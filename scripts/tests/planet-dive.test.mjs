import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * THE LUNG: WHAT A PLAYER CAN GET TO UNDER WATER, AND WHAT IS PUT THERE.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DEFECT THIS FILE WAS WRITTEN FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This project's signature failure is content that is BUILT and cannot be
 * REACHED. It has shipped four times in the medieval expansion alone, and every
 * time the test that should have caught it verified that the thing existed
 * rather than that a player could get to it.
 *
 * Four planets publish swimmable water now, so there is a whole new class of
 * place to put things and a whole new way to put them out of reach - and the
 * limit is not a wall this time, it is a clock. `Swim` gives 14 seconds of
 * oxygen and then 9 damage a second. A reviewer of Shoal's new sea put it
 * exactly: "Oxygen is 14 s, so Shoal's deepest bed (40 m) is not divable - the
 * deep sea bed is still content nobody sees."
 *
 * So this file measures the lung and holds every underwater object on every
 * planet to it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE TWO RULES, AND WHY BOTH ARE NEEDED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   INSIDE THE LUNG. A prop or a deposit standing on a bed deeper than a
 *   round trip on one breath is content nobody can visit. The ceiling is
 *   computed from `Swim`'s own numbers, not from a figure typed here.
 *
 *   UNDER THE SURFACE. `scatter` places a POINT and `PlanetProps` picks the
 *   instance height off the field's size range afterwards, with no idea how
 *   deep the water over that point is. A 6 m kelp stipe on a bed 2 m down is a
 *   tree standing in the sea, and nothing anywhere in the build would notice.
 *   The bound is arithmetic - shallowest bed in the field plus tallest
 *   instance - so it is exact rather than sampled.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THE CONSTANTS ARE SCRAPED AND NOT IMPORTED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Swim.js` exports `ENTER_DEPTH` - which every probe that models a shore
 * imports, and rightly - and keeps `MAX_OXYGEN`, `DIVE_SPEED` and `RISE_SPEED`
 * module-private. Re-typing them here is how a fence ends up guarding a
 * puddle, so they are read out of the source instead, which is what
 * `planet-envelope.test.mjs` already does to the two reach probes' slope
 * ceilings. The regex is asserted to have matched, so a rename goes red naming
 * the constant rather than silently falling back to a default.
 *
 * If `Swim.js` ever exports them, delete `swimConstants()` and import.
 */

import { ENTER_DEPTH } from '../../src/player/Swim.js';
import { PLANETS } from '../../src/worlds/planets/index.js';
import { liquidSurfaceAt, liquidSwimmable, liquidGuards } from '../../src/worlds/planets/PlanetLiquid.js';
import { HEIGHT_FIELDS } from '../../src/worlds/terrain/index.js';
import { scatter } from '../../src/worlds/planets/Placement.js';

/**
 * `MAX_OXYGEN`, `DIVE_SPEED` and `RISE_SPEED`, read off `Swim.js`.
 * @returns {Promise<{oxygen:number, dive:number, rise:number}>}
 */
async function swimConstants() {
  const src = await readFile(new URL('../../src/player/Swim.js', import.meta.url), 'utf8');
  const one = (name) => {
    const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*([\\d.]+)\\s*;`));
    assert.ok(m, `Swim.js no longer declares \`const ${name} = <number>;\` - this file is measuring nothing.`
      + ' Either the constant was renamed (fix the regex) or it is now exported (import it and delete the scrape).');
    const v = Number(m[1]);
    assert.ok(Number.isFinite(v) && v > 0, `Swim.js ${name} reads ${m[1]}`);
    return v;
  };
  return { oxygen: one('MAX_OXYGEN'), dive: one('DIVE_SPEED'), rise: one('RISE_SPEED') };
}

/**
 * Seconds a diver keeps in hand at the bottom. Four, and it is a design number
 * rather than a physical one: a dive whose whole budget is spent travelling is
 * a dive that arrives and turns round, and nothing placed down there would be
 * looked at. It is stated here, once, so the two rules below share it.
 */
const RESERVE = 4;

/** Every planet with a swimmable liquid, derived rather than listed. */
const SWIMMABLE = Object.keys(PLANETS).filter((id) => {
  const L = PLANETS[id].liquid;
  return L?.bodies?.length && liquidSwimmable(L);
});

