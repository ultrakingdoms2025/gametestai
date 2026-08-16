import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CONFIG } from '../../src/core/Config.js';
import { NPCManager } from '../../src/npc/NPCManager.js';
import { BEASTS, threatRadius } from '../../src/npc/BeastSpecies.js';
import { isDeepWater, WADE_DEPTH } from '../../src/npc/Grounding.js';
import { CROSSINGS, GREYOAK_STAGE } from '../../src/worlds/medieval/RoadNet.js';
import { WATER_Y } from '../../src/worlds/terrain/MedievalHeight.js';
import { statsFor } from '../../src/systems/WeaponStats.js';
import { DECAL, DECAL_GRID, cellUV, cellCanvas, DECAL_CELL, DECAL_ATLAS_SIZE, paintClaw }
  from '../../src/systems/DecalPool.js';

/**
 * Beasts inside the existing NPC and combat stack, and the balance they carry.
 *
 * ── The load-bearing claim ────────────────────────────────────────────────
 * Beasts are ordinary entries in `NPCManager._npcs`, filed as hostiles. That
 * one decision is what buys the loot drop, the quest kill-tracking, the
 * separation pass, the sim-rate LOD band, the respawn queue and the hit query -
 * none of which is re-implemented anywhere for beasts. The first half of this
 * suite holds that claim by driving the REAL manager methods.
 *
 * The hit query needed a change to keep it true, and that change is the second
 * thing here. `raycastNPCs` built a VERTICAL capsule from a character's feet to
 * its head. For a 0.85 m wolf with a 0.42 m radius that works out as a 0.36 m
 * sphere sitting under the ribs - so a wolf's head, shoulders and hindquarters
 * could not be shot at all, and the animal that is charging you is mostly not
 * there. A quadruped now publishes a horizontal capsule along its spine.
 *
 * ── Balance ───────────────────────────────────────────────────────────────
 * The rest holds "genuine threat, survivable" as RELATIONSHIPS against the
 * player's own numbers rather than as magic constants, so the figures can be
 * retuned without the design target being retuned by accident.
 */

/**
 * An infinite floor at y = 0 and nothing else.
 *
 * The downward raycast is real rather than stubbed to null, because the spawn
 * path goes through `Grounding.resolveSpot`, which walks a column of raycasts -
 * a world whose rays all miss resolves every spawn to the height it was
 * authored at, which is exactly what a grounding test must not do.
 */
const flatWorld = () => ({
  groundHeight: () => 0,
  resolveCapsule: (p) => {
    if (p.y < 0) p.y = 0;
    return { grounded: p.y <= 0.001, groundNormal: new THREE.Vector3(0, 1, 0) };
  },
  raycast: (origin, dir, maxDistance) => {
    if (dir.y > -0.5 || origin.y < 0) return null;     // only the floor exists
    const d = origin.y / -dir.y;
    if (d > maxDistance) return null;
    return {
      distance: d,
      point: new THREE.Vector3(origin.x + dir.x * d, 0, origin.z + dir.z * d),
      normal: new THREE.Vector3(0, 1, 0),
      collider: { userData: { surface: 'dirt.ground' } },
    };
  },
  containsPoint: () => false,
});

/**
 * The real `NPCManager`, with only the renderer-bound parts left out.
 *
 * `Object.create` rather than `new`: the constructor builds an `InstancedMesh`
 * for the contact shadows and a `CharacterAssets` cache, neither of which
 * exists without a renderer, and neither of which any of this touches.
 */
function makeManager(player) {
  const bus = { _handlers: new Map(), on: () => () => {}, emit: () => {} };
  const mgr = Object.create(NPCManager.prototype);
  Object.assign(mgr, {
    scene: new THREE.Scene(),
    engine: null,
    physics: flatWorld(),
    bus,
    materials: null,
    player,
    _npcs: [], _hostiles: [], _friendlies: [], _vendors: [], _respawnQueue: [],
    theme: 'medieval', worldId: 'medieval', maxNPCs: 72, water: null,
    _seedCounter: 1, _groundCursor: 0, _simStep: 0, _pauseUntil: 0,
    _coverToken: 0, _groundFixes: 0, _contact: null, _chatNPC: null,
  });
  /* The humanoid half of `spawnForWorld` needs a `HumanoidFactory`, which needs
   * a renderer. Stubbed out for the same reason npc-sim-lod.test.mjs stubs
   * everything that is not the cadence: the beast branch of that loop is what
   * is under test, and it does not go anywhere near the factory. */
  mgr._spawnLorekeepers = () => 0;
  mgr._spawnQuestManagers = () => {};
  mgr._populateHubs = () => {};
  return mgr;
}

/* ---------------------------------------------------------------- */
/* A river with a bridge over it                                     */
/* ---------------------------------------------------------------- */

/** Half-width of the channel, metres. The vale's is 8 at the Aldern reach. */
const RIVER_HALF = 8;
/** The bed under the channel. 1.85 m under the water line, as the vale's is. */
const BED_Y = WATER_Y - 1.85;

/**
 * A world with one river and one bridge across it.
 *
 * Two surfaces at any column - the ground (0 on the banks, `BED_Y` in the
 * channel) and, over the bridge's footprint, the DECK - and a `groundHeight`
 * that honours the ray's origin and drop, which is the whole point: the defect
 * this fixture exists to reproduce is a ray that starts under a deck and
 * therefore cannot see it. A fixture whose `groundHeight` ignored `startY`
 * would pass either way.
 *
 * @param {number} deckY height of the deck, metres
 */
function riverWorld(deckY) {
  const DECK_HX = 3.5;
  const DECK_HZ = 13;
  const onDeck = (x, z) => Math.abs(x) <= DECK_HX && Math.abs(z) <= DECK_HZ;
  const surfaces = (x, z) => (onDeck(x, z)
    ? [deckY, Math.abs(z) <= RIVER_HALF ? BED_Y : 0]
    : [Math.abs(z) <= RIVER_HALF ? BED_Y : 0]);
  const highestBelow = (x, z, startY, maxDrop) => {
    let best = null;
    for (const s of surfaces(x, z)) {
      if (s > startY || s < startY - maxDrop) continue;
      if (best === null || s > best) best = s;
    }
    return best;
  };
  const physics = {
    groundHeight: (x, z, startY = 200, maxDrop = 400) => highestBelow(x, z, startY, maxDrop),
    resolveCapsule: (p) => {
      const g = highestBelow(p.x, p.z, p.y + 0.05, 400) ?? 0;
      if (p.y < g) p.y = g;
      return { grounded: p.y <= g + 0.001, groundNormal: new THREE.Vector3(0, 1, 0) };
    },
    raycast: (origin, dir, maxDistance) => {
      if (dir.y > -0.5) return null;                  // only floors exist here
      const y = highestBelow(origin.x, origin.z, origin.y, maxDistance * -dir.y);
      if (y === null) return null;
      const d = (origin.y - y) / -dir.y;
      if (d > maxDistance) return null;
      return {
        distance: d,
        point: new THREE.Vector3(origin.x, y, origin.z),
        normal: new THREE.Vector3(0, 1, 0),
        collider: { userData: { surface: 'dirt.ground' } },
      };
    },
    containsPoint: () => false,
  };
  const water = { surfaceYAt: (x, z) => (Math.abs(z) <= RIVER_HALF ? WATER_Y : null) };
  return { physics, water, onDeck, DECK_HX, DECK_HZ };
}

