/**
 * AlDERMOOR VALE'S STRUCTURED ACTIVITY, MEASURED AGAINST THE WORLD IT RUNS IN.
 *
 * ── What this file is for ─────────────────────────────────────────────────
 * `src/worlds/medieval/Objectives.js` publishes eight viewpoints, three trial
 * routes and one circuit. Every one of them is a claim about a place - "a body
 * can stand here", "a body can run this", "a dragon can fly this" - and the
 * medieval expansion has already shipped four defects of exactly the shape
 * these gates exist to catch: things that were verified BUILT and never
 * verified REACHABLE.
 *
 * So nothing below is checked against the table it came from. The world is
 * built headless and the checks run against its COLLIDER SET and its own
 * heightfield.
 *
 * ── Every gate here can fail, and several prove it in place ───────────────
 * A gate that cannot fail is worse than no gate - that shape has cost this
 * repo nine separate passes. Where a check is a threshold, this file also runs
 * the NEGATIVE CONTROL: the same probe against a point that must be rejected.
 * If the probe ever stops rejecting it, the positive result means nothing and
 * the control fails first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import nodePath from 'node:path';
import * as THREE from 'three';

import { MedievalWorld } from '../../src/worlds/MedievalWorld.js';
import {
  TRIAL_ROUTES, valeLine, trialCheckpoints, chainLength,
  circuitY, KEEP_DECK_Y, WALL_WALK_Y, MARKET_CROSS_Y, JETTY_DECK_Y,
} from '../../src/worlds/medieval/Objectives.js';
import { medievalHeight, WATER_Y, CASTLE } from '../../src/worlds/terrain/MedievalHeight.js';
import { ROADS, CROSSINGS, samplePolyline } from '../../src/worlds/medieval/RoadNet.js';
import { walkableAt, MAX_WALK_SLOPE } from '../../src/worlds/medieval/Treasures.js';
import { PLOTS, EXTRA_YARDS } from '../../src/worlds/medieval/Settlements.js';
import { normaliseViewpoint, MAX_TRAVEL_ROWS, REVEAL_R } from '../../src/systems/Viewpoints.js';
import {
  MinigameManager, MINIGAME_LEGACY_BAND_MAX, venuePrize,
} from '../../src/minigames/MinigameManager.js';
import { RaceManager, DEFAULT_RACE_TYPES, RACE_TYPES } from '../../src/race/RaceManager.js';
import {
  LEAP_APEX, REF_PACE, CLIMB_LEG_S, climbLegs, parTimes, venueCoversRoute,
  chainLength as trialChain,
} from '../../src/minigames/RooftopTrial.js';

const ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '../..');

/** Player capsule and step budget, read rather than restated. */
const STEP_HEIGHT = 0.45;
/** Head-room a standing body needs above the surface it rests on. */
const HEADROOM = 1.8;
/** How far a published Y may sit from the surface a body actually rests on. */
const DECK_TOL = 0.05;

if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
}

let BUILT = null;
/**
 * The vale, headless, with its COLLIDERS KEPT.
 *
 * `medieval-wildlife.test.mjs` stubs `track` to a pass-through, which discards
 * the collider list - fine for a placement test and useless here, because the
 * collider list is the whole evidence. Materials and textures are stubbed and
 * nothing else is.
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

/** Is (x, z) inside this collider's footprint? Rotated boxes read in local frame. */
function covers(c, x, z, pad = 0) {
  const dx = x - c.x;
  const dz = z - c.z;
  const ca = Math.cos(-(c.rotY || 0));
  const sa = Math.sin(-(c.rotY || 0));
  const lx = dx * ca - dz * sa;
  const lz = dx * sa + dz * ca;
  return Math.abs(lx) <= c.hx + pad && Math.abs(lz) <= c.hz + pad;
}

/**
 * The surface a body standing at (x, z) actually rests on.
 *
 * Highest candidate - every collider top over the column, plus the soil - that
 * has `HEADROOM` of nothing above it. The head-room clause is what stops a
 * jetty deck under a fishing hut, or a nave floor under a roof, reading as a
 * place to stand; the first draft of the Reedwater viewpoint was published on
 * a deck with a shed on it and this is the probe that found it.
 */
