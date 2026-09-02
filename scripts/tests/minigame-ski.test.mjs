import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

import { EventBus } from '../../src/core/EventBus.js';
import { Economy } from '../../src/systems/Economy.js';
import {
  MinigameManager,
  MINIGAME_STATE,
  MINIGAME_PRIZE,
  consolationFor,
} from '../../src/minigames/MinigameManager.js';
import {
  createSkiRun,
  SkiRun,
  SKI_GAME_ID,
  SKI_COURSE,
  pisteCentreX,
  gateCourse,
} from '../../src/minigames/SkiRun.js';

/**
 * The ski run, end to end, and the geometry under it.
 *
 * ── The gate this suite exists for ───────────────────────────────────────────
 *
 * The defect this project has shipped four times is a test that proves a thing
 * was BUILT and never that a player can REACH it. A slalom course is the
 * purest possible case: ten gates with plausible coordinates pass any
 * structural check while sitting on the mound's ungroomed flank, in a mogul
 * field, or hanging in the air over a gully - and the contest is then
 * unwinnable while every unit test stays green.
 *
 * So the geometry gate below does not check that the gates exist. It
 * re-extracts the piste's centreline - lane centre, weave amplitude,
 * frequency and groomed width - from `skiHeight`'s OWN source in
 * SportsWorld.js, reconstructs where the middle piste actually is at every
 * gate's z, and asserts each gate (poles included) stands inside the groomed
 * corridor. Gate HEIGHT is asserted separately: the module must take every
 * gate's y from the height field it is handed, never from a constant.
 *
 * The lifecycle gates run the real manager and the real module against a
 * scripted rider at the engine's own fixed step: a clean descent wins and
 * pays 10, a missed gate costs the stated 2 s, straight-lining hands the run
 * to the ghost, and the mount and gate furniture are cleaned up on every exit.
 */

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const SRC = nodePath.resolve(HERE, '../../src');
const STEP = 1 / 60;

/**
 * Deterministic stand-in for `skiHeight` in lifecycle tests: the same summit
 * cosine profile, minus the noise terms. Self-consistent is what matters -
 * the SAME function seats the gates and the scripted rider, exactly as the
 * real field seats the gates and the terrain-following board.
 */
const slopeHeight = (x, z) => {
  const t = Math.max(0, Math.min(1, (-72 - z) / 126));
  return 52 * (0.5 - 0.5 * Math.cos(Math.PI * t));
};

/**
 * The venue as the integration spec has SportsWorld publish it: centred
 * mid-course with the whole descent inside the disc, because MinigameManager
 * abandons a contest 9 s (LEAVE_GRACE_S) after the player leaves the venue
 * and the run takes longer than that - a summit-only trigger self-aborts.
 */
function makeVenue(extraConfig = {}) {
  return {
    id: 'meridian_slope',
    kind: 'ski',
    label: 'Meridian Downhill',
    centre: { x: pisteCentreX(-139), y: slopeHeight(pisteCentreX(-139), -139), z: -139 },
    radius: 60,
    yTolerance: 34,
    reward: 10,
    config: { heightFn: slopeHeight, ...extraConfig },
    rival: { name: 'Kjell Nordvik' },
  };
}