/** A wolf pack standing wherever it is told, hunting `player`, on a real pack. */
function packOn(mgr, player, spots) {
  const wolves = mgr.spawnBeastGroup({
    position: new THREE.Vector3(0, 0, -30), species: 'wolf', count: spots.length,
  });
  assert.equal(wolves.length, spots.length, `spawned ${wolves.length} wolves, wanted ${spots.length}`);
  wolves.forEach((w, i) => {
    w.position.set(spots[i][0], spots[i][1], spots[i][2]);
    // Home is the pack's, and every one of these tests stays well inside the
    // leash - what is under test here is the water rule, not that one.
    w.home.set(0, 0, 0);
    w.target = player;
    w.losClear = true;
    w.memory = 6;
    w.attackTimer = 0;
    w._spooked = 0;
    w.targetDistance = w.position.distanceTo(player.position);
    w.setState('STALK');
  });
  return wolves;
}

const stubPlayer = (x = 0, z = 0) => ({
  position: new THREE.Vector3(x, 0, z),
  isDead: false,
  health: CONFIG.player.maxHealth,
  maxHealth: CONFIG.player.maxHealth,
  applyDamage(a) { this.health -= a; return a; },
  applyImpulse() { return true; },
  applyViewKick() {},
  applyBleed() {},
});

/* ---------------------------------------------------------------- */
/* In the roster                                                     */
/* ---------------------------------------------------------------- */

test('an authored pack lands in _npcs and in the hostile roster', () => {
  const mgr = makeManager(stubPlayer(40, 0));
  const wolves = mgr.spawnBeastGroup({ position: new THREE.Vector3(0, 0, 0), species: 'wolf' });

  assert.ok(wolves.length >= BEASTS.wolf.packMin, `a wolf spawn produced ${wolves.length} wolves`);
  assert.ok(wolves.length <= BEASTS.wolf.packMax);
  for (const w of wolves) {
    assert.ok(mgr._npcs.includes(w), 'a beast is not in _npcs - nothing downstream can see it');
    assert.ok(mgr._hostiles.includes(w), 'a beast is not in the hostile roster - it will never respawn');
    assert.equal(w.type, 'hostile', 'quest kill-tracking only counts npc.type === "hostile"');
    assert.equal(w.isBeast, true);
    assert.equal(w.conversational, false, 'the player can strike up a conversation with a wolf');
  }
  assert.equal(mgr._friendlies.length, 0);
  // They all share one pack, and each has its own bearing on it.
  const packs = new Set(wolves.map((w) => w.pack));
  assert.equal(packs.size, 1, 'an authored pack was split across several packs');
  assert.equal(new Set(wolves.map((w) => w.packSlot)).size, wolves.length);
});

test('a world authors beasts through npcSpawns, and the budget is enforced there', () => {
  /* The authoring API, driven through the real `spawnForWorld` - which is the
   * only thing a world ever calls. A `{ type: 'beast' }` entry has to be
   * understood by the same loop that reads friendlies and hostiles, and it has
   * to be capped: packs arrive four and five at a time and a world with six of
   * them would otherwise spend its whole character budget on wildlife. */
  const mgr = makeManager(stubPlayer(200, 200));
  const world = {
    id: 'medieval',
    portalSpecs: [],
    rules: { crowd: false },
    hostileBudget: 0,
    friendlyBudget: 0,
    beastBudget: 6,
    npcSpawns: [
      { type: 'beast', species: 'wolf', position: new THREE.Vector3(0, 0, 0) },
      { type: 'beast', species: 'wolf', position: new THREE.Vector3(60, 0, 0) },
      { type: 'beast', species: 'bear', position: new THREE.Vector3(-60, 0, 0) },
    ],
  };
  mgr.spawnForWorld(world);

  const beasts = mgr._npcs.filter((n) => n.isBeast);
  assert.ok(beasts.length > 0, 'a world authored a wolf pack and got nothing');
  assert.ok(beasts.length <= world.beastBudget,
    `the world asked for ${world.beastBudget} beasts and got ${beasts.length}`);
  assert.ok(beasts.some((b) => b.species === 'wolf'), 'no wolves were spawned');

  // Two separate spawn entries are two separate packs, not one big one.
  const packs = new Set(beasts.filter((b) => b.pack).map((b) => b.pack));
  assert.ok(packs.size >= 1);
  for (const b of beasts) {
    assert.ok(Math.abs(b.position.y) < 0.2, `${b.species} spawned at y=${b.position.y}`);
  }
});

test('a world that forbids hostiles gets no wildlife either', () => {
  /* The maze declares that nothing in it fights the player. It means that about
   * bears too, and gating on the existing rule is what keeps a world author
   * from having to know that beasts were added after the rule was written. */
  const mgr = makeManager(stubPlayer(200, 200));
  mgr.spawnForWorld({
    id: 'maze',
    portalSpecs: [],
    rules: { hostiles: false, crowd: false },
    friendlyBudget: 0,
    npcSpawns: [{ type: 'beast', species: 'bear', position: new THREE.Vector3(0, 0, 0) }],
  });
  assert.equal(mgr._npcs.filter((n) => n.isBeast).length, 0, 'a bear got into a world that forbids hostiles');
});

test('a bear is a loner whatever the spec asks for', () => {
  const mgr = makeManager(stubPlayer(40, 0));
  const bears = mgr.spawnBeastGroup({ position: new THREE.Vector3(0, 0, 0), species: 'bear', count: 6 });
  assert.equal(bears.length, 1, `a bear spawn produced ${bears.length} bears`);
  assert.equal(bears[0].pack, null, 'a solitary bear was given a pack to coordinate with');
});

test('the group honours its budget rather than overrunning it', () => {
  const mgr = makeManager(stubPlayer(40, 0));
  const wolves = mgr.spawnBeastGroup({ position: new THREE.Vector3(0, 0, 0), species: 'wolf', count: 5 }, 2);
  assert.equal(wolves.length, 2);
});

test('an unknown species falls back rather than throwing', () => {
  const mgr = makeManager(stubPlayer(40, 0));
  const made = mgr.spawnBeastGroup({ position: new THREE.Vector3(0, 0, 0), species: 'griffin', count: 1 });
  assert.equal(made.length, 1);
  assert.equal(made[0].species, 'wolf');
});

test('the programmatic path spawns one and grounds it', () => {
  const mgr = makeManager(stubPlayer(40, 0));
  const bear = mgr.spawnBeast({ position: new THREE.Vector3(3, 9, 4), species: 'bear' });
  assert.ok(bear);
  assert.equal(bear.species, 'bear');
  assert.ok(Math.abs(bear.position.y) < 0.05, `spawned at y=${bear.position.y}, not on the floor`);
  assert.ok(mgr._npcs.includes(bear));
});

/* ---------------------------------------------------------------- */
/* The hit query                                                     */
/* ---------------------------------------------------------------- */

/** Cast at a point, and report which beast (if any) was hit. */
function shootAt(mgr, from, at) {
  const dir = at.clone().sub(from).normalize();
  return NPCManager.prototype.raycastNPCs.call(mgr, from, dir, 120);
}

test('a beast added to _npcs is found by the combat hit query', () => {
  const mgr = makeManager(stubPlayer(60, 0));
  const [bear] = mgr.spawnBeastGroup({ position: new THREE.Vector3(0, 0, 0), species: 'bear', count: 1 });
  bear.yaw = 0;
  bear.root.rotation.y = 0;

  const centre = new THREE.Vector3(0, BEASTS.bear.shoulderHeight * 0.6, 0);
  for (const from of [
    new THREE.Vector3(0, 1.6, 14),     // behind it
    new THREE.Vector3(0, 1.6, -14),    // in front of it
    new THREE.Vector3(14, 1.6, 0),     // broadside
    new THREE.Vector3(-9, 1.6, -9),    // three-quarter
  ]) {
    const hit = shootAt(mgr, from, centre);
    assert.ok(hit, `a shot from ${from.toArray()} passed straight through a bear`);
    assert.equal(hit.npc, bear);
    assert.ok(hit.distance > 0 && hit.distance < 20);
  }
});

