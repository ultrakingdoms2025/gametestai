import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { rig, goto, settle, DT, steerTo } from './_flightrig.mjs';

const { SpaceCombat, GUN, CONVERGE, MAX_SPAN, SHIELD_PER_TIER, SHIELD_FLOOR, SAFE_RADIUS,
  SPAWN_MIN, SPAWN_MAX, LOCK_GRACE, DISENGAGE, TARGET_RANGE, HOLD_FIRE } =
  await import('../../src/ships/SpaceCombat.js');
const { AlienShip, ALIEN_CLASSES, ALIEN_PLANS, buildAlienModel, BREAK_RANGE } =
  await import('../../src/npc/AlienShip.js');
const { DOCK_ANCHOR, BODY_BY_ID, BELT, landableBodies } =
  await import('../../src/worlds/space/Bodies.js');
const { cruiseTopSpeed } = await import('../../src/ships/Flight.js');
const { SHIP_CLASSES } = await import('../../src/ships/ShipStats.js');

/**
 * SHIP-TO-SHIP COMBAT, DRIVEN.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  EVERY CLAIM IN HERE IS FLOWN, NOT DERIVED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The house rule is that for anything a player's BODY does you drive the real
 * integrator and derive nothing, and a dogfight is two bodies doing it at
 * once. So these cases build a REAL `SpaceCombat` over the REAL `Piloting`
 * from `_flightrig.mjs` - the same four real worlds, real `WorldManager`, real
 * `Physics`, real `Flight` - and fly it. The autopilot writes the same five
 * command fields a keyboard writes and the same `input.state.fire` a mouse
 * writes; nothing here calls `place`, sets a velocity, or reaches past a
 * public surface to make a fight come out.
 *
 * The specific things that stubbing would hide, all of which this file caught:
 *
 *   - `Piloting.interdicted` is read inside `_clearOfEverything`, which is
 *     three call frames below `fixedUpdate`. A stub piloting would never run
 *     it, and transit would have gone on quietly cancelling every encounter.
 *   - `SpaceCombat._playable` refuses while `_travelling`, and `_travelling`
 *     is only ever true across a real asynchronous `WorldManager.activate`.
 *   - The launch cone is built from `flight.forward/right/up`, so a wing that
 *     appears behind the player only shows up if the real quaternion is used.
 *
 * ── Floors, and ceilings by ablation ───────────────────────────────────────
 * A "not worse than" assertion with no floor is how this project shipped a
 * world with zero reachable wildlife and 29 green tests. Every measured claim
 * below therefore prints floor / achieved / ceiling, and the ceiling is
 * obtained by ABLATING the mechanism under test - turning the guns off, the
 * lead prediction off, the break-off off - and re-flying the identical case.
 */

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

/** Deterministic 0..1. Every case that spawns anything uses one of these. */
function seeded(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Fire is a mouse button, so the rig's input needs the field the mouse sets. */
function armInput(r) {
  if (!('fire' in r.input.state)) r.input.state.fire = false;
  return r.input;
}

/**
 * A combat system over the shared rig.
 *
 * Built fresh per case and disposed after, because `hostiles` is a pool and a
 * case that inherited another case's wrecks would be measuring the wrong
 * fight. The rig's worlds are NOT rebuilt - that is the 3-6 second part.
 */
async function combatRig({ ship = 'kestrel', seed = 7, powers = null } = {}) {
  const r = await rig();
  armInput(r);
  await goto(r, 'space');
  /* `grantPower` is the real purchase path - `setPowers` does not exist, and
   * writing `_powers` directly would skip `_knownStat`, which is the guard
   * that stops a hull being sold a stat it does not carry.
   *
   * The registry is SHARED across cases and a granted tier is permanent, so a
   * case that wanted a stock hull inherited whatever the last one bought: the
   * per-tier shield case printed "tier 6" for a stock Dray because an earlier
   * case had bought it three tiers. There is no public clear - `grantPower`
   * only ever raises - so the bag is emptied directly, which is the one place
   * in this file that reaches past a public surface and it is a test-isolation
   * reset rather than a shortcut through game logic. */
  delete r.ships._powers[ship];
  if (powers) for (const k in powers) r.ships.grantPower(ship, k, powers[k]);

  const combat = new SpaceCombat({
    scene: r.scene,
    camera: r.camera,
    bus: r.bus,
    input: r.input,
    player: r.player,
    worldManager: r.wm,
    piloting: r.piloting,
    ships: r.ships,
    economy: r.economy,
    rnd: seeded(seed),
  });

  /* Board out in the void rather than at a berth: `board` would otherwise put
   * the hull on its cradle in the yard, and every case here is about what
   * happens 20 km from it. The pose is written through `Flight.place`, which
   * is the same public verb the seams use. */
  r.piloting.board(ship, { silent: true });
  r.player.health = 100;
  r.player.damageTaken = 0;
  /* THE HOLD IS PER-SESSION, NOT PER-HULL.
   *
   * `Piloting` keeps one `_cargo` for the whole mode, so ore stowed in a Dray
   * is still aboard after you park it and board a Pike - which has a hold of
   * zero. It surfaced here as a Pike reporting `4/0 m3`. That is `Piloting`'s
   * behaviour and not this drop's to change, but a case that inherited another
   * case's cargo would measure the wrong thing, so the hold is emptied between
   * them. */
  r.piloting._cargo = Object.create(null);
  r.piloting._cargoUnits = 0;
  return { r, combat };
}

function teardown(r, combat) {
  combat.standDown('test');
  combat.dispose();
  if (r.piloting.active) r.piloting.disembark({ silent: true, force: true });
  r.piloting.interdicted = false;
  r.input.state.fire = false;
}

/** Put the flown hull somewhere, pointing somewhere, at a speed. */
function placeShip(r, at, lookAt, speed = 180) {
  const q = new THREE.Quaternion();
  const m = new THREE.Matrix4();
  m.lookAt(at, lookAt, new THREE.Vector3(0, 1, 0));
  q.setFromRotationMatrix(m);
  r.piloting.flight.place(at, q);
  const fwd = r.piloting.flight.forward(new THREE.Vector3());
  r.piloting.flight.velocity.copy(fwd).multiplyScalar(speed);
  r.piloting._landed = false;
  r.piloting._airborne = true;
}

/**
 * Step the whole thing: piloting first, then combat. Same order as `main.js`.
 *
 * `after` runs when BOTH have stepped, and it exists because of a measurement
 * that lied. `Piloting.interdicted` is written at the end of `combat`'s step
 * and read at the start of `piloting`'s, so a sample taken in `drive` - before
 * either has run - sees the previous step's transit multiplier. On the frame a
 * wing launches that is a stale x8.0, and the interdiction case failed against
 * a number that had already been superseded.
 */
async function step(r, combat, n, drive, after) {
  for (let i = 0; i < n; i++) {
    if (r.piloting._travelling) { await settle(2); continue; }
    drive?.(i * DT, i);
    r.piloting.fixedUpdate(DT, i * DT);
    combat.fixedUpdate(DT, i * DT);
    after?.(i * DT, i);
    if ((i & 31) === 0) await null;
  }
}

const V = (x, y, z) => new THREE.Vector3(x, y, z);

/* ================================================================== */
/* 1. The shape                                                        */
/* ================================================================== */

test('both hostile classes build real, finite, nose-forward geometry', () => {
  for (const id of Object.keys(ALIEN_CLASSES)) {
    const m = buildAlienModel(id);
    /* 250 is a floor, not a target. The first build of these hulls was 192
     * triangles - five profile sections and seven sides - and it read as a
     * pod with sticks on it. What the extra budget bought is SHAPE (a neck, an
     * engine flare, rear strakes, mandibles, spine spikes) rather than
     * smoothness, which is the only kind of triangle worth spending here. */
    assert.ok(m.triangles > 250, `${id}: ${m.triangles} triangles is not a spaceship`);
    assert.equal(m.group.children.length, 4, `${id} must be exactly four draw buckets`);

    /* NAN PROPAGATES THROUGH BLOOM AND BLACKS OUT THE WHOLE FRAME. That is
     * the recorded house rule and it cost this world a day: four boxes with a
     * zero tile put NaN uvs into 19 pixels and 921,600 went black. Every
     * vertex of every new piece of geometry gets checked. */
    let n = 0;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let span = 0;
    for (const child of m.group.children) {
      const a = child.geometry.getAttribute('position');
      for (let i = 0; i < a.count; i++) {
        const x = a.getX(i); const y = a.getY(i); const z = a.getZ(i);
        assert.ok(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z),
          `${id}: non-finite vertex at ${child.name}[${i}]`);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
        span = Math.max(span, Math.abs(x), Math.abs(y));
        n++;
      }
      const nm = child.geometry.getAttribute('normal');
      for (let i = 0; i < nm.count; i++) {
        assert.ok(Number.isFinite(nm.getX(i)) && Number.isFinite(nm.getY(i))
          && Number.isFinite(nm.getZ(i)), `${id}: non-finite normal at ${child.name}[${i}]`);
      }
    }

    /* THE NOSE IS AT -Z, AND THIS IS TESTED AGAINST THE EYE AND THE ENGINES
     * RATHER THAN AGAINST THE EXTENTS.
     *
     * Not a style point: `Flight.FWD_LOCAL` is -Z and `AlienShip._face` builds
     * its quaternion with `Matrix4.lookAt`, whose -Z points at the target. A
     * hull authored the other way flies tail-first and still looks almost
     * right in a screenshot.
     *
     * The first version of this assertion compared the two Z extents, and it
     * was measuring the wrong thing: the skiff's forward-swept BLADES reach
     * further forward than its nose does, which is the entire point of them,
     * so the ratio says less about the facing than about the wings. The eye
     * and the engines are unambiguous - one is the front of the animal and the
     * other is the back. */
    const centroidZ = (name) => {
      const child = m.group.children.find((c) => c.name.endsWith(name));
      const a = child.geometry.getAttribute('position');
      let sum = 0;
      for (let i = 0; i < a.count; i++) sum += a.getZ(i);
      return sum / a.count;
    };
    const eyeZ = centroidZ(':glow');
    const engZ = centroidZ(':engines');
    assert.ok(eyeZ < 0, `${id}: the eye must be forward of the keel origin (z ${eyeZ.toFixed(2)})`);
    assert.ok(engZ > 0, `${id}: the engines must be aft of it (z ${engZ.toFixed(2)})`);
    assert.ok(eyeZ < engZ - 3, `${id}: eye ${eyeZ.toFixed(2)} and engines ${engZ.toFixed(2)} are not opposite ends`);
    assert.ok(minZ < 0 && maxZ > 0,
      `${id}: the hull must straddle its own origin (minZ ${minZ.toFixed(2)}, maxZ ${maxZ.toFixed(2)})`);

    /* ── THE MESH IS TIED BACK TO THE PLAN, BUCKET BY BUCKET ────────────────
     *
     * The plan is authored nose-at-+Z and every emitter negates on the way
     * out, in three separate places - `spindle`'s `ring`, `blade`'s `P`, and
     * the octahedron's own map. Three chances to drop a minus sign, and the
     * eye/engine test above only covers the third: a hull emitted the wrong
     * way round with correctly-emitted glow still passed it, and the mutation
     * run said so twice.
     *
     * So each bucket's forward extremity is checked against the furthest
     * FORWARD thing the plan puts in it. Exact, to a centimetre, because it is
     * the same number arrived at two ways. */
    const plan = ALIEN_PLANS[id];
    const front = (suffix) => {
      const child = m.group.children.find((c) => c.name.endsWith(suffix));
      const a = child.geometry.getAttribute('position');
      let lo = Infinity;
      for (let i = 0; i < a.count; i++) lo = Math.min(lo, a.getZ(i));
      return lo;
    };
    const planNose = Math.max(...plan.sections.map((sec) => sec.z));
    assert.ok(Math.abs(front(':hull') + planNose) < 0.01,
      `${id}: the hull's nose is at z ${front(':hull').toFixed(2)}, but the plan puts it at `
      + `${(-planNose).toFixed(2)} - the spindle emitter has lost its sign`);

    const limbZ = [];
    for (const b of [...(plan.blades ?? []), ...(plan.fins ?? [])]) {
      limbZ.push(...b.root.map((q) => q[2]), ...b.tip.map((q) => q[2]));
    }
    if (plan.arm) limbZ.push(...plan.arm.root.map((q) => q[2]), ...plan.arm.tip.map((q) => q[2]));
    if (plan.spur) limbZ.push(...plan.spur.root.map((q) => q[2]), ...plan.spur.tip.map((q) => q[2]));
    const planLimbNose = Math.max(...limbZ);
    /* THE EYE IS A SEPARATE CLAIM FROM THE SEAMS.
     *
     * The glow bucket holds both, and once the seam count went up from three
     * to nine a mutant that deleted the octahedron outright stopped shifting
     * the bucket's centroid enough to fail anything. "One red slit, not
     * windows" is the first of the three silhouette cues in the header, so it
     * gets an assertion of its own: the forwardmost glow vertex must be the
     * eye's own nose point, which no strip on either hull comes within a metre
     * of. */
    const eyeNose = plan.eye.z + plan.eye.scale[2];
    assert.ok(Math.abs(front(':glow') + eyeNose) < 0.01,
      `${id}: the forwardmost glow sits at z ${front(':glow').toFixed(2)}, but the eye's own `
      + `point belongs at ${(-eyeNose).toFixed(2)} - the eye is missing`);

    assert.ok(Math.abs(front(':limbs') + planLimbNose) < 0.01,
      `${id}: the limbs reach to z ${front(':limbs').toFixed(2)}, but the plan puts them at `
      + `${(-planLimbNose).toFixed(2)} - the blade emitter has lost its sign`);

    /* ── IT TAPERS TO A POINT AT THE FRONT ──────────────────────────────────
     *
     * A profile with a constant radius is a tube, and a tube with wings is
     * what this looked like before the section counts went up. Comparing the
     * radial extent at the two ENDS also catches a flipped spindle from the
     * other direction: a nose is finer than a tail, and a tail is not. */
    const hullMesh = m.group.children.find((c) => c.name.endsWith(':hull'));
    const pos = hullMesh.geometry.getAttribute('position');
    /* HALF the cross-section's own width, not the distance from the Z axis.
     * Every section carries a `y` droop - the skiff's nose sits 0.36 m below
     * the keel line, which is what gives it its hunched profile - so a radius
     * measured from the axis reports that nose at 0.41 m when its true section
     * is 0.05. The first version of this assertion failed on exactly that and
     * called a perfectly good taper a tube. */
    const extentAt = (pick) => {
      let z = pick === 'front' ? Infinity : -Infinity;
      for (let i = 0; i < pos.count; i++) {
        z = pick === 'front' ? Math.min(z, pos.getZ(i)) : Math.max(z, pos.getZ(i));
      }
      let xlo = Infinity; let xhi = -Infinity; let ylo = Infinity; let yhi = -Infinity;
      for (let i = 0; i < pos.count; i++) {
        if (Math.abs(pos.getZ(i) - z) > 0.05) continue;
        xlo = Math.min(xlo, pos.getX(i)); xhi = Math.max(xhi, pos.getX(i));
        ylo = Math.min(ylo, pos.getY(i)); yhi = Math.max(yhi, pos.getY(i));
      }
      return Math.max(xhi - xlo, yhi - ylo) * 0.5;
    };
    const noseR = extentAt('front');
    const tailR = extentAt('back');
    let midR = 0;
    for (let i = 0; i < pos.count; i++) midR = Math.max(midR, Math.abs(pos.getX(i)));
    /* ── NO STRETCHED TRIANGLES ──────────────────────────────────────────────
     *
     * The mutation run found the hole this closes. `spindle` negates the
     * authored Z in TWO places - once in `ring` for the body, once in the
     * `hub` the end caps fan to - and flipping only one of them leaves the
     * extremities, the taper and the eye/engine test all still reading
     * correctly while the nose cap stretches the whole length of the craft.
     * Every assertion above passed on a hull turned inside out.
     *
     * A longest-edge bound catches it and catches the whole family: any sign
     * error, index slip or section swapped out of order produces a triangle
     * that spans much more of the hull than a neighbouring pair of sections
     * ever should. The bound is a fraction of the hull's own length, so it
     * scales with the class rather than being a metre count nobody can check. */
    let longestEdge = 0;
    for (let i = 0; i < pos.count; i += 3) {
      for (let e = 0; e < 3; e++) {
        const a0 = i + e;
        const a1 = i + ((e + 1) % 3);
        longestEdge = Math.max(longestEdge, Math.hypot(
          pos.getX(a0) - pos.getX(a1),
          pos.getY(a0) - pos.getY(a1),
          pos.getZ(a0) - pos.getZ(a1),
        ));
      }
    }
    const hullLen = maxZ - minZ;
    assert.ok(longestEdge < hullLen * 0.4,
      `${id}: a hull triangle has a ${longestEdge.toFixed(2)} m edge on a ${hullLen.toFixed(1)} m craft - `
      + 'something in the emitter is inside out');

    assert.ok(noseR < tailR * 0.5,
      `${id}: nose section ${noseR.toFixed(2)} against tail ${tailR.toFixed(2)} - this is a tube`);
    assert.ok(tailR < midR * 0.6,
      `${id}: the hull does not swell in the middle (tail ${tailR.toFixed(2)}, widest ${midR.toFixed(2)})`);

    /* THE LIMBS ARE THE SILHOUETTE. Drop them and the craft is a lozenge -
     * so they have to reach well outside the hull, and the hit radius is the
     * scale to say "well outside" in. */
    let limbSpan = 0;
    {
      const child = m.group.children.find((c) => c.name.endsWith(':limbs'));
      const a = child.geometry.getAttribute('position');
      for (let i = 0; i < a.count; i++) limbSpan = Math.max(limbSpan, Math.abs(a.getX(i)));
    }
    assert.ok(limbSpan > ALIEN_CLASSES[id].radius * 0.8,
      `${id}: the limbs only reach ${limbSpan.toFixed(1)} m against a ${ALIEN_CLASSES[id].radius} m hull`);
    const len = maxZ - minZ;
    assert.ok(len > span * 1.2,
      `${id}: ${len.toFixed(1)} m long against ${span.toFixed(1)} m of half-span is not a dart`);
    console.log(`  ${id}: ${m.triangles} tris, ${n} verts, ${len.toFixed(1)} m nose-to-tail, `
      + `nose r ${noseR.toFixed(2)} / widest ${midR.toFixed(2)} / tail ${tailR.toFixed(2)}, `
      + `longest edge ${longestEdge.toFixed(2)} m, `
      + `limbs reach ${limbSpan.toFixed(1)} m, glow z ${eyeZ.toFixed(1)}, engines z ${engZ.toFixed(1)}`);
    m.dispose();
  }
});

