import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { rig, goto } from './_flightrig.mjs';

const { Charters, CHARTER_RANKS, CHARTER_DEEDS, reputationOf } =
  await import('../../src/systems/Charters.js');
const { Viewpoints } = await import('../../src/systems/Viewpoints.js');
const { WorldManager } = await import('../../src/worlds/WorldManager.js');
const { EventBus } = await import('../../src/core/EventBus.js');
const { StationWorld } = await import('../../src/worlds/StationWorld.js');
const { MedievalWorld } = await import('../../src/worlds/MedievalWorld.js');
const { SportsWorld } = await import('../../src/worlds/SportsWorld.js');
const { CitadelWorld } = await import('../../src/worlds/CitadelWorld.js');
const { RaceWorld } = await import('../../src/worlds/RaceWorld.js');
const { MazeWorld } = await import('../../src/worlds/MazeWorld.js');
const { DockWorld } = await import('../../src/worlds/DockWorld.js');
const { SpaceWorld } = await import('../../src/worlds/SpaceWorld.js');
const { worldClasses } = await import('../../src/worlds/planets/index.js');

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

/**
 * CHART THE NEXUS.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THESE CASES ARE FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The charter spine's one genuinely dangerous property is that it is made
 * ENTIRELY of denominators it did not author. Every count on the board comes
 * from a world publishing something, or from another system's identity set,
 * and both of those move. So the failures this file exists to catch are:
 *
 *   1. A DENOMINATOR THAT WAS WRITTEN DOWN. If the number of viewpoints in the
 *      yard is a constant in `Charters.js`, the file is a second copy of
 *      `DockWorld` and it will be wrong the day the yard grows a sixth mast.
 *      Every denominator case below re-derives its expectation from the REAL
 *      built world, never from the system under test.
 *
 *   2. THE 0/0 CHARTER. A record with no columns in it is `0 of 0`, which is
 *      complete under any naive comparison - so a player who has never left
 *      the station would have charted seventeen worlds by standing still. This
 *      is the exact shape of `Viewpoints._onWorld`'s `list.length > 0` guard
 *      and `SpaceObjectives`' `wingTotal > 0` guard, and it gets a case here
 *      because it is the one bug that would make the whole objective a lie.
 *
 *   3. A GHOST DENOMINATOR. `SpaceObjectives` keeps its wing roster GROW-ONLY
 *      and pays its set prize against the LIVE world instead, precisely because
 *      a zone deleted from `SpaceWorld` would otherwise leave a total nobody
 *      can reach. A charter cannot use that trick - it has to display a world
 *      it is not standing in - so it takes the other half of the deal: the live
 *      world REPLACES its own roster. There is a case that shrinks a world and
 *      insists the roster shrinks with it.
 *
 *   4. A DEED WITH NO EMITTER. Deeds are the one authored column, and the
 *      lesson `quest-vocab.mjs` was built out of ("0 of 50 quests were
 *      completable") is that an authored objective whose event nothing fires is
 *      dead on arrival. Every deed's event is scraped out of `src/`.
 */

/* ====================================================================== */
/* Helpers                                                                */
/* ====================================================================== */

/** A registry with every world the game registers, and nothing built. */
function registry() {
  const wm = new WorldManager({ bus: new EventBus() });
  wm.register(StationWorld).register(MedievalWorld).register(SportsWorld)
    .register(CitadelWorld).register(RaceWorld).register(MazeWorld)
    .register(DockWorld).register(SpaceWorld);
  for (const C of worldClasses()) wm.register(C);
  return wm;
}

/* ====================================================================== */
/* 1. The denominators come from the worlds, not from this file           */
/* ====================================================================== */

test("the yard's record counts the viewpoints the yard actually publishes", async () => {
  const r = await rig();
  const bus = r.bus;
  const viewpoints = new Viewpoints({ bus, worldManager: r.wm });
  const charters = new Charters({
    bus, worldManager: r.wm, viewpoints, mining: r.mining,
  });

  /* The REAL activation, so the roster is learned by exactly the path a player
   * walking through the blast door takes. Nothing is hand-emitted. */
  await goto(r, 'dock');
  const dock = r.wm.active;

  const published = dock.viewpoints.length;
  assert.ok(published > 0, 'the yard publishes no viewpoints - the rig has broken');

  const rec = charters.record('dock');
  const col = rec.columns.find((c) => c.key === 'viewpoints');
  assert.ok(col, 'the yard record has no viewpoint column');
  assert.equal(col.need, published);
  assert.equal(col.have, 0);
  charters.dispose();
  viewpoints.dispose();
});

