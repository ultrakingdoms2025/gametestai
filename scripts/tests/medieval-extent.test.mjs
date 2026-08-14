/**
 * THE EXTENT GATE.
 *
 * Aldermoor Vale grew from 400x400m to 900x900m by changing one number -
 * `HALF`, in `terrain/MedievalHeight.js`. That only works if every consumer
 * derives from it, and the failure mode when one does not is the worst kind:
 * nothing throws. A terrain job left at `size: 400` draws a quarter of the
 * ground and the rest is sky; a containment wall left at 199 fences the player
 * into the old square in the middle of a much bigger world; a backdrop ring
 * left at 208-358m places its trees inside the playfield and then rejects
 * every one of them, so the horizon is simply bare.
 *
 * None of those need a renderer to catch, so none of them should ever reach
 * one again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { HALF, medievalHeight, smoothstep } from '../../src/worlds/terrain/MedievalHeight.js';
import { MedievalWorld, MEDIEVAL_LAYOUT } from '../../src/worlds/MedievalWorld.js';
import { sampleTerrain } from '../../src/workers/jobs/TerrainJob.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

/* ------------------------------------------------------------------ */
/* The authored number                                                 */
/* ------------------------------------------------------------------ */

test('HALF is 450, so the playfield is 900 x 900 m', () => {
  assert.equal(HALF, 450);
  assert.equal(MEDIEVAL_LAYOUT.half, HALF);
  assert.equal(MEDIEVAL_LAYOUT.size, HALF * 2);
  // 5.06x the area of the 400m vale this grew out of.
  assert.ok(Math.abs((MEDIEVAL_LAYOUT.size ** 2) / 400 ** 2 - 5.0625) < 1e-9);
});

test('the world publishes bounds that match HALF exactly', () => {
  const w = new MedievalWorld({});
  assert.equal(w.bounds.min.x, -HALF);
  assert.equal(w.bounds.max.x, HALF);
  assert.equal(w.bounds.min.z, -HALF);
  assert.equal(w.bounds.max.z, HALF);
});

/* ------------------------------------------------------------------ */
/* Terrain job                                                         */
/* ------------------------------------------------------------------ */

test('the terrain job keeps the 2m grid rather than stretching the cells', () => {
  const job = MEDIEVAL_LAYOUT.terrainJob;
  assert.equal(job.size, MEDIEVAL_LAYOUT.size);
  assert.equal(job.originX, -HALF);
  assert.equal(job.originZ, -HALF);
  assert.equal(job.seg, MEDIEVAL_LAYOUT.terrainSeg);
  /* The grid SPACING is the invariant, not the segment count. 2m is what the
   * collision heightfield needs to describe ground a capsule can stand on
   * without staircasing - a stretched cell is a player floating or clipping. */
  assert.equal(job.size / job.seg, MEDIEVAL_LAYOUT.terrainStep);
  assert.equal(MEDIEVAL_LAYOUT.terrainStep, 2);
  assert.equal(job.seg, 450);
});

test('TerrainJob actually produces the grid the world asks for', () => {
  const { buffers } = sampleTerrain(MEDIEVAL_LAYOUT.terrainJob);
  assert.equal(buffers.nx, 451);
  assert.equal(buffers.nz, 451);
  assert.equal(buffers.heights.length, 451 * 451);
  assert.equal(buffers.step, 2);

  /* 451^2 = 203,401 vertices. A Uint16 index buffer tops out at 65,535, so a
   * job that silently narrowed its index type would fold the far three
   * quarters of the terrain back onto the near quarter. */
  assert.equal(buffers.indices.constructor, Uint32Array);
  assert.ok(buffers.nx * buffers.nz - 1 > 65535);
  assert.equal(buffers.indices.length, 450 * 450 * 6);
  for (let i = 0; i < buffers.indices.length; i++) {
    assert.ok(buffers.indices[i] < buffers.nx * buffers.nz, `index ${i} out of range`);
  }

  // The mesh has to reach the published bounds, not stop short of them.
  const last = 451 * 451 - 1;
  assert.equal(buffers.positions[0], -HALF);
  assert.equal(buffers.positions[2], -HALF);
  assert.equal(buffers.positions[last * 3], HALF);
  assert.equal(buffers.positions[last * 3 + 2], HALF);

  // And the heights it ships must be the same function the props are placed on.
  for (const [x, z] of [[-HALF, -HALF], [0, 0], [HALF, HALF], [-200, 120], [300, -410]]) {
    const i = Math.round((x + HALF) / 2);
    const j = Math.round((z + HALF) / 2);
    assert.ok(Math.abs(buffers.heights[j * 451 + i] - medievalHeight(x, z)) < 1e-6);
  }
});

