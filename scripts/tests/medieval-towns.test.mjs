/**
 * THE TOWN GATE.
 *
 * Five towns, eighty-one buildings and fifty-four walkable interiors were
 * added to the outer ring. Every way that can be wrong is silent:
 *
 *   - a footprint straddling three metres of relief floats a corner or buries
 *     a doorway, and nothing throws;
 *   - two footprints overlapping leaves two roofs interpenetrating, and
 *     nothing throws;
 *   - a building on the road leaves the road running through the parlour, and
 *     nothing throws;
 *   - a staircase whose steps do not sum to the storey height stops 17 cm
 *     under the floor it serves, which is invisible from anywhere except
 *     standing on it;
 *   - a "hollow" ground storey with a solid mass over the ceiling is a room
 *     you can reach and a first floor you cannot;
 *   - a town that is BUILT but never registered in `Settlements.js` renders
 *     with grass growing to its doorsteps.
 *
 * None of it needs a renderer. The layout half is pure arithmetic over
 * `Towns.js`; the build half runs `_buildTowns` for real under Node against a
 * stub physics and a stub material set, so the colliders, the doors and the
 * enterable descriptors that are checked here are the ones that ship.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createHash } from 'node:crypto';

import { medievalHeight, riverZ, riverHalfWidth, WATER_Y, HALF } from '../../src/worlds/terrain/MedievalHeight.js';
import { SETTLEMENTS, settledAt } from '../../src/worlds/medieval/Settlements.js';
import { ROADS, samplePolyline, roadGraph } from '../../src/worlds/medieval/RoadNet.js';
import {
  TOWNS, allBuildings, landmarkOf, interiorPlan, stairFlight, groundUnder,
  footprintsOverlap, footprintDistance, footprintCorners, isOverWater, townBank,
  GROUND_H, UPPER_H, FLOOR_T, FLOOR_RISE, DOOR_W, DOOR_H, WALL_T,
  STAIR_RISE_MAX, STAIR_TREAD, REEDWATER_DECK,
} from '../../src/worlds/medieval/Towns.js';
import { MedievalWorld } from '../../src/worlds/MedievalWorld.js';

/* ------------------------------------------------------------------ */
/* 1. The layout                                                       */
/* ------------------------------------------------------------------ */

const ALL = allBuildings();

test('there are five towns, each with a distinct vernacular and a landmark', () => {
  assert.equal(TOWNS.length, 5);
  const ids = TOWNS.map((t) => t.id).sort();
  assert.deepEqual(ids, ['blackmarch', 'fenwick-cross', 'grimscar', 'reedwater', 'st-ceolwine']);
  /* Distinctness is checked as a property, not asserted as a comment: a player
   * has to know which town they are in from the silhouette, and the two things
   * that carry a silhouette at distance are the WALL material and the ROOF
   * form. If two towns shared both, they would be the same town twice. */
  const seen = new Set();
  for (const t of TOWNS) {
    const lm = landmarkOf(t);
    assert.ok(lm, `${t.id} names a landmark that is not in its own building list`);
    assert.ok(lm.enterable, `${t.id}'s landmark is not enterable`);
    const walls = new Set(t.buildings.map((b) => b.wall));
    const roofs = new Set(t.buildings.map((b) => b.roof));
    const key = `${[...walls].sort().join('/')}|${[...roofs].sort().join('/')}`;
    assert.equal(seen.has(key), false, `${t.id} has the same material palette as another town`);
    seen.add(key);
    assert.ok(t.buildings.length >= 8, `${t.id} has only ${t.buildings.length} buildings`);
  }
  // Fenwick is the biggest of the five, as the brief requires.
  const biggest = TOWNS.reduce((a, b) => (b.buildings.length > a.buildings.length ? b : a));
  assert.equal(biggest.id, 'fenwick-cross');
});

