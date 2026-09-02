import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PLANETS } from '../../src/worlds/planets/index.js';
import { Charters, CHARTER_COLUMNS } from '../../src/systems/Charters.js';
import { Viewpoints, SYNC_CREDITS, SYNC_ITEM, SYNC_ITEM_QTY } from '../../src/systems/Viewpoints.js';
import { SpaceObjectives, ASSAY_CREDITS } from '../../src/systems/SpaceObjectives.js';
import { world_, ALL } from './planet-walk-kit.mjs';

/**
 * WHAT A PLANET IS WORTH ON THE BOARD.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE QUESTION, AND THE ANSWER THAT ALREADY EXISTED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The brief this drop was written against asked for "survey objectives" on the
 * planets, and told me to check what exists before inventing anything. What
 * exists is most of it, and it is worth writing down where, because the honest
 * finding is that a THIRD objective system would have been a duplicate:
 *
 *   `SpaceObjectives` SURVEY   a map of body id -> 'sighted' | 'landed', which
 *                              already covers all ten planets. Paid once,
 *                              persisted by identity, thresholds flown.
 *   `SpaceObjectives` ORE      a per-ELEMENT assay chart LEARNED from
 *                              `world.mineralNodes` with a first-find bonus of
 *                              `ASSAY_CREDITS`, plus the `ORE_TIERS` career
 *                              ladder off `mining:node`.
 *   `Charters` seams           one column per planet, learned from
 *                              `world.mineralNodes.length`.
 *
 * And ONE column, which is what a planet had: `seams`. A charter is complete
 * when every column it has is full, so cutting every seam on Cinder restored
 * Cinder's charter and nothing else about the planet counted for anything.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  SO WHAT THIS DROP ADDED IS A SECOND COLUMN, AND IT ADDED NO CODE TO DO IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Charters` learns its viewpoint denominator off `viewpoints:changed`, which
 * `Viewpoints._onWorld` emits for whatever the active world published. So a
 * planet publishing `world.viewpoints` gains a `Viewpoints` column in the
 * charter, three fast-travel anchors in the pause hub, three minimap markers,
 * `SYNC_CREDITS` and three coins apiece and a set prize - with not one line
 * changed in `Charters.js`, `Viewpoints.js` or `SpaceObjectives.js`.
 *
 * That is a claim about three systems talking to each other, so it is TESTED
 * rather than asserted: everything below drives the real `Viewpoints`, the real
 * `Charters` and a real built `PlanetWorld` over a real event bus.
 */

/* ---------------------------------------------------------------------- */
/* Doubles - the bus is real semantics, everything else is a spy           */
/* ---------------------------------------------------------------------- */

function makeBus() {
  const handlers = new Map();
  const log = [];
  return {
    log,
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
      return () => handlers.get(type)?.delete(fn);
    },
    emit(type, payload) {
      log.push({ type, payload });
      for (const fn of [...(handlers.get(type) ?? [])]) fn(payload);
    },
    of(type) { return log.filter((e) => e.type === type).map((e) => e.payload); },
  };
}

/** A player whose position can be put on a viewpoint. */
function makePlayer() {
  return { position: { x: 1e6, y: 1e6, z: 1e6 }, teleport(p) { Object.assign(this.position, p); } };
}

/* ---------------------------------------------------------------------- */

test('a planet had one charter column and now has two', async () => {
  const bus = makeBus();
  const player = makePlayer();
  const credited = [];
  const bagged = [];
  const worldManager = { ids: ['planet:cinder'], displayNameOf: () => 'Cinder', active: null };
  const viewpoints = new Viewpoints({
    bus,
    player,
    economy: { add: (n, why) => credited.push([n, why]) },
    inventory: { acquire: (id, n) => bagged.push([id, n]) },
  });
  const charters = new Charters({ bus, worldManager, viewpoints });

  const { world } = await world_(PLANETS.cinder);
  bus.emit('world:changed', { id: 'planet:cinder', world });

  const rec = charters.record('planet:cinder');
  const keys = rec.columns.map((c) => c.key);
  assert.ok(keys.includes('seams'), 'the seam column is gone');
  assert.ok(keys.includes('viewpoints'),
    `Cinder's charter columns are ${JSON.stringify(keys)} - publishing viewpoints did not reach Charters`);
  const vp = rec.columns.find((c) => c.key === 'viewpoints');
  assert.equal(vp.need, world.viewpoints.length);
  assert.equal(vp.have, 0);
  assert.ok(rec.known && !rec.complete);
  console.log(`   [objectives] Cinder's charter: ${rec.columns.map((c) => `${c.label} ${c.have}/${c.need}`).join(', ')}`);

  /* And the column FILLS by standing there, through the real sync path. */
  for (const v of world.viewpoints) {
    Object.assign(player.position, { x: v.x, y: v.y, z: v.z });
    viewpoints.update(1 / 60);
  }
  assert.equal(viewpoints.syncedCount, world.viewpoints.length);
  const after = charters.record('planet:cinder');
  assert.equal(after.columns.find((c) => c.key === 'viewpoints').have, world.viewpoints.length);
  assert.equal(credited.length, world.viewpoints.length);
  assert.equal(credited[0][0], SYNC_CREDITS);
  assert.deepEqual(bagged[0], [SYNC_ITEM, SYNC_ITEM_QTY]);
  console.log(`   [objectives] three climbs paid ${credited.reduce((s, c) => s + c[0], 0)} CR and `
    + `${bagged.reduce((s, b) => s + b[1], 0)} coins, and filled the new column`);
});

