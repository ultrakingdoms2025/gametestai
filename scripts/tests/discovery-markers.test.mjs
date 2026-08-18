import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * THE MAP FINALLY SHOWS THE COLLECTIBLES.
 *
 * ── The defect ────────────────────────────────────────────────────────────
 * `Minimap` was constructed with `{portals, caches, contracts}` and nothing
 * else. Thirty relics per world - the only finite, never-restocking collectible
 * in the game, worth 3,600 CR in the citadel alone - had no marker of any kind
 * anywhere, and five named viewpoints had no marker either. The map drew the
 * cache that restocks every few minutes and not the thing that never comes
 * back.
 *
 * ── Why the relic layer is GATED and the viewpoint layer is not ───────────
 * A viewpoint is a hundred-foot tower visible from the far side of the world;
 * hiding its marker would not be mystery, it would be the map disagreeing with
 * the window. A relic is hidden by placement - that is the whole mechanic in
 * `Relics.js`'s header - so plotting all thirty on the first frame would delete
 * it. The gate is `Viewpoints.reveals(x, z)`: climb a tower, open its district.
 *
 * ── How this is measured ──────────────────────────────────────────────────
 * The REAL `Minimap.update`, driven against a recording 2D context. Each of the
 * three new marks paints in a colour used nowhere else in the file, so counting
 * `fill()` calls by `fillStyle` counts marks - which is the only way to tell a
 * marker that is drawn from one that is merely computed and then clipped away.
 */

/* ---------------------------------------------------------------------- */
/* A recording canvas                                                      */
/* ---------------------------------------------------------------------- */

class FakePath2D {
  moveTo() {} lineTo() {} closePath() {} arc() {} rect() {}
}

/** Every call the map makes, with the fill colour in force at the time. */
function recorder() {
  const fills = [];
  const strokes = [];
  const ctx = {
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1,
    shadowColor: '', shadowBlur: 0, imageSmoothingEnabled: true, font: '', textAlign: '',
    _stack: [],
    save() { this._stack.push([this.fillStyle, this.strokeStyle, this.globalAlpha]); },
    restore() { const s = this._stack.pop(); if (s) [this.fillStyle, this.strokeStyle, this.globalAlpha] = s; },
    clearRect() {}, fillRect() {}, strokeRect() {}, clip() {}, beginPath() {},
    moveTo() {}, lineTo() {}, closePath() {}, arc() {}, quadraticCurveTo() {}, rect() {},
    translate() {}, rotate() {}, scale() {}, setTransform() {}, transform() {},
    drawImage() {}, fillText() {}, measureText: () => ({ width: 4 }),
    setLineDash() {}, ellipse() {},
    fill() { fills.push(String(this.fillStyle)); },
    stroke() { strokes.push(String(this.strokeStyle)); },
    createRadialGradient: () => ({ addColorStop() {} }),
    createLinearGradient: () => ({ addColorStop() {} }),
  };
  return { ctx, fills, strokes };
}

/** Colours used exactly once each in `Minimap.js` - see the header. */
const RELIC = '#ffd08a';
const VP_SYNCED = '#8affd0';
const VP_UNSYNCED = '#cfe4ff';

let Minimap;
{
  globalThis.Path2D = FakePath2D;
  globalThis.window = globalThis.window ?? { devicePixelRatio: 1 };
  globalThis.devicePixelRatio = 1;
  ({ Minimap } = await import('../../src/ui/Minimap.js'));
}

function makeMap({ relics = null, viewpoints = null } = {}) {
  const rec = recorder();
  const canvas = { width: 0, height: 0, style: {}, getContext: () => rec.ctx };
  const map = new Minimap({
    canvas,
    player: { position: { x: 0, y: 0, z: 0 }, yaw: 0 },
    worldManager: { active: null },
    npcManager: { npcs: [] },
    portals: { portals: [] },
    relics,
    viewpoints,
  });
  return { map, rec };
}

/** Everything the relic layer needs: positions, in world XZ. */
const relicsAt = (...pts) => ({ markers: pts.map(([x, z]) => ({ x, y: 20, z })) });

/** A viewpoints double with the two members `Minimap` is allowed to touch. */
function viewpointsWith(list, revealFn) {
  return { list, reveals: revealFn ?? (() => true) };
}

/* ====================================================================== */

test('relic markers are drawn at all - they were not before', () => {
  const { map, rec } = makeMap({ relics: relicsAt([4, 4], [-6, 3], [2, -8]) });
  map.update(1 / 60, 0);
  assert.equal(rec.fills.filter((c) => c === RELIC).length, 3,
    'the map drew no relic marks for three relics in range');
});

