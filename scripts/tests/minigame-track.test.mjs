import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

import { EventBus } from '../../src/core/EventBus.js';
import { Economy } from '../../src/systems/Economy.js';
import { Stamina } from '../../src/systems/Stamina.js';
import { CONFIG } from '../../src/core/Config.js';
import {
  MinigameManager,
  MINIGAME_STATE,
  MINIGAME_PRIZE,
} from '../../src/minigames/MinigameManager.js';
import {
  createTrackRace,
  TrackRace,
  TRACK_GAME_ID,
  TRACK_COURSE,
  laneRadius,
  midRadius,
  lapLength,
  coursePoint,
  courseProject,
  checkpointCourse,
} from '../../src/minigames/TrackRace.js';

/**
 * The 400 m foot race, end to end, and the geometry under it.
 *
 * ── The gates this suite exists for ──────────────────────────────────────────
 *
 * The defect this project has shipped four times is a test that proves a thing
 * was BUILT and never that a player can REACH it. For a lap race the two
 * lethal versions are checkpoints that drift off the rubber (the oval's
 * numbers live in SportsWorld and are restated in the module — the geometry
 * gate re-extracts the world's own `const TRACK` from source and rebuilds the
 * ribbon from it), and a rival pace that no honest player can beat. The
 * pacing gate therefore drives a runner through the REAL `Stamina` class —
 * real drain, real regen delay, real exhaustion latch — along the real lane
 * geometry, and holds the brief's outcome: a committed sprinter wins
 * narrowly, a jogger loses to the whole field. Retune stamina or the ghosts
 * and this suite says so.
 */

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const SRC = nodePath.resolve(HERE, '../../src');
const STEP = 1 / 60;

/**
 * The venue as the integration spec has SportsWorld publish it. The disc must
 * hold the WHOLE oval: MinigameManager abandons a contest 9 s (LEAVE_GRACE_S)
 * after the player leaves the venue and a lap takes ~70-100 s, so a
 * gantry-only trigger would self-abort on the back straight — the ski
 * lesson, re-learned here as a geometry assertion below.
 */
function makeVenue(extraConfig = {}) {
  return {
    id: 'meridian_track',
    kind: 'run',
    label: 'Meridian 400 m',
    centre: { x: TRACK_COURSE.cx, y: 0, z: TRACK_COURSE.cz },
    radius: 96,
    yTolerance: 12,
    reward: 10,
    // The flat-zone truth: parkHeight is 0 across the whole oval.
    config: { heightFn: () => 0, ...extraConfig },
    rival: { name: 'Priya Raghunathan' },
  };
}

/**
 * A MountManager stand-in for the two mount rules this module carries: a
 * ridden mount is dismounted before the start-line teleport, and checkpoints
 * do not count while mounted.
 */
function makeMounts({ premounted = false } = {}) {
  const board = () => ({
    id: 'hoverboard',
    canDismount: () => true,
    position: new THREE.Vector3(),
    heading: 0,
    velocity: new THREE.Vector3(),
    speed: 0,
  });
  return {
    summoned: 0,
    dismounted: 0,
    active: premounted ? board() : null,
    summon(id) {
      this.summoned += 1;
      this.active = { ...board(), id };
      return true;
    },
    dismount() {
      this.dismounted += 1;
      this.active = null;
      return true;
    },
  };
}

/**
 * A HumanoidFactory stand-in for the rivals' bodies: the surface
 * `GhostCompetitor` actually touches. The REAL factory bakes canvas textures
 * and cannot run headless — which is also why a rig with no injected factory
 * deterministically has no bodies (asserted below).
 */
function stubFactory() {
  return {
    create() {
      const root = new THREE.Group();
      const rig = new THREE.Group();
      root.add(rig);
      return {
        root,
        rig,
        bones: new Map(),
        boneList: [],
        disposed: false,
        dispose() {
          this.disposed = true;
        },
      };
    },
  };
}

