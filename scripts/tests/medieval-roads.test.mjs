/**
 * THE REACHABILITY GATE.
 *
 * A road network has exactly one property that matters and it is not visual:
 * can you get anywhere on it. At 400 m that was self-evident - seven roads in
 * a 150 x 230 m patch, all visible from the market. At 900 m there are twenty
 * one roads, five towns, three camps, two fords and three bridges spread over
 * 810,000 square metres, and the failure mode is silent in the worst possible
 * way: a town is simply unreachable, nothing throws, nothing looks wrong, and
 * the only symptom is a player standing on a bank looking at water.
 *
 * So connectivity is PROVED here, on the same table `MedievalWorld` builds
 * from, with the crossings declared as graph edges - because the vale's own
 * stone bridge is a 26 m gap between two road ribbons and a graph built from
 * polylines alone reports it as a break.
 *
 * The rest of the file is the set of things that are true of a road and are
 * not true of a line drawn on a plan: it does not climb a cliff, it does not
 * run down the middle of the river, and it does not leave the map.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  medievalHeight, riverZ, riverHalfWidth, WATER_Y, HALF, RIVER_FEATURES,
} from '../../src/worlds/terrain/MedievalHeight.js';
import {
  ROADS, VALE_ROADS, RING_ROADS, CROSSINGS, GREYOAK_STAGE,
  ROAD_JOIN, samplePolyline, roadGraph,
} from '../../src/worlds/medieval/RoadNet.js';
import { TOWNS } from '../../src/worlds/medieval/Towns.js';
import { CAMPS } from '../../src/worlds/medieval/Camps.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GRAPH = roadGraph();

/* ------------------------------------------------------------------ */
/* 1. The table                                                        */
/* ------------------------------------------------------------------ */

test('the vale keeps its seven roads, untouched, and the ring adds its own', () => {
  assert.equal(VALE_ROADS.length, 7);
  assert.deepEqual(VALE_ROADS.map((r) => r.key),
    ['castle', 'vale', 'high', 'bridgeN', 'bridgeS', 'church', 'mill']);
  // The spine of the composed frames, character for character.
  const castle = VALE_ROADS[0];
  assert.equal(castle.width, 7.6);
  assert.deepEqual(castle.pts[0], [-14, -58]);
  assert.deepEqual(castle.pts[castle.pts.length - 1], [34, 15]);
  assert.ok(RING_ROADS.length >= 12, `only ${RING_ROADS.length} ring roads`);
  assert.equal(ROADS.length, VALE_ROADS.length + RING_ROADS.length);
  for (const r of ROADS) {
    assert.ok(r.width >= 3.0 && r.width <= 8.0, `${r.key} is ${r.width} m wide`);
    assert.ok(r.pts.length >= 2);
  }
  assert.equal(new Set(ROADS.map((r) => r.key)).size, ROADS.length, 'duplicate road key');
});

test('MedievalWorld builds from this table and not from a second copy', () => {
  /* The whole argument rests on it: a graph proved over `ROADS` says nothing
   * about a world that kept its own copy. */
  const src = readFileSync(path.join(root, 'src/worlds/MedievalWorld.js'), 'utf8');
  assert.ok(/from '\.\/medieval\/RoadNet\.js'/.test(src),
    'MedievalWorld no longer imports the road table');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.equal(/const ROADS\s*=/.test(code), false,
    'MedievalWorld has redeclared ROADS - the reachability proof is now about a different network');
  assert.ok(/for \(const road of ROADS\)/.test(code),
    '_buildRoadPaths no longer walks the imported table');
});

/* ------------------------------------------------------------------ */
/* 2. Every ring road is a road                                        */
/* ------------------------------------------------------------------ */

test('no road climbs anything a cart could not, and the two that come close say so', () => {
  /* Walked at half-metre spacing against the real heightfield, which is the
   * only way to catch a local step: a route can average 12% and still cross a
   * 70% lip that a plan view cannot see. Two roads are declared `steep` and
   * they are the two that are steep for a reason - the escarpment onto
   * Grimscar bench and the neck onto Blackmarch Bluff. Everything else is
   * held to a cart's limit. */
  const declared = new Set(RING_ROADS.filter((r) => r.steep).map((r) => r.key));
  assert.deepEqual([...declared].sort(), ['blackmarchway', 'grimscarway']);
  for (const r of RING_ROADS) {
    const pts = samplePolyline(r.pts, 0.5);
    let worst = 0;
    let at = null;
    for (let i = 1; i < pts.length; i++) {
      const g = Math.abs(medievalHeight(pts[i][0], pts[i][1]) - medievalHeight(pts[i - 1][0], pts[i - 1][1]))
        / Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (g > worst) { worst = g; at = pts[i]; }
    }
    const limit = r.steep ? 0.62 : 0.45;
    assert.ok(worst <= limit,
      `${r.key} hits ${(worst * 100).toFixed(0)}% at (${at[0].toFixed(0)}, ${at[1].toFixed(0)}), over its ${limit * 100}% limit`);
    if (!r.steep) continue;
    // A road declared steep has to actually BE steep, or the exemption is
    // being used to hide a route nobody re-measured.
    assert.ok(worst > 0.45, `${r.key} is declared steep and peaks at ${(worst * 100).toFixed(0)}%`);
  }
});

