import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { planetHeight, LANDFORM_KINDS } from '../../src/worlds/terrain/PlanetHeight.js';
import { HEIGHT_FIELDS } from '../../src/worlds/terrain/index.js';
import { definePlanet } from '../../src/worlds/planets/PlanetDescriptor.js';
import { VOLCANIC } from '../../src/worlds/planets/Volcanic.js';
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

const P = VOLCANIC;
const H = HEIGHT_FIELDS.planet(P.terrain);
const HALF = P.half;
const CELL = (HALF * 2) / P.seg;

/* ------------------------------------------------------------------ */
/* Shared sampling                                                     */
/* ------------------------------------------------------------------ */

/** The full terrain grid, sampled once and reused by every case below. */
function grid(height, seg = P.seg) {
  const n = seg + 1;
  const step = (HALF * 2) / seg;
  const h = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    const z = -HALF + j * step;
    for (let i = 0; i < n; i++) h[j * n + i] = height(-HALF + i * step, z);
  }
  return { h, n, step };
}

const G = grid(H);

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

test('the height field is deterministic to the bit', () => {
  const a = HEIGHT_FIELDS.planet(P.terrain);
  const b = HEIGHT_FIELDS.planet(P.terrain);
  const out = [];
  for (let j = 0; j <= 200; j++) {
    for (let i = 0; i <= 200; i++) {
      const x = -HALF + (i / 200) * HALF * 2;
      const z = -HALF + (j / 200) * HALF * 2;
      const va = a(x, z);
      assert.equal(va, b(x, z), `two factories disagree at (${x}, ${z})`);
      out.push(va);
    }
  }
  const digest = createHash('sha256').update(Buffer.from(new Float64Array(out).buffer)).digest('hex');
  console.log(`   Cinder 201x201 digest ${digest.slice(0, 16)}  (${out.length.toLocaleString()} samples)`);
  /* Not pinned to a literal. Cinder is being authored, and a hash that has to
   * be edited on every tuning pass is a hash nobody reads. What IS pinned is
   * the property that matters - two factories over one descriptor produce
   * identical numbers, so the worker and the main thread cannot drift. */
});

test('no sample anywhere is non-finite - NaN reaches the shader as a black frame', () => {
  /* Not a paranoid case. Four boxes with a zero tile gave NaN uvs in this repo
   * and 19 NaN pixels blacked out 921,600 through the bloom pass. A descriptor
   * is data: a zero radius or a taper of exactly 1 would divide here, not
   * throw. Checked on the build grid AND on a 4x finer one, because a NaN that
   * happens to fall between two grid samples still gets drawn. */
  let bad = 0;
  for (let k = 0; k < G.h.length; k++) if (!Number.isFinite(G.h[k])) bad++;
  assert.equal(bad, 0, `${bad} non-finite samples on the build grid`);

  const fine = grid(H, P.seg * 2);
  let badFine = 0;
  for (let k = 0; k < fine.h.length; k++) if (!Number.isFinite(fine.h[k])) badFine++;
  assert.equal(badFine, 0, `${badFine} non-finite samples on the 1.56 m grid`);

  // And on the exact centres of every landform, where the radial terms divide.
  for (const f of P.terrain.landforms) {
    const pts = f.pts ?? [[f.x, f.z]];
    for (const [x, z] of pts) {
      assert.ok(Number.isFinite(H(x, z)), `${f.kind} at (${x}, ${z}) samples non-finite`);
    }
  }
  console.log(`   finite at ${(G.h.length + fine.h.length).toLocaleString()} samples including every landform origin`);
});

/* ================================================================== */
/* 3. RELIEF - the Drop Three case                                    */
/* ================================================================== */

