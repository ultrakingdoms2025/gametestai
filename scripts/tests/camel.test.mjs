import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { CONFIG } from '../../src/core/Config.js';
import { NPCManager } from '../../src/npc/NPCManager.js';
import { BeastBody, BEAST_PROFILES } from '../../src/npc/BeastBody.js';
import { BeastAnimator } from '../../src/npc/BeastAnimator.js';
import { BeastPack } from '../../src/npc/BeastPack.js';
import { BEASTS, beastDef, isPredator } from '../../src/npc/BeastSpecies.js';
import {
  GAITS, GAIT_PHASE, gaitFor, footfallPhases, supportCount, suspensionFraction,
} from '../../src/npc/BeastGait.js';

/**
 * THE CAMEL: a quadruped that must never touch the player, and the proof that
 * adding it left the wolf and the bear bit-for-bit alone.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS SUITE IS WRITTEN AGAINST
 * ---------------------------------------------------------------------------
 * This project has already shipped a safety rule that worked perfectly against
 * its own brief: a clearance that held wolf packs away from the roads existed
 * so predators could not see travellers, while the brief asked for predators
 * that attack you. Every link of the chain passed; the feature was invisible.
 *
 * The equivalent trap here is INVERTED, and both halves of it are live:
 *
 *   - a camel must be ON the ground the player walks over, not held off it, so
 *     nothing in this file may assert a clearance;
 *   - and a camel must not maul anybody, which is a claim of ABSENCE - and a
 *     suite cannot detect absence. "It never attacked" is satisfied by a
 *     fixture in which nothing could ever attack, by a beast that failed to
 *     spawn, and by a state machine that never ticked.
 *
 * So every absence claim below is paired with an ABLATION: the same fixture,
 * the same number of steps, the same assertions, with a WOLF in the camel's
 * place - and the wolf has to reach the thing the camel must not. A test that
 * proves the camel is inert and the wolf is not is a test that can fail.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR THINGS HELD HERE
 * ---------------------------------------------------------------------------
 *   1. The predators are UNCHANGED - SHA-256 over their spec rows, their gait
 *      tables, their built vertices and 600 steps of their animation.
 *   2. The silhouette is a camel and not a tall wolf - height, head carriage,
 *      neck, leg length and foot flare, each as a comparison against the two
 *      animals it has to be told apart from.
 *   3. The gait is a PACE - lateral couplets in exact synchrony - and the roll
 *      that comes with it reaches the body.
 *   4. The maul is unreachable, by three independent locks, one of which is
 *      proved by exhausting the distance axis rather than by sampling it.
 */

/* ================================================================== */
/* 1. THE PREDATORS ARE UNCHANGED                                     */
/* ================================================================== */

/**
 * Pinned digests, taken from the tree immediately BEFORE the camel existed.
 *
 * The point of pinning rather than comparing two live species to each other is
 * that a live comparison cannot notice a change that moves both. These are the
 * bytes as they were, and nothing in this repository can regenerate them: a
 * mismatch means the wolf or the bear moved, whatever the diff says it touched.
 */
const PINNED = {
  wolf: {
    spec: 'be32756af7fb5c00e276bc507c0b168e',
    gaits: '1952e62d9af2868329ed0a5443d77013',
    /* REPINNED 2026-08-23 (Phase 9, `art-medieval`). The wolf's jaw and its
     * four lower legs moved from `coat` to `belly`; `bodyDigest` hashes every
     * material colour, so a deliberate countershading pass moves it. Geometry
     * is untouched - see the note above the test. */
    body: { 1: '86997d24638c59964d700ed85dbbe340', 7: 'c7f890d316d2053c6b2d077a00786e86', 4242: 'eec637532f9f6daca5e41509f09a4907' },
    anim: { 1: '10b0759be46383734426d614f95fb12c', 7: '8142fd094bff6d2106f54065254771e1' },
  },
  bear: {
    spec: '8db41314a609b060fee60f65f099107a',
    gaits: 'a6d0ede7a9398ce9b56fb7a6ce9e2e4a',
    /* REPINNED 2026-08-23, same change and same reason as the wolf's. */
    body: { 1: 'c8b74347b107b83354d81ad0d0eeb4de', 7: '6ecc824b52c51d4cc39358fc3614c043', 4242: '508d3034f2a5f7bc2ffed30a93065e27' },
    anim: { 1: '12491f5c24ae1c358555926e6837403a', 7: 'a5682a8464b4ba6ecdf774c964131662' },
  },
};

const short = (h) => h.digest('hex').slice(0, 32);

/** Every vertex, every world transform, every material colour, in build order. */
function bodyDigest(species, seed) {
  const b = new BeastBody({ species, seed });
  b.root.updateWorldMatrix(true, true);
  const h = createHash('sha256');
  h.update(`${species}|${seed}|${b.height}|${b.heightScale}|${b.bodyLength}|${b.muzzleLocal.toArray().join(',')}`);
  const parts = [];
  b.root.traverse((o) => { if (o.isMesh) parts.push(o); });
  for (const m of parts) {
    h.update(`\nMESH|${m.castShadow}|${m.visible}|${m.material.color.getHexString()}`);
    h.update(`|MW|${m.matrixWorld.elements.map((v) => v.toFixed(6)).join(',')}`);
    const p = m.geometry.getAttribute('position');
    h.update(`|N|${p.count}`);
    const a = p.array;
    for (let i = 0; i < a.length; i++) h.update(`,${a[i].toFixed(5)}`);
  }
  b.dispose();
  return short(h);
}

/**
 * 600 fixed steps through every branch the animator owns.
 *
 * Deliberately drives states a given species cannot actually reach - a camel
 * never sees ATTACK - because the thing under test is the POSE DRIVER, and a
 * driver that answers differently for a state its caller happens not to send is
 * still a driver that changed.
 */
function animDigest(species, seed) {
  const body = new BeastBody({ species, seed });
  const an = new BeastAnimator({ body, species, seed });
  const h = createHash('sha256');
  const look = new THREE.Vector3(3, 1.2, -4);
  const dt = 1 / 60;
  for (let i = 0; i < 600; i++) {
    const t = i / 600;
    an.setLocomotion(Math.sin(t * 7) * 8, Math.cos(t * 3) * 1.4);
    an.setLookTarget(i % 3 === 0 ? look : null);
    an.setIntentForState({
      state: i < 200 ? 'STALK' : i < 300 ? 'ATTACK' : i < 380 ? 'FLEE' : 'ROAM',
      phase: i < 240 ? 'telegraph' : i < 260 ? 'strike' : 'recover',
      wind: (i % 40) / 40,
      hunting: i % 5 !== 0,
      stalking: i % 7 === 0,
    });
    if (i === 420) an.flinch(new THREE.Vector3(1, 0, 0), true);
    if (i === 500) an.die(new THREE.Vector3(-1, 0, 0), true);
    if (i === 540) an.beginSink();
    an.update(dt, i * dt, { detail: true, ik: true, distance: 12 });
    const b = body;
    const nodes = [b.tilt, b.neck, b.head, b.jaw, b.tail, ...b.ears,
      ...b.legs.flatMap((l) => [l.upper, l.lower])];
    for (const n of nodes) {
      h.update(`|${n.position.x.toFixed(6)},${n.position.y.toFixed(6)},${n.position.z.toFixed(6)}`);
      h.update(`;${n.rotation.x.toFixed(6)},${n.rotation.y.toFixed(6)},${n.rotation.z.toFixed(6)}`);
    }
    h.update(`;${b.root.visible}`);
  }
  body.dispose();
  return short(h);
}

test('the wolf and the bear spec rows are the bytes they always were', () => {
  for (const species of ['wolf', 'bear']) {
    const got = short(createHash('sha256').update(JSON.stringify(BEASTS[species])));
    assert.equal(got, PINNED[species].spec,
      `the ${species} row changed. Adding a species must not touch the two that were here - `
      + 'and note that a `predator: true` written onto these rows would fail exactly here, '
      + 'which is why `isPredator` defaults to true on ABSENCE instead');
  }
  // The camel is genuinely in the table and genuinely resolvable through the
  // same lookup, or the digests above are proving something about a table that
  // never gained a third row.
  assert.equal(beastDef('camel').id, 'camel');
  assert.equal(Object.keys(BEASTS).length, 3);
});

test('the wolf and the bear gait tables and phase offsets are unchanged', () => {
  for (const species of ['wolf', 'bear']) {
    const got = short(createHash('sha256')
      .update(JSON.stringify(GAITS[species].map((g) => [g, GAIT_PHASE[g.name]]))));
    assert.equal(got, PINNED[species].gaits,
      `the ${species}'s gait bands or phase offsets moved`);
  }
  // And the camel's two new phase tables did not overwrite anybody's.
  assert.ok(GAIT_PHASE.pace && GAIT_PHASE.gallop, 'the camel has no phase tables');
  for (const name of ['trot', 'lope', 'sprint', 'amble', 'charge']) {
    assert.ok(!GAITS.camel.some((g) => g.name === name),
      `the camel borrowed the "${name}" table, so retuning it would retune a predator`);
  }
});

test('the wolf and the bear build to exactly the vertices they used to', () => {
  /* The two additions to the builder - `head.eye` and `legs.clawCount` - are
   * both defaulted to the EXPRESSION they replaced, and the claw default keeps
   * the original multiplication ORDER, because floating-point multiplication is
   * not associative and a reordered product is a different animal in the last
   * bit. This is the assertion that makes that claim checkable rather than
   * asserted.
   *
   * ── The digests were repinned once, deliberately, on 2026-08-23 ─────────
   *
   * `bodyDigest` hashes "every vertex, every world transform, EVERY MATERIAL
   * COLOUR", and Phase 9's `art-medieval` pass moved the jaw and the four
   * lower legs of every beast from the `coat` surface onto `belly` - a colour
   * every profile already declared and no mesh had ever worn. That is a
   * visible art change and it is supposed to move this digest.
   *
   * What it must NOT have moved is the geometry, because the authored `.glb`
   * features are welded in only when they load and `node --test` has no fetch.
   * That half is still pinned by the VERTEX COUNTS inside these digests and by
   * `beast-assets.test.mjs`, which builds one animal with the committed
   * geometry installed and one without and asserts the mesh count and the
   * material count are identical across the pair.
   *
   * The failure this test caught on the way there is worth recording, because
   * it is exactly the kind it exists for: wrapping the neck's bare `sweep` in
   * a `merge()` to make room for the ruff turned an indexed geometry into a
   * non-indexed one for every animal in the game, authored parts or not.
   * Nothing else would have noticed. `BeastBody` now takes the merge only when
   * there is something to merge. */
  for (const species of ['wolf', 'bear']) {
    for (const seed of [1, 7, 4242]) {
      assert.equal(bodyDigest(species, seed), PINNED[species].body[seed],
        `${species} seed ${seed} builds different geometry than it did`);
    }
  }
});

