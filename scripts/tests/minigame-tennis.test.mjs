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
  createTennisMatch,
  TennisScore,
  rivalOdds,
  TENNIS_GAME_ID,
  COURT,
  TUNING,
} from '../../src/minigames/TennisMatch.js';
import { TennisPose } from '../../src/minigames/TennisPose.js';

/**
 * The tennis match, end to end, and the framework under it.
 *
 * Same discipline as minigame-swim.test.mjs, for the same reason: this project
 * has shipped four defects where a test proved a thing was BUILT and never that
 * a player could REACH it. So the geometry gate below does not check that the
 * tennis venue exists - it reads the slab, the collider and the net out of
 * SportsWorld's source and asserts that both baselines of the module's course
 * are on walkable slab, inside the venue trigger, on opposite sides of a net
 * the ball's lowest arc still clears.
 *
 * The lifecycle gates run the real manager and the real game module against a
 * scripted player, a scripted Deborah and a scripted rng, at the engine's own
 * fixed step, and assert the things the user asked for by name: best of 3
 * games, 10 credits for a win, a quit that pays nothing - plus the two things
 * this module must never get wrong: the winner chance cap, and giving Deborah
 * back exactly as she was found.
 */

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const SRC = nodePath.resolve(HERE, '../../src');
const STEP = 1 / 60;

/** The venue as the integration spec has SportsWorld publish it. */
const COURT_VENUE = {
  id: 'meridian_court',
  kind: 'tennis',
  label: 'Meridian Tennis Match',
  centre: { x: 112, y: 0, z: 26 },
  radius: 22,
  yTolerance: 6,
  reward: 10,
  config: {
    centreX: 112,
    netZ: 26,
    baselineS: 37.9,
    baselineN: 14.1,
    halfWidth: 4.115,
  },
  rival: { name: 'Deborah Quint-Halloway' },
};

function makeDeborah() {
  return {
    name: 'Deborah Quint-Halloway',
    isDead: false,
    position: { x: 90, y: 0, z: 26 },
    state: 'WANDER',
    desiredSpeed: 1.5,
    faceOverride: null,
    _lookTarget: null,
    talkPartner: null,
    talkTimer: 0,
    humanoid: null,
    nav: {
      targets: [],
      cleared: 0,
      setTarget(v) {
        this.targets.push({ x: v.x, z: v.z });
      },
      setTargetIfNew(v) {
        const last = this.targets[this.targets.length - 1];
        if (!last || Math.abs(last.x - v.x) > 0.01 || Math.abs(last.z - v.z) > 0.01) {
          this.targets.push({ x: v.x, z: v.z });
        }
      },
      clear() {
        this.cleared += 1;
      },
    },
    setState(s) {
      this.state = s;
    },
  };
}

/**
 * The rig: real manager, real module, fake court-side world. `rngDefault`
 * scripts Deborah - 0.5 means she returns (0.5 < 0.95) and never hits a
 * winner (0.5 > 0.15 cap); 0.99 means she misses every return (0.99 > 0.95).
 */
