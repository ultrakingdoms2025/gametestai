/**
 * Distance-streamed population for a world that is too big to hold one.
 *
 * ---------------------------------------------------------------------------
 * THE ARITHMETIC THAT FORCED IT
 *
 * `NPCManager.maxNPCs` is 72. Aldermoor Vale is 900 x 900 m, which is 810,000
 * m2, which at 72 characters is one person per 11,250 m2 - a person every 106
 * metres in every direction, i.e. one at the very edge of the range at which
 * they are drawn at all (`RENDER_OUT = 135`). Fourteen settlements cannot be
 * populated out of that budget: the table asks for 87 residents before a single
 * traveller, guard rotation or wolf.
 *
 * Raising `maxNPCs` is the obvious move. It is the wrong one, and the reasons
 * are measured - including the ones that turned out NOT to be reasons, which
 * are recorded here because they are the ones a reader will otherwise assume.
 *
 * WHAT IS NOT THE PROBLEM. Every manager-level sweep was timed headlessly
 * against the real methods (`scripts/tests/npc-budget.test.mjs` re-runs the
 * scaling half of this):
 *
 *   `_separateBodies`, 1,000 fixed steps, crowd packed into a 40 m square
 *       n= 24   0.8 us/step        n=100   11.9 us/step
 *       n= 44   2.5 us/step        n=140   24.1 us/step
 *       n= 72   6.3 us/step        n=200   55.6 us/step
 *   Quadratic, exactly as its own docstring says - and at 200 characters that
 *   is 3.3 ms per SECOND of wall clock, i.e. 0.06 ms per frame. It is not the
 *   reason for anything.
 *
 *   `_updateLOD`, per frame, crowd spread over 900 m
 *       n=24 0.2 us · n=72 0.5 us · n=200 1.5 us.  Linear and free.
 *
 *   `Navigation.update`'s neighbour separation, which walks the WHOLE
 *   population for every agent that is going somewhere
 *       n=24 0.161 us · n=72 0.311 us · n=200 0.759 us per agent-step,
 *   i.e. about 3 ns per neighbour. Also not the reason.
 *
 * WHAT IS. The cost of a character is the character, not the bookkeeping
 * around it. `NPCManager`'s own header records the ablation: removing
 * `fixedUpdate` outright on the station, at 44-72 characters, measured -2.0 ms
 * on the plaza, -2.0 ms on the walkway loop and -3.6 ms in the construction
 * court against a 16-21 ms frame. That is roughly 30-50 us per character per
 * frame for the think/steer/integrate step and the four raycasts it carries
 * (capsule resolve, ground probe, nav probe, water probe) - between one hundred
 * and one thousand times everything measured above. `lod.sim` divides it by up
 * to 8 with distance and cannot divide it by zero.
 *
 * AND THE ARITHMETIC THAT SETTLES IT. Sampling a flat roster of the vale's
 * planned population from fourteen positions - the player spawn, every
 * settlement centre and four road midpoints - measures **74.6% of it beyond
 * `RENDER_OUT` (135 m) at any moment**, and that is with the NINE settlements
 * shipped today; the five the expansion adds push it past 85%. Three quarters
 * of the budget would be spent simulating characters that are not drawn.
 *
 * The flat roster is also 94 bodies against a ceiling of 72 before the merge
 * and about 140 after it, so "raise the cap" is not a small adjustment - it is
 * a doubling, to buy a population that is three quarters invisible.
 *
 * So the population is not raised, it is MOVED. The roster is unbounded and
 * costs a plain object each; the live cast is small, local, and fits inside the
 * budget the world already had. Peak demand inside the 175 m stream radius
 * measured 45 bodies over the same fourteen positions, against a live cap of
 * 24 civilians and 8 animals.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ALSO FIXES A SILENT FAILURE
 *
 * `NPCManager.spawnForWorld` walks `npcSpawns` in order and `continue`s past
 * everything once the budget is full, so an over-budget world loses its LAST
 * authored spawns - and "last" means "whichever district was written most
 * recently", which is exactly the new towns. The station's docstrings record
 * this failure happening twice (a merchant in a galley nobody could reach, a
 * construction zone that shipped with zero hostiles).
 *
 * Streaming inverts it. When the live cap binds it binds on the FURTHEST
 * candidate, because the roster is sorted by distance before anything is
 * spawned. The character you lose is always the one you were least able to see.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES NOT OWN
 *
 * Characters. `NPCManager` owns every character in the game; this holds specs
 * and asks. That is the same division `MazePopulation` draws, and the same
 * hazard applies: the manager destroys its whole cast on any world activation
 * without telling anyone, so a held reference is re-checked with `owns()` on
 * every sync rather than trusted. Assuming otherwise is what once left a maze
 * with no wanderers in it at all, silently, because every retry saw a non-null
 * `npc` and skipped.
 *
 * Hostiles are not streamed. `NPCManager.spawnOne` hard-returns null for
 * `type: 'hostile'` and says why - a streamed hostile would arrive with no
 * respawn bookkeeping and no weapon deal. The vale's ten bandit patrols stay
 * authored in `npcSpawns`, which is what they were. Beasts have their own
 * public post-spawn entry point (`spawnBeastGroup`), so they stream.
 *
 * Nothing here imports `three`. A spec's `position` is a `THREE.Vector3` built
 * by the caller, but only `.x` and `.z` are ever read off it, so the streaming
 * decision is plain arithmetic and testable against a plain object.
 */

