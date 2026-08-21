import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { rig, goto, settle, DT, steerTo, approach, fly, liftOff } from './_flightrig.mjs';

/**
 * YOU CAN ALWAYS GET BACK, AND THE UGLY CASES DO NOT STRAND YOU EITHER.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE TWO WAYS TO STRAND A PLAYER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The brief names them: *"A player who lands and cannot take off, or flies out
 * and cannot find the dock, is stranded. Prove both with a driven test."*
 *
 * Both are proved here by flying, and both are reported floor / achieved /
 * ceiling with the ceiling taken by ablation - because "12 of 12 got home" is
 * only worth reading next to "0 of 12 got home without the nav readout". A
 * reachability result with no ablation is how this project once shipped a
 * world with zero reachable wildlife and 29 green tests.
 *
 *   TAKE OFF   From every authored landing site on Cinder, including the one
 *              that is a 2% flood island reachable only by ship. Ablation:
 *              the same climb with the engines cut.
 *   GET HOME   From twelve bearings spread over the whole volume, flown using
 *              NOTHING BUT `navReport()` - the three dot products the HUD draws
 *              an arrow from. Not the target's coordinates: the readout. If a
 *              pilot can fly it, the readout is sufficient; if they cannot, the
 *              HUD is decoration. Ablation: the same twelve legs flown on a
 *              fixed heading.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  AND THE FOUR UGLY CASES THE BRIEF ASKS FOR BY NAME
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   dying while flying          -> the hull comes home, the body is handed back
 *   quitting mid-flight         -> a save/load round trip resumes in the seat
 *   changing world while piloting -> the ship is berthed, you arrive on foot
 *   landing somewhere illegal   -> set down on the nearest pad, hurt, mobile
 *
 * Every one of them ends with the same two assertions, because every one of
 * them has the same worst outcome: `movementOverride` left raised with nothing
 * writing the player's position, which is a player who cannot move at all and
 * cannot be told why.
 */

const { BODY_BY_ID, DOCK_ANCHOR } = await import('../../src/worlds/space/Bodies.js');
const { BERTHS } = await import('../../src/worlds/dock/YardPlan.js');
const { holdCapacity, SHIP_BASE_STATS } = await import('../../src/ships/ShipStats.js');
const PIL = await import('../../src/ships/Piloting.js');

const MOUTH = new THREE.Vector3(...DOCK_ANCHOR.mouth);

function atApron(r, id) {
  const b = BERTHS.find((x) => x.id === id);
  r.player.position.set(b.apron.x, b.cradleTop, b.apron.z);
  return b;
}

/** Put the mode back to a known state between cases without leaving it dirty. */
async function reset(r, world = 'dock') {
  if (r.piloting.active) r.piloting._recoverToBerth();
  r.piloting._recoverToBerth();
  /* The hold is NOT cleared by a recovery, and that is correct - ore stays in
   * the ship when a pilot dies or is moved. So a case that measures a payout
   * has to start from a known empty hold, or it inherits the last case's ore
   * and reports 442 credits for 430 credits of cargo. */
  r.piloting.sellCargo();
  /* Every hull's hold, not just the selected one: holds are per-hull now, so
   * `sellCargo` empties one of them and a case that loaded a Dray and then
   * boarded a Pike would leave ore behind for the next case to inherit. This
   * is a test-isolation reset and the only place in this file that reaches
   * past a public surface. */
  r.piloting._holds.clear();
  r.economy.credits = 0;
  await goto(r, world);
  r.player.damageTaken = 0;
  r.player.health = 100;
}

/* ====================================================================== */
/* 1. LANDED AND CANNOT TAKE OFF                                          */
/* ====================================================================== */

test('every landing site on Cinder can be lifted off from, and no engines means none can', async () => {
  const r = await rig();
  await reset(r, 'cinder');
  const world = r.wm.active;
  const sites = world.landingSites;
  assert.ok(sites.length >= 3, `only ${sites.length} landing sites - not much of a sample`);

  async function climbFrom(site, { engines }) {
    r.piloting._recoverToBerth();
    await goto(r, 'cinder');
    r.piloting.shipId = 'dray';
    r.piloting._parked = 'ground';
    r.piloting._parkedWorld = 'cinder';
    /* Set the ship down ON the pad, standing, exactly as a landing leaves it.
     * This is scenario set-up, not the thing under test: what is being measured
     * is whether the ship can LEAVE, and it leaves through the real integrator
     * from the real ground height at the real site. */
    r.piloting.flight.place(
      new THREE.Vector3(site.position.x, site.position.y + PIL.TOUCH_CLEAR * 0.5, site.position.z)
    );
    r.piloting._landed = true;
    r.player.position.copy(r.piloting.flight.position);
    assert.equal(r.piloting.board('dray'), true, `could not board at ${site.id}`);

    const f = r.piloting.flight;
    const start = f.position.y;
    const res = await fly(r,
      () => (engines
        ? liftOff(f, 260)
        : f.setCommand({ pitch: 0, yaw: 0, roll: 0, throttle: 0, vertical: 0, boost: false })),
      () => r.wm.active.id === 'space', { limit: 90 });
    return { ok: res.done, t: res.t, gained: f.position.y - start };
  }

  const flown = [];
  for (const s of sites) flown.push([s.id, await climbFrom(s, { engines: true })]);
  const ablated = [];
  for (const s of sites) ablated.push([s.id, await climbFrom(s, { engines: false })]);

  const got = flown.filter(([, v]) => v.ok).length;
  const ceil = ablated.filter(([, v]) => v.ok).length;
  console.log(`    take-off: floor ${sites.length}/${sites.length} | achieved ${got}/${sites.length} `
    + `| ablated (engines cut) ${ceil}/${sites.length} | `
    + flown.map(([id, v]) => `${id} ${v.ok ? `${v.t.toFixed(1)}s` : 'STRANDED'}`).join(' '));

  assert.equal(got, sites.length,
    `stranded at ${flown.filter(([, v]) => !v.ok).map(([id]) => id).join(', ')}`);
  assert.equal(ceil, 0, 'a ship with the engines cut still climbed to orbit, so this case measures nothing');
  await reset(r);
});

test('a landed ship stays landed until the pilot asks it to leave', async () => {
  const r = await rig();
  await reset(r, 'cinder');
  const site = r.wm.active.landingSites.find((s) => s.primary);
  r.piloting.shipId = 'dray';
  r.piloting._parked = 'ground';
  r.piloting._parkedWorld = 'cinder';
  r.piloting.flight.place(new THREE.Vector3(site.position.x, site.position.y + 0.7, site.position.z));
  r.piloting._landed = true;
  r.player.position.copy(r.piloting.flight.position);
  r.piloting.board('dray');

  const y0 = r.piloting.flight.position.y;
  let relanded = 0;
  const offLanded = r.bus.on('pilot:landed', () => { relanded++; });
  /* Sixty seconds of hands off, on a planet with 8.44 m/s2 of gravity. A landed
   * ship that is still being integrated sinks through its own pad. */
  for (let i = 0; i < 3600; i++) {
    r.piloting.flight.setCommand({ pitch: 0, yaw: 0, roll: 0, throttle: 0, vertical: 0 });
    r.piloting.fixedUpdate(DT, i * DT);
  }
  offLanded();
  assert.equal(r.piloting.landed, true, 'the ship took off on its own');
  assert.ok(Math.abs(r.piloting.flight.position.y - y0) < 1e-6,
    `a parked ship drifted ${(r.piloting.flight.position.y - y0).toFixed(3)} m in a minute`);
  assert.equal(r.piloting.flight.speed, 0);
  /* NOT JUST "it ended up in the same place".
   *
   * A ship that is still being integrated while landed sinks under gravity and
   * is then caught and re-seated by the ground probe on the very next step, so
   * its POSITION comes out identical after a minute and the drift assertion
   * above passes. What gives it away is the event stream: 3,600 touchdowns in
   * sixty seconds against the zero a parked ship should produce. */
  assert.equal(relanded, 0,
    `a parked ship reported ${relanded} touchdowns in a minute - it is sinking and being caught, `
    + 'not standing still');
  await reset(r);
});

/* ====================================================================== */
/* 2. FLEW OUT AND CANNOT FIND THE DOCK                                   */
/* ====================================================================== */

