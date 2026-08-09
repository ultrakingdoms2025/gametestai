import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BINDABLE } from '../../src/core/Input.js';
import { MAZE } from '../../src/worlds/maze/MazeTopology.js';
import { MazeWorld } from '../../src/worlds/MazeWorld.js';
import { makeRules, mapActionOwner } from '../../src/worlds/WorldRules.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('the map action is bindable, so a contextual key can still be rebound', () => {
  const entry = BINDABLE.find((b) => b.action === 'map');
  assert.ok(entry, 'no `map` action in BINDABLE - the key would be unrebindable');
  assert.equal(entry.code, 'KeyM');
});

test('exactly one owner of the map key per world, and it follows rules.mounts', () => {
  assert.equal(mapActionOwner({ rules: makeRules() }), 'mounts');
  assert.equal(mapActionOwner({ rules: makeRules({ mounts: false }) }), 'map');
});

test('a world with no rules at all still gets exactly one owner', () => {
  // Never both, never neither - that is the whole point of one predicate.
  for (const w of [null, undefined, {}, { rules: null }]) {
    assert.ok(['map', 'mounts'].includes(mapActionOwner(w)), `no owner for ${JSON.stringify(w)}`);
  }
});

test('the maze forbids mounts, so the maze is where the map owns M', () => {
  // Ties the contextual behaviour to the rule that drives it, rather than to
  // a world id - if the maze ever permits mounts, this is what says so.
  const maze = { rules: makeRules({ mounts: false }) };
  assert.equal(mapActionOwner(maze), 'map');
});

test('MountWheel asks the shared predicate rather than deciding for itself', async () => {
  const src = await readFile(path.join(root, 'src/ui/MountWheel.js'), 'utf8');
  assert.ok(src.includes('mapActionOwner'),
    'MountWheel does not consult mapActionOwner - two consumers deciding independently is how a '
    + 'contextual key ends up owned by both or neither');
});

test('THE MARKER GATE: the map plots you, the collectables, the ways out and the ways up', () => {
  /* This REPLACES a test that asserted the opposite.
   *
   * The original spec was emphatic that the map must show no you-are-here
   * marker - the player was to locate themselves by matching junctions, which
   * it called the central navigational challenge. The owner reversed that, so
   * the old gate is gone rather than left passing vacuously: it grepped for
   * `player.position`, and `player?.position` slipped straight past it, which
   * is exactly how a gate ends up green while guarding nothing.
   *
   * What replaces it asserts the marker set is complete, because a legend
   * promising seven things and a map drawing four is the failure mode here. */
  const world = {
    id: 'maze',
    rules: makeRules({ mounts: false }),
    cells: new Uint8Array(MAZE.TOTAL_CELLS),
    mapMarkers: MazeWorld.prototype.mapMarkers,
    _tokens: [],
    portalSpecs: [],
    _connectorsByLevel: null,
    _centreTaken: true,
    centrePosition: null,
  };
  const m = world.mapMarkers(0);
  for (const kind of ['stair', 'lift', 'tunnel', 'token', 'portal', 'centre']) {
    assert.ok(Array.isArray(m[kind]), `mapMarkers omits "${kind}" - the legend names it, so the map must plot it`);
  }
});

test('mapMarkers only reports things on the level asked for', async () => {
  /* Standing on level 2 while reading level 0 must not plant markers in
   * corridors the player is nowhere near - the map draws one level, and a
   * marker from another is worse than no marker at all. */
  const { MazeWorld: MW } = await import('../../src/worlds/MazeWorld.js');
  const world = Object.create(MW.prototype);
  world.cells = new Uint8Array(MAZE.TOTAL_CELLS);
  world._connectorsByLevel = null;
  world._centreTaken = true;
  world.centrePosition = null;
  world.portalSpecs = [
    { position: { x: 10, y: 0, z: 10 } },
    { position: { x: 20, y: MAZE.LEVEL_HEIGHT * 2, z: 20 } },
  ];
  world._tokens = [
    { position: { x: 1, y: 0, z: 1 }, taken: false },
    { position: { x: 2, y: MAZE.LEVEL_HEIGHT * 2, z: 2 }, taken: false },
    { position: { x: 3, y: 0, z: 3 }, taken: true },
  ];
  const l0 = world.mapMarkers(0);
  assert.equal(l0.portal.length, 1, 'a portal from another level was plotted');
  assert.equal(l0.token.length, 1, 'a token from another level, or an already-taken one, was plotted');
  const l2 = world.mapMarkers(2);
  assert.equal(l2.portal.length, 1);
  assert.equal(l2.token.length, 1);
});


test('MazeMap draws from the topology array, never from geometry', async () => {
  const src = await readFile(path.join(root, 'src/ui/MazeMap.js'), 'utf8');
  assert.ok(src.includes('levelSegments'), 'MazeMap does not use levelSegments');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of [/districtColliders/, /shaftColliders/, /\.chunks\b/]) {
    assert.ok(!forbidden.test(code),
      `MazeMap.js reads ${forbidden} - geometry exists only for streamed districts, so a map drawn `
      + 'from it would be a map of wherever the player happens to be standing');
  }
});

test('rebinding the map action moves BOTH consumers, not just one', async () => {
  /* The claim the contextual key rests on. Both consumers own their own
   * keydown listener (they must keep working when Input has stopped
   * reporting), so both have to ask `codeFor` rather than hard-code KeyM. */
  for (const f of ['src/ui/MazeMap.js', 'src/ui/MountWheel.js']) {
    const src = await readFile(path.join(root, f), 'utf8');
    assert.ok(/codeFor\?\.\('map'\)|codeFor\('map'\)/.test(src),
      `${f} does not resolve the map action through Input.codeFor - a rebind would move the other `
      + 'consumer and leave this one on M');
  }
});

