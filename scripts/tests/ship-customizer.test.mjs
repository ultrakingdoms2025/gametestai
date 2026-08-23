import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SHIP_ORDER, SHIP_CLASSES, SHIP_TINTS, SHIP_SLOTS, SHIP_STATS, SHIP_STAT_META,
  SHIP_BASE_STATS, SHIP_SKINS, SHIP_SKINS_BY_ID, KNOWN_SHIP_SKIN_IDS,
  shipSkinsFor, shipSkinItemId, holdCapacity,
} from '../../src/ships/ShipStats.js';
import { Ship, MAX_TIER } from '../../src/ships/Ship.js';
import { ShipRegistry } from '../../src/ships/ShipRegistry.js';
import { REFIT_SOURCE, SHIP_PALETTES, shipStatLine, schemeState, SCHEME_STATE_LABEL } from '../../src/ui/ShipMenuLogic.js';
import { MOUNT_STATS, FINISH_PROPS, applyLivery, cloneLivery } from '../../src/mounts/Livery.js';
import { HULLS, WALKABLE } from '../../src/worlds/dock/HullPlan.js';
import { KILL_TIERS, ORE_TIERS, WING_SET_POWER } from '../../src/systems/SpaceObjectives.js';
import { PLANETS } from '../../src/worlds/planets/index.js';
import { holdUnitsFor } from '../../src/worlds/planets/PlanetDescriptor.js';

/**
 * THE SHIP CUSTOMISER, WITHOUT A RENDERER.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THIS FILE IS FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `mounts/Livery.js` imports nothing from three specifically so the catalogue
 * test can read `MOUNT_STATS` without a renderer, and `ShipStats.js` is written
 * to the same rule. Every failure below is silent at runtime and permanent:
 *
 * - A `defaultColor` missing from its own palette opens the panel with the
 *   CUSTOM PICKER lit instead of a swatch, for every player of that hull, for
 *   ever (`mount-menu.test.mjs:15-28` is the mount half of this).
 * - A ship id in `MOUNT_STATS` makes a `grant_mount_power` catalogue row for a
 *   SHIP pass validation, which is exactly what `mount-catalog.test.mjs:32-41`
 *   uses that table as the authority for.
 * - A scheme naming a slot its hull does not sell is dropped by `_knownSlot`
 *   without a word, so the card lights, the paint does not go on, and the
 *   player is told it did.
 * - A powers bag that loses every stat to `deserialize`'s filter and persists
 *   as `{}` is a save that grows an empty object per hull per load.
 */

/* ================================================================== */
/* The ladder is the ship's, and the mount's is untouched              */
/* ================================================================== */

test('MOUNT_STATS has not been widened with a single ship id', () => {
  /* THE ONE THAT MATTERS MOST, and it is a one-line mistake to make.
   * `mount-catalog.test.mjs` validates every `grant_mount_power` row in the
   * marketplace against `MOUNT_STATS`, so a ship id in there does not add a
   * ship to the mount table — it removes the check from every mount-power row
   * that names a ship, silently. */
  const mounts = Object.keys(MOUNT_STATS);
  assert.equal(mounts.length, 6, `MOUNT_STATS has ${mounts.length} entries and the game has six mounts`);
  for (const id of Object.keys(SHIP_CLASSES)) {
    assert.ok(!mounts.includes(id), `'${id}' has been added to MOUNT_STATS; it belongs in SHIP_STATS`);
  }
  // ...and the ship table does not carry a mount either.
  for (const id of mounts) {
    assert.ok(!(id in SHIP_STATS), `mount '${id}' has appeared in SHIP_STATS`);
  }
});

test('every fitted hull sells slots and stats, and the hulk sells neither', () => {
  for (const id of WALKABLE) {
    assert.ok(SHIP_SLOTS[id]?.length >= 4, `${id} sells ${SHIP_SLOTS[id]?.length ?? 0} livery slots`);
    assert.ok(SHIP_STATS[id]?.length === 4, `${id} sells ${SHIP_STATS[id]?.length ?? 0} stats`);
    assert.ok(SHIP_BASE_STATS[id], `${id} publishes no base bias, so every hull starts identical`);
  }
  /* DECLARED AND EMPTY, not absent — and the difference is the whole defect.
   *
   * These two lines used to read `assert.ok(!SHIP_SLOTS.bastion)`, i.e. they
   * asserted the tables were MISSING. `ShipRegistry._knownSlot`/`_knownStat`
   * treat a missing table as "this hull is mid-migration, accept everything",
   * so what those assertions actually pinned was the opposite of their own
   * message: every slot and every stat was known for the hulk, `setLivery` and
   * `grantPower` merged, stored, emitted and persisted them, and nothing
   * applied them because `_ships` has no Bastion. A test that could not fail
   * while stating the thing it was there to protect. */
  assert.deepEqual(SHIP_SLOTS.bastion, [],
    'the Bastion must DECLARE an empty slot table; absent means "accept every slot"');
  assert.deepEqual(SHIP_STATS.bastion, [],
    'the Bastion must DECLARE an empty stat table; absent means "sell every stat"');
  assert.deepEqual([...SHIP_ORDER], [...WALKABLE],
    'the menu order and the walkable set have drifted apart');
});

