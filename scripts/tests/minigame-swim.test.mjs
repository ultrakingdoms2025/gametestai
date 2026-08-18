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
} from '../../src/minigames/MinigameManager.js';
import { createSwimChallenge, SWIM_GAME_ID } from '../../src/minigames/SwimChallenge.js';
import { QuestSystem } from '../../src/systems/QuestSystem.js';

/**
 * The swim challenge, end to end, and the framework under it.
 *
 * ── What these gates are actually for ────────────────────────────────────────
 *
 * The failure mode this suite exists to catch is the one this project has
 * shipped four times: a test that proves a thing was BUILT and never that a
 * player can REACH it. A venue descriptor with a valid id and a plausible
 * radius passes any structural check while sitting over dry land, or naming
 * touch planes in water too shallow for `Swim` to hold the player, at which
 * point the contest is unwinnable and every unit test still goes green.
 *
 * So the geometry gate below does not check that the venue exists. It
 * reconstructs the pool floor from the numbers `SportsWorld._buildPool` builds
 * it from, and the entry/exit depths from the ones `Swim` uses, and asserts
 * that a swimmer can actually be swimming at both ends of the measured course.
 *
 * The lifecycle gates run the real manager and the real game module against a
 * scripted swimmer, at the engine's own fixed step, and assert the three things
 * the user asked for by name: a prompt at the venue, a quit that pays nothing,
 * and 10 credits for a win.
 */

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const SRC = nodePath.resolve(HERE, '../../src');
const STEP = 1 / 60;

/** The venue as `SportsWorld._buildSpawns` publishes it. Cross-checked below. */
const POOL_VENUE = {
  id: 'lido_pool',
  kind: 'swim',
  label: 'Lido Swim Challenge',
  centre: { x: 46, y: 0, z: 111 },
  radius: 20,
  yTolerance: 8,
  reward: 10,
  requires: 'swim',
  config: {
    startX: 34,
    farX: 58,
    lengths: 2,
    basin: { x0: 32, x1: 60, z0: 103, z1: 119 },
  },
  rival: { name: 'Tavius Okonkwo' },
};

/**
 * A HumanoidFactory stand-in for the rival's body: the surface
 * `GhostCompetitor` actually touches (root, rig, bones map, dispose), nothing
 * else. The REAL factory bakes canvas textures and cannot run headless, which
 * is also why a rig with no injected factory deterministically has no body.
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

function makeRig({ venues = [POOL_VENUE], extraCtx = null } = {}) {
  const bus = new EventBus();
  const economy = new Economy({ bus });
  const player = { position: { x: 0, y: 0, z: 0 } };
  const keys = new Set();
  // The REAL Input contract is pressed AND held (level-trigger) — a double
  // that models only half of it is how the tennis unwinnability bug hid.
  const input = { pressed: (code) => keys.has(code), held: (code) => keys.has(code) };
  const mg = new MinigameManager({ bus, player, economy, input });
  // With extras, the registration mirrors main.js's closure shape exactly.
  mg.registerGame(
    'swim',
    extraCtx ? (v, c) => createSwimChallenge(v, { ...c, ...extraCtx }) : createSwimChallenge
  );

  const seen = [];
  for (const type of [
    'minigame:prompt', 'minigame:countdown', 'minigame:started',
    'minigame:finished', 'minigame:aborted', 'minigame:armed',
    'quest:activity', 'hud:notify',
  ]) {
    bus.on(type, (e) => seen.push({ type, e }));
  }

  bus.emit('world:changed', { id: 'sports', world: { minigameVenues: venues } });
  return { bus, economy, player, keys, input, mg, seen };
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

/** Put the player somewhere, without simulating the journey. */
function place(rig, x, y, z) {
  rig.player.position.x = x;
  rig.player.position.y = y;
  rig.player.position.z = z;
}

/**
 * Swim the player to `targetX` down the middle of the pool, at a held speed,
 * stepping the manager once per fixed step exactly as the engine would.
 * @returns {number} seconds spent
 */
