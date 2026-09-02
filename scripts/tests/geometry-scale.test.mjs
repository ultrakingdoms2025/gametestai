import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import {
  TIERS,
  TIER_IDS,
  tessSegments,
  setGeometryScale,
  getGeometryScale,
  applyBootTier,
  applyTier,
} from '../../src/gfx/QualityTier.js';
import { cylGeo as stationCylGeo } from '../../src/worlds/station/StationKit.js';
import { InteriorKit } from '../../src/worlds/InteriorKit.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

/**
 * THE geometryScale LEVER, AND THE FOUR HELPERS THAT ARE SUPPOSED TO PULL IT.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * `QualityTier` grew a `geometryScale` and threaded it through four
 * tessellation helpers - `MedievalWorld`'s `cylGeo`/`coneGeo`,
 * `station/StationKit`'s `cylGeo` and `InteriorKit`'s `vcyl` - and NOTHING
 * asserted any of it. `quality-tier.test.mjs`'s monotonic-cost check runs over
 * a fixed five-field list (`msaa`, `shadowMapSize`, `far`, `maxPixelRatio`,
 * `resolutionFloor`) that does not include this field, so the table could drop
 * it and the suite would stay green.
 *
 * This repository's recorded failure mode is exactly that shape: a lever that
 * is built, wired once, and then silently stops being wired - the model-
 * without-a-view disease that left the leaderboard, the mastery screen and the
 * collection screen dead, and the `--ablate` flag that reported hits while
 * hiding nothing. A tessellation lever is a perfect host for it, because the
 * only symptom of losing it is that a desktop player's barrels are octagons
 * again, and no test and no crash ever says that out loud.
 *
 * ── Why every assertion here is on EMITTED GEOMETRY ───────────────────────
 *
 * A grep for `tessSegments(` in the four helpers would pass a helper that
 * reads the value and then builds with the authored count anyway - which is
 * the precise bug this lever is exposed to, since both numbers are in scope on
 * the same line. So each helper is CALLED, with the latch at 1 and at 1.5, and
 * the geometry it hands back is counted against a reference three builds
 * itself. Nothing here trusts source text except the two checks at the bottom,
 * which are about call sites rather than behaviour and say so.
 *
 * ── The one seam that is not airtight, stated rather than hidden ──────────
 *
 * `MedievalWorld`'s `cylGeo`/`coneGeo` are module-private and that world has
 * no headless build path (see the note at the top of
 * `scripts/tests/station-audit.test.mjs`), so this file compiles those two
 * function bodies OUT OF THE SOURCE and runs them with the real `tessSegments`
 * injected. That proves the bodies route their segment count through it and
 * that the geometry follows the latch; it cannot prove the module's own import
 * still points at `gfx/QualityTier.js`, so that import is asserted separately.
 */

/* ------------------------------------------------------------------ */
/* Rigs                                                                */
/* ------------------------------------------------------------------ */

/** Run `fn` with the module latch held at `scale`, then put it back. */
function atScale(scale, fn) {
  setGeometryScale(scale);
  try {
    return fn();
  } finally {
    setGeometryScale(1);
  }
}

/**
 * Compile a module-private helper out of its source and hand it the real
 * `tessSegments`. Brace-counted from the `function <name>(` header, so a
 * reformat moves with it and a rename fails loudly here rather than quietly
 * skipping the helper.
 */
function privateHelper(src, name) {
  const at = src.indexOf(`function ${name}(`);
  assert.notEqual(at, -1, `MedievalWorld.js no longer declares 'function ${name}(' - `
    + 'if it was renamed or exported, point this gate at the new name rather than deleting the case.');
  let depth = 0;
  let end = -1;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  assert.ok(end > at, `could not find the end of ${name}`);
  return new Function('THREE', 'tessSegments', `${src.slice(at, end)}\nreturn ${name};`)(THREE, tessSegments);
}

const MEDIEVAL_SRC = read('src/worlds/MedievalWorld.js');
const medievalCylGeo = privateHelper(MEDIEVAL_SRC, 'cylGeo');
const medievalConeGeo = privateHelper(MEDIEVAL_SRC, 'coneGeo');

/** `InteriorKit#vcyl` without the kit: the method only needs `_push`. */
function interiorVcyl(seg) {
  let out = null;
  InteriorKit.prototype.vcyl.call(
    { _push: (_key, g) => { out = g; } },
    'plank', 0, 0, 0, 1, 1, 2, seg,
  );
  assert.ok(out, 'InteriorKit#vcyl pushed nothing');
  return out;
}

/** Index count of the geometry three itself builds for a given radial count. */
const cylIndex = (seg) => new THREE.CylinderGeometry(1, 1, 2, seg, 1, false).index.count;
const coneIndex = (seg) => new THREE.ConeGeometry(1, 2, seg, 1, false).index.count;

/**
 * Every helper as { name, build(seg), refIndex(seg) }. One table, so a fifth
 * helper is one row and a helper that stops scaling names itself.
 */
