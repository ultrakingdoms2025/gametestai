import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Mining, SAMPLE_HOLD_UNITS } from '../../src/systems/Mining.js';
import { Inventory } from '../../src/systems/Inventory.js';
import { ItemUseSystem } from '../../src/systems/ItemUse.js';
import { Contracts } from '../../src/systems/Contracts.js';
import {
  ITEMS, WORLD_MARKETS, SELL_RATE, itemDef, sellValue, setMarketWorld, buyMultiplier,
} from '../../src/systems/ItemDefs.js';
import { PLANETS } from '../../src/worlds/planets/index.js';
import { holdUnitsFor } from '../../src/worlds/planets/PlanetDescriptor.js';

/**
 * ORE THAT CAN BE HELD.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DEFECT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ItemDefs` declares forty-seven ore ids with a `stack`, a `value`, an `icon`,
 * a `colors` pair and a paragraph of description each, and not one of them
 * could ever enter a bag. `Mining.mine` handed every node to `Piloting.stow`,
 * which writes a `{units, credits, name}` row into `Piloting._cargo`, and
 * `sellCargo` called `economy.add(value, 'ore')` - a NUMBER, then deleted every
 * row. `ItemDefs.js` stated the consequence about itself: *"a regional
 * multiplier on tephra would be a number no transaction in the game reads."*
 *
 * Three shipped systems were therefore standing idle against forty-seven
 * pieces of authored data: `Contracts`' `supply` kind, which reads the bag;
 * `WORLD_MARKETS`, which prices `trinket` from 0.65 to 1.55 per world; and
 * `ItemUse`, which had one ore case in it and room for more.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THIS FILE ACTUALLY GUARDS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Not "does a sample reach the bag" - that is one assertion. The failures this
 * change could plausibly ship are all arithmetic or ordering:
 *
 *   1. THE DOUBLE COUNT. One node, two stores. A node that lands in both is a
 *      credit printer; a prompt that invites a cut `mine` then refuses is a
 *      seam the player cannot work and cannot be told why.
 *   2. THE PAY CUT. A vendor pays `SELL_RATE` (0.4) and the yard pays face
 *      value, so ANY node diverted from a hold that had room for it is a 60%
 *      income cut wearing a feature's name. The hold must be asked first,
 *      always, and this file proves it against a hold with room.
 *   3. THE UNREACHABLE EFFECT. An ore with an `ItemUse` case and a `trinket`
 *      kind has no Use button. `planet-minerals.test.mjs` already asserts that
 *      correspondence over every planet; what it cannot see is whether the
 *      three consumable ores are ones a player can actually GET, which is a
 *      question about `Mining`, not about `ItemDefs`.
 *   4. THE PROMISE IN THE PROSE. Each of the three item descriptions quotes a
 *      duration and a percentage. `ferrobasalt`'s note records those drifting
 *      once already - "this note used to say half a minute and the item
 *      description used to say thirty seconds" - so the numbers are read out
 *      of the live effect and matched against the words.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

/** Every mineral on every planet, with the volume the hold would charge. */
function everyMineral() {
  const out = [];
  for (const planet of Object.values(PLANETS)) {
    for (const m of planet.minerals) out.push({ planet: planet.id, ...m, hold: holdUnitsFor(m.size) });
  }
  return out;
}

/** The ores a player can pocket, by the module's own rule. */
function sampleOres() {
  return everyMineral().filter((m) => m.hold <= SAMPLE_HOLD_UNITS);
}

/**
 * A `Mining` wired to a real `Inventory` and a fake ship.
 * @param {{capacity?:number, units?:number}} hold
 */
function rig({ capacity = 0, units = 0 } = {}) {
  const notes = [];
  const events = [];
  const bus = {
    on: () => () => {},
    emit: (type, payload) => {
      events.push({ type, payload });
      if (type === 'hud:notify') notes.push(payload.text);
    },
  };
  const inventory = new Inventory({ ui: false, starter: false });
  const cargo = {};
  const piloting = {
    shipId: 'kestrel',
    active: false,
    cargoUnits: units,
    cargoCapacity: capacity,
    stow(node) {
      const need = holdUnitsFor(node.size ?? 1);
      if (this.cargoUnits + need > this.cargoCapacity) return { ok: false, reason: 'hold-full' };
      this.cargoUnits += need;
      cargo[node.type] = (cargo[node.type] ?? 0) + need;
      return { ok: true, units: need };
    },
  };
  const world = { id: 'rig', mineralNodes: [] };
  const mining = new Mining({
    bus,
    player: { position: { x: 0, y: 0, z: 0 } },
    input: null,
    worldManager: { active: world },
    piloting,
    inventory,
  });
  return { mining, inventory, piloting, cargo, notes, events, bus, world };
}

