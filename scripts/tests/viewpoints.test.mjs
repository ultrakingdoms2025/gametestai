import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Viewpoints, normaliseViewpoint,
  REVEAL_R, SYNC_CREDITS, SYNC_ITEM, SYNC_ITEM_QTY,
  SET_COSMETIC, SET_POWER, SYNC_PAD, SYNC_BAND, LEAP_R, MAX_TRAVEL_ROWS,
} from '../../src/systems/Viewpoints.js';
import { MOUNT_STATS } from '../../src/mounts/Livery.js';
import { MOUNT_SKINS_BY_ID, CHARACTER_SKINS_BY_ID } from '../../src/systems/Cosmetics.js';

/**
 * VIEWPOINT SYNCHRONISATION.
 *
 * ── The defect ────────────────────────────────────────────────────────────
 * `CitadelWorld` publishes five NAMED vantage points, each carrying the exact
 * launch point of a leap of faith, the bearing it leaves on, and the haystack
 * that catches it. `grep -r viewpoints src/` outside `CitadelWorld.js` returned
 * nothing. The hardest climbs in the game paid nothing, said nothing, appeared
 * on no map and survived no reload.
 *
 * ── What is asserted, and what would have to be true for it to pass anyway ──
 * Every test here can fail, and the mutation that kills each one is named in
 * its own comment. The ones that matter most are the negatives:
 *
 *   - a reward that pays TWICE is the failure mode of every "first time you do
 *     X" mechanic, and re-entering a world is the ordinary way to trigger it;
 *   - a `deserialize` that pays is an infinite credit press, reachable by
 *     pressing Load;
 *   - a leap prompt raised over a viewpoint whose haystack never resolved is
 *     the game telling a player to jump off a tower onto nothing, which is
 *     exactly the defect the design's §4.1 exists to fix.
 *
 * Nothing here needs a browser, a renderer, a world build or a login. The
 * module reads one published array and a player position.
 */

/* ---------------------------------------------------------------------- */
/* Doubles                                                                 */
/* ---------------------------------------------------------------------- */

/** The real bus semantics that matter: sync delivery and a recording tail. */
function makeBus() {
  const handlers = new Map();
  const log = [];
  return {
    log,
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
      return () => handlers.get(type)?.delete(fn);
    },
    emit(type, payload) {
      log.push({ type, payload });
      for (const fn of [...(handlers.get(type) ?? [])]) fn(payload);
    },
    of(type) {
      return log.filter((e) => e.type === type).map((e) => e.payload);
    },
  };
}

function makeCtx() {
  const bus = makeBus();
  const player = {
    position: { x: 0, y: 0, z: 0 },
    teleports: [],
    teleport(p) { this.teleports.push({ x: p.x, y: p.y, z: p.z }); },
  };
  const economy = { credits: 0, add(n) { this.credits += n; return this.credits; } };
  const inventory = { got: [], acquire(id, qty) { this.got.push([id, qty]); return { taken: qty }; } };
  const cosmetics = {
    owned: new Set(),
    unlock(id) { if (this.owned.has(id)) return false; this.owned.add(id); return true; },
  };
  const mounts = { mounted: false, powers: [], dismounts: 0,
    dismount() { this.dismounts++; this.mounted = false; },
    grantPower(m, p, t) { this.powers.push([m, p, t]); } };
  const vps = new Viewpoints({ bus, player, economy, inventory, cosmetics, mounts });
  return { bus, player, economy, inventory, cosmetics, mounts, vps };
}

/** Two towers 200 m apart, so one reveal cannot cover both (REVEAL_R = 120). */
const TOWER_A = {
  id: 'tower-a', name: 'The Great Tower', x: 0, y: 60, z: 0, r: 4,
  launch: { x: 0, y: 61, z: 5 }, bearing: 1.57, hay: { x: 0, y: 13, z: 30, r: 3.6 },
};
const TOWER_B = { id: 'tower-b', name: 'Minaret 1', x: 260, y: 40, z: 0, r: 3.5 };