test('a relic outside a revealed district is not drawn', () => {
  /* The gate. Mutation that kills this: drop the `reveals` call from the relic
   * loop in `Minimap.update`. */
  const relics = relicsAt([4, 4], [-6, 3], [2, -8]);
  const { map, rec } = makeMap({
    relics,
    viewpoints: viewpointsWith([], (x) => x > 0),
  });
  map.update(1 / 60, 0);
  // Only the two with x > 0 pass the predicate.
  assert.equal(rec.fills.filter((c) => c === RELIC).length, 2,
    'the reveal gate is not consulted before plotting a relic');
});

test('a world with no viewpoints system draws every relic', () => {
  // Three of five worlds have relics and nothing to reveal them with.
  const { map, rec } = makeMap({ relics: relicsAt([4, 4], [-6, 3]) });
  map.update(1 / 60, 0);
  assert.equal(rec.fills.filter((c) => c === RELIC).length, 2);
});

test('an already-collected relic leaves no marker behind', () => {
  /* `Relics.markers` only ever lists what is still out there. A marker over a
   * relic that has been picked up is a marker with nothing under it, which is
   * worse than no marker at all. */
  const { map, rec } = makeMap({ relics: { markers: [] } });
  map.update(1 / 60, 0);
  assert.equal(rec.fills.filter((c) => c === RELIC).length, 0);
});

test('a synchronised viewpoint reads differently from one still to climb', () => {
  const list = [
    { id: 'a', x: 5, y: 60, z: 5, synced: false },
    { id: 'b', x: -5, y: 40, z: -5, synced: true },
  ];
  const { map, rec } = makeMap({ viewpoints: viewpointsWith(list) });
  map.update(1 / 60, 0);

  // Filled diamond for the one that is done, hollow outline for the one that
  // is not: the two states must not draw the same mark.
  assert.equal(rec.fills.filter((c) => c === VP_SYNCED).length, 1,
    'a synchronised viewpoint is not drawn filled');
  assert.equal(rec.strokes.filter((c) => c === VP_UNSYNCED).length >= 1, true,
    'an unclimbed viewpoint is not drawn as an outline');
  assert.equal(rec.fills.filter((c) => c === VP_UNSYNCED).length, 0,
    'an unclimbed viewpoint is drawn filled, so it reads as already done');
});

test('viewpoints are drawn even when nothing has been revealed yet', () => {
  /* The opposite call from the relics, and deliberately: an unclimbed tower is
   * the thing the reveal is EARNED with, so a map that hid it would hide the
   * only route out of the initial state. */
  const list = [{ id: 'a', x: 5, y: 60, z: 5, synced: false }];
  const { map, rec } = makeMap({
    relics: relicsAt([4, 4]),
    viewpoints: viewpointsWith(list, () => false),
  });
  map.update(1 / 60, 0);
  assert.equal(rec.fills.filter((c) => c === RELIC).length, 0, 'a relic showed with nothing revealed');
  assert.equal(rec.strokes.filter((c) => c === VP_UNSYNCED).length >= 1, true,
    'the viewpoint that would reveal the district was itself hidden');
});

test('an off-range viewpoint keeps a rim bearing; an off-range relic does not', () => {
  /* A viewpoint you cannot take a bearing on is a viewpoint you will not
   * climb. A relic is the opposite - it is something you stumble on inside a
   * district you have opened, and a rim chevron for each of thirty of them
   * would be a ring of arrows round the whole dial. */
  const far = 4000;
  const { map: m1, rec: r1 } = makeMap({
    viewpoints: viewpointsWith([{ id: 'a', x: far, y: 60, z: 0, synced: true }]),
  });
  m1.update(1 / 60, 0);
  assert.ok(r1.fills.filter((c) => c === VP_SYNCED).length >= 1,
    'an off-range viewpoint vanished from the map entirely');

  const { map: m2, rec: r2 } = makeMap({ relics: relicsAt([far, 0]) });
  m2.update(1 / 60, 0);
  assert.equal(r2.fills.filter((c) => c === RELIC).length, 0,
    'an off-range relic was pinned to the rim');
});

test('the map still works with neither system wired', () => {
  // Every other world, and every construction path that predates this.
  const { map, rec } = makeMap();
  assert.doesNotThrow(() => map.update(1 / 60, 0));
  assert.equal(rec.fills.filter((c) => c === RELIC).length, 0);
});