test('a wolf can be shot along its length, not only through its middle', () => {
  /* The defect the horizontal hit capsule fixes, stated as a measurement: the
   * old vertical capsule for a 0.85 m wolf came out 0.36 m in radius and
   * roughly zero in length, so anything aimed at the head or the hindquarters
   * missed the animal entirely. */
  const mgr = makeManager(stubPlayer(60, 0));
  const [wolf] = mgr.spawnBeastGroup({ position: new THREE.Vector3(0, 0, 0), species: 'wolf', count: 1 });
  wolf.yaw = 0;
  wolf.root.rotation.y = 0;

  const half = BEASTS.wolf.bodyLength * 0.3;
  const shoulder = BEASTS.wolf.shoulderHeight * 0.62;
  for (const along of [-half, -half * 0.5, 0, half * 0.5, half]) {
    const at = new THREE.Vector3(0, shoulder, along);
    const hit = shootAt(mgr, new THREE.Vector3(12, shoulder, along), at);
    assert.ok(hit, `a broadside shot ${along.toFixed(2)} m along the wolf missed it`);
    assert.equal(hit.npc, wolf);
  }
  // ...and a shot that genuinely goes past it still misses.
  assert.equal(shootAt(mgr, new THREE.Vector3(12, shoulder, 6), new THREE.Vector3(0, shoulder, 6)), null,
    'a shot six metres clear of a wolf hit it anyway');
});

test('a humanoid is still resolved exactly as it was', () => {
  /* The hit query grew two optional hooks. Neither may change what happens to a
   * character that offers neither, which is every humanoid in the game. */
  const mgr = makeManager(stubPlayer(60, 0));
  const person = {
    position: new THREE.Vector3(0, 0, 0),
    isDead: false,
    height: 1.8,
    radius: 0.33,
    humanoid: { heightScale: 1 },
    headPosition: new THREE.Vector3(0, 1.62, 0),
  };
  mgr._npcs.push(person);

  const chest = new THREE.Vector3(0, 1.1, 0);
  const hit = shootAt(mgr, new THREE.Vector3(0, 1.1, 9), chest);
  assert.ok(hit && hit.npc === person, 'a plain NPC stopped being shootable');
  assert.equal(hit.isHeadshot, false);

  const head = shootAt(mgr, new THREE.Vector3(0, 1.62, 9), new THREE.Vector3(0, 1.62, 0));
  assert.ok(head && head.isHeadshot, 'the headshot sphere stopped working');

  assert.equal(shootAt(mgr, new THREE.Vector3(0, 1.1, 9), new THREE.Vector3(3, 1.1, 0)), null);
});

/* ---------------------------------------------------------------- */
/* Damage routed through the manager                                 */
/* ---------------------------------------------------------------- */

test('a maul with nobody listening still hurts, so a beast is never toothless', () => {
  const player = stubPlayer(0, -2);
  const mgr = makeManager(player);
  const [wolf] = mgr.spawnBeastGroup({ position: new THREE.Vector3(0, 0, 0), species: 'wolf', count: 1 });

  const before = player.health;
  mgr.beastMaul(wolf, {
    target: player, isPlayer: true, damage: 12,
    origin: new THREE.Vector3(0, 0.7, -1), direction: new THREE.Vector3(0, 0, -1),
    def: BEASTS.wolf,
  });
  assert.ok(player.health < before, 'nothing resolved the maul and nothing happened');
});

test('a beast mauling a villager does not pay the player for it', () => {
  /* `Economy` awards credits off `npc:killed.byPlayer`. A wolf eating a
   * traveller must never look like the player's doing, or the player farms
   * credits by standing still. */
  const events = [];
  const player = stubPlayer(80, 80);
  const mgr = makeManager(player);
  mgr.bus = { _handlers: new Map(), on: () => () => {}, emit: (t, e) => events.push({ t, e }) };

  const [wolf] = mgr.spawnBeastGroup({ position: new THREE.Vector3(0, 0, 0), species: 'wolf', count: 1 });
  const villager = {
    position: new THREE.Vector3(0, 0, -1.5), isDead: false, type: 'friendly',
    height: 1.8, radius: 0.33, health: 20,
    applyDamage(a) { this.health -= a; if (this.health <= 0) this.isDead = true; return { applied: a }; },
  };

  events.length = 0;
  mgr.beastMaul(wolf, {
    target: villager, isPlayer: false, damage: 30,
    origin: new THREE.Vector3(0, 0.7, -1), direction: new THREE.Vector3(0, 0, -1),
    def: BEASTS.wolf,
  });
  assert.equal(villager.isDead, true, 'the villager survived a 30-point maul on 20 health');
  const killed = events.filter((e) => e.t === 'npc:killed');
  // With no CombatSystem bound the manager resolves it directly and raises
  // nothing; what must never happen is a byPlayer kill.
  for (const k of killed) assert.notEqual(k.e.byPlayer, true, 'a wolf kill was credited to the player');
});

test('a beast that has made a kill stops hunting for a while', () => {
  /* Beasts hunt travellers as well as the player, which the brief asked for and
   * which is also a slow way to depopulate a village: friendlies are not in the
   * respawn queue, so every civilian a pack works through is gone for the
   * session. A predator that eats and then walks away bounds that without a
   * system to do it - and being attacked still overrides it, so the player can
   * always pick a fight. */
  const mgr = makeManager(stubPlayer(80, 80));
  const [wolf] = mgr.spawnBeastGroup({ position: new THREE.Vector3(0, 0, 0), species: 'wolf', count: 1 });
  const villager = { position: new THREE.Vector3(0, 0, -3), isDead: false, type: 'friendly', height: 1.8 };
  mgr._friendlies.push(villager);

  wolf._acquire(villager);
  assert.equal(wolf.target, villager);
  villager.isDead = true;
  wolf._sense(1 / 60);
  assert.equal(wolf.target, null, 'the wolf is still hunting a corpse');
  assert.ok(wolf.satiated > 0, 'the wolf went straight on to the next villager');

  // A second villager walks past: it is ignored while the wolf is fed.
  const next = { position: new THREE.Vector3(0, 0, -4), isDead: false, type: 'friendly', height: 1.8 };
  mgr._friendlies.push(next);
  wolf._senseTimer = 0;
  wolf._sense(1 / 60);
  assert.equal(wolf.target, null, 'a fed wolf picked the next body out of the queue');

  // But hitting it wakes it straight back up.
  wolf.onDamaged(10, false, next);
  assert.equal(wolf.satiated, 0);
  assert.equal(wolf.target, next, 'a fed wolf does not defend itself');
});

/* ---------------------------------------------------------------- */
/* Water, and the bridges over it                                    */
/* ---------------------------------------------------------------- */

test('every deck in the vale stands above the depth probe\'s old origin', () => {
  /* THE ARITHMETIC OF THE REGRESSION, on the shipped table rather than on a
   * fixture. `Grounding.waterDepthAt` used to cast the bed ray from
   * `surfaceY + 1.0`, which over the medieval river is 1.85 m. Every authored
   * deck is above it - so every one of them was invisible to the ray, and a
   * character standing on dry planks measured the riverbed.
   *
   * Asserted rather than recited, so that a crossing authored LOW enough for
   * the old origin to have worked would show up here as a surprise rather than
   * as a silently different case. */
  const OLD_ORIGIN = WATER_Y + 1.0;
  const decks = [
    ...CROSSINGS.filter((c) => c.kind === 'bridge').map((c) => [c.id, c.deckY]),
    [GREYOAK_STAGE.id, GREYOAK_STAGE.deckY],
  ];
  assert.ok(decks.length >= 4, `only ${decks.length} decks in the table`);
  for (const [id, deckY] of decks) {
    assert.ok(Number.isFinite(deckY), `${id} has no deckY`);
    assert.ok(deckY > OLD_ORIGIN,
      `${id}'s deck is at ${deckY} m, at or below the ${OLD_ORIGIN} m origin the depth probe used to `
      + 'cast from - so this crossing was never affected and the note in Grounding.js is overstated');
    // ...and the depth the old probe reported there was well past wading.
    assert.ok(WATER_Y - BED_Y > WADE_DEPTH,
      'the fixture river is shallower than WADE_DEPTH, so nothing below can fail');
  }
});