const world = (viewpoints) => ({ id: 'testworld', viewpoints });

/** Put the player on a viewpoint's platform and run one frame. */
function standOn(ctx, vp) {
  ctx.player.position.x = vp.x;
  ctx.player.position.y = vp.y;
  ctx.player.position.z = vp.z;
  ctx.vps.update(1 / 60);
}

/* ====================================================================== */
/* The published contract                                                  */
/* ====================================================================== */

test('a viewpoint needs an id and a position, and nothing else', () => {
  // Fails if `normaliseViewpoint` starts demanding fields the contract calls
  // optional - which would silently drop every entry from a simpler world.
  const bare = normaliseViewpoint({ id: 'a', x: 1, y: 2, z: 3 }, 0);
  assert.ok(bare, 'a bare entry was rejected');
  assert.equal(bare.name, 'Viewpoint 1', 'no fallback name');
  assert.ok(bare.r > 0, 'no fallback radius');

  assert.equal(normaliseViewpoint({ x: 1, y: 2, z: 3 }, 0), null, 'an id-less entry was accepted');
  assert.equal(normaliseViewpoint({ id: 'a', x: 1, y: 2 }, 0), null, 'a z-less entry was accepted');
  assert.equal(normaliseViewpoint({ id: 'a', x: NaN, y: 2, z: 3 }, 0), null, 'NaN x was accepted');
  assert.equal(normaliseViewpoint(null, 0), null);
  assert.equal(normaliseViewpoint('great-tower', 0), null, 'a bare string was accepted');
});

test('an UNRESOLVED haystack spec never becomes a leap prompt', () => {
  /* The citadel authors `hay: {run, r}` and the build resolves it against a
   * real physics surface into `{x, y, z, r}`. If the build ever fails to, the
   * spec is still an object and still truthy - so a naive check would raise a
   * prompt inviting the player off a 48 m tower onto a haystack that has no
   * position. Mutation that kills this: drop the `fin(h.y)` test in
   * `normaliseViewpoint`. */
  const unresolved = normaliseViewpoint({
    id: 'a', x: 0, y: 60, z: 0, launch: { x: 0, y: 61, z: 5 }, hay: { run: 26.1, r: 3.6 },
  }, 0);
  assert.ok(unresolved, 'the viewpoint itself was dropped, not just its leap');
  assert.equal(unresolved.hay, null, 'an unresolved hay spec survived as a hay');
  assert.equal(unresolved.launch, null, 'a launch point survived with nothing under it');

  // ..and with a resolved one, both survive together.
  const ok = normaliseViewpoint(TOWER_A, 0);
  assert.ok(ok.hay && ok.launch, 'a resolved pair was dropped');
});

test('a world publishing no viewpoints costs one failed property read', () => {
  const ctx = makeCtx();
  ctx.bus.emit('world:changed', { id: 'medieval', world: { id: 'medieval' } });
  assert.equal(ctx.vps.total, 0);
  assert.deepEqual(ctx.vps.anchors, []);
  // And `update` must return before touching the player at all.
  ctx.player.position = null;
  assert.doesNotThrow(() => ctx.vps.update(1 / 60));
});

/* ====================================================================== */
/* Reaching one                                                            */
/* ====================================================================== */

