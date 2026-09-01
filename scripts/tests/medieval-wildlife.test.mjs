import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';

import {
  medievalHeight, HALF, WATER_Y, riverZ, riverHalfWidth, fbm2, rectDist,
  CASTLE, MARKET,
} from '../../src/worlds/terrain/MedievalHeight.js';
import {
  SETTLEMENTS, PLOTS, EXTRA_YARDS, settledAt,
} from '../../src/worlds/medieval/Settlements.js';
import {
  allBuildings, footprintCorners, TOWNS,
  CEOLWINE_PRECINCT, BLACKMARCH_PALISADE, REEDWATER_JETTIES, GRIMSCAR_WORKINGS,
} from '../../src/worlds/medieval/Towns.js';
import { CAMPS, campPieces } from '../../src/worlds/medieval/Camps.js';
import { woodMask, authoredLift, AUTHORED_WOODS } from '../../src/worlds/medieval/Woodland.js';
import { VALE_ROADS } from '../../src/worlds/medieval/RoadNet.js';
import { beastDef, BEASTS, threatRadius } from '../../src/npc/BeastSpecies.js';
import { ROSTER } from '../../src/worlds/medieval/Inhabitants.js';
import { MedievalWorld } from '../../src/worlds/MedievalWorld.js';
import {
  planBeasts, rejectHome, reachFor, woodlandAt, DEEP_WOOD, MARGIN, ROAD_SHARE,
  WILDLIFE_MIX, builtShapes, builtIndex, builtDistance, shapeDistance,
  WALL_PAD, REGIONS, CORE_VALE, inRegion,
  TRACK_SHARE, TRACK_MARGIN, TRACK_CANOPY, nearCanopy, openRoadIndex,
} from '../../src/worlds/medieval/Wildlife.js';

/**
 * The predator placement, and the two halves of the claim it has to make true.
 *
 * ---------------------------------------------------------------------------
 * THE HALF THIS FILE USED TO PROVE
 *
 * "The deep forest is dangerous and the roads are safe" is a claim about
 * DISTANCE. `Wildlife.js` writes every clearance against a species' own
 * `territory + sight` rather than against a number somebody liked, so retuning a
 * species moves the packs and this file follows. That matters: the clearances
 * are the only thing standing between "atmospheric" and "the vale's only quest
 * giver was eaten during the loading screen".
 *
 * ---------------------------------------------------------------------------
 * AND THE HALF IT MISSED ENTIRELY
 *
 * This file had 24 assertions across 13 tests and every one of them was a
 * "not closer than". All 24 pass on a vale with NO REACHABLE WILDLIFE IN IT,
 * and that is exactly what shipped: ten packs, the nearest 317 m from the
 * player spawn, of which a player who walked all 1,298 road samples streamed
 * four and could see three, and four of 1,465 roadside closed-canopy cells
 * inside a pack's reach. Nothing here noticed, because nothing here asked.
 *
 * AND THE HALF IT ASKED THE WRONG WAY ROUND. When it did start asking, it
 * asked for a CEILING - "fewer than 10% of road samples are watched" - on a
 * world where the rule under test capped that number at 3.4% no matter what.
 * The brief the whole feature came from is "npc bears and wolves that roam
 * around and attack me". A ceiling on how often you are attacked is not a gate
 * for that brief; THE HUNTED PATH is the floor that replaced it.
 *
 * Those five numbers are the only ones in this file that cannot be reproduced
 * by running it: they are the state of a build that no longer exists, on a
 * cordon this file replaced and a woodland mask that had no wood in the
 * starting valley. Everything quoted below, including every ablation, is
 * re-measured against the world THIS file builds. The nearest equivalent that
 * IS reproducible is the "before" column of the four-corner table in
 * `Wildlife.js` - the old cordon and the old selection replayed over today's
 * world - which reaches 9 of 1,477 band cells and shows a road-walker 4 of its
 * 12 packs.
 *
 * THE DANGEROUS WOOD below is what asks.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE BUILDS THE WORLD
 *
 * Because otherwise it certifies a placement the game never builds. The gate
 * used to call `planBeasts` with no `slope`, with a 114-strong roster that
 * contained no travellers, and with a road network hand-typed from seven
 * straight chords of the ORIGINAL vale. Production passes `world._slope`, 108
 * people - 12 authored friendlies, 88 residents and 8 travellers - and 1,259
 * road segments including seventeen village lanes.
 *
 * The roster is the part that cannot be faked. `planPopulation` decides where
 * 88 residents stand by asking `world._isOpenGround`, which reads `_footprints`
 * - a list seventeen builders append to during the build. There is no pure
 * substitute for it, and a stand-in roster is not a smaller error than no
 * roster: swapping one for the other moves packs, and the two disagree about
 * the core vale in opposite directions.
 *
 * So the reachability floors are asserted against `world.populationSummary`,
 * which is the plan the game shipped. It costs about a second and a quarter and
 * it is the only honest way to make the assertions mean anything.
 *
 * The SAFETY invariants are proved over the whole legal region rather than read
 * off today's twelve sites, so no roster or seed can make them pass by luck.
 * They DO now build the world, and that is a change worth naming: the cordon is
 * drawn round the tables AND round `world._footprints`, because the tables do
 * not describe the Greyoak stage, the bridges, the crossing ramps or the market
 * furniture, and 139 of the 234 registered footprints have a corner outside the
 * table-only union, by up to 90.66 m. A theorem proved over the tables alone would be a theorem
 * about a cordon the game does not use. The world is built once for the whole
 * file, so this costs nothing beyond the second and a quarter already spent.
 */

/* ------------------------------------------------------------------ */
/* The world, built once                                               */
/* ------------------------------------------------------------------ */

/* `_breathe` gives the frame back to the browser between buildings. Under Node
 * there is no frame; a timeout is the same shape and keeps the yield points
 * honest rather than stubbing them out. */
if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
}

let BUILT = null;
/**
 * The whole vale, headless.
 *
 * Physics, materials and textures are stubbed and NOTHING else is - no step is
 * skipped and no exception is swallowed. The texture stub is what makes that
 * possible: `_buildMarket`'s folk pass is the only builder that needs a
 * renderer, and all it needs from one is a material's maps.
 */
async function world() {
  if (BUILT) return BUILT;
  const w = new MedievalWorld({
    physics: {
      addBox: (x, y, z, hx, hy, hz) => ({ x, y, z, hx, hy, hz, rotY: 0, solid: true }),
      addRotatedBox: (p, h, rotY) =>
        ({ x: p.x, y: p.y, z: p.z, hx: h.x, hy: h.y, hz: h.z, rotY, solid: true }),
    },
  });
  w.track = (c) => c;
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true });
  w._mats = new Proxy({}, { get: () => mat, has: () => true });
  const tex = { map: null, normalMap: null, roughnessMap: null };
  w._tex = new Proxy({}, { get: () => tex, has: () => true });
  await w._buildRoadPaths();
  await w._buildRoads();
  await w._buildCastle();
  await w._buildVillage();
  await w._buildRiverside();
  await w._buildMarket();
  await w._buildTowns();
  await w._buildCamps();
  await w._buildLandmarks();
  await w._buildGateAndSpawns();
  BUILT = w;
  return w;
}

/** The shipped placement and everything it was planned against. */
async function shipped() {
  const w = await world();
  const s = w.populationSummary;
  assert.ok(s?.beastPlan, 'the world published no beast plan');
  return { w, sites: s.beastPlan, people: s.people, summary: s };
}

/**
 * The two halves of `NPCManager`'s render gate, read off the source.
 *
 * `const render = npc.root.visible ? d < RENDER_OUT : d < RENDER_IN;` - so
 * RENDER_IN is the distance at which something that is NOT drawn starts being
 * drawn, and RENDER_OUT is the distance at which something that IS drawn stops.
 * A streamed pack arrives invisible, so the number that decides whether a
 * road-walker ever sees one is RENDER_IN. Every claim in this file used to be
 * quoted against RENDER_OUT and was overstated by the 10 m between them.
 */
const NPCM_SRC = await readFile(new URL('../../src/npc/NPCManager.js', import.meta.url), 'utf8');
const RENDER_IN = Number(/const RENDER_IN = (\d+);/.exec(NPCM_SRC)?.[1]);
const RENDER_OUT = Number(/const RENDER_OUT = (\d+);/.exec(NPCM_SRC)?.[1]);

test('the render gate is hysteretic, and this file quotes the half that matters', () => {
  /* THE EIGHTH DEAD ASSERTION lived on the line after these two. It read
   *
   *     assert.ok(RENDER_IN < RENDER_OUT, 'the LOD band inverted');
   *
   * which can only be reached once the two equalities above have pinned the
   * pair to 125 and 135, at which point it is `125 < 135` - a statement about
   * two literals in this file, not about `NPCManager.js`. Anything that could
   * invert the band moves one of the two constants and fails on the line above
   * it. Deleted rather than reordered: putting it first would make it a real
   * test, but a redundant one, since the equalities are strictly stronger. */
  assert.equal(RENDER_IN, 125, 'RENDER_IN moved; every draw-radius claim in this file is stated in it');
  assert.equal(RENDER_OUT, 135, 'RENDER_OUT moved');
  assert.match(NPCM_SRC, /npc\.root\.visible \? d < RENDER_OUT : d < RENDER_IN/,
    'the render gate is no longer hysteretic - if it is a single boundary now, the distinction this '
    + 'file draws between RENDER_IN and RENDER_OUT is stale and every claim can go back to one number');
});

/** Road samples: everywhere a player who stays on the network can stand. */
async function roadNodes() {
  const w = await world();
  const all = [];
  const core = [];
  const valeKeys = new Set(VALE_ROADS.map((r) => r.key));
  for (const p of w._roadPaths) {
    /* The CORE VALE's own roads: the seven of the original 400 m vale, plus the
     * village lanes `_buildVillageLanes` hangs off them. Named here rather than
     * left implicit, because "the core vale" can be measured three ways and the
     * percentages differ by ten points between them. */
    const isCore = valeKeys.has(p.key) || p.minimap === false;
    for (const [x, z] of p.pts) {
      all.push([x, z]);
      if (isCore) core.push([x, z]);
    }
  }
  return { all, core };
}

/* ------------------------------------------------------------------ */
/* 1. THE CORDON IS A THEOREM - proved, not sampled                    */
/* ------------------------------------------------------------------ */

/**
 * Exact signed distance to a building's real, ROTATED footprint.
 *
 * Deliberately not `Towns.footprintDistance`: that helper rotates by
 * cos(-yaw)/sin(-yaw), which is the FORWARD map rather than its inverse, and
 * the test below shows it misplacing a wall by up to 2.66 m. This is the true
 * inverse of the transform `footprintCorners`, `_shell` and `_house` all use,
 * and it reproduces `footprintCorners` to 5e-14 m.
 */
function wallDistance(b, x, z) {
  const dx = x - b.x;
  const dz = z - b.z;
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  return rectDist(dx * c - dz * s, dz * c + dx * s, b.hx, b.hz);
}

/** Every authored wall in the vale, as a rotated rect. 118 of them. */
const WALLS = [
  ...allBuildings().map((b) => ({ id: b.id, x: b.x, z: b.z, yaw: b.yaw, hx: b.w / 2, hz: b.d / 2 })),
  ...PLOTS.map((p, i) => ({ id: `plot${i}`, x: p[0], z: p[1], yaw: p[2], hx: p[3] / 2, hz: p[4] / 2 })),
  ...EXTRA_YARDS.map((e, i) => ({ id: `yard${i}`, x: e.x, z: e.z, yaw: e.r, hx: e.w / 2, hz: e.d / 2 })),
];