/** The height field, memoised - it is the only expensive thing in this file. */
const _h = new Map();
const heightOf = (id) => {
  let h = _h.get(id);
  if (!h) _h.set(id, (h = HEIGHT_FIELDS.planet(PLANETS[id].terrain)));
  return h;
};

/**
 * Every prop and mineral field on a planet, placed exactly as
 * `PlanetWorld._buildProps` and `_buildMinerals` place it: one LCG stream per
 * list, one step per field, in declaration order.
 */
const _fields = new Map();
function fieldsOf(id) {
  let out = _fields.get(id);
  if (out) return out;
  const P = PLANETS[id];
  const h = heightOf(id);
  const cell = (P.half * 2) / P.seg;
  out = [];
  for (const [kind, list, salt] of [['prop', P.props ?? [], 0x7f4a], ['mineral', P.minerals ?? [], 0x1d0e]]) {
    let seed = (P.terrain.seed ?? 1) ^ salt;
    for (const spec of list) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const res = scatter({
        region: spec.region, count: spec.count, spacing: spec.spacing ?? 0, seed,
        height: h, half: P.half, slopeStep: cell, liquid: P.liquid, landing: P.landing,
      });
      out.push({ kind, spec, res });
    }
  }
  _fields.set(id, out);
  return out;
}

/** The tallest instance a prop field can produce, in metres, or null. */
function tallest(spec) {
  const s = spec.size ?? {};
  const hi = (v) => (Array.isArray(v) ? Math.max(v[0], v[1]) : null);
  switch (spec.kind) {
    case 'growth': case 'spires': case 'columns': case 'shards': return hi(s.h);
    /* `boulders` scale by radius and `slabs` by thickness; both are handled by
     * the same question - how far above its own point can the geometry get. */
    case 'boulders': return s.rMax !== undefined ? s.rMax * 2 : null;
    case 'slabs': return hi(s.t);
    case 'vents': return hi(s.h);
    default: return null;
  }
}

/* ================================================================== */
/* 1. The lung, from Swim's own numbers                                */
/* ================================================================== */

test('the dive budget is computed from the movement code and not from a comment', async () => {
  const c = await swimConstants();
  const perMetre = 1 / c.dive + 1 / c.rise;
  const ceiling = c.oxygen / perMetre;
  const lung = (c.oxygen - RESERVE) / perMetre;
  console.log(`   Swim: ${c.oxygen} s of oxygen, ${c.dive} m/s down, ${c.rise} m/s up`
    + `   =>  ${perMetre.toFixed(3)} s a metre round trip`);
  console.log(`   the drowning ceiling (0 s to spare) is ${ceiling.toFixed(1)} m`);
  console.log(`   the LUNG (${RESERVE} s to spare at the bottom) is ${lung.toFixed(1)} m`);
  console.log(`   a wade becomes a swim at ${ENTER_DEPTH} m of bed depth`);
  assert.ok(lung > ENTER_DEPTH,
    `the lung is ${lung.toFixed(1)} m and swimming does not even start until ${ENTER_DEPTH} m`
    + ' - at that point there is no diving in this game and every rule below is vacuous');
  assert.ok(ceiling > lung, 'the reserve is bigger than the whole budget');
});

/* ================================================================== */
/* 2. Nothing under water is out of reach, on any planet               */
/* ================================================================== */