test('the hulls differ in more than colour', () => {
  /* The design rule for this world, asserted rather than asserted-to-have-been-
   * intended: silhouette, interior programme, stat bias and slot palette. Two
   * hulls with the same bias are the same ship in a different livery, which is
   * the thing the four spec boards in the yard exist to make legible. */
  const seen = new Map();
  for (const id of WALKABLE) {
    const bias = SHIP_STATS[id].map((s) => SHIP_BASE_STATS[id][s]).join('/');
    assert.ok(!seen.has(bias), `${id} and ${seen.get(bias)} have the same stat bias ${bias}`);
    seen.set(bias, id);
    // ...and the fifth slot is the thing that hull is FOR.
    const accent = SHIP_SLOTS[id].find((s) => s.id === 'accent');
    assert.ok(accent && accent.label, `${id} has no hull-specific slot`);
  }
  const labels = new Set(WALKABLE.map((id) => SHIP_SLOTS[id].find((s) => s.id === 'accent').label));
  assert.equal(labels.size, WALKABLE.length, `only ${labels.size} distinct fifth-slot labels across ${WALKABLE.length} hulls`);
  // Lengths and interior programmes differ too.
  const lens = new Set(WALKABLE.map((id) => SHIP_CLASSES[id].length));
  assert.equal(lens.size, WALKABLE.length, 'two fitted hulls are the same length');
  const rooms = new Set(WALKABLE.map((id) => HULLS[id].rooms.map((r) => r.id).sort().join(',')));
  assert.equal(rooms.size, WALKABLE.length, 'two fitted hulls have the same interior programme');
});

/* ================================================================== */
/* Palettes                                                            */
/* ================================================================== */

test('every slot default colour is a member of its own palette', () => {
  /* The ship copy of `mount-menu.test.mjs:15-28`. A factory colour missing from
   * its own palette opens the panel with the custom picker lit instead of a
   * swatch, for every player of that hull. */
  for (const [id, slots] of Object.entries(SHIP_SLOTS)) {
    for (const s of slots) {
      const hex = `#${s.defaultColor.toString(16).padStart(6, '0')}`;
      assert.ok(SHIP_PALETTES[s.palette],
        `${id}.${s.id} names palette '${s.palette}' and there is no such palette`);
      assert.ok(SHIP_PALETTES[s.palette].includes(s.defaultColor),
        `${id}.${s.id}: default colour ${hex} is not in palette '${s.palette}'`);
    }
  }
  for (const k of Object.keys(SHIP_PALETTES)) {
    assert.ok(SHIP_PALETTES[k].length >= 6, `palette '${k}' has only ${SHIP_PALETTES[k].length} swatches`);
    assert.equal(new Set(SHIP_PALETTES[k]).size, SHIP_PALETTES[k].length,
      `palette '${k}' has a duplicate swatch, so two buttons light together`);
  }
});

test('the slot defaults ARE the tints the hull is built with', () => {
  /* The identity that makes the factory-swatch no-op correct. `SHIP_TINTS` is
   * handed to `ShipKit.shipMaterials` as the clones' real `.color`, and on an
   * ORM-mapped material `.color` is a white MULTIPLIER over the albedo map — so
   * writing a swatch that is not the recorded factory value multiplies the map
   * by itself and the part visibly darkens. `MountMenu.js:189` guards it with
   * `c === slot.defaultColor`, and that guard is only correct while these two
   * tables agree. */
  const KEY = { hull: 'hull', trim: 'trim', canopy: 'glass', thruster: 'glow', accent: 'accent' };
  for (const [id, slots] of Object.entries(SHIP_SLOTS)) {
    for (const s of slots) {
      assert.equal(s.defaultColor, SHIP_TINTS[id][KEY[s.id]],
        `${id}.${s.id}: the panel draws ${s.defaultColor.toString(16)} as factory and the hull is built ${SHIP_TINTS[id][KEY[s.id]].toString(16)}`);
    }
  }
});

/* ================================================================== */
/* Schemes                                                             */
/* ================================================================== */

test('every scheme paints slots its own hull actually sells', () => {
  /* `ShipRegistry._knownSlot` drops a slot the hull does not declare, silently
   * and by design (an intermediate commit that adds a hull before its tables
   * has to keep working). The cost of that tolerance is that a typo in a scheme
   * is invisible: the card lights, the paint does not go on, and nothing says
   * so. This is the thing that makes it visible. */
  for (const s of SHIP_SKINS) {
    assert.ok(SHIP_CLASSES[s.ship], `scheme ${s.id} names hull '${s.ship}', which does not exist`);
    const slots = SHIP_SLOTS[s.ship];
    assert.ok(slots, `scheme ${s.id} is for '${s.ship}', which sells no slots at all`);
    const names = slots.map((x) => x.id);
    for (const slot of Object.keys(s.livery)) {
      assert.ok(names.includes(slot), `scheme ${s.id} paints '${slot}' and the ${s.ship} has no such slot`);
      const v = s.livery[slot];
      assert.equal(typeof v.color, 'number', `scheme ${s.id}.${slot} has no colour`);
      if (v.finish) {
        assert.ok(FINISH_PROPS[v.finish], `scheme ${s.id}.${slot} asks for finish '${v.finish}'`);
        const decl = slots.find((x) => x.id === slot);
        assert.ok(decl.finish, `scheme ${s.id} sets a finish on '${slot}', which does not take one`);
      }
    }
    assert.ok(Object.keys(s.livery).length >= 2, `scheme ${s.id} changes only one slot`);
  }
});