function swimTo(rig, targetX, { speed = 2.2, z = 111, y = -1.6, limit = 120 } = {}) {
  let t = 0;
  const p = rig.player.position;
  p.z = z;
  p.y = y;
  while (t < limit) {
    const d = targetX - p.x;
    if (Math.abs(d) < 1e-9) break;
    p.x += Math.sign(d) * Math.min(Math.abs(d), speed * STEP);
    frame(rig);
    t += STEP;
    if (!rig.mg.running) break;
  }
  return t;
}

/** Press E for exactly one frame. */
function pressE(rig) {
  rig.keys.add('KeyE');
  rig.mg.update(STEP);
  rig.keys.delete('KeyE');
}

/** Take the contest from IDLE to PLAYING with the player already in the water. */
function beginRace(rig) {
  place(rig, 40, -1.6, 111);
  pressE(rig);
  assert.equal(rig.mg.state, MINIGAME_STATE.COUNTDOWN, 'E at the venue should start the countdown');
  // The game module asks for five seconds of "take your marks".
  frames(rig, 6);
  assert.equal(rig.mg.state, MINIGAME_STATE.PLAYING, 'the countdown should expire into play');
}

/* ------------------------------------------------------------------ */
/* Geometry: can a swimmer actually swim this course?                  */
/* ------------------------------------------------------------------ */

test('the swim course lies in water deep enough for Swim to hold the player', async () => {
  const pool = await readFile(nodePath.join(SRC, 'worlds/SportsWorld.js'), 'utf8');
  const swim = await readFile(nodePath.join(SRC, 'player/Swim.js'), 'utf8');

  // The basin, read off the pool builder rather than restated here.
  const basin = /const bx0 = (-?[\d.]+), bx1 = (-?[\d.]+), bz0 = (-?[\d.]+), bz1 = (-?[\d.]+);/.exec(pool);
  assert.ok(basin, 'SportsWorld._buildPool should still declare the basin extents');
  const [bx0, bx1, bz0, bz1] = basin.slice(1, 5).map(Number);

  // The water plane and the sloping floor, likewise.
  const waterY = Number(/waterGeo\.translate\([^,]+, (-?[\d.]+),/.exec(pool)?.[1]);
  const floor = /floor\.position\.set\((-?[\d.]+), (-?[\d.]+), (-?[\d.]+)\);/.exec(pool);
  const slope = /floor\.rotation\.z = -Math\.atan2\(([\d.]+), ([\d.]+)\);/.exec(pool);
  const thick = Number(/new THREE\.BoxGeometry\([\d.]+, ([\d.]+), 16\), tile\)/.exec(pool)?.[1]);
  assert.ok(Number.isFinite(waterY) && floor && slope && Number.isFinite(thick),
    'the pool water plane and sloping floor should still be readable from source');

  const fx = Number(floor[1]);
  const fy = Number(floor[2]);
  const phi = -Math.atan2(Number(slope[1]), Number(slope[2]));
  const half = thick / 2;
  /** Metres of water over the floor at world x, on the pool centreline. */
  const depthAt = (x) => {
    // The plate is a box rotated about Z; its top face at local u is
    // (fy + u*sin(phi) + half*cos(phi)). Invert the tiny x shift the rotation
    // introduces - it is under a centimetre - by solving u from x directly.
    const u = (x - fx) / Math.cos(phi);
    const topY = fy + u * Math.sin(phi) + half * Math.cos(phi);
    return waterY - topY;
  };

  // Swimming's own thresholds, read off the module that enforces them.
  const enter = Number(/const ENTER_DEPTH = ([\d.]+);/.exec(swim)?.[1]);
  const exit = Number(/const EXIT_DEPTH = ([\d.]+);/.exec(swim)?.[1]);
  assert.ok(enter > 0 && exit > 0, 'Swim should still declare its entry and exit depths');

  const { startX, farX } = POOL_VENUE.config;

  // Inside the walls, or the touch plane is behind tile.
  assert.ok(startX > bx0 && startX < bx1, `startX ${startX} must be inside the basin ${bx0}..${bx1}`);
  assert.ok(farX > bx0 && farX < bx1, `farX ${farX} must be inside the basin ${bx0}..${bx1}`);
  assert.ok(POOL_VENUE.centre.z > bz0 && POOL_VENUE.centre.z < bz1, 'the lane must be inside the basin');

  /* The shallow touch must still be swimmable: `Swim` releases the player below
   * EXIT_DEPTH, and a start wall the swimmer cannot reach without standing up
   * mid-length is a course that cannot be completed as a swim. */
  assert.ok(
    depthAt(startX) > exit,
    `start plane x=${startX} sits in ${depthAt(startX).toFixed(2)} m, at or below Swim's ${exit} m release depth`
  );
  /* The far touch must be deep enough to ENTER the swim, because a player who
   * dives in at that end has to become a swimmer there. */
  assert.ok(
    depthAt(farX) > enter,
    `far plane x=${farX} sits in ${depthAt(farX).toFixed(2)} m, below Swim's ${enter} m entry depth`
  );
});