function makeRig({ venue = makeVenue(), mounts = makeMounts(), factory = null } = {}) {
  const bus = new EventBus();
  const economy = new Economy({ bus });
  const player = {
    position: { x: 0, y: 0, z: 0 },
    teleports: 0,
    lastYaw: null,
    teleport(v, yaw) {
      this.position.x = v.x;
      this.position.y = v.y;
      this.position.z = v.z;
      this.lastYaw = yaw;
      this.teleports += 1;
    },
  };
  const keys = new Set();
  // The REAL Input contract is pressed AND held (level-trigger) — a double
  // that models only half of it is how the tennis unwinnability bug hid.
  const input = { pressed: (code) => keys.has(code), held: (code) => keys.has(code) };
  const mg = new MinigameManager({ bus, player, economy, input });
  // The exact wiring the integration spec gives main.js: the manager hands
  // the factory player/bus/input, and the closure adds the mount authority
  // (and, for the rivals' bodies, the humanoid factory when a test wants one).
  mg.registerGame('run', (v, c) =>
    createTrackRace(v, { ...c, mounts, ...(factory ? { factory } : {}) })
  );

  const seen = [];
  for (const type of [
    'minigame:prompt', 'minigame:countdown', 'minigame:started', 'minigame:event',
    'minigame:finished', 'minigame:aborted', 'quest:activity', 'hud:notify',
  ]) {
    bus.on(type, (e) => seen.push({ type, e }));
  }

  bus.emit('world:changed', { id: 'sports', world: { minigameVenues: [venue] } });
  return { bus, economy, player, keys, input, mg, mounts, seen };
}

/** One frame: the prompt/key pass and the fixed pass, in main.js's order. */
function frame(rig, elapsed = 0) {
  rig.mg.update(STEP);
  rig.mg.fixedUpdate(STEP, elapsed);
}

function frames(rig, seconds) {
  const n = Math.ceil(seconds / STEP);
  for (let i = 0; i < n; i++) frame(rig);
}

function place(rig, x, y, z) {
  rig.player.position.x = x;
  rig.player.position.y = y;
  rig.player.position.z = z;
}

/** Press E for exactly one frame. */
function pressE(rig) {
  rig.keys.add('KeyE');
  rig.mg.update(STEP);
  rig.keys.delete('KeyE');
}

/** Accept at the gantry and run the countdown out. */
function beginRace(rig) {
  // Standing by the start/finish gantry, nowhere near the start position.
  place(rig, TRACK_COURSE.cx - 4, 0.05, -148);
  pressE(rig);
  assert.equal(rig.mg.state, MINIGAME_STATE.COUNTDOWN, 'E at the venue should start the countdown');
  frames(rig, 5);
  assert.equal(rig.mg.state, MINIGAME_STATE.PLAYING, 'the countdown should expire into play');
}

/**
 * Advance the player along their lane's parametric line at a per-step speed
 * function, stepping the manager exactly as the engine would. Returns the
 * seconds spent.
 */
function runLane(rig, { lane = TRACK_COURSE.playerLane, speed = 4.6, y = 0.05, until = null, limit = 200 } = {}) {
  const r = laneRadius(lane);
  const lap = lapLength(r);
  const pt = {};
  let s = courseProject(rig.player.position.x, rig.player.position.z, r);
  if (s > lap - 1) s = 0; // standing on the line reads as s = 0, not s = lap
  let t = 0;
  while (rig.mg.running && t < limit) {
    const v = typeof speed === 'function' ? speed(STEP, t) : speed;
    s += v * STEP;
    coursePoint(r, s, pt);
    place(rig, pt.x, y, pt.z);
    t += STEP;
    frame(rig, t);
    if (until && until(s, t)) break;
  }
  return t;
}

/* ------------------------------------------------------------------ */
/* Geometry: do the checkpoints lie on the oval the world built?       */
/* ------------------------------------------------------------------ */

