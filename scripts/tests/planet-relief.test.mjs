import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { planetHeight, LANDFORM_KINDS } from '../../src/worlds/terrain/PlanetHeight.js';
import { HEIGHT_FIELDS } from '../../src/worlds/terrain/index.js';
import { definePlanet } from '../../src/worlds/planets/PlanetDescriptor.js';
import { PLANETS, VOLCANIC } from '../../src/worlds/planets/index.js';
import { scatter, polyDist, slopeDegAt } from '../../src/worlds/planets/Placement.js';
import { SKIRT, discRadiusAt, bodyGeometry } from '../../src/worlds/planets/PlanetLiquid.js';

/**
 * IS CINDER A PLACE, OR IS IT A BIG EMPTY?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS FILE EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Citadel's Drop Three expanded a playfield without authoring relief into it
 * and shipped a flat nothing that every geometry test passed. The fix was an
 * authored landform vocabulary with a MEASURED slope and relief distribution,
 * and the lesson recorded was that "the terrain is 800 m across" and "there is
 * something to walk to" are unrelated claims.
 *
 * So the load-bearing case in this file is not the relief RANGE - a single
 * mountain gives you that and leaves 90% of the map a car park. It is the
 * distribution of relief inside a 50 m window, which is the scale at which a
 * player decides whether anywhere is worth walking to, reported against a
 * ceiling obtained by DELETING every landform and re-measuring the noise on its
 * own. If the authored terrain is not decisively above that, the vocabulary is
 * not doing anything and this planet is fbm with a good palette.
 *
 * The rest pins the promises the descriptor makes: a pad is flat, a road is
 * walkable, a shoreline is a shoreline, every deposit that was asked for was
 * placed, and the whole thing is the same every session.
 *
 * Nothing here needs a renderer. It runs against the pure height field, which
 * is the same function the worker samples and the same one the collider is cut
 * from - `planet-reach.test.mjs` proves that identity over the real colliders.
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ONE PLANET OR TEN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This file was written when Cinder was the only planet, and most of what it
 * measures is a promise EVERY descriptor makes: a pad is flat, a road is
 * walkable, a shoreline is a shoreline, every deposit asked for was placed,
 * nothing is NaN. Nine more planets shipped afterwards with none of that
 * checked, so those cases now iterate `PLANETS` - the registry itself, not a
 * list copied out of it, so an eleventh planet is covered the day it is
 * registered.
 *
 * What stays on Cinder is stated at each case, and it is always one of two
 * things: a floor calibrated to Cinder's own scale (a shield volcano's 90 m of
 * relief is not a claim about an acid-lake basin), or a fact about Cinder's own
 * contents (its landform vocabulary, its sulfur corridor).
 */

/** Every planet the game registers, in registry order. */
const ALL = Object.values(PLANETS);

const P = VOLCANIC;
const H = HEIGHT_FIELDS.planet(P.terrain);
const HALF = P.half;
const CELL = (HALF * 2) / P.seg;

/* ------------------------------------------------------------------ */
/* Shared sampling                                                     */
/* ------------------------------------------------------------------ */

/** The full terrain grid, sampled once and reused by every case below. */
function grid(height, seg = P.seg, half = HALF) {
  const n = seg + 1;
  const step = (half * 2) / seg;
  const h = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    const z = -half + j * step;
    for (let i = 0; i < n; i++) h[j * n + i] = height(-half + i * step, z);
  }
  return { h, n, step };
}

const G = grid(H);

/**
 * One height field and one build grid per planet, sampled once and shared by
 * every case below. Ten grids is 660,000 samples and about half a second; ten
 * cases each building their own would be ten times that.
 */
/**
 * The two scatter streams a planet's world actually runs, memoised.
 *
 * `PlanetWorld._buildProps` walks the props from `(terrain.seed ?? 1) ^ 0x7f4a`
 * and `_buildMinerals` walks the minerals from `(terrain.seed ?? 1) ^ 0x1d0e`,
 * each advancing one LCG step per field. THREE cases below need those exact
 * layouts and each one used to re-roll them; ten planets makes that four
 * seconds of repeated work. Rolled once here, and - because it is the world's
 * seeding rather than a re-derivation - what every case measures is the layout
 * the game builds.
 */
const _fields = new Map();
function fields(planet) {
  let f = _fields.get(planet.id);
  if (!f) {
    const { H: h, HALF: half, CELL: cell } = sampled(planet);
    f = { props: [], minerals: [] };
    for (const [key, list, salt] of [['props', planet.props ?? [], 0x7f4a], ['minerals', planet.minerals, 0x1d0e]]) {
      let seed = (planet.terrain.seed ?? 1) ^ salt;
      for (const spec of list) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        f[key].push({
          spec,
          res: scatter({
            region: spec.region, count: spec.count, spacing: spec.spacing ?? 0, seed,
            height: h, half, slopeStep: cell, liquid: planet.liquid, landing: planet.landing,
          }),
        });
      }
    }
    _fields.set(planet.id, f);
  }
  return f;
}

const _sampled = new Map();
function sampled(planet) {
  let s = _sampled.get(planet.id);
  if (!s) {
    const h = HEIGHT_FIELDS.planet(planet.terrain);
    s = {
      P: planet,
      H: h,
      HALF: planet.half,
      CELL: (planet.half * 2) / planet.seg,
      G: grid(h, planet.seg, planet.half),
    };
    _sampled.set(planet.id, s);
  }
  return s;
}

/** Slope in degrees at every interior grid node, measured over the cell. */
function slopes(g) {
  const out = [];
  for (let j = 1; j < g.n - 1; j++) {
    for (let i = 1; i < g.n - 1; i++) {
      const dx = (g.h[j * g.n + i + 1] - g.h[j * g.n + i - 1]) / (2 * g.step);
      const dz = (g.h[(j + 1) * g.n + i] - g.h[(j - 1) * g.n + i]) / (2 * g.step);
      out.push((Math.atan(Math.hypot(dx, dz)) * 180) / Math.PI);
    }
  }
  out.sort((a, b) => a - b);
  return out;
}

/** Max minus min inside every 50 m window, on a half-window stride. */
function localRelief(g, metres = 50) {
  const w = Math.round(metres / g.step);
  const stride = Math.max(1, Math.floor(w / 2));
  const out = [];
  for (let j = 0; j + w < g.n; j += stride) {
    for (let i = 0; i + w < g.n; i += stride) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let b = 0; b <= w; b++) {
        for (let a = 0; a <= w; a++) {
          const y = g.h[(j + b) * g.n + i + a];
          if (y < lo) lo = y;
          if (y > hi) hi = y;
        }
      }
      out.push(hi - lo);
    }
  }
  out.sort((a, b) => a - b);
  return out;
}

const pct = (sorted, t) => sorted[Math.min(sorted.length - 1, Math.floor(t * sorted.length))];

/* ================================================================== */
/* 1. The descriptor refuses the things that ship silently            */
/* ================================================================== */

function base(over = {}) {
  return {
    id: 'probe', name: 'Probe', half: 200, seg: 64, gravity: 9,
    terrain: { seed: 1, baseY: 0, landforms: [{ kind: 'pad', x: 0, z: 0, r: 20 }] },
    palette: { material: 'dirt.ground', tile: 4, bands: [{ upTo: 0, color: 0x111111 }, { upTo: 50, color: 0x222222 }] },
    sky: { kind: 'daylight' },
    /* A whole mineral row, because the schema now requires one: an ore has
     * an item, a rarity, a terrain, a named place and a per-cubic-metre
     * value, and `credits` is derived from the last two rather than
     * authored. See src/worlds/planets/PlanetDescriptor.js. */
    minerals: [{
      id: 'x', item: 'x_ore', name: 'X', rarity: 'common', terrain: 'plain', place: 'Nowhere',
      color: 1, unitValue: 2, size: 1, count: 1, region: { shape: 'field' },
    }],
    landing: [{ id: 'a', name: 'A', x: 0, z: 0, r: 20, primary: true }],
    ...over,
  };
}

test('definePlanet accepts a minimal well-formed planet', () => {
  const d = definePlanet(base());
  assert.equal(d.id, 'probe');
  assert.equal(d.spawn.site, 'a');
  assert.equal(d.terrain.half, 200, 'terrain.half is filled in from the descriptor half');
});

test('a landing site with no pad landform is REFUSED', () => {
  /* The exact shape of "built but not reachable", caught before it can be
   * built: a site record is a promise, and a promise with no `pad` behind it
   * puts a ship down on a 30-degree flank. */
  assert.throws(
    () => definePlanet(base({ landing: [{ id: 'a', name: 'A', x: 90, z: 90, r: 20, primary: true }] })),
    /has no matching pad landform/
  );
});

test('a landing site larger than its pad is REFUSED', () => {
  assert.throws(
    () => definePlanet(base({ landing: [{ id: 'a', name: 'A', x: 0, z: 0, r: 40, primary: true }] })),
    /claims r=40 but its pad levels only r=20/
  );
});

test('a descriptor that is not plain data is REFUSED', () => {
  /* A closure clones to `undefined` across `postMessage` and the worker builds
   * a flat plain with nothing in the console. Caught at definition time. */
  assert.throws(
    () => definePlanet(base({ terrain: { seed: 1, landforms: [], shape: (x) => x } })),
    /may only hold plain data/
  );
  assert.throws(
    () => definePlanet(base({ terrain: { seed: 1, baseY: NaN, landforms: [] } })),
    /non-finite/
  );
});

test('an unknown landform kind is REFUSED by both the schema and the field', () => {
  assert.throws(() => definePlanet(base({
    terrain: { seed: 1, landforms: [{ kind: 'butte', x: 0, z: 0, r: 10 }] },
  })), /unknown/);
  assert.throws(() => planetHeight({ half: 100, landforms: [{ kind: 'butte' }] }), /unknown landform kind/);
});

test('exactly one primary landing site, and ascending colour bands', () => {
  assert.throws(() => definePlanet(base({
    landing: [
      { id: 'a', name: 'A', x: 0, z: 0, r: 20, primary: true },
      { id: 'b', name: 'B', x: 0, z: 0, r: 20, primary: true },
    ],
  })), /exactly one landing site must be primary, found 2/);
  assert.throws(() => definePlanet(base({
    palette: { bands: [{ upTo: 40, color: 1 }, { upTo: 10, color: 2 }] },
  })), /must ascend/);
});

test('a planet with nothing to mine and a planet you cannot land on are REFUSED', () => {
  assert.throws(() => definePlanet(base({ minerals: [] })), /nothing to mine/);
  assert.throws(() => definePlanet(base({ landing: [] })), /skybox/);
});

