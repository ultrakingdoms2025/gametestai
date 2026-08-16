import * as THREE from 'three';
import { TrackPath, RacerField, DIFFICULTIES, makeTestCircuit } from './RacerAI.js';
import { Pickups, PICKUP_VALUE } from './Pickups.js';
import { Contacts } from './Contacts.js';
import { RaceRings, buildDragonRingCheckpoints, DRAGON_RACE } from './RaceRings.js';
import { RaceLoops } from './RaceLoops.js';
import { allows } from '../worlds/WorldRules.js';

/**
 * The race: state machine, lap validation, placement and prize money.
 *
 * ── What stops a racer farming laps ──────────────────────────────────────────
 *
 * A lap counter that fires on "crossed the start/finish line" is trivially
 * cheated: stop on the line, reverse two metres, drive forward, repeat. It is
 * not even malice - a spin on the pit straight does it by accident, and the
 * player then finishes a race they never drove.
 *
 * So a lap is not a line crossing here. It is the *completion of an ordered
 * sequence*: a racer holds a single `nextCp` cursor and only the checkpoint at
 * that cursor can advance it. Every other checkpoint in the world is inert to
 * that racer, which means:
 *
 *   - Reversing over the line does nothing, because after the line the cursor
 *     is already pointing at checkpoint 1, not at 0.
 *   - Cutting the infield does nothing, because the checkpoints in between were
 *     never armed and the cursor never moved past them.
 *   - The lap only ticks on the pass of checkpoint 0 that follows a pass of the
 *     last checkpoint - which is the definition of a lap.
 *
 * The cursor is tested against the *segment* the racer travelled this step, not
 * against its end point. At 34 m/s a fixed step covers 0.57 m, so a point test
 * would be safe today - but it would silently become a tunnelling bug the first
 * time somebody widened the step or added a faster mount, and a swept test is
 * four lines.
 *
 * ── Placement ────────────────────────────────────────────────────────────────
 *
 * Finished racers rank by finish time. Everyone else ranks by how many
 * checkpoints they have validated, then by how close they are to the next one -
 * which is monotonic by construction (a racer cannot gain a checkpoint without
 * driving to it) and needs no arc-length bookkeeping for the player, who is free
 * to spin, reverse or leave the road entirely.
 */

/** Prize money, by finishing position. Only the player is paid. */
export const RACE_PRIZES = [10, 5, 2];
/** The most racers any circuit can grid, player included. Hard packs 20. */
export const MAX_RACERS = 20;
/**
 * Which grid slot the player gets.
 *
 * Not pole, and not the back. From pole every difficulty below the player's
 * pace is a procession with nothing in the mirrors; from the back the first lap
 * is spent in traffic before the race begins. Mid-grid there is a field to
 * catch and a field to hold off whatever band is chosen.
 */
export const PLAYER_GRID_SLOT = 4;
export const RACE_TYPES = { CAR: 'car', DRAGON: 'dragon' };

/**
 * Per-difficulty field shape, shared by the car and dragon races.
 *
 * The three bands are meant to feel genuinely different rather than being the
 * same race with a faster opposition:
 *
 *   - easy   — a small field you start in the middle of and beat by driving or
 *              flying cleanly. The rivals top out below either of the player's
 *              race mounts.
 *   - medium — a bigger field, a longer race, and rivals that are *quicker in
 *              a straight line than the player's stock mount*. You start near
 *              the back. Winning means good lines, or spending mount/spell
 *              powers from the shop: a Power upgrade lifts your top speed, a
 *              Strength/Shield build lets you lean on the field, offensive
 *              charms slow or damage them.
 *   - hard   — the same idea turned up: the largest field, the longest race,
 *              the fastest rivals, and the deepest grid slot. Effectively
 *              unwinnable stock, which is the point.
 *
 * "Shared by the car and dragon races" is literal - `RacerAI.reset` takes a
 * mode and branches on it only for the mount's height off the road, so a
 * dragon race's rivals are cars flown ten metres up at car speeds. That is a
 * deliberate calibration and not an oversight; the note on DIFFICULTIES in
 * RacerAI.js has the measured lap times for both mounts on all three circuits
 * and scripts/tests/race-pace.test.mjs gates them.
 *
 * `cars` counts the player. `playerSlot` is a 0-based grid index (0 = pole).
 * The AI performance band itself (top speed, grip, mistakes) lives in
 * DIFFICULTIES in RacerAI.js.
 */
export const DIFFICULTY_FIELD = {
  easy: { cars: 10, playerSlot: 4 },   // 5th of 10
  standard: { cars: 15, playerSlot: 9 },   // 10th of 15
  expert: { cars: 20, playerSlot: 14 },  // 15th of 20
};

export const RACE_STATE = {
  IDLE: 'idle',
  COUNTDOWN: 'countdown',
  RACING: 'racing',
  FINISHED: 'finished',
};

/* ---- start procedure ------------------------------------------------------
 *
 * An F1 start, because that is what a gantry with five columns of lights on it
 * is. The columns illuminate one per second; when all five are lit the start is
 * armed, and the race begins the moment they all go *out* together - not when
 * the last one comes on.
 *
 * The hold before they go out is randomised, which is the entire point of the
 * procedure: a fixed delay is a rhythm you can count, and the whole reason a
 * real start is tense is that you cannot. The window is tighter than the
 * sport's 0.2-3 s, because at three seconds with no engine note to read a
 * player assumes the game has hung.
 */
const START_LIGHTS = 5;
/** Seconds between columns coming on. */
const LIGHT_STEP_S = 1.0;
/** Dead time before the first column, so the sequence has a beginning. */
const LIGHT_LEAD_S = 1.0;
const HOLD_MIN_S = 0.7;
const HOLD_MAX_S = 1.9;
/** Seconds the player is given to get home after the last rival finishes. */
const FINISH_GRACE = 25;
/**
 * Metres of centreline per collectable drop.
 *
 * A lap is then worth a handful without the road becoming a coin carpet, and
 * the count scales with the circuit rather than being a fixed number that would
 * feel sparse on a long one and cluttered on a short one.
 */
const DROP_SPACING_M = 40;

const _v = new THREE.Vector3();
const _seat = new THREE.Vector3();
const _clampSample = { x: 0, y: 0, z: 0, width: 12, tx: 0, tz: -1 };

/** Squared distance from point `p` to the segment `a`->`b`, in XZ. */
function segDistSq(ax, az, bx, bz, px, pz) {
  const ex = bx - ax;
  const ez = bz - az;
  const e2 = ex * ex + ez * ez;
  let t = e2 > 1e-9 ? ((px - ax) * ex + (pz - az) * ez) / e2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + ex * t);
  const dz = pz - (az + ez * t);
  return dx * dx + dz * dz;
}

