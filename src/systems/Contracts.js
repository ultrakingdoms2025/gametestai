import * as THREE from 'three';

/**
 * Standing jobs, offered by the people who already have names.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * The most under-used thing in the build was the cast. `NPCRoles` gives every
 * friendly a name, a trade and a personality, and `ChatClient` lets them hold a
 * conversation - and none of it ever asked the player to *do* anything. A world
 * with a smith, a farrier and a quartermaster in it should be able to want
 * something.
 *
 * A contract is the smallest thing that turns those characters into content:
 * one named NPC, one goal, one reward. There is no quest graph, no branching
 * and no state machine beyond "offered / active / done", because the value is
 * in having a reason to cross a world, not in the bookkeeping.
 *
 * Three kinds, each of which reuses a system that already exists and needs no
 * new verbs from the player:
 *
 *   - **bounty**  kill N hostiles in this world        (Combat already emits it)
 *   - **supply**  bring N of an item to the client     (Inventory already has it)
 *   - **survey**  find a world cache                   (Caches already places them)
 *
 * ── Design notes ──────────────────────────────────────────────────────────
 * Contracts are per-world and regenerate on every world change, which keeps
 * them in step with a cast that is itself respawned per world. Progress is
 * tracked from bus events rather than polled, except for supply contracts,
 * which have to look at the bag because items can arrive there by a dozen
 * routes (loot, purchase, cache, pickup) and subscribing to all of them would
 * be a list that silently goes stale.
 */

/** Contracts offered per world. Small: these are errands, not a job board. */
const PER_WORLD = 2;
/** Credits per unit of work, by kind. Tuned against ~24 CR for a hostile drop. */
const REWARD = { bounty: 55, supply: 14, survey: 260 };

const _v = new THREE.Vector3();

/** What each world plausibly wants brought to it. */
const SUPPLY_WANTS = {
  station: [{ id: 'alloy_scrap', min: 4, max: 8 }, { id: 'nexus_shard', min: 1, max: 2 }],
  medieval: [{ id: 'alloy_scrap', min: 3, max: 6 }, { id: 'relic_coin', min: 3, max: 6 }],
  sports: [{ id: 'medkit', min: 2, max: 3 }, { id: 'alloy_scrap', min: 3, max: 6 }],
};

const KIND_TEXT = {
  bounty: (c) => `Clear ${c.need} hostile${c.need === 1 ? '' : 's'} from ${c.worldName}`,
  supply: (c) => `Bring ${c.need} × ${c.itemName}`,
  survey: () => 'Recover a lost cache',
};

