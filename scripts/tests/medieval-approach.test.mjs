/**
 * THE APPROACH GATE - can you actually GET to the thing that was built?
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 * A browser pass over the expanded world found fifteen of the fifty-four
 * enterable town buildings could not be entered, two of the five river
 * crossings could not be stepped onto, and eleven trees were growing inside
 * St Ceolwine's precinct wall with two of them in the cloister garth. A
 * 1074-test suite saw none of it, and the reason is worth writing down,
 * because it is the same reason every time:
 *
 *   every existing test asks whether a thing was BUILT correctly, and no test
 *   asked whether a player standing outside it could reach it.
 *
 * `medieval-towns.test.mjs` proves each interior has a floor, a ceiling, a cut
 * doorway, headroom at the declared standing point and a staircase whose treads
 * sum to the storey above. All of that was true of the winding house, whose
 * threshold stood 2.03 m over the street outside its own door. The building was
 * perfect and the doorstep was a wall.
 *
 * So everything here probes from OUTSIDE, walking in:
 *
 *   1. the doors      - march a probe at the door from fifteen bearings and
 *                       measure every rise it would have to climb;
 *   2. the crossings   - walk the deck end to end, three lanes wide;
 *   3. the interiors   - a room that is modelled and unlit is a room that was
 *                       not built, so every enterable has to own a light;
 *   4. the ground      - nothing woody may grow on a settlement's own core.
 *
 * The world is built for real under Node against a stub physics and a stub
 * material set, exactly as `medieval-towns.test.mjs` does it, so the colliders
 * probed here are the colliders that ship.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as THREE from 'three';

import { CONFIG } from '../../src/core/Config.js';
import { medievalHeight, rectDist } from '../../src/worlds/terrain/MedievalHeight.js';
import { SETTLEMENTS, settledAt, inSettlementCore, CORE_SETTLED }
  from '../../src/worlds/medieval/Settlements.js';
import { CROSSINGS, ROADS } from '../../src/worlds/medieval/RoadNet.js';
import {
  TOWNS, allBuildings, plinthCourses, hasChimney, ECCLESIASTICAL, groundUnder,
  GRIMSCAR_WORKINGS,
} from '../../src/worlds/medieval/Towns.js';
import { MedievalWorld } from '../../src/worlds/MedievalWorld.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORLD_SRC = readFileSync(path.join(root, 'src/worlds/MedievalWorld.js'), 'utf8');

/* `_breathe` hands the frame back to the browser between buildings. Under Node
 * there is no frame; a timeout is the same shape and keeps the yield points
 * honest rather than stubbing them out. */
if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
}

/* ------------------------------------------------------------------ */
/* The harness                                                         */
/* ------------------------------------------------------------------ */

/**
 * A world that can be built under Node.
 *
 * Only physics and materials are stubbed. The material stub hands back a
 * DISTINCT material per key with the key on it, which is what lets the
 * vegetation test below tell a leaf card from a barrel without the world
 * having to label anything for the benefit of a test.
 */
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
  const mats = new Map();
  w._mats = new Proxy({}, {
    get: (_t, k) => {
      if (typeof k !== 'string') return undefined;
      let m = mats.get(k);
      if (!m) {
        m = new THREE.MeshStandardMaterial({ vertexColors: true });
        m.userData.key = k;
        mats.set(k, m);
      }
      return m;
    },
    has: () => true,
  });
  return w;
}

/** True when (x, z) is inside a collider's footprint, honouring its Y rotation. */
function overlaps(c, x, z) {
  const dx = x - c.x;
  const dz = z - c.z;
  const co = Math.cos(c.rotY || 0);
  const si = Math.sin(c.rotY || 0);
  // Inverse of Matrix4.makeRotationY(rotY), which is what addRotatedBox builds.
  return Math.abs(dx * co - dz * si) <= c.hx && Math.abs(dx * si + dz * co) <= c.hz;
}

/**
 * The surface a walker standing at `fromY` would find at (x, z).
 *
 * Terrain, or the top of the highest collider over it - but only counting
 * colliders whose UNDERSIDE is within a step of where the walker already is.
 * Without that clause a jettied burgage plot reports its own first floor as
 * the ground outside its door, because the overhang really is directly above
 * the doorstep and really is solid; you walk under it.
 *
 * Deliberately not the player's own `groundHeight` probe, which only looks in a
 * step-height window and so cannot see the wall it is jammed against: this is
 * the thing that probe has to be measured against, and giving it the same blind
 * spot would make the test agree with the bug.
 */
function surfaceAt(near, x, z, fromY) {
  let y = medievalHeight(x, z);
  const head = fromY + CONFIG.player.stepHeight;
  for (let i = 0; i < near.length; i++) {
    const c = near[i];
    if (!overlaps(c, x, z)) continue;
    if (c.y - c.hy > head) continue;          // an overhang, not a floor
    const top = c.y + c.hy;
    if (top > y) y = top;
  }
  return y;
}