test('the wolf and the bear animate frame-for-frame as they did', () => {
  /* Two things were added to the pose driver: the pace ROLL, guarded on a gait
   * field no predator gait carries, and the CUD, guarded on `_predator`. Both
   * guards are proved here rather than read: 600 steps, every state, every
   * phase, a flinch, a death and a sink, hashed to six decimal places. */
  for (const species of ['wolf', 'bear']) {
    for (const seed of [1, 7]) {
      assert.equal(animDigest(species, seed), PINNED[species].anim[seed],
        `${species} seed ${seed} poses differently than it did`);
    }
  }
});

test('the camel is a different animal from both of them under the same digest', () => {
  /* The ablation on the four tests above. Pinned digests that happened to be
   * insensitive - to the seed, to the species, to anything - would pass all
   * four while proving nothing, so the same functions have to SEPARATE animals
   * that are genuinely different. */
  const bodies = ['wolf', 'bear', 'camel'].map((s) => bodyDigest(s, 7));
  assert.equal(new Set(bodies).size, 3, 'the body digest cannot tell three species apart');
  const anims = ['wolf', 'bear', 'camel'].map((s) => animDigest(s, 7));
  assert.equal(new Set(anims).size, 3, 'the animation digest cannot tell three species apart');
  assert.notEqual(bodyDigest('camel', 1), bodyDigest('camel', 7),
    'the body digest cannot tell two seeds apart');
});

/* ================================================================== */
/* 2. THE SILHOUETTE                                                  */
/* ================================================================== */

const build = (species, seed = 7) => new BeastBody({ species, seed });
const boxOf = (body) => new THREE.Box3().setFromObject(body.root);

/**
 * TWO BODY DESCRIPTIONS, ONE SET OF MEASUREMENTS.
 *
 * A wolf and a bear are `barrel`: an ellipse `{y, z, rx, ry}` swept along a
 * path. A camel is `hull`: a superellipse `{z, y, hw, top, bot, ex, et, eb}`
 * lofted along Z, because a hump has to be part of the back and an ellipse
 * cannot do that. Every helper below reads whichever a species carries and
 * answers the SAME question about it, so the comparisons between the three
 * animals stay comparisons and not two different measurements side by side.
 *
 * The ellipse arms are the expressions that were here before the camel had a
 * hull, so the wolf's and the bear's numbers are unchanged to the last bit.
 */
const sectionsOf = (species) => {
  const P = BEAST_PROFILES[species];
  return P.hull
    ? P.hull.map((s) => ({ z: s.z, top: s.top, bot: s.bot, half: s.hw }))
    : P.barrel.map((s) => ({ z: s.z, top: s.y + s.ry, bot: s.y - s.ry, half: s.rx }));
};
/** Lowest point of the body: where the belly hangs. */
const bellyOf = (species) => Math.min(...sectionsOf(species).map((s) => s.bot));
/**
 * Highest point of the body.
 *
 * On a camel that is the crest of the hump and it is IN the hull; on a bear and
 * a wolf the hump is a separate ellipsoid that may stand above the barrel, so
 * both have to be considered. Returns 2.200, 1.420 and 0.905 - and the bear's
 * 1.420 is the number the shipped version of this test used, taken from the
 * ellipsoid, so the comparison it makes is unchanged.
 */
const crestOf = (species) => {
  const P = BEAST_PROFILES[species];
  const skin = Math.max(...sectionsOf(species).map((s) => s.top));
  return P.hump ? Math.max(skin, P.hump.p[1] + P.hump.r[1]) : skin;
};
/**
 * Depth of the ribcage, measured at the GIRTH - the section that is widest.
 *
 * Not `max(top - bot)`, which on a camel would measure through the hump and
 * report a ribcage half a metre deeper than the animal has. On the wolf and the
 * bear the widest section is also the deepest one, so this returns exactly what
 * `max(ry) * 2` returned: 0.49 and 0.79.
 */
const depthOf = (species) => {
  const k = sectionsOf(species);
  const girth = k.reduce((a, b) => (b.half > a.half ? b : a));
  return girth.top - girth.bot;
};
/** Half-width at the girth. */
const girthOf = (species) => Math.max(...sectionsOf(species).map((s) => s.half));

test('a camel is the tallest thing that walks here, and a wolf could walk under it', () => {
  const camel = build('camel');
  const bear = build('bear');
  const wolf = build('wolf');
  const cb = boxOf(camel);
  const bb = boxOf(bear);
  const wb = boxOf(wolf);
  const h = (b) => b.max.y - b.min.y;

  assert.ok(h(cb) > h(bb) * 1.8,
    `a camel stands ${h(cb).toFixed(2)} m against a bear's ${h(bb).toFixed(2)} - not enough to `
    + 'read as a different order of animal');
  assert.ok(h(cb) > CONFIG.player.height * 1.5,
    `a camel is ${h(cb).toFixed(2)} m against a ${CONFIG.player.height} m player - it has to `
    + 'tower, or the one fact its silhouette has to sell is not true');

  /* The belly clearance, stated the way a player would meet it: the underside
   * of a camel is higher off the ground than the whole of a wolf. */
  const belly = bellyOf('camel');
  assert.ok(belly > h(wb),
    `a camel's belly hangs at ${belly.toFixed(2)} m and a wolf stands ${h(wb).toFixed(2)} - `
    + 'the wolf does not fit underneath, so the legs are not long enough to read as long');

  for (const b of [camel, bear, wolf]) b.dispose();
});

test('a camel carries its head ABOVE its own hump - the bear does the opposite', () => {
  /* The single cue that cannot be confused. A bear's hump is the tallest point
   * of the animal and its head hangs below it; a camel's head is the tallest
   * point and the hump is below THAT. Same two parts, opposite order, and it
   * survives being a hundred pixels tall in bad light. */
  const head = new THREE.Vector3();

  const camel = build('camel', 3);
  camel.getHeadWorldPosition(head);
  const camelHead = head.y;
  const camelCrest = crestOf('camel') * camel.heightScale;
  assert.ok(camelHead > camelCrest * 1.15,
    `a camel's head is at ${camelHead.toFixed(2)} m and its hump crest at ${camelCrest.toFixed(2)} `
    + '- they read as the same height');
  camel.dispose();

  const bear = build('bear', 3);
  bear.getHeadWorldPosition(head);
  assert.ok(head.y < crestOf('bear') * bear.heightScale,
    'the bear has started carrying its head above its hump, and the two are no longer opposites');
  bear.dispose();

  /* One hump, and it is a MOUND: narrow where it is tall. On the hull that is a
   * measurement rather than a field - take the section at the crest and ask how
   * wide the skin is at 90% of its rise above the waist. `et` is the number that
   * makes it small, so this fails the moment somebody flattens the exponent and
   * turns the hump into a ridge as wide as the back it stands on. */
  const peak = BEAST_PROFILES.camel.hull.reduce((a, b) => (b.top > a.top ? b : a));
  const nearCrest = peak.hw * Math.sqrt(1 - 0.9 ** (2 / peak.et)) ** peak.ex;
  assert.ok(nearCrest < peak.hw * 0.5,
    `the hump is ${(nearCrest * 2).toFixed(3)} m across near its top on a back `
    + `${(peak.hw * 2).toFixed(3)} m across - it swells the animal instead of standing on it`);

  /* And it is MID-BACK. A bear's hump is a shoulder mass sitting in the front
   * fifth of the barrel; a camel's is a load carried over the middle of it.
   * Expressed as a fraction along the body from the chest, which is scale free
   * and therefore comparable between two animals of different sizes. */
  const along = (s, z) => {
    const k = sectionsOf(s);
    return (z - k[0].z) / (k[k.length - 1].z - k[0].z);
  };
  const camelAt = along('camel', peak.z);
  assert.ok(camelAt > 0.35 && camelAt < 0.65,
    `the camel's hump sits ${(camelAt * 100).toFixed(0)}% along its back - a dromedary's is over `
    + 'the middle of it, not over a shoulder');
  const bearAt = along('bear', BEAST_PROFILES.bear.hump.p[2]);
  assert.ok(bearAt < 0.3,
    `the bear's hump has moved to ${(bearAt * 100).toFixed(0)}% along its back and is no longer `
    + 'the shoulder mass this comparison is against');
});

