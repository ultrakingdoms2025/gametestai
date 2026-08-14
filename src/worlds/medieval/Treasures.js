/**
 * Placed collectables for the 900 m vale, and the measurement that made them
 * necessary.
 *
 * ---------------------------------------------------------------------------
 * THE MEASUREMENT
 *
 * `Relics` scales its budget with world area and says so in its own docstring:
 * for medieval it asks for `want = 110` relics and gives itself `tries = 330`
 * darts to find them. Both numbers are correct. Neither is what happens.
 *
 * A dart is kept only if it lands somewhere PROMINENT - `MIN_PROMINENCE = 2.5`
 * metres above the ground four metres away, in all four directions. Replaying
 * the exact dart loop against `medievalHeight` (the terrain the darts land on)
 * measures the prominence test passing on **4.2% of the vale**, and the loop
 * placing **9 sites out of the 110 it asked for** - one of them inside the old
 * 400 m square and eight outside it. The physics surface adds the castle and
 * the cottage roofs, which the pure heightfield does not, so the shipped number
 * is a little higher than nine; it is nowhere near a hundred and ten.
 *
 * That is not a bug in `Relics`. A 400 m valley with a castle on a rise in it
 * is 4% prominent and a dart budget of ninety found thirty; a 900 m one with
 * broad rolling relief is still 4% prominent and 330 darts find nine, because
 * `tries` scales with area and the number of PROMINENT PLACES does not. The
 * collectable density of the expansion fell by a factor of ten and nothing
 * anywhere printed a warning, because "9/9 hidden" is a perfectly cheerful log
 * line.
 *
 * ---------------------------------------------------------------------------
 * THE FIX, WHICH IS A HOOK THAT ALREADY EXISTED
 *
 * `Relics._onWorld` consumes `world._towers` and `world._roofs` BEFORE it
 * darts, shuffled, subject only to the 14 m spacing rule - "a world that
 * publishes its roofs and towers knows better than any random probe where a
 * relic belongs". The citadel and the station both do. Medieval published
 * neither.
 *
 * So this file finds the prominent places properly - by SEARCHING the
 * heightfield for local maxima instead of darting at it - and publishes them.
 * The darts still run afterwards and still contribute; they are simply no
 * longer the only source.
 *
 * ---------------------------------------------------------------------------
 * REACHABLE, AND PROVED RATHER THAN ASSERTED
 *
 * The authored path in `Relics` does NO grounding check at all: it takes
 * `{x, y, z}` verbatim and lifts it 55 cm. Publishing a bad `y` there is
 * exactly how the station phase ended up with thirty-four collectables hanging
 * inside lift shafts with the floor twenty-eight metres below them.
 *
 * Every position this file produces is therefore `surface(x, z) + lift` for the
 * SAME height function the terrain mesh and the collision heightfield are built
 * from, which makes "is it standing on the ground" true by construction rather
 * than by luck. What construction cannot give you is "can the player GET
 * there" - a spot on a walkable island in the middle of the river is on the
 * ground and unreachable - so that half is left to `medieval-treasure.test.mjs`,
 * which flood-fills the walkable surface outward from the player spawn and
 * checks every collectable is in the component it reaches. The module supplies
 * the per-point predicate; the test supplies the connectivity, so the test can
 * actually fail.
 *
 * Nothing in this file may import `three`.
 */

import {
  medievalHeight, riverZ, riverHalfWidth, HALF, WATER_Y,
  LANDFORMS, RIVER_FEATURES, CIRCLE,
} from '../terrain/MedievalHeight.js';
import { SETTLEMENTS, settledAt } from './Settlements.js';
import { streamFor } from './Population.js';
import { woodlandAt, DEEP_WOOD } from './Wildlife.js';

/* ------------------------------------------------------------------ */
/* Walkability                                                         */
/* ------------------------------------------------------------------ */