test('the yard can be flown home to from anywhere, on the nav readout alone', async () => {
  const r = await rig();
  await reset(r, 'space');

  /* Twelve bearings on a Fibonacci sphere - deliberately not the six axes, and
   * deliberately including the ones behind and below, because the yard's mouth
   * faces -Z and an approach from +Z has to come round the outside of a 285 m
   * structure. Ranges are stepped from 30 km to 250 km so the sample covers
   * both "just past the belt" and "further out than Ceraunus". */
  const LEGS = 12;
  const dirs = [];
  for (let i = 0; i < LEGS; i++) {
    const y = 1 - (i / (LEGS - 1)) * 2;
    const rad = Math.sqrt(Math.max(0, 1 - y * y));
    const th = Math.PI * (3 - Math.sqrt(5)) * i;
    dirs.push({
      dir: new THREE.Vector3(Math.cos(th) * rad, y, Math.sin(th) * rad).normalize(),
      range: 30000 + (i / (LEGS - 1)) * 220000,
    });
  }

  /**
   * Fly one leg using ONLY the published readout.
   *
   * `homeRow.ahead / above / right` are the three dot products `FlightHUD`
   * draws its arrow from. Nothing here reads `DOCK_ANCHOR.mouth` or the ship's
   * own coordinates, so a green result says the instrument is sufficient - not
   * that the test knows where the yard is.
   */
  async function leg(spec, { instrument }) {
    r.piloting._recoverToBerth();
    await goto(r, 'space');
    atApron(r, 'kestrel');
    r.piloting.board('kestrel');
    const f = r.piloting.flight;
    f.place(spec.dir.clone().multiplyScalar(spec.range).add(MOUTH));
    /* Point the nose somewhere arbitrary and unhelpful, so the leg starts with
     * a real turn rather than already aimed at home. */
    f.quaternion.setFromEuler(new THREE.Euler(0.3, spec.range * 0.001, 0.9, 'YXZ'));
    r.piloting._seamLock = 0;

    const res = await fly(r, () => {
      if (!instrument) { f.setCommand({ pitch: 0, yaw: 0, roll: 0, throttle: 1, boost: true }); return; }
      const rows = r.piloting.navReport();
      const home = rows.find((x) => x.id === 'dock');
      assert.ok(home, 'the nav readout does not carry the yard');
      const closing = home.range;
      const aligned = home.ahead > -0.42;
      /* Two regimes, and the split is where transit lives.
       *
       * Beyond 15 km the throttle stays pinned, because that is the condition
       * transit engages on - a controller that eased off at 240 m/s never got
       * transit at all and crawled the last 200 km at cruise, which is where
       * three of these twelve legs originally timed out at 400 s.
       *
       * Inside 15 km it is the ordinary speed budget: never faster than the
       * range allows a stop in, and under `PIL.DOCK_SPEED` at the end or
       * traffic control will not take the ship. */
      let throttle = 0;
      let boost = false;
      let brake = false;
      if (closing > 15000) {
        throttle = aligned ? 1 : 0;
        boost = home.ahead > 0.9;
      } else {
        const want = Math.max(18, Math.min(240, closing * 0.30));
        throttle = aligned && f.speed < want * 0.85 ? 1 : 0;
        brake = f.speed > want;
      }
      const g = 3.0;
      f.setCommand({
        pitch: Math.max(-1, Math.min(1, home.above * g)),
        yaw: Math.max(-1, Math.min(1, home.right * g)),
        roll: 0,
        throttle,
        boost,
        brake,
      });
    }, () => r.wm.active.id === 'dock', { limit: 400 });
    return res;
  }

  const flown = [];
  for (const s of dirs) flown.push(await leg(s, { instrument: true }));
  const blind = [];
  for (const s of dirs) blind.push(await leg(s, { instrument: false }));

  const got = flown.filter((x) => x.done).length;
  const ceil = blind.filter((x) => x.done).length;
  const worst = Math.max(...flown.filter((x) => x.done).map((x) => x.t));
  console.log(`    homing: floor ${LEGS}/${LEGS} | achieved ${got}/${LEGS} (worst leg ${worst.toFixed(1)} s) `
    + `| ablated (no readout, fixed heading) ${ceil}/${LEGS}`);

  assert.equal(got, LEGS, `${LEGS - got} legs never found the yard`);
  assert.equal(ceil, 0,
    'a ship flying a fixed heading found the yard anyway, so the readout is not what gets a pilot home '
    + 'and this case proves nothing');
  await reset(r);
});

test('the yard is the first row of the nav readout, unconditionally', async () => {
  const r = await rig();
  await reset(r, 'space');
  atApron(r, 'kestrel');
  r.piloting.board('kestrel');
  const f = r.piloting.flight;

  /* Sit right on top of a planet 250 km from home, where every sane ranking
   * would put the yard last, and assert it is still row one. This is the whole
   * anti-stranding guarantee expressed as one assertion. */
  for (const id of ['cinder', 'ceraunus', 'vitrine', 'tessera']) {
    const b = BODY_BY_ID[id];
    f.place(new THREE.Vector3(...b.position).add(new THREE.Vector3(0, b.radius * 1.4, 0)));
    const rows = r.piloting.navReport();
    assert.equal(rows[0].id, 'dock', `standing off ${id}, the readout's first row is ${rows[0].id}`);
    assert.ok(rows[0].range > 0 && Number.isFinite(rows[0].range));
    for (const k of ['ahead', 'above', 'right']) {
      assert.ok(Number.isFinite(rows[0][k]), `nav row is missing "${k}", which a pilot cannot fly without`);
    }
  }
  /* ...and the ranking underneath it is real, not a fixed list: the nearest
   * body after home has to be the one we are parked on. */
  const b = BODY_BY_ID.tessera;
  f.place(new THREE.Vector3(...b.position).add(new THREE.Vector3(0, b.radius * 1.4, 0)));
  assert.equal(r.piloting.navReport()[1].id, 'tessera');
  await reset(r);
});

/* ====================================================================== */
/* 3. LANDING SOMEWHERE ILLEGAL                                           */
/* ====================================================================== */

test('coming down too fast, off any pad, sets the ship down rather than losing it', async () => {
  const r = await rig();
  await reset(r, 'cinder');
  const world = r.wm.active;
  const sites = world.landingSites;

  /* Four points chosen for being nothing like a landing pad: the crater floor,
   * the flank, the rift and the far corner of the playfield. Each is flown
   * into the ground at full throttle from 200 m up. */
  /* Four spots, and the last one is a DIFFERENT test.
   *
   * The first three come down from 220 m and reach roughly 200 m/s, which a
   * naive point probe still catches - a fixed step at 200 m/s is 3.3 m and the
   * probe reaches 4 m below the keel. The fourth starts at 520 m, which is far
   * enough to reach the Pike's 390 m/s cap: 6.5 m per step, past the probe's
   * own reach, and a ship that is not tracked across the SEGMENT it travelled
   * goes straight through the caldera floor and out the bottom of the world.
   * That is a real defect this file found once already, at y -13,270. */
  const spots = [[0, 0, 220], [-240, 180, 220], [120, -300, 220], [330, 330, 520]];
  const outcomes = [];
  for (const [x, z, drop] of spots) {
    r.piloting._recoverToBerth();
    await goto(r, 'cinder');
    r.piloting.shipId = 'pike';
    r.piloting._parked = 'ground';
    r.piloting._parkedWorld = 'cinder';
    const g = r.physics.groundHeight(x, z, 400, 700) ?? 0;
    r.piloting._parked = null;
    /* Nose already straight down, then the throttle pinned. Holding a pitch
     * INPUT instead flies a loop - the ship comes over the top and climbs
     * again - which is a pilot doing aerobatics, not one arriving too fast. */
    r.piloting.flight.place(
      new THREE.Vector3(x, g + drop, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0, 'YXZ'))
    );
    r.player.position.copy(r.piloting.flight.position);
    r.piloting.board('pike');
    r.piloting._landed = false;
    r.piloting._airborne = true;
    r.player.damageTaken = 0;

    const f = r.piloting.flight;
    const res = await fly(r,
      () => f.setCommand({ pitch: 0, yaw: 0, roll: 0, throttle: 1, vertical: -1, boost: true }),
      () => r.piloting.landed || r.wm.active.id !== 'cinder', { limit: 40 });

    assert.ok(res.done, `flew into the ground at (${x}, ${z}) and nothing stopped it`);
    assert.equal(r.wm.active.id, 'cinder');
    assert.equal(r.piloting.landed, true);
    /* THE GUARANTEE: on a pad, hurt, and able to leave. Not "somewhere", not
     * "at the bottom of the fissure it hit" - a named site, because the
     * recovery has to put the player somewhere the loop can continue from. */
    assert.ok(r.piloting.landedSite, `hard landing at (${x}, ${z}) left the ship on open ground`);
    assert.ok(sites.some((s) => s.id === r.piloting.landedSite.id));
    assert.ok(r.player.damageTaken > 0, 'flying into a volcano at full throttle cost nothing');
    /* Levelled. A hull put down nose-first would fly straight back into the
     * dirt on the next take-off, which is a crash loop rather than a recovery. */
    const up = f.up(new THREE.Vector3());
    assert.ok(up.y > 0.999, `set down at ${THREE.MathUtils.radToDeg(Math.acos(up.y)).toFixed(1)} deg off level`);
    outcomes.push(`${r.piloting.landedSite.id}/${r.player.damageTaken}`);

    // ...and it can leave again immediately.
    const off = await fly(r, () => liftOff(f, 260),
      () => r.wm.active.id === 'space', { limit: 90 });
    assert.ok(off.done, `stranded after a hard landing at (${x}, ${z})`);
  }
  console.log(`    hard landings: ${outcomes.join(' ')} (site/damage)`);
  await reset(r);
});

