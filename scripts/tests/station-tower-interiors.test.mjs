import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildStation, THREE } from './world-kit.mjs';
import { collectParts } from '../../src/dev/GeoParts.js';

/**
 * NOTHING SCATTERED STANDS INSIDE A ROOM THE PLAYER CAN WALK INTO.
 *
 * ── Why this gate exists when there is already a containment gate ────────
 *
 * `station-prop-containment.test.mjs` asks "is A inside B" with exact ray
 * parity and a 50% bar, and its own docstring records why that bar cannot go
 * lower: a building IS a set of overlapping boxes and half the population is
 * standing correctly inside something by design. That gate is blind to this
 * defect in BOTH directions:
 *
 *  - A LONG THIN THING DILUTES. The hologram advertising mast at (-24, 96)
 *    ran fourteen metres up through four storeys of a habitat tower, and only
 *    one metre of it was in any single slab - about 7% of its volume, far
 *    under the bar. The one ad mast the containment gate did catch, it caught
 *    by its projector CONE landing in a roof slab of comparable size.
 *  - AN EMPTY ROOM CONTAINS NOTHING. Ray parity tests the prop against a
 *    host's triangles, and the volume a room encloses has no triangles in it.
 *
 * And in the world, `_footprintClear` was blind for the mirror-image reason:
 * it samples `physics.containsPoint`, and the inside of a building is exactly
 * the volume where that is false. That is what a room IS. So three separate
 * scatter passes read the inside of a habitat tower as prime open deck.
 *
 * An ENTERABLE VOLUME is the one host class where "should A be inside B"
 * needs no architectural argument - the question `isDesignedContainer` exists
 * to refuse in general, because ray parity can never answer it. A player can
 * stand in here; nothing scattered may. So this gate is ZERO, not a ratchet.
 *
 * ── Oriented, because an AABB invented a defect ──────────────────────────
 *
 * The first probe for this used each interior group's bounding box and
 * reported six pieces. Four were one avenue lamp at (-33.8, 79.8), which is
 * inside the AABB of a tower yawed 1.05 rad and about two metres OUTSIDE the
 * building. `buildTower` therefore records `{x, z, hx, hz, yaw}` where the
 * tower is built, while yaw is still a number, and this test rotates into
 * that frame. The corroboration below is what stops the registry being
 * trusted blindly: a footprint that has drifted from the geometry it claims
 * to describe would let anything through.
 *
 * ── And then a shop ──────────────────────────────────────────────────────
 *
 * The registry began as the fourteen towers, and a steam vent immediately
 * landed in the floor slab of commercial unit -1:3 at (134, -21) - one of the
 * three in `OPEN_SHOPS`, so a room with a door. The class was never "towers";
 * it is "volumes the station encloses", and the twelve commercial units are
 * now in it too. Only the towers have a scene node of their own, so the
 * corroboration below runs on the entries that name a group and requires at
 * least six of them; a unit drawn into the shared commercial batch is taken
 * on trust rather than being given a group it does not need, because inventing
 * scene structure to satisfy a test puts the test in the world.
 */

test('no scattered prop stands inside a room the station encloses', async () => {
  const { world } = await buildStation();
  const rooms = world._rooms ?? [];

  /* NOT VACUOUS. An empty registry - a rename in `buildTower`, a reset that
   * ran in the wrong order - would pass this file silently forever, which is
   * the exact failure mode this project has shipped before. */
  assert.ok(rooms.length >= 6, `expected the habitat towers to register rooms, found ${rooms.length}`);

  /* ── The registry answers to the geometry ─────────────────────────────
   * Each declared footprint must be corroborated by the interior group it
   * names: the group must exist, and its bounding box must contain the
   * footprint's centre and be no more than 1.5x its diagonal. That catches a
   * footprint pointing at the wrong tower, or at nothing. */
  const groups = new Map();
  world.group.traverse((o) => { if (/^tower-interior-/.test(o.name ?? '')) groups.set(o.name, o); });
  const box = new THREE.Box3();
  const corroborated = rooms.filter((r) => r.group);
  assert.ok(corroborated.length >= 6,
    `expected at least six rooms to name a scene node, found ${corroborated.length}`);
  for (const r of corroborated) {
    const g = groups.get(r.group);
    assert.ok(g, `room ${r.name} names a group ${r.group} that does not exist`);
    box.setFromObject(g);
    assert.ok(Number.isFinite(box.min.x), `room ${r.name} has an empty interior group`);
    assert.ok(r.x > box.min.x && r.x < box.max.x && r.z > box.min.z && r.z < box.max.z,
      `room ${r.name} centre ${r.x.toFixed(1)},${r.z.toFixed(1)} is outside its own interior`);
    const diag = Math.hypot(box.max.x - box.min.x, box.max.z - box.min.z);
    assert.ok(Math.hypot(r.hx * 2, r.hz * 2) <= diag * 1.5,
      `room ${r.name} claims a footprint larger than the tower it names`);
  }

  const inRoom = (x, z) => rooms.find((r) => {
    const dx = x - r.x, dz = z - r.z;
    const c = Math.cos(-r.yaw), s = Math.sin(-r.yaw);
    return Math.abs(dx * c - dz * s) < r.hx && Math.abs(dx * s + dz * c) < r.hz;
  });

  /* The ambient crowd lives in the dressing group and its instanced meshes
   * inherit that name. People walk indoors; that is what a door is for. */
  const CROWD = new Set();
  for (const k of ['crowd', 'skin']) if (world.mat?.[k]) CROWD.add(world.mat[k]);
  const isCrowd = (p) => p.instanced && CROWD.has(Array.isArray(p.obj.material) ? p.obj.material[0] : p.obj.material);

  const c = new THREE.Vector3(), size = new THREE.Vector3();
  const found = [];
  for (const p of collectParts(world.group)) {
    if (!/dressing/.test(p.mesh) || isCrowd(p)) continue;
    p.box.getSize(size);
    /* Paint is excluded for the reason the containment gate excludes it: a
     * decal on a floor cannot be "inside" the floor in any sense a player
     * notices. Flat in any axis, not only in Y. */
    if (Math.min(size.x, size.y, size.z) < 0.15) continue;
    p.box.getCenter(c);
    const room = inRoom(c.x, c.z);
    if (room) {
      found.push(`${p.mesh}#${p.index} at ${c.x.toFixed(1)},${c.y.toFixed(1)},${c.z.toFixed(1)} is inside ${room.name}`);
    }
  }

  console.log(`  ${rooms.length} rooms (${corroborated.length} with a scene node), `
    + `${found.length} dressing pieces standing in them`);
  for (const line of found) console.log(`    ${line}`);
  assert.equal(found.length, 0,
    `set dressing is standing inside rooms the player can walk into:\n  ${found.join('\n  ')}`);
});
