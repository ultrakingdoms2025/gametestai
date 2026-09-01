import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  SHIP_SKINS, SHIP_SKINS_BY_ID, PAID_SHIP_SKINS, KNOWN_SHIP_SKIN_IDS,
  isPaidShipSkin, shipSkinItemId, shipSkinIdFromItem, shipSkinsFor,
} from '../../src/ships/ShipStats.js';
import { Ship } from '../../src/ships/Ship.js';
import { ShipRegistry } from '../../src/ships/ShipRegistry.js';
import { applyShipSkin } from '../../src/ships/ShipSkins.js';
import { SHIP_CLASSES } from '../../src/ships/ShipStats.js';
import { Cosmetics } from '../../src/systems/Cosmetics.js';
import { Inventory } from '../../src/systems/Inventory.js';
import { ItemUseSystem } from '../../src/systems/ItemUse.js';
import {
  ITEMS, itemDef, itemIconSVG, KIND_ACCENT, sellValue, setMarketWorld, WORLD_MARKETS,
} from '../../src/systems/ItemDefs.js';
import { OFFLINE_BASE_ITEMS, offlineCatalog } from '../../src/systems/MarketplaceOffline.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  SHIP LIVERIES YOU CAN BUY, AND THE NINE YOU ALREADY HAVE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ShipStats.js` carried a long note explaining why its nine liveries were
 * painted rather than purchased: the purchase path was "files this stage does
 * not own", and "a skin card that can never be unlocked is the signature
 * defect of this project rendered as a UI element: built, visible, and
 * unreachable". This file is the other end of that sentence. Nine COMMISSIONED
 * liveries now have a bag item, a catalogue row, an offline mirror, a ledger
 * entry and a Use button, and every link in that chain is asserted below,
 * because the chain's failure mode at every single link is the same: a
 * purchase that takes credits and hands over nothing.
 *
 * ── AND THE THING THIS WORK WAS NOT ALLOWED TO DO ────────────────────────
 * The nine free schemes stayed free. Every case here that touches them checks
 * that they still apply with an empty bag and an empty wardrobe, because
 * taking away something players already have is a regression whatever the
 * catalogue gains, and it is the kind of regression that would ship green if
 * nobody wrote it down as a test.
 *
 * Written headless. `ShipStats` imports nothing, `ShipSkins` imports only it,
 * and `ShipRegistry` needs one `Ship` with an empty `slotMats` - the same rig
 * `ship-customizer.test.mjs` uses, for the same reason.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

/** The three hulls in a yard, a wardrobe, a bag, and the wires between them. */
function harness({ ids = ['kestrel', 'dray', 'pike'], bag = [] } = {}) {
  const events = [];
  const bus = { on: () => () => {}, emit: (name, payload) => events.push({ name, payload }) };
  const hulls = ids.map((id) => new Ship({ id, displayName: SHIP_CLASSES[id].name, slotMats: {} }));
  const ships = new ShipRegistry({ bus, worldManager: { active: { ships: hulls } } });
  const cosmetics = new Cosmetics({ bus });
  const inventory = new Inventory({ bus });
  for (const id of bag) inventory.acquire(id, 1);
  return { bus, events, ships, cosmetics, inventory, hulls };
}

/* ================================================================== */
/* 1. Nine items, for the nine that cost money and no others           */
/* ================================================================== */

test('one bag item per PAID livery, and not one for the nine free schemes', () => {
  /* The whole free/paid split, expressed as the presence or absence of a row
   * in `ITEMS`. A free scheme with an item would be a bag cell for a thing
   * every player already owns - a Use button whose only possible outcome is
   * "you already have this" - and a paid one WITHOUT an item is the older,
   * worse failure: a card that can be seen and never unlocked. */
  assert.equal(SHIP_SKINS.length, 18);
  assert.equal(PAID_SHIP_SKINS.length, 9);

  for (const s of SHIP_SKINS) {
    const def = itemDef(shipSkinItemId(s.id));
    if (isPaidShipSkin(s)) {
      assert.ok(def, `${s.id} costs ${s.cost} credits and has no bag item to be bought into`);
      assert.equal(def.kind, 'shipskin', `${s.id} is kind "${def.kind}" - the Use dispatch reads this`);
      assert.equal(def.stack, 1, `${s.id} stacks - two copies of one livery is not twice the paint`);
      assert.equal(def.shipSkinId, s.id);
      assert.equal(def.ship, s.ship);
      assert.ok(def.short && def.short.length <= 8, `${s.id} has no legible short badge`);
      assert.ok(def.desc.includes('Customise ship'), `${s.id} does not say where to apply it`);
    } else {
      assert.equal(def, null, `${s.id} shipped FREE and has grown a bag item`);
    }
  }

  const generated = Object.keys(ITEMS).filter((id) => ITEMS[id].kind === 'shipskin');
  assert.equal(generated.length, 9);
  assert.deepEqual(generated.sort(), PAID_SHIP_SKINS.map((s) => shipSkinItemId(s.id)).sort());
});

