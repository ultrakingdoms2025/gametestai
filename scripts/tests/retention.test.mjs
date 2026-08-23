import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

const { Caches, cacheSiteId, RESTOCK_SECONDS } = await import('../../src/systems/Caches.js');
const { Retention, dayKey, weekKey, seasonKey } = await import('../../src/systems/Retention.js');
const { Charters } = await import('../../src/systems/Charters.js');
const { EventBus } = await import('../../src/core/EventBus.js');

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
/**
 * CRLF, and the reason this helper exists rather than a bare readFileSync.
 *
 * `core.autocrlf` has made a source scrape green in one checkout and red in
 * another three times in this repository, most recently today. Every anchor
 * below is written against '\n'.
 */
const read = (...p) => readFileSync(join(root, ...p), 'utf8').replace(/\r\n/g, '\n');

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE RETENTION LOOP
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Design: `docs/superpowers/specs/2026-08-23-retention-loops-design.md`.
 *
 * There are four failures worth building a file to catch, and every case below
 * is one of them.
 *
 *   1. A CACHE THAT RESTOCKS ON A PORTAL HOP. `Caches._onWorld` cleared its
 *      site list and re-stocked from scratch, so stepping through a gateway and
 *      back refilled every cache in the world you left. The 210-second timer was
 *      decoration and the real interval was two portal transits. That is an
 *      unbounded item faucet in a game the phase before this one measured at 22
 *      credit sources against 5 sinks, and cache loot converts to credits at any
 *      market. The persistence cases below are the fix, and they FAIL on the
 *      old file.
 *
 *   2. AN INDEX WHERE AN IDENTITY BELONGS. `Relics.serialize` once wrote
 *      `{ found: { citadel: 17 } }` and a reload marked the first seventeen
 *      sites in publication order - the tally right, every marked thing wrong.
 *      Cache placement is seeded but PROBED against live physics, so the site
 *      that was index 4 is index 3 the day somebody builds a terrace. There is
 *      a case that reorders a world's sites and insists the right one is still
 *      empty.
 *
 *   3. A DAILY THAT CAN BE FARMED. Brief 5.5 forbids it. The guarantee here is
 *      not a rate cap - see the design's section 0 for why the one section 6
 *      proposed cannot be reached - it is that a daily can only be completed as
 *      often as a record column advances, and every record column is an identity
 *      set capped by content. There is a case that runs the clock forward a
 *      hundred days with no play in between and insists nothing was claimed.
 *
 *   4. A LOOP THAT PAYS CREDITS. The whole-game faucet is over 250,000 CR and
 *      one clear of one world out of eighteen buys 90% of everything permanent.
 *      A daily that pays makes that worse. The last case scrapes the system for
 *      an economy reference, so nobody can quietly give it one.
 */

/* ====================================================================== */
/* Rigs                                                                    */
/* ====================================================================== */

/**
 * A world that nominates its own cache sites, with a finite `y` on each.
 *
 * The authored channel with a height is the one path through `Caches._onWorld`
 * that does not consult physics at all (`_onWorld` skips the probe when a
 * nomination carries a finite y, because a world naming a deck under its own
 * roof is a decision and not a hint). That is what lets these cases drive the
 * REAL placement code with a physics stub that answers nothing: what is under
 * test is the restock ledger, not the dart loop.
 */
function fakeWorld(id, sites) {
  return {
    id,
    cacheSites: sites,
    contentBounds: {
      min: new THREE.Vector3(-180, 0, -180),
      max: new THREE.Vector3(180, 60, 180),
    },
  };
}

/** A pickup pool that hands back plain objects. `Loot` is not under test. */
function fakeLoot() {
  const spawned = [];
  const despawned = [];
  return {
    spawned,
    despawned,
    spawn(pos, contents, opts) {
      const p = { active: true, contents, pos: pos.clone(), tag: opts?.tag ?? null };
      spawned.push(p);
      return p;
    },
    despawn(p) {
      if (!p?.active) return false;
      p.active = false;
      despawned.push(p);
      return true;
    },
  };
}