function makeRig({ withNpc = true, rngDefault = 0.5, rngQueue = [], withBody = false } = {}) {
  const bus = new EventBus();
  const economy = new Economy({ bus });
  const player = { position: { x: 0, y: 0, z: 0 } };
  if (withBody) {
    /* The prop surfaces the module drives, modelled on the REAL contract:
     * `player.scene` (the ball and trail parent), `player.avatar` with a
     * `humanoid.weaponMount`, a carried `_weapon` whose `.visible` the match
     * must override, `_editMaterials` (the shadow-only bookkeeping route the
     * real PlayerAvatar requires for anything added to its subtree), and
     * `player.weapon.setVisible` (the first-person viewmodel, re-asserted
     * visible per frame by Loadout/Player in the real game). */
    player.scene = new THREE.Object3D();
    player.isThirdPerson = false;
    player.avatar = {
      humanoid: { weaponMount: new THREE.Object3D() },
      _weapon: { visible: true },
      previewing: false,
      editCalls: 0,
      _editMaterials(fn) {
        this.editCalls += 1;
        fn();
      },
    };
    player.weapon = {
      visible: true,
      setVisible(v) {
        this.visible = !!v;
      },
    };
  }
  const keys = new Set();
  /* `held` mirrors the real Input.held(): true while the key is in the down
   * set. The match's frame hook edge-detects on held() rather than pressed()
   * because in the real game main.js's boot-registered frame callback calls
   * input.endFrame() BEFORE later-registered hooks run, so pressed() is
   * always false there — a divergence this fake originally hid, which is how
   * an unwinnable tennis match shipped through 18 green tests. */
  const input = { pressed: (code) => keys.has(code), held: (code) => keys.has(code) };

  // A fake engine whose frame updaters the frame() helper pumps, in insertion
  // order, exactly as Engine iterates its Set.
  const frameFns = new Set();
  const engine = {
    onFrameUpdate(fn) {
      frameFns.add(fn);
      return () => frameFns.delete(fn);
    },
  };

  const deborah = withNpc ? makeDeborah() : null;
  const npcs = { friendlies: deborah ? [deborah] : [] };
  const rng = () => (rngQueue.length ? rngQueue.shift() : rngDefault);

  const mg = new MinigameManager({ bus, player, economy, input });
  // The exact wiring shape from the integration spec: the closure is what
  // hands the module the NPC manager and the engine; the framework never does.
  mg.registerGame('tennis', (venue, ctx) => createTennisMatch(venue, { ...ctx, npcs, engine, rng }));

  const seen = [];
  for (const type of [
    'minigame:prompt', 'minigame:countdown', 'minigame:started', 'minigame:event',
    'minigame:finished', 'minigame:aborted', 'minigame:armed',
    'quest:activity', 'hud:notify',
  ]) {
    bus.on(type, (e) => seen.push({ type, e }));
  }

  bus.emit('world:changed', { id: 'sports', world: { minigameVenues: [COURT_VENUE] } });
  return { bus, economy, player, keys, input, mg, seen, deborah, frameFns };
}

