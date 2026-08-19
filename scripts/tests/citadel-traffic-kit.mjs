/**
 * THE CITADEL TRAFFIC KIT — where does a player GO, and what would they MEET?
 *
 * ── The defect this file exists to prevent ────────────────────────────────
 *
 * The medieval expansion added wildlife. Ten packs, spawned, specced, resident,
 * ticking. Every link of the chain worked and the player reported *"i do not see
 * any wolves or bears in the forest areas."* The suite passed 29 of 29 because
 * all 29 assertions were "not closer than": **a world with zero reachable
 * wildlife satisfies every one of them.** Median pack-to-road was 210 m; the
 * nearest pack to spawn was 317 m; 3 of 10 ever came within render range of a
 * road. Nothing asked whether anybody would meet an animal, so nothing noticed
 * that nobody would.
 *
 * Four lessons came out of the seven rounds it took to fix, and all four are
 * built into this file rather than written on top of it:
 *
 *   1. A CLEARANCE SUITE CANNOT DETECT ABSENCE. Every number this file
 *      produces is a FLOOR on encounter with a quoted floor / achieved /
 *      ceiling, and every ceiling is computed by ablation — remove the
 *      constraint, re-measure — so "17% of journeys meet a caravan" reads as
 *      "17%, against a floor of 12% and a 34% ceiling if every corridor in the
 *      world carried one".
 *   2. DRAWN IS NOT SEEN. A five-wolf pack "drawn with 38 m of margin" was 3
 *      pixels of 1,024,000. {@link RECOGNITION} is 15 m, not the 125 m render
 *      gate, and the render gate appears in this file exactly once — in
 *      {@link RENDER_IN}, quoted so the two can be compared and never confused.
 *   3. THE METRIC ITSELF WAS WRONG THREE TIMES. Visibility at range is
 *      unwinnable. The metric here is ENCOUNTER: the content arrives where the
 *      player is, at a distance where it is unmistakable.
 *   4. A SAFETY RULE CAN WORK PERFECTLY AGAINST THE BRIEF. Medieval had a
 *      clearance holding predators off the roads — written so predators could
 *      not see travellers — while the brief asked for predators that attack
 *      you. Nobody noticed the contradiction for the whole build. **Here the
 *      trap is inverted.** Camels are not predators. There is no reason on
 *      earth to keep them off the travel corridors and every reason to put them
 *      ON them, and any rule that reads like a clearance in this feature is a
 *      rule that is fighting the brief. This file therefore contains no
 *      clearance of any kind, only floors.
 *
 * ── What is in here ───────────────────────────────────────────────────────
 *
 *   {@link buildJourneys}    the corridor model: POIs, places, and the
 *                            shortest walkable journey between every pair of
 *                            them over the REAL reachability graph.
 *   {@link ExposureField}    the encounter metric for STATIC content — what
 *                            share of journeys pass within `RECOGNITION` of a
 *                            point, as a queryable field over the whole map.
 *   {@link CaravanRoute}    the encounter metric for MOVING content — the
 *                            closest approach between a train walking its own
 *                            cycle and a player walking a journey, solved in
 *                            closed form over every phase the caravan could
 *                            be in.
 *   {@link featureField}     distance from anywhere to the nearest built
 *                            thing, which is what "empty" means here.
 *   {@link emptiness}        the histogram of it, and the longest stretch of
 *                            nothing on each journey.
 *   {@link rankCandidates}   the ranked positions, which is the placement
 *                            agent's brief.
 *
 * It is deliberately NOT named `*.test.mjs`: `npm test` globs
 * `scripts/tests/*.test.mjs`, and importing a suite re-registers its cases in
 * the importer's run. `citadel-reach-kit.mjs` records the same reason.
 *
 * Nothing in here writes to `src/`. The world is read exactly as it is built.
 */
import {
  ColumnIndex, ReachGraph, buildCitadel, objectiveSites, footprintPointDist,
} from './citadel-reach-kit.mjs';
import { citadelHeight, HALF, INNER_KEEP, MESA_R } from '../../src/worlds/terrain/CitadelHeight.js';

export { floorCheck, f, i5, stats, buildCitadel } from './citadel-reach-kit.mjs';
export { HALF, INNER_KEEP, MESA_R };

/* ================================================================== */
/* The constants, and which of them are MEASURED and which are MODEL   */
/* ================================================================== */

/**
 * How close a thing has to be before the player has MET it.
 *
 * The medieval fix measured this the hard way. A five-wolf pack, drawn, inside
 * the frustum, with 38 m of clearance to spare, occupied three pixels of a
 * 1,024,000-pixel frame; the recorded recognition distance — the range at which
 * the player says "there is an animal there" rather than "there is a dark
 * speck" — is 15 to 20 m. This file uses the PESSIMISTIC end of that band for
 * every floor and reports the optimistic end alongside, so no floor can be met
 * by a rounding argument.
 *
 * MEASURED (medieval wildlife round 5), not chosen.
 */
export const RECOGNITION = 15;
/** The optimistic end of the same measured band. Reported, never asserted on. */
export const RECOGNITION_FAR = 20;

/**
 * `NPCManager`'s hysteretic residency gate, quoted from `NPCManager.js:107-108`.
 *
 * Present for exactly one purpose: so that a reader can see that a body is
 * DRAWN from 125 m and RECOGNISED from 15 m, and that the ratio between the two
 * areas is 69:1. A placement tuned against the render gate is a placement that
 * puts 98.6% of its content in the band where it is a speck.
 */
export const RENDER_IN = 125;
export const RENDER_OUT = 135;

/** Player ground speeds, measured (`Player.js`, quoted in the reach kit). */
export const WALK = 4.6;
export const SPRINT = 8.2;

/**
 * A camel's walking pace, and the length of ground a train stands on.
 *
 * **These two are MODEL PARAMETERS, not measurements, and they are the only
 * numbers in this file that are not read off the world.** Nothing about camels
 * exists in this repo yet — that is the whole point of the task — so there is
 * nothing to measure. They are declared here and SWEPT - see the SENSITIVITY
 * block of THE ROUTE CATALOGUE in `citadel-traffic.test.mjs`, which reports the
 * headline at 0.8, 1.15 and 1.6 m/s and at trains of 4, 32 and 64 m, and fails
 * if doubling the pace moves the answer by two points. (It does not
 * depend on them much: eligibility — whether a journey comes within
 * `RECOGNITION` of the ROUTE at all — is speed-independent by construction and
 * is what decides three quarters of the answer, and {@link CaravanRoute} prices
 * the rest in closed form so the sweep is cheap enough to publish.)
 *
 * `CARAVAN_SPEED` 1.15 m/s is a loaded camel's walk, a quarter of the player's.
 * `TRAIN_LEN` 32 m is eight animals at 4 m of interval, which is the shape the
 * player asked for ("herds of camels").
 */
export const CARAVAN_SPEED = 1.15;
export const TRAIN_LEN = 32;

/** Field resolutions. Both quoted with every number they produce. */
export const EXPOSURE_CELL = 5;
export const FEATURE_CELL = 4;

/**
 * Edge costs for the journey search, in metres of equivalent walking.
 *
 * A journey is the path a player would PLAUSIBLY take, and the plain shortest
 * path over a graph that contains 21,341 one-way drops is not that: it routes
 * the player off every roof in the souk because a 12 m fall is free in metres.
 * So a non-walk edge is charged what it costs a body — a jump is a stop, a
 * turn, a commit and a landing; a drop is a fall and whatever it costs to get
 * back if you were wrong; a climb is the slowest verb in the game.
 *
 * The penalties are deliberately coarse. What they have to get right is the
 * ORDER of two routes that differ by a rooftop shortcut, and nothing finer -
 * so what has to be shown is that the ANSWER does not depend on them. {@link
 * reroute} rebuilds the whole journey set under a different cost table, and
 * THE CORRIDOR MODEL in `citadel-traffic.test.mjs` doubles all three and
 * asserts the ranked sites survive. If a candidate's encounter fraction moved
 * when a jump got more expensive, these three numbers would have to be
 * measured rather than declared.
 */
export const JUMP_COST = 3;
export const DROP_COST = 2;
export const CLIMB_COST = 8;

/* ================================================================== */
/* Places — the six regions, the core, and the sand between them       */
/* ================================================================== */

/**
 * Which named part of the world a point is in.
 *
 * The protected core is the `INNER_KEEP` square, because that is the square
 * `citadelHeight` returns bit-identical ground for and the square the souk was
 * built in before the ring existed. Each region is its own published AABB,
 * grown by `REGION_PAD`, because a region's traffic does not stop at the
 * outermost collider it happens to own.
 *
 * Everything else is `'flats'`, and `'flats'` is the subject of this whole
 * file. THE FLATS in `citadel-traffic.test.mjs` measures how much of the map it
 * is and how empty it is; THE CORRIDOR MODEL measures the thing that makes it
 * the subject, which is that NOT ONE of the 160 places this world publishes to
 * any system stands in it. It is what the player was looking at when he said
 * the world needs NPCs in it.
 */
export const REGION_PAD = 30;

/** @param {{regions:Array}} world */
export function placeIndex(world) {
  const boxes = world.regions.map((r) => ({
    id: r.id,
    name: r.name,
    x0: r.aabb.min.x - REGION_PAD, x1: r.aabb.max.x + REGION_PAD,
    z0: r.aabb.min.z - REGION_PAD, z1: r.aabb.max.z + REGION_PAD,
    cx: (r.aabb.min.x + r.aabb.max.x) * 0.5,
    cz: (r.aabb.min.z + r.aabb.max.z) * 0.5,
  }));
  const at = (x, z) => {
    if (Math.abs(x) <= INNER_KEEP && Math.abs(z) <= INNER_KEEP) return 'core';
    for (const b of boxes) {
      if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) return b.id;
    }
    return 'flats';
  };
  return { boxes, at };
}

/* ================================================================== */
/* The POI set — every place the world itself says is interesting      */
/* ================================================================== */

