import * as THREE from 'three';

/**
 * The test-fire butts: Lodestar Yard's shooting range, in the service trench.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The yard runs `hostiles: false` on purpose — a firefight inside a hangar
 * full of walk-in hulls puts the interior work and the combat work in each
 * other's way — and the consequence nobody had answered is that `rules.weapons`
 * was ON in a world where no weapon had anything to point at. A player walks in
 * carrying a rifle, a bow and a gauntlet and all three are luggage.
 *
 * A range fixes that without a single hostile, and it pays two other debts on
 * the way:
 *
 *  - **`laser_cell` gets a sink.** The design's own rule is "never ship a
 *    buyable with no Drop-One effect", and the cell was authored for a laser
 *    the flight drop has not written yet. The butts burn eight cells to light
 *    the plates for a run, so the rack the Fitting Shop sells is a purchase
 *    with a consequence today.
 *  - **The quest arc gets a non-fetch objective.** Every other step in this
 *    world is press-E, collect-N, buy-one or stand-still-for-two-minutes.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  HOW A HIT IS SCORED, AND WHY IT IS NOT A RAYCAST OF OUR OWN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every plate in the butts is a real world collider that `DockWorld._buildButts`
 * registers. So a round fired at one is resolved by the systems that already
 * exist: `Combat._shoot` raycasts the world, `_resolveWorldHit` sprays the
 * impact, stamps the decal and emits `weapon:hit {point, normal, isNPC:false}`.
 * `Projectiles` does the same job for the bow and the gauntlet and emits
 * `projectile:hit {point, normal, npc}`.
 *
 * This module subscribes to those two events and asks one question of the
 * point: is it inside an ARMED plate's box? That is the whole hit test.
 *
 * The alternative — re-raycasting off `weapon:fired` against our own boxes —
 * was rejected for a specific reason rather than on taste: it would score hits
 * on a plate that the round never reached, because `weapon:fired` carries the
 * shot before the world has been consulted and a bulkhead, a cradle leg or a
 * hull between the muzzle and the plate would not be in our test. Scoring off
 * the RESOLVED hit means the range agrees with the impact spray the player can
 * see, always, including the one it did not draw.
 *
 * `PLATE_PAD` is the one tolerance: the resolved contact point sits ON the
 * collider face, and floating-point arithmetic on a rotated box puts it a
 * fraction either side. 40 mm is comfortably inside the gap between a plate
 * and its neighbour (the nearest two plates are 1.58 m apart) so the pad can
 * never move a hit from one target to another.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE RANKS ARE THE DIFFICULTY, AND THEY ARE SEQUENCED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three ranks of two plates, at 10 / 18 / 26 m from the firing mark, and the
 * plates get smaller as the range gets longer (0.68 / 0.52 / 0.40 m square).
 * Only one rank is armed at a time: clear both plates in the near rank and the
 * mid rank lights. A round into an unarmed plate is a real world hit with a
 * real spray and scores nothing, which is what makes the sequence readable.
 *
 * Sequencing rather than lighting all six is what makes this a course instead
 * of a wall of targets: the clock is shared, so the near rank is the time you
 * bank for the far one.
 */

/**
 * The id the finish event carries as `target`/`id`.
 *
 * `scripts/quest-vocab.mjs` scrapes this constant by name — the regex is
 * `export const (\w*GAME_ID) = '([a-z0-9_]+)'` — follows `main.js`'s
 * `registerGame` call to find which kind runs this module, and only then will
 * it offer `test_fire_won` / `test_fire_lost` as a legal `minigame` target in
 * the dock. Rename it and the vocabulary moves with it instead of leaving a
 * hand-copied string behind.
 */
export const TEST_FIRE_GAME_ID = 'test_fire';

/** Metres of slack around a plate's box when testing a resolved hit point. */
const PLATE_PAD = 0.04;

/** Seconds of "on your marks". Short — you are already on the mark. */
const COUNTDOWN_S = 3.0;

/** Fallbacks for a venue that publishes an incomplete config. */
const DEFAULT_SECONDS = 45;
const DEFAULT_CELLS = 8;

