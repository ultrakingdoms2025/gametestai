import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BeastBody, BEAST_PROFILES } from '../../src/npc/BeastBody.js';
import { BEASTS } from '../../src/npc/BeastSpecies.js';

/**
 * The two silhouettes.
 *
 * ── What this is really checking ──────────────────────────────────────────
 * The brief's requirement is that a player can tell a wolf from a bear
 * INSTANTLY at 40 m. Forty metres is a couple of hundred pixels and no texture
 * at all, so the entire budget is silhouette, and a silhouette is measurable:
 * height, mass, where the tallest point is, and how long the muzzle is. Every
 * assertion below is one of those, expressed as a comparison rather than as a
 * constant so the proportions can be retuned without the distinction being
 * retuned away by accident.
 *
 * It is also, incidentally, the proof that the whole body builder runs headless.
 * Nothing here has a renderer, a canvas or a material library - `BeastBody`
 * falls back to a flat standard material when there is no library, which is
 * what lets these bodies be built under `node --test` at all.
 */

const build = (species, seed = 7) => new BeastBody({ species, seed });
const boxOf = (body) => new THREE.Box3().setFromObject(body.root);

test('both species build with no renderer, no canvas and no material library', () => {
  for (const species of ['wolf', 'bear']) {
    const b = build(species);
    assert.ok(b.root.children.length > 0, `${species} built an empty group`);
    assert.equal(b.legs.length, 4, `${species} has ${b.legs.length} legs`);
    assert.ok(b.head && b.jaw && b.tail && b.neck, `${species} is missing a named part`);
    assert.equal(b.ears.length, 2);
    b.dispose();
  }
});

test('a bear is a different animal from a wolf, not a bigger one', () => {
  const wolf = build('wolf');
  const bear = build('bear');
  const wb = boxOf(wolf);
  const bb = boxOf(bear);

  const wHeight = wb.max.y - wb.min.y;
  const bHeight = bb.max.y - bb.min.y;
  const wWidth = wb.max.x - wb.min.x;
  const bWidth = bb.max.x - bb.min.x;
  const wLength = wb.max.z - wb.min.z;
  const bLength = bb.max.z - bb.min.z;

  assert.ok(bHeight > wHeight * 1.35,
    `a bear stands ${bHeight.toFixed(2)} m against a wolf's ${wHeight.toFixed(2)} - too close to tell apart`);
  // Mass, not scale: the bear has to be proportionally BROADER, or it is a
  // wolf that somebody typed a bigger number into.
  assert.ok(bWidth / bHeight > wWidth / wHeight * 1.4,
    `a bear is ${(bWidth / bHeight).toFixed(2)} wide per unit of height against a wolf's `
    + `${(wWidth / wHeight).toFixed(2)} - the two have the same build`);
  // And proportionally SHORTER in the body, which is the other half of "bulky".
  assert.ok(bLength / bHeight < wLength / wHeight,
    'a bear is as long-bodied for its height as a wolf');

  wolf.dispose();
  bear.dispose();
});

test('the tallest point of a bear is its shoulder hump, not its head', () => {
  /* The single most recognisable thing about a bear, and the one cue that
   * survives being 40 m away in bad light. If the hump ever stops standing
   * proud of the topline the animal reads as a large dog. */
  const P = BEAST_PROFILES.bear;
  const humpTop = P.hump.p[1] + P.hump.r[1];
  const backTop = Math.max(...P.barrel.map((s) => s.y + s.ry));
  assert.ok(humpTop > backTop,
    `the hump reaches ${humpTop.toFixed(2)} against a topline of ${backTop.toFixed(2)}`);

  const bear = build('bear', 3);
  const head = new THREE.Vector3();
  bear.getHeadWorldPosition(head);
  assert.ok(head.y < humpTop * bear.heightScale,
    `the bear carries its head at ${head.y.toFixed(2)}, above its own hump`);
  // ...and out in front of the body, where a quadruped's head belongs.
  assert.ok(head.z < -0.6, `the head sits at z=${head.z.toFixed(2)}, not ahead of the chest`);
  bear.dispose();
});