test('the exact wall distance is the one this file uses, and the shipped helper is not', () => {
  /* A corner of a footprint is at distance zero from it. Anything that says
   * otherwise cannot be used to draw a safety cordon. */
  let mine = 0;
  for (const b of allBuildings()) {
    const w = { x: b.x, z: b.z, yaw: b.yaw, hx: b.w / 2, hz: b.d / 2 };
    for (const [cx, cz] of footprintCorners(b)) mine = Math.max(mine, Math.abs(wallDistance(w, cx, cz)));
  }
  assert.ok(mine < 1e-9, `the reference wall distance is out by ${mine} m on a corner`);

  /* And the reason `builtShapes` is discs and axis-aligned rects only. This is
   * a real, separate, shipped defect in `Towns.footprintDistance` and
   * `MedievalWorld._inFootprint`; it is recorded here rather than fixed,
   * because fixing it moves vegetation scatter, prop placement and NPC standing
   * room across the whole world. If it is ever fixed, this assertion is the one
   * that should be inverted. */
  let shippedErr = 0;
  for (const b of allBuildings()) {
    const dxc = Math.cos(-b.yaw);
    const dxs = Math.sin(-b.yaw);
    for (const [cx, cz] of footprintCorners(b)) {
      const dx = cx - b.x;
      const dz = cz - b.z;
      shippedErr = Math.max(shippedErr, Math.abs(
        rectDist(dx * dxc - dz * dxs, dx * dxs + dz * dxc, b.w / 2, b.d / 2)));
    }
  }
  assert.ok(shippedErr > 2,
    'Towns.footprintDistance now agrees with footprintCorners - the yaw sign was fixed, so the '
    + 'note in Wildlife.js about routing around it is stale');
});

test('footprintCorners agrees with three.js, so the corners below are not our own arithmetic', () => {
  /* THE PREMISE below is a containment test, and a containment test whose
   * subject and whose shape are computed by the same six lines of trigonometry
   * proves only that the six lines are self-consistent. This is the independent
   * leg: `Towns.footprintCorners` is checked against `Matrix4.makeRotationY`,
   * which is three.js's rotation and not this repo's, and it is the transform
   * `_house` and `_shell` actually apply when they place a building. */
  const v = new THREE.Vector3();
  const m = new THREE.Matrix4();
  let worst = 0;
  let rotated = 0;
  for (const b of allBuildings()) {
    if (Math.abs(Math.sin(b.yaw)) > 1e-9 && Math.abs(Math.cos(b.yaw)) > 1e-9) rotated++;
    m.makeRotationY(b.yaw);
    const mine = footprintCorners(b);
    const theirs = [[-b.w / 2, -b.d / 2], [b.w / 2, -b.d / 2], [b.w / 2, b.d / 2], [-b.w / 2, b.d / 2]]
      .map(([ox, oz]) => {
        v.set(ox, 0, oz).applyMatrix4(m);
        return [b.x + v.x, b.z + v.z];
      });
    for (let i = 0; i < 4; i++) {
      worst = Math.max(worst, Math.hypot(mine[i][0] - theirs[i][0], mine[i][1] - theirs[i][1]));
    }
  }
  assert.ok(rotated >= 20, `only ${rotated} town buildings stand at an angle - this proves nothing`);
  assert.ok(worst < 1e-9,
    `footprintCorners is ${worst} m from Matrix4.makeRotationY on a corner; THE PREMISE is measuring `
    + 'its own arithmetic rather than the world\'s');
});

test('THE PREMISE: every shape in the union contains the thing it stands for', async () => {
  /* The guarantee is `dist(wall) >= MARGIN + WALL_PAD` for any point a legal
   * home can threaten, and it rests on exactly one thing: each shape contains
   * its subject inflated by WALL_PAD. That is checked here EXACTLY, per subject,
   * rather than sampled - a lattice can miss a corner, and a corner is where a
   * circumscribed disc is tightest.
   *
   * TWO FAILURE MODES THIS HAS TO AVOID, both of which the first cut had.
   *
   * It must not compare a value to itself. Corners re-derived inline from the
   * same table by the same trigonometry as the shape are an identity; they come
   * from `footprintCorners` instead, which the test above pins to three.js.
   *
   * And it must scan EVERY subject. The first cut scanned 118 subjects of the
   * 143 shapes the union then held, and none at all of the 234 registered
   * footprints and 13 mine workings it has since been widened to cover. The census is asserted against `shapes.length`, so a
   * class of shape added to `builtShapes` without a check here FAILS this test
   * rather than slipping through it. */
  const { w, summary } = await shipped();
  const shapes = builtShapes(SETTLEMENTS, w._footprints);

  /* THE CORDON WAS DRAWN ROUND THE WHOLE WORLD, not round however much of it
   * had been registered by then. `beastFootprints` is `_footprints.length` at
   * the instant `planBeasts` was called; this compares it with the length after
   * every builder has finished. They match today at 234, and the reason they
   * must is call order - the last push is in `_buildLandmarks` and
   * `applyMedievalPopulation` runs out of `_buildInhabitants`, later. A builder
   * added after that point would move packs without moving this number, and
   * this is the assertion that would notice. */
  assert.equal(summary.beastFootprints, w._footprints.length,
    `the cordon was planned against ${summary.beastFootprints} registered footprints and the finished `
    + `world has ${w._footprints.length} - a builder now runs after applyMedievalPopulation, so the `
    + 'packs were placed against a partial world');

  /* The census. Every term is the count of subjects checked below it. */
  let jettySegments = 0;
  for (const j of REEDWATER_JETTIES) jettySegments += j.pts.length - 1;
  const namedElsewhere = new Set([
    'aldermoor', 'keep-approach', 'aldermoor-keep',
    ...TOWNS.map((t) => t.id), ...CAMPS.map((c) => c.id),
  ]);
  const unnamed = SETTLEMENTS.filter((s) => s?.centre && !namedElsewhere.has(s.id));
  const workings = 1 /* adit */ + 1 /* headframe */
    + GRIMSCAR_WORKINGS.heaps.length + 1 /* tip */
    + (GRIMSCAR_WORKINGS.tramway.length - 1);
  const census = allBuildings().length + PLOTS.length + EXTRA_YARDS.length + CAMPS.length
    + 4 /* precinct, palisade, castle, market */ + jettySegments + workings + unnamed.length
    + w._footprints.length;
  assert.equal(shapes.length, census,
    `the union holds ${shapes.length} shapes and this test accounts for ${census} subjects - `
    + 'a class of shape was added to builtShapes without being scanned here');

  /** Distance from p to the nearest shape. A subject must be <= -WALL_PAD. */
  const covered = (x, z) => {
    let best = Infinity;
    for (const s of shapes) {
      const d = shapeDistance(s, x, z);
      if (d < best) best = d;
    }
    return best;
  };
  let checks = 0;
  const inside = (id, x, z) => {
    checks++;
    assert.ok(covered(x, z) <= -WALL_PAD + 1e-9,
      `${id} is not ${WALL_PAD} m inside the union (${covered(x, z).toFixed(2)} m)`);
  };

  // Every corner of every town building, every dwelling and every yard, on the
  // transform three.js agrees with.
  for (const b of allBuildings()) {
    for (const [cx, cz] of footprintCorners(b)) inside(`${b.id}'s corner`, cx, cz);
  }
  for (const [i, p] of PLOTS.entries()) {
    for (const [cx, cz] of footprintCorners({ x: p[0], z: p[1], yaw: p[2], w: p[3], d: p[4] })) {
      inside(`plot${i}'s corner`, cx, cz);
    }
  }
  for (const [i, e] of EXTRA_YARDS.entries()) {
    for (const [cx, cz] of footprintCorners({ x: e.x, z: e.z, yaw: e.r, w: e.w, d: e.d })) {
      inside(`yard${i}'s corner`, cx, cz);
    }
  }
  // Every camp piece. This is the camp analogue of medieval-towns.test.mjs's
  // "each town declares a radius that covers everything it owns", and it is
  // what makes one disc per camp legitimate.
  for (const c of CAMPS) {
    for (const p of campPieces(c)) {
      const extent = Math.hypot(p.x - c.x, p.z - c.z)
        + Math.max(p.r ?? 0, Math.hypot((p.w ?? 0) / 2, (p.d ?? 0) / 2));
      assert.ok(extent <= c.radius,
        `${c.id}'s radius ${c.radius} does not cover its ${p.kind} (extent ${extent.toFixed(2)} m)`);
      inside(`${c.id}/${p.kind}`, p.x, p.z);
    }
  }
  // The authored non-buildings, at their corners.
  const rects = [
    ['ceolwine precinct', CEOLWINE_PRECINCT.x, CEOLWINE_PRECINCT.z, CEOLWINE_PRECINCT.hx, CEOLWINE_PRECINCT.hz],
    ['blackmarch palisade', (BLACKMARCH_PALISADE.x0 + BLACKMARCH_PALISADE.x1) / 2,
      (BLACKMARCH_PALISADE.z0 + BLACKMARCH_PALISADE.z1) / 2,
      (BLACKMARCH_PALISADE.x1 - BLACKMARCH_PALISADE.x0) / 2,
      (BLACKMARCH_PALISADE.z1 - BLACKMARCH_PALISADE.z0) / 2],
    ['castle', CASTLE.x, CASTLE.z, CASTLE.hx, CASTLE.hz],
    ['market', MARKET.x, MARKET.z, MARKET.hx, MARKET.hz],
  ];
  for (const [id, x, z, hx, hz] of rects) {
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      inside(`${id}'s corner`, x + sx * hx, z + sz * hz);
    }
  }
  for (const j of REEDWATER_JETTIES) {
    for (const [x, z] of j.pts) inside(`Reedwater's ${j.id} jetty`, x, z);
  }
  /* Grimscar's workings, whose subjects are the table's own declared extents -
   * the outer edge of each, not its centre, because a spoil heap 9.5 m across
   * that is covered only at its peak is not covered. */
  {
    const GW = GRIMSCAR_WORKINGS;
    const ring = (id, x, z, r) => {
      for (let a = 0; a < 16; a++) {
        inside(id, x + Math.cos((a / 16) * Math.PI * 2) * r, z + Math.sin((a / 16) * Math.PI * 2) * r);
      }
    };
    /* The rendered extents, not the table's nominal ones - see the note beside
     * rule 4b in `builtShapes` for where each of these comes from. */
    ring('the adit portal', GW.adit.x, GW.adit.z, 7.89);
    ring('the headframe', GW.headframe.x, GW.headframe.z, GW.headframe.legHalf * Math.SQRT2);
    for (const h of [...GW.heaps, GW.tip]) ring(`a spoil heap at ${h.x},${h.z}`, h.x, h.z, h.r * 1.35);
    for (const [x, z] of GW.tramway) ring('the tramway', x, z, 1.14);
  }
  for (const s of unnamed) inside(`${s.id}'s centre`, s.centre.x, s.centre.z);

  /* And the 234 the world registered. A footprint record's `r` is not written
   * to one convention - `_house` stores the building's yaw and `_jetty` stores
   * its negation, because the latter was authored against `_inFootprint`, which
   * inverts the yaw sign - so the corners are taken under BOTH readings. The
   * rotated ones are covered by a circumscribed disc, which is rotation-
   * invariant and therefore right about a record the world is ambiguous about;
   * this is the assertion that says so. */
  for (const f of w._footprints) {
    for (const sgn of [1, -1]) {
      const corners = footprintCorners({ x: f.x, z: f.z, yaw: sgn * (f.r ?? 0), w: 2 * f.hx, d: 2 * f.hz });
      for (const [cx, cz] of corners) inside(`a registered footprint at ${f.x | 0},${f.z | 0}`, cx, cz);
    }
  }
  /* 2,662 subject points against 390 shapes. Stated so that a future edit that
   * quietly stops scanning something shows up as a number, not as a silence. */
  assert.ok(checks >= 2662, `only ${checks} containment checks ran`);
  assert.ok(new Set(shapes.map((s) => s.owner)).size >= 10,
    'the union lost its per-settlement attribution');
});