test('every building sits ON the terrain - nothing floats, nothing is buried', () => {
  /* `_shell` bases itself on the HIGHEST corner and drops a plinth past the
   * lowest, so relief under a footprint becomes masonry rather than a floating
   * corner. That works and it stops working somewhere: a 2.4 m plinth under a
   * 7 m cottage is a tower block, and it is the signal that the building has
   * been put on ground that cannot hold it. */
  for (const b of ALL) {
    if (b.stilt) continue;
    const g = groundUnder(b, medievalHeight);
    assert.ok(g.relief <= 2.4,
      `${b.town}/${b.id} spans ${g.relief.toFixed(2)} m of relief - it needs a ${(g.relief + 0.55).toFixed(1)} m plinth`);
    assert.ok(Number.isFinite(g.baseY));
    // ...and it must be dry land, not the flood plain or the channel.
    assert.ok(medievalHeight(b.x, b.z) > WATER_Y + 0.3,
      `${b.town}/${b.id} stands at ${medievalHeight(b.x, b.z).toFixed(2)} m, below the ${WATER_Y} m waterline`);
    const rd = Math.abs(b.z - riverZ(b.x)) - riverHalfWidth(b.x);
    assert.ok(rd > 2, `${b.town}/${b.id} is ${rd.toFixed(1)} m from the channel edge`);
    // Every corner has to be inside the playfield too.
    for (const [cx, cz] of footprintCorners(b, 1)) {
      assert.ok(Math.abs(cx) < HALF && Math.abs(cz) < HALF, `${b.id} overhangs the rim`);
    }
  }
});

test("Reedwater's stilt buildings really do stand over open water", () => {
  const stilts = ALL.filter((b) => b.stilt);
  assert.ok(stilts.length >= 6, `only ${stilts.length} stilt buildings`);
  for (const b of stilts) {
    assert.ok(isOverWater(b, medievalHeight),
      `${b.id} is a stilt building on dry land at ${medievalHeight(b.x, b.z).toFixed(2)} m`);
    assert.equal(b.deck, REEDWATER_DECK, `${b.id} sits at a different deck height to the rest`);
    // Freeboard, and a post long enough to be a post.
    assert.ok(b.deck - WATER_Y >= 0.9, `${b.id}'s deck is only ${(b.deck - WATER_Y).toFixed(2)} m above the pool`);
    const g = groundUnder(b, medievalHeight);
    assert.ok(b.deck - g.hi >= 1.0, `${b.id}'s posts are only ${(b.deck - g.hi).toFixed(2)} m long`);
  }
});

test('no building overlaps another, anywhere in the ring', () => {
  /* One metre of clear air between two buildings, tested with a real
   * separating-axis over the ROTATED rectangles. An axis-aligned approximation
   * would pass a market street of jettied burgage plots that visibly
   * interpenetrates - the whole point of a burgage row is that the plots are
   * close and not parallel to anything. */
  for (let i = 0; i < ALL.length; i++) {
    for (let j = i + 1; j < ALL.length; j++) {
      assert.equal(footprintsOverlap(ALL[i], ALL[j], 0.5), false,
        `${ALL[i].town}/${ALL[i].id} overlaps ${ALL[j].town}/${ALL[j].id}`);
    }
  }
});

test('no building stands on a road', () => {
  const sampled = ROADS.map((r) => ({ key: r.key, hw: r.width / 2, pts: samplePolyline(r.pts, 1.5) }));
  for (const b of ALL) {
    let best = Infinity;
    let who = '';
    for (const r of sampled) {
      for (const [x, z] of r.pts) {
        const d = footprintDistance(b, x, z) - r.hw;
        if (d < best) { best = d; who = r.key; }
      }
    }
    /* 0.4 m, not a metre: these buildings FRONT their streets - a burgage plot
     * with a two-metre setback is a suburb - so the contract is that the
     * carriageway does not cross the wall line, with a pavement's worth of
     * slack for the spline bulging off the sampled polyline. */
    assert.ok(best > 0.4,
      `${b.town}/${b.id} is ${best.toFixed(2)} m from the ${who} road's edge`);
  }
});

/* ------------------------------------------------------------------ */
/* 2. The interiors, as arithmetic                                     */
/* ------------------------------------------------------------------ */

test('a stair flight always lands exactly on the floor it serves', () => {
  // The property, over the whole range of climbs the shells can produce.
  for (let climb = 0.5; climb < 12; climb += 0.017) {
    const f = stairFlight(0, climb);
    assert.ok(f.rise <= STAIR_RISE_MAX + 1e-12, `rise ${f.rise} exceeds the step-up limit`);
    assert.equal(f.steps, Math.max(1, Math.ceil(climb / STAIR_RISE_MAX)));
    // The load-bearing assertion: n * rise IS the climb, to the bit.
    assert.ok(Math.abs(f.steps * f.rise - climb) < 1e-9,
      `a flight of ${f.steps} at ${f.rise} lands ${(f.steps * f.rise - climb).toExponential(2)} off`);
    assert.equal(f.run, f.steps * STAIR_TREAD);
  }
});