export class RaceManager {
  /**
   * @param {{scene:THREE.Scene, physics:any, bus:any, materials:any, player:any,
   *          mounts:any, economy:any, worldManager:any}} ctx
   */
  constructor({ scene, physics, bus, materials, player, mounts, economy, worldManager }) {
    this.scene = scene;
    this.physics = physics;
    this.bus = bus;
    this.player = player;
    this.mounts = mounts ?? null;
    this.economy = economy ?? null;
    this.worldManager = worldManager ?? null;
    /* Collectables along the circuit. Owned here rather than by the world so
     * they reset per race rather than per world build, and so the synthetic
     * test circuit gets them too. */
    this.pickups = new Pickups({ scene, bus, materials });
    this.rings = new RaceRings({ scene });
    /* Car-to-car contact. The rivals have no colliders by design, so without
     * this the player drives through them - see the note in Contacts.js. */
    this.contacts = new Contacts({ bus, path: null });
    /* The 360 loop. Fed from the world rather than from the armed track,
     * because a loop is part of the road: driving up to one with no race
     * running has to take you round it too. See RaceLoops.js. */
    this.loops = new RaceLoops({ bus, physics, player, mounts });
    /* A stand-in entry for the player when no race is on, so the loop can be
     * driven outside one. Deliberately not pushed into `entries` - that array
     * is the classification, and something in it that is not racing would be
     * ranked, scored and shown on the leaderboard. */
    this._freeEntry = {
      id: 'player', isPlayer: true, position: null, speed: 0, _px: 0, _pz: 0,
    };

    this.state = RACE_STATE.IDLE;
    /** Track data as read from the world, or from the synthetic test circuit. */
    this.track = null;
    /** @type {TrackPath|null} */
    this.path = null;
    this.difficulty = 'standard';
    this.difficulties = ['standard'];
    this.raceType = RACE_TYPES.CAR;
    this.raceTypes = [RACE_TYPES.CAR, RACE_TYPES.DRAGON];
    this.lapCount = 3;
    /** 0-based grid slot the player took at the last start; drives placement
     * and the "you start Nth" readout. Set from DIFFICULTY_FIELD in start(). */
    this.playerGridSlot = PLAYER_GRID_SLOT;

    this.field = new RacerField({ scene, physics, materials });
    /** @type {Array<object>} entrants, player included */
    this.entries = [];
    /** Ranked snapshot, rebuilt every fixed step while racing. */
    this.order = [];
    /** Minimap feed: one marker per racer. Rewritten in place, never reallocated. */
    this.markers = [];
    /** Circuit outline for the minimap, as flat [x,z] pairs. */
    this.circuit = null;
    /** @type {Array<object>|null} final classification once the flag is out */
    this.results = null;
    this._baseCheckpoints = [];
    this._ringCheckpoints = [];

    this.clock = 0;
    this._countdown = 0;
    this._countdownTotal = 0;
    this._lastBeep = -1;
    /** Columns currently lit on the gantry, or -1 before a start is armed. */
    this._lit = -1;
    /** Seconds the gantry stays green after the off. */
    this._goHold = 0;
    this._timeLimit = 600;
    this._playerPlace = 0;
    this._playerEntry = null;
    this._graceFrom = 0;
    this._seed = 1;

    // A race is bound to the world it was armed in. Leaving mid-race abandons
    // it rather than leaving a state machine running over a track that is no
    // longer in the scene.
    this._onWorldChanging = () => this._teardown();
    bus?.on?.('world:changing', this._onWorldChanging);
    this._onWorldChanged = ({ world }) => {
      /* Re-arm on EVERY world change - and in a world that forbids races,
       * re-arm on NOTHING, which is what clears the last one.
       *
       * This used to RETURN early when `allows(world, 'races')` was false, on
       * the reasoning that there is nothing to do where there are no circuits.
       * But `arm` is what clears a loaded track, so returning left the previous
       * world's circuit armed: walk from the circuit into the maze and `ready`
       * stayed true, the manager still believing it had a track four
       * kilometres away, and the race panel still answered F7 in a hedge maze.
       *
       * Arming with no world is the fix rather than dropping the rules check:
       * section 5 of the maze spec requires this file to honour `rules.races`,
       * and `arm(null)` finds no track and clears everything (see its own
       * contract), so the rule is honoured AND the stale state goes. */
      this.arm(allows(world, 'races') ? world : null);
    };
    bus?.on?.('world:changed', this._onWorldChanged);
  }

  /* ================================================================ */
  /* Contract surface                                                  */
  /* ================================================================ */

  get racing() {
    return this.state === RACE_STATE.RACING || this.state === RACE_STATE.COUNTDOWN;
  }

  /** True once a track is loaded and `start()` will do something. */
  get ready() {
    return !!(this.path && this.path.valid && this.track?.checkpoints?.length >= 3);
  }

  get dragonRace() {
    return this.raceType === RACE_TYPES.DRAGON;
  }

  /**
   * Field shape for a difficulty: how many cars start and where the player
   * sits on the grid. Falls back to a full 10-car field from mid-grid for any
   * band a circuit invents that isn't in the table.
   * @param {string} difficulty
   * @returns {{cars:number, playerSlot:number}}
   */
  _fieldFor(difficulty) {
    return DIFFICULTY_FIELD[difficulty] ?? { cars: 10, playerSlot: PLAYER_GRID_SLOT };
  }

  /**
   * Change circuit.
   *
   * The world holds all three standing and only repoints its published
   * contract, so this is a re-read rather than a rebuild - but it *is* a
   * re-read: `arm` reinstalls the path, the checkpoints and the grid, and
   * re-emits `race:armed` so the UI and the minimap pick up the new shape.
   *
   * Refused mid-race. Changing the road out from under a running classification
   * would leave every racer's checkpoint cursor pointing at a checkpoint that
   * is now half a kilometre away.
   *
   * @param {string} id
   * @returns {boolean} true if the circuit changed
   */
  selectTrack(id) {
    if (this.racing) return false;
    const world = this._source;
    if (!world?.selectTrack || !id) return false;
    if (world.activeTrackId === id) return false;
    if (!world.selectTrack(id)) return false;
    this.reset();
    return this.arm(world);
  }

  /** Circuits the armed world offers, or an empty list. */
  get tracks() {
    return this._source?.tracks ?? [];
  }

  /** Id of the circuit currently armed. */
  get trackId() {
    return this._source?.activeTrackId ?? null;
  }

