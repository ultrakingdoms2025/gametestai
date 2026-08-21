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
    { target: 'citadel' }, { target: 'medieval' }, { target: 'dock' },
  ],
};

/** Every one-portal world: one portal, and it goes home. */
const RETURNERS = ['medieval', 'sports', 'citadel', 'race', 'maze', 'space'].map((id) => ({
  id,
  portalSpecs: [{ target: id === 'space' ? 'dock' : 'station' }],
}));

/**
 * Lodestar Yard, the first world in the Nexus with TWO destinations.
 *
 * This is the case the rule was derived for and the case that had never
 * existed: `lorekeeperScope` returns the world's own id while its portals name
 * one place and the DESTINATION's id once they name more than one, so the yard
 * gets two keepers reciting `station` and `space` and NEITHER of them recites
 * the yard. That is correct - a keeper beside a gateway is signposting the
 * gateway - and it is also why `DockWorld` authors its own Yard Warden and why
 * `DEFAULT_LORE.space` has to exist at all.
 */
const DOCK = {
  id: 'dock',
  portalSpecs: [{ target: 'station' }, { target: 'space' }],
};

test('at the hub every keeper takes its own gateway destination', () => {
  const scopes = STATION.portalSpecs.map((s) => lorekeeperScope(STATION, s));
  assert.deepEqual(scopes, ['race', 'sports', 'maze', 'citadel', 'medieval', 'dock']);
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

test('the yard has two destinations, so it has two keepers and neither is its own', () => {
  const scopes = DOCK.portalSpecs.map((s) => lorekeeperScope(DOCK, s));
  assert.deepEqual(scopes, ['station', 'space'],
    'the two-target branch is what makes the yard the first non-hub world with a keeper per gateway');
  assert.ok(!scopes.includes('dock'),
    'if a yard keeper ever recites the yard, the rule has stopped being derived from the ring');
});

test('every scope the rule can produce has a real lore entry behind it', () => {
  // A scope with no entry falls back to the Chronicle, which reads as the
  // question having been forgotten. `dock` and `space` are both in the table
  // for exactly this reason - see the notes on them in content/Lore.js. The
  // yard is what makes `space` reachable by this rule at all: it is the only
  // scope in the game produced by a keeper standing in a DIFFERENT world.
  const produced = [
    ...STATION.portalSpecs.map((s) => lorekeeperScope(STATION, s)),
    ...RETURNERS.map((w) => lorekeeperScope(w, w.portalSpecs[0])),
    ...DOCK.portalSpecs.map((s) => lorekeeperScope(DOCK, s)),
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