/* ================================================================== */
/* 2. The field is a function, and it is finite                       */
/* ================================================================== */

test('every height field is deterministic to the bit', () => {
  /* ALL TEN. The worker resolves the field by NAME and rebuilds it from the
   * descriptor's params; the main thread builds its own. Two factories over
   * one descriptor have to produce identical numbers or the mesh and the
   * collider are two different surfaces - and that is true of every planet,
   * not of the one this file was written for.
   *
   * Two digests are printed per planet and neither is pinned to a literal:
   * these worlds are being authored, and a hash that has to be edited on every
   * tuning pass is a hash nobody reads. What IS pinned is the agreement. */
  console.log('   DETERMINISM (two independent factories over one descriptor, 201x201 samples each)');
  const seen = new Map();
  for (const planet of ALL) {
    const a = HEIGHT_FIELDS.planet(planet.terrain);
    const b = HEIGHT_FIELDS.planet(planet.terrain);
    const half = planet.half;
    const out = [];
    for (let j = 0; j <= 200; j++) {
      for (let i = 0; i <= 200; i++) {
        const x = -half + (i / 200) * half * 2;
        const z = -half + (j / 200) * half * 2;
        const va = a(x, z);
        assert.equal(va, b(x, z), `${planet.id}: two factories disagree at (${x}, ${z})`);
        out.push(va);
      }
    }
    const digest = createHash('sha256').update(Buffer.from(new Float64Array(out).buffer)).digest('hex');
    console.log(`     ${planet.id.padEnd(11)} 201x201 digest ${digest.slice(0, 16)}`);
    /* And no two planets are the same ground with a different palette. That is
     * the one thing a digest can say cheaply that nothing else here can. */
    const twin = seen.get(digest);
    assert.ok(!twin, `${planet.id} and ${twin} sample the SAME height field - one of them is a recolour`);
    seen.set(digest, planet.id);
  }
});

test('no sample on any planet is non-finite - NaN reaches the shader as a black frame', () => {
  /* ALL TEN, and this is the cheapest gate in the project as well as the one
   * that costs the most when it is missing.
   *
   * Not a paranoid case. Four boxes with a zero tile gave NaN uvs in this repo
   * and 19 NaN pixels blacked out 921,600 through the bloom pass - flooding
   * ambient 27x moved the mean luminance by 0.07, because there was no image to
   * brighten. A descriptor is data: a zero radius, a zero width, a taper of
   * exactly 1 or a degenerate polyline would DIVIDE here, not throw, and nine
   * of these ten descriptors have never been sampled by anything but the game.
   *
   * Checked on the build grid AND on a 4x finer one, because a NaN that happens
   * to fall between two grid samples still gets drawn, AND on the exact centres
   * of every landform, where the radial terms divide by zero if they are going
   * to. `PlanetWorld._buildTerrain` throws on a non-finite min/max at build
   * time, so this is the same gate moved to where it names the planet. */
  console.log('   FINITENESS (floor: zero non-finite samples, on every planet)');
  let total = 0;
  for (const planet of ALL) {
    const { H: h, G: g } = sampled(planet);
    let bad = 0;
    for (let k = 0; k < g.h.length; k++) if (!Number.isFinite(g.h[k])) bad++;
    assert.equal(bad, 0, `${planet.id}: ${bad} non-finite samples on the build grid`);

    const fine = grid(h, planet.seg * 2, planet.half);
    let badFine = 0;
    for (let k = 0; k < fine.h.length; k++) if (!Number.isFinite(fine.h[k])) badFine++;
    assert.equal(badFine, 0, `${planet.id}: ${badFine} non-finite samples on the ${(fine.step).toFixed(2)} m grid`);

    let origins = 0;
    for (const f of planet.terrain.landforms) {
      const pts = f.pts ?? [[f.x, f.z]];
      for (const [x, z] of pts) {
        origins++;
        assert.ok(Number.isFinite(h(x, z)), `${planet.id}: ${f.kind} at (${x}, ${z}) samples non-finite`);
      }
    }
    const n = g.h.length + fine.h.length + origins;
    total += n;
    console.log(`     ${planet.id.padEnd(11)} finite at ${n.toLocaleString().padStart(9)} samples`
      + ` (${g.step.toFixed(2)} m and ${fine.step.toFixed(2)} m grids, ${origins} landform origins)`);
  }
  console.log(`   ${total.toLocaleString()} samples across the registry, none non-finite`);
});

/* ================================================================== */
/* 3. RELIEF - the Drop Three case                                    */
/* ================================================================== */

test('Cinder has authored relief, not fbm with a palette', () => {
  /* CINDER ONLY, and the floors are why. 90 m of range is a claim about a
   * SHIELD VOLCANO - the caldera has to be a landmark from the far corner -
   * and Sallow, an acid-lake basin with fumarole fields, measures 76.4 m and is
   * not wrong for it. The generalised version of this case is below, and it
   * keeps the part of the claim that is about AUTHORSHIP rather than about
   * scale. */
  let min = Infinity;
  let max = -Infinity;
  for (let k = 0; k < G.h.length; k++) {
    if (G.h[k] < min) min = G.h[k];
    if (G.h[k] > max) max = G.h[k];
  }
  const sl = slopes(G);
  const lr = localRelief(G, 50);

  /* THE CEILING, BY ABLATION.
   *
   * The same field with every landform record deleted: the base plain's swells,
   * ripples and grain and nothing else. This is what "make the map bigger and
   * turn the noise up" produces, and it is the thing Drop Three shipped. */
  const bare = planetHeight({ ...P.terrain, landforms: [] });
  const bareG = grid(bare);
  const bareLr = localRelief(bareG, 50);
  const bareSl = slopes(bareG);
  let bmin = Infinity;
  let bmax = -Infinity;
  for (let k = 0; k < bareG.h.length; k++) {
    if (bareG.h[k] < bmin) bmin = bareG.h[k];
    if (bareG.h[k] > bmax) bmax = bareG.h[k];
  }

  console.log('   RELIEF, over 66,049 samples of an 800 m map (3.125 m cell)');
  console.log(`     total range        floor  90.0 m   achieved ${(max - min).toFixed(1)} m`
    + `   ceiling by ablation ${(bmax - bmin).toFixed(1)} m   [${min.toFixed(1)} .. ${max.toFixed(1)}]`);
  console.log(`     50 m window p10    floor   2.0 m   achieved ${pct(lr, 0.1).toFixed(1)} m`
    + `   ceiling by ablation ${pct(bareLr, 0.1).toFixed(1)} m`);
  console.log(`     50 m window p50    floor  10.0 m   achieved ${pct(lr, 0.5).toFixed(1)} m`
    + `   ceiling by ablation ${pct(bareLr, 0.5).toFixed(1)} m`);
  console.log(`     50 m window p90              -     achieved ${pct(lr, 0.9).toFixed(1)} m`
    + `   ceiling by ablation ${pct(bareLr, 0.9).toFixed(1)} m`);
  console.log(`     50 m window max              -     achieved ${lr[lr.length - 1].toFixed(1)} m`
    + `   ceiling by ablation ${bareLr[bareLr.length - 1].toFixed(1)} m`);
  console.log('   SLOPE, degrees');
  console.log(`     p10 ${pct(sl, 0.1).toFixed(1)}   p50 ${pct(sl, 0.5).toFixed(1)}`
    + `   p75 ${pct(sl, 0.75).toFixed(1)}   p90 ${pct(sl, 0.9).toFixed(1)}`
    + `   p99 ${pct(sl, 0.99).toFixed(1)}   max ${sl[sl.length - 1].toFixed(1)}`
    + `   (noise alone: p50 ${pct(bareSl, 0.5).toFixed(1)}, max ${bareSl[bareSl.length - 1].toFixed(1)})`);
  const frac = (t) => (sl.filter((s) => s <= t).length / sl.length) * 100;
  console.log(`     walkable: ${frac(24).toFixed(1)}% at or under 24 deg, ${frac(38).toFixed(1)}% under 38,`
    + ` ${(100 - frac(50)).toFixed(1)}% over 50 (cliff)`);

  /* The floors. Each one is a claim about the PLAYER's experience, not about
   * the numbers: 90 m of range so the caldera is a landmark from the far
   * corner; 10 m in the median 50 m window so a walk in any direction crosses
   * something; 2 m at p10 so even the flattest tenth of the map is not a table.
   *
   * Deliberately well under what is achieved. A floor set at the measurement is
   * a change detector, and this is a design constraint. */
  assert.ok(max - min >= 90, `total relief ${(max - min).toFixed(1)} m`);
  assert.ok(pct(lr, 0.5) >= 10, `median 50 m relief ${pct(lr, 0.5).toFixed(1)} m - the map is a car park`);
  assert.ok(pct(lr, 0.1) >= 2.0, `p10 50 m relief ${pct(lr, 0.1).toFixed(1)} m`);
  // And the ablation has to be decisively worse, or the landforms are decoration.
  assert.ok(pct(lr, 0.5) > pct(bareLr, 0.5) * 3,
    `authored median relief ${pct(lr, 0.5).toFixed(1)} m is not 3x the noise-only ${pct(bareLr, 0.5).toFixed(1)} m`);

  // Enough of the map has to be walkable for it to be a place you explore.
  assert.ok(frac(38) >= 60, `only ${frac(38).toFixed(1)}% of the map is under 38 deg`);
  // ...and enough of it steep, or "volcanic" is a colour choice.
  assert.ok(100 - frac(50) >= 3, `only ${(100 - frac(50)).toFixed(1)}% of the map is cliff`);
});