let BUILT = null;
/** The towns, the village and the riverside, built once for the whole file. */
async function built() {
  if (!BUILT) {
    const w = headlessWorld();
    // The village dressing reads `_roadPaths`, which `_buildTerrain` would
    // normally have filled in by now.
    w._buildRoadPaths();
    w._buildVillage();
    w._buildRiverside();
    await w._buildTowns();
    BUILT = w;
  }
  return BUILT;
}

/* ------------------------------------------------------------------ */
/* 1. Every door can be walked to                                      */
/* ------------------------------------------------------------------ */

/**
 * Distances to start the walk from, longest first.
 *
 * 4.5 m clears the deepest flight of steps in the world. It also lands inside
 * the neighbour on a street four metres wide, which Aldermoor and Fenwick both
 * have - so a bearing that starts inside something is retried from closer
 * before it is given up on. Two metres is still outside every apron and is a
 * distance a player genuinely stands at; a door that cannot be reached from
 * two metres directly in front of it cannot be reached.
 */
const APPROACH = [4.5, 3.0, 2.0];
/** Sample spacing along the walk in. */
const STRIDE = 0.2;
/**
 * The rise a probe may climb in one stride.
 *
 * `stepHeight` less a real margin, because the player's step probe casts along
 * the direction of TRAVEL: a rise that is exactly at the limit head-on is past
 * it the moment the approach is diagonal, which is precisely how eleven
 * buildings in the 0.30-0.45 m band shipped "reachable" and were not.
 */
const RISE_LIMIT = CONFIG.player.stepHeight - 0.07;
/**
 * The line between "ground you have to be able to walk up" and "a thing you
 * walk round".
 *
 * Waist height. Below it, a rise is a change of GROUND LEVEL - a plinth, a
 * terrace, a threshold - and the player has to be able to climb it or the
 * building is unreachable. Above it, it is an object or a wall: somebody
 * else's gable, the abbey's cloister arcade, a stack of crates outside the
 * tavern, the precinct wall. Those bearings are DISCARDED rather than failed,
 * because walking round a crate is not a defect.
 *
 * What stops the discard from excusing the original bug is that it is only
 * ever applied per bearing. The winding house's 2.03 m sill discarded EVERY
 * bearing, and a door with nothing left to approach it by fails the head-on
 * and the count assertions below - which are louder, and which is right,
 * because that is a worse defect than a step.
 */
const WALL = 0.9;

/** How far a raised surface must hold before it counts as ground. */
const SUSTAIN = 4;

/**
 * The largest rise a walker actually has to climb along a surface profile.
 *
 * A rise only counts if the raised level is still there 0.6 m further on.
 * Without that clause a barrel outside the tavern is a 1.01 m "step": the
 * profile goes up for two samples and straight back down, which is not a
 * change of ground level, it is an object, and the answer to an object in
 * your path is to walk round it. A terrace, a plinth or a stair tread does
 * not come back down, which is exactly what makes it a step.
 */
function worstStep(profile) {
  let worst = 0;
  for (let i = 1; i < profile.length; i++) {
    let sustained = profile[i];
    for (let k = 1; k < SUSTAIN && i + k < profile.length; k++) {
      if (profile[i + k] < sustained) sustained = profile[i + k];
    }
    const rise = sustained - profile[i - 1];
    if (rise > worst) worst = rise;
  }
  return worst;
}

/**
 * Walk a straight line, sampling the surface a walker would find.
 *
 * `seed` is where the walker is standing at the start, and it matters: the
 * surface query only accepts a collider whose underside is within a step of
 * where you already are, so a walk seeded at terrain level cannot climb onto
 * Reedwater's deck 2.5 m above the pool bed - it would report the whole
 * village as unreachable while the player is standing on it. Long approaches
 * seed at the terrain, because a walk that started on a neighbour's roof would
 * descend all the way in and report clear.
 */
function profileAlong(near, x0, z0, dx, dz, len, seed = null) {
  const out = [];
  let prev = seed === null ? medievalHeight(x0, z0) : seed;
  for (let t = 0; t <= len + 1e-6; t += STRIDE) {
    prev = surfaceAt(near, x0 + dx * t, z0 + dz * t, prev);
    out.push(prev);
  }
  return out;
}

/**
 * Walk an arbitrary polyline of (x, z) points, sampling the surface a walker
 * would find, in the order given.
 *
 * The straight-line `profileAlong` above cannot express "along the road, then
 * off its end onto the deck", which is the walk that matters for a crossing.
 */
function profileThrough(near, pts, seed = null) {
  const out = [];
  let prev = seed === null ? medievalHeight(pts[0][0], pts[0][1]) : seed;
  for (const [x, z] of pts) {
    prev = surfaceAt(near, x, z, prev);
    out.push(prev);
  }
  return out;
}

/** Resample a polyline at `STRIDE`, endpoint included. */
function densify(pts, stride = STRIDE) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(len / stride));
    for (let k = 0; k < n; k++) out.push([ax + (bx - ax) * (k / n), az + (bz - az) * (k / n)]);
  }
  out.push(pts[pts.length - 1].slice());
  return out;
}

/**
 * March a probe at one door along one bearing, retrying from closer if the
 * long start lands inside somebody else's gable.
 * @returns {{blocked:boolean, worst:number}}
 */
