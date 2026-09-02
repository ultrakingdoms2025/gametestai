import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installHeadlessDom, Physics, THREE } from './world-kit.mjs';
import { surfaceStack } from '../../src/npc/Grounding.js';

/**
 * A STRAIGHT-DOWN RAY MUST FIND THE FLOOR THE CAPSULE IS STANDING ON.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DEFECT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `sports-pool-ground.test.mjs` records the observation in prose and then walks
 * around it: "a straight-down ray tests exactly one heightfield cell and misses
 * on the knife edge where a sample lands on a cell boundary exactly (x = 33.8
 * is -260 + 113 * 2.6, and a downward ray there returns null on a floor that is
 * demonstrably there)". That is why it drops capsules instead of casting rays.
 *
 * The observation was right and the estimate of its size was wrong. Measured on
 * the real lido build at 5781638, `physics.groundHeight` returned NULL over
 * solid, drawn, walkable terrain at 1086 of 2314 probed columns on the site
 * field and 117 of 744 on the skate pad. It is not a knife edge. It is roughly
 * half of every column whose coordinate lands on a terrain grid line.
 *
 * ── Mechanism ─────────────────────────────────────────────────────────────
 * `Collider._column` carries the full write-up. In one line: the ray named its
 * cell by `floor((x - originX) / stepX)` and then rebuilt that cell's corners by
 * `originX + i * stepX`, and those two doubles do not always agree. At x = 33.8
 * on the 2.6 m grid the division is exactly 113 but the multiply-add is
 * 33.800000000000011, so the query sat 14 femtometres OUTSIDE its own cell,
 * both triangles rejected on the barycentric edge test, and a vertical ray -
 * which touches exactly one cell - had nowhere to recover.
 *
 * ── Why "measure zero" was the wrong read, and it is worth saying ─────────
 * The failing x values are 33.8, -124.8, -166.4, -122.2: the numbers a person
 * types. A grid line RECOMPUTED as `originX + i * stepX` always hits, because
 * that is the corner arithmetic itself - so a sweep built that way reports the
 * field perfectly healthy. Round the same value to any number of decimals, or
 * type it, or read it from an authored table, and 64 of the field's 199 x lines
 * (and the identical 64 z lines) miss. Either axis alone is enough to kill the
 * cast. z = 98.9 - the z of the originally reported fall-through - is one of
 * them.
 *
 * ── The fix ──────────────────────────────────────────────────────────────
 * A vertical ray no longer runs Moller-Trumbore. For a vertical ray the
 * barycentric coordinates ARE the cell fractions, so the answer is the surface
 * height and `sampleHeight` already computes that from one consistent division.
 * The raycast asks it. That is a strict correction with no epsilon anywhere: it
 * cannot widen a footprint or fill a hole, because the hole mask and the edge
 * test it now runs ARE `sampleHeight`'s.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THIS FILE MEASURES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The consumer, not the arithmetic. `physics.groundHeight` is the call 117
 * sites make; `Grounding.surfaceStack` is the call every NPC's ground-follow
 * and the grounding watchdog make, and a watchdog that gets an empty stack
 * teleports the character to its spawn point. Both are asserted here on the
 * REAL lido field, at the real coordinates, alongside a synthetic field whose
 * hole and edges this file controls exactly.
 *
 * Both directions are asserted, because "always return a height" is trivially
 * satisfiable by inventing one. Over the authored pool basin and skate bowl a
 * downward ray must STILL return null, and the outer edge of the footprint must
 * still stop being ground. Inventing floors over the deep end would be the same
 * defect inverted, and worse: the report that started this was a fall-through.
 */

installHeadlessDom();

const { SportsWorld } = await import('../../src/worlds/SportsWorld.js');

const DOWN = new THREE.Vector3(0, -1, 0);
const _o = new THREE.Vector3();

/* ------------------------------------------------------------------ */
/* A field this file controls, for the cases that need exact geometry  */
/* ------------------------------------------------------------------ */

/**
 * The lido's grid - origin -260, step 2.6, 201x201 - with a hole rect punched
 * by `SportsWorld`'s own rule (a cell is open only when it lies ENTIRELY inside
 * the rect) and relief steep enough that a wrong cell would show up as a wrong
 * height rather than hiding in a flat plane.
 */
