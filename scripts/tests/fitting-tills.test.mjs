import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SHIP_ORDER, SHIP_STATS, SHIP_STAT_META, SHIP_POWER_TIERS, SHIP_TIER_MUL,
  shipPowerPrice, shipPowerSellPrice, shipPowerName,
} from '../../src/ships/ShipStats.js';
import { ShipRegistry, activeShipRegistry } from '../../src/ships/ShipRegistry.js';
import { fittingRows, FITTING_STATE_LABEL } from '../../src/ui/ShipMenuLogic.js';
import {
  WEAPON_ORDER, WEAPON_STATS, WEAPON_POWERS, WeaponRegistry,
  WEAPON_POWER_TIERS, WEAPON_TIER_STEP, weaponTierMul, weaponDamage, normaliseDamage,
  weaponPowerPrice, weaponPowerSellPrice, statsFor, falloffFor,
} from '../../src/systems/WeaponStats.js';
import { Marketplace } from '../../src/systems/Marketplace.js';
import { offlineCatalog, OFFLINE_UPGRADE_ROWS } from '../../src/systems/MarketplaceOffline.js';

/**
 * TWO TILLS FOR TWO GEAR CLASSES THAT HAD NONE.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DEFECT, TWICE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A mount sold 57 fittings. A hull sold nothing: `SHIP_STATS` declared four
 * stats for each of three hulls, `SHIP_STAT_META` published +12/+10/+15/+25%
 * per tier, `ShipRegistry.grantPower` existed and `sellsPower` was made public
 * *specifically* so a marketplace could refuse an unsupported stat - and the
 * only caller of `grantPower` in the whole of `src/` was
 * `SpaceObjectives._refit`, which hands out four fittings at four fixed moments
 * in the campaign and then stops. `ShipMenuLogic.js` recorded the shape of it:
 * *"This line said 'upgrade at the Fitting Shop', and the Fitting Shop has
 * never sold a ship stat in any code path, wired or unwired."*
 *
 * A weapon sold nothing either, and had nothing to sell: four flat damage
 * numbers, no tier, no rarity, no upgrade field, and `weaponDamage()` -
 * documented as the single choke point - with zero callers anywhere in `src/`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THIS FILE GUARDS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   1. ONE PRICE. Every till reads `shipPowerPrice` / `weaponPowerPrice`; two
 *      independently authored numbers for one upgrade is how a purchase comes
 *      to sell back for more than it cost (`SHIP_SKINS.cost`'s own note).
 *   2. THE LADDER RATE IS THE SERVER'S. `SHIP_TIER_MUL` is a copy of `TIER_MUL`
 *      in `site/lib/marketplaceCatalog.ts`, so the TypeScript is parsed and
 *      compared, exactly as `marketplace-offline.test.mjs` does for prices.
 *   3. NOBODY IS CHARGED FOR NOTHING. `grantPower` keeps `max(owned, tier)` in
 *      both registries, so a till that sells a tier at or below what is fitted
 *      takes the money and changes nothing - and one that sells III over
 *      nothing makes I and II permanently unbuyable, which is worse.
 *   4. THE TIER REACHES ALL FOUR WEAPONS. The damage a player deals is computed
 *      in three different places and `weaponDamage()` is none of them, so the
 *      multiplier is asserted through every path that actually runs.
 *   5. AND DOES NOT REACH THEM TWICE.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const TS = path.join(ROOT, 'site/lib/marketplaceCatalog.ts');

/** Both registries start every case at stock. */
function stockWeapons() {
  WEAPON_POWERS.clear();
}

/* ================================================================== */
/* 1. ONE PRICE, AND IT IS THE SERVER'S LADDER                         */
/* ================================================================== */