/** How far from the firing mark a run may be started. */
const MARK_R = 6.0;
/** Vertical band on that gate. The trench is 2.1 m of clear height. */
const MARK_BAND = 1.6;

/** mm:ss.t */
function clockText(t) {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
}

/**
 * Read the venue's target list into the shape this module scores against.
 *
 * Returns null rather than throwing for a venue that publishes nothing usable,
 * because `MinigameManager` treats a null factory result as "not available"
 * and a thrown one as an error it logs — and a world shipping a malformed
 * descriptor is the first case, not the second.
 *
 * @param {any} venue
 */
export function readTargets(venue) {
  const raw = venue?.config?.targets;
  if (!Array.isArray(raw) || !raw.length) return null;
  const out = [];
  for (const t of raw) {
    const x = Number(t?.x);
    const y = Number(t?.y);
    const z = Number(t?.z);
    const hx = Number(t?.hx);
    const hy = Number(t?.hy);
    const hz = Number(t?.hz);
    if (![x, y, z, hx, hy, hz].every(Number.isFinite)) continue;
    if (hx <= 0 || hy <= 0 || hz <= 0) continue;
    out.push({
      id: typeof t?.id === 'string' && t.id ? t.id : `plate-${out.length}`,
      rank: Number.isFinite(Number(t?.rank)) ? Math.max(0, Math.floor(Number(t.rank))) : 0,
      x, y, z, hx, hy, hz,
      down: false,
    });
  }
  return out.length ? out : null;
}

export class TestFire {
  /**
   * @param {object} venue the manager's validated venue record
   * @param {{player?:any, bus?:any, input?:any, inventory?:any,
   *          worldManager?:any, scene?:any}} ctx
   */
  constructor(venue, ctx = {}) {
    this.id = TEST_FIRE_GAME_ID;
    this.venue = venue;
    this.bus = ctx.bus ?? null;
    this.player = ctx.player ?? null;

    this.targets = readTargets(venue);
    if (!this.targets) throw new Error('test fire: the venue publishes no usable plates');

    this.ranks = Math.max(1, ...this.targets.map((t) => t.rank + 1));
    const secs = Number(venue?.config?.seconds);
    this.limit = Number.isFinite(secs) && secs > 0 ? secs : DEFAULT_SECONDS;

    /** Rank currently lit. Nothing scores outside it. */
    this.rank = 0;
    this.down = 0;
    this.clock = 0;
    /** Rounds that hit an armed plate, so the HUD can show a hit count. */
    this.hits = 0;

    this._host = ctx.worldManager?.active?.group ?? ctx.scene ?? this.player?.scene ?? null;
    this._offs = [];
    this._lamps = new Map();
    this._lampGeo = null;
    this._lampMat = null;
    this._buildLamps();
  }

  get countdown() {
    return COUNTDOWN_S;
  }

  /**
   * One glowing pip per plate, hung a hand's breadth in front of it.
   *
   * Drawn by this module rather than by the world because it is STATE: a lamp
   * is lit while its plate is armed and gone the moment it is down, and the
   * world's plates are a permanent fixture that has to look the same when
   * nobody is shooting. Two materials and one geometry for all six, disposed
   * with the run — the module owns them, so a contest abandoned mid-run frees
   * them exactly as a completed one does.
   *
   * No host group is not an error: it is the headless case, and the contest is
   * unchanged without it. That is the same contract `RooftopTrial._buildGhost`
   * and `GhostCompetitor` keep, and it is what lets the whole of this file be
   * driven by a test with no renderer.
   */
  _buildLamps() {
    if (!this._host || typeof this._host.add !== 'function') return;
    this._lampGeo = new THREE.SphereGeometry(0.07, 10, 8);
    this._lampMat = new THREE.MeshBasicMaterial({ color: 0x4dffa6, toneMapped: false });
    for (const t of this.targets) {
      const m = new THREE.Mesh(this._lampGeo, this._lampMat);
      // Toward the firing mark, which is +Z of every plate in this venue.
      m.position.set(t.x, t.y + t.hy + 0.14, t.z + t.hz + 0.10);
      m.visible = false;
      m.name = `butts-lamp-${t.id}`;
      this._host.add(m);
      this._lamps.set(t.id, m);
    }
  }