/**
 * A MountManager stand-in modelling the REAL mount surface the module now
 * touches: summon/dismount/active, plus the kinematic fields a Hoverboard
 * actually carries (`position` Vector3, `heading` yaw, `velocity`, `speed`)
 * — the start-gate placement writes them, and a double without them would
 * silently prove nothing (the pressed-without-held lesson, one system over).
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
      this.lastSummon = id;
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

function makeRig({ venue = makeVenue(), mounts = makeMounts(), factory = null } = {}) {
  const bus = new EventBus();
  const economy = new Economy({ bus });
  const player = { position: { x: 0, y: 0, z: 0 } };
  const keys = new Set();
  // The REAL Input contract is pressed AND held (level-trigger) — a double
  // that models only half of it is how the tennis unwinnability bug hid.
  const input = { pressed: (code) => keys.has(code), held: (code) => keys.has(code) };
  const mg = new MinigameManager({ bus, player, economy, input });
  // The exact wiring the integration spec gives main.js: the manager hands
  // the factory player/bus/input, and the closure adds the mount authority
  // (and, for the rival's body, the humanoid factory when a test wants one).
  mg.registerGame('ski', (v, c) =>
    createSkiRun(v, { ...c, mounts, ...(factory ? { factory } : {}) })
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
function frame(rig) {
  rig.mg.update(STEP);
  rig.mg.fixedUpdate(STEP, 0);
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

/** Accept at the summit approach and run the countdown out. */
function beginRun(rig) {
  const x = pisteCentreX(-195);
  place(rig, x, slopeHeight(x, -195) + 0.6, -195);
  pressE(rig);
  assert.equal(rig.mg.state, MINIGAME_STATE.COUNTDOWN, 'E at the venue should start the countdown');
  frames(rig, 5);
  assert.equal(rig.mg.state, MINIGAME_STATE.PLAYING, 'the countdown should expire into play');
}

/**
 * Ride the player through `points` ([x, z] pairs) at a held path speed,
 * seated on the slope, stepping the manager once per fixed step exactly as
 * the engine would. Stops when the contest ends.
 */
function rideThrough(rig, points, { speed = 12 } = {}) {
  const p = rig.player.position;
  for (const [tx, tz] of points) {
    let guard = 0;
    while (rig.mg.running && guard++ < 4000) {
      const dx = tx - p.x;
      const dz = tz - p.z;
      const d = Math.hypot(dx, dz);
      if (d < 1e-6) break;
      const step = Math.min(d, speed * STEP);
      p.x += (dx / d) * step;
      p.z += (dz / d) * step;
      p.y = slopeHeight(p.x, p.z) + 0.6;
      frame(rig);
    }
    if (!rig.mg.running) break;
  }
}

/** The clean line: start line, every gate centre, the finish. */
function cleanLine() {
  return [
    [pisteCentreX(-192), -192],
    ...gateCourse(slopeHeight).map((g) => [g.x, g.z]),
    [pisteCentreX(-86), -86],
  ];
}

/* ------------------------------------------------------------------ */
/* Geometry: are the gates actually on the groomed piste?              */
/* ------------------------------------------------------------------ */