const HELPERS = [
  { name: 'MedievalWorld cylGeo', build: (seg) => medievalCylGeo(1, 1, 2, seg, 0.5, false), refIndex: cylIndex },
  { name: 'MedievalWorld coneGeo', build: (seg) => medievalConeGeo(1, 2, seg, 0.5), refIndex: coneIndex },
  { name: 'StationKit cylGeo', build: (seg) => stationCylGeo(1, 1, 2, seg, 2, false), refIndex: cylIndex },
  { name: 'InteriorKit vcyl', build: (seg) => interiorVcyl(seg), refIndex: cylIndex },
];

/* -------------------------------------------------------- the table -- */

test('every tier carries a geometryScale, and it is the field that goes UP', () => {
  for (const id of TIER_IDS) {
    const s = TIERS[id].geometryScale;
    assert.equal(typeof s, 'number', `${id}.geometryScale is not a number`);
    assert.ok(Number.isFinite(s) && s >= 1,
      `${id}.geometryScale is ${s}; below 1 redraws the world coarser than any artist saw it, `
      + 'and `setGeometryScale` would clamp it away without saying so');
  }
  const [lo, mid, hi] = TIER_IDS.map((id) => TIERS[id].geometryScale);
  assert.ok(lo <= mid, 'low tessellates above medium');
  assert.ok(mid <= hi, 'medium tessellates above high');
  assert.ok(hi > lo, 'high does not tessellate above low, so the lever does nothing for anybody');

  /* The authored intent, pinned rather than assumed. `low` and `medium` sit at
   * 1.0 because the authored counts are already AT the floor (medieval's
   * histogram is radial 4-8) and a phone's bill is shader link and fill, not
   * static vertex buffers; `high` is 1.5 because the dominant radial-8 bucket
   * becomes 12 - a 30-degree facet - where 1.25 would give 10 and show in
   * nothing. Move these only with the picture that justifies it. */
  assert.equal(TIERS.low.geometryScale, 1, 'low no longer leaves the authored tessellation alone');
  assert.equal(TIERS.medium.geometryScale, 1, 'medium no longer leaves the authored tessellation alone');
  assert.equal(TIERS.high.geometryScale, 1.5, 'high is no longer the 1.5 the tessellation note argues for');
});

test('the default latch is 1, so a headless build is what shipped', () => {
  assert.equal(getGeometryScale(), 1);
  assert.equal(tessSegments(8), 8);
  for (const h of HELPERS) {
    assert.equal(h.build(8).index.count, h.refIndex(8), `${h.name} scaled something with no tier applied`);
  }
});

/* ------------------------------------------------- the wiring, boot -- */

test('applyBootTier latches the tier scale; applyTier deliberately does not', () => {
  try {
    applyBootTier(TIERS.high, { render: {} });
    assert.equal(getGeometryScale(), TIERS.high.geometryScale,
      'applyBootTier stopped latching geometryScale - the table would still read 1.5 and no world would build at it');

    /* Re-latching mid-session would leave the worlds already built at one
     * tessellation and the ones the lazy prefetcher builds next at another, so
     * `applyTier` is required NOT to move it. */
    setGeometryScale(1);
    applyTier(TIERS.high, {});
    assert.equal(getGeometryScale(), 1, 'applyTier now re-latches geometryScale mid-session');

    applyBootTier(TIERS.low, { render: {} });
    assert.equal(getGeometryScale(), 1, 'low did not come back to the authored tessellation');
  } finally {
    setGeometryScale(1);
  }
});

test('main.js still calls applyBootTier, which is the only thing that latches the scale', () => {
  /* Source, and only source: there is no headless boot. The behaviour either
   * side of this call is covered above; what is left to lose is the call. */
  assert.match(read('src/main.js'), /applyBootTier\(/,
    'nothing calls applyBootTier any more, so geometryScale is latched at 1 forever');
});

test('the four helpers still import the lever from gfx/QualityTier.js', () => {
  /* The seam the source-compiled medieval helpers cannot see. A helper that
   * imported a local copy would pass every behavioural test above and follow
   * nothing at boot. */
  for (const rel of [
    'src/worlds/MedievalWorld.js',
    'src/worlds/station/StationKit.js',
    'src/worlds/InteriorKit.js',
  ]) {
    assert.match(read(rel), /import\s*\{[^}]*\btessSegments\b[^}]*\}\s*from\s*'[^']*gfx\/QualityTier\.js'/,
      `${rel} no longer imports tessSegments from gfx/QualityTier.js`);
  }
});

/* ------------------------------------- the four helpers, by geometry -- */

