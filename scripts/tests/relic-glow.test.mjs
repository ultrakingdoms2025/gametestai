import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { Relics, glowFalloff } from '../../src/systems/Relics.js';

/**
 * The relic halo is a GLOW and not a card.
 *
 * ── The defect ────────────────────────────────────────────────────────────
 * `relics:glow` was a `PlaneGeometry` with a flat additive colour and no map.
 * Every texel of the quad was as bright as its middle, so what a player saw
 * was a bright SQUARE with a hard boundary: obvious walking up to one, and
 * with bloom disabled a landscape scattered with plain white rectangles. The
 * expansion did not cause it - it is shared, and there are ~470 of these at
 * 2.2 to 9.5 m across the five worlds - but it put a hundred collectables in
 * front of the player, which is what made it everybody's problem.
 *
 * ── What is asserted ──────────────────────────────────────────────────────
 * The falloff, as a pure function, and then the material that carries it. The
 * function is where the "no visible edge" property actually lives: it has to
 * reach zero at the rim of the quad and stay there, because a ramp that still
 * had a few percent left at d = 1 would put a faint square back into bloom -
 * the same defect, quieter.
 *
 * The cost is asserted too, and deliberately: this is one `InstancedMesh` of
 * `MAX_PER_WORLD` sharing one material, and the fix must not have turned it
 * into a per-instance material or a custom shader program. Those are the two
 * ways a soft halo gets expensive, and neither is visible in a screenshot.
 */

test('the halo falls to nothing before the edge of its own quad', () => {
  assert.equal(glowFalloff(0), 1, 'the core of the halo is not at full strength');

  /* Zero AT the rim and beyond it. `d` is in half-widths, so the edge of the
   * quad is 1 and its corners are 1.414 - and the corners are what read as a
   * square first, because they are the only part of a circle-shaped glow that
   * a rectangle has and a light does not. */
  assert.equal(glowFalloff(1), 0, 'the halo is still lit at the edge of its quad');
  assert.equal(glowFalloff(Math.SQRT2), 0, 'the halo is still lit in the CORNERS of its quad');
  assert.equal(glowFalloff(4), 0);

  // Never increases: a ramp with a bump in it reads as a ring, not a glow.
  let prev = Infinity;
  for (let d = 0; d <= 1.6; d += 0.005) {
    const v = glowFalloff(d);
    assert.ok(v <= prev + 1e-12, `the falloff rises again at d = ${d.toFixed(3)}`);
    assert.ok(v >= 0 && v <= 1, `the falloff is ${v} at d = ${d.toFixed(3)}`);
    prev = v;
  }

  /* And it is a RAMP rather than a disc with a hard rim, which is the thing
   * that would pass every assertion above and still look like a card with the
   * corners taken off. Sampled across the middle of the tail. */
  assert.ok(glowFalloff(0.5) > 0.35 && glowFalloff(0.5) < 0.9,
    `halfway out the halo is at ${glowFalloff(0.5).toFixed(2)} - that is a rim, not a falloff`);
  assert.ok(glowFalloff(0.85) < 0.25, 'the tail of the halo is still bright at 85% of the way out');
  // A saturated core, or the relic stops being the brightest thing in frame.
  assert.equal(glowFalloff(0.15), 1);
});

test('the halo material carries the falloff, and still costs one draw', () => {
  // The scene is the only thing `Relics` touches at construction.
  const added = [];
  const relics = new Relics({ scene: { add: (o) => added.push(o) } });

  const glow = relics.glow;
  assert.ok(glow.isInstancedMesh, 'the halo is no longer one instanced mesh');
  assert.equal(glow.name, 'relics:glow');
  assert.ok(added.includes(glow) && added.includes(relics.mesh),
    'the relic meshes were not added to the scene');
  // Two meshes, two materials, whatever the relic count is.
  assert.equal(added.length, 2, `${added.length} objects added - a mesh per relic is not affordable`);

  const mat = glow.material;
  assert.ok(mat.map, 'the halo material has no map - it is a flat card again');
  assert.equal(mat.blending, THREE.AdditiveBlending);
  assert.equal(mat.depthWrite, false);
  assert.equal(mat.toneMapped, false, 'an HDR halo that is tone mapped is just a white square');

  /* No custom program. `onBeforeCompile` or a `customProgramCacheKey` on this
   * material would fork a shader program for one quad type - which is what
   * writing the ramp in GLSL would have cost, and this project counts programs
   * because light counts and material variants fold into the cache key. */
  const stock = new THREE.MeshBasicMaterial();
  assert.equal(mat.onBeforeCompile, stock.onBeforeCompile,
    'the halo material patches its own shader');
  assert.equal(mat.customProgramCacheKey(), stock.customProgramCacheKey(),
    'the halo material forks its own shader program');
  stock.dispose();

  /* The texture, sampled where it matters: full in the middle, nothing in the
   * corner. This is the same claim as the first test, made against the bytes
   * that actually reach the GPU. */
  const { data, width: n } = mat.map.image;
  const alphaAt = (u, v) => data[((Math.min(n - 1, (v * n) | 0) * n) + Math.min(n - 1, (u * n) | 0)) * 4 + 3];
  assert.equal(alphaAt(0.5, 0.5), 255, 'the middle of the halo texture is not opaque');
  assert.equal(alphaAt(0, 0), 0, 'the corner of the halo texture is lit - that is the visible square');
  assert.equal(alphaAt(0.999, 0.999), 0);
  // The mid-edges too: those are the four sides of the square that was visible.
  assert.ok(alphaAt(0.5, 0) <= 1 && alphaAt(0, 0.5) <= 1 && alphaAt(0.999, 0.5) <= 1,
    'the halo texture reaches its own edge still lit - that is the boundary of the card');
  // ...and the ramp exists in between rather than being a hard-edged disc.
  const mid = alphaAt(0.5, 0.25);
  assert.ok(mid > 20 && mid < 240, `the halo texture goes ${mid} a quarter of the way out - no ramp`);

  relics.dispose();
});
