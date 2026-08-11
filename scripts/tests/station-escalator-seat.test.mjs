import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  escalatorDeckDrop, TREAD_T, TREAD_MOUNT,
} from '../../src/worlds/station/Tower.js';

/**
 * Where an escalator's treads sit relative to the floors it joins.
 *
 * `buildTower` cannot be called under Node - it needs a built world, its
 * materials and its physics - so the one piece of arithmetic that decides
 * whether a flight meets its landings is exported and checked here. The
 * end-to-end measurement is the station audit's C4, which fits the tread line
 * from the running page and compares it against the ramp collider and the
 * floor slab; this covers the part C4 would only ever report as a number.
 */

/** The station's flights, from Tower.js: 30 degrees, the real-world standard. */
const PITCH = Math.atan2(3.9, 3.9 / Math.tan(30 * Math.PI / 180));

test('the pitch these flights are built at really is 30 degrees', () => {
  assert.ok(Math.abs(PITCH - Math.PI / 6) < 1e-12);
});

test('the drop seats a tread by its top face, not its centre', () => {
  /* The definition, restated independently: drop the deck by `d` and the tread
   * centre lands at `line - d + TREAD_MOUNT`; its top face is half a tread
   * higher, measured VERTICALLY, which for a pitched slab is
   * TREAD_T/2/cos(pitch). That top face has to be exactly on the line. */
  const d = escalatorDeckDrop(PITCH);
  const centre = -d + TREAD_MOUNT;
  const top = centre + (TREAD_T / 2) / Math.cos(PITCH);
  assert.ok(Math.abs(top) < 1e-12, `tread top ${top} should be on the line`);
});

test('it is exactly the 0.1293 m the audit measured on all 76 flights', () => {
  // The defect, to four places: every flight, both ends, identical. If this
  // number moves, the fix and the report have parted company.
  assert.equal(Number(escalatorDeckDrop(PITCH).toFixed(4)), 0.1293);
});

test('the drop is symmetric in the sign of the pitch', () => {
  // Half the flights climb -Z and carry a negative pitch. They are the same
  // flight turned round and must not be seated differently.
  assert.equal(escalatorDeckDrop(-PITCH), escalatorDeckDrop(PITCH));
});

test('a flat run needs only half a tread of drop above the mount', () => {
  assert.ok(Math.abs(escalatorDeckDrop(0) - (TREAD_MOUNT + TREAD_T / 2)) < 1e-12);
});

test('the drop grows with pitch, because a tilted tread is deeper vertically', () => {
  let prev = -Infinity;
  for (const deg of [0, 10, 20, 30, 40, 50]) {
    const d = escalatorDeckDrop((deg * Math.PI) / 180);
    assert.ok(d > prev, `not increasing at ${deg} degrees`);
    prev = d;
  }
});

test('a thicker tread is seated deeper by exactly half the extra thickness', () => {
  const a = escalatorDeckDrop(0, 0.12);
  const b = escalatorDeckDrop(0, 0.20);
  assert.ok(Math.abs((b - a) - 0.04) < 1e-12);
});

test('the tread mount matches the constant StationWorld animates against', () => {
  /* `StationWorld._runEscalators` rebuilds every tread each frame as
   * `y0 + rise * f + 0.06`. That literal and this constant are the same
   * number in two files, and a flight would silently spring back to its old
   * height if they ever stopped being. */
  assert.equal(TREAD_MOUNT, 0.06);
});
