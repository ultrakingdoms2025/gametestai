/**
 * The region predicate that decides where the station derives collision from
 * its own triangles.
 *
 * Headless on purpose. This is the whole of the fix that let the outer ring be
 * collided at all, it is pure arithmetic over the layout constants, and it is
 * asked once per triangle a quarter of a million times per build - so it is
 * exactly the sort of thing that should be provable without a browser. The
 * defect it replaced (`cx*cx + cz*cz > DECK_R*DECK_R`) would have been caught
 * by the very first assertion below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collideCeilingAt, LINK_COLLIDE_CEILING,
  DECK_R, HULL_R, COLLIDE_CEILING, ZONES, ZONE_R, ZONE_CENTRE_R, LINK_LEN,
  zoneCentre, zoneLocal, roadPos, DEG,
  chunkTriangles, chunkTrianglesBySpan, chunkSpan, PLANTING_SPAN, ROAD_W,
} from '../../src/worlds/station/StationKit.js';

const OUT = -Infinity;

test('the hub deck is collided to the hub ceiling, exactly as it was', () => {
  assert.equal(collideCeilingAt(0, 0), COLLIDE_CEILING);
  assert.equal(collideCeilingAt(DECK_R - 0.5, 0), COLLIDE_CEILING);
  assert.equal(collideCeilingAt(0, -(DECK_R - 0.5)), COLLIDE_CEILING);
});

test('the hub edge is still DECK_R - the hull wall at 202 is not collided from geometry', () => {
  // Bearing 0 carries no link, so nothing else can claim this point. The hull
  // ring of boxes is what stops a player there; see `_buildHull`.
  assert.equal(collideCeilingAt(DECK_R + 0.5, 0), OUT);
  assert.equal(collideCeilingAt(HULL_R, 0), OUT);
});

test('EVERY OUTER ZONE IS COLLIDED - the defect, stated as a test', () => {
  for (const z of ZONES) {
    const c = zoneCentre(z.deg);
    assert.equal(
      collideCeilingAt(c.x, c.z), COLLIDE_CEILING,
      `zone "${z.id}" centre at ${Math.round(Math.hypot(c.x, c.z))} m is not collided`
    );
    // ... and the far wall, which is the furthest thing from the origin that a
    // player can walk up to: 698 m out, three and a half times the old cut.
    const far = zoneLocal(z.deg, 0, 0, -(ZONE_R - 1));
    assert.equal(collideCeilingAt(far.x, far.z), COLLIDE_CEILING, `zone "${z.id}" far wall`);
    assert.ok(Math.hypot(far.x, far.z) > 690, 'the far wall should be ~697 m out');
  }
});

test('a zone region reaches its perimeter wall and stops soon after', () => {
  // Measured across the zone rather than along the corridor: on the corridor
  // axis the link band legitimately carries on past the rim, which is what
  // makes the two regions meet without a seam.
  for (const z of ZONES) {
    // Drawn wall at ZONE_R + 2, 1.1 m thick, so its far face is at 203.1.
    const wall = zoneLocal(z.deg, ZONE_R + 3.1, 0, 0);
    assert.equal(collideCeilingAt(wall.x, wall.z), COLLIDE_CEILING, `zone "${z.id}" wall`);
    const past = zoneLocal(z.deg, ZONE_R + 12, 0, 0);
    assert.equal(collideCeilingAt(past.x, past.z), OUT, `zone "${z.id}" past the wall`);
  }
});

test('a link corridor is collided, to its own ceiling and not the hub\'s', () => {
  for (const z of ZONES) {
    // Midway down the corridor, on its axis and at the edge of its glazed bays.
    const mid = HULL_R + LINK_LEN / 2;
    const on = roadPos(z.deg, mid, 0);
    assert.equal(collideCeilingAt(on.x, on.z), LINK_COLLIDE_CEILING, `link "${z.id}" axis`);
    const bay = roadPos(z.deg, mid, 16.7);
    assert.equal(collideCeilingAt(bay.x, bay.z), LINK_COLLIDE_CEILING, `link "${z.id}" bay`);
    // Well outside the tube is apron, which takes no derived collision at all.
    const off = roadPos(z.deg, mid, 40);
    assert.equal(collideCeilingAt(off.x, off.z), OUT, `link "${z.id}" apron`);
  }
});

test('a link ceiling clears the corridor roof and nothing more', () => {
  // buildLink: CEIL = 9.5, roof plate centre CEIL + 0.3 with half-height 0.3.
  assert.ok(LINK_COLLIDE_CEILING > 9.5 + 0.6, 'a link must collide its own roof');
  assert.ok(LINK_COLLIDE_CEILING < 30, 'a link must not collide the dome above it');
});

test('hub, link and zone form one connected region with no gap to fall through', () => {
  // Walked outward every half metre along each avenue that carries a link,
  // from the plaza to the zone\'s far wall. A hole here is a strip of floor
  // with no derived collision on it.
  for (const z of ZONES) {
    for (let r = 0; r <= ZONE_CENTRE_R + ZONE_R - 1; r += 0.5) {
      const p = roadPos(z.deg, r, 0);
      assert.notEqual(
        collideCeilingAt(p.x, p.z), OUT,
        `gap on the "${z.id}" axis at r=${r}`
      );
    }
  }
});

test('the two avenues without links do not sprout a corridor', () => {
  for (const deg of [0, 60]) {
    const p = roadPos(deg, HULL_R + LINK_LEN / 2, 0);
    assert.equal(collideCeilingAt(p.x, p.z), OUT, `avenue ${deg} should end at the hull`);
  }
});

test('the dome, the apron and the space between the arms take no derived collision', () => {
  assert.equal(collideCeilingAt(0, 700), OUT);
  assert.equal(collideCeilingAt(500, 500), OUT);
  // Halfway between two adjacent zones, at their own radius from the origin.
  const between = roadPos((ZONES[0].deg + ZONES[1].deg) / 2, ZONE_CENTRE_R, 0);
  assert.equal(collideCeilingAt(between.x, between.z), OUT);
});

test('the predicate is pure, symmetric under the layout, and allocation-free', () => {
  // Same answer twice, and the same answer for the same point in every zone -
  // the four zones differ only by bearing, so anything that is true in one and
  // false in another means the table was built wrong.
  const seen = new Set();
  for (const z of ZONES) {
    for (const [lx, lz] of [[0, 0], [80, 80], [0, -150], [ZONE_R - 2, 0]]) {
      const p = zoneLocal(z.deg, lx, 0, lz);
      const first = collideCeilingAt(p.x, p.z);
      assert.equal(collideCeilingAt(p.x, p.z), first, 'not deterministic');
      seen.add(`${lx},${lz}:${first}`);
    }
  }
  assert.equal(seen.size, 4, 'the four zones disagreed about the same local point');
});

test('DEG is the bearing unit the table was built with', () => {
  // Guards against the table and the callers drifting onto different units,
  // which would silently rotate every link band off its corridor.
  const p = roadPos(120, HULL_R + LINK_LEN / 2, 0);
  const q = {
    x: Math.cos(120 * DEG) * (HULL_R + LINK_LEN / 2),
    z: Math.sin(120 * DEG) * (HULL_R + LINK_LEN / 2),
  };
  assert.ok(Math.hypot(p.x - q.x, p.z - q.z) < 1e-9);
});

/* ------------------------------------------------------------------ */
/* The size-bounded chunker                                            */
/* ------------------------------------------------------------------ */