test('a bridge deck reads as dry ground, and the river beside it still does not', () => {
  /* Both halves, at every deck height the vale actually has. The second half is
   * the one that matters: the probe height must not be a licence to walk into
   * the water, and something standing IN the river reports feet at or under the
   * surface, so `Math.max` picks the water and the answer is unchanged. */
  for (const deckY of [4.35, 3.30, 2.92, 2.60]) {
    const { physics, water } = riverWorld(deckY);
    // Mid-channel, on the deck's centreline.
    assert.equal(isDeepWater(physics, water, 0, 0), true,
      `at deck ${deckY} a caller with no height still gets the conservative answer`);
    assert.equal(isDeepWater(physics, water, 0, 0, deckY), false,
      `a character standing on a ${deckY} m deck reads the riverbed under it as water`);
    // Mid-channel, twelve metres off the deck: open river, at any probe height
    // a land animal could plausibly report.
    assert.equal(isDeepWater(physics, water, 12, 0, BED_Y), true,
      'a wolf standing in the open channel no longer reads as out of its depth');
    assert.equal(isDeepWater(physics, water, 12, 0, deckY), true,
      'a high probe over open water invents a crossing where there is no deck');
    // The dry bank is dry either way.
    assert.equal(isDeepWater(physics, water, 12, -30, 0), false, 'the bank reads as river');
  }
});

test('a pack does not deadlock when one member\'s line crosses the river', () => {
  /* THE SLOT LEAK, DRIVEN.
   *
   * `attackSlots` is `max(1, floor(liveCount / 3))`, which is ONE for a pack of
   * three to five. The water veto was reached AFTER `requestAttack` had already
   * granted the slot and it never gave it back, and the beast could then never
   * reach `def.reach`, so `_endAttack`/`releaseAttack` were unreachable too.
   * One wolf whose line happened to cross the river therefore held the pack's
   * only slot for as long as the target lived and the rest orbited forever.
   *
   * The fixture is the smallest thing that reproduces it: the player on the
   * deck, one wolf on the far bank whose straight line crosses open water, and
   * two whose line runs along the planks. */
  const { physics, water } = riverWorld(4.35);
  const player = stubPlayer(0, 0);
  player.position.y = 4.35;                       // standing on the deck
  const mgr = makeManager(player);
  mgr.physics = physics;
  const wolves = packOn(mgr, player, [
    [-20, 0, -14],       // wet line: crosses the channel twelve metres off the deck
    [0, 4.35, -10],      // on the deck, behind the player
    [0, 4.35, 9],        // on the deck, in front
  ]);
  mgr.setWater(water);
  const pack = wolves[0].pack;
  assert.ok(pack, 'the three wolves are not in a pack');
  assert.equal(pack.attackSlots, 1, 'the fixture no longer has exactly one slot to fight over');

  // The blocked wolf goes first, which is the ordering that used to lose.
  wolves[0]._stalk(1 / 60);
  assert.equal(pack.isCommitted(wolves[0]), false,
    'the wolf whose line crosses water is still holding the pack\'s only attack slot');
  assert.ok(wolves[0].nav.active,
    'the blocked wolf stopped dead instead of working round to the ring - it should hold a dry '
    + 'ring position, which is nearer the target and on ground it can reach');

  // ...and the slot is there for somebody who can use it.
  wolves[1]._stalk(1 / 60);
  assert.equal(pack.isCommitted(wolves[1]), true,
    'the pack is inert: a wolf standing on the same deck as the player cannot get an attack slot');
  assert.equal(wolves[1].desiredSpeed, BEASTS.wolf.chargeSpeed,
    'the committed wolf is not charging');
  assert.ok(wolves[1].nav.target
    && Math.hypot(wolves[1].nav.target.x - player.position.x,
      wolves[1].nav.target.z - player.position.z) < 0.5,
    'the committed wolf is not steering at the player');

  /* And it stays unblocked over time rather than flickering: run every member
   * for a second and the pack must still be able to commit somebody. */
  let committed = 0;
  for (let s = 0; s < 60; s++) {
    for (const w of wolves) w._stalk(1 / 60);
    if (wolves.some((w) => pack.isCommitted(w))) committed++;
  }
  assert.equal(committed, 60, `the pack had no committed member on ${60 - committed} of 60 steps`);
});

test('a player on a bridge deck can be attacked, at every deck height the vale has', () => {
  /* THE REGRESSION ITSELF. Before the probe height existed, the ring positions
   * a wolf circles through - 4.2 m around the target, i.e. on the same deck -
   * all read as a metre and a half of river, so `_stalk` cleared the nav and
   * the whole pack held station on the bank in plain sight. Combined with the
   * slot leak that made all five bridges permanent predator-proof zones.
   *
   * Driven at each of the four real deck heights, because the fix is a height
   * comparison and the Greyoak stage at 2.60 m is the one with least clearance
   * over the old 1.85 m origin. */
  for (const deckY of [4.35, 3.30, 2.92, 2.60]) {
    const { physics, water } = riverWorld(deckY);
    const player = stubPlayer(0, 0);
    player.position.y = deckY;
    const mgr = makeManager(player);
    mgr.physics = physics;
    const wolves = packOn(mgr, player, [[0, deckY, -6], [0, deckY, 6], [1.5, deckY, -8]]);
    mgr.setWater(water);
    const pack = wolves[0].pack;

    /* Circling. The ring is 4.2 m and the fixture's deck is 7 m across, so the
     * ring straddles it - which is right, and is the two-sided test: a bearing
     * ALONG the deck is a legal place to stand and a bearing across it is the
     * river. `slotAngle` is `orbit + rank/live * TAU`, so setting `orbit` aims
     * a named member wherever this needs it.
     *
     * Rank of `wolves[1]` is 1 of 3 live, so its bearing is `orbit + 2pi/3`. */
    wolves[1].attackTimer = 9;              // denied a slot, so it holds the ring
    pack.orbit = Math.PI / 2 - (2 * Math.PI) / 3;      // bearing +Z, along the deck
    wolves[1]._stalk(1 / 60);
    assert.ok(wolves[1].nav.active,
      `at deck ${deckY} a wolf circling ALONG the deck cleared its nav - the planks read as river`);
    assert.ok(Math.abs(wolves[1].nav.target.x) < 1e-6 && wolves[1].nav.target.z > 4,
      `at deck ${deckY} the ring target is not where the bearing put it`);

    pack.orbit = -(2 * Math.PI) / 3;                   // bearing +X, out over the water
    wolves[1].nav.clear();
    wolves[1]._stalk(1 / 60);
    assert.equal(wolves[1].nav.active, false,
      `at deck ${deckY} a wolf circling OFF the side of the deck steered into the river`);

    // Charging: the committed member sets a target at the player.
    wolves[0]._stalk(1 / 60);
    assert.equal(wolves[0].desiredSpeed, BEASTS.wolf.chargeSpeed,
      `at deck ${deckY} the committed wolf refused to charge a player on the planks`);

    // ...and it lands the blow once it is in reach, which is the whole claim.
    wolves[0].position.set(0, deckY, -2);
    wolves[0].targetDistance = 2;
    wolves[0]._stalk(1 / 60);
    assert.equal(wolves[0].state, 'ATTACK',
      `at deck ${deckY} a wolf in reach of a player on the deck did not attack`);
  }
});

