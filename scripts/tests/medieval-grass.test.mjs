/**
 * THE GRASS MEMORY GATE.
 *
 * The meadow at 900 m is 1,594,413 blade instances across an 18x18 grid of
 * 50 m zones - 115.6 MB of `instanceMatrix` and `instanceColor`, built at load
 * and held forever. The draw cost was fine (every zone frustum-culls and every
 * zone hides itself past 86 m); the memory was not.
 *
 * The fix is residency: hold only the zones near the player. That trades a
 * fixed 115 MB for a bounded ~20 MB plus a placement pass while walking, and
 * it introduces exactly two ways to be wrong, both of which are what this file
 * tests:
 *
 *   1. A HOLE. A zone that can show a blade but is not resident is bare ground
 *      in front of the player. The build radius therefore has to lead the
 *      visibility radius by a real margin, at every position on the map, and
 *      that margin has to be derived from `GRASS_HIDE_DISTANCE` rather than
 *      guessed - so it is recomputed here from the constant the shader
 *      actually uses.
 *   2. A BOUND THAT IS NOT ONE. The budget only means something if the policy
 *      cannot want more zones than it, and if the per-zone instance count has
 *      a ceiling. Both are checked against the numbers in the source rather
 *      than against numbers written down here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { MEDIEVAL_LAYOUT } from '../../src/worlds/MedievalWorld.js';
import {
  GrassResidency, cellDistance,
  GRASS_BUILD_DISTANCE, GRASS_RELEASE_DISTANCE, GRASS_ZONE_BUDGET, GRASS_BYTES_PER_INSTANCE,
} from '../../src/worlds/medieval/GrassResidency.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORLD_SRC = readFileSync(path.join(root, 'src/worlds/MedievalWorld.js'), 'utf8');

/** Constants that live in the world file and are the real inputs here. */
const HIDE = Number(/const GRASS_HIDE_DISTANCE = (\d+)/.exec(WORLD_SRC)[1]);
const CLUMPS = Number(/const CLUMPS = (\d+)/.exec(WORLD_SRC)[1]);
const MAX_BLADES = Number(/const blades = 5 \+ \(\(rnd\(\) \* (\d+)\) \| 0\)/.exec(WORLD_SRC)[1]) + 5 - 1;

const R = () => new GrassResidency({
  zones: MEDIEVAL_LAYOUT.grassZones,
  zoneMetres: MEDIEVAL_LAYOUT.grassZoneMetres,
  half: MEDIEVAL_LAYOUT.half,
});

/* ------------------------------------------------------------------ */
/* The geometry the policy is built on                                 */
/* ------------------------------------------------------------------ */

test('cellDistance is the distance to the nearest point of the cell', () => {
  assert.equal(cellDistance(5, 5, 0, 0, 50), 0, 'inside is zero');
  assert.equal(cellDistance(-10, 25, 0, 0, 50), 10, 'due west');
  assert.equal(cellDistance(25, 70, 0, 0, 50), 20, 'due south');
  assert.equal(cellDistance(-30, -40, 0, 0, 50), 50, 'off the corner: 3-4-5');
  assert.equal(cellDistance(0, 0, 0, 0, 50), 0, 'on the corner');
});

test('zone keys round-trip and land where the grass loop puts them', () => {
  const r = R();
  for (let zz = 0; zz < r.zones; zz++) {
    for (let zx = 0; zx < r.zones; zx++) {
      const k = r.key(zx, zz);
      assert.equal(r.zoneX(k), zx);
      assert.equal(r.zoneZ(k), zz);
      /* Same expression the grass placement used before it was lazy:
       * `-HALF + (zx * SIZE) / ZONES`. A residency that indexed zones
       * differently from the builder would hold the wrong ones. */
      assert.equal(r.originX(zx), -MEDIEVAL_LAYOUT.half + (zx * MEDIEVAL_LAYOUT.size) / r.zones);
      assert.equal(r.originZ(zz), -MEDIEVAL_LAYOUT.half + (zz * MEDIEVAL_LAYOUT.size) / r.zones);
    }
  }
  assert.equal(r.zones * r.zones, 324);
});