test('the hit sphere covers the hull it is standing in for', () => {
  /* A radius smaller than the craft is a ship you shoot through; much larger
   * is one you hit by missing. The published radius must sit between the
   * half-span and the half-length. */
  for (const id of Object.keys(ALIEN_CLASSES)) {
    const m = buildAlienModel(id);
    let far = 0;
    for (const child of m.group.children) {
      const a = child.geometry.getAttribute('position');
      for (let i = 0; i < a.count; i++) {
        far = Math.max(far, Math.hypot(a.getX(i), a.getY(i), a.getZ(i)));
      }
    }
    const r = ALIEN_CLASSES[id].radius;
    assert.ok(r > far * 0.35 && r < far * 1.0,
      `${id}: hit radius ${r} against a real extent of ${far.toFixed(1)} m`);
    console.log(`  ${id}: hit radius ${r} m, furthest vertex ${far.toFixed(1)} m`);
    m.dispose();
  }
});

/* ================================================================== */
/* 2. Leading                                                          */
/* ================================================================== */

test('a hostile shoots where the target WILL be, not where it is', () => {
  const model = buildAlienModel('skiff');
  const ship = new AlienShip({ classId: 'skiff', model, rnd: () => 0.5 });
  ship.spawn(V(0, 0, 0), V(0, 0, -600), { holdFire: 0 });
  ship.state = 'ATTACK';

  /* Straight across the nose at 200 m/s, 600 m out - the geometry that makes
   * leading matter at all. `rnd` is pinned at 0.5, which is the centre of the
   * scatter cone, so what is measured is the SOLUTION and not the dispersion. */
  const target = { position: V(0, 0, -600), velocity: V(200, 0, 0), jink: 0 };

  let dir = null;
  ship._shoot(target, (_from, d) => { dir = d.clone(); });
  assert.ok(dir, 'the craft did not fire');

  /* The aim point, projected out to the target's range. */
  const aim = dir.clone().multiplyScalar(600).add(ship.position);
  const lead = aim.x;
  const tof = 600 / ALIEN_CLASSES.skiff.boltSpeed;
  const ideal = 200 * tof;
  console.log(`  lead ${lead.toFixed(1)} m, ideal ${ideal.toFixed(1)} m, `
    + `time of flight ${(tof * 1000).toFixed(0)} ms`);
  assert.ok(lead > ideal * 0.6, `floor: lead ${lead.toFixed(1)} m must exceed ${(ideal * 0.6).toFixed(1)}`);
  assert.ok(lead < ideal * 1.5, `ceiling: lead ${lead.toFixed(1)} m must not exceed ${(ideal * 1.5).toFixed(1)}`);

  /* CEILING BY ABLATION: an infinitely fast bolt needs no lead at all, and the
   * same code must then aim at the target itself. If this still leads, the
   * number above came from somewhere other than the intercept. */
  const inst = new AlienShip({
    classId: 'skiff',
    model,
    rnd: () => 0.5,
  });
  inst.def = { ...ALIEN_CLASSES.skiff, boltSpeed: 1e9 };
  inst.spawn(V(0, 0, 0), V(0, 0, -600), { holdFire: 0 });
  let dir2 = null;
  inst._shoot(target, (_f, d) => { dir2 = d.clone(); });
  const lead2 = dir2.clone().multiplyScalar(600).add(inst.position).x;
  console.log(`  ablated (instant bolt): lead ${lead2.toFixed(3)} m`);
  assert.ok(Math.abs(lead2) < 1, 'ablation: an instant bolt must not be led');
  model.dispose();
});

test('aim scatter widens with range and with how hard the target is jinking', () => {
  /* THE AIM MODEL, MEASURED DIRECTLY.
   *
   * The flown case below shows that jinking cuts the hit rate, but a flown
   * fight has a dozen other things moving in it - closure, angle-off, how
   * often anybody gets a firing solution at all - and the mutation run proved
   * the point: deleting the jink term outright left that case green. So this
   * one holds everything still and measures the ONE number, over enough shots
   * that the sampling noise is smaller than the effect.
   */
  const model = buildAlienModel('skiff');
  const rms = (range, jink) => {
    const rnd = seeded(1234);
    const ship = new AlienShip({ classId: 'skiff', model, rnd });
    ship.spawn(V(0, 0, 0), V(0, 0, -range), { holdFire: 0 });
    /* Stationary target: with no velocity there is no lead, so every radian
     * of deviation from the straight line to it is scatter and nothing else. */
    const target = { position: V(0, 0, -range), velocity: V(0, 0, 0), jink };
    const ideal = V(0, 0, -1);
    /* A stock Kestrel's hit sphere, which is what `_playerRadius` gives it. */
    const subtend = Math.atan((14 * 0.45) / range);
    let sum = 0;
    let inside = 0;
    const N = 600;
    for (let i = 0; i < N; i++) {
      ship._shoot(target, (_from, d) => {
        const a = Math.acos(Math.max(-1, Math.min(1, d.dot(ideal))));
        sum += a * a;
        if (a < subtend) inside++;
      });
    }
    return { rms: Math.sqrt(sum / N), hit: inside / N };
  };

  const nearSteady = rms(200, 0);
  const nearJink = rms(200, 1);
  const farSteady = rms(700, 0);
  const farJink = rms(700, 1);
  const mrad = (x) => `${(x * 1000).toFixed(2)} mrad`;
  const row = (lab, o) => console.log(`  ${lab.padEnd(16)} ${mrad(o.rms).padStart(11)}, `
    + `${(o.hit * 100).toFixed(0)}% inside a Kestrel`);
  row('200 m steady', nearSteady);
  row('200 m jinking', nearJink);
  row('700 m steady', farSteady);
  row('700 m jinking', farJink);

  assert.ok(nearSteady.rms > 0, 'floor: there must be scatter at all');
  assert.ok(farSteady.rms > nearSteady.rms * 1.6,
    `floor: range must widen the cone - ${mrad(farSteady.rms)} against ${mrad(nearSteady.rms)}`);
  assert.ok(nearJink.rms > nearSteady.rms * 2.2,
    `floor: jinking must widen the cone - ${mrad(nearJink.rms)} against ${mrad(nearSteady.rms)}`);

  /* THE HIT FRACTION, WHICH IS THE NUMBER A PLAYER ACTUALLY FEELS.
   *
   * Radians are the mechanism; "how often does a bolt land on me" is the
   * experience, so the floors and the ceilings are stated in it.
   *
   * ── AND THE INTERESTING RESULT IS THAT JINKING DOES NOT SAVE YOU CLOSE IN ──
   * At 200 m even 22.6 mrad of scatter is 4.5 m, and a Kestrel's hit sphere is
   * 6.3 m - so a craft on your tail at knife range hits you whatever you do,
   * and the answer to being there is not to be there. The first version of
   * this case asserted that jinking cut the close-in hit rate and failed at
   * 81%, which was the model telling the truth about its own geometry. The
   * assertion moved to 700 m, where it is the fight the player can win. */
  assert.ok(nearSteady.hit > 0.75,
    `floor: close and steady must be nearly free (${(nearSteady.hit * 100).toFixed(0)}%)`);
  assert.ok(farSteady.hit > 0.2 && farSteady.hit < 0.85,
    `the far end of the range must be a real but poor shot (${(farSteady.hit * 100).toFixed(0)}%)`);
  assert.ok(farJink.hit < farSteady.hit * 0.6,
    `floor: jinking at range must roughly halve it - ${(farJink.hit * 100).toFixed(0)}% `
    + `against ${(farSteady.hit * 100).toFixed(0)}%`);
  assert.ok(farJink.hit > 0.04,
    `ceiling: jinking must not be a cloak (${(farJink.hit * 100).toFixed(0)}%)`);
  model.dispose();
});

test('the two guns converge on the point the reticle is drawn at', async () => {
  /* WHY CONVERGENCE IS TESTED AS GEOMETRY RATHER THAN AS A HIT.
   *
   * With `MAX_SPAN` capping the muzzles at 3.2 m and the smallest target being
   * a 4.2 m skiff, parallel guns would still connect - so no amount of
   * shooting at hostiles can tell the two apart, and the mutation that made
   * them parallel survived every flown case. What convergence actually buys is
   * that the CROSSHAIR IS TRUE: `_drawAim` projects the reticle to exactly
   * `CONVERGE` metres up the nose, and this asserts the bolts arrive there.
   */
  const { r, combat } = await combatRig({ ship: 'dray', seed: 17 });
  try {
    placeShip(r, V(0, 0, -30000), V(0, 0, -31000), 0);
    r.input.state.fire = true;
    await step(r, combat, 1);
    r.input.state.fire = false;

    const b = combat._b;
    const live = [];
    for (let i = 0; i < b.active.length; i++) if (b.active[i]) live.push(i);
    assert.equal(live.length, 2, 'one trigger pull is two bolts');

    /* ONE STEP HAS ALREADY BEEN FLOWN.
     *
     * `_stepBolts` integrates in the same call that `_playerGun` spawned in,
     * so the stored position is 26.7 m down range rather than at the muzzle.
     * The first version of this case ignored that and reported the bolts as
     * 26.66 m from the aim point - which is exactly one step of travel and
     * nothing whatever to do with convergence. Everything below is therefore
     * measured from `-DT`. */
    const at = (i, t) => V(
      b.px[i] + b.vx[i] * t, b.py[i] + b.vy[i] * t, b.pz[i] + b.vz[i] * t,
    );
    const muzzleGap = at(live[0], -DT).distanceTo(at(live[1], -DT));
    const tConverge = CONVERGE / GUN.speed - DT;
    const crossGap = at(live[0], tConverge).distanceTo(at(live[1], tConverge));
    /* The reticle's own point, and how far the bolts are from it. */
    const aimPoint = V(0, 0, -30000 - CONVERGE);
    const missA = at(live[0], tConverge).distanceTo(aimPoint);

    console.log(`  muzzles ${muzzleGap.toFixed(2)} m apart (span cap ${MAX_SPAN} m), `
      + `${crossGap.toFixed(2)} m apart at the ${CONVERGE} m reticle, `
      + `${missA.toFixed(2)} m from the aim point`);
    /* PINNED. `muzzleGap > MAX_SPAN` and `muzzleGap <= MAX_SPAN * 2` are both
     * satisfied by the Dray's 6.40 m at a `MAX_SPAN` of 12, so the cap - half
     * of the fix for "a Dray could never hit anything" - was unguarded: the
     * mutation `MAX_SPAN 3.2 -> 12.0` stayed green. The gap IS twice the cap by
     * construction (`_playerGun` clamps `length * 0.22` to `MAX_SPAN` per
     * side), so that is what is asserted. */
    assert.equal(+muzzleGap.toFixed(2), 6.40,
      `the Dray's muzzles sit 2 x MAX_SPAN apart; ${muzzleGap.toFixed(2)} m means the cap moved`);
    assert.ok(muzzleGap > MAX_SPAN, `the muzzles must be apart at the hull (${muzzleGap.toFixed(2)} m)`);
    assert.ok(crossGap < 0.6,
      `floor: the bolts must meet at the reticle - ${crossGap.toFixed(2)} m apart`);
    assert.ok(missA < 0.6,
      `floor: they must meet ON the reticle, not merely near each other - ${missA.toFixed(2)} m off`);
    /* The Dray is the case that matters: `length * 0.22` is 6.16 m on a 28 m
     * hull, and the cap is what stops that straddling a 4.2 m skiff. */
    assert.ok(muzzleGap <= MAX_SPAN * 2 + 0.01,
      `the span cap is not being applied (${muzzleGap.toFixed(2)} m across a 28 m hull)`);
  } finally { teardown(r, combat); }
});

/* ================================================================== */
/* 3. They can kill you                                                */
/* ================================================================== */