test('every checkpoint lies on the rubber ribbon SportsWorld itself lays', async () => {
  const src = await readFile(nodePath.join(SRC, 'worlds/SportsWorld.js'), 'utf8');

  // The oval, read off the world's own constants — never restated here.
  const m = /const TRACK = \{ cx: (-?[\d.]+), cz: (-?[\d.]+), straight: ([\d.]+), inner: ([\d.]+), lanes: (\d+), laneW: ([\d.]+) \}/.exec(src);
  assert.ok(m, 'SportsWorld should still declare const TRACK');
  const [cx, cz, straight, inner, lanes, laneW] = m.slice(1, 7).map(Number);

  // The module's restated constants must be the world's. This is the drift
  // guard: TrackRace duplicates these six numbers, and this is what breaks
  // when someone rebuilds the track without moving the course.
  assert.equal(TRACK_COURSE.cx, cx, 'course centre x must match the world');
  assert.equal(TRACK_COURSE.cz, cz, 'course centre z must match the world');
  assert.ok(Math.abs(TRACK_COURSE.straight - straight) < 1e-9, 'straight length must match');
  assert.ok(Math.abs(TRACK_COURSE.inner - inner) < 1e-9, 'inner radius must match');
  assert.equal(TRACK_COURSE.lanes, lanes, 'lane count must match');
  assert.ok(Math.abs(TRACK_COURSE.laneW - laneW) < 1e-9, 'lane width must match');

  // Reconstruct the ribbon FROM THE EXTRACTED numbers: the track surface is
  // the band [inner, inner + lanes*laneW] around the stadium spine. Radial
  // offset of a point from that spine:
  const hs = straight / 2;
  const radial = (x, z) => {
    if (x >= cx + hs) return Math.hypot(x - (cx + hs), z - cz);
    if (x <= cx - hs) return Math.hypot(x - (cx - hs), z - cz);
    return Math.abs(z - cz);
  };
  const band0 = inner;
  const band1 = inner + lanes * laneW;

  const cps = checkpointCourse(null);
  assert.ok(cps.length >= 10 && cps.length <= 14, 'the brief asks for 10-14 checkpoints');
  let lastS = 0;
  for (const cp of cps) {
    const d = radial(cp.x, cp.z);
    assert.ok(
      d >= band0 - 1e-9 && d <= band1 + 1e-9,
      `checkpoint ${cp.i + 1} at (${cp.x.toFixed(2)}, ${cp.z.toFixed(2)}): radial ${d.toFixed(2)} m is off the ${band0}..${band1} ribbon`
    );
    assert.ok(cp.s > lastS, 'checkpoints must be ordered by course distance');
    lastS = cp.s;
  }

  // Even spacing, and the pass radius must cover EVERY lane from the mid
  // line — no legal racing line may be robbed by lane choice.
  const spacing = lapLength(midRadius()) / cps.length;
  for (let i = 1; i < cps.length; i++) {
    assert.ok(Math.abs(cps[i].s - cps[i - 1].s - spacing) < 1e-9, 'spacing must be uniform');
  }
  assert.ok(midRadius() - TRACK_COURSE.cpRadius < band0, 'the pass radius must reach past the kerb');
  assert.ok(midRadius() + TRACK_COURSE.cpRadius > band1, 'and past the outer lane edge');

  // The last checkpoint IS the finish line: x = cx on the southern home
  // straight, where _buildTrack paints it and parks the gantry.
  const last = cps[cps.length - 1];
  assert.ok(Math.abs(last.x - cx) < 1e-6, `the final checkpoint must sit on the finish paint (x=${last.x})`);
  assert.ok(last.z < cz, 'on the southern (home) straight');

  // The start position: on that same line, in a real outer lane, and the
  // ghosts strictly inside it on real lanes of their own.
  assert.ok(TRACK_COURSE.playerLane >= 1 && TRACK_COURSE.playerLane <= lanes);
  const rp = laneRadius(TRACK_COURSE.playerLane);
  assert.ok(rp >= band0 && rp <= band1, 'the player lane must be on the ribbon');
  const game = new TrackRace(makeVenue(), { player: null, bus: null });
  for (const r of game.runners) {
    assert.ok(r.lane >= 1 && r.lane < TRACK_COURSE.playerLane, `${r.name} runs a staggered INNER lane`);
    assert.ok(r.r >= band0 && r.r <= band1, `${r.name}'s lane must be on the ribbon`);
    assert.ok(Math.abs(r.lap - lapLength(r.r)) < 1e-9, 'each ghost runs its own lane\'s honest lap');
  }
  assert.equal(new Set(game.runners.map((r) => r.lane)).size, game.runners.length,
    'no two ghosts share a lane');

  // The venue disc must hold the WHOLE oval (the ski self-abort lesson):
  // the farthest point of the outermost lane path from the track centre is
  // straight/2 + outer radius.
  const venue = makeVenue();
  assert.ok(hs + band1 < venue.radius,
    `the lap's farthest point (${(hs + band1).toFixed(1)} m) must sit inside the venue disc (${venue.radius} m)`);
});

