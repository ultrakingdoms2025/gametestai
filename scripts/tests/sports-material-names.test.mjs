/**
 * Every material Meridian Athletic Grounds draws has a name, and the reason
 * that is a test rather than a nicety.
 *
 * `scripts/world-shot.mjs --ablate <names>` hides every mesh drawn with a named
 * material and shoots again; the difference between the two frames is which
 * system owns a pixel. It is the tool that stopped the `art-medieval` pass
 * "fixing" the wrong system, and it matches on `material.name`.
 *
 * This world's Phase 9 baseline reported its material breakdown as
 * `MeshStandardMaterial x247, paint.enamel x77, MeshBasicMaterial x5,
 * MeshPhysicalMaterial x4, ShaderMaterial x1` - the CLASS names, which is the
 * harness's fallback when a name is empty. One label in the whole world, and
 * it was not even this world's: `paint.enamel` is the shared library surface
 * `_metal` clones, so the only thing sports published told you a mesh was
 * painted metal and nothing about which of the eleven systems that call
 * `_metal` had painted it. The A/B was unavailable here, exactly as
 * `art-station` and `art-dock` each found it unavailable on their own worlds.
 *
 * A name is metadata: `WebGLPrograms.getProgramCacheKey` reads material type,
 * parameters, defines and `customProgramCacheKey`, and does not read `name`.
 * The branch's before/after confirms the program count did not move.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

import { SportsWorld } from '../../src/worlds/SportsWorld.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/* CRLF: this repo has had a source scrape pass in a worktree and fail in the
 * checkout for no other reason. Normalise before anchoring on anything. */
const source = (p) => readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const stub = (materials = new Map(), group = null) =>
  Object.assign(Object.create(SportsWorld.prototype), { _materials: materials, group });

test('_mat names a material as it registers it', () => {
  const w = stub();
  const m = new THREE.MeshStandardMaterial();
  w._mat('concrete.deck', m);
  assert.equal(m.name, 'sports.concrete.deck');
  assert.equal(w._materials.get('concrete.deck'), m, '_mat stopped registering');
});

test('a _metal clone is renamed to its OWN key, not left as paint.enamel', () => {
  /* `_metal` does `this.materials.get('paint.enamel').clone()`, and
   * `Material.clone` copies `name`. Before this pass all 77 of those clones
   * answered to one name, so `--ablate sports.paint.enamel` would have hidden
   * the rails, the goalposts, the masts, the fencing, the lift towers and the
   * plant all at once and reported whichever you were asking about as guilty. */
  const w = stub();
  const enamel = new THREE.MeshStandardMaterial();
  enamel.name = 'paint.enamel';
  const rail = enamel.clone();
  assert.equal(rail.name, 'paint.enamel', 'three stopped copying name on clone - the rest of this test is moot');
  w._mat('metal.rail', rail);
  assert.equal(rail.name, 'sports.metal.rail');
  assert.notEqual(rail.name, enamel.name);
});

test('_nameMaterials names everything in the library, including the one-offs', () => {
  /* Three families - the scoreboards, the kiosks and the plaza banners - mint
   * one material per instance and put it into `_materials` DIRECTLY rather
   * than through `_mat`. Naming from the map rather than from the call site
   * means a fourth family added the same way is named for free. */
  const materials = new Map([
    ['grass.field', new THREE.MeshStandardMaterial()],
    ['sign.COURT 1.41', new THREE.MeshStandardMaterial()],
    ['kiosk.-14.156', new THREE.MeshStandardMaterial()],
    ['banner.3', new THREE.MeshStandardMaterial()],
  ]);
  stub(materials)._nameMaterials();
  assert.equal(materials.get('grass.field').name, 'sports.grass.field');
  assert.equal(materials.get('sign.COURT 1.41').name, 'sports.sign.COURT 1.41');
  assert.equal(materials.get('kiosk.-14.156').name, 'sports.kiosk.-14.156');
  assert.equal(materials.get('banner.3').name, 'sports.banner.3');
});

