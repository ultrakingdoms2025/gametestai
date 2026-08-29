import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildStation, THREE } from './world-kit.mjs';
import { resolveSpot, surfaceStack } from '../../src/npc/Grounding.js';

/**
 * THE STATION'S MOBILE NPCs: DOES THE GROUND THEY ARE GIVEN HAVE A PERSON-
 * SHAPED HOLE IN IT?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DEFECT THIS EXISTS FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reported from a live session: "npc that are part in the ground, feet can not
 * be seen". `station-actors.test.mjs` had already cleared the two FIXED
 * populations - 1,887 zone figures and 204 plaza crowd, none of them floating,
 * none of them sunk - and closes with the note that whatever the owner saw
 * "is elsewhere - the mobile NPCs, which are grounded by `src/npc/Grounding.js`
 * and are not these actors". This is elsewhere.
 *
 * ── What the first probe got wrong, and it is the interesting part ─────────
 * The obvious measurement is "does the character stand on the TOP of its
 * column?", i.e. `resolveSurfaceY(...) === surfaceStack(...)[0].y`. On the
 * station that flags 28 of 59 spawns and all but five are correct as authored:
 * the hub is roofed by a service raft at 30-62 m and every civilian on the deck
 * is legitimately "not on top of its column". `Grounding.pickSurface` says so
 * in its own docstring - it exists to keep "a civilian authored under a gantry
 * on the deck instead of on the gantry". A gate on stack position would have
 * been 82% false positives, and the remedy for a false positive here is moving
 * somebody who was standing in the right place.
 *
 * The question a player actually asks is not "which surface" but "is there a
 * person-shaped hole here" - so the discriminator is CONTAINMENT, not height:
 *
 *     physics.containsPoint(x, feet + dy, z)   for dy in {0.15, 0.5, 1.0, 1.6}
 *
 * four samples up a standing body from ankle to shoulder. That flags exactly
 * five, all of them real, and they are two different defects wearing the same
 * symptom:
 *
 *   Inside a PROP on the right floor. Meret Duhamel resolved onto the deck at
 *   0.11 - correct - twenty centimetres inside a 0.4 m square post. Sparrow
 *   Nkemdi likewise, inside a 26.8 x 31.1 x 22.8 m shell. Nothing about the
 *   floor is wrong; the column is occupied.
 *
 *   Under a PLATFORM. The Rogue Security Unit at (72.8, -63.1) resolved to 0
 *   inside a cargo container whose lid is the 2.95 surface directly above it;
 *   the Breaker Frame at (54.8, -31.1) is inside a 21.2 x 2.4 x 21.2 plinth.
 *
 * Both are the same failure of the same funnel. `NPCManager._snapToGround`
 * promises in its own docstring that positions are snapped "so nothing ever
 * spawns embedded in geometry or hovering above it", and `resolveSpot`
 * underneath it searches outward on rings of 1.5, 3, 6 and 12 m when a column
 * has NO FLOOR - but never when the floor it found is inside something. An
 * occupied column and an empty one are the same defect from the character's
 * point of view and they now take the same escape.
 *
 * ── The blind spot, stated so nobody trusts this too far ──────────────────
 * `Physics.containsPoint` branches on `box` and `heightfield` and has no case
 * for `mesh`, the triangle soup `_collisionSoup` registers. So this gate is a
 * LOWER BOUND on burial: a character embedded in something that exists only as
 * soup reads clean here. It catches what it catches because the station's
 * `_solidifyStructure` emits boxes, which is where its props and platforms are.
 *
 * ── Why the bound is zero ────────────────────────────────────────────────
 * The same argument the seat check in `station-actors.test.mjs` makes. A band
 * inherited from a defective measurement reads as coverage and is not; every
 * spawn and every waypoint on this station now resolves into clear air, so the
 * honest assertion is that it stays that way.
 */

/** Ankle, shin, waist, shoulder. Four samples up a standing 1.8 m body. */
const BODY = [0.15, 0.5, 1.0, 1.6];

/** True when a character standing at (x, feet, z) has geometry inside it. */
function buried(physics, x, feet, z, v) {
  for (const dy of BODY) if (physics.containsPoint(v.set(x, feet + dy, z))) return true;
  return false;
}