test('every object placed under water is inside one lungful', async () => {
  /* ALL the swimmable planets, not just the one that grew a kelp bed. A rule
   * that only runs where somebody already thought about it is a rule that
   * catches nothing - the next underwater field will be authored on a
   * different planet by somebody who has not read this file. */
  const c = await swimConstants();
  const lung = (c.oxygen - RESERVE) / (1 / c.dive + 1 / c.rise);
  const bad = [];
  let checked = 0;
  console.log(`   floor: nothing on a bed more than ${lung.toFixed(1)} m under its own surface`);
  for (const id of SWIMMABLE) {
    const P = PLANETS[id];
    for (const { kind, spec, res } of fieldsOf(id)) {
      let deepest = 0; let n = 0;
      for (const pt of res.points) {
        const surf = liquidSurfaceAt(P.liquid, pt.x, pt.z);
        if (surf === null || !Number.isFinite(surf)) continue;
        const depth = surf - pt.y;
        if (depth < ENTER_DEPTH) continue;   // wadeable, or dry: not a dive
        n++;
        if (depth > deepest) deepest = depth;
      }
      if (!n) continue;
      checked++;
      console.log(`     ${id.padEnd(11)} ${kind.padEnd(8)} ${spec.id.padEnd(16)} ${String(n).padStart(4)} of `
        + `${String(res.points.length).padStart(4)} under water, deepest ${deepest.toFixed(1)} m`);
      if (deepest > lung + 1e-6) {
        bad.push(`${id}/${spec.id}: ${n} instances under water, the deepest on a bed ${deepest.toFixed(1)} m down`
          + ` against a ${lung.toFixed(1)} m lung - a player cannot get to it and back`);
      }
    }
  }
  if (!checked) console.log('     none: no field on any swimmable planet reaches past the wading line');
  assert.deepEqual(bad, [], `content under water that one breath does not reach:\n  ${bad.join('\n  ')}`);
});

test('nothing placed under water stands out of it', async () => {
  /* The other end of the same window, and the one nothing else in the build
   * would catch. `scatter` returns a point; `PlanetProps` picks the height
   * afterwards from the field's own size range. The two never meet, so a
   * descriptor can put an 8 m plant on a bed 2 m down and get a tree in the
   * sea. Bound rather than sampled: shallowest eligible bed + tallest possible
   * instance. */
  const bad = [];
  for (const id of SWIMMABLE) {
    const P = PLANETS[id];
    for (const { kind, spec, res } of fieldsOf(id)) {
      if (kind !== 'prop') continue;
      const h = tallest(spec);
      if (h === null) continue;
      let worst = null;
      for (const pt of res.points) {
        const surf = liquidSurfaceAt(P.liquid, pt.x, pt.z);
        if (surf === null || !Number.isFinite(surf)) continue;
        if (surf - pt.y < ENTER_DEPTH) continue;
        const top = pt.y + h;
        if (!worst || top - surf > worst.over) worst = { over: top - surf, x: pt.x, z: pt.z, bed: pt.y, surf };
      }
      if (!worst) continue;
      console.log(`     ${id.padEnd(11)} ${spec.id.padEnd(16)} tallest ${h.toFixed(1)} m on the shallowest`
        + ` eligible bed leaves ${(-worst.over).toFixed(2)} m of water over it`);
      if (worst.over > 0) {
        bad.push(`${id}/${spec.id}: a ${h.toFixed(1)} m instance on the bed at (${worst.x.toFixed(0)},`
          + `${worst.z.toFixed(0)}) y ${worst.bed.toFixed(2)} tops out ${worst.over.toFixed(2)} m ABOVE the`
          + ' surface - narrow the field\'s `yMax` or its `size.h`');
      }
    }
  }
  assert.deepEqual(bad, [], `underwater props sticking out of the water:\n  ${bad.join('\n  ')}`);
});

/* ================================================================== */
/* 3. Shoal's sea bed, specifically                                    */
/* ================================================================== */

