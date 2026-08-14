import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { MedievalResidency } from '../../src/worlds/medieval/Residency.js';

/**
 * THE STREAMING GATE.
 *
 * `MedievalResidency` is what lets the vale hold a hundred and forty characters
 * against a hard ceiling of seventy-two, and every one of its failure modes is
 * silent:
 *
 *   - a spec whose character the manager wiped, treated as "already done", and
 *     the town stays empty forever (this is a bug that shipped in the maze);
 *   - a despawn radius that is not larger than the spawn radius, and a player
 *     standing on the line makes the hamlet blink;
 *   - a cap that binds on whatever was written last rather than on whatever is
 *     furthest away, which is the exact defect streaming exists to fix;
 *   - a beast pack half-spawned because the room ran out mid-pack.
 *
 * None of them throws. All of them are checkable against a fake manager, which
 * is what this file is.
 */

/** A manager that behaves like `NPCManager` for the three calls that matter. */
function fakeManager({ max = 72 } = {}) {
  const live = new Set();
  return {
    max,
    live,
    spawned: 0,
    despawned: 0,
    spawnOne(spec) {
      if (live.size >= this.max) return null;
      const npc = { spec, id: ++this.spawned };
      live.add(npc);
      return npc;
    },
    spawnBeastGroup(spec, budget) {
      const out = [];
      const want = Math.min(spec.species === 'bear' ? 1 : 4, budget);
      for (let i = 0; i < want; i++) {
        if (live.size >= this.max) break;
        const b = { spec, beast: true, id: ++this.spawned };
        live.add(b);
        out.push(b);
      }
      return out;
    },
    despawn(npc) {
      if (!live.has(npc)) return false;
      live.delete(npc);
      this.despawned++;
      return true;
    },
    owns(npc) { return live.has(npc); },
    /** What `spawnForWorld` / `clear` do to everybody, without warning. */
    wipe() { live.clear(); },
  };
}

const person = (x, z, name) => ({
  position: new THREE.Vector3(x, 0, z), type: 'friendly', name, role: 'loiterer',
});
const pack = (x, z, species = 'wolf') => ({
  position: new THREE.Vector3(x, 0, z), species, territory: 34,
});

/** A residency with `n` people laid along +X at 40 m intervals. */
function line(mgr, n, opts = {}) {
  return new MedievalResidency({
    npcManager: () => mgr,
    people: Array.from({ length: n }, (_, i) => person(i * 40, 0, `P${i}`)),
    ...opts,
  });
}

/* ------------------------------------------------------------------ */
/* Basics                                                              */
/* ------------------------------------------------------------------ */

test('only what is near exists; the rest is a plain object', () => {
  const mgr = fakeManager();
  const res = line(mgr, 30);
  assert.equal(res.rosterSize, 30);
  res.sync(0, 0);
  // Spawn radius 175 over 40 m spacing: indices 0..4 are inside it.
  assert.equal(res.liveCount(), 5, `${res.liveCount()} live, expected the 5 within 175 m`);
  assert.equal(mgr.live.size, 5);
  for (const e of res.people) {
    const near = Math.abs(e.spec.position.x) <= 175;
    assert.equal(!!e.npc, near, `${e.spec.name} at ${e.spec.position.x} m: live=${!!e.npc}`);
  }
});

test('walking along the roster brings people in and lets them go', () => {
  const mgr = fakeManager();
  const res = line(mgr, 30);
  res.sync(0, 0);
  const first = [...mgr.live].map((n) => n.spec.name);
  res.sync(800, 0);
  const later = [...mgr.live].map((n) => n.spec.name);
  assert.ok(later.length > 0, 'walking to the far end of the map emptied the world');
  assert.equal(first.some((n) => later.includes(n)), false, 'nobody was released on the walk');
  assert.ok(mgr.despawned >= first.length);
});