test('two skiffs kill a pilot who flies straight and does not shoot back', async () => {
  const { r, combat } = await combatRig({ ship: 'kestrel', seed: 11 });
  try {
    placeShip(r, V(0, 0, -30000), V(0, 0, -40000), 190);
    const z = { id: 't-straight', name: 'test', position: [0, 0, -30000], radius: 3000, wing: [{ class: 'skiff', count: 2 }] };
    combat._zones = [z];

    let died = false;
    const off = r.bus.on('player:died', () => { died = true; });
    let shieldZeroAt = null;

    /* ── THE CLOCK IS 160 s, AND IT WAS 110 s ────────────────────────────────
     *
     * NOT a weakened floor - the floor below is the same `died || health < 40`
     * and was not touched. What moved is the SAMPLE, and it moved for the same
     * reason the jinking case's clock moved from 70 s to 110 s: the flown hull
     * changed, so a fixed number of seconds now contains a different number of
     * seconds of ATTACK.
     *
     * The rig used to board through `_shipRecord` in a world that publishes no
     * hulls, so `Flight.setShip` took its `powerMul: 1` fallback and this case
     * flew a Kestrel whose cruise top was 120 m/s. At throttle 0.55 that is
     * 66 m/s against a skiff's 174 - a target that cannot get away from
     * anything, pinned for the whole clock. Flown, at 110 s:
     *
     *     shield down at 43.4 s, 198 damage taken, health 37
     *
     * and `health < 40` passed by three points.
     *
     * The real stock Kestrel cruises at 210, so throttle 0.55 is 116 m/s. Still
     * slower than the wing - you are still caught - but each pass is shorter
     * and the shield pool regenerates between them, so the same 110 s now reads
     *
     *     shield down at 65.7 s, 189 damage taken, health 77
     *
     * The claim is unchanged and still true: two skiffs DO kill a pilot who
     * flies straight and does not shoot back. It takes longer. Flown out, the
     * same seed crosses `health < 40` at 138.4 s and reaches health 14 by 160 s.
     * 160 s is that with 21 s of margin.
     *
     * ── AND THE HONEST CAVEAT, BECAUSE THE SAMPLE IS CHAOTIC ─────────────────
     * The spawn geometry dominates this measurement. Re-flown at 200 s across
     * five seeds, `health < 40` arrives at 156.7 s (7), 138.4 s (11), 7.8 s
     * (23), 6.8 s (61) and 7.0 s (101). Seed 11 - the one this case has always
     * used - is close to the WORST case for the pilot's survival, not the best,
     * so the clock here is not cherry-picked in the direction of passing. It
     * does mean "how long two skiffs need" is a distribution and 138 s is one
     * draw from it. */
    await step(r, combat, 60 * 160, (t) => {
      /* Straight and level, at the throttle of a pilot who is IN the fight
       * rather than leaving it. At full throttle a Kestrel simply outruns a
       * skiff (210 m/s against 174) - measured here at 18 damage taken over
       * the whole clock and health untouched - which is correct behaviour and
       * a useless measurement. This case is about what happens to a pilot who
       * stays and does not manoeuvre. */
      r.piloting.flight.setCommand({ pitch: 0, yaw: 0, roll: 0, throttle: 0.55, vertical: 0, boost: false, brake: false });
      if (shieldZeroAt === null && combat.shield <= 0 && combat.engaged) shieldZeroAt = t;
    });
    off();

    const acc = combat.stats.shotsFired === 0
      ? null
      : null;
    void acc;
    console.log(`  shield down at ${shieldZeroAt === null ? 'never' : `${shieldZeroAt.toFixed(1)} s`}, `
      + `damage taken ${combat.stats.taken.toFixed(0)}, health ${r.player.health.toFixed(0)}, died ${died}`);

    assert.ok(combat.stats.taken > 0, 'floor: they must be able to hit a target flying straight');
    assert.ok(shieldZeroAt !== null, 'floor: unanswered fire must break a stock Kestrel shield');
    assert.ok(died || r.player.health < 40,
      `floor: the pilot must be in real trouble - health ${r.player.health.toFixed(0)}`);
  } finally { teardown(r, combat); }
});

/* ================================================================== */
/* 4. Jinking is the skill                                             */
/* ================================================================== */

test('jinking measurably beats flying straight, and it is the aim model that does it', async () => {
  async function run(jinking) {
    const { r, combat } = await combatRig({ ship: 'kestrel', seed: 23 });
    try {
      placeShip(r, V(0, 0, -30000), V(0, 0, -40000), 190);
      combat._zones = [{
        id: 't-jink', name: 'test', position: [0, 0, -30000], radius: 3000,
        wing: [{ class: 'skiff', count: 2 }],
      }];
      /* THROTTLE 0.55 IN BOTH RUNS, AND THAT IS THE WHOLE REASON THE FIRST
       * VERSION OF THIS CASE FAILED.
       *
       * At full throttle a stock Kestrel cruises at 210 m/s and a skiff at
       * 174, so the player simply leaves: the straight run produced sixteen
       * shots in seventy seconds because after the first pass nobody could
       * catch up. That is correct behaviour - you can always run - but it is
       * not a sample. Held at 0.55 the two are matched and both fights last
       * the clock. The player never shoots in either run, so neither sample is
       * truncated by a kill.
       *
       * ── AND THE CLOCK WENT FROM 70 s TO 110 s ─────────────────────────────
       * Not a weakened floor - the same floor, given the same sample. The
       * shooting band is `[BREAK_RANGE, class.range]` and `class.range` came
       * in from 780 m to 420 m when the engagement geometry was measured (see
       * the `range` note on `skiff`), so each pass now has about half the
       * seconds of ATTACK in it and 70 s of clock produced 16 shots where it
       * used to produce more than 20. The claim under test is a RATIO of hit
       * rates and is untouched by how long the two runs are; `shots > 20` is a
       * statement about whether the ratio means anything. Lowering the floor
       * to fit 16 would have been the fudge; buying the sample back with 40
       * more seconds of identical flying is not.
       *
       * ── RE-MEASURED ON THE REAL HULL ─────────────────────────────────────
       * The clock is unchanged at 110 s. The rig used to fly this at
       * `powerMul: 1` (see the header note), and correcting it to the game's
       * stock Kestrel moved both samples UP - straight 27/30 -> 35/38, jinking
       * 28/44 -> 37/56 - because a faster hull re-merges sooner. Every floor
       * and the ceiling are untouched and all five still hold: the hit rates
       * moved 90.0% -> 92.1% straight and 63.6% -> 66.1% jinking, so the ratio
       * this case is actually about barely moved (0.707 -> 0.718). The jink
       * metric rose 0.68 -> 0.98. */
      await step(r, combat, 60 * 110, (t) => {
        r.piloting.flight.setCommand({
          pitch: jinking ? Math.sin(t * 1.9) : 0,
          yaw: jinking ? Math.cos(t * 1.3) * 0.8 : 0,
          roll: jinking ? Math.sin(t * 0.7) : 0,
          throttle: 0.55, vertical: 0, boost: false, brake: false,
        });
      });
      let shots = 0;
      let hits = 0;
      for (const h of combat.hostiles) { shots += h.shots; hits += h.hits; }
      return { shots, hits, taken: combat.stats.taken, jink: combat.jink };
    } finally { teardown(r, combat); }
  }

  const straight = await run(false);
  const jink = await run(true);
  const rate = (o) => (o.shots ? o.hits / o.shots : 0);
  console.log(`  straight: ${straight.hits}/${straight.shots} = ${(rate(straight) * 100).toFixed(1)}% `
    + `(${straight.taken.toFixed(0)} damage)`);
  console.log(`  jinking : ${jink.hits}/${jink.shots} = ${(rate(jink) * 100).toFixed(1)}% `
    + `(${jink.taken.toFixed(0)} damage, jink metric ${jink.jink.toFixed(2)})`);

  /* THE METRIC ITSELF, NOT JUST ITS CONSEQUENCE.
   *
   * `combat.jink` is derived from the real integrator's velocity direction,
   * and a version of it that never left zero would leave every downstream
   * assertion here still passing on the other differences between the two
   * flights. The mutation run found exactly that. */
  console.log(`  jink metric: straight ${straight.jink.toFixed(3)}, jinking ${jink.jink.toFixed(3)}`);
  assert.ok(straight.jink < 0.15,
    `floor: flying straight must read as steady (${straight.jink.toFixed(3)})`);
  assert.ok(jink.jink > 0.35,
    `floor: rolling and pulling must read as jinking (${jink.jink.toFixed(3)})`);

  assert.ok(straight.shots > 20, `floor: not enough shots to measure (${straight.shots})`);
  assert.ok(rate(straight) > 0.25,
    `floor: a straight-flying target must be hit often - ${(rate(straight) * 100).toFixed(1)}%`);
  assert.ok(rate(jink) < rate(straight) * 0.8,
    `floor: jinking must cut the hit rate by at least a fifth - `
    + `${(rate(jink) * 100).toFixed(1)}% against ${(rate(straight) * 100).toFixed(1)}%`);
  /* CEILING: it must still be a fight, not immunity. A jink that made the
   * player untouchable would be the same defect as one that did nothing. */
  assert.ok(rate(jink) > 0.02,
    `ceiling: jinking must not make you invulnerable - ${(rate(jink) * 100).toFixed(1)}%`);
});

/* ================================================================== */
/* 5. You can kill them, and firepower matters                         */
/* ================================================================== */

test('the player gun kills a skiff, and the Pike does it in fewer shots than the Kestrel', () => {
  /* The gun's arithmetic, driven through the real damage path rather than
   * multiplied out here: a fake registry supplies the tiers, `boltDamage`
   * derives the number, and a real `AlienShip.damage` absorbs it. */
  const fakeCombat = (shipId, bought = {}) => Object.create(SpaceCombat.prototype, {
    piloting: { value: { shipId } },
    ships: { value: { getPowers: () => bought } },
  });

  const shotsToKill = (shipId, bought) => {
    const c = fakeCombat(shipId, bought);
    const dmg = SpaceCombat.prototype.boltDamage.call(c, shipId);
    const model = buildAlienModel('skiff');
    const s = new AlienShip({ classId: 'skiff', model, rnd: () => 0.5 });
    s.spawn(V(0, 0, 0), V(0, 0, -100), { holdFire: 0 });
    let n = 0;
    while (s.alive && n < 99) { s.damage(dmg); n++; }
    model.dispose();
    return { n, dmg };
  };

  const kestrel = shotsToKill('kestrel', {});
  const pike = shotsToKill('pike', {});
  const pikeMax = shotsToKill('pike', { fire: 3 });
  console.log(`  kestrel ${kestrel.dmg.toFixed(1)} dmg -> ${kestrel.n} hits`);
  console.log(`  pike    ${pike.dmg.toFixed(1)} dmg -> ${pike.n} hits`);
  console.log(`  pike +3 ${pikeMax.dmg.toFixed(1)} dmg -> ${pikeMax.n} hits`);

  /* PINNED INTEGERS, and this is the correction to a test that could not fail.
   *
   * The ceiling below used to be `ceil(skiff.integrity / GUN.damage)` - so the
   * claim "six hits from a Kestrel, four from a Pike" was being divided by the
   * very number it was testing, and `GUN.damage: 16 -> 26` was a mutation that
   * stayed green. Both sides of the balance are stated here as the integers the
   * design is: 6, 4 and 3. Changing `GUN.damage`, `SHIP_STATS.*.fire` or
   * `ALIEN_CLASSES.skiff.integrity` now has to change this line with it, which
   * is the point - these three numbers ARE the time-to-kill. */
  assert.equal(kestrel.n, 6, `a stock Kestrel kills a skiff in 6 hits, not ${kestrel.n}`);
  assert.equal(pike.n, 4, `a stock Pike kills a skiff in 4 hits, not ${pike.n}`);
  assert.equal(pikeMax.n, 3, `a Pike at fire tier 3 kills a skiff in 3 hits, not ${pikeMax.n}`);
  assert.ok(pike.n < kestrel.n, `floor: the Pike's fire bias must matter (${pike.n} vs ${kestrel.n})`);
  assert.ok(pikeMax.n < pike.n, `floor: a purchased fire tier must matter (${pikeMax.n} vs ${pike.n})`);
  /* CEILING BY ABLATION: with the per-tier multiplier removed, every hull does
   * the same damage and the three numbers above collapse into one. */
  const flat = Math.ceil(ALIEN_CLASSES.skiff.integrity / GUN.damage);
  assert.equal(flat, 6, `ablated, every hull needs 6 hits, not ${flat}`);
  assert.ok(kestrel.n <= flat && pikeMax.n < flat,
    `ablated (no tier multiplier) every hull needs ${flat} hits`);
});

test('a player bolt at 1600 m/s cannot pass through a 4.2 m skiff', async () => {
  const { r, combat } = await combatRig({ ship: 'kestrel', seed: 3 });
  try {
    /* THIRTY KILOMETRES OUT, AND THAT MATTERS.
     *
     * The first version staged this at the origin, which is 18 m from
     * `DOCK_ANCHOR.mouth` - so `Piloting._seams` docked the ship on step one,
     * `_travelling` went true, and the gun never fired at all. The case
     * reported "0 shots" and looked like a broken trigger. */
    placeShip(r, V(0, 0, -30000), V(0, 0, -30500), 0);
    const s = combat._take('skiff');
    /* Dead ahead at 500 m and stationary. At 1,600 m/s the bolt covers 26.7 m
     * a step, so the step it arrives on straddles the whole craft: a point
     * test at the new position finds nothing.
     *
     * Held in BREAK straight down the firing line for the whole case. Left to
     * think, it manoeuvres out of the cone of a player who is not turning -
     * which is what a real one does and what makes the fight a fight, but it
     * turns this case into a measurement of the autopilot rather than of the
     * sweep. */
    s.spawn(V(0, 0, -30500), V(0, 0, -30000), { holdFire: 99 });
    s.state = 'BREAK';
    s._breakFor = 99;
    s._breakDir.set(0, 0, -1);

    const before = s.integrity;
    r.input.state.fire = true;
    await step(r, combat, 40);
    r.input.state.fire = false;
    await step(r, combat, 20);

    const sweptDamage = before - s.integrity;
    console.log(`  integrity ${before} -> ${s.integrity.toFixed(1)} after ${combat.stats.shotsFired} shots`);
    assert.ok(combat.stats.shotsFired >= 2, 'the gun did not fire');
    assert.ok(sweptDamage > 0, 'floor: a swept bolt must connect at 500 m');

    /* CEILING BY ABLATION: replace the sweep with a point test at the new
     * position and the same shots must miss. This is what proves the sweep is
     * load-bearing and not decoration copied from `Projectiles`. */
    const realSweep = combat._sweep;
    combat._sweep = function pointTest(from, seg, centre, radius) {
      const p = from.clone().add(seg);
      return p.distanceTo(centre) <= radius ? 1 : -1;
    };
    s.integrity = before;
    combat.stats.shotsFired = 0;
    placeShip(r, V(0, 0, -30000), V(0, 0, -30500), 0);
    s.spawn(V(0, 0, -30500), V(0, 0, -30000), { holdFire: 99 });
    s.state = 'BREAK';
    s._breakFor = 99;
    s._breakDir.set(0, 0, -1);
    r.input.state.fire = true;
    await step(r, combat, 40);
    r.input.state.fire = false;
    await step(r, combat, 20);
    const ablatedDamage = before - s.integrity;
    console.log(`  ablated (point test): integrity ${s.integrity.toFixed(1)} after `
      + `${combat.stats.shotsFired} shots (${ablatedDamage.toFixed(1)} damage against `
      + `${sweptDamage.toFixed(1)} swept)`);
    /* Not zero, and it should not be: a point test lands whenever the step
     * boundary happens to fall inside the sphere, which for a 4.2 m target and
     * a 26.7 m step is about one time in six. The claim is that the sweep is
     * load-bearing, and a factor of three is that claim. */
    assert.ok(sweptDamage > ablatedDamage * 2.5,
      `ablation: the sweep must beat a point test by a wide margin - `
      + `${sweptDamage.toFixed(1)} against ${ablatedDamage.toFixed(1)}`);
    combat._sweep = realSweep;
  } finally { teardown(r, combat); }
});

test('the segment-sphere sweep answers all three cases it can be asked', () => {
  /* THE ARITHMETIC ON ITS OWN.
   *
   * `_sweep` has three branches and only two of them are reachable by flying:
   * the "already inside" case needs a hostile to move onto a bolt between
   * `_steps` and `_stepBolts`, which happens perhaps once in a long fight. The
   * mutation run duly found that inverting it changed nothing any flown case
   * could see. It is pure arithmetic with no state, so it gets a pure test.
   */
  const sweep = SpaceCombat.prototype._sweep;
  const centre = V(0, 0, -100);

  /* Crossing. One step of a 1,600 m/s bolt is 26.67 m, so the segment has to
   * START within that of the sphere to reach it at all - the first version of
   * this case fired from 100 m short and asserted a crossing that no single
   * step could produce. */
  const step1 = 1600 / 60;
  const t = sweep.call(null, V(0, 0, -70), V(0, 0, -step1), centre, 4.2);
  assert.ok(t > 0 && t < 1, `a crossing segment must report a fraction, got ${t}`);
  const entry = -70 - step1 * t;
  assert.ok(Math.abs(entry + (100 - 4.2)) < 0.5,
    `it must enter at the NEAR face - entered at z ${entry.toFixed(1)}, near face is -95.8`);

  /* Starting inside. */
  assert.equal(sweep.call(null, V(0, 0, -100), V(0, 0, -26), centre, 4.2), 0,
    'a segment that starts inside must report 0, not a miss');
  assert.equal(sweep.call(null, V(2, 1, -101), V(0, 0, -26), centre, 4.2), 0,
    'off-centre but inside is still inside');

  /* Missing, both ways: past it laterally, and stopping short. */
  assert.equal(sweep.call(null, V(9, 0, -70), V(0, 0, -step1), centre, 4.2), -1,
    'a segment 9 m off the centre of a 4.2 m sphere must miss');
  assert.equal(sweep.call(null, V(0, 0, 0), V(0, 0, -10), centre, 4.2), -1,
    'a segment that stops short must miss');
  /* And a zero-length segment, which is what a bolt spawned with no velocity
   * would produce and what would otherwise divide by zero. */
  assert.equal(sweep.call(null, V(0, 0, 0), V(0, 0, 0), centre, 4.2), -1);
  assert.equal(sweep.call(null, V(0, 0, -100), V(0, 0, 0), centre, 4.2), 0);
  console.log('  crossing, inside, two misses and a zero-length segment all answered');
});