test('Cinder has authored relief, not fbm with a palette', () => {
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

/* ================================================================== */
/* 4. LANDING SITES - the promise the pads make                       */
/* ================================================================== */

test('every landing pad is flat, and flat by construction rather than by luck', () => {
  console.log('   LANDING PADS (floor: 0.30 m of fall across the usable disc)');
  const without = [];
  for (const s of P.landing) {
    let lo = Infinity;
    let hi = -Infinity;
    // 64 bearings x 12 radii, plus the centre: 769 samples per pad.
    for (let a = 0; a < 64; a++) {
      const th = (a / 64) * Math.PI * 2;
      for (let r = 0; r <= 12; r++) {
        const rr = (s.r * r) / 12;
        const y = H(s.x + Math.cos(th) * rr, s.z + Math.sin(th) * rr);
        if (y < lo) lo = y;
        if (y > hi) hi = y;
      }
    }
    /* The ceiling: the same disc with the pad landform removed. That is the
     * ground a ship would have been asked to sit on, and it is what makes the
     * flatness a measured consequence of the `pad` rather than an accident of
     * where the site happened to be put. */
    const noPad = planetHeight({
      ...P.terrain,
      landforms: P.terrain.landforms.filter((f) => !(f.kind === 'pad' && f.x === s.x && f.z === s.z)),
    });
    let nlo = Infinity;
    let nhi = -Infinity;
    for (let a = 0; a < 64; a++) {
      const th = (a / 64) * Math.PI * 2;
      for (let r = 0; r <= 12; r++) {
        const rr = (s.r * r) / 12;
        const y = noPad(s.x + Math.cos(th) * rr, s.z + Math.sin(th) * rr);
        if (y < nlo) nlo = y;
        if (y > nhi) nhi = y;
      }
    }
    console.log(`     ${s.id.padEnd(10)} r ${String(s.r).padStart(2)} m at y ${hi.toFixed(1).padStart(6)}`
      + `   fall across the disc ${(hi - lo).toFixed(3)} m`
      + `   (without its pad: ${(nhi - nlo).toFixed(1)} m)`);
    assert.ok(hi - lo <= 0.30, `pad ${s.id} falls ${(hi - lo).toFixed(3)} m across its usable disc`);
    without.push({ id: s.id, span: nhi - nlo });
  }

  /* THE CEILING, BY ABLATION - and it is a claim about the mechanism, not
   * about every pad.
   *
   * Colonnade Deck sits on a `plateau`, which is already dead level, so its own
   * ablation is 0.0 m and its pad is belt-and-braces. Asserting per-pad that
   * the ablation is worse would fail on it for the wrong reason. What has to be
   * true is that the LEVELLING IS REAL somewhere: Rimhold Shelf is cut into a
   * caldera rim that falls 64.8 m across the same disc, and if that number ever
   * collapses then `pad` has stopped levelling and every flatness figure above
   * is measuring ground that happened to be flat. */
  const worked = Math.max(...without.map((w) => w.span));
  console.log(`   without their pads the same discs fall: `
    + without.map((w) => `${w.id} ${w.span.toFixed(1)} m`).join(', '));
  assert.ok(worked >= 10,
    `no pad is levelling more than ${worked.toFixed(1)} m of fall - the pads are not what make the sites flat`);
});

test('nothing is scattered onto a landing pad', () => {
  /* Props and minerals that ignore a pad are how a ship lands inside a basalt
   * column. Every field that could reach a pad declares `clearOfPads`; this
   * measures the outcome rather than trusting the declaration. */
  let seed = (P.terrain.seed ?? 1) ^ 0x7f4a;
  let worst = Infinity;
  let culprit = null;
  for (const spec of [...P.props, ...P.minerals]) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const res = scatter({
      region: spec.region, count: spec.count, spacing: spec.spacing ?? 0, seed,
      height: H, half: HALF, slopeStep: CELL, liquid: P.liquid, landing: P.landing,
    });
    for (const pt of res.points) {
      for (const s of P.landing) {
        const d = Math.hypot(pt.x - s.x, pt.z - s.z) - s.r;
        if (d < worst) { worst = d; culprit = `${spec.id} at ${d.toFixed(2)} m from ${s.id}`; }
      }
    }
  }
  console.log(`   closest scattered object to a pad edge: ${culprit}`);
  assert.ok(worst > 0, `something is placed ON a pad: ${culprit}`);
});

/* ================================================================== */
/* 5. ROADS - the promise the ramps make                              */
/* ================================================================== */

test('every authored road stays inside the walking envelope', () => {
  /* 38 degrees is the ceiling `planet-reach.test.mjs` floods at, taken from
   * the driven onset measured in `Physics.js:1110`. A road steeper than that
   * anywhere along its length is not a road, and the flood would find it - this
   * case says WHICH road and WHERE, which the flood cannot. */
  console.log('   ROADS (floor: no 2 m segment over 38 deg)');
  const ramps = P.terrain.landforms.filter((f) => f.kind === 'ramp');
  assert.ok(ramps.length >= 3, 'the roads have gone');
  for (const f of ramps) {
    let len = 0;
    for (let i = 1; i < f.pts.length; i++) {
      len += Math.hypot(f.pts[i][0] - f.pts[i - 1][0], f.pts[i][1] - f.pts[i - 1][1]);
    }
    let worst = 0;
    let worstAt = null;
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
        const g = Math.abs(H(bx, bz) - H(ax, az)) / Math.hypot(bx - ax, bz - az);
        if (g > worst) { worst = g; worstAt = [bx, bz]; }
      }
    }
    const y0 = H(f.pts[0][0], f.pts[0][1]);
    const y1 = H(f.pts[f.pts.length - 1][0], f.pts[f.pts.length - 1][1]);
    const mean = (Math.atan(Math.abs(y1 - y0) / len) * 180) / Math.PI;
    const peak = (Math.atan(worst) * 180) / Math.PI;
    console.log(`     ${f.pts.length}-leg road, ${len.toFixed(0)} m, y ${y0.toFixed(1)} -> ${y1.toFixed(1)}:`
      + ` mean ${mean.toFixed(1)} deg, worst 2 m segment ${peak.toFixed(1)} deg`
      + ` at (${worstAt[0].toFixed(0)}, ${worstAt[1].toFixed(0)})`);
    assert.ok(peak <= 38, `a 2 m segment of this road is ${peak.toFixed(1)} deg`);
  }
});