test('standing on a viewpoint synchronises it; standing beneath it does not', () => {
  const ctx = makeCtx();
  ctx.bus.emit('world:changed', { id: 'testworld', world: world([TOWER_A, TOWER_B]) });
  assert.equal(ctx.vps.total, 2);
  assert.equal(ctx.vps.syncedCount, 0);

  // Directly below the platform, at ground level: the whole 1.1 defect was a
  // system that could not tell "on it" from "under it".
  ctx.player.position.x = TOWER_A.x;
  ctx.player.position.y = 0;
  ctx.player.position.z = TOWER_A.z;
  ctx.vps.update(1 / 60);
  assert.equal(ctx.vps.syncedCount, 0, 'a viewpoint synchronised from the ground beneath it');

  // Just outside the platform's own radius plus the pad.
  ctx.player.position.x = TOWER_A.x + TOWER_A.r + SYNC_PAD + 0.5;
  ctx.player.position.y = TOWER_A.y;
  ctx.vps.update(1 / 60);
  assert.equal(ctx.vps.syncedCount, 0, 'a viewpoint synchronised from off the edge of it');

  // Just inside the band, vertically as well as horizontally.
  ctx.player.position.x = TOWER_A.x + TOWER_A.r;
  ctx.player.position.y = TOWER_A.y + SYNC_BAND - 0.1;
  ctx.vps.update(1 / 60);
  assert.equal(ctx.vps.syncedCount, 1, 'standing on the platform did not synchronise it');
  assert.ok(ctx.vps.isSynced('tower-a'));
  assert.ok(!ctx.vps.isSynced('tower-b'));
});

test('synchronising pays credits AND an item, and pays them exactly once', () => {
  /* The failure mode this exists for: a "first time only" reward that fires on
   * every frame the player stands there. At 60 Hz, four seconds on the tower
   * would be 36,000 CR. Mutation that kills it: drop the `set.has(vp.id)`
   * guard in `_sync`. */
  const ctx = makeCtx();
  ctx.bus.emit('world:changed', { id: 'testworld', world: world([TOWER_A]) });

  for (let i = 0; i < 30; i++) standOn(ctx, TOWER_A);

  assert.equal(ctx.economy.credits, SYNC_CREDITS, 'the reward paid more than once');
  assert.deepEqual(ctx.inventory.got, [[SYNC_ITEM, SYNC_ITEM_QTY]], 'the item prize paid more than once');
  assert.equal(ctx.bus.of('viewpoint:synced').length, 1, 'viewpoint:synced fired more than once');
});

test('a viewpoint stays synchronised across a world round trip', () => {
  const ctx = makeCtx();
  ctx.bus.emit('world:changed', { id: 'testworld', world: world([TOWER_A, TOWER_B]) });
  standOn(ctx, TOWER_A);
  assert.equal(ctx.vps.syncedCount, 1);

  ctx.bus.emit('world:changed', { id: 'station', world: { id: 'station' } });
  assert.equal(ctx.vps.total, 0, 'another world inherited the citadel viewpoints');

  ctx.bus.emit('world:changed', { id: 'testworld', world: world([TOWER_A, TOWER_B]) });
  assert.equal(ctx.vps.syncedCount, 1, 'the synchronisation did not survive leaving and returning');
  // ..and returning must not pay again.
  standOn(ctx, TOWER_A);
  assert.equal(ctx.economy.credits, SYNC_CREDITS, 'coming back re-paid the reward');
});

/* ====================================================================== */
/* The map reveal                                                          */
/* ====================================================================== */

test('reveals() opens a district around a synchronised viewpoint and nowhere else', () => {
  const ctx = makeCtx();
  ctx.bus.emit('world:changed', { id: 'testworld', world: world([TOWER_A, TOWER_B]) });

  // Nothing is revealed before the first climb - that is the whole mechanic.
  assert.equal(ctx.vps.reveals(0, 0), false, 'the map was revealed before anything was climbed');

  standOn(ctx, TOWER_A);
  assert.equal(ctx.vps.reveals(0, 0), true, 'the viewpoint you are standing on is not revealed');
  assert.equal(ctx.vps.reveals(REVEAL_R - 1, 0), true, 'the district is smaller than REVEAL_R');
  assert.equal(ctx.vps.reveals(REVEAL_R + 1, 0), false, 'the reveal reaches past REVEAL_R');
  // The far tower is 260 m away: one climb must not open the whole world.
  assert.equal(ctx.vps.reveals(TOWER_B.x, TOWER_B.z), false, 'one climb revealed the entire map');

  standOn(ctx, TOWER_B);
  assert.equal(ctx.vps.reveals(TOWER_B.x, TOWER_B.z), true, 'the second district never opened');
});