function approach(near, doorX, doorZ, ox, oz) {
  for (const R of APPROACH) {
    const worst = worstStep(profileAlong(near, doorX + ox * R, doorZ + oz * R, -ox, -oz, R));
    if (worst <= WALL) return { blocked: false, worst };
  }
  return { blocked: true, worst: 0 };
}

test('every enterable door can be walked to, from any bearing that is not a wall', async () => {
  const w = await built();
  const cols = w.testColliders;
  let checked = 0;
  for (const e of w.enterables) {
    const door = e.doors[0];
    assert.ok(door?.position, `${e.label}: no door position to approach`);
    /* The outward normal, taken from the descriptor rather than from the
     * layout table: `_house`, `_shell` and `InteriorKit` all publish an origin
     * and a door point, and the vector between them is the way you come in.
     * That is the only thing the three builders agree on, which is exactly why
     * it is the thing to test against. */
    let nx = door.position.x - e.origin.x;
    let nz = door.position.z - e.origin.z;
    const nl = Math.hypot(nx, nz);
    if (nl < 0.5) continue;             // a door on the centreline: nothing to aim at
    nx /= nl;
    nz /= nl;
    const dx = door.position.x + nx * 0.35;
    const dz = door.position.z + nz * 0.35;
    const near = cols.filter((c) => Math.abs(c.x - dx) < 40 && Math.abs(c.z - dz) < 40);

    let usable = 0;
    let headOn = false;
    let worst = 0;
    let worstAt = 0;
    for (let deg = -70; deg <= 70; deg += 10) {
      const a = (deg * Math.PI) / 180;
      const ox = nx * Math.cos(a) + nz * Math.sin(a);
      const oz = nz * Math.cos(a) - nx * Math.sin(a);
      const r = approach(near, dx, dz, ox, oz);
      if (r.blocked) continue;
      usable++;
      if (deg === 0) headOn = true;
      if (r.worst > worst) { worst = r.worst; worstAt = deg; }
    }
    assert.ok(worst <= RISE_LIMIT,
      `${e.label}: walking in at ${worstAt} deg needs a ${worst.toFixed(2)} m step, `
      + `and the player can climb ${CONFIG.player.stepHeight}`);
    /* Head-on has to work for every door in the world. This is the assertion
     * the winding house failed: its sill stood 2.03 m over the street, so the
     * straight-in approach was a wall from every distance and the interaction
     * prompt never appeared at all. */
    assert.ok(headOn, `${e.label}: cannot be approached straight at the door`);
    assert.ok(usable >= 6,
      `${e.label}: only ${usable} of 15 bearings reach the door - it is walled in`);
    checked++;
  }
  assert.ok(checked >= 70, `only ${checked} doors probed`);
});

test('you can step over the threshold and be standing on the floor', async () => {
  /* The approach test above stops at the doorway. This one walks THROUGH it -
   * from a stride and a half outside to well inside the room - because the
   * last two risers are the ones the shell never built: the ground outside,
   * the threshold stone, and then the interior floor deck, which sits at
   * `FLOOR_RISE` above the shell's base whatever the ground outside is doing.
   *
   * The door's own collider is excluded, and only that one. It is solid
   * because the leaf is shut, and it is the one thing in the world that gets
   * out of the way when you walk at it. */
  const w = await built();
  const cols = w.testColliders;
  let checked = 0;
  for (const e of w.enterables) {
    const door = e.doors[0];
    let nx = door.position.x - e.origin.x;
    let nz = door.position.z - e.origin.z;
    const nl = Math.hypot(nx, nz);
    if (nl < 0.5) continue;
    nx /= nl;
    nz /= nl;
    const near = cols.filter((c) => c !== door.collider
      && Math.abs(c.x - door.position.x) < 25 && Math.abs(c.z - door.position.z) < 25);
    /* Starts 0.6 m outside the door and not further, which is where the
     * approach test above finishes - so between them the two cover the walk
     * from four metres out to standing in the room with no gap. Further out
     * than that is off the end of Reedwater's deck and into the pool, and a
     * stilt house is reached along a jetty, not by wading. */
    const sx = door.position.x + nx * 0.4;
    const sz = door.position.z + nz * 0.4;
    const worst = worstStep(profileAlong(
      near, sx, sz, -nx, -nz, 1.8, surfaceAt(near, sx, sz, Infinity)
    ));
    assert.ok(worst <= RISE_LIMIT,
      `${e.label}: getting over its threshold means a ${worst.toFixed(2)} m step`);
    checked++;
  }
  assert.ok(checked >= 70, `only ${checked} thresholds crossed`);
});

/* ------------------------------------------------------------------ */
/* 2. Every interior is lit                                            */
/* ------------------------------------------------------------------ */