test('THE CONCLUSION: nowhere a legal pack can reach is within 23.5 m of a wall', async () => {
  /* The arithmetic: a legal home clears every shape by `reach + MARGIN`; every
   * shape contains its wall inflated by WALL_PAD (proved above); so every point
   * within `reach` of a legal home is at least `MARGIN + WALL_PAD` from every
   * wall. This scans for a counterexample rather than trusting the algebra.
   *
   * Scanned on a 1.5 m lattice, and only in the 50 m annulus just outside the
   * cordon - which is where the minimum has to be, because outside it every
   * term only grows. A 0.5 m scan of the WHOLE map, against the SHIPPED union
   * (the tables plus the world's 234 registered footprints), measures 25.00 m
   * for a wolf and 25.00 m for a bear, both at gs-alehouse. Against the table-only
   * union - what a caller with no world gets - the same scan measures the bound
   * being met exactly: 23.50 m for a wolf at gs-chapel and 23.50 m for a bear at
   * rw-s6. Widening the union can only move a legal home further out, so 23.5 is
   * the floor either way.
   *
   * The two rules this replaces, measured the same way and minimised over both
   * species: cordons drawn round settlement CENTRES leave 31.84 m and cost 7.0
   * points of legal wolf canopy to do it - 13.9% against 20.9% of the 7,772
   * closed-canopy cells of a 4 m lattice, on the world and the rules that ship;
   * it was 6.9 points before the road rule was split. Cordons drawn round
   * `SETTLEMENTS[].ground` leave MINUS 4.07 m - there is a legal wolf home at
   * (-332, 12) whose threat envelope reaches four metres inside rw-s4's wall,
   * because `ground` is a decoration table and Reedwater's stilt row is
   * deliberately not in it. */
  const { w } = await shipped();
  const FLOOR = MARGIN + WALL_PAD;
  const index = builtIndex(SETTLEMENTS, w._footprints);
  assert.ok(WALLS.length >= 118, `only ${WALLS.length} walls to scan against`);
  for (const species of ['wolf', 'bear']) {
    const reach = reachFor(beastDef(species));
    const clear = reach + MARGIN;
    let worst = Infinity;
    let where = null;
    let scanned = 0;
    for (let x = -HALF + 30; x <= HALF - 30; x += 1.5) {
      for (let z = -HALF + 30; z <= HALF - 30; z += 1.5) {
        const d = index.distance(x, z);
        if (d < clear || d > clear + 50) continue;
        scanned++;
        for (const w of WALLS) {
          const v = wallDistance(w, x, z) - reach;
          if (v < worst) { worst = v; where = `${w.id} from ${x},${z}`; }
        }
      }
    }
    /* The annulus has to have something in it. `worst` starts at Infinity, so a
     * `builtIndex` that returned the same number everywhere - a wholly broken
     * cordon - would skip every lattice point and pass this test reporting an
     * infinite clearance. Measured: 57,645 cells for a wolf and 73,625 for a
     * bear, so a floor of ten thousand is a long way under either and still
     * catches an index that has stopped discriminating. */
    assert.ok(scanned >= 10000,
      `only ${scanned} lattice cells fall in the ${species}'s 50 m annulus outside the cordon - the `
      + 'built index is not discriminating, and the clearance below was minimised over nothing');
    assert.ok(worst >= FLOOR - 1e-9,
      `a legal ${species} home can put its threat envelope ${worst.toFixed(2)} m from a wall `
      + `(${where}); the guarantee is MARGIN ${MARGIN} + WALL_PAD ${WALL_PAD} = ${FLOOR} m`);
  }
});

/* ------------------------------------------------------------------ */
/* 2. The placement the world actually built                           */
/* ------------------------------------------------------------------ */

test('the vale gets its predators, of both species, in roughly the authored ratio', async () => {
  const { sites } = await shipped();
  /* This asserted exactly 12 until five towns and three camps landed from a
   * parallel branch, at which point it found 10 - correctly, given the cordons
   * of the day. The reading at the time was that the world only held ten good
   * sites. It held twelve; what it did not hold was twelve sites outside
   * cordons drawn round settlement CENTRES.
   *
   * The floor stays at ten rather than being raised to twelve. Twelve is what
   * `ROSTER.beasts` asks for and what the vale currently yields, but the number
   * that means something is the one below which the design is broken - and a
   * short count is legitimate if a future settlement genuinely takes a wood. A
   * count that has quietly fallen to ten while every site sits on the rim is
   * caught by THE DANGEROUS WOOD, which is where it belongs. */
  assert.ok(sites.length >= 10,
    `only ${sites.length} pack sites found - reasons: ${JSON.stringify((await shipped()).summary.beastReasons)}`);
  assert.equal(ROSTER.beasts, 12, 'the roster asks for a different count than this gate measures');
  const wolves = sites.filter((s) => s.species === 'wolf').length;
  const bears = sites.filter((s) => s.species === 'bear').length;
  assert.ok(wolves > 0 && bears > 0, 'the vale needs both species');
  /* The deal is interleaved, so a `count` cut short by a budget still carries
   * both species. At 10 of 12 that lands 8:2 against an authored 3:1, so hold
   * the ratio to within one bear rather than exactly. */
  const ratio = WILDLIFE_MIX.find((m) => m.species === 'wolf').weight
    / WILDLIFE_MIX.find((m) => m.species === 'bear').weight;
  const expectedBears = sites.length / (ratio + 1);
  assert.ok(Math.abs(bears - expectedBears) <= 1,
    `${wolves} wolf / ${bears} bear sites is not close to the authored ${ratio}:1`);
});

test('every species named in the mix is a real beast', () => {
  for (const m of WILDLIFE_MIX) {
    assert.ok(BEASTS[m.species], `WILDLIFE_MIX names "${m.species}", which is not a species`);
    assert.ok(m.weight > 0);
  }
});

test('the wildlife mask and the tree mask are ONE function, not two that agree', () => {
  /* THE TRAP THIS EXISTS FOR, which very nearly shipped.
   *
   * `Wildlife.woodlandAt` used to be `fbm2(x * 0.0062, z * 0.0062, 3)` - the
   * body of `Woodland.woodMask`, written out a second time. Two copies of a
   * pure noise expression agree forever, so nothing complained, and the gate
   * below that looks like it covers this ("every pack lives in closed canopy")
   * cannot: it checks the PLAN against `woodlandAt`, and the plan was MADE with
   * `woodlandAt`, so it agrees with itself whichever copy has drifted.
   *
   * The day `Woodland` gained `AUTHORED_WOODS` the two copies would have
   * diverged silently, in one of the two worst possible directions: a valley
   * full of trees with no legal beast under them, or a beast declared legal on
   * ground with nothing growing on it.
   *
   * So it is now an ALIAS, and this asserts identity rather than agreement.
   * Sampled equality would pass on two functions that differ nowhere the
   * samples fell; `===` cannot. */
  assert.equal(woodlandAt, woodMask,
    'Wildlife.woodlandAt is no longer Woodland.woodMask itself - if it has been re-implemented, '
    + 'the authored woods can drift out of the beast legality gate without anything failing');
  /* And the noise term is still the noise term, so this file has not quietly
   * changed what "woodland" means for everybody downstream. */
  for (let i = 0; i < 200; i++) {
    const x = ((i * 211) % 900) - HALF;
    const z = ((i * 331) % 900) - HALF;
    assert.equal(woodlandAt(x, z), fbm2(x * 0.0062, z * 0.0062, 3) + authoredLift(x, z));
  }
});

test('every pack lives in closed canopy, on the same mask the trees use', async () => {
  const { sites } = await shipped();
  for (const s of sites) {
    /* Reproduced from `Woodland`'s two terms rather than by calling
     * `woodlandAt`, so a pack certified against a mask this file does not
     * recognise shows up here.
     *
     * THE THIRD DEAD ASSERTION. This used to carry
     *
     *     assert.equal(wood, woodlandAt(s.x, s.z), 'the mask has drifted');
     *
     * which compares an expression with itself: `woodlandAt === woodMask` is
     * asserted three tests above, so the right-hand side IS the left-hand side
     * evaluated a second time. No implementation could fail it. What it was
     * reaching for - "the plan was made against the mask this file recognises"
     * - is the comparison below: the PLAN's own recorded `wood`, written by
     * `planBeasts` at the moment it accepted the dart, against the mask
     * recomputed here from Woodland's two terms. That can fail, and it fails on
     * exactly the drift the comment describes. */
    const wood = fbm2(s.x * 0.0062, s.z * 0.0062, 3) + authoredLift(s.x, s.z);
    assert.equal(s.wood, wood,
      `the plan recorded wood ${s.wood} for the ${s.species} at ${s.x | 0},${s.z | 0} and the mask `
      + `says ${wood} - planBeasts accepted that dart against a different field`);
    assert.ok(wood > DEEP_WOOD,
      `a ${s.species} at ${s.x | 0},${s.z | 0} is in open country (wood ${wood.toFixed(3)})`);
  }
});

test('no pack can reach a building - measured on the world the game built', async () => {
  const { w, sites } = await shipped();
  for (const s of sites) {
    const reach = reachFor(beastDef(s.species));
    const need = reach + MARGIN;
    /* The SHIPPED union, footprints included - the cordon the world planned
     * against. Asking the table-only one here would certify the placement
     * against a weaker rule than the one that produced it. */
    const d = builtDistance(s.x, s.z, SETTLEMENTS, w._footprints);
    assert.ok(d >= need,
      `a ${s.species} at ${s.x | 0},${s.z | 0} is ${d.toFixed(1)} m from built ground, needs ${need}`);
    for (const w of WALLS) {
      const v = wallDistance(w, s.x, s.z) - reach;
      assert.ok(v >= MARGIN + WALL_PAD - 1e-9,
        `a ${s.species} at ${s.x | 0},${s.z | 0} can reach to within ${v.toFixed(2)} m of ${w.id}`);
    }
  }
});

test('no pack can reach anything the world REGISTERED as a building either', async () => {
  /* A second opinion, from the other side. `builtShapes(SETTLEMENTS)` is a pure
   * description of the vale; `world._footprints` is what the builders actually
   * put down, 234 records including the bridges, the crossing ramps, the entry
   * aprons and the market stalls that no table mentions.
   *
   * This used to be a MEASURED floor of 15 m, deliberately below MARGIN,
   * because the union did not claim to cover any of it - and 139 of the 234
   * records had a corner outside it, by up to 90.66 m, at (-256, 33). The union
   * covers them now, so the floor is the theorem's own: `MARGIN + WALL_PAD`.
   * The shipped placement measures 35.06 m against that 23.5.
   *
   * Both sign conventions of `f.r` are checked, because the world does not keep
   * one: `_house` stores a building's yaw and `_jetty` stores its negation. A
   * rotated record enters the union as a circumscribed disc precisely so that
   * the bound holds under either reading, and this is where that is tested. */
  const { w, sites } = await shipped();
  let worst = Infinity;
  let where = null;
  for (const s of sites) {
    const reach = reachFor(beastDef(s.species));
    for (const f of w._footprints) {
      for (const sgn of [1, -1]) {
        const dx = s.x - f.x;
        const dz = s.z - f.z;
        const c = Math.cos(sgn * (f.r ?? 0));
        const si = Math.sin(sgn * (f.r ?? 0));
        const v = rectDist(dx * c - dz * si, dz * c + dx * si, f.hx, f.hz) - reach;
        if (v < worst) { worst = v; where = `${s.species}@${s.x | 0},${s.z | 0} vs ${f.x | 0},${f.z | 0}`; }
      }
    }
  }
  assert.ok(worst >= MARGIN + WALL_PAD - 1e-9,
    `a pack's threat envelope comes within ${worst.toFixed(2)} m of a registered footprint (${where}), `
    + `and the union it was planned against promises ${MARGIN + WALL_PAD}`);
});