for (const h of HELPERS) {
  test(`${h.name} builds at the latched scale, not at the authored count`, () => {
    /* 8 is the dominant authored bucket and 12 is what 1.5 makes of it - the
     * 45-degree facet becoming 30 degrees, which is the whole argument for the
     * number. A failure reading "expected the radial-8 count" means the helper
     * took the scale and threw it away, which a grep for `tessSegments(` would
     * have called wired. */
    const scaled = atScale(1.5, () => h.build(8));
    assert.equal(scaled.index.count, h.refIndex(12),
      `${h.name} emitted ${scaled.index.count} indices at scale 1.5; radial 12 is ${h.refIndex(12)}, `
      + `radial 8 is ${h.refIndex(8)}`);

    // A multiplier, not a hard-coded 12: two more points on the same line.
    assert.equal(atScale(1.5, () => h.build(4)).index.count, h.refIndex(6), `${h.name} at radial 4, scale 1.5`);
    assert.equal(atScale(2, () => h.build(5)).index.count, h.refIndex(10), `${h.name} at radial 5, scale 2`);

    // Up only: a scale below 1 is clamped away, so nothing is ever coarser.
    assert.equal(atScale(0.5, () => h.build(8)).index.count, h.refIndex(8),
      `${h.name} built coarser than the authored count`);
  });
}

test('radial 8 at 1.5 is the SAME geometry as radial 12 at 1, UVs included', () => {
  /* The trap all three helper comments name, and the one an index count cannot
   * see: the side/cap UV split is derived from the radial count, so building at
   * the scaled number and UV-ing at the authored one stretches every cap while
   * emitting exactly the right number of triangles.
   *
   * Asserting the split's arithmetic directly was tried and is too weak - with
   * the split left at the authored 8 the eight side vertices that fall past it
   * get cap treatment, and every per-band max stays in range. The check that
   * catches it is an identity: a scale is only a scale if scaling radial 8 by
   * 1.5 produces the same object as authoring radial 12 outright. That covers
   * positions, normals, UVs and the index in one, and it is the property a
   * reader would actually claim for `geometryScale`. */
  for (const h of HELPERS) {
    const scaled = atScale(1.5, () => h.build(8));
    const authored = h.build(12);
    assert.deepEqual(
      [...scaled.index.array],
      [...authored.index.array],
      `${h.name}: index differs between radial 8 at 1.5 and radial 12 at 1`,
    );
    for (const attr of ['position', 'normal', 'uv']) {
      const a = scaled.attributes[attr];
      const b = authored.attributes[attr];
      assert.ok(a && b, `${h.name}: missing '${attr}'`);
      assert.equal(a.count, b.count, `${h.name}: '${attr}' vertex count differs`);
      for (let i = 0; i < a.array.length; i++) {
        assert.ok(Math.abs(a.array[i] - b.array[i]) < 1e-6,
          `${h.name}: '${attr}'[${i}] is ${a.array[i]} at radial 8 x 1.5 but ${b.array[i]} at radial 12 - `
          + (attr === 'uv'
            ? 'the UV split is using one count while the geometry uses the other'
            : 'the scale is not equivalent to authoring the higher count'));
      }
    }
  }
});

/* ----------------------------------------- the deliberate exclusions -- */

/**
 * Every literal radial count handed to `cylGeo`/`coneGeo`, by balanced-paren
 * argument split. Non-literal arguments (variables, expressions) are skipped:
 * they cannot be judged from source and are not what the check below is for.
 */
function helperRadialLiterals(src) {
  const out = [];
  const re = /\b(cylGeo|coneGeo)\(/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    const args = [];
    let arg = '';
    for (let i = re.lastIndex; i < src.length && depth > 0; i++) {
      const ch = src[i];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) break;
      }
      if (depth === 1 && ch === ',') { args.push(arg.trim()); arg = ''; continue; }
      arg += ch;
    }
    args.push(arg.trim());
    const radial = args[m[1] === 'cylGeo' ? 3 : 2];
    if (radial !== undefined && /^\d+(\.\d+)?$/.test(radial)) out.push(Number(radial));
  }
  return out;
}

test('the radial-3 bridge-pier cutwaters are built raw, and stay out of the lever', () => {
  /* Three segments is a count this codebase uses ON PURPOSE - a cutwater reads
   * as a triangle because it is one - so these two are the call sites that must
   * never acquire a multiplier. At `high` the lever would make them pentagons: */
  assert.equal(atScale(1.5, () => tessSegments(3)), 5);

  const raw = [...MEDIEVAL_SRC.matchAll(/new THREE\.CylinderGeometry\(([^)]*)\)/g)]
    .map((m) => m[1].split(',').map((a) => a.trim()))
    .filter((args) => args[3] === '3');
  assert.equal(raw.length, 2,
    `expected two raw radial-3 CylinderGeometry cutwaters in MedievalWorld.js, found ${raw.length}. `
    + 'A cutwater routed through cylGeo scales, and a pier at high quality is then a pentagon.');

  /* And the converse: nothing that goes THROUGH the helpers is authored below
   * radial 4, which is the floor the up-only policy protects. A call site at 3
   * would be a cutwater that forgot to opt out. */
  const authored = helperRadialLiterals(MEDIEVAL_SRC);
  assert.ok(authored.length > 100,
    `only ${authored.length} literal radial counts found; the scan stopped seeing the call sites`);
  assert.deepEqual(authored.filter((n) => n < 4), [],
    'cylGeo/coneGeo call sites authored below radial 4 - see the cutwater argument above');
});