  /** Light the armed rank and darken everything else. */
  _relight() {
    for (const t of this.targets) {
      const lamp = this._lamps.get(t.id);
      if (lamp) lamp.visible = !t.down && t.rank === this.rank;
    }
  }

  begin(elapsed) {
    void elapsed;
    this.clock = 0;
    /* Subscribed at BEGIN, not in the constructor. The countdown runs for
     * three seconds between the two, and a player who fires during it would
     * otherwise put the near rank down before the range was live — which is
     * the same class of bug as a race that counts a checkpoint during the
     * start lights. `dispose` releases these on every exit path the manager
     * has: finish, abort, walk-away, death and world change. */
    const onHit = (evt) => this._onHit(evt);
    if (this.bus) {
      this._offs.push(this.bus.on('weapon:hit', onHit));
      this._offs.push(this.bus.on('projectile:hit', onHit));
    }
    this._relight();
    this.bus?.emit('testfire:started', {
      venueId: this.venue.id,
      label: this.venue.label,
      plates: this.targets.length,
      ranks: this.ranks,
      seconds: this.limit,
    });
  }

  /**
   * A resolved impact somewhere in the world.
   *
   * Ignores anything that hit an NPC: `weapon:hit` carries `isNPC` and
   * `projectile:hit` carries the `npc` it struck, and in a world with
   * `hostiles: false` neither should ever be set — but the range must not
   * start scoring the day somebody flips that rule, because a body standing in
   * front of a plate is not a hit ON the plate.
   *
   * @param {{point?:any, isNPC?:boolean, npc?:any}} evt
   */
  _onHit(evt) {
    if (evt?.isNPC === true || evt?.npc) return;
    const p = evt?.point;
    const px = Number(p?.x);
    const py = Number(p?.y);
    const pz = Number(p?.z);
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) return;

    for (const t of this.targets) {
      if (t.down || t.rank !== this.rank) continue;
      if (Math.abs(px - t.x) > t.hx + PLATE_PAD) continue;
      if (Math.abs(py - t.y) > t.hy + PLATE_PAD) continue;
      if (Math.abs(pz - t.z) > t.hz + PLATE_PAD) continue;
      this._knockDown(t);
      return;
    }
  }

  _knockDown(t) {
    t.down = true;
    this.down++;
    this.hits++;
    const lamp = this._lamps.get(t.id);
    if (lamp) lamp.visible = false;

    const rankLeft = this.targets.filter((x) => x.rank === this.rank && !x.down).length;
    this.bus?.emit('testfire:plate', {
      venueId: this.venue.id,
      plate: t.id,
      rank: this.rank,
      down: this.down,
      of: this.targets.length,
      time: this.clock,
    });
    if (rankLeft > 0) return;

    // Rank clear. Advance and relight; the FINISH is decided in fixedUpdate so
    // there is exactly one place a contest can end.
    this.rank++;
    this._relight();
    if (this.rank < this.ranks) {
      this.bus?.emit('hud:notify', {
        text: `Rank ${this.rank} down — ${clockText(this.limit - this.clock)} left`,
        tone: 'info',
      });
    }
  }

  /**
   * @param {number} dt fixed step
   * @param {number} clock seconds since the lights went out
   * @returns {object|null} an outcome ends the contest
   */
  fixedUpdate(dt, clock) {
    void dt;
    this.clock = clock;

    if (this.down >= this.targets.length) {
      return {
        won: true,
        place: 1,
        total: 2,
        score: this.down,
        scoreLabel: `${this.down}/${this.targets.length} plates in ${clockText(this.clock)}`,
        detail: `all ${this.ranks} ranks`,
      };
    }
    if (this.clock >= this.limit) {
      return {
        won: false,
        place: 2,
        total: 2,
        score: this.down,
        scoreLabel: `${this.down}/${this.targets.length} plates`,
        detail: `time out on rank ${Math.min(this.rank + 1, this.ranks)}`,
      };
    }
    return null;
  }

  snapshot() {
    const left = this.limit - this.clock;
    return {
      rows: [
        { k: 'TIME', v: clockText(Math.max(0, left)), tone: left <= 8 ? 'warn' : null },
        { k: 'RANK', v: `${Math.min(this.rank + 1, this.ranks)}/${this.ranks}` },
        { k: 'PLATES', v: `${this.down}/${this.targets.length}` },
      ],
      progress: Math.max(0, Math.min(1, this.down / this.targets.length)),
    };
  }

  /** Idempotent: the manager tears down on quit, death and world change too. */
  dispose() {
    for (const off of this._offs) {
      try {
        off?.();
      } catch {
        /* a subscription already released is not an error */
      }
    }
    this._offs.length = 0;
    for (const lamp of this._lamps.values()) lamp.parent?.remove(lamp);
    this._lamps.clear();
    this._lampGeo?.dispose?.();
    this._lampMat?.dispose?.();
    this._lampGeo = null;
    this._lampMat = null;
  }
}