test('the tier ladder climbs at the rate the server charges', async () => {
  /* `SHIP_TIER_MUL` and `WEAPON_TIER_MUL` are copies of `TIER_MUL` in the
   * TypeScript the browser cannot import - the same wall `MarketplaceOffline`
   * lives behind, and the same answer: parse the file rather than trust the
   * copy. Line endings are normalised first for the reason
   * `marketplace-offline.test.mjs` records: this repo checks out CRLF, and a
   * scrape that cared would be green in a worktree and red on merge. */
  const src = (await readFile(TS, 'utf8')).split('\r\n').join('\n');
  const literal = /const TIER_MUL = \[([^\]]+)\] as const;/.exec(src)?.[1];
  assert.ok(literal, 'TIER_MUL has been renamed or moved out of marketplaceCatalog.ts');
  const server = literal.split(',').map((n) => Number(n.trim()));
  assert.deepEqual([...SHIP_TIER_MUL], server,
    'the yard climbs its ladder at a different rate from every mount fitting in the game');

  // And the weapon copy, which is private, is checked through its prices.
  const ratio = [1, 2, 3].map((t) => weaponPowerPrice('sword', t) / weaponPowerPrice('sword', 1));
  assert.deepEqual(ratio.map((r) => Math.round(r * 100) / 100), server,
    'the weapon ladder climbs at a different rate from the ship and mount ones');
});

test('every ship fitting has exactly one price, and it is never a refund', () => {
  const seen = [];
  for (const ship of SHIP_ORDER) {
    for (const stat of SHIP_STATS[ship]) {
      let last = 0;
      for (let tier = 1; tier <= SHIP_POWER_TIERS; tier++) {
        const buy = shipPowerPrice(stat, tier);
        const sell = shipPowerSellPrice(stat, tier);
        assert.ok(buy > 0, `${ship}/${stat}/${tier} is free`);
        assert.ok(buy > last, `${ship}/${stat}/${tier} costs ${buy}, no more than tier ${tier - 1}`);
        assert.ok(sell < buy, `${ship}/${stat}/${tier} sells back for ${sell} against ${buy} - buy, sell, repeat, print`);
        last = buy;
        seen.push({ ship, stat, tier, buy });
      }
    }
  }
  assert.equal(seen.length, 36,
    `${seen.length} fittings, not 36 - three hulls, four stats, three tiers`);
  /* A stat off the ladder quotes ZERO and not NaN. A price bug that reaches a
   * player as `NaN CR` looks like a free item and is bought instantly. */
  assert.equal(shipPowerPrice('warp', 1), 0);
  assert.equal(shipPowerPrice('power', 9), 0);
  assert.equal(shipPowerPrice('power', 0), 0);
  const hull = seen.filter((r) => r.ship === 'kestrel').reduce((n, r) => n + r.buy, 0);
  console.log(`   a full Kestrel ladder costs ${hull} CR; all three hulls ${
    seen.reduce((n, r) => n + r.buy, 0)} CR`);
});

test('every weapon tier has exactly one price, and it is never a refund', () => {
  let total = 0;
  for (const id of WEAPON_ORDER) {
    let last = 0;
    for (let tier = 1; tier <= WEAPON_POWER_TIERS; tier++) {
      const buy = weaponPowerPrice(id, tier);
      assert.ok(buy > last, `${id}/${tier} costs ${buy}, no more than the tier below`);
      assert.ok(weaponPowerSellPrice(id, tier) < buy, `${id}/${tier} sells back for at least its price`);
      last = buy;
      total += buy;
    }
  }
  assert.equal(weaponPowerPrice('crossbow', 1), 0, 'a weapon with no ladder quotes a price');
  assert.equal(weaponPowerPrice('sword', 4), 0, 'a tier off the ladder quotes a price');
  console.log(`   every weapon at tier III costs ${total} CR`);
});

/* ================================================================== */
/* 2. THE YARD PANEL: rows, states, and the order the ladder is climbed */
/* ================================================================== */