test('the generated items are drawn, coloured and sorted rather than falling through', () => {
  /* Three separate fall-throughs, each silent, each recorded elsewhere in the
   * repo as a shipped defect:
   *   - `ICONS.unknown` is the question mark, and an item that reaches it is
   *     invisible because a question mark still looks like art
   *     (`planet-minerals`);
   *   - a kind with no `KIND_ACCENT` paints its pickup the currency amber, a
   *     lie about what is on the floor (`Loot.js` ACCENT_PRIORITY note);
   *   - a kind with no `KIND_ORDER` rung sorts into the unknown bucket. */
  const unknown = itemIconSVG('a-key-no-renderer-will-ever-have');
  const strip = (s) => s.replace(/ig\d+/g, 'ig');
  assert.ok(KIND_ACCENT.shipskin, 'the shipskin kind has no accent colour');

  const seen = new Set();
  for (const s of PAID_SHIP_SKINS) {
    const id = shipSkinItemId(s.id);
    assert.equal(itemDef(id).icon, 'shipskin');
    const svg = itemIconSVG(id);
    assert.notEqual(strip(svg), strip(unknown), `${id} draws the question mark`);
    seen.add(strip(svg));
    // Painted from the livery's own colours, so two liveries are two icons.
    assert.ok(itemDef(id).colors.length >= 2, `${id} carries no colours for its icon`);
  }
  assert.equal(seen.size, 9, 'two liveries draw the same icon - the colours are not reaching it');

  const inv = read('src/systems/Inventory.js');
  assert.match(inv, /KIND_ORDER = \{[^}]*shipskin:/, 'Inventory.KIND_ORDER has no shipskin rung');
  assert.ok(!/KIND_ORDER\[d[ab]\?\.kind\] \?\? 9;/.test(inv),
    'the unknown sort bucket is still 9, which is now a real kind');

  const loot = read('src/systems/Loot.js');
  assert.match(loot, /ACCENT_PRIORITY = \[[^\]]*'shipskin'/,
    'Loot.ACCENT_PRIORITY has no shipskin, so a placed livery links its shader on first sight');

  /* The gate that decides whether a bought livery has a Use button at all.
   * Read out of the source rather than by constructing an `InventoryUI`, which
   * needs a DOM - the same scrape `mount-power-item.test.mjs` makes. */
  const ui = read('src/ui/InventoryUI.js');
  const hasUse = /_hasUse\(def\)\s*\{([^}]*)\}/.exec(ui);
  assert.ok(hasUse, 'InventoryUI._hasUse is not where this test expects it');
  assert.match(hasUse[1], /shipskin/,
    'InventoryUI._hasUse does not know the kind, so a bought livery has no ring and no Use button');
});

test('the id round-trips, and an id that names nothing paid comes back null', () => {
  for (const s of PAID_SHIP_SKINS) {
    assert.equal(shipSkinIdFromItem(shipSkinItemId(s.id)), s.id);
  }
  /* A FREE scheme's would-be item id parses to null, which is the guard that
   * stops a stale save or a hand-typed cheat handing `applyScheme` an id the
   * bag was never charged for. */
  for (const s of SHIP_SKINS.filter((x) => !isPaidShipSkin(x))) {
    assert.equal(shipSkinIdFromItem(shipSkinItemId(s.id)), null, `${s.id} is free and parsed as an item`);
  }
  assert.equal(shipSkinIdFromItem('shipskin_nothing_at_all'), null);
  assert.equal(shipSkinIdFromItem('skin_car_neon'), null, 'a MOUNT skin parsed as a ship livery');
  assert.equal(shipSkinIdFromItem(null), null);
  assert.equal(shipSkinIdFromItem(42), null);
});