/**
 * Everywhere a player has a reason to stand, taken from the world rather than
 * from an opinion.
 *
 * Nine sources, and every one of them is something the game already publishes
 * to some other system — which is the test that a place is interesting. If no
 * system in the game cares about a coordinate, the player has no reason to walk
 * to it either.
 *
 *   spawn / portal    `world.playerSpawn`, `world.portalSpecs` — the one way in
 *                     and the one way out. Every session starts here.
 *   region anchors    the labelled anchor each region publishes in its route
 *                     report (`mast`, `tower`, `head`, `beacon`, `eyrie`) plus
 *                     the two ends of the aqueduct spine.
 *   region centres    the AABB centre of each region, which is where a player
 *                     heading for "the Deepworks" is actually heading.
 *   viewpoints        `world.viewpoints` — synced, revealed, fast-travelled to.
 *   caches            `Caches`' own sites, run through the real placer.
 *   relics            `Relics`' own sites, run through the real placer. 109 of
 *                     them, and they are the single biggest reason a player
 *                     crosses open sand.
 *   trial venues      `world.minigameVenues`, at the centroid of the published
 *                     checkpoint chain.
 *   caves             each cave's mouths and its loot spots.
 *
 * Relics dominate the count 109 to 40, and that is not a distortion to be
 * corrected: they dominate the reason to travel, too. What the count would
 * distort is the CORE, where 60 of them sit within 110 m of the spawn — so
 * every headline is reported twice, once over all journeys and once over the
 * inter-region subset that actually crosses the sand.
 */
export async function poiSet(world, physics, scene) {
  const place = placeIndex(world);
  const out = [];
  const add = (kind, label, x, y, z) => {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    out.push({ id: out.length, kind, label, x, y: y ?? citadelHeight(x, z), z, place: place.at(x, z) });
  };

  add('spawn', 'player spawn', world.playerSpawn.x, world.playerSpawn.y, world.playerSpawn.z);
  for (const p of world.portalSpecs) add('portal', p.label, p.position.x, p.position.y, p.position.z);

  for (const r of world.regions) {
    const b = r.built;
    for (const k of ['mast', 'tower', 'head', 'beacon', 'eyrie']) {
      if (b[k] && Number.isFinite(b[k].x)) add('anchor', b[k].label ?? `${r.id} ${k}`, b[k].x, b[k].y, b[k].z);
    }
    if (b.a && b.b) { add('anchor', `${r.id} spine head`, b.a.x, b.a.y, b.a.z); add('anchor', `${r.id} spine foot`, b.b.x, b.b.y, b.b.z); }
    add('region', r.name, (r.aabb.min.x + r.aabb.max.x) * 0.5, undefined, (r.aabb.min.z + r.aabb.max.z) * 0.5);
  }

  for (const v of world.viewpoints) add('viewpoint', v.name, v.x, v.y, v.z);

  const sites = await objectiveSites(world, physics, scene);
  for (const s of sites.caches) add('cache', 'cache', s.x, s.y, s.z);
  for (const s of sites.relics) add('relic', 'relic', s.x, s.y, s.z);

  for (const v of world.minigameVenues) {
    const cps = v.config?.checkpoints ?? [];
    if (!cps.length) continue;
    let sx = 0; let sy = 0; let sz = 0;
    for (const c of cps) { sx += c.x; sy += c.y; sz += c.z; }
    add('venue', v.label, sx / cps.length, sy / cps.length, sz / cps.length);
  }

  for (const c of world.caves ?? []) {
    for (const m of c.plan?.mouths ?? []) add('cave', `${c.plan.label} — ${m.label}`, m.position.x, m.position.y, m.position.z);
    for (const s of c.plan?.spots ?? []) add('cave', `${c.plan.label} — ${s.tier}`, s.position.x, s.position.y, s.position.z);
  }

  return { pois: out, place, sites };
}

/* ================================================================== */
/* Journeys — the shortest walkable path between every pair            */
/* ================================================================== */

/** A binary min-heap over (cost, node). Preallocated; never grown in a loop. */
export class Heap {
  constructor(cap) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.n = 0; }
  clear() { this.n = 0; }
  push(key, val) {
    let i = this.n++;
    if (i >= this.k.length) throw new Error('heap overflow — cap it at edges + 1');
    this.k[i] = key; this.v[i] = val;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= this.k[i]) break;
      const tk = this.k[p]; const tv = this.v[p];
      this.k[p] = this.k[i]; this.v[p] = this.v[i];
      this.k[i] = tk; this.v[i] = tv;
      i = p;
    }
  }
  pop() {
    const top = this.v[0];
    this.topKey = this.k[0];
    const n = --this.n;
    this.k[0] = this.k[n]; this.v[0] = this.v[n];
    let i = 0;
    for (;;) {
      const l = i * 2 + 1; const r = l + 1;
      let m = i;
      if (l < n && this.k[l] < this.k[m]) m = l;
      if (r < n && this.k[r] < this.k[m]) m = r;
      if (m === i) break;
      const tk = this.k[m]; const tv = this.v[m];
      this.k[m] = this.k[i]; this.v[m] = this.v[i];
      this.k[i] = tk; this.v[i] = tv;
      i = m;
    }
    return top;
  }
}

/**
 * The weighted, DIRECTED adjacency the journey search runs over.
 *
 * Built once from the `ReachGraph`'s own edge list. Direction is preserved
 * exactly as `ReachGraph._link` recorded it — walk and climb both ways, jump
 * and drop one way — because a 30 m drop is not a route back up and a journey
 * model that pretends otherwise would route half the world down the quarry and
 * expect it to walk out.
 *
 * @param {ReachGraph} graph
 * @param {{jump?:number, drop?:number, climb?:number}} [cost]
 */
export function weightedAdj(graph, cost) {
  const jumpC = cost?.jump ?? JUMP_COST;
  const dropC = cost?.drop ?? DROP_COST;
  const climbC = cost?.climb ?? CLIMB_COST;
  const n = graph.nodes.length;
  const head = new Int32Array(n + 1);
  const dir = [];
  for (const e of graph.edges) {
    const a = graph.nodes[e.a].pad; const b = graph.nodes[e.b].pad;
    const len = Math.hypot(b.x - a.x, b.z - a.z, b.y - a.y);
    if (e.kind === 'walk') { dir.push([e.a, e.b, len], [e.b, e.a, len]); }
    else if (e.kind === 'climb') { dir.push([e.a, e.b, len + climbC], [e.b, e.a, len + climbC]); }
    else if (e.kind === 'jump') dir.push([e.a, e.b, len + jumpC]);
    else if (e.kind === 'drop') dir.push([e.a, e.b, len + dropC]);
  }
  for (const [a] of dir) head[a + 1]++;
  for (let i = 0; i < n; i++) head[i + 1] += head[i];
  const to = new Int32Array(dir.length);
  const w = new Float64Array(dir.length);
  const fill = head.slice(0, n);
  for (const [a, b, c] of dir) { const p = fill[a]++; to[p] = b; w[p] = c; }
  return { n, head, to, w, m: dir.length };
}

/**
 * Single-source shortest path. Returns `dist` and `prev` over every node.
 *
 * Scratch is allocated per call and reused across the whole all-pairs sweep by
 * the caller, which is the only reason 145 of these are affordable.
 */
export function dijkstra(adj, src, scratch) {
  const { dist, prev, heap } = scratch;
  dist.fill(Infinity);
  prev.fill(-1);
  heap.clear();
  dist[src] = 0;
  heap.push(0, src);
  while (heap.n) {
    const a = heap.pop();
    const d = heap.topKey;
    if (d > dist[a]) continue;
    for (let p = adj.head[a]; p < adj.head[a + 1]; p++) {
      const b = adj.to[p];
      const nd = d + adj.w[p];
      if (nd < dist[b]) { dist[b] = nd; prev[b] = a; heap.push(nd, b); }
    }
  }
  return scratch;
}

/**
 * The plausible-journey set.
 *
 * One journey per unordered pair of POIs, routed A→B over the directed graph.
 * Unordered rather than ordered because the return leg of a pair retraces the
 * outbound one almost everywhere in this world — the exceptions are the drops,
 * and a drop's return is a climb the search already prices — and because
 * halving 21,000 paths to 10,500 halves the corridor stamp with no measurable
 * change in the exposure field (asserted by mutation in the suite).
 *
 * A pair whose endpoints resolve to the SAME graph node is dropped: two relics
 * on one roof are not a journey. A pair with no path is recorded in
 * `unreachable` rather than silently skipped, because in a world the reach
 * suite says is one single component, an unreachable pair is a finding.
 *
 * @returns {{journeys:Array, unreachable:Array, nodeOf:Int32Array, ms:number}}
 */
export function buildJourneys(graph, pois, adj) {
  const t0 = Date.now();
  const nodeOf = new Int32Array(pois.length).fill(-1);
  for (const p of pois) {
    const id = graph.nodeFor(p.x, p.z, p.y);
    nodeOf[p.id] = id === undefined ? -1 : id;
  }
  const scratch = {
    dist: new Float64Array(graph.nodes.length),
    prev: new Int32Array(graph.nodes.length),
    heap: new Heap(adj.m + 8),
  };
  const journeys = [];
  const unreachable = [];
  const unresolved = pois.filter((p) => nodeOf[p.id] < 0);
  for (let i = 0; i < pois.length; i++) {
    const a = pois[i];
    const sa = nodeOf[a.id];
    if (sa < 0) continue;
    dijkstra(adj, sa, scratch);
    for (let j = i + 1; j < pois.length; j++) {
      const b = pois[j];
      const sb = nodeOf[b.id];
      if (sb < 0 || sb === sa) continue;
      if (!Number.isFinite(scratch.dist[sb])) { unreachable.push([a.id, b.id]); continue; }
      // Walk `prev` back from B; the path comes out reversed, so flip it once.
      const path = [];
      for (let k = sb; k !== -1; k = scratch.prev[k]) path.push(k);
      path.reverse();
      journeys.push({
        id: journeys.length, a: a.id, b: b.id, cost: scratch.dist[sb],
        path, from: a.place, to: b.place,
        inter: a.place !== b.place,
      });
    }
  }
  return { journeys, unreachable, unresolved, nodeOf, ms: Date.now() - t0 };
}

