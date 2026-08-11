import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAZE, generateTopology, cellIndex, isOpen, DIR,
} from '../../src/worlds/maze/MazeTopology.js';
import { districtColliders, cellToWorld } from '../../src/worlds/maze/MazeColliders.js';
import {
  shaftColliders, landingColliders, isRegionEnclosureSound,
} from '../../src/worlds/maze/MazeShafts.js';

/* Phase 5's art pass touched exactly one thing on the COLLIDER side of the
 * wall: `dropHedgesInsideShafts`, which deletes a hedge whose box a shaft wall
 * already swallows whole. The motive was visual - two coplanar surfaces stripe
 * when you look up a tower - but the change is a collider change, and the
 * phase's own constraint is that art must not move a collider. "Must not move"
 * is not "must not touch": deleting a box that is entirely inside another box
 * leaves the solid space identical, and that is the property this file holds
 * the drop to, rather than holding it to the descriptor list it happens to
 * produce today.
 *
 * The drop is private to MazeColliders.js and is exercised the only way a
 * caller can reach it, through `districtColliders`. */

const SEEDS = Number(process.env.MAZE_SEEDS ?? 3);
/** Districts per axis scanned per seed. Enough to turn up several shafts. */
const SPAN = 5;

const HALF_CELL = MAZE.CELL / 2;
const HT = MAZE.HEDGE_THICK / 2;
const HH = MAZE.HEDGE_HEIGHT / 2;

/** Position-and-extent identity, so a descriptor can be looked up by shape. */
const key = (d) => [d.cx, d.cy, d.cz, d.hx, d.hy, d.hz].map((n) => n.toFixed(4)).join(',');

/**
 * The hedges a district would emit if nothing were ever dropped.
 *
 * Re-derived from the topology rather than captured from a golden file,
 * because the rule is stated in `districtColliders`'s own docstring - a hedge
 * on a cell's north and west faces, plus south and east only on the GLOBAL
 * grid's far edge - and a rule short enough to state is short enough to
 * re-apply. Without this there is no way to see what the drop removed: the
 * function returns the survivors, and a test that only looks at survivors can
 * prove the drop dropped nothing it should not have kept, but not that it
 * kept everything it should not have dropped.
 */
function expectedHedges(cells, dx, dz, level) {
  const D = MAZE.DISTRICT;
  const baseY = level * MAZE.LEVEL_HEIGHT;
  const out = [];
  const push = (cx, cz, axis) => out.push({
    cx, cy: baseY + HH, cz,
    hx: axis === 'x' ? HT : HALF_CELL,
    hy: HH,
    hz: axis === 'x' ? HALF_CELL : HT,
    kind: 'hedge',
  });
  for (let lz = 0; lz < D; lz++) {
    for (let lx = 0; lx < D; lx++) {
      const x = dx * D + lx, z = dz * D + lz;
      const idx = cellIndex(x, z, level);
      const w = cellToWorld(x, z, level);
      if (!isOpen(cells, idx, DIR.N)) push(w.x, w.z - HALF_CELL, 'z');
      if (!isOpen(cells, idx, DIR.W)) push(w.x - HALF_CELL, w.z, 'x');
      if (z === MAZE.CELLS - 1 && !isOpen(cells, idx, DIR.S)) push(w.x, w.z + HALF_CELL, 'z');
      if (x === MAZE.CELLS - 1 && !isOpen(cells, idx, DIR.E)) push(w.x + HALF_CELL, w.z, 'x');
    }
  }
  return out;
}

/** Every cell in a district carrying an UP link - i.e. every shaft. */
function shaftCells(cells, dx, dz, level) {
  const D = MAZE.DISTRICT;
  const out = [];
  for (let lz = 0; lz < D; lz++) {
    for (let lx = 0; lx < D; lx++) {
      const x = dx * D + lx, z = dz * D + lz;
      if (isOpen(cells, cellIndex(x, z, level), DIR.UP)) out.push({ x, z, lx, lz });
    }
  }
  return out;
}