test('an already-named material is left alone', () => {
  const m = new THREE.MeshStandardMaterial();
  m.name = 'sports.crowd.cloth';
  const materials = new Map([['crowd.skin', m]]);
  stub(materials)._nameMaterials();
  assert.equal(m.name, 'sports.crowd.cloth', 'a name set at the call site must win over the map key');
});

test('materials outside the library are named after the nearest NAMED ancestor', () => {
  const group = new THREE.Group();
  const named = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  named.name = 'lift-base';
  group.add(named);
  const already = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  already.material.name = 'sports.metal.galv';
  group.add(already);

  const n = stub(new Map(), group)._nameStrayMaterials();
  assert.equal(n, 1, 'exactly one anonymous material should have been named');
  assert.equal(named.material.name, 'mesh:lift-base');
  assert.equal(already.material.name, 'sports.metal.galv', 'a library material must keep its library name');
});

test('an anonymous mesh under an anonymous group takes the nearest named ancestor', () => {
  const group = new THREE.Group();
  const outer = new THREE.Group();
  outer.name = 'chairlift';
  const inner = new THREE.Group();          // deliberately anonymous
  const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  inner.add(m);
  outer.add(inner);
  group.add(outer);
  stub(new Map(), group)._nameStrayMaterials();
  assert.equal(m.material.name, 'mesh:chairlift');
});

test('a mesh with no named ancestor at all falls back to its type, not to a crash', () => {
  const group = new THREE.Group();
  const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  group.add(m);
  stub(new Map(), group)._nameStrayMaterials();
  assert.equal(m.material.name, 'mesh:Mesh');
});

test('the world group\'s own name is never used as a label', () => {
  /* `this.group` carries `world:sports`, which every mesh in the world is under.
   * Walking to it would name every stray material `mesh:world:sports` - one
   * label for the whole world, which is the same useless answer as no label. */
  const group = new THREE.Group();
  group.name = 'world:sports';
  const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  group.add(m);
  stub(new Map(), group)._nameStrayMaterials();
  assert.equal(m.material.name, 'mesh:Mesh');
});

test('a mesh carrying an array of materials has all of them named', () => {
  const group = new THREE.Group();
  const m = new THREE.Mesh(new THREE.BoxGeometry(), [
    new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial(),
  ]);
  m.name = 'scoreboard';
  group.add(m);
  assert.equal(stub(new Map(), group)._nameStrayMaterials(), 2);
  for (const mm of m.material) assert.equal(mm.name, 'mesh:scoreboard');
});

test('both naming passes are actually wired into the build', () => {
  /* The passes are worthless if nothing calls them, and "nothing calls them"
   * is exactly the failure the unit tests above cannot see. Anchored on the
   * calls, not on a line number. */
  const src = source('src/worlds/SportsWorld.js');
  assert.ok(/async build\(onProgress\)\s*\{[\s\S]*?this\._nameMaterials\(\);/.test(src),
    'build() no longer calls _nameMaterials - ablation is dead on this world again');
  assert.ok(/async build\(onProgress\)\s*\{[\s\S]*?this\._nameStrayMaterials\(\);/.test(src),
    'build() no longer calls _nameStrayMaterials - the one-off materials go back to being anonymous');
  assert.ok(/_mat\(key, material\)\s*\{[\s\S]{0,200}?material\.name = `sports\.\$\{key\}`;/.test(src),
    '_mat no longer names the material it registers');
});

test('the authored crowd assets are awaited before anything is built', () => {
  /* `_buildCrowd` reads `sportsCrowdParts()` and `sportsCrowdHas()`
   * SYNCHRONOUSLY, and the second decides whether a limb may be built with an
   * open end. A fetch merely started early is a race this world usually wins,
   * and losing it is silent in the worse direction. */
  const src = source('src/worlds/SportsWorld.js');
  const build = src.slice(src.indexOf('async build(onProgress)'));
  const awaitAt = build.indexOf('await loadSportsCrowdAssets();');
  const firstStage = build.indexOf("await stage(");
  assert.ok(awaitAt > 0, 'build() no longer awaits loadSportsCrowdAssets');
  assert.ok(awaitAt < firstStage,
    'loadSportsCrowdAssets is awaited after building has started - _buildCrowd can lose the race');
});
