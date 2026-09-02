import * as THREE from 'three';
import { holdUnitsFor } from '../worlds/planets/PlanetDescriptor.js';
import { isItem, sellValue } from './ItemDefs.js';

/**
 * WORKING A SEAM.
 *
 * `PlanetWorld` places minerals against the real height field and publishes
 * `world.mineralNodes` - position, type, name, credits, size, and the instance
 * range each node's crystals occupy. The planet agent's handover says in as
 * many words: *"Mining is not wired - `world.mineralNodes` is published with
 * position/type/credits and nothing consumes it yet."* This is the consumer.
 *
 * It is a system rather than part of `Piloting` because it is not about the
 * ship: it is a proximity prompt and a pickup, the same shape as `Caches` and
 * `Relics`, and it happens entirely on foot. What it needs the ship for is the
 * HOLD, and that is one call - `piloting.stow(node)`.
 *
 * ── The rule that makes this a loop rather than a pickup ───────────────────
 *
 * Ore goes into the SHIP, not into the player's bag, and it pays nothing until
 * it is sold at the yard. That is the whole reason to fly home, and it is why
 * `stow` refuses when the hold is full rather than quietly paying out: a Pike
 * has no hold at all (`SHIP_BASE_STATS.pike.hold` is 0), a stock Kestrel has
 * 10 m3 and a Dray 40, so which hull you brought decides how much of a
 * 6,080-credit sweep you can take home in one trip. A mining run that paid
 * straight into the wallet would make the ore tender pointless and the flight
 * home optional.
 *
 * ── AND THE SECOND DESTINATION, WHICH DOES NOT BREAK THAT RULE ─────────────
 *
 * `ItemDefs` defines forty-seven ore ids with a stack, a value, an icon and a
 * description, and until now not one of them could ever be held. `stow` writes
 * a per-type `{units, credits}` row into `Piloting._cargo` and `sellCargo`
 * calls `economy.add(value, 'ore')` - a NUMBER, never an item - so every one
 * of those rows was a bag item nothing could put in a bag: no supply contract
 * could name one, no regional multiplier could apply to one, and no `ItemUse`
 * case could fire on one. `ItemDefs.js` said so about itself, in as many
 * words: *"a regional multiplier on tephra would be a number no transaction in
 * the game reads."*
 *
 * So a node the ship CANNOT take now goes into the bag instead - as one unit
 * of the real `ITEMS` row, stackable, sellable, contract-visible, usable.
 *
 * The order is what keeps the loop above intact, and it is the whole design:
 *
 *   THE HOLD IS ASKED FIRST, ALWAYS. The bag is overflow and only overflow.
 *
 * Nothing is ever diverted away from the ship, so no mining run can earn less
 * than it did before this existed - which matters more than it sounds, because
 * a vendor pays `SELL_RATE` (0.4) for a bag item and the yard pays face value
 * for a hold row. Route a 310-credit iridite seam to the bag while the hold
 * had room and you have quietly cut the player's rare-ore income by 60%, in a
 * commit whose message says "ore into the bag". The overflow rule makes that
 * arithmetic impossible: what reaches the bag is ore that would otherwise have
 * been LEFT IN THE GROUND, and 40% of something is the whole of nothing.
 *
 * ── What is small enough to pocket ────────────────────────────────────────
 *
 * `holdUnitsFor(node.size) <= SAMPLE_HOLD_UNITS`, i.e. a node the hold would
 * have charged exactly one cubic metre for. Not a new threshold invented here:
 * it is the SAME size-to-volume law `_roomFor` already borrows, asked for the
 * smallest answer it can give. Twenty-one of the forty-seven ores qualify -
 * every rare and every exotic seam in the system, plus Vitrine's cryolite -
 * and the twenty-six commons and uncommons are 2 and 3 m3 boulders that a
 * person plainly cannot put in a satchel. A rule that let a 1.9 m humic nodule
 * into a bag slot would be the hold's whole reason for existing, deleted by a
 * number nobody looked at.
 *
 * The rarest ore being the pocketable ore is not a coincidence to be smoothed
 * out - it is `PlanetWorld`'s own `SHOW` ladder read backwards. An exotic seam
 * IS a chip and a common seam IS a boulder, in the mesh, on screen, at the
 * size the player walks up to.
 *
 * ── Where the bag comes from ──────────────────────────────────────────────
 *
 * `main.js` builds this as `new Mining({ bus, player, input, worldManager,
 * piloting })` and does not pass an inventory. Rather than ship a feature that
 * is inert until a file this module does not own changes, the bag is resolved
 * lazily through the chain the live game already has: `main.js:379` assigns
 * `player.loadout = loadout` and `main.js:582` calls
 * `loadout.setInventory(inventory)`, so `player.loadout.inventory` IS the
 * player's bag in the shipped build. An explicitly passed `inventory` always
 * wins, which is what every test and the preferred `main.js` wiring use.
 *
 * With no bag reachable at all, `_bag()` answers null and every node behaves
 * exactly as it did before this paragraph was written: hold, or refusal. That
 * is deliberate - the absence of a wire must not invent a destination.
 *
 * ── Refuse before you consume ──────────────────────────────────────────────
 *
 * `MountSkins.js` recorded the ordering rule and `ShipRegistry.applyScheme`
 * follows it: refuse BEFORE anything is taken, because a purchase consumed with
 * nowhere to land is worse than a purchase refused. Here the thing consumed is
 * a finite node in the world - there are 110 of them on Cinder and they do not
 * come back - so `stow` is asked first and the node is only hidden if it said
 * yes.
 *
 * ── Hiding a mined node ────────────────────────────────────────────────────
 *
 * The crystals are four instances inside a shared `InstancedMesh`. There is no
 * way to remove an instance, so the four matrices are zero-scaled, which
 * collapses them to a point and costs nothing extra to draw. The alternative -
 * rebuilding the instance buffer with a hole in it - would re-upload the whole
 * attribute for one node.
 *
 * A zero scale is also the one thing here that could put a NaN in the frame if
 * it were done by dividing rather than by composing, and "NaN propagates
 * through bloom and blacks out the whole frame" has already cost this world a
 * day. `Matrix4.compose` with a zero scale is exact; nothing is inverted.
 */