test('scheme ids are unique, known, and evenly spread across the hulls', () => {
  assert.equal(new Set(SHIP_SKINS.map((s) => s.id)).size, SHIP_SKINS.length, 'a scheme id is used twice');
  assert.equal(SHIP_SKINS_BY_ID.size, SHIP_SKINS.length);
  assert.equal(KNOWN_SHIP_SKIN_IDS.size, SHIP_SKINS.length);
  for (const s of SHIP_SKINS) {
    assert.ok(KNOWN_SHIP_SKIN_IDS.has(s.id));
    // The bag-item id a purchasable version WOULD carry. Stable from day one so
    // wiring the purchase path later adds rows and changes no data.
    assert.equal(shipSkinItemId(s.id), `shipskin_${s.id}`);
  }
  for (const id of WALKABLE) {
    assert.ok(shipSkinsFor(id).length >= 3, `${id} has only ${shipSkinsFor(id).length} schemes`);
  }
  assert.equal(shipSkinsFor('bastion').length, 0, 'the hulk has schemes and no slots to paint them onto');
});

test('schemeState: applied when the hull is already wearing it', () => {
  const scheme = SHIP_SKINS.find((s) => s.id === 'pike_redflight');
  assert.equal(schemeState({ scheme, livery: {} }), 'available');
  assert.equal(schemeState({ scheme, livery: cloneLivery(scheme.livery) }), 'applied');
  // One slot off is not "applied": a card that lights on a partial match tells
  // the player they are wearing something they are not.
  const partial = cloneLivery(scheme.livery);
  delete partial.trim;
  assert.equal(schemeState({ scheme, livery: partial }), 'available');
  assert.deepEqual(Object.keys(SCHEME_STATE_LABEL).sort(), ['applied', 'available']);
});

/* ================================================================== */
/* The stat ladder                                                     */
/* ================================================================== */

test('shipStatLine names the bias as well as the purchase', () => {
  // Untouched: the stock hull, not "not upgraded".
  assert.match(shipStatLine('kestrel', 'power', 0), /^Stock thrust — /);
  assert.equal(shipStatLine('kestrel', 'power', 2), '+24% top speed');
  assert.equal(shipStatLine('pike', 'fire', 3), '+45% laser damage');
  // The hold is the one stat with an effect in this drop, so it reads as a
  // capacity rather than as a percentage of nothing.
  assert.equal(shipStatLine('dray', 'hold', 0), '40 m3 of hold');
  assert.equal(shipStatLine('dray', 'hold', 2), '60 m3 of hold (+50% over stock)');
  assert.equal(shipStatLine('pike', 'hold', 0), 'No hold at all — that is what an interceptor is');
  assert.equal(shipStatLine('kestrel', 'nonsense', 1), '');
});

/**
 * WHERE A STOCK STAT SAYS IT COMES FROM HAS TO BE SOMEWHERE THAT GRANTS IT.
 *
 * The line used to read "Stock thrust — upgrade at the Fitting Shop", and no
 * Fitting Shop has ever sold a ship stat: `SpaceObjectives._refit` is the only
 * caller of `ShipRegistry.grantPower` in `src/`, and `Marketplace` grants
 * MOUNT powers off `this.mounts`, not ship ones. The panel sent the player to
 * a counter that could not serve them, for the only progression the campaign
 * has.
 *
 * So the claim under test is not the wording, it is that every stat the panel
 * describes as earnable IS earned by a rung that exists - and that no stat is
 * left with nothing to point at. Both directions, derived from the ladders
 * rather than from a list kept here.
 */
test('every ship refit the panel names is a rung that actually grants it', () => {
  const granted = new Set([
    ...KILL_TIERS.map((t) => t.power).filter(Boolean),
    ...ORE_TIERS.map((t) => t.power).filter(Boolean),
    WING_SET_POWER,
    // `_checkSurveySet` refits thrust; the constant is inline there.
    'power',
  ]);

  for (const stat of Object.keys(SHIP_STAT_META)) {
    if (stat === 'hold') continue;   // reads as a capacity, never as a source
    assert.ok(REFIT_SOURCE[stat],
      `the panel has no source line for "${stat}", so a stock ${stat} says nothing`);
    assert.ok(granted.has(stat),
      `the panel promises "${stat}" is earnable and no ladder rung grants it`);
  }
  for (const stat of Object.keys(REFIT_SOURCE)) {
    assert.ok(granted.has(stat),
      `REFIT_SOURCE names "${stat}" and no rung grants it - the copy is a promise ` +
      'the game does not keep, which is the defect this case exists for');
  }

  /* And the two rungs named in the copy by NAME are still those rungs. A
   * ladder that renames or re-hangs a prize has to update the sentence the
   * player reads, and this is what makes that a red test rather than a lie. */
  const fireRung = KILL_TIERS.find((t) => t.power === 'fire');
  assert.ok(REFIT_SOURCE.fire.includes(fireRung.title),
    `the panel says firepower comes from "${REFIT_SOURCE.fire}" and the rung is ` +
    `"${fireRung.title}"`);
  assert.ok(REFIT_SOURCE.fire.includes(String(fireRung.kills)),
    'the panel quotes the wrong kill count for the firepower refit');

  const holdRung = ORE_TIERS.find((t) => t.power === 'hold');
  assert.ok(REFIT_SOURCE.hold.includes(holdRung.title),
    `the panel says the hold refit comes from "${REFIT_SOURCE.hold}" and the rung is ` +
    `"${holdRung.title}"`);
  /* Digits only: the copy is written for a player and says "2,000 CR". A
   * comparison that could not see through a thousands separator would force
   * the sentence to be less readable than the game deserves. */
  assert.ok(REFIT_SOURCE.hold.replace(/[^0-9]/g, '').includes(String(holdRung.credits)),
    `the panel says "${REFIT_SOURCE.hold}" and the hold rung is ${holdRung.credits} CR`);
});