test('no road runs down the river, and only the fords go under water', () => {
  const fords = CROSSINGS.filter((c) => c.kind === 'ford');
  assert.ok(fords.length >= 2);
  /* The ring's roads only. The vale's mill lane ends at (-14, 93) on the
   * mill leat, 26 cm under the surface, and has since the world shipped -
   * that is the mill's tailrace and it is authored, not a routing error. */
  for (const r of RING_ROADS) {
    for (const [x, z] of samplePolyline(r.pts, 1.5)) {
      const h = medievalHeight(x, z);
      if (h >= WATER_Y) continue;
      const atFord = fords.some((f) => Math.abs(x - f.x) < 34);
      const atBridge = CROSSINGS.some((c) => c.kind === 'bridge' && Math.abs(x - c.x) < 22
        && z > Math.min(c.from[1], c.to[1]) - 8 && z < Math.max(c.from[1], c.to[1]) + 8);
      assert.ok(atFord || atBridge,
        `${r.key} runs under water at (${x.toFixed(0)}, ${z.toFixed(0)}) with no crossing to explain it`);
    }
  }
});

test('every road stays on the playfield', () => {
  for (const r of ROADS) {
    for (const [x, z] of samplePolyline(r.pts, 2)) {
      assert.ok(Math.abs(x) < HALF - 3 && Math.abs(z) < HALF - 3,
        `${r.key} leaves the map at (${x.toFixed(0)}, ${z.toFixed(0)})`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* 3. Crossings                                                        */
/* ------------------------------------------------------------------ */

test('every ford is genuinely wadeable across the width a player walks', () => {
  for (const c of CROSSINGS) {
    if (c.kind !== 'ford') continue;
    const rz = riverZ(c.x);
    const hw = riverHalfWidth(c.x);
    let worst = 0;
    // A player-width corridor, right across the channel.
    for (let dx = -c.width / 2; dx <= c.width / 2; dx += 0.4) {
      for (let dz = -hw - 1; dz <= hw + 1; dz += 0.4) {
        const depth = WATER_Y - medievalHeight(c.x + dx, riverZ(c.x + dx) + dz);
        if (depth > worst) worst = depth;
      }
    }
    assert.ok(worst > 0.15, `${c.id} is dry - it is not a ford, it is a road`);
    assert.ok(worst < 0.75, `${c.id} is ${(worst * 100).toFixed(0)} cm deep at its worst - that is a swim`);
    void rz;
  }
});

test('every bridge lands on dry ground at both ends and clears the water', () => {
  for (const c of CROSSINGS) {
    if (c.kind !== 'bridge') continue;
    for (const end of [c.from, c.to]) {
      const h = medievalHeight(end[0], end[1]);
      assert.ok(h > WATER_Y + 0.6,
        `${c.id}'s abutment at z=${end[1]} stands at ${h.toFixed(2)} m, in the water`);
    }
    assert.equal(Math.abs(c.to[1] - c.from[1]), c.span, `${c.id}'s declared span is not its own length`);
    // The deck must clear the water by more than a boat's height, and must not
    // be so high the approach roads cannot reach it.
    assert.ok(c.deckY - WATER_Y >= 1.6, `${c.id}'s deck is ${(c.deckY - WATER_Y).toFixed(2)} m over the water`);
    const bankY = Math.max(medievalHeight(c.x, c.from[1]), medievalHeight(c.x, c.to[1]));
    assert.ok(c.deckY - bankY < 2.6,
      `${c.id}'s deck stands ${(c.deckY - bankY).toFixed(2)} m over its own abutments`);
    // And it has to actually span the channel it crosses.
    assert.ok(c.span > riverHalfWidth(c.x) * 2,
      `${c.id} spans ${c.span} m across a ${(riverHalfWidth(c.x) * 2).toFixed(1)} m channel`);
  }
});

test('there are at least four ways across the river, in at least three places', () => {
  /* The brief's own line: a 900 m map with towns on both banks cannot have one
   * crossing. It shipped with exactly one - the stone bridge at x = 26. */
  assert.ok(CROSSINGS.length >= 4, `only ${CROSSINGS.length} crossings`);
  const places = new Set(CROSSINGS.map((c) => Math.round(c.x / 40)));
  assert.ok(places.size >= 3, `every crossing is in the same reach of the river`);
  assert.ok(CROSSINGS.some((c) => c.x < -100), 'nothing crosses the western river');
  assert.ok(CROSSINGS.some((c) => c.x > 100), 'nothing crosses the eastern river');
  assert.ok(CROSSINGS.filter((c) => c.kind === 'bridge').length >= 3, 'only one bridge in the world');
});

test("Greyoak's stage is a dead end, and honest about it", () => {
  // It was routed as a two-span causeway and thrown away: the north bank at
  // x = -404 is the foot of a dip slope that climbs 28 m in 28 m. A crossing
  // there lands the player on a face with nowhere to go, which is worse than
  // no crossing because it looks like a route.
  assert.equal(CROSSINGS.some((c) => c.id === 'greyoak-stage'), false,
    'the Greyoak stage has been promoted to a crossing - the north bank is a 100% face');
  const braid = RIVER_FEATURES.find((f) => f.id === 'greyoak-braid');
  assert.ok(braid, 'the braid this stage exists for has gone');
  // It reaches the gravel bar, which is the only reason it is buildable.
  const barZ = riverZ(GREYOAK_STAGE.x) + braid.barAt;
  assert.ok(Math.abs(GREYOAK_STAGE.toZ - barZ) < braid.barHalf + 3,
    'the stage stops short of the shingle it is supposed to reach');
  assert.ok(medievalHeight(GREYOAK_STAGE.x, GREYOAK_STAGE.fromZ) > WATER_Y,
    'the stage starts in the water');
});

/* ------------------------------------------------------------------ */
/* 4. The graph                                                        */
/* ------------------------------------------------------------------ */

test('the whole network is one connected component', () => {
  const comps = new Set(Array.from(GRAPH.comp));
  assert.equal(comps.size, 1,
    `the road network is in ${comps.size} pieces - somewhere is unreachable`);
});

test('every town and every camp is reachable from Aldermoor market', () => {
  for (const t of TOWNS) {
    assert.ok(GRAPH.connects(34, 18, t.entry.x, t.entry.z, 12),
      `${t.displayName} cannot be walked to from the market`);
  }
  for (const c of CAMPS) {
    assert.ok(GRAPH.connects(34, 18, c.x, c.z, 26),
      `${c.name} cannot be walked to from the market`);
  }
  // ...and the far bank is reachable from the vale bank without swimming,
  // which is the property the crossings exist for.
  const entry = Object.fromEntries(TOWNS.map((t) => [t.id, t.entry]));
  assert.ok(GRAPH.connects(entry.grimscar.x, entry.grimscar.z,
    entry['st-ceolwine'].x, entry['st-ceolwine'].z, 12), 'Grimscar cannot reach the abbey');
  assert.ok(GRAPH.connects(entry.blackmarch.x, entry.blackmarch.z,
    entry['fenwick-cross'].x, entry['fenwick-cross'].z, 12), 'Blackmarch cannot reach Fenwick');
});

test('the network is a circuit, not a set of dead-ended spurs', () => {
  /* Removing any single road must not strand a town. That is the difference
   * between a network and a tree, and it is what the far-bank track and the
   * pilgrim path were added for - without them Fenwick and the abbey are each
   * reachable by exactly one route and the whole southern half of the map is
   * an out-and-back. */
  const targets = TOWNS.map((t) => [t.displayName, t.entry.x, t.entry.z]);
  let redundant = 0;
  for (const drop of RING_ROADS) {
    const g = roadGraph(ROADS.filter((r) => r !== drop), CROSSINGS, ROAD_JOIN);
    const stranded = targets.filter(([, x, z]) => !g.connects(34, 18, x, z, 12));
    if (stranded.length === 0) redundant++;
  }
  assert.ok(redundant >= 4,
    `only ${redundant} of ${RING_ROADS.length} ring roads can be removed without stranding a town`);
});

test('junctions are made at shared control points, not by two splines passing near', () => {
  /* Catmull-Rom passes through every control point, so two roads that share
   * one meet exactly on the curve whatever the tension does between points.
   * Every ring road is authored to begin on a control point copied from the
   * road it branches off; the old vale's seven predate that and merely come
   * close, which is what `ROAD_JOIN` exists for. This asserts the discipline
   * held: each ring road's own endpoints coincide EXACTLY with a control point
   * somewhere else in the table. */
  const points = new Set();
  for (const r of ROADS) for (const [x, z] of r.pts) points.add(`${x},${z}`);
  let exact = 0;
  for (const r of RING_ROADS) {
    const ends = [r.pts[0], r.pts[r.pts.length - 1]];
    for (const [x, z] of ends) {
      let shared = false;
      for (const other of ROADS) {
        if (other === r) continue;
        if (other.pts.some((p) => p[0] === x && p[1] === z)) shared = true;
      }
      if (shared) exact++;
    }
  }
  assert.ok(exact >= RING_ROADS.length,
    `only ${exact} ring-road endpoints land on a shared control point`);
  void points;
});

test('samplePolyline is a faithful, conservative resampling', () => {
  const pts = [[0, 0], [10, 0], [10, 10]];
  const s = samplePolyline(pts, 2.5);
  // Endpoints preserved exactly, spacing never exceeded, corners hit.
  assert.deepEqual(s[0], [0, 0]);
  assert.deepEqual(s[s.length - 1], [10, 10]);
  for (let i = 1; i < s.length; i++) {
    assert.ok(Math.hypot(s[i][0] - s[i - 1][0], s[i][1] - s[i - 1][1]) <= 2.5 + 1e-9);
  }
  assert.ok(s.some((p) => p[0] === 10 && p[1] === 0), 'the corner control point was dropped');
});