test('flying flat out at the edge of the playfield is turned back, not lost', async () => {
  const r = await rig();
  await reset(r, 'cinder');
  const half = r.wm.active.planet.half;
  r.piloting.shipId = 'kestrel';
  r.piloting._parked = null;
  /* Low and fast, straight at the corner. Below `DEPART_ALT` and below the
   * 140 m the departure seam needs, so the only thing that can stop the ship
   * leaving the end of the heightfield is the boundary clamp. */
  /* ALL FOUR DIAGONALS. The clamp is four separate lines - one per face - and
   * a test that only ever flew at the -X-Z corner left the +X and +Z lines
   * unexercised: deleting either stayed green. */
  const worst = [];
  for (const yaw of [0.25, 0.75, 1.25, 1.75].map((q) => q * Math.PI)) {
    r.piloting._recoverToBerth();
    await goto(r, 'cinder');
    r.piloting.shipId = 'kestrel';
    r.piloting._parked = null;
    r.piloting.flight.place(
      new THREE.Vector3(0, 130, 0),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0, 'YXZ'))
    );
    r.player.position.copy(r.piloting.flight.position);
    r.piloting.board('kestrel');
    r.piloting._landed = false;
    r.piloting._airborne = true;
    const f = r.piloting.flight;

    let out = 0;
    await fly(r, () => f.setCommand({ pitch: 0, yaw: 0, roll: 0, throttle: 1, vertical: 0, boost: true }),
      () => {
        out = Math.max(out, Math.max(Math.abs(f.position.x), Math.abs(f.position.z)));
        return r.wm.active.id !== 'cinder';
      }, { limit: 60 });

    assert.equal(r.wm.active.id, 'cinder',
      `flying flat and level on heading ${(yaw / Math.PI).toFixed(2)}pi left the planet`);
    assert.ok(out < half + 70,
      `heading ${(yaw / Math.PI).toFixed(2)}pi reached ${out.toFixed(0)} m from the centre of an `
      + `${half} m playfield - the boundary does not hold on that face`);
    worst.push(Math.round(out));
  }
  console.log(`    boundary: ${half} m playfield, four headings held at ${worst.join(' / ')} m`);
  await reset(r);
});

test('the ground probe tracks the segment travelled, not the point arrived at', async () => {
  const r = await rig();
  await reset(r, 'cinder');
  const site = r.wm.active.landingSites.find((s) => s.primary);
  const g = site.position.y;
  r.piloting.shipId = 'kestrel';
  r.piloting._parked = null;
  r.piloting.flight.place(new THREE.Vector3(site.position.x, g + 30, site.position.z));
  r.player.position.copy(r.piloting.flight.position);
  r.piloting.board('kestrel');
  r.piloting._landed = false;
  r.piloting._airborne = true;
  r.player.damageTaken = 0;

  /* WHITE-BOX ON PURPOSE, AND IT COMPLEMENTS THE DIVE ABOVE RATHER THAN
   * REPLACING IT.
   *
   * The driven dive proves a fast arrival is caught in play. It cannot prove
   * the SWEEP is what caught it: at the Pike's 390 m/s a fixed step is 6.5 m
   * and the point probe still reaches 4 m below the keel, so whether the point
   * version happens to catch a given dive is a coin toss on where in the step
   * the surface fell. That is not a test, it is a lottery.
   *
   * So this stages the case the sweep exists for, exactly: one step that starts
   * clearly above the surface and ends clearly below it, further below than any
   * point probe reaches. A ship that is not tracked across the segment it
   * travelled sails through the caldera floor and out of the bottom of the
   * world - which this file has already found once, at y -13,270. */
  r.piloting._prevY = g + 30;
  r.piloting.flight.position.y = g - 20;
  r.piloting.flight.velocity.set(0, -300, 0);
  r.piloting._groundContact('cinder');

  assert.equal(r.piloting.landed, true,
    'a step that crossed 50 m of terrain was not noticed - the probe is a point again');
  assert.ok(r.player.damageTaken > 0, 'passing through the ground at 300 m/s cost nothing');
  assert.ok(r.piloting.flight.position.y > g - 1,
    `left at y ${r.piloting.flight.position.y.toFixed(1)}, under a surface at ${g.toFixed(1)}`);

  /* And the same step WITHOUT the crossing must be left alone, so the probe is
   * not simply always reporting contact. */
  r.piloting._recoverToBerth();
  await goto(r, 'cinder');
  r.piloting._parked = null;
  r.piloting.flight.place(new THREE.Vector3(site.position.x, g + 120, site.position.z));
  r.player.position.copy(r.piloting.flight.position);
  r.piloting.board('kestrel');
  r.piloting._landed = false;
  r.piloting._airborne = true;
  r.piloting._prevY = g + 160;
  r.piloting._groundContact('cinder');
  assert.equal(r.piloting.landed, false, 'a ship 120 m up was reported as having landed');
  await reset(r);
});

test('a ship cannot be abandoned in vacuum or at speed', async () => {
  const r = await rig();
  await reset(r, 'space');
  atApron(r, 'kestrel');
  r.piloting.board('kestrel');
  r.piloting.flight.place(new THREE.Vector3(0, 0, -40000));
  r.piloting._landed = false;

  assert.equal(r.piloting.disembark(), false, 'stepped out into vacuum');
  assert.equal(r.piloting.active, true);
  assert.equal(r.player.movementOverride, true);
  /* ...and the vacuum rule is its OWN rule, not a side effect of the ship
   * happening to be moving. A hull that believes it is standing on something
   * out in the volume - which is a state a bad save or a debug console can
   * produce - still may not be abandoned there. */
  r.piloting._landed = true;
  assert.equal(r.piloting.disembark(), false, 'a "landed" ship in vacuum could be walked away from');
  assert.equal(r.piloting.active, true);
  r.piloting._landed = false;

  await goto(r, 'cinder');
  r.piloting._landed = false;
  assert.equal(r.piloting.disembark(), false, 'stepped out of a moving ship');
  assert.equal(r.piloting.active, true);
  await reset(r);
});

/* ====================================================================== */
/* 4. DYING, QUITTING, AND BEING MOVED                                    */
/* ====================================================================== */

test('dying in the seat brings the hull home and hands the body back', async () => {
  const r = await rig();
  await reset(r, 'space');
  atApron(r, 'kestrel');
  r.piloting.board('kestrel');
  r.piloting.flight.place(new THREE.Vector3(9000, -4000, -52000));
  r.piloting._landed = false;

  r.bus.emit('player:died', { killerId: null });
  await settle();

  assert.equal(r.piloting.active, false, 'a corpse is still flying the ship');
  assert.equal(r.player.movementOverride, false, 'died in the seat and the body was never released');
  assert.equal(r.player._harnessFrozen, false, 'the camera is still detached after death');
  const b = BERTHS.find((x) => x.id === 'kestrel');
  assert.ok(r.piloting.flight.position.distanceTo(new THREE.Vector3(b.x, b.cradleTop, b.z)) < 0.01,
    'the hull was left wherever the pilot died');
  assert.equal(r.piloting.landed, true);
  await reset(r);
});

test('a world change nobody asked this mode for berths the ship instead of breaking', async () => {
  const r = await rig();
  await reset(r, 'space');
  atApron(r, 'kestrel');
  r.piloting.board('kestrel');
  r.piloting.flight.place(new THREE.Vector3(0, 0, -30000));
  r.piloting._landed = false;
  assert.equal(r.piloting.active, true);

  /* A portal, the debug console or a save load - anything that activates a
   * world a ship cannot be in. `MountManager` clears in this situation; this
   * mode has to put the ship somewhere findable and let the player walk. */
  await goto(r, 'station');
  assert.equal(r.piloting.active, false, 'still flying a ship inside the station');
  assert.equal(r.player.movementOverride, false);
  assert.equal(r.player._harnessFrozen, false);
  const b = BERTHS.find((x) => x.id === 'kestrel');
  assert.ok(r.piloting.flight.position.distanceTo(new THREE.Vector3(b.x, b.cradleTop, b.z)) < 0.01);

  /* ...and the reverse: a change to a world a ship CAN be in keeps the seat. */
  await reset(r, 'space');
  atApron(r, 'kestrel');
  r.piloting.board('kestrel');
  r.piloting.flight.place(new THREE.Vector3(0, 0, -30000));
  r.piloting._landed = false;
  await goto(r, 'cinder');
  assert.equal(r.piloting.active, true, 'moving between two flight worlds threw the pilot out');
  assert.equal(r.player.movementOverride, true, 'the world change released the body mid-flight');
  await reset(r);
});

