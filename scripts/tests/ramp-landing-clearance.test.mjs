import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

import { buildStation } from './world-kit.mjs';
import { rampProxiesIn } from '../../src/worlds/station/StationKit.js';
import { CONFIG } from '../../src/core/Config.js';

/**
 * DOES THE FLIGHT ARRIVE SOMEWHERE, OR AT A WALL?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DEFECT THIS EXISTS FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * BOTH authored flights onto the station's observation promenade dead-ended
 * against the promenade's own balustrade, and every test in the repository was
 * green while they did. Nothing asked the question a body asks.
 *
 * The arithmetic, from the authored constants alone:
 *
 *   ramp head, top face   0.85 + 1.0 + 0.25 / cos(18.435 deg)  = 2.114 m
 *   balustrade collider   `_solidRot(bx, 2.6, bz, 0.2, 1.2, ...)` = 1.40 - 3.80
 *   wall standing at the head                                    1.69 m
 *
 * and there was no gap anywhere for a flight to arrive through: the balustrade
 * is drawn in 26 straight chords of `174 * (96 deg) / 26 + 0.6` = 11.813 m at a
 * spacing of `158 * (96 deg / 25)` = 10.589 m, so every segment OVERLAPS its
 * neighbour by 1.22 m across the whole +-48 degrees and the loop that drew them
 * had no skip condition. The deck behind it - the hero-window viewpoint, nine
 * telescopes, the benches - was reachable only by mantling a blank wall.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT IT MEASURES, AND WHY IT MEASURES THE BODY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The recorded lesson of this repository is that **a gate which measures
 * something the game does not do is worse than no gate**. So this one takes the
 * ramp's own collision proxy, works out where its top face ENDS, and walks a
 * player-sized column off the end of it:
 *
 *   at the head, and 0.45 and 0.90 m beyond it along the climb direction,
 *   find the walkable surface, check the rise from the last one is inside
 *   `CONFIG.player.stepHeight`, and then ask whether a `CONFIG.player.height`
 *   column standing on that surface is free of solid geometry.
 *
 * Four decisions in that, each of which cost a false positive to learn:
 *
 * 1. THE COLUMN IS THE CAPSULE'S AXIS, not its whole 0.7 m width. Swept at the
 *    full radius, five flights reported the jamb of the shop doorway they
 *    arrive at and four reported their own drawn treads - both correct
 *    readings of "something is within 0.35 m", neither of them a blocked
 *    flight. A wall across a flight covers the centreline; a doorway edge does
 *    not.
 * 2. IT ASKS `containsPoint`, WHICH SEES AUTHORED BOXES AND HEIGHTFIELDS.
 *    Two thirds of the station's collision is triangle soup that
 *    `_collisionSoup` derives from what the world DREW, treads included, so a
 *    ray sweep at the head reports the flight's own steps. The defect this
 *    gate exists for is an authored `_solidRot` box put across an arrival, and
 *    that is what it looks for. A soup wall at a ramp head would be missed;
 *    said out loud rather than left to be discovered.
 * 3. A SURFACE THAT READS FAR BELOW THE FLIGHT IS A SEAM, NOT A HOLE. Two
 *    flights arrive about 0.45 m short of the deck edge they meet, so a single
 *    downward cast between them falls to the floor below. A 0.7 m capsule
 *    bridges a 0.45 m seam, so the probe keeps standing at the flight's own
 *    height rather than reporting a hole nobody falls into. A real void under
 *    a flight head is the reach suites' subject, not this one's.
 * 4. A DOOR IS NOT AN OBSTRUCTION. `Interiors` clears the leaf the moment the
 *    player opens it, so a flight that ends at a closed door ends somewhere a
 *    body can go. Taken from `world.enterables`, the list the door system
 *    itself toggles.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE FIFTH DECISION, AND IT COST A FALSE PASS TO LEARN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 5. A FLIGHT IS WALKED, NOT ONLY ARRIVED AT.
 *
 * This file was green while a 7.6 x 7.0 x 1.2 m slab of the commercial
 * approach's lit shopfront band stood over the promenade's +18 degree flight
 * with its soffit at y 2.10 - 1.56 m of headroom falling to 0.27 m over a
 * climb that ends at 2.00, against a 1.75 m player. The gate could not see it,
 * and the reason is exact rather than approximate:
 *
 *   the head of that flight is at (150.27, 2.00, 48.82); the slab spans
 *   x 142.2-149.8, z 47.47-48.67. The head misses it by 0.47 m in x and
 *   0.15 m in z, and the three columns this gate stood - at the head and
 *   0.45 and 0.90 m BEYOND it, along the climb direction - all walk AWAY
 *   from the slab. The obstruction was behind the probe the whole time.
 *
 * So the gate now walks the flight as well as walking off it. The column is
 * stood every `STRIDE` metres from the foot to the head, standing on the
 * ramp's OWN TOP FACE - interpolated between the two end-face centres, not
 * asked of `groundHeight`, because a downward cast that starts inside a soffit
 * answers the soffit's underside and calls it the floor. That is exactly what
 * `groundHeight` did over this flight: 2.100 at every radius from 154 to
 * 157.5, which is the slab, reported as ground.
 *
 * The third test below re-introduces that slab and requires this gate to fail
 * on it. A gate nobody has watched fail is not evidence.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THE STATION IS THE WHOLE SUBJECT, AND HOW THAT STAYS TRUE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A ramp proxy is `StationWorld._ramp` and `DockWorld`'s two equivalents, and
 * nothing else in the game builds one - the citadel, race, sports and medieval
 * flights are stacks of boxes, which is `riser-legality.test.mjs`'s subject.
 * That is asserted below off the source rather than assumed, so the day a
 * fifth world grows a ramp this gate fails and gets extended instead of
 * quietly covering four fifths of the game.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', '..', 'src', 'worlds');

/** Where the column starts above the arrival surface, and where it stops. */
const FOOT = 0.15;
const HEAD = CONFIG.player.height;
const STEP = CONFIG.player.stepHeight;
/**
 * Spacing of the columns stood along a flight, and of the samples up each.
 *
 * `STRIDE` is the same 0.45 m the walk-off uses, which is a short pace and
 * shorter than anything in the station that could be a soffit. `RUNG` is what
 * limits how thin a horizontal slab can be and still be missed BETWEEN two
 * samples: 0.15 m, said out loud rather than left to be discovered. Nothing
 * the station hangs over a route is thinner than a 0.3 m plate.
 */
