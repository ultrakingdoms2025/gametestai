/**
 * Viewpoint synchronisation.
 *
 * ── The defect this answers ───────────────────────────────────────────────
 * `CitadelWorld` publishes `world.viewpoints`, a NAMED list of the world's best
 * vantage points - "The Great Tower", "Minaret 1".. - each carrying the exact
 * point a leap of faith leaves from, the bearing it leaves on, and the haystack
 * that catches it. It had **zero consumers anywhere**. The hardest climbs in the
 * game paid nothing, said nothing, and were on no map.
 *
 * ── Why this is its own module and not a citadel branch ───────────────────
 * Nothing below names a world. The contract is one published array:
 *
 *   `world.viewpoints = [{ id, name, x, y, z, r, launch?, bearing?, hay? }]`
 *
 * `id` and a finite `x/y/z` are the whole requirement; everything else has a
 * default. A world that publishes the array gets the loop, a world that does
 * not costs one failed property read per world change. That is the same
 * arrangement `RaceManager` has with `trackPath` and `MinigameManager` has with
 * `minigameVenues`, and it is what stops this becoming a second copy of the
 * citadel's layout living outside the citadel.
 *
 * ── What reaching one does ────────────────────────────────────────────────
 *   1. **Reveals the local map.** {@link Viewpoints#reveals} is a predicate over
 *      world XZ that `Minimap` asks before it plots a relic. Thirty relic
 *      markers handed over at once is a checklist; thirty relics revealed a
 *      district at a time by climbing is the loop the relics were hidden for. A
 *      world with no viewpoints reveals everything - there is nothing there to
 *      earn it with, and a rule that hid markers for ever in four worlds out of
 *      five would be a bug wearing a design's clothes.
 *   2. **Registers a fast-travel anchor.** {@link Viewpoints#anchors} is the
 *      synchronised subset; {@link Viewpoints#travelTo} puts the player back on
 *      that platform. Earned, not given: an anchor you have not climbed to is
 *      not on the list.
 *   3. **Pays a real prize.** Credits AND coin on every synchronisation, and a
 *      cosmetic plus a mount power for the whole set. A quest can only pay
 *      credits today; this layer does not have to.
 *   4. **Offers the leap of faith.** The prompt only exists where the world
 *      published a `launch` point AND the build resolved a real haystack under
 *      it, so it can never invite a player off a roof with nothing below.
 *
 * ── Signed out ────────────────────────────────────────────────────────────
 * Everything here is world-local with local persistence through `SaveGame`.
 * There is no account, no API and no login on any path in this file.
 */

/**
 * How far a synchronised viewpoint reveals, in metres.
 *
 * ── Measured, not chosen ──────────────────────────────────────────────────
 * The citadel is the only world publishing viewpoints today, and its five all
 * stand inside r = 21 (the great tower at 18.0, the four minarets at 21.0)
 * while its 192 authored roofs run from r = 4.0 out to r = 118.0, median 82.3.
 * Five reveal discs sharing one small cluster of centres therefore behave much
 * more like one big disc than like five districts, so this radius decides the
 * whole mechanic rather than trimming it.
 *
 * Built headless and counted. The ROOF columns are what this table used to
 * carry on its own, and they were the wrong population to choose a number
 * with: what `Minimap` actually gates on this radius is a RELIC SPARK, and
 * `Relics` puts thirty sites on a subset of those roofs plus the wall towers,
 * so the two curves are not the same curve.
 *
 *   radius   roofs 1   roofs 5   relics 1     relics 5
 *     30 m      4%       13%      3/30 10%     7/30  23%
 *     50 m     13%       25%      7/30 23%     8/30  27%
 *     60 m     22%       38%      8/30 27%    11/30  37%
 *     70 m     33%       54%      9/30 30%    14/30  47%
 *     80 m     46%       73%     11/30 37%    19/30  63%
 *     90 m     64%       95%     18/30 60%    26/30  87%
 *    100 m     77%       99%     21/30 70%    29/30  97%
 *    120 m     97%      100%     27/30 90%    30/30 100%
 *
 * The first draft said 120, which hands the player every relic marker in the
 * world for one climb and all of them for five - the hiding, which is the
 * entire mechanic in `Relics.js`'s header, would have been deleted by a
 * constant. **70 m**: one climb marks 9 of the 30 relics and the full set
 * marks 14, so the outer souk ring and the wall towers stay something you find
 * by looking rather than something the map hands over. A radius rather than a
 * rectangle, because what is being revealed is "what you can see from up
 * there".
 *
 * ── What an unrevealed relic is NOT ───────────────────────────────────────
 * It is not unreachable content. Every one of the thirty stands in the
 * reachable component and 26 of 30 are on the rooftop-only network, both
 * floored in `citadel-reach.test.mjs`; the sixteen this radius leaves unmarked
 * are the ones the mechanic exists to make you hunt for. The floor that keeps
 * this honest in the other direction - that climbing is worth something, and
 * that a later edit cannot quietly turn the map back into a checklist - is in
 * `citadel-discovery.test.mjs`.
 */