test("a planet's record counts the seams the planet actually publishes", async () => {
  const r = await rig();
  const bus = r.bus;
  const charters = new Charters({ bus, worldManager: r.wm, mining: r.mining });

  await goto(r, 'cinder');
  const cinder = r.wm.active;

  const seams = cinder.mineralNodes.length;
  assert.ok(seams > 0, 'Cinder publishes no mineral nodes - the rig has broken');

  const col = charters.record('cinder').columns.find((c) => c.key === 'seams');
  assert.ok(col, "Cinder's record has no seam column");
  assert.equal(col.need, seams);
  charters.dispose();
});

test('cutting a real seam moves the numerator and nothing else', async () => {
  const r = await rig();
  const bus = r.bus;
  const charters = new Charters({ bus, worldManager: r.wm, mining: r.mining });
  /* Out and back, because the rig is shared and `activate` on the world that
   * is already live is a no-op - so a charter constructed after the previous
   * case's arrival would never see the `world:changed` that teaches it. */
  await goto(r, 'dock');
  await goto(r, 'cinder');
  const cinder = r.wm.active;

  const before = charters.record('cinder').columns.find((c) => c.key === 'seams');

  /* The REAL mining system, over the REAL node list, through the same `mine`
   * the E key reaches - which refuses before it consumes and only records once
   * `Piloting.stow` has taken the rock. A Dray, because the hold is the loop
   * and a Kestrel's fills after five. Nothing is written into a ledger by hand. */
  r.piloting.board('dray', { silent: true });
  r.piloting._cargo = Object.create(null);
  r.piloting._cargoUnits = 0;
  const node = cinder.mineralNodes.find((n) => !r.mining._taken.has(`cinder/${n.id}`));
  assert.ok(node, 'every seam on Cinder is already cut - the rig has broken');
  const out = r.mining.mine(node);
  assert.equal(out.ok, true, `the real cut refused: ${out.reason}`);

  const after = charters.record('cinder').columns.find((c) => c.key === 'seams');
  assert.equal(after.have, before.have + 1);
  assert.equal(after.need, before.need, 'cutting a seam changed the denominator');
  charters.dispose();
});

/* ====================================================================== */
/* 2. The 0/0 charter                                                     */
/* ====================================================================== */

test('a world nobody has visited is not chartered', () => {
  const bus = new EventBus();
  const wm = registry();
  const charters = new Charters({ bus, worldManager: wm });

  for (const id of wm.ids) {
    const rec = charters.record(id);
    assert.equal(rec.complete, false, `${id} charted itself with nothing in it`);
    assert.equal(charters.isChartered(id), false);
  }
  assert.equal(charters.charteredCount, 0);
  charters.dispose();
});

test('a record with no columns is never complete, however it is asked', () => {
  const bus = new EventBus();
  const wm = registry();
  const charters = new Charters({ bus, worldManager: wm });
  /* Vellum Ridge publishes circuits, relics and nothing else this rig has
   * built, so with no world:changed its roster is empty - `0 of 0`. */
  const rec = charters.record('race');
  assert.equal(rec.need, 0);
  assert.equal(rec.known, false);
  assert.equal(rec.complete, false);
  charters.dispose();
});

/* ====================================================================== */
/* 3. A shrinking world shrinks its roster                                */
/* ====================================================================== */

test('a world that loses content loses the denominator with it', async () => {
  const r = await rig();
  const bus = r.bus;
  const charters = new Charters({ bus, worldManager: r.wm, mining: r.mining });
  await goto(r, 'dock');
  await goto(r, 'cinder');
  const cinder = r.wm.active;
  const full = charters.record('cinder').columns.find((c) => c.key === 'seams').need;

  /* The ghost case, run the only way it can be run: hand the live world a
   * shorter list and re-enter it. A grow-only roster leaves `full` standing
   * and the charter can never be completed again. */
  const kept = cinder.mineralNodes;
  try {
    cinder.mineralNodes = kept.slice(0, 3);
    bus.emit('world:changed', { id: 'cinder', world: cinder });
    const now = charters.record('cinder').columns.find((c) => c.key === 'seams').need;
    assert.equal(now, 3);
    assert.ok(full > 3, 'the fixture did not actually shrink anything');
  } finally {
    cinder.mineralNodes = kept;
    bus.emit('world:changed', { id: 'cinder', world: cinder });
  }
  charters.dispose();
});