test('every enterable interior is a room a player can stand up in', () => {
  for (const b of ALL) {
    if (!b.enterable) continue;
    const plan = interiorPlan(b);
    assert.equal(plan.floors.length, b.storeys);
    for (const fl of plan.floors) {
      assert.ok(fl.clear >= 2.4,
        `${b.town}/${b.id} storey ${fl.storey} has ${fl.clear} m of headroom`);
      assert.ok(fl.ceilY - fl.floorY === fl.clear);
    }
    assert.equal(plan.floors[0].floorY, FLOOR_RISE);
    assert.equal(plan.floors[0].clear, GROUND_H);
    if (b.storeys > 1) assert.equal(plan.floors[1].clear, UPPER_H);
    // The room has floor area, and the door fits in the wall it is cut into.
    assert.ok(Math.abs(plan.standing.z) < plan.inner.hz && plan.standing.x === 0,
      `${b.id} declares a standing point outside its own walls`);
    assert.ok(plan.inner.hx >= 1.6 && plan.inner.hz >= 1.6,
      `${b.id}'s interior is ${(plan.inner.hx * 2).toFixed(1)} x ${(plan.inner.hz * 2).toFixed(1)} m`);
    assert.ok(b.w >= DOOR_W + 2 * WALL_T + 0.8, `${b.id} is too narrow for its own doorway`);
    assert.equal(plan.door.w, DOOR_W);
    assert.ok(plan.door.h >= 2.0 && plan.door.h === DOOR_H);
    assert.equal(plan.wallT, WALL_T);
  }
});

test('a multi-storey interior has a flight that meets BOTH floors and fits', () => {
  let checked = 0;
  for (const b of ALL) {
    if (!b.enterable || b.storeys < 2) continue;
    const plan = interiorPlan(b);
    assert.equal(plan.stairs.length, b.storeys - 1);
    for (let i = 0; i < plan.stairs.length; i++) {
      const st = plan.stairs[i];
      assert.equal(st.fromY, plan.floors[i].floorY, `${b.id} flight ${i} does not start on its floor`);
      assert.equal(st.toY, plan.floors[i + 1].floorY, `${b.id} flight ${i} does not end on its floor`);
      assert.ok(Math.abs(st.fromY + st.steps * st.rise - st.toY) < 1e-9);
      assert.equal(st.toY - st.fromY, plan.floors[i].clear + FLOOR_T);
      // The flight has to physically fit in the room, with a landing.
      assert.ok(st.run <= b.d - 2 * WALL_T - 1.0,
        `${b.id}'s ${st.run.toFixed(2)} m flight does not fit a ${b.d.toFixed(1)} m deep room`);
      checked++;
    }
    assert.ok(plan.stairAt, `${b.id} has stairs but nowhere to put them`);
    assert.ok(Math.abs(plan.stairAt.x) < plan.inner.hx, `${b.id}'s flight is inside a wall`);
  }
  assert.ok(checked >= 20, `only ${checked} flights exist to check`);
});

/* ------------------------------------------------------------------ */
/* 3. Registration and reachability                                    */
/* ------------------------------------------------------------------ */

test('every town is registered as a settlement and its ground IS beaten', () => {
  const byId = new Map(SETTLEMENTS.map((s) => [s.id, s]));
  for (const t of TOWNS) {
    const s = byId.get(t.id);
    assert.ok(s, `${t.id} is built but not in SETTLEMENTS - it will render on open pasture`);
    assert.equal(s.displayName, t.displayName);
    assert.ok(s.ground.length > 0, `${t.id} has no ground features`);
    /* The point of registering is `settledAt`, so that is what is checked:
     * beaten earth at the centre of the town, and the grass scatter's own
     * threshold (0.34) cleared at the doorstep of every building in it. */
    assert.ok(settledAt(t.centre.x, t.centre.z) > 0.5,
      `${t.id}'s centre is only ${settledAt(t.centre.x, t.centre.z).toFixed(2)} settled`);
    /* Stilt buildings are exempt and have to be: their doorstep is a plank
     * jetty over open water, and painting trodden ground under it would put
     * mud on the pool. `settledAt` has no idea what it is standing on. */
    const landed = t.buildings.filter((b) => !b.stilt);
    let trodden = 0;
    for (const b of landed) {
      // A metre outside the door, which is where a threshold is.
      const dx = Math.sin(b.yaw) * (b.d / 2 + 1.0);
      const dz = Math.cos(b.yaw) * (b.d / 2 + 1.0);
      if (settledAt(b.x + dx, b.z + dz) > 0.34) trodden++;
    }
    assert.ok(trodden / landed.length > 0.85,
      `${t.id}: only ${trodden}/${landed.length} doorsteps are on beaten earth`);
  }
});

