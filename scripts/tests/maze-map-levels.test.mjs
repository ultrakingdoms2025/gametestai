import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAZE, generateTopology, cellIndex, cellCoords, isOpen, DIR,
} from '../../src/worlds/maze/MazeTopology.js';
import { MazeWorld } from '../../src/worlds/MazeWorld.js';
import { OVERVIEW, overviewSheet, singleSheet, verticalLinks } from '../../src/ui/MazeMapLayout.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** A MazeWorld with just enough of itself to answer map questions. */
function mapWorld(seed) {
  const t = generateTopology(seed);
  const w = Object.create(MazeWorld.prototype);
  w.cells = t.cells;
  w.centreCell = t.centreCell;
  w._solution = null;
  w._solutionFrom = -1;
  w._connectorsByLevel = null;
  w._centreTaken = true;
  w.centrePosition = null;
  w.portalSpecs = [];
  w._tokens = [];
  return { world: w, topology: t };
}

/** The route a player standing at the entrance would be shown by Ctrl+M. */
function routeFromEntrance(world, topology) {
  const e = cellCoords(topology.entranceCell);
  return world.solutionPath({
    x: e.x * MAZE.CELL,
    y: e.level * MAZE.LEVEL_HEIGHT,
    z: e.z * MAZE.CELL,
  });
}

/* ------------------------------------------------------------------ */
/* The arrangement                                                     */
/* ------------------------------------------------------------------ */

test('THE ALL-LEVELS GATE: the overview lays out every level, not just the one under the player', () => {
  const sheet = overviewSheet(100, 10);
  assert.equal(sheet.panes.length, MAZE.LEVELS,
    `the overview draws ${sheet.panes.length} of ${MAZE.LEVELS} levels - M is meant to show all of them at once`);
  const levels = sheet.panes.map((p) => p.level).sort((a, b) => a - b);
  assert.deepEqual(levels, [...Array(MAZE.LEVELS).keys()], 'a level is drawn twice, or not at all');
});

test('no two floorplans overlap, and none escapes the sheet', () => {
  /* The whole reason for a grid rather than a stack: four levels superimposed
   * would suggest a corridor runs through a floor, which is the one thing the
   * route drawing has always refused to imply. */
  const sheet = overviewSheet(100, 10);
  for (const p of sheet.panes) {
    assert.ok(p.x >= 0 && p.y >= 0, `pane ${p.level} starts outside the sheet`);
    assert.ok(p.x + p.side <= sheet.width + 1e-9, `pane ${p.level} runs off the right of the sheet`);
    assert.ok(p.y + p.side <= sheet.height + 1e-9, `pane ${p.level} runs off the bottom of the sheet`);
  }
  for (let i = 0; i < sheet.panes.length; i++) {
    for (let j = i + 1; j < sheet.panes.length; j++) {
      const a = sheet.panes[i], b = sheet.panes[j];
      const apart = a.x + a.side <= b.x || b.x + b.side <= a.x
        || a.y + a.side <= b.y || b.y + b.side <= a.y;
      assert.ok(apart, `levels ${a.level} and ${b.level} overlap - one floorplan is drawn over another`);
    }
  }
});

test('the panes are gapped, so four floorplans do not read as one', () => {
  const sheet = overviewSheet(100, 10);
  const xs = [...new Set(sheet.panes.map((p) => p.x))].sort((a, b) => a - b);
  assert.ok(xs.length > 1, 'every pane sits in one column');
  assert.equal(xs[1] - xs[0], 110, 'columns are flush against each other - the gap was dropped');
});

test('the sheet is near-square, because the panel it lands in is square', () => {
  /* `min(92vw, 92vh)` in maze-map.css. A 1x4 strip in a square panel would fit
   * each level into a quarter of the panel edge; a 2x2 fits each into a half,
   * which is twice the linear scale for the same screen. */
  const sheet = overviewSheet(100, 10);
  const ratio = sheet.width / sheet.height;
  assert.ok(ratio > 0.85 && ratio < 1.18, `overview aspect ${ratio.toFixed(2)} wastes half a square panel`);
});

test('levels are laid out in the order the tabs and the 1-4 keys name them', () => {
  const sheet = overviewSheet(100, 10);
  const byLevel = new Map(sheet.panes.map((p) => [p.level, p]));
  const a = byLevel.get(0), b = byLevel.get(1);
  assert.ok(b.y === a.y && b.x > a.x, 'level 2 does not follow level 1 across the top row');
  assert.ok(byLevel.get(2).y > a.y, 'the second row does not start below the first');
});