  setRaceType(type) {
    this.raceType = type === RACE_TYPES.DRAGON ? RACE_TYPES.DRAGON : RACE_TYPES.CAR;
    if (this.track && this.state === RACE_STATE.IDLE) this._prepareRaceCheckpoints();
    return this.raceType;
  }

  /**
   * Read the world's race contract, if it publishes one.
   *
   * Written to tolerate every partial state the world can be in - not built
   * yet, built but without a track, a track with too few checkpoints - because
   * this module and the world that feeds it ship independently and a missing
   * field must degrade to "no race here", never to a thrown exception on a
   * world change.
   *
   * @param {any} world
   * @returns {boolean} true when a usable circuit was found
   */
  arm(world = this.worldManager?.active) {
    if (this.racing) return this.ready;
    const t = this._readTrack(world);
    if (!t) {
      this.track = null;
      this._source = null;
      this.path = null;
      this.circuit = null;
      this.entries.length = 0;
      this.markers.length = 0;
      this.field.setVisible(false);
      this.rings.clear();
      return false;
    }
    // The live world, kept alongside the normalised reading of it - see the
    // note in `loadTrack`. This is the path a real world arrives by.
    this._source = world ?? null;
    this._install(t);
    this.bus?.emit('race:armed', {
      laps: this.lapCount,
      difficulties: [...this.difficulties],
      checkpoints: this.track.checkpoints.length,
      synthetic: !!this.track.synthetic,
      raceType: this.raceType,
      raceTypes: [...this.raceTypes],
    });
    return true;
  }

  /**
   * Load a circuit that no world published. The synthetic circle from
   * RacerAI.js is the intended argument; it is how the whole lifecycle was
   * verified before the race world existed, and it is still the only way to
   * exercise a lap-validation failure on demand.
   * @param {object} track same shape as the world contract
   */
  loadTrack(track) {
    const t = this._readTrack(track);
    if (!t) return false;
    /* Keep the object it came from, not just the reading of it.
     *
     * `_readTrack` returns a normalised *copy* - flat arrays, validated, safe
     * to hold - which is the right thing to race against, but it is inert. The
     * circuit can reconfigure itself for a difficulty, and only the live world
     * can be asked to. Without this the difficulty was applied to the field and
     * silently not to the track. */
    this._source = track ?? null;
    this._install(t);
    this.bus?.emit('race:armed', {
      laps: this.lapCount,
      difficulties: [...this.difficulties],
      checkpoints: this.track.checkpoints.length,
      synthetic: true,
      raceType: this.raceType,
      raceTypes: [...this.raceTypes],
    });
    return true;
  }

  /** A circular circuit centred on the player, for testing without a race world. */
  loadTestCircuit(opts = {}) {
    const p = this.player?.position ?? { x: 0, y: 0, z: 0 };
    const radius = opts.radius ?? 55;
    return this.loadTrack(makeTestCircuit({
      centre: { x: p.x, y: p.y, z: p.z - radius },
      ...opts,
      radius,
    }));
  }

  /**
   * Drop the flag. Puts the player in the car on their grid slot, spreads the
   * field over the remaining slots and runs the countdown.
   * @param {string} [difficulty]
   */
  start(difficulty = this.difficulty) {
    if (!this.ready) {
      this.bus?.emit('hud:notify', { text: 'No circuit loaded', tone: 'warn' });
      return false;
    }
    if (this.racing) return false;
    // A free lap that was still going round the loop when START was pressed.
    this._unrail();

    this.difficulty = DIFFICULTIES[difficulty] ? difficulty : (this.difficulties[0] ?? 'standard');
    if (!this.raceTypes.includes(this.raceType)) this.raceType = RACE_TYPES.CAR;

    /* Let the circuit reconfigure itself for this difficulty.
     *
     * The world carries its harder furniture at all times and switches it in
     * and out, so this is a cheap call rather than a rebuild - but it has to
     * happen before the grid is read, because the lap count comes back with it.
     * Optional by design: the synthetic test circuit has no such method and
     * must keep working.
     */
    const applied = this._source?.setDifficulty?.(this.difficulty);
    if (applied) {
      // The lap count comes back with the layout, so re-read it from the world
      // rather than from the snapshot taken when the track was installed.
      this.lapCount = this._source.lapCount ?? this.lapCount;
      if (this.track) this.track.lapCount = this.lapCount;
    }

    this._seed = (Date.now() & 0x7fffffff) || 1;

    /* Seeded from the race, so two races on the same circuit are not laid out
     * identically. */
    let ps = this._seed;
    const prnd = () => {
      ps = (ps * 1664525 + 1013904223) >>> 0;
      return ps / 4294967296;
    };
    this._prepareRaceCheckpoints();
    this.pickups.scatter(this.path, this.dragonRace ? 0 : this.plannedDrops, prnd);

    const grid = this.track.startGrid;
    /* Difficulty decides how big the field is and how deep the player starts.
     * Both are clamped to the grid the circuit actually published, so a track
     * with fewer slots than a hard field asks for still races - it just fields
     * fewer cars and seats the player at the back of what exists. */
    const shape = this._fieldFor(this.difficulty);
    const totalCars = Math.min(shape.cars, grid.length);
    const aiCount = Math.max(0, totalCars - 1);
    this.playerGridSlot = Math.min(shape.playerSlot, Math.max(0, totalCars - 1), grid.length - 1);
    this.field.build(this.path, aiCount, this._seed, this.raceType);

    // Slots: the player takes playerGridSlot, the AI fill the rest in order.
    const slots = [];
    for (let i = 0; i < grid.length; i++) if (i !== this.playerGridSlot) slots.push(grid[i]);
    this.field.reset(this.difficulty, slots, this.raceType);

    const playerSlot = grid[this.playerGridSlot];
    this._placePlayer(playerSlot);

    this._buildEntries(playerSlot);
    this.clock = 0;
    /* The hold is drawn once per start, here, so the same race replays the same
     * way if it is ever resumed - and so the length is known before the
     * sequence begins rather than being decided while it runs. */
    const hold = HOLD_MIN_S + ((this._seed % 1000) / 1000) * (HOLD_MAX_S - HOLD_MIN_S);
    /* `START_LIGHTS - 1` steps, not `START_LIGHTS`: the first column lights at
     * the end of the lead-in, so the fifth lands four steps later, not five.
     * Using five put an extra second of all-lit in front of the hold and made
     * the real wait 2.8 s when the intent was at most 1.9. */
    this._countdownTotal = LIGHT_LEAD_S + (START_LIGHTS - 1) * LIGHT_STEP_S + hold;
    this._countdown = this._countdownTotal;
    this._lastBeep = -1;
    this._lit = -1;
    this.results = null;
    // Generous: at 18 m/s average a lap of this circuit takes L/18 seconds, and
    // a player who is going to finish at all will do it inside twice that.
    this._timeLimit = 45 + this.lapCount * (this.path.length / 18) * 2.4;
    this._graceFrom = 0;
    this.state = RACE_STATE.COUNTDOWN;
    this.field.setVisible(true);

    this._setLights(0);
    this.bus?.emit('race:countdown', { count: Math.ceil(this._countdown), difficulty: this.difficulty });
    return true;
  }

