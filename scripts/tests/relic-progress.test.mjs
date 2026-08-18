import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import {
  Relics, HALFWAY_ITEM, HALFWAY_ITEM_QTY, SET_COSMETIC, SET_POWER, SET_CREDITS,
} from '../../src/systems/Relics.js';
import { ITEMS } from '../../src/systems/ItemDefs.js';
import { MOUNT_STATS } from '../../src/mounts/Livery.js';
import { CHARACTER_SKINS_BY_ID, MOUNT_SKINS_BY_ID } from '../../src/systems/Cosmetics.js';

/**
 * RELIC PROGRESS SURVIVES A RELOAD, AND THE SET PAYS SOMETHING.
 *
 * ── The defect ────────────────────────────────────────────────────────────
 * `Relics._found` - the per-world tally, and the only record that a relic was
 * ever picked up - was absent from `SaveGame._snapshot` entirely. Thirty relics
 * worth 3,600 CR in the citadel reset to thirty on every reload. The file's own
 * header says relics "never come back" and that "the count is the progress
 * bar"; both sentences were false, and the one collectible in the game designed
 * to be finite was in practice an unlimited credit tap for anyone who noticed.
 *
 * The second half is the reward. Every relic paid `VALUE`, including the last
 * one, so the longest activity in a world ended with the same toast as the
 * first minute of it.
 *
 * ── What is asserted ──────────────────────────────────────────────────────
 * The tally round-trips, a restored world does not re-pay, the milestones pay
 * once each, and the ids they pay in exist in the real catalogues - because
 * `Inventory.acquire`, `Cosmetics.unlock` and `MountManager.grantPower` all
 * refuse an unknown id SILENTLY, so a typo is a prize that never arrives and
 * never complains.
 *
 * No renderer: `Relics` is constructed against a bare `THREE.Scene`, which is
 * all `_build` needs, and the sites are installed directly rather than probed
 * out of a physics world - placement is `Caches`' business and is tested
 * nowhere here.
 */

/* ---------------------------------------------------------------------- */
/* Doubles                                                                 */
/* ---------------------------------------------------------------------- */

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
    of(type) { return log.filter((e) => e.type === type).map((e) => e.payload); },
  };
}

function makeRelics() {
  const bus = makeBus();
  const player = { position: new THREE.Vector3(0, 0, 0) };
  const economy = { credits: 0, add(n) { this.credits += n; return this.credits; } };
  const inventory = {
    stored: [], acquired: [],
    add(id, n) { this.stored.push([id, n]); return n; },
    acquire(id, n) { this.acquired.push([id, n]); return { taken: n }; },
  };
  const cosmetics = {
    owned: new Set(),
    unlock(id) { if (this.owned.has(id)) return false; this.owned.add(id); return true; },
  };
  const mounts = { powers: [], grantPower(m, p, t) { this.powers.push([m, p, t]); } };
  const relics = new Relics({
    scene: new THREE.Scene(), bus, physics: null, player, economy, inventory, cosmetics, mounts,
  });
  return { bus, player, economy, inventory, cosmetics, mounts, relics };
}

/**
 * Install `n` sites without a physics probe, exactly as `_onWorld` would leave
 * them, and apply whatever tally is already stored for that world.
 */
function place(ctx, worldId, n) {
  ctx.relics._worldId = worldId;
  ctx.relics.sites.length = 0;
  for (let i = 0; i < n; i++) {
    ctx.relics.sites.push({ pos: new THREE.Vector3(i * 20, 20, 0), taken: false, phase: 0 });
  }
  ctx.relics._applyFound();
  ctx.relics._announce();
}

/** Walk onto one relic and run a frame. */
function collect(ctx, i) {
  const s = ctx.relics.sites[i];
  ctx.player.position.set(s.pos.x, s.pos.y - 1.0, s.pos.z);
  ctx.relics.update(1 / 60);
}

/* ====================================================================== */
/* The tally                                                               */
/* ====================================================================== */

test('picking one up moves the counter, and the counter is published', () => {
  const ctx = makeRelics();
  place(ctx, 'citadel', 6);
  assert.equal(ctx.relics.remaining, 6);
  assert.equal(ctx.relics.found, 0);

  collect(ctx, 0);
  assert.equal(ctx.relics.found, 1);
  const changed = ctx.bus.of('relics:changed').at(-1);
  assert.deepEqual(
    { found: changed.found, remaining: changed.remaining, total: changed.total },
    { found: 1, remaining: 5, total: 6 },
    'relics:changed does not carry the filled part of the progress bar'
  );
  // The event that had no listeners at all before this drop.
  const found = ctx.bus.of('relic:found').at(-1);
  assert.equal(found.found, 1);
  assert.equal(found.total, 6);
  assert.equal(found.worldId, 'citadel');
});

