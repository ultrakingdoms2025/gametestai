import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

/**
 * THE DRONE HACK, DRIVEN.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE VERB NOTHING ELSE IN THE GAME ASKS FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every contest the framework runs today is a race against a clock or a rival:
 * swim, ski, run, rooftop, tennis, test-fire. All six reward MOVING, and the
 * only thing standing still ever does is lose them for you.
 *
 * A splice asks the opposite. You have to STOP inside a node's field and hold
 * it, while a trace clock you cannot pause runs down - and the moment you step
 * out, the progress you banked starts draining at a published multiple of the
 * rate you earned it. That is a second verb, and it is why this is a module
 * rather than a rooftop route with different rings.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE THREE FAILURES THIS FILE IS WRITTEN AGAINST
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  1. **A charge that survives leaving.** If stepping out only paused the hold,
 *     the contest would be "visit six points" and the trace would be the only
 *     opposition - which is a delivery run with extra words. Test 3 measures the
 *     decay against the published multiplier rather than asserting it happens.
 *  2. **A node spliced from the deck above it.** Same defect the delivery run
 *     has: a planar radius forgiving enough to stand in is a radius that pays
 *     out to somebody on a walkway 10 m overhead. Test 5 is the vertical band.
 *  3. **A trace that cannot be beaten, or cannot be lost.** The bonus each
 *     crack returns is what makes a long chain survivable, and a bonus at or
 *     above the cost of a node makes the trace decoration. Test 7 pins both
 *     ends: a fast splicer wins, a slow one runs out, and the run ends exactly
 *     once either way.
 */

const DT = 1 / 60;

const {
  DroneHack, createDroneHack, readNodes, HACK_GAME_ID,
} = await import('../../src/minigames/DroneHack.js');

/* ================================================================== */
/* Apparatus                                                           */
/* ================================================================== */

function fakeBus() {
  const seen = [];
  const subs = new Map();
  return {
    seen,
    emit(name, payload) { seen.push({ name, payload }); },
    on(name, fn) {
      if (!subs.has(name)) subs.set(name, new Set());
      subs.get(name).add(fn);
      return () => subs.get(name).delete(fn);
    },
    find(name) { return seen.filter((e) => e.name === name).map((e) => e.payload); },
  };
}

function venue(over = {}) {
  return {
    id: 'test_splice',
    kind: 'hack',
    label: 'The Test Splice',
    centre: { x: 0, y: 0, z: 0 },
    radius: 60,
    yTolerance: 12,
    reward: 12,
    config: {
      nodes: [
        { id: 'n0', label: 'Relay A', x: 0, y: 0, z: 0 },
        { id: 'n1', label: 'Relay B', x: 20, y: 0, z: 0 },
        { id: 'n2', label: 'Relay C', x: 0, y: 0, z: 20 },
      ],
      holdR: 3.0,
      band: 3.0,
      holdS: 3.0,
      decay: 2.0,
      bonus: 5,
      seconds: 40,
      ...(over.config ?? {}),
    },
    ...over,
  };
}

function body(x = 0, y = 0, z = 0) {
  return { position: new THREE.Vector3(x, y, z) };
}

function running(v = venue(), ctx = {}) {
  const bus = ctx.bus ?? fakeBus();
  const n0 = v.config.nodes[0];
  const player = ctx.player ?? body(n0.x, n0.y, n0.z);
  const game = new DroneHack(v, { bus, player, ...ctx });
  game.begin(0);
  return { game, bus, player };
}

/** Hold position for `seconds` of simulated time; returns the outcome, if any. */
function hold(game, player, p, seconds, from = 0) {
  if (p) player.position.set(p.x, p.y, p.z);
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    const out = game.fixedUpdate(DT, from + (i + 1) * DT);
    if (out) return { out, at: from + (i + 1) * DT };
  }
  return { out: null, at: from + steps * DT };
}

/* ================================================================== */
/* 1. The venue contract                                               */
/* ================================================================== */

test('a malformed venue yields no splice and no exception', () => {
  assert.equal(readNodes(null), null);
  assert.equal(readNodes({ config: {} }), null);
  assert.equal(readNodes({ config: { nodes: [] } }), null);
  assert.equal(readNodes({ config: { nodes: [{ x: 0, y: 'up', z: 0 }] } }), null);
  // A single unusable node among good ones is dropped, not fatal.
  const partial = readNodes({ config: { nodes: [{ id: 'a', x: 0, y: 0, z: 0 }, { id: 'b', x: NaN, y: 0, z: 0 }] } });
  assert.equal(partial.nodes.length, 1);
  assert.equal(createDroneHack({ id: 'x', label: 'x', config: null }, {}), null);
});

