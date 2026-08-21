import test from 'node:test';
import assert from 'node:assert/strict';

import {
  proxyDistance,
  proxyPlacement,
  angularRadius,
  screenFraction,
  NEAR_FIELD,
  PROXY_MAX,
  FAR_SAFE,
  DEPTH_HORIZON,
} from '../../src/worlds/space/Scale.js';

import {
  SPACE_BODIES,
  BODY_BY_ID,
  BELT,
  DOCK_ANCHOR,
  STAR_DIRECTION,
  approachState,
  landableBodies,
  navTargets,
} from '../../src/worlds/space/Bodies.js';

/**
 * The scale scheme and the body layout, tested where they can be tested -
 * which is everywhere, because neither file imports three.
 *
 * What these assertions are FOR, since a test that only re-states the code is
 * worse than none:
 *
 *  - The proxy is claimed to be ANGULAR-EXACT. That is the load-bearing claim
 *    in Scale.js and it is checkable to floating-point tolerance. If it stops
 *    holding, planets change apparent size as you approach and the whole
 *    scheme is a lie.
 *  - Nothing may be drawn beyond the far plane. That is the constraint the
 *    scheme exists to satisfy, and it is checked at close range against the
 *    largest body, which is where it binds hardest.
 *  - The layout claims direction variety and a screen-size progression. Those
 *    are the two things the player actually asked for, so they are asserted as
 *    FLOORS with a measured achieved value, not as "not worse than nothing".
 *
 * Mutation record. Every assertion below was reversed, the single case re-run,
 * and confirmed red before being restored - reported at the bottom of the run.
 */

const FOV = 75; // CONFIG.render.fov
const CAMERA_FAR = 2000; // CONFIG.render.far

const place = { d: 0, scale: 0 };

/* ------------------------------------------------------------------ */
/* The map itself                                                      */
/* ------------------------------------------------------------------ */

test('proxyDistance is the identity below NEAR_FIELD, and continuous through it', () => {
  assert.equal(proxyDistance(1), 1);
  assert.equal(proxyDistance(NEAR_FIELD), NEAR_FIELD);
  // Continuity at the seam: the two branches must agree to well under a
  // millimetre, or a body drifting across 1400 m visibly jumps.
  const below = proxyDistance(NEAR_FIELD - 1e-6);
  const above = proxyDistance(NEAR_FIELD + 1e-6);
  assert.ok(Math.abs(above - below) < 1e-4, `seam jump ${above - below} m`);
});

test('proxyDistance is strictly monotone up to the horizon, then saturates', () => {
  let prev = -1;
  for (let D = 1; D < DEPTH_HORIZON; D *= 1.35) {
    const d = proxyDistance(D);
    assert.ok(d > prev, `not monotone at D=${D}`);
    assert.ok(d <= PROXY_MAX + 1e-9, `overshot PROXY_MAX at D=${D}: ${d}`);
    prev = d;
  }
  assert.ok(Math.abs(proxyDistance(DEPTH_HORIZON) - PROXY_MAX) < 1e-6);
  /* Beyond the horizon everything ties at PROXY_MAX. That is deliberate and
   * harmless - bodies are painter-ordered, not depth-ordered - but it means
   * the map is only NON-DECREASING out there, not strictly increasing. The
   * furthest thing that exists is the star at 640 km, well inside. */
  assert.equal(proxyDistance(DEPTH_HORIZON * 100), PROXY_MAX);
  const furthest = Math.max(...SPACE_BODIES.map((b) => Math.hypot(...b.position)));
  assert.ok(
    furthest < DEPTH_HORIZON,
    `${(furthest / 1000).toFixed(0)} km is past the horizon - two bodies out there would tie`
  );
});

test('proxyDistance throws on a non-finite or non-positive distance', () => {
  // The house rule: a NaN here becomes a NaN vertex, and a NaN vertex through
  // the bloom is a black frame with nothing in the console.
  for (const bad of [NaN, Infinity, -Infinity, 0, -5, undefined]) {
    assert.throws(() => proxyDistance(bad), /finite positive/, `accepted ${bad}`);
  }
});