/**
 * THE HOLD REFIT ARRIVES WHILE THERE IS STILL SOMETHING TO PUT IN IT.
 *
 * It used to sit on Seamwright at 5,000 CR, which one free Dray load clears
 * outright - and that same load lifts every rare node on the planet. The prize
 * for filling a hold was paid on the trip that emptied the field.
 *
 * Measured here from the DESCRIPTOR, not quoted: a richest-first load is an
 * upper bound on any real route, so if even the greedy load cannot reach the
 * hold rung in one trip from a free hull, no route can.
 */
test('the hold refit is not paid on the trip that strips the planet', () => {
  const kinds = [];
  for (const m of PLANETS.cinder.minerals) {
    const units = holdUnitsFor(m.size);
    kinds.push({ units, credits: m.unitValue * units, count: m.count, rarity: m.rarity });
  }
  kinds.sort((a, b) => (b.credits / b.units) - (a.credits / a.units));

  const bestLoad = (cap) => {
    let left = cap, cr = 0;
    for (const k of kinds) {
      for (let i = 0; i < k.count && left >= k.units; i++) { left -= k.units; cr += k.credits; }
    }
    return cr;
  };

  /* Exactly ONE rung, found by search rather than by index. Two rungs both
   * granting the refit would make the second one a no-op (`grantPower` takes
   * a Math.max) and would let a `find` walk past the one that actually
   * matters - which is precisely how a mutation of this file first survived. */
  const holdRungs = ORE_TIERS.filter((t) => t.power === 'hold');
  assert.equal(holdRungs.length, 1,
    `${holdRungs.length} ore rungs grant the hold refit: `
    + `${holdRungs.map((t) => t.title).join(', ') || 'none'}`);
  const holdRung = holdRungs[0];
  const kestrel = bestLoad(holdCapacity('kestrel'));
  const dray = bestLoad(holdCapacity('dray'));
  const rare = kinds.filter((k) => k.rarity === 'rare' || k.rarity === 'exotic')
    .reduce((sum, k) => sum + k.credits * k.count, 0);

  /* THE CEILING, and it is the one that catches the real defect.
   *
   * A stock Kestrel is the hull that most needs a bigger hold, and it is the
   * hull the player starts in. A hold refit is only a decision if it can be
   * earned WHILE flying that hull - which means inside one of its loads. Past
   * that, the cheapest way to the refit is to walk away from the Kestrel and
   * take the free 40 m3 Dray, and the prize for filling a hold is paid to
   * somebody who no longer needs it.
   *
   * This is the assertion that reddens if the refit goes back on Seamwright
   * (5,000): a stock Kestrel lifts 2,980 CR at absolute best. */
  assert.ok(holdRung.credits <= kestrel,
    `the hold refit is paid at ${holdRung.credits} CR and the best single load a stock ` +
    `Kestrel can lift is ${kestrel} CR. The refit for carrying more cannot be earned ` +
    'by the hull that needs it, so the answer is always "go and get the free Dray".');

  /* THE FLOOR: not so early that it is a prize for taking off. Half a
   * Kestrel load - at 500 CR (Prospector) the refit would land on the first
   * trip anybody makes, before hold size has ever been a constraint. */
  assert.ok(holdRung.credits >= kestrel * 0.4,
    `the hold refit at ${holdRung.credits} CR is under 40% of one stock-Kestrel load ` +
    `(${kestrel}) - nobody has felt a full hold yet`);

  /* ACHIEVED, reported so the next person to move a rung can see the shape of
   * the window rather than re-deriving it. Both bounds are measured off the
   * descriptor in this run; neither is written down anywhere. */
  assert.ok(dray > kestrel,
    `a Dray lifts ${dray} and a Kestrel ${kestrel} - the two hulls are not distinguishable ` +
    'by hold, so this whole case is measuring nothing');

  /* And the rare supply is still in the ground: 21 m3 of it, worth `rare`,
   * which one Dray trip takes in a single pass. */
  assert.ok(holdRung.credits < rare * 0.75,
    `the hold refit is paid at ${holdRung.credits} CR against ${rare} CR of rare ore ` +
    'on the whole planet - the extra capacity arrives after the value is gone');
});

test('holdCapacity is the bias plus the tiers, and the Pike has none', () => {
  assert.equal(holdCapacity('dray', 0), 40);
  assert.equal(holdCapacity('kestrel', 0), 10);
  assert.equal(holdCapacity('pike', 0), 0);
  assert.equal(holdCapacity('pike', 3), 30);
  assert.equal(holdCapacity('nobody', 2), 20);
  assert.equal(holdCapacity('dray', -5), 40, 'a negative tier subtracts hold');
});