const STRIDE = 0.45;
const RUNG = 0.15;

/**
 * The walkable surface at (x, z), cast from `from` downward.
 *
 * A five-point rosette rather than one column: a downward cast that lands
 * exactly on the seam between two slabs reads whatever is under the seam.
 */
function surfaceAt(physics, x, z, from) {
  let best = null;
  for (const [ox, oz] of [[0, 0], [0.2, 0], [-0.2, 0], [0, 0.2], [0, -0.2]]) {
    const s = physics.groundHeight(x + ox, z + oz, from, 6.0);
    if (s !== null && (best === null || s > best)) best = s;
  }
  return best;
}

/** The two end-face centres of a ramp proxy's TOP face, head first. */
function proxyEnds(p) {
  p.updateWorldMatrix(true, false);
  const g = p.geometry.parameters;
  const a = new THREE.Vector3(0, g.height / 2, g.depth / 2).applyMatrix4(p.matrixWorld);
  const b = new THREE.Vector3(0, g.height / 2, -g.depth / 2).applyMatrix4(p.matrixWorld);
  return a.y >= b.y ? [a, b] : [b, a];
}

/**
 * Walk off the head of one flight. Returns a description of what stops the
 * body, or null.
 *
 * @param {object} physics
 * @param {THREE.Vector3} head  top face, head end
 * @param {THREE.Vector3} fwd   unit horizontal climb direction
 * @param {Array} ignore        colliders that are not obstructions
 */