/**
 * The steepest ground this module is willing to call walkable.
 *
 * `MedievalWorld._slope` normalises `|grad| / 2d * 1.15` into 0..1, so 0.78
 * here is a gradient of 0.68, about 34 degrees. That is CONSERVATIVE against
 * what the player can actually do - `CONFIG.player.stepHeight` is 0.45 m and
 * `Climb` handles ledges outright - and conservative is the right direction
 * for a reachability model: under-claiming means a proof built on it is
 * evidence, over-claiming means it is decoration.
 *
 * It is not arbitrary either. Measured across the flood fill from the player
 * spawn, at 0.62 the tops of Grimscar Edge and Blackmarch Bluff come out
 * unreachable - and both are landforms whose own table entry names them as
 * where a settlement wants to stand, so a model that cannot get up them is
 * wrong about the map rather than strict about it. The approach ramps measure
 * 0.63-0.78 on the bluff's west face and 0.14-0.24 on Grimscar's dip slope; at
 * 0.78 both are reachable at every grid granularity tried (4, 5 and 6 m, with
 * and without diagonals) and the reachable fraction of the vale is 89-91%.
 */
export const MAX_WALK_SLOPE = 0.78;

/** `MedievalWorld._slope`, reproduced so this module needs no world. */
export function slopeAt(x, z, height = medievalHeight) {
  const d = 2.5;
  const hx = height(x + d, z) - height(x - d, z);
  const hz = height(x, z + d) - height(x, z - d);
  const s = (Math.hypot(hx, hz) / (2 * d)) * 1.15;
  return s < 0 ? 0 : s > 1 ? 1 : s;
}

/**
 * Deepest water a player can cross on foot, metres.
 *
 * Not chosen here: `medieval-landforms.test.mjs` already uses `WADE = 0.75` to
 * assert that Ashlea Ford and Harrowgate Ford are crossable, and the fords are
 * authored to sit at 39-55 cm precisely so they clear it. Using any other
 * number here would mean this module and that test disagreed about whether the
 * western third of the map is connected to the eastern - and it is exactly that
 * disagreement that makes a reachability proof worthless.
 */
export const WADE = 0.75;

/**
 * Can a player CROSS here?
 *
 * Traversal, not placement - the difference matters and getting it backwards
 * is what made the first run of the reachability proof report half the vale
 * unreachable. The river runs the full width of the map; if wading is not
 * modelled, the only links between the north and south banks are the bridge
 * (which is geometry, not terrain, and a heightfield flood fill cannot see it)
 * and nothing else, so the proof declares Grimscar, St Ceolwine's, Blackmarch
 * and Fenwick Cross - every one of the expansion's settlements - unreachable
 * and is wrong about all four.
 *
 * Deliberately knows nothing about buildings: a building is somewhere you walk
 * AROUND, and treating one as impassable would have the flood fill claim the
 * far side of the castle is unreachable when it is a thirty-second walk.
 */
export function walkableAt(x, z, height = medievalHeight) {
  if (!(x > -HALF + 8 && x < HALF - 8 && z > -HALF + 8 && z < HALF - 8)) return false;
  if (height(x, z) < WATER_Y - WADE) return false;
  return slopeAt(x, z, height) <= MAX_WALK_SLOPE;
}

/**
 * Can something be PUT here?
 *
 * Everything `walkableAt` asks, plus dry land: a relic in the ford is a relic
 * underwater, and the glow reads as a bug rather than as a find.
 */
export function standableAt(x, z, height = medievalHeight) {
  if (height(x, z) < WATER_Y + 0.45) return false;
  if (Math.abs(z - riverZ(x)) < riverHalfWidth(x) + 1) return false;
  return walkableAt(x, z, height);
}

/* ------------------------------------------------------------------ */
/* Connectivity                                                        */
/* ------------------------------------------------------------------ */

/** Grid the planner's own flood fill runs on, metres. */
export const REACH_STEP = 6;

/**
 * The walkable surface the player can actually get to, flood-filled from a
 * start point.
 *
 * This is what turns "on the ground" into "reachable". A relic on a walkable
 * ledge in the middle of the gorge satisfies every per-point test in this file
 * and is still a relic nobody will ever collect; only connectivity can say so.
 *
 * Returned as a probe rather than as a grid, because every caller wants the
 * same question ("is this point in it") and none of them wants to know how the
 * cells are indexed.
 *
 * @returns {{ contains:(x:number,z:number)=>boolean, reached:number, cells:number }}
 */