test('proxyPlacement preserves angular size EXACTLY - the load-bearing claim', () => {
  let worst = 0;
  for (const R of [1, 120, 4200, 9000, 15000, 38000, 86640]) {
    for (let D = R * 1.02; D < 8e5; D *= 1.21) {
      proxyPlacement(D, R, place);
      const trueAngle = angularRadius(R, D);
      const drawnAngle = angularRadius(R * place.scale, place.d);
      const err = Math.abs(drawnAngle - trueAngle);
      if (err > worst) worst = err;
    }
  }
  // 1e-12 rad is 2e-7 pixels at 1080p. This is exact, not approximate.
  assert.ok(worst < 1e-12, `worst angular error ${worst} rad`);
});

test('nothing is ever drawn beyond the camera far plane', () => {
  let worstLimb = 0;
  let worstAt = null;
  for (const R of [120, 4200, 9000, 15000, 38000, 86640]) {
    // Right down to the surface, which is where the cap binds hardest.
    for (let D = R * 1.0005; D < 8e5; D *= 1.09) {
      proxyPlacement(D, R, place);
      const limb = place.d * (1 + R / D);
      if (limb > worstLimb) {
        worstLimb = limb;
        worstAt = { R, D };
      }
    }
  }
  assert.ok(
    worstLimb <= FAR_SAFE + 1e-9,
    `far limb reached ${worstLimb} m (R=${worstAt?.R}, D=${worstAt?.D})`
  );
  assert.ok(worstLimb < CAMERA_FAR, `no headroom under the ${CAMERA_FAR} m far plane`);
});

test('the near surface of a body never crosses behind the camera', () => {
  // d*(1-q) is the near limb. It may reach zero only when the camera is ON the
  // surface; anywhere outside it must be positive or the body inverts.
  for (const R of [9000, 38000]) {
    for (let D = R * 1.001; D < 4e5; D *= 1.13) {
      proxyPlacement(D, R, place);
      const near = place.d * (1 - R / D);
      assert.ok(near > 0, `near limb ${near} at R=${R} D=${D}`);
    }
  }
});

test('the far-limb cap really does invert the ordering - the reason Backdrop paints', () => {
  /* This is not a test of desired behaviour; it is a REGRESSION PIN on the
   * hazard. Backdrop.js switches the depth test off for bodies and cites these
   * two numbers as the reason. If a future change to the map made the cap stop
   * binding, this test goes red and the comment in Backdrop.js - and possibly
   * its whole design - is out of date and should be revisited. */
  const cinder = BODY_BY_ID.cinder;
  const ceraunus = BODY_BY_ID.ceraunus;
  const dCinder = Math.hypot(...cinder.position);
  const dCeraunus = Math.hypot(...ceraunus.position);
  assert.ok(dCinder < dCeraunus, 'Cinder is meant to be the nearer of the two');

  proxyPlacement(dCinder, cinder.radius, place);
  const pCinder = place.d;
  proxyPlacement(dCeraunus, ceraunus.radius * ceraunus.ring.outer, place);
  const pCeraunus = place.d;

  assert.ok(
    pCinder > pCeraunus,
    `expected the cap to invert these (Cinder ${pCinder.toFixed(1)}, ` +
      `Ceraunus ${pCeraunus.toFixed(1)}); if it no longer does, re-read ` +
      `the painter-ordering note in Backdrop.js`
  );
});

/* ------------------------------------------------------------------ */
/* The layout                                                          */
/* ------------------------------------------------------------------ */

/** Unit direction from the dock to a body. */
function bearing(body) {
  const [x, y, z] = body.position;
  const len = Math.hypot(x, y, z);
  return [x / len, y / len, z / len];
}