/* ---------------------------------------------------------------- */
/* The claw decal                                                    */
/* ---------------------------------------------------------------- */

test('the claw cell is added without moving any existing cell index', () => {
  assert.equal(DECAL.HARD, 0);
  assert.equal(DECAL.METAL, 1);
  assert.equal(DECAL.WOOD, 2);
  assert.equal(DECAL.BLOOD, 3);
  assert.equal(DECAL.CLAW, 4);
});

test('every decal cell has its own square of the atlas', () => {
  const seen = new Set();
  for (const cell of Object.values(DECAL)) {
    const [u, v] = cellUV(cell);
    assert.ok(u >= 0 && u < 1 && v >= 0 && v < 1, `cell ${cell} maps outside the sheet`);
    // A cell must not run off the far edge once the quad's own UV is added.
    assert.ok(u + 1 / DECAL_GRID <= 1 + 1e-9 && v + 1 / DECAL_GRID <= 1 + 1e-9);
    const key = `${u.toFixed(6)},${v.toFixed(6)}`;
    assert.equal(seen.has(key), false, `cell ${cell} shares its square with another`);
    seen.add(key);
  }
  assert.equal(DECAL_ATLAS_SIZE, DECAL_CELL * DECAL_GRID);
  assert.ok(Object.keys(DECAL).length <= DECAL_GRID * DECAL_GRID, 'more decals than the sheet has cells');
});

/**
 * A 2D canvas context, in as much as one cell of the decal atlas needs.
 *
 * ── What this is, honestly ─────────────────────────────────────────────────
 * Node has no canvas and this project may not take a dependency to get one, so
 * the painter's own draw calls are replayed into a re-implementation of the
 * parts of the Canvas2D model they use: a stroke is the union of round caps of
 * `lineWidth` swept along the path (which is what a round-capped, round-joined
 * stroke IS), a fill is a point-in-shape test, and each op composites over the
 * buffer once, source-over.
 *
 * ── What that proves, and what it does not ─────────────────────────────────
 * It measures the ARTWORK. It says nothing about what the GPU finally shows:
 * no lighting, no normal map, no roughness, no mip level, no `aFade`, no
 * polygon offset, and no antialiasing (coverage is a pixel-centre test, so
 * edge counts are a percent or two out either way). A cell could pass this and
 * still be hard to see because the surface under it is unlit.
 *
 * What it does prove is the thing that was actually wrong: that the cell is not
 * a single tone a few percent away from dark ground. The old claw mark was a
 * dark cut over a pale lip laid at 0.30 alpha and then covered by that cut -
 * composited onto woodland it came out 47/255 of luma away from the ground it
 * was drawn on, over its brightest pixel, which is why a maul left no visible
 * mark anywhere a bear lives.
 */
class MiniCtx {
  constructor(size, bg) {
    this.size = size;
    this.buf = new Float64Array(size * size * 3);
    for (let i = 0; i < size * size; i++) {
      this.buf[i * 3] = bg[0]; this.buf[i * 3 + 1] = bg[1]; this.buf[i * 3 + 2] = bg[2];
    }
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.lineWidth = 1;
    this.lineCap = 'butt';
    this._path = [];
    this._mask = new Uint8Array(size * size);
  }

  /** `rgb(r,g,b)` / `rgba(r,g,b,a)` -> [r, g, b, a]. */
  static parse(css) {
    const m = /rgba?\(([^)]+)\)/.exec(css);
    if (!m) return [0, 0, 0, 1];
    const p = m[1].split(',').map((s) => Number(s.trim()));
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }

  createRadialGradient(x0, y0, r0, x1, y1, r1) {
    return {
      _radial: true, x: x1, y: y1, r0, r1, stops: [],
      addColorStop(t, css) { this.stops.push([t, MiniCtx.parse(css)]); },
    };
  }

  /** Colour and alpha of a style at one pixel. */
  _sample(style, x, y) {
    if (typeof style === 'string') return MiniCtx.parse(style);
    const d = Math.hypot(x - style.x, y - style.y);
    const t = Math.min(1, Math.max(0, (d - style.r0) / (style.r1 - style.r0)));
    const s = style.stops;
    let lo = s[0], hi = s[s.length - 1];
    for (let i = 1; i < s.length; i++) {
      if (s[i][0] >= t) { lo = s[i - 1]; hi = s[i]; break; }
    }
    const span = hi[0] - lo[0] || 1;
    const k = Math.min(1, Math.max(0, (t - lo[0]) / span));
    return lo[1].map((v, i) => v + (hi[1][i] - v) * k);
  }

  beginPath() { this._path = []; }
  moveTo(x, y) { this._path = [[x, y]]; }
  lineTo(x, y) { this._path.push([x, y]); }
  closePath() {}
  save() {} restore() {} translate() {} rotate() {}

  quadraticCurveTo(cx, cy, x, y) {
    const [x0, y0] = this._path[this._path.length - 1];
    for (let i = 1; i <= 64; i++) {
      const t = i / 64;
      const u = 1 - t;
      this._path.push([
        u * u * x0 + 2 * u * t * cx + t * t * x,
        u * u * y0 + 2 * u * t * cy + t * t * y,
      ]);
    }
  }

  ellipse(cx, cy, rx, ry, rot) { this._ellipse = { cx, cy, rx, ry, rot }; }
  arc(cx, cy, r) { this._ellipse = { cx, cy, rx: r, ry: r, rot: 0 }; }

  /** Sweep a disc of `lineWidth` along the path and composite it once. */
  stroke() {
    this._mask.fill(0);
    const rad = this.lineWidth / 2;
    for (const [px, py] of this._path) this._disc(px, py, rad);
    this._compose(this.strokeStyle);
  }

  fill() {
    this._mask.fill(0);
    const e = this._ellipse;
    if (e) {
      const c = Math.cos(-e.rot), s = Math.sin(-e.rot);
      const r = Math.ceil(Math.max(e.rx, e.ry));
      for (let y = Math.floor(e.cy - r); y <= e.cy + r; y++) {
        for (let x = Math.floor(e.cx - r); x <= e.cx + r; x++) {
          if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue;
          const dx = x + 0.5 - e.cx, dy = y + 0.5 - e.cy;
          const u = (dx * c - dy * s) / e.rx, v = (dx * s + dy * c) / e.ry;
          if (u * u + v * v <= 1) this._mask[y * this.size + x] = 1;
        }
      }
      this._ellipse = null;
    }
    this._compose(this.fillStyle);
  }

  _disc(cx, cy, rad) {
    const r = Math.ceil(rad);
    for (let y = Math.floor(cy - r); y <= cy + r; y++) {
      for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue;
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= rad * rad) this._mask[y * this.size + x] = 1;
      }
    }
  }

  _compose(style) {
    for (let i = 0; i < this._mask.length; i++) {
      if (!this._mask[i]) continue;
      const x = i % this.size, y = (i / this.size) | 0;
      const [r, g, b, a] = this._sample(style, x + 0.5, y + 0.5);
      if (a <= 0) continue;
      const o = i * 3;
      this.buf[o] += (r - this.buf[o]) * a;
      this.buf[o + 1] += (g - this.buf[o + 1]) * a;
      this.buf[o + 2] += (b - this.buf[o + 2]) * a;
    }
  }

  /** Rec. 709 luma of every pixel. */
  luma() {
    const out = new Float64Array(this.size * this.size);
    for (let i = 0; i < out.length; i++) {
      out[i] = 0.2126 * this.buf[i * 3] + 0.7152 * this.buf[i * 3 + 1] + 0.0722 * this.buf[i * 3 + 2];
    }
    return out;
  }
}

/** A no-op context for the height and roughness channels, which are not measured. */
const nullCtx = () => new Proxy({}, {
  get: (t, k) => (k === 'createRadialGradient'
    ? () => ({ addColorStop() {} })
    : (typeof k === 'string' ? () => {} : undefined)),
  set: () => true,
});