test('a fitting row is buyable only when it is the next rung and affordable', () => {
  const rows = fittingRows({
    shipId: 'kestrel', stats: SHIP_STATS.kestrel, powers: { fire: 1 }, credits: 600,
  });
  const at = (stat, tier) => rows.find((r) => r.stat === stat && r.tier === tier);
  assert.equal(rows.length, 12, 'a hull draws twelve rungs');

  assert.equal(at('fire', 1).state, 'owned', 'a fitted tier is still on sale');
  assert.equal(at('fire', 2).state, 'dear', 'Firepower II is 1040 CR and the purse holds 600');
  assert.equal(at('fire', 3).state, 'locked', 'tier III is buyable over an unbought tier II');
  assert.equal(at('shield', 1).state, 'afford', 'Shields I is 380 CR against 600 and is not for sale');
  assert.equal(at('shield', 2).state, 'locked');

  /* `locked` is not cosmetic. `grantPower` keeps `max(owned, tier)`, so a
   * player who bought III over nothing would find I and II permanently
   * unbuyable - a purchase that DESTROYS the value of two cheaper ones. */
  assert.equal(FITTING_STATE_LABEL.locked, 'Needs the tier below');
  assert.equal(at('power', 1).effect, `+${SHIP_STAT_META.power.perTier}% ${SHIP_STAT_META.power.unit}`);
  assert.equal(at('power', 3).effect, `+${SHIP_STAT_META.power.perTier * 3}% ${SHIP_STAT_META.power.unit}`,
    'the row quotes the per-tier step three times over instead of the cumulative effect');
});

test('a purse that cannot be reached buys nothing, and says the price anyway', () => {
  /* The direction the silence has to fall. A missing economy is ZERO credits,
   * never infinite ones - every rung draws priced and refused rather than free. */
  const rows = fittingRows({ shipId: 'pike', stats: SHIP_STATS.pike, powers: {}, credits: 0 });
  assert.ok(rows.every((r) => r.state !== 'afford'), 'a rig with no purse can buy fittings');
  assert.ok(rows.every((r) => r.price > 0), 'a rung with no purse also lost its price');
});

test('the Bastion sells nothing, and the panel therefore offers nothing', () => {
  /* `SHIP_STATS.bastion` is an empty frozen array because the Bastion is a hulk
   * with its ribs open to the air. `ShipStats.js` records that `sellsPower`
   * once answered TRUE for it, so the marketplace "would have taken the credits
   * and `grantPower` would have banked `{"bastion":{"power":3}}` into the save
   * with no `Ship` to apply it to". A till is the exact thing that defect
   * needed to become a charge. */
  assert.deepEqual(fittingRows({ shipId: 'bastion', stats: SHIP_STATS.bastion ?? [], powers: {} }), []);
  const reg = new ShipRegistry({});
  assert.equal(reg.sellsPower('bastion', 'power'), false);
  reg.dispose();
});

test('the panel refuses before it charges, and grants only after it has', async () => {
  /* The order is the whole safety of a till, and it is asserted in SOURCE
   * because driving it needs a DOM. A grant before a debit is a free upgrade;
   * a debit before a refusal is the player's money gone. The four steps must
   * appear in this order inside `_buyFitting`. */
  const src = await readFile(path.join(ROOT, 'src/ui/ShipMenu.js'), 'utf8');
  const fn = /_buyFitting\(row\) \{[\s\S]*?\n {2}\}/.exec(src)?.[0];
  assert.ok(fn, '_buyFitting is gone - this whole case is now vacuous');
  const order = ['sellsPower', 'getPowers', 'spend', 'grantPower'];
  let cursor = -1;
  for (const step of order) {
    const at = fn.indexOf(step);
    assert.ok(at > cursor, `_buyFitting reaches "${step}" out of order - the till can charge for nothing`);
    cursor = at;
  }
  assert.match(fn, /row\.tier <= owned/, 'the till trusts its own button label instead of the live registry');
  assert.match(fn, /row\.tier > owned \+ 1/, 'the ladder can be climbed out of order');
});

/* ================================================================== */
/* 3. THE WEAPON LADDER REACHES EVERY WEAPON, THROUGH EVERY PATH        */
/* ================================================================== */