/**
 * Every shaft wall standing anywhere near a district, its own and its
 * neighbours'.
 *
 * The drop is a district-local pass, but the pairs it exists to remove are
 * not: a hedge on a district's west border duplicates the EAST wall of a shaft
 * in the district to the west (see the seam test below). So both "was this
 * hedge swallowed?" and "is this space still solid?" have to be asked of the
 * world rather than of one district's list, or the gate quietly agrees with
 * whatever the implementation happens to see.
 *
 * `REACH` is 2 cells and not 1 because a tunnel folds across two cells, so its
 * outer wall can stand two cells from the cell carrying the UP link -
 * `MazeColliders`'s own `SHAFT_WALL_REACH` for the same reason. Built from
 * `shaftColliders`, the same public builder the district uses, so this is a
 * second READING of where shaft walls are and not a second definition.
 */
const REACH = 2;
function wallsAround(cells, dx, dz, level) {
  const D = MAZE.DISTRICT;
  const x0 = dx * D, z0 = dz * D;
  const out = [];
  for (let z = z0 - REACH; z < z0 + D + REACH; z++) {
    if (z < 0 || z >= MAZE.CELLS) continue;
    for (let x = x0 - REACH; x < x0 + D + REACH; x++) {
      if (x < 0 || x >= MAZE.CELLS) continue;
      for (const d of shaftColliders(cells, x, z, level)) {
        if (d.kind === 'shaftWall') out.push(d);
      }
    }
  }
  return out;
}

/** `a`'s box entirely within `b`'s, the containment the drop turns on. */
const inside = (a, b) => (
  a.cx - a.hx >= b.cx - b.hx - 1e-6 && a.cx + a.hx <= b.cx + b.hx + 1e-6
  && a.cy - a.hy >= b.cy - b.hy - 1e-6 && a.cy + a.hy <= b.cy + b.hy + 1e-6
  && a.cz - a.hz >= b.cz - b.hz - 1e-6 && a.cz + a.hz <= b.cz + b.hz + 1e-6
);

test('THE DROP IS A DELETION, NOT A CHANGE: only hedges a shaft wall swallows whole go', () => {
  /* Both directions at once, which is the only way this says anything:
   *  - nothing that survived is contained (or the drop is not doing its job);
   *  - nothing that vanished was uncontained (or the art pass moved a wall).
   * A one-directional version of this passes trivially on a function that
   * drops everything, or on one that drops nothing. */
  let dropped = 0, kept = 0, districts = 0;
  for (let seed = 0; seed < SEEDS; seed++) {
    const t = generateTopology(seed);
    for (let dz = 0; dz < SPAN; dz++) {
      for (let dx = 0; dx < SPAN; dx++) {
        const descs = districtColliders(t.cells, dx, dz, 0);
        /* The district's own walls AND its neighbours' - a hedge here can be
         * swallowed by a shaft one district over, and the drop is required to
         * see that. Asking only about `descs` would let a correct drop look
         * like a deletion of collision. */
        const walls = wallsAround(t.cells, dx, dz, 0);
        if (walls.length === 0) continue;
        districts++;
        const survivors = new Map(descs.filter((d) => d.kind === 'hedge').map((d) => [key(d), d]));

        for (const h of expectedHedges(t.cells, dx, dz, 0)) {
          const survived = survivors.has(key(h));
          const swallowed = walls.some((w) => inside(h, w));
          assert.equal(survived, !swallowed, survived
            ? `seed ${seed} district (${dx},${dz}): a hedge at ${key(h)} sits entirely inside a shaft `
              + 'wall and was kept - two coplanar surfaces and a duplicate collider'
            : `seed ${seed} district (${dx},${dz}): a hedge at ${key(h)} was dropped without any shaft `
              + 'wall containing it - the art pass has deleted collision the player relies on');
          if (survived) kept++; else dropped++;
        }
      }
    }
  }
  assert.ok(districts > 0, 'no district with a shaft was found - this gate never looked at a drop');
  assert.ok(dropped > 0,
    'not one hedge was dropped across the whole scan, so the "survived === !swallowed" equality above '
    + 'was only ever asserting the trivial half of itself');
  // eslint-disable-next-line no-console
  console.log(`[shaft hedges] ${districts} districts with shafts, ${dropped} hedges dropped, ${kept} kept`);
});