test('every enterable interior owns at least one light', async () => {
  /* Not one of the fifty-four town interiors had a light in it. They had glow
   * CARDS - additive quads - and emissive window glass, and neither of those
   * lights anything: measured mean frame luminance inside the five landmark
   * interiors was 11-20 out of 255, one frame at 0, with every piece of
   * dressing modelled and invisible.
   *
   * Asserted off the descriptor rather than by walking the scene graph,
   * because "which light belongs to which room" is the thing that has to be
   * true, and a stray point light forty metres away in the street would
   * satisfy a proximity test while lighting nothing. */
  const w = await built();
  for (const e of w.enterables) {
    assert.ok(Array.isArray(e.lights) && e.lights.length > 0,
      `${e.label}: an enterable interior with no light in it`);
    for (const l of e.lights) {
      assert.ok(l.isPointLight, `${e.label}: light is not a point light`);
      assert.ok(l.intensity > 0, `${e.label}: its light is dark`);
      assert.ok(l.distance > 0, `${e.label}: its light has no cut-off, so it lights the town`);
      // Inside the building it belongs to, not somewhere near it.
      assert.ok(Math.hypot(l.position.x - e.origin.x, l.position.z - e.origin.z) < 24,
        `${e.label}: its light is not in the building`);
    }
  }
  assert.ok(w.enterables.length >= 70);
});

/**
 * Everything one interior's lamps deliver, as a single number.
 *
 * Intensity summed, not counted and not maxed: a room lit by two lamps of 46
 * and a room lit by one of 92 have the same claim on the eye, and a rule that
 * looked at either alone could be satisfied by splitting one lamp in two or by
 * doubling one and leaving the far end black.
 */
function lumens(e) {
  return e.lights.reduce((s, l) => s + l.intensity, 0);
}

test('a big room gets more light than a small one, by area and not by width', async () => {
  /* THE DEFECT. `_shellInterior` sized the lamp count on `round(w / 12)` and
   * `_interiorLight` used a flat 46 whatever the room, so the amount of light
   * in a room depended on ONE of its two plan dimensions and on nothing else.
   * The Marcher Hall is 14 x 11.5 m - 161 m2, bigger in plan than eight of the
   * ten rooms that already had two lamps - and got one lamp of 46, the same as
   * a 5 x 4 m fisherman's hut. Measured mean frame luminance, four headings,
   * viewmodel light neutralised: 25.9 out of 255 against 37.4 in the Guildhall,
   * and it read as one pool on a black floor.
   *
   * Held as a monotone property rather than as a table of expected values,
   * because the point is the RULE and not the two rooms that exposed it. */
  const w = await built();
  const rooms = w.enterables
    .map((e) => {
      // Plan extent from the lamps' own spread plus their reach, which is what
      // the builder sized off the room - the descriptor carries no dimensions.
      const reach = Math.max(...e.lights.map((l) => l.distance));
      return { label: e.label, reach, total: lumens(e), n: e.lights.length };
    })
    .sort((a, b) => a.reach - b.reach);

  const small = rooms[0];
  const big = rooms[rooms.length - 1];
  assert.ok(big.reach > small.reach * 1.5,
    'every interior is the same size - this test has nothing to compare');
  assert.ok(big.total > small.total * 1.5,
    `the biggest room (${big.label}, reach ${big.reach.toFixed(1)} m) gets ${big.total} of light `
    + `and the smallest (${small.label}, reach ${small.reach.toFixed(1)} m) gets ${small.total}`);

  /* And monotonically, not just at the extremes: bucket by reach and assert the
   * mean light per room never falls as rooms get bigger. This is what the old
   * width-only rule failed - a room could be half again as large in plan and
   * get strictly less light, because its width happened to round down. */
  const buckets = [[0, 9], [9, 12], [12, 15], [15, 99]];
  const means = buckets.map(([lo, hi]) => {
    const rs = rooms.filter((r) => r.reach >= lo && r.reach < hi);
    return rs.length ? rs.reduce((s, r) => s + r.total, 0) / rs.length : null;
  });
  const seen = means.filter((m) => m !== null);
  assert.ok(seen.length >= 3, `only ${seen.length} size bands of interior in the world`);
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i] > seen[i - 1],
      `interiors in size band ${i} average ${seen[i].toFixed(0)} of light and the smaller `
      + `band ${i - 1} averages ${seen[i - 1].toFixed(0)} - light does not follow the room`);
  }

  /* The two rooms the browser pass measured as unreadable, named, because a
   * monotone rule can be satisfied while still leaving these two at 46. Both
   * are big in PLAN and neither is wide enough for the width rule to notice:
   * 14 x 11.5 and 10.5 x 8.4. */
  for (const label of ['The Marcher Hall', 'The Stilthouse']) {
    const e = w.enterables.find((k) => k.label === label);
    assert.ok(e, `${label} has gone from the world`);
    const perStorey = lumens(e) / e.lights.length * (e.lights.length / new Set(
      e.lights.map((l) => l.position.y.toFixed(2))
    ).size);
    assert.ok(perStorey > 46 * 1.6,
      `${label} still gets ${perStorey.toFixed(0)} of light per storey - it measured `
      + '25.9 and 26.6 out of 255 at 46, which is a pool of light on a black floor');
  }
});