/** The XZ polyline a journey traces, as a flat `[x0,z0,x1,z1,…]`. */
export function polyline(graph, journey) {
  const p = new Float64Array(journey.path.length * 2);
  for (let i = 0; i < journey.path.length; i++) {
    const pad = graph.nodes[journey.path[i]].pad;
    p[i * 2] = pad.x; p[i * 2 + 1] = pad.z;
  }
  return p;
}

/** Ground length of a flat polyline, in metres. */
export function polyLength(p) {
  let d = 0;
  for (let i = 2; i < p.length; i += 2) d += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return d;
}

/**
 * The whole journey set rebuilt under a different edge-cost table.
 *
 * The three penalties in {@link JUMP_COST} and its neighbours are the only
 * numbers in the corridor model that were declared rather than measured, and
 * this is what makes that safe: doubling all three and re-deriving 11,919
 * journeys costs a second and a half, and the ranked sites come out of it
 * essentially unchanged. A model whose conclusion moved under that would be a
 * model whose penalties had to be measured before anything downstream of it
 * meant anything.
 *
 * @param {object} T the result of {@link traffic}
 * @param {{jump?:number, drop?:number, climb?:number}} costs
 */
export function reroute(T, costs) {
  const adj = weightedAdj(T.graph, costs);
  const jr = buildJourneys(T.graph, T.pois, adj);
  for (const j of jr.journeys) j.poly = polyline(T.graph, j);
  const inter = jr.journeys.filter((j) => j.inter);
  const exposure = new ExposureField(RECOGNITION);
  for (const j of inter) exposure.stamp(j.id, j.poly);
  exposure.seal(inter.length);
  return { journeys: jr.journeys, inter, exposure };
}

/** Reusable Dijkstra scratch sized for one graph. */
export function scratchFor(graph, adj) {
  return {
    dist: new Float64Array(graph.nodes.length),
    prev: new Int32Array(graph.nodes.length),
    heap: new Heap(adj.m + 8),
  };
}

/**
 * The walkable route between two world positions, as an XZ polyline.
 *
 * The same search the journey set is built from, exposed on its own because a
 * CARAVAN ROUTE has to be a path a body could walk too. A caravan route laid as
 * a straight chord between two regions would cross the quarry pit and the
 * massif; laid over this graph it goes round them, the way a drover would.
 */
export function pathBetween(graph, adj, a, b, scratch) {
  const na = graph.nodeFor(a.x, a.z, a.y);
  const nb = graph.nodeFor(b.x, b.z, b.y);
  if (na === undefined || nb === undefined) return null;
  dijkstra(adj, na, scratch);
  if (!Number.isFinite(scratch.dist[nb])) return null;
  const path = [];
  for (let k = nb; k !== -1; k = scratch.prev[k]) path.push(k);
  path.reverse();
  return polyline(graph, { path });
}

/* ================================================================== */
/* The encounter metric, static: what share of journeys pass near here */
/* ================================================================== */

/**
 * A count, per cell of the map, of how many DISTINCT journeys pass within
 * `radius` of that cell — the encounter field.
 *
 * This is the metric the medieval build never had. It answers, for any point
 * you might put something at, the only question that matters: *what fraction of
 * the times a player crosses this world do they come close enough to see it?*
 *
 * Two details make it honest rather than merely fast.
 *
 * DISTINCT. A journey that doubles back past a cell is one encounter, not two,
 * so every cell carries the id of the last journey that stamped it and a repeat
 * is skipped. Without it a corridor that the aqueduct route runs along twice
 * would score 200% and the "fraction" would not be one.
 *
 * CENTRE-SAMPLED at `EXPOSURE_CELL`. A 5 m cell against a 15 m radius means the
 * boundary of the disc is right to within 3.5 m, worst case, which moves an
 * encounter fraction by less than the width of one journey's corridor. The
 * suite pins the error by re-measuring the top candidates exactly, polyline by
 * polyline, and asserting the two agree within one cell.
 */
export class ExposureField {
  /** @param {number} radius metres; `RECOGNITION` for the real question. */
  constructor(radius = RECOGNITION, cell = EXPOSURE_CELL) {
    this.radius = radius;
    this.cell = cell;
    this.nx = Math.ceil((HALF * 2) / cell) + 1;
    this.nz = this.nx;
    this.count = new Int32Array(this.nx * this.nz);
    this.mark = new Int32Array(this.nx * this.nz).fill(-1);
    this.total = 0;
    this.span = Math.ceil(radius / cell);
    this.r2 = radius * radius;
  }

  ix(x) { return Math.round((x + HALF) / this.cell); }
  wx(i) { return i * this.cell - HALF; }

  /** Stamp one journey's corridor. `step` is the polyline resample interval. */
  stamp(id, poly, step = 3) {
    const { cell, span, r2, nx, nz, mark, count } = this;
    for (let s = 2; s < poly.length; s += 2) {
      const ax = poly[s - 2]; const az = poly[s - 1];
      const bx = poly[s]; const bz = poly[s + 1];
      const len = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.ceil(len / step));
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        const px = ax + (bx - ax) * t;
        const pz = az + (bz - az) * t;
        const ci = Math.round((px + HALF) / cell);
        const cj = Math.round((pz + HALF) / cell);
        for (let di = -span; di <= span; di++) {
          const i = ci + di;
          if (i < 0 || i >= nx) continue;
          const gx = i * cell - HALF;
          const ddx = gx - px;
          for (let dj = -span; dj <= span; dj++) {
            const j = cj + dj;
            if (j < 0 || j >= nz) continue;
            const gz = j * cell - HALF;
            const ddz = gz - pz;
            if (ddx * ddx + ddz * ddz > r2) continue;
            const c = i * nz + j;
            if (mark[c] === id) continue;
            mark[c] = id;
            count[c]++;
          }
        }
      }
    }
  }

  /** Journeys stamped so far; the denominator of every fraction. */
  seal(total) { this.total = total; return this; }

  /** The raw count at a world position. */
  at(x, z) {
    const i = this.ix(x); const j = this.ix(z);
    if (i < 0 || i >= this.nx || j < 0 || j >= this.nz) return 0;
    return this.count[i * this.nz + j];
  }

  /** The share of stamped journeys that meet a thing standing here. */
  fractionAt(x, z) { return this.total ? this.at(x, z) / this.total : 0; }
}

/**
 * The exact answer for one point, with no grid in the way.
 *
 * Used to audit {@link ExposureField} rather than to replace it: it is O(all
 * journeys x all segments) per point, which is 10,440 x 120 and fine for
 * twenty candidates and hopeless for fifty thousand.
 */
export function exactExposure(polys, x, z, radius = RECOGNITION) {
  const r2 = radius * radius;
  let hit = 0;
  for (const p of polys) {
    let near = false;
    for (let s = 2; s < p.length && !near; s += 2) {
      if (segPointDist2(x, z, p[s - 2], p[s - 1], p[s], p[s + 1]) <= r2) near = true;
    }
    if (near) hit++;
  }
  return { hit, total: polys.length, fraction: polys.length ? hit / polys.length : 0 };
}

/** Squared distance from a point to a segment. Flat, XZ. */
export function segPointDist2(px, pz, ax, az, bx, bz) {
  const dx = bx - ax; const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px;
  const qz = az + dz * t - pz;
  return qx * qx + qz * qz;
}

/* ================================================================== */
/* The encounter metric, MOVING: a train against a journey             */
/* ================================================================== */

/**
 * Resample a polyline to fixed arc-length steps, so a position along it is a
 * simple index rather than a search.
 *
 * @returns {{x:Float64Array, z:Float64Array, step:number, length:number}}
 */
export function arcSample(poly, step) {
  const xs = []; const zs = [];
  let carry = 0;
  xs.push(poly[0]); zs.push(poly[1]);
  for (let s = 2; s < poly.length; s += 2) {
    const ax = poly[s - 2]; const az = poly[s - 1];
    const bx = poly[s]; const bz = poly[s + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-9) continue;
    let d = step - carry;
    while (d <= len) {
      const t = d / len;
      xs.push(ax + (bx - ax) * t); zs.push(az + (bz - az) * t);
      d += step;
    }
    carry = (carry + len) % step;
  }
  return { x: Float64Array.from(xs), z: Float64Array.from(zs), step, length: (xs.length - 1) * step };
}

/**
 * A there-and-back patrol as a closed loop: out along the route, back along it.
 *
 * A caravan that walks A to B and vanishes is not content; one that walks
 * A to B to A forever is. Doubling the polyline makes the cycle closed, which
 * is what {@link CaravanRoute} assumes, and it doubles the cycle length - which
 * is the honest cost of a long patrol and the single biggest lever in this
 * whole measurement: a train is 32 m of animals on a cycle that may be 1,400 m
 * round, so it is somewhere else 97.7% of the time.
 */
export function loopRoute(poly) {
  const out = new Float64Array(poly.length * 2 - 2);
  out.set(poly, 0);
  let w = poly.length;
  for (let s = poly.length - 4; s >= 0; s -= 2) { out[w++] = poly[s]; out[w++] = poly[s + 1]; }
  return out;
}