test('Ship.applyPowers writes multipliers now, for a flight model that does not exist yet', () => {
  /* `Dragon.js:2470-2475`: the dragon's `applyPowers` hook did not exist for a
   * while, so tiers were banked, persisted, re-emitted and applied to nothing.
   * Every number below is computed in this drop even though the six-degree
   * model that reads them is the next one. */
  const kestrel = new Ship({ id: 'kestrel', displayName: 'Kestrel', slotMats: {} });
  const dray = new Ship({ id: 'dray', displayName: 'Dray', slotMats: {} });
  kestrel.applyPowers({});
  dray.applyPowers({});
  const stockK = kestrel.snapshot().powerMul;
  const stockD = dray.snapshot().powerMul;
  assert.ok(stockK > stockD, 'a stock Dray is as fast as a stock Kestrel');

  /* The strongest form of the claim, and the one that fixes the constant: a
   * FULLY upgraded Dray must still not beat a stock Kestrel. At the 0.10 per
   * bias point first written, two tiers were enough to overturn it and the
   * three hulls became each other in a different colour. */
  dray.applyPowers({ power: MAX_TIER });
  const maxD = dray.snapshot().powerMul;
  assert.ok(maxD <= stockK,
    `floor: a ${MAX_TIER}-tier Dray (${maxD.toFixed(3)}) stays at or under a stock Kestrel `
    + `(${stockK.toFixed(3)}) - the bias is what makes the hulls different and an upgrade must not erase it`);
  assert.ok(maxD > stockD * 1.3, `${MAX_TIER} tiers buy the Dray only ${((maxD / stockD - 1) * 100).toFixed(0)}%`);

  // Acceleration tracks thrust, and is its own field because the moment the
  // flight model wants them apart, which one it scales decides whether
  // acceleration leaks into top speed.
  assert.equal(dray.snapshot().accelMul, dray.snapshot().powerMul);

  dray.applyPowers({ shield: 2, fire: 1, hold: 1 });
  const s = dray.snapshot();
  assert.equal(s.shieldTier, SHIP_BASE_STATS.dray.shield + 2);
  assert.equal(s.fireTier, SHIP_BASE_STATS.dray.fire + 1);
  assert.equal(s.holdCapacity, holdCapacity('dray', 1));
  // Rubbish in a bag is floored to zero rather than propagated as NaN.
  dray.applyPowers({ power: 'x', shield: null, fire: undefined, hold: -3 });
  const t = dray.snapshot();
  assert.ok(Number.isFinite(t.powerMul) && Number.isFinite(t.holdCapacity));
  assert.deepEqual(t.tiers, { power: 0, shield: 0, fire: 0, hold: 0 });
});

/* ================================================================== */
/* The registry                                                        */
/* ================================================================== */

function harnessRegistry(ids = ['kestrel', 'dray', 'pike']) {
  const events = [];
  const bus = {
    on: () => () => {},
    emit: (name, payload) => events.push({ name, payload }),
  };
  const ships = ids.map((id) => new Ship({ id, displayName: SHIP_CLASSES[id].name, slotMats: {} }));
  const worldManager = { current: { ships } };
  return { reg: new ShipRegistry({ bus, worldManager }), events, ships, worldManager };
}

test('the registry arms off a published field and nothing else', () => {
  /* Exactly as `Relics`, `Caches`, `Viewpoints` and `MinigameManager` do: it
   * reads `world.ships`, and no world knows this class exists. A world with no
   * hulls simply has none, which is what makes the Esc-hub row gate correctly
   * in the other five worlds. */
  const { reg } = harnessRegistry();
  assert.equal(reg.hulls().length, 3);
  assert.ok(reg.canCustomise);
  assert.equal(reg.selectedId, 'kestrel', 'the panel does not open on the first hull in menu order');

  const empty = new ShipRegistry({ bus: null, worldManager: { current: {} } });
  assert.equal(empty.hulls().length, 0);
  assert.equal(empty.canCustomise, false);
  assert.equal(empty.selected, null);
  const none = new ShipRegistry({});
  assert.equal(none.canCustomise, false);
});

test('a livery survives the world being rebuilt under it', () => {
  /* A portal round trip disposes the hulls and builds new ones. If the registry
   * did not re-apply on adopt, every hull would silently repaint itself back to
   * factory on the way home, and the player would have paid for paint that
   * lasts until they use a door. */
  const { reg, worldManager } = harnessRegistry();
  reg.setLivery('dray', { hull: { color: 0x14181f, finish: 'matt' } });
  const fresh = ['kestrel', 'dray', 'pike'].map((id) => new Ship({ id, displayName: id, slotMats: {} }));
  let applied = null;
  fresh[1].applyCustomization = (l) => { applied = l; };
  worldManager.current = { ships: fresh };
  reg._adopt();
  assert.deepEqual(applied, { hull: { color: 0x14181f, finish: 'matt' } });
});

