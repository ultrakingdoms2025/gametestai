import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAZE, generateTopology, cellIndex, isOpen, DIR } from '../../src/worlds/maze/MazeTopology.js';
import { districtColliders } from '../../src/worlds/maze/MazeColliders.js';
import { shaftIvyTransforms } from '../../src/worlds/maze/MazeFoliage.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const SEEDS = Number(process.env.MAZE_SEEDS ?? 3);
/** Districts per axis scanned per seed - enough to turn up several shafts. */
const SPAN = 5;

/**
 * One district's descriptors from every district in the scan window that has
 * a shaft in it, plus the key `MazeChunks` would seed the ivy with.
 *
 * Ivy only exists where a shaft wall does, so a scan that happens to miss
 * every shaft would let this whole file pass while asserting nothing - the
 * same failure mode the enclosure suite's "the window is the point" comment
 * describes. Every test below asserts it found some.
 */
function shaftDistricts(seed) {
  const t = generateTopology(seed);
  const out = [];
  for (let dz = 0; dz < SPAN; dz++) {
    for (let dx = 0; dx < SPAN; dx++) {
      const descs = districtColliders(t.cells, dx, dz, 0);
      if (descs.some((d) => d.kind === 'shaftWall')) out.push({ dx, dz, descs, cells: t.cells });
    }
  }
  return out;
}

test('THE NON-COLLIDABLE GATE: ivy never reaches the collider path', () => {
  /* The same gate `maze-foliage.test.mjs` holds the hedge sprigs to, and for a
   * stronger reason. A hedge sprig sits at 5 m, at the very top of section 2's
   * 0.45-5.0 m band; ivy runs the whole height of a nine-metre panel, so most
   * of a strand is squarely INSIDE the band. Every leaf would be a rung if one
   * ever became a descriptor, and THE ANTI-LADDER GATE would be right to fail.
   *
   * The transforms are also checked not to write back into the descriptors
   * they were derived from: tagging a shaft wall on the way past would reach
   * the collider path just as surely as returning one, and nothing else in the
   * suite would notice a new property appearing on a descriptor. */
  let districts = 0, inBand = 0;
  for (let seed = 0; seed < SEEDS; seed++) {
    for (const d of shaftDistricts(seed)) {
      districts++;
      const before = JSON.stringify(d.descs);
      const ivy = shaftIvyTransforms(d.descs, d.dx * 31 + d.dz);
      assert.equal(JSON.stringify(d.descs), before,
        `district (${d.dx},${d.dz}): growing ivy modified the collider descriptors it grew on`);
      for (const c of d.descs) {
        assert.notEqual(c.kind, 'ivy', `an ivy descriptor reached districtColliders at ${d.dx},${d.dz}`);
      }
      for (const leaf of ivy) {
        if (leaf.y > 0.45 && leaf.y < MAZE.HEDGE_HEIGHT) inBand++;
      }
    }
  }
  assert.ok(districts > 0, 'no district with a shaft was scanned - this gate never saw any ivy');
  assert.ok(inBand > 0,
    'not one leaf landed in the 0.45-5.0 m band, so this gate is green for the wrong reason - '
    + 'the band is exactly where a collidable prop would be a ladder');
});

test('the only thing MazeChunks turns into a collider is a descriptor', () => {
  /* Textual, like the lighting tripwires, and for the same reason: the gate
   * above proves no ivy descriptor EXISTS, which is only half the claim. The
   * other half is that nothing else in the streaming path builds a box - and
   * today it does not, because there is exactly one `addBox` call in the file
   * and it is fed `d`, the descriptor loop variable. A second call site is
   * what "and then we made the ivy solid" would look like, and no behavioural
   * test in this repo would fail the day it appeared. */
  return readFile(path.join(root, 'src/worlds/maze/MazeChunks.js'), 'utf8').then((src) => {
    const calls = [...src.matchAll(/addBox\(([^)]*)\)/g)].map((m) => m[1]);
    assert.equal(calls.length, 1, `MazeChunks has ${calls.length} addBox call sites, expected exactly 1`);
    assert.equal(calls[0], 'd.cx, d.cy, d.cz, d.hx, d.hy, d.hz',
      'the one addBox call no longer takes a descriptor straight from districtColliders');
  });
});

test('ivy grows on shaft walls and on nothing else', () => {
  /* Not just "shaft districts have ivy": the districts WITHOUT a shaft are the
   * other half of the claim, and they are almost all of the maze. Ivy leaking
   * onto ordinary hedges would be a per-district draw call and several
   * thousand instances everywhere in the world, which is the cost this feature
   * was scoped to avoid. */
  const t = generateTopology(2026);
  let withShaft = 0, without = 0;
  for (let dz = 0; dz < SPAN; dz++) {
    for (let dx = 0; dx < SPAN; dx++) {
      const descs = districtColliders(t.cells, dx, dz, 0);
      const ivy = shaftIvyTransforms(descs, dx * 31 + dz);
      if (descs.some((d) => d.kind === 'shaftWall')) {
        assert.ok(ivy.length > 20,
          `district (${dx},${dz}) has shaft walls but grew only ${ivy.length} leaves`);
        withShaft++;
      } else {
        assert.equal(ivy.length, 0,
          `district (${dx},${dz}) has no shaft wall in it and grew ${ivy.length} leaves anyway`);
        without++;
      }
    }
  }
  assert.ok(withShaft > 0 && without > 0,
    `the window has to contain both kinds of district to say anything: ${withShaft} with, ${without} without`);
});