test('the gun has a range, and bolts leave the pool when they reach it', async () => {
  const { r, combat } = await combatRig({ ship: 'kestrel', seed: 19 });
  try {
    /* Beyond `GUN.range`. A bolt that never expired would reach it a second
     * later and the shot would connect - which is what the mutation that
     * deleted the life counter did, silently giving both sides an infinite
     * gun. */
    placeShip(r, V(0, 0, -30000), V(0, 0, -31400), 0);
    const far = combat._take('skiff');
    far.spawn(V(0, 0, -31400), V(0, 0, -30000), { holdFire: 99 });
    far.state = 'BREAK';
    far._breakFor = 99;
    far._breakDir.set(0, 0, -1);

    r.input.state.fire = true;
    await step(r, combat, 30);
    r.input.state.fire = false;
    const inFlight = combat._boltCount;
    /* Long enough for every bolt to have flown `GUN.range` and expired. */
    await step(r, combat, 90);

    console.log(`  target at 1400 m: ${combat.stats.shotsFired} shots, `
      + `${inFlight} bolts in flight at the cease-fire, ${combat._boltCount} left, `
      + `integrity ${far.integrity}`);
    assert.ok(combat.stats.shotsFired >= 2, 'the gun did not fire');
    assert.ok(inFlight > 0, 'nothing was ever in flight');
    assert.equal(far.integrity, ALIEN_CLASSES.skiff.integrity,
      `floor: a ${GUN.range} m gun must not reach 1400 m`);
    assert.equal(combat._boltCount, 0, 'floor: spent bolts must leave the pool');
  } finally { teardown(r, combat); }
});

/* ================================================================== */
/* 6. They break off and come round again                              */
/* ================================================================== */

test('a hostile merges, breaks off, separates, and comes back', async () => {
  const { r, combat } = await combatRig({ ship: 'kestrel', seed: 5 });
  try {
    placeShip(r, V(0, 0, -30000), V(0, 0, -40000), 150);
    combat._zones = [{
      id: 't-break', name: 'test', position: [0, 0, -30000], radius: 3000,
      wing: [{ class: 'skiff', count: 1 }],
    }];

    const seen = new Set();
    let minRange = Infinity;
    let maxAfterBreak = 0;
    let broke = false;
    await step(r, combat, 60 * 60, () => {
      /* A gentle turn: enough that the fight is a fight, not so much that the
       * hostile never gets a pass in. */
      r.piloting.flight.setCommand({
        pitch: 0.12, yaw: 0.2, roll: 0, throttle: 1, vertical: 0, boost: false, brake: false,
      });
      const h = combat.hostiles.find((x) => x.alive);
      if (!h) return;
      seen.add(h.state);
      const d = h.position.distanceTo(r.piloting.flight.position);
      minRange = Math.min(minRange, d);
      if (h.state === 'BREAK') broke = true;
      if (broke) maxAfterBreak = Math.max(maxAfterBreak, d);
    });

    console.log(`  states seen: ${[...seen].sort().join(', ')}`);
    console.log(`  closest ${minRange.toFixed(0)} m, furthest after a break ${maxAfterBreak.toFixed(0)} m`);
    assert.ok(seen.has('ATTACK'), 'floor: it never got into an attack run');
    assert.ok(seen.has('BREAK'), 'floor: it never broke off');
    assert.ok(seen.has('REFORM'), 'floor: it never came round again');
    assert.ok(minRange < BREAK_RANGE * 2.2,
      `floor: it must actually merge - closest was ${minRange.toFixed(0)} m`);
    assert.ok(maxAfterBreak > 500,
      `floor: a break must produce real separation - only ${maxAfterBreak.toFixed(0)} m`);

    /* ══════════════════════════════════════════════════════════════════════
     *  THE NUMBER THIS CASE SUPPLIES TO `DISENGAGE` HAS MOVED, AND `DISENGAGE`
     *  IS NOW A TUNING CHOICE RATHER THAN A DERIVED BOUND
     * ══════════════════════════════════════════════════════════════════════
     *
     * `SpaceCombat.js` cites THIS case by name for the sentence "a normal
     * break-off opens 3,590 m on its own", and sets `DISENGAGE = 3600`
     * "precisely BECAUSE that is where a break-off tops out". That number was
     * taken through a rig that flew a Kestrel at `powerMul: 1` - 120 m/s
     * against a skiff's 174 - i.e. a hull the wing could always out-run, so
     * the separation was bounded by the PLAYER's speed.
     *
     * Re-flown with the game's stock Kestrel (210 m/s) and `DISENGAGE` lifted
     * out of the way to 60 km, the same break-off opens 11,015 m. Three times
     * the constant.
     *
     * So `maxAfterBreak` no longer measures the break-off at all: it measures
     * `DISENGAGE`, because `_spawner` stands the wing down the moment the gap
     * passes 3,600 m. The reading is 3,599 m and it is 3,599 because the
     * constant is 3,600.
     *
     * That is asserted here rather than left in a comment, so the day
     * `DISENGAGE` moves, this says so:
     *
     *   - it is NOT the claim that the derivation was right (it was not);
     *   - it IS the claim that this case can no longer be read as evidence for
     *     `DISENGAGE`, because it saturates it.
     *
     * The design consequence is NOT changed here - a tuning change is a
     * separate decision. What it means, stated plainly: with the real hull the
     * wing gives up while a break-and-reform cycle is still running, where the
     * derivation assumed 3.6 km was past the end of one. The `LOCK_GRACE`
     * reasoning that a radius-based release is structurally wrong is
     * STRENGTHENED by this, not weakened - the radius that would have been
     * needed is now 11 km, not 3.6. */
    assert.ok(maxAfterBreak > DISENGAGE - 50 && maxAfterBreak <= DISENGAGE,
      `the break-off separation reads ${maxAfterBreak.toFixed(0)} m against a ${DISENGAGE} m `
      + 'DISENGAGE. It used to saturate it (3,599 of 3,600). If it no longer does, the '
      + 'stand-down bound and the natural break-off have crossed, and the derivation '
      + 'note on DISENGAGE needs re-deriving - see the block above this line.');
  } finally { teardown(r, combat); }
});

/* ================================================================== */
/* 7. Placement                                                        */
/* ================================================================== */

test('every authored zone is on a route, outside the safe radius, and names a real class', async () => {
  const r = await rig();
  await goto(r, 'space');
  const zones = r.wm.active.encounters;
  const bodies = landableBodies();
  /* One picket per landable world, plus the Ashlane and the Reach nest. The
   * floor is DERIVED so that adding a planet and forgetting its route fails
   * here, which is the defect this file exists to catch one layer down: for a
   * whole phase `_fillEncounters` took `BODY_BY_ID.cinder` by name and nine
   * routes out of ten had nothing on them at all. */
  assert.ok(Array.isArray(zones) && zones.length >= bodies.length + 2,
    `space publishes ${zones?.length ?? 0} zones for ${bodies.length} landable worlds `
    + '- a route with no picket on it is an empty trip');

  const mouth = new THREE.Vector3(...DOCK_ANCHOR.mouth);
  const belt = new THREE.Vector3(...BELT.position);
  /* Every route there is: the yard to each landable body, and the belt. */
  const lanes = bodies.map((b) => ({ id: b.id, at: new THREE.Vector3(...b.position) }));

  /** Perpendicular distance from `p` to the nearest route, and which one. */
  const nearestLane = (p) => {
    let best = { id: 'halberd-reach', off: p.distanceTo(belt) };
    for (const lane of lanes) {
      const t = Math.max(0, Math.min(1, p.dot(lane.at) / lane.at.lengthSq()));
      const off = p.distanceTo(lane.at.clone().multiplyScalar(t));
      if (off < best.off) best = { id: lane.id, off };
    }
    return best;
  };

  const covered = new Set();
  for (const z of zones) {
    const p = new THREE.Vector3(...z.position);
    const home = p.distanceTo(mouth);
    assert.ok(home > SAFE_RADIUS,
      `${z.id} is ${Math.round(home)} m from the yard, inside the ${SAFE_RADIUS} m safe radius`);

    /* ON A ROUTE. Perpendicular distance to some yard-to-body line, or
     * distance to the belt: a zone that is neither is a zone nobody will ever
     * fly into, which is the zero-reachable-wildlife defect with guns. */
    const near = nearestLane(p);
    assert.ok(near.off < z.radius * 0.5,
      `${z.id} sits ${Math.round(near.off)} m off every route with a ${z.radius} m trigger`);
    covered.add(near.id);

    /* AND OUTSIDE THE PLANET IT GUARDS. A trigger sphere that reaches into a
     * body's handoff shell can fire a wing and a descent on the same frame,
     * which is a fight that begins in a world that is being torn down. */
    for (const b of bodies) {
      const d = p.distanceTo(new THREE.Vector3(...b.position));
      assert.ok(d - z.radius > Math.max(b.atmosphere, b.handoff),
        `${z.id}'s trigger reaches inside ${b.id}: ${Math.round(d - z.radius)} m from centre `
        + `against a ${Math.max(b.atmosphere, b.handoff)} m shell`);
    }

    for (const w of z.wing) {
      assert.ok(ALIEN_CLASSES[w.class], `${z.id} names unknown class "${w.class}"`);
      assert.ok((w.count ?? 1) >= 1);
    }
    console.log(`  ${z.id.padEnd(20)} ${String(Math.round(home / 1000)).padStart(3)} km out, `
      + `${String(Math.round(near.off)).padStart(4)} m off the ${near.id} lane, `
      + `trigger ${z.radius} m, wing ${z.wing.map((w) => `${w.count ?? 1}x${w.class}`).join(' + ')}`);
  }

  /* THE ASSERTION THAT WOULD HAVE CAUGHT THE HOLE. Twelve zones all piled on
   * the Cinder run would satisfy every check above and still leave nine routes
   * empty, so coverage is checked by ROUTE rather than by count. */
  const empty = bodies.map((b) => b.id).filter((id) => !covered.has(id));
  assert.deepEqual(empty, [],
    `${empty.length} landable worlds have no encounter anywhere on the run out to them, `
    + `so the whole trip is an empty volume and a landing: ${empty.join(', ')}`);
});

test('the route a new player flies first carries one toll, and the doubled lane is a long one', async () => {
  const r = await rig();
  await goto(r, 'space');
  const zones = r.wm.active.encounters;
  const bodies = landableBodies();
  const belt = new THREE.Vector3(...BELT.position);
  const lanes = bodies.map((b) => ({ id: b.id, at: new THREE.Vector3(...b.position) }));

  /** Same rule the placement case above uses: which route is this zone on. */
  const routeOf = (p) => {
    let best = { id: 'halberd-reach', off: p.distanceTo(belt) };
    for (const lane of lanes) {
      const t = Math.max(0, Math.min(1, p.dot(lane.at) / lane.at.lengthSq()));
      const off = p.distanceTo(lane.at.clone().multiplyScalar(t));
      if (off < best.off) best = { id: lane.id, off };
    }
    return best.id;
  };

  /**
   * ═══════════════════════════════════════════════════════════════════════
   *  ELEVEN ROUTES, TWELVE ZONES - SO ONE LANE DOUBLES, AND IT MATTERS WHICH
   * ═══════════════════════════════════════════════════════════════════════
   *
   * The placement case above requires every zone to sit on a route and every
   * route to carry one, and there are ten landable lanes plus the belt against
   * twelve zones. One lane therefore carries two whatever anybody does; the
   * only decision available is WHICH, and for a whole phase it was the
   * shortest one in the system.
   *
   * The cost is measured, in a real boot with the encounters live rather than
   * in `_flightrig` - which has no `SpaceCombat` in it and once "verified"
   * this leg at 23.5 s. An interdiction holds a ship in normal space for about
   * nineteen seconds whether or not the pilot takes the fight (the wing
   * launches, `LOCK_GRACE` runs, the drive comes back), and the dock-to-Cinder
   * leg was paying it twice:
   *
   *     Cinder    62 km, 2 zones   67.9 - 88.5 s
   *     Tessera   87 km, 1 zone            56.6 s
   *     Shoal    140 km, 1 zone     59.6 - 61.3 s
   *
   * The nearest planet in the system took longer to reach than the second
   * furthest, on the one route every new player flies before they have bought
   * anything. Two derived assertions, so this cannot come back by accident on
   * whichever lane happens to be shortest next time.
   */
  const count = new Map();
  for (const z of zones) {
    const id = routeOf(new THREE.Vector3(...z.position));
    count.set(id, (count.get(id) ?? 0) + 1);
  }
  const distOf = (id) => new THREE.Vector3(...(BODY_BY_ID[id]?.position ?? BELT.position)).length();
  const rows = [...count].sort((a, b) => distOf(a[0]) - distOf(b[0]));
  console.log('  ' + rows.map(([id, n]) => `${id} ${(distOf(id) / 1000).toFixed(0)}km x${n}`).join('  '));

  const nearest = bodies.slice().sort(
    (a, b) => new THREE.Vector3(...a.position).length() - new THREE.Vector3(...b.position).length()
  )[0];
  assert.equal(count.get(nearest.id), 1,
    `${nearest.id} is the nearest landable world - the run every new player flies first - and its `
    + `route carries ${count.get(nearest.id)} encounters. Two interdictions on the shortest leg is `
    + 'thirty-eight seconds of holding W.');

  const doubled = rows.filter(([, n]) => n > 1);
  assert.ok(doubled.length <= 1,
    `${doubled.length} routes carry more than one encounter: ${doubled.map(([id]) => id).join(', ')}`);
  if (doubled.length === 1) {
    const [id] = doubled[0];
    const near = new THREE.Vector3(...nearest.position).length();
    assert.ok(distOf(id) > near * 2,
      `the doubled route is ${id} at ${(distOf(id) / 1000).toFixed(0)} km against a ${(near / 1000).toFixed(0)} km `
      + 'shortest leg - a second toll belongs on a run long enough to absorb it');
  }
});

