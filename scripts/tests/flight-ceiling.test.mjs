import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  flightCeilingAt, stationFlightCeiling, STATION_WORLD_ID, DOME_CLEARANCE,
} from '../../src/mounts/FlightCeiling.js';
import {
  DOME_R, DOME_WALL_H, DOME_APEX, CEIL_Y, OCULUS_R, WORLD_R, domeHeightAt,
} from '../../src/worlds/station/StationKit.js';

/**
 * The flying-mount ceiling, checked headlessly.
 *
 * The clamp is pure arithmetic over the same constants the dome MESH is built
 * from, so it can be asserted directly against the drawn roof rather than
 * against a remembered number - which is the point of keeping it out of the
 * world classes. What is covered here is the part where a wrong answer would
 * be invisible in play: that the ceiling follows the cap instead of cutting
 * across it, that it never rises above the glass, that it does not go silly
 * outside the dome, and that it is not applied to the five worlds that have no
 * roof at all.
 */

/* Every world's `static id`, so a rename shows up here rather than as a
 * silently un-clamped station. */
const ROOFLESS = ['medieval', 'sports', 'citadel', 'race', 'maze'];

test('the station clamp reduces to the existing flat bound on the world axis', () => {
  // StationWorld already sets bounds.max.y to DOME_APEX - 6 and explains why.
  // The dome clamp has to agree with it where the two meet, or the change
  // would be moving a number rather than following a surface.
  assert.equal(stationFlightCeiling(0, 0), DOME_APEX - DOME_CLEARANCE);
  assert.equal(stationFlightCeiling(0, 0), 164);
});

test('the clamp follows the cap: it is exactly the clearance under the drawn roof', () => {
  for (const r of [0, 1, 50, 120, 200, 340, 499, 640, 700, DOME_R]) {
    const roof = domeHeightAt(r);
    assert.equal(stationFlightCeiling(r, 0), roof - DOME_CLEARANCE, `r=${r}`);
    assert.ok(stationFlightCeiling(r, 0) < roof, `r=${r} must stay under the glass`);
  }
});

test('at the springing line the ceiling is the perimeter wall, not the apex', () => {
  assert.ok(Math.abs(domeHeightAt(DOME_R) - DOME_WALL_H) < 1e-6);
  assert.equal(stationFlightCeiling(DOME_R, 0), DOME_WALL_H - DOME_CLEARANCE);
  assert.equal(stationFlightCeiling(DOME_R, 0), 64);
});

test('the flat bound was the defect: it sat above the glass over most of the floor', () => {
  // What this replaces, sized. The old ceiling was a plane at the apex less
  // its clearance, so it crossed OUT through the roof at the radius where the
  // shallow cap has fallen that far - and everything beyond that radius was
  // flyable straight through the glass.
  const flat = DOME_APEX - DOME_CLEARANCE;
  let cross = DOME_R;
  for (let r = 0; r <= DOME_R; r += 0.25) {
    if (domeHeightAt(r) < flat) { cross = r; break; }
  }
  assert.ok(cross < 180, `expected the crossing well inside the hub, got r=${cross}`);
  const areaBeyond = 1 - (cross / DOME_R) ** 2;
  assert.ok(areaBeyond > 0.9, `only ${areaBeyond.toFixed(3)} of the floor was affected`);
  assert.ok(flat - domeHeightAt(650) > 70, 'and by 70 m or more out at the rim');

  // The replacement is under the glass at every radius, which is the property
  // the flat plane never had.
  for (let r = 0; r <= DOME_R; r += 5) {
    assert.ok(stationFlightCeiling(r, 0) < domeHeightAt(r), `r=${r}`);
  }
});

test('the ceiling falls monotonically from the axis to the rim', () => {
  let prev = Infinity;
  for (let r = 0; r <= DOME_R; r += 10) {
    const y = stationFlightCeiling(r, 0);
    assert.ok(y <= prev + 1e-9, `not monotonic at r=${r}`);
    prev = y;
  }
});

test('it is radial: only the distance from the axis matters', () => {
  const r = 413;
  const a = stationFlightCeiling(r, 0);
  for (const th of [0.3, 1.1, 2.6, 4.0, 5.5]) {
    const y = stationFlightCeiling(Math.cos(th) * r, Math.sin(th) * r);
    assert.ok(Math.abs(y - a) < 1e-9, `theta=${th}`);
  }
  assert.equal(stationFlightCeiling(-120, -260), stationFlightCeiling(120, 260));
});

test('outside the dome the ceiling holds at the springing line and never goes negative', () => {
  /* The regression this guards: `domeHeightAt` keeps following its sphere past
   * the dome, and the sphere comes back down. The station's bounds box reaches
   * 744 on each axis, so its corner is ~1052 m from the axis, where the
   * unclamped cap height is about -45 - a ceiling clamp fed that would drive a
   * mount underground. */
  const corner = Math.hypot(WORLD_R, WORLD_R);
  assert.ok(corner > DOME_R, 'the bounds box really does reach past the dome');
  assert.ok(domeHeightAt(corner) < 0, 'the unclamped cap really does go negative out there');

  const rim = stationFlightCeiling(DOME_R, 0);
  assert.equal(stationFlightCeiling(WORLD_R, WORLD_R), rim);
  assert.equal(stationFlightCeiling(DOME_R + 200, 0), rim);
  assert.ok(rim > 0);
});

test('the oculus is left open: the ceiling over the plaza is the dome, not the hub plate', () => {
  /* The deliberate decision, asserted so it cannot be undone by accident. The
   * hub's overhead plate is at CEIL_Y with an OCULUS_R opening punched through
   * it over the plaza; rising through that opening into the cap is meant to
   * work, so the flight ceiling anywhere inside the oculus must be well above
   * the plate. The plate is architecture and is collision's business, not this
   * clamp's. */
  for (const r of [0, OCULUS_R / 2, OCULUS_R - 1]) {
    assert.ok(stationFlightCeiling(r, 0) > CEIL_Y + 90, `r=${r} should clear the hub plate`);
  }
  // ...and outside the oculus too - the clamp does not know the plate exists.
  assert.ok(stationFlightCeiling(OCULUS_R + 1, 0) > CEIL_Y);
});

test('flightCeilingAt applies the dome to the station and nothing to any other world', () => {
  for (const [x, z] of [[0, 0], [300, -120], [-700, 40]]) {
    assert.equal(
      flightCeilingAt({ id: STATION_WORLD_ID }, x, z),
      stationFlightCeiling(x, z),
    );
  }
  for (const id of ROOFLESS) {
    assert.equal(flightCeilingAt({ id }, 0, 0), null, `${id} must keep an open sky`);
    assert.equal(flightCeilingAt({ id }, 700, 700), null, `${id} must keep an open sky`);
  }
});

test('a missing or unknown world means an open sky, never a clamp at zero', () => {
  // The failure this forbids: returning 0 or NaN for an unknown world would
  // pin every mount to the ground the first time a world forgot its id.
  assert.equal(flightCeilingAt(null, 0, 0), null);
  assert.equal(flightCeilingAt(undefined, 0, 0), null);
  assert.equal(flightCeilingAt({}, 0, 0), null);
  assert.equal(flightCeilingAt({ id: 'Station' }, 0, 0), null);
});

test('the station id matches the world class it is meant to select', () => {
  assert.equal(STATION_WORLD_ID, 'station');
});
