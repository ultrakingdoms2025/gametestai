import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { integrateAim, AIM_DEAD_ZONE, AIM_CLAMP } from '../../src/ui/MountWheelAim.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The mount wheel, aimed with a finger.
 *
 * ── The defect ───────────────────────────────────────────────────────────
 *
 * The wheel integrates `e.movementX/Y` into a direction vector of its own,
 * because under pointer lock there is no cursor to point with. `movementX` is a
 * pointer-lock quantity: on a touch device it is absent or zero on every event
 * the browser will ever deliver, so the roster opened on a phone and then could
 * not be aimed - six mounts on screen and no way to pick one.
 *
 * `MountWheel.js` imports a stylesheet and so cannot be reached from Node at
 * all, which is why the arithmetic moved into `MountWheelAim.js` (the same
 * split as `MountMenuLogic` and `MazeMapLayout`). These tests drive that module
 * directly; the source gates at the bottom are what pin the wheel to it, so a
 * touch branch cannot quietly grow a second copy of the maths that drifts from
 * what a mouse does.
 */

const SECTORS = 6;

test('a drag upwards picks the twelve-o-clock sector', () => {
  // The layout starts at twelve and runs clockwise; screen y is inverted.
  const r = integrateAim(0, 0, 0, -80, SECTORS);
  assert.equal(r.sel, 0);
  assert.equal(r.moved, true);
});

test('the ring runs clockwise from twelve, one sector per 60 degrees', () => {
  // Aimed at each sector's centre rather than at the seams between them, which
  // is where a rounding change would show up first.
  for (let k = 0; k < SECTORS; k++) {
    const a = (k / SECTORS) * Math.PI * 2 - Math.PI / 2;
    const r = integrateAim(0, 0, Math.cos(a) * 100, Math.sin(a) * 100, SECTORS);
    assert.equal(r.sel, k, `sector ${k} is not at ${(k * 60)} degrees clockwise from twelve`);
  }
});

test('the dead zone applies to a finger too', () => {
  /* The reason the dead zone exists - "a hand that has not moved does not pick
   * the sector the mouse drifted a pixel towards" - is MORE true of a thumb,
   * not less: an incidental tap would otherwise commit a mount. */
  const r = integrateAim(0, 0, 6, -4, SECTORS);
  assert.equal(r.sel, -1, 'a nudge inside the dead zone selected a mount');
  assert.equal(r.moved, false);
  assert.equal(r.reach, 0);
  // Just past it, the same gesture does select.
  assert.equal(integrateAim(0, 0, 0, -(AIM_DEAD_ZONE + 1), SECTORS).sel, 0);
});

test('deltas accumulate, so a slow drag reaches the same place as a flick', () => {
  let v = { vx: 0, vy: 0, sel: -1 };
  for (let i = 0; i < 10; i++) v = integrateAim(v.vx, v.vy, 0, -12, SECTORS);
  assert.equal(v.sel, 0);
  assert.ok(Math.abs(v.vy + 120) < 1e-6, `accumulation lost deltas: ${v.vy}`);
});

test('a long sweep is clamped, so coming back is not a second sweep', () => {
  let v = { vx: 0, vy: 0 };
  for (let i = 0; i < 40; i++) v = integrateAim(v.vx, v.vy, 0, -60, SECTORS);
  assert.ok(Math.hypot(v.vx, v.vy) <= AIM_CLAMP + 1e-6, 'the vector escaped the clamp');
});

/* ------------------------------------------------------------ source -- */

/** Comments are documentation, not behaviour. */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('MountWheel aims from the shared module and from the bus, not from movementX alone', async () => {
  /* The gate that stops this becoming a rebuilt copy of the wiring: the wheel
   * must actually import the arithmetic above, and must actually subscribe to
   * the look deltas `Input.applyLook` publishes. Without the subscription the
   * module is correct and unreachable, which is the failure shape this project
   * has hit nine times. */
  const src = strip(await readFile(path.join(root, 'src/ui/MountWheel.js'), 'utf8'));
  assert.ok(src.includes("from './MountWheelAim.js'"), 'MountWheel no longer uses the shared aim module');
  assert.ok(src.includes('integrateAim('), 'MountWheel does not call integrateAim');
  assert.ok(src.includes("'input:look'"), 'MountWheel does not subscribe to input:look');
  // Subscribed is not enough - it has to be subscribed from the constructor,
  // or the wheel is correct and unreachable.
  const ctor = src.slice(src.indexOf('constructor('), src.indexOf('get isOpen'));
  assert.ok(ctor.includes('_wireLook()'), 'the constructor never installs the look subscription');
  // Both feeders must go through one entry point.
  assert.ok(/_integrate\(/.test(src), 'MountWheel has no single integration entry point');
  assert.ok(
    !/movementX[\s\S]{0,400}?Math\.atan2/.test(src),
    'the sector arithmetic has grown back inside the mousemove handler'
  );
});

test('the look subscription is released on dispose', async () => {
  // A wheel that stayed subscribed after disposal would keep integrating every
  // drag in the game into a detached DOM for the life of the page.
  const src = strip(await readFile(path.join(root, 'src/ui/MountWheel.js'), 'utf8'));
  const at = src.indexOf('dispose()');
  assert.ok(at > 0);
  assert.ok(src.slice(at).includes('_offLook'), 'dispose() does not release the look subscription');
});