test('checkpoint heights come from the ground field the venue hands over', () => {
  const calls = [];
  const probe = (x, z) => {
    calls.push([x, z]);
    return 3.25;
  };
  const cps = checkpointCourse(probe);
  for (const cp of cps) {
    assert.equal(cp.y, 3.25, `checkpoint ${cp.i + 1} must take its y from the field`);
    assert.ok(
      calls.some(([x, z]) => x === cp.x && z === cp.z),
      `checkpoint ${cp.i + 1} must sample the field at its own (x, z)`
    );
  }
  // No field at all: the flat-zone truth of 0 stands in (the whole oval is
  // inside SportsWorld's flat zone, where parkHeight returns exactly 0).
  const game = new TrackRace({ ...makeVenue(), config: {} }, { player: null, bus: null });
  for (const cp of game.checkpoints) assert.equal(cp.y, 0);
});

test('the parametric course and its projection are inverses all the way round', () => {
  const r = midRadius();
  const lap = lapLength(r);
  const pt = {};
  for (let s = 0; s < lap - 1e-6; s += lap / 977) {
    coursePoint(r, s, pt);
    const back = courseProject(pt.x, pt.z, r);
    const err = Math.abs(back - s);
    assert.ok(Math.min(err, lap - err) < 1e-6, `projection must invert coursePoint at s=${s.toFixed(2)} (got ${back.toFixed(2)})`);
  }
});

/* ------------------------------------------------------------------ */
/* Prompt and start positioning                                        */
/* ------------------------------------------------------------------ */

test('the track prompts on arrival and E places the runner on the start line', () => {
  const rig = makeRig();
  place(rig, TRACK_COURSE.cx - 4, 0.05, -148);
  rig.mg.update(STEP);
  const p = rig.seen.filter((s) => s.type === 'minigame:prompt').at(-1)?.e;
  assert.equal(p?.verb, 'Start');
  assert.equal(p?.label, 'Meridian 400 m');
  assert.equal(p?.venueId, 'meridian_track');

  pressE(rig);
  assert.equal(rig.mg.state, MINIGAME_STATE.COUNTDOWN);

  /* Start positioning, the user requirement verbatim: "when I start a game
   * it should position me at the start". On the finish paint, in lane 6,
   * facing +x down the home straight. */
  assert.equal(rig.player.teleports, 1, 'accepting must place the runner');
  const pos = rig.player.position;
  assert.ok(Math.abs(pos.x - TRACK_COURSE.cx) < 1e-9, 'on the finish line');
  assert.ok(Math.abs(pos.z - (TRACK_COURSE.cz - laneRadius(TRACK_COURSE.playerLane))) < 1e-9,
    `in lane ${TRACK_COURSE.playerLane}`);
  assert.ok(Math.abs(pos.y - 0.05) < 1e-9, 'feet on the venue\'s own ground field');
  assert.ok(Math.abs(rig.player.lastYaw - -Math.PI / 2) < 1e-9,
    'facing +x — down the home straight, the direction of travel');
});

test('a ridden mount is dismounted before the start-line teleport', () => {
  const mounts = makeMounts({ premounted: true });
  const rig = makeRig({ mounts });
  beginRace(rig);
  assert.equal(mounts.dismounted, 1,
    'the mount owns position while ridden (measured) — a seated teleport would silently snap back');
  assert.equal(mounts.active, null);
  assert.equal(rig.player.teleports, 1, 'and the teleport still landed');
});

/* ------------------------------------------------------------------ */
/* Pacing: the brief's outcome, against the REAL stamina system        */
/* ------------------------------------------------------------------ */