/* ------------------------------------------------------------------ */
/* Containment                                                         */
/* ------------------------------------------------------------------ */

test('the containment walls fence the new rim, not the old one', () => {
  const walls = MEDIEVAL_LAYOUT.walls;
  assert.equal(walls.length, 4);
  for (const [cx, , cz, hx, , hz] of walls) {
    const acrossC = Math.abs(cx) > Math.abs(cz) ? Math.abs(cx) : Math.abs(cz);
    const acrossH = Math.abs(cx) > Math.abs(cz) ? hx : hz;
    const alongH = Math.abs(cx) > Math.abs(cz) ? hz : hx;
    /* The wall STRADDLES the rim: centre 1m inside, 2m thick, so it spans
     * HALF-3 to HALF+1. That 3m of overlap is what the player's capsule stops
     * against - a wall whose inner face sat exactly on HALF would let the
     * capsule's own radius hang over ground that has already stopped. The
     * relationship to the rim is the invariant; the absolute number is not. */
    assert.equal(acrossC, HALF - 1, `a wall at (${cx}, ${cz}) is not 1m inside the rim`);
    assert.equal(acrossH, 2, 'wall thickness changed');
    assert.equal(acrossC + acrossH, HALF + 1, 'the wall no longer reaches past the rim');
    // And it spans the whole side, or the four corners leak.
    assert.equal(alongH, HALF, `a wall at (${cx}, ${cz}) does not span the full side`);
  }
  const xs = walls.map((w) => w[0]).sort((a, b) => a - b);
  const zs = walls.map((w) => w[2]).sort((a, b) => a - b);
  assert.deepEqual(xs, [-(HALF - 1), 0, 0, HALF - 1]);
  assert.deepEqual(zs, [-(HALF - 1), 0, 0, HALF - 1]);
});

test('_inPlayfield tracks HALF', () => {
  const w = new MedievalWorld({});
  assert.equal(w._inPlayfield(HALF - 1, 0), true);
  assert.equal(w._inPlayfield(HALF + 1, 0), false);
  assert.equal(w._inPlayfield(0, -(HALF - 1)), true);
  assert.equal(w._inPlayfield(0, -(HALF + 1)), false);
  // Inset is metres off each side, not a fraction.
  assert.equal(w._inPlayfield(HALF - 3, 0, 5), false);
  assert.equal(w._inPlayfield(HALF - 7, 0, 5), true);
});

/* ------------------------------------------------------------------ */
/* Distant skirt                                                       */
/* ------------------------------------------------------------------ */

test('the skirt starts under the playfield and ends at the far plane', () => {
  // Inside the square, or its inner rings would poke out past the rim with
  // only 2.5cm of clearance to hide them.
  assert.ok(MEDIEVAL_LAYOUT.skirtInner < HALF,
    'the skirt starts outside the playfield - its inner ring would be visible');
  assert.ok(HALF - MEDIEVAL_LAYOUT.skirtInner >= 10);
  /* The outer radius is deliberately NOT derived from HALF: it is set by the
   * 2km camera far plane, and that did not change when the vale got wider. */
  assert.equal(MEDIEVAL_LAYOUT.skirtOuter, 1928);
  assert.ok(MEDIEVAL_LAYOUT.skirtOuter < 2000);
  assert.ok(MEDIEVAL_LAYOUT.skirtOuter > HALF * Math.SQRT2,
    'the skirt stops inside the playfield corner');
});