test('a world with no viewpoints reveals everything', () => {
  /* Three of the five worlds have relics and no viewpoints. A reveal gate that
   * defaulted closed would hide every relic marker in them for ever - a bug
   * that looks exactly like a design. Mutation that kills this: change the
   * `!this.list.length` early return in `reveals` to `return false`. */
  const ctx = makeCtx();
  ctx.bus.emit('world:changed', { id: 'medieval', world: { id: 'medieval' } });
  assert.equal(ctx.vps.reveals(0, 0), true);
  assert.equal(ctx.vps.reveals(9000, -9000), true);
});

/* ====================================================================== */
/* Fast travel                                                             */
/* ====================================================================== */

test('travel refuses an anchor that was never climbed to', () => {
  const ctx = makeCtx();
  ctx.bus.emit('world:changed', { id: 'testworld', world: world([TOWER_A, TOWER_B]) });

  assert.equal(ctx.vps.travelTo('tower-a'), false, 'travelled to an unsynchronised viewpoint');
  assert.equal(ctx.player.teleports.length, 0);
  assert.equal(ctx.vps.travelTo('no-such-place'), false);
  assert.deepEqual(ctx.vps.anchors, [], 'an unclimbed viewpoint was on the anchor list');
});

test('travel lands the player on the platform, dismounting first', () => {
  const ctx = makeCtx();
  ctx.bus.emit('world:changed', { id: 'testworld', world: world([TOWER_A, TOWER_B]) });
  standOn(ctx, TOWER_A);
  ctx.player.position.x = 500;
  ctx.player.position.y = 0;
  ctx.player.position.z = 500;

  /* A mounted teleport is the defect this dismount answers: `Player.teleport`
   * moves the body and nothing else, so the rider would arrive on the tower
   * still parented to a horse standing in the souk. */
  ctx.mounts.mounted = true;
  assert.equal(ctx.vps.travelTo('tower-a'), true, 'travel to a synchronised anchor was refused');
  assert.equal(ctx.mounts.dismounts, 1, 'the player was teleported while still mounted');

  const to = ctx.player.teleports.at(-1);
  assert.equal(to.x, TOWER_A.x);
  assert.equal(to.z, TOWER_A.z);
  assert.ok(to.y >= TOWER_A.y && to.y < TOWER_A.y + 0.5,
    `landed at y ${to.y}, not on the ${TOWER_A.y} m platform`);
  assert.equal(ctx.bus.of('viewpoint:travelled').length, 1);
});

test('the hub rows are a live list of the anchors, and stay hidden until earned', () => {
  const ctx = makeCtx();
  const rows = ctx.vps.hubItems();
  assert.equal(rows.length, MAX_TRAVEL_ROWS);
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, 'duplicate hub row ids');

  ctx.bus.emit('world:changed', { id: 'testworld', world: world([TOWER_A, TOWER_B]) });
  // Predicates, not snapshots: the hub builds once at boot and re-reads these.
  assert.equal(rows.every((r) => r.visible() === false), true, 'a travel row showed with no anchors');

  standOn(ctx, TOWER_A);
  assert.equal(rows[0].visible(), true, 'the first row did not appear when an anchor did');
  assert.equal(rows[0].label(), 'Travel: The Great Tower');
  assert.equal(rows[1].visible(), false, 'a row appeared for an anchor that does not exist');

  rows[0].run();
  assert.equal(ctx.player.teleports.length, 1, 'the hub row did not travel');
});

/* ====================================================================== */
/* The leap of faith                                                       */
/* ====================================================================== */