/* ================================================================== */
/* 2. The nine free schemes are still free                             */
/* ================================================================== */

test('every free scheme applies with an empty bag and an empty wardrobe', () => {
  /* THE PROMISE. Nine schemes shipped free; nine schemes stay free. Driven
   * through `applyShipSkin` - the path both the panel and the Use button now
   * take - with nothing owned and nothing carried, which is the state of a
   * brand new save. */
  for (const scheme of SHIP_SKINS.filter((s) => !isPaidShipSkin(s))) {
    const { ships, cosmetics, inventory } = harness();
    /* A fresh `Inventory` comes with starting stock, so "nothing was taken" has
     * to be a comparison rather than an emptiness check - an assertion that the
     * bag is empty would only be testing the starter kit. */
    const before = JSON.stringify(inventory.serialize());
    const res = applyShipSkin({ ships, cosmetics, inventory }, scheme.ship, scheme.id);
    assert.deepEqual(res, { ok: true, consumed: false },
      `${scheme.id} no longer paints for nothing - a free scheme has been put behind the till`);
    // Nothing was taken, and nothing was recorded: it was never owned to begin
    // with, and a wardrobe entry for a universal scheme would be noise.
    assert.equal(JSON.stringify(inventory.serialize()), before, `${scheme.id} took something from the bag`);
    assert.equal(cosmetics.list().length, 0, `${scheme.id} wrote itself into the wardrobe`);
    // And the paint really is on the hull.
    const livery = ships.getLivery(scheme.ship);
    for (const slot of Object.keys(scheme.livery)) {
      assert.equal(livery[slot]?.color, scheme.livery[slot].color, `${scheme.id}.${slot} did not go on`);
    }
  }
});

test('a free scheme is refused for the wrong hull, and still costs nothing', () => {
  const { ships, cosmetics, inventory } = harness();
  const res = applyShipSkin({ ships, cosmetics, inventory }, 'pike', 'kestrel_courier');
  assert.deepEqual(res, { ok: false, reason: 'wrong-ship' });
  assert.deepEqual(ships.getLivery('pike'), {}, 'a refused scheme painted the hull anyway');
});

/* ================================================================== */
/* 3. Buying, wearing, and the exact cost of wearing                   */
/* ================================================================== */

test('applying a bought livery consumes exactly one and records the unlock', () => {
  const scheme = SHIP_SKINS_BY_ID.get('pike_whitecap');
  const itemId = shipSkinItemId(scheme.id);
  const { ships, cosmetics, inventory } = harness({ bag: [itemId, itemId] });
  assert.equal(inventory.totalCount(itemId), 2);

  const res = applyShipSkin({ ships, cosmetics, inventory }, 'pike', scheme.id);
  assert.deepEqual(res, { ok: true, consumed: true });
  assert.equal(inventory.totalCount(itemId), 1, 'the apply took something other than exactly one');
  assert.equal(cosmetics.has(scheme.id), true, 'the unlock was not recorded - the livery is not owned');
  assert.equal(ships.getLivery('pike').hull.color, scheme.livery.hull.color);

  /* Burned in. Re-applying is free for ever after, and the SECOND copy in the
   * bag must not be spent on it - that is the mount contract, and it is what
   * makes the purchase permanent rather than per-use. */
  ships.resetLivery('pike');
  const again = applyShipSkin({ ships, cosmetics, inventory }, 'pike', scheme.id);
  assert.deepEqual(again, { ok: true, consumed: false });
  assert.equal(inventory.totalCount(itemId), 1, 'wearing an OWNED livery spent a second copy');
});

test('a livery stowed in the store applies too, rather than reading as unowned', () => {
  /* `applyShipSkin` takes from the bag first and then the store, the order
   * `applyMountSkin` uses. A player who stowed the livery to free a bag slot
   * must not be told they do not own it. */
  const scheme = SHIP_SKINS_BY_ID.get('dray_meridian');
  const itemId = shipSkinItemId(scheme.id);
  const { ships, cosmetics, inventory } = harness();
  inventory.add(itemId, 1);
  assert.equal(inventory.bagCount(itemId), 0, 'the rig put it in the bag, so this proves nothing');
  assert.equal(inventory.totalCount(itemId), 1);

  assert.deepEqual(applyShipSkin({ ships, cosmetics, inventory }, 'dray', scheme.id),
    { ok: true, consumed: true });
  assert.equal(inventory.totalCount(itemId), 0);
});