test('a hedge that only MEETS a shaft wall survives - touching is not containment', () => {
  /* The north and west sides of a shaft are the ones the shaft cell owns, and
   * there `shaftWalls` starts its panel at HEDGE_HEIGHT and stacks on top of
   * the ordinary hedge instead of duplicating it (MazeShafts.js, fix round 2
   * Finding 4). Hedge top and wall bottom are the same plane to the last bit,
   * which is exactly the case a containment test written with `<=` on the
   * wrong side, or with an overlap test instead of a containment test, gets
   * wrong - and getting it wrong deletes the lower five metres of a wall the
   * corridor outside is relying on. */
  let checked = 0;
  for (let seed = 0; seed < SEEDS; seed++) {
    const t = generateTopology(seed);
    for (let dz = 0; dz < SPAN; dz++) {
      for (let dx = 0; dx < SPAN; dx++) {
        const cells = shaftCells(t.cells, dx, dz, 0);
        if (!cells.length) continue;
        const descs = districtColliders(t.cells, dx, dz, 0);
        const hedges = descs.filter((d) => d.kind === 'hedge');
        const walls = descs.filter((d) => d.kind === 'shaftWall');
        for (const c of cells) {
          const w = cellToWorld(c.x, c.z, 0);
          const idx = cellIndex(c.x, c.z, 0);
          for (const side of [{ dir: DIR.N, dx: 0, dz: -1 }, { dir: DIR.W, dx: -1, dz: 0 }]) {
            if (isOpen(t.cells, idx, side.dir)) continue;   // an open side has no hedge to keep
            const cx = w.x + side.dx * HALF_CELL, cz = w.z + side.dz * HALF_CELL;
            const at = (list) => list.filter((d) => Math.abs(d.cx - cx) < 1e-6 && Math.abs(d.cz - cz) < 1e-6);
            const wall = at(walls)[0];
            if (!wall) continue;
            // The fixture's own premise: these two really do meet, so this is
            // the touching case and not some third arrangement.
            if (Math.abs((wall.cy - wall.hy) - (w.y + MAZE.HEDGE_HEIGHT)) > 1e-6) continue;
            assert.equal(at(hedges).length, 1,
              `seed ${seed}: the hedge under the shaft wall at ${c.x},${c.z} (${side.dx},${side.dz}) was `
              + 'dropped, but the wall above only touches its top face - it does not contain it');
            checked++;
          }
        }
      }
    }
  }
  assert.ok(checked > 0,
    'no shaft with a closed north or west side turned up, so the touching case was never tested');
});