test('the leap prompt appears at the launch point and only there', () => {
  const ctx = makeCtx();
  ctx.bus.emit('world:changed', { id: 'testworld', world: world([TOWER_A, TOWER_B]) });

  // On the platform but not on the beam: no prompt.
  standOn(ctx, TOWER_A);
  const afterPlatform = ctx.bus.of('viewpoint:prompt').at(-1);
  assert.ok(!afterPlatform || afterPlatform.text === null,
    'the leap prompt showed from the middle of the platform');

  const l = TOWER_A.launch;
  ctx.player.position.x = l.x;
  ctx.player.position.y = l.y;
  ctx.player.position.z = l.z;
  ctx.vps.update(1 / 60);
  const p = ctx.bus.of('viewpoint:prompt').at(-1);
  assert.equal(p.viewpointId, 'tower-a');
  assert.ok(/leap of faith/i.test(p.text), `prompt text was "${p.text}"`);

  /* The drop is the two published points, not a guess: launch y 61, hay y 13.
   * A prompt that invented this number would be the fourth figure in this
   * project computed instead of measured. */
  assert.equal(p.drop, 48);
  assert.ok(p.text.includes('48'), `the prompt does not state the measured drop: "${p.text}"`);

  // Step off the beam and it stands down.
  ctx.player.position.z = l.z + LEAP_R + 1;
  ctx.vps.update(1 / 60);
  assert.equal(ctx.bus.of('viewpoint:prompt').at(-1).text, null, 'the leap prompt never stood down');
});

test('the leap prompt is written once per arrival, not once per frame', () => {
  // 60 emits a second into a HUD listener is the cheapest possible way to make
  // a prompt widget dirty layout every frame. Mutation: drop the `_promptId`
  // comparison in `_setPrompt`.
  const ctx = makeCtx();
  ctx.bus.emit('world:changed', { id: 'testworld', world: world([TOWER_A]) });
  const l = TOWER_A.launch;
  ctx.player.position.x = l.x;
  ctx.player.position.y = l.y;
  ctx.player.position.z = l.z;
  for (let i = 0; i < 40; i++) ctx.vps.update(1 / 60);
  assert.equal(ctx.bus.of('viewpoint:prompt').length, 1,
    'the leap prompt was re-emitted while the player stood still');
});

test('a viewpoint with no resolved haystack never offers a leap', () => {
  const ctx = makeCtx();
  ctx.bus.emit('world:changed', { id: 'testworld', world: world([TOWER_B]) });
  // TOWER_B has no launch at all; standing anywhere on it must stay silent.
  standOn(ctx, TOWER_B);
  const prompts = ctx.bus.of('viewpoint:prompt').filter((p) => p.text);
  assert.deepEqual(prompts, [], 'a leap was offered from a viewpoint with no hay under it');
});

/* ====================================================================== */
/* Prizes                                                                  */
/* ====================================================================== */

test('the full set pays a cosmetic and a mount power, once, and only when complete', () => {
  const ctx = makeCtx();
  ctx.bus.emit('world:changed', { id: 'testworld', world: world([TOWER_A, TOWER_B]) });

  standOn(ctx, TOWER_A);
  assert.equal(ctx.cosmetics.owned.size, 0, 'the set prize paid on a partial set');
  assert.deepEqual(ctx.mounts.powers, [], 'the mount power paid on a partial set');

  standOn(ctx, TOWER_B);
  assert.ok(ctx.cosmetics.owned.has(SET_COSMETIC), 'the set cosmetic was never granted');
  assert.deepEqual(ctx.mounts.powers, [[SET_POWER.mount, SET_POWER.power, SET_POWER.tier]]);
  assert.equal(ctx.bus.of('viewpoint:setComplete').length, 1);

  // Leave, come back, stand on both again: still once.
  ctx.bus.emit('world:changed', { id: 'station', world: { id: 'station' } });
  ctx.bus.emit('world:changed', { id: 'testworld', world: world([TOWER_A, TOWER_B]) });
  standOn(ctx, TOWER_A);
  standOn(ctx, TOWER_B);
  assert.equal(ctx.bus.of('viewpoint:setComplete').length, 1, 'the set prize paid twice');
  assert.equal(ctx.mounts.powers.length, 1);
});