function deckAt(w, x, z) {
  const tops = [{ top: medievalHeight(x, z), src: 'terrain' }];
  for (const c of w.colliders) if (covers(c, x, z)) tops.push({ top: c.y + c.hy, src: 'box' });
  tops.sort((a, b) => b.top - a.top);
  for (const t of tops) {
    const blocked = w.colliders.some((c) => covers(c, x, z)
      && (c.y - c.hy) < t.top + HEADROOM && (c.y + c.hy) > t.top + 0.05);
    if (!blocked) return t;
  }
  return null;
}

/** Nearest authored dwelling footprint centre, metres. */
const HOUSES = PLOTS.map((p) => ({ x: p[0], z: p[1] }))
  .concat(EXTRA_YARDS.map((e) => ({ x: e.x, z: e.z })));
function houseClear(x, z) {
  let best = Infinity;
  for (const h of HOUSES) best = Math.min(best, Math.hypot(x - h.x, z - h.z));
  return best;
}

/* ================================================================== */
/* 1. The published contract                                           */
/* ================================================================== */

test('the vale publishes viewpoints, trials and a circuit, and every reader accepts them', async () => {
  const w = await world();

  assert.equal(w.viewpoints.length, 8, 'the vale should publish eight viewpoints');
  assert.equal(new Set(w.viewpoints.map((v) => v.id)).size, 8, 'duplicate viewpoint id');
  for (const [i, v] of w.viewpoints.entries()) {
    assert.ok(normaliseViewpoint(v, i), `Viewpoints refused ${v.id}`);
    assert.equal(v.launch, undefined, `${v.id} publishes a launch point`);
    assert.equal(v.hay, undefined, `${v.id} publishes a haystack`);
  }
  /* The hub reserves a fixed number of travel rows and it is a HARD CEILING:
   * an anchor past the last row synchronises, pays and then has nowhere to be
   * travelled to. Checked against the real published count, not the constant,
   * because a floor pinned to today's content is a floor that fails silently
   * the next time a district is authored. */
  assert.ok(w.viewpoints.length <= MAX_TRAVEL_ROWS,
    `${w.viewpoints.length} viewpoints against ${MAX_TRAVEL_ROWS} hub travel rows`);

  const mm = new MinigameManager({ bus: { on: () => () => {}, emit: () => {} } });
  assert.equal(w.minigameVenues.length, 3);
  for (const v of w.minigameVenues) {
    const read = mm._readVenue(v);
    assert.ok(read, `MinigameManager refused venue ${v.id}`);
    assert.equal(read.kind, 'rooftop');
    assert.equal(read.requires, null,
      `${v.id} declares a world rule it never uses - these are footraces, not roof crossings`);
    assert.ok(Array.isArray(v.config.checkpoints) && v.config.checkpoints.length >= 3);
  }

  const t = RaceManager.prototype._readTrack.call({}, w);
  assert.ok(t, 'RaceManager refused the vale circuit');
  assert.ok(t.trackPath.length >= 3 && t.checkpoints.length >= 3);
  assert.deepEqual(t.raceTypes, ['dragon'],
    'the vale offers exactly one mount, and a car on a bridleway is the reason');
  assert.deepEqual(t.difficulties, ['easy', 'standard', 'expert']);

  /* `Charters` learns the circuits column as circuits x difficulties and
   * DELETES any column whose denominator is zero, so a world that published
   * the circuit and forgot the bands would light nothing at all. */
  assert.ok(Array.isArray(w.circuits) && w.circuits.length === 1);
  assert.equal(w.circuits.length * w.difficulties.length, 3,
    'the circuits charter denominator');
});

/* ================================================================== */
/* 2. Viewpoints: can a body stand there?                              */
/* ================================================================== */