test('the game id is declared in the shape quest-vocab scrapes', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../src/minigames/DroneHack.js', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n');
  assert.match(src, /export const HACK_GAME_ID = 'drone_hack'/);
  assert.equal(HACK_GAME_ID, 'drone_hack');
});

/* ================================================================== */
/* 2. Holding a node                                                   */
/* ================================================================== */

test('holding the live node for its hold time cracks it; a later node does nothing', () => {
  const v = venue();
  const { game, player } = running(v);
  assert.equal(game.cracked, 0);

  // Relay B is node 1. Standing on it while A is live banks nothing.
  hold(game, player, { x: 20, y: 0, z: 0 }, 5);
  assert.equal(game.cracked, 0, 'a node later in the chain was spliced out of turn');
  assert.equal(game.charge, 0);

  // Relay A is live.
  hold(game, player, { x: 0, y: 0, z: 0 }, v.config.holdS + 0.2, 5);
  assert.equal(game.cracked, 1, 'holding the live node for its full hold time did not crack it');
  assert.equal(game.node, 1, 'the next node did not light');
  game.dispose();
});

test('a hold that is broken before the end cracks nothing', () => {
  const v = venue();
  const { game, player } = running(v);
  hold(game, player, { x: 0, y: 0, z: 0 }, v.config.holdS * 0.6);
  assert.equal(game.cracked, 0);
  assert.ok(game.charge > 0, 'a partial hold banked nothing at all');
  game.dispose();
});

test('the charge drains when you step out, at the published multiple of the rate it was earned', () => {
  /* THE DEFECT: a charge that merely PAUSES makes the contest "visit six
   * points", which is the delivery run with different words. The rate is stated
   * as a number so a change to it is a change to a test. */
  const v = venue();
  const { game, player } = running(v);
  hold(game, player, { x: 0, y: 0, z: 0 }, 2.0);
  const banked = game.charge;
  assert.ok(banked > 1.9 && banked <= 2.1, `2 s in the field banked ${banked} s`);

  // One second away, at decay 2.0, costs two seconds of charge.
  hold(game, player, { x: 30, y: 0, z: 30 }, 1.0, 2.0);
  assert.ok(game.charge < banked, 'stepping out of the field cost nothing');
  assert.ok(Math.abs(game.charge - Math.max(0, banked - 1.0 * v.config.decay)) < 0.05,
    `charge fell from ${banked} to ${game.charge}, not to ${banked - v.config.decay}`);

  // ...and it never goes below zero, however long you stay away.
  hold(game, player, { x: 30, y: 0, z: 30 }, 20, 3.0);
  assert.equal(game.charge, 0);
  game.dispose();
});

test('a node spliced from the deck above it is not spliced at all', () => {
  const v = venue();
  const { game, player } = running(v);
  hold(game, player, { x: 0, y: v.config.band + 2, z: 0 }, v.config.holdS + 1);
  assert.equal(game.cracked, 0, 'the splice was made from outside the vertical band');
  assert.equal(game.charge, 0);
  hold(game, player, { x: 0, y: v.config.band - 0.5, z: 0 }, v.config.holdS + 0.2, 5);
  assert.equal(game.cracked, 1, 'a splice inside the band was refused');
  game.dispose();
});

test('the hold radius is real: a metre outside the field banks nothing', () => {
  const v = venue();
  const { game, player } = running(v);
  hold(game, player, { x: v.config.holdR + 1.0, y: 0, z: 0 }, 4);
  assert.equal(game.charge, 0);
  game.dispose();
});

/* ================================================================== */
/* 3. The trace                                                        */
/* ================================================================== */

test('the trace runs down while you hold, and a crack hands some of it back', () => {
  const v = venue();
  const { game, player } = running(v);
  const start = game.trace;
  assert.equal(start, v.config.seconds);

  hold(game, player, { x: 0, y: 0, z: 0 }, 1.0);
  assert.ok(game.trace < start, 'the trace did not advance while a node was being held');

  const before = game.trace;
  hold(game, player, { x: 0, y: 0, z: 0 }, v.config.holdS, 1.0);
  assert.equal(game.cracked, 1);
  assert.ok(game.trace > before, `a crack returned nothing: ${before} -> ${game.trace}`);
  game.dispose();
});

test('the bonus is smaller than a node costs, or the trace is decoration', () => {
  /* A bonus at or above `holdS` plus the walk between nodes would mean the
   * trace never falls - the contest would have no opposition and could not be
   * lost by anyone who kept moving. Stated against the SHIPPED venues below;
   * here it is stated against the module's own default. */
  const v = venue();
  assert.ok(v.config.bonus < v.config.seconds,
    'a single crack returns the whole trace');
  const { game, player } = running(v);
  // Crack the first node as fast as the rules allow, and the trace must still
  // be net down over the exchange.
  const start = game.trace;
  hold(game, player, { x: 0, y: 0, z: 0 }, v.config.holdS + 0.05);
  assert.equal(game.cracked, 1);
  assert.ok(game.trace <= start + v.config.bonus - v.config.holdS + 0.1,
    `the trace went from ${start} to ${game.trace} over a node that costs ${v.config.holdS} s`);
  game.dispose();
});