function mulberry(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class Contracts {
  /**
   * @param {{bus:any, npcManager:any, player:any, economy:any, inventory:any,
   *          worldManager:any}} ctx
   */
  constructor({ bus, npcManager, player, economy, inventory, worldManager } = {}) {
    this.bus = bus ?? null;
    this.npcManager = npcManager ?? null;
    this.player = player ?? null;
    this.economy = economy ?? null;
    this.inventory = inventory ?? null;
    this.worldManager = worldManager ?? null;

    /** @type {Array<object>} */
    this.list = [];
    this._worldId = null;
    this._scanT = 0;

    /** @type {Array<() => void>} */
    this._offs = [];
    if (this.bus) {
      // Regenerate after the cast does, or there would be nobody to give them
      // out: NPCManager spawns on `world:changed` too, and we need its list.
      this._offs.push(this.bus.on('world:changed', ({ id }) => {
        this._worldId = id ?? null;
        this._pending = true;
      }));
      this._offs.push(this.bus.on('npc:killed', (e) => this._onKill(e)));
      this._offs.push(this.bus.on('loot:collected', (e) => this._onCollect(e)));
    }
    this._pending = false;
  }

  /** Contracts the player has accepted and not yet turned in. */
  get active() {
    return this.list.filter((c) => c.state === 'active');
  }

  /** Everything offered in this world, for the HUD and the minimap. */
  get all() {
    return this.list;
  }

  /** The contract this NPC is offering, if any. @returns {object|null} */
  forNPC(npc) {
    if (!npc) return null;
    return this.list.find((c) => c.npc === npc && c.state !== 'done') ?? null;
  }

  /* ------------------------------------------------------------------ */
  /* Generation                                                          */
  /* ------------------------------------------------------------------ */

  _generate() {
    this.list.length = 0;
    const id = this._worldId;
    const friendlies = (this.npcManager?.friendlies ?? this.npcManager?._friendlies ?? [])
      .filter((n) => n && !n.isDead && n.conversational);
    if (!friendlies.length) return;

    const rnd = mulberry(hashString(`contract:${id}`));
    const worldName = this.worldManager?.displayNameOf?.(id) ?? id ?? 'this world';
    // Prefer people with a trade: a quartermaster wanting scrap reads better
    // than a random passer-by wanting it.
    const pool = friendlies.slice().sort((a, b) => (b.isVendor ? 1 : 0) - (a.isVendor ? 1 : 0));

    // Draw kinds without replacement: two "kill four hostiles" jobs in the same
    // village is the version of this feature nobody wants.
    const kinds = ['bounty', 'supply', 'survey'];
    for (let i = kinds.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
    }

    const taken = new Set();
    for (let i = 0; i < Math.min(PER_WORLD, pool.length, kinds.length); i++) {
      let npc = null;
      for (let t = 0; t < 8 && !npc; t++) {
        const cand = pool[Math.floor(rnd() * Math.min(pool.length, 6))] ?? pool[i];
        if (cand && !taken.has(cand)) npc = cand;
      }
      if (!npc) npc = pool.find((n) => !taken.has(n)) ?? null;
      if (!npc) break;
      taken.add(npc);
      const c = this._make(kinds[i], npc, rnd, worldName);
      if (c) this.list.push(c);
    }
    if (this.list.length) {
      this.bus?.emit('contracts:changed', { worldId: id, contracts: this.list });
    }
  }

  _make(kind, npc, rnd, worldName) {
    const c = {
      id: `${this._worldId}:${kind}:${npc.name ?? 'x'}`,
      kind, npc, worldId: this._worldId, worldName,
      state: 'offered', have: 0, need: 1, reward: 0,
      itemId: null, itemName: null, title: '',
    };

    if (kind === 'bounty') {
      c.need = 3 + Math.floor(rnd() * 3);
      c.reward = c.need * REWARD.bounty;
    } else if (kind === 'supply') {
      const wants = SUPPLY_WANTS[this._worldId] ?? SUPPLY_WANTS.station;
      const w = wants[Math.floor(rnd() * wants.length)];
      c.itemId = w.id;
      c.need = w.min + Math.floor(rnd() * (w.max - w.min + 1));
      c.reward = c.need * REWARD.supply * 3;
      // Resolved lazily so this module never has to import the item table.
      c.itemName = w.id.replace(/_/g, ' ');
    } else {
      c.need = 1;
      c.reward = REWARD.survey;
    }
    c.title = KIND_TEXT[kind](c);
    return c;
  }

  /* ------------------------------------------------------------------ */
  /* Player actions                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Accept an offered contract. Called from the chat/interact path.
   * @param {object} c
   */
  accept(c) {
    if (!c || c.state !== 'offered') return false;
    c.state = 'active';
    c.have = 0;
    this.bus?.emit('contracts:changed', { worldId: this._worldId, contracts: this.list });
    this.bus?.emit('hud:notify', {
      text: `Contract accepted — ${c.title}`, tone: 'info',
    });
    return true;
  }

  /**
   * Hand in a completed contract and pay out.
   * @param {object} c
   */
  turnIn(c) {
    if (!c || c.state !== 'active' || c.have < c.need) return false;
    // Supply contracts consume the goods; the others are pure information.
    // The bag is the only pool that counts - goods left in the world store are
    // not "brought" to anyone.
    if (c.kind === 'supply' && this.inventory) {
      if (!this.inventory.consumeFromBag(c.itemId, c.need)) return false;
    }
    c.state = 'done';
    this.economy?.add?.(c.reward, 'contract');
    this.bus?.emit('contracts:changed', { worldId: this._worldId, contracts: this.list });
    this.bus?.emit('hud:notify', {
      text: `Contract complete — ${c.reward} CR`, tone: 'good',
    });
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Progress                                                            */
  /* ------------------------------------------------------------------ */

  _onKill(e) {
    const npc = e?.npc;
    if (!npc || npc.type !== 'hostile') return;
    let changed = false;
    for (const c of this.list) {
      if (c.state === 'active' && c.kind === 'bounty' && c.have < c.need) {
        c.have++;
        changed = true;
      }
    }
    if (changed) this._announce();
  }

  _onCollect(e) {
    // Survey contracts complete on recovering any cache. Loot does not tell us
    // which pickup it was, so the tag check lives on the pickup itself and this
    // simply treats a trinket-grade recovery as the find.
    if (!e) return;
    let changed = false;
    for (const c of this.list) {
      if (c.state === 'active' && c.kind === 'survey' && c.have < c.need && e.fromCache) {
        c.have = c.need;
        changed = true;
      }
    }
    if (changed) this._announce();
  }

  _announce() {
    this.bus?.emit('contracts:changed', { worldId: this._worldId, contracts: this.list });
  }

  /**
   * @param {number} dt
   */
  update(dt) {
    if (this._pending) {
      this._pending = false;
      this._generate();
    }
    if (!this.list.length) return;

    // Supply progress is polled: items reach the bag through loot, purchase,
    // cache and pickup, and subscribing to every one of those is a list that
    // goes stale the first time somebody adds a fifth.
    this._scanT -= dt;
    if (this._scanT > 0) return;
    this._scanT = 0.5;

    let changed = false;
    for (const c of this.list) {
      if (c.state !== 'active' || c.kind !== 'supply') continue;
      // Bag, not store: turn-in draws from the bag, so progress has to track
      // the same pool or the contract would read complete and refuse to close.
      const held = this.inventory?.bagCount?.(c.itemId) ?? 0;
      const capped = Math.min(held, c.need);
      if (capped !== c.have) {
        c.have = capped;
        changed = true;
      }
    }
    if (changed) this._announce();
  }

  /** Nearest contract-giver the player can turn in to, for the HUD prompt. */
  nearestGiver(maxRange = 4.5) {
    if (!this.player) return null;
    let best = null;
    let bestD = maxRange * maxRange;
    for (const c of this.list) {
      if (c.state === 'done' || !c.npc || c.npc.isDead) continue;
      _v.copy(c.npc.position);
      const d = _v.distanceToSquared(this.player.position);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
    this.list.length = 0;
  }
}

export default Contracts;