/* ====================================================================== */
/* 4. Deeds have emitters                                                 */
/* ====================================================================== */

test('every deed names an event something in src/ actually emits', () => {
  const emitted = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const src = readFileSync(p, 'utf8');
      for (const m of src.matchAll(/emit\??\.?\(\s*'([a-z][\w:-]*)'/g)) emitted.add(m[1]);
    }
  };
  walk(join(root, 'src'));
  assert.ok(emitted.size > 50, 'the emit scrape found almost nothing - it has broken');

  const deeds = Object.entries(CHARTER_DEEDS);
  assert.ok(deeds.length > 0, 'no deeds are declared');
  for (const [worldId, rows] of deeds) {
    for (const deed of rows) {
      assert.ok(
        emitted.has(deed.event),
        `deed ${worldId}/${deed.id} waits on "${deed.event}", which nothing in src/ emits`
      );
    }
  }
});

test('a deed is credited by the event the game already fires', () => {
  const bus = new EventBus();
  const wm = registry();
  const charters = new Charters({ bus, worldManager: wm });

  const before = charters.record('maze');
  const col = before.columns.find((c) => c.key === 'deeds');
  assert.ok(col, 'the Coil has no deed column');
  assert.equal(col.have, 0);
  assert.equal(col.need, 1);

  bus.emit('world:changed', { id: 'maze', world: { id: 'maze' } });
  bus.emit('maze:centre-found', { amount: 100 });

  const after = charters.record('maze').columns.find((c) => c.key === 'deeds');
  assert.equal(after.have, 1);
  assert.equal(charters.isChartered('maze'), true,
    "the Coil's only column filled and no charter was restored");
  charters.dispose();
});

test('a deed only counts in the world it belongs to', () => {
  const bus = new EventBus();
  const wm = registry();
  const charters = new Charters({ bus, worldManager: wm });

  /* The station's deeds are a first trade, a first mount and a first gateway.
   * A trade made in the citadel market is not the station's first trade. */
  bus.emit('world:changed', { id: 'citadel', world: { id: 'citadel' } });
  bus.emit('market:trade', { kind: 'buy' });
  assert.equal(charters.record('station').columns.find((c) => c.key === 'deeds').have, 0);

  bus.emit('world:changed', { id: 'station', world: { id: 'station' } });
  bus.emit('market:trade', { kind: 'buy' });
  assert.equal(charters.record('station').columns.find((c) => c.key === 'deeds').have, 1);
  charters.dispose();
});

/* ====================================================================== */
/* 5. Rank is derived, never accumulated                                  */
/* ====================================================================== */

test('rank is a pure function of the charters held', () => {
  const bus = new EventBus();
  const wm = registry();
  const charters = new Charters({ bus, worldManager: wm });

  assert.equal(charters.rank, CHARTER_RANKS[0].title);

  /* Restore a charter the only way the system allows - by satisfying the
   * record - then read the rank back. A rank that could be set directly would
   * be a rank that can be farmed. */
  assert.equal(typeof charters.charterRank, 'number');
  const first = charters.charterRank;
  bus.emit('world:changed', { id: 'maze', world: { id: 'maze' } });
  bus.emit('maze:centre-found', { amount: 100 });
  assert.equal(charters.charteredCount, 1);
  assert.ok(charters.charterRank >= first);

  /* And it goes back down when the ledger does, which is what "derived"
   * means: a load that takes progress away takes the rank with it. */
  charters.deserialize({ rosters: {}, charters: [], deeds: [] });
  assert.equal(charters.charteredCount, 0);
  assert.equal(charters.rank, CHARTER_RANKS[0].title);
  charters.dispose();
});