/* ================================================================== */
/* 4. Every refusal keeps the item                                     */
/* ================================================================== */

test('a refused apply NEVER consumes: wrong hull, wrong world, no ledger, no registry', () => {
  /* The rule the whole apply path is built around, checked at each of the four
   * doors that can refuse. Every one of them runs before `consumeFromBag`, and
   * the assertion after each is the same: the livery is still in the bag. */
  const scheme = SHIP_SKINS_BY_ID.get('kestrel_kingfisher');
  const itemId = shipSkinItemId(scheme.id);

  // -- wrong hull: the livery is for the Kestrel and the panel is on the Pike.
  {
    const { ships, cosmetics, inventory } = harness({ bag: [itemId] });
    assert.deepEqual(applyShipSkin({ ships, cosmetics, inventory }, 'pike', scheme.id),
      { ok: false, reason: 'wrong-ship' });
    assert.equal(inventory.totalCount(itemId), 1, 'a wrong-hull refusal ate the livery');
    assert.equal(cosmetics.has(scheme.id), false);
    assert.deepEqual(ships.getLivery('pike'), {}, 'a wrong-hull refusal painted the Pike');
  }

  // -- not here: the right hull, in a world that has no hulls at all.
  {
    const { cosmetics, inventory } = harness({ bag: [itemId] });
    const ships = new ShipRegistry({ worldManager: { active: { ships: [] } } });
    assert.deepEqual(applyShipSkin({ ships, cosmetics, inventory }, 'kestrel', scheme.id),
      { ok: false, reason: 'not-here' });
    assert.equal(inventory.totalCount(itemId), 1, 'a not-here refusal ate the livery');
    assert.equal(cosmetics.has(scheme.id), false);
  }

  /* WRONG-SHIP AND NOT-HERE ARE DIFFERENT ANSWERS, and this is the case that
   * says so. They are different problems with different fixes - take the other
   * tab, versus fly to the yard - and collapsing them into one reason would
   * make the toast for the second one send the player looking for a panel that
   * does not open where they are standing. */
  {
    const { cosmetics, inventory } = harness({ bag: [itemId] });
    const ships = new ShipRegistry({ worldManager: { active: { ships: [] } } });
    const a = applyShipSkin({ ships, cosmetics, inventory }, 'pike', scheme.id);
    assert.equal(a.reason, 'wrong-ship',
      'the hull check no longer runs first, so a wrong-hull livery in the wrong world says "not-here"');
  }

  // -- no wardrobe to record the unlock in.
  {
    const { ships, inventory } = harness({ bag: [itemId] });
    assert.deepEqual(applyShipSkin({ ships, cosmetics: null, inventory }, 'kestrel', scheme.id),
      { ok: false, reason: 'unavailable' });
    assert.equal(inventory.totalCount(itemId), 1, 'a missing wardrobe ate the livery');
  }

  // -- no registry at all, which is what an unwired main.js looks like.
  {
    const { cosmetics, inventory } = harness({ bag: [itemId] });
    assert.deepEqual(applyShipSkin({ ships: null, cosmetics, inventory }, 'kestrel', scheme.id),
      { ok: false, reason: 'unavailable' });
    assert.equal(inventory.totalCount(itemId), 1, 'an unwired registry ate the livery');
  }

  // -- and a registry too old to answer "is this hull here" refuses rather
  //    than guessing, because a guess is spent whether or not it was right.
  {
    const { cosmetics, inventory } = harness({ bag: [itemId] });
    const blind = { applyScheme: () => ({ ok: true }) };
    assert.deepEqual(applyShipSkin({ ships: blind, cosmetics, inventory }, 'kestrel', scheme.id),
      { ok: false, reason: 'unavailable' });
    assert.equal(inventory.totalCount(itemId), 1);
  }

  // -- owning nothing and carrying nothing: `not-owned`, and nothing painted.
  {
    const { ships, cosmetics, inventory } = harness();
    assert.deepEqual(applyShipSkin({ ships, cosmetics, inventory }, 'kestrel', scheme.id),
      { ok: false, reason: 'not-owned' });
    assert.deepEqual(ships.getLivery('kestrel'), {}, 'an unpaid livery went on anyway');
  }

  // -- and an id nobody has ever heard of.
  {
    const { ships, cosmetics, inventory } = harness();
    assert.deepEqual(applyShipSkin({ ships, cosmetics, inventory }, 'kestrel', 'kestrel_nonesuch'),
      { ok: false, reason: 'unknown-scheme' });
  }
});