test('the published venue matches the one these tests race on', async () => {
  const src = await readFile(nodePath.join(SRC, 'worlds/SportsWorld.js'), 'utf8');
  const block = src.slice(src.indexOf('this.minigameVenues'));
  assert.ok(block.length > 0, 'SportsWorld should publish minigameVenues');
  assert.match(block, /id: 'lido_pool'/);
  assert.match(block, /kind: 'swim'/);
  assert.match(block, /startX: 34/);
  assert.match(block, /farX: 58/);
  assert.match(block, /lengths: 2/);
  assert.match(block, /basin: \{ x0: 32, x1: 60, z0: 103, z1: 119 \}/);
  assert.match(block, /reward: 10/);
  // The slots that must stay published and inert until their modules land.
  assert.match(block, /kind: 'tennis'/);
  assert.match(block, /kind: 'ski'/);
});

/* ------------------------------------------------------------------ */
/* Arming                                                              */
/* ------------------------------------------------------------------ */

test('only venues with a registered game arm, and a world change clears them', () => {
  const rig = makeRig({
    venues: [
      POOL_VENUE,
      { id: 'court', kind: 'tennis', label: 'Court', centre: { x: 112, z: 26 }, radius: 20 },
      { id: 'broken', kind: 'swim', label: 'No centre', radius: 12 },
    ],
  });
  assert.deepEqual(rig.mg.venues.map((v) => v.id), ['lido_pool'],
    'tennis has no module and the malformed venue has no centre; neither should arm');

  // The bug this mirrors: RaceManager used to return early for a world with no
  // circuit, which left the previous world's track armed four km away.
  rig.bus.emit('world:changed', { id: 'maze', world: {} });
  assert.deepEqual(rig.mg.venues, [], 'a world with no venues must clear the previous world\'s');
  assert.equal(rig.mg.nearest, null);
});

test('a malformed world never throws on a world change', () => {
  const rig = makeRig({ venues: [] });
  for (const world of [null, {}, { minigameVenues: null }, { minigameVenues: [null, 7, 'x'] }]) {
    assert.doesNotThrow(() => rig.bus.emit('world:changed', { id: 'x', world }));
  }
});

/* ------------------------------------------------------------------ */
/* Prompt and the E key                                                */
/* ------------------------------------------------------------------ */