test('setLivery drops what the hull does not sell, and never emits for nothing', () => {
  const { reg, events } = harnessRegistry();
  const count = () => events.filter((e) => e.name === 'ship:livery').length;

  reg.setLivery('kestrel', { nosuchslot: { color: 0x112233 } });
  assert.deepEqual(reg.getLivery('kestrel'), {}, 'an unknown slot was stored');
  assert.equal(count(), 0, 'an unknown slot emitted a livery change');

  reg.setLivery('kestrel', { hull: { color: 0x2c2f36 } });
  assert.equal(count(), 1);
  // The same patch again changes nothing: no emit, so no persist per frame
  // while a colour picker is being dragged.
  reg.setLivery('kestrel', { hull: { color: 0x2c2f36 } });
  assert.equal(count(), 1, 'a redundant patch emitted a livery change');
  // Rubbish is not a change either.
  reg.setLivery('kestrel', { hull: { color: 'not a colour' } });
  reg.setLivery('kestrel', {});
  reg.setLivery('kestrel', { hull: null });
  assert.equal(count(), 1);

  // Clearing the last slot deletes the whole entry rather than leaving `{}`.
  reg.setLivery('kestrel', { hull: { finish: null } });
  assert.deepEqual(reg.getLivery('kestrel'), { hull: { color: 0x2c2f36 } });
  reg.resetLivery('kestrel');
  assert.deepEqual(reg.getLivery('kestrel'), {});
  assert.deepEqual(reg.serialize().liveries, {}, 'a reset hull persists as an empty bag');
  // A reset on a hull that had nothing is a no-op with no emit.
  const before = count();
  reg.resetLivery('kestrel');
  assert.equal(count(), before);
});

test('grantPower refuses a stat the hull does not sell, and sellsPower says so first', () => {
  /* The public twin exists so the marketplace can REFUSE rather than take the
   * money and drop the grant on the floor — `MountManager.sellsPower` is there
   * for the same reason. */
  const { reg } = harnessRegistry();
  assert.equal(reg.sellsPower('kestrel', 'power'), true);
  assert.equal(reg.sellsPower('kestrel', 'strength'), false);
  assert.equal(reg.sellsPower('nosuchship', 'anything'), true,
    'a hull with no declared stats must accept everything, or an intermediate commit stops working');

  reg.grantPower('kestrel', 'strength', 3);
  assert.deepEqual(reg.getPowers('kestrel'), {}, 'a stat the hull does not sell was banked');
  reg.grantPower('kestrel', 'power', 2);
  reg.grantPower('kestrel', 'power', 1);
  assert.deepEqual(reg.getPowers('kestrel'), { power: 2 }, 'a lower tier overwrote a higher one');
});

test('the hulk takes no paint and no credits, and does not persist either', () => {
  /* THE DEFECT, MEASURED IN THE LIVE YARD BEFORE THE FIX.
   *
   * `SHIP_SLOTS`/`SHIP_STATS` had no `bastion` entry at all, and a hull with no
   * table is treated as mid-migration and accepts everything. The Bastion is
   * not mid-migration — she is a hulk with her frames open and `_ships` never
   * holds her, so `applyCustomization` and `applyPowers` are never reached. The
   * result, driven in the browser:
   *
   *   reg.setLivery('bastion', { hull: { color: '#ff00ff' } })
   *     -> serialize().liveries === { bastion: { hull: { color: 16711935 } } }
   *     -> the Bastion's five material colours unchanged, byte for byte
   *   reg.sellsPower('bastion', 'power') === true
   *     -> the marketplace would sell a refit for a hull that cannot fit one
   *
   * Both halves are asserted here rather than only the table shape, because
   * the table shape is what the old assertion checked and it checked it
   * backwards. `nosuchship` keeps the mid-migration escape hatch proven in the
   * same breath, so this cannot be "fixed" by deleting that behaviour. */
  const { reg, events } = harnessRegistry();
  const liveries = () => events.filter((e) => e.name === 'ship:livery').length;

  reg.setLivery('bastion', { hull: { color: 0xff00ff }, trim: { color: 0x00ff00 } });
  assert.deepEqual(reg.getLivery('bastion'), {}, 'the hulk stored a livery nothing can apply');
  assert.equal(liveries(), 0, 'painting the hulk emitted ship:livery');
  assert.deepEqual(reg.serialize().liveries, {}, 'the hulk wrote a livery into the save');

  assert.equal(reg.sellsPower('bastion', 'power'), false, 'the marketplace would sell the hulk a refit');
  reg.grantPower('bastion', 'power', 3);
  assert.deepEqual(reg.getPowers('bastion'), {}, 'the hulk banked an upgrade tier');
  assert.deepEqual(reg.serialize().powers, {}, 'the hulk wrote a power tier into the save');

  // A save that already carries one is filtered on the way back in.
  reg.deserialize({ liveries: { bastion: { hull: { color: 0xff00ff } } }, powers: { bastion: { power: 2 } } });
  assert.deepEqual(reg.getLivery('bastion'), {}, 'a stale hulk livery survived deserialize');
  assert.deepEqual(reg.getPowers('bastion'), {}, 'a stale hulk power tier survived deserialize');

  // ...and the mid-migration escape hatch is still open for a hull with no table.
  assert.equal(reg.sellsPower('nosuchship', 'power'), true);
});