/** Answers nothing, so `_findHigh` places nothing and only the authored sites land. */
const deadPhysics = { raycast: () => null, groundHeight: () => null };

function cacheRig({ at = 0 } = {}) {
  const bus = new EventBus();
  const loot = fakeLoot();
  let clock = at;
  const caches = new Caches({
    bus,
    physics: deadPhysics,
    loot,
    worldManager: null,
    now: () => clock,
  });
  return {
    bus,
    caches,
    loot,
    get now() { return clock; },
    advance(seconds) { clock += seconds * 1000; },
    enter(id, sites) { bus.emit('world:changed', { id, world: fakeWorld(id, sites) }); },
    collect(pickup) { bus.emit('loot:collected', { pickup }); },
  };
}

/* ---------------------------------------------------------------------- */

/**
 * A record board without eighteen built worlds.
 *
 * `Charters` is driven through its real public API - the same `relics:changed`
 * the live game emits, and a relic ledger stood in for by an object with the
 * `serialize()` shape `Relics` actually returns. What is under test in every
 * case below is `Retention`, so the board is real and the worlds are not.
 */
function boardRig({ at = Date.parse('2026-08-23T09:00:00Z'), worlds = ['medieval', 'citadel', 'sports'] } = {}) {
  const bus = new EventBus();
  const found = {};
  const wm = {
    ids: [...worlds],
    displayNameOf: (id) => id,
    get active() { return null; },
  };
  const relics = { serialize: () => ({ foundIds: found }) };
  const charters = new Charters({ bus, worldManager: wm, relics });
  let clock = at;
  const caches = { consigned: [], consign(id) { this.consigned.push(id); return 1; } };
  const retention = new Retention({ bus, charters, caches, now: () => clock });

  const rig = {
    bus, charters, retention, caches, found,
    get now() { return clock; },
    setClock(ms) { clock = ms; },
    advanceDays(n) { clock += n * 86400000; },
    /** Publish a world's relic denominator, which is how a record becomes known. */
    publish(worldId, total) { bus.emit('relics:changed', { worldId, total }); },
    /** Find `n` more relics in a world, by identity. */
    find(worldId, n) {
      const list = (found[worldId] ??= []);
      for (let i = 0; i < n; i++) list.push(`${worldId}-relic-${list.length}`);
      bus.emit('relics:changed', { worldId, total: rig._totals[worldId] });
    },
    _totals: {},
  };
  rig.publish = (worldId, total) => {
    rig._totals[worldId] = total;
    bus.emit('relics:changed', { worldId, total });
  };
  return rig;
}

/* ====================================================================== */
/* 1. A cache emptied stays emptied                                        */
/* ====================================================================== */

test('an emptied cache is still empty after a portal hop', () => {
  const r = cacheRig();
  const sites = [{ x: 0, y: 12, z: 0 }, { x: 90, y: 12, z: 90 }, { x: -90, y: 12, z: -90 }];
  r.enter('station', sites);
  assert.equal(r.caches.all.length, 3, 'the authored sites did not land');
  assert.ok(r.caches.all.every((s) => s.pickup), 'a fresh world stocks every site');

  const taken = r.caches.all[1];
  r.collect(taken.pickup);
  assert.equal(taken.pickup, null);

  /* The whole defect in one line: leave and come back. Before this phase
   * `_onWorld` cleared `sites` and re-stocked everything, so the restock timer
   * was worth two portal transits and cache loot was unbounded. */
  r.enter('medieval', [{ x: 0, y: 8, z: 0 }]);
  r.enter('station', sites);

  const again = r.caches.all.find((s) => Math.round(s.pos.x) === 90);
  assert.ok(again, 'the site moved between two identical placements');
  assert.equal(again.pickup, null, 'a portal hop restocked an emptied cache');
  assert.ok(again.restock > 0 && again.restock <= RESTOCK_SECONDS,
    `the returning site carries no restock countdown (${again.restock})`);
});