test('the venue prompts on arrival and stands down for doors and portals', () => {
  const rig = makeRig();
  const prompts = () => rig.seen.filter((s) => s.type === 'minigame:prompt').map((s) => s.e);

  place(rig, 200, 0, 200);
  rig.mg.update(STEP);
  assert.equal(rig.mg.nearest, null, 'nothing should be offered from the far side of the park');

  place(rig, 46, 0.1, 104);
  rig.mg.update(STEP);
  const p = prompts().at(-1);
  assert.equal(p.verb, 'Start');
  assert.equal(p.label, 'Lido Swim Challenge');
  assert.equal(p.venueId, 'lido_pool');

  /* A door in reach means E belongs to Interiors. Both systems poll the same
   * un-consumed key, so the venue has to stand down by hand or one press does
   * two things. */
  rig.bus.emit('interior:prompt', { text: 'Open door' });
  rig.mg.update(STEP);
  assert.equal(prompts().at(-1).text, null, 'a door prompt must suppress the venue prompt');
  pressE(rig);
  assert.equal(rig.mg.state, MINIGAME_STATE.IDLE, 'E belongs to the door while its prompt is up');

  rig.bus.emit('interior:prompt', { text: null });
  rig.bus.emit('portal:near', { portal: { id: 'gw' } });
  rig.mg.update(STEP);
  assert.equal(prompts().at(-1).text, null, 'a portal in reach must suppress the venue prompt');
  pressE(rig);
  assert.equal(rig.mg.state, MINIGAME_STATE.IDLE, 'E belongs to the portal while one is in reach');

  /* And the third claim, which is the citadel's.
   *
   * `Viewpoints` raises a leap-of-faith prompt within 3 m of a published launch
   * point. In the citadel the great tower's launch beam tip stands 58.3 m and
   * 24.1 m inside the `citadel_skyline` venue disc - which is r 60.8 / yTol
   * 33.5 because a trial disc has to hold its whole route or `LEAVE_GRACE_S`
   * abandons the run - so the venue prompt buried the leap prompt at the one
   * place in the world it exists for, and E started a race off a diving board.
   * Suppressing it HERE rather than in the HUD is what keeps the key and the
   * words agreeing. */
  rig.bus.emit('portal:near', { portal: null });
  rig.bus.emit('viewpoint:prompt', { text: 'Leap of faith — hay 46 m below', viewpointId: 'great-tower' });
  rig.mg.update(STEP);
  assert.equal(prompts().at(-1).text, null, 'a leap-of-faith prompt must suppress the venue prompt');
  pressE(rig);
  assert.equal(rig.mg.state, MINIGAME_STATE.IDLE, 'E belongs to nobody while the leap prompt is up');

  rig.bus.emit('viewpoint:prompt', { text: null, viewpointId: null });
  rig.mg.update(STEP);
  assert.equal(prompts().at(-1).verb, 'Start');
  pressE(rig);
  assert.equal(rig.mg.state, MINIGAME_STATE.COUNTDOWN, 'with nothing else claiming E, the venue takes it');
});

test('mid-contest the prompt offers the quit, and E only REQUESTS it', () => {
  const rig = makeRig();
  beginRace(rig);

  rig.mg.update(STEP);
  const p = rig.seen.filter((s) => s.type === 'minigame:prompt').at(-1).e;
  assert.equal(p.verb, 'Quit', 'a running contest offers the only decision left');

  let requests = 0;
  rig.bus.on('minigame:quitRequest', () => { requests++; });
  pressE(rig);
  assert.equal(requests, 1);
  assert.equal(rig.mg.state, MINIGAME_STATE.PLAYING,
    'E must never abandon a match on its own - the confirm sheet owns the abort');
});

/* ------------------------------------------------------------------ */
/* The contest                                                         */
/* ------------------------------------------------------------------ */

test('swimming the two lengths cleanly wins and pays exactly 10 credits', () => {
  const rig = makeRig();
  beginRace(rig);

  const game = rig.mg._game;
  /* Start positioning made the wall-touch arming IMMEDIATE: the factory
   * placed the player at the start wall during the countdown, so the first
   * racing step finds them already touching it. The arming rule itself is
   * unchanged — the deck-walk test below still proves dry land counts zero. */
  assert.equal(game.phase, 'racing', 'placed on the start wall, the race arms on the first step');
  assert.equal(rig.economy.credits, 0);

  swimTo(rig, 34);
  assert.equal(game.phase, 'racing', 'drifting on the wall does not un-arm it');

  swimTo(rig, 58);
  assert.equal(game.leg, 1, 'reaching the far wall completes a length');

  swimTo(rig, 34);
  assert.equal(rig.mg.state, MINIGAME_STATE.FINISHED);

  const fin = rig.seen.find((s) => s.type === 'minigame:finished')?.e;
  assert.ok(fin, 'a finish must be announced');
  assert.equal(fin.won, true, 'a 2.2 m/s cruise should beat the pace swimmer');
  assert.equal(fin.place, 1);
  assert.equal(fin.credits, MINIGAME_PRIZE);
  assert.equal(fin.credits, 10, 'the user asked for ten credits, in those words');
  assert.equal(rig.economy.credits, 10, 'and the wallet has to actually contain them');
  assert.equal(fin.detail.splits.length, 2, 'both lengths should be split');
  assert.ok(fin.time > 0);
});