test('a committed sprinter beats the field narrowly and collects exactly 10 credits', () => {
  const rig = makeRig();
  beginRace(rig);
  assert.equal(rig.economy.credits, 0);

  /* The runner the brief describes: sprint whenever the REAL stamina pool
   * allows, walk while it recovers. Real drain, real regen delay, real
   * exhaustion latch — Config.js/Stamina.js are the authority, so retuning
   * either retunes this assertion. */
  const st = new Stamina({});
  const P = CONFIG.player;
  const speed = (dt, t) => {
    st.fixedUpdate(dt, t);
    if (st.canSprint) {
      st.drain(P.sprintStaminaDrain * dt, 'sprint');
      return P.sprintSpeed;
    }
    return P.walkSpeed;
  };
  runLane(rig, { speed });

  assert.equal(rig.mg.state, MINIGAME_STATE.FINISHED);
  const fin = rig.seen.find((s) => s.type === 'minigame:finished')?.e;
  assert.ok(fin, 'a finish must be announced');
  assert.equal(fin.won, true, 'sprinting most of the lap must win');
  assert.equal(fin.place, 1);
  assert.equal(fin.total, 4, 'a four-runner field');
  assert.equal(fin.credits, MINIGAME_PRIZE);
  assert.equal(fin.credits, 10, 'the user asked for ten credits, in those words');
  assert.equal(rig.economy.credits, 10, 'and the wallet has to actually contain them');
  assert.equal(fin.detail.passed, TRACK_COURSE.checkpoints, 'every checkpoint taken, in order');

  /* Narrowly: the header arithmetic says ~69 s against a 74.9 s leader.
   * Hold the shape, not the decimals — a real run, a single-digit margin. */
  assert.ok(fin.score > 60 && fin.score < 74.9,
    `a stamina-honest sprint should land ~69 s, inside the leader's ~74.9 s (got ${fin.score.toFixed(1)})`);
  assert.ok(fin.detail.margin > 0 && fin.detail.margin < 60,
    `the win should be narrow — metres, not a lap (margin ${fin.detail.margin.toFixed(1)} m)`);

  // The quest handle, in the shape QuestSystem's default branch reads.
  const act = rig.seen.find((s) => s.type === 'quest:activity')?.e;
  assert.equal(act?.type, 'minigame');
  assert.equal(act?.target, TRACK_GAME_ID);
  assert.equal(act?.id, TRACK_GAME_ID);
  assert.equal(act?.name, 'Meridian 400 m');
  assert.equal(act?.won, true);

  // Checkpoint splits were announced along the way.
  const splits = rig.seen.filter((s) => s.type === 'minigame:event' && s.e.kind === 'split');
  assert.equal(splits.length, TRACK_COURSE.checkpoints);
  assert.match(splits[0].e.text, /^CHECKPOINT 1\/12 — /);
});

test('jogging loses to the whole field the moment the leader is home, and pays nothing', () => {
  const rig = makeRig();
  beginRace(rig);
  runLane(rig, { speed: CONFIG.player.walkSpeed });

  assert.equal(rig.mg.state, MINIGAME_STATE.FINISHED);
  const fin = rig.seen.find((s) => s.type === 'minigame:finished')?.e;
  assert.equal(fin.won, false, 'a 4.6 m/s jog must not beat a 74.9 s leader');
  assert.equal(fin.detail.reason, 'rival');
  assert.equal(fin.rivalName, 'Priya Raghunathan', 'the venue names the leader, and the leader won');
  assert.ok(fin.place >= 2 && fin.place <= 4, `a jogger finishes down the field (P${fin.place})`);
  assert.equal(fin.credits, 0);
  assert.equal(rig.economy.credits, 0, 'losing must not pay');
  /* The loss lands when the LEADER's tuned curve integrates home: the lane-1
   * 402 m at 5.05→5.70 m/s is ~74.9 s. This is the other half of the
   * winnability boundary — if a retune moves the leader, this notices. */
  assert.ok(fin.score > 72 && fin.score < 78,
    `the leader should be home at ~74.9 s (got ${fin.score.toFixed(1)})`);
});

/* ------------------------------------------------------------------ */
/* The checkpoints are the authority                                   */
/* ------------------------------------------------------------------ */