test('an emptied cache comes back when its timer really elapses', () => {
  const r = cacheRig();
  const sites = [{ x: 0, y: 12, z: 0 }];
  r.enter('station', sites);
  r.collect(r.caches.all[0].pickup);

  r.advance(RESTOCK_SECONDS - 1);
  r.enter('medieval', [{ x: 0, y: 8, z: 0 }]);
  r.enter('station', sites);
  assert.equal(r.caches.all[0].pickup, null, 'it restocked a second early');

  r.advance(2);
  r.enter('medieval', [{ x: 0, y: 8, z: 0 }]);
  r.enter('station', sites);
  assert.ok(r.caches.all[0].pickup, 'the timer elapsed and the cache stayed empty');
});

test('the emptied set is keyed by identity, not by index', () => {
  /* Placement is seeded, but it is also PROBED against live physics, so the
   * order a world's sites land in is not stable across builds. An index-keyed
   * ledger marks the wrong cache - which is exactly the `Relics` defect. */
  const r = cacheRig();
  const a = { x: 0, y: 12, z: 0 };
  const b = { x: 90, y: 12, z: 90 };
  const c = { x: -90, y: 12, z: -90 };
  r.enter('station', [a, b, c]);
  r.collect(r.caches.all[2].pickup); // the site at (-90, -90)

  // The same three places, published in a different order.
  r.enter('station', [b, c, a]);
  const empty = r.caches.all.filter((s) => !s.pickup);
  assert.equal(empty.length, 1, 'reordering the world changed how many were empty');
  assert.equal(Math.round(empty[0].pos.x), -90,
    'the wrong site is empty - the ledger is keyed by index, not by place');
});

test('the emptied ledger round-trips, and drops what has already elapsed', () => {
  const r = cacheRig({ at: 1_000_000 });
  const sites = [{ x: 0, y: 12, z: 0 }, { x: 90, y: 12, z: 90 }];
  r.enter('station', sites);
  r.collect(r.caches.all[0].pickup);

  const saved = r.caches.serialize();
  assert.ok(saved && typeof saved === 'object');
  const id = cacheSiteId('station', 'high', 0, 0);
  assert.ok(Object.prototype.hasOwnProperty.call(saved.emptied, id),
    `the save does not name the emptied site (${Object.keys(saved.emptied).join(', ')})`);

  const fresh = cacheRig({ at: 1_000_000 });
  assert.equal(fresh.caches.deserialize(saved), true);
  fresh.enter('station', sites);
  assert.equal(fresh.caches.all.find((s) => Math.round(s.pos.x) === 0).pickup, null,
    'a restored save stocked a cache the player had already emptied');

  /* And a deadline that has passed is dropped rather than kept forever: the
   * ledger has to be bounded by the restock window, not by lifetime play. */
  const later = cacheRig({ at: 1_000_000 + (RESTOCK_SECONDS + 5) * 1000 });
  later.caches.deserialize(saved);
  assert.equal(Object.keys(later.caches.serialize().emptied).length, 0);
});

test('consign releases one world, and says how many it released', () => {
  const r = cacheRig();
  const station = [{ x: 0, y: 12, z: 0 }, { x: 90, y: 12, z: 90 }];
  r.enter('station', station);
  r.collect(r.caches.all[0].pickup);
  r.collect(r.caches.all[1].pickup);
  r.enter('medieval', [{ x: 0, y: 8, z: 0 }]);
  r.collect(r.caches.all[0].pickup);

  assert.equal(r.caches.consign('station'), 2);
  assert.equal(r.caches.consign('station'), 0, 'consign is not idempotent');
  // The vale was emptied too and must be untouched by the station's consignment.
  assert.equal(Object.keys(r.caches.serialize().emptied).length, 1);

  r.enter('station', station);
  assert.ok(r.caches.all.every((s) => s.pickup), 'a consigned world did not restock');
});