function syntheticField() {
  const nx = 201;
  const nz = 201;
  const originX = -260;
  const originZ = -260;
  const step = 2.6;
  const heights = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = originX + i * step;
      const z = originZ + j * step;
      heights[j * nx + i] = Math.sin(x * 0.031) * 6 + Math.cos(z * 0.027) * 4;
    }
  }
  const rect = { x0: 25, z0: 100, x1: 75, z1: 125 };
  const holes = new Uint8Array((nx - 1) * (nz - 1));
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const xa = originX + i * step;
      const za = originZ + j * step;
      if (xa >= rect.x0 && xa + step <= rect.x1 && za >= rect.z0 && za + step <= rect.z1) {
        holes[j * (nx - 1) + i] = 1;
      }
    }
  }
  const physics = new Physics();
  const field = physics.addHeightfield({
    heights, nx, nz, originX, originZ, stepX: step, stepZ: step, holes,
  });
  return { physics, field, rect, step, nx, nz, originX, originZ };
}

const SYN = syntheticField();

/** `groundHeight`'s exact ray, so a failure here is a failure the game has. */
const castDown = (physics, x, z) => physics.groundHeight(x, z, 400, 900);

/* ------------------------------------------------------------------ */
/* The real lido                                                       */
/* ------------------------------------------------------------------ */

const physics = new Physics();
{
  const world = new SportsWorld({
    physics,
    scene: new THREE.Scene(),
    bus: { on: () => () => {}, emit() {} },
    engine: {
      renderer: {
        capabilities: { getMaxAnisotropy: () => 4, isWebGL2: true },
        initTexture() {}, getContext: () => ({}),
        getRenderTarget: () => null, setRenderTarget() {}, render() {}, clear() {},
      },
      onFrameUpdate: () => () => {},
      onResize: () => () => {},
    },
    materials: { get: () => new THREE.MeshStandardMaterial(), dispose() {} },
  });
  world.physics = physics;
  const say = console.log;
  console.log = () => {};
  try {
    await world.build(() => {});
  } finally {
    console.log = say;
  }
}

/* ------------------------------------------------------------------ */
/* 1. The reported family: a ray on a cell boundary finds the floor     */
/* ------------------------------------------------------------------ */

test('a straight-down ray on a cell boundary hits ground the terrain says is there', () => {
  /* The single coordinate the pool file names in prose. -260 + 113 * 2.6 is
   * 33.800000000000011; the double you get by typing 33.8 is 33.799999999999997.
   * Two ULP apart, and that gap was the whole difference between a floor and
   * open sky. */
  assert.equal(
    (33.8 + 260) / 2.6, 113,
    'x = 33.8 is no longer a grid line of the lido field - re-derive this case'
  );
  assert.notEqual(
    -260 + 113 * 2.6, 33.8,
    'the corner arithmetic now agrees with the division at x = 33.8, so this '
      + 'coordinate can no longer reproduce the defect - find one that does'
  );

  const terrain = physics.terrainHeight(33.8, -40);
  assert.ok(terrain !== null, 'the lido terrain no longer covers (33.8, -40)');
  const y = castDown(physics, 33.8, -40);
  assert.ok(
    y !== null,
    'a downward ray at (33.8, -40) returned null over terrain the same collider '
      + `reports at y=${terrain}. This is the cell-boundary miss: the ray named its `
      + 'cell by division and rebuilt the cell by multiply-add, and the two disagreed.'
  );
  assert.equal(
    y, terrain,
    `the ray hit at y=${y} but the heightfield samples y=${terrain} in the same column. `
      + 'These are the same surface and the collider promises they cannot drift.'
  );
});

test('every terrain grid line on the lido answers a downward ray, on all three fields', () => {
  /* The generalisation, and the assertion that actually pins the defect: walk
   * the grid lines of every heightfield the site registered, at coordinates that
   * have been through a decimal - which is how a coordinate reaches this code
   * from an author, a save file or a `toFixed`. A column with terrain under it
   * must answer.
   *
   * Measured pre-fix: 1086 of 2314 on the site field and 117 of 744 on the pad.
   * A gate that swept `originX + i * stepX` instead would have found zero of
   * them, because that expression IS the corner arithmetic the ray agreed with. */
  assert.ok(physics.heightfields.length >= 3, 'the lido lost a heightfield');

  const failures = [];
  let probed = 0;
  for (const hf of physics.heightfields) {
    for (let i = 1; i < hf.nx - 1; i++) {
      const x = +(hf.originX + i * hf.stepX).toFixed(3);
      for (let j = 1; j < hf.nz - 1; j += 7) {
        const z = +(hf.originZ + j * hf.stepZ).toFixed(3);
        // Only columns this field actually surfaces: holes and rim are case 3.
        if (hf.sampleHeight(x, z) === null) continue;
        probed++;
        if (castDown(physics, x, z) === null && failures.length < 8) {
          failures.push(`(${x}, ${z})`);
        } else if (castDown(physics, x, z) === null) {
          failures.push(null);
        }
      }
    }
  }
  assert.ok(probed > 4000, `the grid-line sweep only probed ${probed} columns`);
  assert.equal(
    failures.length, 0,
    `${failures.length} of ${probed} terrain columns on a grid line returned no ground to a `
      + `downward ray, e.g. ${failures.filter(Boolean).join(' ')}. Drawn ground with no ray under it: `
      + 'every ground probe, spawn placement and NPC ground-follow in this world reads null there.'
  );
});