/* ================================================================== */
/* 6. SHORELINES                                                      */
/* ================================================================== */

test('every liquid body meets the ground inside its own skirt', () => {
  /* A lake's drawn edge and the height at which the terrain actually crosses
   * its level disagree, because the terrain is noise. Small disagreements are
   * hidden by the apron; large ones are a strip of sky under the lava, or a
   * lake sitting on top of a hill. The apron is 5 m, so this is the bound. */
  console.log(`   LIQUID SHORELINES (floor: within the ${SKIRT.toFixed(1)} m skirt, and no terrain above the surface inside)`);
  for (const [i, b] of P.liquid.bodies.entries()) {
    /* Only a shoreline that sits BELOW the liquid needs the apron. An edge
     * buried IN the ground is invisible and is what the ribbon's extra width is
     * for - it laps the gorge walls on purpose. So this is one-sided. */
    let edgeWorst = 0;
    let buried = 0;
    let poke = -Infinity;
    if (b.shape === 'disc') {
      /* Sampled on `discRadiusAt`, which is the outline the MESH is built from.
       * Measuring the nominal radius while the mesh draws a wobbled one would
       * be measuring a shore that does not exist. */
      for (let a = 0; a < 256; a++) {
        const th = (a / 256) * Math.PI * 2;
        const R = discRadiusAt(b, th);
        const dy = H(b.x + Math.cos(th) * R, b.z + Math.sin(th) * R) - b.y;
        if (dy < 0) edgeWorst = Math.max(edgeWorst, -dy); else buried = Math.max(buried, dy);
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
          const y = b.y0 + (b.y1 - b.y0) * ((cum[k] + len * t) / total);
          poke = Math.max(poke, H(x, z) - y);
          for (const sgn of [-1, 1]) {
            const ex = x + (-dz / len) * sgn * b.width * 0.5;
            const ez = z + (dx / len) * sgn * b.width * 0.5;
            const dy = H(ex, ez) - y;
            if (dy < 0) edgeWorst = Math.max(edgeWorst, -dy); else buried = Math.max(buried, dy);
          }
        }
      }
    }
    console.log(`     body ${i} (${b.shape}): edge hangs ${edgeWorst.toFixed(2)} m over the ground`
      + ` / is buried ${buried.toFixed(2)} m in it, terrain above the surface inside ${poke.toFixed(2)} m`);
    assert.ok(edgeWorst <= SKIRT, `body ${i} edge hangs ${edgeWorst.toFixed(2)} m over the ground, past the ${SKIRT} m skirt`);
    assert.ok(poke <= 0.05, `body ${i} has terrain standing ${poke.toFixed(2)} m proud of its own surface`);
  }
});

/* ================================================================== */
/* 7. MINERALS                                                        */
/* ================================================================== */