test('the hump IS the back - one skin over it, where a bear wears a second one', () => {
  /* THE FAULT THIS FILE WAS REOPENED FOR.
   *
   * The camel shipped with `barrel` + `hump`: an ellipse with an ellipsoid
   * merged into it. Merged is not joined. Two closed surfaces that intersect are
   * still two closed surfaces, and at any range where the intersection is more
   * than a pixel wide the animal reads as a ball resting on a tube - which is
   * exactly what the screenshot that reopened this showed.
   *
   * "One surface" is measurable without reading a profile field: drop a ray
   * straight down onto the back and count the OUTWARD-facing faces it meets. One
   * skin answers one, everywhere. A body with a second body merged on top
   * answers two or three - the outer object's skin, and then the inner object's
   * skin underneath it, still facing the sky from inside the first.
   *
   * The bear is the ablation and it is not hypothetical: its shoulder mass IS an
   * ellipsoid merged into a barrel, so the same scan over the same kind of
   * region has to come back with more than one. If it ever comes back with one,
   * this test has stopped being able to tell the two constructions apart. */
  const scan = (species, zLo, zHi, xLim) => {
    const b = build(species, 7);
    b.root.updateWorldMatrix(true, true);
    const rc = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);
    const from = new THREE.Vector3();
    let worst = 0;
    let worstAt = null;
    for (let iz = 0; iz <= 24; iz++) {
      for (let ix = 0; ix <= 12; ix++) {
        const z = (zLo + (zHi - zLo) * (iz / 24)) * b.heightScale;
        const x = (-xLim + 2 * xLim * (ix / 12)) * b.heightScale;
        rc.set(from.set(x, 9, z), down);
        const n = rc.intersectObject(b.mesh, false).length;
        if (n > worst) { worst = n; worstAt = [+x.toFixed(3), +z.toFixed(3)]; }
      }
    }
    b.dispose();
    return { worst, worstAt };
  };

  /* The whole back from the withers to the croup, inboard of the leg masses:
   * the forelegs reach back to z = -0.488 and the thighs forward to z = 0.380,
   * and both are outboard of |x| = 0.035, so this window touches nothing but the
   * body's own skin.
   *
   * AND IT IS A WINDOW, WHICH IS WORTH SAYING OUT LOUD, because the claim in
   * this test's title is about the HUMP and the file's prose is looser than
   * that. The same scan run down the whole centreline answers 1 everywhere
   * except z in [-0.840, -0.630], where it answers 2 - the STERNAL PAD, the one
   * `masses` entry this animal keeps, sitting under the brisket at z = -0.742.
   * It is a deliberate, named, visible lump and not a second barrel, but it is
   * a second surface and the window excludes it. The hull is one skin; the
   * ANIMAL is one skin plus one callus. */
  const camel = scan('camel', -0.48, 0.35, 0.12);
  assert.equal(camel.worst, 1,
    `a ray dropped on the camel's back at ${JSON.stringify(camel.worstAt)} passes through `
    + `${camel.worst} outward-facing surfaces. The hump is an object sitting on the body again`);

  const bear = scan('bear', -0.70, -0.30, 0.12);
  assert.ok(bear.worst > 1,
    `the bear's hump now reads as one skin with its back (${bear.worst} surface), so this scan `
    + 'can no longer tell a merged ellipsoid from a lofted one');

  // And the camel genuinely still HAS a hump to be one skin with: no `hump`
  // field, and a topline that climbs and falls again over the middle of the back.
  assert.equal(BEAST_PROFILES.camel.hump, undefined, 'the camel grew a `hump` ellipsoid back');
  assert.ok(BEAST_PROFILES.bear.hump, 'the bear lost the ellipsoid this test compares against');
  const tops = BEAST_PROFILES.camel.hull.map((s) => s.top);
  const peak = tops.indexOf(Math.max(...tops));
  assert.ok(peak > 2 && peak < tops.length - 3,
    'the camel topline peaks at an end station, so there is no hump in it at all');
  // Measured from the WITHERS - the widest section, which is where the back
  // proper starts - because that is the line the hump has to stand above.
  const withers = BEAST_PROFILES.camel.hull.reduce((a, b) => (b.hw > a.hw ? b : a));
  const rise = tops[peak] - withers.top;
  assert.ok(rise > 0.35,
    `the back rises ${rise.toFixed(3)} m from the withers into the hump - flat enough to read as `
    + 'a fat camel rather than a humped one');
});

test('nothing on the animal has an open ring showing', () => {
  /* THE PRICE OF PUTTING THE MUSCLE IN THE LIMB.
   *
   * Every limb here is a swept tube built with `capStart: false`, so its top is
   * an OPEN RING. That is deliberate and it is how the wolf and the bear are
   * built too: the parent mass covers the hole. On a wolf the barrel is 0.41 m
   * across and the leg tops are 0.14, so it covers them by a mile. On this camel
   * the shoulder and thigh are 0.28 and 0.30 across on a body 0.62 across, and
   * the fit is 2-4 cm - which is what the withers and haunch stations are drawn
   * 0.310 and 0.292 wide for.
   *
   * So it is measured rather than assumed: every vertex of every open ring is
   * tested against the hull's own cross-section at that station, by
   * point-in-polygon on the superellipse the loft actually draws. A hole here is
   * a camera looking into the inside of an animal.
   */
  const P = BEAST_PROFILES.camel;
  const H = P.hull;
  const stationAt = (z) => {
    if (z <= H[0].z || z >= H[H.length - 1].z) return null;
    for (let i = 1; i < H.length; i++) {
      if (z <= H[i].z) {
        const a = H[i - 1];
        const b = H[i];
        const t = (z - a.z) / (b.z - a.z);
        const m = (k) => a[k] + (b[k] - a[k]) * t;
        return {
          y: m('y'), hw: m('hw'), top: m('top'), bot: m('bot'),
          ex: m('ex'), et: m('et'), eb: m('eb'),
        };
      }
    }
    return null;
  };
  const outlineAt = (st, n = 360) => {
    const pts = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      pts.push([
        st.hw * Math.sign(c) * Math.abs(c) ** st.ex,
        s >= 0 ? st.y + (st.top - st.y) * Math.abs(s) ** st.et
          : st.y - (st.y - st.bot) * Math.abs(s) ** st.eb,
      ]);
    }
    return pts;
  };
  const insideHull = (x, y, z) => {
    const st = stationAt(z);
    if (!st) return false;
    const pts = outlineAt(st);
    let n = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i];
      const [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) n = !n;
    }
    return n;
  };

  /* Each entry is the open ring, parameterised by angle and by a factor that
   * fattens it about its own centre - which is what the ablation below turns up. */
  const rings = [
    ['left fore', P.legs.upperFront[0], -P.legs.track, P.legs.frontHipY, P.legs.frontZ],
    ['right fore', P.legs.upperFront[0], P.legs.track, P.legs.frontHipY, P.legs.frontZ],
    ['left hind', P.legs.upperHind[0], -P.legs.track, P.legs.hindHipY, P.legs.hindZ],
    ['right hind', P.legs.upperHind[0], P.legs.track, P.legs.hindHipY, P.legs.hindZ],
  ].map(([name, t, cx, cy, cz]) => [name, (a, sc) => [
    cx + Math.cos(a) * t.rx * sc, cy + t.y, cz + Math.sin(a) * t.ry * sc,
  ]]);
  const s0 = P.neck.sections[0];
  rings.push(['neck base', (a, sc) => [
    Math.cos(a) * s0.rx * sc,
    P.neck.at[1] + s0.y + Math.sin(a) * s0.ry * sc,
    P.neck.at[2] + s0.z,
  ]]);

  for (const [name, at] of rings) {
    for (let k = 0; k < 96; k++) {
      const [x, y, z] = at((k / 96) * Math.PI * 2, 1);
      assert.ok(insideHull(x, y, z),
        `the ${name} open ring reaches (${x.toFixed(3)}, ${y.toFixed(3)}, ${z.toFixed(3)}), which `
        + 'is outside the hull - there is a hole in the animal there');
    }
  }

  /* THE ABLATION, and it is the whole reason the stations above are the sizes
   * they are. "No holes" on its own is satisfied perfectly by limbs drawn thin
   * enough to disappear inside the body - which is the version of the fix that
   * also means "no shoulder". So the very next station down each limb, the one
   * carrying the muscle, has to be OUTSIDE: a shoulder and a thigh that stand
   * proud of the ribs, and a neck that has left the withers. If any of these
   * three ever fits inside the hull, the test above has stopped being able to
   * detect a hole because there is nothing left near the surface to make one. */
  const proud = [
    ['fore shoulder', P.legs.upperFront[2], P.legs.track, P.legs.frontHipY, P.legs.frontZ],
    ['hind thigh', P.legs.upperHind[2], P.legs.track, P.legs.hindHipY, P.legs.hindZ],
  ].map(([name, t, cx, cy, cz]) => [name, (a) => [
    cx + Math.cos(a) * t.rx, cy + t.y, cz + Math.sin(a) * t.ry,
  ]]);
  const s2 = P.neck.sections[2];
  proud.push(['neck at the withers', (a) => [
    Math.cos(a) * s2.rx,
    P.neck.at[1] + s2.y + Math.sin(a) * s2.ry,
    P.neck.at[2] + s2.z,
  ]]);
  for (const [name, at] of proud) {
    let outside = 0;
    for (let k = 0; k < 96; k++) {
      const [x, y, z] = at((k / 96) * Math.PI * 2);
      if (!insideHull(x, y, z)) outside++;
    }
    assert.ok(outside > 4,
      `the ${name} is entirely inside the hull (${outside} of 96 points proud of it) - it is a `
      + 'mass nobody can see, and the open-ring check above is therefore measuring nothing');
  }
});

test('the neck is a metre of near-vertical, which nothing else here has', () => {
  const neckRun = (s) => {
    const k = BEAST_PROFILES[s].neck.sections;
    let len = 0;
    for (let i = 1; i < k.length; i++) len += Math.hypot(k[i].y - k[i - 1].y, k[i].z - k[i - 1].z);
    return { len, rise: k[k.length - 1].y - k[0].y, run: Math.abs(k[k.length - 1].z - k[0].z) };
  };
  const camel = neckRun('camel');
  const wolf = neckRun('wolf');
  const bear = neckRun('bear');

  // Long, in absolute metres and as a fraction of the animal.
  assert.ok(camel.len > 1.0,
    `the camel's neck is ${camel.len.toFixed(2)} m of path - a dromedary's is over a metre`);
  const frac = (s, n) => n.len / BEAST_PROFILES[s].height;
  assert.ok(frac('camel', camel) > frac('wolf', wolf) * 1.3,
    `the camel's neck is ${frac('camel', camel).toFixed(2)} of its height against a wolf's `
    + `${frac('wolf', wolf).toFixed(2)}`);

  // And UP rather than forward, which is the half that makes the head carriage
  // work. Both predators reach forward; only this one climbs.
  assert.ok(camel.rise > camel.run * 1.5,
    `the camel's neck rises ${camel.rise.toFixed(2)} m over ${camel.run.toFixed(2)} m of reach `
    + '- that is a neck pointing at the horizon, not at the sky');
  assert.ok(wolf.rise < wolf.run, 'the wolf neck stopped being the horizontal one');
  assert.ok(bear.rise < 0, 'the bear neck stopped hanging downward');
});