test('every viewpoint stands on a real surface with room for a head', async () => {
  const w = await world();
  for (const v of w.viewpoints) {
    const d = deckAt(w, v.x, v.z);
    assert.ok(d, `${v.id}: nothing to stand on at all`);
    assert.ok(Math.abs(d.top - v.y) <= DECK_TOL,
      `${v.id}: published y ${v.y.toFixed(3)} but the surface a body rests on is `
      + `${d.top.toFixed(3)} (${d.src})`);
  }

  /* NEGATIVE CONTROL. The probe must reject a point that is plainly wrong, or
   * the eight passes above prove nothing. Two metres over the keep deck is
   * mid-air; the middle of the Ruined Watchtower is inside a sealed shell with
   * no floor, so its only surface is the soil 4.65 m down, not the 17.15 m
   * rim - and if this probe ever agrees that the rim is standable, the whole
   * "measure it, do not read the table" discipline in Objectives.js is gone. */
  const keep = w.viewpoints.find((v) => v.id === 'keep-deck');
  assert.ok(Math.abs(deckAt(w, keep.x, keep.z).top - (keep.y + 2)) > DECK_TOL,
    'the probe accepted a point two metres above the keep deck');
  const drum = deckAt(w, 160, -20);
  assert.equal(drum.src, 'terrain',
    'the watchtower drum reported a standable deck; it is a sealed ring wall with no floor');
  assert.ok(drum.top < 5, `watchtower interior surface is ${drum.top.toFixed(2)}, expected soil`);
});

test('the two masonry viewpoints are climbed by a stair, not free-climbed', async () => {
  const w = await world();

  /**
   * A ladder of surfaces inside a column: sorted collider tops with no gap
   * bigger than one step. This is the cheapest honest statement of "there is a
   * way up" and it is the property the vice and the wall stairs were built to
   * have.
   */
  const ladder = (cx, cz, radius, fromY, toY) => {
    const tops = [fromY];
    for (const c of w.colliders) {
      const top = c.y + c.hy;
      if (top < fromY - 0.01 || top > toY + 0.01) continue;
      if (Math.hypot(c.x - cx, c.z - cz) > radius) continue;
      tops.push(top);
    }
    tops.push(toY);
    tops.sort((a, b) => a - b);
    let worst = 0;
    for (let i = 1; i < tops.length; i++) worst = Math.max(worst, tops[i] - tops[i - 1]);
    return worst;
  };

  /* The keep's newel vice: 48 treads on a 1.32 m helix from the hall floor at
   * CASTLE.ground + 0.25 to the deck. A 1.75 m cylinder takes the treads and
   * nothing else. */
  const vice = ladder(CASTLE.x - 6 + 7.5, CASTLE.z + 2 - 5.3, 1.75, CASTLE.ground + 0.25, KEEP_DECK_Y);
  assert.ok(vice <= STEP_HEIGHT,
    `the vice's worst riser is ${vice.toFixed(3)} m against a ${STEP_HEIGHT} m step`);

  /* The curtain's east flight, which climbs away from the gatehouse toward
   * -Z. A 1.4 m radius about its own line takes the treads. */
  const east = ladder(-35.25, -77, 8, CASTLE.ground, WALL_WALK_Y);
  assert.ok(east <= STEP_HEIGHT,
    `the east wall stair's worst riser is ${east.toFixed(3)} m`);

  /* NEGATIVE CONTROL: the same probe over a column with no stair in it must
   * report a gap far bigger than a step. St Aldern's bell tower is one solid
   * 8 x 8 x 24 m box whose top is standable and whose only route up is a free
   * climb; if this reports a walkable ladder, the two assertions above are
   * measuring nothing. */
  const tower = ladder(51.4, -8, 5, medievalHeight(51.4, -8), 28.583);
  assert.ok(tower > 10,
    `the probe found a ${tower.toFixed(2)} m ladder up a solid tower with no stair`);
});