/**
 * A caravan route, and the exact question "does a player walking THIS journey
 * meet a train walking THIS route".
 *
 * -- Why this is not a distance -------------------------------------------
 *
 * A static distance to a moving thing answers the wrong question in both
 * directions. For a route the player crosses, "could they ever be close" is
 * always yes; for a route the player never crosses it is always no; and in
 * between it says nothing about whether the timing works out. The medieval
 * build's whole failure was a distance metric standing in for an encounter one,
 * and the brief for this task names the replacement explicitly: measure the
 * closest approach over the CARAVAN'S OWN CYCLE against the player's journey.
 *
 * -- How it is computed, and why it is exact rather than sampled ----------
 *
 * The only unknown is the caravan's PHASE - where along its cycle it happens to
 * be when the player sets off - and the honest answer is therefore a fraction
 * over that unknown. Sweeping sixteen phases and simulating each was the first
 * cut; it cost 3.5 seconds per route and was wrong at the edges. The closed
 * form is both exact and forty times faster:
 *
 *   The player is at journey arc `p_i` at time `t_i = i * step / playerSpeed`.
 *   A train's head is at route arc `s(t) = (phase + v t) mod L`, and the train
 *   occupies `[s - trainLen, s]`.
 *   So a CONTACT - journey sample `i` within `radius` of route arc `a` - is an
 *   encounter exactly when
 *
 *       (a - v t_i - phase) mod L  in  [0, trainLen]
 *
 *   which is one interval of phase, of width `trainLen`, per contact. The set
 *   of phases that produce an encounter is the UNION of those intervals on the
 *   circle, and its measure divided by `L` is the answer.
 *
 * Two things fall out of that form and both matter to the placement.
 *
 *   Every contact contributes AT MOST `trainLen / L` of phase, so a long route
 *   is self-defeating: the 686 m Undercliff-aqueduct line loops in 1,372 m and
 *   a single 32 m train can be met at no more than 2.3% of phases per contact.
 *   Coverage comes from the UNION over many contacts - a journey that runs
 *   ALONGSIDE a route for 200 m has fifty contacts at fifty different phases -
 *   which is why routes that share a corridor with the traffic beat routes that
 *   merely cross it.
 *
 *   `trains` replicates the interval set at `L / trains` spacing, so `n` trains
 *   is at most `n` times one train and exactly `n` times when the intervals do
 *   not overlap. That is the cheapest lever the placement has and the
 *   measurement prices it directly.
 *
 * The only discretisation left is the phase bin (`bins`, default 1024, so
 * 1.3 m of arc on the longest route here) and the journey sample interval
 * (2 m, 0.43 s at walking pace). Both are quoted with every number.
 */
export class CaravanRoute {
  /**
   * @param {Float64Array} poly XZ polyline of the route as WALKED (one way).
   * @param {object} [opts] `radius`, `arcStep`, `cell`, `loop`.
   */
  constructor(poly, opts = {}) {
    this.radius = opts.radius ?? RECOGNITION;
    this.arcStep = opts.arcStep ?? 4;
    this.oneWay = opts.loop === false;
    this.poly = this.oneWay ? poly : loopRoute(poly);
    const s = arcSample(this.poly, this.arcStep);
    this.x = s.x; this.z = s.z;
    this.n = s.x.length;
    this.L = this.n * this.arcStep;
    this.walkLength = polyLength(poly);

    /* An arc index lookup by cell, so a contact test is O(arcs near here)
     * rather than O(the whole route), and a REJECT MASK in front of it so the
     * common case - a journey sample nowhere near this route - costs one array
     * index and nothing else.
     *
     * The mask is not an optimisation bolted on afterwards; it is what makes
     * the measurement affordable at all. 74 candidate routes against 8,384
     * journeys sampled every 2 m is 3.1 billion sample-cell tests, and the
     * first cut spent them all building `${i},${j}` strings for a Map: it ran
     * for ten minutes and did not finish. Flat integer-keyed grids and a
     * dilated occupancy mask bring the same, identical answer back in twelve
     * seconds. Nothing about the metric changed - the suite pins that by
     * re-measuring two routes against `closestApproach`, which uses no grid at
     * all.
     */
    this.cell = opts.cell ?? 8;
    this.span = Math.ceil((this.radius + this.arcStep) / this.cell);
    this.gn = Math.ceil((HALF * 2 + 120) / this.cell);
    this.g0 = -(HALF + 60);
    this.buckets = new Array(this.gn * this.gn);
    this.mask = new Uint8Array(this.gn * this.gn);
    for (let a = 0; a < this.n; a++) {
      const ci = this._ci(this.x[a]);
      const cj = this._ci(this.z[a]);
      if (ci < 0 || ci >= this.gn || cj < 0 || cj >= this.gn) continue;
      const k = ci * this.gn + cj;
      let l = this.buckets[k];
      if (!l) this.buckets[k] = (l = []);
      l.push(a);
    }
    for (let i = 0; i < this.gn; i++) {
      for (let j = 0; j < this.gn; j++) {
        if (!this.buckets[i * this.gn + j]) continue;
        for (let di = -this.span; di <= this.span; di++) {
          for (let dj = -this.span; dj <= this.span; dj++) {
            const ii = i + di; const jj = j + dj;
            if (ii < 0 || ii >= this.gn || jj < 0 || jj >= this.gn) continue;
            this.mask[ii * this.gn + jj] = 1;
          }
        }
      }
    }
  }

  _ci(v) { return Math.floor((v - this.g0) / this.cell); }

  /** Route arc indices within `radius` of a point, written into `out`. */
  nearArcs(x, z, out) {
    out.length = 0;
    const ci = this._ci(x); const cj = this._ci(z);
    if (ci < 0 || ci >= this.gn || cj < 0 || cj >= this.gn) return out;
    if (this.mask[ci * this.gn + cj] === 0) return out;
    const r2 = this.radius * this.radius;
    const i0 = Math.max(0, ci - this.span); const i1 = Math.min(this.gn - 1, ci + this.span);
    const j0 = Math.max(0, cj - this.span); const j1 = Math.min(this.gn - 1, cj + this.span);
    for (let i = i0; i <= i1; i++) {
      const base = i * this.gn;
      for (let j = j0; j <= j1; j++) {
        const l = this.buckets[base + j];
        if (!l) continue;
        for (let q = 0; q < l.length; q++) {
          const a = l[q];
          const dx = this.x[a] - x; const dz = this.z[a] - z;
          if (dx * dx + dz * dz <= r2) out.push(a);
        }
      }
    }
    return out;
  }

  /** Closest the journey ever comes to the LINE, ignoring time. Diagnostic. */
  closestApproach(js) {
    let best = Infinity;
    for (let i = 0; i < js.x.length; i++) {
      const px = js.x[i]; const pz = js.z[i];
      for (let a = 0; a < this.n; a++) {
        const dx = this.x[a] - px; const dz = this.z[a] - pz;
        const d2 = dx * dx + dz * dz;
        if (d2 < best) best = d2;
      }
    }
    return Math.sqrt(best);
  }

  /**
   * The share of caravan phases at which a player walking `js` meets a train.
   *
   * @param {{x:Float64Array,z:Float64Array,step:number,length:number}} js the
   *   journey, arc-sampled - 2 m is the interval every number here is quoted at.
   * @param {object} [opts] `speed`, `trainLen`, `trains`, `playerSpeed`, `bins`.
   */
  encounter(js, opts = {}) {
    const speed = opts.speed ?? CARAVAN_SPEED;
    const trainLen = opts.trainLen ?? TRAIN_LEN;
    const trains = opts.trains ?? 1;
    const playerSpeed = opts.playerSpeed ?? WALK;
    const bins = opts.bins ?? 1024;
    const perBin = this.L / bins;
    const arcs = _arcScratch;
    const width = Math.max(1, Math.ceil(trainLen / perBin));
    const shift = bins / trains;

    /* THE CHEAP PASS FIRST. Roughly half of all journeys never come within
     * `radius` of this route at all, and for those the answer is zero without
     * touching a phase bin. Skipping the mask work for them is not a micro-
     * optimisation: the first cut cleared a 1,024-bin mask per journey per
     * route, 1.3 billion writes over the catalogue, and that alone was
     * two thirds of the run. */
    let contacts = 0;
    for (let i = 0; i < js.x.length; i++) {
      if (this.nearArcs(js.x[i], js.z[i], arcs).length) { contacts = 1; break; }
    }
    if (!contacts) return { fraction: 0, contacts: 0, eligible: false, bins };

    /* And the mask is GENERATION-STAMPED rather than cleared: a bin belongs to
     * this journey when it holds this journey's stamp. Same answer, no fill. */
    const mask = _phaseMask(bins);
    const gen = ++_gen;
    contacts = 0;
    for (let i = 0; i < js.x.length; i++) {
      const t = (i * js.step) / playerSpeed;
      const vt = speed * t;
      this.nearArcs(js.x[i], js.z[i], arcs);
      for (let q = 0; q < arcs.length; q++) {
        contacts++;
        const base = (arcs[q] * this.arcStep - vt) / perBin;
        for (let c = 0; c < trains; c++) {
          let b0 = Math.floor(base - c * shift) % bins;
          if (b0 < 0) b0 += bins;
          for (let k = 0; k <= width; k++) {
            let b = b0 - k;
            if (b < 0) b += bins;
            mask[b] = gen;
          }
        }
      }
    }
    let met = 0;
    for (let b = 0; b < bins; b++) if (mask[b] === gen) met++;
    return { fraction: met / bins, contacts, eligible: contacts > 0, bins };
  }
}

/** Phase-mask scratch. Module level, per the house rule; never grown in a loop. */
let _mask = new Int32Array(1024);
let _gen = 0;
function _phaseMask(bins) {
  if (_mask.length < bins) { _mask = new Int32Array(bins); _gen = 0; }
  return _mask;
}
const _arcScratch = [];

/**
 * A whole route scored against a whole journey set.
 *
 * `eligibleShare` is the share of journeys that pass within `radius` of the
 * line - the CEILING for that route, reached only by a train long enough to
 * fill it. `expected` is the share of (journey, phase) pairs that meet, which
 * is what a player actually experiences over many crossings, and it is the
 * number the floors are written against.
 */
export function routeStats(route, journeys, opts = {}) {
  let eligible = 0;
  let sum = 0;
  let best = 0;
  const per = new Float64Array(journeys.length);
  for (let i = 0; i < journeys.length; i++) {
    const e = route.encounter(journeys[i].samp, opts);
    if (e.eligible) eligible++;
    sum += e.fraction;
    if (e.fraction > best) best = e.fraction;
    per[i] = e.fraction;
  }
  return {
    n: journeys.length,
    eligible, eligibleShare: eligible / journeys.length,
    expected: sum / journeys.length,
    best, per,
  };
}