test('the single-level sheet is still one pane at the origin', () => {
  // Paging to one floor must not go through the grid maths at all, or the view
  // that opens at junction scale starts landing a quarter of the way across.
  const sheet = singleSheet(2, 100);
  assert.equal(sheet.panes.length, 1);
  assert.deepEqual(
    { level: sheet.panes[0].level, x: sheet.panes[0].x, y: sheet.panes[0].y },
    { level: 2, x: 0, y: 0 },
  );
  assert.equal(sheet.width, 100);
  assert.equal(sheet.height, 100);
});

/* ------------------------------------------------------------------ */
/* Where the route changes floor                                       */
/* ------------------------------------------------------------------ */

test('verticalLinks reports every level change in a route and nothing else', () => {
  const path = [
    { x: 0, z: 0, level: 0 },
    { x: 6, z: 0, level: 0 },
    { x: 6, z: 0, level: 1 },
    { x: 6, z: 6, level: 1 },
    { x: 6, z: 6, level: 0 },
  ];
  const links = verticalLinks(path);
  assert.equal(links.length, 2, `reported ${links.length} level changes in a route that makes two`);
  assert.deepEqual(links[0], { x: 6, z: 0, from: 0, to: 1 });
  assert.deepEqual(links[1], { x: 6, z: 6, from: 1, to: 0 });
});

test('a route that never leaves its floor produces no links to draw', () => {
  assert.deepEqual(verticalLinks([{ x: 0, z: 0, level: 1 }, { x: 6, z: 0, level: 1 }]), []);
  assert.deepEqual(verticalLinks([]), []);
});

test('THE CONTIGUITY GATE: the route steps one cell at a time, on every seed tried', () => {
  /* Drawn across four floorplans at once, a route with a jump in it would read
   * as a way through a hedge on one pane and a teleport between two others. */
  for (const seed of [3, 77, 2026, 4242]) {
    const { world, topology } = mapWorld(seed);
    const route = routeFromEntrance(world, topology);
    assert.ok(route.length > 10, `seed ${seed}: route is only ${route.length} steps`);
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1], b = route[i];
      const dx = Math.abs(a.x - b.x) / MAZE.CELL;
      const dz = Math.abs(a.z - b.z) / MAZE.CELL;
      const dl = Math.abs(a.level - b.level);
      assert.equal(dx + dz + dl, 1, `seed ${seed}: step ${i} moves dx=${dx} dz=${dz} dlevel=${dl}`);
    }
  }
});

test('THE VERTICAL-LINK GATE: the route changes floor only where the topology has one', () => {
  /* The claim the all-levels drawing makes. A link drawn between two panes
   * says "the way up is here" - if it landed anywhere but a real shaft the
   * player would stand in a dead corridor looking for a staircase. */
  for (const seed of [3, 77, 2026, 4242]) {
    const { world, topology } = mapWorld(seed);
    const links = verticalLinks(routeFromEntrance(world, topology));
    assert.ok(links.length > 0, `seed ${seed}: the route never leaves level 0 - nothing to show on four maps`);
    for (const link of links) {
      const x = Math.round(link.x / MAZE.CELL);
      const z = Math.round(link.z / MAZE.CELL);
      const lower = Math.min(link.from, link.to);
      assert.equal(Math.abs(link.from - link.to), 1, `seed ${seed}: a link skips a floor`);
      assert.ok(isOpen(topology.cells, cellIndex(x, z, lower), DIR.UP),
        `seed ${seed}: the route changes floor at ${x},${z} where the topology has no vertical link`);
    }
  }
});

test('and every one of those links stands on a connector the map already plots', () => {
  /* The link has to point at something the player can see and walk to. The
   * marker set is per level and names what is BUILT, so the transition cell
   * must appear among the lower level's stairs, lifts or tunnels. */
  const { world, topology } = mapWorld(2026);
  const links = verticalLinks(routeFromEntrance(world, topology));
  for (const link of links) {
    const lower = Math.min(link.from, link.to);
    const m = world.mapMarkers(lower);
    const near = [...m.stair, ...m.lift, ...m.tunnel].some(
      (c) => Math.abs(c.x - link.x) < 1e-6 && Math.abs(c.z - link.z) < 1e-6,
    );
    assert.ok(near, `the route leaves level ${lower} at ${link.x},${link.z}, where the map plots no connector`);
  }
});