/* ================================================================== */
/* 5. Through `ItemUse`, which is what the Use button presses           */
/* ================================================================== */

test('ItemUse routes a shipskin before the generic consume, and refuses without spending', () => {
  /* THE DEFECT THIS DISPATCH EXISTS TO PREVENT. `use()`'s generic path calls
   * `consumeFromBag` BEFORE `_apply`, so a livery that reached it would be
   * destroyed and then found to be unsupported. The `shipskin` branch must run
   * ahead of it, and ahead of the `!this.player` guard, because painting a
   * hull has nothing to do with being alive. */
  const src = read('src/systems/ItemUse.js');
  const at = (needle) => src.indexOf(needle);
  assert.ok(at("kind === 'shipskin'") > 0, 'ItemUse has no shipskin dispatch');
  assert.ok(at("kind === 'shipskin'") < at('if (!this.player)'),
    'the shipskin dispatch runs after the player guard, so a dead pilot cannot paint a hull');
  assert.ok(at("kind === 'shipskin'") < at('this.inventory.consumeFromBag(itemId, 1)'),
    'the shipskin dispatch runs after the generic consume - a refusal would destroy the livery');

  const scheme = SHIP_SKINS_BY_ID.get('pike_cinnabar');
  const itemId = shipSkinItemId(scheme.id);
  const { bus, events, ships, cosmetics, inventory } = harness({ bag: [itemId] });
  ships.select('pike');
  const sys = new ItemUseSystem({ bus, inventory, cosmetics, ships });

  const ok = sys.use(itemId);
  assert.equal(ok.ok, true);
  assert.equal(ok.consumed, true);
  assert.equal(inventory.totalCount(itemId), 0);
  assert.equal(cosmetics.has(scheme.id), true);
  assert.ok(events.some((e) => e.name === 'inventory:item-used' && e.payload.effect === 'shipskin'),
    'nothing told the rest of the game a livery was used');
});

test('the two refusals a player can act on are worded differently, and both keep the livery', () => {
  const scheme = SHIP_SKINS_BY_ID.get('kestrel_solstice');
  const itemId = shipSkinItemId(scheme.id);

  // Wrong berth selected: the fix is one click, and the toast says which hull.
  {
    const { bus, events, ships, cosmetics, inventory } = harness({ bag: [itemId] });
    ships.select('dray');
    const res = new ItemUseSystem({ bus, inventory, cosmetics, ships }).use(itemId);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'wrong-ship');
    assert.equal(inventory.totalCount(itemId), 1, 'a refusal spent the livery');
    const toast = events.filter((e) => e.name === 'hud:notify').pop();
    assert.match(toast.payload.text, /Kestrel/, 'the toast does not name the hull the livery is for');
    assert.match(toast.payload.text, /Kept, not spent/);
  }

  // Not in this world: the fix is a flight, and the toast says where to.
  {
    const events = [];
    const bus = { on: () => () => {}, emit: (name, payload) => events.push({ name, payload }) };
    const inventory = new Inventory({ bus });
    inventory.acquire(itemId, 1);
    const ships = new ShipRegistry({ worldManager: { active: { ships: [] } } });
    const res = new ItemUseSystem({ bus, inventory, cosmetics: new Cosmetics({ bus }), ships }).use(itemId);
    assert.equal(res.reason, 'not-here');
    assert.equal(inventory.totalCount(itemId), 1, 'a refusal spent the livery');
    const toast = events.filter((e) => e.name === 'hud:notify').pop();
    assert.match(toast.payload.text, /Lodestar Yard/, 'the toast does not say where to take the hull');
    assert.match(toast.payload.text, /Kept, not spent/);
  }

  /* An unwired registry - the shape main.js has for a moment during boot, and
   * for ever if the `itemUse.ships = ships` line is ever dropped. The failure
   * must cost a toast, never a livery. */
  {
    const events = [];
    const bus = { on: () => () => {}, emit: (name, payload) => events.push({ name, payload }) };
    const inventory = new Inventory({ bus });
    inventory.acquire(itemId, 1);
    const res = new ItemUseSystem({ bus, inventory, cosmetics: new Cosmetics({ bus }) }).use(itemId);
    assert.equal(res.ok, false);
    assert.equal(inventory.totalCount(itemId), 1, 'an unwired registry ate the livery');
  }

  // And main.js really does make that wire.
  assert.match(read('src/main.js'), /itemUse\.ships = ships;/,
    'main.js no longer hands the hull registry to ItemUse - every livery would refuse');
});