/* ====================================================================== */
/* 5. STATE SURVIVES THE LOOP                                             */
/* ====================================================================== */

test('a save taken mid-flight resumes mid-flight, with the hold intact', async () => {
  const r = await rig();
  await reset(r, 'space');
  atApron(r, 'dray');
  r.piloting.board('dray');
  const f = r.piloting.flight;
  const pose = new THREE.Vector3(-14000, 900, -38000);
  f.place(pose, new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 1.4, -0.3, 'YXZ')));
  r.piloting._landed = false;
  r.piloting._parked = null;
  r.piloting.stow({ type: 'iridite', name: 'Iridite', credits: 240, size: 1.1 });
  r.piloting.stow({ type: 'sulfur', name: 'Sulfur Crust', credits: 26, size: 0.9 });
  const before = {
    world: r.wm.active.id,
    pos: f.position.clone(),
    quat: f.quaternion.clone(),
    units: r.piloting.cargoUnits,
    value: r.piloting.cargoValue,
  };
  const snap = JSON.parse(JSON.stringify(r.piloting.serialize()));
  assert.equal(snap.aboard, true);

  /* Wipe the mode as hard as a page reload does, then restore the way
   * `SaveGame._restoreProgress` does: world first, then deserialize. */
  /* Wipe every field the mode owns, the way a page reload does. A recovery is
   * NOT a wipe - the ore stays in the ship when a pilot dies - so the reset is
   * an explicit empty restore, and the assertion below proves the wipe took
   * before the real restore is measured against it. */
  r.piloting._recoverToBerth();
  await goto(r, 'dock');
  r.piloting.deserialize({ shipId: 'kestrel', aboard: false, parked: 'berth', parkedWorld: 'dock', cargo: {} });
  assert.equal(r.piloting.cargoUnits, 0, 'the wipe did not actually clear the hold');
  assert.equal(r.piloting.shipId, 'kestrel');

  await goto(r, before.world);
  r.piloting.deserialize(snap);
  await settle();

  assert.equal(r.piloting.active, true, 'quit mid-flight and came back on foot');
  assert.equal(r.piloting.shipId, 'dray');
  assert.ok(r.piloting.flight.position.distanceTo(before.pos) < 0.01,
    `resumed ${r.piloting.flight.position.distanceTo(before.pos).toFixed(1)} m from where the save was taken`);
  assert.ok(r.piloting.flight.quaternion.angleTo(before.quat) < 1e-4, 'resumed pointing somewhere else');
  assert.equal(r.piloting.cargoUnits, before.units, 'the ore did not survive the reload');
  assert.equal(r.piloting.cargoValue, before.value);
  assert.equal(r.player.movementOverride, true, 'resumed in the seat with the body not taken');
  await reset(r);
});

test('a save taken on a planet resumes on the planet, on foot, beside the ship', async () => {
  const r = await rig();
  await reset(r, 'cinder');
  const site = r.wm.active.landingSites.find((s) => s.primary);
  r.piloting.shipId = 'pike';
  r.piloting._parked = 'ground';
  r.piloting._parkedWorld = 'cinder';
  const where = new THREE.Vector3(site.position.x + 8, site.position.y + 0.7, site.position.z - 6);
  r.piloting.flight.place(where);
  r.piloting._landed = true;

  const snap = JSON.parse(JSON.stringify(r.piloting.serialize()));
  assert.equal(snap.aboard, false);
  assert.equal(snap.parked, 'ground');

  r.piloting._recoverToBerth();
  await goto(r, 'dock');
  await goto(r, 'cinder');
  r.piloting.deserialize(snap);

  assert.equal(r.piloting.active, false);
  assert.ok(r.piloting.flight.position.distanceTo(where) < 0.01, 'the ship was not where it was left');
  r.player.position.copy(where);
  assert.equal(r.piloting.boardableAt(), 'pike',
    'reloaded next to your own ship on a planet and it cannot be boarded - that is stranded');
  await reset(r);
});

test('a save that names a world the load could not reach leaves the player able to play', async () => {
  const r = await rig();
  await reset(r, 'dock');
  /* The failure mode this guards: a save taken in flight, restored into a world
   * the loader fell back to. The ship must not be boarded into the wrong place;
   * it must be at its berth, with the player on foot. */
  const snap = {
    shipId: 'kestrel', aboard: true, world: 'cinder', parked: 'berth', parkedWorld: 'dock',
    landed: false, pos: [-14000, 900, -38000], quat: [0, 0, 0, 1], cargo: {},
  };
  r.piloting.deserialize(snap);
  assert.equal(r.piloting.active, false, 'boarded a ship into a world the save did not come from');
  assert.equal(r.player.movementOverride, false);
  const b = BERTHS.find((x) => x.id === 'kestrel');
  assert.ok(r.piloting.flight.position.distanceTo(new THREE.Vector3(b.x, b.cradleTop, b.z)) < 0.01);
  assert.equal(r.piloting.boardableAt(new THREE.Vector3(b.apron.x, b.cradleTop, b.apron.z)), 'kestrel');
  await reset(r);
});

test('a worked-out seam stays worked out, and it is not the hold that says so', async () => {
  const r = await rig();
  await reset(r, 'cinder');
  atApron(r, 'dray');
  /* Board where the ship is - the point is the hold, not the boarding. */
  r.piloting._parked = 'berth';
  r.piloting.board('dray');
  const node = r.wm.active.mineralNodes.find((n) => !r.mining._taken.has(r.mining._key(n)));
  assert.ok(node, 'every node on the planet has already been taken by an earlier case');

  r.player.position.copy(node.position);
  const first = r.mining.mine(r.mining.nearest());
  assert.equal(first.ok, true);

  /* Empty the hold before trying again. With a full hold `stow` refuses and the
   * re-mine would be blocked for the wrong reason - which is exactly how a
   * missing `_taken` guard hid behind a capacity check. */
  r.piloting.sellCargo();
  assert.equal(r.piloting.cargoUnits, 0);
  const again = r.mining.mine(node);
  assert.equal(again.ok, false, 'a worked-out seam can be worked again');
  assert.equal(again.reason, 'already-taken',
    `refused for "${again.reason}" rather than because the seam is gone`);
  assert.equal(r.mining.nearest(), null, 'the prompt still offers a node that has been taken');
  await reset(r);
});