test('M is no longer listed as an unbindable fixed key', async () => {
  // It became a BINDABLE action, so the panel would otherwise show it twice
  // and claim it cannot be changed.
  const src = await readFile(path.join(root, 'src/ui/KeybindMenu.js'), 'utf8');
  assert.ok(!/key:\s*'M'/.test(src), 'KeybindMenu still lists M among FIXED_KEYS');
});

test('the map labels a connector by what is BUILT, not by what the topology chose', async () => {
  /* Most tunnel links fall back to a staircase when no fold orientation keeps
   * the maze walkable. A map that marks all of them as tunnels would send a
   * player looking for a vaulted descent and hand them a spiral - and unlike a
   * missing marker, a wrong one costs the walk back. */
  const { generateTopology, cellIndex, isOpen, DIR, connectorAt } =
    await import('../../src/worlds/maze/MazeTopology.js');
  const { tunnelOrientation } = await import('../../src/worlds/maze/MazeShafts.js');
  const { MazeWorld: MW } = await import('../../src/worlds/MazeWorld.js');

  const t = generateTopology(2026);
  const world = Object.create(MW.prototype);
  world.cells = t.cells;
  world._connectorsByLevel = null;
  world._centreTaken = true;
  world.centrePosition = null;
  world.portalSpecs = [];
  world._tokens = [];

  const marked = world.mapMarkers(0).tunnel.length;
  let real = 0;
  for (let z = 0; z < MAZE.CELLS; z++) {
    for (let x = 0; x < MAZE.CELLS; x++) {
      if (!isOpen(t.cells, cellIndex(x, z, 0), DIR.UP)) continue;
      if (connectorAt(t.cells, x, z, 0) !== 'tunnel') continue;
      if (tunnelOrientation(t.cells, x, z, 0)) real++;
    }
  }
  assert.equal(marked, real,
    `the map marks ${marked} tunnels on level 0 but only ${real} are built - the rest are staircases`);
});

test('the Ctrl+M solution path is a real adjacent-cell route to the centre', async () => {
  /* The cheat has to be a route the player could actually walk. A path with a
   * jump in it would send them at a hedge and read as the map lying. */
  const { generateTopology, cellIndex, isOpen, cellCoords } =
    await import('../../src/worlds/maze/MazeTopology.js');
  const { MazeWorld: MW } = await import('../../src/worlds/MazeWorld.js');

  const t = generateTopology(2026);
  const world = Object.create(MW.prototype);
  world.cells = t.cells;
  world.centreCell = t.centreCell;
  world._solution = null;
  world._solutionFrom = -1;

  const e = cellCoords(t.entranceCell);
  const from = { x: e.x * MAZE.CELL, y: e.level * MAZE.LEVEL_HEIGHT, z: e.z * MAZE.CELL };
  const path = world.solutionPath(from);
  assert.ok(path.length > 10, `solution path is only ${path.length} steps`);

  const c = cellCoords(t.centreCell);
  const last = path[path.length - 1];
  assert.equal(last.level, c.level, 'the path does not end on the centre level');
  assert.ok(Math.abs(last.x - c.x * MAZE.CELL) < 1e-6 && Math.abs(last.z - c.z * MAZE.CELL) < 1e-6,
    'the path does not end at the centre');

  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const dx = Math.abs(a.x - b.x) / MAZE.CELL;
    const dz = Math.abs(a.z - b.z) / MAZE.CELL;
    const dl = Math.abs(a.level - b.level);
    assert.ok(dx + dz + dl === 1,
      `path step ${i} moves dx=${dx} dz=${dz} dlevel=${dl} - not a single cell`);
  }
});

test('the solution path re-solves when the player moves, not once per seed', async () => {
  /* Cached against the player's own cell. Cached against the seed alone it
   * would keep drawing a route from wherever they first pressed Ctrl+M. */
  const { generateTopology, cellCoords } = await import('../../src/worlds/maze/MazeTopology.js');
  const { MazeWorld: MW } = await import('../../src/worlds/MazeWorld.js');
  const t = generateTopology(7);
  const world = Object.create(MW.prototype);
  world.cells = t.cells;
  world.centreCell = t.centreCell;
  world._solution = null;
  world._solutionFrom = -1;

  const e = cellCoords(t.entranceCell);
  const a = world.solutionPath({ x: e.x * MAZE.CELL, y: 0, z: e.z * MAZE.CELL });
  const b = world.solutionPath({ x: (e.x + 6) * MAZE.CELL, y: 0, z: e.z * MAZE.CELL });
  assert.notEqual(a.length, b.length, 'the path did not change when the player moved six cells');
});

test('the map closes itself when the world stops being a maze', async () => {
  /* Observed: the map was open, the player left for the station, and the panel
   * stayed up drawing the maze it had baked - over a world it did not belong
   * to, eating clicks, and with no maze left for the map key to toggle. `_draw`
   * returned early on a missing world instead of standing down. */
  const src = await readFile(path.join(root, 'src/ui/MazeMap.js'), 'utf8');
  const from = src.indexOf('  _draw() {');
  assert.ok(from > 0, 'no _draw to check');
  const body = src.slice(from, src.indexOf('\n  }\n', from));
  assert.ok(/if \(!w\) \{[^}]*this\.close\(\)/.test(body),
    '_draw does not close the map when there is no maze world to draw');
  assert.ok(body.indexOf('this._open') < body.indexOf('_mazeWorld()'),
    'the open check must come first, or every frame in every other world looks for a maze');
});
