import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAZE, generateTopology, cellIndex, cellCoords, isOpen, DIR,
} from '../../src/worlds/maze/MazeTopology.js';
import { MazeWorld } from '../../src/worlds/MazeWorld.js';
import {
  OVERVIEW, overviewSheet, singleSheet, paneAt, verticalLinks,
} from '../../src/ui/MazeMapLayout.js';

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
  /* `--mz-side` in maze-map.css is `min(width, height)` of the safe box, and
   * the panel is that square. A 1x4 strip in a square panel would fit each
   * level into a quarter of the panel edge; a 2x2 fits each into a half, which
   * is twice the linear scale for the same screen. */
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
/* Clicking a floorplan to enlarge it                                  */
/* ------------------------------------------------------------------ */

test('THE ENLARGE GATE: every floorplan can be picked out by a click inside it', () => {
  /* The map inverts its own pan and zoom to reach sheet space; from there the
   * question "which floor did they click" is this and nothing else. If it
   * picked the wrong pane the player would ask for level 3 and be paged to
   * level 1, which is indistinguishable from the click being ignored. */
  const sheet = overviewSheet(100, 10);
  for (const pane of sheet.panes) {
    const hit = paneAt(sheet, pane.x + pane.side / 2, pane.y + pane.side / 2);
    assert.ok(hit, `the middle of level ${pane.level}'s floorplan hits nothing`);
    assert.equal(hit.level, pane.level,
      `clicking level ${pane.level} would enlarge level ${hit.level}`);
  }
});

test('a click in the gutter names no floor, so nothing happens', () => {
  /* Deliberate, and the alternative was snapping to the nearest pane. The
   * player between two floorplans meant one of them and the map cannot know
   * which, so paging to a guess is worse than letting them click again. */
  const sheet = overviewSheet(100, 10);
  assert.equal(paneAt(sheet, 105, 50), null, 'the column gutter is treated as part of a floorplan');
  assert.equal(paneAt(sheet, 50, 105), null, 'the row gutter is treated as part of a floorplan');
  assert.equal(paneAt(sheet, 105, 105), null, 'where the two gutters cross belongs to a floorplan');
});

test('a click off the sheet names no floor either', () => {
  const sheet = overviewSheet(100, 10);
  // Reachable in practice: the sheet is fitted to a square panel, so at zoom 1
  // there is bare background wherever the panel is not square.
  for (const [x, y] of [[-1, 50], [50, -1], [sheet.width, 50], [50, sheet.height], [-40, -40]]) {
    assert.equal(paneAt(sheet, x, y), null, `${x},${y} is outside the sheet and hit a floorplan`);
  }
  assert.equal(paneAt(sheet, NaN, 50), null, 'a degenerate scale produced a hit rather than a miss');
  assert.equal(paneAt(null, 50, 50), null);
});

test('pane edges belong to exactly one floorplan', () => {
  /* Half-open bounds. With a gutter between every pair this cannot bite today,
   * but a zero-gap sheet would otherwise make the answer depend on the order
   * the panes happen to be listed in. */
  const sheet = overviewSheet(100, 10);
  assert.equal(paneAt(sheet, 0, 0).level, 0, 'the sheet origin is outside level 1');
  assert.equal(paneAt(sheet, 99.999, 99.999).level, 0, 'the far corner of level 1 is not in it');
  assert.equal(paneAt(sheet, 100, 50), null, 'a pane owns the pixel past its own edge');
  assert.equal(paneAt(sheet, 110, 50).level, 1, 'the near edge of level 2 belongs to nobody');
  const flush = overviewSheet(100, 0);
  const seam = paneAt(flush, 100, 50);
  assert.equal(seam.level, 1, 'with no gutter, the seam is claimed by the pane that ends there');
});