test('every gate stands inside the groomed corridor skiHeight itself carves', async () => {
  const src = await readFile(nodePath.join(SRC, 'worlds/SportsWorld.js'), 'utf8');

  // The mound and the lanes, read off the world's own constants.
  const ski = /const SKI = \{ x0: (-?[\d.]+), z0: (-?[\d.]+), x1: (-?[\d.]+), z1: (-?[\d.]+), top: ([\d.]+) \}/.exec(src);
  const lanes = /const PISTE_LANES = \[(-?[\d.]+), (-?[\d.]+), (-?[\d.]+)\]/.exec(src);
  assert.ok(ski && lanes, 'SportsWorld should still declare SKI and PISTE_LANES');
  const [x0, z0, x1, z1] = ski.slice(1, 5).map(Number);
  const laneX = Number(lanes[2]); // middle piste = index 1

  // The weave and the groomed width, read off skiHeight's own body.
  const fnStart = src.indexOf('function skiHeight(');
  assert.ok(fnStart > 0, 'skiHeight should still exist');
  const fn = src.slice(fnStart, src.indexOf('\n}', fnStart) + 2);
  const weave = /const c = PISTE_LANES\[i\] \+ Math\.sin\(\(z \+ ([\d.]+)\) \* ([\d.]+) \+ i\) \* ([\d.]+);/.exec(fn);
  const width = /const w = ([\d.]+) \+ i \* ([\d.]+);/.exec(fn);
  const profile = /clamp01\(\((-?\d+) - z\) \/ (\d+)\)/.exec(fn);
  assert.ok(weave && width && profile, 'the piste weave, width and fall-line profile should be readable from skiHeight');
  const [zOff, freq, amp] = weave.slice(1, 4).map(Number);
  const w = Number(width[1]) + 1 * Number(width[2]); // middle piste, i = 1
  const [zTopRef, span] = profile.slice(1, 3).map(Number);

  // The module's restated constants must be the world's. This is the drift
  // guard: SkiRun duplicates these four numbers, and this is what breaks
  // when someone regrooms the mountain without moving the course.
  assert.equal(SKI_COURSE.laneX, laneX, 'course lane must be PISTE_LANES[1]');
  assert.ok(Math.abs(SKI_COURSE.weaveAmp - amp) < 1e-9, 'weave amplitude must match skiHeight');
  assert.ok(Math.abs(SKI_COURSE.weaveFreq - freq) < 1e-9, 'weave frequency must match skiHeight');
  assert.equal(SKI_COURSE.weaveZOff, zOff, 'weave z offset must match skiHeight');
  assert.equal(SKI_COURSE.weavePhase, 1, 'weave phase is the lane index, and the middle lane is 1');
  assert.ok(Math.abs(SKI_COURSE.pisteWidth - w) < 1e-9, 'groomed width must match skiHeight');

  // Reconstruct the centreline FROM THE EXTRACTED numbers and hold every
  // gate - poles included - inside the groomed corridor at its own z.
  const cx = (z) => laneX + Math.sin((z + zOff) * freq + 1) * amp;
  const gates = gateCourse(slopeHeight);
  assert.ok(gates.length >= 8 && gates.length <= 12, 'a slalom is 8-12 gates');
  let lastSide = 0;
  for (const g of gates) {
    const off = Math.abs(g.x - cx(g.z));
    assert.ok(
      off + SKI_COURSE.gateHalf <= w + 1e-9,
      `gate ${g.i + 1} at z=${g.z}: outer pole ${(off + SKI_COURSE.gateHalf).toFixed(2)} m off centreline exceeds the ${w} m groomed width`
    );
    assert.ok(g.x > x0 && g.x < x1 && g.z > z0 && g.z < z1,
      `gate ${g.i + 1} must be on the mound (${x0}..${x1}, ${z0}..${z1})`);
    assert.notEqual(g.side, lastSide, 'gates must alternate sides');
    lastSide = g.side;
  }

  // The course must genuinely descend: the fall-line profile factor at the
  // start line is near the summit and near zero at the finish.
  const fz = (z) => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, (zTopRef - z) / span)));
  assert.ok(SKI_COURSE.startZ < SKI_COURSE.finishZ, 'skiers travel toward +z');
  assert.ok(fz(SKI_COURSE.startZ) > 0.9, `the start line should sit near the summit (fz=${fz(SKI_COURSE.startZ).toFixed(3)})`);
  assert.ok(fz(SKI_COURSE.finishZ) < 0.15, `the finish should sit in the run-out (fz=${fz(SKI_COURSE.finishZ).toFixed(3)})`);
  assert.ok(SKI_COURSE.startZ > z0 && SKI_COURSE.finishZ < z1, 'start and finish must both be on the mound');
});

test('gate heights come from the height field the venue hands over, never a constant', () => {
  const calls = [];
  const probe = (x, z) => {
    calls.push([x, z]);
    return 42.125;
  };
  const gates = gateCourse(probe);
  for (const g of gates) {
    assert.equal(g.y, 42.125, `gate ${g.i + 1} must take its y from the field`);
    assert.ok(
      calls.some(([x, z]) => x === g.x && z === g.z),
      `gate ${g.i + 1} must sample the field at its own (x, z)`
    );
  }
  // And with no field at all, the vertical acceptance must be disabled
  // rather than comparing real positions against a fictional zero.
  const game = new SkiRun(
    { ...makeVenue(), config: {} },
    { player: { position: { x: 0, y: 0, z: 0 } }, bus: null }
  );
  assert.equal(game._yGate, Infinity, 'no height field means no vertical gate');
});