test('the marker list is scratch, not a fresh array every frame', () => {
  /* `Minimap.update` reads this getter, and `HUD.update` calls `Minimap.update`
   * every frame, so a getter that built an array here was thirty pushes and one
   * array of garbage per frame in the one world that has relics. House rule is
   * module-level scratch only on a frame path.
   *
   * Identity is the test that can actually fail: it holds only if the same
   * array is refilled. Mutation that kills it: `return [...list]`. */
  const ctx = makeRelics();
  place(ctx, 'citadel', 6);
  const a = ctx.relics.markers;
  assert.equal(a.length, 6);
  collect(ctx, 0);
  const b = ctx.relics.markers;
  assert.equal(b.length, 5, 'the scratch was not refilled, only reused');
  assert.equal(a, b, 'the markers getter allocated a new array');
});

test('a world that forbids relics announces ZERO, so the HUD row can go away', () => {
  /* `_onWorld` returned before `_announce` for a world with `relics: false`,
   * which was harmless while `relics:changed` had no listener. This drop gives
   * it one: `HUD._setDiscoveries` keeps `_relicTotal` from the last
   * announcement, so a player who had found 3 of 6 in the citadel and portalled
   * into the maze (`MazeWorld` sets `relics: false`) went on reading
   * "Relics 3/6" in a world with none. `Viewpoints._onWorld` announces on every
   * path already. */
  const ctx = makeRelics();
  place(ctx, 'citadel', 6);
  collect(ctx, 0); collect(ctx, 1); collect(ctx, 2);
  assert.equal(ctx.bus.of('relics:changed').at(-1).total, 6);

  ctx.relics._onWorld('maze', { rules: { relics: false } });
  const last = ctx.bus.of('relics:changed').at(-1);
  assert.deepEqual({ worldId: last.worldId, found: last.found, remaining: last.remaining, total: last.total },
    { worldId: 'maze', found: 0, remaining: 0, total: 0 },
    'a relic-free world left the last world\'s count standing on the HUD');
});

test('the tally round-trips and a reloaded world stays stripped', () => {
  /* The defect, stated as a test: three relics found, save, reload, and the
   * world must still hold three fewer. Mutation that kills it: drop `relics`
   * from `SaveGame._snapshot`, or drop `serialize` from this file. */
  const a = makeRelics();
  place(a, 'citadel', 6);
  collect(a, 0); collect(a, 1); collect(a, 2);
  assert.equal(a.relics.found, 3);
  const snap = JSON.parse(JSON.stringify(a.relics.serialize()));

  const b = makeRelics();
  assert.equal(b.relics.deserialize(snap), true);
  place(b, 'citadel', 6);
  assert.equal(b.relics.found, 3, 'the reloaded world put every relic back');
  assert.equal(b.relics.remaining, 3);
  assert.equal(b.economy.credits, 0, 'restoring the tally paid the relics again');
});

test('the tally is per world', () => {
  const ctx = makeRelics();
  place(ctx, 'citadel', 6);
  collect(ctx, 0); collect(ctx, 1);
  place(ctx, 'medieval', 6);
  assert.equal(ctx.relics.found, 0, 'the medieval valley inherited the citadel tally');
  place(ctx, 'citadel', 6);
  assert.equal(ctx.relics.found, 2, 'the citadel tally was lost on the way back');
});

test('a restore that lands while the world is already up is applied to it', () => {
  /* `SaveGame.load` only rebuilds the world when the save names a DIFFERENT
   * one, so pressing Load in the citadel with a citadel save never emits
   * `world:changed` - and a deserialize that only wrote `_found` would leave
   * thirty relics standing with a tally that said otherwise. */
  const ctx = makeRelics();
  place(ctx, 'citadel', 6);
  assert.equal(ctx.relics.found, 0);
  ctx.relics.deserialize({ found: { citadel: 4 } });
  assert.equal(ctx.relics.found, 4, 'the live world ignored the restored tally');
  assert.equal(ctx.relics.markers.length, 2, 'the map still shows relics that were collected');
});

test('a load REPLACES the tally, so progress can go down as well as up', () => {
  /* A load is a load, not a merge. Collect the lot, then load a save written
   * before any of it: the additive version kept all six marked taken and the
   * milestone cosmetic still paid, so the player kept progress the save they
   * loaded does not contain. `MountManager.deserialize` writes the same rule
   * down as the house convention. */
  const ctx = makeRelics();
  place(ctx, 'citadel', 6);
  for (let i = 0; i < 6; i++) collect(ctx, i);
  assert.equal(ctx.relics.found, 6);
  assert.ok(ctx.relics._paid.size > 0, 'the milestones must have paid, or this proves nothing');

  ctx.relics.deserialize({ found: { citadel: 2 }, paid: [] });
  assert.equal(ctx.relics.found, 2, 'the restore merged instead of replacing');
  assert.equal(ctx.relics.remaining, 4, 'four sites must be standing again');
  assert.equal(ctx.relics._paid.size, 0, 'a milestone the loaded save never reached stayed paid');

  // A world absent from the payload is a world with nothing found in it, which
  // is precisely what `serialize` writes for a zero tally.
  place(ctx, 'race', 3);
  collect(ctx, 0);
  ctx.relics.deserialize({ found: { citadel: 2 } });
  assert.equal(ctx.relics.found, 0, 'a world left out of the payload kept its stale tally');
});