/**
 * The factory `minigames.registerGame('test_fire', ...)` calls.
 *
 * Three gates, in this order, and the order is the point:
 *
 *  1. **A usable venue.** No plates, no contest — null, not a throw.
 *  2. **On the mark.** The venue disc is 22 m so the prompt is up along the
 *     whole range (it has to be, or `LEAVE_GRACE_S` abandons a run the moment
 *     you walk down to check a plate). So the START gate lives here, and it
 *     says WHERE rather than just no — `RooftopTrial`'s recorded reason: a bare
 *     "not available" over a working venue reads as a broken world.
 *  3. **The cells.** Checked and only THEN consumed, and consumed before the
 *     contest object is built so a run that starts has already paid. The order
 *     is `MountSkins`': refuse before anything is consumed, because "a purchase
 *     must never be consumed with nowhere for it to land" — here, a rack burned
 *     for a contest that then failed to construct.
 *
 * @param {object} venue
 * @param {object} ctx
 * @returns {TestFire|null}
 */
export function createTestFire(venue, ctx = {}) {
  if (!readTargets(venue)) return null;

  const mark = venue?.config?.fireMark;
  const p = ctx.player?.position;
  if (p && mark && Number.isFinite(Number(mark.x))) {
    const d = Math.hypot(p.x - Number(mark.x), p.z - Number(mark.z));
    if (d > MARK_R || Math.abs(p.y - Number(mark.y)) > MARK_BAND) {
      ctx.bus?.emit('hud:notify', {
        text: `${venue.label ?? 'The butts'} fires from the mark, ${Math.round(d)} m back up the trench`,
        tone: 'warn',
      });
      return null;
    }
  }

  const cells = Number(venue?.config?.cells);
  const cost = Number.isFinite(cells) && cells > 0 ? Math.floor(cells) : DEFAULT_CELLS;
  const inv = ctx.inventory ?? null;
  if (inv && typeof inv.bagCount === 'function') {
    const held = inv.bagCount('laser_cell');
    if (held < cost) {
      ctx.bus?.emit('hud:notify', {
        text: `The butts run off a cell rack — ${cost} laser cells, and you have ${held}`,
        tone: 'warn',
      });
      return null;
    }
  }

  let game = null;
  try {
    game = new TestFire(venue, ctx);
  } catch (err) {
    console.warn('[test-fire] the butts failed to build:', err?.message ?? err);
    return null;
  }

  /* Paid last, and only once the contest exists. `consumeFromBag` returning
   * false after the count above passed would mean the bag moved between the
   * two reads, so the built contest is thrown away rather than run for free. */
  if (inv && typeof inv.consumeFromBag === 'function') {
    if (!inv.consumeFromBag('laser_cell', cost)) {
      game.dispose();
      return null;
    }
    ctx.bus?.emit('hud:notify', { text: `${cost} cells racked — plates live`, tone: 'info' });
  }
  return game;
}

export default createTestFire;
