import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CONFIG } from '../../src/core/Config.js';
import { NPCManager } from '../../src/npc/NPCManager.js';
import { BEASTS } from '../../src/npc/BeastSpecies.js';
import { statsFor } from '../../src/systems/WeaponStats.js';
import { DECAL, DECAL_GRID, cellUV, cellCanvas, DECAL_CELL, DECAL_ATLAS_SIZE }
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

test('nothing outruns a sprinting player, so fleeing is always available', () => {
  for (const def of Object.values(BEASTS)) {
    assert.ok(def.chargeSpeed < CONFIG.player.sprintSpeed,
      `a ${def.id} runs at ${def.chargeSpeed} against a player's ${CONFIG.player.sprintSpeed}`);
    // ...and everything beats a walk, or there is no threat at all.
    assert.ok(def.chargeSpeed > CONFIG.player.walkSpeed,
      `a ${def.id} cannot catch a walking player`);
  }
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

test('a beast gives up a chase before it leaves its own world', () => {
  for (const def of Object.values(BEASTS)) {
    assert.ok(def.loseInterest > def.sight * 0.6,
      `${def.id} gives up at ${def.loseInterest} m but can see to ${def.sight}`);
    assert.ok(def.loseInterest < 80, `${def.id} chases for ${def.loseInterest} m`);
    assert.ok(def.territory > 10, `${def.id} roams ${def.territory} m, which is standing still`);
  }
});
