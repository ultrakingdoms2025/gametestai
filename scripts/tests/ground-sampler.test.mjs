// scripts/tests/ground-sampler.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planGrid, createJob, encodeInt16Base64, NO_SAMPLE, MAX_LAYERS } from '../../src/systems/GroundSampler.js';

/**
 * THE GROUND GRID THE MAP EDITOR DRAWS AND VALIDATES AGAINST.
 *
 * THE CLAIM: from a world's bounds and a downward cast, the sampler produces a
 * grid whose step, extent and cell order are exactly what site/lib/mapLayout.ts
 * decodes (index ((j*nx)+i)*layers+k, layer 0 topmost, NO_SAMPLE padding, cm
 * clamped to ±32767, Int16 LE base64), in slices that stop when a time budget
 * is spent.
 *
 * Not a stub: the cast is a FUNCTION RETURNING KNOWN SURFACES, so every
 * assertion is arithmetic the site will index into; the decode is Node's
 * Buffer.readInt16LE, never the encoder's inverse, so a byte-order mistake
 * cannot cancel out. That the cast peels REAL colliders is map-overlay-layout.test.mjs's claim.
 */

/** Independent decoder: Node's Buffer, little-endian, none of the module's code. */
function decode(b64) {
  const buf = Buffer.from(b64, 'base64');
  const out = new Int16Array(buf.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}
const box = (x0, y0, z0, x1, y1, z1) => ({ min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 } });

test('the station (±744 m) plans a 6 m step and a 249×249 grid; a small world floors at 4 m', () => {
  assert.deepEqual(planGrid(box(-744, -6, -744, 744, 158, 744)),
    { originX: -744, originZ: -744, step: 6, nx: 249, nz: 249 });
  assert.deepEqual(planGrid(box(-40, -5, -40, 40, 30, 40)),
    { originX: -40, originZ: -40, step: 4, nx: 21, nz: 21 });
  assert.equal(planGrid(box(-450, 0, -450, 450, 100, 450)).nx, 226); // 900/256 → 4 m
  assert.equal(planGrid(null), null);
  assert.equal(planGrid(box(0, 0, 0, 0, 10, 0)), null, 'a degenerate box plans nothing');
});

test('Int16 little-endian base64 round-trips a hand-built array, extremes included', () => {
  const src = new Int16Array([0, 1, -1, 32767, -32768, 1234, -1234, 256]);
  const b64 = encodeInt16Base64(src);
  assert.match(b64, /^[A-Za-z0-9+/]+=*$/);
  assert.deepEqual([...decode(b64)], [...src]);
  // Byte order pinned by hand: 256 is 0x0100 → bytes 00 01 in LE.
  assert.deepEqual([...Buffer.from(encodeInt16Base64(new Int16Array([256])), 'base64')], [0x00, 0x01]);
});