export const REVEAL_R = 70;
/** Credits per synchronisation. */
export const SYNC_CREDITS = 150;
/** Coin per synchronisation - a prize, not just a number going up. */
export const SYNC_ITEM = 'relic_coin';
export const SYNC_ITEM_QTY = 3;
/** The whole set: a mount skin the marketplace charges for. */
export const SET_COSMETIC = 'eagle_storm';
/** ..and a mount power tier. `eagle` sells `power`; see `Livery.MOUNT_STATS`. */
export const SET_POWER = { mount: 'eagle', power: 'power', tier: 1 };
/** How far past a viewpoint's own radius still counts as standing on it. */
export const SYNC_PAD = 2.5;
/** Vertical band around the platform top. Beyond this you are under it. */
export const SYNC_BAND = 3.0;
/** How close to the published launch point the leap prompt appears. */
export const LEAP_R = 3.0;
/** Vertical band for the leap prompt. Tighter: a diving board, not a roof. */
export const LEAP_BAND = 2.5;
/**
 * Rows the pause hub reserves for travel anchors.
 *
 * The hub is built once at boot from a static list, so the rows have to exist
 * before the anchors do; each one is `visible()`-gated on there being an anchor
 * at its index. `main.js:509` splices `hubItems()` in at boot with no argument,
 * so THIS CONSTANT IS THE HARD CEILING on how many anchors a player can ever
 * travel to - an eleventh viewpoint would synchronise, pay its prize, reveal
 * its district and then have nowhere in the menu to be travelled to.
 *
 * It was 8 while the citadel published five. The outer ring took it to TEN -
 * the great tower, four minarets, and one apiece on the Caravanserai, the
 * Undercliff, the Deepworks, Ashfall and the Eyrie - so eight silently dropped
 * the last two off the bottom of the list, and the two it dropped were the
 * Eyrie and Ashfall: the hardest climbs in the world, paying the least.
 *
 * TWELVE, not ten: the number is a menu allocation rather than a fact about a
 * world, and a floor pinned exactly to today's content is a floor that fails
 * the next time a region is authored. `citadel-objectives.test.mjs` asserts
 * headroom over the real published count rather than the constant, which is
 * the assertion that would have caught the 8.
 */
export const MAX_TRAVEL_ROWS = 12;

/** Default platform radius when a world publishes a viewpoint without one. */
const DEFAULT_R = 6;

/** Module-level scratch. `update` runs every frame and must not allocate. */
const _pos = { x: 0, y: 0, z: 0 };