  /**
   * Drive the gantry and anything watching it.
   *
   * The world is told directly rather than through the bus because a circuit
   * without a gantry - the synthetic test one - simply does not have the
   * method, and an optional call says that more plainly than a subscriber that
   * has to check.
   */
  _setLights(lit, go = false) {
    if (lit === this._lit && !go) return;
    this._lit = lit;
    this._source?.setStartLights?.(lit, go);
    // `active` distinguishes the two meanings of zero: the sequence about to
    // begin, and a start that was cleared. The HUD needs to show the panel for
    // the first and hide it for the second.
    this.bus?.emit('race:lights', {
      lit, of: START_LIGHTS, go, active: this.state === RACE_STATE.COUNTDOWN,
    });
  }

  /** Abandon a race in progress. No payout, no classification. */
  abort(reason = 'abandoned') {
    if (this.state === RACE_STATE.IDLE) return;
    this.state = RACE_STATE.IDLE;
    this.results = null;
    this.order.length = 0;
    this.markers.length = 0;
    this.field.setVisible(false);
    this.rings.clear();
    this._goHold = 0;
    this._setLights(0);
    this._unrail();
    this.bus?.emit('race:aborted', { reason });
  }

  /** Clear the finished screen and go back to the picker. */
  reset() {
    if (this.racing) return;
    this.state = RACE_STATE.IDLE;
    this.results = null;
    this.field.setVisible(false);
    this.markers.length = 0;
    this.rings.clear();
    this._unrail();
  }

  /**
   * Take everything off the loop, right now.
   *
   * Abandoning a race, changing world or starting a fresh one all have to come
   * through here: `railed` is what tells a car to stop simulating, and a car
   * left with it set sits at whatever height the rail last wrote for ever.
   * `RaceLoops.clear` un-rails everything it was carrying; the sweep over the
   * field afterwards is belt and braces for a racer that was rebuilt or
   * replaced while it happened to be on the loop.
   */
  _unrail() {
    if (!this.loops) return;
    this.loops.clear();
    const car = this._playerCar();
    if (car?.railed) {
      car.railed = false;
      car._pitch = 0;
      car._pitchTarget = 0;
      car._vy = 0;
    }
    for (const r of this.field?.racers ?? []) r.railed = false;
  }

  /**
   * Everything the UI needs for one frame, in one object. Deliberately a
   * snapshot rather than a stream of bus events: a position readout that
   * updates 60 times a second would be 60 emits a second for a two-character
   * change, and the UI already has a frame tick of its own.
   */
  /**
   * How many drops this circuit will carry.
   *
   * Derived from the path rather than read off `pickups`, because the setup
   * panel is shown *before* `start()` scatters them and a reward advertised as
   * "—" is not an incentive to go looking.
   */
  get plannedDrops() {
    return this.path ? Math.round(this.path.length / DROP_SPACING_M) : 0;
  }

  snapshot() {
    const p = this._playerEntry;
    return {
      state: this.state,
      ready: this.ready,
      difficulty: this.difficulty,
      difficulties: this.difficulties,
      raceType: this.raceType,
      raceTypes: [...this.raceTypes],
      laps: this.lapCount,
      clock: this.clock,
      countdown: Math.max(0, Math.ceil(this._countdown)),
      place: this._playerPlace,
      total: this.entries.length,
      lap: p ? Math.min(p.lap, this.lapCount) : 0,
      bestLap: p?.bestLap ?? 0,
      lastLap: p?.lastLap ?? 0,
      finished: !!p?.finished,
      results: this.results,
      order: this.order,
      drops: this.pickups.collected,
      dropsTotal: this.pickups.items.length,
      lights: Math.max(0, this._lit),
      lightsOf: START_LIGHTS,
      rings: this.dragonRace ? this._ringProgress() : null,
    };
  }

  /* ================================================================ */
  /* Simulation                                                        */
  /* ================================================================ */

  /**
   * Runs AFTER `mounts.fixedUpdate` in main.js, so the player's position for
   * this step is already the seat of the car rather than last step's.
   */
  fixedUpdate(dt) {
    // Spin and bob regardless of state, so a scattered circuit is alive during
    // the countdown and after the flag rather than only while racing.
    this.pickups.update(dt);
    this.rings.update(this.clock);
    if (this.state === RACE_STATE.IDLE || this.state === RACE_STATE.FINISHED) {
      this._freeDrive(dt);
      return;
    }
    if (!this.ready) return;

    const running = this.state === RACE_STATE.RACING;

    if (!running) {
      this._countdown -= dt;
      // Columns come on one per second after the lead-in, and stay on until the
      // off. Derived from elapsed time rather than counted up on a tick, so a
      // dropped frame cannot skip a light.
      const elapsed = this._countdownTotal - this._countdown;
      const lit = elapsed < LIGHT_LEAD_S
        ? 0
        : Math.min(START_LIGHTS, Math.floor((elapsed - LIGHT_LEAD_S) / LIGHT_STEP_S) + 1);
      this._setLights(lit);
      this._holdPlayerOnGrid();
      if (this.dragonRace) this._clampPlayerDragon();
      if (this._countdown <= 0) {
        this.state = RACE_STATE.RACING;
        this.clock = 0;
        // See `_seedSweep`: being held on the grid for the whole start
        // procedure is what makes every racer's position trustworthy at
        // exactly this instant.
        if (this.dragonRace) this._clampPlayerDragon();
        this._syncPlayerEntry();
        this._seedSweep();
        // Lights out. All five go dark together - that is the signal, not the
        // fifth one coming on.
        this._setLights(0, true);
        this._goHold = 2.5;
        this.bus?.emit('race:countdown', { count: 0, difficulty: this.difficulty });
        this.bus?.emit('race:started', {
          difficulty: this.difficulty,
          raceType: this.raceType,
          laps: this.lapCount,
          racers: this.entries.length,
        });
      }
    } else {
      this.clock += dt;
      // The green hold is a courtesy to anyone who blinked, not a state — put
      // the gantry back to rest once the field is away.
      if (this._goHold > 0) {
        this._goHold -= dt;
        if (this._goHold <= 0) this._source?.setStartLights?.(0, false);
      }
    }

    if (this.dragonRace) this._clampPlayerDragon();
    this._syncPlayerEntry();
    // The AI need no sync: `RacerAI` owns its own `s`, `lateral` and `speed`,
    // which is the whole point of driving them along the centreline.
    this.field.fixedUpdate(dt, this.entries, running);

    /* The loop, between the field moving and the race being scored.
     *
     * After, because a car on the rail must not have its position overwritten
     * by its own driving this step; before, because the apex checkpoint can
     * only fire against a position that is actually at the apex. Running during
     * the countdown as well as the race costs nothing - nobody is near the
     * entry gate on the grid - and means a car that was already on the rail
     * when the flag fell is carried off it rather than frozen. */
    this.loops.fixedUpdate(dt, this.entries, this._playerCar(), this.path);
    if (this.loops.isRailed('player')) this._syncPlayerEntry();

    /* Contact runs between the field moving and the race being scored, so a
     * shunt is reflected in this step's lap progress rather than next one's.
     * Only while racing: cars are stacked nose to tail on the grid and would
     * shove each other down the road before the lights went out. */
    if (running) {
      const car = this.mounts?.active;
      this.contacts.setPath(this.path);
      this.contacts.resolve(!this.dragonRace && car?.id === 'car' ? car : null, this.field.racers, dt, this.player);
      // The player may have been moved by a contact; re-read before scoring.
      if (this.contacts.hits) this._syncPlayerEntry();
    }

    if (running) {
      for (const e of this.entries) this._advance(e, dt);
      this._rank();
      this._checkEnd();
    }
    this._writeMarkers();
  }

