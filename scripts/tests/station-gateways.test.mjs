import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEG, PORTAL_R, PLAZA_R, ROAD_W, LOOP_R,
  ROAD_ANGLES_DEG, ROAD_EDGE_HALF, MONUMENT_R,
  GATEWAY, GATEWAY_BEARINGS_DEG, GATEWAY_CENTRES,
  gatewayCentre, gatewayFrameYaw, gatewayLocalFootprint, gatewayWorldFootprint,
  avenueClearance, gatewayClearances,
} from '../../src/worlds/station/StationKit.js';

/**
 * Where the six gateways stand, and what they are clear of.
 *
 * `_buildGatewayRing` cannot be called under Node - it needs a built world, its
 * materials and its physics - so the arithmetic that decides WHERE a gateway
 * goes, and whether the thing it lands on top of is an avenue, the monument or
 * a promenade column, is exported and checked here. The end-to-end proof is the
 * station audit plus walking through all six portals in the running page; this
 * covers the part those would only ever report as a number.
 *
 * ── The defects these pin ────────────────────────────────────────────────
 * 1. The maze gateway shipped at (-54, 128): 139 m from the plaza centre, on no
 *    bearing at all, built by the code path meant for the on-axis pair, and
 *    offset along Z purely to keep its dais off the citadel's. Nothing in the
 *    world could derive its position, which is why `GATEWAY_CENTRES` had to be
 *    hand-written, and why `_buildCrowd`'s two four-entry position arrays had
 *    no way to know they needed a fifth.
 * 2. The citadel and race gateways sat ON avenues 180 and 0. The station audit
 *    reports both avenues obstructed, and `13fa912` names the cause: "the
 *    gateway approach RAMP and its kerbs ... 8 m wide inside an 18 m
 *    carriageway". Six gateways in that phase would be six blocked roads.
 */

const AVENUE_HALF = ROAD_W / 2;

/* --------------------------------------------------------------------- */
/* The bearings themselves                                               */
/* --------------------------------------------------------------------- */

test('there are exactly six bearings, evenly spaced', () => {
  assert.equal(GATEWAY_BEARINGS_DEG.length, 6);
  const gaps = GATEWAY_BEARINGS_DEG.map((d, i, a) => {
    const next = a[(i + 1) % a.length];
    return ((next - d) % 360 + 360) % 360;
  });
  for (const gap of gaps) assert.equal(gap, 60, `spacing ${gaps.join(', ')}`);
});

/** Unsigned angular separation between two bearings, degrees, in [0, 180]. */
const sep = (a, b) => Math.abs((((a - b + 540) % 360) + 360) % 360 - 180);

test('sep measures what it claims to', () => {
  // Pinned because the obvious one-liner for this is easy to get backwards, and
  // a backwards one would report a gateway sitting ON an avenue as 180 degrees
  // clear of it - a test that passes hardest exactly when it should fail.
  assert.equal(sep(0, 0), 0);
  assert.equal(sep(30, 0), 30);
  assert.equal(sep(330, 0), 30);
  assert.equal(sep(180, 0), 180);
  assert.equal(sep(190, 10), 180);
});

test('the gateways sit BETWEEN the avenues, not on them', () => {
  for (const g of GATEWAY_BEARINGS_DEG) {
    const nearest = Math.min(...ROAD_ANGLES_DEG.map((road) => sep(g, road)));
    assert.equal(
      nearest, 30,
      `gateway ${g} is ${nearest.toFixed(1)} deg off its nearest avenue, not the 30 that puts it midway`
    );
  }
});

test('every gateway is on the same radius - no off-axis fifth', () => {
  for (const [x, z] of GATEWAY_CENTRES) {
    assert.ok(
      Math.abs(Math.hypot(x, z) - PORTAL_R) < 1e-9,
      `dais at (${x.toFixed(2)}, ${z.toFixed(2)}) is ${Math.hypot(x, z).toFixed(1)} m out, not ${PORTAL_R}`
    );
  }
  assert.equal(GATEWAY_CENTRES.length, GATEWAY_BEARINGS_DEG.length);
});