test('the legs are long and the feet are splayed', () => {
  /* Two measurements, both ratios, because "long" and "splayed" are only
   * meaningful against the body they are attached to.
   *
   * LEG: hip height over barrel depth. A camel is a body on stilts; a wolf and
   * a bear are - to within a percent of each other, which is the interesting
   * part - the same animal by this measure.
   *
   * FOOT: pad width over the width of the cannon bone directly above it. This
   * is FLARE, and it is what "splayed" means: a bear has an enormous foot that
   * is nevertheless the same width as its own leg. */
  const legRatio = (s) => BEAST_PROFILES[s].legs.frontHipY / depthOf(s);
  assert.ok(legRatio('camel') > legRatio('wolf') * 1.5,
    `a camel's hip sits ${legRatio('camel').toFixed(2)} barrel-depths up against a wolf's `
    + `${legRatio('wolf').toFixed(2)}`);
  assert.ok(legRatio('camel') > legRatio('bear') * 1.5,
    `a camel's hip sits ${legRatio('camel').toFixed(2)} barrel-depths up against a bear's `
    + `${legRatio('bear').toFixed(2)}`);

  const flare = (s) => {
    const L = BEAST_PROFILES[s].legs;
    return L.paw.r[0] / L.lower[L.lower.length - 1].rx;
  };
  assert.ok(flare('camel') > 3,
    `the camel's pad is only ${flare('camel').toFixed(2)} times its own cannon - it does not splay`);
  assert.ok(flare('camel') > flare('bear') * 2 && flare('camel') > flare('wolf') * 2,
    `flare: camel ${flare('camel').toFixed(2)}, bear ${flare('bear').toFixed(2)}, `
    + `wolf ${flare('wolf').toFixed(2)}`);

  // Flat, too: a pad, not a ball. Width over depth.
  const flatness = (s) => BEAST_PROFILES[s].legs.paw.r[0] / BEAST_PROFILES[s].legs.paw.r[1];
  assert.ok(flatness('camel') > flatness('bear'),
    `the camel's pad is ${flatness('camel').toFixed(2)} wide per unit of depth against the bear's `
    + `plantigrade plate at ${flatness('bear').toFixed(2)}`);

  // Two toenails, not four claws, and the builder honoured it.
  assert.equal(BEAST_PROFILES.camel.legs.clawCount, 2);
  assert.equal(BEAST_PROFILES.wolf.legs.clawCount, undefined,
    'the wolf gained an explicit claw count, which is a change to a profile that must not change');
});

test('the leg carries its own muscle, and the joints in it are knobs', () => {
  /* THE SECOND FAULT THIS FILE WAS REOPENED FOR: "thin cylinders with ball
   * joints and no muscle mass at the top".
   *
   * The wolf and the bear hang their shoulder and haunch off the BARREL, as
   * ellipsoids merged into it, and at 0.85 m and 1.4 m tall that reads. It did
   * not read on a 2.2 m animal whose legs are 1.4 m long: the leg left the body
   * at 0.098 m of half-width and went straight down, and two 0.085 m lumps on a
   * 0.245 m barrel were invisible beside it. Four rods pushed into a tube.
   *
   * The mass is now IN the limb, which is also where it belongs kinematically -
   * a shoulder that swings with the leg instead of staying behind on the ribs.
   * Three measurements say so, and none of them is "the numbers are bigger":
   *
   *   TAPER: the widest point of the upper leg against the cannon bone below
   *     the knee. A rod is 1; this has to be a limb.
   *   DRIVE: the hind heavier than the fore at every station above the hock,
   *     which is the ordinary quadruped arrangement and the thing that makes a
   *     standing animal look like it could move.
   *   JOINT: the knee wider than the bone above it AND the bone below it. The
   *     shipped leg had 0.045 at the top of the lower segment under an 0.048
   *     upper - a joint narrower than both, which is a rod with a crimp in it.
   */
  const L = BEAST_PROFILES.camel.legs;
  const cannon = Math.min(...L.lower.map((k) => k.rx));
  const widestFore = Math.max(...L.upperFront.map((k) => k.rx));
  const widestHind = Math.max(...L.upperHind.map((k) => k.rx));

  assert.ok(widestFore / cannon > 3.5,
    `the foreleg is ${(widestFore / cannon).toFixed(2)} cannons wide at the shoulder - that is a `
    + 'rod, not a limb');
  assert.ok(widestHind > widestFore,
    `the thigh (${widestHind}) is no heavier than the shoulder (${widestFore}) - a quadruped's `
    + 'drive is behind');

  /* The hind outweighs the fore at every visible station, not just at the one
   * somebody happened to type a bigger number into. Station 0 is exempt: it is
   * the buried tip, and it is sized by how much room the hull has to swallow it
   * at that station rather than by the animal. */
  assert.equal(L.upperFront.length, L.upperHind.length);
  for (let i = 1; i < L.upperFront.length; i++) {
    assert.ok(L.upperHind[i].rx >= L.upperFront[i].rx,
      `station ${i}: the hind leg (${L.upperHind[i].rx}) is thinner than the fore `
      + `(${L.upperFront[i].rx})`);
  }

  // THE KNEE. Widest station of the lower segment, and it has to be wider than
  // the end of the upper segment above it and the cannon below it.
  const knee = L.lower.reduce((a, b) => (b.rx > a.rx ? b : a));
  const aboveFore = L.upperFront[L.upperFront.length - 1].rx;
  const aboveHind = L.upperHind[L.upperHind.length - 1].rx;
  assert.ok(knee.rx > aboveFore && knee.rx > aboveHind,
    `the knee is ${knee.rx} under an upper leg that finishes at ${aboveFore} / ${aboveHind} - `
    + 'the joint is narrower than the bones it joins, which is a crimp and not a knee');
  assert.ok(knee.rx > cannon * 1.8,
    `the knee is only ${(knee.rx / cannon).toFixed(2)} cannons wide - it does not read as a joint`);
  assert.ok(Math.abs(knee.y) < 0.05,
    `the knee knob sits ${knee.y} from the joint it turns about, so folding the leg swings it out `
    + 'sideways instead of rotating it about its own centre');

  // And the wolf did NOT acquire any of this: it is still three stations with
  // the muscle on the barrel, which is what its digest is pinned to.
  assert.equal(BEAST_PROFILES.wolf.legs.upperFront.length, 3);
  assert.equal(BEAST_PROFILES.bear.legs.upperFront.length, 3);
  assert.equal(BEAST_PROFILES.camel.masses.length, 1,
    'the camel grew shoulder and haunch ellipsoids back onto its barrel');
  assert.equal(BEAST_PROFILES.wolf.masses.length, 4);
});

test('the neck TAPERS into the shoulder instead of being planted on it', () => {
  /* THE THIRD FAULT: "a smooth tube with no taper into the shoulders".
   *
   * Two things are wrong with a tube. It is one thickness, and it meets the body
   * at a hard circle. Both are measurable.
   *
   * THICKNESS: the base against the poll. A camel's neck is a wedge - it is a
   *   third of the girth of the chest where it leaves it and a fifth of that at
   *   the head - and it must narrow at EVERY station, or it is a tube with a
   *   bulge somewhere in it.
   * JOIN: the base ring has to be genuinely buried. Not "inside the hull", which
   *   the open-ring test already holds, but inside it with the whole of the
   *   first third of the neck's run still under the skin, so the surface a
   *   player sees leaves the withers as a swelling rather than as a rim.
   */
  const N = BEAST_PROFILES.camel.neck;
  const k = N.sections;
  assert.ok(k.length >= 7, `${k.length} stations cannot describe a metre of curve`);
  for (let i = 1; i < k.length; i++) {
    assert.ok(k[i].rx < k[i - 1].rx,
      `the neck is ${k[i].rx} at station ${i} under ${k[i - 1].rx} at ${i - 1} - it swells `
      + 'somewhere along its length instead of tapering');
  }
  const taper = k[0].rx / k[k.length - 1].rx;
  assert.ok(taper > 2.5,
    `the neck is ${taper.toFixed(2)} times thicker at the shoulder than at the poll - a tube is 1`);
  assert.ok(k[0].rx > girthOf('camel') * 0.65,
    `the neck leaves a ${(girthOf('camel') * 2).toFixed(2)} m chest at ${(k[0].rx * 2).toFixed(2)} `
    + 'm across - too thin at the root to be part of the shoulder');

  /* Most of the taper happens EARLY, over the buried third: 0.228 -> 0.150 in
   * the first 0.35 m of a 1.32 m run. A neck that tapers evenly over its whole
   * length is a cone, and a cone planted on a body has the same hard rim a
   * cylinder does. */
  const run = (i) => Math.hypot(k[i].y - k[i - 1].y, k[i].z - k[i - 1].z);
  let total = 0;
  for (let i = 1; i < k.length; i++) total += run(i);
  const early = run(1) + run(2);
  const dropEarly = k[0].rx - k[2].rx;
  const dropAll = k[0].rx - k[k.length - 1].rx;
  assert.ok(early / total < 0.35 && dropEarly / dropAll > 0.5,
    `the first ${((early / total) * 100).toFixed(0)}% of the neck's run does `
    + `${((dropEarly / dropAll) * 100).toFixed(0)}% of the narrowing - the taper is spread evenly, `
    + 'which is a cone');

  // The predators keep the three-station necks their digests are pinned to.
  assert.equal(BEAST_PROFILES.wolf.neck.sections.length, 3);
  assert.equal(BEAST_PROFILES.bear.neck.sections.length, 3);
});

test('the chest is a KEEL that hangs below the shoulder, and the flank is slab-sided', () => {
  /* THE FOURTH FAULT: "almost no barrel/ribcage between the legs - the body
   * reads as a ball on stilts".
   *
   * The shipped barrel was an ellipse 0.49 m wide and 0.67 m deep with a round
   * underside. The hull is the same 0.655 m deep - the depth was never the
   * problem - and 0.62 m WIDE, and its underside comes to an edge 0.32 m below
   * the shoulder joint the legs swing from. That is what a dromedary's chest is,
   * and it is the difference between a body and a tube.
   *
   * Slab-sidedness is `ex`, and it is checked the way a player sees it: how much
   * of its full width the section still has a quarter of the way up towards the
   * topline. An ellipse holds 87%; this holds better than 93%; a cylinder would
   * be 100% and would read as a barrel of oil.
   */
  const P = BEAST_PROFILES.camel;
  const girth = P.hull.reduce((a, b) => (b.hw > a.hw ? b : a));

  const belowShoulder = P.legs.frontHipY - girth.bot;
  assert.ok(belowShoulder > 0.28,
    `the deepest point of the chest is only ${belowShoulder.toFixed(3)} m below the shoulder `
    + 'joint - there is no keel under this animal');
  assert.ok(girth.bot < bellyOf('camel') + 1e-9,
    'the deepest section of the chest is not the lowest part of the body');
  // ...and it is a keel and not a bowl: the underside comes to an edge, which is
  // `eb` above 1. An ellipse is exactly 1 and a flat pan is below it.
  assert.ok(girth.eb > 1.35,
    `the underside exponent at the girth is ${girth.eb} - the chest is round-bottomed`);

  const widthAt = (st, frac) => {
    const dy = (st.top - st.y) * frac;
    const sinA = (dy / (st.top - st.y)) ** (1 / st.et);
    return st.hw * Math.sqrt(1 - sinA * sinA) ** st.ex;
  };
  const held = widthAt(girth, 0.25) / girth.hw;
  assert.ok(held > 0.93,
    `the flank is down to ${(held * 100).toFixed(0)}% of its width a quarter of the way up - `
    + 'that is an ellipse, not a slab-sided animal');
  assert.ok(girth.ex < 0.9, `the side exponent is ${girth.ex}; 1 is an ellipse`);

  // Wider than it was, and wider than deep is still wrong - a camel seen head on
  // is a TALL narrow animal, which is the half of the shape the keel provides.
  assert.ok(depthOf('camel') > girth.hw * 2,
    `the ribcage is ${depthOf('camel').toFixed(3)} m deep and ${(girth.hw * 2).toFixed(3)} m wide `
    + '- a dromedary is deeper than it is wide');
  // The ellipse arms still answer for the two predators, unchanged.
  assert.ok(Math.abs(depthOf('wolf') - 0.49) < 1e-9);
  assert.ok(Math.abs(depthOf('bear') - 0.79) < 1e-9);
});