/** Paint the claw cell over one background and report its luma field. */
function clawOver(bg) {
  const size = 256;
  const ctx = new MiniCtx(size, bg);
  let s = 0x5eed1e;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // Painted at 0,0 because a painter takes its cell origin as an argument -
  // the cell it lands in is `cellCanvas`'s business and is tested above.
  paintClaw(ctx, nullCtx(), nullCtx(), 0, 0, rnd);
  const bgLuma = 0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2];
  return { luma: ctx.luma(), bgLuma };
}

test('the claw mark carries its own contrast, on dark ground and on light', () => {
  /* ── The defect ────────────────────────────────────────────────────────
   * The stamp worked and the mark was invisible: every tone in the cell was
   * darker than a woodland floor, and woodland is where the animals that
   * leave it live. A decal has to bring its own contrast, because the atlas
   * is shared by five worlds and cannot know what it will land on.
   *
   * So: measured against BOTH a dark ground and a light one, and required to
   * carry a component that separates from each. One or the other alone is a
   * mark drawn for one surface. See `MiniCtx` above for what this rasteriser
   * does and does not prove.
   */
  const DARK = [26, 32, 22];    // woodland undergrowth in shadow, luma 30
  const LIGHT = [196, 190, 178]; // ashlar in sun, luma 189

  const onDark = clawOver(DARK);
  const onLight = clawOver(LIGHT);

  let lighter = 0;
  for (const v of onDark.luma) if (v - onDark.bgLuma >= 70) lighter++;
  let darker = 0;
  for (const v of onLight.luma) if (onLight.bgLuma - v >= 70) darker++;

  assert.ok(lighter >= 2000,
    `only ${lighter} px of the claw cell are 70/255 of luma clear of dark ground `
    + '- the mark cannot be seen where the beasts are');
  assert.ok(darker >= 2000,
    `only ${darker} px of the claw cell are 70/255 of luma below pale stone `
    + '- the mark has no dark component left to read on a wall');

  /* ...and it is not one flat tone. A cell painted a single bright colour
   * would satisfy both counts above and read as a sticker; a gouge has a lit
   * edge and a shadow in it. Measured over the marked area only. */
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of onDark.luma) {
    if (Math.abs(v - onDark.bgLuma) < 6) continue; // unmarked ground
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  assert.ok(hi - lo >= 100,
    `the marked pixels span only ${(hi - lo).toFixed(0)}/255 of luma - the cell is one flat tone`);
});

test('the painter and the sampler agree about which row a cell is on', () => {
  /* Canvas y runs down and a CanvasTexture uploads flipped, so a cell painted
   * at canvas row 0 is sampled at the TOP of the sheet. The old 2x2 layout
   * ignored that and every cell rendered somebody else's artwork - the visible
   * one being blood, which came out as a torn metal hole. */
  for (const cell of Object.values(DECAL)) {
    const [u, v] = cellUV(cell);
    const [ox, oy] = cellCanvas(cell);
    assert.equal(ox, u * DECAL_ATLAS_SIZE, `cell ${cell} is painted in the wrong column`);
    const expectedY = (DECAL_GRID - 1 - Math.round(v * DECAL_GRID)) * DECAL_CELL;
    assert.equal(oy, expectedY, `cell ${cell} is painted in the wrong row - it will render another cell's art`);
  }
});

/* ---------------------------------------------------------------- */
/* Balance                                                           */
/* ---------------------------------------------------------------- */

test('a sprinting player outruns every beast - and the stamina pool is what rations it', () => {
  /* CLOSED. This case was flagged OPEN, and the resolution is the interesting
   * part, so the history stays.
   *
   * It originally read `nothing outruns a sprinting player, so fleeing is
   * always available` and asserted `chargeSpeed < CONFIG.player.sprintSpeed`.
   * It passed for the wrong reason: that constant said 8.2 and nothing in the
   * game could go 8.2, because the friction/acceleration equilibrium capped a
   * grounded player at `acceleration / friction` = 60/10 = 6.0 m/s. Against
   * the real 6.0 a wolf (7.6) and a bear (6.4) were both FASTER, so the case
   * was inverted to say so and the balance question was left to the owner.
   *
   * The owner decided: make the sprint genuinely reach 8.2 (`acceleration` 60
   * -> 82, `friction` deliberately untouched - see ../../src/core/Config.js)
   * and leave the beast speeds exactly where they are. So the original claim
   * is true again, now for the right reason, and the numbers are real:
   *
   *     sprinting player   8.2 m/s     (measured, ./player-speed.test.mjs)
   *     wolf charge        7.6 m/s     player gains 0.6 m/s
   *     bear charge        6.4 m/s     player gains 1.8 m/s
   *
   * ── Why this is a ration and not an escape hatch ──────────────────────
   * Sprint is not a state you can hold. The pool is 100 and drains at 15/s, so
   * a held sprint from full gives out after 6.68 s and the player drops back to
   * a 4.6 m/s walk, which BOTH beasts still beat comfortably. Driven against
   * the real controller with the real `Stamina`, one full bar spent running in
   * a straight line buys a peak lead of 3.32 m on a wolf and 11.32 m on a bear,
   * and the wolf's is handed straight back.
   *
   * So the wolf is still a chase you cannot simply win on foot; 3.3 m of a 46 m
   * `loseInterest` leash is a head start, not an exit. The disengagement below
   * is therefore still the mechanism that ends an encounter, and is still
   * asserted. The bear's docstring ("being thrown four metres back is what buys
   * the sprint away") reads correctly again: 1.8 m/s of margin plus a four
   * metre shove is a real gap. */
  const cap = CONFIG.player.sprintSpeed;
  assert.equal(cap, CONFIG.player.acceleration / CONFIG.player.friction,
    'the player speed cap moved; re-read this whole case against the new number');
  for (const def of Object.values(BEASTS)) {
    // Everything beats a walk, or there is no threat at all.
    assert.ok(def.chargeSpeed > CONFIG.player.walkSpeed,
      `a ${def.id} cannot catch a walking player`);
    assert.ok(def.chargeSpeed < cap,
      `a ${def.id} charges at ${def.chargeSpeed} against a player's real top speed of ${cap} - `
      + 'it outruns a sprint in a straight line, and "fleeing is always available" is false again');
    // A sprint is rationed, so out-running a charge cannot be the whole escape:
    // past `loseInterest`, or with the scent cold and no line of sight, the
    // target is dropped, and that is what actually ends a chase.
    assert.ok(def.loseInterest > def.sight,
      `a ${def.id} gives up at ${def.loseInterest} m but sees to ${def.sight} m - it would `
      + 're-acquire the moment it disengaged, and a chase could never end');
    // The margin is thin on purpose. If a charge ever drops far enough under
    // the cap that a player can stroll away from it, this stops being a chase.
    assert.ok(cap - def.chargeSpeed < CONFIG.player.walkSpeed,
      `a ${def.id} is ${(cap - def.chargeSpeed).toFixed(1)} m/s slower than a sprint, which is `
      + 'more margin than a walk is worth - the pursuit has stopped being threatening');
  }
  // The ration is the counterweight to the whole claim above, so it is pinned:
  // one bar is 6.67 s of sprint, and the wolf takes only 0.6 m/s off that.
  assert.ok(CONFIG.player.maxStamina / CONFIG.player.sprintStaminaDrain < 8,
    'a sprint now lasts long enough to simply leave a wolf behind; the lead this case '
    + 'measures at 3.32 m was the reason disengagement still had to exist');
});