export function reachableFrom(startX, startZ, {
  height = medievalHeight, step = REACH_STEP,
} = {}) {
  const lim = HALF - 8;
  const n = Math.floor((2 * lim) / step) + 1;
  const seen = new Uint8Array(n * n);
  const walk = (i, k) => walkableAt(-lim + i * step, -lim + k * step, height);
  const cellX = (x) => Math.round((x + lim) / step);
  const cellZ = (z) => Math.round((z + lim) / step);

  const si = cellX(startX);
  const sk = cellZ(startZ);
  const contains = (x, z) => {
    const i = cellX(x);
    const k = cellZ(z);
    return i >= 0 && k >= 0 && i < n && k < n && seen[k * n + i] === 1;
  };
  if (si < 0 || sk < 0 || si >= n || sk >= n || !walk(si, sk)) {
    return { contains: () => false, reached: 0, cells: n * n };
  }

  /* Eight-connected. A four-connected fill on a coarse grid disconnects any
   * ramp that runs diagonally across the lattice, which on this terrain is
   * most of them - the Grimscar dip slope in particular. */
  const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const queue = [sk * n + si];
  seen[sk * n + si] = 1;
  for (let head = 0; head < queue.length; head++) {
    const c = queue[head];
    const i = c % n;
    const k = (c - i) / n;
    for (const [di, dk] of NB) {
      const ni = i + di;
      const nk = k + dk;
      if (ni < 0 || nk < 0 || ni >= n || nk >= n) continue;
      const nc = nk * n + ni;
      if (seen[nc] || !walk(ni, nk)) continue;
      seen[nc] = 1;
      queue.push(nc);
    }
  }
  return { contains, reached: queue.length, cells: n * n };
}

/* ------------------------------------------------------------------ */
/* Prominence                                                          */
/* ------------------------------------------------------------------ */

/**
 * `Relics`' own prominence test, to the metre: how far this point stands above
 * the ground four metres away, taking the LOWEST of four bearings.
 *
 * Reproduced rather than imported because `Relics.js` imports `three` and
 * `Physics`, and because the number this file wants is the terrain's, not the
 * physics surface's - a relic authored on a rooftop the heightfield does not
 * know about would be a relic whose `y` is wrong.
 */
export function prominenceAt(x, z, height = medievalHeight, r = 4) {
  const y = height(x, z);
  let low = Infinity;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const s = height(x + Math.cos(a) * r, z + Math.sin(a) * r);
    if (s < low) low = s;
  }
  return y - low;
}

/* ------------------------------------------------------------------ */
/* Sites                                                               */
/* ------------------------------------------------------------------ */

/** Lift above the surface. `Relics` adds another 0.55 on top of this. */
const RELIC_LIFT = 0.0;
/** Lift for a streamed interior-style pickup, which is placed as authored. */
const CACHE_LIFT = 0.62;

/**
 * Coarse grid the whole search works on, metres.
 *
 * 15 m is a little under the 14 m spacing `Relics` enforces between sites, so
 * two adjacent grid winners are always far enough apart to both survive - and
 * fine enough that a knoll thirty metres across is not stepped over.
 */
const GRID = 15;

/**
 * The distribution grid: the vale split into `SPREAD x SPREAD` cells.
 *
 * The failure this exists to prevent is the one the brief names - relics
 * clustering in the old vale rather than distributing across the new ring.
 * Prominence is not uniform (the castle rise and the western scarp are far
 * lumpier than the southern flats), so taking the N most prominent points in
 * the world puts them all in two places. Sites are therefore taken round-robin
 * across these cells, best-first WITHIN a cell, which spreads by construction.
 * 6 x 6 over 900 m is a 150 m cell - about a minute's walk across.
 */
const SPREAD = 6;

/** Which distribution cell a point falls in. */
function cellOf(x, z) {
  const i = Math.min(SPREAD - 1, Math.max(0, Math.floor(((x + HALF) / (2 * HALF)) * SPREAD)));
  const k = Math.min(SPREAD - 1, Math.max(0, Math.floor(((z + HALF) / (2 * HALF)) * SPREAD)));
  return k * SPREAD + i;
}

/** Distance to the nearest settlement centre, and which one. */
function nearestSettlement(x, z, settlements) {
  let best = null;
  let bestD = Infinity;
  for (const s of settlements) {
    if (!s?.centre) continue;
    const d = Math.hypot(x - s.centre.x, z - s.centre.z);
    if (d < bestD) { bestD = d; best = s; }
  }
  return { s: best, d: bestD };
}

/**
 * True when a point is outside EVERY settlement's radius plus a margin.
 *
 * Asked of every settlement rather than of the nearest one, which is the bug
 * this replaced: the keep approach is a 110 m arc whose centre is nowhere near
 * its houses, so a point 99 m from that centre can easily be nearer to a 16 m
 * parish church - and "the nearest settlement is far enough away" was then
 * true, and wrong, and put a woodland cache inside a hamlet.
 */
