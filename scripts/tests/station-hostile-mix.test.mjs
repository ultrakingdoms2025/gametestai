import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NPC_WEAPONS, WEAPON_TABLES, isMelee, pickWeaponId } from '../../src/npc/NPCWeapons.js';

/**
 * The station's hostile weapon mix.
 *
 * `StationWorld._fillSpawns` and `zones/Construction.js` name four archetypes -
 * Rogue Security Unit, Breaker Frame, Skirmish Drone, Arc Lance Sentry - and
 * each of them IS its weapon: the breaker is only a breaker because it carries
 * a baton and has to close, the lance is only a lance because its shot takes
 * most of a second to charge. Those spawns set `weaponId` explicitly, so the
 * archetype survives a change to the theme table; what does NOT survive is a
 * change that removes an id from the station's pool, because `weaponPool` is
 * what a respawned hostile re-rolls from. Take `baton` out of the table and the
 * Breaker Frames quietly become shooters the second they respawn.
 *
 * This pins the properties the encounter design depends on rather than the
 * exact numbers, which are tuning and are allowed to move.
 */

const STATION_IDS = WEAPON_TABLES.station.map(([id]) => id);

test('every id in the station table is a real weapon', () => {
  for (const id of STATION_IDS) {
    assert.ok(NPC_WEAPONS[id], `station table names "${id}", which is not in NPC_WEAPONS`);
    assert.equal(NPC_WEAPONS[id].id, id);
  }
});

test('the station pool carries all four archetype weapons', () => {
  // rifle -> Rogue Security Unit, sidearm -> Skirmish Drone,
  // staff  -> Arc Lance Sentry,   baton   -> Breaker Frame.
  for (const id of ['rifle', 'sidearm', 'staff', 'baton']) {
    assert.ok(STATION_IDS.includes(id), `"${id}" has left the station pool; an archetype respawns wrong`);
  }
});

test('the mix is not all one shape: at least one brawler and three shooters', () => {
  const melee = STATION_IDS.filter(isMelee);
  const ranged = STATION_IDS.filter((id) => !isMelee(id));
  assert.ok(melee.length >= 1, 'nothing on the station closes to contact');
  assert.ok(ranged.length >= 3, 'the station lost its ranged variety');
  // A brawler that can shoot back across a yard is just a shooter.
  for (const id of melee) assert.ok(NPC_WEAPONS[id].range <= 3.2, `${id} reaches ${NPC_WEAPONS[id].range} m`);
  for (const id of ranged) assert.ok(NPC_WEAPONS[id].range >= 15, `${id} only reaches ${NPC_WEAPONS[id].range} m`);
});

test('the shooters hold genuinely different bands, so a fight reads differently', () => {
  const ranged = STATION_IDS.filter((id) => !isMelee(id)).map((id) => NPC_WEAPONS[id]);
  const bands = ranged.map((d) => `${d.preferredMin}-${d.preferredMax}`);
  assert.equal(new Set(bands).size, bands.length, `bands collapsed: ${bands.join(' ')}`);
});

test('damage is paid for with telegraph, which is what keeps it fair', () => {
  // The rule the weapon table's own docstring states: anything that hits hard
  // announces itself first. Checked as a monotonic pairing rather than a
  // constant so retuning damage cannot silently remove the wind-up.
  const sorted = STATION_IDS.map((id) => NPC_WEAPONS[id]).sort((a, b) => a.damage - b.damage);
  const lightest = sorted[0];
  const heaviest = sorted[sorted.length - 1];
  assert.ok(heaviest.damage > lightest.damage * 2, 'the mix has no weight range left');
  assert.ok(
    heaviest.telegraph > lightest.telegraph * 2,
    `${heaviest.id} hits for ${heaviest.damage} on a ${heaviest.telegraph}s wind-up ` +
    `against ${lightest.id}'s ${lightest.damage} on ${lightest.telegraph}s`
  );
});

test('every weight in the station table is positive, so no id is dead in the pool', () => {
  for (const [id, w] of WEAPON_TABLES.station) {
    assert.ok(w > 0, `"${id}" is weighted ${w} and can never be drawn`);
  }
});

test('pickWeaponId only ever returns an id from the theme it was asked for', () => {
  // Deterministic sweep of the whole 0..1 roll rather than a random sample: a
  // weight table whose total disagrees with its rows falls off the end and
  // returns the first row for a band of rolls, which a sample can miss.
  const seen = new Set();
  for (let i = 0; i < 1000; i++) {
    const r = (i + 0.5) / 1000;
    const id = pickWeaponId('station', () => r);
    assert.ok(STATION_IDS.includes(id), `roll ${r} produced "${id}"`);
    seen.add(id);
  }
  assert.equal(seen.size, STATION_IDS.length, `a full sweep never drew ${STATION_IDS.filter((i) => !seen.has(i))}`);
});