test('flying the Cinder run finds a fight, and shrinking the trigger removes it', async () => {
  async function run(shrink) {
    const { r, combat } = await combatRig({ ship: 'kestrel', seed: 31 });
    try {
      /* The launch pose, near enough: outside the yard on the mouth normal,
       * pointed at Cinder, with the throttle pinned - which is exactly what a
       * player does after `pilot:launched`. */
      const cinder = new THREE.Vector3(...BODY_BY_ID.cinder.position);
      placeShip(r, V(0, 0, -600), cinder, 120);
      if (shrink) {
        combat._zones = r.wm.active.encounters.map((z) => ({ ...z, radius: 1 }));
      }
      let contactsAt = null;
      let transitPeak = 1;
      let transitWhileLocked = 0;
      let lockedSteps = 0;
      let engagedSteps = 0;
      /* THE MULTIPLIER ON THE FIRST STEP THE PLAYER FLIES AFTER A LAUNCH.
       *
       * Not on the launch step itself, and the difference is the whole
       * subtlety of the frame order. `piloting` runs BEFORE `combat`, so on
       * the step a wing appears the ship has already been integrated at
       * whatever multiplier was in force - a reading taken there is of a
       * number that has already been superseded and cannot be acted on. The
       * step AFTER is the first one `interdicted` can have reached, and it is
       * the first metre of the run-in that the standoff is supposed to buy.
       *
       * (`Piloting`'s displacement multiplier disengages instantly rather than
       * damping, so one stale step is 28 m of a 600 m shell. The transit DRIVE
       * is the one that cannot be cancelled in a step - it sheds 5,000 m/s
       * over `transitSpoolDown` - and it has its own case below.) */
      let launchStep = null;
      let spawnFactor = null;
      const off = r.bus.on('combat:contacts', () => { contactsAt = true; });
      await step(r, combat, 60 * 100, () => {
        steerTo(r.piloting.flight, cinder, { throttle: 1 });
      }, (t, i) => {
        void t;
        if (contactsAt && launchStep === null) launchStep = i;
        if (launchStep !== null && i === launchStep + 1 && spawnFactor === null) {
          spawnFactor = r.piloting._transit;
        }
        /* Sampled AFTER both systems have stepped - see the note on `step`.
         * `_transit` is written by `piloting` and `interdicted` by `combat`,
         * so a reading taken between them always has one of the two stale.
         *
         * ── SAMPLED ON THE LOCK, NOT ON `engaged` ──────────────────────────
         * `interdicted` used to mean "anything is alive anywhere", so
         * "engaged" and "held" were the same condition and either could stand
         * in for the other. They are now different by design: the lock is a
         * CLOCK (`LOCK_GRACE`), because a flag that outlived the danger by
         * 3.6 km denied the drive for about ninety seconds after a player had
         * broken off. So the assertion is the one the mechanism actually
         * makes: while something is IN REACH of you, the multiplier is off.
         * Testing it against `engaged` would now be asserting the bug that was
         * removed.
         *
         * The first two steps of an engagement are skipped, and that is an
         * honest allowance rather than a fudge: `piloting` runs first in the
         * frame order, so the step on which a wing launches has already been
         * integrated at whatever multiplier was in force, and the step after
         * it is the first that can see the flag. */
        if (combat.engaged) engagedSteps++;
        transitPeak = Math.max(transitPeak, r.piloting._transit);
        const p = r.piloting.flight.position;
        const held = combat.hostiles.some(
          (h) => h.alive && h.position.distanceTo(p) <= h.def.range);
        if (held) lockedSteps++; else lockedSteps = 0;
        if (lockedSteps > 2) transitWhileLocked = Math.max(transitWhileLocked, r.piloting._transit);
      });
      off();
      return {
        contacts: !!contactsAt, transitPeak, transitWhileLocked, engagedSteps, spawnFactor,
        range: r.piloting.flight.position.length(),
      };
    } finally { teardown(r, combat); }
  }

  const real = await run(false);
  console.log(`  live zones : contacts ${real.contacts}, transit peaked at x${real.transitPeak.toFixed(1)}, `
    + `x${real.transitWhileLocked.toFixed(2)} while locked over ${real.engagedSteps} engaged steps, `
    + `${Math.round(real.range / 1000)} km out`);
  console.log(`  displacement multiplier on the first step after the launch: `
    + `x${(real.spawnFactor ?? 0).toFixed(2)}`);
  assert.ok(real.contacts, 'floor: a straight run at Cinder must find the Ashlane picket');
  assert.ok(real.transitPeak > 4, `floor: transit must engage on the outbound leg (x${real.transitPeak.toFixed(1)})`);
  /* INTERDICTION. The whole reason `Piloting.interdicted` exists: without it,
   * the wing is flown past at 3,640 m/s and the fight never happens. */
  assert.ok(real.engagedSteps > 300, `floor: the fight must last (${real.engagedSteps} steps)`);
  assert.ok(real.transitWhileLocked < 1.05,
    `floor: transit must drop while something holds a lock (x${real.transitWhileLocked.toFixed(2)})`);
  /* THE ARM-BEFORE-LAUNCH SPLIT, AND IT IS ITS OWN ASSERTION.
   *
   * A wing launched into a live multiplier is 600-850 m of standoff crossed in
   * a third of a second; the whole spawn shell is decoration if this is not
   * held. It is a strictly stronger claim than "the fight lasted", because a
   * fight can also last by the hostiles catching up afterwards. */
  assert.ok(real.spawnFactor !== null && real.spawnFactor < 1.05,
    `floor: the run-in must be flown in normal space, not at a x${(real.spawnFactor ?? 0).toFixed(2)} `
    + 'displacement multiplier');

  const ablated = await run(true);
  console.log(`  1 m triggers: contacts ${ablated.contacts}, transit peaked at x${ablated.transitPeak.toFixed(1)}`);
  assert.equal(ablated.contacts, false, 'ablation: a 1 m trigger must never fire');
});

/* ================================================================== */
/* 7b. The engagement geometry itself                                  */
/* ================================================================== */

/**
 * HOW MANY PIXELS IS A HOSTILE. The complaint, as arithmetic.
 *
 * "Combat is invisible at range - a 4.2 m skiff at 1.1 km is ~6 px" is a claim
 * about angular size, and angular size is the one thing in this whole system
 * that can be checked without flying anything. `CONFIG.render.fov` is 75
 * degrees VERTICAL, so the image plane at range d is `2*d*tan(37.5deg)` world
 * units tall mapped to 1080 rows:
 *
 *     pixels = 1080 / (2 * tan(37.5deg)) * metres / range = 703.7 * m / r
 *
 * `.probe/engagement.mjs` measured the same thing the hard way - a real
 * hostile at a real range, its own vertices projected through the live camera
 * - and agreed inside 10% at every range from 130 m to 1,250 m.
 *
 * This case pins the CONSEQUENCE: the range at which each class opens fire
 * must be a range at which it can be seen to be a ship. Without it, `range`
 * is a balance number that anyone may re-tune to 900 for feel, and the
 * complaint comes straight back.
 */
test('a hostile is legible at the range it shoots from - the pixel arithmetic', () => {
  const FOV_V = 75;
  const ROWS = 1080;
  const PX_PER_METRE_AT_1M = ROWS / (2 * Math.tan((FOV_V / 2) * Math.PI / 180));
  const px = (metres, rangeM) => PX_PER_METRE_AT_1M * metres / rangeM;

  /* The span each hull actually presents, taken off `ALIEN_PLANS` rather than
   * typed: the widest |x| in any authored triangle, doubled. A hull whose
   * blades were re-authored narrower would move this number and the case would
   * follow it, which is the point of deriving it. */
  const spanOf = (planId) => {
    const plan = ALIEN_PLANS[planId];
    let w = 0;
    const eat = (pts) => { for (const p of pts) w = Math.max(w, Math.abs(p[0])); };
    for (const b of plan.blades ?? []) { eat(b.root); eat(b.tip); }
    for (const f of plan.fins ?? []) { eat(f.root); eat(f.tip); }
    if (plan.arm) { eat(plan.arm.root); eat(plan.arm.tip); }
    if (plan.spur) { eat(plan.spur.root); eat(plan.spur.tip); }
    for (const s of plan.sections) w = Math.max(w, s.r * (s.w ?? 1));
    return w * 2;
  };

  console.log(`  ${ROWS}p at ${FOV_V}deg vertical: ${PX_PER_METRE_AT_1M.toFixed(1)} px per metre at 1 m`);
  for (const [id, def] of Object.entries(ALIEN_CLASSES)) {
    const span = spanOf(id);
    const atRange = px(span, def.range);
    const atBreak = px(span, BREAK_RANGE);
    const atSpawn = px(span, SPAWN_MAX);
    console.log(`  ${id}: ${span.toFixed(1)} m across; ${atSpawn.toFixed(1)} px at the ${SPAWN_MAX} m spawn, `
      + `${atRange.toFixed(1)} px at its own ${def.range} m gun, ${atBreak.toFixed(1)} px at the ${BREAK_RANGE} m merge`);

    /* THE FLOOR, and it is the number the complaint is about. Eighteen pixels
     * is where the forward-swept blades leave the body and the craft stops
     * being a dot with a colour: measured in `.probe/engage/`, 780 m (10 px)
     * is four violet pixels at 4x magnification and NOTHING in the unzoomed
     * frame, 420 m (18 px) is an object, 300 m (25 px) is a shape with a
     * facing. A hostile that opens fire from further out than this is
     * shooting at the player from somewhere the player cannot look. */
    assert.ok(atRange >= 18,
      `${id} opens fire at ${def.range} m, where it is ${atRange.toFixed(1)} px across - a dot`);
    /* And the merge has to be a spectacle, not merely legible. */
    assert.ok(atBreak >= 45,
      `${id} merges at ${BREAK_RANGE} m and is only ${atBreak.toFixed(1)} px across`);
    /* CEILING BY THE OTHER SIDE OF THE ARGUMENT. The hulls are authored .glb-
     * scale craft and the fix for "invisible" must never be "make them
     * bigger" - a skiff you can see because it is the size of a house is a
     * worse lie than a fight at 300 m. So the fight is also not allowed to be
     * fought so close that a light raider fills the plate. */
    assert.ok(atBreak <= ROWS * 0.5,
      `${id} at the merge is ${atBreak.toFixed(0)} px - over half the frame; the fight is too close`);
  }

  /* The player's gun must out-reach the heaviest hostile, or a good merge buys
   * nothing; and the spawn shell must sit outside every hostile's own gun, or
   * a wing arrives already shooting. Both are relations between numbers that
   * live in two different files, which is exactly what drifts. */
  const worstHostile = Math.max(...Object.values(ALIEN_CLASSES).map((c) => c.range));
  console.log(`  player gun ${GUN.range} m against the heaviest hostile's ${worstHostile} m; `
    + `spawn shell ${SPAWN_MIN}-${SPAWN_MAX} m; convergence ${CONVERGE} m`);
  assert.ok(GUN.range > worstHostile + 100,
    `the player's ${GUN.range} m gun must meaningfully out-reach ${worstHostile} m`);
  assert.ok(SPAWN_MIN > worstHostile,
    `the spawn shell starts at ${SPAWN_MIN} m, inside a ${worstHostile} m gun`);

  /* THE RETICLE MUST BE TRUE ACROSS THE WHOLE ENVELOPE. A bolt aimed at the
   * convergence point is `span * (1 - d / CONVERGE)` off the axis at range d,
   * and the smallest thing it has to hit is a skiff's 4.2 m sphere. Checked at
   * both ends, because convergence is exact in the middle by construction and
   * wrong at whichever end is further from it. */
  const smallest = Math.min(...Object.values(ALIEN_CLASSES).map((c) => c.radius));
  for (const d of [BREAK_RANGE * 0.85, GUN.range]) {
    const off = Math.abs(MAX_SPAN * (1 - d / CONVERGE));
    console.log(`  a ${MAX_SPAN} m span converged at ${CONVERGE} m is ${off.toFixed(2)} m off axis at ${d.toFixed(0)} m`);
    assert.ok(off < smallest,
      `a max-span hull misses a ${smallest} m target by ${off.toFixed(2)} m at ${d.toFixed(0)} m`);
  }
});

test('nothing spawns near the yard, on the ground, or while out of the seat', async () => {
  const { r, combat } = await combatRig({ ship: 'kestrel', seed: 41 });
  try {
    /* A zone deliberately authored ON TOP of the yard. The spawner's own
     * `SAFE_RADIUS` check has to refuse it, not just the authored placement -
     * rule 2 in the header of `SpaceCombat`. */
    combat._zones = [{
      id: 't-hangar', name: 'test', position: [0, 0, 0], radius: 40000,
      wing: [{ class: 'skiff', count: 2 }],
    }];
    placeShip(r, V(0, 0, -1200), V(0, 0, -5000), 60);
    await step(r, combat, 60 * 8);
    console.log(`  ${Math.round(r.piloting.flight.position.length())} m from the mouth: `
      + `${combat.contacts} contacts`);
    assert.equal(combat.contacts, 0, 'a wing launched inside the safe radius');

    /* Out of range of the yard, but out of the seat. */
    placeShip(r, V(0, 0, -30000), V(0, 0, -40000), 190);
    r.piloting.disembark({ silent: true, force: true });
    await step(r, combat, 60 * 6);
    assert.equal(combat.contacts, 0, 'a wing launched at a player who is not flying');
    console.log('  out of the seat: 0 contacts');

    /* Back in, same place: now it must fire, or the two zeros above prove
     * nothing at all. */
    r.piloting.board('kestrel', { silent: true });
    placeShip(r, V(0, 0, -30000), V(0, 0, -40000), 190);
    await step(r, combat, 60 * 6);
    console.log(`  in the seat at 30 km: ${combat.contacts} contacts`);
    assert.ok(combat.contacts > 0, 'ceiling: the same zone must fire once the player is flying');
  } finally { teardown(r, combat); }
});

test('a wing arrives ahead of the player, outside weapons range, and holds fire', async () => {
  const { r, combat } = await combatRig({ ship: 'kestrel', seed: 61 });
  try {
    placeShip(r, V(0, 0, -30000), V(0, 0, -40000), 190);
    combat._zones = [{
      id: 't-arrival', name: 'test', position: [0, 0, -30000], radius: 3000,
      wing: [{ class: 'skiff', count: 3 }],
    }];
    await step(r, combat, 4);

    const f = r.piloting.flight;
    const fwd = f.forward(new THREE.Vector3());
    assert.ok(combat.contacts >= 3, `only ${combat.contacts} launched`);
    for (const h of combat.hostiles) {
      if (!h.alive) continue;
      const to = h.position.clone().sub(f.position);
      const d = to.length();
      const ahead = to.normalize().dot(fwd);
      console.log(`  ${h.classId}: ${Math.round(d)} m, ${(Math.acos(ahead) * 57.3).toFixed(0)}° off the nose, `
        + `holdFire ${h.holdFire.toFixed(2)} s`);
      assert.ok(d >= SPAWN_MIN - 1 && d <= SPAWN_MAX + 1,
        `spawned at ${Math.round(d)} m, outside [${SPAWN_MIN}, ${SPAWN_MAX}]`);
      assert.ok(d > ALIEN_CLASSES[h.classId].range,
        `spawned at ${Math.round(d)} m, already inside its own ${ALIEN_CLASSES[h.classId].range} m gun range`);
      assert.ok(ahead > 0, `spawned BEHIND the player (${ahead.toFixed(2)})`);
      assert.ok(h.holdFire > 1, `holding fire for only ${h.holdFire.toFixed(2)} s`);
    }
  } finally { teardown(r, combat); }
});

/* ================================================================== */
/* 8. Shields, the ladder, and the payout                              */
/* ================================================================== */

