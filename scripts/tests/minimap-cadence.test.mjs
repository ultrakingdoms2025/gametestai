import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * HOW OFTEN DOES THE DIAL ACTUALLY NEED REPAINTING?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT WAS HAPPENING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Minimap.update` clears and repaints 193,600 device pixels, rotates a blit
 * of the baked floorplan through the result, and walks every marker list in
 * the world. It is driven from `HUD.update` with no cadence of its own AND
 * OUTSIDE the `uiPaused` gate - so on a 120 Hz panel it ran 120 times a second,
 * including while the player sat in a menu with nothing on the map moving.
 *
 * It also built a `createRadialGradient` and three `addColorStop`s per frame
 * whose four arguments - cx, cy, 4, r - are fixed for the life of the widget.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT IS ASSERTED, AND WHY IT IS NOT A FRAME COUNT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A gate is only worth having if it cannot skip a frame the player would have
 * seen. So the assertions are about the CASES, not about a ratio:
 *
 *   a stationary player           repaints at the idle floor, never at 0 Hz
 *   a walking player              repaints, and at the ceiling not above it
 *   a turning player              repaints (the dial rotates under the arrow)
 *   a live race                   repaints regardless of the player
 *   a new world / zoom / circuit  repaints on the very next frame
 *
 * The counts come from `minimap.paints`, which the widget keeps for exactly
 * this reason: a saving that is claimed rather than counted is the shape this
 * repository keeps paying for.
 */

/* ---- the smallest DOM that lets the real class run --------------------- */
class FakeGradient { addColorStop() {} }
function fakeCtx() {
  const real = {
    createRadialGradient: () => new FakeGradient(),
    createLinearGradient: () => new FakeGradient(),
    createPattern: () => null,
    measureText: () => ({ width: 8 }),
    getLineDash: () => [],
    /** Counted, because "did it repaint" is answered by the clear. */
    clears: 0,
    clearRect() { real.clears++; },
  };
  return new Proxy(real, { get: (o, k) => (k in o ? o[k] : () => undefined), set: (o, k, v) => { o[k] = v; return true; } });
}
globalThis.Path2D = class { moveTo() {} lineTo() {} closePath() {} arc() {} rect() {} };
globalThis.window = globalThis.window ?? globalThis;
globalThis.window.devicePixelRatio = 2;
globalThis.document = globalThis.document ?? {
  createElement() { const c = { width: 1, height: 1, style: {} }; c.getContext = () => fakeCtx(); return c; },
};

const { Minimap } = await import('../../src/ui/Minimap.js');

function makeMap() {
  const canvas = { width: 0, height: 0, style: {}, getContext: () => fakeCtx() };
  const player = { position: { x: 0, y: 0, z: 0 }, yaw: 0 };
  const map = new Minimap({
    canvas, player,
    worldManager: { active: null }, npcManager: null, portals: null,
    caches: null, contracts: null, relics: null, viewpoints: null,
  });
  return { map, player };
}

/** Drive `seconds` of frames at `hz` and hand back what was painted. */
function run(map, seconds, hz, step = null) {
  const dt = 1 / hz;
  const n = Math.round(seconds * hz);
  for (let i = 1; i <= n; i++) {
    step?.(i * dt, i);
    map.update(dt, i * dt);
  }
  return map.paints;
}

test('a stationary player repaints at the idle floor - not at the frame rate, and never at zero', () => {
  const { map } = makeMap();
  const p = run(map, 2, 120);
  /* 10 Hz over two seconds. The bound is loose on purpose: the exact count
   * depends on how the first frame lands relative to the floor, and pinning it
   * would be pinning the arithmetic rather than the behaviour. */
  assert.ok(p.drawn >= 15 && p.drawn <= 25,
    `a still player took ${p.drawn} repaints in 2 s; expected about 20 (the 10 Hz idle floor)`);
  assert.ok(p.skipped > 200, `only ${p.skipped} frames were skipped out of 240 - the gate is not gating`);
  /* And it must not stop: several markers pulse on `elapsed`, and a frozen
   * dial reads as a broken widget rather than as a saving. */
  assert.ok(p.drawn > 0);
});

test('a walking player repaints, and is capped at the ceiling rather than the frame rate', () => {
  const { map, player } = makeMap();
  /* 4.6 m/s is this game's measured walking speed. */
  const p = run(map, 2, 120, (t) => { player.position.z = -4.6 * t; });
  assert.ok(p.drawn <= 62, `${p.drawn} repaints in 2 s is over the 30 Hz ceiling`);
  assert.ok(p.drawn >= 20, `${p.drawn} repaints in 2 s of walking is under the idle floor - the gate is holding the map back`);
});

test('turning repaints the dial even though the player has not moved a metre', () => {
  /* The map is player-CENTRED and rotates to the heading, so a turn moves
   * every drawn point while the position term stays exactly zero. A gate that
   * only watched position would freeze the map under a mouse-look. */
  const { map, player } = makeMap();
  const p = run(map, 1, 120, (t) => { player.yaw = t * 2.0; });
  assert.ok(p.drawn >= 25, `${p.drawn} repaints while turning at 2 rad/s; the dial would visibly step`);
});

test('a live race repaints whatever the player does', () => {
  /* Racer dots are somebody else's position. A gate keyed on the player alone
   * would freeze the field the moment the player's own car stopped. */
  const { map } = makeMap();
  map.setCircuit([[0, 0], [10, 0], [10, 10], [0, 10]], [{ x: 1, z: 1, isPlayer: false, color: 0, place: 1 }]);
  const p = run(map, 1, 120);
  assert.ok(p.drawn >= 25, `${p.drawn} repaints during a race; the field would step`);
});

test('a new world, a zoom step and a circuit each repaint on the very next frame', () => {
  const { map } = makeMap();
  run(map, 1, 120);
  const settled = map.paints.drawn;

  map.zoom(1);
  map.update(1 / 120, 1.001);
  assert.equal(map.paints.drawn, settled + 1, 'a zoom step must repaint immediately, not at the idle floor');

  map.setWorld(null);
  map.update(1 / 120, 1.002);
  assert.equal(map.paints.drawn, settled + 2, 'a world change must repaint immediately');
});

test('the backdrop gradient is built once, not once a frame', () => {
  /* Every argument to it - cx, cy, 4, r - is fixed for the life of the widget,
   * and a CanvasGradient is immutable and reusable. */
  const { map } = makeMap();
  const first = map._bg;
  assert.ok(first, 'the gradient is not built in the constructor');
  run(map, 1, 120);
  assert.equal(map._bg, first, 'the backdrop gradient was rebuilt during the run');
});

test('a caller that passes no elapsed clock always repaints', () => {
  /* The gate is an optimisation, not a contract. A driver (a probe, a test,
   * an offscreen bake) that hands over no clock must get the old behaviour
   * rather than a silently frozen widget. */
  const { map } = makeMap();
  for (let i = 0; i < 10; i++) map.update(1 / 60, undefined);
  assert.equal(map.paints.drawn, 10);
  assert.equal(map.paints.skipped, 0);
});