/**
 * Several routes at once: the chance a journey meets AT LEAST ONE caravan.
 *
 * Not a sum. Two routes that share a corridor meet the same journeys, and the
 * union is what the player experiences. Phases are independent per route, so
 * the probability a journey meets nothing is the product of the per-route
 * misses - which is the only place in this file where a probability is
 * multiplied, and it is sound because each route's phase is its own free
 * variable at world load.
 */
export function unionExpected(perRouteFractions) {
  const n = perRouteFractions[0].length;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    let miss = 1;
    for (const per of perRouteFractions) miss *= 1 - per[i];
    sum += 1 - miss;
  }
  return sum / n;
}


/**
 * The candidate caravan routes: every walkable line between two hubs.
 *
 * A caravan route is not an arbitrary curve. It is a road between two places
 * somebody would trade between, and it has to be a line a body could walk —
 * laid as a straight chord, a Caravanserai-to-Ashfall route crosses the quarry
 * pit and the massif. So each candidate is the shortest walkable path between
 * two HUBS over the same reach graph the journeys are routed on, which is what
 * makes "the caravan goes round the pit the way a drover would" true by
 * construction rather than by inspection.
 *
 * Hubs are the spawn, the six region centres and the seven published region
 * anchors, deduplicated at 50 m — two names for one place is one hub. Pairs
 * shorter than `minLength` are dropped: a 60 m route is a roundabout, not a
 * caravan road.
 */
export function routeCatalogue(graph, adj, pois, opts = {}) {
  const minLength = opts.minLength ?? 120;
  const dedupe = opts.dedupe ?? 50;
  const wanted = opts.kinds ?? ['spawn', 'region', 'anchor'];
  const hubs = [];
  for (const p of pois) {
    if (!wanted.includes(p.kind)) continue;
    let dup = false;
    for (const h of hubs) if (Math.hypot(h.x - p.x, h.z - p.z) < dedupe) { dup = true; break; }
    if (!dup) hubs.push(p);
  }
  const scratch = scratchFor(graph, adj);
  const out = [];
  for (let i = 0; i < hubs.length; i++) {
    for (let j = i + 1; j < hubs.length; j++) {
      const poly = pathBetween(graph, adj, hubs[i], hubs[j], scratch);
      if (!poly) continue;
      const len = polyLength(poly);
      if (len < minLength) continue;
      out.push({ id: `${hubs[i].label} <-> ${hubs[j].label}`, a: hubs[i], b: hubs[j], poly, walk: len });
    }
  }
  return { hubs, routes: out };
}

/* ================================================================== */
/* Counting ANIMALS, not routes                                        */
/* ================================================================== */

/**
 * A herd standing at an oasis, as positions rather than as a number.
 *
 * A count is not a placement. Eight camels "at" an oasis are eight bodies
 * spread over a watering ground, and whether the player passes within
 * recognition of one of them depends on where they stand — so they are laid on
 * a golden-angle spiral inside `r`, which is the cheapest arrangement that is
 * neither a ring (every animal at the same distance from the path) nor a heap
 * (every animal at the same point). Deterministic: the same oasis always
 * produces the same herd, so a floor cannot be met by a lucky seed.
 */
export function herdPositions(x, z, r, n) {
  const out = [];
  const GA = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : Math.sqrt((i + 0.5) / n);
    const a = i * GA;
    out.push({ x: x + Math.cos(a) * t * r, z: z + Math.sin(a) * t * r });
  }
  return out;
}

/**
 * How many DISTINCT animals of a caravan the player passes within recognition
 * of, averaged over the caravan's phase.
 *
 * The train interval in {@link CaravanRoute#encounter} treats the caravan as a
 * continuum, which is right for "did I meet the caravan" and wrong for "how
 * many camels did I see". So each animal gets its own slot of the train —
 * `gap` metres of it — and its own phase interval, and the answer is the mean
 * over phase bins of the number of slots that were hit. The union of the
 * per-animal intervals is exactly the train interval, so the two metrics cannot
 * disagree about whether an encounter happened; they only disagree about how
 * much of one it was.
 */
export function encounterAnimals(route, js, opts = {}) {
  const speed = opts.speed ?? CARAVAN_SPEED;
  const trains = opts.trains ?? 1;
  const animals = opts.animals ?? 8;
  const gap = opts.gap ?? 4;
  const playerSpeed = opts.playerSpeed ?? WALK;
  const bins = opts.bins ?? 512;
  const perBin = route.L / bins;
  const slots = trains * animals;
  const masks = _slotMasks(slots, bins);
  const gen = ++_slotGen;
  const arcs = _arcScratch;
  const width = Math.max(1, Math.ceil(gap / perBin));
  const shift = bins / trains;
  const slotBins = gap / perBin;
  for (let i = 0; i < js.x.length; i++) {
    const t = (i * js.step) / playerSpeed;
    const base = -(speed * t) / perBin;
    route.nearArcs(js.x[i], js.z[i], arcs);
    for (let q = 0; q < arcs.length; q++) {
      const b = base + (arcs[q] * route.arcStep) / perBin;
      for (let c = 0; c < trains; c++) {
        for (let k = 0; k < animals; k++) {
          let b0 = Math.floor(b - c * shift - k * slotBins) % bins;
          if (b0 < 0) b0 += bins;
          const m = masks[c * animals + k];
          for (let w = 0; w <= width; w++) {
            let bb = b0 - w;
            if (bb < 0) bb += bins;
            m[bb] = gen;
          }
        }
      }
    }
  }
  /* `mean` is the expected count over an unknown phase, which is what a player
   * gets. `best` is the count at the single luckiest phase, which is the same
   * measurement with the TIMING CONSTRAINT ABLATED - it is the most animals
   * this route could ever show this journey, and it is therefore the honest
   * ceiling for the `mean`. Computing both from one mask set costs one extra
   * pass and removes the need to invent a ceiling by argument. */
  let sum = 0;
  let best = 0;
  for (let b = 0; b < bins; b++) {
    let here = 0;
    for (let sI = 0; sI < slots; sI++) if (masks[sI][b] === gen) here++;
    sum += here;
    if (here > best) best = here;
  }
  return { mean: sum / bins, best, slots, bins };
}

let _slots = [];
let _slotGen = 0;
function _slotMasks(n, bins) {
  while (_slots.length < n) _slots.push(new Int32Array(bins));
  for (let i = 0; i < n; i++) if (_slots[i].length < bins) { _slots[i] = new Int32Array(bins); _slotGen = 0; }
  return _slots;
}

/* ================================================================== */
/* Scoring a whole placement                                           */
/* ================================================================== */

/**
 * Everything the floors need, measured over one journey set in one pass.
 *
 * A placement is `{ routes: [{poly, trains, animals}], oases: [{x, z, r,
 * herd}] }` — the same shape {@link caravanContent} reads off the world, so the
 * synthetic placement this file proves the metric with and the real placement
 * the game ships go through identical arithmetic. That is deliberate: a proof
 * that the apparatus CAN see content is worth nothing if it sees it by a
 * different route than the gate does.
 *
 * Reported:
 *   `caravanShare`  P(a journey meets at least one caravan), over phase.
 *   `oasisShare`    share of journeys passing within `RECOGNITION` of any herd
 *                   animal. Static, so no phase and no probability.
 *   `anyShare`      P(meets at least one camel of any kind). The routes' phases
 *                   are independent free variables at world load, so a miss is
 *                   the product of misses; the oasis term is 0 or 1 and simply
 *                   multiplies in.
 *   `camelsMet`     expected number of DISTINCT animals met per journey.
 *   `reliable`      share of journeys that meet a camel at 50% of phases or
 *                   more — the ones where the encounter is not a coin flip.
 */
export function scorePlacement(placement, journeys, opts = {}) {
  const radius = opts.radius ?? RECOGNITION;
  const routes = (placement.routes ?? []).map((r) => ({
    ...r,
    cr: r.cr ?? new CaravanRoute(r.poly, { radius }),
  }));
  const herds = [];
  for (const o of placement.oases ?? []) {
    for (const p of herdPositions(o.x, o.z, o.r ?? 18, o.herd ?? 8)) herds.push(p);
  }
  const r2 = radius * radius;
  const n = journeys.length;
  let caravanSum = 0; let oasisHits = 0; let anySum = 0; let camels = 0; let camelsBest = 0; let reliable = 0;
  const perJourney = new Float64Array(n);
  const oasisJourney = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const j = journeys[i];
    let miss = 1;
    let count = 0;
    let countBest = 0;
    for (const r of routes) {
      const e = r.cr.encounter(j.samp, { trains: r.trains ?? 1, ...opts });
      miss *= 1 - e.fraction;
      if (e.eligible) {
        const a = encounterAnimals(r.cr, j.samp, { trains: r.trains ?? 1, animals: r.animals ?? 8, ...opts });
        count += a.mean;
        countBest += a.best;
      }
    }
    const caravan = 1 - miss;
    caravanSum += caravan;
    let herdMet = 0;
    for (const h of herds) {
      let near = false;
      for (let k = 2; k < j.poly.length && !near; k += 2) {
        if (segPointDist2(h.x, h.z, j.poly[k - 2], j.poly[k - 1], j.poly[k], j.poly[k + 1]) <= r2) near = true;
      }
      if (near) herdMet++;
    }
    if (herdMet) { oasisHits++; oasisJourney[i] = 1; }
    count += herdMet;
    countBest += herdMet;
    camels += count;
    camelsBest += countBest;
    const any = herdMet ? 1 : caravan;
    anySum += any;
    if (any >= 0.5) reliable++;
    perJourney[i] = any;
  }
  return {
    n,
    caravanShare: caravanSum / n,
    oasisShare: oasisHits / n,
    anyShare: anySum / n,
    camelsMet: camels / n,
    camelsMetBest: camelsBest / n,
    reliable: reliable / n,
    perJourney, oasisJourney,
    herds: herds.length,
    routes: routes.length,
  };
}