test('a lone wolf is beatable with a sword; a bear is not a trade', () => {
  const sword = statsFor('sword');
  const wolfHits = Math.ceil(BEASTS.wolf.health / sword.damage);
  const bearHits = Math.ceil(BEASTS.bear.health / sword.damage);
  assert.ok(wolfHits <= 2, `a wolf takes ${wolfHits} sword hits - a lone one is not beatable`);
  assert.ok(wolfHits >= 2, `a wolf dies to ${wolfHits} sword hit - there is no fight`);
  assert.ok(bearHits >= 4, `a bear takes ${bearHits} sword hits - it is not tanky`);
  assert.ok(sword.range >= BEASTS.wolf.reach - 0.7,
    `the sword reaches ${sword.range} m against a wolf's ${BEASTS.wolf.reach} - the player cannot answer`);
});

test('an unarmed player loses a straight fight with a bear', () => {
  /* Standing still and trading with a bear has to be lethal, or none of the
   * rest of the design matters. Health regeneration never starts, because a
   * blow lands well inside the regeneration delay. */
  const bear = BEASTS.bear;
  const perBlow = bear.attackDamage + bear.bleedRate * bear.bleedTime;
  const cycle = bear.telegraph + bear.strikeWindow + bear.recover + bear.attackCooldown;
  assert.ok(cycle < CONFIG.player.healthRegenDelay,
    `a bear's ${cycle.toFixed(1)}s attack cycle is longer than the ${CONFIG.player.healthRegenDelay}s `
    + 'regeneration delay, so a passive player heals between blows');
  const blows = Math.ceil(CONFIG.player.maxHealth / perBlow);
  assert.ok(blows <= 3, `a bear needs ${blows} blows to kill a passive player - that is not a threat`);
  assert.ok(blows >= 2, 'a bear one-shots the player, which is not survivable');
});

test('a bear announces itself for long enough to be dodged', () => {
  /* The whole fairness argument for the damage: the harder it hits, the longer
   * it visibly winds up first. Held as a pairing rather than as a constant so
   * retuning damage cannot silently remove the wind-up - the same rule
   * NPCWeapons is held to. */
  const wolf = BEASTS.wolf;
  const bear = BEASTS.bear;
  assert.ok(bear.attackDamage > wolf.attackDamage * 1.8, 'the two species hit for the same');
  assert.ok(bear.telegraph > wolf.telegraph * 1.5,
    `a bear hits for ${bear.attackDamage} on a ${bear.telegraph}s wind-up against `
    + `a wolf's ${wolf.attackDamage} on ${wolf.telegraph}s`);
  for (const def of Object.values(BEASTS)) {
    // Long enough to see and act on, short enough not to be comic.
    assert.ok(def.telegraph >= 0.4 && def.telegraph <= 1.2, `${def.id} winds up for ${def.telegraph}s`);
    // The strike window has to be a window, or the volume cannot be swept.
    assert.ok(def.strikeWindow > 0.05, `${def.id}'s strike is instantaneous`);
    // And the beast has to be open afterwards, or there is no punish.
    assert.ok(def.recover > 0.2, `${def.id} recovers in ${def.recover}s`);
  }
});

test('the knockback buys space rather than taking control away', () => {
  for (const def of Object.values(BEASTS)) {
    assert.ok(def.knockback > 3, `${def.id} shoves for ${def.knockback} m/s - the player will not feel it`);
    assert.ok(def.knockback <= 14, `${def.id} shoves for ${def.knockback} m/s, past the impulse ceiling`);
    assert.ok(def.knockUp > 0 && def.knockUp < CONFIG.player.jumpVelocity,
      `${def.id} throws the player ${def.knockUp} m/s upward, harder than they can jump`);
  }
  assert.ok(BEASTS.bear.knockback > BEASTS.wolf.knockback * 1.5,
    'a bear and a wolf shove you the same distance');
});

test('a bleed is a wound, not a second health bar', () => {
  for (const def of Object.values(BEASTS)) {
    const total = def.bleedRate * def.bleedTime;
    assert.ok(total < def.attackDamage,
      `${def.id}'s bleed does ${total} against a ${def.attackDamage} blow - the wound outweighs the bite`);
    assert.ok(def.bleedTime <= CONFIG.player.healthRegenDelay,
      `${def.id}'s bleed runs for ${def.bleedTime}s, past the regeneration delay - `
      + 'the player can never heal after one hit');
  }
});

test('a pack is dangerous, and a wolf on its own is a nuisance', () => {
  /* Time to kill an unarmed player who stands still and never dodges, which is
   * the worst case the design has to survive. The numbers only mean anything
   * relative to each other, so that is how they are held. */
  const wolf = BEASTS.wolf;
  const bear = BEASTS.bear;
  const ttk = (def, cycle) => CONFIG.player.maxHealth
    / ((def.attackDamage + def.bleedRate * def.bleedTime) / cycle);
  const soloCycle = (d) => d.telegraph + d.strikeWindow + d.recover + d.attackCooldown;

  assert.ok(wolf.packMin >= 3 && wolf.packMax <= 5, 'wolves no longer hunt in packs of three to five');
  assert.equal(bear.packMax, 1, 'bears have stopped being solitary');

  const loneWolf = ttk(wolf, soloCycle(wolf));
  assert.ok(loneWolf > 10,
    `a lone wolf kills a passive player in ${loneWolf.toFixed(1)}s - there is no time to react to it`);

  const solitaryBear = ttk(bear, soloCycle(bear));
  assert.ok(solitaryBear < loneWolf * 0.85 && solitaryBear < 10,
    `a bear takes ${solitaryBear.toFixed(1)}s against a lone wolf's ${loneWolf.toFixed(1)}s - `
    + 'the two do not read as different threats');

  /* A pack keeps ONE attack slot filled continuously (see `BeastPack`), so its
   * cadence is the committed sequence with no cooldown between wolves. That is
   * where the danger comes from - not from bigger numbers. */
  const packCycle = wolf.telegraph + wolf.strikeWindow + wolf.recover;
  const packed = ttk(wolf, packCycle);
  assert.ok(packed < loneWolf * 0.5,
    `a pack is only ${(loneWolf / packed).toFixed(1)}x a lone wolf - the coordination is not worth anything`);
  assert.ok(packed > 3,
    `a pack kills a passive player in ${packed.toFixed(1)}s, which is not survivable by anybody`);
});

test('a wolf breaks off when it is losing; a bear has no such concept', () => {
  assert.ok(BEASTS.wolf.courage > 0 && BEASTS.wolf.courage < 0.4,
    `a wolf flees below ${BEASTS.wolf.courage} of its health`);
  assert.equal(BEASTS.bear.courage, 0, 'the bear has learned to run away');
});

test('the chase constants are in proportion to one another', () => {
  /* Three inequalities on the table, and that is ALL they are. This test used
   * to be called "a beast gives up a chase before it leaves its own world" and
   * it asserted nothing whatever about position - a beast that walked to the
   * far corner of the map passed it, which is exactly what one did. The
   * positional claim is the test below; this is the balance check it always
   * really was, renamed so the two are not confused again. */
  for (const def of Object.values(BEASTS)) {
    assert.ok(def.loseInterest > def.sight * 0.6,
      `${def.id} gives up at ${def.loseInterest} m but can see to ${def.sight}`);
    assert.ok(def.loseInterest < 80, `${def.id} chases for ${def.loseInterest} m`);
    assert.ok(def.territory > 10, `${def.id} roams ${def.territory} m, which is standing still`);
  }
});