test('GATEWAY_CENTRES is derived, so it cannot fall short of the bearings', () => {
  // The hand-written list is the thing this replaces. Rebuilding it from the
  // bearings must reproduce it exactly, element for element.
  for (let i = 0; i < GATEWAY_BEARINGS_DEG.length; i++) {
    const [x, z] = gatewayCentre(GATEWAY_BEARINGS_DEG[i]);
    assert.equal(GATEWAY_CENTRES[i][0], x);
    assert.equal(GATEWAY_CENTRES[i][1], z);
  }
});

/* --------------------------------------------------------------------- */
/* The local frame, and its agreement with the gateways that shipped      */
/* --------------------------------------------------------------------- */

test('the frame yaw reproduces the rotationY of all four on-axis gateways', () => {
  /* Sports stood at (0, +54) with rotationY 0, medieval at (0, -54) with PI,
   * race at (+54, 0) with PI/2 and citadel at (-54, 0) with -PI/2. Those four
   * came from two different builders using two different expressions - `s.yaw`
   * and `Math.PI * 0.5 * side` - and `gatewayFrameYaw` has to agree with both,
   * or the unified builder is not a transcription of them but a rewrite. */
  const shipped = [[90, 0], [270, Math.PI], [0, Math.PI / 2], [180, -Math.PI / 2]];
  for (const [deg, yaw] of shipped) {
    const got = gatewayFrameYaw(deg);
    const d = Math.atan2(Math.sin(got - yaw), Math.cos(got - yaw));
    assert.ok(Math.abs(d) < 1e-12, `bearing ${deg}: yaw ${got} != ${yaw}`);
  }
});

test('local +Z is outward and local -Z is the approach, at every bearing', () => {
  for (const deg of GATEWAY_BEARINGS_DEG) {
    const yaw = gatewayFrameYaw(deg);
    const [cx, cz] = gatewayCentre(deg);
    // localAt: +Z -> (sin yaw, cos yaw).
    const outX = cx + Math.sin(yaw) * 10;
    const outZ = cz + Math.cos(yaw) * 10;
    assert.ok(
      Math.hypot(outX, outZ) > PORTAL_R + 9.9,
      `local +Z at bearing ${deg} does not point away from the plaza`
    );
    const inX = cx - Math.sin(yaw) * 10;
    const inZ = cz - Math.cos(yaw) * 10;
    assert.ok(
      Math.hypot(inX, inZ) < PORTAL_R - 9.9,
      `local -Z at bearing ${deg} does not point at the plaza`
    );
  }
});

test('the six footprints are congruent - one builder, not two', () => {
  /* Every gateway must be the same shape, which under a rigid transform means
   * the multiset of distances from its own centre is identical. This is the
   * headless form of "visually identical in construction": the Z-axis pair had
   * an octagonal dais, an arch and an aperture surround while the X-axis trio
   * had a stepped disc and four standing stones, and no arrangement of bearings
   * would have made those the same gateway. */
  const key = (deg) => gatewayWorldFootprint(deg)
    .map((p) => {
      const [cx, cz] = gatewayCentre(deg);
      return Math.hypot(p.x - cx, p.z - cz).toFixed(6);
    })
    .sort()
    .join('|');
  const first = key(GATEWAY_BEARINGS_DEG[0]);
  for (const deg of GATEWAY_BEARINGS_DEG.slice(1)) {
    assert.equal(key(deg), first, `gateway at ${deg} is not the same shape as the first`);
  }
});

/* --------------------------------------------------------------------- */
/* Clearances                                                            */
/* --------------------------------------------------------------------- */

test('avenueClearance is negative on a road and positive beside one', () => {
  // Dead centre of avenue 0, well outside its mouth.
  assert.ok(avenueClearance(80, 0) < 0, 'a point on the carriageway reads clear');
  // Exactly on the kerb's outer edge.
  assert.ok(Math.abs(avenueClearance(80, ROAD_EDGE_HALF)) < 1e-9);
  // Two metres beyond it.
  assert.ok(Math.abs(avenueClearance(80, ROAD_EDGE_HALF + 2) - 2) < 1e-9);
  // Inboard of the mouth: on the bearing, but the road has not started.
  assert.ok(avenueClearance(PLAZA_R - 12, 0) > 0, 'the plaza inside the mouth reads as road');
});