function walkOff(physics, head, fwd, ignore) {
  const was = ignore.map((c) => c.solid);
  for (const c of ignore) c.solid = false;
  const pt = new THREE.Vector3();
  const q = new THREE.Vector3();
  try {
    let prev = head.y;
    for (const d of [0, 0.45, 0.9]) {
      q.copy(head).addScaledVector(fwd, d);
      let s = surfaceAt(physics, q.x, q.z, prev + STEP);
      if (s === null || s < prev - STEP) s = prev;   // a seam, see note 3
      if (s > prev + STEP + 1e-6) return `${d} m out: the ground rises ${(s - prev).toFixed(2)} m`;
      prev = s;
      for (let dy = FOOT; dy <= HEAD + 1e-9; dy += 0.15) {
        pt.set(q.x, s + dy, q.z);
        if (physics.containsPoint(pt)) {
          return `${d} m out: solid ${dy.toFixed(2)} m over a surface at ${s.toFixed(2)}`;
        }
      }
    }
  } finally {
    for (let i = 0; i < ignore.length; i++) ignore[i].solid = was[i];
  }
  return null;
}

/**
 * Walk UP one flight, standing on the flight's own top face.
 *
 * @see decision 5 in the header. The base of each column is interpolated
 * between the proxy's two end-face centres rather than probed, because a
 * downward cast that starts inside a soffit answers the soffit.
 *
 * @param {object} physics
 * @param {THREE.Vector3} foot  top face, foot end
 * @param {THREE.Vector3} head  top face, head end
 * @param {Array} ignore        colliders that are not obstructions
 */
function walkUp(physics, foot, head, ignore) {
  const was = ignore.map((c) => c.solid);
  for (const c of ignore) c.solid = false;
  const pt = new THREE.Vector3();
  const q = new THREE.Vector3();
  try {
    const run = Math.hypot(head.x - foot.x, head.z - foot.z);
    const n = Math.max(1, Math.ceil(run / STRIDE));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      q.lerpVectors(foot, head, t);
      /* Stand on the higher of the proxy's top face and the floor around it,
       * and take the floor from a cast that STARTS one step over the face.
       *
       * Both halves are load-bearing. A ramp foot is authored flush with the
       * deck it leaves, so the proxy's own face runs a little UNDER that deck
       * for the first metre - three dock flights reported their own floor slab
       * as an obstruction 0.15 m over the tread until this line existed, which
       * is decision 3's seam seen from the other end. And the cast has to
       * start low, because one that starts high answers a soffit's underside
       * and calls it the floor: `groundHeight` from 8 m over the promenade's
       * +18 flight answered 2.100 - the shopfront slab - at every radius from
       * 154 to 157.5. `STEP` is the most floor a body could be standing on
       * that the flight's own face does not already carry. */
      const floor = surfaceAt(physics, q.x, q.z, q.y + STEP);
      const base = floor !== null && floor > q.y && floor <= q.y + STEP ? floor : q.y;
      for (let dy = FOOT; dy <= HEAD + 1e-9; dy += RUNG) {
        pt.set(q.x, base + dy, q.z);
        if (physics.containsPoint(pt)) {
          return `${(t * run).toFixed(2)} m up the flight: solid ${dy.toFixed(2)} m over the tread at ${base.toFixed(2)}`;
        }
      }
    }
  } finally {
    for (let i = 0; i < ignore.length; i++) ignore[i].solid = was[i];
  }
  return null;
}