test('with no berth selected the livery paints its OWN hull, rather than refusing', () => {
  /* Opening the bag without first opening the ship panel selects nothing, and
   * a Use button that only works after a different button has been pressed is
   * a button that does not work. The fallback is the livery's own hull, which
   * is the only thing the press could have meant. */
  const scheme = SHIP_SKINS_BY_ID.get('dray_anthracite');
  const itemId = shipSkinItemId(scheme.id);
  const { bus, ships, cosmetics, inventory } = harness({ bag: [itemId] });
  ships._selected = null;
  const res = new ItemUseSystem({ bus, inventory, cosmetics, ships }).use(itemId);
  assert.equal(res.ok, true);
  assert.equal(ships.getLivery('dray').hull.color, scheme.livery.hull.color);
});

/* ================================================================== */
/* 6. It survives being saved                                          */
/* ================================================================== */

test('an owned livery and an applied one both round-trip through save and load', () => {
  /* Two halves, and the second is the one that is easy to miss: an APPLIED
   * livery is paint (`ShipRegistry.serialize`) and an OWNED one is a ledger
   * entry (`Cosmetics.serialize`). Losing either is a purchase that evaporates
   * on reload - the first silently repaints the hull to yard grey, the second
   * turns a bought card back into a padlock. */
  const worn = SHIP_SKINS_BY_ID.get('pike_covert');
  const spare = SHIP_SKINS_BY_ID.get('kestrel_blackline');
  const { ships, cosmetics, inventory } = harness({ bag: [shipSkinItemId(worn.id), shipSkinItemId(spare.id)] });

  applyShipSkin({ ships, cosmetics, inventory }, 'pike', worn.id);
  cosmetics.unlock(spare.id);          // bought and burned in, never applied

  const saved = { ships: ships.serialize(), cosmetics: cosmetics.serialize() };
  const json = JSON.parse(JSON.stringify(saved));

  const next = harness();
  next.ships.deserialize(json.ships);
  next.cosmetics.deserialize(json.cosmetics);

  assert.equal(next.cosmetics.has(worn.id), true, 'the applied livery is no longer owned');
  assert.equal(next.cosmetics.has(spare.id), true, 'the spare livery was lost on reload');
  assert.equal(next.ships.getLivery('pike').hull.color, worn.livery.hull.color,
    'the hull repainted itself to yard grey across the save');

  // And the owned-but-unapplied one still applies for free on the fresh save.
  assert.deepEqual(applyShipSkin(next, 'kestrel', spare.id), { ok: true, consumed: false });
});

test('the wardrobe knows every livery id and refuses everything else', () => {
  /* `Cosmetics` guards `unlock` and `deserialize` with one id set, and the ship
   * half of it is imported from `ShipStats` rather than restated - a guard
   * carrying its own copy of the catalogue goes stale the first time a livery
   * is renamed, and the failure is silent: `unlock` answers false and the
   * player who paid does not get their paint. */
  const c = new Cosmetics({});
  for (const id of KNOWN_SHIP_SKIN_IDS) {
    assert.equal(c.unlock(id), true, `the wardrobe refuses ${id}, which is in its own known set`);
  }
  assert.equal(c.list().length, KNOWN_SHIP_SKIN_IDS.size);
  assert.equal(c.unlock('pike_whitecap'), false, 'a second unlock of the same id was not idempotent');

  const bad = new Cosmetics({});
  assert.equal(bad.unlock('shipskin_pike_whitecap'), false, 'the BAG ITEM id unlocked a cosmetic');
  assert.equal(bad.unlock('pike_nonesuch'), false);
  assert.equal(bad.unlock(''), false);
  assert.equal(bad.unlock(null), false);
  assert.equal(bad.list().length, 0);

  // A save carrying rubbish loads the good ids and drops the rest, rather than
  // failing the whole load - the shape the ledger has always had.
  const filtered = new Cosmetics({});
  filtered.deserialize({ unlocked: ['pike_covert', 'pike_nonesuch', 'char_aurora', 42, null] });
  assert.deepEqual(filtered.list().sort(), ['char_aurora', 'pike_covert']);
});