test('a restore over a live world takes the pickup away with the site', () => {
  /* `_onWorld` builds fresh sites with no pickup, so the only way a STOCKED
   * site meets the restock ledger is a save loaded while a world is up - which
   * `SaveGame` does, in its late progress pass, after the world is built.
   * Dropping the reference without releasing it would leave a collectable cache
   * standing in the world with nothing tracking it: a free pickup, and one that
   * pays again every time the player reloads. */
  const r = cacheRig({ at: 5_000_000 });
  const sites = [{ x: 0, y: 12, z: 0 }, { x: 90, y: 12, z: 90 }];
  r.enter('station', sites);
  const live = r.caches.all[0].pickup;
  assert.ok(live?.active);

  r.caches.deserialize({ emptied: { [cacheSiteId('station', 'high', 0, 0)]: 5_000_000 + 60_000 } });

  assert.equal(r.caches.all[0].pickup, null);
  assert.equal(live.active, false, 'the orphaned pickup is still standing in the world');
  assert.deepEqual(r.loot.despawned, [live]);
  // The site the save said nothing about is untouched.
  assert.ok(r.caches.all[1].pickup?.active);
});

test('Loot clears a world before Caches rebuilds it', () => {
  /* An ordering fact that lives in someone else's file, pinned here because
   * `Caches.update` leans on it: the `!pickup.active` branch there WRITES a
   * restock deadline, and if `Caches` rebuilt its sites before `Loot` released
   * the old world's pickups, entering a world would mark its own caches empty
   * for 210 seconds with nobody having collected anything.
   *
   * The bus fires handlers in subscription order, and both systems subscribe in
   * their constructors, so the guarantee is the construction order in
   * `main.js` and nothing else. */
  const main = read('src', 'main.js');
  const loot = main.indexOf(String.fromCharCode(10) + 'const loot = new Loot(');
  const caches = main.indexOf(String.fromCharCode(10) + 'const caches = new Caches(');
  assert.ok(loot > 0 && caches > 0, 'the construction sites have been renamed');
  assert.ok(loot < caches,
    'Caches now subscribes to world:changed before Loot does, so a world change'
    + ' can mark a cache emptied that nobody collected');
});

/* ====================================================================== */
/* 2. The daily is drawn from what is not finished                         */
/* ====================================================================== */

test('the daily names an incomplete record, never a finished or unknown one', () => {
  const r = boardRig();
  assert.equal(r.retention.daily, null, 'a board with nothing known offered a task');

  r.publish('medieval', 9);
  const task = r.retention.daily;
  assert.ok(task, 'a known incomplete record produced no daily');
  assert.equal(task.worldId, 'medieval');
  assert.equal(task.column, 'relics');
  assert.ok(task.target > task.have, 'the daily is already satisfied on issue');
  assert.ok(task.target <= 9, 'the daily asks for more than the world holds');

  // Finish it outright; there is nothing incomplete left to point at.
  r.find('medieval', 9);
  assert.equal(r.retention.daily, null,
    'the daily still points at a world whose record is complete');
});

test('the daily target survives a reload with the progress unchanged', () => {
  const r = boardRig();
  r.publish('citadel', 40);
  r.find('citadel', 4);
  const first = r.retention.daily;

  /* Derived, never stored. A second system reading the same board on the same
   * day must produce the identical target, or a reload silently moves the
   * goalposts and a half-done task starts again. */
  const twin = new Retention({ bus: new EventBus(), charters: r.charters, now: () => r.now });
  const second = twin.daily;
  assert.equal(second.worldId, first.worldId);
  assert.equal(second.column, first.column);
  assert.equal(second.target, first.target);
  twin.dispose();
});

test('the weekly asks for a different world from the daily', () => {
  const r = boardRig();
  r.publish('medieval', 9);
  r.publish('citadel', 40);
  r.publish('sports', 12);
  const d = r.retention.daily;
  const w = r.retention.weekly;
  assert.ok(d && w);
  assert.notEqual(w.worldId, d.worldId,
    'the weekly landed in the same world as the daily');
  assert.ok(w.target - w.have > d.target - d.have,
    'a week asks for no more than a day does');
});

