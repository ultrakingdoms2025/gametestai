/**
 * Every material the station draws has a name, and the reason that is a test
 * rather than a nicety.
 *
 * `scripts/world-shot.mjs --ablate <names>` hides every mesh drawn with a named
 * material and shoots again; the difference between the two frames is which
 * system owns a pixel. It is the tool that stopped the `art-medieval` pass
 * "fixing" the wrong system - the vale's white blow-out looked exactly like its
 * own light-spill cards, and one ablation proved in a single shot that it was
 * not, saving a cross-world change to a system shared by nine worlds.
 *
 * It matches on `material.name`. The station's Phase 9 baseline reported its
 * material breakdown as `MeshStandardMaterial x1070, MeshBasicMaterial x244` -
 * the class names, which is the harness's fallback when the name is empty. Not
 * one of this world's 225 materials had a name, so the A/B was unavailable on
 * the ENTRY WORLD, the one place a Phase 9 branch is most likely to need it.
 *
 * A name is metadata: `WebGLPrograms.getProgramCacheKey` does not read it, so
 * none of this can move the program count, which is the number this phase is
 * gated on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

import { StationWorld } from '../../src/worlds/StationWorld.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/* CRLF: this repo has had a source scrape pass in a worktree and fail in the
 * checkout for no other reason. Normalise before anchoring on anything. */
const source = (p) => readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const stub = (mat, group) => Object.assign(Object.create(StationWorld.prototype), { mat, group });

test('every material in the table is named station.<key>', () => {
  const mat = {
    trim: new THREE.MeshStandardMaterial(),
    emCyan: new THREE.MeshStandardMaterial(),
    crowd: new THREE.MeshStandardMaterial(),
    glassHull: new THREE.MeshPhysicalMaterial(),
  };
  stub(mat)._nameMaterials();
  assert.equal(mat.trim.name, 'station.trim');
  assert.equal(mat.emCyan.name, 'station.emCyan');
  assert.equal(mat.crowd.name, 'station.crowd');
  assert.equal(mat.glassHull.name, 'station.glassHull');
});

test('a clone does not steal its source material\'s name', () => {
  /* `M.plazaOnDeck = M.plaza.clone()` and `M.shaftBig = M.shaft.clone()` are
   * real lines in this world. `Material.clone` copies `name`, so a clone taken
   * after its source was named would arrive already called `station.plaza` -
   * and ablating `station.plaza` would then hide the deck surface AND its
   * on-deck variant, which is the wrong answer delivered with confidence. */
  const plaza = new THREE.MeshStandardMaterial();
  const mat = { plaza, plazaOnDeck: plaza.clone() };
  stub(mat)._nameMaterials();
  assert.equal(mat.plaza.name, 'station.plaza');
  assert.equal(mat.plazaOnDeck.name, 'station.plazaOnDeck');
  assert.notEqual(mat.plaza.name, mat.plazaOnDeck.name);
});

test('an already-named material is left alone', () => {
  const m = new THREE.MeshStandardMaterial();
  m.name = 'station.emGate_medieval';
  const mat = { emGate_medieval: m };
  stub(mat)._nameMaterials();
  assert.equal(m.name, 'station.emGate_medieval');
});

test('materials created outside the table are named after the mesh that draws them', () => {
  const group = new THREE.Group();
  const named = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  named.name = 'skyline:holoMarker';
  group.add(named);
  const already = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  already.material.name = 'station.trim';
  already.name = 'dome:trim';
  group.add(already);

  const n = stub({}, group)._nameStrayMaterials();
  assert.equal(n, 1, 'exactly one anonymous material should have been named');
  assert.equal(named.material.name, 'mesh:skyline:holoMarker');
  assert.equal(already.material.name, 'station.trim', 'a table material must keep its table name');
});

test('an anonymous mesh under an anonymous group takes the nearest NAMED ancestor', () => {
  /* The first version of this pass stopped at the mesh and its parent and
   * produced seven materials called `mesh:Mesh` - the class name, which is the
   * exact useless label the whole change exists to replace. The backdrop and
   * the holo markers are anonymous meshes under anonymous groups under a named
   * one, and the named one is the answer somebody typing `--ablate` wants. */
  const group = new THREE.Group();
  const outer = new THREE.Group();
  outer.name = 'space';
  const inner = new THREE.Group();          // deliberately anonymous
  const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  inner.add(m);
  outer.add(inner);
  group.add(outer);
  stub({}, group)._nameStrayMaterials();
  assert.equal(m.material.name, 'mesh:space');
});

test('a mesh with no named ancestor at all falls back to its type, not to a crash', () => {
  const group = new THREE.Group();
  const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  group.add(m);
  stub({}, group)._nameStrayMaterials();
  assert.equal(m.material.name, 'mesh:Mesh');
});

test('a mesh carrying an array of materials has all of them named', () => {
  const group = new THREE.Group();
  const m = new THREE.Mesh(new THREE.BoxGeometry(), [
    new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial(),
  ]);
  m.name = 'hull:multi';
  group.add(m);
  assert.equal(stub({}, group)._nameStrayMaterials(), 2);
  for (const mm of m.material) assert.equal(mm.name, 'mesh:hull:multi');
});

test('both naming passes are actually wired into the build', () => {
  /* The passes are worthless if nothing calls them, and "nothing calls them"
   * is exactly the failure the unit tests above cannot see. Anchored on the
   * call, not on a line number. */
  const src = source('src/worlds/StationWorld.js');
  assert.ok(/_buildMaterials\(\)\s*\{[\s\S]*?this\._nameMaterials\(\);/.test(src),
    '_buildMaterials no longer calls _nameMaterials - ablation is dead on this world again');
  assert.ok(src.includes('this._nameStrayMaterials();'),
    'nothing calls _nameStrayMaterials - the one-off materials go back to being anonymous');
});

test('the six gateway beacons name themselves, because the table pass has already run', () => {
  /* `M.emGate_<target>` is created inside `_buildGateway`, long after
   * `_buildMaterials` has finished naming the table. Without the inline name
   * it would fall through to `_nameStrayMaterials` and be called after
   * whichever mesh drew it first - and "is the portal beacon what is blowing
   * out this frame" is precisely the question an art pass on the entry world
   * needs to be able to type into `--ablate`. */
  const src = source('src/worlds/StationWorld.js');
  assert.ok(/const key = `emGate_\$\{s\.target\}`;\s*\n\s*M\[key\] = new THREE\.MeshStandardMaterial\(\{\s*\n\s*name: `station\.\$\{key\}`,/.test(src),
    'the gateway beacon material is no longer named at creation');
});