function clearOfSettlements(x, z, settlements, margin) {
  for (const s of settlements) {
    if (!s?.centre) continue;
    const need = (s.radius ?? 0) + margin;
    if ((x - s.centre.x) ** 2 + (z - s.centre.z) ** 2 < need * need) return false;
  }
  return true;
}

/**
 * Is there room to walk up to this point and stand beside it?
 *
 * A collectable on a single walkable cell is reachable by the letter of a flood
 * fill and useless in practice - the player cannot get a body next to it, and
 * the pickup sphere is 2 m. Four of the eight compass neighbours at 6 m have to
 * be walkable, which admits a ridge crest (you approach along the ridge) and
 * refuses a pinnacle.
 */
function hasApproach(x, z, height) {
  let room = 0;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    if (walkableAt(x + Math.cos(a) * 6, z + Math.sin(a) * 6, height)) room++;
  }
  return room >= 4;
}

/**
 * The scale a hiding place is measured at, metres.
 *
 * Measured, not chosen. Over the vale's 57 lattice hilltops the prominence
 * distribution by radius is
 *
 *     r =  4 m   median 0.29 m   only  1 clears 2.5 m
 *     r = 12 m   median 1.32 m        16 clear  2.5 m
 *     r = 25 m   median 3.06 m        33 clear  2.5 m
 *     r = 40 m   median 4.70 m        43 clear  2.5 m
 *
 * which is the whole story of why `Relics`' own dart loop finds nothing here.
 * Its `MIN_PROMINENCE = 2.5` at r = 4 is an ARCHITECTURAL test - a parapet, a
 * ledge, a rooftop - and this world's relief is 25-40 m broad rolling ground
 * with almost no four-metre steps in it. Asking the same question at 25 m asks
 * "is this the top of a rise", which is the thing a player can actually see and
 * walk up.
 */
export const PROMINENCE_R = 25;

/**
 * Every candidate hiding place on the heightfield, scored.
 *
 * The lattice is walked exhaustively - 3,249 points against `Relics`' 330
 * darts - and each walkable one is scored for how much it rewards the walk:
 *
 *   prominence  the top of a rise is a place; a point on a slope is not
 *   woodland    somewhere you have to go into the trees to find
 *   remoteness  distance beyond the nearest settlement's own radius, capped,
 *               so a relic on the market square scores nothing and one over
 *               the next hill scores well
 *
 * A LOCAL MAXIMUM bonus rather than a local-maximum filter. Filtering on it
 * caps the whole map at 57 sites (measured), which is not enough to fill the
 * budget; scoring on it means the hilltops win their cells and the rest of the
 * budget still lands somewhere interesting.
 *
 * @returns {Array<{x:number,z:number,y:number,prom:number,score:number,
 *                  cell:number,wood:number,settled:number,top:boolean,
 *                  near:string|null,nearD:number}>}
 */
export function candidateSites({
  height = medievalHeight, settlements = SETTLEMENTS, minScore = 0.6,
} = {}) {
  const out = [];
  const lim = HALF - 26;
  /* One pass to fill a height lattice, then one to test it. Sampling the
   * neighbours from the lattice rather than re-evaluating `medievalHeight`
   * turns nine height calls per point into one - and `medievalHeight` is the
   * single most expensive function in this world. */
  const n = Math.floor((2 * lim) / GRID) + 1;
  const h = new Float64Array(n * n);
  for (let k = 0; k < n; k++) {
    const z = -lim + k * GRID;
    for (let i = 0; i < n; i++) h[k * n + i] = height(-lim + i * GRID, z);
  }
  for (let k = 1; k < n - 1; k++) {
    for (let i = 1; i < n - 1; i++) {
      const x = -lim + i * GRID;
      const z = -lim + k * GRID;
      if (!standableAt(x, z, height)) continue;
      const settled = settledAt(x, z);
      // Beaten earth is a street. A relic in the middle of one is not hidden.
      if (settled > 0.25) continue;

      const y = h[k * n + i];
      let top = true;
      for (let dk = -1; dk <= 1 && top; dk++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dk) continue;
          if (h[(k + dk) * n + i + di] >= y) { top = false; break; }
        }
      }
      const prom = prominenceAt(x, z, height, PROMINENCE_R);
      const wood = woodlandAt(x, z);
      const near = nearestSettlement(x, z, settlements);
      const remote = Math.min(1, Math.max(0, (near.d - (near.s?.radius ?? 0)) / 160));
      const score = Math.min(1, Math.max(0, prom / 6)) * 1.4
        + (top ? 1.1 : 0)
        + Math.min(1, Math.max(0, (wood - DEEP_WOOD) / 0.18)) * 0.8
        + remote * 0.7;
      if (score < minScore) continue;
      out.push({
        x, z, y, prom, score, top,
        cell: cellOf(x, z),
        wood,
        settled,
        near: near.s?.id ?? null,
        nearD: near.d,
      });
    }
  }
  return out;
}