test('SHOAL: the deep bed is the map edge, and the sea proper is a diver\'s sea', async () => {
  /* The measurement that decided what to do about "the deep sea bed is content
   * nobody sees". Re-derived every run off the real height field, because the
   * whole answer rests on it: the 40 m is `terrain.rim`, and the sea inside the
   * rim is shallow enough to visit.
   *
   * REPORTED as a table and ASSERTED only on the two claims the descriptor
   * makes, so a landform edit that deepens the basin goes red here rather than
   * silently making the kelp unreachable. */
  const P = PLANETS.shoal;
  const c = await swimConstants();
  const perMetre = 1 / c.dive + 1 / c.rise;
  const lung = (c.oxygen - RESERVE) / perMetre;
  const ceiling = c.oxygen / perMetre;
  const h = heightOf('shoal');
  const half = P.half; const N = P.seg + 1; const step = (half * 2) / P.seg;
  const sea = P.liquid.bodies[0].y;
  const rim = P.terrain.rim.start;
  let wet = 0; let inner = 0; let innerDeepest = 0; let outerDeepest = 0; let innerInLung = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = -half + i * step; const z = -half + j * step;
      const y = h(x, z);
      assert.ok(Number.isFinite(y), `shoal: the height field is ${y} at (${x}, ${z})`);
      if (y >= sea) continue;
      wet++;
      const depth = sea - y;
      if (Math.max(Math.abs(x), Math.abs(z)) > rim) { outerDeepest = Math.max(outerDeepest, depth); continue; }
      inner++;
      innerDeepest = Math.max(innerDeepest, depth);
      if (depth <= lung) innerInLung++;
    }
  }
  const pct = (100 * innerInLung) / inner;
  console.log(`   ${wet.toLocaleString()} wet samples; ${inner.toLocaleString()} of them inside the ${rim} m rim`);
  console.log(`   deepest INSIDE the rim  ${innerDeepest.toFixed(1)} m   (${pct.toFixed(1)}% of it inside the ${lung.toFixed(1)} m lung,`
    + ` all of it within ${(innerDeepest - ceiling).toFixed(1)} m of the ${ceiling.toFixed(1)} m drowning ceiling)`);
  console.log(`   deepest OUTSIDE it      ${outerDeepest.toFixed(1)} m   - the map edge falling away, and nothing is on it`);

  /* CLAIM ONE: the 40 m figure the review quoted is the boundary of the world,
   * not the sea. If a landform edit ever makes the sea inside the rim as deep
   * as the skirt outside it, that sentence in `Shoal.js` becomes a lie. */
  assert.ok(outerDeepest > innerDeepest + 3,
    'shoal: the rim skirt is no deeper than the sea inside it, so "the 40 m is the map edge" is no longer'
    + ` true - inside ${innerDeepest.toFixed(1)} m, outside ${outerDeepest.toFixed(1)} m`);

  /* CLAIM TWO: the sea inside the rim is a diver's sea. Two halves, because
   * they say different things and only one of them is about comfort.
   *
   *   MOST OF IT IS COMFORTABLE. Floor 50, achieved 66. Deliberately well under
   *   the measurement: a floor at 65 would be a change detector, and what this
   *   is protecting is the design statement "you can swim down and look".
   *
   *   NONE OF IT IS FAR OUT OF REACH. The deepest in-bounds bed is 16.3 m,
   *   which is 0.6 m past the ceiling - six tenths of a second of drowning, or
   *   about five damage, for the deepest single sample on the planet. That is
   *   a sea with a bottom rather than a trench with a lid, and 3 m of tolerance
   *   is what keeps it one. */
  assert.ok(pct >= 50,
    `shoal: only ${pct.toFixed(1)}% of the sea inside the rim is inside a ${lung.toFixed(1)} m lung`
    + ' - the ocean world has become a room with a floor nobody can touch');
  assert.ok(innerDeepest <= ceiling + 3,
    `shoal: the sea inside the rim reaches ${innerDeepest.toFixed(1)} m against a ${ceiling.toFixed(1)} m`
    + ' drowning ceiling - the playable sea now has a floor a diver cannot touch at all, which is the'
    + ' defect this file exists for arriving by way of a landform edit rather than a prop record');
});

/* ================================================================== */
/* 4. Sundering Head, in terrain rather than in furniture              */
/* ================================================================== */