test('the fall-through report\'s own z line answers, four metres north of the deck', () => {
  /* z = 98.9 is the z the fall-through was reported at, and it is one of the 64
   * failing z lines - so at 5781638 the whole line x = -260..260 at z = 98.9
   * was invisible to a downward ray wherever x was also on a line. This is the
   * consumer-visible overlap between the two defects. */
  for (const x of [33.8, 36.4, 39, 41.6]) {
    const terrain = physics.terrainHeight(x, 98.9);
    if (terrain === null) continue;
    assert.ok(
      castDown(physics, x, 98.9) !== null,
      `a downward ray at (${x}, 98.9) - the reported fall-through line - returned null `
        + `over terrain at y=${terrain}.`
    );
  }
});

/* ------------------------------------------------------------------ */
/* 2. The over-fix guard: a hole is still a hole                       */
/* ------------------------------------------------------------------ */

test('a downward ray over an authored hole still returns null', () => {
  /* The direction that matters more than the fix. `_column` is what decides a
   * hole, and the vertical fast path now runs `_column` rather than a triangle
   * test - so if it ever stopped honouring the mask, or reached into a
   * neighbouring cell to rescue a boundary, this goes red. Every open cell in
   * the field is checked, at its centre and at all four of its corners, because
   * the corners are exactly where a one-cell reach would show. */
  const { physics: p, field, step, nx, nz, originX, originZ } = SYN;
  let open = 0;
  let phantom = 0;
  const examples = [];
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      if (!field.holes[j * (nx - 1) + i]) continue;
      open++;
      const xa = originX + i * step;
      const za = originZ + j * step;
      for (const [x, z] of [
        [xa + step * 0.5, za + step * 0.5],
        [+(xa).toFixed(3), +(za).toFixed(3)],
        [+(xa + step).toFixed(3), +(za).toFixed(3)],
        [+(xa).toFixed(3), +(za + step).toFixed(3)],
        [+(xa + step).toFixed(3), +(za + step).toFixed(3)],
      ]) {
        // A corner shared with a solid neighbour belongs to that neighbour under
        // the half-open convention; only ask about points this cell owns.
        if (field.sampleHeight(x, z) !== null) continue;
        if (castDown(p, x, z) !== null) {
          phantom++;
          if (examples.length < 6) examples.push(`(${x}, ${z})`);
        }
      }
    }
  }
  assert.ok(open > 100, `the synthetic field only has ${open} open cells - the hole did not punch`);
  assert.equal(
    phantom, 0,
    `${phantom} downward rays found ground inside an authored hole, e.g. ${examples.join(' ')}. `
      + 'The boundary fix has invented floor over the basin, which is the reported defect inverted.'
  );
});

test('the real pool basin and skate bowl are still open in the terrain collider', () => {
  /* The same guard on the shipped field, phrased the way a consumer sees it:
   * `terrainHeight` is null over the basin because the cells are open, and the
   * ray must agree that the TERRAIN is not there. (`groundHeight` legitimately
   * answers over the basin - the basin floor and the deck slabs are separate box
   * colliders - so the terrain field is asked directly.) */
  const hf = physics.heightfields.find((h) => h.holes !== null);
  assert.ok(hf, 'the site terrain no longer has holes punched in it');

  let open = 0;
  let phantom = 0;
  const stride = hf.nx - 1;
  for (let j = 0; j < hf.nz - 1; j++) {
    for (let i = 0; i < stride; i++) {
      if (!hf.holes[j * stride + i]) continue;
      open++;
      const x = hf.originX + (i + 0.5) * hf.stepX;
      const z = hf.originZ + (j + 0.5) * hf.stepZ;
      const hit = physics.raycast(_o.set(x, 400, z), DOWN, 900);
      if (hit && hit.collider === hf) phantom++;
    }
  }
  assert.ok(open > 100, `the site terrain only has ${open} open cells`);
  assert.equal(
    phantom, 0,
    `${phantom} downward rays hit the TERRAIN collider inside the pool basin or skate bowl. `
      + 'Those cells are authored open; sealing them puts grass over the deep end.'
  );
});