test('every planet is authored ground, and every planet is walkable', () => {
  /* ALL TEN, with the two floors that are claims about AUTHORSHIP rather than
   * about a volcano's scale.
   *
   *   THE LANDFORMS DO THE WORK. Each planet's median 50 m relief against the
   *   SAME field with every landform record deleted. That ablation is what
   *   "make the map bigger and turn the noise up" produces, and it is what
   *   Citadel's Drop Three shipped. A ratio near 1 means the vocabulary is
   *   decoration and the planet is fbm with a good palette.
   *
   *   IT IS A PLACE YOU CAN WALK. 60% of the map inside the 38 degree envelope
   *   `planet-reach.test.mjs` floods at. Under that, the ore may all be placed
   *   and none of it reachable.
   *
   * Everything else here is REPORTED, not asserted, and Cinder's own floors are
   * printed beside it so a shrinking number is visible long before it is a
   * failure. The p10 column is the reason: Cathedra's is 0.7 m because the
   * Pavement is a shattered PLATE and a plate is flat - Cinder's 2.0 m floor
   * would fail it for being the thing it was authored to be. */
  console.log('   AUTHORED RELIEF ACROSS THE REGISTRY');
  console.log('     planet       range     50 m p10   50 m p50   noise p50   authored/noise   walkable   cliff');
  console.log(`     ${'(Cinder floors)'.padEnd(12)} >= 90 m       >= 2.0     >= 10.0           -            >= 3.0x     >= 60%    >= 3%`);
  const rows = [];
  for (const planet of ALL) {
    const { G: g } = sampled(planet);
    let min = Infinity;
    let max = -Infinity;
    for (let k = 0; k < g.h.length; k++) {
      if (g.h[k] < min) min = g.h[k];
      if (g.h[k] > max) max = g.h[k];
    }
    const lr = localRelief(g, 50);
    const sl = slopes(g);
    const bareLr = localRelief(grid(planetHeight({ ...planet.terrain, landforms: [] }), planet.seg, planet.half), 50);
    const ratio = pct(lr, 0.5) / Math.max(1e-9, pct(bareLr, 0.5));
    const frac = (t) => (sl.filter((x) => x <= t).length / sl.length) * 100;
    const row = {
      id: planet.id, range: max - min, p10: pct(lr, 0.1), p50: pct(lr, 0.5),
      noise: pct(bareLr, 0.5), ratio, walk: frac(38), cliff: 100 - frac(50),
    };
    rows.push(row);
    console.log(`     ${planet.id.padEnd(12)}${row.range.toFixed(1).padStart(6)} m   ${row.p10.toFixed(1).padStart(6)} m`
      + `   ${row.p50.toFixed(1).padStart(6)} m    ${row.noise.toFixed(2).padStart(6)} m`
      + `        ${row.ratio.toFixed(1).padStart(5)}x       ${row.walk.toFixed(1).padStart(5)}%   ${row.cliff.toFixed(1).padStart(5)}%`);

    assert.ok(row.ratio >= 2,
      `${planet.id}: the authored median 50 m relief is ${row.p50.toFixed(1)} m against ${row.noise.toFixed(2)} m for the`
      + ` same field with every landform deleted - only ${row.ratio.toFixed(1)}x, so the landform vocabulary is decoration`);
    assert.ok(row.walk >= 60,
      `${planet.id}: only ${row.walk.toFixed(1)}% of the map is under 38 deg - most of this planet cannot be walked on`);
    assert.ok(row.range >= 50,
      `${planet.id}: ${row.range.toFixed(1)} m of total relief over ${(planet.half * 2)} m of map is a table with a texture on it`);
  }
  const thinnest = rows.reduce((a, b) => (b.ratio < a.ratio ? b : a));
  const flattest = rows.reduce((a, b) => (b.range < a.range ? b : a));
  console.log(`     least authored: ${thinnest.id} at ${thinnest.ratio.toFixed(1)}x the noise.`
    + `  lowest relief: ${flattest.id} at ${flattest.range.toFixed(1)} m`
    + `  (Cinder, the reference, is ${rows[0].ratio.toFixed(1)}x and ${rows[0].range.toFixed(1)} m)`);
});

/* ================================================================== */
/* 4. LANDING SITES - the promise the pads make                       */
/* ================================================================== */

test('every landing pad on every planet is flat, and flat by construction', () => {
  /* ALL TEN. A pad is the one place in a descriptor where the author has
   * PROMISED a number, and it is checked against the real height field rather
   * than against the `pad` record that was supposed to make it true.
   *
   * 769 samples per pad - 64 bearings by 12 radii, plus the centre - because a
   * ring test misses a dome in the middle and a spoke test misses a tilt.
   *
   * THE CEILING IS BY ABLATION, and it is a claim about the MECHANISM rather
   * than about every pad. Cinder's Colonnade Deck sits on a `plateau`, which is
   * already dead level, so its own ablation is 0.0 m and its pad is
   * belt-and-braces; asserting per-pad that the ablation is worse would fail on
   * it for the wrong reason. Cathedra has two of those. What has to be true is
   * that the LEVELLING IS REAL SOMEWHERE ON EACH PLANET: if the biggest fall a
   * pad is cancelling ever collapses to nothing, `pad` has stopped levelling
   * and every flatness figure above is measuring ground that happened to be
   * flat. Carnelian's Kiln is cut into a gorge wall that falls 91.5 m across
   * the same disc. */
  console.log('   LANDING PADS (floor: 0.30 m of fall across the usable disc, every pad, every planet)');
  let worstSpan = 0;
  let worstId = null;
  const levelled = [];
  for (const planet of ALL) {
    const { H: h } = sampled(planet);
    const without = [];
    for (const site of planet.landing) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let a = 0; a < 64; a++) {
        const th = (a / 64) * Math.PI * 2;
        for (let r = 0; r <= 12; r++) {
          const rr = (site.r * r) / 12;
          const y = h(site.x + Math.cos(th) * rr, site.z + Math.sin(th) * rr);
          if (y < lo) lo = y;
          if (y > hi) hi = y;
        }
      }
      /* The same disc with THIS pad's landform removed: the ground a ship would
       * have been asked to sit on. */
      const noPad = planetHeight({
        ...planet.terrain,
        landforms: planet.terrain.landforms.filter((f) => !(f.kind === 'pad' && f.x === site.x && f.z === site.z)),
      });
      let nlo = Infinity;
      let nhi = -Infinity;
      for (let a = 0; a < 64; a++) {
        const th = (a / 64) * Math.PI * 2;
        for (let r = 0; r <= 12; r++) {
          const rr = (site.r * r) / 12;
          const y = noPad(site.x + Math.cos(th) * rr, site.z + Math.sin(th) * rr);
          if (y < nlo) nlo = y;
          if (y > nhi) nhi = y;
        }
      }
      const span = hi - lo;
      if (span > worstSpan) { worstSpan = span; worstId = `${planet.id}/${site.id}`; }
      console.log(`     ${planet.id.padEnd(11)} ${site.id.padEnd(16)}${site.primary ? 'PRIMARY' : '       '}`
        + ` r ${String(site.r).padStart(2)} m at y ${hi.toFixed(1).padStart(7)}`
        + `   fall across the disc ${span.toFixed(3)} m   (without its pad: ${(nhi - nlo).toFixed(1)} m)`);
      assert.ok(span <= 0.30,
        `${planet.id}: pad ${site.id} falls ${span.toFixed(3)} m across its usable disc`);
      without.push({ id: site.id, span: nhi - nlo });
    }
    levelled.push({ id: planet.id, m: Math.max(...without.map((w) => w.span)) });
  }
  console.log(`   worst pad on any planet: ${worstId} at ${worstSpan.toFixed(3)} m of fall (floor 0.30 m)`);
  console.log('   fall each planet\'s hardest-working pad is cancelling: '
    + levelled.map((l) => `${l.id} ${l.m.toFixed(1)} m`).join(', '));
  /* THE ABLATION FLOOR IS A CLAIM ABOUT THE REGISTRY, NOT ABOUT EACH PLANET,
   * and that is deliberate. Vitrine's three pads sit on firn that already falls
   * only 2.0 to 3.6 m across a disc, and Cathedra's two low ones sit on
   * shattered PLATES whose ablation is 0.0 m: on those the `pad` is
   * belt-and-braces and a per-planet floor would fail them for being the thing
   * they were authored to be. What must be true is that `pad` IS STILL
   * LEVELLING SOMEWHERE - Carnelian's Kiln is cut into a gorge wall that falls
   * 91.5 m across the same disc, Verdigris's Sumphead 69.2 m, Cinder's Rimhold
   * 64.8 m. If the biggest number in that list ever collapses, `pad` has
   * stopped cutting and every 0.00 above is measuring ground that happened to
   * be flat. */
  const hardest = levelled.reduce((a, b) => (b.m > a.m ? b : a));
  console.log(`   hardest-working pad in the registry: ${hardest.id} at ${hardest.m.toFixed(1)} m of cancelled fall (floor 30 m)`);
  assert.ok(hardest.m >= 30,
    `the biggest fall any pad in the registry is levelling is ${hardest.m.toFixed(1)} m, on ${hardest.id}`
    + ' - no pad anywhere is cut into anything steep, so nothing here proves `pad` levels at all');
});

test('nothing is scattered onto a landing pad, on any planet', () => {
  /* ALL TEN. Props and minerals that ignore a pad are how a ship lands inside
   * a basalt column and how a boulder ends up standing on the disc a player
   * arrives at. `clearOfPads` is OPT-IN in `Placement.js` - a region that never
   * mentions it is never filtered - so this measures the OUTCOME rather than
   * trusting the declaration.
   *
   * THE SEEDS ARE THE WORLD'S SEEDS. `PlanetWorld._buildProps` walks the props
   * from `(terrain.seed ?? 1) ^ 0x7f4a` and `_buildMinerals` walks the minerals
   * from `(terrain.seed ?? 1) ^ 0x1d0e`, each advancing one LCG step per field.
   * The previous version of this case advanced ONE stream across props and then
   * minerals, so its mineral half was measuring a layout the game never builds.
   * Two streams here, matching the two in the world. */
  console.log('   CLEARANCE OF LANDING PADS (floor: nothing inside any pad disc)');
  const offenders = [];
  for (const planet of ALL) {
    let worst = Infinity;
    let culprit = null;
    const f = fields(planet);
    for (const { spec, res } of [...f.props, ...f.minerals]) {
      for (const pt of res.points) {
        for (const site of planet.landing) {
          const d = Math.hypot(pt.x - site.x, pt.z - site.z) - site.r;
          if (d < worst) { worst = d; culprit = `${spec.id} at ${d.toFixed(2)} m from ${site.id}'s edge`; }
        }
      }
    }
    console.log(`     ${planet.id.padEnd(11)} closest scattered object to a pad edge: ${culprit}`);
    if (!(worst > 0)) offenders.push(`${planet.id}: ${culprit}`);
  }
  assert.deepEqual(offenders, [],
    'something is placed ON a landing pad - a pad is where a ship sets down and where the player walks out');
});

/* ================================================================== */
/* 5. ROADS - the promise the ramps make                              */
/* ================================================================== */