/* ================================================================== */
/* 7. Purchase-only, and the money                                     */
/* ================================================================== */

test('a livery falls off nothing, is cached by nothing and is asked for by nothing', () => {
  /* The single-source fact the `noSell` decision rests on. `ItemDefs` leaves
   * these SELLABLE where a mount upgrade is `noSell`, and the entire reason is
   * that a mount upgrade has a second source - a map-editor pickup that
   * respawns for anyone who does not own the power - and a livery does not.
   * citadel-economy.test.mjs asserts this over the live tables; this is the
   * textual half, which also catches a table that is added rather than edited. */
  const ids = PAID_SHIP_SKINS.map((s) => shipSkinItemId(s.id));
  for (const rel of ['src/systems/Loot.js', 'src/systems/Caches.js', 'src/systems/Contracts.js']) {
    const src = read(rel);
    for (const id of ids) {
      assert.ok(!src.includes(id), `${rel} names ${id} - a livery has grown a second source`);
    }
  }
  for (const id of ids) assert.notEqual(itemDef(id).noSell, true,
    `${id} is noSell - see the SHIP_SKIN_VALUE_RATIO note for why it should not be`);
});

test('selling a livery back is a loss in every world, which is why it is sellable', () => {
  /* Measured, not asserted. `sellValue` is `value * SELL_RATE *
   * buyMultiplier`, and no region declares a `shipskin` rate - so this
   * compares the BEST buy-back anywhere against that livery's OWN counter
   * price, per livery, rather than against the cheapest one. A world that grew
   * a generous `shipskin` multiplier tomorrow would redden here. */
  for (const s of PAID_SHIP_SKINS) {
    const id = shipSkinItemId(s.id);
    let best = 0;
    for (const world of Object.keys(WORLD_MARKETS)) {
      setMarketWorld(world);
      best = Math.max(best, sellValue(id, 1));
    }
    setMarketWorld(null);
    assert.ok(best < s.cost / 2,
      `${s.id} costs ${s.cost} and sells back for ${best} - that is close enough to be worth farming`);
    assert.ok(best >= 1, `${s.id} sells back for nothing at all`);
  }
});

/* ================================================================== */
/* 8. The catalogue, and the shop that works with the API down         */
/* ================================================================== */

test('every paid livery has a shop row, at the price the game says it costs', () => {
  /* The last link, and the one whose failure is a card that can be seen and
   * never unlocked. Checked against the OFFLINE mirror, which
   * marketplace-offline.test.mjs pins field by field against the TypeScript -
   * so this is a two-hop chain to `BASE_ITEMS` with no second parser to keep
   * honest. */
  const rows = OFFLINE_BASE_ITEMS.filter((r) => r.game_action === 'ship_livery');
  assert.equal(rows.length, 9, `${rows.length} livery rows in the shop, for 9 paid liveries`);

  for (const s of PAID_SHIP_SKINS) {
    const itemId = shipSkinItemId(s.id);
    const row = rows.find((r) => r.action_config.item_id === itemId);
    assert.ok(row, `${s.id} costs credits and has no shop row - the card can never be unlocked`);
    assert.equal(row.source_key, itemId);
    assert.equal(row.action_config.effect, 'grant_item');
    assert.equal(row.category, 'ships');
    assert.deepEqual([...row.worlds], ['dock'],
      `${s.id} is seeded outside the yard, where no counter carries the ships category`);
    /* `fixed`, not `consumable`. A permanent unlock priced by regional
     * multipliers makes "fly to the cheap world first" the correct play for a
     * thing you buy once, which is the arbitrage the bag rigs are fixed to
     * prevent. */
    assert.equal(row.pricing_kind, 'fixed', `${s.id} is priced per region`);
    assert.equal(row.cost_buy, s.cost,
      `${s.id} costs ${s.cost} in the game and ${row.cost_buy} at the counter`);
    assert.ok(!row.name.includes("'"),
      `${row.name} has an apostrophe - marketplace-offline.test.mjs parses names with a `
      + 'single-quote-only regex and would silently read it as null');
  }

  // The yard really does stock them offline, and nowhere else does.
  const dock = offlineCatalog('dock').map((r) => r.source_key);
  const station = offlineCatalog('station').map((r) => r.source_key);
  for (const s of PAID_SHIP_SKINS) {
    const key = shipSkinItemId(s.id);
    assert.ok(dock.includes(key), `the yard's offline shop does not stock ${key}`);
    assert.ok(!station.includes(key), `${key} is stocked on the station, which is not a shipyard`);
  }
});