test('no viewpoint stands where the world would plant a tree on it', async () => {
  const w = await world();
  /* THE HOLE THIS CLOSES. The headless recipe every medieval test uses stops
   * short of `_buildNature`, which needs a DOM - and `_buildNature` is where
   * four kinds of collider get registered: trunks, boulders, fallen logs and
   * stumps. So the collider set this file measures against has no vegetation
   * in it, and a viewpoint could be published on a spot the scatter would put
   * an oak on without any probe here noticing.
   *
   * Asked the other way round, it needs no vegetation at all: `_isPlantable`
   * is the world's OWN predicate for "may something grow here", and a point it
   * refuses cannot have a tree on it however the scatter is seeded. Every
   * viewpoint is either masonry or inside a landmark's reserved footprint, so
   * every one of them is refused - and if a later edit moves one into open
   * pasture, this is what says so.
   *
   * Not applied to trial checkpoints: the Poacher's Line is a WOODLAND route
   * and trees on it are the point. A 3 m checkpoint ring with a 0.5 m trunk in
   * it is an obstacle, which is what a poacher's line is for. */
  for (const v of w.viewpoints) {
    assert.equal(w._isPlantable(v.x, v.z), false,
      `${v.id} stands on plantable ground - the scatter may put a tree on it`);
  }
  /* NEGATIVE CONTROL: open pasture between the vale road and the wood must
   * still read as plantable, or the predicate is answering false to
   * everything and the eight assertions above are vacuous. */
  assert.equal(w._isPlantable(-180, 150), true,
    'open ground no longer reads as plantable; the check above proves nothing');
});

test('the viewpoints spread over the vale rather than clustering on the castle', async () => {
  const w = await world();
  /* `REVEAL_R` is what makes this matter: discs that share a centre behave as
   * one big disc, which is the defect the citadel's own note records. The
   * castle offers three reachable platforms and takes ONE. */
  const castle = w.viewpoints.filter((v) => Math.hypot(v.x - CASTLE.x, v.z - CASTLE.z) < 70);
  assert.equal(castle.length, 1,
    `${castle.length} viewpoints inside one reveal radius of the castle`);

  let hit = 0;
  let total = 0;
  for (let x = -440; x <= 440; x += 10) {
    for (let z = -440; z <= 440; z += 10) {
      total++;
      if (w.viewpoints.some((v) => Math.hypot(v.x - x, v.z - z) <= REVEAL_R)) hit++;
    }
  }
  const share = hit / total;
  /* Two-sided on purpose. Too little and eight climbs reveal nothing; too much
   * and the 110 relics are handed over as a checklist, which is precisely what
   * `Viewpoints.REVEAL_R`'s own note says a radius must not do. Measured:
   * 15.0%. */
  assert.ok(share > 0.10 && share < 0.30,
    `eight viewpoints reveal ${(share * 100).toFixed(1)}% of the playfield`);
});

/* ================================================================== */
/* 3. Trials: can a body run them?                                     */
/* ================================================================== */

test('every trial checkpoint is on walkable, dry, unbuilt ground', async () => {
  const w = await world();
  /* The two causeway points are the only checkpoints in the world that stand
   * on masonry; the moat under them is cut to CASTLE.ground - 4.9 and the deck
   * spans it, so `walkableAt` - which knows only the heightfield - is the
   * wrong question there and the collider probe is the right one. */
  const DECKED = new Set(['-14|-58', '-19.7|-58']);

  for (const key of Object.keys(TRIAL_ROUTES)) {
    for (const [x, z] of TRIAL_ROUTES[key]) {
      const tag = `${key} (${x}, ${z})`;
      const d = deckAt(w, x, z);
      assert.ok(d, `${tag}: nothing to stand on`);
      if (DECKED.has(`${x}|${z}`)) {
        assert.ok(Math.abs(d.top - CASTLE.ground) <= DECK_TOL,
          `${tag}: the causeway deck reads ${d.top.toFixed(3)}, not ${CASTLE.ground}`);
        continue;
      }
      assert.equal(d.src, 'terrain', `${tag}: stands on a structure, not on soil`);
      assert.ok(walkableAt(x, z), `${tag}: not walkable`);
      assert.ok(medievalHeight(x, z) >= WATER_Y, `${tag}: under the waterline`);
      assert.ok(houseClear(x, z) >= 7, `${tag}: ${houseClear(x, z).toFixed(1)} m from a dwelling`);
    }
  }

  /* NEGATIVE CONTROL: the same battery must reject the places the survey
   * rejected. Aldern Mill's own settlement-table centre is 1.18 m UNDER the
   * water, and a point inside the tavern is not soil. Both were live
   * candidates in the first draft of these routes. */
  assert.ok(medievalHeight(EXTRA_YARDS[1].x, EXTRA_YARDS[1].z) < WATER_Y,
    'Aldern Mill is no longer under water; the wet check is measuring nothing');
  assert.notEqual(deckAt(w, 46, 32).src, 'terrain',
    'the tavern no longer stands where the probe says a route must not go');
});

