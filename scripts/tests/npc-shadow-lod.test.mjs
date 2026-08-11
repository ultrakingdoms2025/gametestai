import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { NPCManager } from '../../src/npc/NPCManager.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The shadow-caster band in `NPCManager._updateLOD`.
 *
 * Characters are the dominant frame cost in the crowd worlds and their shadow
 * pass is most of it, so distant NPCs stop casting. The saving is real - 19% of
 * the citadel frame, 12% of the medieval one, measured against
 * `renderer.info.render.calls` - but it is only safe because it is a BAND.
 * A single boundary would turn a stride's worth of pelvis travel into a
 * per-frame castShadow toggle, and a shadow blinking is the most visible thing
 * an LOD switch can do.
 *
 * Everything below drives the REAL `_updateLOD` against stub characters, so the
 * band cannot drift from the shipped code the way a re-derivation would.
 */

/** A character that records every write to its two shadow-casting meshes. */
function stubNPC(x) {
  const writes = { body: 0, hair: 0 };
  const mesh = {
    _c: true,
    get castShadow() { return this._c; },
    set castShadow(v) { writes.body++; this._c = v; },
  };
  const hairMesh = {
    _c: true,
    get castShadow() { return this._c; },
    set castShadow(v) { writes.hair++; this._c = v; },
  };
  return {
    position: new THREE.Vector3(x, 0, 0),
    height: 1.8,
    root: { visible: true },
    animator: { sunk: false },
    humanoid: { mesh, hairMesh },
    lod: { distance: 0, ik: true, detail: true, rate: 1, visible: true, shadow: true },
    writes,
  };
}

/**
 * Run the real `_updateLOD` with no camera, so the eye is the player position
 * and every character is treated as on screen - the distance band is what is
 * under test, not the frustum test that sits beside it.
 */
function runLOD(npcs, eyeX) {
  const ctx = {
    _npcs: npcs,
    engine: null,
    player: { position: new THREE.Vector3(eyeX, 0, 0) },
  };
  NPCManager.prototype._updateLOD.call(ctx);
}

test('the shadow band is a band: crossing in and crossing out are different distances', () => {
  const npc = stubNPC(0);

  // Comes from far away: still not casting at 46 m, because 45 is the way IN.
  npc.lod.shadow = false;
  npc.humanoid.mesh._c = false;
  npc.humanoid.hairMesh._c = false;
  runLOD([npc], 46);
  assert.equal(npc.lod.shadow, false, 'started casting before reaching the inner edge');
  runLOD([npc], 44);
  assert.equal(npc.lod.shadow, true, 'inside the inner edge and still not casting');

  // Now walking away: it must NOT stop at 46 - that is inside the band.
  runLOD([npc], 46);
  assert.equal(npc.lod.shadow, true, 'the band has no width - 46 m both starts and stops the cast');
  runLOD([npc], 48);
  assert.equal(npc.lod.shadow, true, 'stopped casting before reaching the outer edge');
  runLOD([npc], 50);
  assert.equal(npc.lod.shadow, false, 'past the outer edge and still casting');
});

test('a character loitering on the boundary never toggles its shadow', () => {
  /* The failure this exists to catch, framed as the player would see it: a
   * character standing at the switch distance, jostled by a neighbour or just
   * swinging its pelvis through a stride, blinking its shadow every frame.
   * Jitter of +/-2 m around 46 m - well over a stride - must produce exactly
   * zero writes once the flag has settled. */
  const npc = stubNPC(0);
  npc.lod.shadow = false;
  npc.humanoid.mesh._c = false;
  npc.humanoid.hairMesh._c = false;
  runLOD([npc], 44);              // cross in
  const settled = { ...npc.writes };
  for (let i = 0; i < 200; i++) runLOD([npc], 47 + Math.sin(i) * 1.5);
  assert.deepEqual(npc.writes, settled,
    `${npc.writes.body - settled.body} castShadow writes while loitering in the band`);
  assert.equal(npc.lod.shadow, true, 'the flag left the band it never crossed');
});