test('the skirt height meets the terrain at the rim with no step', () => {
  const w = new MedievalWorld({});
  /* The whole reason `_outerHeight` blends rather than switches: a visible
   * step at the seam is a dark hairline ruled across the horizon in every
   * elevated framing. Blend start is HALF - 5, so anywhere at or inside that
   * the skirt is the terrain minus the 2.5cm clearance. */
  for (const [x, z] of [[HALF - 6, 0], [0, HALF - 6], [-(HALF - 6), 0], [0, -(HALF - 6)]]) {
    assert.ok(Math.abs(w._outerHeight(x, z) - (w._height(x, z) - 0.025)) < 1e-9,
      `skirt does not match terrain at (${x}, ${z})`);
  }
  // And at the rim itself the disagreement is still far under a centimetre.
  for (const [x, z] of [[HALF, 0], [0, HALF], [-HALF, 0], [0, -HALF]]) {
    assert.ok(Math.abs(w._outerHeight(x, z) - w._height(x, z)) < 0.1,
      `a ${Math.abs(w._outerHeight(x, z) - w._height(x, z)).toFixed(3)}m seam step at (${x}, ${z})`);
  }
});

test('the near/far blend sits where it always sat, relative to the rim', () => {
  /* The blend edges used to be the literals 195 and 320 against HALF = 200.
   * They are now `HALF - 5` and `HALF * 1.6`, and what has to be preserved is
   * not a metre count but the geometry:
   *
   *   - It has NOT started at the mid-edge rim. That is where the seam is a
   *     900m straight line viewed edge-on from the ramparts, and any blend
   *     there is a value step ruled across the horizon.
   *   - It has finished by `HALF * 1.6`, comfortably past the corner radius of
   *     `HALF * sqrt(2)` = 1.414 HALF.
   *   - At the corner itself it is part-way, exactly as it always was. That
   *     is a real (pre-existing) property of a polar skirt under a square
   *     playfield, not something this change introduced, and pinning it here
   *     is what would catch a future edit that quietly moved it.
   */
  const corner = HALF * Math.SQRT2;
  assert.ok(HALF * 1.6 > corner, 'the blend outer edge is inside the playfield corner');
  assert.equal(smoothstep(HALF - 5, HALF * 1.6, HALF - 6), 0,
    'the blend has already started before the rim - the seam will show a step');
  assert.equal(smoothstep(HALF - 5, HALF * 1.6, HALF * 1.6), 1);
  // The 400m vale ran this at smoothstep(195, 320, 283) = 0.789.
  const t = smoothstep(HALF - 5, HALF * 1.6, corner);
  assert.ok(Math.abs(t - 0.789) < 0.02,
    `the corner seam behaves differently to the 400m vale: ${t.toFixed(3)} vs 0.789`);
});

/* ------------------------------------------------------------------ */
/* Grass zones                                                         */
/* ------------------------------------------------------------------ */

test('grass zones keep the 50m cell that GRASS_HIDE_DISTANCE assumes', () => {
  assert.equal(MEDIEVAL_LAYOUT.grassZoneMetres, 50);
  assert.equal(MEDIEVAL_LAYOUT.grassZones, 18);
  assert.equal(MEDIEVAL_LAYOUT.size / MEDIEVAL_LAYOUT.grassZones, 50);
  /* This is the load-bearing property. A 50m cell has a ~35m bounding-sphere
   * radius, so "nearest point of the sphere beyond 86m" proves every blade in
   * the zone is past the 58-86m height fade and hiding the zone cannot change
   * a pixel. Fixing the COUNT at 8x8 instead would have stretched the cell to
   * 112m and quietly destroyed that argument. */
  const src = read('src/worlds/MedievalWorld.js');
  const hide = Number(/const GRASS_HIDE_DISTANCE = (\d+)/.exec(src)[1]);
  const sphereR = (MEDIEVAL_LAYOUT.grassZoneMetres * Math.SQRT2) / 2;
  assert.ok(sphereR * 2 < hide,
    `a ${MEDIEVAL_LAYOUT.grassZoneMetres}m zone cannot be proved fully past the ${hide}m fade`);
});