test('the trial pars are not inflated by a hill the runner never climbs', async () => {
  /* `RooftopTrial.climbLegs` adds 9 s of par for every leg whose RISE exceeds
   * LEAP_APEX, on the assumption that such a leg is a free climb up a wall.
   * On farmland it is a heuristic firing on a slope. The checkpoint spacing is
   * what holds it down; a ratchet, so a re-spaced route that reintroduces the
   * inflation fails here rather than shipping a 41-second penalty. */
  const budget = { pilgrim: 2, grimscar: 2, poacher: 0 };
  for (const key of Object.keys(TRIAL_ROUTES)) {
    const cps = trialCheckpoints(key);
    const climbs = climbLegs(cps);
    assert.ok(climbs <= budget[key],
      `${key}: ${climbs} legs read as free climbs (+${(climbs * CLIMB_LEG_S).toFixed(0)} s of `
      + `par), budget ${budget[key]}`);
  }
  /* NEGATIVE CONTROL: the heuristic must still fire on a leg that IS a climb,
   * or the budget above is satisfied by a broken probe. */
  assert.equal(climbLegs([{ x: 0, y: 0, z: 0 }, { x: 0, y: LEAP_APEX + 0.5, z: 1 }]), 1);

  /* And the pars themselves land somewhere a runner recognises. REF_PACE is
   * 6.0 chain-m/s; a trial under half a minute is a corridor and one over five
   * is a commute. */
  for (const key of Object.keys(TRIAL_ROUTES)) {
    const cps = trialCheckpoints(key);
    const chain = chainLength(cps);
    assert.ok(Math.abs(chain - trialChain(cps)) < 1e-6,
      `${key}: this file and RooftopTrial disagree about how long the route is`);
    const par = parTimes(cps, chain);
    assert.ok(par.gold > 30 && par.bronze < 300,
      `${key}: pars ${par.gold.toFixed(1)}/${par.silver.toFixed(1)}/${par.bronze.toFixed(1)} s `
      + `over ${chain.toFixed(0)} m at ${REF_PACE} chain-m/s`);
  }
});

test('every trial venue contains its own route', async () => {
  const w = await world();
  /* `MinigameManager` abandons a contest whose player is outside the venue
   * disc for LEAVE_GRACE_S. A venue smaller than its route therefore quits on
   * the runner partway round, which reads as a bug in the trial rather than in
   * the descriptor. */
  for (const v of w.minigameVenues) {
    for (const c of v.config.checkpoints) {
      const d = Math.hypot(c.x - v.centre.x, c.z - v.centre.z);
      assert.ok(d <= v.radius,
        `${v.id}: a checkpoint is ${d.toFixed(1)} m out of a ${v.radius} m venue`);
      assert.ok(Math.abs(c.y - v.centre.y) <= v.yTolerance,
        `${v.id}: a checkpoint is outside the venue's height band`);
    }
    assert.ok(venueCoversRoute(v, v.config.checkpoints),
      `${v.id}: RooftopTrial says the venue does not cover its own route`);
    assert.ok(v.config.ringRadius >= 2.6,
      `${v.id}: a road wants a gate at least as wide as a roof's 2.6 m default`);
    assert.ok(Math.abs(v.config.routeLength - chainLength(v.config.checkpoints)) < 0.01,
      `${v.id}: the published route length is not the route`);
  }

  /* Rewards stay in the LEGACY BAND, like every other venue in the game, so
   * `MINIGAME_REWARD_SCALE` still moves every contest in the Nexus together. A
   * value at or over the band max is taken as literal credits and stops
   * tracking that constant - which is how the first draft of this file put a
   * footrace above the hardest trial in the game. */
  for (const v of w.minigameVenues) {
    assert.ok(v.reward > 0 && v.reward < MINIGAME_LEGACY_BAND_MAX,
      `${v.id}: reward ${v.reward} is outside the legacy band and will be paid literally`);
  }
  /* And no vale trial out-pays the most-rewarded trial anywhere else. */
  const richest = Math.max(...w.minigameVenues.map((v) => venuePrize(v.reward)));
  assert.ok(richest <= venuePrize(18),
    `a vale trial pays ${richest} CR against the game's ${venuePrize(18)} CR ceiling`);

  /* NEGATIVE CONTROL: shrink one venue to a tenth and the containment check
   * must fail. */
  const v = w.minigameVenues[0];
  const shrunk = v.config.checkpoints.some((c) =>
    Math.hypot(c.x - v.centre.x, c.z - v.centre.z) > v.radius / 10);
  assert.ok(shrunk, 'the containment check passes even at a tenth of the radius');
});