/** Every spawn and every patrol waypoint, as one flat list of things to stand. */
function stances(world) {
  const out = [];
  for (const s of world.npcSpawns ?? []) {
    const name = s.name ?? '(unnamed)';
    out.push({ what: name, p: s.position });
    for (const [i, w] of (s.patrol ?? []).entries()) out.push({ what: `${name} wp${i}`, p: w });
  }
  return out;
}

test('no station NPC is spawned inside solid geometry', async () => {
  const { world, physics } = await buildStation();
  const v = new THREE.Vector3();
  const spot = new THREE.Vector3();

  const sunk = [];
  let n = 0;
  for (const { what, p } of stances(world)) {
    n++;
    /* Through the real funnel, not a reimplementation of it. `_snapToGround`
     * delegates to `resolveSpot` and adds only the deep-water walk, which the
     * station has no water for - so this is the position the game gives the
     * character, arrived at the way the game arrives at it. */
    const r = resolveSpot(physics, p, spot);
    const feet = r ?? p;
    if (buried(physics, feet.x, feet.y, feet.z, v)) {
      sunk.push({
        what,
        at: `${feet.x.toFixed(1)}, ${feet.y.toFixed(2)}, ${feet.z.toFixed(1)}`,
        column: surfaceStack(physics, feet.x, feet.z, p.y + 40).slice(0, 5)
          .map((q) => q.y.toFixed(2)).join(' '),
      });
    }
  }

  console.log(`  ${n} spawns + waypoints, ${sunk.length} standing inside solid geometry`);
  for (const s of sunk.slice(0, 8)) console.log(`    ${s.what} @ ${s.at}  column: ${s.column}`);

  assert.deepEqual(sunk.map((s) => s.what), [],
    `${sunk.length} NPC stances resolve to a point inside solid geometry`);
});

test('a spawn moved off an occupied column does not travel far enough to change district', async () => {
  const { world, physics } = await buildStation();
  const spot = new THREE.Vector3();

  /* The escape hatch searches rings at 1.5, 3, 6 and 12 m, and 12 m is a long
   * way on a plaza - far enough to put a quest giver on the wrong side of a
   * wall from the stall they belong to. So the runtime keeps the 12 m ring,
   * because being moved is always better than being buried, and the GATE draws
   * the line at 6: past that, a character has stopped being nudged clear of a
   * prop and started being relocated, and that is a placement to fix at source.
   *
   * Seventeen stances move today and fourteen of them clear on the first or
   * second ring. The three that need the full 6 m are all inside volumes too
   * large to step out of, and all three are moved to somewhere their author
   * would recognise:
   *
   *   Sparrow Nkemdi is authored at the cargo yard's exact centre and is its
   *   maintenance engineer; the centre is inside a 26.8 x 31.1 x 22.8 m shell,
   *   and 6 m north puts her on the yard deck she works on.
   *
   *   Hask Merrow's wp1 and wp2 are two legs of a walking round that pass
   *   through his own shop unit. `StationWorld` already records what happens
   *   to a character inside one - "Merrow is not in his shop, he is on its
   *   roof at 9.4 m" - because `resolveCapsule` depenetrates straight up with
   *   no lateral component and the character then climbs. Moving the waypoints
   *   onto the pavement is the same remedy that docstring chose for the four
   *   traders beside him.
   *
   *   Skirmish Drone wp1 is a hostile patrol corner, and a hostile's route has
   *   no authored relationship to defend.
   */
  let worst = 0, worstWhat = '';
  const moved = [];
  for (const { what, p } of stances(world)) {
    const r = resolveSpot(physics, p, spot);
    if (!r) continue;
    const d = Math.hypot(r.x - p.x, r.z - p.z);
    if (d > 0.01) moved.push(`${what} ${d.toFixed(1)}m`);
    if (d > worst) { worst = d; worstWhat = what; }
  }

  console.log(`  ${moved.length} stances nudged clear, worst ${worst.toFixed(2)} m (${worstWhat})`);
  assert.ok(worst <= 6.01,
    `${worstWhat} was moved ${worst.toFixed(2)} m from where it was authored - fix the placement, do not widen this`);
});