/** Finite number, or null. */
function fin(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalise one published entry, or return null if it cannot be used.
 *
 * Deliberately tolerant about everything except identity and position: a world
 * that publishes a viewpoint with no launch point simply has no leap of faith
 * there, which is a choice a world is allowed to make.
 *
 * @param {any} raw
 * @param {number} index position in the published array, for the fallback name
 */
export function normaliseViewpoint(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id ? raw.id : null;
  if (!id) return null;
  const x = fin(raw.x);
  const y = fin(raw.y);
  const z = fin(raw.z);
  if (x === null || y === null || z === null) return null;

  /* A launch point is only a launch point when something catches you. The
   * citadel's build resolves `hay` from a `{run, r}` spec to `{x, y, z, r}`
   * against a real physics surface; an UNRESOLVED spec has no `y`, and is
   * dropped here rather than becoming a prompt that invites a player off a
   * tower onto nothing. The two travel together for the same reason: a hay with
   * no launch has no prompt to attach to. */
  const l = raw.launch;
  const launch = l && fin(l.x) !== null && fin(l.y) !== null && fin(l.z) !== null
    ? { x: Number(l.x), y: Number(l.y), z: Number(l.z) }
    : null;
  const h = raw.hay;
  const hay = h && fin(h.x) !== null && fin(h.y) !== null && fin(h.z) !== null
    ? { x: Number(h.x), y: Number(h.y), z: Number(h.z), r: fin(h.r) ?? 3 }
    : null;
  const paired = launch !== null && hay !== null;

  return {
    id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : `Viewpoint ${index + 1}`,
    x,
    y,
    z,
    r: Math.max(1, fin(raw.r) ?? DEFAULT_R),
    launch: paired ? launch : null,
    hay: paired ? hay : null,
    synced: false,
  };
}

export class Viewpoints {
  /**
   * @param {{bus?:any, player?:any, economy?:any, inventory?:any,
   *          cosmetics?:any, mounts?:any, worldManager?:any}} ctx
   */
  constructor({ bus, player, economy, inventory, cosmetics, mounts, worldManager } = {}) {
    this.bus = bus ?? null;
    this.player = player ?? null;
    this.economy = economy ?? null;
    this.inventory = inventory ?? null;
    this.cosmetics = cosmetics ?? null;
    this.mounts = mounts ?? null;
    this.worldManager = worldManager ?? null;

    /** Viewpoints published by the ACTIVE world, normalised. @type {Array<object>} */
    this.list = [];
    this._worldId = null;
    /** worldId -> Set of synchronised ids. Survives a world round trip. */
    this._synced = new Map();
    /** Worlds whose whole set has already paid, so the set prize pays once. */
    this._setPaid = new Set();
    /** Whose leap is on offer, so the prompt only writes when it changes. */
    this._promptId = null;

    this._offs = [];
    if (this.bus) {
      this._offs.push(this.bus.on('world:changed', ({ id, world }) => this._onWorld(id, world)));
    }
  }

  /* ------------------------------------------------------------------ */
  /* Contract surface                                                    */
  /* ------------------------------------------------------------------ */

  /** How many viewpoints the active world publishes. */
  get total() {
    return this.list.length;
  }

  /** How many of them the player has stood on. */
  get syncedCount() {
    let n = 0;
    for (const v of this.list) if (v.synced) n++;
    return n;
  }

  /** @param {string} id */
  isSynced(id) {
    return !!this._syncedSet(this._worldId)?.has(id);
  }

  /**
   * Fast-travel anchors: the synchronised subset, in publication order.
   * A fresh array each call - this is a menu read, never a frame read.
   * @returns {Array<{id:string,name:string,x:number,y:number,z:number}>}
   */
  get anchors() {
    const out = [];
    for (const v of this.list) {
      if (v.synced) out.push({ id: v.id, name: v.name, x: v.x, y: v.y, z: v.z });
    }
    return out;
  }

  /**
   * Is this world-space column inside a revealed district?
   *
   * The predicate `Minimap` asks before plotting a relic. See the header for
   * why a world publishing no viewpoints answers `true` for everything.
   *
   * @param {number} x
   * @param {number} z
   */
  reveals(x, z) {
    if (!this.list.length) return true;
    const px = Number(x);
    const pz = Number(z);
    if (!Number.isFinite(px) || !Number.isFinite(pz)) return false;
    const r2 = REVEAL_R * REVEAL_R;
    for (const v of this.list) {
      if (!v.synced) continue;
      const dx = v.x - px;
      const dz = v.z - pz;
      if (dx * dx + dz * dz <= r2) return true;
    }
    return false;
  }

  /**
   * Put the player back on a synchronised viewpoint.
   *
   * Refuses an anchor that was never earned - the whole point of the list is
   * that climbing is what puts a place on it. A ridden mount is dismounted
   * first: `Player.teleport` moves the body and nothing else, so a mounted
   * player would arrive on the tower still parented to a horse standing in the
   * souk.
   *
   * @param {string} id
   * @returns {boolean} true when the player actually moved
   */
  travelTo(id) {
    const vp = this.list.find((v) => v.id === id);
    if (!vp) return false;
    if (!vp.synced) {
      this.bus?.emit('hud:notify', { text: `${vp.name} — not synchronised yet`, tone: 'warn' });
      return false;
    }
    if (!this.player?.teleport) return false;
    if (this.mounts?.mounted) this.mounts.dismount?.();
    _pos.x = vp.x;
    _pos.y = vp.y + 0.05;
    _pos.z = vp.z;
    this.player.teleport(_pos);
    this.bus?.emit('viewpoint:travelled', { worldId: this._worldId, id: vp.id, name: vp.name });
    this.bus?.emit('hud:notify', { text: `Travelled to ${vp.name}`, tone: 'info' });
    return true;
  }

  /**
   * Pause-hub rows, one per possible anchor.
   *
   * The hub is built once at boot and re-reads `visible`/`label` on every
   * refresh, so a fixed set of gated rows IS a live list without the hub
   * needing to know this system exists. Returned as plain descriptors so
   * `main.js` can drop them into an existing group - a group of their own would
   * leave a dangling heading in every world that publishes no viewpoints.
   *
   * @param {number} [max]
   */
  hubItems(max = MAX_TRAVEL_ROWS) {
    const rows = [];
    for (let i = 0; i < max; i++) {
      rows.push({
        id: `travel-${i + 1}`,
        visible: () => i < this.anchors.length,
        label: () => `Travel: ${this.anchors[i]?.name ?? ''}`,
        hint: 'Synchronised viewpoint',
        run: () => this.travelTo(this.anchors[i]?.id),
      });
    }
    return rows;
  }

  /* ------------------------------------------------------------------ */
  /* Persistence                                                         */
  /* ------------------------------------------------------------------ */

  /** @returns {{worlds:Object<string,string[]>, sets:string[]}} */
  serialize() {
    const worlds = {};
    for (const [worldId, set] of this._synced) {
      if (set.size) worlds[worldId] = [...set];
    }
    return { worlds, sets: [...this._setPaid] };
  }

  /**
   * Restore synchronised ids. Never pays: the prizes were paid the first time,
   * and a load that re-granted them would be an infinite credit press.
   *
   * REPLACE, not merge. Merging meant a load could never UN-synchronise:
   * climb all five citadel viewpoints, then load a save written before any of
   * them, and `_synced` still held all five ids, `_applySynced` re-stamped
   * `synced: true`, the five fast-travel rows stayed in the pause hub and
   * `reveals()` still opened the whole map. The player kept progress the save
   * they loaded does not contain. `MountManager.deserialize` writes the same
   * rule down as the house convention.
   *
   * `_setPaid` is cleared with it and for the same reason - it is the record of
   * a prize already given, and if the save says the set was never completed
   * then the prize in that save was never given either. Completing the set
   * again re-pays it, which is correct: `_paySet` is idempotent per world for
   * the CURRENT state, not across states a load replaced.
   *
   * @param {{worlds?:Object<string,string[]>, sets?:string[]}|null} data
   * @returns {boolean} true when a well-formed payload was applied
   */
  deserialize(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    this._synced.clear();
    this._setPaid.clear();
    // `this.list`'s own `synced` flags need no separate clear: `_applySynced`
    // below assigns `!!set?.has(v.id)` to every one of them, so it un-stamps
    // as well as it stamps. A second loop here would be a guard nothing could
    // ever prove load-bearing.
    const worlds = data.worlds;
    if (worlds && typeof worlds === 'object' && !Array.isArray(worlds)) {
      for (const worldId of Object.keys(worlds)) {
        const ids = worlds[worldId];
        if (!Array.isArray(ids)) continue;
        const set = this._syncedSet(worldId, true);
        for (const id of ids) if (typeof id === 'string' && id) set.add(id);
      }
    }
    if (Array.isArray(data.sets)) {
      for (const w of data.sets) if (typeof w === 'string' && w) this._setPaid.add(w);
    }
    this._applySynced();
    this._announce();
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* World                                                               */
  /* ------------------------------------------------------------------ */

  _onWorld(id, world) {
    this._worldId = id ?? null;
    this.list.length = 0;
    this._setPrompt(null);

    const published = world?.viewpoints;
    if (Array.isArray(published)) {
      for (let i = 0; i < published.length; i++) {
        const vp = normaliseViewpoint(published[i], i);
        if (vp) this.list.push(vp);
      }
    }
    this._applySynced();
    /* A set that is already complete but has never paid.
     *
     * Reachable two ways, and both are ordinary: a save written before this
     * prize existed, and a save whose last synchronisation happened in a build
     * where the set prize was different. `_setPaid` - and the `sets` array it
     * serialises to - is what makes this pay exactly once rather than on every
     * entry to the world, and this is the only path on which that matters.
     * A world with no viewpoints has no set to complete. */
    if (this.list.length > 0 && this.syncedCount >= this.list.length) this._paySet();
    this._announce();
  }

  /** @param {string|null} worldId */
  _syncedSet(worldId, create = false) {
    if (worldId === null || worldId === undefined) return null;
    let set = this._synced.get(worldId);
    if (!set && create) {
      set = new Set();
      this._synced.set(worldId, set);
    }
    return set ?? null;
  }

  /** Stamp the stored ids onto the live list. */
  _applySynced() {
    const set = this._syncedSet(this._worldId);
    for (const v of this.list) v.synced = !!set?.has(v.id);
  }

  /* ------------------------------------------------------------------ */
  /* Frame                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Detect arrival and offer the leap. One pass over at most a handful of
   * entries, no allocation, and it returns immediately in every world that
   * publishes none.
   * @param {number} _dt
   */
  update(_dt) {
    if (!this.list.length) return;
    const p = this.player?.position;
    if (!p) return;
    const px = p.x;
    const py = p.y;
    const pz = p.z;

    let prompt = null;
    for (const v of this.list) {
      const dx = v.x - px;
      const dz = v.z - pz;
      const reach = v.r + SYNC_PAD;
      /* `_sync` owns the already-done test, and it is the ONLY place that test
       * lives. A second copy here would read as belt and braces and is really a
       * test that cannot fail: with two guards, deleting either one leaves the
       * behaviour correct, so nothing can ever prove either is load-bearing. */
      if (dx * dx + dz * dz <= reach * reach && Math.abs(py - v.y) <= SYNC_BAND) this._sync(v);
      const l = v.launch;
      if (l && prompt === null) {
        const lx = l.x - px;
        const lz = l.z - pz;
        if (lx * lx + lz * lz <= LEAP_R * LEAP_R && Math.abs(py - l.y) <= LEAP_BAND) prompt = v;
      }
    }
    this._setPrompt(prompt);
  }

  /** @param {object|null} vp */
  _setPrompt(vp) {
    const id = vp?.id ?? null;
    if (id === this._promptId) return;
    this._promptId = id;
    if (!vp) {
      this.bus?.emit('viewpoint:prompt', { text: null, viewpointId: null });
      return;
    }
    /* The drop is measured off the two published points, not guessed: the
     * launch's own y and the y the build resolved the haystack to. */
    const drop = Math.max(0, vp.launch.y - vp.hay.y);
    this.bus?.emit('viewpoint:prompt', {
      text: `Leap of faith — hay ${drop.toFixed(0)} m below`,
      viewpointId: vp.id,
      drop,
    });
  }

  /* ------------------------------------------------------------------ */
  /* Synchronisation and prizes                                          */
  /* ------------------------------------------------------------------ */

  _sync(vp) {
    // The single "already done" gate. `update` calls this on every frame the
    // player is inside the band, so without it the reward pays at 60 Hz.
    if (vp.synced) return;
    const set = this._syncedSet(this._worldId, true);
    if (!set) return;
    set.add(vp.id);
    vp.synced = true;

    this.economy?.add?.(SYNC_CREDITS, 'viewpoint');
    this.inventory?.acquire?.(SYNC_ITEM, SYNC_ITEM_QTY);

    const done = this.syncedCount;
    const total = this.total;
    this.bus?.emit('viewpoint:synced', {
      worldId: this._worldId,
      id: vp.id,
      name: vp.name,
      position: { x: vp.x, y: vp.y, z: vp.z },
      revealRadius: REVEAL_R,
      credits: SYNC_CREDITS,
      synced: done,
      total,
    });
    this.bus?.emit('hud:notify', {
      text: `${vp.name} synchronised — +${SYNC_CREDITS} CR, map revealed (${done}/${total})`,
      tone: 'good',
    });

    if (done >= total && total > 0) this._paySet();
    this._announce();
  }

  /**
   * The whole set, once per world.
   *
   * A cosmetic and a mount power rather than a fourth credit payment: the
   * viewpoints are the hardest climbs in the world and credits are what the
   * relics already pay. `grantPower` silently drops a stat the mount does not
   * sell and `unlock` refuses an id it does not know, so both are safe to call
   * without this file holding a copy of either catalogue.
   */
  _paySet() {
    if (!this._worldId || this._setPaid.has(this._worldId)) return;
    this._setPaid.add(this._worldId);
    const gotSkin = this.cosmetics?.unlock?.(SET_COSMETIC) === true;
    this.mounts?.grantPower?.(SET_POWER.mount, SET_POWER.power, SET_POWER.tier);
    this.bus?.emit('viewpoint:setComplete', {
      worldId: this._worldId,
      cosmetic: SET_COSMETIC,
      power: { ...SET_POWER },
      total: this.total,
    });
    this.bus?.emit('hud:notify', {
      text: gotSkin
        ? 'Every viewpoint synchronised — Storm Crest unlocked, eagle speed up'
        : 'Every viewpoint synchronised — eagle speed up',
      tone: 'good',
    });
  }

  _announce() {
    this.bus?.emit('viewpoints:changed', {
      worldId: this._worldId,
      synced: this.syncedCount,
      total: this.total,
    });
  }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
    this.list.length = 0;
  }
}

export default Viewpoints;