test('the despawn edge is outside the spawn edge, so standing on it cannot blink', () => {
  const mgr = fakeManager();
  const res = new MedievalResidency({ npcManager: () => mgr, people: [person(0, 0, 'A')] });
  assert.ok(res.despawnRadius > res.spawnRadius + 30,
    'the hysteresis gap is too small to survive a stride');
  // Sit exactly between the two edges, from both directions, many times over.
  const mid = (res.spawnRadius + res.despawnRadius) / 2;
  res.sync(0, 0);
  assert.equal(res.liveCount(), 1);
  for (let i = 0; i < 200; i++) {
    res.sync(mid + Math.sin(i) * 15, 0);
    assert.equal(res.liveCount(), 1, `blinked at iteration ${i}`);
  }
  res.sync(res.despawnRadius + 5, 0);
  assert.equal(res.liveCount(), 0);
  // ...and coming back in, it has to reach the SPAWN edge, not the despawn one.
  res.sync(res.despawnRadius - 5, 0);
  assert.equal(res.liveCount(), 0, 'promoted the moment it crossed back over the outer edge');
  res.sync(res.spawnRadius - 5, 0);
  assert.equal(res.liveCount(), 1);
});

/* ------------------------------------------------------------------ */
/* The cap                                                             */
/* ------------------------------------------------------------------ */

test('THE POINT: when the cap binds it drops the FURTHEST, never the last written', () => {
  const mgr = fakeManager();
  /* Thirty people packed inside the spawn radius, a cap of 5. The roster is
   * written nearest-last on purpose - a first-come implementation would keep
   * the five furthest and this is the whole reason the class exists. */
  const people = [];
  for (let i = 29; i >= 0; i--) people.push(person(i * 5, 0, `P${i}`));
  const res = new MedievalResidency({ npcManager: () => mgr, people, maxLive: 5 });
  res.sync(0, 0);
  assert.equal(res.liveCount(), 5);
  const livedNames = [...mgr.live].map((n) => n.spec.name).sort();
  assert.deepEqual(livedNames, ['P0', 'P1', 'P2', 'P3', 'P4'],
    `the cap kept ${livedNames.join(',')} instead of the five nearest`);
});