/* ------------------------------------------------------------------ */
/* 1. No holes                                                         */
/* ------------------------------------------------------------------ */

test('the build radius leads visibility, derived from GRASS_HIDE_DISTANCE', () => {
  /* A zone hides itself when the nearest point of its bounding SPHERE is past
   * `GRASS_HIDE_DISTANCE`. Residency measures the nearest point of its
   * FOOTPRINT, which is a different and always larger number, so the two have
   * to be related rather than compared.
   *
   * Worst case is face-on: the sphere's centre is `span/2` beyond the near
   * face, and its radius is at least the half-diagonal of the cell. So the
   * footprint distance at which a zone can first draw a blade is
   *
   *     HIDE + radius - span/2
   *
   * ...which for a 50 m cell and a ~35.4 m half-diagonal is HIDE + 10.4 m. The
   * build radius must exceed that, and by enough that a one-zone-per-frame
   * build rate can keep up with a sprint. */
  const span = MEDIEVAL_LAYOUT.grassZoneMetres;
  const radius = Math.hypot(span / 2, span / 2);
  const canShow = HIDE + radius - span / 2;
  assert.ok(GRASS_BUILD_DISTANCE > canShow,
    `a zone can show a blade at ${canShow.toFixed(1)} m but is only built at ${GRASS_BUILD_DISTANCE} m`);
  const lead = GRASS_BUILD_DISTANCE - canShow;
  assert.ok(lead >= 25,
    `only ${lead.toFixed(1)} m of lead - at 8 m/s that is ${(lead / 8).toFixed(1)} s to build a zone`);
});

test('sweeping the whole map, every zone that could be visible is wanted', () => {
  /* The property in the form that matters: not "the radius is bigger" but
   * "at no position on the map is there a zone inside the visibility distance
   * that residency would not have built". Swept at 5 m, which is finer than a
   * zone by an order of magnitude. */
  const r = R();
  const span = r.span;
  const canShow = HIDE + Math.hypot(span / 2, span / 2) - span / 2;
  const half = MEDIEVAL_LAYOUT.half;
  for (let x = -half; x <= half; x += 5) {
    for (let z = -half; z <= half; z += 5) {
      let visible = 0;
      let wanted = 0;
      for (let k = 0; k < r.zones * r.zones; k++) {
        const d = r.distance(k, x, z);
        if (d <= canShow) { visible++; if (d <= GRASS_BUILD_DISTANCE) wanted++; }
      }
      assert.equal(wanted, visible, `a visible zone is not resident at (${x}, ${z})`);
      assert.ok(visible <= GRASS_ZONE_BUDGET,
        `${visible} zones are visible at (${x}, ${z}) but the budget is ${GRASS_ZONE_BUDGET}`);
    }
  }
});

test('the budget can hold everything the release radius wants', () => {
  /* If the cap were tighter than the policy, the two would fight: the cap
   * would evict a zone the release rule keeps, `decide` would ask for it back
   * next frame, and the world would rebuild the same zone forever. */
  const r = R();
  let maxBuild = 0;
  let maxRelease = 0;
  const half = MEDIEVAL_LAYOUT.half;
  for (let x = -half; x <= half; x += 5) {
    for (let z = -half; z <= half; z += 5) {
      let b = 0;
      let rel = 0;
      for (let k = 0; k < r.zones * r.zones; k++) {
        const d = r.distance(k, x, z);
        if (d <= GRASS_BUILD_DISTANCE) b++;
        if (d <= GRASS_RELEASE_DISTANCE) rel++;
      }
      if (b > maxBuild) maxBuild = b;
      if (rel > maxRelease) maxRelease = rel;
    }
  }
  assert.ok(GRASS_RELEASE_DISTANCE > GRASS_BUILD_DISTANCE, 'no hysteresis');
  assert.ok(GRASS_ZONE_BUDGET >= maxRelease,
    `the release radius holds ${maxRelease} zones but the budget is ${GRASS_ZONE_BUDGET}`);
  // Recorded, so a future change to the radii shows up as a number here.
  assert.equal(maxBuild, 37);
  assert.equal(maxRelease, 54);
});