test('interior lights are sources for the rig, not extra slots in the shader', () => {
  /* The load-bearing claim behind adding eighty of them. `gfx/LightRig.js` owns
   * a fixed set of slots and every other light in the game is hidden and pooled
   * into them, so the light COUNTS in Three's program cache key never move. If
   * that ever stopped being true, this many practicals would be a 60 s shader
   * stall rather than a rounding error - see the measurements in LightRig's own
   * docstring. */
  const rig = readFileSync(path.join(root, 'src/gfx/LightRig.js'), 'utf8');
  assert.match(rig, /point:\s*\d+/, 'the rig no longer declares a fixed point budget');
  assert.match(rig, /if \(obj\.visible\) obj\.visible = false;/,
    'the rig no longer hides the lights it claims - every world light is back in the count');
  assert.match(WORLD_SRC, /_interiorLight\(/, 'the interior lamp helper has gone');
});

/* ------------------------------------------------------------------ */
/* 3. Every crossing can be reached ON THE ROADS THAT SERVE IT         */
/* ------------------------------------------------------------------ */

/**
 * ── Why this test was rewritten, which matters more than the bug ────────
 * The first version of it walked each crossing ALONG ITS OWN AXIS: three lanes
 * up the deck's centreline from ten metres short of one abutment to ten metres
 * past the other. It passed, and Harrowgate Bridge still could not be walked
 * onto - the player jammed at (307.8, 2.2, 104.8) on `harrowbridgeN`, the
 * identical coordinate as before the fix that the test certified.
 *
 * The reason is the same one that let fifteen unenterable buildings ship: the
 * test exercised the STRUCTURE and not the APPROACH TO IT. `harrowbridgeN` is
 * `[[296,112],[304,108],[311,104]]` - it arrives at 30 degrees off the deck's
 * axis, onto the abutment's west cheek, which the axial walk never touches
 * because the axial walk is already on top of the abutment when it starts.
 * A causeway with no lateral flare is a ramp head-on and a wall from anywhere
 * else, and only a probe that arrives on a real bearing can tell the two apart.
 *
 * So this walks the ROAD NETWORK: for each end of each crossing, find the road
 * the network actually reaches it by, walk the last 26 m of that road, step off
 * its end to the crossing's own abutment point, and cross. Both ends, both
 * directions of travel.
 */

/** How much of the serving road to walk before stepping off it, metres. */
const APPROACH_RUN = 26;
/**
 * How far a road may be from a crossing's abutment and still be said to serve
 * it. Ashlea's plank bridge is the case that sets this: it stands 12 m
 * downstream of its own ford so that carts take the water and walkers take the
 * planks, and the nearest carriageway sample is 9 m from its northern
 * abutment. A crossing with nothing inside this is not served by the network at
 * all, which is a louder defect than a step and is asserted as one.
 */
const SERVED_WITHIN = 22;

/** Every road resampled once, at the walk's own stride. */
const ROAD_WALKS = ROADS.map((r) => ({ key: r.key, pts: densify(r.pts) }));

/**
 * The road a traveller actually reaches (x, z) on, and every place they could
 * step off it to do so.
 *
 * The step-off point is deliberately NOT fixed at the nearest sample. A player
 * leaving the carriageway for a bridge head leaves it wherever the bridge head
 * is convenient, and at Ashlea that is 6 m up the road from the closest point:
 * the plank bridge stands 12 m downstream of its own ford, and the line that
 * happens to be shortest arrives broadside onto the deck's flank, which is a
 * parapet and is meant to be a wall. So every sample within `SERVED_WITHIN` is
 * a candidate and the end passes if ANY of them gets you on - which is exactly
 * the claim being made, that the crossing is reachable on foot from its road.
 */
function servingRoad(x, z) {
  let best = null;
  for (const r of ROAD_WALKS) {
    for (let i = 0; i < r.pts.length; i++) {
      const d = Math.hypot(r.pts[i][0] - x, r.pts[i][1] - z);
      if (!best || d < best.d) best = { d, road: r, i };
    }
  }
  const road = best.road;
  const span = Math.round(APPROACH_RUN / STRIDE);
  const offs = [];
  // Every ~1.5 m of carriageway inside the serve radius, and the nearest point
  // always, whichever side of the road's own length it falls on.
  for (let i = 0; i < road.pts.length; i++) {
    const d = Math.hypot(road.pts[i][0] - x, road.pts[i][1] - z);
    if (d > SERVED_WITHIN) continue;
    if (i !== best.i && i % Math.round(1.5 / STRIDE) !== 0) continue;
    const runs = [];
    if (i > 0) runs.push(road.pts.slice(Math.max(0, i - span), i + 1));
    if (i < road.pts.length - 1) {
      runs.push(road.pts.slice(i, Math.min(road.pts.length, i + span + 1)).reverse());
    }
    for (const run of runs) offs.push({ at: road.pts[i], d, run });
  }
  return { key: road.key, d: best.d, offs };
}

test('every crossing can be walked onto from the roads that serve it, both ends', async () => {
  const w = await built();
  const cols = w.testColliders;
  let checked = 0;
  for (const c of CROSSINGS) {
    const midZ = (c.from[1] + c.to[1]) / 2;
    const near = cols.filter((k) => Math.abs(k.x - c.x) < 80 && Math.abs(k.z - midZ) < 80);
    for (const [end, far] of [[c.from, c.to], [c.to, c.from]]) {
      const s = servingRoad(end[0], end[1]);
      assert.ok(s.d <= SERVED_WITHIN,
        `${c.id}: its abutment at (${end[0]}, ${end[1]}) is ${s.d.toFixed(1)} m from the `
        + 'nearest road - no road in the network serves this end of the crossing');
      let best = Infinity;
      let bestAt = null;
      for (const off of s.offs) {
        /* road ... step-off point ... abutment ... the far abutment, all at one
         * stride, so the bank between the carriageway and the bridge head is
         * probed rather than assumed. Both directions of travel on the same
         * line, because an abutment can be a ramp from one side and a kerb from
         * the other. */
        const path = densify([...off.run, [end[0], end[1]], [far[0], far[1]]]);
        const worst = Math.max(
          worstStep(profileThrough(near, path)),
          worstStep(profileThrough(near, [...path].reverse()))
        );
        if (worst < best) { best = worst; bestAt = off.at; }
        if (best <= RISE_LIMIT) break;
      }
      assert.ok(best <= RISE_LIMIT,
        `${c.id}: nowhere on ${s.key} can a walker get onto the abutment at `
        + `(${end[0]}, ${end[1]}) - the easiest line, leaving the road at `
        + `(${bestAt?.[0].toFixed(1)}, ${bestAt?.[1].toFixed(1)}), still needs a `
        + `${best.toFixed(2)} m step and the player can climb ${CONFIG.player.stepHeight}`);
      checked++;
    }
  }
  assert.ok(checked >= 10, `only ${checked} crossing ends walked`);
});

test('a crossing approach is climbable from every bearing, not only head-on', async () => {
  /* The property behind the fix, held independently of where the roads happen
   * to run today: a causeway is a nested, flared stack, so a straight line from
   * anywhere outside it crosses each course boundary exactly once whatever its
   * bearing - which is the same argument `_entrySteps` makes for a doorstep.
   *
   * Nine metres out, because that is the arc the causeway itself occupies: the
   * longest flight in the world is three courses and reaches 7.05 m, so a probe
   * from 9 m starts on open ground just outside the toe and has to cross every
   * riser to get in. Further out and the fan sweeps the bank either side of the
   * bridge and starts measuring the landscape instead of the structure. */
  const w = await built();
  const cols = w.testColliders;
  let checked = 0;
  for (const c of CROSSINGS) {
    if (c.kind !== 'bridge' || c.id === 'aldern-bridge') continue;
    const midZ = (c.from[1] + c.to[1]) / 2;
    const near = cols.filter((k) => Math.abs(k.x - c.x) < 80 && Math.abs(k.z - midZ) < 80);
    for (const end of [c.from, c.to]) {
      // Outward from the deck: the bearing a causeway descends on.
      const out = end[1] < midZ ? -1 : 1;
      let usable = 0;
      let headOn = false;
      for (let deg = -60; deg <= 60; deg += 15) {
        const a = (deg * Math.PI) / 180;
        const ox = Math.sin(a);
        const oz = out * Math.cos(a);
        const worst = worstStep(profileAlong(
          near, end[0] + ox * 9, end[1] + oz * 9, -ox, -oz, 9
        ));
        if (worst > RISE_LIMIT) continue;
        usable++;
        if (deg === 0) headOn = true;
      }
      /* Head-on always, and seven of the nine. Not all nine, because the
       * Harrowgate toll house stands on the south causeway's east cheek and one
       * probe walks into its gable - that is a building, and walking round a
       * building is not a defect. Seven still fails a plain unflared stack,
       * which managed six here and would manage three. */
      assert.ok(headOn,
        `${c.id}: its abutment at (${end[0]}, ${end[1]}) cannot even be climbed head-on`);
      assert.ok(usable >= 7,
        `${c.id}: only ${usable} of 9 bearings can climb onto its abutment at `
        + `(${end[0]}, ${end[1]}) - the causeway is a ramp head-on and a wall from the side`);
      checked++;
    }
  }
  assert.ok(checked >= 4, `only ${checked} abutments probed`);
});

test('the Grimscar tramway runs clear of the winding house and its doorstep', async () => {
  /* The rails ran straight from the adit to the headframe at z = -192, which is
   * inside the winding house (x -374.5..-365.5, z -196..-184) for nine metres
   * and inside its eight-course entry apron (out to x = -360.3) for six more:
   * buried 1.08 m at x = -365, 0.75 m at -363, 0.10 m at -361, 0.41 m at -359,
   * so the track terminated at the steps and re-appeared beyond them.
   *
   * Only the stretch between the adit mouth and the headframe is probed, and
   * deliberately: east of the headframe the rails run INTO the shaft collar and
   * the standing carts and under the tip, all of which is what a tramway does,
   * and west of it is the adit portal itself. The window is exactly the ground
   * the winding house stands on.
   */
  const w = await built();
  const pts = GRIMSCAR_WORKINGS.tramway;
  const cols = w.testColliders.filter((c) => Math.abs(c.x + 368) < 30 && Math.abs(c.z + 192) < 30);
  assert.ok(cols.length > 20, 'no colliders near Grimscar - the town did not build');
  let worst = 0;
  let worstAt = null;
  let sampled = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const ux = (bx - ax) / len;
    const uz = (bz - az) / len;
    for (let t = 0; t <= len; t += 0.5) {
      const cx = ax + ux * t;
      const cz = az + uz * t;
      if (cx < -377 || cx > -361) continue;    // the winding house's own ground
      // Both rails and the sleeper ends: a 1.5 m gauge, not a centreline.
      for (const off of [-0.75, -0.42, 0, 0.42, 0.75]) {
        const x = cx - uz * off;
        const z = cz + ux * off;
        const rail = medievalHeight(x, z) + 0.17;
        let top = -Infinity;
        for (const c of cols) if (overlaps(c, x, z)) top = Math.max(top, c.y + c.hy);
        if (top === -Infinity) continue;
        const buried = top - rail;
        if (buried > worst) { worst = buried; worstAt = [x, z]; }
      }
      sampled++;
    }
  }
  assert.ok(sampled > 12, `only ${sampled} sleepers fall on the winding house's ground`);
  assert.ok(worst <= 0.25,
    `the tramway is buried ${worst.toFixed(2)} m inside the masonry at `
    + `(${worstAt?.[0].toFixed(1)}, ${worstAt?.[1].toFixed(1)}) - the rails run into a wall`);
});