test('the kerb clearance is measured to the kerb, not the carriageway', () => {
  assert.ok(ROAD_EDGE_HALF > AVENUE_HALF, 'kerbs are part of the obstruction');
  /* 9.9 to within float. `ROAD_W / 2 + 0.45 + 0.45` evaluates to
   * 9.899999999999999, and asserting strict equality against the decimal
   * literal fails on the last bit - which says nothing about the geometry and
   * everything about having written the number twice. It is a distance, so it
   * gets a tolerance. */
  assert.ok(Math.abs(ROAD_EDGE_HALF - 9.9) < 1e-9, `ROAD_EDGE_HALF = ${ROAD_EDGE_HALF}`);
});

test('no part of any gateway stands on an avenue', () => {
  const { avenue, avenueAt } = gatewayClearances();
  assert.ok(avenue > 0, `something is on a road: ${avenueAt} at ${avenue.toFixed(2)} m`);
});

test('the tightest avenue clearance is the dais collider corner, and it is inherited', () => {
  /* The binding constraint is NOT the part that looks widest. The dais collider
   * is a square of half-extent 10.6 standing for an octagon of radius 11.4, so
   * its corners reach 15.0 - and that over-reach, not the approach flight, is
   * what comes closest to a kerb.
   *
   * It is inherited rather than introduced. Measured against the arrangement
   * that shipped, the medieval gateway's collider corner had exactly the same
   * clearance, because a square rotated onto a 60-degree phase presents the
   * same corner to the same kerb as one sitting on an axis 30 degrees away. */
  const { avenue, avenueAt } = gatewayClearances();
  assert.match(avenueAt, /collider corner/, `tightest point is ${avenueAt}`);

  // What medieval had, computed from the geometry as it shipped: dais at
  // (0, -PORTAL_R), collider half 10.6, world-axis-aligned.
  let shipped = Infinity;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const d = avenueClearance(sx * GATEWAY.COLLIDER_HALF, -PORTAL_R + sz * GATEWAY.COLLIDER_HALF);
      if (d < shipped) shipped = d;
    }
  }
  assert.ok(
    Math.abs(avenue - shipped) < 1e-6,
    `six gateways clear the kerbs by ${avenue.toFixed(3)} m where medieval cleared them by ${shipped.toFixed(3)} m`
  );
});

test('the drawn geometry - dais rim, flight and ramp - clears the kerbs by metres', () => {
  /* Same measurement with the collider corners taken out, which is what a
   * player actually sees. If this were tight the arrangement would look wrong
   * even though nothing collided. */
  let worst = Infinity, at = null;
  for (const deg of GATEWAY_BEARINGS_DEG) {
    for (const p of gatewayWorldFootprint(deg)) {
      if (p.what === 'dais collider corner') continue;
      const d = avenueClearance(p.x, p.z);
      if (d < worst) { worst = d; at = `${deg} deg ${p.what}`; }
    }
  }
  assert.ok(worst > 3.5, `drawn geometry comes within ${worst.toFixed(2)} m of a kerb at ${at}`);
});

test('the ON-avenue phase would seal every road - which is why it was rejected', () => {
  /* The counterfactual, asserted rather than claimed. Phasing the six gateways
   * onto the avenues puts a 22.8 m dais across a 19.8 m paved width; this is
   * the measurement that made the choice, so it is pinned here. If a future
   * change to ROAD_W or PORTAL_R ever made the aligned phase viable, this test
   * fails and the note on GATEWAY_BEARINGS_DEG has to be rewritten. */
  const aligned = gatewayClearances(ROAD_ANGLES_DEG, ROAD_ANGLES_DEG);
  assert.ok(
    aligned.avenue < 0,
    `gateways aligned with the avenues would clear them by ${aligned.avenue.toFixed(2)} m`
  );
});