test('the shop sells exactly the paid nine, and never a free scheme', () => {
  /* The other direction. A row selling `shipskin_kestrel_courier` would resolve
   * to an item that is not generated, so `_purchaseGrant` would take the
   * credits and hand over nothing - the nine-step registration's recorded
   * failure, arriving through a row that looks perfectly well-formed. */
  for (const row of OFFLINE_BASE_ITEMS) {
    const itemId = row.action_config?.item_id;
    if (typeof itemId !== 'string' || !itemId.startsWith('shipskin_')) continue;
    const skinId = shipSkinIdFromItem(itemId);
    assert.ok(skinId, `${row.source_key} grants ${itemId}, which is not a paid livery`);
    assert.ok(itemDef(itemId), `${row.source_key} grants ${itemId}, which is not in ITEMS`);
  }

  const ts = read('site/lib/marketplaceCatalog.ts');
  for (const s of SHIP_SKINS.filter((x) => !isPaidShipSkin(x))) {
    assert.ok(!ts.includes(shipSkinItemId(s.id)),
      `the catalogue sells ${s.id}, which shipped free - that is a thing taken away from players`);
  }
  assert.match(ts, /id: 'ship_livery'/, 'the ship_livery action id is gone; every row would fail validation');
});

/* ================================================================== */
/* 9. The panel                                                        */
/* ================================================================== */

test('the ship panel is wired to the wardrobe and the bag, or every card is locked', () => {
  /* A panel built without `cosmetics` and `inventory` draws all nine paid cards
   * as `locked` for ever, which is precisely the "built, visible and
   * unreachable" card the ShipStats note names as this project's signature
   * defect. Checked in main.js, where the wire is actually made. */
  const main = read('src/main.js');
  const at = main.indexOf('new ShipMenu({');
  assert.ok(at > 0, 'ShipMenu is no longer constructed in main.js');
  const block = main.slice(at, main.indexOf('});', at));
  assert.match(block, /cosmetics/, 'ShipMenu is built without the wardrobe - every paid card locks');
  assert.match(block, /inventory/, 'ShipMenu is built without the bag - a carried livery reads as unbought');

  const menu = read('src/ui/ShipMenu.js');
  assert.match(menu, /applyShipSkin/,
    'the panel calls applyScheme directly again - a paid livery would paint without being spent');
  for (const cls of ['owned', 'held', 'locked']) {
    assert.ok(menu.includes(`'${cls}'`), `the panel never draws the ${cls} card state`);
  }
  const css = read('src/ui/ship-menu.css');
  for (const cls of ['sm-schemecard.owned', 'sm-schemecard.held', 'sm-schemecard.locked', 'sm-secnote']) {
    assert.ok(css.includes(`.${cls}`), `.${cls} has no rule, so the state is invisible`);
  }
});

test('every hull shows both blocks, and the free block is never a shop', () => {
  for (const id of ['kestrel', 'dray', 'pike']) {
    const all = shipSkinsFor(id);
    assert.equal(all.length, 6, `${id} shows ${all.length} liveries`);
    assert.equal(all.filter((s) => !isPaidShipSkin(s)).length, 3);
    assert.equal(all.filter(isPaidShipSkin).length, 3);
    /* Free first in catalogue order, so the block a player already owns is the
     * one at the top of the section list and the commissions read as an
     * addition rather than as the main event. */
    assert.ok(!isPaidShipSkin(all[0]), `${id} leads with a purchase`);
  }
});