/* ------------------------------------------------------------------ */
/* 4. Nothing grows on a settlement's core                             */
/* ------------------------------------------------------------------ */

/**
 * A settlement's core, defined GEOMETRICALLY and independently of the
 * predicate under test.
 *
 * `inSettlementCore` thresholds `settledAt`, so testing against it would be
 * testing a function against itself. This is the ground feature proper - inside
 * the rectangle or the disc, feather excluded - which is where `settledAt` is
 * exactly 1 and where, by definition, nothing woody can be growing.
 */
function inCoreProper(x, z) {
  for (const s of SETTLEMENTS) {
    for (const f of s.ground) {
      const d = f.shape === 'rect'
        ? rectDist(x - f.x, z - f.z, f.hx, f.hz)
        : Math.hypot(x - f.x, z - f.z) - f.r;
      if (d < 0) return s.id;
    }
  }
  return null;
}

test('no tree and no shrub stands on ground a settlement has beaten flat', async () => {
  /* Eleven trunks inside St Ceolwine's precinct wall, two of them in the
   * cloister garth at (-293, 359) and (-290, 359), and forty-odd leaf sheets
   * within thirty metres of the garth centre - large semi-transparent cards
   * standing between the garth and the church it is composed around. Cause:
   * every natural-cover pass gated on `_isOpenGround`, which knows about roads,
   * footprints, the river and the vale's two hand-authored rectangles, and has
   * never had any way to be told that a settlement exists. */
  const w = headlessWorld();
  // `_buildContactShadows` paints to a 2D canvas, which Node has not got. It
  // is the last thing `_buildNature` does and it places nothing.
  w._buildContactShadows = () => {};
  await w._buildNature();

  const p = new THREE.Vector3();
  const m = new THREE.Matrix4();
  const offenders = [];
  w.group.traverse((o) => {
    if (!o.isInstancedMesh) return;
    const key = o.material?.userData?.key;
    // Crowns and trunks. A barrel in a market square is correct; an oak is not.
    if (key !== 'leaf' && key !== 'bark') return;
    for (let i = 0; i < o.count; i++) {
      o.getMatrixAt(i, m);
      p.setFromMatrixPosition(m);
      o.localToWorld(p);
      const where = inCoreProper(p.x, p.z);
      if (where) offenders.push(`${key} at (${p.x.toFixed(0)}, ${p.z.toFixed(0)}) in ${where}`);
    }
  });
  assert.equal(offenders.length, 0,
    `${offenders.length} plants growing on beaten earth: ${offenders.slice(0, 6).join('; ')}`);

  // And the pass actually planted something, or the assertion above is vacuous.
  let planted = 0;
  w.group.traverse((o) => {
    if (o.isInstancedMesh && (o.material?.userData?.key === 'leaf')) planted += o.count;
  });
  assert.ok(planted > 5000, `only ${planted} leaf instances - the scatter did not run`);
});