/* ====================================================================== */
/* 3. Claiming, and the identity it is keyed by                            */
/* ====================================================================== */

test('completing the column claims the day, keyed by the day and not by a count', () => {
  const r = boardRig();
  r.publish('medieval', 9);
  const task = r.retention.daily;
  assert.equal(task.done, false);

  r.find('medieval', task.target - task.have);
  assert.equal(r.retention.daily.done, true, 'the record advanced and no day was claimed');

  const saved = r.retention.serialize();
  assert.deepEqual(saved.done, [`daily/${dayKey(r.now)}`],
    'the claim is not stored as the day it belongs to');
  assert.equal(saved.streak, undefined, 'a derived number was persisted');
  assert.equal(saved.count, undefined, 'a count was persisted');
});

test('a day is claimed once, however many times the board moves', () => {
  const r = boardRig();
  r.publish('citadel', 40);
  let claims = 0;
  /* Only the daily. With one published world the weekly falls back to the same
   * record - deliberately, so a player with one unfinished world still has a
   * week - and counting both would make this case about the fallback. */
  r.bus.on('retention:complete', (e) => { if (e.kind === 'daily') claims++; });

  const task = r.retention.daily;
  r.find('citadel', task.target - task.have);
  assert.equal(claims, 1);
  // Keep playing. The next target is further out; the day does not pay twice.
  r.find('citadel', 12);
  assert.equal(claims, 1, 'the same day was claimed more than once');
  assert.equal(r.retention.serialize().done.filter((k) => k.startsWith('daily/')).length, 1);
});

test('a hundred days of clock with no play claims nothing', () => {
  /* Brief 5.5: not farmable. The guarantee is not a rate cap - it is that a
   * claim requires a record column to advance, and every record column is an
   * identity set capped by content. Moving the clock buys day keys and nothing
   * else. */
  const r = boardRig();
  r.publish('medieval', 9);
  let claims = 0;
  r.bus.on('retention:complete', () => claims++);
  for (let i = 0; i < 100; i++) {
    r.advanceDays(1);
    r.bus.emit('relics:changed', { worldId: 'medieval', total: 9 });
  }
  assert.equal(claims, 0, 'the clock alone claimed a daily');
  assert.equal(r.retention.serialize().done.length, 0);
});

test('a completed daily consigns the caches of the world it named', () => {
  const r = boardRig();
  r.publish('medieval', 9);
  const task = r.retention.daily;
  r.find('medieval', task.target - task.have);
  assert.deepEqual(r.caches.consigned, ['medieval'],
    'the reward is not the cache consignment the design names');
});

/* ====================================================================== */
/* 4. The streak is derived; the season resets nothing                     */
/* ====================================================================== */

test('the streak is computed from the days, never stored', () => {
  const r = boardRig({ at: Date.parse('2026-08-23T09:00:00Z') });
  r.retention.deserialize({
    done: ['daily/2026-08-21', 'daily/2026-08-22', 'daily/2026-08-23', 'daily/2026-08-18'],
    season: [],
  });
  assert.equal(r.retention.streak, 3, 'three consecutive days did not read as a streak of three');

  // A payload that claims a streak it has not earned changes nothing.
  r.retention.deserialize({ done: ['daily/2026-08-23'], season: [], streak: 400 });
  assert.equal(r.retention.streak, 1);
});

test('the season names a window and takes nothing away when it turns over', () => {
  const r = boardRig({ at: Date.parse('2026-08-23T09:00:00Z') });
  const summer = seasonKey(r.now);
  r.bus.emit('charter:restored', { id: 'medieval', name: 'Aldermoor Vale' });
  assert.deepEqual(r.retention.season().worlds, ['medieval']);

  // Six months on: a new window, and the old one is still on the record.
  r.setClock(Date.parse('2027-02-01T09:00:00Z'));
  const winter = seasonKey(r.now);
  assert.notEqual(winter, summer);
  assert.deepEqual(r.retention.season().worlds, [],
    'the new season opened with the last one already in it');
  r.bus.emit('charter:restored', { id: 'citadel', name: 'Sunspire Citadel' });

  const all = r.retention.seasons();
  const past = all.find((s) => s.id === summer);
  assert.ok(past, 'the finished season is gone from the record');
  assert.deepEqual(past.worlds, ['medieval'], 'a season turnover deleted progress');
  assert.deepEqual(r.retention.serialize().season.sort(),
    [`${summer}/medieval`, `${winter}/citadel`].sort());
});