test("the Poacher's Line still crosses two predator territories", async () => {
  const w = await world();
  /* THE CLAIM THIS ROUTE IS FOR. `Wildlife.planBeasts` does not read a table -
   * it darts 20,000 seeded samples at the world and deals twelve homes
   * nearest-a-road-first - so which animals live where is a FUNCTION of the
   * built world, and a route authored against yesterday's roster is a route
   * that quietly stops being dangerous. This reads the roster the world
   * actually published. */
  const sites = w.populationSummary?.beastPlan;
  assert.ok(Array.isArray(sites) && sites.length > 0, 'the world published no beast plan');

  const nearest = (cps, site) => {
    let best = Infinity;
    for (let i = 1; i < cps.length; i++) {
      for (let k = 0; k <= 60; k++) {
        const t = k / 60;
        const x = cps[i - 1][0] + (cps[i][0] - cps[i - 1][0]) * t;
        const z = cps[i - 1][1] + (cps[i][1] - cps[i - 1][1]) * t;
        best = Math.min(best, Math.hypot(x - site.x, z - site.z));
      }
    }
    return best;
  };

  const crossed = sites.filter((s) => nearest(TRIAL_ROUTES.poacher, s) < s.territory);
  assert.ok(crossed.length >= 2,
    `the poacher's line crosses ${crossed.length} territories, not two - the roster moved`);
  /* Both dens have to be inside one streaming radius of each other, or a
   * runner never has both packs live at once and the route's whole hazard is a
   * coin flip. `Residency.spawnRadius` is 175 m. */
  const [a, b] = crossed;
  assert.ok(Math.hypot(a.x - b.x, a.z - b.z) < 175,
    'the two dens are further apart than one streaming radius');

  /* NEGATIVE CONTROL: the other two routes must NOT be dangerous, or "crosses
   * a territory" is true of every line in the vale and the assertion above is
   * satisfied by accident. */
  for (const key of ['pilgrim', 'grimscar']) {
    const n = sites.filter((s) => nearest(TRIAL_ROUTES[key], s) < s.territory).length;
    assert.equal(n, 0, `${key} crosses ${n} predator territories and should cross none`);
  }
});

/* ================================================================== */
/* 4. The circuit                                                      */
/* ================================================================== */