test('the published ski slot still exists for this module to plug into', async () => {
  const src = await readFile(nodePath.join(SRC, 'worlds/SportsWorld.js'), 'utf8');
  const block = src.slice(src.indexOf('this.minigameVenues'));
  assert.match(block, /id: 'meridian_slope'/);
  assert.match(block, /kind: 'ski'/);
  assert.match(block, /rival: \{ name: 'Kjell Nordvik' \}/);
});

/* ------------------------------------------------------------------ */
/* Prompt and mount                                                    */
/* ------------------------------------------------------------------ */

test('the slope prompts on arrival and E starts the countdown already mounted', () => {
  const rig = makeRig();
  place(rig, pisteCentreX(-139), slopeHeight(0, -139) + 0.5, -139);
  rig.mg.update(STEP);
  const p = rig.seen.filter((s) => s.type === 'minigame:prompt').at(-1)?.e;
  assert.equal(p?.verb, 'Start');
  assert.equal(p?.label, 'Meridian Downhill');
  assert.equal(p?.venueId, 'meridian_slope');

  pressE(rig);
  assert.equal(rig.mg.state, MINIGAME_STATE.COUNTDOWN);
  assert.equal(rig.mounts.summoned, 1, 'accepting should summon the board');
  assert.equal(rig.mounts.lastSummon, 'hoverboard');
  assert.equal(rig.mounts.active?.id, 'hoverboard', 'and the player should be riding it');

  /* Start positioning: the MOUNT (which owns position while ridden — a
   * player teleport would snap back) is stood just above the start line,
   * facing downhill, so the countdown shows the run laid out below. */
  const m = rig.mounts.active;
  const gz = SKI_COURSE.startZ - 4;
  assert.ok(Math.abs(m.position.z - gz) < 1e-9, `the board stands just above the line (z=${m.position.z})`);
  assert.ok(Math.abs(m.position.x - pisteCentreX(gz)) < 1e-9, 'on the groomed centreline');
  assert.ok(Math.abs(m.position.y - (slopeHeight(pisteCentreX(gz), gz) + 0.5)) < 1e-9,
    'seated on the snow by the height field, not a constant');
  assert.equal(m.heading, Math.PI, 'facing +z — downhill');
});

test('a player already on their board is not toggled off it, and keeps it at the flag', () => {
  const mounts = makeMounts({ premounted: true });
  const rig = makeRig({ mounts });
  beginRun(rig);
  assert.equal(mounts.summoned, 0,
    'summon() TOGGLES - calling it for the mount already ridden would dismiss it');

  rideThrough(rig, cleanLine());
  assert.equal(rig.mg.state, MINIGAME_STATE.FINISHED);
  assert.equal(mounts.dismounted, 0,
    'a board the module did not summon is not its to take away');
  assert.equal(mounts.active?.id, 'hoverboard');
});

/* ------------------------------------------------------------------ */
/* The contest                                                         */
/* ------------------------------------------------------------------ */

