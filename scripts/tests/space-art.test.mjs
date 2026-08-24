/**
 * THE ART-PASS INVARIANTS FOR OPEN SPACE (Phase 9, `art-space`).
 *
 * Three things this branch changed that are cheap to break again and that no
 * other test in the suite would notice, held against a REAL built `SpaceWorld`
 * rather than against source text.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  1. EVERY MATERIAL CARRIES A NAME
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `scripts/world-shot.mjs --ablate` is the only A/B this project has for the
 * question "which system owns this pixel", and it identifies materials BY
 * NAME. `art-station` found all 225 of its world's materials anonymous, so the
 * harness silently reported a class-name fallback and its whole ablation was
 * useless - it did not fail, it lied. Open space was in exactly that state:
 * 43 materials, of which ONE (`Sky.space`) carried a name.
 *
 * The name is free - `WebGLPrograms.getProgramCacheKey` never reads it - so
 * the only reason it was missing is that nothing asked for it. This asks.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  2. THE RIM FILL IS CREATED INVISIBLE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `LightRig` demotes every world light it claims and copies it into a fixed
 * slot, so the light count compiled into every shader never moves. But it
 * claims on `world:changed`, and the frame between `new DirectionalLight()`
 * and that walk is a frame in which the light COUNTS - and one such frame is a
 * full recompile of roughly 390 programs.
 *
 * `Caves.js` and `MazeChunks.js` already create theirs invisible with tests
 * enforcing it. The roadmap lists 61 sites across 12 world files that do not,
 * as Phase 1's open item 4. This is the one in this world's file.
 *
 * The rig built here has NO `LightRig` in its context, which is what makes the
 * assertion mean something: nothing has had a chance to set the flag, so what
 * is read is what `SpaceWorld._buildRim` wrote.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  3. THE BELT'S ALBEDO IS APPLIED ONCE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The material carried `color: tint` and every instance carried
 * `setColorAt(i, tint * variation)`; three multiplies `vColor` into
 * `diffuseColor`, so the field's albedo was the tint SQUARED. Held here as
 * well as in `belt-assets.test.mjs` because that file tests a `Belt` built in
 * isolation and this one tests the belt the world actually builds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { domHarness, rig } from './_flightrig.mjs';

domHarness();

/** The built `space` world, once. `rig()` caches it for the whole file. */
async function space() {
  const r = await rig();
  const w = r.wm._instances.get('space');
  assert.ok(w, 'the rig did not build a space world');
  assert.ok(w._built, 'the rig has a space world that was never built');
  return w;
}

test('every material in open space carries a name, so --ablate can see it', async () => {
  const w = await space();
  const anon = new Map();
  const named = new Set();
  w.group.traverse((o) => {
    const m = o.material;
    if (!m) return;
    for (const mm of (Array.isArray(m) ? m : [m])) {
      if (!mm) continue;
      if (mm.name) named.add(mm.name);
      else anon.set(mm.uuid, `${mm.type} on ${o.name || '(unnamed mesh)'}`);
    }
  });
  assert.equal(anon.size, 0,
    `${anon.size} material(s) in world:space have no name, so \`world-shot --ablate\` `
    + `cannot address them and reports a class-name fallback instead:\n  `
    + [...anon.values()].slice(0, 8).join('\n  '));
  /* A floor rather than an exact count: the claim is "they are all named",
   * and an exact number here would fail the next time somebody legitimately
   * adds or merges one. */
  assert.ok(named.size >= 20,
    `only ${named.size} distinct material names in world:space - something stopped naming them`);
  console.log(`   ${named.size} distinct named materials, 0 anonymous`);
});

test('every named material name is unique to what it draws', async () => {
  /* Two different materials sharing one name makes `--ablate` hide both and
   * report one, which is the same failure as no name at all wearing a hat. */
  const w = await space();
  const byName = new Map();
  w.group.traverse((o) => {
    const m = o.material;
    if (!m) return;
    for (const mm of (Array.isArray(m) ? m : [m])) {
      if (!mm?.name) continue;
      const set = byName.get(mm.name) ?? new Set();
      set.add(mm.uuid);
      byName.set(mm.name, set);
    }
  });
  const clashes = [...byName.entries()].filter(([, s]) => s.size > 1).map(([n, s]) => `${n} x${s.size}`);
  assert.deepEqual(clashes, [], `material names are shared by different instances: ${clashes.join(', ')}`);
});

test('the rim fill light is created invisible, so it never counts for a frame', async () => {
  const w = await space();
  assert.ok(w._rim, 'the rim fill is gone');
  assert.equal(w._rim.visible, false,
    'space:rim is created visible - the frame between construction and LightRig\'s '
    + 'claim is a frame in which the light count changes, and that is a full recompile');
  assert.equal(w._rim.castShadow, false,
    'space:rim casts a shadow - castShadow feeds numDirLightShadows into the program cache key');
  /* And it is still a real fill: an invisible light with zero intensity would
   * pass the line above and light nothing once the rig copies it into a slot. */
  assert.ok(w._rim.intensity > 0, 'space:rim has no intensity left to give its slot');
});

test('open space adds exactly one light of its own', async () => {
  /* The world's own header says "point lights 0 - everything that looks like a
   * lamp is emissive geometry above the bloom threshold", and `RIG_BUDGET` is
   * a fixed pool for the whole game. A second world light appearing here would
   * be a second thing competing for a fill slot and a second construction
   * frame to pay for. */
  const w = await space();
  const lights = [];
  w.group.traverse((o) => { if (o.isLight) lights.push(o); });
  assert.equal(lights.length, 1, `world:space carries ${lights.length} lights: ${lights.map((l) => l.name || l.type).join(', ')}`);
  assert.equal(lights[0].name, 'space:rim');
});

test('the belt the world builds shares one white named material', async () => {
  const w = await space();
  assert.ok(w.belt, 'the world has no belt');
  const mats = new Set(w.belt.meshes.map((m) => m.material.uuid));
  assert.equal(mats.size, 1,
    `the belt draws with ${mats.size} materials; they were byte-identical and are now one`);
  const mat = w.belt.meshes[0].material;
  assert.equal(mat.name, 'space:belt:rock');
  assert.equal(mat.color.getHex(), 0xffffff,
    'the belt material is tinted AND its instances are tinted - three multiplies the two, '
    + 'which is the squared albedo this pass removed');
  assert.equal(mat.flatShading, true, 'the belt lost its flat shading - a smooth 80-tri rock is a potato');
});

test('the belt still holds its field, and every rock has an instance', async () => {
  const w = await space();
  const belt = w.belt;
  const total = belt.meshes.reduce((n, m) => n + m.count, 0);
  assert.equal(total, belt.count, 'a rock was lost between the field and the buckets');
  /* No fetch in `node --test`, so the authored boulder is absent and this is
   * the DEGRADED arm - which is the one worth pinning, because it is the one
   * that has to keep working when the asset is missing in production. */
  assert.equal(belt.heroMesh, -1, 'the headless build should take the procedural arm');
  assert.equal(belt.meshes.length, 3);
  console.log(`   ${total} rocks over ${belt.meshes.length} buckets, ${belt.colliderRocks.length} with colliders`);
});