/* ------------------------------------------------------------------ */
/* 3. The outer edge of the footprint                                  */
/* ------------------------------------------------------------------ */

test('the footprint edge is ground and one step past it is not', () => {
  const { physics: p, field, step, nx, originX, originZ } = SYN;
  const maxX = originX + (nx - 1) * step;

  // The last sample line is inside the field, on the boundary, and must answer.
  for (const z of [0, +(originZ + 40 * step).toFixed(3), 137.5]) {
    assert.ok(
      castDown(p, maxX, z) !== null,
      `a downward ray on the field's own +x edge (x=${maxX}, z=${z}) found no ground, `
        + 'but the footprint includes its boundary.'
    );
    assert.ok(
      castDown(p, originX, z) !== null,
      `a downward ray on the field's own -x edge (x=${originX}, z=${z}) found no ground.`
    );
  }

  /* And it stops there. The vertical fast path defers the footprint test to
   * `sampleHeight`, so a widened edge would be a widened `containsColumn` for
   * the capsule solver too - `PlanetWorld` registers a terrain field inside a
   * wider floor field and its own comment warns that the shore/void boundary
   * lives exactly here. */
  for (const d of [1e-6, 1e-3, 0.5, 5]) {
    assert.equal(
      castDown(p, maxX + d, 0), null,
      `a downward ray ${d} m outside the field's +x edge found ground. The footprint has grown.`
    );
    assert.equal(
      castDown(p, originX - d, 0), null,
      `a downward ray ${d} m outside the field's -x edge found ground. The footprint has grown.`
    );
  }
  assert.equal(field.sampleHeight(maxX + 1e-6, 0), null, 'sampleHeight disagrees about the edge');
});

/* ------------------------------------------------------------------ */
/* 4. No discontinuity was introduced at the seam                      */
/* ------------------------------------------------------------------ */

test('the height at a cell boundary agrees with the height either side of it', () => {
  /* The fix could have been "hit, but with the NEIGHBOURING cell's answer",
   * which passes every test above and puts a step in the lawn. This is the test
   * that would catch it.
   *
   * Not the mean of the two neighbours: a grid line is a crease, the triangles
   * either side have different slopes, and the mean is off by half the slope
   * change times the probe distance - 7.5e-6 m on this relief, which is real
   * geometry and not a defect. The surface is CONTINUOUS across the crease
   * though, so the one-sided limits are the thing to ask for: extrapolate
   * linearly from two points on the left, and again from two on the right, and
   * both must land on the boundary's own answer.
   *
   * Measured discrimination, which is why this shape was chosen: the residual
   * is 1.6e-14 m, and a one-cell error on this field moves the answer by up to
   * 0.483 m. Thirteen orders of margin. */
  const { physics: p, step, nx, nz, originX, originZ } = SYN;
  const EPS = 1e-3;
  let worst = 0;
  let worstAt = null;
  let n = 0;
  for (let i = 5; i < nx - 5; i += 1) {
    const x = +(originX + i * step).toFixed(3);
    for (let j = 5; j < nz - 5; j += 3) {
      const z = +(originZ + j * step).toFixed(3);
      const on = castDown(p, x, z);
      const l1 = castDown(p, x - EPS, z);
      const l2 = castDown(p, x - 2 * EPS, z);
      const r1 = castDown(p, x + EPS, z);
      const r2 = castDown(p, x + 2 * EPS, z);
      if (on === null || l1 === null || l2 === null || r1 === null || r2 === null) continue;
      n++;
      const err = Math.max(Math.abs(on - (2 * l1 - l2)), Math.abs(on - (2 * r1 - r2)));
      if (err > worst) { worst = err; worstAt = [x, z]; }
    }
  }
  assert.ok(
    n > 8000,
    `the seam sweep only compared ${n} boundaries - a shortfall here means columns on the grid `
      + 'lines returned no ground at all, which is the boundary miss itself.'
  );
  assert.ok(
    worst < 1e-9,
    `the ray height on a cell boundary is ${worst.toExponential(3)} m off the surface approaching `
      + `it from one side, at (${worstAt}). The boundary is being answered by a different cell than `
      + 'the ground either side of it - a step has been put in the lawn.'
  );
});