test('a hedge a full-height shaft wall swallows really is gone, district seam or not', () => {
  /* The mirror image of the test above, and the reason the drop exists. On a
   * shaft's east and south sides the wall runs from the floor, and the hedge
   * standing there - emitted by the NEIGHBOURING cell, whose west/north face
   * it is - occupies the wall's own lower five metres exactly.
   *
   * The neighbour is in a DIFFERENT DISTRICT when the shaft sits at
   * `lx === DISTRICT - 1` or `lz === DISTRICT - 1`, and that case is the whole
   * point of this test rather than an exemption from it. An earlier version
   * skipped it, which is how a real defect hid behind a green suite: the drop
   * was a pass over one district's own finished list, so those hedges were
   * emitted into the NEXT district's list where no shaft wall stood beside
   * them, and both artifacts the drop exists to remove - the z-fighting stripe
   * and the duplicate collider - survived. Verified on seed 7 at cell (99,15):
   * district (4,0) emitted the wall at x=597, z=90 spanning y 0-9 m and
   * district (5,0) emitted a hedge with the identical footprint spanning
   * y 0-5 m.
   *
   * So the hedge is looked for in whichever district OWNS it, which is the
   * district the neighbouring cell falls in - `districtAtWorld`-style
   * arithmetic on the neighbour's own cell coordinates, not on the shaft's. */
  const D = MAZE.DISTRICT;
  let checked = 0, seams = 0;
  for (let seed = 0; seed < SEEDS; seed++) {
    const t = generateTopology(seed);
    /* One district's colliders are wanted many times over (every shaft on a
     * seam asks for its neighbour's), and building a district is not free. */
    const cache = new Map();
    const district = (ddx, ddz) => {
      const k = `${ddx},${ddz}`;
      if (!cache.has(k)) cache.set(k, districtColliders(t.cells, ddx, ddz, 0));
      return cache.get(k);
    };
    for (let dz = 0; dz < SPAN; dz++) {
      for (let dx = 0; dx < SPAN; dx++) {
        const cells = shaftCells(t.cells, dx, dz, 0);
        if (!cells.length) continue;
        for (const c of cells) {
          const w = cellToWorld(c.x, c.z, 0);
          const idx = cellIndex(c.x, c.z, 0);
          const sides = [
            { dir: DIR.E, dx: 1, dz: 0 },
            { dir: DIR.S, dx: 0, dz: 1 },
          ];
          for (const side of sides) {
            if (isOpen(t.cells, idx, side.dir)) continue;
            const nx = c.x + side.dx, nz = c.z + side.dz;
            if (nx >= MAZE.CELLS || nz >= MAZE.CELLS) continue;   // no neighbour to own it
            const owner = { dx: Math.floor(nx / D), dz: Math.floor(nz / D) };
            const seam = owner.dx !== dx || owner.dz !== dz;
            const cx = w.x + side.dx * HALF_CELL, cz = w.z + side.dz * HALF_CELL;
            const hedges = district(owner.dx, owner.dz).filter((d) => d.kind === 'hedge');
            const still = hedges.filter((d) => Math.abs(d.cx - cx) < 1e-6 && Math.abs(d.cz - cz) < 1e-6);
            assert.equal(still.length, 0,
              `seed ${seed}: the hedge inside the shaft wall at ${c.x},${c.z} survived in district `
              + `(${owner.dx},${owner.dz})${seam ? ' across the seam' : ''} - it is the duplicate `
              + 'collider and the z-fighting stripe this drop exists to remove');
            checked++;
            if (seam) seams++;
          }
        }
      }
    }
  }
  assert.ok(checked > 0, 'no shaft with a closed east or south side was found');
  assert.ok(seams > 0,
    'no shaft on a district\'s east or south edge turned up, so the cross-seam half of this test - '
    + 'the half that was failing - never ran');
  // eslint-disable-next-line no-console
  console.log(`[shaft hedges] ${checked} swallowed E/S hedges checked, ${seams} of them across a district seam`);
});

