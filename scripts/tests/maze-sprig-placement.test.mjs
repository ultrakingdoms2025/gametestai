/**
 * Where the maze's growth sits, and whether a player can actually SEE it.
 *
 * `maze-foliage.test.mjs` already gates the two failures that were obvious
 * from the start - a sprig at floor level, a sprig floating above the hedge -
 * as a band around the hedge top. This file gates the failure that was not
 * obvious, because it is invisible in exactly the way the roadmap warns
 * about: geometry that is built, instanced, drawn, and never rendered where
 * anyone can see it.
 *
 * ── The defect this file exists for ───────────────────────────────────────
 *
 * Foliage sank a FLAT 0.16 m into the hedge. A sprig's half-height is
 * `0.25 * s * 1.4 = 0.35 * s` and `s` ranges 0.34 to 0.84, so every sprig
 * with `s < 0.457` had its whole silhouette below the hedge top - inside an
 * opaque box, drawn every frame, contributing nothing. That is 23% of them,
 * roughly 830 of the 3,600 in every district, and it had been true since the
 * sink constant was written. No error, no warning, and no test: the band
 * check above passes for a buried sprig, because a buried sprig IS at hedge-
 * top height. `art-citadel` found the same shape in a different world (200
 * houses whose window recesses were painted 16 cm inside a solid box) and
 * that is where the instinct to look here came from.
 *
 * The fix is a FRACTION of each sprig's own height rather than a constant, so
 * the failure cannot come back at any scale, and the assertions below are
 * written against that property rather than against the number.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAZE, generateTopology } from '../../src/worlds/maze/MazeTopology.js';
import { districtColliders } from '../../src/worlds/maze/MazeColliders.js';
import { foliageTransforms, shaftIvyTransforms } from '../../src/worlds/maze/MazeFoliage.js';
import { SPRIG_HALF } from '../../src/worlds/maze/MazeMeshes.js';

/** What `MazeChunks.buildSprigInstances` multiplies a sprig's `s` by on y. */
const Y_STRETCH = 1.4;
/** Half-height of one instance, in metres: the tuft's own half-extent times both. */
const halfHeight = (s) => SPRIG_HALF.hy * s * Y_STRETCH;

function everySprig(seed = 2026) {
  const { cells } = generateTopology(seed);
  const out = [];
  for (let dz = 2; dz < 5; dz++) {
    for (let dx = 2; dx < 5; dx++) {
      const key = dz * 20 + dx;
      out.push(...foliageTransforms(districtColliders(cells, dx, dz, 0), key));
    }
  }
  assert.ok(out.length > 2000, `only ${out.length} sprigs across nine districts - the scan is checking nothing`);
  return out;
}

test('THE VISIBLE-GROWTH GATE: every sprig breaks the hedge top line', () => {
  /* The whole reason foliage exists, stated as arithmetic. `MazeFoliage`'s own
   * header says it: "The hedge is a box, and the giveaway is its perfectly
   * straight top edge... Breaking that line is worth more than any amount of
   * detail on the faces." A sprig whose highest point is below that line
   * breaks nothing and is a triangle nobody will ever see. */
  const top = MAZE.HEDGE_HEIGHT;
  let worst = Infinity;
  for (const s of everySprig()) {
    const proud = (s.y + halfHeight(s.s)) - top;
    if (proud < worst) worst = proud;
    assert.ok(proud > 0,
      `a sprig at s=${s.s.toFixed(3)} tops out ${(-proud * 100).toFixed(1)} cm INSIDE the hedge - `
      + 'drawn every frame, visible never');
  }
  /* And not by a millimetre. Ten centimetres of a two-metre-wide corridor
   * silhouette is what makes the line read as broken at twenty metres. */
  assert.ok(worst > 0.04,
    `the least-proud sprig clears the hedge by only ${(worst * 100).toFixed(1)} cm`);
});

test('the sink is proportional, so the smallest sprig is as visible as the largest', () => {
  /* The property, not the number. A flat sink is the defect; any constant
   * fraction is correct, so the test asserts the ratio is CONSTANT rather
   * than asserting what it happens to be. */
  const ratios = new Set();
  for (const s of everySprig()) {
    const buried = (MAZE.HEDGE_HEIGHT - s.y) / halfHeight(s.s);
    ratios.add(buried.toFixed(4));
  }
  assert.equal(ratios.size, 1,
    `sprigs sink by ${ratios.size} different fractions of their own height (${[...ratios].slice(0, 5)}) - `
    + 'a sink that is not proportional buries the small ones');
});