test('every leaf clings to the outside of a panel, over its height', () => {
  /* Stated as bands rather than as the exact offsets and scales, which are art
   * values and have already been retuned twice mid-phase (the leaf count
   * became a spacing, the yaw became a roll). An equality against today's
   * literals would restate the implementation and go red on the next tuning
   * pass while catching neither of the failures that actually matter:
   *
   *  - a leaf INSIDE the panel, which is invisible and pure cost;
   *  - a leaf adrift in the corridor, off the surface it is meant to clad;
   *  - ivy pooled at the base, which reads as a hedge clipping through stone
   *    rather than as growth up a tower (the docstring's own words). */
  let leaves = 0, panelsSeen = 0;
  for (let seed = 0; seed < SEEDS; seed++) {
    for (const d of shaftDistricts(seed)) {
      const panels = d.descs.filter((c) => c.kind === 'shaftWall');
      const ivy = shaftIvyTransforms(d.descs, d.dx * 31 + d.dz);
      panelsSeen += panels.length;
      /** How high up its own panel the highest leaf on it got, panel by panel. */
      const highest = new Map();
      for (const leaf of ivy) {
        assert.ok(leaf.s > 0, `a leaf has scale ${leaf.s}`);
        /* Every panel whose outer face this leaf could be lying on. Gathered
         * rather than settled on the first hit: the four panels of a shaft
         * meet at its corners, and a tunnel's are longer still, so one leaf
         * can sit in more than one panel's band. Picking the first and
         * demanding the flatten axis agree with it fails on geometry that is
         * perfectly correct. */
        const candidates = panels.filter((p) => {
          const thinX = p.hx < p.hz;
          const off = thinX ? Math.abs(leaf.x - p.cx) : Math.abs(leaf.z - p.cz);
          const along = thinX ? Math.abs(leaf.z - p.cz) : Math.abs(leaf.x - p.cx);
          const thin = thinX ? p.hx : p.hz;
          const span = thinX ? p.hz : p.hx;
          // Just proud of the face - outside the stone, not floating off it.
          if (off <= thin || off > thin + 0.5) return false;
          if (along > span) return false;
          return leaf.y >= p.cy - p.hy - 0.25 && leaf.y <= p.cy + p.hy;
        });
        assert.ok(candidates.length > 0,
          `seed ${seed} district (${d.dx},${d.dz}): a leaf at (${leaf.x.toFixed(2)}, `
          + `${leaf.y.toFixed(2)}, ${leaf.z.toFixed(2)}) lies on no panel face at all - it is either `
          + 'buried in the stone or adrift in the corridor');
        /* A leaf is a flattened quad, and the axis it is flattened on has to
         * be the normal of the panel it lies on, or it stands edge-out from
         * the very wall it is meant to be clinging to - the failure the source
         * `axis`/roll comment describes. So of the panels it could belong to,
         * at least one has to agree with how it is squashed. */
        const home = candidates.find((p) => {
          const thinX = p.hx < p.hz;
          if (leaf.axis !== undefined && leaf.axis !== (thinX ? 'x' : 'z')) return false;
          if (leaf.sx === undefined || leaf.sz === undefined) return true;
          return thinX ? leaf.sx < leaf.sz : leaf.sz < leaf.sx;
        });
        assert.ok(home,
          `seed ${seed} district (${d.dx},${d.dz}): a leaf at (${leaf.x.toFixed(2)}, `
          + `${leaf.y.toFixed(2)}, ${leaf.z.toFixed(2)}) is flattened on an axis (sx=${leaf.sx}, `
          + `sz=${leaf.sz}) that matches no panel it lies on - it stands edge-out from the stone`);
        const frac = (leaf.y - (home.cy - home.hy)) / (2 * home.hy);
        const k = `${home.cx},${home.cz}`;
        highest.set(k, Math.max(highest.get(k) ?? 0, frac));
        leaves++;
      }
      for (const [k, frac] of highest) {
        assert.ok(frac > 0.4,
          `panel ${k} is only clad to ${(frac * 100).toFixed(0)}% of its height - ivy that stops `
          + 'low reads as a hedge clipping through the tower, not as growth up it');
      }
    }
  }
  assert.ok(leaves > 100 && panelsSeen > 0, `only ${leaves} leaves across ${panelsSeen} panels`);
});

test('ivy is deterministic, and differs between districts', () => {
  /* The whole world is reproducible from its seed - the map, the wanderers and
   * the tokens all key off it - and a prop that re-rolls per call would break
   * that quietly: a district evicted and streamed back in 120 m later would
   * come back clad differently, which is the one artifact a player standing
   * still can see happen. */
  const t = generateTopology(11);
  const withShaft = [];
  for (let dz = 0; dz < SPAN && withShaft.length < 2; dz++) {
    for (let dx = 0; dx < SPAN && withShaft.length < 2; dx++) {
      const descs = districtColliders(t.cells, dx, dz, 0);
      if (descs.some((d) => d.kind === 'shaftWall')) withShaft.push(descs);
    }
  }
  assert.ok(withShaft.length > 0, 'no shaft district found to grow ivy on');
  const descs = withShaft[0];
  assert.deepEqual(shaftIvyTransforms(descs, 5), shaftIvyTransforms(descs, 5));
  assert.notDeepEqual(shaftIvyTransforms(descs, 5), shaftIvyTransforms(descs, 6),
    'two districts with the same shaft layout grew identical ivy - the seed is not reaching the hash');
});