test('applyScheme refuses before it paints', () => {
  /* `MountSkins.js:26-28`'s ordering rule: refuse BEFORE anything is consumed,
   * because a purchase must never be consumed with nowhere for it to land.
   * Nothing is consumed here yet, and the order is kept anyway so the day a bag
   * item is wired in the refusal is already in the right place. */
  const { reg } = harnessRegistry();
  assert.deepEqual(reg.applyScheme('kestrel', 'nope'), { ok: false, reason: 'unknown-scheme' });
  assert.deepEqual(reg.applyScheme('kestrel', 'pike_redflight'), { ok: false, reason: 'wrong-ship' });
  assert.deepEqual(reg.getLivery('kestrel'), {}, 'a refused scheme still painted the hull');

  const scheme = SHIP_SKINS_BY_ID.get('kestrel_nightmail');
  assert.deepEqual(reg.applyScheme('kestrel', 'kestrel_nightmail'), { ok: true });
  assert.equal(schemeState({ scheme, livery: reg.getLivery('kestrel') }), 'applied');

  const away = new ShipRegistry({ worldManager: { current: { ships: [] } } });
  assert.deepEqual(away.applyScheme('kestrel', 'kestrel_nightmail'), { ok: false, reason: 'not-here' });
});

test('select points the panel at a hull that is actually here', () => {
  const { reg, events } = harnessRegistry();
  assert.equal(reg.select('dray'), true);
  assert.equal(reg.selectedId, 'dray');
  assert.equal(reg.select('dray'), false, 'reselecting the same hull emitted a change');
  assert.equal(reg.select('bastion'), false, 'selected a hulk that is not in world.ships');
  assert.equal(reg.select(null), false);
  assert.equal(events.filter((e) => e.name === 'ship:selected').length, 1);
});

test('a save round trip keeps what was bought and invents nothing', () => {
  const { reg } = harnessRegistry();
  reg.setLivery('pike', { hull: { color: 0xd9dde2, finish: 'matt' }, trim: { color: 0x0d0f12 } });
  reg.grantPower('pike', 'fire', 2);
  reg.grantPower('dray', 'hold', 3);
  reg.select('pike');
  const snap = JSON.parse(JSON.stringify(reg.serialize()));

  const { reg: fresh } = harnessRegistry();
  fresh.deserialize(snap);
  assert.deepEqual(fresh.getLivery('pike'), reg.getLivery('pike'));
  assert.deepEqual(fresh.getPowers('pike'), { fire: 2 });
  assert.deepEqual(fresh.getPowers('dray'), { hold: 3 });
  assert.equal(fresh.selectedId, 'pike');

  // A save cannot smuggle in a slot or a stat the hull never sold...
  const { reg: guard } = harnessRegistry();
  guard.deserialize({
    liveries: { kestrel: { nosuchslot: { color: 0x112233 } } },
    powers: { kestrel: { strength: 3 } },
    selected: 'bastion',
  });
  assert.deepEqual(guard.getLivery('kestrel'), {});
  /* ...and a bag that loses every stat to the filter must NOT persist as an
   * empty {}: `grantPower` never creates one, so a round trip must not either. */
  assert.deepEqual(guard.serialize().powers, {});
  assert.equal(guard.selectedId, 'kestrel', 'a save selected a hull this world does not have');

  guard.deserialize(null);
  guard.deserialize({});
  assert.deepEqual(guard.serialize().liveries, {});
});

test('applyLivery is imported from the mount code and writes uniforms only', () => {
  /* The reuse verdict, asserted rather than described: five of `Livery.js`'s
   * seven exports take `(livery, slots, slotMats)` and contain no reference to
   * the word "mount", so the ship code imports them as they are. What has to
   * stay true is the two things that make them safe: `needsUpdate` is never
   * raised (a mid-frame program link is the exact stall the station work spent
   * weeks removing) and the factory look is snapshotted so clearing a slot
   * restores the RECORDED multipliers rather than a guessed number. */
  const mat = {
    color: { _v: 0xbcc6d2, getHex() { return this._v; }, setHex(v) { this._v = v; }, clone() { return { ...this }; }, lerp() {} },
    roughness: 0.5,
    metalness: 0.58,
    envMapIntensity: 1.35,
    needsUpdate: true,
    userData: {},
  };
  const slots = SHIP_SLOTS.kestrel;
  applyLivery({ hull: { color: 0x2c2f36, finish: 'matt' } }, slots, { hull: [mat] });
  assert.equal(mat.color.getHex(), 0x2c2f36);
  assert.equal(mat.roughness, FINISH_PROPS.matt.roughness);
  assert.equal(mat.needsUpdate, false, 'a livery write forced a shader recompile');
  assert.equal(mat.userData.factory.roughness, 0.5, 'the factory roughness was not snapshotted');

  // Clearing restores the RECORDED value, not 1.0 and not a guess.
  applyLivery({}, slots, { hull: [mat] });
  assert.equal(mat.color.getHex(), 0xbcc6d2);
  assert.equal(mat.roughness, 0.5);
  assert.equal(mat.metalness, 0.58);
});

test('every stat the hulls sell has effect copy behind it', () => {
  const used = new Set();
  for (const id of Object.keys(SHIP_STATS)) for (const s of SHIP_STATS[id]) used.add(s);
  for (const s of used) {
    assert.ok(SHIP_STAT_META[s], `stat '${s}' is sold and has no meta - the panel would render its id`);
    assert.ok(SHIP_STAT_META[s].perTier > 0, `stat '${s}' pays nothing per tier`);
    assert.ok(SHIP_STAT_META[s].unit, `stat '${s}' has no unit, so its effect line reads "+12% undefined"`);
    assert.ok(shipStatLine('kestrel', s, 1).length > 4);
  }
  for (const s of Object.keys(SHIP_STAT_META)) {
    assert.ok(used.has(s), `SHIP_STAT_META carries '${s}' and no hull sells it`);
  }
});