/**
 * WHAT IS STILL BLOCKED - two ratchets, because there are two measurements.
 *
 * They are kept apart on purpose. `walkUp` is new, and folding its findings
 * into the walk-off list would have read as a RISE from one to three in a
 * ratchet whose own rule is that the number may fall and never rise - hiding a
 * gate that got stronger inside a number that got worse. One list per probe:
 * each may fall and neither may rise.
 *
 * ── BLOCKED_OFF: what a flight arrives AT. 1 -> 0 ───────────────────────
 *
 * The construction yard's haul ramp is gone. `Construction.js` built a flight
 * up the tallest spoil heap at `rise = h * 0.8` = 4.55 m against a heap
 * collided as ONE box whose top was `h - 0.4` = 5.29 and whose sides stood at
 * `0.7 r` = 9.4 m from the summit: the flight arrived 0.74 m under the thing
 * it climbed - over a 0.45 m step and under `Climb.MIN_RISE_GROUND` = 1.0, so
 * neither a walk nor a mantle - and ran inside that box for its last 9.4 m,
 * where the ramp surface was 2.45 m and the wall 2.84 m higher still.
 *
 * The repair was the heap and not the ramp. Seven spoil heaps are now collided
 * as stepped cones that follow the dirt drawn on them, every riser inside the
 * player's step, so the flank IS the route - which is what the ramp's own
 * comment always claimed the heap was - and the broken second way up is gone.
 *
 * ── BLOCKED_UP: what a flight passes UNDER. Born at 3 ───────────────────
 *
 * Three soffits over flights in the Gym district's tall halls, every one of
 * them found by `walkUp` on the day it was written and none of them visible to
 * anything in this repository before. The probe reports the first rung that is
 * solid and the rungs are `RUNG` = 0.15 m, so the true clearance is between
 * 1.35 and 1.50 m against a 1.75 m player. That is not a wall - a body
 * climbing is pushed down by the resolver rather than stopped dead - but it is
 * under the standing height the whole of this gate is written against.
 *
 * They are left because the fix is inside a builder this pass did not open,
 * and because they are one defect in one district rather than three:
 * `station/zones/Gym.js` hangs a deck over the head end of its own flights.
 *
 * Two other things `walkUp` found HAVE been fixed, and are recorded here
 * because a list of what is left is worth nothing without the list of what was
 * found:
 *
 *   the six gateway service ramps. `GATEWAY.RAMP_Z` was 12 against a dais
 *   collider reaching local z = `COLLIDER_HALF` = 10.6, so the last 5.4 m of
 *   every one of them ran under the dais and a body met the rim at
 *   `2.4 * 5.4 / 8` = 1.62 m with the deck at 2.40 - a 0.78 m rise, over a
 *   step and under a mantle. `RAMP_Z` is `COLLIDER_HALF + 8 / 2` now, so the
 *   head lands ON the rim. Worse for what the ramp is FOR: `Horse`'s own
 *   STEP_UP is 0.75 and a mount cannot mantle at all.
 *
 *   the shopfront soffit 0.27 m over the head end of the promenade's +18
 *   degree flight - see decision 5 in the header, and the third test below,
 *   which re-introduces it and requires this gate to fail on it.
 */
const BLOCKED_OFF = [];
const BLOCKED_UP = [
  '(-498.0, 7.50, 17.1): 14.67 m up the flight: solid 1.50 m over the tread at 5.58',
  '(-572.1, 8.69, 43.2): 14.22 m up the flight: solid 1.50 m over the tread at 7.82',
  '(-578.7, 17.39, 28.9): 14.22 m up the flight: solid 1.50 m over the tread at 16.52',
];

let BUILT = null;
async function station() {
  if (!BUILT) BUILT = await buildStation();
  return BUILT;
}