/* ================================================================== */
/* The flats — how much of this world is nothing                       */
/* ================================================================== */

/**
 * Distance from every cell of the map to the nearest BUILT thing.
 *
 * "Built" means a world-layer box collider — the heightfield is excluded, since
 * the ground is not content. A cell is seeded if any box's rotated footprint
 * comes within half a cell diagonal of its centre, which over-seeds slightly
 * and therefore makes the world look LESS empty than it is: the error runs
 * against the claim this file is making, which is the only direction it is safe
 * to run in.
 *
 * The transform is the exact separable squared-distance one (Felzenszwalb &
 * Huttenlocher), so the answer is the true distance to the nearest seeded cell
 * CENTRE, and the only error left is the ±2.83 m of the seeding itself. Every
 * number this produces is quoted at 4 m resolution for that reason.
 */
export function featureField(idx, cell = FEATURE_CELL) {
  const n = Math.ceil((HALF * 2) / cell) + 1;
  const INF = 1e12;
  const g = new Float64Array(n * n).fill(INF);
  const half = Math.SQRT2 * cell * 0.5;
  for (const b of idx.boxes) {
    const i0 = Math.max(0, Math.floor((b.x - b.ax - half + HALF) / cell));
    const i1 = Math.min(n - 1, Math.ceil((b.x + b.ax + half + HALF) / cell));
    const j0 = Math.max(0, Math.floor((b.z - b.az - half + HALF) / cell));
    const j1 = Math.min(n - 1, Math.ceil((b.z + b.az + half + HALF) / cell));
    for (let i = i0; i <= i1; i++) {
      const x = i * cell - HALF;
      for (let j = j0; j <= j1; j++) {
        const z = j * cell - HALF;
        if (g[i * n + j] === 0) continue;
        if (footprintPointDist(b, x, z) <= half) g[i * n + j] = 0;
      }
    }
  }
  edt2d(g, n, cell);
  for (let i = 0; i < g.length; i++) g[i] = Math.sqrt(g[i]);
  return {
    n, cell, d: g,
    ix: (x) => Math.min(n - 1, Math.max(0, Math.round((x + HALF) / cell))),
    at(x, z) { return this.d[this.ix(x) * n + this.ix(z)]; },
  };
}