test('every authored road on every planet stays inside the walking envelope', () => {
  /* ALL TEN. 38 degrees is the ceiling `planet-reach.test.mjs` floods at, taken
   * from the driven onset measured in `Physics.js:1110`. A road steeper than
   * that anywhere along its length is not a road; the flood would notice that
   * the ore behind it was gone, but only this case can say WHICH road, WHERE,
   * and by how much.
   *
   * Sampled on the ramp's own CENTRE LINE at 2 m, which is the lattice pitch,
   * so a segment that fails here is a segment the walk probe cannot cross.
   *
   * The floor on the ramp COUNT stays on Cinder: three roads is a fact about a
   * shield volcano with a spiral into its caldera, and six of the ten planets
   * carry two. What every planet must have is at least one - a descriptor with
   * no `ramp` at all has no authored route anywhere.
   *
   * ── WHAT THIS FOUND ──────────────────────────────────────────────────────
   * A ramp is a LEVEL and so is a pad, and inside the LEVEL layer a later form
   * overrides an earlier one. Volcanic.js records the rule as "roads first,
   * pads last", and the cost of the other order was a landing pad with a three
   * metre fall across it. The SAME interaction has a second face, which is what
   * this case catches: where a road's head is inside a pad disc, the pad holds
   * the road level out to its own radius and the road's grade has to make up
   * the difference in the blend just outside it. That is a riser, and it is at
   * the pad, which is where the player is standing when they arrive. */
  console.log('   ROADS (floor: no 2 m segment of any ramp centre line over 38 deg)');
  const overs = [];
  for (const planet of ALL) {
    const { H: h } = sampled(planet);
    const ramps = planet.terrain.landforms.filter((f) => f.kind === 'ramp');
    assert.ok(ramps.length >= 1, `${planet.id} has no ramp landform at all - nothing on it is an authored route`);
    for (const f of ramps) {
      let len = 0;
      for (let i = 1; i < f.pts.length; i++) {
        len += Math.hypot(f.pts[i][0] - f.pts[i - 1][0], f.pts[i][1] - f.pts[i - 1][1]);
      }
      let worst = 0;
      let worstAt = null;
      let worstS = 0;
      let run = 0;
      for (let i = 1; i < f.pts.length; i++) {
        const segLen = Math.hypot(f.pts[i][0] - f.pts[i - 1][0], f.pts[i][1] - f.pts[i - 1][1]);
        const n = Math.max(1, Math.ceil(segLen / 2));
        for (let k = 0; k < n; k++) {
          const t0 = k / n;
          const t1 = (k + 1) / n;
          const ax = f.pts[i - 1][0] + (f.pts[i][0] - f.pts[i - 1][0]) * t0;
          const az = f.pts[i - 1][1] + (f.pts[i][1] - f.pts[i - 1][1]) * t0;
          const bx = f.pts[i - 1][0] + (f.pts[i][0] - f.pts[i - 1][0]) * t1;
          const bz = f.pts[i - 1][1] + (f.pts[i][1] - f.pts[i - 1][1]) * t1;
          const step = Math.hypot(bx - ax, bz - az);
          run += step;
          const g = Math.abs(h(bx, bz) - h(ax, az)) / step;
          if (g > worst) { worst = g; worstAt = [bx, bz]; worstS = run; }
        }
      }
      const y0 = h(f.pts[0][0], f.pts[0][1]);
      const y1 = h(f.pts[f.pts.length - 1][0], f.pts[f.pts.length - 1][1]);
      const mean = (Math.atan(Math.abs(y1 - y0) / len) * 180) / Math.PI;
      const peak = (Math.atan(worst) * 180) / Math.PI;
      console.log(`     ${planet.id.padEnd(11)} ${f.pts.length}-leg road, ${len.toFixed(0).padStart(3)} m,`
        + ` y ${y0.toFixed(1).padStart(6)} -> ${y1.toFixed(1).padStart(6)}: mean ${mean.toFixed(1).padStart(4)} deg,`
        + ` worst 2 m segment ${peak.toFixed(1).padStart(4)} deg at (${worstAt[0].toFixed(0)}, ${worstAt[1].toFixed(0)}),`
        + ` ${worstS.toFixed(0)} m along${peak > 38 ? '   *** OVER THE ENVELOPE' : ''}`);
      if (peak > 38) {
        overs.push(`${planet.id}: a 2 m segment of its ${len.toFixed(0)} m road is ${peak.toFixed(1)} deg`
          + ` at (${worstAt[0].toFixed(0)}, ${worstAt[1].toFixed(0)}), ${worstS.toFixed(0)} m from the head`
          + ` - the road's own mean grade is ${mean.toFixed(1)} deg`);
      }
    }
  }
  assert.deepEqual(overs, [],
    'a road with a segment past 38 degrees is a road a walking player cannot use at that point');
});

/* ================================================================== */
/* 6. SHORELINES                                                      */
/* ================================================================== */

/**
 * A SEA IS NOT A BIG LAKE, and the two cases below are split on that.
 *
 * A LAKE has an OUTLINE. It fills a basin, its drawn edge and the contour where
 * the terrain crosses its level have to agree to within the apron, and nothing
 * stands up out of it - Volcanic.js records that a lake whose level came out of
 * a `min()` over its basin tilted twelve metres across a single circle, and the
 * fix was a `pad` under it.
 *
 * A SEA has no outline at all. Shoal's is one disc of radius 2,700 m on a 440 m
 * playfield: it covers the map and keeps going, the shoreline is the y = 6.0
 * contour of the terrain rather than anything in the record, and the islands
 * standing out of it ARE the planet. Measured against the lake rules it looks
 * catastrophic - its edge "hangs" 42.7 m over ground that is 1.8 km outside the
 * playfield, and 48.6 m of island "pokes through" - and every one of those
 * numbers is the design working.
 *
 * So a body whose radius reaches past the corner of the playfield is a sea, and
 * it is asked the questions a sea has to answer instead.
 */
const isSea = (planet, b) => b.shape === 'disc' && b.r >= planet.half * Math.SQRT2;

test('every lake on every planet meets the ground inside its own skirt', () => {
  /* ALL TEN (six of which have liquid; five of those have lakes). A lake's
   * drawn edge and the height at which the terrain actually crosses its level
   * disagree, because the terrain is noise. Small disagreements are hidden by
   * the apron; large ones are a strip of sky under the lava, or a lake sitting
   * on top of a hill. The apron is `SKIRT` metres, so that is the bound.
   *
   * THE SECOND RULE IS AN AREA, NOT A HEIGHT, and that is the generalisation.
   * Cinder's four bodies are lava - opaque, hot, and a rock standing out of one
   * is simply wrong, so its own case below holds it to 5 cm. Sirocco's brine
   * pans and Sallow's acid lakes are shallow and crusted, and they measure
   * 0.08 m to 0.83 m of ground standing proud. A rock in a salt pan is a salt
   * pan; a lake with a hill in it is a mistake; a HEIGHT cannot tell those
   * apart and a FRACTION OF THE FOOTPRINT can. 95% of a lake has to be
   * water. */
  console.log(`   LAKE SHORELINES (floor: within the ${SKIRT.toFixed(1)} m skirt, and 95% of the footprint under the surface)`);
  let bodies = 0;
  const bad = [];
  for (const planet of ALL) {
    const { H: h } = sampled(planet);
    for (const [i, b] of (planet.liquid?.bodies ?? []).entries()) {
      if (isSea(planet, b)) {
        console.log(`     ${planet.id.padEnd(11)} body ${i} (${b.shape} r ${b.r}): a SEA, not a lake - see the case below`);
        continue;
      }
      bodies++;
      /* Only a shoreline that sits BELOW the liquid needs the apron. An edge
       * buried IN the ground is invisible and is what the ribbon's extra width
       * is for - it laps the gorge walls on purpose. So this is one-sided. */
      let edgeWorst = 0;
      let buried = 0;
      let poke = -Infinity;
      let wet = 0;
      let inside = 0;
      if (b.shape === 'disc') {
        /* Sampled on `discRadiusAt`, which is the outline the MESH is built
         * from. Measuring the nominal radius while the mesh draws a wobbled one
         * would be measuring a shore that does not exist. */
        for (let a = 0; a < 256; a++) {
          const th = (a / 256) * Math.PI * 2;
          const R = discRadiusAt(b, th);
          const dy = h(b.x + Math.cos(th) * R, b.z + Math.sin(th) * R) - b.y;
          if (dy < 0) edgeWorst = Math.max(edgeWorst, -dy); else buried = Math.max(buried, dy);
          for (let r = 0; r <= 12; r++) {
            const rr = (R * r) / 12;
            const d = h(b.x + Math.cos(th) * rr, b.z + Math.sin(th) * rr) - b.y;
            poke = Math.max(poke, d);
            inside++;
            if (d <= 0) wet++;
          }
        }
      } else {
        const cum = [0];
        for (let k = 1; k < b.pts.length; k++) {
          cum.push(cum[k - 1] + Math.hypot(b.pts[k][0] - b.pts[k - 1][0], b.pts[k][1] - b.pts[k - 1][1]));
        }
        const total = cum[cum.length - 1];
        for (let k = 0; k + 1 < b.pts.length; k++) {
          const dx = b.pts[k + 1][0] - b.pts[k][0];
          const dz = b.pts[k + 1][1] - b.pts[k][1];
          const len = Math.hypot(dx, dz) || 1;
          for (let m = 0; m <= 40; m++) {
            const t = m / 40;
            const x = b.pts[k][0] + dx * t;
            const z = b.pts[k][1] + dz * t;
            const y = b.y0 + (b.y1 - b.y0) * ((cum[k] + len * t) / total);
            const d = h(x, z) - y;
            poke = Math.max(poke, d);
            inside++;
            if (d <= 0) wet++;
            for (const sgn of [-1, 1]) {
              const ex = x + (-dz / len) * sgn * b.width * 0.5;
              const ez = z + (dx / len) * sgn * b.width * 0.5;
              const edy = h(ex, ez) - y;
              if (edy < 0) edgeWorst = Math.max(edgeWorst, -edy); else buried = Math.max(buried, edy);
            }
          }
        }
      }
      const frac = wet / inside;
      console.log(`     ${planet.id.padEnd(11)} body ${i} (${b.shape}): edge hangs ${edgeWorst.toFixed(2)} m over the ground`
        + ` / is buried ${buried.toFixed(2)} m in it, ground stands ${poke.toFixed(2)} m proud at worst,`
        + ` ${(frac * 100).toFixed(1)}% of the footprint is under the surface`);
      if (edgeWorst > SKIRT) {
        bad.push(`${planet.id} body ${i} (${b.shape}): edge hangs ${edgeWorst.toFixed(2)} m over the ground,`
          + ` past the ${SKIRT} m skirt - that gap is a strip of sky under the liquid`);
      }
      if (frac < 0.95) {
        bad.push(`${planet.id} body ${i} (${b.shape}): only ${(frac * 100).toFixed(1)}% of its footprint is under its own`
          + ` surface (worst ${poke.toFixed(2)} m proud) - that is a wet hillside, not a lake`);
      }
    }
  }
  console.log(`   ${bodies} lakes across the registry`);
  /* Collected rather than thrown at the first one: with ten planets the first
   * failure would hide the other nine, and a list of every shoreline that is
   * wrong is the thing worth having. */
  assert.deepEqual(bad, [], 'a liquid body whose edge misses the ground is a lake with sky under it');
});