/** Metres. Reach of the prompt, from the node's centre to the player's feet. */
export const MINE_RANGE = 3.2;
/** Seconds of holding the key. Long enough to be a verb, short enough to spam. */
export const MINE_TIME = 0.85;

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(0, 0, 0);
const _m = new THREE.Matrix4();

/**
 * The largest hold volume, in cubic metres, a node may occupy and still be
 * pocketable. One - which is the smallest number `holdUnitsFor` can return.
 *
 * Exported because the gate reads it rather than restating it: a test that
 * spelled `1` itself would still pass on the day this became 2 and every
 * boulder on ten planets started going into bag slots.
 */
export const SAMPLE_HOLD_UNITS = 1;

export class Mining {
  /**
   * @param {{bus:any, player:any, input:any, worldManager:any, piloting:any,
   *          inventory?:any}} ctx
   */
  constructor({ bus, player, input, worldManager, piloting, inventory = null }) {
    this.bus = bus ?? null;
    this.player = player ?? null;
    this.input = input ?? null;
    this.worldManager = worldManager ?? null;
    this.piloting = piloting ?? null;
    /**
     * The player's bag, for hand samples. Null is a valid, tested state and
     * means "hold or nothing" - see the header on where this comes from in the
     * shipped build when `main.js` does not pass one.
     */
    this.inventory = inventory ?? null;

    /** @type {Array<object>} live nodes in the active world. */
    this._nodes = [];
    /** @type {Set<string>} node ids already worked, per world. */
    this._taken = new Set();
    this._near = null;
    this._hold = 0;
    this._prompt = null;
    /** Totals, for the HUD, the tests and the trip report. */
    this.stats = { mined: 0, credits: 0 };

    this._offWorld = bus?.on?.('world:changed', () => this._adopt());
    this._adopt();
  }

  /**
   * Pick up whatever the live world publishes.
   *
   * Replace semantics, exactly as `ShipRegistry._adopt`: the previous world's
   * nodes hold a reference to an `InstancedMesh` whose geometry may be disposed,
   * and writing a matrix into a dead buffer is a silent GPU error.
   */
  _adopt() {
    const w = this.worldManager?.active ?? null;
    const list = Array.isArray(w?.mineralNodes) ? w.mineralNodes : [];
    this._nodes = list;
    this._near = null;
    this._hold = 0;
    this._setPrompt(null);
    /* Re-hide anything already mined. A world is rebuilt from scratch on a
     * volatile activation and re-shown on a normal one; either way the ledger
     * of what has been taken is the authority, not the mesh. */
    for (const n of list) if (this._taken.has(this._key(n))) this._hide(n);
  }

