import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lorekeeperScope } from '../../src/npc/NPCManager.js';
import { DEFAULT_LORE, loreEntryForScope } from '../../src/content/Lore.js';

/**
 * Which lore a gateway keeper recites.
 *
 * `NPCManager._spawnLorekeepers` plants one keeper beside every portal in the
 * world. It used to look the lore up under `world.id` for all of them, which is
 * right in five worlds and wrong in the sixth: the station has six gateways to
 * six different places, so a player who walked the whole ring met six people
 * who all recited the same paragraph about the station they were standing in.
 *
 * The obvious fix - key on `spec.target` - is WRONG, and wrong in four worlds
 * at once. Every world other than the station has exactly one portal and it
 * targets `station`, so keying on the target would make the medieval keeper
 * recite station lore in Aldermoor Vale, the citadel keeper recite it in
 * Sunspire, and so on. That is the failure this file exists to make impossible
 * to reintroduce, which is why the negative cases below are as detailed as the
 * positive one.
 *
 * The rule that IS right is derived from the ring rather than named after it:
 * a world whose portals lead to more than one place has a keeper per
 * destination; a world with one destination has a keeper for itself.
 */

/** The station's six, in bearing order, as `_buildGatewayRing` builds them. */
const STATION = {
  id: 'station',
  portalSpecs: [
    { target: 'race' }, { target: 'sports' }, { target: 'maze' },
    { target: 'citadel' }, { target: 'medieval' }, { target: 'survey' },
  ],
};

/** Every other world: one portal, and it goes home. */
const RETURNERS = ['medieval', 'sports', 'citadel', 'race', 'maze'].map((id) => ({
  id,
  portalSpecs: [{ target: 'station' }],
}));

test('at the hub every keeper takes its own gateway destination', () => {
  const scopes = STATION.portalSpecs.map((s) => lorekeeperScope(STATION, s));
  assert.deepEqual(scopes, ['race', 'sports', 'maze', 'citadel', 'medieval', 'survey']);
});

test('the hub keepers are six DIFFERENT scopes, which was the whole defect', () => {
  const scopes = new Set(STATION.portalSpecs.map((s) => lorekeeperScope(STATION, s)));
  assert.equal(scopes.size, 6, `got ${[...scopes].join(', ')}`);
  assert.ok(!scopes.has('station'), 'no keeper on the ring recites the hub back at you');
});

test('a one-portal world keeps its OWN lore, not the portal target', () => {
  for (const w of RETURNERS) {
    const scope = lorekeeperScope(w, w.portalSpecs[0]);
    assert.equal(scope, w.id, `${w.id} keeper drifted to ${scope}`);
    assert.notEqual(scope, 'station', `${w.id} keeper would recite station lore`);
  }
});

test('every scope the rule can produce has a real lore entry behind it', () => {
  // A scope with no entry falls back to the Chronicle, which reads as the
  // question having been forgotten. Gateway 06 is in the table for exactly
  // this reason - see the note on `survey` in content/Lore.js.
  const produced = [
    ...STATION.portalSpecs.map((s) => lorekeeperScope(STATION, s)),
    ...RETURNERS.map((w) => lorekeeperScope(w, w.portalSpecs[0])),
  ];
  for (const scope of produced) {
    assert.ok(DEFAULT_LORE[scope], `no lore entry for "${scope}"`);
    assert.equal(loreEntryForScope(scope).scope, scope);
    assert.ok(String(DEFAULT_LORE[scope].body ?? '').length > 40, `"${scope}" body is a stub`);
  }
});

test('a world with no portals, or a spec with no target, falls back to the world', () => {
  assert.equal(lorekeeperScope({ id: 'sandbox' }, {}), 'sandbox');
  assert.equal(lorekeeperScope({ id: 'sandbox', portalSpecs: [] }, {}), 'sandbox');
  // Two portals to the SAME place is still one destination: a hub is a hub
  // because its gateways disagree, not because it has several.
  const twin = { id: 'twin', portalSpecs: [{ target: 'station' }, { target: 'station' }] };
  assert.equal(lorekeeperScope(twin, twin.portalSpecs[0]), 'twin');
  // Multi-destination but this particular spec is unlabelled: better the
  // world's own lore than undefined.
  assert.equal(lorekeeperScope(STATION, {}), 'station');
});