test('every planet gains the column, and none of them was already complete', async () => {
  /* Ten worlds, one board. The failure this would catch is a planet whose
   * viewpoints never reach `Charters` - because the world published an empty
   * array, or because `viewpoints:changed` fired with the wrong world id, both
   * of which are silent. */
  const bus = makeBus();
  const ids = ALL.map((p) => `planet:${p.id}`);
  const worldManager = { ids, displayNameOf: (id) => id, active: null };
  const viewpoints = new Viewpoints({ bus, player: makePlayer() });
  const charters = new Charters({ bus, worldManager, viewpoints });
  for (const planet of ALL) {
    const { world } = await world_(planet);
    bus.emit('world:changed', { id: `planet:${planet.id}`, world });
  }
  for (const planet of ALL) {
    const rec = charters.record(`planet:${planet.id}`);
    const vp = rec.columns.find((c) => c.key === 'viewpoints');
    assert.ok(vp, `planet:${planet.id} has no viewpoint column`);
    assert.equal(vp.need, 3, `planet:${planet.id} learned ${vp.need} viewpoints`);
    assert.equal(vp.have, 0);
    assert.equal(rec.complete, false,
      `planet:${planet.id}'s charter is complete before anybody has been there`);
  }
  /* And the denominator went UP, which is the whole change: two columns is
   * strictly more record than one. */
  const cols = charters.record('planet:cinder').columns.length;
  assert.equal(cols, 2, `Cinder shows ${cols} columns`);
  assert.ok(CHARTER_COLUMNS.some((c) => c.key === 'viewpoints'));
});

test('the reveal is a no-op on a planet, and that is the honest reading', async () => {
  /* `Viewpoints.reveals(x, z)` gates RELIC sparks on the minimap and planets
   * publish `relics: false`, so the map reveal - one of the four things a
   * synchronisation buys in the citadel - buys nothing here. That is worth a
   * test rather than a shrug: it is the difference between "we knew" and "we
   * assumed", and if relics are ever switched on for a planet this is the line
   * that says the reveal starts mattering.
   *
   * The other three - the anchor, the prize and the set - all land, and the
   * test above proves the first two. */
  const bus = makeBus();
  const player = makePlayer();
  const viewpoints = new Viewpoints({ bus, player });
  const { world } = await world_(PLANETS.tessera);
  bus.emit('world:changed', { id: 'planet:tessera', world });
  assert.equal(world.rules.relics, false, 'a planet now has relics - the note above needs re-deriving');
  /* Before any climb the map hides everything, which is the mechanic working. */
  assert.equal(viewpoints.reveals(0, 0), false);
  const v = world.viewpoints[0];
  Object.assign(player.position, { x: v.x, y: v.y, z: v.z });
  viewpoints.update(1 / 60);
  assert.equal(viewpoints.reveals(v.x + 10, v.z + 10), true);
  assert.equal(viewpoints.anchors.length, 1);
  assert.equal(viewpoints.anchors[0].id, v.id);
});

test('the travel anchor puts a body on the ground the world measured', async () => {
  /* `travelTo` teleports to `y + 0.05`. If the published y were the descriptor's
   * continuous height rather than the collision field's, this is where that
   * error would land a player - inside a hill or 0.9 m above one, on the one
   * path in the game that moves a body without a solver step in front of it. */
  const bus = makeBus();
  const player = makePlayer();
  const viewpoints = new Viewpoints({ bus, player });
  const { world } = await world_(PLANETS.sallow);
  bus.emit('world:changed', { id: 'planet:sallow', world });
  const v = world.viewpoints.find((w) => w.id === 'pan_cone');
  Object.assign(player.position, { x: v.x, y: v.y, z: v.z });
  viewpoints.update(1 / 60);
  Object.assign(player.position, { x: 0, y: 0, z: 0 });
  assert.equal(viewpoints.travelTo(v.id), true);
  const collision = world._terrainField.sampleHeight(player.position.x, player.position.z);
  const off = player.position.y - collision;
  assert.ok(off > 0 && off < 0.1,
    `travel landed ${off.toFixed(3)} m off the collision surface at ${v.id}`);
  console.log(`   [objectives] travelTo(${v.id}) lands ${off.toFixed(3)} m over the collision field`);
});

test('SpaceObjectives already counts the planets, and the ore chart learns from the world', async () => {
  /* The part that did NOT need building, proven rather than claimed - because
   * "it already exists" is exactly the kind of statement that is worth being
   * wrong about once. */
  const bus = makeBus();
  const objectives = new SpaceObjectives({ bus });
  assert.ok(objectives.surveyTotal >= 10,
    `the survey denominator is ${objectives.surveyTotal} - it should already contain every planet`);
  const before = objectives.assayTotal;

  const { world } = await world_(PLANETS.cinder);
  bus.emit('world:changed', { id: 'planet:cinder', world });
  const learned = objectives.assayTotal - before;
  assert.equal(learned, new Set(world.mineralNodes.map((n) => n.type)).size,
    'the assay chart did not learn Cinder\'s elements off the world it was handed');
  assert.ok(learned >= 5, `only ${learned} elements learned`);
  assert.ok(ASSAY_CREDITS > 0);
  console.log(`   [objectives] SpaceObjectives: ${objectives.surveyTotal} bodies in the survey, `
    + `${learned} of Cinder's elements learned into the assay chart at ${ASSAY_CREDITS} CR a first find`);
});