test('the shield pool and the hull reduction both come off the tier the panel sells', async () => {
  async function tank(shipId, bought) {
    const { r, combat } = await combatRig({ ship: shipId, seed: 71, powers: bought });
    try {
      placeShip(r, V(0, 0, -30000), V(0, 0, -40000), 0);
      await step(r, combat, 2);
      const max = combat.shieldMax;
      /* UP WHEN YOU LEAVE THE YARD.
       *
       * `_regen` preserves the FRACTION when the ceiling moves, which is right
       * for an upgrade bought mid-session and wrong for the first step of a
       * session - the pool starts at zero and the fraction is therefore zero.
       * Measured before `_chargeShield` existed: 0% at t = 0.0 s on every
       * flight. Nothing downstream noticed, because everything downstream
       * compares hulls to each other and all three were equally naked. */
      assert.equal(combat.shield, max,
        `${shipId} boarded with ${combat.shield} of ${max} shield`);
      /* Two hundred points of damage, ten at a time, through the real path. */
      /* FOUR HUNDRED POINTS, NOT TWO.
       *
       * At 200 the fully-upgraded Dray's 330-point pool swallowed the lot and
       * its health was still exactly 100 - so the case could tell you the
       * shield existed but not that anything ever got past it, and the ceiling
       * assertion ("shields must not make a hull untouchable") had nothing to
       * measure. 400 breaks every pool on the ladder, which is the only amount
       * that compares all three. */
      const at = r.piloting.flight.position.clone();
      for (let i = 0; i < 40; i++) combat._playerHit(10, at, null);
      return { max, health: r.player.health };
    } finally { teardown(r, combat); }
  }

  const kestrel = await tank('kestrel', null);
  const dray = await tank('dray', null);
  const drayMax = await tank('dray', { shield: 3 });
  console.log(`  kestrel  shield ${kestrel.max}, health after 400 dmg: ${kestrel.health.toFixed(1)}`);
  console.log(`  dray     shield ${dray.max}, health after 400 dmg: ${dray.health.toFixed(1)}`);
  console.log(`  dray +3  shield ${drayMax.max}, health after 400 dmg: ${drayMax.health.toFixed(1)}`);

  /* PINNED INTEGERS. These three lines used to read `kestrel.max ===
   * SHIELD_PER_TIER * 1`, `dray.max === SHIELD_PER_TIER * 3` and so on - the
   * whole shield ladder asserted as `x === x`, so `SHIELD_PER_TIER: 55 -> 20`
   * was a mutation that stayed green and every pool in the game could be
   * silently rebalanced by a third. The ladder is 55 / 165 / 330; the
   * derivations are kept underneath as the statement of WHY those are the
   * numbers, but the numbers themselves are now the assertion. */
  assert.equal(kestrel.max, 55, `a Kestrel's shield pool is 55, not ${kestrel.max}`);
  assert.equal(dray.max, 165, `a stock Dray's shield pool is 165, not ${dray.max}`);
  assert.equal(drayMax.max, 330, `a Dray at shield tier 3 has 330, not ${drayMax.max}`);
  assert.equal(kestrel.max, Math.max(SHIELD_FLOOR, SHIELD_PER_TIER * 1));
  assert.equal(dray.max, SHIELD_PER_TIER * 3);
  /* Three purchased tiers on top of the Dray's bias of three. `MAX_TIER` is 3,
   * so this is the top of the ladder the panel actually sells. */
  assert.equal(drayMax.max, SHIELD_PER_TIER * 6);
  assert.ok(dray.health > kestrel.health + 20,
    `floor: the Dray's shield bias must be worth real hull (${dray.health.toFixed(1)} vs ${kestrel.health.toFixed(1)})`);
  assert.ok(drayMax.health > dray.health,
    'floor: a purchased shield tier must be worth something on top of the bias');
  /* CEILING: a fully-shielded Dray must still be hurt by 400 points. Immunity
   * would be the same defect as no effect. */
  assert.ok(drayMax.health < 100, 'ceiling: shields must not make a hull untouchable');
});

test('the panel\'s "10% less hull damage" is honoured to the point, per tier', async () => {
  /* THE SECOND HALF OF THE SHIELD TIER, PINNED EXACTLY.
   *
   * The pool is the visible half and the case above covers it. This is the
   * other one: `SHIP_STAT_META.shield` has said "10% less hull damage" since
   * the customiser shipped, and it is applied literally to whatever gets
   * through the pool. Removing it entirely left the case above green, because
   * that case compares hulls that differ in POOL as well as in reduction - so
   * this one drains the pool first and measures the reduction on its own.
   */
  async function bleed(shipId, bought) {
    const { r, combat } = await combatRig({ ship: shipId, seed: 73, powers: bought });
    try {
      placeShip(r, V(0, 0, -30000), V(0, 0, -40000), 0);
      await step(r, combat, 2);
      combat.shield = 0;
      const at = r.piloting.flight.position.clone();
      const before = r.player.health;
      combat._playerHit(100, at, null);
      return { tier: combat.tiers().shield, lost: before - r.player.health };
    } finally { teardown(r, combat); }
  }

  const rows = [
    await bleed('kestrel', null),
    await bleed('pike', null),
    await bleed('dray', null),
    await bleed('dray', { shield: 3 }),
  ];
  for (const row of rows) {
    const expected = 100 * Math.max(0.4, 1 - 0.10 * row.tier);
    console.log(`  shield tier ${row.tier}: 100 points through the pool cost `
      + `${row.lost.toFixed(1)} hull (expected ${expected.toFixed(1)})`);
    assert.ok(Math.abs(row.lost - expected) < 0.01,
      `tier ${row.tier} took ${row.lost.toFixed(1)} rather than ${expected.toFixed(1)}`);
  }
  /* And the ordering, stated separately so a formula that happened to match at
   * one tier cannot pass by accident. */
  assert.ok(rows[0].lost > rows[2].lost, 'more shield must mean less hull damage');
  assert.ok(rows[2].lost > rows[3].lost, 'a purchased tier must reduce it further');
  /* The floor at 0.4 is real: six tiers of 10% would be 40% left, and the
   * clamp is what stops a seventh ever reaching zero. */
  assert.equal(rows[3].lost, 40, 'the reduction floor must be 40% of the damage');
});

test('a kill pays a bounty into the ledger and leaves salvage you can scoop', async () => {
  const { r, combat } = await combatRig({ ship: 'dray', seed: 83 });
  try {
    placeShip(r, V(0, 0, -30000), V(0, 0, -30500), 0);
    const before = r.economy.credits;
    const holdBefore = r.piloting.cargoUnits;

    /* A Dray on purpose: it is the hull whose 6.16 m wingtip span used to make
     * its guns straddle a 4.2 m target and miss forever. With `CONVERGE` and
     * `MAX_SPAN` in place it kills a skiff like everything else, and this case
     * is what says so. */
    const s = combat._take('skiff');
    s.spawn(V(0, 0, -30200), V(0, 0, -30000), { holdFire: 99 });
    s.state = 'BREAK';
    s._breakFor = 99;
    s._breakDir.set(0, 0, -1);
    combat.zone = { id: 't-pay', name: 'test' };

    /* THE NOSE HAS TO TRACK, AND THAT IS THE POINT.
     *
     * The first version parked the hull and held the trigger. It landed five
     * hits and then stopped: the skiff drifts laterally out of a stationary
     * gun's cone within a second, and the case sat at 3 of 95 integrity
     * reporting "the skiff did not die". That is the game working - a turret
     * does not win a dogfight - so the case flies the way a player does, with
     * `steerTo` writing pitch and yaw through the real command struct. */
    r.input.state.fire = true;
    await step(r, combat, 60 * 6, () => {
      if (s.alive) steerTo(r.piloting.flight, s.position, { throttle: 0 });
    });
    r.input.state.fire = false;

    assert.equal(combat.stats.kills, 1, 'the skiff did not die');
    const paid = r.economy.credits - before;
    console.log(`  bounty paid ${paid} cr (expected ${ALIEN_CLASSES.skiff.bounty})`);
    assert.equal(paid, ALIEN_CLASSES.skiff.bounty, 'floor: the bounty must reach the ledger');

    /* Fly through the canister. `stow` is the real path, so a full hold would
     * refuse it - which is why this case flies a Dray.
     *
     * It may already be aboard: the skiff died about 70 m from the nose and
     * `SCOOP_RANGE` is 60, so a kill at the merge is sometimes scooped by the
     * steps that were already running. The first version asserted a canister
     * was adrift and failed on exactly that - a scoop that had already
     * succeeded. */
    const can = combat._salv.find((x) => x.active);
    if (can) {
      for (let i = 0; i < 240 && can.active; i++) {
        r.piloting.flight.place(can.pos.clone());
        combat._stepSalvage(DT);
      }
    }
    console.log(`  hold ${holdBefore} -> ${r.piloting.cargoUnits} m3, `
      + `worth ${r.piloting.cargoValue} cr`);
    assert.ok(r.piloting.cargoUnits > holdBefore, 'floor: salvage must go into the hold');
    assert.equal(r.piloting.cargoUnits, ALIEN_CLASSES.skiff.salvageBulk,
      'the canister must take up the bulk its class publishes');
    assert.equal(r.piloting.cargoValue, ALIEN_CLASSES.skiff.salvage);
    assert.equal(combat.stats.salvaged, ALIEN_CLASSES.skiff.salvage);
  } finally { teardown(r, combat); }
});

test('a full hold refuses salvage and leaves it in space, rather than eating it', async () => {
  const { r, combat } = await combatRig({ ship: 'pike', seed: 91 });
  try {
    /* A Pike has `hold: 0` - zero cubic metres, by design. It is the hull that
     * proves `stow` refuses BEFORE it consumes, which is the ordering rule
     * `MountSkins.js` recorded and `Mining` already follows. */
    assert.equal(r.piloting.cargoCapacity, 0, 'the Pike must have no hold');
    placeShip(r, V(0, 0, -30000), V(0, 0, -30500), 0);
    const s = combat._take('skiff');
    s.spawn(V(0, 0, -30050), V(0, 0, -30000), { holdFire: 99 });
    combat._dropSalvage(s);
    const can = combat._salv.find((x) => x.active);
    for (let i = 0; i < 30; i++) {
      r.piloting.flight.place(can.pos.clone());
      combat._stepSalvage(DT);
    }
    console.log(`  pike hold ${r.piloting.cargoUnits}/${r.piloting.cargoCapacity}, `
      + `canister still adrift: ${can.active}`);
    assert.equal(r.piloting.cargoUnits, 0);
    assert.equal(can.active, true, 'the canister must survive a refused scoop');
    assert.ok(combat._warnText.includes('Hold full'), 'the pilot must be told why');
  } finally { teardown(r, combat); }
});

/**
 * SALVAGE DOES NOT DISPLACE BETTER CARGO.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 * The scoop is automatic and had no opinion about what it was scooping into.
 * Driven cold, one skiff kill loaded 4 m³ of salvage worth 40 CR into a 10 m³
 * Kestrel hold - 40% of the hull's entire capacity at 10 CR/m³ - against
 * iridite's 310 CR for one cubic metre. The tester's note was "I never chose
 * to pick it up and was never told".
 *
 * That was a bad trade before and it is a worse one now that being shot down
 * empties the un-banked hold (`pilot-downed.test.mjs`): the player is carrying
 * a real stake and the ship keeps swapping some of it for scrap.
 *
 * Both halves are asserted, and the second half is the one that matters - a
 * rule that refuses everything is not a rule, it is a broken scoop.
 *
 * MUTATION RECORD for this case: 5 of 5 red. Three assertion reversals, plus
 * the comparison flipped to `>` and the whole rule deleted.
 */
test('the scoop leaves salvage worth less per cubic metre than what is aboard', async () => {
  const { r, combat } = await combatRig({ ship: 'kestrel', seed: 137 });
  try {
    /* One cubic metre of the dearest ore on Cinder. `stow` is the real verb
     * the mining loop uses, so the hold's rate below is the rate a player
     * would actually be carrying. */
    const stowed = r.piloting.stow({ type: 'iridite', name: 'Iridite', size: 0.62, credits: 310 });
    assert.equal(stowed.ok, true, 'setup: could not put ore in the hold');
    const holdRate = r.piloting.cargoValue / r.piloting.cargoUnits;

    placeShip(r, V(0, 0, -30000), V(0, 0, -30500), 0);
    const skiff = combat._take('skiff');
    skiff.spawn(V(0, 0, -30050), V(0, 0, -30000), { holdFire: 99 });
    combat._dropSalvage(skiff);
    const can = combat._salv.find((x) => x.active);
    const salvageRate = can.credits / can.bulk;
    assert.ok(salvageRate < holdRate,
      `setup: skiff salvage is ${salvageRate.toFixed(1)} CR/m³ against ${holdRate.toFixed(1)} ` +
      'aboard - it is not the poorer cargo, so this case is measuring nothing');

    const unitsBefore = r.piloting.cargoUnits;
    for (let i = 0; i < 30; i++) {
      r.piloting.flight.place(can.pos.clone());
      combat._stepSalvage(DT);
    }
    console.log(`  hold ${holdRate.toFixed(0)} CR/m³ vs salvage ${salvageRate.toFixed(0)} CR/m³, `
      + `canister still adrift: ${can.active}`);
    assert.equal(r.piloting.cargoUnits, unitsBefore,
      'salvage worth a fraction of the ore aboard was loaded over it anyway');
    assert.equal(can.active, true,
      'the canister was consumed rather than left - a refused scoop must not destroy it, ' +
      'so a pilot who sells and comes back can still have it');
    assert.match(combat._warnText, /Salvage left/,
      `the pilot is not told why: the banner reads "${combat._warnText}"`);

    /* AND IT STILL SCOOPS. Empty the hold and the same canister goes aboard -
     * the rule is about displacement, not about refusing salvage. */
    for (const k in r.piloting._cargo) delete r.piloting._cargo[k];
    r.piloting._cargoUnits = 0;
    for (let i = 0; i < 30; i++) {
      r.piloting.flight.place(can.pos.clone());
      combat._stepSalvage(DT);
    }
    assert.equal(can.active, false, 'an EMPTY hold refused salvage - the scoop is simply broken');
    assert.equal(r.piloting.cargoUnits, ALIEN_CLASSES.skiff.salvageBulk);
  } finally { teardown(r, combat); }
});

/* ================================================================== */
/* 9. The ugly cases                                                   */
/* ================================================================== */

test('a fight does not survive leaving the seat, the world, or the volume', async () => {
  const { r, combat } = await combatRig({ ship: 'kestrel', seed: 97 });
  try {
    const start = () => {
      placeShip(r, V(0, 0, -30000), V(0, 0, -40000), 190);
      combat._zones = [{
        id: 't-ugly', name: 'test', position: [0, 0, -30000], radius: 3000,
        wing: [{ class: 'skiff', count: 2 }],
      }];
      combat._cool.clear();
    };

    start();
    await step(r, combat, 30);
    assert.ok(combat.engaged, 'setup: nothing launched');
    r.bus.emit('pilot:left', { shipId: 'kestrel' });
    assert.equal(combat.contacts, 0, 'hostiles survived the pilot leaving the seat');
    assert.equal(r.piloting.interdicted, false, 'interdiction survived a stand-down');

    r.piloting.board('kestrel', { silent: true });
    start();
    await step(r, combat, 30);
    assert.ok(combat.engaged, 'setup: nothing relaunched');
    r.bus.emit('world:changed', { id: 'dock' });
    assert.equal(combat.contacts, 0, 'hostiles survived a world change');

    /* Run away. The wing stands down and the zone rearms on the shorter
     * clock, because the fight is unfinished rather than won. */
    await goto(r, 'space');
    r.piloting.board('kestrel', { silent: true });
    start();
    await step(r, combat, 30);
    assert.ok(combat.engaged, 'setup: nothing launched for the flee case');
    placeShip(r, V(0, 0, -60000), V(0, 0, -70000), 190);
    await step(r, combat, 4);
    console.log(`  after running 30 km: ${combat.contacts} contacts, `
      + `zone rearms in ${(combat._cool.get('t-ugly') ?? 0).toFixed(0)} s`);
    assert.equal(combat.contacts, 0, 'a wing 30 km astern is still fighting');
    assert.ok((combat._cool.get('t-ugly') ?? 0) > 0, 'the zone must not re-fire instantly');
  } finally { teardown(r, combat); }
});

test('clearing a zone rearms it on the long clock and stops interdicting at once', async () => {
  const { r, combat } = await combatRig({ ship: 'pike', seed: 101 });
  try {
    placeShip(r, V(0, 0, -30000), V(0, 0, -30600), 0);
    combat._zones = [{
      id: 't-clear', name: 'test', position: [0, 0, -30000], radius: 3000,
      wing: [{ class: 'skiff', count: 1 }], rearm: 210,
    }];
    let cleared = null;
    const off = r.bus.on('combat:cleared', (e) => { cleared = e; });
    await step(r, combat, 20);
    const h = combat.hostiles.find((x) => x.alive);
    assert.ok(h, 'setup: nothing launched');
    assert.equal(r.piloting.interdicted, true, 'a live wing must interdict');

    /* Kill it through the real damage path. */
    while (h.alive) combat._hostileHit(h, 40, h.position);
    await step(r, combat, 2);

    off();
    console.log(`  cleared: ${cleared?.name}, bounty ${cleared?.bounty} cr, `
      + `rearm ${combat._cool.get('t-clear')?.toFixed(0)} s, interdicted ${r.piloting.interdicted}`);
    assert.ok(cleared, 'floor: clearing the last hostile must report the encounter');
    assert.equal(r.piloting.interdicted, false, 'floor: a cleared field must let you leave at once');
    assert.ok((combat._cool.get('t-clear') ?? 0) > 100, 'a cleared zone must stay quiet for a while');
  } finally { teardown(r, combat); }
});