test('SHOAL: the Head is walled by its own face, and carries no barrier circle', async () => {
  /* Two claims, and they are one change measured from both sides.
   *
   * `planet-envelope.test.mjs` owns the CONSEQUENCE - abyssite 0 of 7 from the
   * primary pad at REAL + jump + swim. This owns the CAUSE, because a gate that
   * holds by four degrees is a gate that opens the next time somebody nudges a
   * landform, and the envelope case cannot say which of the ten planets' hills
   * is the marginal one.
   *
   * The band that matters is not the whole cliff. It is the strip a SWIMMER can
   * climb out into: standing ground (bed at or above `SEA - ENTER_DEPTH`) no
   * more than one `walkRise` above the waterline. Above that a swimmer cannot
   * reach; below it they are still swimming. Sampled on the same 2 m lattice
   * and the same 2 m central difference the reach probes use. */
  const P = PLANETS.shoal;
  const h = heightOf('shoal');
  const sea = P.liquid.bodies[0].y;
  const half = P.half; const N = P.seg + 1; const step = (half * 2) / P.seg;

  assert.equal(liquidGuards(P.liquid).length, 0,
    'shoal declares a `liquid.guard` again. A guard is a wall round a shore, and the reason this one went'
    + ' away is that Sundering Head now has the cliffs its own header claims. If a guard is back, either the'
    + ' terrain regressed or somebody reached for the furniture first.');

  /* The collision heightfield, sampled the way `Physics` samples it, so what is
   * measured is rise per 3.143 m cell rather than the analytic profile. */
  const grid = new Float32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) grid[j * N + i] = h(-half + i * step, -half + j * step);
  const sample = (x, z) => {
    const fx = (x + half) / step; const fz = (z + half) / step;
    const i = Math.floor(fx); const j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= N - 1 || j >= N - 1) return NaN;
    const tx = fx - i; const tz = fz - j;
    const a = grid[j * N + i]; const b = grid[j * N + i + 1];
    const cc = grid[(j + 1) * N + i]; const d = grid[(j + 1) * N + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (cc * (1 - tx) + d * tx) * tz;
  };
  const gradAt = (x, z) => Math.hypot((sample(x + 1, z) - sample(x - 1, z)) / 2, (sample(x, z + 1) - sample(x, z - 1)) / 2);

  const { WALKABLE_NORMAL_Y } = await import('../../src/npc/Grounding.js');
  const REAL = (Math.acos(WALKABLE_NORMAL_Y) * 180) / Math.PI;
  const realTan = Math.tan((REAL * Math.PI) / 180);
  /* The generous side of the swim-exit rule in `planet-envelope.test.mjs`. */
  const walkRise = Math.max(2.0 * realTan, 0.45);

  /* The Head, read out of the descriptor rather than typed. */
  const head = P.terrain.landforms.find((f) => f.kind === 'plateau' && f.y > 40);
  assert.ok(head, 'shoal has no high plateau - Sundering Head has been renamed or removed');
  const reach = head.r + (head.edge ?? 22) + 20;

  let shallowest = null; let band = 0; let standable = 0;
  for (let z = head.z - reach; z <= head.z + reach; z += 2) {
    for (let x = head.x - reach; x <= head.x + reach; x += 2) {
      if (Math.hypot(x - head.x, z - head.z) > reach) continue;
      const y = sample(x, z);
      if (!Number.isFinite(y)) continue;
      if (y < sea - ENTER_DEPTH || y > sea + walkRise) continue;
      band++;
      const g = gradAt(x, z);
      if (!shallowest || g < shallowest.g) shallowest = { g, x, z, y };
      if (g <= realTan) standable++;
    }
  }
  const deg = (t) => (Math.atan(t) * 180) / Math.PI;
  assert.ok(band > 50, `only ${band} cells in the Head's swim-exit band - the sampler is missing the island`);
  console.log(`   plateau r ${head.r} y ${head.y} edge ${head.edge}`);
  console.log(`   ${band} lattice cells in the band a swimmer could climb out into `
    + `(bed ${(sea - ENTER_DEPTH).toFixed(2)} .. ${(sea + walkRise).toFixed(2)})`);
  console.log(`   shallowest of them ${deg(shallowest.g).toFixed(1)} deg at (${shallowest.x}, ${shallowest.z})`
    + `   against the ${REAL.toFixed(2)} deg the game stands on`);
  assert.equal(standable, 0,
    `shoal: ${standable} of ${band} cells round Sundering Head are standing room at the REAL envelope, so a`
    + ` swimmer can climb out onto the island. Shallowest ${deg(shallowest.g).toFixed(1)} deg at`
    + ` (${shallowest.x}, ${shallowest.z}). The exotic guarantee is held up by this face.`);
  assert.ok(deg(shallowest.g) > REAL + 8,
    `shoal: the Head's shallowest exit-band cell is ${deg(shallowest.g).toFixed(1)} deg against a`
    + ` ${REAL.toFixed(2)} deg envelope - under 8 degrees of margin on a discretised heightfield is a gate`
    + ' that the next landform edit opens by accident');
});