test('a boundary column reports the same height as terrainHeight, everywhere', () => {
  /* The invariant the collider's constructor already claims - "the height
   * reported by `sampleHeight` is exactly the height of the triangle a ray or a
   * capsule will hit". Before the fix that was nearly true off the boundaries
   * and false on them; a downward ray disagreed with `terrainHeight` by ~6e-14 m
   * even where it hit. Now it is exact, which is what lets a prop placed by
   * `terrainHeight` and a body held up by the ray sit on the same surface. */
  const { physics: p, field, step, nx, nz, originX, originZ } = SYN;
  let n = 0;
  let off = 0;
  const examples = [];
  for (let i = 1; i < nx - 1; i += 2) {
    for (let j = 1; j < nz - 1; j += 7) {
      for (const [x, z] of [
        [+(originX + i * step).toFixed(3), +(originZ + j * step).toFixed(3)],
        [originX + (i + 0.5) * step, originZ + (j + 0.5) * step],
        [originX + (i + 0.37) * step, originZ + (j + 0.61) * step],
      ]) {
        const s = field.sampleHeight(x, z);
        if (s === null) continue;
        n++;
        const y = castDown(p, x, z);
        if (!Object.is(y, s)) {
          off++;
          if (examples.length < 5) examples.push(`(${x}, ${z}) ray=${y} sample=${s}`);
        }
      }
    }
  }
  assert.ok(n > 8000, `the agreement sweep only compared ${n} columns`);
  assert.equal(
    off, 0,
    `${off} of ${n} columns where a downward ray and \`sampleHeight\` disagree, e.g. `
      + `${examples.join('; ')}. The ray and the capsule solver are reading different ground.`
  );
});

/* ------------------------------------------------------------------ */
/* 5. What the NPC path actually gets                                  */
/* ------------------------------------------------------------------ */

test('surfaceStack finds a walkable surface on a boundary column', () => {
  /* The loudest consumer. `NPC.auditGrounding` asks `auditStanding`, which asks
   * `resolveSurfaceY`, which asks `surfaceStack` - and an empty stack is
   * `{ ok: false, surfaceY: null }`, which teleports the character to its spawn
   * point. The watchdog audits one NPC per step, so a character standing on one
   * of these columns is snatched away within about half a second. */
  const columns = [];
  const hf = physics.heightfields[0];
  for (let i = 1; i < hf.nx - 1 && columns.length < 400; i += 3) {
    const x = +(hf.originX + i * hf.stepX).toFixed(3);
    for (let j = 1; j < hf.nz - 1 && columns.length < 400; j += 29) {
      const z = +(hf.originZ + j * hf.stepZ).toFixed(3);
      if (hf.sampleHeight(x, z) !== null) columns.push([x, z]);
    }
  }
  assert.ok(columns.length > 200, `only found ${columns.length} boundary columns to walk`);

  const empty = [];
  const unwalkable = [];
  for (const [x, z] of columns) {
    const stack = surfaceStack(physics, x, z);
    if (stack.length === 0) { if (empty.length < 6) empty.push(`(${x}, ${z})`); continue; }
    if (!stack.some((s) => s.walkable) && unwalkable.length < 6) unwalkable.push(`(${x}, ${z})`);
  }
  assert.equal(
    empty.length, 0,
    `surfaceStack returned an EMPTY stack on ${empty.length} lido columns that have terrain under `
      + `them, e.g. ${empty.join(' ')}. auditStanding reports drop=Infinity there and the grounding `
      + 'watchdog teleports the character to its spawn point.'
  );
  assert.equal(
    unwalkable.length, 0,
    `surfaceStack found only unwalkable surfaces on ${unwalkable.length} lido columns, e.g. `
      + `${unwalkable.join(' ')}. The hit normal on a boundary is naming a cliff on flat lawn.`
  );
});