test('the hold is the hull, and a hull with no hold takes nothing', async () => {
  const r = await rig();
  await reset(r, 'dock');
  /* `SHIP_BASE_STATS.pike.hold` is 0, so the interceptor is a hull you cannot
   * mine with at all. That is a design choice and it has to be enforced rather
   * than merely declared, or the ore tender is pointless. */
  assert.equal(holdCapacity('pike', 0), 0);
  assert.ok(holdCapacity('dray', 0) > holdCapacity('kestrel', 0));

  atApron(r, 'pike');
  r.piloting.board('pike');
  assert.equal(r.piloting.cargoCapacity, 0);
  const res = r.piloting.stow({ type: 'tephra', name: 'Tephra', credits: 12, size: 0.8 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'hold-full');
  assert.equal(r.piloting.cargoUnits, 0);
  r.piloting.disembark({ force: true });

  atApron(r, 'dray');
  r.piloting.board('dray');
  assert.equal(r.piloting.cargoCapacity, holdCapacity('dray', 0));
  assert.equal(r.piloting.stow({ type: 'tephra', name: 'Tephra', credits: 12, size: 0.8 }).ok, true);
  assert.ok(r.piloting.cargoUnits > 0);

  /* A purchased hold tier has to reach the ship, or the upgrade is the dragon
   * bug again: banked, persisted, and applied to nothing. */
  const base = r.piloting.cargoCapacity;
  r.ships.grantPower('dray', 'hold', 2);
  assert.ok(r.piloting.cargoCapacity > base,
    'buying a hold tier did not change what the ship can carry');
  assert.equal(SHIP_BASE_STATS.pike.hold, 0);
  await reset(r);
});

test('selling the hold pays exactly what was in it, once', async () => {
  const r = await rig();
  await reset(r, 'dock');
  atApron(r, 'dray');
  r.piloting.board('dray');
  r.economy.credits = 0;
  r.piloting.stow({ type: 'iridite', name: 'Iridite', credits: 240, size: 1.1 });
  r.piloting.stow({ type: 'iridite', name: 'Iridite', credits: 190, size: 1.1 });
  assert.equal(r.piloting.cargoValue, 430);
  assert.equal(r.piloting.sellCargo(), 430);
  assert.equal(r.economy.credits, 430);
  assert.equal(r.piloting.cargoUnits, 0);
  assert.equal(r.piloting.sellCargo(), 0, 'an empty hold sold for something');
  assert.equal(r.economy.credits, 430);
  await reset(r);
});

test('a livery bought in the yard reaches the hull you fly', async () => {
  const r = await rig();
  await reset(r, 'dock');
  atApron(r, 'kestrel');
  r.piloting.board('kestrel');
  const model = r.piloting._models.get('kestrel');
  const hullMat = model.slotMats.hull[0];
  const before = hullMat.color.getHex();
  r.ships.setLivery('kestrel', { hull: { color: 0x22ff88 } });
  assert.notEqual(hullMat.color.getHex(), before,
    'the flown hull kept its factory paint - the customizer only repaints the one on the pier');
  assert.equal(hullMat.color.getHex(), 0x22ff88);
  /* ...and it did NOT repaint the parked one, which has its own clones. */
  const parked = r.wm.getWorld('dock').ships.find((s) => s.id === 'kestrel');
  assert.ok(parked, 'the yard stopped publishing its hulls');
  r.ships.resetLivery('kestrel');
  await reset(r);
});

test('ore stays in the hull that carried it, and a Pike is not paid for a Dray load', async () => {
  /* THE HOLD BELONGED TO THE SESSION, NOT TO THE HULL.
   *
   * `Piloting` kept one `_cargo` for the whole mode, so ore stowed in a Dray
   * was still aboard after you parked it and boarded a Pike - and
   * `SHIP_BASE_STATS.pike.hold` is 0. Driven against the real rig before the
   * fix:
   *
   *     dray: stowed 6 nodes -> 12/40 m3, 91 cr
   *     pike (hold 0) after boarding: 12/0 m3, 91 cr   <- ore across hulls
   *
   * `_dock()` calls `sellCargo()` unconditionally, so that 91 credits was paid
   * out by a hull that cannot carry anything. It made the customiser's `hold`
   * stat and the Pike's deliberate zero-hold design inert for any player who
   * boarded a Dray first, and park-and-swap at the piers is the intended verb
   * rather than an obscure path. `space-combat.test.mjs` documented the
   * behaviour verbatim and worked around it, which is the signal that it was
   * known and owned by nobody.
   *
   * Both directions are driven: the Pike must not SEE the Dray's ore, and the
   * Dray must still have it when you come back.
   */
  const r = await rig();
  await reset(r, 'dock');

  atApron(r, 'dray');
  r.piloting.board('dray');
  r.piloting.stow({ type: 'iridite', name: 'Iridite', credits: 240, size: 1.1 });
  r.piloting.stow({ type: 'sulfur', name: 'Sulfur', credits: 29, size: 0.6 });
  const drayUnits = r.piloting.cargoUnits;
  const drayValue = r.piloting.cargoValue;
  assert.ok(drayUnits > 0 && drayValue === 269, `the Dray did not load (${drayUnits} m3, ${drayValue} cr)`);
  r.piloting.disembark({ force: true, silent: true });

  atApron(r, 'pike');
  r.piloting.board('pike');
  assert.equal(r.piloting.cargoCapacity, 0, 'the Pike is meant to have no hold at all');
  assert.equal(r.piloting.cargoUnits, 0,
    `boarding a Pike inherited ${r.piloting.cargoUnits} m3 of somebody else's ore`);
  assert.equal(r.piloting.cargoValue, 0,
    `a hull with no hold is carrying ${r.piloting.cargoValue} credits of cargo`);
  r.economy.credits = 0;
  assert.equal(r.piloting.sellCargo(), 0, 'a Pike was paid for a Dray load');
  assert.equal(r.economy.credits, 0);
  r.piloting.disembark({ force: true, silent: true });

  /* And the other half: the ore is still in the Dray. A "fix" that simply
   * emptied the hold on disembark would pass every assertion above and lose
   * the player their cargo, which is worse than the bug. */
  atApron(r, 'dray');
  r.piloting.board('dray');
  assert.equal(r.piloting.cargoUnits, drayUnits, 'the Dray lost its load while it was parked');
  assert.equal(r.piloting.cargoValue, drayValue, 'the Dray lost the value of its load');
  r.economy.credits = 0;
  assert.equal(r.piloting.sellCargo(), drayValue);
  assert.equal(r.economy.credits, drayValue);
  await reset(r);
});

test('a save round-trips every hull\'s hold, not just the one in the seat', async () => {
  /* The persistence half of the same property. `serialize` used to write one
   * `cargo` object for the session; it writes `holds` now, and a save taken
   * with a loaded Dray parked and a Pike selected has to bring the Dray's ore
   * back. */
  const r = await rig();
  await reset(r, 'dock');
  atApron(r, 'dray');
  r.piloting.board('dray');
  r.piloting.stow({ type: 'obsidian', name: 'Obsidian', credits: 140, size: 1.0 });
  const value = r.piloting.cargoValue;
  r.piloting.disembark({ force: true, silent: true });
  atApron(r, 'pike');
  r.piloting.board('pike');
  const saved = JSON.parse(JSON.stringify(r.piloting.serialize()));
  r.piloting.disembark({ force: true, silent: true });

  /* Wipe every hold, then restore. */
  r.piloting._holds.clear();
  r.piloting.deserialize(saved);
  await settle();

  atApron(r, 'dray');
  if (!r.piloting.active) r.piloting.board('dray');
  else if (r.piloting.shipId !== 'dray') { r.piloting.disembark({ force: true, silent: true }); r.piloting.board('dray'); }
  assert.equal(r.piloting.cargoValue, value,
    `the Dray's ore did not survive a save taken while a different hull was selected`);
  await reset(r);
});

test('dying on a planet brings the pilot home, not just the hull', async () => {
  /* THE STRANDING THIS FILE'S OWN HEADER SAYS CANNOT HAPPEN.
   *
   * `_recoverToBerth` sends the HULL to the yard. `Player.respawn` then puts
   * the BODY at `_spawnPosition`, which is an anchor in the world the player
   * died in. On a planet that is a body standing on a volcano with no ship (it
   * is at a berth 600 km away), no portal (`PlanetWorld` publishes
   * `portalSpecs: []`), no "return" in the pause menu and no boarding prompt.
   *
   * Driven before the fix: world `cinder`, player on foot at
   * (330.4, 13.0, 354.8), hull at the berth (-68, 1.2, -143), 0 portals, no
   * escape - and it survived a save, because `serialize` wrote
   * `world: 'cinder'` with `parked: 'berth'`. It is reachable by a real player
   * path: `_forceSetDown` deals up to 55 hp and two hard landings inside the
   * health-regen window is a death.
   *
   * The fix is that the world change is part of the recovery. This drives the
   * real bus event on the real planet and asserts the player ends up somewhere
   * they can play from.
   */
  const r = await rig();
  await reset(r, 'cinder');
  assert.equal(r.wm.active.id, 'cinder');
  /* The premise, stated rather than assumed: there is genuinely no way off
   * this world on foot. If a planet ever grows a portal, this case should be
   * re-read rather than silently kept. */
  assert.equal((r.wm.active.portalSpecs ?? []).length, 0,
    'a planet has portals now - the stranding this case is about may no longer exist');

  atApron(r, 'kestrel');
  r.piloting.board('kestrel');
  r.piloting.flight.place(new THREE.Vector3(150, 60, 205));
  r.piloting._landed = false;

  r.bus.emit('player:died', { killerId: 'impact' });
  await settle(8);

  assert.equal(r.piloting.active, false, 'a corpse is still flying the ship');
  assert.equal(r.player.movementOverride, false, 'died in the seat and the body was never released');
  assert.equal(r.wm.active.id, 'dock',
    `the pilot was left in "${r.wm.active.id}" with the ship at a berth in "dock" - stranded`);
  /* And the ship is where the notification says it is, so the player can walk
   * to it and fly again. */
  const b = BERTHS.find((x) => x.id === 'kestrel');
  assert.ok(r.piloting.flight.position.distanceTo(new THREE.Vector3(b.x, b.cradleTop, b.z)) < 0.01,
    'the hull is not at its berth');
  assert.equal(r.piloting.boardableAt(new THREE.Vector3(b.apron.x, b.cradleTop, b.apron.z)), 'kestrel',
    'the recovered hull cannot be boarded from its own apron');
  await reset(r);
});

test('the docking sphere is wide enough to fly into and narrow enough not to catch a launch', async () => {
  /* `DOCK_RANGE` WAS ASSERTED ONLY BY THE TWELVE LEGS THAT ALREADY DOCKED.
   *
   * The mutation `260 -> 20` stayed green: every homeward leg flies straight
   * at the mouth and still crosses a 20 m sphere at some point, so "they all
   * docked" says nothing about whether a human could do it. What the number
   * has to buy is a WINDOW - enough steps inside the trigger that a pilot is
   * not required to be frame-perfect - and a ceiling, because a sphere that
   * reached the launch arrival point would re-dock a ship on the frame after
   * it left.
   *
   * Both are stated as the arithmetic they are, and both are driven.
   */
  const r = await rig();
  await reset(r, 'space');

  /* FLOOR. A ship on a straight run at the mouth at exactly `DOCK_SPEED`
   * covers `DOCK_SPEED * DT` = 1.5 m a step, so the sphere is inside the
   * trigger for `2 * DOCK_RANGE / 1.5` steps. One full second of window - 60
   * steps - is the floor; at a `DOCK_RANGE` of 20 it is 26 and a player has to
   * be lucky. */
  const window = (2 * PIL.DOCK_RANGE) / (PIL.DOCK_SPEED * DT);
  assert.ok(window >= 60,
    `floor: a ship arriving at ${PIL.DOCK_SPEED} m/s is inside the docking sphere for `
    + `${window.toFixed(0)} steps; under 60 the approach is frame-perfect`);

  /* CEILING. `SPACE_ARRIVAL_OUT` is where a launched ship appears, measured
   * along the mouth normal. If the docking sphere reached it, `_seams` would
   * dock the ship on the step after it launched and the two seams would
   * ping-pong - which `SEAM_COOLDOWN` masks rather than prevents. */
  assert.ok(PIL.DOCK_RANGE < PIL.SPACE_ARRIVAL_OUT,
    `ceiling: the docking sphere (${PIL.DOCK_RANGE} m) reaches the launch arrival `
    + `(${PIL.SPACE_ARRIVAL_OUT} m) - a launch re-docks itself`);
  /* And it has to clear the structure it is a trigger for, or the trigger is
   * inside the building. */
  assert.ok(PIL.SPACE_ARRIVAL_OUT > DOCK_ANCHOR.radius + PIL.DOCK_RANGE * 0.35,
    'the launch arrival is not clear of both the yard and its own docking sphere');

  /* DRIVEN. Fly the last 600 m at `DOCK_SPEED` and count the steps spent
   * inside the trigger before the seam fires. */
  atApron(r, 'kestrel');
  r.piloting.board('kestrel');
  const from = MOUTH.clone().add(new THREE.Vector3(0, 0, -600));
  const q = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().lookAt(from, MOUTH, new THREE.Vector3(0, 1, 0))
  );
  r.piloting.flight.place(from, q);
  r.piloting._landed = false;
  r.piloting._airborne = true;
  r.piloting._seamLock = 0;
  const fwd = r.piloting.flight.forward(new THREE.Vector3());
  let inside = 0;
  for (let i = 0; i < 900; i++) {
    if (r.piloting._travelling || !r.piloting.active) break;
    r.piloting.flight.velocity.copy(fwd).multiplyScalar(PIL.DOCK_SPEED - 2);
    r.piloting.fixedUpdate(DT, i * DT);
    if (r.piloting.flight.position.distanceTo(MOUTH) <= PIL.DOCK_RANGE) inside++;
    if ((i & 31) === 0) await null;
  }
  await settle(6);
  console.log(`  docking window: ${inside} steps inside the sphere `
    + `(arithmetic ${window.toFixed(0)}), world now "${r.wm.active.id}"`);
  assert.ok(inside >= 1, 'the ship never entered the docking sphere at all');
  assert.equal(r.wm.active.id, 'dock', 'a straight run at the mouth at docking speed did not dock');
  await reset(r);
});

