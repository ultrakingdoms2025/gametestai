import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installHeadlessDom, Physics, THREE } from './world-kit.mjs';

/**
 * IS THERE A FLOOR UNDER MY FEET? THE MERIDIAN LIDO, DROP-TESTED.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE REPORT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   "in sporting area near the pool i fall through the ground pos 37.4, 0, 98.9"
 *
 * That coordinate is not in the pool. The basin is x 32..60 by z 103..119 and
 * the water surface is at y -0.22; z = 98.9 is four metres NORTH of the deck,
 * on the lido's grass verge, between the clipped hedge that runs along z = 98
 * and the deck slab that starts at z = 100. Grass was drawn there. Nothing
 * held a body up.
 *
 * ── The mechanism, because the shape of the hole is the diagnosis ─────────
 * The site's ground is one heightfield on a 2.6 m grid spanning +/-260 m, with
 * `holeRects` left open where the ground genuinely has no floor: the swimming
 * basin (`POOL`) and the skate bowl (`PAD`). Two different rules decided which
 * cells were open:
 *
 *   `_heightMesh`          drops a drawn quad only when it lies ENTIRELY
 *                          inside a hole rect;
 *   `_addHeightCollision`  dropped a collision cell when its CENTRE fell
 *                          inside one.
 *
 * Same rects, same grid, different answers at every boundary. A cell straddling
 * the rect edge with its centre just inside was dropped whole, so the collision
 * opening SPILLED up to half a cell (1.3 m) out of the rect - past the slabs
 * laid to replace the ground inside it, under grass the mesh was still drawing.
 * Measured against a real build, that was three floorless strips:
 *
 *   x 26.0 .. 75.4 by z 98.8 .. 100.0   1.2 m x  49 m   the pool's north verge
 *   x 75.0 .. 75.4 by z 98.8 .. 124.8   0.4 m x  26 m   the pool's east verge
 *   x -124.8 .. -26.0 by z 75.0 .. 75.4 0.4 m x  98 m   the skate pad's south
 *
 * The first is the one that was walked into. The other two were found by this
 * file's grid and had never been reported.
 *
 * The fix is that `_addHeightCollision` now uses `_heightMesh`'s containment
 * rule, so the collider is open exactly where the lawn is open and nowhere
 * else. It is PRE-EXISTING, not a regression: it reproduces identically at
 * 7146d09, before the art passes, and `Physics.js` has not changed since.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THIS FILE MEASURES, AND WHY IT IS A DROP AND NOT A RAYCAST
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This repository's most expensive recorded lesson is that a gate measuring
 * something the game does not do is worse than no gate. A gate asserting that
 * `_addHeightCollision` was CALLED, or that a heightfield collider EXISTS over
 * the lido, would have been green through every day this defect shipped.
 *
 * So the probe is the thing the player is: a 0.35 m x 1.75 m capsule under
 * `CONFIG.player.gravity`, integrated at the fixed 60 Hz tick, resolved every
 * tick by `physics.resolveCapsule` - the same call `Player._move` makes and
 * the only thing in the engine that actually holds a body off the floor. Drop
 * it, let it settle, ask where it came to rest. A body that rests at 0.0 is
 * standing on the lawn. A body that rests at -7 fell through the world.
 *
 * `physics.raycast` is deliberately NOT the instrument, and not for taste:
 * a straight-down ray tests exactly one heightfield cell and misses on the
 * knife edge where a sample lands on a cell boundary exactly (x = 33.8 is
 * -260 + 113 * 2.6, and a downward ray there returns null on a floor that is
 * demonstrably there). A capsule cannot balance on a zero-width line - it
 * takes the closest point on every triangle in a neighbourhood - so it reports
 * what a player experiences rather than what a float rounds to.
 *
 * ── Both directions are asserted ──────────────────────────────────────────
 * "There is a floor everywhere" is trivially satisfiable by deleting the hole
 * rects and paving the pool. So the basin is measured too, and it must still
 * be 1.3 to 2.9 m below the deck. A green run means the apron holds a body AND
 * the pool is still a pool.
 *
 * ── Cost ─────────────────────────────────────────────────────────────────
 * One headless SportsWorld build (~2 s) shared by every test, and ~34,000
 * capsule drops (~5 s). The grid is 0.25 m, which is guaranteed to place at
 * least one sample strictly inside a 0.4 m strip - the narrowest of the three.
 */

installHeadlessDom();