test('the drop takes nothing but hedges: every shaft, tread and guard rail is still there', () => {
  /* A filter that ran on the wrong `kind` - or on none - would take a shaft
   * wall, a tread or a lift car out with the hedges, and every one of those is
   * either the enclosure itself or the way up through it. Checked by asking
   * the builders what they emitted and demanding all of it back, rather than
   * by counting kinds, so a swap of one descriptor for another cannot pass.
   *
   * Levels above 0 are included on purpose: that is where `landingColliders`
   * puts its guard rails, and those are `hedge`-KINDED - a hedge sitting in
   * open air beside a stair well, the one hedge in the world that a careless
   * widening of this drop would be most likely to eat. */
  let checkedDescs = 0, rails = 0;
  for (let seed = 0; seed < SEEDS; seed++) {
    const t = generateTopology(seed);
    for (let level = 0; level < MAZE.LEVELS; level++) {
      for (let dz = 0; dz < SPAN; dz++) {
        for (let dx = 0; dx < SPAN; dx++) {
          const descs = districtColliders(t.cells, dx, dz, level);
          const present = new Set(descs.map((d) => `${d.kind}|${key(d)}`));
          const want = [];
          for (const c of shaftCells(t.cells, dx, dz, level)) {
            want.push(...shaftColliders(t.cells, c.x, c.z, level));
          }
          if (level > 0) {
            for (const c of shaftCells(t.cells, dx, dz, level - 1)) {
              const below = landingColliders(t.cells, c.x, c.z, level - 1);
              want.push(...below);
              rails += below.filter((d) => d.kind === 'hedge').length;
              break;   // districtColliders punches one hole per district - the first
            }
          }
          for (const d of want) {
            assert.ok(present.has(`${d.kind}|${key(d)}`),
              `seed ${seed} level ${level} district (${dx},${dz}): a ${d.kind} at ${key(d)} was emitted `
              + 'by its builder and is missing from the district - the drop took something that is not '
              + 'a swallowed hedge');
            checkedDescs++;
          }
        }
      }
    }
  }
  assert.ok(checkedDescs > 0, 'no shaft descriptors were checked at all');
  assert.ok(rails > 0,
    'no landing guard rail was checked - those are the hedge-kinded descriptors this test exists for');
});

test('ART MUST NOT MOVE A COLLIDER: the space every dropped hedge occupied is still solid', () => {
  /* The property, stated without reference to how the drop decides. A hedge
   * that vanished has to leave the world exactly as solid as it was, so every
   * point it used to occupy must still be inside SOME surviving collider -
   * not necessarily the one the implementation happened to compare it
   * against. Sampled through the volume rather than at the corners, because a
   * hedge could in principle be covered at its corners by two boxes that miss
   * each other in the middle.
   *
   * "Still solid" is asked of the WORLD, not of one district's list: the box
   * that covers a dropped border hedge is often a shaft wall in the district
   * next door. That is safe for a reason worth restating - `updateResidency`
   * holds a neighbourhood around the player's OWN district (radius 2, never
   * less than 1), so a player who can reach a border hedge is standing in one
   * of the two districts either side of it and both are built. A version of
   * this test that only looked at `descs` would fail a correct drop, so the
   * neighbours are included, and every point still has to be inside something.
   */
  const FRAC = [0.05, 0.5, 0.95];
  let sampled = 0, seams = 0;
  for (let seed = 0; seed < SEEDS; seed++) {
    const t = generateTopology(seed);
    const cache = new Map();
    const district = (ddx, ddz) => {
      const k = `${ddx},${ddz}`;
      if (!cache.has(k)) cache.set(k, districtColliders(t.cells, ddx, ddz, 0));
      return cache.get(k);
    };
    for (let dz = 0; dz < SPAN; dz++) {
      for (let dx = 0; dx < SPAN; dx++) {
        const descs = district(dx, dz);
        if (!wallsAround(t.cells, dx, dz, 0).length) continue;
        const survivors = new Set(descs.filter((d) => d.kind === 'hedge').map(key));
        /* The resident neighbourhood the player would have when standing in
         * this district, which is what "the world" means at this hedge. */
        const around = [];
        for (let nz = dz - 1; nz <= dz + 1; nz++) {
          for (let nx = dx - 1; nx <= dx + 1; nx++) {
            if (nx < 0 || nz < 0 || nx >= MAZE.DISTRICTS || nz >= MAZE.DISTRICTS) continue;
            around.push(...district(nx, nz));
          }
        }
        for (const h of expectedHedges(t.cells, dx, dz, 0)) {
          if (survivors.has(key(h))) continue;
          const ownDistrictCovers = [];
          for (const fx of FRAC) for (const fy of FRAC) for (const fz of FRAC) {
            const px = h.cx + (fx * 2 - 1) * h.hx;
            const py = h.cy + (fy * 2 - 1) * h.hy;
            const pz = h.cz + (fz * 2 - 1) * h.hz;
            const solidIn = (list) => list.some((d) => Math.abs(d.cx - px) <= d.hx + 1e-6
              && Math.abs(d.cy - py) <= d.hy + 1e-6
              && Math.abs(d.cz - pz) <= d.hz + 1e-6);
            assert.ok(solidIn(around),
              `seed ${seed} district (${dx},${dz}): (${px.toFixed(2)}, ${py.toFixed(2)}, ${pz.toFixed(2)}) `
              + 'was solid hedge before the art pass and is open air after it');
            ownDistrictCovers.push(solidIn(descs));
            sampled++;
          }
          if (ownDistrictCovers.some((c) => !c)) seams++;
        }
      }
    }
  }
  assert.ok(sampled > 0, 'no dropped hedge was found to re-check - this proved nothing');
  // eslint-disable-next-line no-console
  console.log(`[shaft hedges] ${sampled} points re-checked inside dropped hedges, `
    + `${seams} of those hedges covered only by a neighbouring district's wall`);
});