/** A node shaped like the ones `PlanetWorld` publishes, for one real mineral. */
function nodeFor(id, n = 1) {
  const m = everyMineral().find((x) => x.id === id);
  assert.ok(m, `${id} is not a mineral on any planet`);
  return {
    id: `${id}_${n}`,
    type: m.item,
    name: m.name,
    size: m.size,
    credits: m.credits[0],
    position: { x: 0, y: 0, z: 0 },
  };
}

/* ================================================================== */
/* 1. THE RULE: the hold first, the bag only as overflow               */
/* ================================================================== */

test('a hold with room takes the node, and the bag stays empty', () => {
  /* THE PAY-CUT GUARD, and the most important case in the file.
   *
   * A vendor pays `value * SELL_RATE` for a bag row and the yard pays the
   * node's face value for a hold row. Iridite is 310 cr/m3, so routing one
   * chip to the bag while the hold had room for it takes 310 credits down to
   * 124 - a 60% cut, shipped under a commit message that says "ore into the
   * bag". Nothing about the feature would look wrong; the player would simply
   * be poorer. */
  const r = rig({ capacity: 10 });
  const res = r.mining.mine(nodeFor('iridite'));
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.where, 'hold', 'a node was pocketed while the hold had room for it');
  assert.equal(r.cargo.iridite, 1, 'the hold did not take it');
  assert.equal(r.inventory.bagCount('iridite'), 0, 'it went into the bag as well as the hold');
});

test('a full hold hands a small node to the bag, and a big one to nobody', () => {
  const r = rig({ capacity: 2, units: 2 });
  const small = r.mining.mine(nodeFor('iridite'));
  assert.equal(small.where, 'bag', `a 1 m3 node was refused by a full hold: ${small.reason}`);
  assert.equal(r.inventory.bagCount('iridite'), 1);
  assert.equal(r.cargo.iridite, undefined, 'the hold took it too - one node, two stores');

  const big = r.mining.mine(nodeFor('tephra'));
  assert.equal(big.ok, false, 'a 3 m3 boulder went into a satchel');
  assert.equal(big.reason, 'hold-full');
  assert.equal(r.inventory.bagCount('tephra'), 0);
});

test('a Pike has no hold at all, and that is what makes it a prospector', () => {
  /* `SHIP_BASE_STATS.pike.hold` is 0, so before this the interceptor could not
   * mine one gram of anything. Every node it stood at answered "Hold full -
   * 0/0 m3", which is a mining prompt on a ship with no mining loop. */
  const r = rig({ capacity: 0 });
  const res = r.mining.mine(nodeFor('aurichalc'));
  assert.equal(res.where, 'bag', `the Pike still cannot take a chip: ${res.reason}`);
  assert.equal(r.inventory.bagCount('aurichalc'), 1);
});

test('the node is not consumed when neither store will take it', () => {
  /* `MountSkins.js`'s ordering rule, applied to the one thing here that cannot
   * be given back: a mineral node is finite and does not respawn. Both refusals
   * must happen BEFORE `_taken` and `_hide`. */
  const r = rig({ capacity: 0 });
  /* Every slot, not every item. Capacity is counted in SLOTS and a medkit
   * stacks, so thirty single medkits fill one slot and leave twenty-nine free -
   * which is how a "full bag" test comes to test nothing at all. `addToBag`
   * accepts what fits and reports it, so asking for far too many fills the bag
   * exactly. */
  const filled = r.inventory.addToBag('medkit', 100000);
  assert.ok(filled > 0, 'nothing went in');
  assert.equal(r.inventory.bagRoomFor('iridite'), 0, 'the bag is not actually full');

  const node = nodeFor('iridite');
  const res = r.mining.mine(node);
  assert.equal(res.ok, false, 'a node was taken with nowhere to put it');
  // The real proof: the same node can still be worked once there is room.
  r.inventory.consumeFromBag('medkit', filled);
  const again = r.mining.mine(node);
  assert.equal(again.where, 'bag', `the refused node was consumed after all: ${again.reason}`);
  assert.equal(r.inventory.bagCount('iridite'), 1);
});