test('Cinder\'s lava has NOTHING standing out of it', () => {
  /* CINDER ONLY, and it is the material that makes it so. Lava is opaque and
   * it is `lethal: true`; a rock standing 20 cm out of it is a rock the player
   * can see, aim a jump at, and die on. Water, brine and acid are none of those
   * things, so the registry-wide case above asks for a WET FRACTION and this
   * one keeps the 5 cm that Cinder's four bodies actually measure (-1.00 m to
   * -0.20 m: every one of them is strictly below its own surface). */
  /* The discriminator is the MATERIAL, and it is read off the descriptor:
   * Cinder's lava runs `emissive: 2.1` against Shoal's water at 0.16 and
   * Verdigris's river at 0.10. An opaque, self-lit surface is one a rock cannot
   * stand out of without being seen to. */
  assert.ok(P.liquid.emissive >= 1,
    `Cinder's liquid is at emissive ${P.liquid.emissive} - it is no longer molten, so re-read this case before keeping it`);
  for (const [i, b] of P.liquid.bodies.entries()) {
    let poke = -Infinity;
    if (b.shape === 'disc') {
      for (let a = 0; a < 256; a++) {
        const th = (a / 256) * Math.PI * 2;
        const R = discRadiusAt(b, th);
        for (let r = 0; r <= 12; r++) {
          const rr = (R * r) / 12;
          poke = Math.max(poke, H(b.x + Math.cos(th) * rr, b.z + Math.sin(th) * rr) - b.y);
        }
      }
    } else {
      const cum = [0];
      for (let k = 1; k < b.pts.length; k++) {
        cum.push(cum[k - 1] + Math.hypot(b.pts[k][0] - b.pts[k - 1][0], b.pts[k][1] - b.pts[k - 1][1]));
      }
      const total = cum[cum.length - 1];
      for (let k = 0; k + 1 < b.pts.length; k++) {
        const dx = b.pts[k + 1][0] - b.pts[k][0];
        const dz = b.pts[k + 1][1] - b.pts[k][1];
        const len = Math.hypot(dx, dz) || 1;
        for (let m = 0; m <= 40; m++) {
          const t = m / 40;
          const x = b.pts[k][0] + dx * t;
          const z = b.pts[k][1] + dz * t;
          poke = Math.max(poke, H(x, z) - (b.y0 + (b.y1 - b.y0) * ((cum[k] + len * t) / total)));
        }
      }
    }
    console.log(`     Cinder body ${i} (${b.shape}): ground reaches ${poke.toFixed(2)} m of its own surface`);
    assert.ok(poke <= 0.05, `Cinder body ${i} has terrain standing ${poke.toFixed(2)} m proud of molten rock`);
  }
});

test('a sea has islands in it, and a pad you can stand on above it', () => {
  /* ALL TEN, but only Shoal has one. The lake rules cannot be asked of a sea,
   * so these are the three questions a sea has to answer instead, and they are
   * the ones the brief raised:
   *
   *   IT IS FLAT. A `disc` carries one `y`, so this is checkable outright - and
   *   it is the whole reason the sea is authored as a surface rather than
   *   derived from a `min()` over the terrain, which is how Cinder's crater
   *   lake once came out twelve metres out of level across one circle.
   *
   *   THERE IS LAND IN IT. A sea with nothing standing out of it is a blue
   *   plane, and the planet is "islands over a shelf".
   *
   *   YOU NEVER HAVE TO SWIM. `PlanetWorld` sets `swim: false`, so water is a
   *   wall. Every landing pad has to be dry ground with clear air over the sea
   *   level, or the player arrives in something they cannot get out of. */
  let seas = 0;
  for (const planet of ALL) {
    for (const [i, b] of (planet.liquid?.bodies ?? []).entries()) {
      if (!isSea(planet, b)) continue;
      seas++;
      const { H: h, G: g } = sampled(planet);
      assert.equal(typeof b.y, 'number', `${planet.id} body ${i} is a sea with no single level`);
      assert.equal(b.wobble ?? 0, 0,
        `${planet.id} body ${i} is a sea with a wobbled outline - an ocean has no outline to wobble`);
      let above = 0;
      let below = 0;
      for (let k = 0; k < g.h.length; k++) (g.h[k] > b.y ? above++ : below++);
      const land = (above / g.h.length) * 100;
      const pads = planet.landing.map((sq) => ({ id: sq.id, clear: h(sq.x, sq.z) - b.y }));
      console.log(`     ${planet.id.padEnd(11)} sea at y ${b.y}, r ${b.r} m over a ${planet.half * 2} m playfield:`
        + ` ${land.toFixed(1)}% of the map stands out of it`);
      console.log(`     ${' '.repeat(11)} pads above the water: ${pads.map((q) => `${q.id} +${q.clear.toFixed(1)} m`).join(', ')}`);
      assert.ok(land >= 5,
        `${planet.id}: only ${land.toFixed(1)}% of the map stands out of its sea - there are no islands, there is a blue plane`);
      assert.ok(land <= 80,
        `${planet.id}: ${land.toFixed(1)}% of the map is above sea level - that is a continent with a pond on it`);
      for (const q of pads) {
        assert.ok(q.clear > 1.0,
          `${planet.id}: landing pad ${q.id} sits ${q.clear.toFixed(1)} m above the sea, and \`swim\` is false`
          + ' - the player arrives in water they cannot get out of');
      }
    }
  }
  console.log(`   ${seas} sea across the registry (a sea is a disc whose radius reaches past the corner of the playfield)`);
  assert.equal(seas, 1, 'exactly one planet is authored as an ocean world; if that has changed, re-read these two cases');
});

test('every deposit every descriptor asks for is actually placed, and pays for the walk', () => {
  /* ALL TEN. `scatter` NEVER pads a field to `count` - it reports the shortfall
   * and returns what it could place. That is the right behaviour and it is
   * exactly why this case has to exist: without it a descriptor can quietly ask
   * for 12 nodes of the rarest ore on the planet, get 9, and nobody ever looks.
   * Cinder's colonnade was cut from 210 to 150 for this reason.
   *
   * Minerals are held to 100% rather than to the props' 90%: a mineral is a
   * named, priced, quest-visible object and `SpaceObjectives` counts them. */
  console.log('   MINERALS (floor: 100% of requested placed, on every planet)');
  const short = [];
  for (const planet of ALL) {
    const { H: h, CELL: cell } = sampled(planet);
    let total = 0;
    for (const { spec, res } of fields(planet).minerals) {
      let lo = Infinity;
      let hi = -Infinity;
      let slopeMax = 0;
      for (const pt of res.points) {
        if (pt.y < lo) lo = pt.y;
        if (pt.y > hi) hi = pt.y;
        slopeMax = Math.max(slopeMax, slopeDegAt(h, pt.x, pt.z, cell));
        total += Math.round(spec.credits[0] + pt.rnd * (spec.credits[1] - spec.credits[0]));
      }
      console.log(`     ${planet.id.padEnd(11)} ${spec.id.padEnd(12)} ${spec.rarity.padEnd(9)} ${res.points.length}/${spec.count} placed,`
        + ` ${spec.credits[0]}-${spec.credits[1]} cr, size ${String(spec.size).padEnd(4)} y ${lo.toFixed(0).padStart(4)}..${hi.toFixed(0).padStart(4)},`
        + ` steepest site ${slopeMax.toFixed(1).padStart(4)} deg, ${res.tries} tries`);
      if (res.points.length !== spec.count) {
        short.push(`${planet.id}/${spec.id}: ${res.points.length} of ${spec.count} placed in ${res.tries} tries`
          + ` - the region is too small or too filtered for what the descriptor asks`);
      }
      if (spec.region.slopeMaxDeg !== undefined) {
        assert.ok(slopeMax <= spec.region.slopeMaxDeg + 1e-6,
          `${planet.id}/${spec.id} has a site at ${slopeMax.toFixed(1)} deg, past its ${spec.region.slopeMaxDeg} deg ceiling`);
      }
    }
    /* Value has to spread, or every deposit on the planet is the same errand.
     * The rarest thing pays at least 7x the commonest. */
    const lowest = Math.min(...planet.minerals.map((m) => m.credits[0]));
    const highest = Math.max(...planet.minerals.map((m) => m.credits[1]));
    console.log(`     ${planet.id.padEnd(11)} a full sweep is worth ${total.toLocaleString()} credits`
      + ` over ${planet.minerals.length} ores, ${(highest / lowest).toFixed(1)}x from cheapest to dearest`);
    assert.ok(highest / lowest >= 7, `${planet.id}: value spread is only ${(highest / lowest).toFixed(1)}x`);
    assert.ok(planet.minerals.length >= 4, `${planet.id}: fewer than four kinds of ore is not an exploration loop`);
  }
  assert.deepEqual(short, [], 'a deposit that could not be placed is a deposit that is not there');
});

test('every liquid surface on every planet faces UP', () => {
  /* ALL TEN. A polygon wound the wrong way is invisible from the side you are
   * standing on and lit from the side you are not, and it looks EXACTLY like a
   * surface that is correctly there and merely dark. That is how 340 m of lava
   * river in Cinder's outlet gorge survived three review screenshots: the
   * ribbon's triangles were wound face-down, `computeVertexNormals` dutifully
   * derived downward normals from them, backface culling removed it from the
   * frame, and what was left underneath was ash-coloured ground that read as a
   * cooled flow.
   *
   * A screenshot cannot answer "is this inside out". This can, and nine more
   * planets have authored water, brine, meltwater and acid since. */
  console.log('   LIQUID FACING (floor: every surface triangle normal has ny > 0.5)');
  const A = { x: 0, y: 0, z: 0 };
  const B = { x: 0, y: 0, z: 0 };
  for (const planet of ALL) {
    for (const [i, b] of (planet.liquid?.bodies ?? []).entries()) {
      const { surface } = bodyGeometry(b);
      const pos = surface.getAttribute('position');
      const idx = surface.getIndex();
      const count = idx ? idx.count : pos.count;
      let worst = 1;
      let tris = 0;
      for (let t = 0; t + 2 < count; t += 3) {
        const g = (k) => (idx ? idx.getX(t + k) : t + k);
        const i0 = g(0); const i1 = g(1); const i2 = g(2);
        A.x = pos.getX(i1) - pos.getX(i0); A.y = pos.getY(i1) - pos.getY(i0); A.z = pos.getZ(i1) - pos.getZ(i0);
        B.x = pos.getX(i2) - pos.getX(i0); B.y = pos.getY(i2) - pos.getY(i0); B.z = pos.getZ(i2) - pos.getZ(i0);
        const nx = A.y * B.z - A.z * B.y;
        const ny = A.z * B.x - A.x * B.z;
        const nz = A.x * B.y - A.y * B.x;
        const len = Math.hypot(nx, ny, nz);
        if (len < 1e-9) continue;   // degenerate; carries no facing
        tris++;
        const up = ny / len;
        if (up < worst) worst = up;
      }
      console.log(`     ${planet.id.padEnd(11)} body ${i} (${b.shape}): ${String(tris).padStart(5)} triangles,`
        + ` worst upward component ${worst.toFixed(3)}`);
      assert.ok(worst > 0.5,
        `${planet.id} liquid body ${i} has a triangle facing ${worst.toFixed(3)} - it is wound inside out`);
    }
  }
});