/** One frame in main.js's order: manager poll, frame updaters, fixed step. */
function frame(rig) {
  rig.mg.update(STEP);
  for (const fn of rig.frameFns) fn(STEP);
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

/** Press E for exactly one manager poll, as the swim suite does. */
function pressE(rig) {
  rig.keys.add('KeyE');
  rig.mg.update(STEP);
  rig.keys.delete('KeyE');
}

/** Press the swing key for exactly one frame. */
function pressSwing(rig) {
  rig.keys.add('KeyF');
  frame(rig);
  rig.keys.delete('KeyF');
}

/** Run frames until `cond` or `maxSeconds` of simulated time. @returns seconds */
function runUntil(rig, cond, maxSeconds = 60) {
  let t = 0;
  while (t < maxSeconds) {
    frame(rig);
    t += STEP;
    if (cond()) return t;
  }
  return -1;
}

/** IDLE -> PLAYING with Deborah walked onto her baseline. */
function beginMatch(rig) {
  place(rig, 112, 0.2, 30);
  pressE(rig);
  assert.equal(rig.mg.state, MINIGAME_STATE.COUNTDOWN, 'E at the court should start the countdown');
  frames(rig, 6); // the module asks for a 5 s "take your ends"
  assert.equal(rig.mg.state, MINIGAME_STATE.PLAYING, 'the countdown should expire into play');
  if (rig.deborah) {
    rig.deborah.position.x = 112;
    rig.deborah.position.z = 14.1;
  }
  assert.ok(
    runUntil(rig, () => rig.mg._game?._phase === 'serve', 10) >= 0,
    'with Deborah on her mark, the walk-on should yield to the first serve'
  );
}

/** Run to the next inbound ball. */
function toIncoming(rig) {
  assert.ok(
    runUntil(rig, () => rig.mg._game?._phase === 'toPlayer', 10) >= 0,
    'a rival-serve point should put a ball in the air toward the player'
  );
  return rig.mg._game;
}

/* ------------------------------------------------------------------ */
/* Scoring: the pure rules, every named transition                     */
/* ------------------------------------------------------------------ */

test('points climb 0-15-30-40 and four straight points take the game', () => {
  const s = new TennisScore(2);
  assert.equal(s.pointsText(), '0-0');
  assert.equal(s.gameNumber, 1);

  s.pointTo('player');
  assert.equal(s.pointsText(), '15-0');
  s.pointTo('rival');
  assert.equal(s.pointsText(), '15-15');
  s.pointTo('player');
  assert.equal(s.pointsText(), '30-15');
  s.pointTo('player');
  assert.equal(s.pointsText(), '40-15');
  const game = s.pointTo('player');
  assert.equal(game, 'player', 'the fourth point with a two-point lead is the game');
  assert.equal(s.gamesText(), '1-0');
  assert.equal(s.pointsText(), '0-0', 'points reset for the next game');
  assert.equal(s.gameNumber, 2);
});

test('deuce goes to advantage, back to deuce, and needs two clear points', () => {
  const s = new TennisScore(2);
  for (let i = 0; i < 3; i++) {
    s.pointTo('player');
    s.pointTo('rival');
  }
  assert.equal(s.pointsText(), '40-40', 'three points each is deuce');

  assert.equal(s.pointTo('player'), null, 'a point from deuce is not the game');
  assert.equal(s.pointsText(), 'A-40');
  assert.equal(s.pointTo('rival'), null, 'advantage lost is deuce again');
  assert.equal(s.pointsText(), '40-40');
  assert.equal(s.pointTo('rival'), null);
  assert.equal(s.pointsText(), '40-A');
  assert.equal(s.pointTo('rival'), 'rival', 'two clear from deuce is the game');
  assert.equal(s.gamesText(), '0-1');
});

test('the match is best of three games and ends the moment someone has two', () => {
  const winGame = (s, who) => {
    for (let i = 0; i < 4; i++) s.pointTo(who);
  };

  const sweep = new TennisScore(2);
  winGame(sweep, 'player');
  assert.equal(sweep.matchWinner, null, 'one game is not the match');
  winGame(sweep, 'player');
  assert.equal(sweep.matchWinner, 'player', 'two games is');
  assert.equal(sweep.pointTo('rival'), null, 'a decided match takes no more points');

  const decider = new TennisScore(2);
  winGame(decider, 'player');
  winGame(decider, 'rival');
  assert.equal(decider.matchWinner, null, '1-1 goes to a third game');
  assert.equal(decider.gameNumber, 3);
  winGame(decider, 'rival');
  assert.equal(decider.matchWinner, 'rival');
  assert.equal(decider.gamesText(), '1-2');
});

/* ------------------------------------------------------------------ */
/* The rally odds: capped, bounded, decaying                           */
/* ------------------------------------------------------------------ */

test('the winner chance never exceeds the cap, at any rally length', () => {
  let prevReturn = Infinity;
  let prevWinner = -Infinity;
  for (let e = 0; e <= 1000; e++) {
    const { pReturn, pWinner } = rivalOdds(e);
    assert.ok(pWinner <= TUNING.WINNER_CAP + 1e-12,
      `winner chance ${pWinner} at exchange ${e} breaks the ${TUNING.WINNER_CAP} cap`);
    assert.ok(pWinner >= 0 && pWinner <= 0.15 + 1e-12, 'and the cap itself must stay ~15%');
    assert.ok(pReturn > 0 && pReturn <= TUNING.RETURN_START, 'return chance must stay a probability');
    assert.ok(pReturn >= TUNING.RETURN_FLOOR - 1e-12, 'and above its floor');
    assert.ok(pReturn <= prevReturn + 1e-12, 'return chance must decay, so rallies end naturally');
    assert.ok(pWinner >= prevWinner - 1e-12, 'winner chance must never decrease before its cap');
    prevReturn = pReturn;
    prevWinner = pWinner;
  }
  assert.ok(rivalOdds(0).pReturn > 0.9, 'the first exchange must be very likely to come back');
});

/* ------------------------------------------------------------------ */
/* Tuning: winnable by a first-time player                             */
/* ------------------------------------------------------------------ */

test('the swing window opens before the ball crosses the net', () => {
  /* The instruction a first-time player infers from "SWING — PRESS F" is
   * "press it about when the ball comes over the net". That press must land
   * inside the window, so WINDOW_OPEN is bounded by the net-crossing fraction
   * of the SHORTEST incoming flight - the serve, struck from the baseline
   * itself (a mid-rally return starts at baseN + 0.4, which crosses later). */
  const from = COURT.baseN;
  const to = COURT.baseS - 0.5;
  const uNet = (COURT.netZ - from) / (to - from);
  assert.ok(TUNING.WINDOW_OPEN <= uNet,
    `WINDOW_OPEN ${TUNING.WINDOW_OPEN} must not be after the net crossing at u=${uNet.toFixed(3)}`);
});

test('the window is long enough, and flights slow enough, to be human', () => {
  // The worst case is the fastest ball: even then the window must give a
  // first-time player the better part of a second.
  const worst = (1 - TUNING.WINDOW_OPEN) * TUNING.FLIGHT_MIN_S;
  const best = (1 - TUNING.WINDOW_OPEN) * TUNING.FLIGHT_MAX_S;
  assert.ok(worst >= 0.8, `shortest window ${worst.toFixed(2)}s must be >= 0.8s`);
  assert.ok(best <= 1.5, `longest window ${best.toFixed(2)}s should stay a timing game, not a formality`);
  // Flights were slowed from 1.2-1.6s (untrackable, per the user) - keep them
  // in the legible band without turning the rally into a lob-fest.
  assert.ok(TUNING.FLIGHT_MIN_S >= 1.5 && TUNING.FLIGHT_MAX_S <= 2.5,
    'crossing times must stay in the slowed, trackable band');
});

test('rallies resolve: Deborah is more likely to miss than return by her 5th', () => {
  assert.ok(rivalOdds(5).pReturn < 0.5,
    'a player who keeps making the window must be paid within ~5 exchanges');
  assert.ok(TUNING.WINNER_CAP <= 0.15, 'the winner cap must hold at <= 0.15');
});

/* ------------------------------------------------------------------ */
/* Geometry: can this course actually be played on this court?         */
/* ------------------------------------------------------------------ */

test('both baselines sit on walkable slab, inside the venue, either side of a cleared net', async () => {
  const src = await readFile(nodePath.join(SRC, 'worlds/SportsWorld.js'), 'utf8');

  // The slab, read off the court builder rather than restated here.
  const slab = /this\._slab\(([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+), 0\.07, this\._materials\.get\('court\.tennis'\)\)/.exec(src);
  assert.ok(slab, 'SportsWorld._buildCourts should still lay the tennis slab');
  const [sx0, sz0, sx1, sz1] = slab.slice(1, 5).map(Number);

  // Its collider - the surface the player actually stands on.
  const box = /this\.physics\.addBox\(112, (-?[\d.]+), 26, ([\d.]+), ([\d.]+), ([\d.]+), \{\}\)/.exec(src);
  assert.ok(box, 'the tennis slab should still carry its collider');
  const [boxY, boxHx, boxHy, boxHz] = box.slice(1, 5).map(Number);

  // The net, with its true post and centre-sag heights.
  const net = /this\._buildNet\(([\d.]+), ([\d.]+), ([\d.]+), true, ([\d.]+), ([\d.]+), ([\d.]+)\)/.exec(src);
  assert.ok(net, 'the tennis net should still be built at full size');
  const [netX, netZ, netW, hPost] = net.slice(1, 5).map(Number);

  const { cx, baseS, baseN, halfW } = COURT;

  // Both baselines on the slab, with the full singles width beside them.
  for (const bz of [baseS, baseN]) {
    assert.ok(bz > sz0 && bz < sz1, `baseline z=${bz} must be on the slab z ${sz0}..${sz1}`);
    assert.ok(Math.abs(bz - 26) < boxHz, `baseline z=${bz} must be over the collider`);
  }
  assert.ok(cx - halfW > sx0 && cx + halfW < sx1, 'the singles width must fit on the slab');
  assert.ok(boxY + boxHy > -0.1 && boxY + boxHy < 0.2,
    'the collider top must be at deck level, or the baselines are not standable');

  // The net divides the course: one baseline each side, court centred on it.
  assert.equal(netX, cx, 'the course must be centred on the net');
  assert.ok(baseN < netZ && netZ < baseS, 'the baselines must bracket the net');
  assert.ok(netW / 2 > halfW, 'the net must span the full singles width');
  // The ball's LOWEST arc adds ARC_MIN above chest height at the apex; ARC_MIN
  // alone exceeding the post height proves every flight clears the cord.
  assert.ok(TUNING.ARC_MIN > hPost,
    `the minimum arc (+${TUNING.ARC_MIN} m) must clear the ${hPost} m net posts`);

  // The venue trigger, as published: both baselines inside it.
  const block = src.slice(src.indexOf("id: 'meridian_court'"));
  assert.ok(block.length > 0, 'SportsWorld should publish the tennis venue');
  assert.match(block.slice(0, 600), /kind: 'tennis'/);
  assert.match(block.slice(0, 600), /rival: \{ name: 'Deborah Quint-Halloway' \}/);
  const radius = Number(/radius: (\d+)/.exec(block.slice(0, 600))?.[1]);
  assert.ok(Number.isFinite(radius), 'the venue should declare its radius');
  for (const bz of [baseS, baseN]) {
    assert.ok(Math.hypot(0, bz - netZ) < radius,
      `baseline z=${bz} must be inside the ${radius} m venue trigger, or play there aborts the match`);
  }
});

test('Deborah exists, patrols the courts, and is the venue rival by exact name', async () => {
  const src = await readFile(nodePath.join(SRC, 'worlds/SportsWorld.js'), 'utf8');
  assert.match(src, /name: 'Deborah Quint-Halloway'/, 'the opponent must exist to be borrowed');
  assert.match(src, /type: 'friendly',\s*\n\s*name: 'Deborah Quint-Halloway'/,
    'and be a FriendlyNPC, which is the class the _minigameLock diff patches');
});

/* ------------------------------------------------------------------ */
/* Start: placement and the borrowed opponent                          */
/* ------------------------------------------------------------------ */

test('starting places the player on the south baseline and drives Deborah north', () => {
  const rig = makeRig();
  place(rig, 112, 0.2, 30);
  pressE(rig);
  assert.equal(rig.mg.state, MINIGAME_STATE.COUNTDOWN);

  assert.equal(rig.player.position.x, COURT.cx, 'the player must be put on the centre mark');
  assert.ok(Math.abs(rig.player.position.z - (COURT.baseS + 0.6)) < 0.01,
    'behind the south baseline');

  const deb = rig.deborah;
  assert.equal(deb._minigameLock, true, 'her think loop must be locked from the first frame');
  assert.ok(deb.desiredSpeed > 4, 'and she should be sent at a run, not a stroll');
  const target = deb.nav.targets[deb.nav.targets.length - 1];
  assert.ok(target, 'she must be given somewhere to go during the countdown');
  assert.ok(Math.abs(target.z - COURT.baseN) < 0.5 && Math.abs(target.x - COURT.cx) < 0.5,
    `her walk-on target (${target.x}, ${target.z}) must be the north baseline centre`);
});

test('play waits on her walk-on, then opens with a serve', () => {
  const rig = makeRig();
  place(rig, 112, 0.2, 30);
  pressE(rig);
  frames(rig, 6);
  assert.equal(rig.mg.state, MINIGAME_STATE.PLAYING);
  assert.equal(rig.mg._game._phase, 'walkon', 'no ball until she is on her mark');

  rig.deborah.position.x = 112;
  rig.deborah.position.z = 14.1;
  assert.ok(runUntil(rig, () => rig.mg._game._phase === 'serve', 5) >= 0,
    'her arrival should start play');
});

/* ------------------------------------------------------------------ */
/* The timing window                                                   */
/* ------------------------------------------------------------------ */

test('not swinging at an inbound ball loses the point as a miss', () => {
  const rig = makeRig();
  beginMatch(rig);
  const game = toIncoming(rig);

  assert.ok(runUntil(rig, () => game._phase === 'point', 5) >= 0, 'the flight must land');
  assert.deepEqual(game.lastPoint, { to: 'rival', why: 'miss' });
  assert.equal(game.score.pointsText(), '0-15');
});

test('swinging before the window opens is a committed early miss', () => {
  const rig = makeRig();
  beginMatch(rig);
  const game = toIncoming(rig);

  frames(rig, 0.3); // well before WINDOW_OPEN (0.45 of a >=1.6 s flight)
  assert.equal(game.windowOpen, false, 'the window must not be open this early');
  pressSwing(rig);
  assert.equal(game._phase, 'toPlayer', 'an early swing does not return the ball');

  // A second, well-timed press must not rescue a committed swing.
  runUntil(rig, () => game._flight && game._flight.t / game._flight.T >= TUNING.WINDOW_OPEN, 5);
  pressSwing(rig);
  assert.equal(game._phase, 'toPlayer', 'one swing per ball - the early one was it');

  runUntil(rig, () => game._phase === 'point', 5);
  assert.deepEqual(game.lastPoint, { to: 'rival', why: 'early' });
});

test('swinging inside the window returns the ball and the rally continues', () => {
  const rig = makeRig();
  beginMatch(rig);
  const game = toIncoming(rig);

  assert.ok(
    runUntil(rig, () => game.windowOpen, 5) >= 0,
    'the window must open before the ball lands'
  );
  pressSwing(rig);
  assert.equal(game._phase, 'toNpc', 'a windowed swing sends the ball back');
  assert.equal(game.lastPoint, null, 'and concedes nothing');
});

test('a winner opens no window and takes the point regardless of the swing', () => {
  const rig = makeRig();
  beginMatch(rig);
  const game = toIncoming(rig);

  // Force the flag the odds roll would set - the roll itself is covered by the
  // rivalOdds sweep; this gate is about what the flag DOES.
  game._flight.winner = true;
  runUntil(rig, () => game._flight.t / game._flight.T >= TUNING.WINDOW_OPEN + 0.05, 5);
  assert.equal(game.windowOpen, false, 'a winner must never open the window');
  pressSwing(rig);
  assert.equal(game._phase, 'toPlayer', 'no swing returns a winner');

  runUntil(rig, () => game._phase === 'point', 5);
  assert.deepEqual(game.lastPoint, { to: 'rival', why: 'winner' });
});

/* ------------------------------------------------------------------ */
/* Whole matches                                                       */
/* ------------------------------------------------------------------ */

test('winning the match 2-0 pays exactly 10 credits and frees Deborah', () => {
  // 0.99: every return roll fails (0.99 > 0.95), so each clean player return
  // ends the exchange her way - two 4-0 games for a player who makes every window.
  const rig = makeRig({ rngDefault: 0.99 });
  beginMatch(rig);
  assert.equal(rig.economy.credits, 0);
  assert.equal(rig.frameFns.size, 1, 'the match should be holding one late-frame hook');

  let t = 0;
  while (rig.mg.state !== MINIGAME_STATE.FINISHED && t < 240) {
    const g = rig.mg._game;
    if (g && g.windowOpen) pressSwing(rig);
    else frame(rig);
    t += STEP;
  }
  assert.equal(rig.mg.state, MINIGAME_STATE.FINISHED, 'making every window must win inside the time limit');

  const fin = rig.seen.find((s) => s.type === 'minigame:finished')?.e;
  assert.ok(fin, 'a finish must be announced');
  assert.equal(fin.won, true);
  assert.equal(fin.place, 1);
  assert.equal(fin.score, '2-0', 'a clean sweep is two games to love');
  assert.equal(fin.credits, MINIGAME_PRIZE);
  assert.equal(fin.credits, 10, 'the user asked for ten credits, in those words');
  assert.equal(rig.economy.credits, 10, 'and the wallet has to actually contain them');
  assert.equal(fin.rivalName, 'Deborah Quint-Halloway');

  const act = rig.seen.find((s) => s.type === 'quest:activity')?.e;
  assert.ok(act, 'a finished match must credit quests');
  assert.equal(act.target, TENNIS_GAME_ID);
  assert.equal(act.won, true);

  /* The self-clean gate: the manager only disposes on ABORTS - a finished
   * match is reset(), never disposed - so the module must have freed
   * everything itself the moment the outcome was returned. */
  const deb = rig.deborah;
  assert.equal(deb._minigameLock, false, 'her think loop must be hers again');
  assert.equal(deb.state, 'IDLE', 'reset to IDLE, whose wander pick resumes her patrol');
  assert.equal(deb.faceOverride, null);
  assert.equal(deb._lookTarget, null);
  assert.equal(deb.desiredSpeed, 1.5, 'her pace must be restored to what it was');
  assert.equal(rig.frameFns.size, 0, 'the late-frame hook must be released');
});

test('never swinging loses the match and pays the participation floor', () => {
  const rig = makeRig(); // 0.5: she returns everything she reaches, no winners
  beginMatch(rig);

  let t = 0;
  while (rig.mg.state !== MINIGAME_STATE.FINISHED && t < 240) {
    frame(rig);
    t += STEP;
  }
  assert.equal(rig.mg.state, MINIGAME_STATE.FINISHED);
  const fin = rig.seen.find((s) => s.type === 'minigame:finished')?.e;
  assert.equal(fin.won, false);
  /* A COMPLETED loss pays the participation floor; an abandoned one still pays
   * nothing (see the teardown tests below). See
   * `2026-08-23-mission-architecture.md` §8 and `consolationFor`. */
  const floor = consolationFor(rig.mg._venue);
  assert.ok(floor > 0 && floor < (rig.mg._venue?.reward ?? MINIGAME_PRIZE));
  assert.equal(fin.credits, floor);
  assert.equal(rig.economy.credits, floor, 'a completed loss paid the wrong floor');
  assert.equal(fin.score, '0-2');
  assert.equal(rig.deborah._minigameLock, false, 'a loss frees her exactly like a win');
});

/* ------------------------------------------------------------------ */
/* Teardown: every exit gives Deborah back                             */
/* ------------------------------------------------------------------ */

test('quitting mid-match pays nothing, credits no quest, and restores Deborah', () => {
  const rig = makeRig();
  beginMatch(rig);
  const deb = rig.deborah;
  assert.equal(deb._minigameLock, true);

  rig.mg.abort('player');
  assert.equal(rig.mg.state, MINIGAME_STATE.IDLE);
  assert.equal(rig.economy.credits, 0, 'an abandoned match pays nothing');
  assert.equal(rig.seen.filter((s) => s.type === 'quest:activity').length, 0,
    'walking out is not completing');
  assert.equal(rig.seen.filter((s) => s.type === 'minigame:finished').length, 0);

  assert.equal(deb._minigameLock, false, 'the lock must not outlive the match');
  assert.equal(deb.state, 'IDLE');
  assert.equal(deb.faceOverride, null);
  assert.equal(deb._lookTarget, null);
  assert.equal(deb.desiredSpeed, 1.5);
  assert.ok(deb.nav.cleared > 0, 'her borrowed destination must be dropped');
  assert.equal(rig.frameFns.size, 0, 'the late-frame hook must be released');
});

test('leaving the world mid-match tears down and restores Deborah', () => {
  const rig = makeRig();
  beginMatch(rig);
  rig.bus.emit('world:changing', { to: 'maze' });
  assert.equal(rig.mg.state, MINIGAME_STATE.IDLE);
  assert.equal(rig.economy.credits, 0);
  assert.equal(rig.deborah._minigameLock, false);
  assert.equal(rig.frameFns.size, 0);
});

test('a court with no Deborah in the world still plays a full contest', () => {
  // The module must degrade to a rally against an unbodied opponent rather
  // than refuse to start - the same posture SwimChallenge takes to having no
  // swimmer NPC at all.
  const rig = makeRig({ withNpc: false, rngDefault: 0.99 });
  place(rig, 112, 0.2, 30);
  pressE(rig);
  assert.equal(rig.mg.state, MINIGAME_STATE.COUNTDOWN, 'no NPC must not mean no contest');
  frames(rig, 6);
  assert.equal(rig.mg.state, MINIGAME_STATE.PLAYING);
  assert.ok(runUntil(rig, () => rig.mg._game?._phase === 'serve', 10) >= 0,
    'the walk-on must not wait forever for an opponent who does not exist');
});

/* ------------------------------------------------------------------ */
/* The pose modules                                                    */
/* ------------------------------------------------------------------ */

test('TennisPose writes the swing onto the bones, and only during a swing', () => {
  let writes = 0;
  const bone = { quaternion: { slerp: () => { writes += 1; } } };
  const bones = new Map([
    ['upperArmR', bone], ['foreArmR', bone], ['spine02', bone], ['head', bone],
  ]);
  const player = { avatar: { humanoid: { bones } } };

  const midSwing = { _game: { id: TENNIS_GAME_ID, playerSwingAge: TUNING.SWING_S * 0.5 } };
  new TennisPose({ player, minigames: midSwing }).applyPose(STEP, 0);
  assert.ok(writes > 0, 'mid-swing, the arc must actually write bones');

  writes = 0;
  const idle = { _game: { id: TENNIS_GAME_ID, playerSwingAge: TUNING.SWING_S * 4 } };
  new TennisPose({ player, minigames: idle }).applyPose(STEP, 0);
  assert.equal(writes, 0, 'a finished swing must write nothing');

  writes = 0;
  const otherGame = { _game: { id: 'swim_challenge', playerSwingAge: 0.1 } };
  new TennisPose({ player, minigames: otherGame }).applyPose(STEP, 0);
  assert.equal(writes, 0, 'another sport\'s module must be left alone');

  assert.doesNotThrow(() => new TennisPose({}).applyPose(STEP, 0),
    'a harness with no avatar and no manager must not throw');
});

/* ------------------------------------------------------------------ */
/* The ball the user can see, and the trail behind it                  */
/* ------------------------------------------------------------------ */

test('the match ball is the big unlit one, towed by a pooled fading trail', () => {
  const rig = makeRig({ withBody: true });
  beginMatch(rig);
  const game = rig.mg._game;

  const ball = game._ball;
  assert.ok(ball, 'a player with a scene must get a visible ball');
  assert.equal(ball.geometry.parameters.radius, TUNING.BALL_RADIUS);
  assert.ok(TUNING.BALL_RADIUS >= 0.06,
    'the readability fix: the match ball must stay ~2x the 0.033 hopper ball');
  assert.equal(ball.material.isMeshBasicMaterial, true,
    'unlit, so it is full-bright tennis yellow at any sun angle');

  assert.equal(game._trail.length, TUNING.TRAIL_COUNT, 'the trail pool is built up front');
  for (let i = 1; i < game._trail.length; i++) {
    assert.ok(game._trail[i].material.opacity < game._trail[i - 1].material.opacity,
      'followers must fade toward the tail');
    assert.equal(game._trail[i].geometry, ball.geometry, 'followers share the ball geometry');
  }

  toIncoming(rig);
  frame(rig);
  assert.equal(game._trail[0].visible, true, 'the comet must show while a ball flies');

  runUntil(rig, () => game._phase === 'point', 5);
  frame(rig);
  assert.equal(game._ball.visible, false);
  assert.equal(game._trail[0].visible, false, 'and hide between points');

  rig.mg.abort('player');
  assert.equal(rig.player.scene.children.length, 0,
    'dispose must sweep the ball and every trail sphere out of the scene');
});

/* ------------------------------------------------------------------ */
/* The racket replaces the gun - for exactly the length of the match   */
/* ------------------------------------------------------------------ */

test('starting stows the firearm and puts a racket in both hands', () => {
  const rig = makeRig({ withBody: true });
  rig.deborah.humanoid = { weaponMount: new THREE.Object3D() };
  place(rig, 112, 0.2, 30);
  pressE(rig);

  const avatar = rig.player.avatar;
  const mount = avatar.humanoid.weaponMount;
  assert.equal(mount.children.length, 1, 'the racket must hang on the weapon mount');
  assert.equal(mount.children[0].name, 'racketProp');
  assert.ok(avatar.editCalls >= 1,
    'the racket must be added through _editMaterials, or first person draws it disembodied');
  assert.equal(avatar._weapon.visible, false, 'the carried carbine must be hidden');
  assert.equal(rig.player.weapon.visible, false, 'and the first-person viewmodel with it');
  assert.equal(rig.deborah.humanoid.weaponMount.children.length, 1,
    'Deborah gets a racket on her own weaponMount');
});

test('the frame hook re-hides the gun after its owners re-show it, and survives a wardrobe swap', () => {
  const rig = makeRig({ withBody: true });
  place(rig, 112, 0.2, 30);
  pressE(rig);
  const avatar = rig.player.avatar;

  /* Loadout.update and Player._driveWeapon re-assert viewmodel visibility
   * EVERY frame, and the F2 preview writes avatar._weapon.visible directly.
   * The match's late-registered hook runs after all of them, so the last
   * write before render must be the hide. */
  rig.player.weapon.visible = true;
  avatar._weapon.visible = true;
  frame(rig);
  assert.equal(rig.player.weapon.visible, false, 'the late hook must win the frame');
  assert.equal(avatar._weapon.visible, false);

  // The wardrobe's _rebuildBody: a NEW humanoid, a NEW visible carbine, and
  // the old mount (racket aboard) disposed out from under the match.
  avatar.humanoid = { weaponMount: new THREE.Object3D() };
  avatar._weapon = { visible: true };
  frame(rig);
  assert.equal(avatar.humanoid.weaponMount.children.length, 1,
    'the racket must follow the player onto the rebuilt body');
  assert.equal(avatar._weapon.visible, false, 'and the rebuilt carbine must be re-hidden');
});

test('every exit gives the firearm back: quit, and a win that self-disposes', () => {
  const quitRig = makeRig({ withBody: true });
  quitRig.deborah.humanoid = { weaponMount: new THREE.Object3D() };
  place(quitRig, 112, 0.2, 30);
  pressE(quitRig);
  quitRig.mg.abort('player');
  const qa = quitRig.player.avatar;
  assert.equal(qa.humanoid.weaponMount.children.length, 0, 'quit must take the racket away');
  assert.equal(qa._weapon.visible, true, 'and hand the carbine back exactly as found');
  assert.equal(quitRig.player.weapon.visible, true);
  assert.equal(quitRig.deborah.humanoid.weaponMount.children.length, 0,
    'Deborah hands hers back too');

  // A FINISHED match is reset(), never disposed, by the manager - the module
  // must have restored the loadout itself the moment the outcome returned.
  const winRig = makeRig({ withBody: true, rngDefault: 0.99 });
  beginMatch(winRig);
  let t = 0;
  while (winRig.mg.state !== MINIGAME_STATE.FINISHED && t < 240) {
    const g = winRig.mg._game;
    if (g && g.windowOpen) pressSwing(winRig);
    else frame(winRig);
    t += STEP;
  }
  assert.equal(winRig.mg.state, MINIGAME_STATE.FINISHED);
  assert.equal(winRig.seen.find((s) => s.type === 'minigame:finished')?.e?.won, true);
  const wa = winRig.player.avatar;
  assert.equal(wa.humanoid.weaponMount.children.length, 0, 'a win must sweep the racket');
  assert.equal(wa._weapon.visible, true, 'and restore the carbine without the manager\'s help');
  assert.equal(winRig.player.scene.children.length, 0, 'ball and trail gone with it');
});