test('cutting the infield credits nothing: the lap must be run in order', () => {
  const rig = makeRig();
  beginRace(rig);
  const game = rig.mg._game;
  const r = midRadius();
  const lap = lapLength(r);

  // One bound across the infield to the middle of the back straight...
  place(rig, TRACK_COURSE.cx, 0.05, TRACK_COURSE.cz + r);
  frame(rig);
  // ...then run the SECOND half of the lap honestly, arriving at the line.
  const pt = {};
  for (let s = lap / 2; s <= lap - 0.01; s += 6 * STEP) {
    coursePoint(r, s, pt);
    place(rig, pt.x, 0.05, pt.z);
    frame(rig);
  }
  assert.equal(rig.mg.state, MINIGAME_STATE.PLAYING, 'arriving at the paint must not finish a half-run lap');
  assert.equal(game._cp, 0, 'checkpoint 1 was never passed, so nothing after it may count');
  assert.ok(game.playerDist < lap / TRACK_COURSE.checkpoints,
    'the continuous ruler must not be fooled by the shortcut either');
  rig.mg.abort('player');
});

test('checkpoints do not count while mounted, and racing resumes on dismount', () => {
  const rig = makeRig();
  beginRace(rig);
  const game = rig.mg._game;
  const r = laneRadius(TRACK_COURSE.playerLane);
  const spacing = lapLength(midRadius()) / TRACK_COURSE.checkpoints;

  // Summon a board mid-race and ride through checkpoint 1.
  rig.mounts.summon('hoverboard');
  runLane(rig, { speed: 12, until: (s) => s > spacing + 8 });
  assert.equal(game._cp, 0, 'a 12 m/s hoverboard pass must not credit a checkpoint');
  assert.equal(game.snapshot().banner, 'ON FOOT — DISMOUNT TO RACE', 'and the HUD says why');

  // Step off, jog back behind the checkpoint, and take it on foot. (The
  // swept test is direction-free, as RaceManager's is: re-crossing the
  // armed checkpoint from either side is passing it.)
  rig.mounts.dismount();
  const pt = {};
  let s = spacing + 10;
  while (game._cp === 0 && s > 2) {
    s -= 4.6 * STEP;
    coursePoint(r, s, pt);
    place(rig, pt.x, 0.05, pt.z);
    frame(rig);
  }
  assert.equal(game._cp, 1, 'on foot, the armed checkpoint counts again');
  assert.equal(game.snapshot().banner, null);
  rig.mg.abort('player');
});

test('a dragon over the oval passes nothing: the y gate holds', () => {
  const rig = makeRig();
  beginRace(rig);
  const game = rig.mg._game;
  const spacing = lapLength(midRadius()) / TRACK_COURSE.checkpoints;

  // Fly the first stretch 40 m up, crossing checkpoint 1 in plan view.
  runLane(rig, { speed: 10, y: 40, until: (s) => s > spacing + 6 });
  assert.equal(game._cp, 0, 'an overflight 40 m up must not take a checkpoint');

  // Back on the rubber, re-crossing it counts.
  const r = laneRadius(TRACK_COURSE.playerLane);
  const pt = {};
  let s = spacing + 8;
  while (game._cp === 0 && s > 2) {
    s -= 5 * STEP;
    coursePoint(r, s, pt);
    place(rig, pt.x, 0.05, pt.z);
    frame(rig);
  }
  assert.equal(game._cp, 1);
  rig.mg.abort('player');
});

/* ------------------------------------------------------------------ */
/* The visible field                                                   */
/* ------------------------------------------------------------------ */