test('every ramp head has room for a body to stand in', async () => {
  const { world, physics } = await station();
  const proxies = rampProxiesIn(world.group);
  /* Non-vacuity. `station-ramp-proxies.test.mjs` counts the flights exactly;
   * 40 is a floor. It fails loudly if the identification ever finds nothing,
   * which is exactly what a rehearsal frame clearing `visible` used to do. */
  assert.ok(proxies.length >= 40,
    `only ${proxies.length} ramp proxies found - this gate is measuring nothing`);

  /* The proxies' own colliders, matched by centre: `addBoxFromObject` bakes the
   * proxy's world matrix and the box geometry is centred, so the collider's
   * centre is the proxy's position. */
  const byCentre = new Map();
  for (const c of physics.colliders) {
    if (c.type !== 'box') continue;
    byCentre.set(`${c.center.x.toFixed(3)}|${c.center.y.toFixed(3)}|${c.center.z.toFixed(3)}`, c);
  }
  const doors = [];
  for (const e of world.enterables ?? []) {
    for (const d of e.doors ?? []) if (d.collider) doors.push(d.collider);
  }
  assert.ok(doors.length >= 3,
    `only ${doors.length} door colliders found - if enterables stopped publishing them, `
    + 'this gate would start reporting every shop doorway as a wall');

  const blockedOff = [];
  const blockedUp = [];
  for (const p of proxies) {
    const [head, foot] = proxyEnds(p);
    const fwd = new THREE.Vector3(head.x - foot.x, 0, head.z - foot.z);
    if (fwd.lengthSq() < 1e-9) continue;   // a flat proxy is not a flight
    fwd.normalize();
    const own = doors.slice();
    const key = `${p.position.x.toFixed(3)}|${p.position.y.toFixed(3)}|${p.position.z.toFixed(3)}`;
    if (byCentre.has(key)) own.push(byCentre.get(key));
    const at = (why) => `(${head.x.toFixed(1)}, ${head.y.toFixed(2)}, ${head.z.toFixed(1)}): ${why}`;
    const off = walkOff(physics, head, fwd, own);
    if (off) blockedOff.push(at(off));
    const up = walkUp(physics, foot, head, own);
    if (up) blockedUp.push(at(up));
  }
  console.log(`  ${proxies.length} ramps walked with a ${HEAD} m column; `
    + `${blockedOff.length} blocked at the head, ${blockedUp.length} blocked along the flight`);
  for (const b of [...blockedOff, ...blockedUp]) console.log(`     ${b}`);

  assert.ok(blockedOff.length <= BLOCKED_OFF.length,
    `${blockedOff.length} flights arrive inside something solid, up from ${BLOCKED_OFF.length}. `
    + 'A player climbs one of these and stops at the top. Cut the obstruction back at the head - '
    + 'see StationKit `promenadeRailRuns` for the shape of that fix.');
  assert.deepEqual(blockedOff, BLOCKED_OFF,
    'the set of flights blocked AT THE HEAD changed - a flight that arrived cleanly no longer '
    + 'does, or one that was pinned has been fixed. Lower the list when you fix one; never raise it.');
  assert.ok(blockedUp.length <= BLOCKED_UP.length,
    `${blockedUp.length} flights pass under something solid, up from ${BLOCKED_UP.length}. `
    + 'A player climbing one of these meets a soffit before the head.');
  assert.deepEqual(blockedUp, BLOCKED_UP,
    'the set of flights blocked ALONG THEIR RUN changed. Lower the list when you fix one; '
    + 'never raise it.');
});

test('the probe fires on the geometry the promenade used to have', async () => {
  /* PROOF THE GATE CAN FAIL, on the real defect rather than on a toy.
   *
   * The balustrade is rebuilt here at its ORIGINAL numbers - `_solidRot(bx,
   * 2.6, bz, 0.2, 1.2, chord/2, -th)` at r = 158, all 26 overlapping chords,
   * no opening anywhere - and registered on the live station. Both promenade
   * flight heads must then report blocked. It is removed again in a `finally`,
   * so the memoised world is handed on exactly as it was found.
   *
   * The head is at r = 158 on the flight's bearing with its top face on the
   * promenade deck: `_ramp` at `promR0 - 3` with a 6 m run gains exactly 6 m of
   * radius, and `promenadeFlight().rampSeat` puts the top face at `DECK_TOP`. */
  const { physics } = await station();
  const promR0 = 158, promR1 = 190;
  const arcSegs = 26, halfArc = (48 * Math.PI) / 180;
  const chord = (2 * Math.PI * ((promR0 + promR1) / 2) * (halfArc * 2)) / (Math.PI * 2) / arcSegs + 0.6;
  const added = [];
  let caught = 0;
  try {
    for (let i = 0; i < arcSegs; i++) {
      const th = -halfArc + (halfArc * 2 * i) / (arcSegs - 1);
      const bx = Math.cos(th) * promR0, bz = Math.sin(th) * promR0;
      added.push(physics.addRotatedBox(
        new THREE.Vector3(bx, 2.6, bz), new THREE.Vector3(0.2, 1.2, chord / 2), -th
      ));
    }
    for (const deg of [-18, 18]) {
      const th = (deg * Math.PI) / 180;
      const head = new THREE.Vector3(Math.cos(th) * promR0, 2.0, Math.sin(th) * promR0);
      const fwd = new THREE.Vector3(Math.cos(th), 0, Math.sin(th));
      if (walkOff(physics, head, fwd, [])) caught++;
    }
  } finally {
    for (const c of added) physics.remove(c);
  }
  assert.equal(caught, 2,
    'the un-cut balustrade did NOT register as an obstruction at either flight head - '
    + 'this gate cannot see the defect it was written for');
});