/* ------------------------------------------------------------------ */
/* Aerial perspective                                                  */
/* ------------------------------------------------------------------ */

test('the fog reaches the rim instead of saturating a third of the way to it', () => {
  /* Linear fog is two numbers and they are the entire depth cascade, so they
   * are an extent-derived quantity exactly like the wall coordinates above -
   * and they fail the same way, silently. 96 / 560 was right for a 400 m vale
   * whose far corner was 283 m; against a 636 m corner it put everything past
   * 424 m - the outer third of the radius, 60% of the AREA, and all four of
   * the ring's landforms - at 70-100% haze.
   *
   * What is pinned here is the shape, not the pair: the near field must be
   * where it was tuned, the playfield corner must still read, and the far side
   * of the map must be the first thing to go. */
  const src = read('src/worlds/MedievalWorld.js');
  const near = Number(/const FOG_NEAR = ([\d.]+)/.exec(src)[1]);
  const far = Number(/const FOG_FAR = ([\d.]+)/.exec(src)[1]);
  const haze = (d) => Math.min(1, Math.max(0, (d - near) / (far - near)));
  const corner = MEDIEVAL_LAYOUT.half * Math.SQRT2;

  // The keep stands ~110 m from the village approach and was tuned to a 3%
  // veil there. That composition did not change when the map grew.
  assert.ok(Math.abs(haze(110) - 0.030) < 0.006,
    `the keep now takes ${(haze(110) * 100).toFixed(1)}% haze instead of 3%`);
  // The playfield corner has to be legible - deep aerial perspective, not gone.
  assert.ok(haze(corner) > 0.55 && haze(corner) < 0.80,
    `the ${corner.toFixed(0)} m corner sits at ${(haze(corner) * 100).toFixed(0)}% haze`);
  // Nothing inside the playfield may be fully saturated except the far rim.
  assert.equal(haze(MEDIEVAL_LAYOUT.half), haze(MEDIEVAL_LAYOUT.half));
  assert.ok(haze(MEDIEVAL_LAYOUT.half) < 0.5,
    'the rim mid-edge is already past half haze seen from the middle of the map');
  assert.ok(far >= MEDIEVAL_LAYOUT.size * 0.9 && far <= MEDIEVAL_LAYOUT.size * 1.1,
    `fogFar ${far} is not scaled to the ${MEDIEVAL_LAYOUT.size} m rim-to-rim sightline`);
  // ...and the distant skirt must still saturate long before its outer ring,
  // or it stops landing on the sky dome's horizon colour. See the dome shader.
  assert.equal(haze(MEDIEVAL_LAYOUT.skirtOuter), 1);
  assert.ok(far < MEDIEVAL_LAYOUT.skirtOuter * 0.55);

  // The skirt's own value ramp is derived from the fog run rather than being a
  // second copy of it.
  assert.ok(/HALF \+ \(FOG_FAR - FOG_NEAR\)/.test(src),
    'the skirt value ramp no longer tracks the fog it dissolves into');
});

/* ------------------------------------------------------------------ */
/* Auto-scaling systems downstream                                     */
/* ------------------------------------------------------------------ */