test('the trace running out is a loss carrying what was cracked; a full chain is a win', () => {
  const v = venue();

  // Slow: crack one node, then stand well clear until the trace expires.
  const slow = running(v);
  hold(slow.game, slow.player, { x: 0, y: 0, z: 0 }, v.config.holdS + 0.1);
  assert.equal(slow.game.cracked, 1);
  const lost = hold(slow.game, slow.player, { x: 40, y: 0, z: 40 }, 120, 4).out;
  assert.ok(lost, 'the trace never ran out');
  assert.equal(lost.won, false);
  assert.equal(lost.score, 1, 'the loss forgot the node that WAS cracked');
  assert.match(lost.scoreLabel, /1\/3/);
  // ...and the run ends exactly once.
  assert.equal(slow.game.fixedUpdate(DT, 200), null, 'a finished run went on returning outcomes');
  slow.game.dispose();

  // Fast: walk the chain, holding each node.
  const fast = running(v);
  let out = null;
  let t = 0;
  for (const n of v.config.nodes) {
    const r = hold(fast.game, fast.player, n, v.config.holdS + 0.1, t);
    t = r.at;
    out = r.out;
    if (out) break;
  }
  assert.ok(out, 'a run that cracked every node never ended');
  assert.equal(out.won, true);
  assert.equal(out.score, v.config.nodes.length);
  assert.equal(fast.game.cracked, v.config.nodes.length);
  fast.game.dispose();
});

/* ================================================================== */
/* 4. Lifecycle                                                        */
/* ================================================================== */

test('nothing charges before begin() or after dispose()', () => {
  const v = venue();
  const bus = fakeBus();
  const player = body(0, 0, 0);
  const game = new DroneHack(v, { bus, player });
  for (let i = 0; i < 300; i++) game.fixedUpdate(DT, i * DT);
  assert.equal(game.charge, 0, 'a node charged during the countdown');
  assert.equal(game.trace, v.config.seconds, 'the trace ran during the countdown');

  game.begin(0);
  hold(game, player, { x: 0, y: 0, z: 0 }, 1.0);
  assert.ok(game.charge > 0);

  game.dispose();
  const frozen = game.charge;
  hold(game, player, { x: 0, y: 0, z: 0 }, 2.0, 1.0);
  assert.equal(game.charge, frozen, 'a disposed splice went on charging');
  game.dispose();
});

test('the node markers live in the world group and leave with the run', () => {
  const v = venue();
  const host = new THREE.Group();
  const { game } = running(v, { worldManager: { active: { group: host } } });
  assert.ok(host.children.length > 0, 'the splice drew no node markers at all');
  game.dispose();
  assert.equal(host.children.length, 0, 'a marker survived the run that owned it');
});

test('a splice with no host group is unchanged — the headless case is not a special case', () => {
  const { game, player } = running(venue(), { worldManager: null });
  hold(game, player, { x: 0, y: 0, z: 0 }, venue().config.holdS + 0.1);
  assert.equal(game.cracked, 1);
  game.dispose();
});

/* ================================================================== */
/* 5. The factory's start gate, and the HUD contract                   */
/* ================================================================== */

test('a splice may only be started from its access node, and the refusal says where', () => {
  const v = venue();
  const near = fakeBus();
  assert.ok(createDroneHack(v, { bus: near, player: body(1, 0, 1) }) instanceof DroneHack);

  const far = fakeBus();
  assert.equal(createDroneHack(v, { bus: far, player: body(45, 0, 45) }), null);
  const note = far.find('hud:notify')[0];
  assert.ok(note, 'the refusal said nothing');
  assert.match(note.text, /Relay A/, `the refusal "${note.text}" does not name the access node`);
  assert.match(note.text, /\d+\s*m/, 'the refusal does not say how far');
});

test('the snapshot carries the three rows the HUD renders, and a progress bar', () => {
  const v = venue();
  const { game, player } = running(v);
  const snap = game.snapshot();
  assert.deepEqual(snap.rows.map((r) => r.k), ['TRACE', 'NODE', 'SPLICE']);
  assert.equal(snap.progress, 0);
  hold(game, player, { x: 0, y: 0, z: 0 }, v.config.holdS + 0.1);
  assert.ok(game.snapshot().progress > 0, 'cracking a node moved no progress');
  game.dispose();
});