test('the rebuilt camel is still cheap enough to put seven of on screen', () => {
  /* This is streamed content: `packMax` is 7, and a herd is built and thrown
   * away as the player crosses the flats. The rebuild spends its triangles on a
   * lofted hull with 16 stations and on limbs with six and seven stations
   * instead of three - and gets some of them back by deleting the hump
   * ellipsoid and the four muscle ellipsoids, which are now geometry the hull
   * and the limbs already own.
   *
   * Measured, not asserted: 3016 -> 3672 per camel, +21.8%, and a seven-strong
   * herd goes 21112 -> 25704. The bound below is the wolf's cost plus a third,
   * which is where the numbers actually landed with room to breathe; the point
   * of it is that the next person to add detail has to notice they are doing it.
   */
  const trisOf = (species) => {
    const b = build(species, 7);
    let t = 0;
    b.root.traverse((o) => { if (o.isMesh) t += o.geometry.getAttribute('position').count / 3; });
    b.dispose();
    return t;
  };
  const wolf = trisOf('wolf');
  const camel = trisOf('camel');
  assert.equal(wolf, 3016, 'the wolf changed size, which no digest would catch as a count');
  assert.ok(camel < wolf * 1.35,
    `a camel is ${camel} triangles against a wolf's ${wolf}, `
    + `+${((camel / wolf - 1) * 100).toFixed(1)}% - a herd of seven is streamed, so this `
    + 'is not free');
  assert.ok(camel * BEASTS.camel.packMax < 28000,
    `a full herd is ${camel * BEASTS.camel.packMax} triangles`);
  // And the detail band still has something to drop at distance.
  const b = build('camel', 7);
  b.setDetailVisible(false);
  let hidden = 0;
  b.root.traverse((o) => { if (o.isMesh && !o.visible) hidden++; });
  assert.equal(hidden, 7,
    `${hidden} meshes are culled at range, not the seven this animal files as detail - the eyes, `
    + 'the two rows of teeth and one pair of toenails on each of four feet');
  b.dispose();
});

test('a camel stands on the floor, inside its capsule, and can be shot along its length', () => {
  /* The three invariants `beast-body.test.mjs` holds over `['wolf', 'bear']` -
   * a hard-coded pair, so a third species is covered by NOTHING there. Held
   * here over 200 seeds rather than four, because the size jitter is what makes
   * them interesting and 2.2 m of animal amplifies a 10% error into 22 cm. */
  const def = BEASTS.camel;
  let worstFloat = 0;
  let worstWidth = 0;
  let narrowest = Infinity;
  let worstBound = Infinity;
  for (let seed = 1; seed <= 200; seed++) {
    const b = build('camel', seed);
    const box = boxOf(b);
    worstFloat = Math.max(worstFloat, Math.abs(box.min.y));
    const halfWidth = Math.max(Math.abs(box.min.x), Math.abs(box.max.x));
    worstWidth = Math.max(worstWidth, halfWidth);
    narrowest = Math.min(narrowest, halfWidth);
    const extent = Math.max(box.max.z, -box.min.z, halfWidth);
    worstBound = Math.min(worstBound, (b.bodyLength * 0.55 + def.bodyRadius) - extent * 0.9);
    assert.ok(Math.abs(b.height - def.shoulderHeight * b.heightScale) < 1e-6,
      `seed ${seed}: the body height and the species table disagree`);
    b.dispose();
  }
  assert.ok(worstFloat < 0.06,
    `the worst camel of 200 misses the floor by ${worstFloat.toFixed(4)} m`);
  assert.ok(worstWidth <= def.bodyRadius,
    `the widest camel of 200 is ${worstWidth.toFixed(3)} m against a ${def.bodyRadius} m capsule `
    + '- its shoulders are in the walls');
  assert.ok(narrowest > def.bodyRadius * 0.4,
    `the narrowest camel of 200 is ${narrowest.toFixed(3)} m inside a ${def.bodyRadius} m capsule`);
  /* WHAT THIS NUMBER IS, AND WHAT IT IS NOT.
   *
   * It is `boundRadius` against the body's own extent, in the BODY'S FRAME,
   * origin at the feet. That is the comparison `BeastNPC.js:107` is written
   * against and it is worth holding: it is what stops a 2.7 m animal being
   * given a wolf's reach.
   *
   * It is NOT the test the engine performs. `NPCManager.raycastNPCs:2083`
   * centres the rejection sphere at `position.y + height * 0.5`, and this
   * expression has no y offset in it at all, so a positive margin here says
   * nothing about whether the sphere contains the animal. Measured properly -
   * distance from that centre to the head sphere's far edge, worst of 200
   * seeds - the camel's head sits OUTSIDE the rejection sphere by 0.3191 m on
   * this tree and by 0.3709 m at 092740c, while the wolf clears it by 0.301 m
   * and the bear by 0.573 m. So some head shots on a camel are rejected before
   * the head sphere is ever tested.
   *
   * That is a live defect and it is NOT this branch's: it is the same at
   * 092740c, the rebuilt body shortened `bodyLength` from 2.719 m to 2.686 m
   * and so IMPROVED it by 0.052 m, and the fix belongs in `BeastNPC` rather
   * than in an art pass. It is printed here rather than asserted because
   * asserting it would be red, and left here rather than deleted because the
   * reason nobody had noticed is that the line below reads like a proof of it.
   */
  let worstHead = -Infinity;
  for (let seed = 1; seed <= 200; seed++) {
    const b = build('camel', seed);
    b.root.updateWorldMatrix(true, true);
    const head = b.getHeadWorldPosition(new THREE.Vector3());
    const bound = b.bodyLength * 0.55 + def.bodyRadius;
    head.y -= b.height * 0.5;
    worstHead = Math.max(worstHead, head.length() + 0.135 * b.heightScale - bound);
    b.dispose();
  }
  console.info(`  published bound clears the body by ${worstBound.toFixed(4)} m in the body frame;`
    + ` the engine's rejection sphere MISSES the head by ${worstHead.toFixed(4)} m`
    + ' (pre-existing, 0.3709 m at 092740c - see the note above)');
  assert.ok(worstBound > 0,
    `the published hit bound is ${(-worstBound).toFixed(3)} m shorter than the body it is `
    + 'published for, so a camel is given a bound sized for a smaller animal');
});

/* ================================================================== */
/* 3. THE GAIT                                                        */
/* ================================================================== */

const paceGait = () => GAITS.camel.find((g) => g.name === 'pace');
const gallopGait = () => GAITS.camel.find((g) => g.name === 'gallop');
const SAMPLES = 720;

test('a camel PACES: the lateral pairs land together, and the sides alternate', () => {
  /* The cheapest thing in this whole feature that makes a camel read as a
   * camel. A pace is both legs on ONE SIDE leaving and landing in exact
   * synchrony - not the bear's staggered lateral sequence, which is an amble,
   * and emphatically not the wolf's diagonals.
   *
   * Held as EQUALITY on the same-side pair and a half-cycle on the opposite
   * one, because "roughly lateral" is what an amble already is. */
  const fall = footfallPhases(paceGait());     // [FL, FR, HL, HR]
  const gap = (a, b) => Math.min(Math.abs(a - b), 1 - Math.abs(a - b));
  assert.equal(gap(fall[0], fall[2]), 0, 'the camel\'s near fore and near hind do not land together');
  assert.equal(gap(fall[1], fall[3]), 0, 'the camel\'s off fore and off hind do not land together');
  assert.ok(Math.abs(gap(fall[0], fall[1]) - 0.5) < 1e-9,
    `the two sides land ${gap(fall[0], fall[1]).toFixed(3)} of a cycle apart, not a half`);

  // The bear's amble is the thing this must not have collapsed into.
  const amble = footfallPhases(GAITS.bear.find((g) => g.name === 'amble'));
  assert.ok(gap(amble[0], amble[2]) > 0,
    'the bear amble has become an exact pace, so the two species now move identically');
});

test('the pace keeps two feet down and the gallop leaves the ground briefly', () => {
  const pace = paceGait();
  let worst = 4;
  for (let i = 0; i < SAMPLES; i++) worst = Math.min(worst, supportCount(pace, i / SAMPLES));
  assert.equal(worst, 2,
    `the pace drops to ${worst} feet - a pacing animal stands on one side at a time, which is `
    + 'two, and never on nothing');
  assert.equal(suspensionFraction(pace, SAMPLES), 0, 'the pace has grown a flight phase');

  /* The gallop is not called `sprint` or `charge`, so `beast-gait.test.mjs` -
   * which counts those two names to prove the wolf and the bear each own one
   * running gait - does not hold it to having a flight phase. This does. */
  const air = suspensionFraction(gallopGait(), SAMPLES);
  assert.ok(air > 0.05 && air < 0.25,
    `the camel gallop spends ${(air * 100).toFixed(1)}% of its cycle airborne`);
  const cycle = gallopGait().stride / BEASTS.camel.chargeSpeed;
  assert.ok(air * cycle < 0.2,
    `a bolting camel floats for ${(air * cycle).toFixed(3)}s at a time`);
});

test('the pace band covers everything short of a bolt, because a camel has no trot', () => {
  assert.equal(GAITS.camel.length, 3, 'the camel grew an intermediate gear it does not have');
  assert.equal(gaitFor('camel', BEASTS.camel.roamSpeed).name, 'pace',
    'a grazing camel is not pacing');
  assert.equal(gaitFor('camel', BEASTS.camel.stalkSpeed).name, 'pace');
  assert.equal(gaitFor('camel', BEASTS.camel.chargeSpeed * 0.95).name, 'gallop',
    'a fleeing camel is not galloping');
  assert.equal(gaitFor('camel', 0).name, 'stand');
});