export class MedievalResidency {
  /**
   * @param {object} o
   * @param {() => any} o.npcManager resolved per call, never captured
   * @param {Array<object>} o.people   friendly specs, world-space Vector3 positions
   * @param {Array<object>} o.beasts   pack specs `{position, species, territory}`
   * @param {number} [o.spawnRadius]
   * @param {number} [o.despawnRadius]
   * @param {number} [o.maxLive]       live streamed friendlies
   * @param {number} [o.maxLiveBeasts] live streamed animals (bodies, not packs)
   */
  constructor({
    npcManager,
    people = [],
    beasts = [],
    /* Comfortably past `RENDER_OUT = 135`, so a character is built while it is
     * still not being drawn and there is no pop. The 45 m gap to the despawn
     * edge is hysteresis: with one threshold a player standing on it makes the
     * whole hamlet blink. */
    spawnRadius = 175,
    despawnRadius = 220,
    /* Sized against what the vale already spends, not chosen. `spawnForWorld`
     * builds 12 authored friendlies, one lorekeeper, one questmaster and a hub
     * crowd of 9 (`FRIENDLY_BUDGET` 22 less the 13 authored), plus ten bandit
     * patrols: 33 permanent bodies. 24 + 8 animals brings the worst case to 65
     * against `maxNPCs` of 72, leaving seven for anything a merge adds.
     *
     * Demand measured 45 bodies inside the stream radius at the busiest of
     * fourteen sample positions, so the cap does bind there - and binding is
     * fine BECAUSE of the sort in `sync`: what it refuses is the furthest 11,
     * every one of them past 130 m. */
    maxLive = 24,
    /* Bodies, not packs - a wolf site is three to five animals. Eight is under
     * `NPCManager`'s own `BEAST_CEILING` of 14, and deliberately so: a beast is
     * 22 meshes and 15 shadow casters against a humanoid's 2, and its sense
     * scan walks every live civilian. Two packs at once is the encounter the
     * species was tuned for; three is a rout. */
    maxLiveBeasts = 8,
  }) {
    this._npcManager = npcManager;
    this.spawnRadius = spawnRadius;
    this.despawnRadius = despawnRadius;
    this.maxLive = maxLive;
    this.maxLiveBeasts = maxLiveBeasts;

    /** @type {Array<{spec:object, npc:any, kind:'friendly'}>} */
    this.people = people.map((spec) => ({ spec, npc: null, kind: 'friendly' }));
    /** @type {Array<{spec:object, bodies:any[], kind:'beast'}>} */
    this.beasts = beasts.map((spec) => ({ spec, bodies: [], kind: 'beast' }));

    this._sinceTick = 0;
    this._lastX = Infinity;
    this._lastZ = Infinity;
    /** Counters the headless gates and the report read. */
    this.stats = { syncs: 0, spawned: 0, despawned: 0, refused: 0 };
  }

  /** The live NPC manager, or null. Resolved per call, never cached. */
  get npcManager() {
    return this._npcManager?.() ?? null;
  }

  /** Streamed friendlies that actually have a character in the world. */
  liveCount() {
    const mgr = this.npcManager;
    let n = 0;
    for (const e of this.people) {
      if (!e.npc) continue;
      if (mgr?.owns?.(e.npc) === false) continue;
      n++;
    }
    return n;
  }

  /** Streamed animals - BODIES, because that is what the budget is in. */
  liveBeastCount() {
    const mgr = this.npcManager;
    let n = 0;
    for (const e of this.beasts) {
      for (const b of e.bodies) {
        if (mgr?.owns?.(b) === false) continue;
        n++;
      }
    }
    return n;
  }

  /** Every roster entry, live or not - the number the design is written in. */
  get rosterSize() {
    return this.people.length + this.beasts.length;
  }