test('THE ONE GAP LEFT: Grimscar\'s prop yard is a measured floor, not a theorem', async () => {
  /* Everything else in the vale is covered by a table or by a registered
   * footprint. Grimscar's pit props, stacked timber and water butt are covered
   * by neither: `_dressGrimscar` scatters them over (-376..-370, -204..-196)
   * as literals, pushes no footprint for them, and `GRIMSCAR_WORKINGS` does not
   * mention them - so `builtShapes` cannot reach them and the theorem does not
   * cover them.
   *
   * That is stated and measured rather than quietly rounded into the workings'
   * discs. The shipped placement leaves 65.3 m between a pack's threat envelope
   * and the nearest corner of that yard, against the 23.5 m the theorem
   * guarantees everywhere else - so the gap is not a live defect, and the floor
   * below is set at 30 m, comfortably under what ships and comfortably over the
   * guarantee. The fix, when somebody wants one, is one `_footprints.push` in
   * `_dressGrimscar`: rule 6 of `builtShapes` then picks it up for nothing. */
  const { sites } = await shipped();
  let worst = Infinity;
  for (const s of sites) {
    const reach = reachFor(beastDef(s.species));
    for (let x = -376; x <= -370; x += 0.5) {
      for (let z = -204; z <= -196; z += 0.5) {
        worst = Math.min(worst, Math.hypot(s.x - x, s.z - z) - reach);
      }
    }
  }
  assert.ok(worst >= 30,
    `a pack's threat envelope is ${worst.toFixed(1)} m from Grimscar's uncovered prop yard, which `
    + 'no rule in builtShapes protects - register a footprint for it in _dressGrimscar');
});

test("no pack's threat envelope touches ground anybody has ever walked on", async () => {
  /* The fringe test, and it no longer needs a magic floor.
   *
   * The cordon is not drawn on `SETTLEMENTS[].ground` any more, so there is no
   * arithmetic bound relating the two - the old `MARGIN - widest feather` was
   * both the wrong bound and wrong arithmetic (the widest feather in the table
   * is 12, not 9, which left the old floor of 10 sitting exactly on its own
   * limit with zero headroom). What CAN be asserted is the property itself, and
   * it is stronger and needs no number: `settledAt` is zero everywhere a pack
   * can reach. Not "nearly zero" - zero, sampled at 2 m across every envelope.
   *
   * Measured slack behind it, on a 1 m lattice: the nearest a threat envelope
   * comes to the OUTER edge of a feather is 16.4 m - the Grimscar bear at
   * (389, -92), against Blackmarch's beaten earth at (381, -160). */
  const { sites } = await shipped();
  for (const s of sites) {
    const reach = reachFor(beastDef(s.species));
    for (let dx = -reach; dx <= reach; dx += 2) {
      for (let dz = -reach; dz <= reach; dz += 2) {
        if (dx * dx + dz * dz > reach * reach) continue;
        const v = settledAt(s.x + dx, s.z + dz);
        assert.equal(v, 0,
          `a ${s.species} at ${s.x | 0},${s.z | 0} can reach trodden ground `
          + `(settledAt ${v.toFixed(3)} at ${(s.x + dx) | 0},${(s.z + dz) | 0})`);
      }
    }
  }
});

test('no pack can reach a cordon point, and the slack over it is the whole of MARGIN', async () => {
  /* THE ASSERTION THAT KEEPS MARGIN HONEST.
   *
   * `FriendlyNPC` sets `homeRadius = 12 + rnd() * 10`, so a civilian free-roams
   * up to 22 m from the position `planPopulation` gave it. MARGIN is 22. So
   * `reach + MARGIN` is not "reach plus some slack", it is exactly "a pack
   * cannot acquire a civilian even at the far end of that civilian's wander",
   * and there is nothing left over.
   *
   * The old placement left 56.2 m of accidental slack on top of it, because
   * every pack was on the rim. Pulling them toward the roads spends that, and
   * putting a wood in the starting valley spends more of it.
   *
   * WHAT THIS TEST MEASURES, STATED EXACTLY, because the two quantities are
   * within a tenth of a metre of each other's names and were transposed once.
   * `people` is the CORDON's own input - the 143 points `Inhabitants.js` fed to
   * `planBeasts`, which is 108 spawn pins plus the 35 authored waypoints. Over
   * those 143 points the shipped placement's worst clearance is 22.2237 m, at
   * the wolf at (314, -57) against the resident Watchman Perrin Redsill at
   * (319.4, -147.8). Over the ground those civilians can actually OCCUPY it is
   * a quarter of a metre, because the free-roam disc is 22 m wide and eats
   * almost all of it - that number belongs to the next test and is measured
   * there.
   *
   * There used to be a second assertion here, `d - reach >= FREE_ROAM` with
   * `FREE_ROAM = 22`. MARGIN is 22, so it was `d >= reach + MARGIN` written a
   * second way: the same inequality, rearranged, with no implementation able to
   * pass one and fail the other. THE FIFTH DEAD ASSERTION. What replaces it is
   * the measured minimum, which is a number rather than a tautology. */
  const { sites, people } = await shipped();
  let worst = Infinity;
  let where = null;
  for (const s of sites) {
    const reach = reachFor(beastDef(s.species));
    for (const p of people) {
      const d = Math.hypot(s.x - p.x, s.z - p.z);
      assert.ok(d >= reach + MARGIN,
        `a ${s.species} at ${s.x | 0},${s.z | 0} is ${d.toFixed(0)} m from somebody, needs ${reach + MARGIN}`);
      if (d - reach < worst) { worst = d - reach; where = `${s.species}@${s.x | 0},${s.z | 0}`; }
    }
  }
  /* 143 = 108 spawn pins + 35 authored waypoints. It was 149 while the vale's
   * twelve authored friendlies contributed 41 waypoints between them; two of
   * them - Bram Tallow and Wilda Sorrel - now hold market counters instead of
   * walking rounds (`ROLE_DEFS[vendor].stationary`), which retires six legs,
   * and a third counter was added with no round at all. The spawn-pin count is
   * unchanged at 108 because `planSettlement` subtracts a hand-authored
   * civilian from its settlement's quota rather than doubling it: one body
   * gained here is one resident fewer at Aldermoor.
   *
   * Which is exactly why this is a floor-and-composition check and not a
   * tautology: a counter that STOPPED an NPC walking removes real ground from
   * the cordon's input, and the assertion below is what says the packs did not
   * quietly move into it. They did not - the worst clearance is the same
   * 22.2237 m against the same wolf and the same watchman. */
  assert.ok(people.length === 143, `the cordon was drawn round ${people.length} points, not 143`);
  assert.ok(worst >= MARGIN && worst < MARGIN + 1,
    `the worst clearance over the cordon's own 143 points is ${worst.toFixed(4)} m (${where}); it was `
    + `22.2237 m when this was written, and anything a metre clear of MARGIN (${MARGIN}) means the `
    + 'packs have drifted back onto the rim and this rule has stopped being the one that binds');
});

/**
 * Every point a civilian can stand on: the free-roam disc AND the whole patrol.
 *
 * `FriendlyNPC._pickWanderTarget` does one of two things - walk two to four
 * legs of its authored round, or pick a free-roam spot within `homeRadius` of
 * its SPAWN - so the ground it can occupy is the union of the patrol polyline
 * and a 22 m disc. Sampling both is the only way to ask "can this person be
 * eaten" rather than "can this person be eaten while standing still".
 */
const FREE_ROAM = 22;   // FriendlyNPC: homeRadius = 12 + rnd() * 10
function* occupiable(p, patrol) {
  yield [p.x, p.z, false];
  for (let a = 0; a < 24; a++) {
    const t = (a / 24) * 2 * Math.PI;
    yield [p.x + Math.cos(t) * FREE_ROAM, p.z + Math.sin(t) * FREE_ROAM, false];
  }
  for (let i = 0; i < patrol.length; i++) {
    if (i > 0) {
      const n = Math.max(1, Math.ceil(
        Math.hypot(patrol[i].x - patrol[i - 1].x, patrol[i].z - patrol[i - 1].z) / 2));
      for (let k = 1; k < n; k++) {
        yield [patrol[i - 1].x + (patrol[i].x - patrol[i - 1].x) * k / n,
          patrol[i - 1].z + (patrol[i].z - patrol[i - 1].z) * k / n, true];
      }
    }
    yield [patrol[i].x, patrol[i].z, true];
  }
}

/** Every civilian the vale will ever hold, with the route it walks. */
async function civilians() {
  const w = await world();
  const out = [];
  for (const n of w.npcSpawns ?? []) {
    if (n.type === 'hostile' || n.type === 'beast' || !n.position) continue;
    out.push({ kind: 'authored', name: n.name, role: n.role, p: n.position, patrol: n.patrol ?? [] });
  }
  for (const e of w._population?.people ?? []) {
    const n = e.spec;
    out.push({
      kind: n.settlement ? 'resident' : 'traveller', name: n.name, role: n.role,
      p: n.position, patrol: n.patrol ?? [],
    });
  }
  return out;
}