test('only the pace declares a roll, and it actually reaches the body', () => {
  /* THE SHIP. The leg tables put the feet in the right pattern; nothing in them
   * makes the barrel above the feet fall toward the unsupported side, and that
   * fall is what a camel looks like. It lives on the gait as `roll`, and this
   * asserts both that no predator gait has one - which is what keeps their
   * animation digests identical - and that the animator applies it. */
  for (const species of ['wolf', 'bear']) {
    for (const g of GAITS[species]) {
      assert.ok(!g.roll, `${species}'s "${g.name}" declares a roll, so the predators now roll`);
    }
  }
  assert.ok(paceGait().roll > 0.05, 'the pace roll is too small to see');
  assert.ok(gallopGait().roll < paceGait().roll * 0.5,
    'a galloping camel rolls as hard as a pacing one - the gallop is not a lateral gait');

  /* Measured on the real animator: hold the animal at pace speed for two full
   * stride cycles and watch `tilt.rotation.z`. It has to swing both ways, and
   * the peak has to be near the roll the table asked for. Turn rate is pinned
   * at zero so nothing of the lean term is in the number. */
  const body = build('camel', 5);
  const an = new BeastAnimator({ body, species: 'camel', seed: 5 });
  an.setIntentForState({ state: 'ROAM', phase: 'none', wind: 0, hunting: false, stalking: false });
  an.setLocomotion(2.6, 0);
  let lo = Infinity;
  let hi = -Infinity;
  const dt = 1 / 120;
  for (let i = 0; i < 600; i++) {
    an.setLocomotion(2.6, 0);
    an.update(dt, i * dt, { detail: false, ik: false, distance: 20 });
    if (i > 240) {                                   // past the damped settle
      lo = Math.min(lo, body.tilt.rotation.z);
      hi = Math.max(hi, body.tilt.rotation.z);
    }
  }
  const swing = hi - lo;
  assert.ok(swing > paceGait().roll * 1.6,
    `the barrel swings ${swing.toFixed(4)} rad peak to peak against a declared roll of `
    + `${paceGait().roll} - the roll is not reaching the body`);
  assert.ok(lo < -0.04 && hi > 0.04,
    `the roll is one-sided: ${lo.toFixed(4)} .. ${hi.toFixed(4)}`);
  body.dispose();

  // The ablation: the same drive on a wolf, whose trot declares no roll.
  const wolfBody = build('wolf', 5);
  const wolfAn = new BeastAnimator({ body: wolfBody, species: 'wolf', seed: 5 });
  let wLo = Infinity;
  let wHi = -Infinity;
  for (let i = 0; i < 600; i++) {
    wolfAn.setLocomotion(2.6, 0);
    wolfAn.update(dt, i * dt, { detail: false, ik: false, distance: 20 });
    if (i > 240) {
      wLo = Math.min(wLo, wolfBody.tilt.rotation.z);
      wHi = Math.max(wHi, wolfBody.tilt.rotation.z);
    }
  }
  assert.ok(wHi - wLo < 1e-6,
    `a trotting wolf's barrel swings ${(wHi - wLo).toFixed(6)} rad - the roll leaked`);
  wolfBody.dispose();
});

test('the pace roll is the roll the table declares, and the same at any frame rate', () => {
  /* THE CAPSIZE.
   *
   * `only the pace declares a roll` above proves the roll REACHES the body. It
   * cannot prove the body gets the right amount of it, and it did not: the sine
   * was added to `tilt.rotation.z` after a `damp` that reads the same property
   * back, so every frame's roll returned as part of the next frame's state and
   * the whole thing summed to a geometric series. Measured before the fix, on
   * THIS fixture - seed 5, 2.6 m/s, 15 s, first 2 s discarded - a declared
   * 0.150 rad of swing produced:
   *
   *      30 Hz  0.550      60 Hz  1.030      120 Hz  1.994      240 Hz  3.922
   *
   * A walking camel leaning 59 degrees peak to peak, and 225 on a fast machine.
   * The pair of numbers that used to be here (1.161 at 60 Hz, 1.994 at 120 Hz)
   * were both real and were from DIFFERENT fixtures - 1.161 is the grazing
   * walk, not 2.6 m/s - so the first of them did not reproduce off this case.
   * Every figure above is from `swingAt` below with the fix reverted, and each
   * is stable to four places from 900 steps out to 60,000.
   *
   * Two independent things are wrong there and this holds both:
   *   the AMPLITUDE has to be the one the gait table asked for, and
   *   it has to be the SAME at two frame rates, which no feedback loop through
   *   an exponential damp can be.
   *
   * The turn rate is pinned at zero throughout so none of the lean term is in
   * the number, and the first two seconds are discarded so none of the settle is.
   */
  const swingAt = (dt, steps, speed) => {
    const body = build('camel', 5);
    const an = new BeastAnimator({ body, species: 'camel', seed: 5 });
    an.setIntentForState({
      state: 'ROAM', phase: 'none', wind: 0, hunting: false, stalking: false,
    });
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < steps; i++) {
      an.setLocomotion(speed, 0);
      an.update(dt, i * dt, { detail: false, ik: false, distance: 20 });
      if (i * dt <= 2) continue;
      lo = Math.min(lo, body.tilt.rotation.z);
      hi = Math.max(hi, body.tilt.rotation.z);
    }
    body.dispose();
    return hi - lo;
  };

  const declared = paceGait().roll;
  const slow = swingAt(1 / 60, 900, 2.6);
  const fast = swingAt(1 / 240, 3600, 2.6);
  for (const [label, got] of [['60 Hz', slow], ['240 Hz', fast]]) {
    assert.ok(Math.abs(got - declared * 2) < declared * 0.06,
      `at ${label} the barrel swings ${got.toFixed(4)} rad where the table declares `
      + `${(declared * 2).toFixed(4)} - the roll is being amplified or eaten somewhere between `
      + 'the gait and the node');
  }
  assert.ok(Math.abs(slow - fast) < declared * 0.04,
    `the same camel rolls ${slow.toFixed(4)} rad at 60 Hz and ${fast.toFixed(4)} at 240 - the `
    + 'roll is coming out of a feedback loop and the animal looks different on a faster machine');

  // A grazing camel is already pacing, so this is the roll a player mostly sees.
  const grazing = swingAt(1 / 60, 900, BEASTS.camel.roamSpeed);
  assert.ok(Math.abs(grazing - declared * 2) < declared * 0.06,
    `a camel at its ${BEASTS.camel.roamSpeed} m/s grazing walk swings ${grazing.toFixed(4)} rad`);

  /* The ablation: a wolf under exactly the same drive. Its trot declares no
   * roll, so `_rolled` stays 0, neither guarded line runs, and `rotation.z`
   * holds still - which is also the proof that the two lines added to the pose
   * driver cannot be reached by a predator. */
  const wolfBody = build('wolf', 5);
  const wolfAn = new BeastAnimator({ body: wolfBody, species: 'wolf', seed: 5 });
  let wLo = Infinity;
  let wHi = -Infinity;
  for (let i = 0; i < 900; i++) {
    wolfAn.setLocomotion(2.6, 0);
    wolfAn.update(1 / 60, i / 60, { detail: false, ik: false, distance: 20 });
    if (i <= 120) continue;
    wLo = Math.min(wLo, wolfBody.tilt.rotation.z);
    wHi = Math.max(wHi, wolfBody.tilt.rotation.z);
  }
  assert.ok(wHi - wLo < 1e-9, `a trotting wolf's barrel swings ${(wHi - wLo).toFixed(9)} rad`);
  wolfBody.dispose();
});

test('a camel that dies mid-stride comes back upright, not carrying the roll it died with', () => {
  /* THE ONE STATE IN WHICH THE ROLL INVARIANT IS VIOLATED.
   *
   * `_rolled` is a claim about the NODE: "of whatever is in `tilt.rotation.z`,
   * this much is mine, and I take it back before the damp". Every live frame
   * keeps that true. Death does not - `_poseDead` writes `rotation.z` outright
   * and never touches `_rolled` - so the two only have to be re-synchronised in
   * one place, `revive()`, which zeroes the node and used not to zero the flag.
   *
   * `NPC.respawn` calls `revive()`, so the first live frame of a respawned
   * camel subtracted a roll the node no longer held.
   *
   * Measured as the WORST |rotation.z| over the second after revival, against
   * the same animator brought to the same standstill without ever dying. The
   * control matters: a camel at rest has some settle of its own, and asserting
   * a bare number would pass on a build where nothing moves at all.
   */
  const paceTo = (kill) => {
    const body = build('camel', 5);
    const an = new BeastAnimator({ body, species: 'camel', seed: 5 });
    an.setIntentForState({
      state: 'ROAM', phase: 'none', wind: 0, hunting: false, stalking: false,
    });
    // Pace far enough in that the roll is at full amplitude, then stop on a
    // frame where the sine is well off zero - a stale 0 proves nothing.
    let i = 0;
    for (; i < 600; i++) {
      an.setLocomotion(2.6, 0);
      an.update(1 / 60, i / 60, { detail: false, ik: false, distance: 20 });
    }
    for (let g = 0; g < 120 && Math.abs(an._rolled) < paceGait().roll * 0.8; g++, i++) {
      an.setLocomotion(2.6, 0);
      an.update(1 / 60, i / 60, { detail: false, ik: false, distance: 20 });
    }
    const carried = an._rolled;
    if (kill) {
      an.die(new THREE.Vector3(1, 0, 0));
      for (let d = 0; d < 30; d++, i++) an.update(1 / 60, i / 60, { detail: false, ik: false, distance: 20 });
      an.revive();
    }
    // Standing still from here: nothing should be driving the barrel at all.
    let worst = 0;
    for (let s = 0; s < 60; s++, i++) {
      an.setLocomotion(0, 0);
      an.update(1 / 60, i / 60, { detail: false, ik: false, distance: 20 });
      worst = Math.max(worst, Math.abs(body.tilt.rotation.z));
    }
    body.dispose();
    return { carried, worst };
  };

  const control = paceTo(false);
  const revived = paceTo(true);
  console.info(`  carried ${revived.carried.toFixed(4)} rad into death;`
    + ` worst tilt after revive ${revived.worst.toFixed(6)} rad`
    + ` against ${control.worst.toFixed(6)} standing on`);
  assert.ok(Math.abs(revived.carried) > paceGait().roll * 0.8,
    `the fixture stopped the camel at ${revived.carried.toFixed(4)} rad of roll - it has to die `
    + 'with a real one or this case cannot detect a stale flag');
  assert.ok(revived.worst <= control.worst + 1e-9,
    `a respawned camel's barrel starts ${revived.worst.toFixed(4)} rad over where the same camel `
    + `stands at ${control.worst.toFixed(4)} - revive() left the pace roll latched`);
});