test('groundHeightOrFallback answers directly on a boundary, without the ring probe', () => {
  /* The ring probe was masking this: `groundHeightOrFallback` returns a
   * NEIGHBOUR'S height from up to 5 m away when the direct cast fails, which is
   * a confident number about the wrong column. On a lawn nobody notices; on a
   * rampart or a shoreline it is metres. The fallback should never be reached on
   * ground that is there. */
  let ringed = 0;
  const examples = [];
  const hf = physics.heightfields[0];
  for (let i = 1; i < hf.nx - 1; i += 5) {
    const x = +(hf.originX + i * hf.stepX).toFixed(3);
    for (let j = 1; j < hf.nz - 1; j += 37) {
      const z = +(hf.originZ + j * hf.stepZ).toFixed(3);
      if (hf.sampleHeight(x, z) === null) continue;
      if (physics.groundHeight(x, z, 400, 900) === null) {
        ringed++;
        if (examples.length < 6) examples.push(`(${x}, ${z})`);
      }
    }
  }
  assert.equal(
    ringed, 0,
    `${ringed} lido columns fall through to groundHeightOrFallback's ring probe, e.g. `
      + `${examples.join(' ')}. Each answers with a surface up to 5 m away.`
  );
});

/* ------------------------------------------------------------------ */
/* 6. The rest of the ray contract, unchanged                          */
/* ------------------------------------------------------------------ */

test('the vertical fast path keeps the ray contract it replaced', () => {
  const { physics: p, field } = SYN;
  const x = 33.8;
  const z = -40.13;
  const surf = field.sampleHeight(x, z);
  assert.ok(surf !== null);

  // Back faces count: recovery walks the terrain from underneath.
  const up = p.raycast(_o.set(x, surf - 5, z), new THREE.Vector3(0, 1, 0), 900);
  assert.ok(up, 'an upward ray from 5 m under the surface found no terrain above it');
  assert.equal(up.point.y, surf, 'the upward hit is not on the sampled surface');

  // A downward ray from below must not hit the surface behind it.
  assert.equal(
    p.raycast(_o.set(x, surf - 5, z), DOWN, 900), null,
    'a downward ray started under the terrain hit the surface above it'
  );

  // Self-hit guard: a body standing on the floor does not hit the floor it is on.
  assert.equal(
    p.raycast(_o.set(x, surf, z), DOWN, 900), null,
    'a downward ray started exactly on the surface hit it - the 1e-5 self-hit guard is gone'
  );

  // maxDistance is respected.
  assert.equal(
    p.raycast(_o.set(x, surf + 10, z), DOWN, 5), null,
    'a downward ray hit ground 10 m below it on a 5 m cast'
  );
  assert.ok(
    p.raycast(_o.set(x, surf + 10, z), DOWN, 20),
    'a downward ray missed ground 10 m below it on a 20 m cast'
  );

  // The normal points back at the ray and is a unit vector.
  const hit = p.raycast(_o.set(x, 400, z), DOWN, 900);
  assert.ok(hit.normal.dot(DOWN) < 0, 'the hit normal faces along the ray');
  assert.ok(Math.abs(hit.normal.length() - 1) < 1e-9, 'the hit normal is not normalised');
  assert.equal(hit.collider, field, 'the hit names a different collider');
  assert.ok(Math.abs(hit.distance - (400 - surf)) < 1e-9, 'distance disagrees with the hit point');
});

test('a marching ray still crosses the field and agrees with the vertical one', () => {
  /* The DDA was deliberately left alone: it meets the same one-ULP disagreement
   * at its entry cell, but it steps into the neighbour within femtometres of
   * travel, so the miss is a sliver of one triangle rather than the answer. This
   * pins that it still works and still agrees with the fast path, so the two
   * paths cannot drift into reporting different ground. */
  const { physics: p, field } = SYN;
  const dir = new THREE.Vector3(0.35, -1, 0.2).normalize();
  let n = 0;
  let worst = 0;
  for (let k = 0; k < 400; k++) {
    const x = -180 + k * 0.77;
    const z = -140 + k * 0.31;
    const hit = p.raycast(_o.set(x, 300, z), dir, 900);
    if (!hit) continue;
    const s = field.sampleHeight(hit.point.x, hit.point.z);
    if (s === null) continue;
    n++;
    worst = Math.max(worst, Math.abs(hit.point.y - s));
  }
  assert.ok(n > 200, `only ${n} marching rays landed on the field`);
  assert.ok(
    worst < 1e-6,
    `a marching ray landed ${worst.toExponential(3)} m off the surface the heightfield samples `
      + 'at the same point. The DDA and the vertical path disagree about the ground.'
  );
});