  /**
   * Bring the live cast in line with where the player is.
   *
   * Throttled on BOTH time and travel: standing still is the common case and
   * costs one compare, and a player sprinting at 9 m/s cannot cross the 45 m
   * hysteresis gap between two syncs.
   *
   * @param {number} x eye position
   * @param {number} z
   * @param {number} dt
   * @returns {boolean} true when anything changed
   */
  update(x, z, dt = 0) {
    this._sinceTick += dt;
    const moved = Math.abs(x - this._lastX) + Math.abs(z - this._lastZ);
    if (this._sinceTick < 0.4 && moved < 8) return false;
    this._sinceTick = 0;
    this._lastX = x;
    this._lastZ = z;
    return this.sync(x, z);
  }

  /**
   * The whole streaming decision, in one pass and with no allocation per
   * entry beyond the sort key array.
   *
   * Order matters and is the same order `MazeChunks` and `MazePopulation` use:
   * RELEASE first, then acquire. Releasing before loading keeps the peak live
   * count at the size of the wanted set rather than at the size of its union
   * with the previous one - which, against a hard `maxNPCs`, is the difference
   * between a town filling and a town half-filling because the last one had not
   * let go yet.
   */
  sync(x, z) {
    const mgr = this.npcManager;
    if (!mgr) return false;
    this.stats.syncs++;
    let changed = false;

    const out2 = this.despawnRadius * this.despawnRadius;
    const in2 = this.spawnRadius * this.spawnRadius;

    /* ---- release ---------------------------------------------------- */
    for (const e of this.people) {
      if (e.npc && mgr.owns?.(e.npc) === false) { e.npc = null; continue; }
      if (!e.npc) continue;
      const p = e.spec.position;
      if ((p.x - x) ** 2 + (p.z - z) ** 2 <= out2) continue;
      mgr.despawn?.(e.npc);
      e.npc = null;
      this.stats.despawned++;
      changed = true;
    }
    for (const e of this.beasts) {
      if (!e.bodies.length) continue;
      /* A pack whose members the manager no longer owns is a pack that is
       * gone - dropped by a world change, or killed and cleaned up. Filtered
       * rather than despawned, or `despawn` would be called on a disposed body. */
      e.bodies = e.bodies.filter((b) => mgr.owns?.(b) !== false);
      if (!e.bodies.length) continue;
      const p = e.spec.position;
      if ((p.x - x) ** 2 + (p.z - z) ** 2 <= out2) continue;
      for (const b of e.bodies) mgr.despawn?.(b);
      this.stats.despawned += e.bodies.length;
      e.bodies = [];
      changed = true;
    }

    /* ---- acquire, nearest first ------------------------------------- */
    let live = this.liveCount();
    if (live < this.maxLive) {
      const want = [];
      for (const e of this.people) {
        if (e.npc) continue;
        const p = e.spec.position;
        const d2 = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (d2 > in2) continue;
        want.push({ e, d2 });
      }
      /* THE POINT OF THE WHOLE CLASS. When the cap binds it binds on the
       * furthest candidate, not on whichever spec happened to be written last
       * in the roster. */
      want.sort((a, b) => a.d2 - b.d2);
      for (const { e } of want) {
        if (live >= this.maxLive) { this.stats.refused++; break; }
        const npc = mgr.spawnOne?.(e.spec) ?? null;
        if (!npc) { this.stats.refused++; continue; }
        e.npc = npc;
        live++;
        this.stats.spawned++;
        changed = true;
      }
    }

    let liveBeasts = this.liveBeastCount();
    if (liveBeasts < this.maxLiveBeasts) {
      const want = [];
      for (const e of this.beasts) {
        if (e.bodies.length) continue;
        const p = e.spec.position;
        const d2 = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (d2 > in2) continue;
        want.push({ e, d2 });
      }
      want.sort((a, b) => a.d2 - b.d2);
      for (const { e } of want) {
        const room = this.maxLiveBeasts - liveBeasts;
        if (room <= 0) { this.stats.refused++; break; }
        /* A pack is spawned as a pack or not at all - `spawnBeastGroup` takes
         * the remaining room as its budget, and a pack cut to one member is a
         * wolf with nothing to coordinate with (see the note on `pack` in
         * `spawnBeastGroup`). */
        const made = mgr.spawnBeastGroup?.(e.spec, room) ?? [];
        if (!made.length) { this.stats.refused++; continue; }
        e.bodies = made;
        liveBeasts += made.length;
        this.stats.spawned += made.length;
        changed = true;
      }
    }
    return changed;
  }

  /** Release everything. The teardown path. */
  disposeAll() {
    const mgr = this.npcManager;
    for (const e of this.people) {
      if (e.npc && mgr?.owns?.(e.npc) !== false) mgr?.despawn?.(e.npc);
      e.npc = null;
    }
    for (const e of this.beasts) {
      for (const b of e.bodies) if (mgr?.owns?.(b) !== false) mgr?.despawn?.(b);
      e.bodies = [];
    }
  }

  /** `World.dispose` walks `_owned` and calls this. */
  dispose() {
    this.disposeAll();
  }
}