test('every deposit the descriptor asks for is actually placed, and pays for the walk', () => {
  console.log('   MINERALS (floor: 100% of requested placed)');
  let seed = (P.terrain.seed ?? 1) ^ 0x1d0e;
  let total = 0;
  for (const spec of P.minerals) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const res = scatter({
      region: spec.region, count: spec.count, spacing: spec.spacing ?? 0, seed,
      height: H, half: HALF, slopeStep: CELL, liquid: P.liquid, landing: P.landing,
    });
    let lo = Infinity;
    let hi = -Infinity;
    let slopeMax = 0;
    for (const pt of res.points) {
      if (pt.y < lo) lo = pt.y;
      if (pt.y > hi) hi = pt.y;
      slopeMax = Math.max(slopeMax, slopeDegAt(H, pt.x, pt.z, CELL));
      total += Math.round(spec.credits[0] + pt.rnd * (spec.credits[1] - spec.credits[0]));
    }
    console.log(`     ${spec.id.padEnd(12)} ${res.points.length}/${spec.count} placed,`
      + ` ${spec.credits[0]}-${spec.credits[1]} cr, y ${lo.toFixed(0)}..${hi.toFixed(0)},`
      + ` steepest site ${slopeMax.toFixed(1)} deg,`
      + ` ${res.tries} tries`);
    assert.equal(res.points.length, spec.count,
      `${spec.id}: only ${res.points.length} of ${spec.count} could be placed - the region is too small or too filtered`);
    if (spec.region.slopeMaxDeg !== undefined) {
      assert.ok(slopeMax <= spec.region.slopeMaxDeg + 1e-6,
        `${spec.id} has a site at ${slopeMax.toFixed(1)} deg, past its ${spec.region.slopeMaxDeg} deg ceiling`);
    }
  }
  console.log(`   a full sweep of Cinder is worth ${total.toLocaleString()} credits`);
  /* Value has to spread, or every deposit is the same errand. The rarest thing
   * on the planet pays at least 7x the commonest. */
  const lowest = Math.min(...P.minerals.map((m) => m.credits[0]));
  const highest = Math.max(...P.minerals.map((m) => m.credits[1]));
  assert.ok(highest / lowest >= 7, `value spread is only ${(highest / lowest).toFixed(1)}x`);
  assert.ok(P.minerals.length >= 4, 'fewer than four kinds of ore is not an exploration loop');
});

test('every liquid surface faces UP', () => {
  /* A polygon wound the wrong way is invisible from the side you are standing
   * on and lit from the side you are not, and it looks EXACTLY like a surface
   * that is correctly there and merely dark. That is how 340 m of lava river in
   * the outlet gorge survived three review screenshots: the ribbon's triangles
   * were wound face-down, `computeVertexNormals` dutifully derived downward
   * normals from them, backface culling removed it from the frame, and what was
   * left underneath was ash-coloured ground that read as a cooled flow.
   *
   * A screenshot cannot answer "is this inside out". This can. */
  console.log('   LIQUID FACING (floor: every surface triangle normal has ny > 0.5)');
  const A = { x: 0, y: 0, z: 0 };
  const B = { x: 0, y: 0, z: 0 };
  for (const [i, b] of P.liquid.bodies.entries()) {
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
    console.log(`     body ${i} (${b.shape}): ${tris} triangles, worst upward component ${worst.toFixed(3)}`);
    assert.ok(worst > 0.5, `liquid body ${i} has a triangle facing ${worst.toFixed(3)} - it is wound inside out`);
  }
});

test('every prop field places what it asks for, within a margin', () => {
  /* `scatter` never pads a field to `count` - it reports the shortfall. That is
   * the right behaviour and it is exactly why this case has to exist: without
   * it, a descriptor can quietly ask for 260 columns, get 155, and nobody ever
   * looks. A field that under-delivers by more than 10% is a descriptor telling
   * itself a number it cannot have.
   *
   * The floor is on the OUTCOME, not on the request, because the request is the
   * thing being checked. */
  console.log('   PROP FIELDS (floor: 90% of requested placed)');
  let seed = (P.terrain.seed ?? 1) ^ 0x7f4a;
  for (const spec of P.props) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const res = scatter({
      region: spec.region, count: spec.count, spacing: spec.spacing ?? 0, seed,
      height: H, half: HALF, slopeStep: CELL, liquid: P.liquid, landing: P.landing,
    });
    const frac = res.points.length / spec.count;
    console.log(`     ${spec.id.padEnd(13)} ${spec.kind.padEnd(9)} ${res.points.length}/${spec.count}`
      + ` = ${(frac * 100).toFixed(0)}% at ${spec.spacing} m spacing, ${res.tries} tries`
      + `   rejects ${Object.entries(res.rejects).filter(([, v]) => v).map(([k, v]) => `${k}:${v}`).join(' ') || 'none'}`);
    assert.ok(frac >= 0.9,
      `${spec.id} placed only ${res.points.length} of ${spec.count} - the region cannot hold what the descriptor asks for`);
  }
});

test('the vocabulary is what the descriptor is allowed to say, and no more', () => {
  // A guard against the drift where a planet grows a one-off landform kind.
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