/* ------------------------------------------------------------------ */
/* 2. The bound is a bound                                             */
/* ------------------------------------------------------------------ */

test('the resident set never exceeds the budget, walking the whole map', () => {
  const r = R();
  const half = MEDIEVAL_LAYOUT.half;
  let peak = 0;
  let builds = 0;
  // A long walk: a boustrophedon sweep at 4 m a step, which is faster than a
  // sprint and covers every part of the map including all four corners.
  for (let row = 0; row <= 36; row++) {
    const z = -half + row * 25;
    for (let s = 0; s <= 225; s++) {
      const x = row % 2 ? half - s * 4 : -half + s * 4;
      // Two ticks per step, as the world does one build per frame.
      for (let t = 0; t < 2; t++) {
        const { build, free } = r.decide(x, z, 1);
        assert.ok(build.length <= 1, 'decide ignored its per-tick limit');
        for (const k of free) {
          assert.ok(!build.includes(k), `zone ${k} is being built and freed in the same tick`);
          r.resident.delete(k);
        }
        for (const k of build) r.resident.set(k, true);
        builds++;
      }
      if (r.resident.size > peak) peak = r.resident.size;
      assert.ok(r.resident.size <= GRASS_ZONE_BUDGET,
        `${r.resident.size} zones resident at (${x}, ${z})`);
    }
  }
  assert.ok(peak > 30, `the walk only ever held ${peak} zones - it is not exercising the policy`);
  assert.ok(builds > 10000);
});

test('a zone is never freed and immediately rebuilt', () => {
  /* Hysteresis, in the form that costs money if it is missing: freeing is
   * cheap and rebuilding is a placement pass, so a player pacing across the
   * boundary must not be able to drive one. */
  const r = R();
  const seen = new Map();
  let churn = 0;
  for (let i = 0; i < 4000; i++) {
    // Pace back and forth across a zone boundary at the build radius.
    const x = -GRASS_BUILD_DISTANCE + (i % 2 ? 3 : -3);
    const { build, free } = r.decide(x, 0, 1);
    for (const k of free) { r.resident.delete(k); seen.set(k, (seen.get(k) || 0) + 1); }
    for (const k of build) r.resident.set(k, true);
  }
  for (const n of seen.values()) churn = Math.max(churn, n);
  assert.equal(churn, 0, `a zone was freed ${churn} times while pacing 6 m`);
});

test('the memory bound is real, and it is the one claimed', () => {
  /* Per-zone ceiling from the source: `CLUMPS` clump attempts, each seeding at
   * most `MAX_BLADES` instances. Nothing in the placement can exceed it, so
   * budget x ceiling x bytes is a hard cap rather than an average. */
  assert.equal(CLUMPS, 720, 'the clump density changed - it is a DENSITY, see the grass comment');
  assert.equal(MAX_BLADES, 9);
  const worst = GRASS_ZONE_BUDGET * CLUMPS * MAX_BLADES * GRASS_BYTES_PER_INSTANCE;
  const before = 1594413 * GRASS_BYTES_PER_INSTANCE;
  assert.equal(GRASS_BYTES_PER_INSTANCE, 76);
  assert.ok(before / 1048576 > 110 && before / 1048576 < 120,
    `the "before" figure moved: ${(before / 1048576).toFixed(1)} MB`);
  assert.ok(worst < 32 * 1048576,
    `worst case is ${(worst / 1048576).toFixed(1)} MB`);
  assert.ok(worst < before / 4,
    `${(worst / 1048576).toFixed(1)} MB against ${(before / 1048576).toFixed(1)} MB `
    + 'is not worth the streaming machinery');
});