  _key(node) {
    return `${this.worldManager?.active?.id ?? '?'}/${node.id}`;
  }

  /** How many nodes are left to work in this world. */
  get remaining() {
    let n = 0;
    for (const node of this._nodes) if (!this._taken.has(this._key(node))) n++;
    return n;
  }

  /** The node the player is standing at, or null. */
  nearest(position = this.player?.position) {
    if (!position || !this._nodes.length) return null;
    let best = null;
    let bestD = MINE_RANGE * MINE_RANGE;
    for (const n of this._nodes) {
      if (this._taken.has(this._key(n))) continue;
      const dx = position.x - n.position.x;
      const dy = position.y - n.position.y;
      const dz = position.z - n.position.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  update(dt) {
    /* Nothing to do in the seat: you cannot work a seam from a cockpit, and
     * running the proximity sweep at 3,600 m/s would flash a prompt for one
     * frame every time the ship crossed a deposit. */
    if (this.piloting?.active) {
      if (this._prompt) this._setPrompt(null);
      this._near = null;
      this._hold = 0;
      return;
    }
    const node = this.nearest();
    if (node !== this._near) {
      this._near = node;
      this._hold = 0;
    }
    if (!node) {
      if (this._prompt) this._setPrompt(null);
      return;
    }

    const room = this._roomFor(node);
    if (!room.ok) {
      this._setPrompt(room.text);
      this._hold = 0;
      return;
    }

    const held = !!this.input?.state?.interact && !this.input?.textCaptured;
    if (held) this._hold += dt;
    else this._hold = 0;

    if (this._hold >= MINE_TIME) {
      this._hold = 0;
      this.mine(node);
      return;
    }
    const pct = Math.round((this._hold / MINE_TIME) * 100);
    /* "Hold", not a bracketed key.
     *
     * Cutting is `MINE_TIME` (0.85 s) of a HELD interact - `this._hold += dt`
     * five lines up - and the prompt said `[E] Work the ...`, which is the
     * same shape every TAP prompt in the game uses. Driven cold, the tester
     * tapped E at an iridite seam, nothing happened, and nothing on screen
     * said why: the rarest element in the game was guarded by an unteachable
     * verb. The key itself is now the chip beside this line, so the sentence
     * only has to carry the thing the chip cannot say - that it is a hold. */
    this._setPrompt(
      this._hold > 0
        ? `Cutting ${node.name}… ${pct}%`
        /* The DESTINATION is on the line whenever it is not the hold.
         *
         * A pilot with a full hold who reads "Hold to cut the Iridite · 233 cr"
         * and then watches the credits NOT arrive at the yard has been told
         * something untrue about their own ship - the same failure the `_roomFor`
         * docblock names one method down. `233 cr` is the hold's face value and
         * a bag sample is sold at a counter for `SELL_RATE` times a regional
         * multiplier, so the number changes as well as the place. Both are said. */
        : room.where === 'bag'
          ? `Hold to pocket a ${node.name} sample  ·  ~${sellValue(node.type, 1)} cr at a counter`
          : `Hold to cut the ${node.name}  ·  ${node.credits} cr`
    );
  }

  /**
   * Why the player cannot take this node, if they cannot.
   *
   * ── The size-to-volume law is BORROWED, not copied ────────────────────────
   *
   * There were three copies of `max(1, round(size * 1.6))`: `Piloting.stow`,
   * which is the one that actually charges the hold;
   * `PlanetDescriptor.HOLD_UNITS_PER_SIZE`, which prices a node against the
   * volume the ship will charge for it; and this one, which decides whether the
   * prompt says "hold full" before either of them is asked.
   *
   * `planet-minerals.test.mjs` scrapes the text of `Piloting.stow` and fails if
   * the descriptor's copy drifts from it - so two of the three were watched and
   * the third was not. A third copy that nothing compares is the one that goes
   * stale, and the way it would go stale is quiet and specific: the prompt would
   * refuse a node the hold would in fact have taken, or invite one it would not,
   * and the only symptom is a player standing at a seam being told something
   * untrue about their own ship.
   *
   * So this asks `holdUnitsFor` instead of restating it. That leaves two copies,
   * one of them scraped against the other, which is the arrangement the
   * descriptor's docblock describes and the one this file was quietly outside.
   */
  _roomFor(node) {
    const p = this.piloting;
    if (!p?.shipId) return { ok: false, text: 'No ship to load it into.' };
    const units = holdUnitsFor(node.size ?? 1);
    if (p.cargoUnits + units <= p.cargoCapacity) return { ok: true, where: 'hold' };

    /* THE HOLD SAID NO. ASK THE OTHER STORE, AND ONLY IN THIS ORDER.
     *
     * The trap this arrangement exists to avoid is double-counting: two stores
     * and one node, with a prompt that invites a cut the `mine` path will then
     * refuse, or - far worse - a cut that lands in both. `_roomFor` and `mine`
     * therefore ask the SAME two questions in the SAME order, and `mine` never
     * reaches the bag except down the branch `stow` has already declined.
     * There is exactly one `stow` call and exactly one `addToBag` call, and
     * neither can run twice for one node.
     *
     * The prompt still names the hold when the bag is what will take it,
     * because "hold full" is the fact the player has to act on eventually; the
     * sample line below says where this one is actually going. */
    const sample = this._sampleRoom(node, units);
    if (sample.ok) return { ok: true, where: 'bag', units };
    return { ok: false, text: sample.text ?? `Hold full — ${p.cargoUnits}/${p.cargoCapacity} m³. Sell at the yard.` };
  }

  /**
   * The bag the hand samples go into, or null.
   *
   * An explicitly wired `inventory` wins. Failing that, the live game's own
   * chain: `player.loadout` is assigned in `main.js` and `Loadout.setInventory`
   * puts the bag on it, so this is the player's real inventory in the shipped
   * build without a line of `main.js` having to change. Both probes are
   * duck-typed on the two methods this file actually calls, so a stub that
   * cannot accept an item is treated as no bag at all rather than throwing
   * halfway through a mine.
   *
   * @returns {any|null}
   */
  _bag() {
    for (const inv of [this.inventory, this.player?.loadout?.inventory]) {
      if (inv && typeof inv.addToBag === 'function' && typeof inv.bagRoomFor === 'function') return inv;
    }
    return null;
  }

  /**
   * Can this node be pocketed, and is there a slot for it?
   *
   * Three questions, and all three have to answer yes:
   *
   *  1. is it small enough - `holdUnitsFor(size) <= SAMPLE_HOLD_UNITS`;
   *  2. is `node.type` a REAL `ITEMS` row - every `PlanetDescriptor` mineral
   *     declares `item` and every one of the forty-seven sets it equal to its
   *     own `id`, which is what `node.type` carries, but a descriptor that
   *     broke that equality must not put an unknown id in a bag. `Inventory`
   *     would silently accept nothing and the node would be gone;
   *  3. is there a free slot or a part-filled stack.
   *
   * @param {object} node @param {number} units the hold volume of this node
   * @returns {{ok:boolean, text?:string}}
   */
  _sampleRoom(node, units = holdUnitsFor(node?.size ?? 1)) {
    if (units > SAMPLE_HOLD_UNITS) return { ok: false };
    const id = node?.type;
    if (!id || !isItem(id)) return { ok: false };
    const bag = this._bag();
    if (!bag) return { ok: false };
    if (bag.bagRoomFor(id) < 1) {
      return { ok: false, text: `Hold full, and no bag slot for a ${node.name} sample.` };
    }
    return { ok: true };
  }

  /**
   * Take one node. Public so a test can drive it without an input device.
   * @returns {{ok:boolean, reason?:string, credits?:number, where?:'hold'|'bag'}}
   */
  mine(node) {
    if (!node) return { ok: false, reason: 'no-node' };
    const key = this._key(node);
    if (this._taken.has(key)) return { ok: false, reason: 'already-taken' };

    // Refuse before consuming. See the header.
    const res = this.piloting?.stow?.(node) ?? { ok: false, reason: 'no-ship' };
    let where = 'hold';
    if (!res.ok) {
      /* THE HOLD REFUSED. The only door left is the bag, and only for a node
       * small enough to go through it.
       *
       * `stow` refuses without consuming anything - it checks the volume before
       * it touches `_cargo` - so arriving here means the node is still in the
       * world and untaken, which is the precondition the header's
       * "refuse before you consume" rule needs. `addToBag` has the same
       * property: it returns how many units it ACCEPTED and mutates nothing
       * when that is zero, so a bag that fills between the prompt and the cut
       * leaves the seam standing rather than eating it. */
      const sample = this._sampleRoom(node);
      const taken = sample.ok ? (this._bag()?.addToBag?.(node.type, 1) ?? 0) : 0;
      if (taken < 1) {
        this.bus?.emit?.('hud:notify', {
          text: res.reason === 'hold-full'
            ? (sample.text ? 'Hold is full, and so is your bag.' : 'Hold is full.')
            : 'Nowhere to put it.',
          tone: 'warn',
        });
        return res;
      }
      where = 'bag';
    }

    this._taken.add(key);
    this._hide(node);
    this.stats.mined++;
    this.stats.credits += node.credits ?? 0;
    this._near = null;
    this._setPrompt(null);
    /* `where` rides along for the same reason `byPlayer` rides on every
     * `npc:killed`: a listener that cannot tell the two destinations apart
     * would credit a bag sample against the hold's ledger. Nothing consumes it
     * yet, and it is published anyway because the alternative is a second
     * event later that has to be kept in step with this one. */
    this.bus?.emit?.('mining:node', {
      id: node.id, type: node.type, name: node.name, credits: node.credits, where,
    });
    this.bus?.emit?.('hud:notify', {
      text: where === 'bag'
        ? `${node.name} sample in your bag — the hold is full`
        : `${node.name} aboard — ${node.credits} CR when sold`,
      tone: 'info',
    });
    /* Quest and contract systems both listen on this channel for "the player
     * did a thing to a named target", so a future ore contract needs no new
     * plumbing. Same call shape `Portals` and `Interiors` already make. */
    this.bus?.emit?.('quest:activity', { type: 'collect', target: node.type, id: node.id });
    /* AND a `mine` of its own, which is not the same claim.
     *
     * `collect` fires for every pickup in the game - a dropped medkit, a credit
     * stack, a cache - so a step that meant "cut a seam" could be finished by
     * walking over something named after an ore. Mining and piloting were the
     * two verbs the mission survey named as the significant omissions from the
     * step vocabulary, and this is the emitter half of closing the first one.
     * Both events fire, because both claims are true: you cut a seam, and you
     * now hold the rock.
     *
     * The payload carries the element type, the node's own id and the world,
     * so a step can say "cut five Rheniite" or "work the Colonnade seam" and
     * `quest-vocab.mjs` can derive both spellings from the descriptor. */
    this.bus?.emit?.('quest:activity', {
      type: 'mine',
      target: node.type,
      id: node.id,
      name: node.name,
      worldId: this.worldManager?.active?.id ?? null,
    });
    return { ok: true, credits: node.credits ?? 0, where };
  }

  /** Collapse a node's crystals. See the header on why it is a zero scale. */
  _hide(node) {
    const mesh = node.mesh;
    if (!mesh?.isInstancedMesh) return;
    const start = node.slot ?? 0;
    const n = node.slotCount ?? 4;
    _v.set(0, -9999, 0);
    _q.identity();
    for (let i = 0; i < n; i++) {
      if (start + i >= mesh.count) break;
      _m.compose(_v, _q, _s);
      mesh.setMatrixAt(start + i, _m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  /* `source` names the slot on the shared prompt channel. See the note in
   * `Piloting._pollBoard`: without it, stepping off a seam published `null` and
   * wiped the board prompt, which then never came back because that publisher
   * only re-emits when the boardable hull CHANGES. */
  _setPrompt(text) {
    if (text === this._prompt) return;
    this._prompt = text;
    this.bus?.emit?.('pilot:prompt', { source: 'mining', text, key: 'E' });
  }

  /* ---- persistence: which seams are already worked out ---- */

  serialize() {
    return { taken: [...this._taken], mined: this.stats.mined, credits: this.stats.credits };
  }

  deserialize(data) {
    if (!data) return;
    if (Array.isArray(data.taken)) {
      this._taken = new Set(data.taken.filter((k) => typeof k === 'string'));
    }
    this.stats.mined = Math.max(0, Math.round(Number(data.mined) || 0));
    this.stats.credits = Math.max(0, Math.round(Number(data.credits) || 0));
    this._adopt();
  }

  dispose() {
    this._offWorld?.();
    this._nodes = [];
  }
}
