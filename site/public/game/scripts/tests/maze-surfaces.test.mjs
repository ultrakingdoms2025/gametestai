import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  buildMazeMaterials, declaredTextureBytes, MAZE_TEXTURE_SIZES,
} from '../../src/worlds/maze/MazeMaterials.js';
import { prefabFor } from '../../src/worlds/maze/MazeMeshes.js';

/**
 * Task 5's gate: real PBR surfaces from real height fields.
 *
 * Phase 5 stopped at colour maps and wrote down why: `makeNormalFromHeight`
 * takes a Float32Array HEIGHT FIELD, and the API Phase 5 called could not hand
 * one back. `bakeSurface` emits albedo + height + packed ORM from ONE noise
 * walk - the machinery `Textures.js` was built with - so this suite asserts
 * the maze now uses it: every principal surface carries the full set, the ORM
 * is genuinely shared between its two material slots, and the byte budget the
 * plan set is declared in code rather than implied by it.
 */

const SURFACED = ['hedge', 'floor', 'stair', 'footing', 'tunnel'];

test('the maze surfaces its principal materials, not just tints them', () => {
  const m = buildMazeMaterials();
  for (const kind of ['hedge', 'floor', 'stair', 'footing']) {
    assert.ok(m[kind].map, `${kind} has no albedo`);
    assert.ok(m[kind].normalMap, `${kind} has no normal map - it will read flat at any distance`);
    assert.ok(m[kind].roughnessMap, `${kind} has no ORM - roughness is uniform across the surface`);
  }
});

test('one ORM texture serves ao, roughness and metalness', () => {
  /* Three separate greyscale maps is three uploads and three samplers for data
   * that packs into one RGB. Textures.js bakes it packed already; wiring it to
   * one slot and generating two more would be paying twice for the same texels. */
  const m = buildMazeMaterials().hedge;
  assert.equal(m.roughnessMap, m.metalnessMap, 'ORM is not shared between roughness and metalness');
  if (m.aoMap) assert.equal(m.aoMap, m.roughnessMap, 'a separate AO texture was generated');
});

test('the texture budget is declared and respected', () => {
  const bytes = declaredTextureBytes(); // from the size table in MazeMaterials.js
  assert.ok(bytes <= 96 * 1024 * 1024, `${(bytes / 1048576).toFixed(1)} MB of maps, budget 96 MB`);
});

test('every surfaced kind carries the full set, tunnel included, at its declared size', () => {
  /* The plan's own first test names four kinds; the task's interface names
   * five. The size assertion is the one with teeth: the declared table is
   * what `declaredTextureBytes` sums, so a bake that quietly outgrew its
   * declaration would otherwise pass the budget test while lying to it. */
  const m = buildMazeMaterials();
  for (const kind of SURFACED) {
    const declared = MAZE_TEXTURE_SIZES[kind];
    assert.ok(declared, `${kind} has no entry in the size table`);
    for (const slot of ['map', 'normalMap', 'roughnessMap']) {
      const tex = m[kind][slot];
      assert.ok(tex, `${kind} has no ${slot}`);
      assert.equal(tex.image.width, declared,
        `${kind}.${slot} is ${tex.image.width}px against a declared ${declared}px`);
    }
  }
  /* 1024 is reserved for the two surfaces a player stands nose-to. */
  assert.equal(MAZE_TEXTURE_SIZES.hedge, 1024);
  assert.equal(MAZE_TEXTURE_SIZES.floor, 1024);
  for (const kind of ['stair', 'footing', 'tunnel']) {
    assert.equal(MAZE_TEXTURE_SIZES[kind], 512, `${kind} does not need nose-to resolution`);
  }
});

test('no surfaced material double-tints its own albedo', () => {
  /* three multiplies `map` by `color`. The albedo is AUTHORED now - the tone
   * lives in the texels - so a leftover Phase 2 tint would darken every map
   * twice and read as grime nobody painted. White is the identity. */
  const m = buildMazeMaterials();
  for (const kind of SURFACED) {
    assert.equal(m[kind].color.getHex(), 0xffffff,
      `${kind}'s colour tint ${m[kind].color.getHexString()} multiplies its authored albedo`);
  }
});