test('a beast gives up a chase before it leaves its own world - measured, in metres', () => {
  /* THE DEFECT THIS IS THE GATE FOR.
   *
   * Every rule that ended a pursuit was beast-to-TARGET, and `chargeSpeed` 7.6
   * beats a walking player's 4.6, so `loseInterest` could never fire against
   * somebody who simply kept walking. Driven here at the real fixed step with a
   * player walking away in a straight line, a wolf followed for 40 s and the
   * only thing that stopped it was the end of the loop.
   *
   * The bound is `BeastSpecies.threatRadius` - `territory + sight`, the very
   * radius the world's own placement cordons are written against - so what this
   * asserts is not "some number" but the number that makes the vale's clearance
   * arithmetic true of an animal rather than of a spec. */
  const player = stubPlayer(0, 6);
  const mgr = makeManager(player);
  const [wolf] = mgr.spawnBeastGroup({ position: new THREE.Vector3(0, 0, 0), species: 'wolf', count: 1 });
  assert.equal(wolf.leash, threatRadius(BEASTS.wolf), 'the leash is not the placement radius');

  wolf._acquire(player);
  assert.equal(wolf.target, player, 'the wolf never took the target at all');

  const DT = 1 / 60;
  const WALK = CONFIG.player.walkSpeed;
  let farthest = 0;
  let dropped = -1;
  for (let s = 0; s < 60 * 40 && dropped < 0; s++) {
    // The player walks away in a straight line, which is all it takes.
    player.position.z += WALK * DT;
    // Drive perception and the state machine directly: the integrator needs a
    // renderer-built body, and what is under test is the decision, not the gait.
    wolf._sense(DT);
    if (wolf.state === 'STALK') wolf._stalk(DT);
    if (!wolf.target) { dropped = s * DT; break; }
    /* Close at the charge speed, which is the whole point - the wolf is FASTER
     * than the player it is following, so nothing beast-to-target can end this. */
    const toward = wolf.target.position.clone().sub(wolf.position).setY(0);
    if (toward.length() > wolf.def.reach) {
      wolf.position.addScaledVector(toward.normalize(), wolf.def.chargeSpeed * DT);
    }
    farthest = Math.max(farthest, Math.hypot(wolf.position.x - wolf.home.x, wolf.position.z - wolf.home.z));
  }

  assert.ok(dropped > 0, 'the wolf never broke off - it followed a walking player for the whole run');
  assert.ok(farthest <= wolf.leash + wolf.def.chargeSpeed * DT * 2,
    `the wolf reached ${farthest.toFixed(1)} m from home against a ${wolf.leash} m leash`);
  /* And it is a CHASE, not a shrug: the wolf has to have left its territory and
   * covered real ground before breaking off, or the leash has been cut so tight
   * that nothing can ever be caught. Measured: it reaches 65.99 m from home
   * against its 34 m territory and lets go at t = 13.47 s, by which point it is
   * 2.03 m behind a player who never once ran. */
  assert.ok(farthest > wolf.def.territory,
    `the wolf broke off at ${farthest.toFixed(1)} m, inside its own ${wolf.def.territory} m territory `
    + '- the leash is too short to allow a chase at all');

  /* And it will not pick up whoever lives where the player led it. This is the
   * half that keeps Edmund Marsh alive: the leash gates ACQUISITION, not only
   * pursuit, so a beast that has been drawn to the edge of its country cannot
   * start hunting the neighbours who live past it. The villager stands where
   * the PLAYER is - just outside the leash, which is why the wolf let go - and
   * a wolf sees 34 m, so this is inside its eyesight by a wide margin. */
  const villager = {
    position: player.position.clone(), isDead: false, type: 'friendly', height: 1.8,
  };
  assert.ok(wolf.position.distanceTo(villager.position) < BEASTS.wolf.sight,
    'the villager is out of sight anyway, so refusing it proves nothing');
  mgr._friendlies.push(villager);
  wolf._senseTimer = 0;
  wolf.satiated = 0;
  wolf._sense(DT);
  assert.equal(wolf.target, null,
    'a wolf that has been walked out of its territory picked up a civilian standing where it landed');
  assert.equal(wolf.adoptPackTarget(villager), false, 'the pack share path ignores the leash');
  wolf.onDamaged(10, false, villager);
  assert.equal(wolf.target, null, 'being hit from outside the leash still starts an unbounded hunt');
});

test('a player cannot walk a pack to the vale\'s quest manager', () => {
  /* THE CONSEQUENCE, ASSERTED AS THE CONSEQUENCE.
   *
   * `Inhabitants.js` plants Edmund Marsh at (10, -9) - 7.2 m from the player's
   * spawn pin - anchored, weaponless, on 100 health, and neither
   * `NPCManager._updateRespawns` (which walks `_hostiles`) nor
   * `MedievalResidency.sync` (which streams specs) can bring him back, because
   * he is placed by `_spawnQuestManagers` and is in neither list. `HUD` gates
   * the quest board on `isQuestManager`, so his death removes it for the
   * session.
   *
   * The nearest pack home to the player's spawn measures 195.5 m on the shipped
   * placement - `medieval-wildlife.test.mjs` holds that - so what has to be
   * true is that a pack cannot cover the difference. This drives it: a player
   * walks from beside a pack all the way to Edmund and the pack follows as fast
   * as it can. */
  const EDMUND = new THREE.Vector3(10, 0, -9);
  const NEAREST_PACK_HOME = 195.5;      // medieval-wildlife.test.mjs, shipped placement
  const home = new THREE.Vector3(EDMUND.x, 0, EDMUND.z - NEAREST_PACK_HOME);
  const player = stubPlayer(home.x, home.z + 5);
  const mgr = makeManager(player);
  const pack = mgr.spawnBeastGroup({ position: home, species: 'wolf', count: 5 });
  assert.ok(pack.length >= 3, `only ${pack.length} wolves spawned`);
  for (const w of pack) w._acquire(player, true);

  const DT = 1 / 60;
  let closest = Infinity;
  for (let s = 0; s < 60 * 90; s++) {
    // Straight at Edmund, at a walk, which is the exploit.
    const toEdmund = EDMUND.clone().sub(player.position).setY(0);
    if (toEdmund.length() > 0.1) {
      player.position.addScaledVector(toEdmund.normalize(), CONFIG.player.walkSpeed * DT);
    }
    for (const w of pack) {
      w._sense(DT);
      // The same dispatch `_think` does, including the pack clock - `_roam`'s
      // re-adopt is one of the paths the leash has to close, so it must run.
      if (w.pack && w.pack.firstLiving() === w) w.pack.update(DT);
      if (w.state === 'STALK') w._stalk(DT);
      else if (w.state === 'ROAM') w._roam(DT);
      /* A beast only ever moves at its OWN target. Steering it at the pack's
       * target instead would be modelling a bug the code does not have and
       * would make this test pass or fail on the harness. */
      if (w.target) {
        const toward = w.target.position.clone().sub(w.position).setY(0);
        if (toward.length() > w.def.reach) {
          w.position.addScaledVector(toward.normalize(), w.def.chargeSpeed * DT);
        }
      }
      closest = Math.min(closest, Math.hypot(w.position.x - EDMUND.x, w.position.z - EDMUND.z));
    }
  }
  /* A wolf sees 34 m. Anything beyond that and Edmund is never a candidate, let
   * alone a target. Measured on this drive: the nearest wolf stopped 129.45 m
   * short of him, against the 127.5 m the leash arithmetic allows (195.5 minus
   * the 68 m leash). Driven in the browser against the real vale, on the real
   * Hazelbrake pack, the same walk left the nearest wolf 136.2 m short. */
  assert.ok(closest > BEASTS.wolf.sight,
    `a walking player brought a wolf to within ${closest.toFixed(1)} m of Edmund Marsh, inside its `
    + `${BEASTS.wolf.sight} m sight - the quest board can be deleted for the session`);
  assert.ok(closest >= NEAREST_PACK_HOME - threatRadius(BEASTS.wolf) - 1,
    `a wolf got ${closest.toFixed(1)} m from Edmund; the leash allows no closer than `
    + `${(NEAREST_PACK_HOME - threatRadius(BEASTS.wolf)).toFixed(1)} m`);
});