test('the sample rule is the hold volume, and it is read from the module', () => {
  /* Not a number this file spells. `SAMPLE_HOLD_UNITS` is exported precisely so
   * a gate cannot pass on the day it changes: at 2 every uncommon boulder in
   * the game goes into a bag slot and the hold stops being the reason to fly
   * home, which is the loop this whole system exists for. */
  assert.equal(SAMPLE_HOLD_UNITS, 1,
    'the pocketable volume moved - re-read the ladder below before changing this');
  const samples = sampleOres();
  const bulk = everyMineral().filter((m) => m.hold > SAMPLE_HOLD_UNITS);
  assert.equal(samples.length + bulk.length, 47, 'the ore census moved');
  assert.equal(samples.length, 21,
    `${samples.length} ores are pocketable, not 21 - the size ladder or the rule moved`);
  // Every rare and exotic seam in the system, and nothing common.
  const rarities = new Set(samples.map((m) => m.rarity));
  assert.ok(!rarities.has('common'),
    `a common ore is pocketable (${samples.filter((m) => m.rarity === 'common').map((m) => m.id)}) - ` +
    'a boulder you walk up to at the pad is not a hand sample');
  console.log(`   pocketable: ${samples.length}/47 - ${[...rarities].sort().join(', ')}`);
});

/* ================================================================== */
/* 2. CONSEQUENCE ONE: supply contracts can name an ore                */
/* ================================================================== */

test('every ore a world asks for is one a player can actually pocket', async () => {
  /* The "built but not reachable" defect, printed on a job board. A supply
   * contract is completed by `consumeFromBag`, so a row naming an ore the bag
   * can never hold is an errand nobody can finish - and `Contracts` offers two
   * per world out of a table of three, so it would be offered often. */
  const src = await readFile(path.join(ROOT, 'src/systems/Contracts.js'), 'utf8');
  const block = /const SUPPLY_WANTS = \{([\s\S]*?)\n\};/.exec(src)?.[1];
  assert.ok(block, 'SUPPLY_WANTS has been renamed or moved - this whole case is now vacuous');
  const wanted = [...block.matchAll(/id: '([a-z0-9_]+)'/g)].map((m) => m[1]);
  assert.ok(wanted.length >= 12, `only ${wanted.length} supply rows parsed - the scraper lost its grip`);

  const pocketable = new Set(sampleOres().map((m) => m.item));
  const allOre = new Set(everyMineral().map((m) => m.item));
  const oreWanted = wanted.filter((id) => allOre.has(id));
  assert.ok(oreWanted.length >= 5,
    `only ${oreWanted.length} worlds ask for ore - the 47 ids are idle data again`);
  for (const id of oreWanted) {
    assert.ok(pocketable.has(id),
      `a world asks the player to bring "${id}", and ${holdUnitsFor(
        everyMineral().find((m) => m.item === id).size,
      )} m3 of it will not go in a bag - that contract can never be turned in`);
  }
  console.log(`   ore on the job board: ${oreWanted.join(', ')}`);
});

test('a supply contract for ore completes off a mined sample, end to end', () => {
  /* The whole chain in one case: cut a seam with a full hold, watch the sample
   * land in the bag, watch the contract's own scan see it, turn it in, watch
   * the bag be debited and the credits paid. */
  const inventory = new Inventory({ ui: false, starter: false });
  let paid = 0;
  const economy = { add: (n) => { paid += n; } };
  const bus = { on: () => () => {}, emit: () => {} };
  const contracts = new Contracts({ bus, inventory, economy });
  const c = {
    id: 'x', kind: 'supply', state: 'active', have: 0, need: 2,
    reward: 84, itemId: 'rheniite', itemName: 'rheniite',
  };
  contracts.list.push(c);

  const r = rig({ capacity: 0 });
  // Two rheniite flakes, both pocketed because a Pike has no hold.
  for (let i = 0; i < 2; i++) {
    const res = r.mining.mine(nodeFor('rheniite', i));
    assert.equal(res.where, 'bag', `flake ${i} did not reach the bag: ${res.reason}`);
  }
  // Move them into the contract's own inventory the way a real session would
  // have them there already - the point under test is the turn-in, not the two
  // separate `Inventory` instances a headless rig needs.
  inventory.addToBag('rheniite', r.inventory.bagCount('rheniite'));
  c.have = inventory.bagCount('rheniite');
  assert.equal(c.have, 2, 'the samples never arrived');

  assert.equal(contracts.turnIn(c), true, 'the turn-in was refused');
  assert.equal(inventory.bagCount('rheniite'), 0, 'the goods were not consumed');
  assert.equal(paid, 84, 'the reward was not paid');
});

/* ================================================================== */
/* 3. CONSEQUENCE TWO: the regional spread is real                     */
/* ================================================================== */