test('every town is reachable from Aldermoor market on roads and crossings', () => {
  const g = roadGraph();
  for (const t of TOWNS) {
    assert.ok(t.entry, `${t.id} declares no entry point`);
    assert.ok(g.distance(t.entry.x, t.entry.z) < 8,
      `${t.id}'s entry is ${g.distance(t.entry.x, t.entry.z).toFixed(1)} m from any road`);
    assert.ok(g.connects(34, 18, t.entry.x, t.entry.z, 12),
      `${t.id} is not connected to the vale's road network`);
  }
});

test('each town declares a radius that covers everything it owns', () => {
  for (const t of TOWNS) {
    for (const b of t.buildings) {
      const reach = Math.hypot(b.x - t.centre.x, b.z - t.centre.z) + Math.hypot(b.w, b.d) / 2;
      assert.ok(reach <= t.radius, `${t.id}'s radius misses ${b.id} by ${(reach - t.radius).toFixed(1)} m`);
    }
  }
});

test('the two river towns are on the banks the brief puts them on', () => {
  const bank = Object.fromEntries(TOWNS.map((t) => [t.id, townBank(t)]));
  // Reedwater and the abbey are across the water from the vale; Grimscar and
  // Blackmarch are not. Computed from `riverZ`, never declared - the channel
  // swings 120 m across the map and a hand-written compass answer would be
  // wrong for half of it.
  assert.equal(bank.reedwater, 'far');
  assert.equal(bank['st-ceolwine'], 'far');
  assert.equal(bank['fenwick-cross'], 'far');
  assert.equal(bank.grimscar, 'vale');
  assert.equal(bank.blackmarch, 'vale');
});

/* ------------------------------------------------------------------ */
/* 4. The build, for real                                              */
/* ------------------------------------------------------------------ */

/**
 * A world that can be built under Node.
 *
 * Physics and materials are stubbed and nothing else is: `_buildTowns` runs
 * the geometry, the colliders, the door pivots and the enterable descriptors
 * exactly as the browser does, so what is asserted below is what ships.
 */
/* `_breathe` gives the frame back to the browser between buildings. Under
 * Node there is no frame; a timeout is the same shape and keeps the yield
 * points honest rather than stubbing them out. */
if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
}

function headlessWorld() {
  const colliders = [];
  const w = new MedievalWorld({
    physics: {
      addBox: (x, y, z, hx, hy, hz) => ({ x, y, z, hx, hy, hz, rotY: 0, solid: true }),
      addRotatedBox: (p, h, rotY) =>
        ({ x: p.x, y: p.y, z: p.z, hx: h.x, hy: h.y, hz: h.z, rotY, solid: true }),
    },
  });
  w.track = (c) => { colliders.push(c); return c; };
  w.testColliders = colliders;
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true });
  w._mats = new Proxy({}, { get: () => mat, has: () => true });
  return w;
}

/** True when (x, y, z) is inside a collider, honouring its Y rotation. */
function insideCollider(c, x, y, z) {
  if (Math.abs(y - c.y) > c.hy) return false;
  const dx = x - c.x;
  const dz = z - c.z;
  const co = Math.cos(c.rotY || 0);
  const si = Math.sin(c.rotY || 0);
  // Inverse of Matrix4.makeRotationY(rotY), which is what addRotatedBox builds.
  const lx = dx * co - dz * si;
  const lz = dx * si + dz * co;
  return Math.abs(lx) <= c.hx && Math.abs(lz) <= c.hz;
}

let BUILT = null;
async function built() {
  if (!BUILT) {
    const w = headlessWorld();
    await w._buildTowns();
    BUILT = w;
  }
  return BUILT;
}