test('nothing this system holds can shrink on its own', () => {
  /* `progressLedger` never subtracts and neither does this. A retention loop
   * that deletes progress teaches people to stop playing. */
  const r = boardRig();
  r.retention.deserialize({ done: ['daily/2026-08-01'], season: ['2026-Q3/medieval'] });
  r.publish('medieval', 9);
  const task = r.retention.daily;
  r.find('medieval', task.target - task.have);
  const after = r.retention.serialize();
  assert.ok(after.done.includes('daily/2026-08-01'), 'an old day was dropped');
  assert.ok(after.season.includes('2026-Q3/medieval'), 'an old season entry was dropped');
});

test('a load is not progress', () => {
  /* `Charters.deserialize` re-derives every record and announces a board that
   * can jump by a hundred relics. That is a load, not a day's play, and a loop
   * that claimed on it would hand a returning player a free daily every boot. */
  const r = boardRig();
  r.publish('citadel', 40);
  let claims = 0;
  // The daily only; the week is a second, legitimate claim off the same run.
  r.bus.on('retention:complete', (e) => { if (e.kind === 'daily') claims++; });

  r.retention.resync();
  r.find('citadel', 30);
  /* `resume`, not the `save:loaded` event: `SaveGame` closes the window with
   * the same method that opened it, because the event is skipped on the
   * failure path and a loop left switched off would be silent. */
  r.retention.resume();
  assert.equal(claims, 0, 'restoring a save claimed the daily');

  // And play after the load claims normally.
  const task = r.retention.daily;
  r.find('citadel', task.target - task.have);
  assert.equal(claims, 1, 'the loop did not resume after a load');
});

test('a load that never emits save:loaded still resumes the loop', () => {
  /* `SaveGame.load` skips its `save:loaded` on the failure path and returns
   * false. If that event were the only thing that closed the window, one failed
   * load would switch the loop off for the rest of the session and say nothing.
   * So the pair is `resync`/`resume`, both called by `_restoreProgress`, and
   * this case is the reason the second is not an event handler. */
  const r = boardRig();
  r.publish('medieval', 9);
  r.retention.resync();
  r.retention.resume();

  let claims = 0;
  r.bus.on('retention:complete', (e) => { if (e.kind === 'daily') claims++; });
  const task = r.retention.daily;
  r.find('medieval', task.target - task.have);
  assert.equal(claims, 1, 'the loop stayed switched off after a load that did not announce');
});

/* ====================================================================== */
/* 5. The loop cannot pay credits                                          */
/* ====================================================================== */