test('NOBODY IS HUNTED BUT THE PLAYER: no pack can acquire a civilian anywhere on its round', async () => {
  /* THE RISK THE TRACK RULE HAD TO BE MEASURED AGAINST.
   *
   * `BeastNPC._candidates` is the player AND every live friendly. Letting packs
   * watch the paths lets them watch whoever else walks the paths, and eight of
   * the vale's civilians are travellers who stand ON the verge by definition.
   * Most of them come back - `MedievalResidency` re-spawns a streamed spec
   * without looking at `isDead`, so a 220 m round trip restores 96 of these 108
   * - but the twelve AUTHORED ones do not, and neither does the quest manager
   * or the lorekeeper. See the note on `BeastNPC.satiated`, which names them.
   *
   * Measured over every point of `occupiable`: ZERO of 108 civilians can be
   * acquired, at their pin, anywhere in their free-roam disc, or anywhere on a
   * patrol leg. The worst clearance over all of that ground is 0.2640 m, at the
   * resident Watchman Perrin Redsill - a quarter of a metre, NOT the 22.22 m
   * this comment used to quote, which is the minimum over the cordon's 149
   * INPUT POINTS and belongs to the test above. The two differ by exactly the
   * free-roam radius and were transposed; the assertion below is now written
   * against the small one so the number and the code agree.
   *
   * It is zero by construction rather than by luck, and the construction is
   * two-sided:
   *
   *   - MARGIN is 22 because `homeRadius` is at most 22, so the cordon covers
   *     the free-roam disc exactly - which is why there is a quarter of a metre
   *     left over and not twenty-two;
   *   - and every patrol the PLANNER writes is shorter than that disc, which is
   *     asserted below rather than assumed - `planSettlement` gives a wanderer
   *     legs of `8 + rnd() * 14` and `planTravellers` crops the road polyline
   *     to six indices either side of a pin on a 2.5 m sampling.
   *
   * The AUTHORED patrols are not bounded by anything, and that is the hole this
   * found: Sister Meriet's round takes her 45.19 m from her spawn, twice
   * MARGIN. `Inhabitants.js` now feeds every authored waypoint to the cordon as
   * a person, which is why the clearance below is measured over the route and
   * not over the pin.
   *
   * ── THE FOURTH MOTION MODE, AND WHY "ZERO BY CONSTRUCTION" IS QUALIFIED ──
   * `occupiable` enumerates three of `FriendlyNPC`'s four ways of moving: the
   * spawn pin, the free-roam disc and the patrol. The fourth is `_flee`, which
   * `onGunfire` and `onDamaged` trigger and which is bounded by NOTHING here -
   * it hops 9-18 m at a time directly away from a startle origin, at
   * `CONFIG.npc.runSpeed` 4.4 m/s, for a `fleeTimer` of 4-8 s (gunfire) or
   * 6-10 s (damage), so a startled civilian can travel up to about 44 m from
   * wherever they were standing, twice MARGIN.
   *
   * That is stated rather than modelled, because modelling it honestly means
   * enlarging the cordon by 44 m and the map does not have that much room - and
   * because the mode is transient and self-correcting: `_flee` ends in IDLE and
   * `_pickWanderTarget` walks the character back onto its round, and the thing
   * that startled it is in the opposite direction to the one it ran. So the
   * guarantee this test proves is precisely:
   *
   *     no pack can acquire a civilian who is standing, wandering or walking
   *     their round - which is where a civilian is at all times except during
   *     the seconds after being shot at.
   *
   * The home leash is what keeps the second half from mattering. A beast will
   * not hunt anything more than `threatRadius` from its own home whatever mode
   * that thing is in (see `BeastSpecies.threatRadius`), and the leash test
   * below measures the same clearance against that radius rather than against
   * `reach + MARGIN`. */
  const { sites } = await shipped();
  const roster = await civilians();
  assert.equal(roster.length, 108, 'the civilian roster changed size');

  let worst = Infinity;
  let where = null;
  let points = 0;
  const eaten = [];
  for (const c of roster) {
    let hit = false;
    for (const [x, z, onRoute] of occupiable(c.p, c.patrol)) {
      points++;
      for (const s of sites) {
        const d = Math.hypot(s.x - x, s.z - z) - s.reach;
        if (d < worst) { worst = d; where = `${c.kind} "${c.name}"${onRoute ? ' on a patrol leg' : ''}`; }
        if (d <= 0) hit = true;
      }
    }
    if (hit) eaten.push(`${c.kind}/${c.role} "${c.name}" at ${c.p.x | 0},${c.p.z | 0}`);
  }
  assert.deepEqual(eaten, [],
    `${eaten.length} civilian(s) can be acquired by a pack somewhere on their round: ${eaten.join('; ')}`);
  /* `worst > 0` would be the same predicate as `eaten` being empty - both are
   * "every d is positive" read off the same loop - so what is asserted is the
   * VALUE, which the empty list cannot give. A quarter of a metre is the whole
   * headroom this rule has, and a run that reports metres of it means the packs
   * have moved back to the rim and the cordon has stopped being what binds. */
  assert.ok(points >= 3000, `only ${points} occupiable points scanned - the roster or the sampler moved`);
  assert.ok(worst > 0 && worst < 1,
    `the closest a pack's envelope comes to ground a civilian walks is ${worst.toFixed(4)} m (${where}); `
    + 'it was 0.2640 m when this was written and the guarantee is that it stays positive');

  /* And the two bounds the argument above rests on, so it cannot rot. */
  const excursion = { authored: 0, resident: 0, traveller: 0 };
  for (const c of roster) {
    for (const q of c.patrol) {
      excursion[c.kind] = Math.max(excursion[c.kind], Math.hypot(q.x - c.p.x, q.z - c.p.z));
    }
  }
  assert.ok(excursion.resident <= FREE_ROAM,
    `a planned resident's patrol reaches ${excursion.resident.toFixed(2)} m from its spawn, past the `
    + `${FREE_ROAM} m free-roam disc that MARGIN is sized against - the people cordon no longer `
    + 'covers the whole route by construction');
  assert.ok(excursion.traveller <= FREE_ROAM,
    `a traveller's patrol reaches ${excursion.traveller.toFixed(2)} m from its spawn, past ${FREE_ROAM}`);
  assert.ok(excursion.authored > FREE_ROAM,
    `no authored patrol now exceeds ${FREE_ROAM} m (worst ${excursion.authored.toFixed(2)} m), so the `
    + 'reason Inhabitants.js feeds authored waypoints to the cordon has gone - either a patrol was '
    + 'shortened or this gate is measuring the wrong list');
});

test('THE HOME LEASH: the cordon is a bound on where an ANIMAL can be, not on a spec', async () => {
  /* WHAT THIS FILE COULD NOT SAY UNTIL THE LEASH EXISTED.
   *
   * Every clearance above is a distance from a pack's HOME, and a home is a
   * spawn point. Nothing bounded where the animal went after it spawned: the
   * only rules that ended a pursuit were beast-to-target - `loseInterest` 46 m
   * and a six second memory - and `chargeSpeed` 7.6 beats a walking player's
   * 4.6, so neither could ever fire against somebody who simply kept walking. A
   * player could therefore lead a pack anywhere at all, and every clearance
   * proved in this file was a statement about a JSON record.
   *
   * `BeastNPC` now refuses to hunt anything more than `threatRadius` from its
   * home, and `threatRadius` IS `reachFor` - the same function, imported, not a
   * second copy of the sum. So the cordon becomes what it always claimed to be:
   *
   *   a pack home clears every point a civilian can occupy by at least `reach`
   *   -> a beast never hunts past `reach` from home
   *   -> no beast can ever acquire a civilian.
   *
   * The first line is what is measured below, and it is measured over the
   * ground civilians OCCUPY rather than over the cordon's input points, because
   * that is the weaker of the two by 22 m and it is the one the conclusion
   * needs. Shipped: 68.264 m for a wolf against a 68 m leash and 53.710 m for a
   * bear against 52 m - 0.264 m and 1.710 m of slack. The wolf's is the same
   * quarter-metre the people cordon runs on, and for the same reason: MARGIN is
   * 22 because `homeRadius` is at most 22, so the two bounds are the same bound
   * seen from either end. */
  const { sites } = await shipped();
  const roster = await civilians();
  const worst = {};
  for (const s of sites) {
    for (const c of roster) {
      for (const [x, z] of occupiable(c.p, c.patrol)) {
        const d = Math.hypot(s.x - x, s.z - z);
        if (!(s.species in worst) || d < worst[s.species].d) {
          worst[s.species] = { d, who: `${c.kind} "${c.name}"`, at: `${s.x | 0},${s.z | 0}` };
        }
      }
    }
  }
  for (const species of new Set(sites.map((s) => s.species))) {
    const leash = threatRadius(beastDef(species));
    assert.equal(leash, reachFor(beastDef(species)),
      `a ${species}'s leash and the reach this file plans against have come apart`);
    const w = worst[species];
    assert.ok(w.d >= leash,
      `a ${species} pack at ${w.at} homes ${w.d.toFixed(3)} m from ground ${w.who} can stand on, `
      + `inside its own ${leash} m leash - a player could lead it onto them`);
  }

  /* And the general form, over the species table rather than over this roster:
   * the leash may never exceed what the people cordon buys. `reach + MARGIN` is
   * the clearance to a civilian's PIN and MARGIN is exactly the free-roam
   * radius, so the clearance to the ground they occupy is `reach` - which is
   * the leash. Equality, with nothing spare, and that is the design rather than
   * an accident: it is what makes a bigger leash unsafe and a smaller one a
   * pure loss of encounter. */
  assert.equal(MARGIN, FREE_ROAM,
    `MARGIN is ${MARGIN} and FriendlyNPC free-roams to ${FREE_ROAM} - the leash argument above `
    + 'assumed they were the same number and no longer holds');
  for (const id of Object.keys(BEASTS)) {
    const def = beastDef(id);
    assert.ok(threatRadius(def) <= reachFor(def) + MARGIN - FREE_ROAM,
      `a ${id}'s leash is ${threatRadius(def)} m against a people cordon that only clears `
      + `${reachFor(def) + MARGIN - FREE_ROAM} m of occupiable ground`);
  }
});

test('THE HUNTED PATH: a pack can watch a forest track and cannot stand on one', async () => {
  /* WHAT THIS TEST USED TO BE FOR, AND WHY IT IS THE OPPOSITE NOW.
   *
   * It was called THE SAFE ROAD and it asserted a ceiling: fewer than 10% of
   * road samples inside a pack's acquisition envelope. The world measured 2.3%
   * against it - 30 of 1,298 - and the ceiling never came close to binding,
   * because the rule it was watching held every pack 59.4 m from EVERY road
   * against a wolf's 68 m reach. The CEILING on that number, with every legal
   * cell of a 3 m lattice occupied at once, was 3.4%: no placement could have
   * done much better, and the brief the whole feature was built from asked for
   * bears and wolves that "attack me".
   *
   * The network is now split in two - see `Wildlife.TRACK_CANOPY` - and the
   * ceiling has become a FLOOR. What has to be true is:
   *
   *   1. no pack can ROAM onto any metalled surface, of either class. This is
   *      what `TRACK_MARGIN` is for and it is the whole of what survives of the
   *      old rule's intent. Asserted per pack against its own `territory`.
   *   2. the arithmetic that makes (1) true is not a coincidence of two
   *      species. Asserted over every species in `BeastSpecies`.
   *   3. the highway rule is untouched: every pack still clears every OPEN
   *      stretch by `reach * ROAD_SHARE + MARGIN`.
   *   4. and the network is genuinely watched: 5% of samples, against 7.1%
   *      achieved and a 9.4% ceiling.
   *
   * Measured on the world this file builds: 92 of 1,298 samples (7.1%) are
   * inside an envelope, of which 91 are on forest track and 1 is on open
   * highway, spread over grimscarway (22), blackmarchway (17) and pilgrimway
   * (53). Before the split it was 30 samples, 26 track and 4 highway. The
   * tightest margin between a pack's territory edge and the metalled surface is
   * 7.95 m; the tightest slack over the track rule is 1.35 m and over the
   * highway rule 2.83 m.
   *
   * Hazelbrake's wolf contributes none of it, and that is not a defect this
   * test can fix: it sits 84.0 m from the nearest road against a 68 m reach,
   * and every cell of its wood that lies nearer a road is refused by the Aldern
   * mill's cordon, the flood line, the people cordon or the channel - never by
   * a road rule. */
  const { w, sites } = await shipped();
  const nodes = (await roadNodes()).all;
  const openDist = openRoadIndex(w._roadSegs);

  /* 1. Nothing can roam onto a road. */
  let worstVerge = Infinity;
  for (const s of sites) {
    const def = beastDef(s.species);
    const d = w._roadDist(s.x, s.z);
    assert.ok(d >= reachFor(def) * TRACK_SHARE + TRACK_MARGIN,
      `a ${s.species} at ${s.x | 0},${s.z | 0} is ${d.toFixed(1)} m from a road, inside the `
      + `${(reachFor(def) * TRACK_SHARE + TRACK_MARGIN).toFixed(1)} m track clearance`);
    worstVerge = Math.min(worstVerge, d - def.territory);
    /* 3. and the highway is still a highway. */
    const od = openDist(s.x, s.z);
    assert.ok(od >= reachFor(def) * ROAD_SHARE + MARGIN,
      `a ${s.species} at ${s.x | 0},${s.z | 0} is ${od.toFixed(1)} m from OPEN road, inside the `
      + `${(reachFor(def) * ROAD_SHARE + MARGIN).toFixed(1)} m highway clearance`);
  }
  /* THE SIXTH AND SEVENTH DEAD ASSERTIONS, which lived on these two lines.
   *
   *     assert.ok(d > def.territory, '... can roam onto the road ...');
   *     assert.ok(worstVerge >= 5, '... reaches to within N m of the surface');
   *
   * Both were implied by the track clearance asserted three lines above them,
   * and the comment under them said so while claiming the opposite. The
   * arithmetic: the loop has already established `d >= 0.55 * (territory +
   * sight) + 4` per site, so `d - territory >= 0.55 * sight - 0.45 * territory
   * + 4`, which for the shipped species is 7.4 m (wolf, sight 34 territory 34)
   * and 6.6 m (bear, 26 and 26). No placement that passed the line above could
   * fail either of them, and no floor under 6.6 could ever bind. The comment's
   * "`68 * 0.55 + 4` is 41.4 against 34" was the right sum and the wrong
   * conclusion - 41.4 EXCEEDS 34, which is what makes the implication hold.
   *
   * `worstVerge` survives as the diagnostic it always really was, printed
   * rather than asserted; the property it was reaching for is asserted below,
   * over the species table, where it can actually fail. */
  assert.ok(Number.isFinite(worstVerge), 'no site was scanned for its verge clearance');

  /* 2. THE ASSERTION THAT REPLACES THEM, AND THE ONLY FORM THAT CAN FAIL.
   *
   * The two dead lines above were statements about today's twelve sites, and
   * they were entailed by the clearance those sites had already passed. What is
   * NOT entailed by anything is that the clearance formula outruns `territory`
   * at all - `reach * TRACK_SHARE + TRACK_MARGIN > territory` is true for the
   * shipped species and is not guaranteed by the shape of the rule. So it is
   * asserted over the species table rather than over the roster, and it is the
   * assertion that fails the day somebody gives a beast a large territory and
   * poor eyesight - at which point no placement could keep it off the cobbles.
   * Measured today: a wolf clears by 41.4 m against a 34 m territory (7.4 m
   * spare) and a bear by 32.6 against 26 (6.6 m). */
  for (const id of Object.keys(BEASTS)) {
    const def = beastDef(id);
    const clear = reachFor(def) * TRACK_SHARE + TRACK_MARGIN;
    assert.ok(clear > def.territory,
      `a ${id} clears a forest track by ${clear.toFixed(1)} m and roams ${def.territory} m, so it `
      + 'can stand on the track. TRACK_SHARE * (territory + sight) + TRACK_MARGIN must exceed '
      + 'territory for every species, and this one breaks it');
  }

  /* 4. The network IS watched, and it is the woodland that is watched. */
  const isTrack = nodes.map(([x, z]) => nearCanopy(x, z, TRACK_CANOPY));
  let inside = 0;
  let onTrack = 0;
  for (let i = 0; i < nodes.length; i++) {
    const [x, z] = nodes[i];
    let hit = false;
    for (const s of sites) {
      if ((s.x - x) ** 2 + (s.z - z) ** 2 <= s.reach * s.reach) { hit = true; break; }
    }
    if (!hit) continue;
    inside++;
    if (isTrack[i]) onTrack++;
  }
  assert.ok(inside / nodes.length >= 0.05,
    `only ${inside} of ${nodes.length} road samples (${(100 * inside / nodes.length).toFixed(1)}%) are `
    + 'inside a pack\'s acquisition envelope (floor 5%, achieved 7.1%, ceiling 9.4%) - the packs are '
    + 'back off the paths and the brief asked for predators that attack the player');
  /* CONCENTRATED IN WOODLAND, not on the arterial. A pack still sees the last
   * few metres of a highway at the far edge of its envelope, because
   * `ROAD_SHARE` is 0.55 and not 1.0 - so this is a fraction, not a zero. One
   * of the 92 is a highway sample today; four of the old placement's 30 were. */
  assert.ok(onTrack / inside >= 0.9,
    `only ${onTrack} of the ${inside} watched road samples are forest track - the rest are open `
    + 'highway between towns, which is the thing the split was written to prevent');
});