test('_buildTowns produces one walkable interior per enterable building', async () => {
  const w = await built();
  const want = ALL.filter((b) => b.enterable).length;
  assert.equal(w.enterables.length, want, 'enterable descriptors do not match the table');
  assert.ok(want >= 50, `only ${want} enterable buildings across five towns`);
  for (const e of w.enterables) {
    assert.ok(e.origin instanceof THREE.Vector3);
    assert.equal(e.doors.length, 1, `${e.label} has ${e.doors.length} doors`);
    assert.ok(e.collectibleSpots.length >= 1);
  }
});

test('every door has a leaf on a pivot that actually swings', async () => {
  const w = await built();
  for (const e of w.enterables) {
    const d = e.doors[0];
    assert.ok(d.id && typeof d.id === 'string');
    assert.equal(d.leaves.length, 1);
    const leaf = d.leaves[0];
    assert.ok(leaf.pivot && leaf.pivot.isObject3D, `${e.label}: door has no pivot`);
    assert.ok(leaf.pivot.children.length >= 1, `${e.label}: door pivot carries no leaf mesh`);
    // The pivot is a HINGE: it must open by a real angle and start closed.
    assert.ok(Math.abs(leaf.open - leaf.closed) > 1.0,
      `${e.label}: the door opens by ${(leaf.open - leaf.closed).toFixed(2)} rad`);
    assert.equal(leaf.pivot.rotation.y, leaf.closed);
    assert.equal(d.open, false);
    // The doorway collider is what the interior system toggles; without it the
    // door is a picture of a door.
    assert.ok(d.collider && d.collider.solid === true, `${e.label}: no doorway collider`);
    assert.ok(d.position instanceof THREE.Vector3);
    // The pivot must be at the doorway, not at the origin.
    assert.ok(leaf.pivot.position.distanceTo(e.origin) < 20,
      `${e.label}: the door pivot is nowhere near its building`);
  }
});

test('you can stand inside: a floor under you, headroom over you, nothing between', async () => {
  const w = await built();
  const cols = w.testColliders;
  const enterables = ALL.filter((b) => b.enterable);
  let checked = 0;
  for (const b of enterables) {
    const plan = interiorPlan(b);
    const g = groundUnder(b, (x, z) => medievalHeight(x, z));
    const baseY = b.stilt ? b.deck : g.baseY;
    /* The point the plan DECLARES clear, not a point this test guessed.
     * Guessing found the abbey church's choir stalls and reported a building
     * nobody could enter; a nave with stalls down the middle of it is correct.
     * `interiorPlan.standing` is the contract every furnishing pass has to
     * respect, so it is the contract this probes. */
    const lx = plan.standing.x;
    const lz = plan.standing.z;
    const co = Math.cos(b.yaw);
    const si = Math.sin(b.yaw);
    const px = b.x + lx * co + lz * si;
    const pz = b.z - lx * si + lz * co;
    const floorY = baseY + plan.floors[0].floorY;
    const near = cols.filter((c) => Math.abs(c.x - b.x) < 40 && Math.abs(c.z - b.z) < 40);
    // 1. Something solid holds the player up at the floor line.
    const hasFloor = near.some((c) => insideCollider(c, px, floorY - 0.14, pz));
    assert.ok(hasFloor, `${b.town}/${b.id}: no floor collider under the interior`);
    // 2. Nothing solid occupies the standing volume. 1.75 m capsule, probed
    //    from ankle to crown.
    for (let h = 0.25; h <= 1.75; h += 0.25) {
      const blocked = near.find((c) => insideCollider(c, px, floorY + h, pz));
      assert.ok(!blocked,
        `${b.town}/${b.id}: solid at ${h.toFixed(2)} m above the floor - the room is not enterable`);
    }
    // 3. And a ceiling above that, so it is a ROOM and not an open box.
    const ceil = baseY + plan.floors[0].ceilY;
    const hasCeil = near.some((c) => insideCollider(c, px, ceil + 0.1, pz));
    assert.ok(hasCeil, `${b.town}/${b.id}: no ceiling over the ground storey`);
    checked++;
  }
  assert.ok(checked >= 50, `only ${checked} interiors probed`);
});

