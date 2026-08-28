import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

import { MAP_OVERLAY_SCHEMA, normaliseOverlayEntries } from './mapOverlaySchema';
// The GAME's applier and physics, imported directly. Not a copy of them, not a
// description of them — the modules the browser runs.
import { Physics } from '../../src/physics/Physics.js';
import { MapOverlay } from '../../src/systems/MapOverlay.js';

/**
 * THE SEAM: a document the editor writes is a document the game can apply.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The editor's half is tested in TypeScript against `normaliseOverlayEntries`.
 * The game's half is tested in `scripts/tests/map-overlay.test.mjs` against
 * hand-written entries. Both were green while proving nothing about each
 * other: each end was tested against a document I wrote by hand for it.
 *
 * The failure that arrangement permits is silent in the worst way. Rename
 * `target.name` to `target.object` on one side and every test stays green;
 * in production the overlay applies zero entries, reports nothing wrong,
 * and the world simply looks like it always did. The admin concludes the
 * editor does not work and has no way to find out why.
 *
 * So this file puts the two halves end to end: normalise as the SAVE path
 * does, hand the result to the REAL `MapOverlay` over a real `Physics`, and
 * check the object actually moved. A field renamed on either side fails here.
 */

function world(id = 'station') {
  const group = new THREE.Group();
  group.name = `world:${id}`;
  const crate = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  crate.name = 'crate.alpha';
  crate.position.set(10, 0, 10);
  group.add(crate);
  group.updateMatrixWorld(true);
  return { id, group, crate };
}

/**
 * A partial EventBus, cast once here rather than at each call site.
 *
 * This case exercises the overlay's apply path, not EventBus's queue, `once`
 * or `off`. Growing the double into a full implementation would produce a test
 * double that itself needs tests; casting at the factory keeps the seam in one
 * place and keeps `tsc --noEmit` clean, which `main` is and should stay.
 */
function bus(): any {
  const handlers = new Map<string, Set<(p: unknown) => void>>();
  return {
    on(name: string, fn: (p: unknown) => void) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(fn);
      return () => handlers.get(name)?.delete(fn);
    },
    emit(name: string, payload: unknown) {
      for (const fn of handlers.get(name) ?? []) fn(payload);
    },
  };
}

/** Exactly what `/api/game/map-overlay` answers, built from the SAVE path. */
function served(rawEntries: unknown[], version = 1) {
  const { entries, rejected } = normaliseOverlayEntries(rawEntries);
  expect(rejected, 'the fixture itself must survive normalisation').toEqual([]);
  return { world: 'station', schema: MAP_OVERLAY_SCHEMA, version, entries, admin: false };
}

describe('an overlay written by the editor applies in the game', () => {
  it('moves the object the admin named, and its collider with it', async () => {
    const document = served([
      {
        kind: 'move',
        id: 'm1',
        target: { name: 'crate.alpha' },
        position: { x: 40, y: 3, z: -20 },
      },
    ]);

    const b = bus();
    const physics = new Physics(b);
    const w = world();
    const collider = physics.addBoxFromObject(w.crate);

    const system = new MapOverlay({
      bus: b,
      physics,
      loot: { spawn: () => null, despawn: () => true },
      // Only `ok` and `json` are read; the rest of Response is not this test's subject.
      fetch: (async () => ({ ok: true, status: 200, json: async () => document })) as unknown as typeof fetch,
    });

    b.emit('world:changed', { id: w.id, world: w });
    await system.applying;

    // The catalogue reports an object's ANCHOR - the world bottom-centre of its
    // bounds - and a move lands the anchor at the target (post-release fix,
    // spec section 14). The 2 m crate's bottom therefore sits at y = 3 and its
    // origin, one metre above it, at y = 4.
    const box = new THREE.Box3().setFromObject(w.crate);
    expect([(box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2]).toEqual([40, 3, -20]);
    expect(w.crate.position.toArray()).toEqual([40, 4, -20]);
    expect(collider!.center.x).toBeCloseTo(40, 6);
    expect(system.report.unresolved).toEqual([]);
    expect(system.report.applied).toEqual([{ id: 'm1', ok: true, colliders: 1 }]);
  });

  it('places the item the admin picked out of the marketplace catalogue', async () => {
    // The shape `MapEditorPanel.addPlace` builds from a catalogue row.
    const document = served([
      {
        kind: 'place',
        id: 'p1',
        item: {
          source_key: 'pack_bullets',
          name: 'Rifle Round Pack',
          config: { effect: 'grant_ammo', ammo_item: 'bullet', amount: 60 },
        },
        position: { x: 5, y: 1, z: 5 },
        quantity: 1,
      },
    ]);

    const spawned: Array<{ contents: unknown; opts: unknown }> = [];
    const b = bus();
    const system = new MapOverlay({
      bus: b,
      physics: new Physics(b),
      loot: {
        spawn: (_p: unknown, contents: unknown, opts: unknown) => {
          spawned.push({ contents, opts });
          return { active: true };
        },
        despawn: () => true,
      },
      // Only `ok` and `json` are read; the rest of Response is not this test's subject.
      fetch: (async () => ({ ok: true, status: 200, json: async () => document })) as unknown as typeof fetch,
    });

    const w = world();
    b.emit('world:changed', { id: w.id, world: w });
    await system.applying;

    expect(system.report.unresolved).toEqual([]);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].contents).toEqual([{ itemId: 'bullet', qty: 60 }]);
  });

  it('a v1 hidden move reaches the game as a remove: the object is hidden AND its collider leaves the physics', async () => {
    const document = served([{ kind: 'move', id: 'h1', target: { name: 'crate.alpha' }, hidden: true }]);
    expect(document.entries).toEqual([{ kind: 'remove', id: 'h1', target: { name: 'crate.alpha' } }]);

    const b = bus();
    const physics = new Physics(b);
    const w = world();
    const collider = physics.addBoxFromObject(w.crate);
    const system = new MapOverlay({
      bus: b,
      physics,
      loot: { spawn: () => null, despawn: () => true },
      fetch: (async () => ({ ok: true, status: 200, json: async () => document })) as unknown as typeof fetch,
    });
    b.emit('world:changed', { id: w.id, world: w });
    await system.applying;

    expect(w.crate.visible).toBe(false);
    expect(physics.has(collider!)).toBe(false);
    expect(system.report.applied).toEqual([{ id: 'h1', ok: true, colliders: 1 }]);
    expect(system.report.unresolved).toEqual([]);
  });
});