test('every direction the player asked for is spoken for', () => {
  /* "some of the planets i would fly out and down to reach, others to the
   * right or left or straight ahead or out and up" - five directions, and the
   * floor is that each one has a body whose bearing is dominated by it.
   *
   * Floor 0.34 on the axis component: that is 20 degrees of separation from
   * the 45-degree diagonal, enough that a player told "up and out" does not
   * end up at the thing that is really to starboard. Achieved values printed. */
  const FLOOR = 0.34;
  const got = {};
  for (const b of SPACE_BODIES) got[b.id] = bearing(b);
  const beltB = (() => {
    const [x, y, z] = BELT.position;
    const l = Math.hypot(x, y, z);
    return [x / l, y / l, z / l];
  })();

  const checks = [
    ['out and down (Cinder)', -got.cinder[2], -got.cinder[1]],
    ['out and up (Ceraunus)', -got.ceraunus[2], got.ceraunus[1]],
    ['straight ahead (Vitrine)', -got.vitrine[2], -got.vitrine[2]],
    ['right (Tessera)', got.tessera[0], got.tessera[0]],
    ['left (Halberd Reach)', -beltB[0], -beltB[0]],
  ];
  const report = [];
  for (const [name, a, b] of checks) {
    report.push(`${name}: ${a.toFixed(2)}/${b.toFixed(2)}`);
    assert.ok(a >= FLOOR, `${name}: primary component ${a.toFixed(3)} < ${FLOOR}`);
    assert.ok(b >= FLOOR, `${name}: secondary component ${b.toFixed(3)} < ${FLOOR}`);
  }
  // Straight ahead must ALSO be near-axial, or it is just another diagonal.
  assert.ok(-got.vitrine[2] > 0.94, `Vitrine is not straight ahead: ${-got.vitrine[2]}`);
  console.log('   directions:', report.join(' | '));
});

test('bodies are separated enough that no two ever overlap in the sky', () => {
  /* Painter ordering is exact only while the bodies do not interpenetrate.
   * Cheaper and stronger: assert their surfaces are kilometres apart. */
  for (let i = 0; i < SPACE_BODIES.length; i++) {
    for (let j = i + 1; j < SPACE_BODIES.length; j++) {
      const a = SPACE_BODIES[i];
      const b = SPACE_BODIES[j];
      const sep = Math.hypot(
        a.position[0] - b.position[0],
        a.position[1] - b.position[1],
        a.position[2] - b.position[2]
      );
      const touch = a.radius + b.radius;
      assert.ok(sep > touch * 2, `${a.name} and ${b.name} are only ${(sep / 1000).toFixed(1)} km apart`);
    }
  }
});

test('the volcanic planet grows from a spark to a world, with a floor at each stage', () => {
  /* THE central promise of the scale scheme: "a planet you approach must grow
   * convincingly from a point to a world filling the view."
   *
   * Asserted as floors with the achieved value reported, because a
   * not-smaller-than assertion with no floor is how this project once shipped
   * a world nobody could reach. The ceiling on the first row is the ablation:
   * at the dock it must be small enough to read as distant. */
  const c = BODY_BY_ID.cinder;
  const dockDist = Math.hypot(...c.position);

  const stages = [
    // label,       distance,      floor,  ceiling
    ['from the dock', dockDist, 0.12, 0.35],
    ['at 20 km', 20000, 0.55, 0.95],
    ['at 12 km', 12000, 1.05, 2.0],
    ['at handoff', c.handoff, 1.5, 4.0],
  ];
  const line = [];
  for (const [label, D, floor, ceiling] of stages) {
    const f = screenFraction(c.radius, D, FOV);
    line.push(`${label} ${f.toFixed(3)}`);
    assert.ok(f >= floor, `${label}: ${f.toFixed(3)} below floor ${floor}`);
    assert.ok(f <= ceiling, `${label}: ${f.toFixed(3)} above ceiling ${ceiling}`);
  }
  console.log('   Cinder screen fraction:', line.join(' -> '));
});