test('the doorway is a hole in the wall, not a picture of one', async () => {
  const w = await built();
  const cols = w.testColliders;
  for (const b of ALL) {
    if (!b.enterable) continue;
    const plan = interiorPlan(b);
    const g = groundUnder(b, (x, z) => medievalHeight(x, z));
    const baseY = b.stilt ? b.deck : g.baseY;
    const co = Math.cos(b.yaw);
    const si = Math.sin(b.yaw);
    // Dead centre of the opening, 1.2 m up - head height for a stooping adult.
    const lz = b.d / 2 - WALL_T / 2;
    const px = b.x + lz * si;
    const pz = b.z + lz * co;
    const y = baseY + plan.door.y + 1.2;
    const near = cols.filter((c) => Math.abs(c.x - b.x) < 30 && Math.abs(c.z - b.z) < 30);
    const solid = near.filter((c) => insideCollider(c, px, y, pz));
    /* Exactly one thing may be there and it is the door leaf's own collider,
     * which the interior system clears when the door opens. Two would mean the
     * wall was never cut. */
    assert.ok(solid.length <= 1,
      `${b.town}/${b.id}: ${solid.length} colliders fill the doorway - the wall was not cut`);
  }
});

test('multi-storey shells have a stair a player can climb, step by step', async () => {
  const w = await built();
  const cols = w.testColliders;
  let checked = 0;
  for (const b of ALL) {
    if (!b.enterable || b.storeys < 2) continue;
    const plan = interiorPlan(b);
    const g = groundUnder(b, (x, z) => medievalHeight(x, z));
    const baseY = b.stilt ? b.deck : g.baseY;
    const co = Math.cos(b.yaw);
    const si = Math.sin(b.yaw);
    const near = cols.filter((c) => Math.abs(c.x - b.x) < 40 && Math.abs(c.z - b.z) < 40);
    for (const st of plan.stairs) {
      for (let i = 0; i < st.steps; i++) {
        const lz = st.z0 + st.dir * (i + 0.5) * st.tread;
        const px = b.x + st.x * co + lz * si;
        const pz = b.z - st.x * si + lz * co;
        const treadTop = baseY + st.fromY + (i + 1) * st.rise;
        // Solid just under the tread...
        assert.ok(near.some((c) => insideCollider(c, px, treadTop - 0.06, pz)),
          `${b.town}/${b.id}: flight ${st.storey} step ${i} has no collider`);
        /* ...and clear air above it. This is the probe that found the stacked
         * flights in the three-storey shells: two flights in one well climbing
         * the same way put the second one's underside at head height over the
         * first, and every other property of both staircases was correct. */
        assert.ok(!near.some((c) => insideCollider(c, px, treadTop + 0.9, pz)),
          `${b.town}/${b.id}: flight ${st.storey} step ${i} is blocked overhead`);
      }
      // The top step's surface IS the floor it serves.
      const topY = baseY + st.fromY + st.steps * st.rise;
      assert.ok(Math.abs(topY - (baseY + plan.floors[st.storey + 1].floorY)) < 1e-9,
        `${b.town}/${b.id}: flight ${st.storey} ends off its floor`);
      // And there is somewhere to stand when you get there.
      const lz = st.z0 + st.dir * (st.run + 0.6);
      const px = b.x + st.x * co + lz * si;
      const pz = b.z - st.x * si + lz * co;
      assert.ok(near.some((c) => insideCollider(c, px, topY - 0.12, pz)),
        `${b.town}/${b.id}: flight ${st.storey} arrives at a hole in the deck`);
      checked++;
    }
  }
  assert.ok(checked >= 20, `only ${checked} staircases built`);
});

test('two flights in one shell never stack on top of each other', () => {
  /* The dog-leg, as a property rather than as a comment. A shell too shallow
   * for two runs plus a landing would put flight n+1 back over flight n, which
   * is the defect the headless probe above caught. Checked over the table, so
   * a narrow three-storey building added later fails here first. */
  for (const b of ALL) {
    if (b.storeys < 3) continue;
    const plan = interiorPlan(b);
    for (let i = 1; i < plan.stairs.length; i++) {
      const a = plan.stairs[i - 1];
      const c = plan.stairs[i];
      const az0 = Math.min(a.z0, a.z0 + a.dir * a.run);
      const az1 = Math.max(a.z0, a.z0 + a.dir * a.run);
      const cz0 = Math.min(c.z0, c.z0 + c.dir * c.run);
      const cz1 = Math.max(c.z0, c.z0 + c.dir * c.run);
      assert.ok(az1 < cz0 - 0.5 || cz1 < az0 - 0.5,
        `${b.town}/${b.id}: flights ${i - 1} and ${i} occupy the same well`);
    }
    // ...which is only possible if the room is deep enough to hold both.
    const run = plan.stairs[0].run;
    assert.ok(plan.inner.hz * 2 >= run * 2 + 1.0,
      `${b.town}/${b.id} is too shallow (${(plan.inner.hz * 2).toFixed(1)} m) for a dog-leg`);
  }
});

