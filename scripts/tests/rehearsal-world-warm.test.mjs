import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { forceDrawable } from '../../src/gfx/RehearsalDraw.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The boot rehearsal has to cover the WORLD, not just what the player carries.
 *
 * `rehearse()` in main.js drew the mounts, the viewmodels, the loot accents and
 * the avatar, then rendered three frames from the spawn camera. Everything
 * outside that one frustum was dropped by `projectObject` before it could link
 * a program or upload a buffer, so the warm finished at 494 programs and the
 * world held twelve more in reserve - paid for in a 1,275 ms frame the first
 * time the player looked somewhere new. Walking the station's own review
 * framings on a settled boot reproduced exactly that: +5 at `plaza-wide`, +5 at
 * `portal-sports`, +2 at `apron-wide`, and a thirteenth (a character's Sprite
 * name sign) once the world group alone was covered.
 *
 * The fix is to hand `forceDrawable` the world group, the gateways and the
 * crowd, so bearing stops being a variable. These tests hold the two halves of
 * that: the roots are actually passed (textual, because the call is the fix),
 * and un-culling a world group really does reach geometry a camera would have
 * dropped.
 */

test('the rehearsal draws the active world, the gateways and the crowd', async () => {
  const src = (await readFile(path.join(root, 'src/main.js'), 'utf8')).replace(/\r\n/g, '\n');
  const from = src.indexOf('async function rehearse()');
  assert.notEqual(from, -1, 'rehearse() is no longer a top-level function in main.js');
  // To the next top-level declaration, so the assertions below can only be
  // satisfied by code inside the rehearsal itself.
  const rest = src.slice(from + 1);
  const next = rest.search(/\n(?:async )?function \w+\(/);
  const fn = next === -1 ? rest : rest.slice(0, next);

  assert.match(fn, /worldManager\.active/,
    'the rehearsal no longer reaches for the active world - the world\'s programs go back to being '
    + 'linked under the player\'s mouse on the first change of view direction');
  assert.match(fn, /portals\.portals/,
    'the gateways are parented to the scene, not the world group; without them the two framings '
    + 'that face a gateway link on first sight');
  assert.match(fn, /npcManager\.npcs/,
    'the crowd is parented to the scene, not the world group; without it a character\'s Sprite '
    + 'name sign links the first time the player walks past one');

  const call = /forceDrawable\(\[([^\]]*)\]\)/.exec(fn)?.[1];
  assert.ok(call, 'rehearse() no longer calls forceDrawable with a root list');
  assert.match(call, /worldRoots/,
    'the world/gateway/crowd roots are collected but never handed to forceDrawable');
});

test('un-culling a world group reaches geometry a camera would have dropped', () => {
  /* The mechanism, stated as the renderer sees it: `projectObject` drops an
   * object that is outside the frustum before its material is ever touched, so
   * a mesh behind the spawn camera contributes no program and no buffer upload.
   * Clearing `frustumCulled` across the whole world group is what makes one
   * frame equivalent to looking in every direction at once. */
  const world = new THREE.Group();
  world.name = 'world';
  const behindCamera = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  behindCamera.name = 'behind';
  behindCamera.position.set(0, 0, 500);
  const parkedInterior = new THREE.Group();
  parkedInterior.name = 'interior';
  parkedInterior.visible = false;
  const interiorMesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  interiorMesh.name = 'interior-mesh';
  parkedInterior.add(interiorMesh);
  world.add(behindCamera, parkedInterior);

  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 100);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
  behindCamera.updateMatrixWorld();
  assert.equal(frustum.intersectsObject(behindCamera), false,
    'the test is worthless unless the mesh really is outside the spawn frustum');

  const restore = forceDrawable([world]);
  assert.equal(behindCamera.frustumCulled, false, 'a mesh outside the frustum was left culled');
  assert.equal(interiorMesh.visible, true, 'a parked interior was left hidden');
  assert.equal(parkedInterior.visible, true, 'the parked parent still blocks the subtree');

  restore();
  assert.equal(behindCamera.frustumCulled, true, 'the world was left permanently un-culled');
  assert.equal(parkedInterior.visible, false, 'a parked interior was left showing after the warm');
});