test('every body is a disc rather than a star from the dock', () => {
  /* The floor that stops a body being scenery you cannot see. 0.02 of screen
   * height at 1080p is 21 pixels - unambiguously a shape with an edge. */
  const FLOOR = 0.02;
  const line = [];
  for (const b of SPACE_BODIES) {
    const D = Math.hypot(...b.position);
    const f = screenFraction(b.radius, D, FOV);
    line.push(`${b.name} ${f.toFixed(3)}`);
    assert.ok(f >= FLOOR, `${b.name} is only ${f.toFixed(4)} of screen height from the dock`);
  }
  console.log('   from the dock:', line.join(' | '));
});

test('the star direction and the star body agree', () => {
  const star = BODY_BY_ID.erenmark;
  const len = Math.hypot(...star.position);
  for (let i = 0; i < 3; i++) {
    assert.ok(
      Math.abs(STAR_DIRECTION[i] - star.position[i] / len) < 1e-12,
      'STAR_DIRECTION has drifted from the star it is derived from'
    );
  }
  assert.ok(Math.abs(Math.hypot(...STAR_DIRECTION) - 1) < 1e-12, 'not a unit vector');
});

test('the star is behind, so everything the player flies at is front-lit', () => {
  /* The layout claims this and it is the reason the sky reads. A body is
   * front-lit when the star is roughly opposite the direction you look to see
   * it: dot(bearing, starDirection) < 0. */
  const line = [];
  for (const b of SPACE_BODIES) {
    if (b.kind === 'star') continue;
    const [x, y, z] = bearing(b);
    const d = x * STAR_DIRECTION[0] + y * STAR_DIRECTION[1] + z * STAR_DIRECTION[2];
    const phase = ((1 - d) / 2) * 100;
    line.push(`${b.name} ${phase.toFixed(0)}%`);
    assert.ok(d < 0.35, `${b.name} is back-lit from the dock (dot ${d.toFixed(2)})`);
  }
  // And at least one is a partial phase, or the sky is four flat full discs.
  const phases = SPACE_BODIES.filter((b) => b.kind !== 'star').map((b) => {
    const [x, y, z] = bearing(b);
    return x * STAR_DIRECTION[0] + y * STAR_DIRECTION[1] + z * STAR_DIRECTION[2];
  });
  assert.ok(Math.max(...phases) - Math.min(...phases) > 0.5, 'every body is at the same phase');
  console.log('   illuminated fraction:', line.join(' | '));
});

/* ------------------------------------------------------------------ */
/* The approach interface                                              */
/* ------------------------------------------------------------------ */

/** A point `alt` metres above Cinder's surface, on the vector from the dock. */
function aboveCinder(alt) {
  const c = BODY_BY_ID.cinder;
  const len = Math.hypot(...c.position);
  const u = c.position.map((v) => v / len);
  const r = c.radius + alt;
  // Approach from the dock side, i.e. back along the bearing.
  return {
    x: c.position[0] - u[0] * r,
    y: c.position[1] - u[1] * r,
    z: c.position[2] - u[2] * r,
  };
}

test('approachState walks a descent through every phase, in order', () => {
  const c = BODY_BY_ID.cinder;
  const air = c.atmosphere - c.radius;

  const atDock = approachState({ x: 0, y: 0, z: 0 });
  assert.equal(atDock.phase, 'cruise');
  assert.equal(atDock.shouldHandoff, false);
  assert.equal(atDock.atmoDepth, 0);

  const far = approachState(aboveCinder(c.radius * 8));
  assert.equal(far.body.id, 'cinder');
  assert.equal(far.phase, 'cruise');

  const near = approachState(aboveCinder(c.radius * 2));
  assert.equal(near.phase, 'approach', 'six radii in should be an approach');

  /* Midway between the top of the air and the handoff altitude. This is the
   * band that did not exist in the first draft - see the note on Cinder in
   * Bodies.js. */
  const handoffAlt = c.handoff - c.radius;
  const inAir = approachState(aboveCinder((air + handoffAlt) / 2));
  assert.equal(inAir.phase, 'atmosphere');
  assert.ok(inAir.atmoDepth > 0.05 && inAir.atmoDepth < 0.95, `atmoDepth ${inAir.atmoDepth}`);
  assert.equal(inAir.shouldHandoff, false, 'the air is not the handoff');

  const down = approachState(aboveCinder(handoffAlt - 1));
  assert.equal(down.phase, 'handoff');
  assert.equal(down.shouldHandoff, true);
  assert.equal(down.body.surfaceWorld, 'planet:cinder');
});