test('a resting camel chews and a resting wolf does not', () => {
  /* Measured recognition distance for this project's animals is 15-20 m, and at
   * that range a still animal reads as a placed prop. A chewing jaw is the
   * cheapest possible "this is alive". Gated on the species, so it can never
   * appear on a predator whose jaw means something else entirely. */
  const jawSwing = (species) => {
    const body = build(species, 9);
    const an = new BeastAnimator({ body, species, seed: 9 });
    an.setIntentForState({ state: 'ROAM', phase: 'none', wind: 0, hunting: false, stalking: false });
    let lo = Infinity;
    let hi = -Infinity;
    const dt = 1 / 60;
    for (let i = 0; i < 900; i++) {
      an.setLocomotion(0, 0);
      an.update(dt, i * dt, { detail: false, ik: false, distance: 12 });
      if (i > 120) { lo = Math.min(lo, body.jaw.rotation.x); hi = Math.max(hi, body.jaw.rotation.x); }
    }
    body.dispose();
    return hi - lo;
  };
  const camel = jawSwing('camel');
  assert.ok(camel > 0.05,
    `a standing camel's jaw moves ${camel.toFixed(4)} rad - that is a closed mouth`);
  for (const species of ['wolf', 'bear']) {
    assert.ok(jawSwing(species) < 1e-9,
      `a standing ${species} is chewing, which is the herbivore idle leaking onto a predator`);
  }
});

/* ================================================================== */
/* 4. TEMPERAMENT: THE MAUL IS UNREACHABLE                            */
/* ================================================================== */

/** An infinite floor at y = 0. Same fixture shape as `beast-combat`. */
const flatWorld = () => ({
  groundHeight: () => 0,
  resolveCapsule: (p) => {
    if (p.y < 0) p.y = 0;
    return { grounded: p.y <= 0.001, groundNormal: new THREE.Vector3(0, 1, 0) };
  },
  raycast: (origin, dir, maxDistance) => {
    if (dir.y > -0.5 || origin.y < 0) return null;     // only the floor exists
    const d = origin.y / -dir.y;
    if (d > maxDistance) return null;
    return {
      distance: d,
      point: new THREE.Vector3(origin.x + dir.x * d, 0, origin.z + dir.z * d),
      normal: new THREE.Vector3(0, 1, 0),
      collider: { userData: { surface: 'dirt.ground' } },
    };
  },
  containsPoint: () => false,
});

const stubPlayer = (x = 0, z = 0) => ({
  position: new THREE.Vector3(x, 0, z),
  isDead: false,
  health: CONFIG.player.maxHealth,
  maxHealth: CONFIG.player.maxHealth,
  applyDamage(a) { this.health -= a; return a; },
  applyImpulse() { return true; },
  applyViewKick() {},
  applyBleed() {},
});

/** The real `NPCManager` with only the renderer-bound parts left out. */
function makeManager(player) {
  const bus = { on: () => () => {}, emit: () => {} };
  const mgr = Object.create(NPCManager.prototype);
  Object.assign(mgr, {
    scene: new THREE.Scene(),
    engine: null,
    physics: flatWorld(),
    bus,
    materials: null,
    player,
    _npcs: [], _hostiles: [], _friendlies: [], _vendors: [], _respawnQueue: [],
    theme: 'citadel', worldId: 'citadel', maxNPCs: 72, water: null,
    _seedCounter: 1, _groundCursor: 0, _simStep: 0, _pauseUntil: 0,
    _coverToken: 0, _groundFixes: 0, _contact: null, _chatNPC: null,
  });
  mgr._spawnLorekeepers = () => 0;
  mgr._spawnQuestManagers = () => {};
  mgr._populateHubs = () => {};
  return mgr;
}

/**
 * Put one animal `gap` metres from a stationary player and run the real
 * `fixedUpdate` for `seconds`, recording everything the maul would have to pass
 * through. Identical for every species, which is what makes the wolf a valid
 * ablation on the camel.
 */
function encounter(species, { gap = 4, seconds = 30, count = 1, shootAt = -1 } = {}) {
  const player = stubPlayer(0, 0);
  const mgr = makeManager(player);
  let mauls = 0;
  mgr.beastMaul = () => { mauls++; };
  const beasts = mgr.spawnBeastGroup(
    { position: new THREE.Vector3(0, 0, gap), species, count }, 16);
  assert.ok(beasts.length > 0, `no ${species} spawned - the fixture proves nothing`);

  const states = new Set();
  const phases = new Set();
  let sawTarget = false;
  let minDist = Infinity;
  let maxDist = 0;
  let shot = false;
  const DT = 1 / 30;
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    if (shootAt >= 0 && !shot && i * DT >= shootAt) {
      shot = true;
      for (const b of beasts) b.applyDamage(20, false, player);
    }
    for (const b of beasts) {
      b.fixedUpdate(DT, i * DT);
      states.add(b.state);
      phases.add(b.attackPhase);
      if (b.target) sawTarget = true;
      const d = b.position.distanceTo(player.position);
      minDist = Math.min(minDist, d);
      maxDist = Math.max(maxDist, d);
    }
  }
  return { beasts, states, phases, mauls, sawTarget, minDist, maxDist, player, mgr };
}

test('THE GATE, exhausted: no distance exists at which a camel may begin an attack', () => {
  /* `BeastNPC._stalk` opens an attack on
   *
   *     wantsToCommit && dist <= def.reach + this.radius
   *
   * and `this.radius` IS `def.bodyRadius`. This is not a sample of that test,
   * it is the whole of it: `dist` is a distance, so it is non-negative, and the
   * right-hand side is negative. Walked in centimetres out to 40 m anyway,
   * because the arithmetic argument is only worth anything if the constants it
   * is made of are the ones actually in the table. */
  const def = BEASTS.camel;
  const threshold = def.reach + def.bodyRadius;
  assert.ok(threshold < 0,
    `a camel opens an attack inside ${threshold.toFixed(3)} m, which is a distance a player can `
    + 'stand at - the sentinel reach has been tuned away');
  for (let mm = 0; mm <= 4000; mm++) {
    const dist = mm / 100;
    assert.equal(dist <= threshold, false, `a camel would strike at ${dist} m`);
  }
  // The ablation. The same expression, the same loop, on the two animals that
  // are supposed to reach the player.
  for (const species of ['wolf', 'bear']) {
    const d = BEASTS[species];
    assert.ok(d.reach + d.bodyRadius > 1.5,
      `a ${species} can only strike inside ${(d.reach + d.bodyRadius).toFixed(2)} m, so this loop `
      + 'would report "cannot attack" for a predator too and proves nothing about the camel');
  }
});

test('THE CONE, exhausted: a camel cannot see a candidate from any bearing or range', () => {
  /* Lock 2. `fovDegrees` 0 makes `fovCos` exactly 1, and `scent` 0 removes the
   * near-field override that would otherwise let a bear notice something behind
   * it. Driven through the REAL `_canSee` on a real beast rather than
   * re-deriving the trigonometry here, because the thing under test is what
   * `BeastNPC` computes, not what this file thinks it computes. */
  const player = stubPlayer(0, 0);
  const mgr = makeManager(player);
  const [camel] = mgr.spawnBeastGroup(
    { position: new THREE.Vector3(0, 0, 0), species: 'camel', count: 1 }, 4);
  assert.equal(camel.fovCos, 1, 'the camel prey cone has been opened');

  let seen = 0;
  for (let a = 0; a < 64; a++) {
    camel.yaw = (a / 64) * Math.PI * 2;
    for (let d = 1; d <= 40; d++) {
      player.position.set(Math.sin(a) * d, 0, Math.cos(a * 1.7) * d);
      player.position.setLength(d);
      if (camel._canSee(player)) seen++;
    }
  }
  assert.equal(seen, 0, `a camel saw a candidate in ${seen} of 2560 bearing/range pairs`);

  // The ablation: a wolf in exactly the same sweep sees plenty, so a zero above
  // is a property of the camel and not of the fixture's geometry.
  const [wolf] = mgr.spawnBeastGroup(
    { position: new THREE.Vector3(0, 0, 0), species: 'wolf', count: 1 }, 4);
  wolf.position.set(0, 0, 0);
  let wolfSeen = 0;
  for (let a = 0; a < 64; a++) {
    wolf.yaw = (a / 64) * Math.PI * 2;
    for (let d = 1; d <= 40; d++) {
      player.position.set(Math.sin(a) * d, 0, Math.cos(a * 1.7) * d);
      player.position.setLength(d);
      if (wolf._canSee(player)) wolfSeen++;
    }
  }
  assert.ok(wolfSeen > 800,
    `a wolf only saw ${wolfSeen} of 2560 - the sweep is not putting anything in front of it, so `
    + 'the camel\'s zero is meaningless');
});

test('thirty seconds beside a camel: no stalk, no telegraph, no blow', () => {
  const camel = encounter('camel', { gap: 4, seconds: 30, count: 5 });
  assert.equal(camel.mauls, 0, `a camel herd landed ${camel.mauls} blows on a stationary player`);
  assert.ok(!camel.states.has('ATTACK'),
    'a camel entered ATTACK, which is the failure mode this whole species is designed around');
  assert.ok(!camel.states.has('STALK'), 'a camel entered STALK and held it');
  assert.deepEqual([...camel.phases], ['none'],
    `a camel reached attack phases ${[...camel.phases].join(', ')}`);
  assert.equal(camel.sawTarget, false, 'a camel took a target off its own senses');
  assert.ok(camel.states.has('ROAM'), 'the camels never ticked at all - the fixture is dead');

  /* THE ABLATION, and it is the only thing that makes the four assertions above
   * mean anything. Same fixture, same 900 steps, same player standing still,
   * with wolves instead. If a wolf cannot reach the player here then "the camel
   * never attacked" is a statement about the harness. */
  const wolf = encounter('wolf', { gap: 4, seconds: 30, count: 5 });
  assert.ok(wolf.mauls > 0,
    'the wolves did not land a blow either, so this fixture cannot detect an attack and the '
    + 'camel result above is worthless');
  assert.ok(wolf.states.has('ATTACK') && wolf.phases.has('strike'),
    `the wolves reached states ${[...wolf.states].join(', ')} - no attack sequence ran`);
});