test('the retention system has no credit line at all', () => {
  /* The whole-game faucet is over 250,000 CR against five spend sites, and one
   * clear of one world buys 90% of everything permanent. A daily that pays
   * makes the measured problem worse, so the reward is progress and items and
   * the design says so. This is the gate that stops somebody quietly adding
   * one: giving this system an economy means coming here and arguing for it. */
  const src = read('src', 'systems', 'Retention.js');
  assert.doesNotMatch(src, /economy\s*[?.]*\.\s*(add|spend|set)\s*\(/,
    'Retention acquired a credit line');
  assert.doesNotMatch(src, /credits:changed/, 'Retention emits a credit change');
  assert.doesNotMatch(src, /this\.economy/, 'Retention holds the economy');

  /* And the server half: no retention reason may be mapped, because a mapped
   * reason is a paid reason. `creditReasons.test.ts` already refuses a mapped
   * reason with no emitter, so the pair of them means the loop cannot acquire a
   * credit line on either side of the wire without somebody arguing for it. */
  const pricing = read('site', 'lib', 'creditPricing.ts');
  const table = pricing.slice(pricing.indexOf('export const REASON_KIND'),
    pricing.indexOf('export const DECLARED_KINDS'));
  for (const reason of ['daily', 'weekly', 'streak', 'season', 'retention']) {
    assert.doesNotMatch(table, new RegExp(`^\s*'?${reason}'?\s*:`, 'm'),
      `REASON_KIND maps '${reason}' - the retention loop grew a faucet`);
  }
});

test('the ledger carries the two retention sets and nothing numeric', () => {
  const ledger = read('site', 'lib', 'progressLedger.ts');
  const kinds = ledger.slice(ledger.indexOf('export const KINDS'), ledger.indexOf('export type ProgressKind'));
  assert.match(kinds, /\n\s*retention:\s*\{\s*shape:\s*'set'\s*\}/,
    'the day and week ids do not cross devices');
  assert.match(kinds, /\n\s*season:\s*\{\s*shape:\s*'set'\s*\}/,
    'the season record does not cross devices');
  /* Sets, not values. A value kind would need a merge RULE, and the only
   * honest rule for a streak is "whichever device lied hardest". */
  assert.doesNotMatch(kinds, /retention:\s*\{\s*shape:\s*'value'/);
  assert.doesNotMatch(kinds, /streak/);
});

test('the sync carries the retention sets and unions rather than replaces', async () => {
  const { toPayload, applyState } = await import('../../src/systems/ProgressSync.js');
  const retention = {
    _done: ['daily/2026-08-20'],
    _season: ['2026-Q3/medieval'],
    serialize() { return { done: [...this._done], season: [...this._season] }; },
    deserialize(d) { this._done = [...d.done]; this._season = [...d.season]; return true; },
  };
  const payload = toPayload({ retention });
  const group = payload.items.find((g) => g.kind === 'retention');
  assert.ok(group, 'the day ids never leave the device');
  assert.deepEqual(group.keys, ['daily/2026-08-20']);
  const season = payload.items.find((g) => g.kind === 'season' && g.scope === '2026-Q3');
  assert.ok(season, 'the season record never leaves the device');
  assert.deepEqual(season.keys, ['medieval']);

  /* The phone has a day the desktop does not. `deserialize` REPLACES by
   * design, so the union has to be built before it is handed over - the rule
   * the onboarding block already follows. */
  applyState({
    items: { retention: { '': ['daily/2026-08-21'] }, season: { '2026-Q3': ['citadel'] } },
    values: {},
  }, { retention });
  assert.deepEqual(retention._done.sort(), ['daily/2026-08-20', 'daily/2026-08-21']);
  assert.deepEqual(retention._season.sort(), ['2026-Q3/citadel', '2026-Q3/medieval']);
});

/* ====================================================================== */
/* 6. Period keys                                                          */
/* ====================================================================== */

test('the period keys are UTC and fit the ledger key limit', () => {
  const t = Date.parse('2026-08-23T23:30:00Z');
  assert.equal(dayKey(t), '2026-08-23');
  assert.equal(dayKey(t + 3600000), '2026-08-24');
  // 23 August 2026 is a Sunday, which ISO puts at the end of week 34.
  assert.equal(weekKey(t), '2026-W34');
  assert.equal(weekKey(t + 3600000), '2026-W35');
  assert.equal(seasonKey(t), '2026-Q3');
  assert.equal(seasonKey(Date.parse('2026-10-01T00:00:00Z')), '2026-Q4');

  /* `progressLedger` refuses a key over 64 characters. Every id this system
   * can mint is `kind/period` or `season/world`, and both are short - but the
   * check belongs here rather than in a comment. */
  for (const k of [`daily/${dayKey(t)}`, `weekly/${weekKey(t)}`, `${seasonKey(t)}/lodestar-yard`]) {
    assert.ok(k.length <= 64, `${k} is too long for the ledger`);
  }
});