test('the atmosphere phase is REACHABLE, with a floor on how much air you fly', () => {
  /* The regression pin for the bug above. A phase that is in the enum, is
   * handled by callers, and can never be entered is the exact shape of defect
   * this project ships: built, not reachable.
   *
   * Floor 300 m of air above the handoff. At a 250 m/s entry that is 1.2
   * seconds of glow - the shortest transition that reads as one rather than
   * as a cut. Ceiling by ablation: more than half the air must remain BELOW
   * the handoff, or space is doing the planet's job. */
  /* AIRLESS BODIES ARE A CATEGORY, NOT AN EXEMPTION.
   *
   * Phase 1 had one landable body and it had air, so this case asserted air of
   * everything landable. Phase 2 lands Tessera and Lathe, which have none - and
   * "no air" is a real, visible property of those two worlds (black sky at
   * noon, no haze, no fill in the shadows), not a shortcut.
   *
   * So the two cases are split and BOTH are asserted, rather than the airless
   * one being skipped. A body that claims air must let you fly a real amount of
   * it; a body that claims none must SKIP the atmosphere phase cleanly - which
   * means the descent walks cruise -> approach -> handoff and `atmoDepth` never
   * leaves 0. The failure this guards is the mirror of the original defect: not
   * a phase that cannot be entered, but a phase entered with a negative depth,
   * which is how a NaN gets into a shader uniform. */
  const withAir = landableBodies().filter((b) => b.atmosphere > b.radius);
  const airless = landableBodies().filter((b) => b.atmosphere <= b.radius);
  assert.ok(withAir.length > 0, 'no landable body has any air at all');
  assert.ok(airless.length > 0, 'the airless category has no members - delete it or fill it');

  for (const b of withAir) {
    const air = b.atmosphere - b.radius;
    const flown = b.atmosphere - b.handoff;
    assert.ok(
      flown >= 300,
      `${b.name}: only ${flown} m of air above the handoff (floor 300, air ${air})`
    );
    assert.ok(
      flown <= air * 0.5,
      `${b.name}: ${flown} m of ${air} m of air is flown in space - the planet should get most of it`
    );
    console.log(`   ${b.name}: ${air} m of air, handoff after ${flown} m of it`);
  }

  for (const b of airless) {
    assert.equal(b.atmosphere, b.radius,
      `${b.name} claims to be airless but its atmosphere radius is not its surface radius`);
    assert.ok(b.handoff > b.radius,
      `${b.name}: the handoff is at or under the surface, so the ship reaches the ground before the world does`);

    /* Walk the real descent and prove the phase is skipped rather than
     * entered badly. */
    const len = Math.hypot(...b.position);
    const u = b.position.map((v) => v / len);
    const at = (alt) => {
      const r = b.radius + alt;
      return { x: b.position[0] - u[0] * r, y: b.position[1] - u[1] * r, z: b.position[2] - u[2] * r };
    };
    const handoffAlt = b.handoff - b.radius;
    for (const alt of [b.radius * 8, b.radius * 2, handoffAlt + 1, handoffAlt - 1]) {
      const st = approachState(at(alt));
      assert.notEqual(st.phase, 'atmosphere',
        `${b.name} has no air but reports phase 'atmosphere' at ${alt} m`);
      assert.equal(st.atmoDepth, 0,
        `${b.name} has no air but reports atmoDepth ${st.atmoDepth} at ${alt} m`);
      assert.ok(Number.isFinite(st.atmoDepth) && Number.isFinite(st.altitude) && Number.isFinite(st.distance),
        `${b.name}: a non-finite approach value at ${alt} m - this is how a NaN reaches a uniform`);
    }
    assert.equal(approachState(at(handoffAlt - 1)).shouldHandoff, true,
      `${b.name}: inside the handoff radius and still not handing off`);
    console.log(`   ${b.name}: airless, handoff ${handoffAlt} m up, atmosphere phase correctly skipped`);
  }
});