test('a clean descent through every gate beats Kjell and pays exactly 10 credits', () => {
  const rig = makeRig();
  beginRun(rig);

  const game = rig.mg._game;
  assert.equal(game.phase, 'approach', 'the clock must not run until the start line is crossed');
  assert.equal(rig.economy.credits, 0);

  rideThrough(rig, cleanLine());
  assert.equal(rig.mg.state, MINIGAME_STATE.FINISHED);

  const fin = rig.seen.find((s) => s.type === 'minigame:finished')?.e;
  assert.ok(fin, 'a finish must be announced');
  assert.equal(fin.won, true, 'a committed line at board cruise pace should beat the ghost');
  assert.equal(fin.place, 1);
  assert.equal(fin.detail.passed, 10, 'every gate should have been taken');
  assert.equal(fin.detail.missed, 0);
  /* 120, and no longer the 10 the user first asked for.
   *
   * The request ("if I win I get 10 credits") predates the shop, and the shop
   * is what made it wrong: the cheapest row on any shelf is a medkit at 67-138
   * CR, so a whole contest paid a ninth of the cheapest thing in the game while
   * one raider paid 5 CR of bounty PLUS a guaranteed credit drop off the body.
   * The Sep-2026 economy audit measured that and moved the prize onto shelf
   * scale. `MINIGAME_PRIZE` carries the arithmetic, including why 120 is not a
   * guess: it is what `BUTTS_REWARD` - the one venue authored after the shop
   * existed - has always paid.
   *
   * The literal is kept beside the constant on purpose. Asserting only
   * `MINIGAME_PRIZE` would let the number move silently; asserting both means
   * moving it stays a deliberate act with a reason attached. */
  assert.equal(fin.credits, MINIGAME_PRIZE);
  assert.equal(fin.credits, 120, 'a contest win must buy one shelf item — see MINIGAME_PRIZE');
  assert.equal(rig.economy.credits, MINIGAME_PRIZE, 'and the wallet has to actually contain them');
  assert.equal(fin.rivalName, 'Kjell Nordvik');

  // The quest handle, in the shape QuestSystem's default branch reads.
  const act = rig.seen.find((s) => s.type === 'quest:activity')?.e;
  assert.equal(act?.type, 'minigame');
  assert.equal(act?.target, SKI_GAME_ID);
  assert.equal(act?.name, 'Meridian Downhill');
  assert.equal(act?.won, true);

  // Finish cleans up: the auto-summoned board is handed back.
  assert.equal(rig.mounts.dismounted, 1, 'the module dismounts the board it summoned');
});

test('skipping one gate costs the stated 4 s and a fast run still wins', () => {
  const rig = makeRig();
  beginRun(rig);

  const line = cleanLine();
  // Gate 3 (index 2 of the course, entry 3 of the line) is replaced by the
  // bare centreline at its z: 3.2 m wide of the poles, an honest miss.
  const g = gateCourse(slopeHeight)[2];
  line[3] = [pisteCentreX(g.z), g.z];
  rideThrough(rig, line);

  assert.equal(rig.mg.state, MINIGAME_STATE.FINISHED);
  const fin = rig.seen.find((s) => s.type === 'minigame:finished')?.e;
  assert.equal(fin.detail.missed, 1);
  assert.equal(fin.detail.penaltySeconds, SKI_COURSE.penaltyS);
  assert.equal(fin.detail.penaltySeconds, 4,
    'the HUD states 4 s per missed gate (the winnability retune); it must cost 4 s');
  assert.equal(fin.won, true, 'one miss on a fast run should still beat the ghost');
  assert.ok(fin.score > fin.detail.run, 'the penalty must be inside the recorded score');
  const missEvent = rig.seen.find((s) => s.type === 'minigame:event' && s.e.kind === 'miss')?.e;
  assert.match(missEvent?.text ?? '', /MISSED — \+4s/, 'the miss and its price are announced');
});