/**
 * Take from `pool` round-robin across the distribution cells, best-first within
 * each, honouring a minimum spacing.
 *
 * @param {Array<{x:number,z:number,cell:number}>} pool
 * @param {number} want
 * @param {number} apart metres
 */
function spread(pool, want, apart) {
  const byCell = new Map();
  for (const c of pool) {
    if (!byCell.has(c.cell)) byCell.set(c.cell, []);
    byCell.get(c.cell).push(c);
  }
  /* Cells visited in a fixed order and their contents sorted by a fixed key,
   * so the same terrain always yields the same treasure map. Ties broken on
   * position, because two knolls of identical prominence are otherwise ordered
   * by whatever order the lattice scan happened to produce. */
  const cells = [...byCell.keys()].sort((a, b) => a - b);
  for (const c of cells) {
    byCell.get(c).sort((a, b) => (b.score ?? b.prom ?? 0) - (a.score ?? a.prom ?? 0)
      || a.x - b.x || a.z - b.z);
  }
  const out = [];
  const a2 = apart * apart;
  let progress = true;
  while (out.length < want && progress) {
    progress = false;
    for (const c of cells) {
      if (out.length >= want) break;
      const list = byCell.get(c);
      while (list.length) {
        const cand = list.shift();
        let clash = false;
        for (const o of out) {
          if ((o.x - cand.x) ** 2 + (o.z - cand.z) ** 2 < a2) { clash = true; break; }
        }
        if (clash) continue;
        out.push(cand);
        progress = true;
        break;
      }
    }
  }
  return out;
}

/**
 * Relic sites for `world._roofs`.
 *
 * Three sources, in the order they are added so that the named places win the
 * spacing contest against a merely-tall lump of hillside:
 *
 *   1. LANDMARKS - `LANDFORMS[].site` and the banks of every named river reach.
 *      These are the places the terrain module itself considers worth naming,
 *      and putting a relic at each is what makes walking to the far scarp or
 *      the gorge pay something.
 *   2. OUTSKIRTS - one ring position just beyond each settlement's own radius.
 *      Derived from the table, so a settlement added later gets one.
 *   3. PROMINENCES - the local maxima, spread round-robin over the vale.
 *
 * @param {object} ctx
 * @param {number} [ctx.want] how many to publish
 * @returns {Array<{x:number,y:number,z:number,source:string,cell:number}>}
 */