/* ================================================================== */
/* The panel itself                                                    */
/* ================================================================== */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('the ship panel carries the four traps the mount panel paid for', async () => {
  /* A SOURCE test, and the precedent is `pause-menu.test.mjs`, which reads
   * `main.js` for the same reason: `ShipMenu.js` opens with
   * `import './ship-menu.css'`, which node cannot resolve, so the panel itself
   * cannot be constructed under `node --test`. That is why `MountMenu` has no
   * behavioural test either and why the interesting rules were extracted into
   * `ShipMenuLogic.js`, which is tested above.
   *
   * What is left is four lines that are each a bug somebody found in play, and
   * every one of them is silent when it goes missing:
   *
   * 1. A colour-picker write coalesced for the previous hull must be cancelled
   *    when the body is rebuilt, or it lands on the new one.
   * 2. Clicking the swatch that already IS the factory colour must do nothing:
   *    on an ORM-mapped material writing it multiplies the albedo map by itself
   *    and the part visibly DARKENS — "put it back" makes it worse.
   * 3. The livery cache is saved and restored around the sync loop, so a nested
   *    sync cannot leave it pointing at the wrong hull.
   * 4. The relock is deferred 140 ms, because browsers reject a lock that
   *    follows an Escape-driven exit too closely and the rejection surfaces as
   *    a console error mid-game.
   *
   * Trap 4 used to be spelled `canvas.requestPointerLock()` here. Phase 5 moved
   * every such call behind `Input.reengage()`, because on a touch device that
   * method does not exist and closing this panel left the player stood down
   * with the world frozen behind no card. The 140 ms deferral - which is what
   * this trap is actually about - is unchanged and still pinned below.
   */
  const src = await readFile(path.join(ROOT, 'src/ui/ShipMenu.js'), 'utf8');

  assert.match(src, /if \(this\._pendingRaf\) \{ cancelAnimationFrame\(this\._pendingRaf\); this\._pendingRaf = 0; \}/,
    'trap 1: the pending colour-picker patch is not cancelled when the hull changes');
  assert.match(src, /if \(c === slot\.defaultColor && this\._livery\(\)\[slot\.id\]\?\.color == null\) return;/,
    'trap 2: the factory-swatch no-op is missing, so "put it back" darkens the part');
  assert.match(src, /const prev = this\._liveryCache;[\s\S]{0,400}finally \{\s*this\._liveryCache = prev;/,
    'trap 3: the livery cache is not saved and restored around the sync loop');
  assert.match(src, /reengage[\s\S]{0,200}\}, 140\);/,
    'trap 4: the relock is not deferred, so an Escape-driven exit logs a rejection');

  // ...and it never raises `needsUpdate` itself, which is the stall the station
  // work spent weeks removing.
  assert.ok(!/needsUpdate/.test(src), 'the ship panel touches needsUpdate');

  /* The precondition is the ship one, not the mount one. `MountMenu` gates on
   * `mounts.mounted`; a hull is SELECTED, so this gates on there being one. */
  assert.match(src, /const ship = this\.ships\?\.selected \?\? null;/,
    'the panel does not open on the selected hull');
  /* Comments are documentation, not code - `pause-menu.test.mjs` strips them
   * for the same reason. This file's header explains the mount precondition at
   * length, and that prose must not be what the check reads. */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/\.mounted/.test(code), 'the ship panel has inherited the mount precondition');

  // Every class it writes is namespaced, so the two drawers cannot collide.
  const classes = [...src.matchAll(/el\('[a-z]+', '([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(classes.length > 10, `only ${classes.length} classed elements found - the scraper has stopped working`);
  for (const c of classes) {
    assert.ok(c.split(' ').every((x) => x.startsWith('sm-')),
      `the ship panel writes class '${c}', which is not in its own namespace`);
  }
});

test('every class the ship panel writes has a rule in its stylesheet', async () => {
  /* The half a namespace check cannot make: a correctly-namespaced class with
   * no rule behind it is an unstyled element, and an unstyled element in a
   * drawer is a row of black-on-black text nobody reports because it looks like
   * nothing at all. */
  const src = await readFile(path.join(ROOT, 'src/ui/ShipMenu.js'), 'utf8');
  const css = await readFile(path.join(ROOT, 'src/ui/ship-menu.css'), 'utf8');
  const used = new Set();
  for (const m of src.matchAll(/el\('[a-z]+', '([a-z0-9 -]+)'/g)) {
    for (const c of m[1].split(' ')) if (c) used.add(c);
  }
  /* One exemption, named and reasoned: `sm-sec-b` is the bare flow container a
   * section's contents sit in. It has no rule because it needs none - the mount
   * drawer's `mm-sec-b` has none either - and an empty rule added to satisfy a
   * test is a test satisfying itself. */
  const CONTAINERS = new Set(['sm-sec-b']);
  const missing = [...used].filter((c) => !CONTAINERS.has(c) && !new RegExp(`\\.${c}[^a-z0-9-]`).test(css));
  assert.deepEqual(missing, [],
    `${missing.length} classes the panel writes have no rule in ship-menu.css: ${missing.join(', ')}`);
  assert.ok(used.size >= 12, `only ${used.size} distinct classes - the scraper has stopped working`);
});