test('the route spans several floors, so the all-levels view is worth having', () => {
  const { world, topology } = mapWorld(2026);
  const levels = new Set(routeFromEntrance(world, topology).map((s) => s.level));
  assert.ok(levels.size >= 2, `the route touches only ${levels.size} level(s)`);
});

/* ------------------------------------------------------------------ */
/* What the map does with all that                                     */
/* ------------------------------------------------------------------ */

test('the map opens on all four levels, and can still be paged down to one', async () => {
  const src = await readFile(path.join(root, 'src/ui/MazeMap.js'), 'utf8');
  assert.ok(src.includes("from './MazeMapLayout.js'"),
    'MazeMap does not use the shared layout - the arrangement would be untestable again');
  const open = src.slice(src.indexOf('\n  open() {'), src.indexOf('\n  close() {'));
  assert.ok(open.includes('OVERVIEW'), 'open() does not start on the all-levels view');
  assert.ok(/setLevel\(/.test(src), 'paging to a single floor was removed along the way');
});

test('the drawing walks the sheet, so adding a level adds a floorplan', async () => {
  const src = await readFile(path.join(root, 'src/ui/MazeMap.js'), 'utf8');
  const draw = src.slice(src.indexOf('\n  _draw() {'), src.indexOf('\n  _project('));
  assert.ok(/for \(const pane of sheet\.panes\)/.test(draw),
    '_draw does not iterate the sheet - it is still drawing one baked level');
  assert.ok(/_render\(w, pane\.level\)/.test(draw),
    '_draw bakes something other than the pane it is about to draw');
});

test('THE ONE-SOLVER GATE: the map asks the world for the route, it does not find one', async () => {
  /* `solve` in MazeTopology.js is the single answer to "is this maze
   * solvable", and a second search in the UI would be a second answer - the
   * exact split this repo keeps closing. */
  const src = await readFile(path.join(root, 'src/ui/MazeMap.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(/solutionPath\?\.\(|solutionPath\(/.test(code), 'the map no longer asks the world for the route');
  for (const forbidden of [/\bparentField\b/, /\bInt32Array\b/, /\bneighbourOf\b/, /\bqueue\b/]) {
    assert.ok(!forbidden.test(code),
      `MazeMap.js contains ${forbidden} - it is searching the maze itself, and two solvers disagree`);
  }
});

test('THE ONE-OWNER GATE: Ctrl+M is decided by the same predicate as M', async () => {
  /* One predicate decides who owns M (commit 6e863e3). The chord is the same
   * key, so a second rule for it would be a second way for the map and the
   * mount wheel to disagree - which is the whole thing that predicate exists
   * to make impossible. */
  const src = await readFile(path.join(root, 'src/ui/MazeMap.js'), 'utf8');
  const key = src.slice(src.indexOf('\n  _onKey(e) {'), src.indexOf('\n  _onWheel(e) {'));
  const chord = key.slice(0, key.indexOf('if (e.ctrlKey || e.metaKey || e.altKey) return;'));
  assert.ok(chord.length > 0, 'the Ctrl+M branch no longer comes before the modifier guard');
  assert.ok(chord.includes('mapActionOwner'),
    'the Ctrl+M branch does not consult mapActionOwner - it decides for itself who owns the key');
  assert.ok(/codeFor\?\.\('map'\)/.test(chord),
    'the Ctrl+M branch hard-codes its key instead of following the map binding');
});

test('the map still installs exactly one keydown listener', async () => {
  // A competing handler is how a chord ends up handled twice, or by nobody.
  const src = await readFile(path.join(root, 'src/ui/MazeMap.js'), 'utf8');
  const n = (src.match(/addEventListener\('keydown'/g) ?? []).length;
  assert.equal(n, 1, `MazeMap installs ${n} keydown listeners`);
});

test('the legend names the route, now that it is drawn across four maps', async () => {
  const src = await readFile(path.join(root, 'src/ui/MazeMap.js'), 'utf8');
  const foot = src.slice(src.indexOf('mz-map-foot'), src.indexOf('</div>`'));
  assert.ok(/route/i.test(foot), 'the legend does not name the solution route');
});