test('the vale circuit is a closed loop of the vale\'s own roads', () => {
  const line = valeLine();
  assert.ok(line.length >= 3);

  let len = 0;
  for (let i = 0; i < line.length; i++) {
    const a = line[i];
    const b = line[(i + 1) % line.length];
    len += Math.hypot(b.x - a.x, b.z - a.z);
  }
  assert.ok(len > 700 && len < 900, `circuit length ${len.toFixed(1)} m`);

  /* Tightest corner. Raw, the chain's own worst is 4.2 m at the Aldermoor
   * junction, which nothing in this game can take; the smoother opens it. A
   * FLOOR, so a change that tightens the line fails rather than shipping a
   * corner the dragon flies into the corridor wall on. */
  let minR = Infinity;
  const n = line.length;
  for (let i = 0; i < n; i++) {
    const a = line[(i - 1 + n) % n];
    const b = line[i];
    const c = line[(i + 1) % n];
    const ab = Math.hypot(b.x - a.x, b.z - a.z);
    const bc = Math.hypot(c.x - b.x, c.z - b.z);
    const ca = Math.hypot(a.x - c.x, a.z - c.z);
    const area = Math.abs((b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z)) / 2;
    if (area < 1e-9) continue;
    minR = Math.min(minR, (ab * bc * ca) / (4 * area));
  }
  assert.ok(minR >= 10, `tightest corner is ${minR.toFixed(1)} m of radius`);

  /* And it is still a ROAD. A CEILING on how far the racing line may be pulled
   * off a carriageway by the smoother: 6.5 m, which is the Aldermoor junction
   * cutting the inside of its own 103 degree turn over the edge of the market.
   * Everywhere else it is inside 4 m. Excludes the Aldern Bridge, where the
   * ribbon genuinely stops for 26 m and the masonry deck carries the line -
   * and that exclusion is checked rather than assumed: exactly five samples
   * sit on the deck, and if the smoother ever stops putting any there this
   * clause is silently exempting nothing. */
  const road = [];
  for (const r of ROADS) for (const p of samplePolyline(r.pts, 1.0)) road.push(p);
  const aldern = CROSSINGS.find((c) => c.id === 'aldern-bridge');
  let worst = 0;
  let onDeckCount = 0;
  for (const p of line) {
    const onDeck = Math.abs(p.x - aldern.x) < aldern.width * 0.5 + 3
      && p.z > aldern.from[1] - 2 && p.z < aldern.to[1] + 2;
    if (onDeck) { onDeckCount++; continue; }
    let d = Infinity;
    for (const q of road) d = Math.min(d, Math.hypot(p.x - q[0], p.z - q[1]));
    worst = Math.max(worst, d);
  }
  assert.equal(onDeckCount, 5, 'the bridge exemption covers a different number of samples now');
  assert.ok(worst <= 6.5, `the racing line strays ${worst.toFixed(2)} m off the road network`);
});

test('the circuit never dives through the riverbed', () => {
  const line = valeLine();
  const aldern = CROSSINGS.find((c) => c.id === 'aldern-bridge');
  for (const p of line) {
    const onDeck = Math.abs(p.x - aldern.x) < aldern.width * 0.5 + 3
      && p.z > aldern.from[1] - 2 && p.z < aldern.to[1] + 2;
    if (onDeck) {
      assert.equal(p.y, aldern.deckY, 'the bridge span is not on the bridge deck');
      continue;
    }
    assert.ok(p.y >= WATER_Y - 0.75,
      `a circuit sample sits at ${p.y.toFixed(2)}, under the waterline`);
  }

  /* NEGATIVE CONTROL: the soil under that span really is below the water, so
   * the deck clause is doing work rather than decorating a line that would
   * have been fine anyway. */
  const mid = (aldern.from[1] + aldern.to[1]) / 2;
  assert.ok(medievalHeight(aldern.x, mid) < WATER_Y - 0.75,
    'the channel under the Aldern Bridge is no longer a channel');
  assert.equal(circuitY(aldern.x, mid), aldern.deckY);
});