test('a ship standing on a planet is solid, and stops being solid when it leaves', async () => {
  /* YOU COULD WALK THROUGH YOUR OWN SHIP.
   *
   * `ShipModel` routes every collider `ShipBuild` registers into a scratch
   * `Physics` and drops it, and that is right for a FLOWN hull: the boxes
   * would be baked at the origin of whatever world happened to be live and the
   * player would collide with an invisible ship at 0,0,0 forever after. It is
   * wrong for one standing on a pad. Driven before the fix: landed on Ashfall
   * Flat at (150, 9.5, 205), stepped out at (145.7, 8.79, 210.9), walked a
   * straight line THROUGH the hull centre to (161.5, 8.79, 189.2) in 5.9 s
   * with no obstruction and Y never changing; standing beside it put the
   * camera inside the Kestrel's belly plating.
   *
   * So the boxes are registered on touchdown and dropped on lift-off, and both
   * edges are driven here. Only on a SURFACE world: at a berth the yard's own
   * parked hull is the solid one, and in vacuum there is nothing to walk on.
   */
  const r = await rig();
  await reset(r, 'cinder');
  atApron(r, 'kestrel');
  r.piloting.board('kestrel');

  const site = r.wm.active.landingSites.find((s) => s.id === 'ashfall');
  assert.ok(site, 'Ashfall Flat is not published as a landing site');
  const pad = new THREE.Vector3(site.position.x, site.position.y + 0.7, site.position.z);
  r.piloting.flight.place(pad, new THREE.Quaternion());
  r.piloting.flight.halt();
  r.piloting._setLanded(true);
  r.piloting._parked = 'ground';
  r.piloting._parkedWorld = 'cinder';
  r.piloting.update(1 / 60, 0);

  const before = r.physics.colliders.length;
  assert.ok(r.piloting._hullColliders.length > 20,
    `only ${r.piloting._hullColliders.length} hull colliders registered for a landed ship`);

  /* THE WALK. A ray straight through the hull at chest height, from one side
   * to the other, must meet the ship. This is the exact traverse that went
   * through unobstructed. */
  const from = pad.clone().add(new THREE.Vector3(-14, 1.2, 0));
  const dir = new THREE.Vector3(1, 0, 0);
  const hit = r.physics.raycast(from, dir, 28);
  assert.ok(hit, 'a ray fired straight through a landed ship met nothing at all');
  console.log(`  landed hull: ${r.piloting._hullColliders.length} colliders, `
    + `first surface ${hit.distance.toFixed(2)} m across a 28 m traverse`);
  assert.ok(hit.distance < 14, `the first surface is at ${hit.distance.toFixed(2)} m - that is past the keel line`);

  /* AND THE CAPSULE. A raycast can clip a corner; the thing that matters is
   * that a BODY cannot stand in the middle of the hull. */
  const inside = pad.clone().add(new THREE.Vector3(0, 0.4, 0));
  const solved = inside.clone();
  r.physics.resolveCapsule(solved, 0.35, 1.75);
  const pushed = solved.distanceTo(inside);
  console.log(`  a capsule placed in the hull centre is pushed ${pushed.toFixed(2)} m`);
  assert.ok(pushed > 0.1, 'a body standing inside the landed hull was not pushed out of it');

  /* LIFT-OFF DROPS THEM. A ship that left its colliders behind is the exact
   * defect `ShipModel` refuses to register them for in the first place: an
   * invisible ship parked wherever it last was. */
  r.piloting.flight.setCommand({ pitch: 0, yaw: 0, roll: 0, throttle: 1, vertical: 1, boost: false, brake: false });
  for (let i = 0; i < 30; i++) r.piloting.fixedUpdate(DT, i * DT);
  r.piloting.update(1 / 60, 1);
  assert.equal(r.piloting.landed, false, 'the ship never left the pad');
  assert.equal(r.piloting._hullColliders.length, 0,
    'the hull flew away and left its colliders standing on the pad');
  assert.ok(r.physics.colliders.length < before,
    `the world still carries ${r.physics.colliders.length} colliders against ${before} with the ship down`);
  const after = r.physics.raycast(from, dir, 28);
  assert.equal(after, null, 'the ship left a ghost on the pad after take-off');
  await reset(r);
});