test('dawdling loses to the pace swimmer, and a loss pays nothing', () => {
  const rig = makeRig();
  beginRace(rig);
  swimTo(rig, 34);
  // Well under the rival's pace. Nothing here is a cheat - it is just slow.
  swimTo(rig, 58, { speed: 0.8 });
  if (rig.mg.running) swimTo(rig, 34, { speed: 0.8 });

  assert.equal(rig.mg.state, MINIGAME_STATE.FINISHED);
  const fin = rig.seen.find((s) => s.type === 'minigame:finished')?.e;
  assert.equal(fin.won, false);
  assert.equal(fin.credits, 0);
  assert.equal(rig.economy.credits, 0, 'losing must not pay');
  assert.equal(fin.rivalName, 'Tavius Okonkwo');
});

test('getting out of the pool freezes progress rather than advancing it', () => {
  const rig = makeRig();
  beginRace(rig);
  swimTo(rig, 34);
  const before = rig.mg._game.playerDist;

  // Run the length on the deck instead. Two metres above the water, inside the
  // venue, moving fast - and worth nothing.
  const p = rig.player.position;
  for (let i = 0; i < 240; i++) {
    p.y = 0.1;
    p.x = Math.min(58, p.x + 6 * STEP);
    frame(rig);
  }
  assert.ok(rig.mg._game.playerDist <= before + 1e-6,
    'a length walked along the deck must not count as a length swum');
  assert.equal(rig.mg._game.leg, 0);
});

test('quitting mid-contest pays nothing and credits no quest', () => {
  const rig = makeRig();
  beginRace(rig);
  swimTo(rig, 34);
  swimTo(rig, 58);
  assert.equal(rig.mg._game.leg, 1, 'quit from a winning position, not a hopeless one');

  rig.mg.abort('player');
  assert.equal(rig.mg.state, MINIGAME_STATE.IDLE);
  assert.equal(rig.economy.credits, 0, 'an abandoned contest pays nothing');
  assert.equal(rig.seen.filter((s) => s.type === 'quest:activity').length, 0,
    'and credits no quest step - walking out is not completing');
  assert.ok(rig.seen.some((s) => s.type === 'minigame:aborted'));
  assert.equal(rig.seen.filter((s) => s.type === 'minigame:finished').length, 0);
});

test('walking away from the venue abandons the contest', () => {
  const rig = makeRig();
  beginRace(rig);
  swimTo(rig, 34);

  place(rig, 46, 0.2, 160);
  frames(rig, 12);
  assert.equal(rig.mg.state, MINIGAME_STATE.IDLE);
  assert.equal(rig.economy.credits, 0);
  const abort = rig.seen.find((s) => s.type === 'minigame:aborted')?.e;
  assert.equal(abort.reason, 'left');
});

test('leaving the world abandons the contest without paying', () => {
  const rig = makeRig();
  beginRace(rig);
  swimTo(rig, 34);
  swimTo(rig, 58);

  rig.bus.emit('world:changing', { to: 'maze' });
  assert.equal(rig.mg.state, MINIGAME_STATE.IDLE);
  assert.equal(rig.economy.credits, 0);
});

test('the countdown is driven from elapsed time, so a stall cannot skip a number', () => {
  const rig = makeRig();
  place(rig, 40, -1.6, 111);
  pressE(rig);

  const counts = () => rig.seen.filter((s) => s.type === 'minigame:countdown').map((s) => s.e.count);
  // One enormous step, as a tab that was backgrounded delivers.
  rig.mg.fixedUpdate(2.5, 0);
  rig.mg.fixedUpdate(2.5, 0);
  assert.equal(rig.mg.state, MINIGAME_STATE.PLAYING);
  assert.equal(counts().at(-1), 0, 'the sequence must still land on zero after a stall');
  const seq = counts();
  for (let i = 1; i < seq.length; i++) {
    assert.ok(seq[i] < seq[i - 1], 'the countdown must never go up');
  }
});