test('a circuit may narrow the mounts it offers, and only for as long as it is armed', () => {
  const stub = () => ({
    racing: false, state: 'idle', track: null, path: null, circuit: null,
    entries: [], markers: [], raceType: RACE_TYPES.CAR,
    raceTypes: [...DEFAULT_RACE_TYPES],
    field: { setVisible: () => {} }, rings: { clear: () => {} },
    _readTrack: RaceManager.prototype._readTrack,
    arm: RaceManager.prototype.arm,
    _install: RaceManager.prototype._install,
    setRaceType: RaceManager.prototype.setRaceType,
  });

  /* A world with no circuit must not inherit a narrowing from the last one -
   * the same "one world's setting outlived its world" shape the difficulty
   * default was fixed for. */
  const r = stub();
  r.raceTypes = ['dragon'];
  r.arm(null);
  assert.deepEqual(r.raceTypes, [...DEFAULT_RACE_TYPES],
    'a world with no circuit kept the last circuit\'s vehicle list');

  /* And a type the circuit does not offer must be refused rather than falling
   * back to CAR, which is what the old two-way ternary did. */
  const s = stub();
  s.raceTypes = ['dragon'];
  s.raceType = 'dragon';
  assert.equal(s.setRaceType('car'), 'dragon',
    'a dragon-only circuit accepted a car');
  assert.equal(s.setRaceType('dragon'), 'dragon');

  /* A circuit that publishes nothing keeps both, so every existing world is
   * untouched by the contract. */
  const t = RaceManager.prototype._readTrack.call({}, {
    trackPath: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }],
    checkpoints: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }],
  });
  assert.deepEqual(t.raceTypes, [...DEFAULT_RACE_TYPES]);

  /* A name this build does not implement is dropped, not honoured. */
  const u = RaceManager.prototype._readTrack.call({}, {
    trackPath: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }],
    checkpoints: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }],
    raceTypes: ['unicycle'],
  });
  assert.deepEqual(u.raceTypes, [...DEFAULT_RACE_TYPES],
    'an unknown race type left the panel with no vehicle to pick');
});

/* ================================================================== */
/* 5. The quest vocabulary can see the trials                          */
/* ================================================================== */

test('the trial catalogue in source is exactly the list the world publishes', async () => {
  const w = await world();
  /* `scripts/quest-vocab.mjs` scrapes venue ids out of SOURCE with this exact
   * regex and walks the object literals inside the brackets. Building the
   * venues with `push({...})` instead cost the citadel its entire trial
   * vocabulary once already: every quest step naming one was rejected as an
   * invented target. This is that defect stated directly, for this world. */
  const src = readFileSync(nodePath.join(ROOT, 'src/worlds/medieval/Objectives.js'), 'utf8');
  const m = /\.minigameVenues\s*=\s*\[/.exec(src);
  assert.ok(m, 'the venue catalogue is no longer a source literal the vocabulary can read');
  const ids = [...src.slice(m.index).matchAll(/\bid:\s*'([a-z0-9_]+)'/g)].map((q) => q[1]);
  const published = w.minigameVenues.map((v) => v.id).sort();
  assert.deepEqual(ids.slice(0, published.length).sort(), published,
    'the source literal and the published list disagree');
});

/* ================================================================== */
/* 6. The derived heights are the builder's, not this file's           */
/* ================================================================== */

test('every masonry height is the one the builder measures from', async () => {
  const w = await world();
  const at = (x, z) => deckAt(w, x, z).top;
  assert.ok(Math.abs(at(-78, -53) - KEEP_DECK_Y) <= DECK_TOL, 'keep deck');
  assert.ok(Math.abs(at(-32.2, -80) - WALL_WALK_Y) <= DECK_TOL, 'east wall walk');
  assert.ok(Math.abs(at(-111.8, -60) - WALL_WALK_Y) <= DECK_TOL, 'west wall walk');
  assert.ok(Math.abs(at(34, 18) - MARKET_CROSS_Y) <= DECK_TOL, 'market cross');
  assert.ok(Math.abs(at(-369, 90) - JETTY_DECK_Y) <= DECK_TOL, 'reedwater jetty');

  /* The keep deck is the highest standable point in the vale, and the reason
   * it is published at all is that it is now reachable. If anything overtakes
   * it the viewpoint set should be reconsidered rather than silently demoted. */
  const highest = Math.max(...w.viewpoints.map((v) => v.y));
  assert.equal(highest, KEEP_DECK_Y, 'the keep is no longer the vale\'s high point');
  assert.ok(KEEP_DECK_Y > WALL_WALK_Y + 9);
});