/* ------------------------------------------------------------------ */
/* 3. The world consumes it, and rebuilds are identical                */
/* ------------------------------------------------------------------ */

test('the world builds grass lazily, per zone, from residency', () => {
  const code = WORLD_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  assert.ok(/this\._grass = new GrassResidency\(\{/.test(code),
    'the world no longer owns a GrassResidency');
  assert.ok(/for \(const key of this\._grass\.initial\(seed\.x, seed\.z\)\)/.test(code),
    'the initial zone set is no longer seeded at the player spawn');
  assert.ok(/this\._tickGrass\(/.test(code), 'nothing advances the grass frontier');
  assert.ok(/this\._lod\.remove\(mesh\)/.test(code),
    'a freed zone is not deregistered from DistanceLod - that is a leak and a '
    + 'per-frame distance test against disposed geometry');
  assert.ok(/mesh\.dispose\(\)/.test(code), 'a freed zone never releases its instance buffers');
  // ...and the zone still hides itself at the fade, which is the whole reason
  // holding fewer of them is free.
  assert.ok(/hideBeyond: GRASS_HIDE_DISTANCE, measure: SURFACE/.test(code));
});

test('a zone is seeded from its own coordinates, not from a shared stream', () => {
  /* The requirement that makes freeing safe. With the world's shared scatter
   * RNG, a zone's contents depended on how many zones happened to be built
   * before it - so walking away and back would reshuffle the meadow. */
  const code = WORLD_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  const m = /const rnd = mulberry32\(\((.*)\) >>> 0\);/.exec(code);
  assert.ok(m, 'the per-zone seed is gone');
  assert.ok(m[1].includes('zx') && m[1].includes('zz'),
    `the grass seed ${m[1]} does not depend on the zone`);

  // And the seed really is unique per zone across the whole grid.
  const seeds = new Set();
  for (let zz = 0; zz < 18; zz++) {
    for (let zx = 0; zx < 18; zx++) {
      // eslint-disable-next-line no-eval
      seeds.add(((0x6a55f00d ^ (zx * 73856093) ^ (zz * 19349663)) >>> 0));
    }
  }
  assert.equal(seeds.size, 324, 'two zones share a seed and would grow identical grass');
});

/* ------------------------------------------------------------------ */
/* 3. A BUILD THAT PLACES NOTHING                                      */
/* ------------------------------------------------------------------ */

/**
 * The third way to be wrong, and the one this file could not see.
 *
 * Every case above drives the policy with `r.resident.set(k, true)` - it models
 * a build that always succeeds. Some zones can never place a blade: zone 133 is
 * almost entirely inside the castle bailey's trodden ground, and `_settled`
 * rejects every candidate in it. `_buildGrassZone` returned null for those
 * without recording anything, so `decide()` re-offered the same key on the next
 * frame, forever.
 *
 * Measured in a browser, standing perfectly still: 600 build attempts in 600
 * frames, all returning null, 4.9-5.4 ms a frame at three of this map's
 * vantages - and, because `decide()` sorts nearest-first and truncates to one
 * build per frame, the empty zone won that slot every frame and NO other zone
 * was ever built. Arriving at Ravenshaw the world settled with one resident
 * grass zone out of about thirty.
 *
 * So the contract is: a build that places nothing must still take residency.
 */

/**
 * Drive the policy the way the world does, with `empty` never placing a blade.
 *
 * `recordEmpty` selects between the two callers: `true` is the world today,
 * `false` is the world before the fix, which returned null without recording.
 * The control case below runs with `false` so that these tests are known to be
 * capable of failing - a test that models only the fixed caller would pass
 * against the bug it exists to catch.
 */
function walk(r, positions, empty = new Set(), recordEmpty = true) {
  let attempts = 0;
  for (const [x, z] of positions) {
    for (let frame = 0; frame < 60; frame++) {
      const { build, free } = r.decide(x, z, 1);
      for (const k of free) r.resident.delete(k);
      for (const k of build) {
        attempts++;
        if (empty.has(k)) {
          // This is the line the world runs: null for a zone that placed nothing.
          if (recordEmpty) r.resident.set(k, null);
        } else {
          r.resident.set(k, true);
        }
      }
    }
  }
  return attempts;
}

test('CONTROL: not recording an empty zone starves the frontier, as it did', () => {
  /* The failure this file was blind to, reproduced deliberately. If this ever
   * stops failing to build the meadow, the model has drifted away from the
   * world and the three cases below stop meaning anything. */
  const r = R();
  const first = r.decide(0, 0, 1).build[0];
  const attempts = walk(r, [[0, 0]], new Set([first]), false);
  assert.equal(attempts, 60, 'the empty zone should be retried on every one of the 60 frames');
  assert.equal(r.resident.size, 0,
    'with the empty zone winning the single build slot, nothing else is ever built');
});

test('a zone that places no blades is still recorded, and is not retried forever', () => {
  const r = R();
  const centre = [0, 0];
  // Whatever the nearest zone to the origin is, make it place nothing.
  const first = r.decide(centre[0], centre[1], 1).build[0];
  assert.ok(first !== undefined, 'nothing was offered at the origin');

  const attempts = walk(r, [centre], new Set([first]));
  // One attempt per zone in range, not one per frame.
  assert.ok(attempts <= r.budget + 1,
    `${attempts} build attempts for at most ${r.budget} zones - the empty zone is being retried`);
  assert.ok(r.resident.has(first), 'the empty zone did not take residency');
  assert.equal(r.resident.get(first), null, 'an empty zone should be resident with no mesh');
});

test('an empty zone nearest the player does not starve the rest of the meadow', () => {
  /* The half that actually showed up as a hole in the ground. */
  const r = R();
  const first = r.decide(0, 0, 1).build[0];
  walk(r, [[0, 0]], new Set([first]));

  // Everything within the build radius should be resident, not just the one.
  let wanted = 0;
  for (let zz = 0; zz < r.zones; zz++) {
    for (let zx = 0; zx < r.zones; zx++) {
      if (r.distance(r.key(zx, zz), 0, 0) <= r.build) wanted++;
    }
  }
  const got = r.resident.size;
  assert.ok(got >= Math.min(wanted, r.budget),
    `${got} of ${wanted} in-range zones resident - the frontier is starved`);
  assert.ok(got > 1, 'only one zone was ever built, which is the Ravenshaw hole');
});

test('an empty zone is released like any other when the player leaves', () => {
  /* `_freeGrassZone` tests `has` rather than truthiness for exactly this: a
   * null-valued entry that returns early without deleting would pin the key
   * for the life of the world and burn one of the budget's slots. */
  const r = R();
  const first = r.decide(0, 0, 1).build[0];
  walk(r, [[0, 0]], new Set([first]));
  assert.ok(r.resident.has(first));

  // Walk far enough that everything falls outside the release radius.
  walk(r, [[0, 0], [400, 400]], new Set([first]));
  assert.ok(!r.resident.has(first), 'the empty zone was never released');
});

test('the world records residency for an empty zone, and frees on has() not truthiness', () => {
  /* Source-level, because the two halves live in MedievalWorld and the policy
   * object cannot see them. Both are one line and both are easy to undo. */
  const code = WORLD_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  assert.match(code, /if \(!placed\) \{[\s\S]{0,200}?resident\.set\(key, null\)/,
    'a zone that places no blades no longer takes residency - it will be retried every frame');
  assert.match(code, /if \(!this\._grass\.resident\.has\(key\)\) return;/,
    '_freeGrassZone tests the value again - a null-valued zone will never be evicted');
});