test('the cockpit tells the pilot how fast they are going DOWN', async () => {
  /* LANDING HAD NO MARGIN AND NO INSTRUMENT.
   *
   * `_groundContact` refuses a touchdown when `down > LAND_SPEED * 0.8` -
   * 20.8 m/s - and nothing on screen said so or showed the number. Holding the
   * descend key from 121 m over the pad reached 70 m/s down in 1.4 s: vertical
   * thrust is roughly 50 m/s^2 ON TOP of gravity and there is no flare or
   * hover hold, so a first attempt at "press descend" is a crash, and a crash
   * costs up to 55 hp and teleports the hull to the nearest pad. Two of them
   * inside the health-regen window is a death.
   *
   * It is landable by hand - a -11 / -5 / -2 m/s profile put a Kestrel down at
   * 4.08 m/s with no damage - so the instrument IS the fix. `report()` is what
   * the HUD draws, so `report()` is what is asserted.
   */
  const r = await rig();
  await reset(r, 'cinder');
  atApron(r, 'kestrel');
  r.piloting.board('kestrel');
  const site = r.wm.active.landingSites.find((s) => s.id === 'ashfall');
  r.piloting.flight.place(
    new THREE.Vector3(site.position.x, site.position.y + 120, site.position.z),
    new THREE.Quaternion()
  );
  r.piloting._landed = false;
  r.piloting._airborne = true;

  /* The limit has to BE the rule, not a second copy of it. */
  const out = r.piloting.report();
  assert.equal(out.descentLimit, PIL.LAND_SPEED * 0.8,
    'the readout warns at a different number from the one the seam enforces');

  r.piloting.flight.velocity.set(0, -34, 0);
  const falling = r.piloting.report();
  console.log(`  falling at ${falling.descent.toFixed(1)} m/s against a limit of ${falling.descentLimit}`);
  assert.ok(Math.abs(falling.descent - 34) < 0.01,
    `the readout says ${falling.descent.toFixed(2)} m/s for a 34 m/s descent`);
  assert.ok(falling.descent > falling.descentLimit,
    'floor: a 34 m/s descent must read as over the limit, or the warning never fires');

  /* Climbing is not a descent, and a ship going up must not show a rate at
   * all - a HUD that flashed red on take-off would be worse than none. */
  r.piloting.flight.velocity.set(0, 22, 0);
  assert.ok(r.piloting.report().descent < 0, 'a climb is being reported as a descent');

  /* And the number is the one the touchdown test uses: a hand-flown 4 m/s
   * arrival reads under the limit. */
  r.piloting.flight.velocity.set(0, -4.08, 0);
  const gentle = r.piloting.report();
  assert.ok(gentle.descent < gentle.descentLimit,
    'a 4.08 m/s arrival - which lands without damage - reads as over the limit');
  await reset(r);
});

test('the engines show the throttle, and a parked ship is not burning', async () => {
  /* NO PLUME, NO THROTTLE FEEDBACK, NO BOOST EFFECT.
   *
   * `_poseModel` wrote a position and a quaternion and nothing else:
   * `grep -rn "plume|exhaust|thrustGlow" src/ships/` came back empty and 200
   * frames at `throttle: 1` were pixel-identical at the nozzles to the parked
   * hull. Full burn, boost, airbrake and reverse all looked the same from the
   * seat, which is a large part of why the hull reads as machinery rather than
   * as a spacecraft.
   *
   * The nozzles are recorded by `Hulls.bell` as it draws them, so the exhaust
   * cannot drift from the engine it comes out of. Asserted on the model rather
   * than on a screenshot: scale along the bore and the shared material's
   * opacity are what a burn IS.
   */
  const r = await rig();
  await reset(r, 'space');
  atApron(r, 'kestrel');
  r.piloting.board('kestrel');
  r.piloting.flight.place(new THREE.Vector3(0, 0, -30000), new THREE.Quaternion());
  r.piloting._landed = false;
  r.piloting._airborne = true;

  const model = r.piloting._model;
  assert.ok(model?.plumeCount > 0, `the Kestrel has ${model?.plumeCount ?? 0} exhaust plumes`);
  const plume = model.group.getObjectByName('ship:kestrel:plume');
  assert.ok(plume, 'no plume mesh on the flown hull');

  const read = () => ({ z: plume.scale.z, a: plume.material.opacity });

  r.piloting.flight.setCommand({ pitch: 0, yaw: 0, roll: 0, throttle: 0, vertical: 0, boost: false, brake: false });
  r.piloting._poseModel();
  const idle = read();

  r.piloting.flight.setCommand({ pitch: 0, yaw: 0, roll: 0, throttle: 1, vertical: 0, boost: false, brake: false });
  r.piloting._poseModel();
  const full = read();

  r.piloting.flight.setCommand({ pitch: 0, yaw: 0, roll: 0, throttle: 1, vertical: 0, boost: true, brake: false });
  r.piloting._poseModel();
  const boost = read();

  console.log(`  plume length x${idle.z.toFixed(2)} idle, x${full.z.toFixed(2)} full, `
    + `x${boost.z.toFixed(2)} boost (opacity ${idle.a.toFixed(2)} / ${full.a.toFixed(2)} / ${boost.a.toFixed(2)})`);
  assert.ok(full.z > idle.z * 2, `floor: full throttle must be a visibly longer plume than idle`);
  assert.ok(boost.z > full.z, 'floor: boost must be visible on top of full throttle');
  assert.ok(full.a > idle.a, 'floor: the plume must brighten with the throttle');

  /* A LANDED SHIP IS COLD. A hull sitting on a cradle in a pressurised shed
   * with its engines lit is the same class of mistake as a plume that never
   * changes: the exhaust has to mean something. */
  r.piloting._landed = true;
  r.piloting.flight.setCommand({ pitch: 0, yaw: 0, roll: 0, throttle: 1, vertical: 0, boost: true, brake: false });
  r.piloting._poseModel();
  const parked = read();
  assert.ok(parked.z <= idle.z + 1e-6 && parked.a <= idle.a + 1e-6,
    `a landed ship is burning: length x${parked.z.toFixed(2)}, opacity ${parked.a.toFixed(2)}`);
  await reset(r);
});