const { SportsWorld } = await import('../../src/worlds/SportsWorld.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/* CRLF: this repo has had a source scrape pass in a worktree and fail in the
 * checkout for no other reason. Normalise before anchoring on anything. */
const source = (p) => readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

/* ------------------------------------------------------------------ */
/* The body                                                            */
/* ------------------------------------------------------------------ */

/** `CONFIG.player.radius`. */
const RADIUS = 0.35;
/** `CONFIG.player.height`. */
const HEIGHT = 1.75;
/** `CONFIG.player.gravity`. */
const GRAVITY = -22;
/** `Player.fixedUpdate`'s tick. */
const DT = 1 / 60;

/**
 * How far below the surface a rest counts as "fell through".
 *
 * The lido apron is levelled to y = 0 by `FLAT_ZONES` and the deck slabs sit
 * 0.1 m proud of it, so a body that is held anywhere on the apron rests in
 * [0.0, 0.1] - or higher, on a bench, the lifeguard chair or the dive tower.
 * -0.5 is half a metre of slack under the lowest legitimate rest, and the
 * defect it is looking for drops a body seven metres in the same number of
 * ticks. There is no interesting band between the two.
 */
const FLOOR_TOL = -0.5;

/* ------------------------------------------------------------------ */
/* The world                                                           */
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

const _p = new THREE.Vector3();

/**
 * Drop a player capsule at (x, z) and return the height its feet come to rest
 * at. Reproduces `Player.fixedUpdate`'s order - gravity applied, then the
 * position integrated, then `resolveCapsule` given the last word - because
 * that order is what decides whether a contact is seen at all on the tick a
 * body arrives at a surface.
 */
function drop(x, z, startY, ticks) {
  _p.set(x, startY, z);
  let vy = 0;
  for (let t = 0; t < ticks; t++) {
    vy += GRAVITY * DT;
    _p.y += vy * DT;
    const res = physics.resolveCapsule(_p, RADIUS, HEIGHT);
    if (res.grounded && vy < 0) vy = 0;
  }
  return _p.y;
}

/**
 * Drop a body on every 0.25 m lattice point of a rect and return the lowest
 * rest, with the point that produced it.
 *
 * `skip` excludes the pool basin from the apron sweep: a body dropped over
 * open water legitimately ends up on the basin floor three metres down, and
 * that surface gets its own test rather than a hole in this one.
 */
function sweep({ x0, z0, x1, z1, startY, ticks, skip = null }) {
  let worst = Infinity;
  let at = null;
  let n = 0;
  for (let z = z0; z <= z1 + 1e-9; z += 0.25) {
    for (let x = x0; x <= x1 + 1e-9; x += 0.25) {
      if (skip && skip(x, z)) continue;
      n++;
      const y = drop(x, z, startY, ticks);
      if (y < worst) { worst = y; at = [+x.toFixed(2), +z.toFixed(2)]; }
    }
  }
  return { worst, at, n };
}

/* ------------------------------------------------------------------ */
/* The report                                                          */
/* ------------------------------------------------------------------ */

test('the reported coordinate holds a body: near the pool at 37.4, 98.9', () => {
  const y = drop(37.4, 98.9, 1.6, 55);
  assert.ok(
    y > FLOOR_TOL,
    `a body dropped at the reported point (37.4, 98.9) came to rest at y=${y.toFixed(3)}, `
      + `below ${FLOOR_TOL}. This is the exact coordinate the fall-through was reported from: `
      + 'grass is drawn here and the collision floor is open under it.'
  );
  // And it is standing on the lawn, not perched on the hedge behind it.
  assert.ok(
    y < 0.6,
    `the body at (37.4, 98.9) rested at y=${y.toFixed(3)}, which is not the lido lawn (0.0) `
      + 'or its deck (0.1) - something is holding it up that should not be.'
  );
});

/* ------------------------------------------------------------------ */
/* The apron                                                           */
/* ------------------------------------------------------------------ */

test('the lido apron holds a body on every square metre outside the basin', () => {
  /* The whole pool complex plus a metre of verge on every side: the hedge runs
   * at z 98 and z 127 and the deck spans x 25..75 by z 100..125, so x 24..77 by
   * z 96..129 covers the enclosure, both hedge lines and the grass between them
   * and the slabs. The basin opening is excluded with a 0.5 m margin outside
   * its coping so the gate never has to argue about the lip. */
  const r = sweep({
    x0: 24, z0: 96, x1: 77, z1: 129,
    startY: 1.6, ticks: 55,
    skip: (x, z) => x > 31.5 && x < 60.5 && z > 102.5 && z < 119.5,
  });
  assert.ok(r.n > 20000, `the apron sweep only took ${r.n} samples - the grid stopped covering it`);
  assert.ok(
    r.worst > FLOOR_TOL,
    `${r.n} bodies dropped on the lido apron; the lowest came to rest at y=${r.worst.toFixed(3)} `
      + `at (${r.at?.[0]}, ${r.at?.[1]}), below ${FLOOR_TOL}. `
      + 'There is a floorless column under drawn ground somewhere in the pool enclosure.'
  );
});

test('the pool is still a pool - the basin is not paved over to satisfy the apron', () => {
  /* Deliberately inside the coping and clear of both diving boards: the 6.2 m
   * board reaches x 58.7 and the springboard x 57.9, and a body landing on
   * either is legitimately at +1.3. The floor slopes 1.2 m at the blocks to
   * 3.0 m under the boards, so every rest in here belongs in [-3.2, -1.0]. */
  let lo = Infinity;
  let hi = -Infinity;
  let n = 0;
  for (let z = 105; z <= 117.0001; z += 0.25) {
    for (let x = 34; x <= 56.0001; x += 0.25) {
      n++;
      const y = drop(x, z, 1.6, 90);
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
  }
  assert.ok(n > 4000, `the basin sweep only took ${n} samples`);
  assert.ok(
    hi < -1.0,
    `a body dropped inside the basin came to rest at y=${hi.toFixed(3)}. The basin is meant to be `
      + '1.2 m deep at the blocks and 3.0 m under the boards; something has floored it. '
      + 'A ground gate that can be satisfied by paving the pool is not a ground gate.'
  );
  assert.ok(
    lo > -3.2,
    `a body dropped inside the basin came to rest at y=${lo.toFixed(3)}, below the deepest point `
      + 'of the sloping floor (-3.0). It went through the basin.'
  );
});

/* ------------------------------------------------------------------ */
/* The second site the same rule opened                                */
/* ------------------------------------------------------------------ */

test("the skate pad's south verge holds a body", () => {
  /* `PAD` ends at z = 75 and the 2.6 m collision grid's last dropped cell ran
   * to z = 75.4, so this verge carried the same 0.4 m strip the pool's east
   * side did - 98 m of it, along the whole south edge of the concrete, and
   * nobody had walked into it. The drop starts at 6 m because the quarter pipe's
   * deck is at 3.1 and reaches z = 75. */
  const r = sweep({ x0: -126, z0: 74, x1: -24, z1: 77, startY: 6, ticks: 100 });
  assert.ok(r.n > 4000, `the pad verge sweep only took ${r.n} samples`);
  assert.ok(
    r.worst > FLOOR_TOL,
    `${r.n} bodies dropped along the skate pad's south verge; the lowest came to rest at `
      + `y=${r.worst.toFixed(3)} at (${r.at?.[0]}, ${r.at?.[1]}), below ${FLOOR_TOL}.`
  );
});

/* ------------------------------------------------------------------ */
/* The rule itself                                                     */
/* ------------------------------------------------------------------ */

/**
 * Read a hole rect straight out of the world rather than restating it.
 *
 * A rect copied into a test is a second source of truth that goes quietly
 * stale; every planning document in this repository has done exactly that. The
 * regex fails loudly if the declaration moves or changes shape.
 */
function rectFromSource(src, name) {
  const m = new RegExp(
    `const ${name} = \\{ x0: (-?[\\d.]+), z0: (-?[\\d.]+), x1: (-?[\\d.]+), z1: (-?[\\d.]+)`
  ).exec(src);
  assert.ok(m, `could not read the ${name} rect out of SportsWorld.js - the declaration moved`);
  return { x0: +m[1], z0: +m[2], x1: +m[3], z1: +m[4] };
}

test('a collision hole never spills outside the rect that authored it', () => {
  /* The grid-independent form of the defect, asserted on the collider the
   * build actually registered. Whatever resolution the field is baked at and
   * wherever its origin lands, an open cell must lie ENTIRELY within a rect
   * somebody asked to be open. The old centre rule could not satisfy this for
   * any rect whose edges were not exactly on a cell boundary - which is every
   * rect in this world. */
  const src = source('src/worlds/SportsWorld.js');
  const rects = [rectFromSource(src, 'POOL'), rectFromSource(src, 'PAD')];

  const fields = physics.heightfields.filter((h) => h.holes !== null);
  assert.equal(fields.length, 1, 'the site terrain is the one heightfield with holes punched in it');
  const hf = fields[0];

  const stride = hf.nx - 1;
  let open = 0;
  let spilled = 0;
  const examples = [];
  for (let j = 0; j < hf.nz - 1; j++) {
    const za = hf.originZ + j * hf.stepZ;
    const zb = za + hf.stepZ;
    for (let i = 0; i < stride; i++) {
      if (!hf.holes[j * stride + i]) continue;
      open++;
      const xa = hf.originX + i * hf.stepX;
      const xb = xa + hf.stepX;
      if (rects.some((r) => xa >= r.x0 && xb <= r.x1 && za >= r.z0 && zb <= r.z1)) continue;
      spilled++;
      if (examples.length < 6) {
        examples.push(`[${xa.toFixed(1)}..${xb.toFixed(1)} x ${za.toFixed(1)}..${zb.toFixed(1)}]`);
      }
    }
  }
  assert.ok(open > 100, `the terrain field only has ${open} open cells - the basin and bowl are sealed`);
  assert.equal(
    spilled,
    0,
    `${spilled} collision cells are open outside every authored hole rect, e.g. `
      + `${examples.join(' ')}. Each one is drawn ground with no floor under it.`
  );
});