test('every shaft is still a proven enclosure once its duplicate hedges are gone', () => {
  /* The enclosure proof reads the same descriptor list this drop edits, and a
   * hedge is exactly the sort of thing `isEnclosureSound` counts as coverage.
   * If the drop ever took one that was load-bearing for a seal - it must not,
   * see the containment test above - the failure would show up here as a
   * shaft that is no longer sound. Same helper the enclosure suite uses, so
   * "sealed" means one thing in this repo and not two. */
  let shafts = 0;
  for (let seed = 0; seed < SEEDS; seed++) {
    const t = generateTopology(seed);
    for (let dz = 0; dz < SPAN; dz++) {
      for (let dx = 0; dx < SPAN; dx++) {
        const cells = shaftCells(t.cells, dx, dz, 0);
        if (!cells.length) continue;
        const descs = districtColliders(t.cells, dx, dz, 0);
        for (const c of cells) {
          assert.equal(isRegionEnclosureSound(descs, t.cells, c.x, c.z, 0), true,
            `seed ${seed}: the shaft at ${c.x},${c.z} stopped being sealed once its hedges were dropped`);
          shafts++;
        }
      }
    }
  }
  assert.ok(shafts > 0, 'no shaft was checked for seal after the drop');
});

test('SEED 809, CELL (40,1): a shaft beside a shaft still proves its own enclosure', () => {
  /* The one arrangement in a 1000-seed sweep where the drop and the stacking
   * rule contradicted each other, pinned here because the sweep that found it
   * costs six minutes and nobody runs it: the gates above are written against
   * `MAZE_SEEDS`, default 3, so this geometry was invisible for the whole life
   * of the code that produced it.
   *
   * TWO ADJACENT SHAFTS. (40,1) and (39,1) both carry an UP link and the face
   * between them is closed. (40,1)'s WEST side is one it owns, so `shaftWalls`
   * used to start its panel at HEDGE_HEIGHT and let the ordinary 5 m hedge
   * carry the bottom - sound only while that hedge is standing. But (39,1)
   * walls its own EAST side floor-to-top on the very same plane, so
   * `dropHedgesInsideShafts` took (40,1)'s west hedge as a duplicate, which it
   * genuinely was. The solid space survived; the OWNERSHIP of it did not.
   * (39,1) is in district (1,0) and (40,1) is in district (2,0), so shaft
   * (40,1) was left proving the lower five metres of its own west wall out of
   * a descriptor its own district never emits - exactly the district-seam
   * dependency `stairColliders`'s comment refuses for east and south. That is
   * why the failure showed up twice over: once as a hedge dropped under a wall
   * that only touches it, and once as a shaft that was no longer sealed.
   *
   * So the assertions below are about SELF-SUFFICIENCY, not about the hedge.
   * The hedge is still dropped - it is still a duplicate and the stripe is
   * still worth removing - and what changed is that (40,1) now stands its own
   * full floor-to-top west wall, the same thing east and south have always
   * done. A future change that restores the stack, or that stops the drop to
   * make this pass, will fail here. */
  const SEED = 809, X = 40, Z = 1, LEVEL = 0;
  const D = MAZE.DISTRICT;
  const dx = Math.floor(X / D), dz = Math.floor(Z / D);
  const t = generateTopology(SEED);
  const idx = cellIndex(X, Z, LEVEL);
  const w = cellToWorld(X, Z, LEVEL);

  /* The fixture's premise. If seeding or carving ever moves, this test must
   * say so rather than quietly pass on some other cell's geometry. */
  assert.ok(isOpen(t.cells, idx, DIR.UP), `seed ${SEED} cell (${X},${Z}) is no longer a shaft`);
  assert.ok(!isOpen(t.cells, idx, DIR.W), `seed ${SEED} cell (${X},${Z})'s west face is no longer closed`);
  assert.ok(isOpen(t.cells, cellIndex(X - 1, Z, LEVEL), DIR.UP),
    `seed ${SEED} cell (${X - 1},${Z}) is no longer a shaft - the two-shafts-abreast case has moved`);
  assert.notEqual(Math.floor((X - 1) / D), dx,
    'the two shafts no longer straddle a district seam, which is the whole point of this fixture');

  const descs = districtColliders(t.cells, dx, dz, LEVEL);
  const planeX = w.x - HALF_CELL;
  const on = (list) => list.filter(
    (d) => Math.abs(d.cx - planeX) < 1e-6 && Math.abs(d.cz - w.z) < 1e-6);

  const walls = on(descs.filter((d) => d.kind === 'shaftWall'));
  assert.equal(walls.length, 1, `seed ${SEED}: expected exactly one shaft wall on (40,1)'s west plane`);
  assert.ok(Math.abs((walls[0].cy - walls[0].hy) - w.y) < 1e-6,
    `seed ${SEED}: (${X},${Z})'s west wall starts at ${(walls[0].cy - walls[0].hy).toFixed(2)} m and not at `
    + 'the floor - it is stacking on a hedge that the drop deletes, so its lower five metres are a '
    + "neighbouring district's problem");
  assert.ok(Math.abs((walls[0].cy + walls[0].hy) - (w.y + MAZE.LEVEL_HEIGHT)) < 1e-6,
    `seed ${SEED}: (${X},${Z})'s west wall no longer reaches LEVEL_HEIGHT`);

  assert.equal(on(descs.filter((d) => d.kind === 'hedge')).length, 0,
    `seed ${SEED}: the duplicate hedge under (${X},${Z})'s west wall came back - the drop has been `
    + 'loosened to make the enclosure pass instead of the wall being made self-sufficient');

  /* The property itself: every height the vanished hedge used to fill is solid
   * in THIS DISTRICT'S OWN list. Asking the world would pass on the broken
   * build too, because (39,1)'s wall was there all along. */
  for (const f of [0.02, 0.5, 0.98]) {
    const py = w.y + f * MAZE.HEDGE_HEIGHT;
    assert.ok(descs.some((d) => Math.abs(d.cx - planeX) <= d.hx + 1e-6
      && Math.abs(d.cy - py) <= d.hy + 1e-6
      && Math.abs(d.cz - w.z) <= d.hz + 1e-6),
    `seed ${SEED}: (${planeX}, ${py.toFixed(2)}, ${w.z}) is open air in district (${dx},${dz})'s own `
      + 'colliders - the shaft is relying on the district next door to hold its west side shut');
  }

  assert.equal(isRegionEnclosureSound(descs, t.cells, X, Z, LEVEL), true,
    `seed ${SEED}: the shaft at ${X},${Z} is not a proven enclosure from its own district's descriptors`);
});