test('the tier multiplies the number every damage path actually reads', () => {
  /* Three paths, none of them `weaponDamage()`:
   *   machinegun  Combat._resolveNPCHit  ->  stats.damage * falloff * headshot
   *   sword       Sword._cut             ->  SPEC.damage, a module-scoped alias
   *   bow/fire    Projectiles            ->  normaliseDamage(id, amount)
   * Each is reproduced here exactly as its caller writes it, so a change that
   * turned the accessor back into a plain value would redden three times. */
  stockWeapons();
  const base = Object.fromEntries(WEAPON_ORDER.map((id) => [id, WEAPON_STATS[id].baseDamage]));

  for (let tier = 0; tier <= WEAPON_POWER_TIERS; tier++) {
    stockWeapons();
    if (tier) for (const id of WEAPON_ORDER) WEAPON_POWERS.grantPower(id, tier);
    const mul = weaponTierMul(tier);

    // Combat._resolveNPCHit, verbatim.
    const stats = statsFor('machinegun');
    const combat = stats.damage * falloffFor('machinegun', 10) * 1;
    assert.equal(round(combat), round(base.machinegun * mul),
      `tier ${tier}: the hitscan path did not see the tier`);

    // Sword._cut, through the same object it aliases at module scope.
    assert.equal(round(WEAPON_STATS.sword.damage), round(base.sword * mul),
      `tier ${tier}: the melee path did not see the tier`);

    // Projectiles -> Combat.applyNPCDamage -> normaliseDamage, at full charge.
    for (const id of ['bow', 'fireball']) {
      const republished = normaliseDamage(id, WEAPON_STATS[id].reference);
      assert.equal(round(republished), round(base[id] * mul),
        `tier ${tier}: the projectile path did not see the tier for ${id}`);
    }

    // And the documented choke point, which nothing calls but everything cites.
    assert.equal(round(weaponDamage('sword')), round(base.sword * mul));
  }
  stockWeapons();
});

test('the tier is applied exactly once, on every path', () => {
  /* The failure the accessor makes possible and this case forbids. A
   * `normaliseDamage` that multiplied by the tier AND read a tiered
   * `s.damage` would square it: at tier III a bow would deal 42 x 1.3 x 1.3 =
   * 71 rather than 55, which is a one-shot body kill and would look like a
   * balance decision rather than a bug. */
  stockWeapons();
  WEAPON_POWERS.grantPower('bow', 3);
  const once = 42 * 1.3;
  assert.equal(round(normaliseDamage('bow', WEAPON_STATS.bow.reference)), round(once));
  assert.notEqual(round(normaliseDamage('bow', WEAPON_STATS.bow.reference)), round(42 * 1.3 * 1.3));
  // Half a draw is half the damage, tier included - the charge curve survives.
  assert.equal(round(normaliseDamage('bow', WEAPON_STATS.bow.reference / 2)), round(once / 2));
  stockWeapons();
});

test('a tier-III weapon does not trivialise a 100 HP NPC', () => {
  /* The bound the ladder was chosen against. `CONFIG.npc.maxHealth` is 100 and
   * the beasts carry 220, and the only threshold the ladder crosses is the bow
   * headshot - which `firepower_boost_25` has crossed for 44 credits since the
   * day it shipped. Body-shot counts are asserted because those are the ones a
   * player feels in every fight, not only in a good one. */
  stockWeapons();
  for (const id of WEAPON_ORDER) WEAPON_POWERS.grantPower(id, WEAPON_POWER_TIERS);
  const hits = (id) => Math.ceil(100 / WEAPON_STATS[id].damage);
  assert.equal(hits('sword'), 2, 'a tier-III sword one-shots a hostile');
  assert.equal(hits('fireball'), 2, 'a tier-III fireball one-shots a hostile');
  assert.equal(hits('bow'), 2, 'a tier-III bow body shot one-shots a hostile');
  assert.ok(hits('machinegun') >= 5, 'a tier-III rifle kills in under five body shots');
  assert.ok(WEAPON_STATS.sword.damage < 100, 'the highest single hit in the game now one-shots');
  console.log(`   tier III body shots to kill: ${WEAPON_ORDER.map((id) => `${id} ${hits(id)}`).join(', ')}`);
  stockWeapons();
});