test('the flag is written to both shadow-casting meshes, and only when it changes', () => {
  /* Two properties in one, because they are the same property: the body
   * SkinnedMesh and the hair shell are the character's only sun casters
   * (weapons cast too but measured zero draws saved, so they are left alone),
   * and a crowd re-asserting two flags per character per frame is exactly the
   * per-frame work this LOD exists to remove. */
  const npc = stubNPC(0);
  runLOD([npc], 5);
  assert.deepEqual(npc.writes, { body: 0, hair: 0 },
    'an unchanged flag still wrote castShadow');

  runLOD([npc], 100);
  assert.deepEqual(npc.writes, { body: 1, hair: 1 }, 'the far switch missed a mesh');
  assert.equal(npc.humanoid.mesh.castShadow, false);
  assert.equal(npc.humanoid.hairMesh.castShadow, false);

  for (let i = 0; i < 50; i++) runLOD([npc], 100);
  assert.deepEqual(npc.writes, { body: 1, hair: 1 }, 'the far state is re-written every frame');

  runLOD([npc], 5);
  assert.deepEqual(npc.writes, { body: 2, hair: 2 }, 'the near switch missed a mesh');
  assert.equal(npc.humanoid.mesh.castShadow, true);
  assert.equal(npc.humanoid.hairMesh.castShadow, true);
});

test('a bald character is not a crash - the hair shell is optional', () => {
  /* `buildHairGeometry` returns null for shaved styles, so `hairMesh` is null
   * on a real character often enough that an unguarded write would be a
   * first-crowd crash rather than a rare one. */
  const npc = stubNPC(0);
  npc.humanoid.hairMesh = null;
  runLOD([npc], 100);
  assert.equal(npc.humanoid.mesh.castShadow, false);
  assert.deepEqual(npc.writes, { body: 1, hair: 0 });
});

test('the band sits inside the contact-decal range, so no character loses both ground cues at once', async () => {
  /* The cast shadow is not the only thing telling a player a character is
   * standing on the floor: `_updateContactShadows` puts an AO decal under
   * everyone within 70 m. That decal is what makes culling the caster safe at
   * conversational-to-mid range, so the band must switch off WELL inside it -
   * if the two ranges ever crossed, characters would lose the cast shadow and
   * the decal at the same distance and start reading as pasted onto the
   * ground. Textual on the decal range because it is a literal in the loop. */
  const src = await readFile(path.join(root, 'src/npc/NPCManager.js'), 'utf8');
  const inM = Number(/const SHADOW_IN = (\d+(?:\.\d+)?);/.exec(src)?.[1]);
  const outM = Number(/const SHADOW_OUT = (\d+(?:\.\d+)?);/.exec(src)?.[1]);
  assert.ok(Number.isFinite(inM) && Number.isFinite(outM),
    'SHADOW_IN / SHADOW_OUT are no longer plain constants next to the other LOD bands');
  assert.ok(inM < outM, `the band is inverted: in ${inM} m, out ${outM} m`);

  const decal = Number(/npc\.lod\.distance > (\d+(?:\.\d+)?)\) continue;/.exec(src)?.[1]);
  assert.equal(decal, 70, 'the contact-decal range moved - re-check the band against it');
  assert.ok(outM < decal,
    `shadows stop at ${outM} m but the contact decal ends at ${decal} m - `
    + 'there is a range where a character has neither ground cue');

  /* And the threshold itself, pinned to the measurement in the docstring: 45 m
   * was chosen because it is the largest saving that changed no pixels in
   * either crowd world. 30 m saves ~110 more draws at the citadel and loses
   * visible shadows on market crates and stall tops; if this number drops,
   * re-run the pixel comparison rather than trusting the counter. */
  assert.equal(inM, 45, 'the shadow threshold moved without the pixel evidence moving with it');
});