test('the single-floor view still answers, so the hit-test needs no special case', () => {
  // It is not asked in that view - it is already the enlarged one - but a
  // function that threw there would be a trap for whoever changes that.
  const sheet = singleSheet(2, 100);
  assert.equal(paneAt(sheet, 50, 50).level, 2);
  assert.equal(paneAt(sheet, 150, 50), null);
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

test('paging out of the overview enlarges THAT pane - it does not teleport the window', async () => {
  /* The owner's report, and the second time this exact shape has bitten: with
   * the Ctrl+M route up, pressing 1-4 dropped to a junction-scale window
   * centred on the player's own position, so the visible fragment of route
   * (or, on a floor they were not standing on, an empty corridor somewhere
   * else) looked nothing like the pane they had just been reading - which
   * read as the route CHANGING between views. It never changed; the window
   * did. Paging out of the overview must land on the floor FITTED WHOLE, the
   * literal enlargement of the pane that was clicked. Junction scale stays
   * one FIND ME press away, which is what `recentre` is for. */
  const src = await readFile(path.join(root, 'src/ui/MazeMap.js'), 'utf8');
  const setLevel = src.slice(src.indexOf('\n  setLevel('), src.indexOf('\n  _onDown('));
  const branch = setLevel.slice(setLevel.indexOf('fromOverview) {'));
  assert.ok(/_zoom = MIN_ZOOM/.test(branch),
    'leaving the overview no longer fits the floor whole - the window teleports again');
  assert.ok(!/_centreOnPlayer|OPEN_CELLS_ACROSS/.test(branch),
    'leaving the overview recentres on the player - that is FIND ME\'s job, answered uninvited');
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

test('a pan is not a click: the release measures how far the pointer travelled', async () => {
  /* Both gestures share one button on one canvas, so the only thing keeping
   * drag-to-pan from paging the map on every release is this measurement. */
  const src = await readFile(path.join(root, 'src/ui/MazeMap.js'), 'utf8');
  const up = src.slice(src.indexOf('\n  _onUp(e) {'), src.indexOf('\n  dispose() {'));
  assert.ok(up.length > 0, '_onUp no longer takes the event it needs to place the click');
  assert.ok(/fromX|fromY/.test(up), '_onUp does not compare against where the press started');
  assert.ok(/CLICK_SLOP_PX/.test(up), 'the pan-versus-click threshold was dropped');
  assert.ok(/OVERVIEW/.test(up), 'a click on the single-floor view now pages somewhere');
  assert.ok(/_paneAtClient/.test(up), '_onUp decides which floor was clicked by some other means');
});

test('the hit-test inverts the drawing, rather than keeping its own idea of the panes', async () => {
  /* Two copies of the fit-then-pan arithmetic drift, and the symptom is a
   * click landing on the neighbouring floorplan near a gutter. */
  const src = await readFile(path.join(root, 'src/ui/MazeMap.js'), 'utf8');
  assert.ok(/paneAt/.test(src) && src.includes("from './MazeMapLayout.js'"),
    'the pane hit-test moved out of the shared layout, where it cannot be asserted');
  const draw = src.slice(src.indexOf('\n  _draw() {'), src.indexOf('\n  _project('));
  assert.ok(/this\._frame\(\)/.test(draw),
    '_draw computes its own projection again - the click and the zoom now invert a different one');
});

test('THE WHEEL GATE: the plain wheel zooms, about the pointer, and the chord scrolls', async () => {
  /* The owner asked for zoom (2026-08-09). Panning is not lost with it -
   * drag-to-pan covers it, and Ctrl, Cmd or Shift still scroll. */
  const src = await readFile(path.join(root, 'src/ui/MazeMap.js'), 'utf8');
  const wheel = src.slice(src.indexOf('\n  _onWheel(e) {'), src.indexOf('\n  _zoomAbout('));
  assert.ok(wheel.length > 0, '_onWheel or _zoomAbout went missing');
  const branch = wheel.indexOf('if (e.ctrlKey || e.metaKey || e.shiftKey) {');
  assert.ok(branch > 0, 'the modifier no longer selects scrolling - the wheel default may have flipped back');
  const modified = wheel.slice(branch, wheel.indexOf('} else {', branch));
  assert.ok(/_panX|_panY/.test(modified) && !/_zoomAbout/.test(modified),
    'the modified wheel zooms rather than scrolls');
  const plain = wheel.slice(wheel.indexOf('} else {', branch));
  assert.ok(/_zoomAbout\(e\.clientX, e\.clientY/.test(plain),
    'the plain wheel does not zoom about the pointer - centre-anchored zoom walks the view off the panel');
});

test('the header hint tells the truth about the wheel and the click', async () => {
  /* A hint that still said WHEEL SCROLLS would be worse than no hint: the
   * player would conclude the map was broken rather than that it had changed. */
  const src = await readFile(path.join(root, 'src/ui/MazeMap.js'), 'utf8');
  const hint = src.slice(src.indexOf('mz-map-hint'), src.indexOf('</span>', src.indexOf('mz-map-hint')));
  assert.ok(!/WHEEL SCROLLS/.test(hint), 'the hint still promises the old wheel behaviour');
  assert.ok(/WHEEL(?: OR PINCH)? ZOOMS/.test(hint), 'the hint does not say the wheel zooms');
  assert.ok(/CLICK A FLOOR/i.test(hint), 'nothing tells the player a floorplan can be clicked');
  /* And the half of it a phone can reach. A hint that names only the wheel on
   * a device with no wheel tells a touch player the map has one zoom level. */
  assert.ok(/PINCH/i.test(hint), 'nothing tells a touch player the map can be pinched');
  assert.ok(/FIND ME/i.test(hint),
    'nothing names the recentre control - Home is a key a phone does not have');
});

test('the legend names the route, now that it is drawn across four maps', async () => {
  const src = await readFile(path.join(root, 'src/ui/MazeMap.js'), 'utf8');
  const foot = src.slice(src.indexOf('mz-map-foot'), src.indexOf('</div>`'));
  assert.ok(/route/i.test(foot), 'the legend does not name the solution route');
});

/* ------------------------------------------------------------------ */
/* The pointer                                                         */
/* ------------------------------------------------------------------ */

/**
 * The map's slice of MazeMap.js, cut at the method boundaries.
 *
 * Source gates rather than DOM tests, in the habit of the file above: the
 * behaviour being pinned is "which call is made, in which method", and standing
 * up a canvas, a pointer lock and a browser in Node to assert that costs more
 * than it proves. The BROWSER is where the fix was verified working; these are
 * here so it cannot be quietly undone.
 */
async function mazeMapMethod(name, until) {
  const src = await readFile(path.join(root, 'src/ui/MazeMap.js'), 'utf8');
  const from = src.indexOf(`\n  ${name}`);
  assert.ok(from > 0, `${name} went missing from MazeMap`);
  const to = src.indexOf(`\n  ${until}`, from);
  assert.ok(to > from, `${until} went missing from MazeMap`);
  return src.slice(from, to);
}

test('THE POINTER GATE: open() releases the pointer lock', async () => {
  /* The owner's bug, in their words: "the mouse is locked on the game play
   * window and not the map so as i try things it is just moving the game".
   *
   * While the game holds pointer lock there is no cursor and no hit-testing -
   * every mouse event goes to the locked element as movement - so the wheel
   * zoom, the click-a-floorplan and FIND ME are not hard to hit, they are
   * unreachable. Binding the listeners correctly, which this file always did,
   * is not enough on its own. */
  const open = await mazeMapMethod('open() {', 'close() {');
  assert.match(open, /this\.input\?\.exitLock\?\.\(\)/,
    'open() no longer releases the pointer lock - the map is unusable by mouse again');
  assert.match(open, /this\._hadLock = !!this\.input\?\.locked/,
    'open() does not record whether the pointer was locked, so close() cannot know what to restore');
  /* Order matters: the record has to be taken BEFORE the lock is dropped, or it
   * reads back the state this method just created and is always false. */
  assert.ok(open.indexOf('this._hadLock =') < open.indexOf('this.input?.exitLock'),
    'the lock is dropped before it is recorded, so _hadLock is always false and close() never restores');
});

test('THE POINTER GATE: close() restores the lock, and only if there was one', async () => {
  /* Conditional on purpose. A player who opened the map from an already
   * unlocked state - the STANDBY overlay, or another panel up - must not be
   * dropped into mouse-look on close; taking the pointer from under a menu
   * they can still see is this same bug pointed the other way.
   *
   * The delay and the keyboard re-arm are not decoration either, and both are
   * copied from the panels that got here first (`InventoryUI.menuFocusOut`,
   * `CharacterMenu.close`): browsers refuse a lock request that follows an
   * Escape-driven exit too closely, and `exitLock` gives back the KEYBOARD lock
   * as well, so re-taking only the pointer leaves Ctrl+W live mid-run. */
  const close = await mazeMapMethod('close() {', '_centreOnPlayer() {');
  const guard = close.indexOf('if (hadLock)');
  assert.ok(guard > 0, 'close() restores the lock unconditionally - it force-locks a player who never had one');
  const restore = close.slice(guard);
  assert.match(restore, /requestPointerLock/, 'close() never re-acquires the pointer lock');
  assert.match(restore, /relockKeyboard/,
    'close() takes the pointer back but not the keyboard - Ctrl+W closes the window again');
  assert.match(restore, /setTimeout\([\s\S]*?,\s*140\)/,
    'the re-lock lost its delay - a request this close to an Escape-driven exit is refused');
  assert.match(restore, /catch/, 'the re-lock is unguarded; a rejection must never throw out of a close');
});

test('every way out of the map goes through close()', async () => {
  /* There are three, and a fix written into only the map key would leave the
   * player cursor-bound after Escape or after walking out of the maze. The
   * cheap way to keep that true is to let `_open = false` exist in exactly one
   * place, which is what this asserts. */
  const src = await readFile(path.join(root, 'src/ui/MazeMap.js'), 'utf8');
  /* Past the constructor, which has to initialise the flag and is not a close. */
  const methods = src.slice(src.indexOf('\n  get isOpen()'));
  const clears = methods.match(/this\._open = false/g) ?? [];
  assert.equal(clears.length, 1,
    `_open is cleared in ${clears.length} places - a close path that skips close() skips the pointer restore too`);
  const body = await mazeMapMethod('close() {', '_centreOnPlayer() {');
  assert.match(body, /this\._open = false/, 'the one place _open is cleared is not close()');
  for (const exit of ['toggle() {', '_onKey(e) {', '_draw() {']) {
    const from = src.indexOf(`\n  ${exit}`);
    assert.ok(from > 0, `${exit} went missing`);
    assert.match(src.slice(from, src.indexOf('\n  }', from)), /this\.close\(\)/,
      `${exit} closes the map without going through close()`);
  }
});

test('the map does not capture text, or the map key would stop closing it', async () => {
  /* The sibling panels open through `InventoryUI.menuFocusIn`, which exits the
   * lock AND calls `setTextCapture(true)`. This panel deliberately does not use
   * it: `_onKey` reads `input.textCaptured` as its "a text field owns the
   * keyboard" guard and returns before the map key is tested, so capturing text
   * here would lock the player inside the panel they just opened. */
  const src = await readFile(path.join(root, 'src/ui/MazeMap.js'), 'utf8');
  /* Code only. The reasoning above is written down in `open`, and a gate that
   * failed because the source EXPLAINS what it refuses to do would teach the
   * next person to delete the explanation. */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(!/setTextCapture/.test(code),
    'MazeMap captures text input - _onKey then returns early and the map key can no longer close the map');
  assert.ok(!/menuFocusIn/.test(code),
    'MazeMap opens through menuFocusIn, which captures text and breaks the map key');
});

test('THE POINTER GATE: the panel takes mouse events at all', async () => {
  /* The second half of the owner's report, and the half that no amount of
   * pointer-lock work would have fixed on its own. `#ui-root` is
   * `pointer-events: none` in hud.css so the HUD never eats the crosshair, and
   * only `button`, `input`, `textarea` and `.interactive` opt back in. This
   * panel inherited the `none`, so its tabs and FIND ME worked (they are
   * buttons) while the CANVAS - which carries the wheel zoom and the
   * click-a-floorplan - was invisible to the mouse: `elementsFromPoint` at the
   * middle of the open map returned `#viewport`, the GAME canvas, underneath.
   *
   * Which is worse than dead: `Input` locks the pointer on a mousedown over the
   * game canvas, so a click aimed at a floorplan re-took the lock and put the
   * player straight back into the bug. */
  const css = await readFile(path.join(root, 'src/ui/maze-map.css'), 'utf8');
  const rule = css.slice(css.indexOf('.mz-map {'), css.indexOf('}', css.indexOf('.mz-map {')));
  assert.match(rule, /pointer-events:\s*auto/,
    'the map overlay does not opt back into pointer events - #ui-root is pointer-events:none, so the '
    + 'canvas is transparent to the mouse and clicks fall through to the game canvas beneath');
});

test('the STANDBY overlay is kept off the map it would otherwise cover', async () => {
  /* Releasing the lock makes `main.js` raise the HUD pause overlay. It is also
   * z-index 60 and is appended after this panel, so it wins the stack and takes
   * the clicks - the fix would cover the map with "click to resume" and change
   * nothing the player could feel. Same rule, same reason, as the inventory,
   * character and quest panels already carry against hud.css. */
  const js = await readFile(path.join(root, 'src/ui/MazeMap.js'), 'utf8');
  const css = await readFile(path.join(root, 'src/ui/maze-map.css'), 'utf8');
  assert.match(js, /classList\.add\('mz-map-open'\)/, 'nothing marks the body while the map is open');
  assert.match(js, /classList\.remove\('mz-map-open'\)/, 'the body class outlives the map and hides STANDBY for good');
  assert.match(css, /body\.mz-map-open \.pause/, 'no rule keeps the STANDBY overlay off the open map');
});

/* ------------------------------------------------------------------ */
/* The pinch                                                           */
/* ------------------------------------------------------------------ */

/**
 * ── WHAT THESE PROVE, AND WHAT THEY DO NOT ────────────────────────────────
 *
 * `MazeMap.js` starts with `import './maze-map.css'`, which Node cannot load,
 * so nothing in this repository can construct the class under `node --test`.
 * Every gate in this file is therefore a source gate, and these are too: they
 * pin WHICH CALL IS MADE IN WHICH METHOD, and they cannot tell you the map
 * zooms.
 *
 * THE BROWSER IS WHERE THAT WAS ESTABLISHED, and it was measured rather than
 * eyeballed: the real `MazeMap` built by `scripts/harness/hud-viewport.js`,
 * driven at 390x844 with a coarse pointer by `Input.dispatchTouchEvent` over
 * CDP - two real touch points, not synthesised `PointerEvent`s.
 *
 *     two fingers 40 px apart, spread to 380 px   zoom 1     -> 10
 *     two fingers 360 px apart, closed to 40 px   zoom 10    -> 1.11
 *     one finger, tapped on a floorplan           level all  -> level 1
 *
 * The third line is the one that is easy to lose: a pinch must not end as a
 * click on a pane, and a tap after a pinch must still page. Re-run it against
 * `window.__harness.panels.mazeMap` if any of this changes.
 */
test('a second finger starts a pinch instead of a second pan', async () => {
  const down = await mazeMapMethod('_onDown(e) {', '_span() {');
  assert.match(down, /this\._pointers\.set\(e\.pointerId/,
    '_onDown no longer tracks the pointer - a pinch needs two at once and no event carries both');
  assert.match(down, /this\._pointers\.size === 2/,
    'nothing notices the second finger, so a phone has no way to zoom this map at all');
  const two = down.slice(down.indexOf('this._pointers.size === 2'));
  assert.match(two, /this\._drag = null/,
    'the pan keeps running through the pinch - the first finger would move the sheet twice');
  assert.match(two, /this\._pinch = this\._span\(\)/,
    'the pinch never records the span it started at, so there is no ratio to zoom by');
});

test('the pinch zooms about where the fingers were, and pans by where they went', async () => {
  const move = await mazeMapMethod('_onMove(e) {', '_onUp(e) {');
  assert.match(move, /this\._pinch && this\._pointers\.size === 2/,
    '_onMove no longer has a pinch branch');
  const pinch = move.slice(move.indexOf('this._pinch && this._pointers.size === 2'));
  assert.match(pinch, /_zoomAbout\(this\._pinch\.x, this\._pinch\.y, now\.d \/ this\._pinch\.d\)/,
    'the pinch does not zoom about the OLD midpoint by the span ratio - anchoring on the new '
    + 'midpoint is a frame late and walks the sheet out from under the fingers');
  assert.match(pinch, /this\._panX \+= now\.x - this\._pinch\.x/,
    'two fingers travelling together no longer pan, so a pinch fights the drag it is part of');
  assert.match(pinch, /this\._clampNow\(\)/, 'the pinch can push the sheet outside the grid');

  /* And the single-finger pan still exists below it. */
  assert.match(move, /if \(!this\._drag\) return;/,
    'the one-finger pan branch went with the pinch');
});

test('coming out of a pinch does not page the map to a floor', async () => {
  /* MEASURED as the third line of the browser run above. `_onUp` doubles as
   * the click hit-test: without the flag, lifting the second finger inside the
   * 5 px slop and 500 ms hold reads as a tap on whatever pane it was over, and
   * the map pages to a floor the player never asked for at the end of every
   * zoom. */
  const up = await mazeMapMethod('_onUp(e) {', 'dispose() {');
  assert.match(up, /this\._pointers\.delete\(e\.pointerId\)/,
    '_onUp no longer forgets the pointer - the next single finger down is half a pinch for ever');
  assert.match(up, /pinched: true/,
    'the finger left over from a pinch is not marked, so the pinch ends as a click on a floorplan');
  assert.match(up, /press\.pinched/,
    'the click hit-test does not check the pinch flag, so the mark above does nothing');
  /* One finger left of two keeps panning, from where that finger IS. */
  assert.match(up, /const rest = \[\.\.\.this\._pointers\.values\(\)\]\[0\]/,
    'lifting one of two fingers drops the pan entirely instead of continuing from the other');
});

test('a cancelled pointer is forgotten, or the next tap is half a pinch', async () => {
  /* A finger that leaves the panel, a palm rejected as a gesture, a call
   * arriving mid-drag: `pointercancel` and no `pointerup`. That pointer would
   * sit in the set for ever, and the NEXT single finger down would be the
   * second half of a pinch that nobody started. */
  const src = await readFile(path.join(root, 'src/ui/MazeMap.js'), 'utf8');
  assert.match(src, /addEventListener\('pointercancel', this\._onUp\)/,
    'nothing listens for pointercancel, so a lost finger is remembered for ever');
  assert.match(src, /removeEventListener\('pointercancel', this\._onUp\)/,
    'the pointercancel listener outlives the panel');
  /* Escape can close the map with two fingers still on the glass. */
  const close = await mazeMapMethod('close() {', '_centreOnPlayer() {');
  assert.match(close, /this\._pointers\.clear\(\)/,
    'closing mid-gesture leaves the pointers behind - the map reopens already pinching');
});

test('the canvas keeps touch-action: none, or the browser takes the gesture', async () => {
  /* Without it the browser claims a two-finger drag for page zoom and a
   * one-finger drag for scrolling, and neither ever reaches this panel. It
   * predates the pinch and is now load-bearing for it. */
  const css = await readFile(path.join(root, 'src/ui/maze-map.css'), 'utf8');
  const rule = css.slice(css.indexOf('.mz-map-canvas {'), css.indexOf('}', css.indexOf('.mz-map-canvas {')));
  assert.match(rule, /touch-action:\s*none/,
    'the map canvas no longer claims its own gestures - the browser eats the pinch');
});