test('a set completed before the prize existed pays on entry, once', () => {
  /* An old save carries five synchronised viewpoints and no record of a set
   * prize, because there was no set prize when it was written. Entering the
   * world settles that debt - and `_setPaid` is what stops it settling again on
   * every subsequent entry. This is the only path on which that flag is
   * load-bearing, which is why it is tested rather than trusted. */
  const ctx = makeCtx();
  ctx.vps.deserialize({ worlds: { testworld: ['tower-a', 'tower-b'] } });

  ctx.bus.emit('world:changed', { id: 'testworld', world: world([TOWER_A, TOWER_B]) });
  assert.equal(ctx.bus.of('viewpoint:setComplete').length, 1, 'the owed set prize never arrived');
  assert.ok(ctx.cosmetics.owned.has(SET_COSMETIC));
  // ..but no credits and no item: those were paid per viewpoint, long ago.
  assert.equal(ctx.economy.credits, 0, 'entering the world re-paid the per-viewpoint reward');

  ctx.bus.emit('world:changed', { id: 'station', world: { id: 'station' } });
  ctx.bus.emit('world:changed', { id: 'testworld', world: world([TOWER_A, TOWER_B]) });
  assert.equal(ctx.bus.of('viewpoint:setComplete').length, 1,
    'the set prize paid again on the next visit');
});

test('an incomplete set pays nothing on entry', () => {
  const ctx = makeCtx();
  ctx.vps.deserialize({ worlds: { testworld: ['tower-a'] } });
  ctx.bus.emit('world:changed', { id: 'testworld', world: world([TOWER_A, TOWER_B]) });
  assert.equal(ctx.bus.of('viewpoint:setComplete').length, 0, 'a 1-of-2 set paid the set prize');
});

test('the prizes name things the real catalogues actually sell', () => {
  /* `grantPower` silently drops a stat the mount does not sell and `unlock`
   * silently refuses an unknown id, so a typo here would be a prize that
   * never arrives and never complains. This is the only test that can catch
   * that, and it reads the real tables rather than a copy. */
  assert.ok(MOUNT_STATS[SET_POWER.mount], `no mount "${SET_POWER.mount}"`);
  assert.ok(MOUNT_STATS[SET_POWER.mount].includes(SET_POWER.power),
    `${SET_POWER.mount} does not sell "${SET_POWER.power}"`);
  assert.ok(MOUNT_SKINS_BY_ID.has(SET_COSMETIC) || CHARACTER_SKINS_BY_ID.has(SET_COSMETIC),
    `"${SET_COSMETIC}" is in neither skin catalogue`);
});

/* ====================================================================== */
/* Persistence                                                             */
/* ====================================================================== */

test('synchronised viewpoints round-trip through serialize/deserialize', () => {
  const a = makeCtx();
  a.bus.emit('world:changed', { id: 'testworld', world: world([TOWER_A, TOWER_B]) });
  standOn(a, TOWER_A);
  const snap = JSON.parse(JSON.stringify(a.vps.serialize()));

  const b = makeCtx();
  assert.equal(b.vps.deserialize(snap), true);
  b.bus.emit('world:changed', { id: 'testworld', world: world([TOWER_A, TOWER_B]) });
  assert.equal(b.vps.syncedCount, 1, 'the restored save forgot the climb');
  assert.equal(b.vps.isSynced('tower-a'), true);
  assert.equal(b.vps.reveals(0, 0), true, 'the restored save forgot the map reveal');
  assert.deepEqual(b.vps.anchors.map((x) => x.id), ['tower-a']);
});