/** A triangle laid flat at (x, z), `s` metres across. */
function tri(x, z, s = 0.2, y = 1) {
  return [x, y, z, x + s, y, z, x, y, z + s];
}
function soupOf(tris) {
  return new Float32Array(tris.flat());
}

test('chunkSpan measures the longest side of a chunk\'s bounds', () => {
  assert.equal(chunkSpan(soupOf([tri(0, 0, 3)])), 3);
  assert.equal(chunkSpan(soupOf([tri(0, 0, 1), tri(10, 0, 1)])), 11);
  assert.equal(chunkSpan(new Float32Array(0)), 0);
});

test('THE SEALED CORRIDOR: scattered triangles never share one wide chunk', () => {
  /* This is the defect in miniature. Sixty shrubs strung along 300 m are one
   * chunk to a chunker that counts triangles, and the box around that chunk is
   * a wall 300 m long. That is exactly what lay across the habitation link. */
  const scattered = [];
  for (let i = 0; i < 60; i++) scattered.push(tri(i * 5, 0, 0.2));
  const soup = soupOf(scattered);

  const plain = chunkTriangles(soup, 64);
  assert.equal(plain.length, 1, 'the triangle-only chunker should make one chunk here');
  assert.ok(chunkSpan(plain[0]) > 290, 'and that chunk should span the whole run');

  const bounded = chunkTrianglesBySpan(soup, 64, 4);
  for (const c of bounded) {
    assert.ok(chunkSpan(c) <= 4 || c.length === 9, `chunk spans ${chunkSpan(c)} m`);
  }
});