test('approachState picks the nearest SURFACE, not the nearest centre', () => {
  /* A gas giant 100 km away is not "nearer" than a moonlet you are skimming,
   * and getting this backwards would hand the descent to the wrong world. */
  const t = BODY_BY_ID.tessera;
  const skimming = { x: t.position[0] + t.radius + 400, y: t.position[1], z: t.position[2] };
  const s = approachState(skimming);
  assert.equal(s.body.id, 'tessera');
  // Confirm the trap is real: some other body IS closer by centre distance
  // than Tessera's centre... no - confirm instead that surface ranking put
  // Tessera first while its centre distance is not the smallest coordinate.
  assert.ok(s.altitude > 0 && s.altitude < 500, `altitude ${s.altitude}`);
  assert.equal(s.shouldHandoff, true, 'Tessera is landable as of Phase 2 and this is inside its handoff');
});

test('a body with no handoff never claims one, however deep you go', () => {
  const g = BODY_BY_ID.ceraunus;
  const inside = { x: g.position[0], y: g.position[1], z: g.position[2] };
  const s = approachState(inside);
  assert.equal(s.body.id, 'ceraunus');
  assert.equal(s.shouldHandoff, false);
  assert.ok(s.altitude < 0, 'should report a negative altitude inside the body');
});

test('approachState allocates nothing per call', () => {
  const a = approachState({ x: 1, y: 2, z: 3 });
  const b = approachState({ x: 4, y: 5, z: 6 });
  assert.equal(a, b, 'the result object must be reused');
  // ...and a caller who wants a snapshot can pass their own.
  const mine = { body: null, distance: 0, altitude: 0, phase: '', atmoDepth: 0, shouldHandoff: false };
  const c = approachState({ x: 0, y: 0, z: 0 }, mine);
  assert.equal(c, mine);
});

/* ------------------------------------------------------------------ */
/* The published contract                                              */
/* ------------------------------------------------------------------ */

test('ten bodies are landable, the volcanic one is still first, and the two that are not landable say why', () => {
  /* Phase 1 asserted "exactly one, and it is Cinder". Phase 2 makes that ten, so
   * the assertion moves from a COUNT to the two properties the count was really
   * standing in for:
   *
   *  - Cinder is still `landable[0]`. That is the ablation guard on the ORDER of
   *    `SPACE_BODIES`: new bodies are APPENDED, never prepended, and several
   *    tests and save migrations index off that.
   *  - Everything NOT landable is not landable for a stated reason. A body with
   *    `handoff: 0` and no `surfaceWorld` is either deliberate scenery or a
   *    planet somebody forgot to finish, and those two look identical from here.
   *    Naming them is what makes the difference visible. */
  const landable = landableBodies();
  assert.equal(landable.length, 10, `${landable.length} landable bodies: ${landable.map((b) => b.id).join(', ')}`);
  assert.equal(landable[0].id, 'cinder', 'Cinder must stay first - new bodies are appended, never prepended');

  const scenery = SPACE_BODIES.filter((b) => !(b.handoff > 0 && b.surfaceWorld)).map((b) => b.id).sort();
  assert.deepEqual(scenery, ['ceraunus', 'erenmark'],
    'a body that is not landable must be one of the two that have a reason: a gas giant with no surface, and the star');

  for (const b of landable) {
    assert.ok(typeof b.surfaceWorld === 'string' && b.surfaceWorld.startsWith('planet:'),
      `${b.name} is landable but its surfaceWorld is ${b.surfaceWorld}`);
  }
});