test('the plantable gate is the settlement table, not a list of rectangles', () => {
  /* The general form of the fix, held as a property: a town added to the table
   * later must get the same rejection with no edit anywhere else. */
  for (const t of TOWNS) {
    assert.ok(inSettlementCore(t.centre.x, t.centre.z) || t.ground.length === 0,
      `${t.id}'s own centre is not inside its own core`);
  }
  assert.ok(CORE_SETTLED > 0 && CORE_SETTLED <= 1);
  // Open pasture is still plantable, or the world has no woods left.
  assert.equal(inSettlementCore(-140, 210), false);
  assert.equal(settledAt(-140, 210), 0);
});

/* ------------------------------------------------------------------ */
/* 5. What the roofline and the footings say                           */
/* ------------------------------------------------------------------ */

test('no church building carries a domestic chimney', async () => {
  /* `_shell` fitted a chimney to everything that was not on stilts,
   * flat-roofed, a barn or a shed - so the 34 m abbey church under lead got a
   * rubble domestic stack on its ridge. A nave has no hearth. */
  for (const b of allBuildings()) {
    if (!ECCLESIASTICAL.has(b.kind)) continue;
    assert.equal(hasChimney(b), false, `${b.id} (${b.kind}) carries a chimney`);
  }
  // At least one of them is a lit, pitched-roof building, so the rule is doing
  // work rather than being satisfied by `roof: 'flat'` for free.
  const church = allBuildings().find((b) => b.kind === 'abbeychurch');
  assert.ok(church && church.lit && church.roof !== 'flat');

  /* And end to end: a lit chimney registers a smoke plume at its own ridge, so
   * a stack on the abbey church would leave a smoke origin standing inside the
   * church's footprint. */
  const w = await built();
  const s = w._smokeOrigins;
  for (let i = 0; i < s.length; i += 3) {
    const d = rectDist(s[i] - church.x, s[i + 2] - church.z, church.w / 2, church.d / 2);
    assert.ok(d > 0, `smoke rising from the abbey church roof at (${s[i] | 0}, ${s[i + 2] | 0})`);
  }
});