  /* ================================================================ */
  /* Internals                                                         */
  /* ================================================================ */

  /** Pull the contract off a world (or off a plain object) and validate it. */
  _readTrack(source) {
    if (!source) return null;
    const path = source.trackPath;
    const cps = source.checkpoints;
    const grid = source.startGrid;
    if (!Array.isArray(path) || path.length < 3) return null;
    if (!Array.isArray(cps) || cps.length < 3) return null;

    const checkpoints = [];
    for (const c of cps) {
      const x = Number(c?.x);
      const z = Number(c?.z);
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      checkpoints.push({
        x,
        y: Number.isFinite(Number(c.y)) ? Number(c.y) : 0,
        z,
        radius: Math.max(3, Number(c.radius) || 10),
        /* Vertical gate, when the circuit states one.
         *
         * The default of 14 m is generous on purpose - it only has to reject a
         * bridge crossing over a line it is not part of, and demanding accurate
         * checkpoint heights from a world is how you get a lap that will not
         * validate on a crest. The loop's apex checkpoint is the one place that
         * needs a tight gate, because rejecting the car on the road 30 m below
         * it is the entire mechanism that makes the loop mandatory. */
        yGate: Number.isFinite(Number(c.yGate)) ? Number(c.yGate) : 0,
        loop: !!c.loop,
      });
    }
    if (checkpoints.length < 3) return null;

    // A missing or short grid is survivable: place everyone on the line rather
    // than refusing to race. Nine cars stacked on one point separate within a
    // second, and a broken grid must not be the thing that stops a race.
    const startGrid = [];
    if (Array.isArray(grid)) {
      for (const g of grid) {
        const x = Number(g?.x);
        const z = Number(g?.z);
        if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
        startGrid.push({
          x,
          y: Number.isFinite(Number(g.y)) ? Number(g.y) : 0,
          z,
          yaw: Number.isFinite(Number(g.yaw)) ? Number(g.yaw) : 0,
        });
      }
    }

    const difficulties = Array.isArray(source.difficulties) && source.difficulties.length
      ? source.difficulties.filter((d) => DIFFICULTIES[d])
      : [];

    return {
      trackPath: path,
      checkpoints,
      startGrid,
      lapCount: Math.max(1, Math.round(Number(source.lapCount) || 3)),
      difficulties: difficulties.length ? difficulties : ['standard'],
      synthetic: !!source.synthetic,
      loops: Array.isArray(source.loops) ? source.loops : [],
      trackId: source.activeTrackId ?? null,
      trackName: source.tracks?.find?.((t) => t.id === source.activeTrackId)?.name ?? null,
    };
  }

  _install(t) {
    this.path = new TrackPath(t.trackPath);
    if (!this.path.valid) {
      this.path = null;
      this.track = null;
      this._source = null;
      return;
    }
    // Derive a grid from the centreline when the world did not publish one, so
    // a partially finished world still races.
    if (t.startGrid.length < MAX_RACERS) t.startGrid = this._deriveGrid(t);
    this.track = t;
    this.lapCount = t.lapCount;
    this.difficulties = t.difficulties;
    if (!this.difficulties.includes(this.difficulty)) this.difficulty = this.difficulties[0];

    const pts = new Array(this.path.n);
    for (let i = 0; i < this.path.n; i++) {
      const p = this.path.points[i];
      pts[i] = [p.x, p.z];
    }
    this.circuit = pts;
    this._baseCheckpoints = t.checkpoints.map((c) => ({ ...c }));
    this._prepareRaceCheckpoints();
    this.loops.setLoops(t.loops);
  }

  _prepareRaceCheckpoints() {
    if (!this.track) return;
    if (this.dragonRace) {
      this._ringCheckpoints = buildDragonRingCheckpoints(this.path);
      this.track.checkpoints = this._ringCheckpoints.length >= 3
        ? this._ringCheckpoints
        : this._baseCheckpoints.map((c) => ({ ...c }));
      this.rings.setCheckpoints(this._ringCheckpoints);
    } else {
      this.track.checkpoints = this._baseCheckpoints.map((c) => ({ ...c }));
      this.rings.clear();
    }
  }

  /** Two columns behind checkpoint 0, staggered, using the centreline's own frame. */
  _deriveGrid(t) {
    const cp0 = t.checkpoints[0];
    const s0 = this.path.project(cp0.x, cp0.z, -1);
    const grid = [];
    const sm = { x: 0, y: 0, z: 0, width: 12, tx: 0, tz: -1 };
    for (let i = 0; i < MAX_RACERS; i++) {
      const back = 8 + Math.floor(i / 2) * 8;
      this.path.sample(s0 - back, sm);
      const col = (i % 2 === 0 ? -1 : 1) * Math.min(4, sm.width * 0.22);
      grid.push({
        // Right of travel is (-tz, tx) - see TrackPath.lateralOf.
        x: sm.x - sm.tz * col,
        y: sm.y,
        z: sm.z + sm.tx * col,
        // Forward is -Z at yaw 0, so a tangent (tx,tz) reads back as this.
        yaw: Math.atan2(-sm.tx, -sm.tz),
      });
    }
    return grid;
  }