test('every prop field on every planet places what it asks for, within a margin', () => {
  /* ALL TEN. `scatter` never pads a field to `count` - it reports the
   * shortfall. That is the right behaviour and it is exactly why this case has
   * to exist: without it, a descriptor can quietly ask for 260 columns, get
   * 155, and nobody ever looks. A field that under-delivers by more than 10% is
   * a descriptor telling itself a number it cannot have.
   *
   * The floor is on the OUTCOME, not on the request, because the request is the
   * thing being checked. Seeded exactly as `PlanetWorld._buildProps` seeds it. */
  console.log('   PROP FIELDS (floor: 90% of requested placed, on every planet)');
  const short = [];
  let nFields = 0;
  let placed = 0;
  let asked = 0;
  for (const planet of ALL) {
    for (const { spec, res } of fields(planet).props) {
      const frac = res.points.length / spec.count;
      nFields++;
      placed += res.points.length;
      asked += spec.count;
      console.log(`     ${planet.id.padEnd(11)} ${spec.id.padEnd(18)} ${spec.kind.padEnd(9)} ${String(res.points.length).padStart(4)}/${String(spec.count).padEnd(4)}`
        + ` = ${(frac * 100).toFixed(0).padStart(3)}% at ${String(spec.spacing).padStart(4)} m spacing, ${String(res.tries).padStart(5)} tries`
        + `   rejects ${Object.entries(res.rejects).filter(([, v]) => v).map(([k, v]) => `${k}:${v}`).join(' ') || 'none'}`);
      if (frac < 0.9) {
        short.push(`${planet.id}/${spec.id}: ${res.points.length} of ${spec.count} (${(frac * 100).toFixed(0)}%)`
          + ' - the region cannot hold what the descriptor asks for');
      }
    }
  }
  console.log(`   ${placed.toLocaleString()} of ${asked.toLocaleString()} props placed across ${nFields} fields on ${ALL.length} planets`);
  assert.deepEqual(short, [], 'a prop field that under-delivers is a number in the descriptor nobody can reason about');
});

test('no planet uses a landform kind outside the published vocabulary', () => {
  /* ALL TEN, and this is the half of the old case that generalises: a planet
   * that grows a one-off kind is a planet `PlanetHeight` will build as a flat
   * nothing, because the switch has no arm for it. The EXACT set is a fact
   * about Cinder and stays in the case below. */
  console.log('   LANDFORM VOCABULARY');
  for (const planet of ALL) {
    const kinds = [...new Set(planet.terrain.landforms.map((f) => f.kind))].sort();
    console.log(`     ${planet.id.padEnd(11)} ${String(planet.terrain.landforms.length).padStart(3)} landforms: ${kinds.join(' ')}`);
    for (const k of kinds) {
      assert.ok(LANDFORM_KINDS.includes(k), `${planet.id} uses "${k}", which is not in LANDFORM_KINDS`);
    }
  }
});

test('Cinder says exactly what Cinder is allowed to say, and no more', () => {
  /* CINDER ONLY: this is an inventory of ONE planet's landforms and one of its
   * ore regions, and it is here because both of those were the fix for a
   * measured defect. */
  assert.deepEqual(
    [...new Set(P.terrain.landforms.map((f) => f.kind))].sort(),
    ['basin', 'cone', 'pad', 'plateau', 'ramp', 'ridge', 'trench', 'volcano'],
    'Cinder uses a landform kind outside the published vocabulary'
  );
  for (const k of new Set(P.terrain.landforms.map((f) => f.kind))) {
    assert.ok(LANDFORM_KINDS.includes(k), `${k} is not in LANDFORM_KINDS`);
  }
  // And the rift's sulfur really is on the lip rather than in the crack.
  const sulfur = P.minerals.find((m) => m.id === 'sulfur');
  assert.ok(sulfur.region.widthInner > 0, 'the rift corridor is no longer hollow - sulfur can fall into the fissure');
  for (const pt of scatter({
    region: sulfur.region, count: sulfur.count, spacing: sulfur.spacing, seed: 7,
    height: H, half: HALF, slopeStep: CELL, liquid: P.liquid, landing: P.landing,
  }).points) {
    assert.ok(polyDist(pt.x, pt.z, sulfur.region.pts) >= sulfur.region.widthInner);
  }
});

/* ================================================================== */
/* 8. THE KINDS ADDED AFTER CINDER - crater, dunes, scarp             */
/* ================================================================== */

/**
 * A landform kind is a NAME plus a promise about a shape, and the name is the
 * only part the rest of the pipeline can see. `definePlanet` will happily
 * validate a record that says `crater` and evaluates to a dent; the worker will
 * build it, the collider will match it, `planet-reach.test.mjs` will walk over
 * it, and every one of those passes. The shape is checkable in exactly one
 * place - here, by sampling it - so each case below measures the property the
 * docblock claims rather than that the kind exists.
 *
 * Every case runs against a planet with the noise turned OFF. Swells and grain
 * would only add a confound: the question is what the LANDFORM does, and a
 * floor of "the crater is deeper than the ripples" is not the floor that
 * matters.
 */

const BARE = { seed: 5, half: 400, baseY: 0 };
const only = (forms, over = {}) =>
  planetHeight({ ...BARE, ...over, landforms: Array.isArray(forms) ? forms : [forms] });

/** Lowest and highest sample on a ring of radius `d` about (x, z). */
function ring(h, x, z, d, n = 128) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let a = 0; a < n; a++) {
    const th = (a / n) * Math.PI * 2;
    const v = h(x + Math.cos(th) * d, z + Math.sin(th) * d);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return { lo, hi };
}

/** Samples along a bearing through (x, z), from `s0` to `s1` every `step` m. */
function transect(h, x, z, ang, s0, s1, step) {
  const ux = Math.cos(ang);
  const uz = Math.sin(ang);
  const s = [];
  const y = [];
  for (let t = s0; t <= s1 + 1e-9; t += step) {
    s.push(t);
    y.push(h(x + ux * t, z + uz * t));
  }
  return { s, y };
}

const spanOf = (y) => Math.max(...y) - Math.min(...y);

test('a crater has a RIM, which is the whole difference between it and a dent', () => {
  /* `basin` was already in the vocabulary and it digs a hole. If that were
   * enough, `crater` would be an alias for it. It is not: what a viewer reads
   * as an impact is the ring of ejecta standing ABOVE the plain around the
   * hole, and a cratered highland built out of basins is a sheet of dimpled
   * metal.
   *
   * So the ablation here is not "the landform against no landform" - it is the
   * crater against the basin that would otherwise have been used. */
  const F = { kind: 'crater', x: 0, z: 0, r: 60, depth: 18, rim: 5, rimWidth: 25, floor: 0.35 };
  const h = only(F);
  const dent = only({ kind: 'basin', x: 0, z: 0, r: F.r, depth: F.depth, flat: F.floor });

  const plain = h(200, 200);
  const floor = ring(h, 0, 0, 0).lo;
  const crest = ring(h, 0, 0, F.r).hi;
  const outside = ring(h, 0, 0, F.r + F.rimWidth + 2).hi;

  // Where the highest and lowest ground in the whole landform actually are.
  let hiD = 0;
  let hiY = -Infinity;
  let loY = Infinity;
  let dentHi = -Infinity;
  for (let d = 0; d <= 110; d += 0.25) {
    const r = ring(h, 0, 0, d, 64);
    if (r.hi > hiY) { hiY = r.hi; hiD = d; }
    if (r.lo < loY) loY = r.lo;
    dentHi = Math.max(dentHi, ring(dent, 0, 0, d, 64).hi);
  }

  console.log('   CRATER (r 60, depth 18, rim 5, rimWidth 25, floor 0.35)');
  console.log(`     plain ${plain.toFixed(2)}   floor ${floor.toFixed(2)}   crest at the edge ${crest.toFixed(2)}`
    + `   ${(F.r + F.rimWidth + 2).toFixed(0)} m out ${outside.toFixed(2)}`);
  console.log(`     highest ground ${hiY.toFixed(2)} m at r=${hiD.toFixed(1)} (the edge is r=${F.r}),`
    + ` lowest ${loY.toFixed(2)} m`);
  console.log(`     the same hole cut as a basin instead: highest ground ${dentHi.toFixed(2)} m`
    + ' - it never leaves the plain');

  assert.ok(floor <= plain - F.depth * 0.98, `the floor is only ${(plain - floor).toFixed(2)} m below the plain`);
  assert.ok(crest >= plain + F.rim * 0.98, `the rim only reaches ${(crest - plain).toFixed(2)} m above the plain`);
  // The crest is AT the crater edge, not somewhere out in the ejecta blanket.
  assert.ok(Math.abs(hiD - F.r) <= 1, `the highest ground is at r=${hiD.toFixed(1)}, not at the r=${F.r} edge`);
  // ...and the ejecta is finished by `rimWidth`, so the crater has a footprint.
  assert.ok(Math.abs(outside - plain) < 1e-9,
    `the rim is still ${(outside - plain).toFixed(3)} m proud past its own rimWidth`);
  /* The load-bearing comparison. A `basin` of the same depth and flat fraction
   * never rises above the ground it is cut into - that is the dent. */
  assert.ok(dentHi <= plain + 1e-9, `the basin ablation rose ${(dentHi - plain).toFixed(3)} m - it is not a fair control`);
  assert.ok(hiY - dentHi >= F.rim * 0.98, 'the crater stands no higher anywhere than the basin it replaces');
});