test('a camel that is hit runs, and keeps running away rather than round', () => {
  /* `courage` 1.0: `onDamaged` compares `health < maxHealth * courage`, so any
   * non-fatal blow at all satisfies it. What the assertions below add to that
   * arithmetic is the ORDER inside `onDamaged` - `_acquire` may set STALK and
   * the courage check overwrites it in the same call - and the direction. */
  const player = stubPlayer(0, 0);
  const mgr = makeManager(player);
  mgr.beastMaul = () => { throw new Error('a camel mauled the player'); };
  const [camel] = mgr.spawnBeastGroup(
    { position: new THREE.Vector3(0, 0, 5), species: 'camel', count: 1 }, 4);

  const startState = camel.state;
  camel.applyDamage(20, false, player);
  assert.equal(camel.state, 'FLEE',
    `a shot camel went from ${startState} to ${camel.state} instead of running`);
  assert.equal(camel.attackPhase, 'none');

  const start = camel.position.distanceTo(player.position);
  let far = start;
  const seenStates = new Set();
  const DT = 1 / 30;
  for (let i = 0; i < 900; i++) {
    camel.fixedUpdate(DT, i * DT);
    seenStates.add(camel.state);
    assert.equal(camel.attackPhase, 'none', `step ${i}: the camel wound up an attack`);
    assert.notEqual(camel.state, 'ATTACK', `step ${i}: the camel entered ATTACK`);
    far = Math.max(far, camel.position.distanceTo(player.position));
  }
  assert.ok(far - start > 15,
    `a fleeing camel only gained ${(far - start).toFixed(1)} m on a stationary attacker in 30 s at `
    + `${(BEASTS.camel.chargeSpeed * 0.95).toFixed(2)} m/s - it is circling, not leaving`);
  assert.ok(seenStates.has('ROAM'),
    'the camel never came off FLEE, so it panics forever once it has been hit');

  // The bolt outruns a walk and does not outrun a sprint - the same bargain
  // every other row in the table strikes, read the other way round.
  assert.ok(BEASTS.camel.chargeSpeed > CONFIG.player.walkSpeed,
    'a walking player can keep pace with a bolting camel');
  assert.ok(BEASTS.camel.chargeSpeed < CONFIG.player.sprintSpeed,
    'a bolting camel cannot be caught, so the player can never reach one they want to');
});

test('being shot does not turn a herd on the player', () => {
  /* The path that would do it: `_acquire(source, share = true)` calls
   * `pack.share`, `share` stores the target, and `BeastNPC._roam` re-adopts
   * `pack.target` the moment any member is idle - so one camel taking a
   * crossbow bolt would walk the whole herd into STALK several seconds later,
   * long after the shot, which is the worst possible reading of the brief. */
  const player = stubPlayer(0, 0);
  const mgr = makeManager(player);
  mgr.beastMaul = () => { throw new Error('a camel mauled the player'); };
  const herd = mgr.spawnBeastGroup(
    { position: new THREE.Vector3(0, 0, 6), species: 'camel', count: 6 }, 16);
  assert.ok(herd.length >= 3, `the herd spawned ${herd.length}`);
  const pack = herd[0].pack;
  assert.ok(pack, 'a camel group above one was given no pack, so this proves nothing');

  herd[0].applyDamage(20, false, player);
  assert.equal(pack.target, null, 'the herd recorded a collective target');

  const DT = 1 / 30;
  for (let i = 0; i < 600; i++) {
    for (const c of herd) {
      c.fixedUpdate(DT, i * DT);
      assert.notEqual(c.state, 'ATTACK', `step ${i}: a camel entered ATTACK`);
      assert.equal(pack.target, null, `step ${i}: the herd adopted a collective target`);
    }
  }
  // Everyone except the one that was actually shot should still be grazing.
  const untouched = herd.slice(1).filter((c) => c.state === 'ROAM').length;
  assert.equal(untouched, herd.length - 1,
    `${herd.length - 1 - untouched} camels that were not shot reacted to the shot`);
});

/* ================================================================== */
/* 5. THE HERD                                                        */
/* ================================================================== */

/** A member, as far as a pack is concerned. */
const stubMember = (x = 0, z = 0) => ({
  position: { x, y: 0, z },
  isDead: false,
  adopted: null,
  adoptPackTarget(t) { this.adopted = t; return true; },
});

function group(species, n) {
  const pack = new BeastPack({ species, seed: 42 });
  const members = [];
  for (let i = 0; i < n; i++) {
    const m = stubMember(i * 2, 0);
    pack.add(m);
    members.push(m);
  }
  return { pack, members };
}

test('a herd refuses both pursuit mechanisms; a pack still runs on them', () => {
  const herd = group('camel', 5);
  const target = { isDead: false, position: { x: 0, y: 0, z: 0 } };

  assert.equal(herd.pack.isHerd, true);
  assert.equal(herd.pack.share(target, herd.members[0]), 0, 'word travelled through a herd');
  assert.equal(herd.pack.target, null, 'a herd stored a collective target');
  assert.equal(herd.members.filter((m) => m.adopted).length, 0);
  for (const m of herd.members) {
    assert.equal(herd.pack.requestAttack(m), false, 'a herd granted an attack slot');
  }
  assert.equal(herd.pack.attackSlots >= 1, true,
    'the slot COUNT is still whatever the base class says - the refusal is at the gate, not by '
    + 'starving the pool, so a future caller reading attackSlots is not silently misled');

  /* The ablation. Every assertion above is "returned nothing", which a broken
   * pack class satisfies for wolves too. */
  const pack = group('wolf', 5);
  assert.equal(pack.pack.isHerd, false);
  assert.equal(pack.pack.share(target, pack.members[0]), 4, 'the wolf pack stopped sharing aggro');
  assert.equal(pack.pack.target, target);
  assert.equal(pack.pack.requestAttack(pack.members[0]), true,
    'the wolf pack stopped handing out attack slots');
});

test('a herd bearing is stable and spread, and does NOT circle the way a ring does', () => {
  /* `slotAngle` is the hunting version: it rotates, and it ranks over the
   * LIVING so the circle closes over a corpse. Both are wrong for a herd - the
   * rotation is what makes a pack read as working you, and grazing animals do
   * not shuffle up when one of them is shot. */
  const { pack, members } = group('camel', 5);
  const before = members.map((m) => pack.herdBearing(m));
  assert.equal(new Set(before.map((a) => a.toFixed(6))).size, 5, 'two camels share a bearing');
  assert.ok(Math.max(...before) - Math.min(...before) > Math.PI,
    `five herd bearings only span ${(Math.max(...before) - Math.min(...before)).toFixed(2)} rad`);

  const spun = members.map((m) => pack.slotAngle(m));
  for (let i = 0; i < 40; i++) pack.update(1 / 30);
  assert.deepEqual(members.map((m) => pack.herdBearing(m)), before,
    'the herd bearings rotated - a herd is not a ring');
  assert.notDeepEqual(members.map((m) => pack.slotAngle(m)), spun,
    'the pack ring stopped turning, so "did not rotate" above is not a distinction');

  // A death does not close the herd up, and does not renumber the survivors.
  members[1].isDead = true;
  assert.deepEqual(members.map((m) => pack.herdBearing(m)), before,
    'the herd closed ranks over a dead member');

  // Usable before the bodies exist, which is when a spawner wants it.
  const laid = [0, 1, 2, 3].map((i) => pack.herdBearing(i, 4));
  assert.equal(new Set(laid).size, 4);
  assert.equal(pack.leader(), members[0]);
  members[0].isDead = true;
  assert.equal(pack.leader(), members[2], 'the herd is being led by a corpse');
});

test('a spawned herd shares one anchor and grazes inside one disc', () => {
  /* WHERE THE COHESION ACTUALLY COMES FROM, and it is not this class.
   * `BeastPack` steers nothing: every destination is chosen inside
   * `BeastNPC._roam` from `this.home`. `spawnBeastGroup` gives every member of
   * a group the SAME home, and `_roam` keeps each animal inside
   * `def.territory` of its own home - so a herd is a shared anchor plus a
   * shared radius, and the camel's 16 m territory is set as a grazing disc for
   * exactly that reason. This is the assertion on that claim. */
  const mgr = makeManager(stubPlayer(300, 300));
  const herd = mgr.spawnBeastGroup(
    { position: new THREE.Vector3(0, 0, 0), species: 'camel', count: 6 }, 16);
  assert.ok(herd.length >= 3);
  const homes = new Set(herd.map((c) => `${c.home.x},${c.home.z}`));
  assert.equal(homes.size, 1, 'the herd was given several anchors, so it is not one herd');

  const DT = 1 / 30;
  let worst = 0;
  for (let i = 0; i < 3600; i++) {                    // two minutes of grazing
    for (const c of herd) {
      c.fixedUpdate(DT, i * DT);
      worst = Math.max(worst, Math.hypot(c.position.x - c.home.x, c.position.z - c.home.z));
    }
  }
  /* The floor matters as much as the ceiling: a herd that never left its pin
   * would satisfy any ceiling and would read as six statues. */
  assert.ok(worst > 4,
    `over two minutes the furthest any camel strayed from the anchor was ${worst.toFixed(1)} m - `
    + 'the herd is not grazing, it is standing still');
  assert.ok(worst < BEASTS.camel.territory * 2.2,
    `a camel wandered ${worst.toFixed(1)} m from a ${BEASTS.camel.territory} m territory - the `
    + 'herd has dispersed');
});

/* ================================================================== */
/* 6. THE ROW ITSELF                                                  */
/* ================================================================== */

test('the camel row satisfies the invariants the whole species table is held to', () => {
  /* Quoted here with their margins, because these are the two that FORCED
   * `sight` and `territory` off the zero they would otherwise have been, and a
   * future editor who does not know that will set them to zero again. */
  const d = BEASTS.camel;
  const TRACK_SHARE = 0.55;
  const TRACK_MARGIN = 4;
  const clear = (d.territory + d.sight) * TRACK_SHARE + TRACK_MARGIN;
  assert.ok(clear > d.territory,
    `a camel clears a track by ${clear.toFixed(1)} m and roams ${d.territory} m, so no placement `
    + 'rule can keep it off one');
  assert.ok(d.territory > 10, 'the camel territory fell under the table-wide floor');
  assert.equal(isPredator(d), false);
  assert.equal(isPredator(BEASTS.wolf), true, 'the default flipped, and every predator with it');
  assert.equal(isPredator(BEASTS.bear), true);
  assert.equal(isPredator(undefined), true, 'an unknown species defaults to harmless');

  // The dimensions the brief asked for, as numbers rather than as adjectives.
  assert.ok(Math.abs(d.shoulderHeight - 2.2) < 0.001, 'the hump crest moved off 2.2 m');
  assert.ok(Math.abs(d.bodyLength - 3.0) < 0.001, 'the body length moved off 3 m');
  assert.ok(d.shoulderHeight > CONFIG.player.height * 1.2,
    'a camel no longer towers over the player');
});