test('the top rank needs every registered world and no more', () => {
  const wm = registry();
  const top = CHARTER_RANKS[CHARTER_RANKS.length - 1];
  assert.equal(Math.round(top.fraction * wm.ids.length), wm.ids.length,
    'the top rank is not "every world" - it is either unreachable or free');
  for (let i = 1; i < CHARTER_RANKS.length; i++) {
    assert.ok(CHARTER_RANKS[i].fraction > CHARTER_RANKS[i - 1].fraction,
      'the rank ladder does not ascend');
  }
});

/* ====================================================================== */
/* 6. Persistence is identity, and a load can take progress away          */
/* ====================================================================== */

test('the save carries identities and no numerator', () => {
  const bus = new EventBus();
  const wm = registry();
  const charters = new Charters({ bus, worldManager: wm });
  bus.emit('world:changed', { id: 'maze', world: { id: 'maze' } });
  bus.emit('maze:centre-found', { amount: 100 });

  const snap = charters.serialize();
  assert.ok(Array.isArray(snap.charters), 'charters is not a set');
  assert.deepEqual(snap.charters, ['maze']);
  assert.ok(Array.isArray(snap.deeds), 'deeds is not a set');
  assert.deepEqual(snap.deeds, ['maze/centre']);
  /* Nothing anywhere in the payload is a count of things the player has done:
   * every numerator is recomputed from the systems that own the identity. */
  const flat = JSON.stringify(snap);
  assert.ok(!/"have"/.test(flat) && !/"found"/.test(flat), 'a numerator was persisted');
  charters.dispose();
});

test('a restore replaces rather than merges', () => {
  const bus = new EventBus();
  const wm = registry();
  const charters = new Charters({ bus, worldManager: wm });
  bus.emit('world:changed', { id: 'maze', world: { id: 'maze' } });
  bus.emit('maze:centre-found', { amount: 100 });
  assert.equal(charters.isChartered('maze'), true);

  /* Load a save written before any of that. A merging restore keeps the
   * charter - the player holding progress the save does not contain, which is
   * the rule `MountManager`, `Relics` and `Viewpoints` all write down. */
  assert.equal(charters.deserialize({ rosters: {}, charters: [], deeds: [] }), true);
  assert.equal(charters.isChartered('maze'), false);
  assert.equal(charters.record('maze').columns.find((c) => c.key === 'deeds').have, 0);
  charters.dispose();
});

test('a restored charter is clamped against the record that earned it', () => {
  const bus = new EventBus();
  const wm = registry();
  const charters = new Charters({ bus, worldManager: wm });
  /* A payload claiming the Coil and the Citadel are charted, with no deed and
   * no roster in it. Believing either would mean a hand-edited localStorage
   * entry mints charter rank, which is the one thing
   * `SpaceObjectives.deserialize` clamps its four receipts against.
   *
   * The CITADEL is the case that matters and the reason this is not the Coil
   * alone: an unvisited world's record is UNKNOWN, and `_settle` deliberately
   * refuses to revoke a charter for an unknown record - otherwise a reload
   * before going back would delete the objective. So nothing downstream can
   * catch a forged citadel charter, and the clamp in `deserialize` is the ONLY
   * thing standing between a text editor and the top rank. Asserted with the
   * Coil alone this case passed with the clamp deleted. */
  charters.deserialize({ rosters: {}, charters: ['maze', 'citadel'], deeds: [] });
  assert.equal(charters.isChartered('maze'), false);
  assert.equal(charters.isChartered('citadel'), false);
  assert.equal(charters.charteredCount, 0);
  charters.dispose();
});

/* ====================================================================== */
/* 7. Reputation and the objective line                                   */
/* ====================================================================== */

test('reputation is the record expressed as a standing', () => {
  assert.equal(reputationOf(0, 0), null, 'a world with no record has no standing');
  assert.notEqual(reputationOf(0, 4), reputationOf(4, 4));
  assert.equal(reputationOf(4, 4), reputationOf(9, 9),
    'standing depends on the fraction, not the size');
});

test('the objective always names something to do', () => {
  const bus = new EventBus();
  const wm = registry();
  const charters = new Charters({ bus, worldManager: wm });
  const p = charters.progress();
  assert.equal(p.total, wm.ids.length);
  assert.equal(p.chartered, 0);
  assert.equal(typeof p.hint, 'string');
  assert.ok(p.hint.length > 0, 'a first-run player is told nothing');
  charters.dispose();
});