test('the ladder cannot be climbed out of order, downwards, or off its end', () => {
  const reg = new WeaponRegistry();
  assert.equal(reg.grantPower('trebuchet', 1), false, 'a weapon with no ladder was granted a tier');
  assert.equal(reg.grantPower('sword', 0), false);
  assert.equal(reg.grantPower('sword', 99), false, 'a tier off the end of the ladder was banked');
  assert.equal(reg.grantPower('sword', 2), true);
  assert.equal(reg.grantPower('sword', 1), false, 'a lower tier overwrote a higher one');
  assert.equal(reg.tierOf('sword'), 2);
  assert.equal(reg.multiplier('sword'), weaponTierMul(2));
  assert.deepEqual(reg.serialize(), { powers: { sword: 2 } });

  const back = new WeaponRegistry();
  back.deserialize({ powers: { sword: 2, trebuchet: 3, bow: 99 } });
  assert.deepEqual(back.serialize(), { powers: { sword: 2 } },
    'a hand-edited save installed a tier the ladder does not have');
});

test('a weapon tier survives a save round trip without SaveGame changing', async () => {
  /* The ladder rides in `Loadout.serialize()`, which `SaveGame._snapshotWeapons`
   * already stores whole and `_restoreLoadout` already hands back. Both halves
   * are scraped: either one moving would leave a purchase that vanishes on the
   * next reload, silently, with nothing to throw. */
  const save = await readFile(path.join(ROOT, 'src/systems/SaveGame.js'), 'utf8');
  assert.match(save, /loadout\.serialize\?\.\(\)/, 'SaveGame no longer stores the loadout whole');
  assert.match(save, /loadout\.deserialize\?\.\(snap\.custom\)/, 'SaveGame no longer restores it');

  const loadout = await readFile(path.join(ROOT, 'src/player/Loadout.js'), 'utf8');
  assert.match(loadout, /powers: WEAPON_POWERS\.serialize\(\)\.powers/, 'the ladder is not written');
  assert.match(loadout, /WEAPON_POWERS\.deserialize\(\{ powers: data\.powers \}\)/, 'the ladder is not read back');

  stockWeapons();
  WEAPON_POWERS.grantPower('fireball', 2);
  const wire = JSON.parse(JSON.stringify({ powers: WEAPON_POWERS.serialize().powers }));
  stockWeapons();
  assert.equal(WEAPON_STATS.fireball.damage, WEAPON_STATS.fireball.baseDamage);
  WEAPON_POWERS.deserialize(wire);
  assert.equal(round(WEAPON_STATS.fireball.damage), round(WEAPON_STATS.fireball.baseDamage * 1.2));
  stockWeapons();
});

/* ================================================================== */
/* 4. THE COUNTER: rows exist, and refuse what they should             */
/* ================================================================== */

test('the yard stocks every fitting, and every vendor stocks every weapon tier', () => {
  assert.equal(OFFLINE_UPGRADE_ROWS.length, 48, 'thirty-six fittings and twelve weapon tiers');
  const dock = offlineCatalog('dock');
  const ships = dock.filter((r) => r.action_config?.effect === 'grant_ship_power');
  assert.equal(ships.length, 36, 'the yard does not stock the full ladder');
  assert.ok(ships.every((r) => r.category === 'ships'), 'a fitting is not in the ships category');
  /* The `:<world>` suffix the seeder stamps on, so an offline purchase and an
   * online one name the same row. `MarketplaceOffline`'s own note calls this
   * out as the thing a second loop would forget. */
  assert.ok(ships.every((r) => r.id.endsWith(':dock')), 'a generated row lost its world suffix');
  assert.ok(ships.every((r) => r.offline === true), 'a generated row is not marked offline');

  // A fitting is bought where the hull stands, and nowhere else.
  for (const world of ['station', 'medieval', 'citadel', 'sports', 'race']) {
    assert.equal(offlineCatalog(world).filter((r) => r.action_config?.effect === 'grant_ship_power').length, 0,
      `${world} sells a fitting for a hull that is not there`);
    assert.equal(offlineCatalog(world).filter((r) => r.action_config?.effect === 'grant_weapon_power').length, 12,
      `${world} does not stock the weapon ladder, and a weapon is carried, not moored`);
  }
});