test('a dune field waves at the wavelength it claims, and holds a line across it', () => {
  /* `wavelength` is the whole reason this kind exists rather than another lump
   * of fbm: dunes are PERIODIC and they are TRANSVERSE, and a field that is
   * merely bumpy is ridged noise with a new name. Both halves are measured -
   * the crest spacing along the wind axis, and the fact that walking along a
   * crest is walking on the level. */
  const F = { kind: 'dunes', x: 0, z: 0, r: 160, amp: 6, wavelength: 20, angle: 0.4, sharpness: 0.6, taper: 0.25 };
  const h = only(F);

  const along = transect(h, F.x, F.z, F.angle, -110, 110, 0.25);
  const peaks = [];
  const troughs = [];
  for (let i = 1; i + 1 < along.y.length; i++) {
    if (along.y[i] > along.y[i - 1] && along.y[i] > along.y[i + 1]) peaks.push(along.s[i]);
    if (along.y[i] < along.y[i - 1] && along.y[i] < along.y[i + 1]) troughs.push(along.s[i]);
  }
  const gaps = peaks.slice(1).map((p, i) => p - peaks[i]);
  const meanGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;

  // The same field sampled ACROSS the wind, standing on a crest.
  const crestAt = peaks[Math.floor(peaks.length / 2)];
  const cx = F.x + Math.cos(F.angle) * crestAt;
  const cz = F.z + Math.sin(F.angle) * crestAt;
  const across = transect(h, cx, cz, F.angle + Math.PI / 2, -40, 40, 0.25);

  /* Asymmetry. `sharpness` claims a long windward back and a short slip face,
   * so the rise into a crest has to be measurably longer than the fall off it.
   * A sine would put these two at 1.00. */
  const before = Math.max(...troughs.filter((t) => t < crestAt));
  const after = Math.min(...troughs.filter((t) => t > crestAt));

  console.log('   DUNES (r 160, amp 6, wavelength 20, angle 0.4 rad, sharpness 0.6, taper 0.25)');
  console.log(`     ${peaks.length} crests over a 220 m transect, mean spacing ${meanGap.toFixed(2)} m`
    + ` (asked for ${F.wavelength}), tightest ${Math.min(...gaps).toFixed(2)}, widest ${Math.max(...gaps).toFixed(2)}`);
  console.log(`     relief along the wind ${spanOf(along.y).toFixed(2)} m (amp ${F.amp}),`
    + ` along the crest ${spanOf(across.y).toFixed(2)} m`
    + ` = ${((spanOf(across.y) / spanOf(along.y)) * 100).toFixed(1)}% of it`);
  console.log(`     windward back ${(crestAt - before).toFixed(1)} m, slip face ${(after - crestAt).toFixed(1)} m`
    + ` = ${((crestAt - before) / (after - crestAt)).toFixed(2)}x (a sine would be 1.00)`);

  assert.ok(Math.abs(meanGap - F.wavelength) <= F.wavelength * 0.05,
    `crests are ${meanGap.toFixed(2)} m apart, not the ${F.wavelength} m the record asks for`);
  assert.ok(Math.abs(spanOf(along.y) - F.amp) <= F.amp * 0.05,
    `the field is ${spanOf(along.y).toFixed(2)} m tall, not the ${F.amp} m asked for`);
  assert.ok(spanOf(across.y) <= spanOf(along.y) * 0.3,
    `the crest rises and falls ${spanOf(across.y).toFixed(2)} m along its own length - these are lumps, not dunes`);
  assert.ok((crestAt - before) / (after - crestAt) >= 2,
    'the windward back is not meaningfully longer than the slip face - sharpness is doing nothing');

  /* And the field is seeded off its own origin. Two identical records at two
   * places on one planet have to be two dune fields, not one pattern stamped
   * twice - which is the artefact you see the instant both are on screen. */
  const two = planetHeight({ ...BARE, landforms: [{ ...F, x: -220, z: -220 }, { ...F, x: 220, z: 220 }] });
  let worst = 0;
  for (let u = -60; u <= 60; u += 2) {
    for (let v = -60; v <= 60; v += 2) {
      worst = Math.max(worst, Math.abs(two(-220 + u, -220 + v) - two(220 + u, 220 + v)));
    }
  }
  console.log(`     two identical records at two origins differ by up to ${worst.toFixed(2)} m`
    + ` of their ${F.amp} m amplitude`);
  assert.ok(worst >= F.amp * 0.2, 'the two dune fields are one field moved - the seed is not the field own');
});

test('a scarp raises one side by its height and gets there in about its run', () => {
  const F = { kind: 'scarp', pts: [[-150, 0], [150, 0]], height: 25, run: 20, side: 1 };
  const h = only(F);
  const flipped = only({ ...F, side: -1 });

  const cut = transect(h, 0, 0, Math.PI / 2, -60, 60, 0.1);
  const high = h(0, 60);
  const low = h(0, -60);
  // Where the profile passes 5% and 95% of the step: the visible face.
  const at = (frac) => {
    const want = low + (high - low) * frac;
    for (let i = 0; i < cut.y.length; i++) if (cut.y[i] >= want) return cut.s[i];
    return NaN;
  };
  const face = at(0.95) - at(0.05);
  const halfway = (h(0, -F.run / 2) - low) / (high - low);

  console.log('   SCARP (straight, height 25, run 20, side +1)');
  console.log(`     high side ${high.toFixed(2)}   low side ${low.toFixed(2)}   step ${(high - low).toFixed(2)} m`);
  console.log(`     the face runs from ${at(0.05).toFixed(1)} to ${at(0.95).toFixed(1)} = ${face.toFixed(1)} m`
    + ` of the ${F.run} m run; at half the run it is ${(halfway * 100).toFixed(0)}% up`);
  console.log(`     side -1 puts the block on the other bank: high ${flipped(0, -60).toFixed(2)},`
    + ` low ${flipped(0, 60).toFixed(2)}`);

  assert.ok(Math.abs((high - low) - F.height) < 1e-9,
    `the two sides differ by ${(high - low).toFixed(3)} m, not the ${F.height} m asked for`);
  // Fully down by `run`, and not before: a scarp is a slope, not a step.
  assert.ok(Math.abs(h(0, -F.run - 0.5) - low) < 1e-9, 'the ground is still falling past the run');
  assert.ok(halfway > 0.3 && halfway < 0.7, `at half the run the face is ${(halfway * 100).toFixed(0)}% up - it is a step`);
  assert.ok(face >= F.run * 0.5 && face <= F.run, `the visible face is ${face.toFixed(1)} m of a ${F.run} m run`);
  // `side` really does pick the bank.
  assert.ok(Math.abs(flipped(0, -60) - high) < 1e-9 && Math.abs(flipped(0, 60) - low) < 1e-9,
    'side: -1 did not swap which bank is the high one');
});

test('a scarp never leaves a cliff hanging off the end of its own line', () => {
  /* The defect this case exists for.
   *
   * A scarp raises a half-plane, and "which side of the line am I on" is
   * answered by the perpendicular of the NEAREST segment. Walk off the end of
   * the authored polyline and that perpendicular flips across the segment own
   * extension while the distance to the line is still tens of metres - so the
   * naive version puts a `height`-tall vertical wall along a ray running out of
   * the last point, in mid-air, with flat nothing on either side of it. It is
   * invisible in a screenshot taken from anywhere except beside it, and a body
   * walks into it and stops.
   *
   * Continuity is the assertion because continuity is the property: over a
   * dense grid that extends well past both ends of the line AND past a bend, no
   * two neighbouring samples may differ by more than the steepest slope the
   * record can legitimately produce. */
  const F = { kind: 'scarp', pts: [[-120, -60], [0, 40], [130, -30]], height: 25, run: 20, side: 1 };
  const h = only(F);

  const STEP = 0.5;
  const LO = -260;
  const N = Math.round((-LO * 2) / STEP) + 1;
  /* The steepest a smoothstep of this height over this run can be, per sample
   * step: its slope peaks at 1.5 * height / run halfway down the face. */
  const ceiling = ((1.5 * F.height) / F.run) * STEP * Math.SQRT2;
  let jump = 0;
  let jumpAt = null;
  let nonFinite = 0;
  let prev = null;
  const row = new Float64Array(N);
  for (let j = 0; j < N; j++) {
    const z = LO + j * STEP;
    for (let i = 0; i < N; i++) {
      const x = LO + i * STEP;
      const v = h(x, z);
      if (!Number.isFinite(v)) nonFinite++;
      row[i] = v;
      const d = Math.max(i > 0 ? Math.abs(v - row[i - 1]) : 0, prev ? Math.abs(v - prev[i]) : 0);
      if (d > jump) { jump = d; jumpAt = [x, z]; }
    }
    if (!prev) prev = new Float64Array(N);
    prev.set(row);
  }

  console.log('   SCARP (3-leg, height 25, run 20) over a 0.5 m grid reaching 260 m past both of its ends');
  console.log(`     ${(N * N).toLocaleString()} samples, ${nonFinite} non-finite,`
    + ` largest step between neighbours ${jump.toFixed(3)} m at (${jumpAt[0]}, ${jumpAt[1]})`);
  console.log(`     the steepest the face itself can be over 0.5 m is ${ceiling.toFixed(3)} m`);
  assert.equal(nonFinite, 0, `${nonFinite} non-finite samples`);
  assert.ok(jump <= ceiling,
    `a ${jump.toFixed(2)} m step between samples 0.5 m apart at (${jumpAt}) - the scarp has a wall in it`);
  // Both banks are still what they claim, 250 m past the end of the authored line.
  assert.ok(Math.abs(h(250, 200) - F.height) < 1e-9, 'the raised block does not reach past the end of the line');
  assert.ok(Math.abs(h(250, -200)) < 1e-9, 'the low bank does not reach past the end of the line');
});

test('the new kinds are finite everywhere, including on top of each other', () => {
  /* Same reasoning as the Cinder case above and the same stakes - 19 NaN pixels
   * blacked out 921,600 through the bloom pass. What is new here is the
   * OVERLAP: a crater dug through a dune field with a scarp cutting across both
   * puts every one of the new divisions - by wavelength, by run, by radius - on
   * the same sample, which is the arrangement a real moonlet will use and the
   * one no single-landform case covers. */
  const forms = [
    { kind: 'dunes', x: -40, z: 20, r: 220, amp: 7, wavelength: 16, angle: 1.1, sharpness: 0.85, taper: 0.4 },
    { kind: 'dunes', x: 150, z: -150, r: 120, amp: 4, wavelength: 31, angle: -0.6, sharpness: 0, taper: 1 },
    { kind: 'crater', x: 0, z: 0, r: 90, depth: 24, rim: 7, rimWidth: 40, floor: 0.3 },
    { kind: 'crater', x: -180, z: 140, r: 30, depth: 6 },
    { kind: 'scarp', pts: [[-300, -120], [-40, -20], [120, 60], [300, 40]], height: 18, run: 25, side: -1 },
    { kind: 'pad', x: 0, z: 0, r: 22 },
  ];
  const h = planetHeight({
    seed: 11, half: 400, baseY: 4, swell: { amp: 9, scale: 130 }, ripple: { amp: 3, scale: 30 },
    grain: { amp: 0.6, scale: 5 }, rim: { start: 340, drop: 30 }, landforms: forms,
  });

  let bad = 0;
  let n = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let x = -400; x <= 400; x += 1) {
    for (let z = -400; z <= 400; z += 1) {
      const v = h(x, z);
      n++;
      if (!Number.isFinite(v)) bad++;
      else { if (v < lo) lo = v; if (v > hi) hi = v; }
    }
  }
  // And on the exact origins and vertices, where every radial and polyline term divides.
  for (const f of forms) {
    for (const [x, z] of f.pts ?? [[f.x, f.z]]) {
      assert.ok(Number.isFinite(h(x, z)), `${f.kind} at (${x}, ${z}) samples non-finite`);
    }
  }
  console.log('   OVERLAP: 2 dune fields, 2 craters, a scarp and a pad on one 800 m planet');
  console.log(`     ${n.toLocaleString()} samples at 1 m, ${bad} non-finite, range ${lo.toFixed(1)} .. ${hi.toFixed(1)} m`);
  assert.equal(bad, 0, `${bad} non-finite samples`);
});