test('a corrupt save leaves the world playable', () => {
  const ctx = makeRelics();
  place(ctx, 'citadel', 6);
  for (const bad of [null, 42, 'x', [], { found: 3 }, { found: { citadel: 'lots' } }]) {
    assert.doesNotThrow(() => ctx.relics.deserialize(bad), `threw on ${JSON.stringify(bad)}`);
  }
  assert.equal(ctx.relics.found, 0, 'rubbish in the save marked relics collected');
});

/* ====================================================================== */
/* The prizes                                                              */
/* ====================================================================== */

test('half the relics pays an item, once', () => {
  const ctx = makeRelics();
  place(ctx, 'citadel', 6);
  collect(ctx, 0); collect(ctx, 1);
  assert.deepEqual(ctx.inventory.acquired, [], 'the halfway prize paid at 2 of 6');

  collect(ctx, 2);
  assert.deepEqual(ctx.inventory.acquired, [[HALFWAY_ITEM, HALFWAY_ITEM_QTY]],
    'the halfway prize did not pay at 3 of 6');

  collect(ctx, 3);
  assert.equal(ctx.inventory.acquired.length, 1, 'the halfway prize paid twice');
});

test('the last relic pays credits, a cosmetic and a mount power - once', () => {
  const ctx = makeRelics();
  place(ctx, 'citadel', 4);
  for (let i = 0; i < 3; i++) collect(ctx, i);
  assert.equal(ctx.cosmetics.owned.size, 0, 'the set prize paid before the set was complete');

  const before = ctx.economy.credits;
  collect(ctx, 3);
  assert.equal(ctx.economy.credits - before, 120 + SET_CREDITS,
    'the completion bonus is missing or doubled');
  assert.ok(ctx.cosmetics.owned.has(SET_COSMETIC), 'the set cosmetic was never granted');
  assert.deepEqual(ctx.mounts.powers, [[SET_POWER.mount, SET_POWER.power, SET_POWER.tier]]);

  const milestones = ctx.bus.of('relics:milestone').map((m) => m.milestone);
  assert.deepEqual(milestones, ['half', 'set']);
});

test('leaving and re-entering a stripped world pays nothing', () => {
  /* The ordinary way a once-only reward pays twice: `_onWorld` re-marks the
   * first N sites taken, so a naive "have I reached the threshold" check fires
   * again on every entry. Mutation that kills it: drop the `_paid` set. */
  const ctx = makeRelics();
  place(ctx, 'citadel', 4);
  for (let i = 0; i < 4; i++) collect(ctx, i);
  const credits = ctx.economy.credits;

  place(ctx, 'station', 4);
  place(ctx, 'citadel', 4);
  assert.equal(ctx.economy.credits, credits, 're-entering a completed world paid again');
  assert.equal(ctx.cosmetics.owned.size, 1);
  assert.equal(ctx.mounts.powers.length, 1);
  assert.equal(ctx.bus.of('relics:milestone').length, 2, 'the milestones re-fired');
});

test('a milestone already paid is not paid again after a reload', () => {
  const a = makeRelics();
  place(a, 'citadel', 4);
  for (let i = 0; i < 4; i++) collect(a, i);
  const snap = JSON.parse(JSON.stringify(a.relics.serialize()));
  assert.ok(snap.paid.includes('citadel:set'), 'the save does not record which prizes were paid');

  const b = makeRelics();
  b.relics.deserialize(snap);
  place(b, 'citadel', 4);
  assert.equal(b.cosmetics.owned.size, 0, 'a load re-granted the set cosmetic');
  assert.equal(b.bus.of('relics:milestone').length, 0);
});

test('a one-relic world pays BOTH milestones on that relic', () => {
  /* Ceil(1/2) is 1, so the halfway and set thresholds land on the same pickup.
   * Written as two `if`s rather than if/else for exactly this case; an `else`
   * would make the smallest world quietly the cheapest. */
  const ctx = makeRelics();
  place(ctx, 'tiny', 1);
  collect(ctx, 0);
  assert.deepEqual(ctx.bus.of('relics:milestone').map((m) => m.milestone), ['half', 'set']);
});

test('the prizes name things the real catalogues actually sell', () => {
  assert.ok(ITEMS[HALFWAY_ITEM], `no item "${HALFWAY_ITEM}" - acquire() would drop it silently`);
  assert.ok(MOUNT_STATS[SET_POWER.mount]?.includes(SET_POWER.power),
    `${SET_POWER.mount} does not sell "${SET_POWER.power}" - grantPower would drop it silently`);
  assert.ok(CHARACTER_SKINS_BY_ID.has(SET_COSMETIC) || MOUNT_SKINS_BY_ID.has(SET_COSMETIC),
    `"${SET_COSMETIC}" is in neither skin catalogue - unlock() would refuse it silently`);
  // The two set prizes must not be the same skin, or one of them is invisible.
  assert.notEqual(SET_COSMETIC, HALFWAY_ITEM);
});