test('growth may overhang the hedge face, but only just', () => {
  /* `SPRIG_OFFSET` was called `SPRIG_OVERHANG`, and until Phase 9 the name
   * was a claim the arithmetic never made. A 1.2 m hedge has 0.60 m of
   * half-thickness; an UPRIGHT sprig reached 0.22 + 0.25*0.84*sqrt2 = 0.52 m,
   * eight centimetres short of its own hedge's face. Nothing had ever hung
   * over anything.
   *
   * The lean changes that, by design and by a measurable amount: a tuft
   * leaning `SPRIG_LEAN` displaces its tip by `halfHeight * sin(lean)`, so
   * the worst case now clears the face by a few centimetres and the constant
   * finally does what it was named for. What must NOT happen is growth
   * reaching into the walkable corridor, which is 4.8 m wide - so the bound
   * is asserted against a tenth of a metre rather than against zero, and
   * against a fifth of the corridor half-width as the thing that would
   * actually matter. */
  const { cells } = generateTopology(2026);
  const descs = districtColliders(cells, 3, 3, 0);
  const sprigs = foliageTransforms(descs, 33);
  const hedges = descs.filter((d) => d.kind === 'hedge' && d.hy * 2 >= MAZE.HEDGE_HEIGHT - 0.01);
  assert.ok(hedges.length > 0, 'no full-height hedges in the scanned district');

  let worstOverhang = -Infinity;
  for (const s of sprigs) {
    /* The hedge this sprig belongs to: the nearest full-height one. */
    let host = null; let hostD = Infinity;
    for (const d of hedges) {
      const dd = Math.hypot(s.x - d.cx, s.z - d.cz);
      if (dd < hostD) { hostD = dd; host = d; }
    }
    assert.ok(host, 'a sprig has no hedge within its own district');
    /* Only the THIN axis matters. Along the hedge's length a sprig near the
     * end legitimately reaches past the segment's own end and onto the next
     * one - that is a straight run of hedge, not an edge. */
    const thinX = host.hx < host.hz;
    const off = thinX ? Math.abs(s.x - host.cx) : Math.abs(s.z - host.cz);
    const face = thinX ? host.hx : host.hz;
    /* Worst case in plan: the tuft's own half-extent on the diagonal, plus
     * whatever the lean displaces the tip by. */
    const reach = SPRIG_HALF.hx * s.s * Math.SQRT2
      + SPRIG_HALF.hy * s.s * Y_STRETCH * Math.abs(Math.sin(s.tilt));
    worstOverhang = Math.max(worstOverhang, off + reach - face);
  }
  assert.ok(worstOverhang < 0.10,
    `growth hangs ${(worstOverhang * 100).toFixed(1)} cm past the hedge face - it has no collider, so a `
    + 'player would walk through it');
  assert.ok(worstOverhang < MAZE.CORRIDOR / 2 / 5,
    'growth reaches an appreciable fraction of the way across the corridor');
});

test('hedge growth uses the whole circle of yaw, and leans both ways', () => {
  /* Half a turn was right for a BOX - a square in plan repeats every quarter
   * turn - and is half the variation thrown away for a five-fold tuft, which
   * has no symmetry at all. And nothing in this world leaned before Phase 9:
   * every sprig stood exactly upright, which on a straight hedge top is the
   * "bricks laid by hand" read the before-shots caught. */
  const sprigs = everySprig();
  let maxRy = 0; let minTilt = Infinity; let maxTilt = -Infinity;
  for (const s of sprigs) {
    if (s.ry > maxRy) maxRy = s.ry;
    assert.equal(typeof s.tilt, 'number', 'a hedge sprig carries no lean');
    if (s.tilt < minTilt) minTilt = s.tilt;
    if (s.tilt > maxTilt) maxTilt = s.tilt;
  }
  assert.ok(maxRy > Math.PI * 1.5,
    `yaw tops out at ${maxRy.toFixed(2)} rad - the tuft is not symmetric, so anything under a full turn `
    + 'is variation thrown away');
  assert.ok(minTilt < -0.2 && maxTilt > 0.2,
    `lean spans ${minTilt.toFixed(2)}..${maxTilt.toFixed(2)} rad - growth that all leans one way is a comb`);
  assert.ok(Math.abs(minTilt) < 0.9 && maxTilt < 0.9,
    'a tuft leaning past half a radian reads as blown over, not as grown');
});

test('IVY NEVER LEANS - its thin axis has to stay on the wall', () => {
  /* The one place a lean would be a regression rather than an improvement,
   * and the reason is already written into `buildSprigInstances`: an ivy leaf
   * is flattened on the wall's own normal and rolled ABOUT that normal, so
   * the thin axis cannot move. A lean is exactly the rotation that takes it
   * off the stone, and the failure mode has a name in this repository -
   * confetti. */
  const { cells } = generateTopology(2026);
  let leaves = 0;
  for (let dz = 0; dz < 6; dz++) {
    for (let dx = 8; dx < 13; dx++) {
      for (const leaf of shaftIvyTransforms(districtColliders(cells, dx, dz, 0), dz * 20 + dx)) {
        leaves++;
        assert.equal(leaf.tilt, undefined,
          'an ivy leaf carries a lean - it would stand edge-out from the wall it lies on');
        assert.ok(leaf.axis === 'x' || leaf.axis === 'z',
          `an ivy leaf rolls about '${leaf.axis}' rather than about a wall normal`);
      }
    }
  }
  assert.ok(leaves > 100, `only ${leaves} ivy leaves across thirty districts - the scan found no shafts`);
});