test('straight-lining the course hands it to the ghost, and a loss pays the participation floor', () => {
  const rig = makeRig();
  beginRun(rig);

  // Ride the bare centreline: every gate is 3.2 m wide of the line, outside
  // the 2.4 m pass radius, so every one is missed and each hands the ghost
  // 2 s. Nothing here is a cheat - it is just not slalom.
  const line = [[pisteCentreX(-192), -192]];
  for (let z = -186; z <= -86; z += 6) line.push([pisteCentreX(z), z]);
  rideThrough(rig, line);

  assert.equal(rig.mg.state, MINIGAME_STATE.FINISHED);
  const fin = rig.seen.find((s) => s.type === 'minigame:finished')?.e;
  assert.equal(fin.won, false);
  assert.equal(fin.detail.reason, 'rival', 'the accumulated penalties put the ghost home first');
  assert.ok(fin.detail.missed >= 5, `the misses are what lost it (${fin.detail.missed} recorded)`);
  /* A COMPLETED loss pays the participation floor, and an abandoned one still
   * pays nothing - see the quit test below. The number this replaced was zero,
   * and `2026-08-23-mission-architecture.md` §8 measured what that costs:
   * "Zero for a completed contest against a named rival teaches players not to
   * enter." The floor is a quarter of the venue's own prize, clamped strictly
   * below it, so winning is still the point. */
  const floor = consolationFor(rig.mg.venue ?? rig.mg._venue);
  assert.ok(floor > 0, 'the ski venue pays nothing for finishing a losing run');
  assert.equal(fin.credits, floor);
  assert.equal(rig.economy.credits, floor, 'a completed loss paid the wrong floor');
  assert.ok(floor < (rig.mg._venue?.reward ?? 10), 'the floor is not below the prize');
  assert.equal(fin.rivalName, 'Kjell Nordvik');
  assert.equal(rig.mounts.dismounted, 1, 'the board is handed back on a loss too');
});

test('the winnability boundary: an ordinary run survives one miss and loses on two', () => {
  /* "Ordinary" here is 6.5 m/s along the weaving line ≈ 18.8 s of timed
   * descent — the middle of the 15-25 s band measured in-browser. Against the
   * 24.8 s ghost and the 4 s penalty that must resolve exactly as the brief
   * asks: most-gates wins, missing 2+ loses. */
  const run = (missCount) => {
    const rig = makeRig();
    beginRun(rig);
    const line = cleanLine();
    const gates = gateCourse(slopeHeight);
    for (let i = 0; i < missCount; i++) {
      const g = gates[i * 2 + 1]; // gates 2 and 4: honest mid-course misses
      line[g.i + 1] = [pisteCentreX(g.z), g.z];
    }
    rideThrough(rig, line, { speed: 6.5 });
    return rig.seen.find((s) => s.type === 'minigame:finished')?.e;
  };
  const clean = run(0);
  assert.equal(clean?.won, true, 'a clean ordinary descent wins');
  const one = run(1);
  assert.equal(one?.detail?.missed, 1);
  assert.equal(one?.won, true, 'one missed gate on an ordinary descent still wins');
  const two = run(2);
  assert.equal(two?.detail?.missed, 2);
  assert.equal(two?.won, false, 'two missed gates on an ordinary descent lose');
  assert.equal(two?.detail?.reason, 'rival', 'because the penalties put Kjell home first');
});