  /**
   * Put the player in the car on their grid slot.
   *
   * `summon` toggles - calling it while already on the car would dismiss it -
   * so the mount is only summoned when something else is being ridden. The
   * car's own `spawn` is then reused rather than writing its position by hand,
   * because it also resets the ride height, the four wheel probes and the
   * suspension state; setting only `position` leaves the car convinced the
   * ground is where the old grid was and launches it on the first step.
   */
  _placePlayer(slot) {
    const mounts = this.mounts;
    const mountId = this.dragonRace ? 'dragon' : 'car';
    if (mounts && mounts.active?.id !== mountId) mounts.summon(mountId);
    const mount = mounts?.active;
    if (mount && mount.id === mountId) {
      const y = this.physics?.groundHeight?.(slot.x, slot.z, slot.y + 3, 8);
      const baseY = y === null || y === undefined ? slot.y : y;
      _v.set(slot.x, this.dragonRace ? baseY + DRAGON_RACE.flightHeight : baseY, slot.z);
      mount.spawn(_v, slot.yaw);
      if (this.dragonRace) {
        mount.position.copy(_v);
        mount.state = 'flying';
        mount._groundY = baseY;
        mount._vy = 0;
        mount.velocity?.set?.(0, 0, 0);
      }
    } else if (this.player?.teleport) {
      this.player.teleport(_v.set(slot.x, this.dragonRace ? slot.y + DRAGON_RACE.flightHeight : slot.y, slot.z), slot.yaw);
    }
    // The car steers toward the look direction, so a stale yaw would have it
    // driving off the grid the instant the lights go out. `yaw` is read-only on
    // Player - orientation belongs to the mount while one is being ridden, and
    // `setYaw` is the door it is handed through.
    this.player?.setYaw?.(slot.yaw);
    this._gridSlot = slot;
  }

  /** Hold everything still until the flag. */
  _holdPlayerOnGrid() {
    const mount = this.mounts?.active;
    const slot = this._gridSlot;
    if (!mount || !slot) return;
    if (!this.dragonRace && mount.id !== 'car') return;
    if (this.dragonRace && mount.id !== 'dragon') return;
    const baseY = this.physics?.groundHeight?.(slot.x, slot.z, slot.y + 3, 8) ?? slot.y;
    mount.position.x = slot.x;
    mount.position.z = slot.z;
    if (this.dragonRace) {
      mount.position.y = baseY + DRAGON_RACE.flightHeight;
      mount.state = 'flying';
      mount._groundY = baseY;
      mount._vy = 0;
    }
    mount.speed = 0;
    mount.velocity?.set?.(0, 0, 0);
    mount.heading = slot.yaw;
    mount.getSeat?.(_seat);
    if (this.player?.position) this.player.position.copy(_seat);
    this.player?.setYaw?.(slot.yaw);
  }

  /**
   * Hold the player's dragon inside the road corridor.
   *
   * The correction fires on the LATERAL OFFSET being out of range, not on the
   * rebuilt position differing from the old one. Those look equivalent and are
   * not, and the difference was the whole dragon race.
   *
   * Rebuilding `pos` from `sample(s) + normal * lat` unconditionally and then
   * asking `pos.x !== oldX` is a float round-trip through project → lateralOf
   * → sample, so it lands a few ulps away from the point it started at even
   * when nothing was clamped. Measured on Vellum Ridge, with a dragon flying a
   * clean line 0.0-2.9 m off the centreline - comfortably inside a corridor
   * that is 2.51-4.39 m wide here - that test tripped on 2338 of 3600 fixed
   * steps (64.9%): 2313 of them moved the mount by under a nanometre and 24 by
   * 1-6 cm, where `project` lands on a polyline vertex and `sample` then reads
   * the *next* segment's tangent. Every one of them ran the penalty below, so
   * the player's dragon sat pinned at exactly 10.000 m/s for the whole lap
   * against a field whose top speeds span 22.5-43.0 m/s. A clean Vellum lap
   * took 133.57 s instead of 54.01 s. That is the "I have no chance" report.
   *
   * `THREE.MathUtils.clamp` returns its argument unchanged when it is already
   * in range, so `lat !== raw` is an exact test for "the corridor caught you"
   * with no epsilon to tune.
   */
  _clampPlayerDragon() {
    if (!this.dragonRace || !this.path?.valid) return;
    const dragon = this.mounts?.active;
    if (!dragon || dragon.id !== 'dragon') return;
    const pos = dragon.position;
    const s = this.path.project(pos.x, pos.z, -1);
    this.path.sample(s, _clampSample);
    const half = Math.max(2.5, _clampSample.width * 0.5 - 1.8);
    const raw = this.path.lateralOf(pos.x, pos.z, s);
    const lat = THREE.MathUtils.clamp(raw, -half, half);
    const nx = -_clampSample.tz;
    const nz = _clampSample.tx;
    const oldY = pos.y;
    if (lat !== raw) {
      pos.x = _clampSample.x + nx * lat;
      pos.z = _clampSample.z + nz * lat;
      dragon.velocity.x = 0;
      dragon.velocity.z = 0;
      dragon.speed = Math.min(dragon.speed ?? 0, 10);
    }
    const minY = _clampSample.y + DRAGON_RACE.minFlight;
    const maxY = _clampSample.y + DRAGON_RACE.maxFlight;
    pos.y = THREE.MathUtils.clamp(pos.y, minY, maxY);
    if (pos.y !== oldY) {
      dragon.velocity.y = 0;
      dragon._vy = 0;
    }
    dragon.state = 'flying';
    dragon._groundY = _clampSample.y;
    dragon.getSeat?.(_seat);
    if (this.player?.position) this.player.position.copy(_seat);
    if (this.player?.velocity && dragon.velocity) this.player.velocity.copy(dragon.velocity);
  }

  _buildEntries(playerSlot) {
    this.entries.length = 0;
    const mk = (o) => Object.assign(o, {
      lap: 1,
      nextCp: this.dragonRace ? 0 : 1,
      cpDone: 0,
      finished: false,
      finishTime: 0,
      lastLap: 0,
      bestLap: 0,
      _lapStart: 0,
      place: 0,
      _px: o.position.x,
      _pz: o.position.z,
    });

    this._playerEntry = mk({
      id: 'player',
      name: 'YOU',
      isPlayer: true,
      color: 0x52e9ff,
      position: this.player?.position ?? new THREE.Vector3(),
      s: this.path.project(playerSlot.x, playerSlot.z, -1),
      lateral: 0,
      speed: 0,
    });
    this.entries.push(this._playerEntry);
    for (const r of this.field.racers) this.entries.push(mk(r));

    this._playerPlace = this.playerGridSlot + 1;
    this.order = [...this.entries];
    this._seedSweep(playerSlot);
    this._writeMarkers();
  }