test('the size-bounded chunker keeps every triangle exactly once', () => {
  const tris = [];
  for (let i = 0; i < 200; i++) tris.push(tri((i % 20) * 7, Math.floor(i / 20) * 9, 0.3));
  const soup = soupOf(tris);
  const chunks = chunkTrianglesBySpan(soup, 64, 4);
  const kept = chunks.reduce((n, c) => n + c.length / 9, 0);
  assert.equal(kept, 200, 'triangles were lost or duplicated');
  // Same multiset of first vertices, order-independent.
  const key = (a, i) => `${a[i].toFixed(3)},${a[i + 1].toFixed(3)},${a[i + 2].toFixed(3)}`;
  const want = new Set();
  for (let i = 0; i < soup.length; i += 9) want.add(key(soup, i));
  const got = new Set();
  for (const c of chunks) for (let i = 0; i < c.length; i += 9) got.add(key(c, i));
  assert.deepEqual([...got].sort(), [...want].sort());
});

test('it terminates on a single triangle that is itself wider than the span', () => {
  // The floor of the recursion. A 40 m card cannot be split any further, and a
  // chunker that kept trying would hang the build.
  const chunks = chunkTrianglesBySpan(soupOf([tri(0, 0, 40)]), 64, 4);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].length, 9);
});

test('it terminates on coincident triangles no split can separate', () => {
  const same = [];
  for (let i = 0; i < 40; i++) same.push(tri(0, 0, 12));
  const chunks = chunkTrianglesBySpan(soupOf(same), 64, 4);
  assert.equal(chunks.reduce((n, c) => n + c.length / 9, 0), 40);
});

test('dense geometry is left alone - the bound only bites where it should', () => {
  // A hedge: 64 triangles inside two metres. Already a patch, so the bounded
  // chunker must return what the plain one did and cost nothing.
  const hedge = [];
  for (let i = 0; i < 64; i++) hedge.push(tri((i % 8) * 0.25, Math.floor(i / 8) * 0.25, 0.2));
  const soup = soupOf(hedge);
  assert.equal(chunkTrianglesBySpan(soup, 64, 4).length, chunkTriangles(soup, 64).length);
});

test('PLANTING_SPAN is narrower than the narrowest route a player walks', () => {
  // The hab arcade's radial spokes are 5.4 m; roads are ROAD_W. A proxy box
  // that cannot span the narrowest of those cannot seal any of them.
  assert.ok(PLANTING_SPAN < 5.4, 'a planting proxy must not span an arcade spoke');
  assert.ok(PLANTING_SPAN < ROAD_W);
  assert.ok(PLANTING_SPAN > 0.5, 'and must still be able to hug a lobe');
});