/** Exact separable squared Euclidean distance transform over a square grid. */
function edt2d(g, n, cell) {
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const zz = new Float64Array(n + 1);
  const pass = (get, set) => {
    for (let q = 0; q < n; q++) f[q] = get(q);
    let k = 0; v[0] = 0; zz[0] = -1e20; zz[1] = 1e20;
    for (let q = 1; q < n; q++) {
      let s;
      for (;;) {
        s = ((f[q] + q * q * cell * cell) - (f[v[k]] + v[k] * v[k] * cell * cell)) / (2 * cell * cell * (q - v[k]));
        if (s > zz[k]) break;
        k--;
      }
      k++; v[k] = q; zz[k] = s; zz[k + 1] = 1e20;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (zz[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) * cell * cell + f[v[k]];
    }
    for (let q = 0; q < n; q++) set(q, d[q]);
  };
  for (let i = 0; i < n; i++) pass((j) => g[i * n + j], (j, val) => { g[i * n + j] = val; });
  for (let j = 0; j < n; j++) pass((i) => g[i * n + j], (i, val) => { g[i * n + j] = val; });
}

/** Terrain slope, sampled from the world's own height function. */
export function slopeAt(x, z, h = 2) {
  const dx = (citadelHeight(x + h, z) - citadelHeight(x - h, z)) / (2 * h);
  const dz = (citadelHeight(x, z + h) - citadelHeight(x, z - h)) / (2 * h);
  return Math.hypot(dx, dz);
}

/**
 * How much of the 810,000 m² is open flat with nothing in it, and how long a
 * player walks between features on every inter-region journey.
 *
 * The two halves answer two different complaints and both were in the player's
 * sentence. The AREA half answers "the large open areas"; the JOURNEY half
 * answers what he was doing when he noticed — walking between the places the
 * world gave him a reason to walk to, for minutes at a time, past nothing.
 *
 * `bands` are distance-to-nearest-built-thing thresholds in metres.
 */
export function emptiness(field, opts = {}) {
  const bands = opts.bands ?? [15, 30, 50, 80, 120, 200];
  const maxSlope = opts.maxSlope ?? 0.5;
  const { n, cell, d } = field;
  const cellArea = cell * cell;
  let inPlay = 0; let flat = 0;
  const band = new Array(bands.length).fill(0);
  const flatBand = new Array(bands.length).fill(0);
  let worst = { d: -1, x: 0, z: 0 };
  for (let i = 0; i < n; i++) {
    const x = i * cell - HALF;
    if (Math.abs(x) > HALF) continue;
    for (let j = 0; j < n; j++) {
      const z = j * cell - HALF;
      if (Math.abs(z) > HALF) continue;
      inPlay++;
      const dist = d[i * n + j];
      const isFlat = slopeAt(x, z) <= maxSlope;
      if (isFlat) flat++;
      for (let k = 0; k < bands.length; k++) {
        if (dist >= bands[k]) { band[k]++; if (isFlat) flatBand[k]++; }
      }
      if (isFlat && dist > worst.d) worst = { d: dist, x, z };
    }
  }
  return {
    bands,
    cells: inPlay,
    area: inPlay * cellArea,
    flatCells: flat,
    flatArea: flat * cellArea,
    band: band.map((c, k) => ({ m: bands[k], cells: c, area: c * cellArea, share: c / inPlay })),
    flatBandArea: flatBand.map((c, k) => ({ m: bands[k], area: c * cellArea, share: c / inPlay })),
    worst,
  };
}

/**
 * The longest stretch of nothing on one journey, and the mean gap between
 * features along it.
 *
 * Sampled every 2 m. A sample "meets something" if the nearest built thing is
 * within `radius`; a stretch of nothing is a maximal run of samples that do
 * not. This is the number the player actually experiences: not how empty the
 * map is on average, but how long the walk is before anything happens.
 *
 * `extra` adds STATIC content the collider field does not know about - an oasis
 * is a place, not a box, and a watering ground with eight camels standing in it
 * breaks up a walk exactly the way a building does. Caravans are deliberately
 * NOT admitted here: a thing that is only sometimes there cannot be relied on
 * to fill a stretch, and the whole point of this measurement is what the walk
 * is like at its worst.
 */
export function journeyEmptiness(field, poly, radius = RECOGNITION, step = 2, extra = null) {
  const s = arcSample(poly, step);
  let run = 0; let longest = 0; let met = 0;
  const gaps = [];
  for (let i = 0; i < s.x.length; i++) {
    let near = field.at(s.x[i], s.z[i]) <= radius;
    if (!near && extra) {
      for (let k = 0; k < extra.length; k++) {
        const e = extra[k];
        const rr = radius + (e.r ?? 0);
        const dx = e.x - s.x[i]; const dz = e.z - s.z[i];
        if (dx * dx + dz * dz <= rr * rr) { near = true; break; }
      }
    }
    if (near) {
      if (run > 0) gaps.push(run * step);
      if (run > longest) longest = run;
      run = 0; met++;
    } else run++;
  }
  if (run > 0) gaps.push(run * step);
  if (run > longest) longest = run;
  return {
    length: s.length,
    longest: longest * step,
    metShare: s.x.length ? met / s.x.length : 0,
    gaps,
    meanGap: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : s.length,
  };
}

/* ================================================================== */
/* Candidates — the placement agent's brief                            */
/* ================================================================== */

/**
 * Every position in the world where a static thing would be met, ranked.
 *
 * The filter is deliberately weak — flat enough to stand a tent on, clear
 * enough of colliders to put one there, and on ground the reach graph agrees a
 * body can walk. Everything else is decided by the encounter fraction, because
 * the whole lesson of the medieval build is that placement rules dressed up as
 * quality criteria are how content ends up where nobody goes.
 *
 * `minSep` spreads the returned list: two oases 20 m apart are one oasis.
 */
export function rankCandidates(exposure, field, opts = {}) {
  const step = opts.step ?? 10;
  const clear = opts.clear ?? 12;
  const maxSlope = opts.maxSlope ?? 0.28;
  const minSep = opts.minSep ?? 70;
  const limit = opts.limit ?? 24;
  const minDistToBuilt = opts.minDistToBuilt ?? clear;
  const keep = opts.keep ?? (() => true);
  const rows = [];
  for (let x = -HALF + step; x < HALF; x += step) {
    for (let z = -HALF + step; z < HALF; z += step) {
      const dist = field.at(x, z);
      if (dist < minDistToBuilt) continue;
      if (slopeAt(x, z) > maxSlope) continue;
      if (!keep(x, z)) continue;
      const hit = exposure.at(x, z);
      if (hit <= 0) continue;
      rows.push({ x, z, hit, fraction: hit / exposure.total, clearance: dist });
    }
  }
  rows.sort((a, b) => b.hit - a.hit);
  const picked = [];
  for (const r of rows) {
    let ok = true;
    for (const p of picked) if (Math.hypot(p.x - r.x, p.z - r.z) < minSep) { ok = false; break; }
    if (!ok) continue;
    picked.push(r);
    if (picked.length >= limit) break;
  }
  return { all: rows, ranked: picked };
}

/**
 * Read whatever caravan and oasis content the world publishes.
 *
 * **This is the contract between this measurement and the placement work.** The
 * floors do not care how caravans are built; they care that the world SAYS
 * where they are, because a floor that has to reverse-engineer placement out of
 * collider soup is a floor that breaks the first time somebody moves a mesh.
 * Three shapes are accepted, in order:
 *
 *   `world.caravanRoutes`  `[{ id, points: [{x,y,z}, …], trains?, animals? }]`
 *   `world.oases`          `[{ id, x, y, z, r }]`
 *   `world.npcSpawns`      any entry whose `role` or `type` names a caravan or
 *                          a camel, read as a single static position — the
 *                          degenerate case, so that a placement built entirely
 *                          out of spawn descriptors still measures.
 *
 * Absent everything, it returns empty lists and the floors go red, which is the
 * state this file was written in and the state it is supposed to be in until
 * the placement lands.
 */
export function caravanContent(world) {
  const routes = [];
  const oases = [];
  const statics = [];
  for (const r of world.caravanRoutes ?? []) {
    const pts = r.points ?? r.route ?? r.waypoints ?? [];
    if (pts.length < 2) continue;
    const poly = new Float64Array(pts.length * 2);
    for (let i = 0; i < pts.length; i++) { poly[i * 2] = pts[i].x; poly[i * 2 + 1] = pts[i].z; }
    routes.push({
      id: r.id ?? `route-${routes.length}`,
      poly,
      trains: r.trains ?? r.caravans ?? 1,
      animals: r.animals ?? r.camels ?? r.herd ?? 8,
      spec: r,
    });
  }
  for (const o of world.oases ?? []) {
    oases.push({
      id: o.id ?? `oasis-${oases.length}`,
      x: o.x ?? o.position?.x, z: o.z ?? o.position?.z,
      r: o.r ?? o.radius ?? OASIS_R,
      herd: o.herd ?? o.camels ?? o.animals ?? 8,
      spec: o,
    });
  }
  for (const s of world.npcSpawns ?? []) {
    const tag = `${s.role ?? ''} ${s.type ?? ''} ${s.species ?? ''} ${s.name ?? ''}`.toLowerCase();
    if (!/caravan|camel|drover|herd/.test(tag)) continue;
    const x = s.position?.x ?? s.x; const z = s.position?.z ?? s.z;
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    statics.push({ id: `spawn-${statics.length}`, x, z, r: 2, herd: 1, tag });
  }
  /* A single tagged spawn descriptor is a herd of one standing in one place,
   * which is the degenerate oasis. Folding it in here rather than giving it a
   * third code path is what lets a placement built entirely out of spawn
   * descriptors be measured by the same gate as one built out of routes. */
  return { routes, oases: [...oases, ...statics], statics, declaredOases: oases };
}

/* ================================================================== */
/* The floors                                                          */
/* ================================================================== */

/**
 * What the placement has to achieve, and why each number is where it is.
 *
 * Every one of these was set by MEASURING a reference placement rather than by
 * choosing a round number, and the reference is published alongside the gate:
 * two caravan routes carrying three eight-animal trains each, plus two oases of
 * eight camels, at the top of the ranked candidate list this file produces.
 * That placement is 64 animals in a 900 m world and it scores 53.1% / 5.74 /
 * 26.1% / 87.8% / 74.7% against these five floors. **The floors sit below it
 * with room, and above what any lesser placement can reach**, which is the only
 * way a floor is worth having:
 *
 *   `caravanShare` 40%   One route with three trains reaches 32.9%. Two reach
 *                        53.1%. The floor is deliberately between them, so a
 *                        single caravan cannot satisfy the brief and two
 *                        thoughtfully-placed ones can.
 *   `camelsMet` 3.0      The player asked for HERDS. One animal met is not a
 *                        herd; the reference meets 5.74 and its best phase
 *                        meets 13.06.
 *   `oasisShare` 20%     The best single oasis position in the open flats
 *                        reaches 15.8%; the best pair reaches 28.4%. Again the
 *                        floor is between them: the player asked for "1 or 2",
 *                        and this says two, sited by measurement.
 *   `spawnAnyShare` 60%  The medieval defect in one number. Its nearest pack
 *                        stood 317 m from the player spawn and no gate noticed.
 *                        This one is about the journeys that begin or end where
 *                        every session begins.
 *   `shortWalkShare` 72% The player's actual complaint, quantified. Today 63.3%
 *                        of inter-region journeys have their longest featureless
 *                        stretch under 150 m; the reference oases lift it to
 *                        74.7%. This is the only floor that is not zero today,
 *                        because emptiness is a matter of degree where encounter
 *                        is a matter of absence.
 */
export const FLOORS = Object.freeze({
  caravanShare: 0.40,
  camelsMet: 3.0,
  oasisShare: 0.20,
  spawnAnyShare: 0.60,
  shortWalkShare: 0.72,
});

/** A featureless stretch longer than this is what the player was complaining about. */
export const LONG_WALK_M = 150;

/**
 * What share of journeys could be reached AT ALL by static content on this set
 * of cells — the ablation ceiling for an oasis floor.
 *
 * Every legal cell holding an oasis at once is not a placement anybody would
 * ship; it is the answer to "how well could this possibly go", which is what a
 * ceiling is for. Computed through a dilated mask rather than cell by cell,
 * because 1,417 candidates against 8,384 journeys is 12 million polyline
 * distance queries and this is two array lookups per journey sample.
 */
export function coverableShare(journeys, cells, radius, cell = 5) {
  const n = Math.ceil((HALF * 2 + 120) / cell);
  const g0 = -(HALF + 60);
  const mask = new Uint8Array(n * n);
  const span = Math.ceil(radius / cell);
  const r2 = radius * radius;
  for (const c of cells) {
    const ci = Math.floor((c.x - g0) / cell);
    const cj = Math.floor((c.z - g0) / cell);
    for (let di = -span; di <= span; di++) {
      for (let dj = -span; dj <= span; dj++) {
        const i = ci + di; const j = cj + dj;
        if (i < 0 || i >= n || j < 0 || j >= n) continue;
        const dx = (i * cell + g0) - c.x; const dz = (j * cell + g0) - c.z;
        if (dx * dx + dz * dz > r2) continue;
        mask[i * n + j] = 1;
      }
    }
  }
  let hit = 0;
  for (const j of journeys) {
    const s = j.samp ?? arcSample(j.poly, 3);
    let ok = false;
    for (let i = 0; i < s.x.length && !ok; i++) {
      const ci = Math.floor((s.x[i] - g0) / cell);
      const cj = Math.floor((s.z[i] - g0) / cell);
      if (ci >= 0 && ci < n && cj >= 0 && cj < n && mask[ci * n + cj]) ok = true;
    }
    if (ok) hit++;
  }
  return hit / journeys.length;
}

/** Share of journeys whose longest featureless stretch is under `limit` metres. */
export function shortWalkShare(field, journeys, extra, limit = LONG_WALK_M) {
  let ok = 0;
  for (const j of journeys) {
    if (journeyEmptiness(field, j.poly, RECOGNITION, 2, extra).longest < limit) ok++;
  }
  return ok / journeys.length;
}

/**
 * The five floors, computed over one placement, in one place.
 *
 * **Both the gate and the proof call this function.** `citadel-caravans.test.mjs`
 * feeds it whatever the world publishes; `citadel-traffic.test.mjs` feeds it the
 * synthetic reference placement and asserts the same five gates go green. A
 * proof that the apparatus can see content is worth nothing if it sees it by
 * different arithmetic than the gate does, and this is how the two are held to
 * the same arithmetic.
 *
 * @param {{routes:Array, oases:Array}} placement
 * @param {object} ctx `inter`, `spawnJourneys`, `field`, and the three ceilings
 *   that come from ablation rather than from the placement.
 * @returns {Array<{key:string,label:string,floor:number,achieved:number,ceiling:number,note:string}>}
 */
export function evaluateFloors(placement, ctx) {
  const inter = ctx.inter;
  const score = scorePlacement(placement, inter);
  const spawnScore = scorePlacement(placement, ctx.spawnJourneys);
  const extra = (placement.oases ?? []).map((o) => ({ x: o.x, z: o.z, r: o.r ?? 18 }));
  const short = shortWalkShare(ctx.field, inter, extra.length ? extra : null);
  const pct = (v) => Math.round(v * 1000) / 10;
  return [
    {
      key: 'caravanShare',
      label: 'inter-region journeys that meet a caravan (%)',
      floor: pct(FLOORS.caravanShare),
      achieved: pct(score.caravanShare),
      ceiling: pct(ctx.ceilings.caravanShare),
      note: `${placement.routes?.length ?? 0} routes, n=${inter.length}`,
      score,
    },
    {
      key: 'camelsMet',
      label: 'camels met at 15 m per inter-region journey',
      floor: FLOORS.camelsMet,
      achieved: Math.round(score.camelsMet * 100) / 100,
      ceiling: Math.round(score.camelsMetBest * 100) / 100,
      note: 'ceiling = the same placement at its luckiest phase',
      score,
    },
    {
      key: 'oasisShare',
      label: 'inter-region journeys that meet an oasis herd (%)',
      floor: pct(FLOORS.oasisShare),
      achieved: pct(score.oasisShare),
      ceiling: pct(ctx.ceilings.oasisShare),
      note: `${placement.oases?.length ?? 0} oases`,
      score,
    },
    {
      key: 'spawnAnyShare',
      label: 'journeys from the spawn that meet any camel (%)',
      floor: pct(FLOORS.spawnAnyShare),
      achieved: pct(spawnScore.anyShare),
      ceiling: pct(ctx.ceilings.spawnAnyShare),
      note: `n=${ctx.spawnJourneys.length}`,
      score: spawnScore,
    },
    {
      key: 'shortWalkShare',
      label: `inter-region walks with no ${LONG_WALK_M} m of nothing (%)`,
      floor: pct(FLOORS.shortWalkShare),
      achieved: pct(short),
      ceiling: pct(ctx.ceilings.shortWalkShare),
      note: 'static content only - a caravan cannot be relied on to fill a stretch',
      score: null,
    },
  ];
}

/* ================================================================== */
/* One pass, shared by every test in the traffic suite                 */
/* ================================================================== */

let _traffic = null;
/**
 * Build the world, index it, graph it, route it, field it. About 40 seconds,
 * once per process, memoised the way `citadel-reach-kit.measure` is.
 */
export function traffic() {
  if (_traffic) return _traffic;
  _traffic = (async () => {
    const t0 = Date.now();
    const { world, physics, scene } = await buildCitadel();
    const tBuild = Date.now();
    const idx = new ColumnIndex(physics);
    const graph = new ReachGraph(world, idx);
    const tGraph = Date.now();
    const { pois, place, sites } = await poiSet(world, physics, scene);
    const adj = weightedAdj(graph);
    const jr = buildJourneys(graph, pois, adj);
    const tJourney = Date.now();

    const polys = jr.journeys.map((j) => polyline(graph, j));
    for (let i = 0; i < jr.journeys.length; i++) jr.journeys[i].poly = polys[i];
    for (const j of jr.journeys) j.ground = polyLength(j.poly);

    const exposure = new ExposureField(RECOGNITION);
    for (const j of jr.journeys) exposure.stamp(j.id, j.poly);
    exposure.seal(jr.journeys.length);

    const inter = jr.journeys.filter((j) => j.inter);
    const exposureInter = new ExposureField(RECOGNITION);
    for (const j of inter) exposureInter.stamp(j.id, j.poly);
    exposureInter.seal(inter.length);
    const tField = Date.now();

    const field = featureField(idx);
    /**
     * The same distance field with THIS DROP'S OWN CONTENT SUBTRACTED.
     *
     * `field` is a distance-to-anything-built transform over the world as it
     * stands, and the world now stands with two oases and eight wayside wells
     * in the flats - which is what this measurement briefed. That is the right
     * field for "how empty is the world today" and the WRONG one for the two
     * questions that are about the placement rather than about the world:
     *
     *   the BEFORE column, without which "the drop broke up the long walks"
     *   has nothing to be a claim against; and
     *
     *   the negative control under the five floors, which asks whether an empty
     *   PLACEMENT fails every gate. `shortWalkShare` reads built geometry, so
     *   once the oases and wells exist it passes on masonry with not one camel
     *   in the world - and a control that passes for that reason is not a
     *   control.
     *
     * `world.traffic.colliders` is every collider `_buildTraffic` registered,
     * published by the world for exactly this. On a world that has not built
     * any, this is `field` and the two columns agree, which is itself the
     * assertion that the subtraction is doing something.
     */
    const own = new Set(world.traffic?.colliders ?? []);
    const fieldPre = own.size
      ? featureField(new ColumnIndex({ colliders: physics.colliders.filter((c) => !own.has(c)) }))
      : field;
    const tFeature = Date.now();

    return {
      world, physics, scene, idx, graph, pois, place, sites, adj,
      journeys: jr.journeys, inter, unreachable: jr.unreachable, unresolved: jr.unresolved,
      nodeOf: jr.nodeOf, exposure, exposureInter, field, fieldPre,
      ms: {
        build: tBuild - t0, graph: tGraph - tBuild, journeys: tJourney - tGraph,
        field: tField - tJourney, feature: tFeature - tField, total: tFeature - t0,
      },
    };
  })();
  return _traffic;
}

/**
 * The second pass: the route catalogue, the candidate pools, the three
 * ablation ceilings, and the reference placement they were all calibrated on.
 *
 * Split from {@link traffic} because it costs another twenty seconds and
 * because the split is the seam between MEASURING THE WORLD - which is true
 * whatever anybody builds next - and MEASURING A PLACEMENT, which is not.
 * Memoised per process, like everything else here.
 */
let _corridors = null;
export function corridors() {
  if (_corridors) return _corridors;
  _corridors = (async () => {
    const T = await traffic();
    const t0 = Date.now();
    /* Journeys are arc-sampled at 3 m - 0.65 s of walking - and every caravan
     * number in this file is quoted at that interval. It is not free to
     * tighten: the sample rate is the inner loop of every route score. */
    for (const j of T.journeys) j.samp = arcSample(j.poly, 3);

    const cat = routeCatalogue(T.graph, T.adj, T.pois);
    for (const r of cat.routes) {
      r.cr = new CaravanRoute(r.poly);
      r.stats = routeStats(r.cr, T.inter, { trains: REFERENCE_TRAINS });
    }
    cat.routes.sort((a, b) => b.stats.expected - a.stats.expected);
    const tRoutes = Date.now();

    /* THE GREEDY PICK, and why it is greedy rather than exhaustive. Two routes
     * out of fifty is 1,225 pairs and affordable; four out of fifty is 230,300
     * and is not. Greedy set-cover on a submodular objective is within
     * 1 - 1/e of optimal, and the objective here IS submodular - adding a route
     * can only ever cover journeys some other route did not - so the reference
     * placement is provably within 37% of the best pair, and measured, it beats
     * the best single route by 20 points. */
    const chosen = [];
    const pers = [];
    for (let k = 0; k < 4; k++) {
      let best = null; let bu = -1;
      for (const r of cat.routes) {
        if (chosen.includes(r)) continue;
        const u = unionExpected([...pers, r.stats.per]);
        if (u > bu) { bu = u; best = r; }
      }
      if (!best) break;
      chosen.push(best); pers.push(best.stats.per);
      best.unionAfter = bu;
    }

    /* The oasis pool: every flat, clear cell in the OPEN FLATS, scored by how
     * many inter-region journeys pass within recognition of a herd standing
     * there. Restricted to the flats on purpose - the unrestricted best sites
     * are 30 m outside a region wall, where the traffic funnels, and the player
     * asked for oases "in the large open areas between objects/villages/caves".
     * The unrestricted ranking is measured too and reported beside it, because
     * the gap between them is the price of honouring the brief: 16.2% against
     * 15.8% for the best site, which is to say the brief costs almost nothing.
     */
    const oasisField = new ExposureField(RECOGNITION + OASIS_R);
    for (const j of T.inter) oasisField.stamp(j.id, j.poly);
    oasisField.seal(T.inter.length);
    const flatsOnly = (x, z) => T.place.at(x, z) === 'flats';
    const oasisRank = rankCandidates(oasisField, T.field, {
      limit: 24, minSep: 90, clear: 24, keep: flatsOnly,
    });
    const oasisAnywhere = rankCandidates(oasisField, T.field, { limit: 8, minSep: 90, clear: 24 });
    /* A camel STANDING somewhere, rather than an oasis: the same question at
     * the bare recognition radius, which is what a single wandering herd or a
     * drover's camp would be met at. */
    const spotRank = rankCandidates(T.exposureInter, T.field, { limit: 24, minSep: 70, clear: 12 });

    const referencePlacement = {
      routes: chosen.slice(0, 2).map((r) => ({
        id: r.id, poly: r.poly, cr: r.cr, trains: REFERENCE_TRAINS, animals: REFERENCE_ANIMALS,
      })),
      oases: oasisRank.ranked.slice(0, 2).map((c) => ({
        id: `oasis-${c.x}-${c.z}`, x: c.x, z: c.z, r: OASIS_R, herd: REFERENCE_HERD,
      })),
    };

    const spawnPoi = T.pois.find((p) => p.kind === 'spawn');
    const spawnJourneys = T.journeys.filter((j) => j.a === spawnPoi.id || j.b === spawnPoi.id);

    /* ---- the three ceilings, each by ABLATION ------------------------- */
    const ceilings = {
      /* Remove the content budget: every candidate route in the catalogue
       * carries three trains at once. */
      caravanShare: unionExpected(cat.routes.map((r) => r.stats.per)),
      /* Remove the content budget: every legal flats cell holds an oasis. */
      oasisShare: coverableShare(T.inter, oasisRank.all, RECOGNITION + OASIS_R),
      shortWalkShare: shortWalkShare(T.field, T.inter, oasisRank.all.map((c) => ({ x: c.x, z: c.z, r: OASIS_R }))),
      /* Same, over the spawn's own journeys. */
      spawnAnyShare: 0,
    };
    const spawnPer = cat.routes.map((r) => routeStats(r.cr, spawnJourneys, { trains: REFERENCE_TRAINS }).per);
    ceilings.spawnAnyShare = Math.max(
      unionExpected(spawnPer),
      coverableShare(spawnJourneys, oasisRank.all, RECOGNITION + OASIS_R)
    );
    /* `camelsMet` is the one gate whose ceiling cannot be computed without a
     * placement - "how many animals could you meet" is meaningless until
     * somebody says how many animals there are. So it gets TWO. The one
     * reported next to the achieved value is the placement's own luckiest
     * phase, which is a true upper bound on its own mean and moves with it; the
     * one here is the reference placement's, and it exists so the guard that
     * checks a floor is passable at all has something placement-independent to
     * compare against. Without it, an empty world reports a ceiling of zero and
     * the guard concludes the gate is a wall, which is exactly backwards. */
    const reference = scorePlacement(referencePlacement, T.inter);
    ceilings.camelsMet = reference.camelsMetBest;

    return {
      ...T,
      cat, chosen, oasisField, oasisRank, oasisAnywhere, spotRank,
      referencePlacement, reference, spawnJourneys, ceilings,
      ms: { ...T.ms, routes: tRoutes - t0, corridors: Date.now() - t0 },
    };
  })();
  return _corridors;
}

/**
 * The reference placement's shape, quoted once so the floors' calibration and
 * the proof that they are reachable cannot drift apart.
 *
 * Three trains of eight animals is 24 camels on a route and 48 over the two
 * reference routes; with two eight-camel oases that is 64 animals in a 900 m
 * world. The project's own measurement says this is the right ORDER: a
 * character costs 30-50 us of frame time each, manager sweeps are free at 200
 * characters, and 74.6% of a flat roster sits beyond `RENDER_OUT` and pays for
 * nothing. Content placed on the corridors is content inside `RENDER_IN` when
 * it matters and outside it when it does not, which is the density-over-count
 * argument made geometrically instead of by budget.
 */
export const REFERENCE_TRAINS = 3;
export const REFERENCE_ANIMALS = 8;
export const REFERENCE_HERD = 8;
/** An oasis is a place with a radius, not a point. Herds are spread inside it. */
export const OASIS_R = 18;