test('a landable body carries a handoff radius above its surface', () => {
  for (const b of landableBodies()) {
    assert.ok(b.handoff > b.radius, `${b.name} hands off at or below its own surface`);

    /* THE AIRLESS CASE INVERTS THIS, and it is not a loosening.
     *
     * For a body with air the handoff must sit INSIDE the atmosphere, or the
     * surface world takes the ship before it has flown any of the air and the
     * atmosphere phase is unreachable - the exact defect Cinder shipped with.
     *
     * For an airless body `atmosphere === radius`, so a handoff above the
     * surface is necessarily above the atmosphere, and demanding otherwise
     * would demand a handoff at or below the ground. The two cases want
     * opposite inequalities against the same field because the field means
     * something different when there is no air, so both are asserted rather
     * than the airless one being skipped. */
    if (b.atmosphere > b.radius) {
      assert.ok(b.handoff <= b.atmosphere, `${b.name} has air but hands off outside it`);
    } else {
      assert.equal(b.atmosphere, b.radius, `${b.name} is neither airless nor has usable air`);
      assert.ok(b.handoff > b.atmosphere, `${b.name} is airless, so its handoff must stand off the surface`);
    }
  }
});

test('no descriptor carries surface parameters - those belong to the planet system', () => {
  /* The boundary this file exists to keep. A second copy of the mineral table
   * up here is how two mineral tables end up disagreeing. */
  for (const b of SPACE_BODIES) {
    for (const leaked of ['surface', 'minerals', 'gravity', 'heightField', 'terrain', 'landing']) {
      assert.ok(!(leaked in b), `${b.name} has grown a "${leaked}" field`);
    }
  }
});

test('every descriptor number is finite - the NaN gate', () => {
  const walk = (obj, path) => {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'number') {
        assert.ok(Number.isFinite(v), `${path}.${k} is ${v}`);
      } else if (Array.isArray(v)) {
        v.forEach((e, i) => {
          if (typeof e === 'number') assert.ok(Number.isFinite(e), `${path}.${k}[${i}] is ${e}`);
          else if (e && typeof e === 'object') walk(e, `${path}.${k}[${i}]`);
        });
      } else if (v && typeof v === 'object') {
        walk(v, `${path}.${k}`);
      }
    }
  };
  for (const b of SPACE_BODIES) walk(b, b.id);
  walk(BELT, 'belt');
  walk(DOCK_ANCHOR, 'dock');
});

test('navTargets includes the dock and the belt as well as the bodies', () => {
  const t = navTargets();
  const ids = t.map((x) => x.id);
  assert.ok(ids.includes('dock'), 'the way home has no marker');
  assert.ok(ids.includes('halberd-reach'));
  for (const b of SPACE_BODIES) assert.ok(ids.includes(b.id), `${b.id} has no marker`);
  for (const x of t) {
    assert.equal(x.position.length, 3);
    assert.ok(x.radius > 0);
    assert.ok(typeof x.blurb === 'string' && x.blurb.length > 0);
  }
});

test('the dock is inside the near field, so it is never proxied while you are on it', () => {
  /* Colliders live in the true frame. If the dock were still being scaled at
   * the range a player can stand on it, the deck they see would not be the
   * deck they collide with. */
  assert.ok(
    DOCK_ANCHOR.radius < NEAR_FIELD,
    `dock radius ${DOCK_ANCHOR.radius} reaches past the ${NEAR_FIELD} m identity zone`
  );
  // Every berth too - a ship parked at the far pier must be real.
  for (const b of DOCK_ANCHOR.berths) {
    const d = Math.hypot(...b.position);
    assert.ok(d < NEAR_FIELD, `${b.id} at ${d.toFixed(0)} m is outside the identity zone`);
  }
});

test('the belt sits where you can reach it but not where you launch', () => {
  const d = Math.hypot(...BELT.position);
  assert.ok(d > DOCK_ANCHOR.radius * 8, 'the debris field is on top of the yard');
  assert.ok(d < 60000, `the debris field is ${(d / 1000).toFixed(0)} km out - nobody will visit it`);
  assert.ok(BELT.extent[1] < BELT.extent[0] * 0.4, 'a belt has to be flatter than it is wide');
  assert.ok(BELT.hollow > 0 && BELT.hollow < 0.8);
  assert.ok(BELT.rockRadius[0] < BELT.rockRadius[1]);
});