test('the counter refuses a fitting it cannot land, and never charges for one', () => {
  const reg = new ShipRegistry({});
  assert.equal(activeShipRegistry(), reg, 'the shop cannot find the registry it must refuse against');
  const row = offlineCatalog('dock').find((r) => r.source_key === 'ship_kestrel_fire_1');
  assert.ok(row, 'the yard does not stock Kestrel Firepower I');

  let balance = 10000;
  const economy = {
    get credits() { return balance; },
    spend: (n) => { if (n > balance) return false; balance -= n; return true; },
    add: (n) => { balance += n; },
  };
  const market = new Marketplace({ economy, ui: false });
  market._catalog = offlineCatalog('dock');

  // A row for a hull that sells nothing is unavailable, not merely unaffordable.
  const hulk = { ...row, id: 'x', action_config: { effect: 'grant_ship_power', ship: 'bastion', power: 'power', tier: 1 } };
  assert.equal(market.preview(hulk).reason, 'unsupported',
    'the shop would have banked a tier on a hulk with no Ship to apply it to');

  // The real one: bought once, refused for ever after.
  const before = balance;
  const res = market.buy(row.id);
  assert.equal(res.ok, true, res.reason);
  assert.equal(balance, before - row.cost_buy, 'the debit does not match the quoted price');
  assert.equal(reg.getPowers('kestrel').fire, 1, 'the credits went and the tier did not arrive');
  assert.equal(market.buy(row.id).reason, 'owned', 'a fitted tier was sold a second time');

  // And the ladder is climbed in order at the counter too.
  const three = offlineCatalog('dock').find((r) => r.source_key === 'ship_kestrel_fire_3');
  market._catalog.push(three);
  assert.equal(market.preview(three).reason, 'owned',
    'tier III sold over an unbought tier II - the two cheap rungs are now unbuyable');
  reg.dispose();
});

test('the counter grants a weapon tier itself, with no handler to go missing', () => {
  stockWeapons();
  let balance = 5000;
  const economy = {
    get credits() { return balance; },
    spend: (n) => { if (n > balance) return false; balance -= n; return true; },
    add: (n) => { balance += n; },
  };
  const seen = [];
  const market = new Marketplace({
    economy, ui: false,
    bus: { on: () => () => {}, emit: (t, p) => seen.push([t, p]) },
  });
  market._catalog = offlineCatalog('station');
  const row = market._catalog.find((r) => r.source_key === 'weapon_bow_damage_1');
  assert.ok(row, 'no bow tier on the shelf');

  const before = balance;
  assert.equal(market.buy(row.id).ok, true);
  assert.equal(balance, before - row.cost_buy);
  assert.equal(WEAPON_POWERS.tierOf('bow'), 1, 'the credits went and the tier did not arrive');
  assert.equal(round(WEAPON_STATS.bow.damage), round(WEAPON_STATS.bow.baseDamage * 1.1),
    'the damage table did not move, so the purchase changed nothing a player can feel');
  assert.ok(seen.some(([t]) => t === 'weapon:power:buy'), 'no receipt for the persist scheduler');

  assert.equal(market.buy(row.id).reason, 'owned', 'the same tier was sold twice');
  const three = market._catalog.find((r) => r.source_key === 'weapon_bow_damage_3');
  assert.equal(market.preview(three).reason, 'owned', 'tier III sold over an unbought tier II');
  stockWeapons();
});

/** Two decimal places. Every one of these is a float product of a x1.1. */
function round(n) {
  return Math.round(n * 100) / 100;
}