test('the towns are built as districts, not as one map-wide mesh', async () => {
  const w = await built();
  /* The pattern this whole file's cost argument rests on: a town is merged per
   * material key into ITS OWN batch, so its meshes carry a bounding sphere the
   * size of the town and frustum-cull as a unit. One batch for all five would
   * merge just as well and would then be in frustum from everywhere. */
  const spheres = [];
  w.group.traverse((o) => {
    if (o.isMesh && o.geometry.boundingSphere) spheres.push(o.geometry.boundingSphere.radius);
  });
  assert.ok(spheres.length > 0);
  const worst = Math.max(...spheres);
  assert.ok(worst < 130,
    `a town mesh has a ${worst.toFixed(0)} m bounding sphere - the districts have been merged`);
});

test('the build stays inside its triangle and draw-call budget', async () => {
  const w = await built();
  let draws = 0;
  let triangles = 0;
  w.group.traverse((o) => {
    if (!o.isMesh) return;
    draws++;
    const g = o.geometry;
    triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });
  /* Measured, then pinned with headroom. Eighty-one buildings and fifty-four
   * dressed interiors across five districts: ~177k triangles and ~116 draw
   * calls, of which 54 are the door leaves (one mesh each - the iron straps
   * are merged into the leaf and carried as vertex colour, because three
   * meshes per door would have been 162 draw calls of door furniture, more
   * than the five districts they hang on).
   *
   * The bound is here so the next person to add a town finds out what it
   * costs before a browser does. */
  assert.ok(triangles < 260000, `the ring towns draw ${Math.round(triangles)} triangles`);
  assert.ok(draws < 150, `the ring towns cost ${draws} draw calls`);
  assert.ok(triangles > 90000, `only ${Math.round(triangles)} triangles - a town has gone missing`);
});

/* ------------------------------------------------------------------ */
/* 5. Determinism                                                      */
/* ------------------------------------------------------------------ */

test('the same seed builds the same world, to the bit', async () => {
  /* Everything in this phase is seeded - `mulberry32` off the town's own
   * coordinates, a fixed seed per shell, a stable hash for the stand species -
   * and every one of those is a place a `Math.random()` could be introduced
   * without anything failing. It would fail exactly once, in a screenshot
   * comparison two months from now, on a build nobody could reproduce.
   *
   * So the whole district is digested twice. Vertex positions AND colours,
   * because the per-object variation (plaster tint, beam stain, roof slate)
   * lives in the colour attribute and is the half most likely to drift. */
  const digest = async () => {
    const w = headlessWorld();
    await w._buildTowns();
    w._buildCamps();
    const h = createHash('sha256');
    const meshes = [];
    w.group.traverse((o) => { if (o.isMesh) meshes.push(o); });
    // Sorted, because two builds may parent in a different order without the
    // world being different - what is being pinned is the geometry.
    meshes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      || a.geometry.attributes.position.count - b.geometry.attributes.position.count);
    for (const m of meshes) {
      const g = m.geometry;
      h.update(m.name || '');
      h.update(Buffer.from(new Float32Array(g.attributes.position.array).buffer));
      if (g.attributes.color) {
        h.update(Buffer.from(new Float32Array(g.attributes.color.array).buffer));
      }
    }
    // Colliders, doors and glows are just as much "the world".
    h.update(String(w.testColliders.length));
    for (const c of w.testColliders) h.update(`${c.x},${c.y},${c.z},${c.hx},${c.hy},${c.hz},${c.rotY}`);
    for (const e of w.enterables) h.update(`${e.label}|${e.origin.toArray().join(',')}`);
    for (const g of w._glows) h.update(`${g.x},${g.y},${g.z},${g.r}`);
    return h.digest('hex');
  };
  const a = await digest();
  const b = await digest();
  assert.equal(a, b, 'two builds of the ring towns and camps differ - something is unseeded');
});