test('aoMap is only wired where a second UV set exists to feed it', () => {
  /* three samples aoMap from the texture's declared channel; none of the maze
   * prefabs carries a uv1 attribute, so wiring the slot would either silently
   * sample the wrong channel or silently no-op depending on the three
   * version's default - both worse than not wiring it. Contact occlusion is
   * already baked into vertex colours (Task 4), which is the honest statement
   * of what AO data this world actually has per-instance. */
  const m = buildMazeMaterials();
  for (const kind of SURFACED) {
    if (!m[kind].aoMap) continue;
    for (const lod of [0, 1, 2]) {
      const g = prefabFor({ kind, hx: 0.6, hy: 2.5, hz: 3, lod });
      assert.ok(g.attributes.uv1 || g.attributes.uv2,
        `${kind} wires aoMap but its LOD${lod} prefab has no second UV set - a silent no-op`);
    }
  }
});

test('prefab UVs are world-scale metres, on every prefab family', () => {
  /* The decision Task 4 explicitly handed to this task. Per-face 0..1 UVs
   * stretch a map by whatever the face measures - the same earth grain spans
   * 1.4 m on one floor slab and 24 m on its neighbour - and a normal map
   * makes that stretch legible as smeared relief. World-scale UVs give
   * constant texel density everywhere, and the stair prefab has carried them
   * since Task 2 for exactly this moment; this test holds the other two
   * prefab builders (plain box, chamfered box) to the same convention. */
  const cases = [
    ['hedge', 0], // plain box at LOD0 (bevel deferred to Task 7)
    ['slideWall', 0], // the chamfered-box builder
    ['floor', 1], // the box LOD every kind degrades to
    ['stair', 0], // the sweep, world-scale since Task 2
  ];
  for (const [kind, lod] of cases) {
    const g = prefabFor({ kind, hx: 2.4, hy: 2.5, hz: 0.6, lod });
    const uv = g.attributes.uv;
    let minU = Infinity; let maxU = -Infinity;
    for (let i = 0; i < uv.count; i++) {
      minU = Math.min(minU, uv.getX(i));
      maxU = Math.max(maxU, uv.getX(i));
    }
    /* A 4.8 m box face must span metres of UV, not the unit square. */
    assert.ok(maxU - minU > 3.5,
      `${kind}@lod${lod} spans ${(maxU - minU).toFixed(2)} in u - still per-face 0..1 UVs`);
  }
});

test('world-scale UVs demand RepeatWrapping, and the bake convention supplies it', () => {
  /* With UVs in metres every coordinate leaves 0..1 immediately; a clamped
   * texture would smear its border texel down every surface in the world. */
  const m = buildMazeMaterials();
  for (const kind of SURFACED) {
    for (const slot of ['map', 'normalMap', 'roughnessMap']) {
      const tex = m[kind][slot];
      assert.equal(tex.wrapS, THREE.RepeatWrapping, `${kind}.${slot} does not wrap in s`);
      assert.equal(tex.wrapT, THREE.RepeatWrapping, `${kind}.${slot} does not wrap in t`);
    }
  }
});

test('normal and ORM maps are data, albedo is sRGB - the glTF convention', () => {
  /* An sRGB-tagged normal map is decoded before sampling and every normal
   * tilts wrong; a linear-tagged albedo washes out. The convention is baked
   * into Textures.js; asserting it here pins the wiring, not the toolkit. */
  const m = buildMazeMaterials();
  for (const kind of SURFACED) {
    assert.equal(m[kind].map.colorSpace, THREE.SRGBColorSpace, `${kind} albedo is not sRGB`);
    assert.equal(m[kind].normalMap.colorSpace, THREE.NoColorSpace, `${kind} normal map is not data`);
    assert.equal(m[kind].roughnessMap.colorSpace, THREE.NoColorSpace, `${kind} ORM is not data`);
  }
});