test('a wolf has a long muzzle and a bear has a short broad one', () => {
  /* The head is a wedge or it is a box, and the measurement that separates
   * those two is the skull's aspect ratio - how long it is against how wide.
   * At the range where a head is more than a blob, that ratio is the whole
   * difference between a wolf and a bear. */
  const skull = (species) => {
    const s = BEAST_PROFILES[species].head.sections;
    const length = s[0].z - s[s.length - 1].z;
    const width = Math.max(...s.map((k) => k.rx)) * 2;
    const stop = s.findIndex((k) => k.z < 0) + 1;
    return { length, width, aspect: length / width, muzzle: (s[stop].z - s[s.length - 1].z) / length };
  };
  const wolf = skull('wolf');
  const bear = skull('bear');
  assert.ok(wolf.aspect > bear.aspect * 1.4,
    `a wolf's skull is ${wolf.aspect.toFixed(2)} long per unit of width against a bear's `
    + `${bear.aspect.toFixed(2)} - the two heads read the same`);
  assert.ok(wolf.muzzle > bear.muzzle,
    `a wolf's snout is ${(wolf.muzzle * 100).toFixed(0)}% of its skull against a bear's `
    + `${(bear.muzzle * 100).toFixed(0)}%`);
  // And in absolute terms, a bear's muzzle is a great deal thicker.
  const thick = (s) => BEAST_PROFILES[s].head.sections[3].rx;
  assert.ok(thick('bear') > thick('wolf') * 1.8,
    `a bear's muzzle is ${thick('bear')} thick against a wolf's ${thick('wolf')}`);
});

test('a wolf has a brush and a bear has a stub', () => {
  const reach = (species) => {
    const t = BEAST_PROFILES[species].tail.sections;
    const last = t[t.length - 1];
    return Math.hypot(last.y, last.z);
  };
  assert.ok(reach('wolf') > reach('bear') * 2.5,
    `a wolf's tail reaches ${reach('wolf').toFixed(2)} m against a bear's ${reach('bear').toFixed(2)}`);
});

test('the feet reach the floor and nothing sinks into it', () => {
  /* The root IS the feet - `NPC` grounds it against the terrain - so a body
   * whose legs stop short hovers and one whose legs overshoot is buried. A
   * couple of centimetres either way is hidden by the ground follower. */
  for (const species of ['wolf', 'bear']) {
    for (const seed of [1, 2, 3, 99]) {
      const b = build(species, seed);
      const box = boxOf(b);
      assert.ok(box.min.y > -0.06,
        `a ${species} (seed ${seed}) reaches ${box.min.y.toFixed(3)} m below its own root`);
      assert.ok(box.min.y < 0.06,
        `a ${species} (seed ${seed}) floats ${box.min.y.toFixed(3)} m above the ground`);
      b.dispose();
    }
  }
});

test('the body fits the collision capsule it is given', () => {
  /* `NPC` integrates a capsule of `def.bodyRadius` around the root. A body
   * wider than its own capsule has its shoulders inside walls; one much
   * narrower leaves the animal floating away from them. */
  for (const species of ['wolf', 'bear']) {
    const def = BEASTS[species];
    const b = build(species, 11);
    const box = boxOf(b);
    const halfWidth = Math.max(Math.abs(box.min.x), Math.abs(box.max.x));
    assert.ok(halfWidth <= def.bodyRadius + 1e-6,
      `a ${species} is ${halfWidth.toFixed(2)} m wide against a ${def.bodyRadius} m capsule`);
    assert.ok(halfWidth > def.bodyRadius * 0.4,
      `a ${species}'s capsule is more than twice its body`);
    // The published bound has to actually contain the animal, or the hit query
    // rejects shots before it ever tests the body.
    const extent = Math.max(box.max.z, -box.min.z, halfWidth);
    const bound = b.bodyLength * 0.55 + def.bodyRadius;
    assert.ok(bound >= extent * 0.9,
      `a ${species}'s hit bound is ${bound.toFixed(2)} m against a ${extent.toFixed(2)} m body`);
    b.dispose();
  }
});