/* ------------------------------------------------------------------ */
/* Start positioning and the visible rival                             */
/* ------------------------------------------------------------------ */

test('accepting places the swimmer on their mark: start wall, in the water, lane centre', () => {
  const rig = makeRig();
  place(rig, 46, 0.13, 104); // standing on the deck, nowhere near the wall
  pressE(rig);
  assert.equal(rig.mg.state, MINIGAME_STATE.COUNTDOWN);

  const p = rig.player.position;
  assert.ok(Math.abs(p.x - 34.5) < 1e-9, `at the start wall inside the touch slack (x=${p.x})`);
  assert.equal(p.z, 110, 'in a lane centre, one lane off the rival');
  assert.ok(p.y < -0.35, `in the water, under the coping (y=${p.y})`);

  // Which is what makes the wall-touch arming immediate once play begins.
  frames(rig, 6);
  assert.equal(rig.mg.state, MINIGAME_STATE.PLAYING);
  assert.equal(rig.mg._game.phase, 'racing', 'no swim-to-the-wall preamble from the placed start');
});

test('the rival BODY swims the adjacent lane at exactly the readout distance', () => {
  const group = new THREE.Group();
  const rig = makeRig({
    extraCtx: { factory: stubFactory(), worldManager: { active: { group } } },
  });
  beginRace(rig);
  const game = rig.mg._game;
  assert.ok(game._ghost, 'a world group and a factory should produce a body');
  assert.ok(group.children.includes(game._ghost.root), 'the body must live in the world group');

  // Swim a length at cruise; at every step the body's course position must be
  // the same `rivalDist` mapping the RIVAL gap row is derived from — the two
  // must never disagree.
  const p = rig.player.position;
  p.z = 111;
  p.y = -1.6;
  let sampled = 0;
  for (let i = 0; i < 900 && rig.mg.running; i++) {
    p.x = Math.min(58, p.x + 2.2 * STEP);
    frame(rig);
    if (!rig.mg.running) break;
    const d = game.rivalDist;
    const leg = Math.min(Math.floor(d / game.legLength), game.lengths - 1);
    const frac = (d - leg * game.legLength) / game.legLength;
    const along = leg % 2 === 0 ? frac : 1 - frac;
    const x = game.startX + (game.farX - game.startX) * along;
    assert.ok(Math.abs(game._ghost.root.position.x - x) < 1e-6,
      `body x ${game._ghost.root.position.x} must equal the readout mapping ${x}`);
    assert.equal(game._ghost.root.position.z, 112, 'one lane over (~2 m)');
    sampled += 1;
  }
  assert.ok(sampled > 100, 'the sweep must actually have raced');
});

test('the body is removed and the humanoid handed back on finish AND on abort', () => {
  // Finish path: _win/_lose self-dispose, because the manager only ever
  // reset()s a finished contest (the TennisMatch cleanup contract).
  const group = new THREE.Group();
  let rig = makeRig({
    extraCtx: { factory: stubFactory(), worldManager: { active: { group } } },
  });
  beginRace(rig);
  const hum = rig.mg._game._ghost.humanoid;
  swimTo(rig, 58);
  swimTo(rig, 34);
  assert.equal(rig.mg.state, MINIGAME_STATE.FINISHED);
  assert.equal(group.children.length, 0, 'a finished contest must not leak the body');
  assert.equal(hum.disposed, true, 'the humanoid must hand its geometry holds back');

  // Abort path: the manager's teardown calls dispose().
  const group2 = new THREE.Group();
  rig = makeRig({
    extraCtx: { factory: stubFactory(), worldManager: { active: { group: group2 } } },
  });
  beginRace(rig);
  const hum2 = rig.mg._game._ghost.humanoid;
  rig.mg.abort('player');
  assert.equal(group2.children.length, 0, 'an abort must not leak the body');
  assert.equal(hum2.disposed, true);
});