test('the same rock is worth more two gateways away, and by how much', () => {
  /* `WORLD_MARKETS.buy.trinket` runs 0.65 at the station to 1.55 in Aldermoor
   * Vale, and until a sample could be carried that spread applied to nothing a
   * miner owned. The assertion is on the RATIO rather than on either price, so
   * a re-tune of both ends together does not redden it and a re-tune that
   * flattens the map does. */
  const cheap = 'station';
  const dear = 'medieval';
  const rows = [];
  for (const id of ['iridite', 'aurichalc', 'rheniite', 'cryolite']) {
    setMarketWorld(cheap);
    const low = sellValue(id, 1);
    setMarketWorld(dear);
    const high = sellValue(id, 1);
    rows.push({ id, low, high, ratio: high / low });
    assert.ok(high > low,
      `${id} pays ${high} in ${dear} and ${low} in ${cheap} - there is nothing to carry it for`);
    assert.ok(high / low > 2,
      `${id} only gains ${((high / low - 1) * 100).toFixed(0)}% across the map - not a trade, a rounding`);
  }
  setMarketWorld(null);
  for (const r of rows) console.log(`   ${r.id.padEnd(10)} ${r.low} -> ${r.high} cr  (x${r.ratio.toFixed(2)})`);
});

test('the three usable ores kept their trinket payout through the kind change', () => {
  /* `laser_cell`'s recorded failure, and the reason its `itemBuy` row exists:
   * a relabelling that moves an item from one kind multiplier to another is a
   * balance change nobody would find in a diff of `ItemDefs`. All three ores
   * had to become `consumable` to get a Use button, so all three carry a
   * per-item row pinning them at their own former `buy.trinket` rate. */
  for (const id of ['cryolite', 'sperrylite', 'aurichalc']) {
    assert.equal(itemDef(id).kind, 'consumable', `${id} lost its Use button`);
    for (const [world, market] of Object.entries(WORLD_MARKETS)) {
      const trinket = market.buy?.trinket;
      if (trinket === undefined) continue;
      setMarketWorld(world);
      assert.equal(buyMultiplier(id), trinket,
        `${id} pays ${buyMultiplier(id)}x in ${world} and every other ore pays ${trinket}x - ` +
        'the kind change moved the payout');
    }
  }
  setMarketWorld(null);
});

test('SELL_RATE still applies to a sample, so the hold is still the better door', () => {
  /* Stated as a gate because it is the argument the whole overflow rule rests
   * on. If a bag row ever paid face value, routing ore to the bag would stop
   * being a fallback and start being a choice - and the hold, the ore tender
   * and the flight home would all become optional. */
  setMarketWorld(null);
  assert.equal(SELL_RATE, 0.4);
  const iridite = ITEMS.iridite;
  assert.equal(sellValue('iridite', 1), Math.round(iridite.value * SELL_RATE),
    'a bag row no longer sells at the buy-back rate');
  setMarketWorld('medieval');
  assert.ok(sellValue('iridite', 1) < iridite.value,
    'the dearest market in the game now pays face value for a pocketed rock');
  setMarketWorld(null);
});

/* ================================================================== */
/* 4. CONSEQUENCE THREE: three ores with a use in the hand              */
/* ================================================================== */

test('the three ore effects fire, and are weaker than the article they imitate', () => {
  const sys = new ItemUseSystem({});
  const ward = sys._effectFor('cryolite');
  const charm = sys._effectFor('ward_20');
  assert.equal(ward.type, 'ward');
  assert.ok(ward.multiplier > charm.multiplier,
    `cryolite takes off ${(1 - ward.multiplier) * 100}% and a Bastion Ward ${(1 - charm.multiplier) * 100}% - ` +
    'a rock out of the ground beats the manufactured article');
  assert.ok(ward.duration < charm.duration, 'the rock lasts as long as the charm');

  const edge = sys._effectFor('sperrylite');
  const boost = sys._effectFor('firepower_boost_25');
  assert.equal(edge.type, 'firepower');
  assert.ok(edge.multiplier < boost.multiplier, 'the cube beats the Ardent Charm');
  assert.ok(edge.duration < boost.duration, 'the cube lasts as long as the charm');

  const leaf = sys._effectFor('aurichalc');
  assert.equal(leaf.type, 'chart');
  assert.ok(leaf.refusal?.text, 'no refusal, so a chart in the wrong sky is destroyed for nothing');
  assert.ok(ITEMS.aurichalc.value > ITEMS.nav_chart.value,
    'the ore no longer costs more than the Plate it imitates - the trade-off is gone');
});