test('three rivals stand on the line, run their own lanes at exactly the readout, and tear down', () => {
  const group = new THREE.Group();
  const rig = makeRig({ venue: makeVenue({ group }), factory: stubFactory() });

  // Accept, and inspect the marks DURING the countdown — the gun has not
  // gone, so the field must be standing abreast of the player on the line.
  place(rig, TRACK_COURSE.cx - 4, 0.05, -148);
  pressE(rig);
  assert.equal(rig.mg.state, MINIGAME_STATE.COUNTDOWN);
  const game = rig.mg._game;

  assert.equal(group.children.length, 3, 'three bodies and NOTHING else — the track needs no furniture');
  const humanoids = game.runners.map((r) => r.ghost.humanoid);
  for (const r of game.runners) {
    assert.ok(r.ghost, `${r.name} should have a body`);
    assert.ok(Math.abs(r.ghost.root.position.x - TRACK_COURSE.cx) < 1e-6, 'on the line');
    assert.ok(Math.abs(r.ghost.root.position.z - (TRACK_COURSE.cz - r.r)) < 1e-6, 'in their own lane');
  }

  frames(rig, 5);
  assert.equal(rig.mg.state, MINIGAME_STATE.PLAYING, 'the countdown should expire into play');

  // Jog and sweep: every racing step, every body must sit at exactly the
  // course point its pace distance maps to — the number POSITION/LEADER are
  // computed from — on its own lane, at the venue's ground height (0 here).
  const pt = {};
  let sampled = 0;
  const r6 = laneRadius(TRACK_COURSE.playerLane);
  const p = rig.player.position;
  let s = 0;
  // 90 simulated seconds: past the leader's ~74.9 s finish, so the jog is
  // guaranteed to be run down and the loss teardown actually exercised.
  for (let i = 0; i < 5400 && rig.mg.running; i++) {
    s += 4.6 * STEP;
    coursePoint(r6, s, pt);
    place(rig, pt.x, 0.05, pt.z);
    frame(rig, i * STEP);
    if (!rig.mg.running) break;
    for (const r of game.runners) {
      coursePoint(r.r, Math.min(r.dist, r.lap), pt);
      const gp = r.ghost.root.position;
      assert.ok(Math.abs(gp.x - pt.x) < 1e-6 && Math.abs(gp.z - pt.z) < 1e-6,
        `${r.name}'s body and readout must never disagree`);
      assert.equal(gp.y, 0, 'feet on the venue\'s ground field');
    }
    sampled += 1;
  }
  assert.ok(sampled > 100, 'the sweep must actually have raced');
  assert.ok(game.runners.every((r) => r.dist > sampled * STEP * 4),
    'the field must actually be moving');
  void p;

  // Jogging cannot hold them off: the leader gets home, the race is lost,
  // and win or lose the flag tears every body down.
  assert.equal(rig.mg.state, MINIGAME_STATE.FINISHED);
  assert.equal(group.children.length, 0, 'all three bodies must be gone at the flag');
  for (const h of humanoids) assert.equal(h.disposed, true, 'each humanoid hands its geometry holds back');
});

test('quitting mid-race pays nothing, credits no quest, and still tears the field down', () => {
  const group = new THREE.Group();
  const rig = makeRig({ venue: makeVenue({ group }), factory: stubFactory() });
  beginRace(rig);
  assert.equal(group.children.length, 3);
  runLane(rig, { speed: 6, until: (s) => s > 80 });
  assert.ok(rig.mg._game._cp >= 2, 'quit from a real position, not the start');

  rig.mg.abort('player');
  assert.equal(rig.mg.state, MINIGAME_STATE.IDLE);
  assert.equal(rig.economy.credits, 0, 'an abandoned race pays nothing');
  assert.equal(rig.seen.filter((s) => s.type === 'quest:activity').length, 0,
    'and credits no quest step - walking out is not completing');
  assert.equal(group.children.length, 0, 'teardown must remove the bodies');
});

test('a world change mid-race tears down without paying', () => {
  const group = new THREE.Group();
  const rig = makeRig({ venue: makeVenue({ group }), factory: stubFactory() });
  beginRace(rig);
  assert.equal(group.children.length, 3);

  rig.bus.emit('world:changing', { to: 'maze' });
  assert.equal(rig.mg.state, MINIGAME_STATE.IDLE);
  assert.equal(group.children.length, 0, 'a portal out must not leave runners circling another world');
  assert.equal(rig.economy.credits, 0);
});

test('with no factory there are no bodies, and the contest is untouched', () => {
  const rig = makeRig();
  beginRace(rig);
  const game = rig.mg._game;
  assert.ok(game.runners.every((r) => r.ghost === null),
    'headless must mean bodiless, deterministically');
  // The readout still races: the field advances and the rows still rank.
  frames(rig, 2);
  assert.ok(game.runners.every((r) => r.dist > 5), 'the paced field runs on without bodies');
  const rows = game.snapshot().rows;
  assert.equal(rows[0].k, 'CHECKPOINT');
  assert.equal(rows[2].k, 'POSITION');
  assert.match(rows[2].v, /^P[1-4]\/4$/);
  assert.equal(rows[3].k, 'LEADER');
  assert.match(rows[3].v, /m$/);
  rig.mg.abort('player');
});