  /**
   * Arm the swept checkpoint test with a position that is actually on the grid.
   *
   * This is subtle and it bit hard. `_placePlayer` moves the *car*, but the
   * player's own position is not rewritten until `MountManager` applies the seat
   * on the next fixed step - so seeding the sweep from `player.position` seeds it
   * from wherever the player was standing when they pressed start. The first
   * step of the race then sweeps a segment from there to the grid, straight
   * across the infield, and hands out every checkpoint that chord happens to
   * pass through. Caught in testing by starting a race while parked on
   * checkpoint 1, which awarded checkpoint 1 before the lights went out.
   *
   * Seeding from the grid slot fixes the start. Re-seeding at the flag fixes
   * everything else: the countdown holds the field on the grid for three
   * seconds, so at GO every racer's real position is known good.
   *
   * @param {{x:number,z:number}} [playerSlot]
   */
  _seedSweep(playerSlot) {
    for (const e of this.entries) {
      const src = e.isPlayer && playerSlot ? playerSlot : e.position;
      e._px = src.x;
      e._pz = src.z;
    }
  }

  /** The car, when the player is actually in one. */
  _playerCar() {
    const m = this.mounts?.active;
    return m && m.id === 'car' ? m : null;
  }

  /**
   * The loop, with no race running.
   *
   * A loop is a piece of road. Gating it on a race being armed would mean
   * driving up to one on a free lap and passing straight through a ramp that
   * has no collision on it, which reads as a broken world rather than as a set
   * piece you are not currently allowed to use.
   */
  _freeDrive(dt) {
    if (!this.loops.loops.length) return;
    const car = this._playerCar();
    const pos = this.player?.position;
    if (!pos) { this.loops.clear(); return; }
    if (!car) {
      // On foot or on another mount: nothing to rail, and anything on the way
      // round has just been dismounted out from under it. `clear` is what hands
      // that car back its own physics - see RaceLoops.clear.
      if (this.loops.active) this.loops.clear();
      return;
    }
    const e = this._freeEntry;
    if (e.position !== pos) { e.position = pos; e._px = pos.x; e._pz = pos.z; }
    e.speed = car.speed ?? 0;
    this.loops.fixedUpdate(dt, [e], car, this.path);
    e._px = pos.x;
    e._pz = pos.z;
  }

  /** The player is not a `RacerAI`, so its track coordinates are derived here. */
  _syncPlayerEntry() {
    const e = this._playerEntry;
    if (!e) return;
    const p = this.player?.position;
    if (!p) return;
    e.position = p;
    // A full scan, not a windowed one: the player can spin, reverse, be teleported
    // by Unstuck, or leave the road entirely, and a hint would then lock their
    // projection to wherever they last were.
    const prevS = e.s;
    e.s = this.path.project(p.x, p.z, -1);
    e.lateral = this.path.lateralOf(p.x, p.z, e.s);
    e.speed = this.mounts?.active?.speed ?? 0;
    // Only while actually racing: rolling over the circuit before the lights
    // go out should not empty it.
    if (this.state === RACE_STATE.RACING && typeof prevS === 'number') {
      if (!this.dragonRace) this.pickups.claim(e.id, prevS, e.s, e.lateral, true);
    }
  }

  /**
   * Advance one racer's checkpoint cursor, if it swept through the armed
   * checkpoint this step. See the header for why only one checkpoint is ever
   * live per racer.
   */
  _advance(e, dt) {
    void dt;
    if (e.finished) return;
    const cps = this.track.checkpoints;
    const cp = cps[e.nextCp];
    const px = e.position.x;
    const pz = e.position.z;

    // Swept test against the segment travelled, so a faster mount or a longer
    // fixed step can never tunnel a checkpoint.
    const d2 = segDistSq(e._px, e._pz, px, pz, cp.x, cp.z);
    e._px = px;
    e._pz = pz;
    if (d2 > cp.radius * cp.radius) return;
    // A generous vertical gate still rejects a bridge crossing over the line
    // it is not part of, without demanding the world get checkpoint heights
    // exactly right. Dragon rings are tighter because the player must fly through them.
    const yGap = Math.abs((e.position.y ?? cp.y) - cp.y);
    const gate = cp.yGate > 0 ? cp.yGate : (this.dragonRace ? cp.radius * 0.9 : 14);
    if (yGap > gate) return;

    const passed = e.nextCp;
    e.cpDone++;
    e.nextCp = (e.nextCp + 1) % cps.length;
    if (this.dragonRace && e.isPlayer) {
      this.rings.pass(passed, e.nextCp);
      this.bus?.emit('race:ring', { ring: passed + 1, total: cps.length, next: e.nextCp + 1 });
    }

    const lapCursor = this.dragonRace ? 0 : 1;
    if (e.nextCp !== lapCursor) return; // mid-lap checkpoint

    /* --- checkpoint 0 passed in order: that is a completed lap --- */
    const lapTime = this.clock - e._lapStart;
    e._lapStart = this.clock;
    e.lastLap = lapTime;
    if (!e.bestLap || lapTime < e.bestLap) e.bestLap = lapTime;
    e.lap++;
    if (e.lap > this.lapCount) {
      e.finished = true;
      e.finishTime = this.clock;
      if (this.dragonRace && e.isPlayer) this.rings.clear();
    }
    // `lap` is the lap just *completed*, not the one now being driven. Reporting
    // the latter is ambiguous at the flag - it has to be clamped to the race
    // length, and the clamp makes the final crossing indistinguishable from the
    // one before it, which is exactly the sort of off-by-one a lap counter must
    // not have.
    this.bus?.emit('race:lap', {
      id: e.id,
      name: e.name,
      isPlayer: !!e.isPlayer,
      lap: e.lap - 1,
      laps: this.lapCount,
      lapTime,
      best: e.bestLap,
      finished: e.finished,
    });
  }