test('the volume the fight happens in is inside the near field, so nothing is a proxy', () => {
  /* `Scale.NEAR_FIELD` is 1400 m: inside it, `Backdrop` draws everything at
   * its TRUE position. Every distance combat cares about has to live there, or
   * the thing on screen is not where the maths says it is and the player is
   * aiming at a lie. */
  const NEAR_FIELD = 1400;
  const worst = Math.max(
    GUN.range,
    SPAWN_MAX,
    ...Object.values(ALIEN_CLASSES).map((c) => c.range),
  );
  console.log(`  gun ${GUN.range} m, spawn ${SPAWN_MAX} m, worst hostile gun `
    + `${Math.max(...Object.values(ALIEN_CLASSES).map((c) => c.range))} m; near field ${NEAR_FIELD} m`);
  assert.ok(worst < NEAR_FIELD, `${worst} m of engagement against a ${NEAR_FIELD} m near field`);
  /* And the arena has to be big enough to turn in. A stock Kestrel's turn
   * radius at cruise is 148 m; a gun range under a few radii would be a
   * knife fight with no room for the knife. */
  const radius = cruiseTopSpeed(1.75) / 1.4175;
  console.log(`  a stock Kestrel turns in ${radius.toFixed(0)} m; the gun reaches `
    + `${(GUN.range / radius).toFixed(1)} radii`);
  assert.ok(GUN.range > radius * 4, 'the arena must be several turn radii across');
});

test('a Dray can hit a skiff at knife range - the span cap is what makes it possible', async () => {
  /* THE CASE `MAX_SPAN` EXISTS FOR, AND IT DID NOT HAVE ONE.
   *
   * `_playerGun` sets the muzzle half-span to `length * 0.22`, which on a 28 m
   * Dray is 6.16 m per side, and clamps it to `MAX_SPAN`. The clamp is half of
   * the fix for the original "a Dray could never hit anything" defect - the
   * other half is `CONVERGE`, which aims both barrels at a point 550 m up the
   * nose line.
   *
   * `CONVERGE` was already guarded. `MAX_SPAN` was not: the only assertions on
   * it were `muzzleGap > MAX_SPAN` and `muzzleGap <= MAX_SPAN * 2`, both of
   * which the Dray's 6.40 m satisfies at a `MAX_SPAN` of 12 - so the mutation
   * `3.2 -> 12.0` stayed green. And 550 m is precisely the range at which the
   * cap does NOT matter, because that is where the bolts meet whatever the
   * span is.
   *
   * So this is fought at 90 m, and 90 is arithmetic rather than taste. A bolt
   * aimed at the convergence point is `span * (1 - d / CONVERGE)` off the axis
   * at range d, and a skiff's hit sphere is 4.2 m:
   *
   *     range   capped 3.2 m    uncapped 6.16 m
   *      200 m      2.04 m  hit      3.92 m  hit      <- the cap is invisible
   *      175 m      1.98 m  hit      4.20 m  edge
   *       90 m      2.68 m  hit      5.15 m  MISS
   *
   * Above about 175 m convergence alone is enough and the cap does nothing,
   * which is exactly why every existing case was blind to it. The ablation
   * moves the muzzles back out to where `length * 0.22` would put them and
   * re-aims them at the same convergence point, so the only thing that changes
   * is the number under test.
   */
  const { r, combat } = await combatRig({ ship: 'dray', seed: 5 });
  try {
    const RANGE = 90;
    const stage = () => {
      placeShip(r, V(0, 0, -30000), V(0, 0, -30000 - RANGE), 0);
      const s = combat._take('skiff');
      s.spawn(V(0, 0, -30000 - RANGE), V(0, 0, -30000), { holdFire: 99 });
      /* Held in BREAK straight down the firing line, for the same reason the
       * 500 m sweep case holds it: left to think it manoeuvres, and the case
       * becomes a measurement of the skiff's autopilot. */
      s.state = 'BREAK';
      s._breakFor = 99;
      s._breakDir.set(0, 0, -1);
      return s;
    };

    const s = stage();
    /* PINNED AT 200 m, every step. Left to run, the skiff opens the range - it
     * is on a break heading directly away - and the bolts converge on it as it
     * goes, so by 400 m even an uncapped span is on target and the ablation
     * below measures nothing. The claim is about knife range, so the range is
     * held. */
    const hold = (t, i) => { void t; void i; s.position.set(0, 0, -30000 - RANGE); };
    const before = s.integrity;
    combat.stats.shotsFired = 0;
    r.input.state.fire = true;
    await step(r, combat, 60, null, hold);
    r.input.state.fire = false;
    const landed = before - s.integrity;
    console.log(`  Dray at ${RANGE} m: ${combat.stats.shotsFired} shots, ${landed.toFixed(1)} damage`);
    assert.ok(combat.stats.shotsFired >= 4, `the gun did not fire (${combat.stats.shotsFired} shots)`);
    assert.ok(landed > 0, `floor: a Dray must be able to hit a stationary skiff at ${RANGE} m`);

    /* CEILING BY ABLATION. `_playerGun` writes the two muzzles at
     * `position +/- right * span` and aims each one at the convergence point,
     * so the ablation is a wrapper on `_spawnBolt` that pushes the player's
     * bolts back outboard to the UNCAPPED span and re-aims them at the same
     * point. Everything else about the shot - rate, damage, speed, the sweep -
     * is untouched. */
    const realSpawn = combat._spawnBolt;
    const UNCAPPED = SHIP_CLASSES.dray.length * 0.22;
    combat._spawnBolt = function wideSpan(origin, dir, speed, damage, range, side, owner = null) {
      if (side === 0) {
        const f = r.piloting.flight;
        const right = f.right(new THREE.Vector3());
        const fwd = f.forward(new THREE.Vector3());
        const off = origin.clone().sub(f.position);
        const s2 = Math.sign(off.dot(right)) || 1;
        const wide = origin.clone().addScaledVector(right, (UNCAPPED - MAX_SPAN) * s2);
        const aim = f.position.clone().addScaledVector(fwd, CONVERGE).sub(wide).normalize();
        return realSpawn.call(this, wide, aim, speed, damage, range, side, owner);
      }
      return realSpawn.call(this, origin, dir, speed, damage, range, side, owner);
    };
    const s2 = stage();
    const hold2 = (t, i) => { void t; void i; s2.position.set(0, 0, -30000 - RANGE); };
    const before2 = s2.integrity;
    combat.stats.shotsFired = 0;
    r.input.state.fire = true;
    await step(r, combat, 60, null, hold2);
    r.input.state.fire = false;
    const ablated = before2 - s2.integrity;
    combat._spawnBolt = realSpawn;
    console.log(`  ablated (uncapped ${UNCAPPED.toFixed(2)} m span): ${combat.stats.shotsFired} shots, `
      + `${ablated.toFixed(1)} damage against ${landed.toFixed(1)} capped`);
    assert.ok(landed > ablated * 2 + 1,
      `ablation: an uncapped span must miss at ${RANGE} m - ${ablated.toFixed(1)} damage `
      + `against ${landed.toFixed(1)} with the cap`);
  } finally { teardown(r, combat); }
});

test('the capacitor is a resource and not a jam: a held trigger sustains its rate', async () => {
  /* `GUN.regenDelay` IS ZERO ON PURPOSE AND NOTHING MEASURED IT.
   *
   * The note on it records the defect it was set to 0 to fix: at 0.35 s the
   * dead time after every shot stacks on the 9/30 = 0.3 s it takes to afford
   * the next one, so the sustained rate is 1/(0.35 + 0.3) = 1.54 shots a
   * second against a burst rate of five - "measured in the browser at 2 shots
   * in 1.2 seconds while the trigger was held". Nothing in the suite measured
   * sustained fire, so `regenDelay: 0 -> 0.35` was a mutation that stayed
   * green and a documented, browser-visible jam could be reintroduced in one
   * character.
   *
   * Held trigger, four seconds, counted. The shape the design wants:
   * 100/9 = 11 shots straight off a full charge, then a steady 30/9 = 3.33 a
   * second. Over 4 s that is 11 + 3.33 x (4 - 11 x 0.20) = about 17.
   */
  const { r, combat } = await combatRig({ ship: 'kestrel', seed: 9 });
  try {
    placeShip(r, V(0, 0, -30000), V(0, 0, -30500), 0);
    /* Something in the volume, because `_playerGun` only runs while the world
     * is playable. Placed 900 m out and held on its break so no bolt reaches
     * it inside the window: this measures the GUN, not the fight. */
    const s = combat._take('skiff');
    s.spawn(V(0, 0, -30900), V(0, 0, -30000), { holdFire: 99 });
    s.state = 'BREAK';
    s._breakFor = 99;
    s._breakDir.set(0, 0, -1);

    combat.stats.shotsFired = 0;
    r.input.state.fire = true;
    const SECONDS = 12;
    await step(r, combat, Math.round(SECONDS / DT));
    r.input.state.fire = false;
    const shots = combat.stats.shotsFired;
    const rate = shots / SECONDS;
    console.log(`  ${shots} shots in ${SECONDS}s = ${rate.toFixed(2)}/s `
      + `(burst ${(1 / GUN.interval).toFixed(2)}/s, floor ${(40 / 12).toFixed(2)}/s)`);

    /* TWELVE SECONDS AND NOT FOUR, and the reason is arithmetic rather than
     * patience. Firing costs 45/s and the capacitor pays back 30/s, so a full
     * 100 does not run dry until about 6.7 s in: a four-second window never
     * reaches the sustained rate at all and measures only the burst, which is
     * the same for both designs. Twelve seconds spans both halves.
     *
     * FLOOR 40 (3.33/s averaged). Shipped, the window yields about 50. With
     * `regenDelay: 0.35` the capacitor cannot charge AT ALL while the trigger
     * is held at 0.2 s intervals, so it is 11 shots off the stored charge and
     * then one every 0.35 + 0.3 s - about 26 in the same window. The floor sits
     * inside that gap rather than beside it. */
    assert.ok(shots >= 40,
      `floor: a held trigger must sustain 40 shots in ${SECONDS}s; got ${shots} `
      + `(${rate.toFixed(2)}/s). A recharge delay has been reintroduced.`);
    /* CEILING: it must still be a capacitor. Four seconds at the burst rate is
     * 20 shots, and reaching that means the cost is not being paid at all. */
    assert.ok(shots < SECONDS / GUN.interval,
      `ceiling: ${shots} shots in ${SECONDS}s is the burst rate - the capacitor charges nothing`);
    /* And the burst, which is the other half of the shape: eleven shots come
     * off the stored charge before the rate steps down, and that step is what
     * the player sees on the bar. */
    assert.equal(Math.floor(GUN.capacity / GUN.cost), 11,
      'the burst off a full capacitor is 11 shots');
  } finally { teardown(r, combat); }
});

/* ================================================================== */
/* 14. Getting away                                                    */
/* ================================================================== */

/**
 * A FIGHT MUST BE ESCAPABLE, AND THE ESCAPE MUST BE SOMETHING YOU DO.
 *
 * Taking a hit drops the transit drive (`Piloting._breakTransit`), so a player
 * who cannot break the lock cannot leave at all - they are held in normal
 * space by a wing that has already stopped shooting at them. That is the pin
 * `LOCK_RANGE` exists to bound, and a bound with no case on it is a comment.
 *
 * Flown, not derived: a real merge at real speed, then the throttle pinned
 * away from the fight and the boost spent, and the clock read off the step
 * `interdicted` goes false. Both ends are asserted, because the interesting
 * failure is in either direction - a lock you cannot break is a pin, and one
 * that falls off in a second and a half is the fly-through defect returning
 * (which is exactly what `LOCK_RANGE: 1500` did, and what the interdiction
 * case caught).
 *
 * ── AND IT IS NOW FLOWN BY A HULL THAT *CAN* OUT-RUN THE WING ─────────────
 * This block used to read the other way round, and the correction is the
 * whole point of it. `_flightrig` boards through `Piloting.board`, and
 * `_shipRecord`'s two lookups were both world-scoped - only `DockWorld`
 * publishes `world.ships`, and `ShipRegistry._adopt` replaces its map on every
 * `world:changed`. `combatRig` boards AFTER `goto('space')`, so every case in
 * this file took `Flight.setShip`'s `powerMul: 1` fallback and flew a Kestrel
 * that cruised at 120 m/s against a skiff's 174. Slower than the wing, slower
 * than any hull the yard sells.
 *
 * `_shipRecord` now falls back to `ShipRegistry.statsFor`, which is
 * world-independent, so the flown Kestrel cruises at 210 m/s - the game's
 * number - and every comment in this file that says so is now describing this
 * rig too. `_flightrig` asserts it on every board.
 *
 * Escape here still cannot come from speed alone: at cruise the margin over a
 * skiff is 36 m/s, so opening the 3.6 km `DISENGAGE` bound by running takes
 * about 100 s. It has to come from the release rule, which is what this case
 * measures.
 */