test('restoring a save pays nothing', () => {
  /* Load is a button. A deserialize that granted the rewards would be an
   * infinite credit-and-cosmetic press two clicks deep. Mutation that kills
   * this: route `deserialize` through `_sync`. */
  const a = makeCtx();
  a.bus.emit('world:changed', { id: 'testworld', world: world([TOWER_A, TOWER_B]) });
  standOn(a, TOWER_A);
  standOn(a, TOWER_B);
  const snap = JSON.parse(JSON.stringify(a.vps.serialize()));

  const b = makeCtx();
  b.vps.deserialize(snap);
  b.bus.emit('world:changed', { id: 'testworld', world: world([TOWER_A, TOWER_B]) });
  assert.equal(b.economy.credits, 0, 'loading a save paid the viewpoint rewards again');
  assert.deepEqual(b.inventory.got, [], 'loading a save paid the item prize again');
  assert.equal(b.cosmetics.owned.size, 0, 'loading a save re-granted the set cosmetic');
  assert.deepEqual(b.mounts.powers, [], 'loading a save re-granted the mount power');

  // ..and standing on them again pays nothing either.
  standOn(b, TOWER_A);
  standOn(b, TOWER_B);
  assert.equal(b.economy.credits, 0, 'a restored viewpoint paid when re-entered');
  assert.equal(b.bus.of('viewpoint:setComplete').length, 0, 'the set prize paid after a load');
});

test('a load REPLACES the synchronised set, so it can un-synchronise too', () => {
  /* A load is a load, not a merge. Climb both towers, complete the set, then
   * load a save written before either climb: the additive version kept both ids
   * in `_synced`, `_applySynced` re-stamped them, both fast-travel rows stayed
   * in the pause hub, `reveals()` still opened the whole map, and `_setPaid`
   * still said the set prize had been given. `MountManager.deserialize` writes
   * the replace rule down as the house convention.
   *
   * Mutation that kills this: drop the two `.clear()` calls at the top of
   * `deserialize`. */
  const ctx = makeCtx();
  ctx.bus.emit('world:changed', { id: 'testworld', world: world([TOWER_A, TOWER_B]) });
  standOn(ctx, TOWER_A);
  standOn(ctx, TOWER_B);
  assert.equal(ctx.vps.syncedCount, 2);
  assert.equal(ctx.cosmetics.owned.size, 1, 'the set prize must have paid, or this proves nothing');

  ctx.vps.deserialize({ worlds: { testworld: ['tower-a'] }, sets: [] });
  assert.equal(ctx.vps.syncedCount, 1, 'the restore merged instead of replacing');
  assert.equal(ctx.vps.isSynced('tower-b'), false, 'a climb the loaded save never made survived it');
  assert.deepEqual(ctx.vps.anchors.map((x) => x.id), ['tower-a'], 'a stale fast-travel row survived the load');
  assert.equal(ctx.vps.reveals(TOWER_B.x, TOWER_B.z), false, 'the map stayed open around an unclimbed tower');

  // A world left out of the payload is a world with nothing climbed in it.
  ctx.vps.deserialize({ worlds: {} });
  assert.equal(ctx.vps.syncedCount, 0, 'an absent world kept its stale set');
});

test('a corrupt or foreign payload is refused without throwing', () => {
  const ctx = makeCtx();
  for (const bad of [null, undefined, 42, 'nope', [], { worlds: 7 }, { worlds: { a: 'x' } }]) {
    assert.doesNotThrow(() => ctx.vps.deserialize(bad), `threw on ${JSON.stringify(bad)}`);
  }
  ctx.bus.emit('world:changed', { id: 'testworld', world: world([TOWER_A]) });
  assert.equal(ctx.vps.syncedCount, 0, 'rubbish in the save granted a synchronisation');
});

/* ====================================================================== */
/* World-agnostic                                                          */
/* ====================================================================== */

test('the module names no world', async () => {
  /* The brief was explicit: any world publishing `viewpoints` gets this. A
   * `if (worldId === 'citadel')` anywhere would satisfy every behavioural test
   * above and still be exactly the thing that was asked not to happen. */
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../../src/systems/Viewpoints.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const id of ['citadel', 'medieval', 'station', 'maze', 'sports', 'race']) {
    assert.ok(!new RegExp(`['"\`]${id}['"\`]`).test(code),
      `Viewpoints.js hard-codes the world "${id}"`);
  }
});