test('size varies between individuals, so a pack is not five copies', () => {
  /* A pack of five identical wolves reads as five copies of one wolf, which is
   * a stronger tell than any amount of coat variation. What matters is that
   * the sizes actually SPREAD, not that no two ever coincide - the seeds these
   * come from are consecutive and an LCG's first draw off consecutive seeds is
   * nearly linear, so a handful of collisions is arithmetic, not a fault. */
  const scales = [];
  for (let seed = 1; seed <= 16; seed++) {
    const b = build('wolf', seed);
    scales.push(b.heightScale);
    assert.ok(b.heightScale >= 0.9 && b.heightScale <= 1.1,
      `a wolf came out at ${b.heightScale.toFixed(2)} of its species height`);
    assert.ok(Math.abs(b.height - BEASTS.wolf.shoulderHeight * b.heightScale) < 1e-6);
    b.dispose();
  }
  const spread = Math.max(...scales) - Math.min(...scales);
  assert.ok(spread > 0.1, `sixteen wolves spanned only ${(spread * 100).toFixed(1)}% in size`);
  assert.ok(new Set(scales.map((s) => s.toFixed(3))).size >= 8,
    'sixteen wolves produced fewer than eight distinct sizes');
});

test('the same seed always builds the same animal', () => {
  // The world is generated from a seed; a body that rolls its own dice would
  // make a pack change size every time the player walked back into the wood.
  const a = build('wolf', 4242);
  const b = build('wolf', 4242);
  assert.equal(a.heightScale, b.heightScale);
  assert.equal(a.materialSet.coat.color.getHex(), b.materialSet.coat.color.getHex());
  a.dispose();
  b.dispose();
});

test('the mouth is derived from the built skull, not guessed', () => {
  /* The maul's contact volume starts at `muzzleLocal`, so if the head is ever
   * reshaped the bite has to move with it. Checked by comparing against the
   * profile the head was actually built from. */
  for (const species of ['wolf', 'bear']) {
    const P = BEAST_PROFILES[species];
    const b = build(species, 5);
    const expectZ = (P.neck.at[2] + P.head.at[2] + P.head.sections[3].z) * b.heightScale;
    assert.ok(Math.abs(b.muzzleLocal.z - expectZ) < 1e-6,
      `${species}'s bite does not start at its mouth`);
    assert.ok(b.muzzleLocal.z < 0, 'the mouth is behind the animal');
    assert.ok(b.muzzleLocal.y > 0.3, 'the mouth is on the floor');
    b.dispose();
  }
});

test('the shadow and detail switches reach every mesh', () => {
  /* `NPCManager._updateLOD` toggles two meshes on a humanoid. A quadruped is a
   * dozen, and offers `setShadowCasting` so the manager can hand the whole
   * switch over - a wolf whose barrel stops casting while its legs carry on is
   * worse than one that casts all the way out. */
  const b = build('wolf', 8);
  assert.equal(typeof b.setShadowCasting, 'function');
  b.setShadowCasting(false);
  let casting = 0;
  b.root.traverse((o) => { if (o.isMesh && o.castShadow) casting++; });
  assert.equal(casting, 0, `${casting} meshes are still casting after the shadow band was left`);
  b.setShadowCasting(true);
  b.root.traverse((o) => { if (o.isMesh && o.castShadow) casting++; });
  assert.ok(casting > 4, 'the shadow never came back');

  b.setDetailVisible(false);
  let hidden = 0;
  b.root.traverse((o) => { if (o.isMesh && !o.visible) hidden++; });
  assert.ok(hidden > 0, 'nothing was culled at distance');
  b.setDetailVisible(true);
  b.root.traverse((o) => { if (o.isMesh) assert.equal(o.visible, true); });
  b.dispose();
});