test('Relics and Caches scale themselves off the published bounds', () => {
  /* Neither system is edited by this change; both read `world.bounds`. This
   * asserts they land somewhere sane rather than that they were touched -
   * a 900m vale with the 400m vale's thirty relics is a mechanic the player
   * stops noticing exists. */
  const relics = read('src/systems/Relics.js');
  const perWorld = Number(/const PER_WORLD = (\d+)/.exec(relics)[1]);
  const baseExtent = Number(/const BASE_EXTENT = (\d+)/.exec(relics)[1]);
  const maxPerWorld = Number(/const MAX_PER_WORLD = (\d+)/.exec(relics)[1]);
  const edgeInset = Number(/const EDGE_INSET = (\d+)/.exec(relics)[1]);
  const rExtent = MEDIEVAL_LAYOUT.size - 2 * edgeInset;
  const areaScale = Math.min(maxPerWorld / perWorld, (rExtent / baseExtent) ** 2);
  assert.equal(Math.round(perWorld * Math.max(1, areaScale)), maxPerWorld,
    'the medieval vale no longer saturates the relic cap');

  const caches = read('src/systems/Caches.js');
  const high = Number(/const PER_WORLD = \{ sunken: \d+, high: (\d+) \}/.exec(caches)[1]);
  const wanted = Math.min(12, Math.max(high, Math.round(high * (MEDIEVAL_LAYOUT.size / 400) ** 1.5)));
  assert.equal(wanted, 10);
});

/* ------------------------------------------------------------------ */
/* The literal sweep                                                   */
/* ------------------------------------------------------------------ */

/** Source with comments and string/template literals removed. */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

test('NO 400m-vale literal survives anywhere in the medieval source', () => {
  /* Every one of these was a hard-coded extent in the 400m build: the width
   * itself, the four inset scatter spans, the containment wall coordinate,
   * the skirt's inner radius and its two blend edges, the backdrop ring radii
   * and the playfield's corner radius. Any of them reappearing is a number
   * that will not follow `HALF` the next time the vale is resized, and every
   * one of them fails silently.
   *
   * Comments are stripped first, because the comments legitimately talk about
   * where these numbers came from and that history is worth keeping. */
  const forbidden = ['400', '392', '388', '380', '199', '188', '195', '430', '208', '358', '283'];
  const files = [
    'src/worlds/MedievalWorld.js',
    'src/worlds/terrain/MedievalHeight.js',
    'src/worlds/medieval/Settlements.js',
    'src/worlds/medieval/GridIndex.js',
  ];
  const offenders = [];
  for (const f of files) {
    const code = codeOnly(read(f));
    for (const lit of forbidden) {
      const re = new RegExp(`(?<![\\w.])${lit}(?![\\w.])`, 'g');
      let m;
      while ((m = re.exec(code))) {
        const line = code.slice(0, m.index).split('\n').length;
        offenders.push(`${f}:${line} -> ${lit} in "${code.slice(Math.max(0, m.index - 50), m.index + 20).replace(/\s+/g, ' ').trim()}"`);
      }
    }
  }
  assert.deepEqual(offenders, [], `hard-coded extents:\n${offenders.join('\n')}`);
});

test('the terrain job, the walls and the grass grid are read from one place', () => {
  /* Publishing `MEDIEVAL_LAYOUT` is only worth anything if the build consumes
   * it. If `_buildTerrain` went back to spelling the job out inline, this test
   * would keep passing on a layout object nothing uses. */
  const code = codeOnly(read('src/worlds/MedievalWorld.js'));
  assert.ok(/genPool\.run\('terrain', MEDIEVAL_LAYOUT\.terrainJob\)/.test(read('src/worlds/MedievalWorld.js')),
    '_buildTerrain no longer submits MEDIEVAL_LAYOUT.terrainJob');
  assert.ok(/for \(const w of MEDIEVAL_LAYOUT\.walls\)/.test(code),
    'the containment walls are no longer built from MEDIEVAL_LAYOUT.walls');
  /* The grass grid is now built lazily per zone (see `GrassResidency`), so
   * the consumer is the residency constructor rather than a loop bound - but
   * the property being pinned is unchanged: the zone COUNT is derived from
   * the extent, and the 50 m cell is what survives a resize. */
  assert.ok(/zones: MEDIEVAL_LAYOUT\.grassZones/.test(code)
    && /zoneMetres: MEDIEVAL_LAYOUT\.grassZoneMetres/.test(code),
    'the grass grid no longer reads MEDIEVAL_LAYOUT.grassZones / grassZoneMetres');
});