test('a ship that lifts off is not standing in its own ground probe', async () => {
  /* THE INTERACTION BETWEEN THE TWO HALVES OF "A LANDED SHIP IS SOLID".
   *
   * Registering the hull's boxes on touchdown is right. Leaving them
   * registered for even one step after lift-off is a stranding, because
   * `_groundContact` asks `physics.groundHeight` what is under the ship and
   * the answer becomes THE SHIP. Measured on Ashfall Flat: the terrain is at
   * 8.79, the probe returned 14.65 with the hull registered, and a hull
   * hovering at 9.50 therefore read -2.9 m of clearance. All three landing
   * sites went from "lifts off" to STRANDED.
   *
   * So the flag and the colliders move together - `_setLanded(false)` rather
   * than `_landed = false` - and this is the case that says so, in the terms
   * the failure appeared in: what does the probe under the ship return?
   */
  const r = await rig();
  await reset(r, 'cinder');
  atApron(r, 'kestrel');
  r.piloting.board('kestrel');
  const site = r.wm.active.landingSites.find((s) => s.id === 'ashfall');
  const truth = r.wm.active.groundAt(site.position.x, site.position.z);
  r.piloting.flight.place(
    new THREE.Vector3(site.position.x, site.position.y + 0.7, site.position.z),
    new THREE.Quaternion()
  );
  r.piloting.flight.halt();
  r.piloting._setLanded(true);
  r.piloting._parked = 'ground';
  r.piloting._parkedWorld = 'cinder';
  r.piloting.update(1 / 60, 0);

  /* Standing on the pad, the hull IS in the world - that is the other half of
   * this feature, and without it the case below proves nothing. */
  assert.ok(r.piloting._hullColliders.length > 20, 'the landed hull registered nothing');
  const probeLanded = r.physics.groundHeight(site.position.x, site.position.z, site.position.y + 40, 300);
  assert.ok(probeLanded > truth + 1,
    `floor: with the hull down, a probe from above must find the SHIP (${probeLanded?.toFixed(2)}) `
    + `and not the terrain (${truth.toFixed(2)})`);

  /* Now lift off, and take ONE fixed step. */
  r.piloting.flight.setCommand({ pitch: 0, yaw: 0, roll: 0, throttle: 1, vertical: 1, boost: false, brake: false });
  r.piloting.fixedUpdate(DT, 0);
  assert.equal(r.piloting.landed, false, 'the ship did not leave the pad');
  assert.equal(r.piloting._hullColliders.length, 0,
    'the hull left the pad and its colliders stayed behind - the next ground probe will find them');
  const p = r.piloting.flight.position;
  const probeFlying = r.physics.groundHeight(p.x, p.z, p.y + 40, 300);
  console.log(`  ground under the pad: ${truth.toFixed(2)} terrain, ${probeLanded.toFixed(2)} with the hull down, `
    + `${probeFlying.toFixed(2)} one step after lift-off`);
  assert.ok(Math.abs(probeFlying - truth) < 0.5,
    `after lift-off the ground probe reads ${probeFlying?.toFixed(2)} against a terrain height of `
    + `${truth.toFixed(2)} - the ship is standing in its own way`);

  /* AND IT ACTUALLY CLIMBS. The failure this guards was not "a wrong number",
   * it was three landing sites reporting STRANDED.
   *
   * Flown with `liftOff`, which is the profile the whole file uses and the one
   * the flight model is built for: vertical thrust to unstick, then nose up on
   * the main engine. Pure vertical thrust does NOT climb on Cinder -
   * `FLIGHT.verticalFrac` is 0.50 and the planet pulls 8.44 - and a case that
   * demanded it would be testing a manoeuvre the game does not have. */
  const pad = site.position.y + 0.7;
  for (let i = 1; i < 200; i++) {
    liftOff(r.piloting.flight, pad + 40);
    r.piloting.fixedUpdate(DT, i * DT);
  }
  const climbed = r.piloting.flight.position.y - pad;
  console.log(`  climbed ${climbed.toFixed(1)} m in ${(199 * DT).toFixed(1)} s`);
  assert.ok(climbed > 20, `floor: the ship climbed ${climbed.toFixed(1)} m in ${(199 * DT).toFixed(1)} s of lift-off`);

  /* THE OTHER WAY A LANDED HULL STOPS BEING LANDED, and it has the same
   * hazard. `Flight.place` is a public verb that moves a ship without telling
   * this class, so `fixedUpdate` corroborates "landed" against WHERE - and
   * that branch has to drop the colliders too, or a ship teleported off its
   * pad leaves a solid ghost of itself standing on it. */
  r.piloting.flight.place(
    new THREE.Vector3(site.position.x, site.position.y + 0.7, site.position.z),
    new THREE.Quaternion()
  );
  r.piloting.flight.halt();
  r.piloting._setLanded(true);
  r.piloting.update(1 / 60, 0);
  assert.ok(r.piloting._hullColliders.length > 20, 'the hull did not become solid again');
  r.piloting.flight.place(
    new THREE.Vector3(site.position.x + 40, site.position.y + 30, site.position.z + 40),
    new THREE.Quaternion()
  );
  r.piloting.flight.setCommand({ pitch: 0, yaw: 0, roll: 0, throttle: 0, vertical: 0, boost: false, brake: false });
  r.piloting.fixedUpdate(DT, 0);
  assert.equal(r.piloting.landed, false, 'a hull that was teleported off its pad still believes it is on it');
  assert.equal(r.piloting._hullColliders.length, 0,
    'a hull teleported off its pad left a solid ghost of itself standing on it');
  const ghost = r.physics.groundHeight(site.position.x, site.position.z, site.position.y + 40, 300);
  assert.ok(Math.abs(ghost - truth) < 0.5,
    `the pad still reads ${ghost?.toFixed(2)} against a terrain height of ${truth.toFixed(2)}`);
  await reset(r);
});

test('a hull driven under the surface is set down, not lost inside the planet', async () => {
  /* FOUND BY FLYING IT, AND NOT BY ANY TEST.
   *
   * `_groundContact` returns early while `!_airborne`, and `_airborne` only
   * came back when the hull climbed `TOUCH_CLEAR * 2.4` CLEAR of the ground.
   * Go the other way - lift off and immediately push the nose down - and the
   * hull sinks through the heightfield with the landing check switched off,
   * clearance now negative and unable ever to exceed 3.36 again.
   *
   * Driven in a browser: a hand-flown approach to Ashfall Flat touched down,
   * the autopilot tapped climb once to arrest a 4 m/s sink and then held
   * descend, and the Kestrel went through the surface at y 8.8 and kept going
   * - -48 m, then -176 m, then -447 m - with the ground probe returning `null`
   * because its ray now started below the terrain. It IS recoverable: holding
   * climb for ten seconds through solid rock crossed `DEPART_ALT` and popped
   * the ship out in space. That is not a recovery a player will find.
   */
  const r = await rig();
  await reset(r, 'cinder');
  atApron(r, 'kestrel');
  r.piloting.board('kestrel');
  const site = r.wm.active.landingSites.find((s) => s.id === 'ashfall');
  const ground = r.wm.active.groundAt(site.position.x, site.position.z);

  /* Exactly the state the browser was in: just off the pad (so `_airborne` is
   * false), and commanded down. */
  r.piloting.flight.place(
    new THREE.Vector3(site.position.x, ground + 1.0, site.position.z),
    new THREE.Quaternion()
  );
  r.piloting.flight.halt();
  r.piloting._setLanded(false);
  r.piloting._airborne = false;
  r.piloting._prevY = null;
  const log = [];
  for (let i = 0; i < 240; i++) {
    r.piloting.flight.setCommand({ pitch: 0, yaw: 0, roll: 0, throttle: 0, vertical: -1, boost: false, brake: false });
    r.piloting.fixedUpdate(DT, i * DT);
    if (i % 60 === 0) log.push(`t${(i * DT).toFixed(1)} y ${r.piloting.flight.position.y.toFixed(1)}`);
    if (r.piloting.landed) break;
  }
  const y = r.piloting.flight.position.y;
  console.log(`  terrain ${ground.toFixed(1)}; ${log.join(', ')}; ended y ${y.toFixed(1)}, landed ${r.piloting.landed}`);
  assert.ok(y > ground - 8,
    `the hull is ${(ground - y).toFixed(0)} m inside the planet - it was never caught`);
  assert.equal(r.piloting.landed, true, 'the hull was driven under the surface and never set down');
  /* On a pad, because that is what `_forceSetDown` is for, and hurt, because
   * flying into a planet is an impact. */
  assert.ok(r.piloting._landedSite, 'set down on open ground rather than on a pad');
  assert.ok(r.player.damageTaken > 0, 'flying into the planet cost the pilot nothing');

  /* AND IT DOES NOT FIRE IN THE YARD, which is why the rule asks the HEIGHT
   * FIELD rather than the ground probe.
   *
   * Measured: a boarded Kestrel on its cradle sits at y 1.20 and the probe
   * under it returns 4.12 - the bolsters - so its clearance is -2.92, which is
   * 0.44 m from the -3.36 a clearance test would fire at. That is not a
   * margin. The yard has no heightfield at all (`heightfields.length` is 0,
   * `terrainHeight` returns null), so `_underTerrain` is structurally false
   * there however the cradles are later re-cut. Both facts are asserted,
   * because the second is the one that makes the first safe. */
  await reset(r, 'dock');
  atApron(r, 'kestrel');
  r.piloting.board('kestrel');
  assert.equal(r.physics.heightfields.length, 0, 'the yard has grown a height field - re-read this case');
  const kp = r.piloting.flight.position;
  const under = r.physics.groundHeight(kp.x, kp.z, kp.y + 4, 64);
  console.log(`  yard: hull at ${kp.y.toFixed(2)}, probe ${under?.toFixed(2)}, `
    + `clearance ${(kp.y - under).toFixed(2)}, terrainHeight ${r.physics.terrainHeight(kp.x, kp.z)}`);
  assert.ok(under - kp.y > 1,
    'a berthed hull no longer reads negative clearance - the hazard this guards may be gone');
  /* AND THE MARGIN, which is the whole argument for not using a clearance test.
   * A clearance rule would fire at -3.36 and the cradle reads -2.92: 0.44 m.
   * If that ever closes, a clearance-based rescue would set every berthed ship
   * down on every step - so the number is pinned here rather than trusted.
   * Note that this cannot be MUTATION-KILLED today: at 0.44 m of margin the
   * two implementations behave identically on the shipped geometry, and the
   * height-field form is chosen because it cannot be closed by a change to the
   * bolsters at all. */
  assert.ok((under - kp.y) < 4.0,
    `the cradle now stands ${(under - kp.y).toFixed(2)} m over the keel; a clearance-based rescue `
    + 'would fire at 3.36 and this case would stop describing the hazard');
  assert.equal(r.piloting._underTerrain(kp), false, 'a cradle is being read as a planet surface');
  r.piloting._setLanded(false);
  r.piloting._airborne = false;
  r.piloting._prevY = null;
  const before = r.player.damageTaken;
  for (let i = 0; i < 30; i++) {
    r.piloting.flight.setCommand({ pitch: 0, yaw: 0, roll: 0, throttle: 1, vertical: 1, boost: false, brake: false });
    r.piloting.fixedUpdate(DT, i * DT);
  }
  assert.equal(r.player.damageTaken, before,
    'lifting a hull off its cradle in the yard was treated as flying into the ground');
  await reset(r);
});