test('a tall plinth is a battered footing, not one flush face', () => {
  /* Fourteen shells carry over 1.6 m of plinth. The height cannot go: it is
   * the relief under the footprint, and a shell sits on its highest corner so
   * that no corner floats. What CAN go is the single flush face taken straight
   * down, which is the only thing about it that reads as the bottom of a
   * tower rather than as the thing a building is standing on. */
  // Level ground keeps exactly the one course it always had.
  assert.equal(plinthCourses(0.42).length, 1);
  assert.equal(plinthCourses(0.9).length, 1);
  let worst = 0;
  for (const b of allBuildings()) {
    if (b.stilt) continue;
    const g = groundUnder(b, medievalHeight);
    const plinth = Math.max(0.42, g.relief + 0.55);
    if (plinth > worst) worst = plinth;
    const cs = plinthCourses(plinth);
    // The courses tile the plinth exactly - a gap is a floating building.
    assert.ok(Math.abs(cs[0].y0) < 1e-9, `${b.id}: the top course does not start at the base`);
    assert.ok(Math.abs(cs[cs.length - 1].y1 - plinth) < 1e-9,
      `${b.id}: the courses do not reach the bottom of the plinth`);
    for (let i = 1; i < cs.length; i++) {
      assert.ok(Math.abs(cs[i].y0 - cs[i - 1].y1) < 1e-9, `${b.id}: a gap between courses`);
      // And it BATTERS - each course stands proud of the one above it.
      assert.ok(cs[i].out > cs[i - 1].out, `${b.id}: the footing is not battered`);
    }
    if (plinth > 1.6) {
      assert.ok(cs.length >= 2,
        `${b.id}: ${plinth.toFixed(2)} m of plinth in one flush face`);
    }
  }
  assert.ok(worst > 2.4, 'the tall-plinth case has gone from the table - retune this test');
});

/* ------------------------------------------------------------------ */
/* 6. Trodden ground is painted where towns are, and painted last      */
/* ------------------------------------------------------------------ */

test('trodden ground is derived from the settlement table and painted over the meadow', () => {
  /* Fenwick Cross's market place and Grimscar's pithead yard both read as
   * pasture. The obvious diagnosis - that the table does not cover them - is
   * wrong, and this pins that down so nobody re-fixes the wrong thing: */
  for (const [x, z] of [[196, 344], [-381, -192], [-359, -192], [-343, -190], [-365, -190]]) {
    assert.equal(settledAt(x, z), 1,
      `(${x}, ${z}) is not registered as trodden - the ground table really is short`);
  }
  /* ...the cause was that the two passes that make trodden ground READ as
   * trodden - the flat wash and the damp/dry mottle - were written against the
   * vale `MARKET` rect and its literal coordinates, and ran BEFORE `blotches`
   * scattered nine hundred meadow drifts across the whole map on top of them.
   *
   * Held as source order because a canvas paint has no other observable. */
  const wash = WORLD_SRC.indexOf('for (const s of SETTLEMENTS) {');
  const drift = WORLD_SRC.indexOf("blotches(g2, S, rnd, Math.round(area * 1.125e-3)");
  assert.ok(drift > 0, 'the meadow drift pass has gone');
  assert.ok(wash > 0, 'the trodden-ground pass is no longer derived from the settlement table');
  assert.ok(wash > drift,
    'the meadow drift is painted over the trodden ground again - a market square '
    + 'with a 40 m green blotch on it is the "same value, different paint" defect');
  assert.ok(!/MARKET\.x \+ \(rnd\(\) - 0\.5\) \* 78/.test(WORLD_SRC),
    'the damp/dry mottle is scattered around the vale market again, so the five '
    + 'towns get none of it');
});