test('with no factory or scene there is no body, and the contest is untouched', () => {
  const rig = makeRig();
  beginRace(rig);
  assert.equal(rig.mg._game._ghost, null, 'headless must mean bodiless, deterministically');
  swimTo(rig, 58);
  swimTo(rig, 34);
  assert.equal(rig.mg.state, MINIGAME_STATE.FINISHED);
  assert.equal(rig.economy.credits, 10, 'and the race still pays as always');
});

/* ------------------------------------------------------------------ */
/* Quest credit                                                        */
/* ------------------------------------------------------------------ */

test('the finish payload is shaped for QuestSystem and advances a minigame step', () => {
  const rig = makeRig();
  const quests = new QuestSystem({ bus: rig.bus });

  /* A real engagement, in the shape `_advanceSteps` reads. Two steps, so the
   * advance does not complete the quest and reach for the network. */
  quests.engagements.set('eng-1', {
    engagement: { id: 'eng-1', status: 'in_progress' },
    quest: {
      id: 'q-1',
      steps: [
        { order: 0, type: 'minigame', target: 'swim_challenge', count: 1, label: 'Swim the lido' },
        { order: 1, type: 'kill', target: 'nobody', count: 1, label: 'Unrelated' },
      ],
    },
    stepStates: {},
  });

  beginRace(rig);
  swimTo(rig, 34);
  swimTo(rig, 58);
  swimTo(rig, 34);

  const act = rig.seen.find((s) => s.type === 'quest:activity')?.e;
  assert.ok(act, 'a finish must emit quest:activity');
  assert.equal(act.type, 'minigame');
  assert.equal(act.target, SWIM_GAME_ID);
  assert.equal(act.id, SWIM_GAME_ID);
  assert.equal(act.name, 'Lido Swim Challenge');
  assert.equal(act.won, true);
  assert.equal(act.place, 1);

  /* The candidates the matcher will actually see. This is the gate that would
   * have caught a payload that carried the venue id under a key the `minigame`
   * branch of `_eventTargetCandidates` does not read.
   *
   * Since the dedicated branch landed, a finished contest's game id is carried
   * INSIDE the `<gameId>_won`/`<gameId>_lost` composite and never offered
   * bare: `_tokenRunMatch` is bidirectional, so a bare `swim_challenge` on
   * every finish would sit inside the target `swim_challenge_won` as a
   * whole-token run and complete a "win it" step on a LOSS. The plain-id step
   * still completes — asserted below — because the id matches the composite
   * as a token run. */
  const candidates = quests._eventTargetCandidates('minigame', act);
  assert.ok(candidates.includes(`${SWIM_GAME_ID}_won`),
    'a won finish must offer the outcome composite — the only candidate that carries the game id');
  assert.equal(candidates.includes(SWIM_GAME_ID), false,
    'the bare game id must NOT ride beside an outcome: as a token-subrun of the composite '
    + 'it would complete a "win it" step on any finish');
  assert.ok(candidates.includes('Lido Swim Challenge'), 'the label must be a matchable candidate');

  assert.equal(
    quests.engagements.get('eng-1').stepStates[0]?.done, true,
    'a {type:"minigame", target:"swim_challenge"} step must complete on a finish'
  );
  assert.equal(
    quests.engagements.get('eng-1').stepStates[1]?.done, undefined,
    'and must not touch a step of another type'
  );
  quests.dispose?.();
});

test('a quest step naming the venue label by token run also matches', () => {
  const quests = new QuestSystem({ bus: new EventBus() });
  const event = {
    type: 'minigame',
    target: SWIM_GAME_ID,
    id: SWIM_GAME_ID,
    name: 'Lido Swim Challenge',
  };
  for (const target of ['swim_challenge', 'Lido Swim Challenge', 'swim challenge']) {
    assert.equal(
      quests._matchesStepTarget({ type: 'minigame', target }, { event }), true,
      `a step targeting "${target}" should match the swim challenge`
    );
  }
  // And must not match a contest it does not name.
  assert.equal(
    quests._matchesStepTarget({ type: 'minigame', target: 'ski_downhill' }, { event }), false,
    'a step naming another contest must not be completed by the swim'
  );
  quests.dispose?.();
});