export function planRelicSites({
  height = medievalHeight,
  settlements = SETTLEMENTS,
  want = 84,
  apart = 26,
  from = { x: CIRCLE.x + 12, z: CIRCLE.z + 7 },
  reach = null,
} = {}) {
  const rnd = streamFor('medieval:treasure');
  /* Connectivity, computed ONCE and shared with the cache planner by the
   * caller. Everything else in this function is a per-point test and would
   * happily place a relic on a walkable shelf on the wrong side of the gorge. */
  const walkable = reach ?? reachableFrom(from.x, from.z, { height });
  const out = [];
  const a2 = apart * apart;
  const take = (x, z, source) => {
    if (out.length >= want) return false;
    if (!standableAt(x, z, height)) return false;
    if (!walkable.contains(x, z)) return false;
    if (!hasApproach(x, z, height)) return false;
    for (const o of out) if ((o.x - x) ** 2 + (o.z - z) ** 2 < a2) return false;
    out.push({ x, y: height(x, z) + RELIC_LIFT, z, source, cell: cellOf(x, z) });
    return true;
  };

  /* 1. Landmarks. Offsets are tried in a fixed order so a landmark whose exact
   *    site is in the water still contributes something on its bank. */
  const RING = [[0, 0], [11, 6], [-9, 12], [14, -10], [-15, -8], [6, 18], [-20, 4]];
  for (const lf of LANDFORMS) {
    if (!lf.site) continue;
    for (const [dx, dz] of RING) if (take(lf.site.x + dx, lf.site.z + dz, `landform:${lf.id}`)) break;
  }
  for (const f of RIVER_FEATURES) {
    // Both banks: a ford is worth crossing, and a pool is worth walking round.
    const bank = riverHalfWidth(f.x) + 12;
    for (const side of [1, -1]) {
      for (const dx of [0, 22, -22]) {
        const x = f.x + dx;
        if (take(x, riverZ(x) + side * bank, `river:${f.id}`)) break;
      }
    }
  }
  // The stone circle: the one landmark the player is standing next to on
  // arrival, so the mechanic introduces itself.
  take(CIRCLE.x - CIRCLE.r - 6, CIRCLE.z - CIRCLE.r - 4, 'circle');

  /* 2. Settlement outskirts - just outside the beaten earth, in a direction
   *    that varies per settlement so they are not all due north. */
  for (const s of settlements) {
    if (!s?.centre) continue;
    const r = (s.radius ?? 40) * 1.18 + 14;
    const a0 = rnd() * Math.PI * 2;
    for (let k = 0; k < 8; k++) {
      const a = a0 + (k / 8) * Math.PI * 2;
      if (take(s.centre.x + Math.cos(a) * r, s.centre.z + Math.sin(a) * r, `outskirt:${s.id}`)) break;
    }
  }

  /* 3. Prominences, spread across the vale. Asked for more than is left over
   *    because `take` re-applies the spacing rule against everything above. */
  const pool = candidateSites({ height, settlements });
  for (const c of spread(pool, (want - out.length) * 2, apart)) {
    if (out.length >= want) break;
    take(c.x, c.z, 'prominence');
  }
  return out;
}

/**
 * Caches hidden in the deep woods, published as doorless `enterables` so
 * `Interiors` streams them.
 *
 * `Interiors` reads `e.doors || []`, `e.lifts || []` and `e.collectibleSpots`,
 * so a descriptor that is nothing but a label and a spot is a valid one - and
 * it buys the whole streaming path (spawn at 46 m, despawn at 64 m, collected
 * state remembered by tag) for a hollow tree with no door on it.
 *
 * They go where the predators are on purpose: `Wildlife.planBeasts` puts packs
 * in `woodlandAt(x, z) > DEEP_WOOD` and refuses to put them near a road, and
 * this puts the `prize` tier in exactly that country. The reward for walking
 * into the wolves' half of the map is the only reason to do it.
 *
 * @returns {Array<{x:number,y:number,z:number,tier:string,label:string}>}
 */
export function planForestCaches({
  height = medievalHeight, settlements = SETTLEMENTS, want = 16, apart = 70,
  from = { x: CIRCLE.x + 12, z: CIRCLE.z + 7 },
  reach = null,
} = {}) {
  const rnd = streamFor('medieval:forest-cache');
  const walkable = reach ?? reachableFrom(from.x, from.z, { height });
  const out = [];
  const a2 = apart * apart;
  for (let t = 0; t < 40000 && out.length < want; t++) {
    const x = (rnd() - 0.5) * 2 * (HALF - 40);
    const z = (rnd() - 0.5) * 2 * (HALF - 40);
    if (woodlandAt(x, z) <= DEEP_WOOD + 0.03) continue;
    if (!standableAt(x, z, height)) continue;
    if (!walkable.contains(x, z)) continue;
    if (!hasApproach(x, z, height)) continue;
    if (settledAt(x, z) > 0.02) continue;
    if (!clearOfSettlements(x, z, settlements, 45)) continue;
    let clash = false;
    for (const o of out) if ((o.x - x) ** 2 + (o.z - z) ** 2 < a2) { clash = true; break; }
    if (clash) continue;
    /* The deeper the wood the better the find. `prize` is three relic coins
     * and a shield charge (see `Interiors._contentsFor`), so it is worth the
     * walk past whatever lives out here. */
    const w = woodlandAt(x, z);
    const tier = w > 0.30 ? 'prize' : w > 0.23 ? 'rare' : 'common';
    out.push({
      x, y: height(x, z) + CACHE_LIFT, z, tier,
      label: `woodcache@${x | 0},${z | 0}`,
      wood: w,
      cell: cellOf(x, z),
    });
  }
  return out;
}