test('no pack is in the water, in the channel, or off the edge of the map', async () => {
  const { sites } = await shipped();
  for (const s of sites) {
    assert.ok(medievalHeight(s.x, s.z) >= WATER_Y + 1.2,
      `a ${s.species} at ${s.x | 0},${s.z | 0} is standing in water`);
    assert.ok(Math.abs(s.z - riverZ(s.x)) >= riverHalfWidth(s.x) + 14,
      `a ${s.species} at ${s.x | 0},${s.z | 0} is in the channel`);
    assert.ok(Math.abs(s.x) < HALF - 30 && Math.abs(s.z) < HALF - 30,
      `a ${s.species} at ${s.x | 0},${s.z | 0} is off the playfield`);
  }
});

test('every pack stands on walkable ground the height function describes', async () => {
  const { w, sites } = await shipped();
  for (const s of sites) {
    assert.equal(s.y, medievalHeight(s.x, s.z));
    /* Production passes `world._slope` and the gate used to pass nothing, so
     * two of twelve sites used to be certified on faces the world rejects. */
    assert.ok(w._slope(s.x, s.z) <= 0.55,
      `a ${s.species} at ${s.x | 0},${s.z | 0} lives on a ${w._slope(s.x, s.z).toFixed(2)} slope`);
  }
});