test('the lock survives a break-off, and releases a grace after contact is lost', async () => {
  /* ── PART A: IT MUST NOT FALL OFF MID-FIGHT ──────────────────────────────
   *
   * The two radius attempts documented on `LOCK_GRACE` both died here. A
   * normal break-and-reform opens thousands of metres - this file's own
   * merge case measures 3,590 m - so a lock that keys on distance releases
   * the drive between passes, the displacement multiplier spools to x8, and
   * the encounter ends itself. Flown: merge, then let the wing break, and
   * assert the lock holds through the whole cycle. */
  const { r, combat } = await combatRig({ ship: 'kestrel', seed: 61 });
  try {
    placeShip(r, V(0, 0, -30000), V(0, 0, -30600), 180);
    combat._zones = [{
      id: 't-flee', name: 'test', position: [0, 0, -30000], radius: 3000,
      wing: [{ class: 'skiff', count: 2 }],
    }];

    let merged = false;
    let widest = 0;
    let clearRun = 0;
    let longestClearRun = 0;
    let heldThroughout = true;
    let worstLockT = 0;
    await step(r, combat, 60 * 45, (t) => {
      /* LOITERING ON THE ZONE, which is what a player who has decided to fight
       * does, and what the guns-cold ablation in `space-objectives.test.mjs`
       * does. It is deliberately not a chase: pointing at the nearest hostile
       * keeps the gap under 600 m and never produces the separation this case
       * is about. Holding a point lets the wing break off properly, which is
       * exactly the geometry a distance-based lock cannot survive.
       *
       * (The flown hull is the game's stock Kestrel - 210 m/s cruise, boost
       * ceiling 455 - and `_flightrig` asserts that on every board. It used
       * not to be; see the header note.) */
      steerTo(r.piloting.flight, V(0, 0, -30000), { throttle: 1 });
      void t;
    }, (t) => {
      void t;
      const p = r.piloting.flight.position;
      let near = Infinity;
      let reach = false;
      for (const h of combat.hostiles) {
        if (!h.alive) continue;
        const d = h.position.distanceTo(p);
        near = Math.min(near, d);
        if (d < 400) merged = true;
        if (d <= h.def.range) reach = true;
      }
      if (!Number.isFinite(near)) return;
      if (merged) {
        widest = Math.max(widest, near);
        clearRun = reach ? 0 : clearRun + DT;
        longestClearRun = Math.max(longestClearRun, clearRun);
        if (!r.piloting.interdicted && combat.engaged) heldThroughout = false;
        /* THE INVARIANT, and it is the ceiling this case exists to state:
         * while you are held, the clock that will release you is running and
         * has not been sitting at its limit. */
        if (r.piloting.interdicted) worstLockT = Math.max(worstLockT, combat._lockT);
      }
    });

    console.log(`  through the fight: widest gap ${widest.toFixed(0)} m, longest stretch with `
      + `nothing in reach ${longestClearRun.toFixed(1)} s, worst lock clock `
      + `${worstLockT.toFixed(1)} s of ${LOCK_GRACE}`);
    assert.ok(merged, 'staging: the wing never got close enough for this to be a fight');
    /* THE STAGING BAR IS THE CLEAR RUN, NOT THE DISTANCE, and that is the
     * right bar now that the lock is a clock: what it has to survive is a
     * stretch with nothing able to shoot, and `BREAK_MAX` + a `REFORM` run is
     * up to 10.4 s of exactly that. Four seconds is a real break-off rather
     * than a gap between bursts. The widest gap is printed alongside because
     * it is what the two failed radius attempts were measured against. */
    assert.ok(longestClearRun > 4,
      `staging: the wing never broke off (longest stretch out of reach `
      + `${longestClearRun.toFixed(1)} s) - this case is about a lock surviving one`);
    assert.ok(widest > 700,
      `staging: the wing never left its own gun range by a margin (widest ${widest.toFixed(0)} m)`);
    assert.ok(heldThroughout,
      `floor: the lock fell off during a fight that was still on - the wing reached `
      + `${widest.toFixed(0)} m and was out of reach for ${longestClearRun.toFixed(1)} s, `
      + 'and a lock keyed on either would have released there');
    assert.ok(worstLockT < LOCK_GRACE,
      `the release clock reached ${worstLockT.toFixed(1)} s while still holding the player`);
  } finally { teardown(r, combat); }

  /* ── PART B: AND IT MUST LET GO ──────────────────────────────────────────
   *
   * The failure a lock invites is the pin: taking a hit drops the transit
   * drive, so a player held by a wing that has already lost them cannot leave
   * at all. The wing is held on a break heading straight away - the same
   * staging the sweep and span cases use, and for the same reason: left to
   * think, this measures the skiff's autopilot rather than the rule.
   */
  const b = await combatRig({ ship: 'kestrel', seed: 62 });
  try {
    placeShip(b.r, V(0, 0, -30000), V(0, 0, -31000), 0);
    const s2 = b.combat._take('skiff');
    /* PINNED AT 3,000 m, EVERY STEP, and the pin is the point.
     *
     * The rule under test is `SpaceCombat._locked`, not the skiff's autopilot,
     * and two attempts to produce "the wing has lost you" by flying failed for
     * reasons that belong to the autopilot: a hostile spawned facing the
     * player spends two and a half seconds turning round while closing at
     * 147 m/s, and `_break` exits the moment `range > 900` and REFORMS - which
     * steers back at the player's future position and starts closing again.
     * Closing is one of the two things that reset the clock, so with the AI
     * left to think, the clock never ran. Pinning is the same idiom the Dray
     * span case uses for the same reason, and it is applied AFTER the system
     * has stepped, so every read `_locked` makes is of a real position the AI
     * wrote. The craft is alive, in the pool, and inside `DISENGAGE`. */
    const at = V(0, 0, -33000);
    s2.spawn(at, at.clone().add(V(0, 0, -2000)), { holdFire: 0 });
    b.combat.fixedUpdate(DT, 0);
    /* Held from the moment it arrives, at 900 m and pointing away - because
     * the clock starts at zero. A wing that had to shoot at you before it
     * counted would let a player jump out of the spawn shell. */
    assert.equal(b.r.piloting.interdicted, true,
      'staging: a live wing must hold the lock from the moment it arrives');

    let freeAt = null;
    await step(b.r, b.combat, Math.round(20 / DT), () => {
      b.r.piloting.flight.setCommand({
        pitch: 0, yaw: 0, roll: 0, throttle: 0, vertical: 0, boost: false, brake: false,
      });
    }, (t) => {
      if (freeAt === null && !b.r.piloting.interdicted) freeAt = t;
      s2.position.copy(at);
      s2.velocity.set(0, 0, 0);
    });

    const gap = s2.position.distanceTo(b.r.piloting.flight.position);
    console.log(`  nothing in reach and nothing gaining from t=0; drive released at `
      + `${freeAt === null ? 'never' : `${freeAt.toFixed(1)} s`} (grace ${LOCK_GRACE} s), `
      + `hostile now ${gap.toFixed(0)} m out and still alive: ${s2.alive}`);
    assert.ok(s2.alive, 'staging: the hostile must still be alive, or this measures a standdown');
    assert.ok(freeAt !== null,
      `floor: the drive must come back once nothing can reach the player - still held after 20 s `
      + `with the hostile ${gap.toFixed(0)} m away`);
    assert.ok(freeAt >= LOCK_GRACE - 0.5 && freeAt <= LOCK_GRACE + 1.5,
      `the release came at ${freeAt.toFixed(1)} s against a ${LOCK_GRACE} s grace`);
  } finally { teardown(b.r, b.combat); }
});

/* ================================================================== */
/* 15. The contact readout, and every way it could publish a NaN       */
/* ================================================================== */

/**
 * THE HUD HALF, AND THE ONE RULE IT CANNOT BREAK.
 *
 * `contactReport` is what makes a hostile findable before it is legible, and
 * everything it publishes ends up in a CSS `left:` or a `textContent`. A
 * non-finite number there is not a visible error - `left: NaN%` is DROPPED by
 * the browser, which silently pins the marker to the top-left corner and
 * points the pilot at nothing. And this project has already lost a day to a
 * NaN: 19 of them through `UnrealBloomPass` blacked out a 921,600-pixel frame.
 *
 * So every field is checked finite, in every degenerate pose the geometry
 * admits: a contact dead astern (where `project` divides by a negative w and
 * answers confidently in the wrong corner), one exactly on the camera (where
 * it divides by zero), and one moving at exactly the player's velocity (which
 * is a real case in a co-speed turning fight and is why no time-to-close is
 * published at all).
 */
test('the contact readout is finite in every degenerate pose', async () => {
  const { r, combat } = await combatRig({ ship: 'kestrel', seed: 71 });
  try {
    placeShip(r, V(0, 0, -30000), V(0, 0, -31000), 120);
    const f = r.piloting.flight;

    const poses = [
      ['dead ahead, 500 m', V(0, 0, -30500), V(0, 0, 0)],
      ['dead astern, 400 m', V(0, 0, -29600), V(0, 0, 0)],
      ['abeam, 900 m', V(900, 0, -30000), V(0, 0, 0)],
      ['above, 1.2 km', V(0, 1200, -30000), V(0, 0, 0)],
      /* Exactly on the camera. `distanceTo` is 0, the bearing cannot be
       * normalised, and `project` divides by a w of about zero. */
      ['inside the hull', f.position.clone(), V(0, 0, 0)],
      /* Matched velocity: the closing speed is exactly 0. Any time-to-close
       * would be a division by it. */
      ['matched velocity', V(0, 0, -30400), f.velocity.clone()],
    ];

    for (const [what, at, vel] of poses) {
      for (const h of combat.hostiles) h.retire();
      const s = combat._take('skiff');
      s.spawn(at, f.position, { holdFire: 99 });
      s.velocity.copy(vel);
      /* THE REAL CHASE CAMERA, COMPOSED. `_project` runs through whatever
       * `Piloting._composeCamera` last placed, and the first version of this
       * case never called it - so every pose came back `edge`, the on-plate
       * branch was never taken, and the case would have passed with the
       * projection deleted entirely. */
      r.piloting.update(0.016, 0);
      combat.update(0.016);
      const rows = combat.contactReport();
      assert.equal(rows.length, 1, `${what}: expected exactly one contact`);
      const row = rows[0];
      for (const k of ['range', 'frac', 'ahead', 'above', 'right', 'closing']) {
        assert.ok(Number.isFinite(row[k]), `${what}: ${k} is ${row[k]}`);
      }
      assert.ok(Number.isFinite(row.ndc.x) && Number.isFinite(row.ndc.y),
        `${what}: ndc is (${row.ndc.x}, ${row.ndc.y})`);
      /* The marker must always be DRAWABLE. A contact off the plate or behind
       * the camera falls back to its bearing and is pinned to the edge; one
       * that simply switched off would be absent exactly when it is needed. */
      assert.equal(row.ndc.on, true, `${what}: the pip switched itself off`);
      assert.ok(Math.abs(row.ndc.x) <= 1.2 && Math.abs(row.ndc.y) <= 1.2,
        `${what}: ndc (${row.ndc.x.toFixed(2)}, ${row.ndc.y.toFixed(2)}) is off the plate`);
      assert.ok(row.ahead >= -1.0001 && row.ahead <= 1.0001,
        `${what}: ahead ${row.ahead} is not a unit dot`);
      console.log(`  ${what.padEnd(22)} ${row.edge ? 'edge' : 'on  '} `
        + `ndc (${row.ndc.x.toFixed(2)}, ${row.ndc.y.toFixed(2)}) `
        + `ahead ${row.ahead.toFixed(2)} closing ${row.closing.toFixed(1)} m/s`);
    }

    /* A camera that has not been composed yet - the first frame of a world
     * change - is the other way a projection goes non-finite. It must produce
     * a bearing-pinned marker, not a NaN. */
    const cam = combat.camera;
    combat.camera = null;
    const blind = combat.contactReport();
    assert.equal(blind.length, 1, 'no camera must not mean no contacts');
    assert.ok(Number.isFinite(blind[0].ndc.x) && Number.isFinite(blind[0].ndc.y),
      'a missing camera published a non-finite pip');
    combat.camera = cam;

    /* And the ordering contract the HUD leans on: nearest first, so the six
     * drawn rows are the six that matter when a seventh could not exist. */
    for (const h of combat.hostiles) h.retire();
    for (const d of [900, 200, 1500, 600]) {
      const s = combat._take('skiff');
      s.spawn(V(0, 0, -30000 - d), f.position, { holdFire: 99 });
    }
    r.piloting.update(0.016, 0);
    combat.update(0.016);
    const many = combat.contactReport();
    const ranges = many.map((x) => Math.round(x.range));
    console.log(`  four contacts, sorted: ${ranges.join(', ')} m`);
    for (let i = 1; i < many.length; i++) {
      assert.ok(many[i].range >= many[i - 1].range,
        `contacts are not nearest-first: ${ranges.join(', ')}`);
    }
    /* `locked` names exactly the one the lead pip is solving for, and only
     * inside `TARGET_RANGE` - a pip on a six-pixel speck 3 km away is telling
     * the pilot about something they cannot act on. */
    const locked = many.filter((x) => x.locked);
    assert.ok(locked.length <= 1, `${locked.length} contacts claim the lock`);
    for (const x of many) {
      if (x.locked) {
        assert.ok(x.range <= TARGET_RANGE,
          `the lead pip is solving for something ${Math.round(x.range)} m away`);
      }
    }
  } finally { teardown(r, combat); }
});

/* ================================================================== */
/* 16. Hold fire, as a distance rather than a time                     */
/* ================================================================== */

test('the first bolt of an encounter arrives where the player can see what fired it', () => {
  /* `HOLD_FIRE` is a time and it is spent as a DISTANCE. From the near edge of
   * the spawn shell at the closure a merge actually produces, the ship the
   * player is being shot by has to be inside the range at which it reads as a
   * ship - otherwise the first thing that happens in an encounter is damage
   * from nowhere, which is the session the hull alarm was written for.
   *
   * Closure: a stock Kestrel cruises at 210 m/s and a fresh wing arrives at
   * half its own top speed pointed at the player (`AlienShip.spawn`), so a
   * skiff contributes 87 m/s - 297 m/s head-on, which is the worst (fastest)
   * case and therefore the right one to bound with. */
  const CRUISE = cruiseTopSpeed(1.75);
  const skiff = ALIEN_CLASSES.skiff;
  const closure = CRUISE + (skiff.thrust / skiff.drag) * 0.5;
  const firstBolt = SPAWN_MIN - closure * HOLD_FIRE;
  console.log(`  spawn ${SPAWN_MIN} m, closure ${closure.toFixed(0)} m/s, hold ${HOLD_FIRE} s `
    + `-> first bolt at about ${firstBolt.toFixed(0)} m`);
  assert.ok(firstBolt > BREAK_RANGE,
    `the hold runs past the merge (${firstBolt.toFixed(0)} m against a ${BREAK_RANGE} m break) - `
    + 'the opening pass would have no shots in it at all');
  assert.ok(firstBolt < skiff.range,
    `the first bolt would arrive at ${firstBolt.toFixed(0)} m, outside the ${skiff.range} m `
    + 'range this class can even shoot from');
});

/* ================================================================== */
/* 17. Arming and launching are two different things                   */
/* ================================================================== */

/**
 * A WING MUST NOT BE LAUNCHED INTO A LIVE TRANSIT DRIVE.
 *
 * ── THE DEFECT, IN ARITHMETIC ──────────────────────────────────────────────
 * `Flight`'s transit drive tops out at 5,000 m/s. A picket's trigger sphere is
 * 4,200 m in radius - 0.84 seconds of it. The old spawner launched on the step
 * the sphere was crossed and `interdicted` was written from `engaged`, so the
 * flag could not possibly be true until AFTER the wing existed; the drive then
 * spent `transitSpoolDown` (1.2 s) shedding 5,000 m/s to cruise, over which
 * the ship covers about 3.1 km. The wing was three kilometres astern before
 * its first bolt and had to catch a faster ship from behind, which it cannot.
 * The encounter existed and never happened.
 *
 * So crossing the sphere now ARMS the zone - which writes `interdicted`
 * immediately, and `Piloting._transitBreak` drops the drive - and the wing
 * launches only once `flight.transitState` is back to `off`.
 *
 * This case holds the drive open by hand and checks both halves: nothing
 * launches while it is live, and something does the moment it is not. The
 * ablation is the same flight with the gate removed, which is the shape the
 * old code had.
 */
test('a zone arms on entry and holds its wing until the transit drive has dropped', async () => {
  const { r, combat } = await combatRig({ ship: 'kestrel', seed: 83 });
  try {
    placeShip(r, V(0, 0, -30000), V(0, 0, -60000), 210);
    combat._zones = [{
      id: 't-arm', name: 'test', position: [0, 0, -30000], radius: 4200,
      wing: [{ class: 'skiff', count: 2 }],
    }];

    /* The drive, latched directly. `Flight.engageTransit` is deliberately a
     * dumb latch - `Piloting._pollTransit` is the thing that refuses - so this
     * is the same door the Z key opens and not a back one. */
    const f = r.piloting.flight;
    f.engageTransit();
    /* `env.transitAltitude` is filled by `Piloting` from `approachState` every
     * step, and out here between bodies it is large, so the altitude law
     * allows the top speed. Nothing is stubbed. */

    let contacts = 0;
    const off = r.bus.on('combat:contacts', () => { contacts++; });

    /* Ten steps with the drive held open by re-latching it every step, which
     * is what a player holding a course under transit looks like to this
     * system. `interdicted` must already be true and the wing must not be
     * out. */
    let armedWhileUnderway = 0;
    let contactsWhileUnderway = 0;
    await step(r, combat, 40, () => {
      if (f.transitState === 'off') f.engageTransit();
    }, () => {
      if (f.transitState !== 'off') {
        if (combat._armed) armedWhileUnderway++;
        contactsWhileUnderway = contacts;
      }
    });

    console.log(`  under way: transit ${f.transitState}, armed for ${armedWhileUnderway} steps, `
      + `interdicted ${r.piloting.interdicted}, contacts ${contactsWhileUnderway}`);
    assert.ok(armedWhileUnderway > 0,
      'floor: crossing the trigger sphere must ARM the zone even though it cannot launch yet');
    assert.equal(r.piloting.interdicted, true,
      'floor: an armed zone must interdict - that is what drops the drive');
    assert.equal(contactsWhileUnderway, 0,
      `floor: ${contactsWhileUnderway} wings launched into a live transit drive`);

    /* Now let it drop. Nothing is forced: `Piloting._transitBreak` reads the
     * flag this system wrote and calls `dropTransit('interdicted')` itself. */
    await step(r, combat, 60 * 6, () => {
      steerTo(r.piloting.flight, V(0, 0, -60000), { throttle: 1 });
    });
    off();

    console.log(`  after the drop: transit ${f.transitState}, contacts ${contacts}, `
      + `${combat.contacts} alive, speed ${f.speed.toFixed(0)} m/s`);
    assert.equal(f.transitState, 'off', 'the drive should have been dropped by the interdiction');
    assert.ok(contacts > 0, 'floor: the wing must launch once the drive is down');
    assert.ok(combat.engaged, 'floor: the fight must actually be on');
    /* And it must have launched into a speed a 600-850 m standoff means
     * something at. A stock Kestrel's boost top is 455 m/s; anything above
     * that is the drive still running. */
    assert.ok(f.speed < 600,
      `the wing launched at ${f.speed.toFixed(0)} m/s - the standoff is 1.4 s of that`);
  } finally { teardown(r, combat); }
});