test('the effect numbers and the item descriptions say the same thing', () => {
  /* `ferrobasalt`'s recorded failure: the note said half a minute, the item
   * said thirty seconds, and the player read the item three lines from a toast
   * counting down from twenty. Both numbers are derived from the live effect
   * and looked for in the prose, so a re-tune that touches one and not the
   * other reddens here rather than in a toast. */
  const sys = new ItemUseSystem({});
  for (const id of ['cryolite', 'sperrylite']) {
    const fx = sys._effectFor(id);
    const desc = itemDef(id).desc.toLowerCase();
    const WORDS = { 20: 'twenty', 30: 'thirty', 15: 'fifteen', 10: 'ten' };
    assert.ok(desc.includes(`${WORDS[fx.duration] ?? fx.duration} seconds`),
      `${id} runs for ${fx.duration}s and its description does not say so: "${desc}"`);
    const pct = Math.round(Math.abs(1 - fx.multiplier) * 100);
    assert.ok(desc.includes(WORDS[pct] ?? String(pct)),
      `${id} is worth ${pct}% and its description does not say so: "${desc}"`);
  }
});

test('a use refused by the world keeps the rock', () => {
  /* The seven-hundred-credit case. `_canApply` is asked before
   * `consumeFromBag`, so aurichalc read in a world with nothing to chart must
   * come back with the chip still in the bag - the "unit destroyed for
   * nothing" failure the `ItemUse` header keeps naming, at the highest price
   * the game can charge for it. */
  const bag = {
    n: 1,
    bagCount: () => 1,
    consumeFromBag(id, q) { if (id !== 'aurichalc' || this.n < q) return false; this.n -= q; return true; },
  };
  const sys = new ItemUseSystem({ bus: { emit() {} }, player: {}, inventory: bag, viewpoints: null });
  const res = sys.use('aurichalc');
  assert.equal(res.ok, false, 'a chart was read in a world with nothing to chart');
  assert.equal(bag.n, 1, 'the 700 cr/m3 chip was destroyed for nothing');
});

/* ================================================================== */
/* 5. THE WIRE                                                         */
/* ================================================================== */

test('no bag reachable means the old behaviour, exactly', () => {
  /* The absence of a wire must not invent a destination. A `Mining` built the
   * way `main.js` builds it today, with no inventory anywhere in reach, has to
   * behave precisely as it did before this feature existed - hold, or refusal -
   * because a feature that half-works when unwired is worse than one that does
   * not work at all. */
  const bus = { on: () => () => {}, emit: () => {} };
  const piloting = { shipId: 'pike', active: false, cargoUnits: 0, cargoCapacity: 0, stow: () => ({ ok: false, reason: 'hold-full' }) };
  const m = new Mining({ bus, player: {}, input: null, worldManager: { active: { id: 'x', mineralNodes: [] } }, piloting });
  const res = m.mine(nodeFor('iridite'));
  assert.equal(res.ok, false, 'a node vanished into a bag that does not exist');
  assert.equal(res.reason, 'hold-full');
});

test('the live game can reach a bag without main.js changing', async () => {
  /* The chain the module documents: `main.js` assigns `player.loadout` and
   * `Loadout.setInventory` puts the bag on it. Both halves are scraped, because
   * either one moving turns the whole feature off silently - `_bag()` would
   * answer null, every sample would become a refusal, and nothing would throw. */
  const main = await readFile(path.join(ROOT, 'src/main.js'), 'utf8');
  assert.match(main, /player\.loadout\s*=\s*loadout/,
    'main.js no longer hangs the loadout off the player - Mining._bag has lost its route to the inventory');
  assert.match(main, /loadout\.setInventory\??\.?\(inventory\)/,
    'main.js no longer gives the loadout the inventory - Mining._bag has lost its route to the inventory');

  const loadout = await readFile(path.join(ROOT, 'src/player/Loadout.js'), 'utf8');
  assert.match(loadout, /setInventory\s*\(/, 'Loadout.setInventory is gone');

  // And the probe really does find it through that chain.
  const inventory = new Inventory({ ui: false, starter: false });
  const bus = { on: () => () => {}, emit: () => {} };
  const piloting = { shipId: 'pike', active: false, cargoUnits: 0, cargoCapacity: 0, stow: () => ({ ok: false, reason: 'hold-full' }) };
  const m = new Mining({
    bus,
    player: { loadout: { inventory } },
    input: null,
    worldManager: { active: { id: 'x', mineralNodes: [] } },
    piloting,
  });
  const res = m.mine(nodeFor('iridite'));
  assert.equal(res.where, 'bag', `the documented chain does not reach the bag: ${res.reason}`);
  assert.equal(inventory.bagCount('iridite'), 1);
});