  /**
   * Rank the field.
   *
   * Progress is `checkpoints validated` plus a fraction of the way to the next
   * one. The fraction is derived from the straight-line distance rather than
   * arc length on purpose: between two adjacent checkpoints the two agree
   * closely enough to order a field, and the straight line is defined for a
   * player who has left the track entirely, where an arc-length projection is
   * not.
   */
  _rank() {
    const cps = this.track.checkpoints;
    for (const e of this.entries) {
      if (e.finished) {
        e._score = 1e9 - e.finishTime;
        continue;
      }
      const cp = cps[e.nextCp];
      const prev = cps[(e.nextCp - 1 + cps.length) % cps.length];
      const gap = Math.hypot(cp.x - prev.x, cp.z - prev.z) || 1;
      const d = Math.hypot(cp.x - e.position.x, cp.z - e.position.z);
      e._score = e.cpDone + Math.max(0, Math.min(1, 1 - d / gap)) * 0.999;
    }
    this.order.sort((a, b) => b._score - a._score);
    for (let i = 0; i < this.order.length; i++) this.order[i].place = i + 1;

    const place = this._playerEntry?.place ?? 0;
    if (place !== this._playerPlace) {
      this._playerPlace = place;
      this.bus?.emit('race:position', {
        place,
        total: this.entries.length,
        lap: Math.min(this._playerEntry?.lap ?? 1, this.lapCount),
        laps: this.lapCount,
      });
    }
  }

  _checkEnd() {
    const p = this._playerEntry;
    if (p?.finished) {
      this._classify(false);
      return;
    }

    /* Once every rival is home the player is on their own, and the outer time
     * limit is far too long to sit through - a player wedged against a wall on
     * lap one would watch a "racing" HUD for another minute and a half. Real
     * racing closes the flag a fixed interval after the leader rather than
     * waiting for the last car, so the same rule applies here. */
    if (this._graceFrom === 0 && this.entries.every((e) => e.isPlayer || e.finished)) {
      this._graceFrom = this.clock;
    }
    const graced = this._graceFrom > 0 && this.clock - this._graceFrom >= FINISH_GRACE;
    if (graced || this.clock >= this._timeLimit) this._classify(true);
  }

  /**
   * Final classification and the payout.
   *
   * The race ends when the *player* crosses the line, not when the last car
   * does: everyone still running is classified on the progress they had at that
   * moment, which is what a chequered flag does in real racing and avoids
   * making the player watch a car three laps down finish.
   */
  _classify(playerDnf) {
    this._rank();
    this.state = RACE_STATE.FINISHED;

    const winner = this.order[0];
    const results = this.order.map((e, i) => {
      const place = i + 1;
      const prize = RACE_PRIZES[place - 1] ?? 0;
      return {
        place,
        id: e.id,
        name: e.name,
        isPlayer: !!e.isPlayer,
        color: e.color ?? 0x9fb4c4,
        time: e.finished ? e.finishTime : 0,
        // A gap only means something between two cars that both finished.
        gap: e.finished && winner?.finished ? e.finishTime - winner.finishTime : 0,
        laps: Math.min(e.lap, this.lapCount),
        bestLap: e.bestLap,
        dnf: !e.finished,
        credits: prize,
      };
    });
    this.results = results;

    const mine = results.find((r) => r.isPlayer);
    let paid = 0;
    // Only the player has a wallet. The prize column is still shown against the
    // podium so the reward for improving a place is legible before the next
    // race rather than after it.
    /* Pickups pay even on a DNF. They were collected; taking them back for
     * finishing fourth would make them a trap rather than a reward. The placing
     * prize still requires a finish. */
    const bonus = this.pickups.collected * PICKUP_VALUE;
    if (mine) {
      if (mine.dnf) mine.credits = 0;
      mine.pickups = this.pickups.collected;
      mine.credits += bonus;
      paid = mine.credits;
      if (paid > 0) this.economy?.add?.(paid, 'race');
    }

    this.bus?.emit('race:finished', {
      results,
      place: mine?.place ?? 0,
      credits: paid,
      pickups: this.pickups.collected,
      pickupCredits: bonus,
      dnf: !!playerDnf || !!mine?.dnf,
      difficulty: this.difficulty,
      time: mine?.time ?? 0,
      laps: this.lapCount,
    });
    this.bus?.emit('hud:notify', {
      text: mine?.dnf
        ? 'Race over — did not finish'
        : `Finished P${mine?.place ?? '?'}${paid ? ` — +${paid} credits` : ''}`,
      tone: paid ? 'good' : 'info',
    });
  }

  _ringProgress() {
    const p = this._playerEntry;
    const total = this.track?.checkpoints?.length ?? 0;
    return { done: total ? (p?.cpDone ?? 0) % total : 0, total, next: p?.nextCp ?? 0 };
  }

  /** One marker per racer for the minimap, plus remaining rings for dragon races. */
  _writeMarkers() {
    const m = this.markers;
    const ringMarkers = this.dragonRace ? this.rings.markers(this._playerEntry?.nextCp ?? 0) : [];
    m.length = this.entries.length + ringMarkers.length;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      const slot = m[i] ?? (m[i] = { x: 0, z: 0, isPlayer: false, color: 0xffffff, place: 0 });
      slot.type = 'racer';
      slot.x = e.position.x;
      slot.z = e.position.z;
      slot.isPlayer = !!e.isPlayer;
      slot.color = e.color ?? 0xffffff;
      slot.place = e.place;
      slot.next = false;
    }
    for (let i = 0; i < ringMarkers.length; i++) {
      const src = ringMarkers[i];
      const slot = m[this.entries.length + i] ?? (m[this.entries.length + i] = {});
      slot.type = 'ring';
      slot.x = src.x;
      slot.z = src.z;
      slot.isPlayer = false;
      slot.color = src.next ? 0x52e9ff : 0xffd166;
      slot.place = 0;
      slot.index = src.index;
      slot.number = src.number;
      slot.next = !!src.next;
    }
  }

  _teardown() {
    // Tell the UI before dropping the state, or a leaderboard left open when the
    // player steps into a portal survives into the next world with nothing
    // behind it and no way to dismiss it except the key that opens the picker.
    if (this.state !== RACE_STATE.IDLE) this.bus?.emit('race:aborted', { reason: 'world' });
    this.state = RACE_STATE.IDLE;
    this.track = null;
    this.path = null;
    this.circuit = null;
    this.results = null;
    this.entries.length = 0;
    this.order.length = 0;
    this.markers.length = 0;
    this._playerEntry = null;
    this._playerPlace = 0;
    this._unrail();
    this.loops.setLoops(null);
    this.field.clear();
    this.rings.clear();
    // Otherwise a forbidden world's `tracks` getter and `selectTrack` keep
    // reading the world that was just left, and can re-arm its circuits from
    // inside the maze.
    this._source = null;
  }

  dispose() {
    this.pickups?.dispose?.();
    this.rings?.dispose?.();
    this.bus?.off?.('world:changing', this._onWorldChanging);
    this.bus?.off?.('world:changed', this._onWorldChanged);
    this.field.dispose();
    this.loops?.clear?.();
    this.entries.length = 0;
    this.markers.length = 0;
  }
}

export { makeTestCircuit, DIFFICULTIES };
