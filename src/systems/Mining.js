import * as THREE from 'three';

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

export class Mining {
  /**
   * @param {{bus:any, player:any, input:any, worldManager:any, piloting:any}} ctx
   */
  constructor({ bus, player, input, worldManager, piloting }) {
    this.bus = bus ?? null;
    this.player = player ?? null;
    this.input = input ?? null;
    this.worldManager = worldManager ?? null;
    this.piloting = piloting ?? null;

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
        : `Hold to cut the ${node.name}  ·  ${node.credits} cr`
    );
  }

  /** Why the player cannot take this node, if they cannot. */
  _roomFor(node) {
    const p = this.piloting;
    if (!p?.shipId) return { ok: false, text: 'No ship to load it into.' };
    const units = Math.max(1, Math.round((node.size ?? 1) * 1.6));
    if (p.cargoUnits + units > p.cargoCapacity) {
      return { ok: false, text: `Hold full — ${p.cargoUnits}/${p.cargoCapacity} m³. Sell at the yard.` };
    }
    return { ok: true };
  }

  /**
   * Take one node. Public so a test can drive it without an input device.
   * @returns {{ok:boolean, reason?:string, credits?:number}}
   */
  mine(node) {
    if (!node) return { ok: false, reason: 'no-node' };
    const key = this._key(node);
    if (this._taken.has(key)) return { ok: false, reason: 'already-taken' };

    // Refuse before consuming. See the header.
    const res = this.piloting?.stow?.(node) ?? { ok: false, reason: 'no-ship' };
    if (!res.ok) {
      this.bus?.emit?.('hud:notify', {
        text: res.reason === 'hold-full' ? 'Hold is full.' : 'Nowhere to put it.',
        tone: 'warn',
      });
      return res;
    }

    this._taken.add(key);
    this._hide(node);
    this.stats.mined++;
    this.stats.credits += node.credits ?? 0;
    this._near = null;
    this._setPrompt(null);
    this.bus?.emit?.('mining:node', {
      id: node.id, type: node.type, name: node.name, credits: node.credits,
    });
    this.bus?.emit?.('hud:notify', {
      text: `${node.name} aboard — ${node.credits} CR when sold`,
      tone: 'info',
    });
    /* Quest and contract systems both listen on this channel for "the player
     * did a thing to a named target", so a future ore contract needs no new
     * plumbing. Same call shape `Portals` and `Interiors` already make. */
    this.bus?.emit?.('quest:activity', { type: 'collect', target: node.type, id: node.id });
    return { ok: true, credits: node.credits ?? 0 };
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
