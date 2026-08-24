import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as THREE from 'three';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

/**
 * HOW A PICKUP IS DRAWN, AND WHY IT IS PINNED HERE.
 *
 * Four separate world art branches - `art-medieval`, `art-station`,
 * `art-dock` and `art-citadel` - each photographed the same defect and each
 * declined to fix it, because `src/systems/Loot.js` is shared by nine worlds
 * and Phase 9 is staged one world at a time. Two faults, both global:
 *
 *   1. Four coincident additive/emissive layers put roughly 3.5x an accent's
 *      linear radiance through an ACESFilmic curve that answers with white. A
 *      *violet* trinket measured `rgb(253,216,250)` at the centre - red and
 *      blue both AT the 255 ceiling, saturation 0.15 - so a pickup lost the
 *      kind colour that tells the player what it is.
 *   2. The three additive layers carried `fog: false`, so a pickup at 300 m
 *      was drawn at the brightness of one at 10 m in a valley that is
 *      otherwise carefully graded.
 *
 * These are appearance assertions, which are unusual and are here on purpose:
 * both faults are invisible in a passing test suite and were only ever found
 * by photographing a world. The point of the file is that the next change to
 * these numbers has to be a DELIBERATE one.
 *
 * Measurements behind every figure below, with the framings and the noise
 * floors, are in `docs/superpowers/specs/2026-08-23-art-loot-design.md`.
 */

/* ------------------------------------------------------------------ */
/* Constructing a Loot under Node                                      */
/* ------------------------------------------------------------------ */

/**
 * `Loot`'s constructor paints two canvas textures, which is why the older
 * tests around it (`citadel-economy`) read the source as text instead. A
 * gradient stub is enough: `CanvasTexture` only keeps a reference to the
 * element, and nothing here uploads one. Asserting against the real material
 * objects beats asserting against a regex over the source, so it is worth the
 * eight lines.
 */
function withCanvasStub(fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'document');
  const prev = globalThis.document;
  const grad = { addColorStop() {} };
  globalThis.document = {
    createElement() {
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          createRadialGradient: () => grad,
          createLinearGradient: () => grad,
          fillRect() {},
          set fillStyle(_v) {},
          get fillStyle() { return ''; },
        }),
      };
    },
  };
  try {
    return fn();
  } finally {
    if (had) globalThis.document = prev;
    else delete globalThis.document;
  }
}

const { Loot } = await import('../../src/systems/Loot.js');
const loot = withCanvasStub(() => new Loot({ scene: new THREE.Scene() }));
const KINDS = ['skin', 'trinket', 'consumable', 'ammo', 'currency'];

/* ------------------------------------------------------------------ */

test('every pickup material still carries its own name', () => {
  /* `--ablate` in scripts/world-shot.mjs hides meshes BY MATERIAL NAME, and
   * it is the only tool in this repository that can answer "which system drew
   * this pixel". Two of the five art branches found their world's materials
   * entirely anonymous, which makes the whole A/B silently useless - an
   * unnamed material reports its class name and matches nothing. `Loot` is
   * diagnosable only because it names all twenty. Losing that is how the next
   * defect here goes un-found. */
  for (const kind of KINDS) {
    const m = loot._mats[kind];
    assert.ok(m, `no material set for accent "${kind}"`);
    assert.equal(m.core.name, `loot.core.${kind}`);
    assert.equal(m.ring.name, `loot.ring.${kind}`);
    assert.equal(m.halo.name, `loot.halo.${kind}`);
    assert.equal(m.beam.name, `loot.beam.${kind}`);
  }
});

test('a pickup keeps its kind colour: the coincident layers stay under the tone curve', () => {
  /* The core and the halo are the two layers that sit on the SAME pixel - the
   * sprite is centred on the octahedron - so their sum is what the tone
   * mapper sees at the centre of a pickup and it is the only number that
   * decides white or violet. Measured on a controlled ladder in Aldermoor
   * Vale, `2.6 + 0.85 = 3.45` reads `rgb(253,216,250)`, saturation 0.15, with
   * red and blue clipped; `1.1 + 0.4 = 1.5` reads `rgb(248,199,239)` at the
   * same mark with nothing clipped, and `rgb(248,167,244)`, saturation 0.33,
   * in a close framing.
   *
   * The ceiling is the assertion, not the two numbers: split the budget
   * differently if a later pass wants to, but a sum past here is the
   * blow-out coming back. */
  for (const kind of KINDS) {
    const { core, halo } = loot._mats[kind];
    const coincident = core.emissiveIntensity + halo.opacity;
    assert.ok(
      coincident <= 1.6,
      `accent "${kind}": core emissive ${core.emissiveIntensity} + halo opacity ${halo.opacity}`
      + ` = ${coincident.toFixed(2)}, over the 1.6 the tone curve holds hue below`
    );
  }
  const t = loot._mats.trinket;
  assert.equal(t.core.emissiveIntensity, 1.1);
  assert.equal(t.ring.opacity, 0.5);
  assert.equal(t.halo.opacity, 0.4);
  assert.equal(t.beam.opacity, 0.25);
});