test('degenerate parameters THROW at build time rather than sampling NaN', () => {
  /* A descriptor is DATA. `wavelength: 0` is a perfectly valid number to write
   * and it divides in the sampler; a `pts` with the same point twice is a
   * perfectly valid array and it leaves a zero-length segment with no
   * direction, so the line has no sides. Neither throws on its own - they
   * produce NaN and Infinity, three layers away from the record that caused it.
   *
   * The floor is that the FACTORY refuses, naming the landform and the field. */
  const cases = [
    ['crater with r 0', { kind: 'crater', x: 0, z: 0, r: 0, depth: 10 }, /"r" must be > 0/],
    ['crater with rimWidth 0', { kind: 'crater', x: 0, z: 0, r: 40, depth: 10, rimWidth: 0 }, /"rimWidth" must be > 0/],
    ['crater with a NaN depth', { kind: 'crater', x: 0, z: 0, r: 40, depth: NaN }, /"depth" must be a finite number, got NaN/],
    ['dunes with wavelength 0', { kind: 'dunes', x: 0, z: 0, r: 80, amp: 4, wavelength: 0 }, /"wavelength" must be > 0/],
    ['dunes with no wavelength', { kind: 'dunes', x: 0, z: 0, r: 80, amp: 4 }, /"wavelength" must be a finite number/],
    ['dunes with r 0', { kind: 'dunes', x: 0, z: 0, r: 0, amp: 4, wavelength: 12 }, /"r" must be > 0/],
    ['scarp with run 0', { kind: 'scarp', pts: [[-10, 0], [10, 0]], height: 5, run: 0 }, /"run" must be > 0/],
    ['scarp with two identical pts', { kind: 'scarp', pts: [[10, 10], [10, 10]], height: 5 }, /repeats pts\[0\]/],
    ['scarp with a repeated interior pt', { kind: 'scarp', pts: [[0, 0], [10, 0], [10, 0], [20, 5]], height: 5 }, /repeats pts\[1\]/],
    ['scarp with one pt', { kind: 'scarp', pts: [[10, 10]], height: 5 }, /at least 2 points/],
    ['scarp with side 0', { kind: 'scarp', pts: [[-10, 0], [10, 0]], height: 5, side: 0 }, /"side" must be \+1 or -1/],
  ];
  console.log('   DEGENERATE RECORDS (floor: every one throws, none of them samples)');
  for (const [name, f, re] of cases) {
    assert.throws(() => only(f), re, `${name} did not throw`);
    console.log(`     ${name.padEnd(34)} refused`);
  }

  /* The other half of the floor: the values NEXT to the degenerate ones are
   * legal and have to stay legal, or the guard has been set to reject shapes an
   * author actually wants. A taper of exactly 1 fades the whole field, a
   * sharpness of 1 is the sharpest slip face, a floor of 1 is a crater that is
   * all floor - all three sit exactly on a divide. */
  const extremes = [
    { kind: 'dunes', x: 0, z: 0, r: 80, amp: 4, wavelength: 12, taper: 1, sharpness: 1 },
    { kind: 'dunes', x: 90, z: 0, r: 60, amp: 4, wavelength: 12, taper: 0, sharpness: 0, angle: -3 },
    { kind: 'crater', x: -90, z: 60, r: 50, depth: 12, floor: 1 },
    { kind: 'crater', x: 60, z: -80, r: 50, depth: 12, floor: 0, rim: 0 },
    { kind: 'scarp', pts: [[-10, -90], [10, -90]], height: 5 },
  ];
  const h = only(extremes);
  let bad = 0;
  let n = 0;
  for (let x = -200; x <= 200; x += 0.5) {
    for (let z = -200; z <= 200; z += 0.5) { n++; if (!Number.isFinite(h(x, z))) bad++; }
  }
  console.log(`     taper 1 / sharpness 0 and 1 / floor 0 and 1 / rim 0:`
    + ` ${bad} non-finite over ${n.toLocaleString()} samples`);
  assert.equal(bad, 0, `${bad} non-finite samples from legal extreme parameters`);
});

test('the new kinds compose with the old ones without corrupting them', () => {
  /* Three separate claims, because "composes" is three different things.
   *
   * The first is the ORDERING one, and it is the same promise section 4 pins on
   * Cinder: the LEVEL pass runs last, so a `pad` still levels ground even when
   * the ground under it is a dune field 6 m tall. If `dunes` had gone in after
   * the level pass - or if `pad` had been made to read a partial field - the
   * landing guarantee would be quietly false on every sandy planet. */
  const DU = { kind: 'dunes', x: 0, z: 0, r: 160, amp: 6, wavelength: 20, angle: 0.4, taper: 0.25 };
  const PAD = { kind: 'pad', x: 0, z: 0, r: 25, blend: 10 };
  const disc = (h, x, z, r) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let a = 0; a < 64; a++) {
      const th = (a / 64) * Math.PI * 2;
      for (let k = 0; k <= 12; k++) {
        const v = h(x + Math.cos(th) * ((r * k) / 12), z + Math.sin(th) * ((r * k) / 12));
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    return hi - lo;
  };
  const onDunes = disc(only([DU, PAD]), 0, 0, PAD.r);
  const noPad = disc(only([DU]), 0, 0, PAD.r);
  console.log('   COMPOSITION');
  console.log(`     a pad on a dune field falls ${onDunes.toFixed(3)} m across its disc`
    + ` (without the pad, the same disc falls ${noPad.toFixed(2)} m)`);
  assert.ok(onDunes <= 0.05, `the pad only levelled the dunes to ${onDunes.toFixed(3)} m - the LEVEL pass is not last`);
  assert.ok(noPad >= 2, 'the ablation is not measuring anything - the dunes are not under the pad');

  /* The second is the same for a scarp, which is the harder case: a scarp is
   * unbounded on its high side, so a `ramp` crossing it is levelling ground the
   * ADD pass raised by 25 m and has to win anyway. */
  const SC = { kind: 'scarp', pts: [[-200, 0], [200, 0]], height: 25, run: 30, side: 1 };
  const RAMP = { kind: 'ramp', pts: [[0, -40], [0, 40]], width: 8, blend: 6 };
  const steepestOn = (h) => {
    let g = 0;
    for (let z = -40; z < 40; z += 0.5) g = Math.max(g, Math.abs(h(0, z + 0.5) - h(0, z)) / 0.5);
    return (Math.atan(g) * 180) / Math.PI;
  };
  const withRamp = steepestOn(only([SC, RAMP]));
  const bare = steepestOn(only([SC]));
  console.log(`     a ramp over a 25 m scarp: steepest 0.5 m step ${withRamp.toFixed(1)} deg`
    + ` (the unramped face is ${bare.toFixed(1)} deg)`);
  assert.ok(withRamp <= 38, `the ramp is ${withRamp.toFixed(1)} deg - the LEVEL pass did not win over the scarp`);
  assert.ok(bare > 38, 'the unramped scarp is walkable anyway - this proves nothing');

  /* The third is the NON-interference one. A new kind that reached into a
   * shared module scalar - `_polyS`, `_polyD`, `_polyC` - and left it dirty
   * would corrupt whichever polyline landform was evaluated next, and the
   * damage would surface on a `ridge` or a `ramp` that nobody had touched.
   * Interleaving the new forms among the old ones, far enough away to overlap
   * nothing, has to move the old ones by exactly zero. */
  const OLD = [
    { kind: 'ridge', pts: [[-100, -100], [0, 0], [100, -40]], width: 20, height: 8, taper: 0.3 },
    { kind: 'trench', pts: [[-90, 60], [90, 90]], width: 12, depth: 9, lip: 2 },
    { kind: 'cone', x: 60, z: -60, r: 40, peak: 18, pit: 0.3 },
    { kind: 'ramp', pts: [[-60, -30], [40, 20]], width: 9 },
  ];
  const NEW = [
    { ...DU, x: 900, z: 900, r: 60 },
    { kind: 'crater', x: -900, z: 900, r: 40, depth: 9 },
    { kind: 'scarp', pts: [[800, -900], [900, -800]], height: 12, side: -1 },
  ];
  const before = only(OLD, { swell: { amp: 6, scale: 150 } });
  const after = planetHeight({
    ...BARE, swell: { amp: 6, scale: 150 },
    landforms: [OLD[0], NEW[0], OLD[1], NEW[1], OLD[2], NEW[2], OLD[3]],
  });
  let drift = 0;
  let samples = 0;
  for (let x = -160; x <= 160; x += 1) {
    for (let z = -160; z <= 160; z += 1) {
      samples++;
      drift = Math.max(drift, Math.abs(before(x, z) - after(x, z)));
    }
  }
  console.log('     interleaving 3 new forms 1,200 m away among 4 old ones moved'
    + ` ${samples.toLocaleString()} samples of them by ${drift} m`);
  assert.equal(drift, 0, `the old landforms moved by ${drift} m - a new kind is leaving a shared scalar dirty`);
});

test('the three new kinds are in the published vocabulary', () => {
  /* The descriptor schema validates against exactly this list, so a kind the
   * field understands but the list omits is a landform no planet may use. */
  for (const k of ['crater', 'dunes', 'scarp']) {
    assert.ok(LANDFORM_KINDS.includes(k), `${k} is not in LANDFORM_KINDS`);
  }
  assert.equal(LANDFORM_KINDS.length, 12, `the vocabulary is ${LANDFORM_KINDS.length} kinds`);
  console.log(`   the vocabulary is ${LANDFORM_KINDS.length} kinds: ${LANDFORM_KINDS.join(', ')}`);
});