test('the cap is never exceeded, however the player moves', () => {
  const mgr = fakeManager();
  const people = [];
  for (let i = 0; i < 200; i++) people.push(person((i % 20) * 12 - 120, ((i / 20) | 0) * 12 - 60, `P${i}`));
  const res = new MedievalResidency({ npcManager: () => mgr, people, maxLive: 24 });
  let rnd = 12345;
  const next = () => ((rnd = (rnd * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 400; i++) {
    res.sync((next() - 0.5) * 500, (next() - 0.5) * 500);
    assert.ok(res.liveCount() <= 24, `live count reached ${res.liveCount()}`);
    assert.ok(mgr.live.size <= 24);
  }
});

test('the manager\'s own ceiling is respected even when the residency would allow more', () => {
  const mgr = fakeManager({ max: 8 });
  const people = [];
  for (let i = 0; i < 40; i++) people.push(person(i * 2, 0, `P${i}`));
  const res = new MedievalResidency({ npcManager: () => mgr, people, maxLive: 30 });
  res.sync(0, 0);
  assert.equal(mgr.live.size, 8, 'the residency spawned past the manager\'s hard ceiling');
  assert.ok(res.stats.refused > 0, 'refusals were not counted');
});

/* ------------------------------------------------------------------ */
/* Beasts                                                              */
/* ------------------------------------------------------------------ */

test('a pack arrives whole, and the beast cap counts BODIES not sites', () => {
  const mgr = fakeManager();
  const res = new MedievalResidency({
    npcManager: () => mgr,
    beasts: [pack(0, 0), pack(20, 0), pack(40, 0), pack(60, 0)],
    maxLiveBeasts: 8,
  });
  res.sync(0, 0);
  assert.equal(res.liveBeastCount(), 8, 'the beast budget is being counted in packs, not animals');
  const sites = res.beasts.filter((e) => e.bodies.length).length;
  assert.equal(sites, 2, `${sites} sites spawned - a pack of four should fill four of the eight`);
  for (const e of res.beasts) {
    assert.ok(e.bodies.length === 0 || e.bodies.length === 4, 'a pack arrived half-built');
  }
});

test('a solitary bear and a wolf pack both fit the same budget rule', () => {
  const mgr = fakeManager();
  const res = new MedievalResidency({
    npcManager: () => mgr,
    beasts: [pack(0, 0, 'bear'), pack(10, 0, 'bear'), pack(20, 0, 'wolf')],
    maxLiveBeasts: 8,
  });
  res.sync(0, 0);
  assert.equal(res.liveBeastCount(), 6);
});

test('walking away releases the whole pack, not part of it', () => {
  const mgr = fakeManager();
  const res = new MedievalResidency({ npcManager: () => mgr, beasts: [pack(0, 0)] });
  res.sync(0, 0);
  assert.equal(res.liveBeastCount(), 4);
  res.sync(600, 0);
  assert.equal(res.liveBeastCount(), 0);
  assert.equal(mgr.live.size, 0);
});

test('a pack whose members were killed and cleaned up is not double-despawned', () => {
  const mgr = fakeManager();
  const res = new MedievalResidency({ npcManager: () => mgr, beasts: [pack(0, 0)] });
  res.sync(0, 0);
  const bodies = [...mgr.live];
  for (const b of bodies) mgr.despawn(b);          // the pack dies
  const before = mgr.despawned;
  res.sync(600, 0);                                 // and the player walks off
  assert.equal(mgr.despawned, before, 'despawn was called on bodies that were already gone');
});

/* ------------------------------------------------------------------ */
/* Surviving a manager wipe                                            */
/* ------------------------------------------------------------------ */

test('a cast the manager silently destroyed is rebuilt, not skipped forever', () => {
  /* The maze's shipped bug, reproduced. `clear()` and `spawnForWorld()` dispose
   * every character on any world activation without telling anyone; a residency
   * that trusts its own references sees a non-null `npc` and skips, and the
   * world stays empty with nothing logged anywhere. */
  const mgr = fakeManager();
  const res = line(mgr, 6);
  res.sync(0, 0);
  const before = res.liveCount();
  assert.ok(before > 0);

  mgr.wipe();
  assert.equal(mgr.live.size, 0);
  res.sync(0, 0);
  assert.equal(res.liveCount(), before, 'the residency never noticed its cast was destroyed');
  assert.equal(mgr.live.size, before);
});

test('a wiped BEAST site is repopulated too', () => {
  const mgr = fakeManager();
  const res = new MedievalResidency({ npcManager: () => mgr, beasts: [pack(0, 0)] });
  res.sync(0, 0);
  assert.equal(res.liveBeastCount(), 4);
  mgr.wipe();
  res.sync(0, 0);
  assert.equal(res.liveBeastCount(), 4);
});

test('no manager is not an error - it is a world that has not activated yet', () => {
  const res = new MedievalResidency({ npcManager: () => null, people: [person(0, 0, 'A')] });
  assert.equal(res.sync(0, 0), false);
  assert.equal(res.liveCount(), 0);
  assert.doesNotThrow(() => res.update(0, 0, 1));
  assert.doesNotThrow(() => res.disposeAll());
});

/* ------------------------------------------------------------------ */
/* Throttling and teardown                                             */
/* ------------------------------------------------------------------ */

test('standing still costs one compare, and sprinting cannot outrun the sync', () => {
  const mgr = fakeManager();
  const res = line(mgr, 20);
  res.update(0, 0, 1);
  const syncs = res.stats.syncs;
  for (let i = 0; i < 100; i++) res.update(0, 0, 1 / 60);   // 1.66 s of standing still
  assert.ok(res.stats.syncs - syncs <= 5, `${res.stats.syncs - syncs} syncs while standing still`);

  // A 9 m/s sprint. The 8 m travel trigger has to fire before the hysteresis
  // gap (45 m) is crossed, or somebody walks into view without existing.
  let x = 0;
  const before = res.stats.syncs;
  for (let i = 0; i < 60; i++) { x += 9 / 60; res.update(x, 0, 1 / 60); }
  assert.ok(res.stats.syncs - before >= 1, 'a sprinting player outran the streamer');
});

test('dispose releases everything and can be called twice', () => {
  const mgr = fakeManager();
  const res = new MedievalResidency({
    npcManager: () => mgr, people: [person(0, 0, 'A')], beasts: [pack(10, 0)],
  });
  res.sync(0, 0);
  assert.ok(mgr.live.size > 0);
  res.dispose();
  assert.equal(mgr.live.size, 0);
  assert.doesNotThrow(() => res.dispose());
});

test('the same walk twice produces the same population', () => {
  const walk = [[0, 0], [120, 40], [400, -80], [0, 0], [-300, 200]];
  const run = () => {
    const mgr = fakeManager();
    const res = line(mgr, 40);
    const seen = [];
    for (const [x, z] of walk) {
      res.sync(x, z);
      seen.push([...mgr.live].map((n) => n.spec.name).sort().join(','));
    }
    return seen;
  };
  assert.deepEqual(run(), run());
});