/**
 * A HumanoidFactory stand-in for the rival's body: the surface
 * `GhostCompetitor` actually touches. The REAL factory bakes canvas textures
 * and cannot run headless — which is also why a rig with no injected factory
 * deterministically has no body (asserted by the furniture-count tests).
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

test("Kjell's body rides the snow at exactly the readout distance, and is torn down", () => {
  const group = new THREE.Group();
  const rig = makeRig({ venue: makeVenue({ group }), factory: stubFactory() });
  beginRun(rig);
  const game = rig.mg._game;
  assert.ok(game._ghost, 'group + height field + factory should produce a body');
  assert.equal(group.children.length, 2, 'the gate furniture and the rival body');
  const gr = game._ghost.root.position;
  assert.equal(gr.z, SKI_COURSE.startZ, 'waiting at the start line during the approach');

  // Descend the bare centreline; every racing step the body must sit at
  // startZ + rivalDist — the number the RIVAL row prints — on the snow,
  // inside the gate corridor.
  const p = rig.player.position;
  place(rig, pisteCentreX(-192), slopeHeight(pisteCentreX(-192), -192) + 0.6, -192);
  let sampled = 0;
  for (let i = 0; i < 2000 && rig.mg.running; i++) {
    p.z += 8 * STEP;
    p.x = pisteCentreX(p.z);
    p.y = slopeHeight(p.x, p.z) + 0.6;
    frame(rig);
    if (!rig.mg.running || game.phase !== 'racing') continue;
    assert.ok(Math.abs(gr.z - (SKI_COURSE.startZ + game.rivalDist)) < 1e-6,
      'the body and the readout must never disagree');
    assert.ok(Math.abs(gr.y - (slopeHeight(gr.x, gr.z) + 0.55)) < 1e-6,
      'his y comes from the height field: he rides the snow');
    assert.ok(Math.abs(gr.x - pisteCentreX(gr.z)) <= SKI_COURSE.gateOffset + 1e-6,
      'his slalom line stays inside the gate corridor');
    sampled += 1;
  }
  assert.ok(sampled > 100, 'the sweep must actually have raced');

  // Straight-lining missed everything, so this run LOST — and win or lose,
  // the flag tears down gates and body alike.
  assert.equal(rig.mg.state, MINIGAME_STATE.FINISHED);
  assert.equal(group.children.length, 0, 'gates AND body must be gone at the flag');
});

test('quitting mid-run pays nothing, credits no quest, and still cleans up', () => {
  const group = new THREE.Group();
  const rig = makeRig({ venue: makeVenue({ group }) });
  beginRun(rig);
  assert.equal(group.children.length, 1, 'the run parents one group of course furniture');
  assert.equal(group.children[0].children.length, SKI_COURSE.gateCount * 2 + 4,
    'two poles per gate plus the start and finish pairs stand while the run is live');

  rideThrough(rig, cleanLine().slice(0, 4));
  assert.ok(rig.mg._game.passed >= 2, 'quit from a real position, not the start');

  rig.mg.abort('player');
  assert.equal(rig.mg.state, MINIGAME_STATE.IDLE);
  assert.equal(rig.economy.credits, 0, 'an abandoned run pays nothing');
  assert.equal(rig.seen.filter((s) => s.type === 'quest:activity').length, 0,
    'and credits no quest step - walking out is not completing');
  assert.equal(group.children.length, 0, 'teardown must remove the gate furniture');
  assert.equal(rig.mounts.dismounted, 1, 'and hand back the summoned board');
});

test('the gate furniture goes up on start and comes down on a world change', () => {
  const group = new THREE.Group();
  const rig = makeRig({ venue: makeVenue({ group }) });
  beginRun(rig);
  assert.ok(group.children.length > 0);

  rig.bus.emit('world:changing', { to: 'maze' });
  assert.equal(rig.mg.state, MINIGAME_STATE.IDLE);
  assert.equal(group.children.length, 0, 'a portal out must not leave poles on a mound in another world');
  assert.equal(rig.economy.credits, 0);
});

test('riding over the summit above the line does not arm the run', () => {
  const rig = makeRig();
  beginRun(rig);
  const game = rig.mg._game;

  // Cross the start line's z at altitude - a dragon overflight, not a start.
  const p = rig.player.position;
  place(rig, pisteCentreX(-190), slopeHeight(0, -190) + 40, -193);
  for (let i = 0; i < 90 && rig.mg.running; i++) {
    p.z += 6 * STEP;
    frame(rig);
  }
  assert.equal(game.phase, 'approach', 'an overflight 40 m up must not start the clock');

  // Now cross it on the snow: that is the start.
  place(rig, pisteCentreX(-190), slopeHeight(0, -192) + 0.6, -192);
  for (let i = 0; i < 90 && game.phase === 'approach'; i++) {
    p.z += 6 * STEP;
    p.y = slopeHeight(p.x, p.z) + 0.6;
    frame(rig);
  }
  assert.equal(game.phase, 'racing', 'crossing the line on the snow arms the run');
});