test('the probe fires on the soffit that used to stand over the promenade flight', async () => {
  /* PROOF THAT `walkUp` CAN FAIL, on the real defect rather than on a toy.
   *
   * The shopfront panel is rebuilt here at its ORIGINAL numbers - the i = 10
   * step of `_buildNearField`'s lit band, `bx = 62 + 10 * 8.4` = 146.0,
   * `bz = 47 + sin(9.0) * 2.6` = 48.07, a 7.6 x 7.0 x 1.2 m box centred at
   * y 5.6 so its soffit is at 2.10 - and registered on the live station as an
   * authored box, which is what `containsPoint` sees. The +18 degree flight
   * must then report blocked and the -18 degree one, which the panel never
   * reached, must not. Removed again in a `finally`, so the memoised world is
   * handed on exactly as it was found.
   *
   * The two halves matter equally. A gate that fires on the +18 flight and
   * ALSO on the -18 one is not detecting the slab, it is detecting the
   * promenade. */
  const { world, physics } = await station();
  const proxies = rampProxiesIn(world.group);
  const flights = new Map();
  for (const deg of [18, -18]) {
    const th = (deg * Math.PI) / 180;
    const cx = Math.cos(th) * 155, cz = Math.sin(th) * 155;
    const p = proxies.find((q) => Math.hypot(q.position.x - cx, q.position.z - cz) < 0.5);
    assert.ok(p, `no promenade ramp proxy at ${deg} deg - this proof is measuring nothing`);
    flights.set(deg, proxyEnds(p));
  }

  const bx = 62 + 10 * 8.4;
  const bz = 47 + Math.sin(10 * 0.9) * 2.6;
  const slab = physics.addBox(bx, 5.6, bz, 3.8, 3.5, 0.6);
  let caught = null;
  let clear = null;
  try {
    for (const [deg, [head, foot]] of flights) {
      const why = walkUp(physics, foot, head, []);
      if (deg === 18) caught = why; else clear = why;
    }
  } finally {
    physics.remove(slab);
  }
  assert.ok(caught,
    'the shopfront soffit over the +18 degree promenade flight did NOT register - '
    + 'this gate still cannot see the defect `walkUp` was written for');
  console.log(`  the re-introduced soffit reports: ${caught}`);
  assert.equal(clear, null,
    `the -18 degree flight also reported blocked (${clear}) - the probe is finding the `
    + 'promenade rather than the slab');
});

test('no world outside the station and the dock builds a ramp proxy', async () => {
  /* The scope statement, asserted. `riser-legality.test.mjs` owns the stacked
   * flights; this file owns the pitched ones, and the split is only honest
   * while nothing else grows a proxy. Source-level on purpose: it is a claim
   * about which builders exist, and building five worlds to discover that none
   * of them calls `markRampProxy` would be an expensive way to read five
   * lines. */
  for (const f of ['StationWorld.js', 'DockWorld.js']) {
    assert.ok(/markRampProxy/.test(readFileSync(path.join(SRC, f), 'utf8')),
      `${f} no longer marks its ramp proxies`);
  }
  for (const f of ['SportsWorld.js', 'CitadelWorld.js', 'RaceWorld.js', 'MedievalWorld.js', 'MazeWorld.js']) {
    let src;
    try { src = readFileSync(path.join(SRC, f), 'utf8'); } catch { continue; }
    assert.ok(!/markRampProxy/.test(src),
      `${f} has grown a ramp proxy - extend this gate to build that world and probe its heads`);
  }
});