test('a pickup is still LOUD: it out-emits the scene and keeps all four layers', () => {
  /* The other side of the same coin, and the easier mistake to make: a
   * pickup is a gameplay affordance before it is a pixel, and dimming it
   * until the screenshot is calm breaks the game to fix a photograph. The
   * core must still be emissive above the ~0.9 linear that a lit surface
   * reaches at noon, and all four layers must still exist - the ring and the
   * beam are what carry the read at 30 m where the core is four pixels. */
  for (const kind of KINDS) {
    const { core, ring, halo, beam } = loot._mats[kind];
    assert.ok(core.emissiveIntensity >= 1.0, `accent "${kind}" core is no longer self-lit`);
    for (const [name, m] of [['ring', ring], ['halo', halo], ['beam', beam]]) {
      assert.equal(m.blending, THREE.AdditiveBlending, `${name} stopped being additive`);
      assert.ok(m.opacity > 0.2, `${name} faded to ${m.opacity}`);
    }
  }
});

test('the additive layers take the scene fog instead of opting out of it', () => {
  for (const kind of KINDS) {
    const { core, ring, halo, beam } = loot._mats[kind];
    // The core always fogged: MeshStandardMaterial defaults `fog` to true and
    // this file never turned it off. Only the additive three were opted out.
    assert.equal(core.fog, true, `accent "${kind}" core lost its fog`);
    assert.equal(ring.fog, true, `accent "${kind}" ring is still fog: false`);
    assert.equal(halo.fog, true, `accent "${kind}" halo is still fog: false`);
    assert.equal(beam.fog, true, `accent "${kind}" beam is still fog: false`);
  }
  assert.doesNotMatch(
    read('src/systems/Loot.js'), /fog:\s*false/,
    'a loot material has been opted out of fog again'
  );
});

test('additive fog SWALLOWS rather than TINTS - the trap that makes range worse', () => {
  /* Three's stock `<fog_fragment>` is `mix( colour, fogColor, fogFactor )`.
   * On an additive layer that means a fully fogged pickup ADDS the haze
   * colour at full strength: a brighter dot at 800 m than at 8 m, which is a
   * worse defect than the one being fixed. Turning the flag on and walking
   * away is the trap, and this is the assertion that catches it.
   *
   * `systems/Projectiles.js` and `systems/VFX.js` already carry the same rule
   * in their own particle shaders; this is that rule applied to stock Three
   * materials through a chunk replacement. */
  const stub = { fragmentShader: 'void main() {\n#include <fog_fragment>\n}' };
  const ring = loot._mats.trinket.ring;
  assert.equal(typeof ring.onBeforeCompile, 'function', 'the additive fog patch is not installed');
  ring.onBeforeCompile(stub);
  assert.doesNotMatch(stub.fragmentShader, /#include <fog_fragment>/, 'the chunk replacement did not match');
  assert.match(stub.fragmentShader, /gl_FragColor\.rgb\s*\*=\s*1\.0 - fogFactor;/);
  assert.doesNotMatch(stub.fragmentShader, /mix\(\s*gl_FragColor\.rgb,\s*fogColor/);
  // Both fog models, because SportsWorld installs a FogExp2 while it is up
  // and applyEnvironment restores a linear THREE.Fog on the way out.
  assert.match(stub.fragmentShader, /#ifdef FOG_EXP2/);
  assert.match(stub.fragmentShader, /smoothstep\(\s*fogNear,\s*fogFar,\s*vFogDepth\s*\)/);
});

test('the fog patch cannot split the shader program cache', () => {
  /* `Material.customProgramCacheKey()` returns `onBeforeCompile.toString()`
   * by default, so a patch declared inside the per-kind loop would hand
   * fifteen distinct closures to the program cache. Three hashes the text, so
   * they would in fact still collide - but relying on that is how a later
   * refactor that captures one variable costs fifteen programs in a project
   * with a documented history of 1.65 s and 63 s freezes from exactly that.
   *
   * Measured in the browser after this change: the twenty loot materials
   * consume SIX distinct programs, which is what they consumed before it. */
  const first = loot._mats[KINDS[0]];
  const fn = first.ring.onBeforeCompile;
  const key = first.ring.customProgramCacheKey();
  assert.equal(typeof key, 'string');
  assert.ok(key.length > 0);
  for (const kind of KINDS) {
    for (const layer of ['ring', 'halo', 'beam']) {
      const m = loot._mats[kind][layer];
      assert.equal(m.onBeforeCompile, fn, `${kind}.${layer} has its own patch closure`);
      assert.equal(m.customProgramCacheKey(), key, `${kind}.${layer} has its own cache key`);
    }
  }
});

test('still no lights, and still one material set per accent', () => {
  /* The header's standing promise. A point light per pickup changes the scene
   * light count at runtime, which invalidates Three's whole program cache -
   * the failure that cost this project a 63 s freeze on first bow draw. An
   * art pass is exactly when someone reaches for one. */
  let lights = 0;
  loot.group.traverse((o) => { if (o.isLight) lights++; });
  assert.equal(lights, 0, 'a pickup has grown a light');
  const uuids = new Set();
  for (const kind of KINDS) {
    for (const layer of ['core', 'ring', 'halo', 'beam']) uuids.add(loot._mats[kind][layer].uuid);
  }
  assert.equal(uuids.size, KINDS.length * 4, 'the per-accent material sets are no longer shared by the pool');
});