test('nothing touches the plaza-centre monument', () => {
  const { monument } = gatewayClearances();
  assert.ok(monument > 15, `a gateway comes within ${monument.toFixed(2)} m of the monument`);
  // Sanity: the monument is inside the plaza and the gateways are outside it.
  assert.ok(MONUMENT_R < PLAZA_R);
  assert.ok(PORTAL_R > PLAZA_R);
});

test('nothing touches a promenade support column', () => {
  /* Twelve columns at 15 + 30k on LOOP_R, placed "kept clear of the avenues".
   * The gateway bearings are the avenue midpoints, so each gateway points
   * exactly between two columns - the worst case is the service ramp reaching
   * outward under the walkway, which is why this is measured rather than
   * assumed from the 18 m of radial gap. */
  const { column } = gatewayClearances();
  assert.ok(column > 5, `a gateway comes within ${column.toFixed(2)} m of a loop column`);
  assert.ok(LOOP_R > PORTAL_R, 'the loop is outboard of the gateway ring');
});

test('adjacent daises do not overlap', () => {
  const { neighbour } = gatewayClearances();
  assert.ok(neighbour > 0, `adjacent gateway colliders overlap by ${(-neighbour).toFixed(2)} m`);
  // Centre to centre, six on a circle of radius PORTAL_R at 60 degrees.
  const [ax, az] = gatewayCentre(GATEWAY_BEARINGS_DEG[0]);
  const [bx, bz] = gatewayCentre(GATEWAY_BEARINGS_DEG[1]);
  assert.ok(Math.abs(Math.hypot(ax - bx, az - bz) - PORTAL_R) < 1e-9,
    'a 60-degree chord on radius R is R');
});

/* --------------------------------------------------------------------- */
/* The assembly's own dimensions                                         */
/* --------------------------------------------------------------------- */

test('the approach flight is climbable on its own terms', () => {
  /* `CONFIG.player.stepHeight` is 0.45. The flight shipped as five treads of
   * 0.48 - three centimetres too tall to walk up, every one of them - and was
   * fixed to six of 0.40 for the same 2.4 m rise. The constants moved into
   * StationKit for the clearance maths, so the relationship moves with them. */
  assert.ok(GATEWAY.TREAD_RISE < 0.45, 'a tread taller than stepHeight is a wall');
  assert.ok(
    Math.abs(GATEWAY.TREADS * GATEWAY.TREAD_RISE - 2.4) < 1e-9,
    'the flight no longer reaches the gateway deck'
  );
});

test('the treads taper outward and the flight leads away from the dais', () => {
  const pts = gatewayLocalFootprint().filter((p) => p.what.startsWith('approach tread'));
  assert.ok(pts.length > 0);
  for (const p of pts) assert.ok(p.z < 0, 'a tread is on the outward side of the dais');
  // Bottom tread is narrower and further out than the top one.
  const top = pts.filter((p) => p.what === 'approach tread 0');
  const bot = pts.filter((p) => p.what === `approach tread ${GATEWAY.TREADS - 1}`);
  assert.ok(Math.max(...bot.map((p) => Math.abs(p.x))) < Math.max(...top.map((p) => Math.abs(p.x))));
  assert.ok(Math.min(...bot.map((p) => p.z)) < Math.min(...top.map((p) => p.z)));
});

test('the service ramp is on the far side from the approach', () => {
  const ramp = gatewayLocalFootprint().filter((p) => p.what === 'service ramp');
  assert.equal(ramp.length, 4);
  for (const p of ramp) assert.ok(p.z > 0, 'the ramp is on the approach side');
  // Mounts cannot climb the flight; the ramp is how they reach the deck, and it
  // has to stay walkable rather than becoming a step.
  const pitch = Math.atan2(2.4, 8) / DEG;
  assert.ok(pitch > 10 && pitch < 20, `ramp pitch ${pitch.toFixed(1)} deg`);
});