test('two packs never share a wood', async () => {
  const { sites } = await shipped();
  for (let i = 0; i < sites.length; i++) {
    for (let j = i + 1; j < sites.length; j++) {
      const d = Math.hypot(sites[i].x - sites[j].x, sites[i].z - sites[j].z);
      assert.ok(d >= 90, `two packs are ${d.toFixed(0)} m apart - their territories overlap`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* 3. THE DANGEROUS WOOD - the half the clearances cannot make          */
/* ------------------------------------------------------------------ */

/**
 * The forest a player actually walks into: closed canopy within `TRACK_CANOPY`
 * of a road.
 *
 * Forty metres is not a mood either. `BeastSpecies.wolf` sees 34 m, so a player
 * who leaves the metalled surface and walks until the trees close over is at
 * the edge of being seen by anything that is there - and if nothing is within a
 * pack's reach of that whole band, then "I went into the woods and found
 * nothing" is not the player missing it, it is the map.
 *
 * THE RADIUS IS THE CONSTANT, NOT A COPY OF IT. `Wildlife.TRACK_CANOPY` says of
 * itself that it is "the radius `medieval-wildlife.test.mjs` already uses to
 * define THE DANGEROUS WOOD" - and until this line it was a third independent
 * literal 40 sitting beside `TRACK_CANOPY` and `nearCanopy`'s default, with
 * nothing binding them. This file's own history records the woodland mask
 * existing in two copies for exactly that reason. Importing it makes the claim
 * true: retune the classifier and the band the reachability floors are measured
 * over follows it, which is the property the constant's docstring is selling.
 *
 * Sampled on a 5 m lattice, which is 1,477 cells - it was 1,465 before
 * `Woodland.AUTHORED_WOODS` added Hazelbrake, whose fringe reaches within 40 m
 * of a road in twelve of them. Every figure quoted in this file is the 5 m one.
 * The previous attempt quoted 5 m figures beside a gate that sampled at 6 m,
 * and quoted two different values for the 5 m number forty lines apart.
 */
const BAND_STEP = 5;
async function roadsideCanopy() {
  const w = await world();
  const cells = [];
  for (let x = -HALF + 30; x <= HALF - 30; x += BAND_STEP) {
    for (let z = -HALF + 30; z <= HALF - 30; z += BAND_STEP) {
      if (woodlandAt(x, z) <= DEEP_WOOD) continue;
      if (w._roadDist(x, z) > TRACK_CANOPY) continue;
      cells.push([x, z]);
    }
  }
  return cells;
}

test('the roadside band and the track classifier are the same radius', () => {
  /* Not a restatement of the import: it is the assertion that the two READINGS
   * of that constant agree. `TRACK_CANOPY` is used here as a distance from a
   * road to a wood, and in `openRoadIndex` as a distance from a road to a wood
   * - the same metric in the same direction - and `nearCanopy` defaults to it
   * so a caller that omits the radius gets the same classification the gate
   * measures. A default that drifted from the constant would put the two on
   * different bands while every number in this file stayed the same. */
  assert.equal(TRACK_CANOPY, 40, 'the forest-track radius moved; the figures below are stated in it');
  const wooded = [-110, 125];    // Hazelbrake's centre: closed canopy by construction
  const open = [-420, -336];     // measured: no closed canopy within 40 m
  const fringe = [-420, -420];   // measured: nearest closed canopy between 25 and 40 m
  assert.equal(nearCanopy(...wooded), true, 'Hazelbrake does not classify as forest track');
  assert.equal(nearCanopy(...open), false, 'open moor classifies as forest track');
  /* The default IS the constant, and this is the only form of that claim that
   * can fail: a point whose nearest canopy lies between 25 and 40 m answers
   * differently at the two radii, so a default that had drifted to anything
   * appreciably under 40 would show up here. Comparing `nearCanopy(x, z)` with
   * `nearCanopy(x, z, TRACK_CANOPY)` at any other point proves nothing, because
   * almost everywhere the two radii agree. */
  assert.equal(nearCanopy(...fringe, 25), false, 'the fringe sample moved - it is wooded at 25 m now');
  assert.equal(nearCanopy(...fringe), true,
    'nearCanopy\'s default radius is no longer TRACK_CANOPY - a stretch of road 40 m from a wood is '
    + 'now classified as open highway while THE DANGEROUS WOOD still counts its canopy as roadside');
});

test('THE DANGEROUS WOOD: the roadside forest is somebody\'s country', async () => {
  /* THE ASSERTION THIS FILE SHIPPED WITHOUT.
   *
   * Every clearance above is a "not closer than", and a vale with zero
   * reachable wildlife passes all of them - which is precisely what happened.
   * Replayed over today's world, the single road rule this replaces - the same
   * plan with `openRoadDist` left out - puts 202 of the 1,477 roadside
   * closed-canopy cells, 13.7%, within a pack's reach against the 337 (22.8%)
   * the split reaches, and every clearance test above still passes on it.
   * Nothing failed.
   *
   * WHERE THE FLOOR COMES FROM. Three numbers, all measured on the built world
   * as it ships, Hazelbrake included:
   *
   *   ceiling   26.3%. Every cell of a 3 m lattice that `rejectHome` accepts
   *             for either species - 6,626 of them - all occupied at once. That
   *             is the most this band can be threatened by while the clearances
   *             hold, and no selection rule can beat it.
   *   achieved  22.8% (337 of 1,477 cells), against 13.7% (202) with every road
   *             treated as a highway. Splitting the network is what moved it:
   *             this band is roadside canopy by definition, so it is exactly
   *             the ground the track rule frees.
   *   floor     15%, asserted. A third below what is achieved, so a road
   *             re-route or a settlement moving cannot fail it by accident, and
   *             comfortably above the 13.7% the single road rule reached - i.e.
   *             this floor now discriminates against the rule it replaced as
   *             well as against a starved dart budget, which collapses it to
   *             5.4% at 2,000 darts.
   *
   * It is deliberately NOT written as "within 68 m", because 68 is a wolf's
   * arithmetic and this has to follow a species retune like everything else
   * here. A bear reaches 52 and is legal 8.8 m closer to a road for it. */
  const { w, sites } = await shipped();
  const cells = await roadsideCanopy();
  let hit = 0;
  for (const [x, z] of cells) {
    for (const s of sites) {
      if ((s.x - x) ** 2 + (s.z - z) ** 2 <= s.reach * s.reach) { hit++; break; }
    }
  }
  const got = hit / cells.length;
  assert.ok(got >= 0.15,
    `only ${(100 * got).toFixed(1)}% of the ${cells.length} roadside closed-canopy cells are within `
    + `a pack's reach (floor 15%, achieved 22.8%, ceiling 26.3%). Pack-to-road distances: `
    + `${sites.map((s) => w._roadDist(s.x, s.z).toFixed(0)).sort((a, b) => a - b).join(', ')} m. `
    + 'The clearances still pass; the wildlife is simply somewhere no player goes.');
});

test('THE DANGEROUS WOOD: a player walking the roads streams most of the packs', async () => {
  /* Reachability has a second gate below the one above, and it is the one that
   * decides whether a pack exists at all for a given player.
   * `MedievalResidency` builds bodies within `spawnRadius` (175 m) of the
   * player, and `NPCManager` lets a streamed body APPEAR at RENDER_IN. A site
   * further than 175 m from every road node is a spec that never becomes an
   * animal for anyone who stays on the network.
   *
   * RENDER_IN, NOT RENDER_OUT, and the difference is a real 10 m. The render
   * gate is hysteretic - `npc.root.visible ? d < RENDER_OUT : d < RENDER_IN` -
   * and `MedievalResidency` builds a body invisible, so a pack that streams in
   * at 135-175 m is hidden on its first LOD tick and cannot be drawn until the
   * player is within 125 m. Every claim in this file that used to be quoted
   * against 135 was overstated by that much: eleven of the twelve packs come
   * within 135 m of some road and only NINE come within 125 m.
   *
   * Measured on the world as it ships: 77.0% of the 1,298 road nodes are within
   * 175 m of some pack, against a ceiling of 90.8%, and 9 of the 12 packs come
   * within appearing range of some road. With every road treated as a highway
   * the same two figures are 74.1% and 9 of 12 - i.e. neither of these
   * discriminates against the single road rule, and that is stated rather than
   * hidden: what discriminates is the ENCOUNTER floor in THE HUNTED PATH and
   * the roadside band above. These two are here to catch a placement that has
   * drifted off the network altogether.
   *
   * No ceiling is quoted for the drawable count: "the largest set of legal
   * homes that are `minApart` apart and each within RENDER_IN of a road node"
   * is a packing problem nobody has solved here.
   *
   * The floors are 45% and half the packs. Both are stated as fractions of what
   * is planned rather than as counts, so changing `count` does not silently
   * change what is being asserted. */
  const { sites } = await shipped();
  const nodes = (await roadNodes()).all;
  let inRange = 0;
  for (const [x, z] of nodes) {
    for (const s of sites) {
      if ((s.x - x) ** 2 + (s.z - z) ** 2 <= 175 * 175) { inRange++; break; }
    }
  }
  const covered = inRange / nodes.length;
  assert.ok(covered >= 0.45,
    `only ${(100 * covered).toFixed(1)}% of the ${nodes.length} road nodes are within the 175 m `
    + 'spawn radius of a pack - most of the vale\'s wildlife never streams in for a road-walking player');

  let drawable = 0;
  for (const s of sites) {
    let best = Infinity;
    for (const [x, z] of nodes) {
      const d = (s.x - x) ** 2 + (s.z - z) ** 2;
      if (d < best) best = d;
    }
    if (best < RENDER_IN * RENDER_IN) drawable++;
  }
  assert.ok(drawable >= Math.ceil(sites.length / 2),
    `only ${drawable} of ${sites.length} packs ever come within RENDER_IN (${RENDER_IN} m) of a road - `
    + 'the rest can be streamed but are never drawn');
});

test('THE DANGEROUS WOOD: the core vale gets its pack, and it is the quota that puts it there', async () => {
  /* THE ONE THE PLAYER REPORTED.
   *
   * "I do not see any wolves or bears in the forest areas" was a report from
   * the CORE VALE - the original 400 m square, where the player spawns at
   * (14, -15) and where the castle, the village, the market and the riverside
   * content are. A global fraction cannot see it: the ring roads outvote the
   * vale's own roads 1,029 to 269, so a placement that is 60% covered overall
   * can be, and was, 0% covered here.
   *
   * WHAT IS ACHIEVABLE, AND WHY IT CHANGED. On a 4 m lattice over the core vale
   * there are now 39 legal WOLF homes and 142 legal BEAR homes. Both of those
   * numbers used to be far smaller and the wolf's used to be ZERO - not a
   * tuning failure, and nothing in this file could argue with it: delete the
   * built cordon outright and a wolf gains 110 cells, delete the people cordon
   * outright and it gains 43, and both are the safety guarantees the rest of
   * this file exists to keep.
   *
   * What changed is the MASK, not a clearance. `Woodland.AUTHORED_WOODS` puts a
   * wood - Hazelbrake, centred (-110, 125) - inside the valley, and the 39 wolf
   * cells and 128 of the 142 bear cells ARE that wood. The other fourteen bear
   * cells are the eastern wood at (188..200, -120..-104), two on the northern
   * rim at z 200 and one lone cell at (-188, 184), which is the whole of what
   * the valley held before.
   *
   * WHAT THIS GATE HAD TO STOP DOING. It asserted `drawable >= 1` over all
   * twelve sites and `inCore.length >= 1` over all twelve sites, and tied
   * neither to the other or to the quota - so the first was satisfied by a wolf
   * that lives 90 m OUTSIDE the vale and the second by a bear that is not
   * drawable from any of these roads. Every assertion below is either tied to
   * the quota's own report or is a statement about a named, identified pack. */
  const { sites, summary } = await shipped();
  const core = (await roadNodes()).core;
  assert.ok(core.length > 200, `only ${core.length} core-vale road samples - the region moved`);

  /* 1. The quota ran, and what it says it did is what the roster shows. This is
   *    the tie the old gate was missing: `got` is the mechanism's own claim and
   *    `inCore` is the independent count of packs inside the box. */
  const report = (summary.beastRegions ?? []).find((r) => r.id === CORE_VALE.id);
  assert.ok(report, 'planBeasts published no core-vale quota report - REGIONS is not wired in');
  assert.equal(report.want, 1, 'the core-vale quota is no longer one');
  assert.equal(report.got, report.want, 'the core-vale quota was not filled');
  const inCore = sites.filter((s) => inRegion(CORE_VALE, s.x, s.z));
  assert.ok(inCore.length >= report.got,
    `the quota reports ${report.got} pack(s) placed in the core vale but ${inCore.length} live there`);

  /* 2. Streaming range, on the core vale's OWN roads. 44.6% achieved, against a
   *    69.5% ceiling with every legal cell of a 3 m lattice occupied at once.
   *    Before Hazelbrake this was 10.4% against a ceiling of 12.3%, so the
   *    floor moves with it: 25%, a little over half of what is achieved, in the
   *    same spirit as the 15% floor on the roadside band.
   *
   *    THE TRACK RULE DID NOT MOVE THIS ROW, and that is measured rather than
   *    excused: the core vale is 44.6% covered with the split and 44.6% without
   *    it. Of the 2,615 cells of Hazelbrake's disc that lie nearer a road than
   *    the best legal one, 920 are refused by the Aldern mill's cordon, 790 by
   *    the flood line, 535 by the people cordon and 260 by the channel, and NOT
   *    ONE by a road rule. The starting valley's wood is hemmed in by the mill
   *    and the river. */
  let inRange = 0;
  for (const [x, z] of core) {
    for (const s of sites) {
      if ((s.x - x) ** 2 + (s.z - z) ** 2 <= 175 * 175) { inRange++; break; }
    }
  }
  const covered = inRange / core.length;
  assert.ok(covered >= 0.25,
    `only ${(100 * covered).toFixed(1)}% of the ${core.length} core-vale road samples are within `
    + 'streaming range of a pack (floor 25%, achieved 44.6%, measured ceiling 69.5%)');

  /* 3. The nearest pack to the spawn point. 195.5 m achieved; 175.4 m is the
   *    nearest LEGAL home there is, and it is inside Hazelbrake too. */
  let nearest = Infinity;
  for (const s of sites) nearest = Math.min(nearest, Math.hypot(s.x - 14, s.z + 15));
  assert.ok(nearest <= 250,
    `the nearest pack to the player spawn is ${nearest.toFixed(0)} m away `
    + '(the nearest LEGAL home to it is 175.4 m, so 250 is reachable)');
});

test('THE REPORT, ANSWERED: the core vale\'s own pack IS drawn from the core vale\'s own roads', async () => {
  /* THIS GATE USED TO ASSERT THE OPPOSITE, AND SAID SO.
   *
   * It was titled "KNOWN LIMITATION: the core vale's own pack is never DRAWN
   * from the core vale's own roads", it asserted `best > RENDER_OUT` for every
   * pack living in the box, and its failure message told whoever broke it to
   * delete the test and rewrite the prose. This is that rewrite. The comparison
   * below is the same one, inverted; nothing else about the measurement moved.
   *
   * WHAT THE LIMITATION WAS. `MedievalResidency.spawnRadius` is 175 m and a
   * streamed body cannot APPEAR until 125 m, so there is a 50 m band in which a
   * pack exists and is not drawn. The core vale's quota bear sat squarely in
   * it, at (200, -105): its nearest core-vale road node was 165.5 m, so it
   * streamed in and was never rendered for a player who stayed on those roads.
   * No placement could have fixed it, because the valley had no closed canopy
   * for a wolf to be legal in.
   *
   * WHAT FIXED IT. Not a clearance - `Woodland.AUTHORED_WOODS` put a wood in
   * the valley, and the valley went from 0 legal wolf homes to 39. The quota is
   * still one pack and it is now a WOLF, at (-131.4, 115.7), whose nearest
   * core-vale road node is 96.8 m away, on `vale` itself at (-45, 72). It
   * streams AND it draws. Coverage of the core samples is 9.3% against a
   * measured ceiling of 24.5%.
   *
   * EVERY NUMBER HERE IS AGAINST RENDER_IN (125), NOT RENDER_OUT (135). This
   * gate used to be written in RENDER_OUT and its claims were overstated by the
   * 10 m between them - a streamed pack arrives invisible, so 135 is only the
   * range at which it would STOP being drawn if it ever had been. The wolf
   * above clears the real bound by 28.2 m, not by the 38.2 m the old text
   * implied.
   *
   * The strong form is asserted rather than the coverage: EVERY pack that lives
   * in the box is drawable from the box's own roads. That is a property of the
   * wood rather than of this seed - see the last assertion, which proves it
   * over the whole wood - so it does not become a lie the day the dart stream
   * moves by one. */
  const { sites } = await shipped();
  const core = (await roadNodes()).core;
  const inCore = sites.filter((s) => inRegion(CORE_VALE, s.x, s.z));
  assert.ok(inCore.length >= 1, 'no pack lives inside the original 400 m vale at all');

  /* THE FIX, as the inverse of the old assertion. */
  for (const s of inCore) {
    let best = Infinity;
    for (const [x, z] of core) best = Math.min(best, Math.hypot(s.x - x, s.z - z));
    assert.ok(best <= RENDER_IN,
      `the ${s.species} at ${s.x | 0},${s.z | 0} lives in the core vale and is ${best.toFixed(1)} m `
      + `from the nearest core-vale road node, outside RENDER_IN (${RENDER_IN}) - it streams in `
      + 'and is never drawn for a player who stays on the valley\'s own roads, which is the exact '
      + 'defect the player reported');
  }

  /* ...and at least one of them is a WOLF, which is what the report named and
   * what the valley was structurally incapable of holding until Hazelbrake. */
  assert.ok(inCore.some((s) => s.species === 'wolf'),
    `the core vale holds ${inCore.map((s) => s.species).join(', ')} and no wolf`);

  /* Coverage, as a floor well under what is achieved. 9.3% achieved against a
   * 24.5% ceiling, so 5% discriminates without being fragile. */
  let nodes = 0;
  for (const [x, z] of core) {
    for (const s of sites) {
      if ((s.x - x) ** 2 + (s.z - z) ** 2 <= RENDER_IN * RENDER_IN) { nodes++; break; }
    }
  }
  assert.ok(nodes / core.length >= 0.05,
    `only ${nodes} of the ${core.length} core-vale road samples (${(100 * nodes / core.length).toFixed(1)}%) `
    + 'have a pack inside RENDER_IN (floor 5%, achieved 9.3%, ceiling 24.5%)');

  /* THE PROPERTY, NOT THE SEED.
   *
   * Everything above is true of today's dart stream. This is true of the wood:
   * every cell of a 2 m lattice inside Hazelbrake that `rejectHome` will accept
   * for either species lies within RENDER_IN of a core-vale road node. So there
   * is no reseed, no roster shift and no road re-route that can put the quota
   * pack back in the streamed-but-never-drawn band while leaving the wood where
   * it is.
   *
   * This is the assertion that would have caught the two configurations the
   * survey rejected: centre (-135, 125) at r 60 and centre (-130, 130) at
   * amplitude 0.60, both of which reach far enough north-west that the pool's
   * lowest road distance is a cell 140.6 m from any core-vale road.
   *
   * THE FOURTH DEAD ASSERTION, and it lived right here. It read
   *
   *     assert.equal(outside, 0, "... legal cells outside the core vale ...");
   *
   * counting cells of the r = 65 disc about (-110, 125) that fall outside
   * `CORE_VALE`. `CORE_VALE` is `{hx: 200, hz: 200}` and the disc spans
   * x in [-175, -45], z in [60, 190], so ALL 3,300 of its cells are inside the
   * box whether or not any of them is legal. `outside` was zero for every
   * possible implementation of `rejectHome`, including one that accepted
   * everything. What it was reaching for is a real bound and it is asserted
   * below as one: the disc's own extent against the region's, which fails the
   * day the wood is widened or moved or the region is shrunk. */
  const { w } = await shipped();
  const bump = AUTHORED_WOODS.find((a) => a.id === 'hazelbrake');
  assert.ok(bump, 'Hazelbrake is no longer in AUTHORED_WOODS');
  assert.ok(Math.abs(bump.x) + bump.r <= CORE_VALE.hx && Math.abs(bump.z) + bump.r <= CORE_VALE.hz,
    `Hazelbrake's disc - centre (${bump.x}, ${bump.z}), r ${bump.r} - now reaches outside the core `
    + `vale box (${CORE_VALE.hx} x ${CORE_VALE.hz}), so the quota can no longer claim all of it`);

  const built = builtIndex(SETTLEMENTS, w._footprints);
  const people = (await shipped()).people;
  const openDist = openRoadIndex(w._roadSegs);
  let legal = 0;
  let worst = 0;
  for (let dx = -bump.r; dx <= bump.r; dx += 2) {
    for (let dz = -bump.r; dz <= bump.r; dz += 2) {
      if (dx * dx + dz * dz > bump.r * bump.r) continue;
      const x = bump.x + dx;
      const z = bump.z + dz;
      const ctx = {
        settlements: SETTLEMENTS, built, people,
        height: (a, b) => w._height(a, b),
        roadDist: (a, b) => w._roadDist(a, b),
        openRoadDist: openDist,
        slope: (a, b) => w._slope(a, b),
      };
      const ok = ['bear', 'wolf'].some((sp) => !rejectHome(x, z, reachFor(beastDef(sp)), ctx));
      if (!ok) continue;
      legal++;
      let best = Infinity;
      for (const [nx, nz] of core) best = Math.min(best, Math.hypot(x - nx, z - nz));
      if (best > worst) worst = best;
    }
  }
  /* 516 cells of the 2 m lattice - 2,064 m2 - which at one dart per 40 m2 is
   * about fifty darts, so the stream cannot miss the wood either. */
  assert.ok(legal >= 350,
    `Hazelbrake offers only ${legal} legal home cells on a 2 m lattice - the dart pool will miss it`);
  /* 119.1 m measured, against 125. Six metres, and it is the whole reason
   * `AUTHORED_WOODS.hazelbrake.r` is 65 rather than anything larger. */
  assert.ok(worst <= RENDER_IN,
    `a legal home in Hazelbrake can be ${worst.toFixed(1)} m from the nearest core-vale road node, `
    + `outside RENDER_IN (${RENDER_IN}) - the wood has grown north-west far enough that the pool's `
    + 'lowest road distance is measured against pilgrimway rather than the vale, and a reseed can put '
    + 'the quota pack somewhere it is streamed and never drawn. Shrink AUTHORED_WOODS.hazelbrake.r.');
});

/* ------------------------------------------------------------------ */
/* 4. The diagnostics, whose arithmetic is checked rather than trusted  */
/* ------------------------------------------------------------------ */

test('the rejection tally accounts for every dart, exactly', async () => {
  /* `reasons.apart` used to be counted here and it broke the identity by
   * thousands, because it counted pool-SCAN skips rather than rejected darts -
   * a diagnostic in one unit added to a diagnostic in another. The pool-scan
   * bookkeeping now lives on `pool`, and this is the assertion that stops the
   * two being mixed again. */
  const { summary } = await shipped();
  const reasons = summary.beastReasons;
  const pool = summary.beastPool;
  const sum = Object.values(reasons).reduce((a, b) => a + b, 0);
  assert.equal(sum + pool.size, 20000,
    `the reasons sum to ${sum} and the pool holds ${pool.size}, which is not the dart budget`);
  for (const k of Object.keys(reasons)) {
    assert.ok(/^(playfield|water|channel|people|road|track|woodland|slope|built:.+)$/.test(k),
      `"${k}" is not one of rejectHome's rule names`);
  }
});

test('the dart pool is not starved - asserted directly, not inferred from coverage', async () => {
  /* The dart budget and the map are different failure modes and used to be
   * indistinguishable: a coverage floor drops both when a road moves and when
   * the pool runs thin. `pool.nearRoad` counts legal darts within 110 m of a
   * road, which is the quantity that actually decides whether the selection has
   * anything to select from.
   *
   * Measured: 214 at the shipped 20,000 darts, 50 at 5,000, 19 at 2,000. The
   * floor is 60, which is three times the starved value and well under a third
   * of what ships.
   *
   * The thing 2,000 darts USED to break was the core-vale quota, which went
   * unfilled and took the site count to eleven. It no longer does - Hazelbrake
   * is 2,064 m2 of legal ground and a thin pool still finds it - so the visible
   * symptom of a halved budget is now coverage: the roadside canopy band falls
   * to 5.4% against its 15% floor and ENCOUNTER to 1.8% against its 5% floor.
   * Between them the three gates still catch it; none would on its own. */
  const { summary } = await shipped();
  assert.ok(summary.beastPool.nearRoad >= 60,
    `only ${summary.beastPool.nearRoad} of the ${summary.beastPool.size} legal darts are within `
    + '110 m of a road - the dart budget is too small for the selection to have a choice');
  assert.equal(summary.beastPool.exhausted, 0,
    'a species ran out of legal homes far enough from the ones already placed');
});

/* ------------------------------------------------------------------ */
/* 5. The rules themselves                                             */
/* ------------------------------------------------------------------ */

test('rejectHome names the rule that rejected, so a barren map can be diagnosed', () => {
  const reach = reachFor(beastDef('wolf'));
  const ctx = { settlements: SETTLEMENTS, people: [] };
  // In the middle of Aldermoor.
  assert.match(String(rejectHome(44, 26, reach, ctx)), /^built:/);
  // Off the map.
  assert.equal(rejectHome(HALF - 5, 0, reach, ctx), 'playfield');
  // In the river.
  assert.equal(rejectHome(0, riverZ(0), reach, ctx), 'water');
  /* THE SECOND DEAD ASSERTION. This line used to read
   *
   *     const why = rejectHome(-420, 420, reach, { settlements: [], people: [] });
   *     assert.ok(why === null || typeof why === 'string');
   *
   * and it is the function's own return type restated: `rejectHome` returns a
   * string or null and nothing else, so no implementation of it could fail
   * that. It was worse than empty, because the two coordinates were chosen to
   * mean "open pasture well away from everything" and are not: the playfield
   * rule is `x > -HALF + inset` with inset 30, so x = -420 is EXACTLY on the
   * boundary and fails it. The line certified the rim of the map as pasture.
   *
   * What is asserted instead is the boundary itself, which is a real property
   * with a real off-by-one in it, and the woodland rule, which is what actually
   * turns a dart away in open pasture. */
  assert.equal(rejectHome(-(HALF - 30), 0, reach, ctx), 'playfield',
    'the inset boundary is exclusive: a home exactly on it is off the playfield');
  assert.notEqual(rejectHome(-(HALF - 30) + 1, 0, reach, ctx), 'playfield',
    'one metre inside the inset is inside the playfield');
  // Open pasture, inside the playfield, with nothing built or standing near it.
  const bare = { settlements: [], people: [] };
  assert.equal(rejectHome(-400, -400, reach, bare), 'woodland',
    'a home in open grass should be turned away by the woodland mask, by name');
});

test('legality is monotone in reach, which is what lets the dart loop stop early', () => {
  /* `planBeasts` evaluates the narrowest species first and stops at the first
   * refusal. That is only sound because every clearance grows with `reach` and
   * nothing else in `rejectHome` mentions it. Checked on a lattice rather than
   * argued: a point no bear may use must be usable by no wolf either. */
  const wolf = reachFor(beastDef('wolf'));
  const bear = reachFor(beastDef('bear'));
  assert.ok(bear < wolf, 'a bear no longer has the narrower reach - the dart loop order is wrong');
  const ctx = { settlements: SETTLEMENTS, people: [] };
  for (let x = -HALF + 40; x < HALF - 40; x += 37) {
    for (let z = -HALF + 40; z < HALF - 40; z += 41) {
      if (rejectHome(x, z, bear, ctx)) {
        assert.ok(rejectHome(x, z, wolf, ctx),
          `(${x}, ${z}) is legal for a wolf and not for a bear - legality is not monotone in reach`);
      }
    }
  }
});

test('a settlement added to the table later pushes the packs off it automatically', () => {
  /* The merge property for wildlife. A settlement this file has never seen must
   * clear its own cordon the moment it is in the table - and one with no
   * buildings enumerated anywhere gets its declared radius, which is the only
   * description of it there is. */
  const first = planBeasts({ beastDef, count: 12, height: medievalHeight, settlements: SETTLEMENTS });
  const invented = {
    id: 'newtown', displayName: 'Newtown', kind: 'town',
    centre: { x: first[0].x, z: first[0].z }, radius: 70, plots: null, ground: [],
  };
  const after = planBeasts({
    beastDef, count: 12, height: medievalHeight,
    settlements: [...SETTLEMENTS, invented],
  });
  for (const s of after) {
    const d = Math.hypot(s.x - invented.centre.x, s.z - invented.centre.z);
    assert.ok(d >= invented.radius + reachFor(beastDef(s.species)) + MARGIN,
      'a pack stayed put on top of a settlement added after the fact');
  }
});

test('same seed, same wolves - and the same as the world built', async () => {
  /* Determinism, and the stronger claim underneath it: re-planning with the
   * world's own inputs reproduces the world's own placement, record for record.
   * That is what makes every floor above a statement about the game rather than
   * about a stand-in for it. */
  const { w, sites, people } = await shipped();
  const again = planBeasts({
    beastDef,
    count: ROSTER.beasts,
    height: (x, z) => w._height(x, z),
    people,
    settlements: SETTLEMENTS,
    footprints: w._footprints,
    roadDist: (x, z) => w._roadDist(x, z),
    /* Rebuilt from the world's own segment list rather than reused, so this
     * also proves `openRoadIndex` is a pure function of `_roadSegs`: a
     * classifier that depended on anything else would put the packs somewhere
     * else and this comparison would fail. */
    openRoadDist: openRoadIndex(w._roadSegs),
    slope: (x, z) => w._slope(x, z),
  });
  assert.deepEqual(
    again.map((s) => `${s.species}@${s.x},${s.z}`),
    sites.map((s) => `${s.species}@${s.x},${s.z}`),
    'replanning with the world\'s own inputs does not reproduce the world\'s own placement',
  );
});

test('planBeasts refuses to guess at a species table it was not given', () => {
  assert.throws(() => planBeasts({ count: 1 }), TypeError);
});

test('the region table is a table, not a hard-coded box', () => {
  /* `REGIONS` is the only reason any pack is inside the starting valley, so it
   * has to be legible and it has to be checkable. */
  assert.ok(REGIONS.length >= 1);
  for (const r of REGIONS) {
    assert.ok(r.id && Number.isFinite(r.hx) && Number.isFinite(r.hz) && r.min >= 1);
  }
  assert.ok(inRegion(CORE_VALE, 14, -15), 'the player spawn is not inside the core vale region');
  assert.ok(!inRegion(CORE_VALE, 362, -92), 'Harrowgate Chase is inside the core vale region');
});
