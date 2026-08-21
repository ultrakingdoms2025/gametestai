import * as THREE from 'three';

const damp = THREE.MathUtils.damp;
const clamp = THREE.MathUtils.clamp;

/**
 * SIX-DEGREE ARCADE FLIGHT, WITH ASSIST.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The owner asked for "arcade six-degree with assist": full pitch, yaw, roll
 * and thrust, with enough help that the ship never tumbles and always ends up
 * going where the nose is pointed. That is a specific and slightly unusual
 * machine, so here is what each half means and where it lives:
 *
 *   SIX DEGREE   Three rotational axes, driven by mouse (pitch, yaw) and the
 *                strafe keys (roll). Three translational: main/reverse thrust
 *                along the nose, vertical thrust on Space/C, and a lateral
 *                axis that exists in the command struct and is deliberately
 *                left off the keyboard (see `readInput`).
 *
 *   ASSIST       Four separate mechanisms, none of which is "clamp it and
 *                hope". They are listed here because "the assist" is the
 *                single most load-bearing word in the brief and a reader
 *                needs to know which one to reach for:
 *
 *                  1. ANGULAR RESPONSE (`angResponse`) - the body rate chases
 *                     a target rate through an exponential damper, so asking
 *                     for nothing damps to nothing. Rotation stops when you
 *                     stop asking. There is no free spin state to get into.
 *                  2. THE TUMBLE CAP (`omegaCap`) - a hard clamp on the
 *                     MAGNITUDE of the body rate, after the per-axis targets
 *                     are summed. Pitch, yaw and roll all pinned at once
 *                     wants 3.112 rad/s; it gets 2.80. This is the one that
 *                     makes "from any input sequence" true rather than
 *                     probable.
 *                  3. VELOCITY ALIGNMENT (`alignBase`/`alignThrust`) - the
 *                     velocity VECTOR is rotated toward the nose, magnitude
 *                     preserved. Pointing and going become the same verb, and
 *                     a hard turn costs nothing, which is the whole difference
 *                     between arcade and Newtonian.
 *                  4. AUTHORITY FALLOFF (`authorityFalloff`) - turn rate drops
 *                     to 60% at cruise top. This is an assist in the sense
 *                     that matters: it is what stops a boosted ship from
 *                     pivoting like a stationary one, which reads as floaty.
 *
 * There is no renderer, no scene graph and no `Input` import here. The class
 * takes a command struct; `readInput` is the ONE method that knows what a
 * keyboard is, and it takes the input object as an argument rather than
 * importing it. So the integrator runs headless, and every number in this
 * file was measured by running it (`scripts/tests/ship-flight.test.mjs`).
 *
 * ── Cost, measured in Chrome rather than assumed ──────────────────────────
 * 0.199 us per fixed step including a `cameraRig` read, over 600,000 steps of
 * a fully-loaded command (throttle, pitch, roll, vertical thrust and boost all
 * live). That is 0.0012% of a 16.7 ms frame. Heap delta over 400,000 calls of
 * `step`, of `cameraRig(75, out)` and of `cameraRig(75)` was 0 bytes against a
 * control that deliberately allocates one Vector3 per call and reads 4.0 - so
 * the module-level scratch below is doing its job and the house rule about
 * frame handlers is kept in fact and not only in intent.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE TWO ARITHMETIC LESSONS `Ship.js` LEFT FOR THIS FILE, AND HOW EACH IS PAID
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Ship.js:33-42` records both, from the mount work, and both are load-bearing
 * here:
 *
 *  1. "A SPEED TIER WIDENS THE TURNING RADIUS unless the falloff curve divides
 *     by the TIERED top speed *and* the turn rate, cap and gain are all
 *     multiplied by `powerMul`." Measured on the mounts before the fix: eagle
 *     29.5 -> 44.8 m (x1.52), hoverboard 11.6 -> 19.1 m (x1.65).
 *
 *     PAID: every rate in `_stepAngular` is multiplied by `pm`, the falloff
 *     divides by `cruiseTop * pm`, and `omegaCap` is multiplied by `pm` too.
 *     The result is that turning radius is INVARIANT across power tiers. Flown
 *     for real - accelerate to cruise top, hold full pitch for six seconds,
 *     then measure the quaternion sweep over one second - all twelve (hull,
 *     tier) pairs circle at 148.02 to 148.11 m, a spread of 0.09 m over a
 *     x1.90 range of power multipliers (Dray stock 1.25 to Kestrel tier 3
 *     2.38). The 0.09 m is integrator noise, not tier drift: the analytic
 *     spread is 0.000 m.
 *
 *     `ship-flight.test.mjs` asserts that grid and then ABLATES each of the
 *     three multipliers, because an invariance that holds for a reason nobody
 *     checked is a coincidence. Dropping `pm` off the turn rate takes the
 *     Kestrel from 148.15 to 259.26 m (x1.75, the whole tier). Using the
 *     UNTIERED 120 in the falloff denominator is the subtle one - it looks
 *     harmless at cruise top, where every ship clamps to the same 0.6
 *     authority and the radius is unchanged - and it opens a 14.8 m spread at
 *     half throttle-speed, which is where players actually corner.
 *
 *  2. "On a drag-limited craft, ACCELERATION LEAKS INTO TOP SPEED unless the
 *     NET is scaled: `speed += (thrust - drag) * accelMul * dt`, never
 *     `thrust * accelMul`."
 *
 *     PAID: `_stepLinear` builds the whole acceleration - engine minus drag -
 *     and multiplies the SUM by `_accelMul` on one line, which is commented at
 *     the site. Gravity is added afterwards and is deliberately outside that
 *     multiply, because gravity is not the engine. The fixed point is then
 *     `thrust * powerMul / drag`, with `accelMul` cancelled out of it
 *     algebraically. Measured: moving the multiply inside takes a stock
 *     Kestrel's cruise top from 210.0 to 367.5 m/s (x1.75).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  TWO CEILINGS, ON PURPOSE, AND WHY NEITHER SNAPS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Cruise top speed is DRAG-GOVERNED: `thrust / drag` = 78 / 0.65 = 120 m/s at
 * `powerMul` 1. Boost top speed is CAP-GOVERNED: boost multiplies thrust by
 * 2.6, which would settle at 312 m/s, and the hard cap stops it at 260.
 *
 * That split is not an accident of tuning, it is the fix for a snap. The first
 * arrangement had a cruise cap of 150 and a boost cap of 240, so releasing
 * boost at 240 m/s teleported the ship to 150 in one frame - a 90 m/s step
 * with no deceleration and no sound to hang on it. With ONE cap that does not
 * move, releasing boost leaves drag to bring 260 back to 120 over 6.20 s,
 * which is a settle you can feel and the reason boost has a shape.
 *
 * The whole boost, measured at `powerMul` 1: 120 m/s cruise, 1.93 s to 99% of
 * the 260 cap, pinned at 260 for the rest of a 3.35 s tank, then 6.20 s of
 * drag settling back to within 2% of cruise. A x2.17 speed swing you enter and
 * leave over ten seconds, which is what "it must feel different at different
 * speeds" has to mean if it is going to mean anything.
 *
 * It also means both mechanisms are real and both are testable: the drag fixed
 * point governs cruise (so lesson 2 has teeth) and the cap governs boost (so
 * "a hard speed cap" is a thing that actually binds), rather than one of them
 * being decoration.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE THIRD CEILING: THE TRANSIT DRIVE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Cruise and boost are both about a FIGHT: 120 to 260 m/s is the band in which
 * a turning radius and a boost budget mean something. They are the wrong tool
 * for a solar system, and the arithmetic says so out loud.
 *
 * `worlds/space/Bodies.js` puts Cinder 62 km from the dock and admits, in its
 * own docblock, that the layout was pinned to an ASSUMED envelope of "cruise
 * 260 m/s, boost 1600 m/s" and should be re-derived "when the flight model
 * lands". The flight model landed at 120-285 m/s sustained. 62 km at 120 m/s
 * is 517 seconds - eight and a half minutes of holding one key in a straight
 * line - and Phase 2 puts nine more bodies out to ~300 km, where the same
 * arithmetic gives forty minutes. The layout cannot be shrunk to fix it: the
 * radii and distances were chosen so that the sky reads with depth (see the
 * `screen fraction` table in `Bodies.js`) and collapsing them turns a solar
 * system into a diorama.
 *
 * So there is a third ceiling, and it is a SEPARATE DRIVE rather than a bigger
 * boost. Five things make it a mode instead of a number:
 *
 *   1. IT IS TOGGLED, not held, and it SPOOLS. `transitSpoolUp` seconds in and
 *      `transitSpoolDown` out, with the FOV, the chase distance and the drive
 *      note all riding the same 0..1 `transitSpool`. Engaging is an event you
 *      hear and see, not a number that changes.
 *
 *   2. ITS SPEED IS GOVERNED BY ALTITUDE, and that one rule replaces every
 *      separate drop-out rule a supercruise usually needs:
 *
 *          maxTransitSpeed = clamp(altitude * transitK, cruiseTop, transitTop)
 *
 *      A ship 50 km above a surface may do 5,000 m/s; a ship 2 km up may do
 *      360; a ship at Cinder's handoff radius (900 m up) is held to its own
 *      cruise top and cannot exceed it. The consequences are all free:
 *      closing on a planet DECELERATES you automatically, you cannot overshoot
 *      into a world at 5 km/s, and by the time `approachState()` is calling it
 *      an approach you are already flying at a speed you can land from. The
 *      deceleration is real and it is `dv/dt = -transitK * v`: at 5,000 m/s
 *      that is 900 m/s² of braking that nobody had to write.
 *
 *   3. IT IS CAP-GOVERNED, NOT DRAG-GOVERNED, and that is `Ship.js` lesson 2
 *      paid a second way. Drag is suppressed in proportion to the spool, and
 *      the drive pushes along the velocity until the altitude cap stops it -
 *      so `accelMul` changes how fast a hull REACHES transit speed and has no
 *      effect at all on what that speed is. Every hull crosses the volume in
 *      the same time, which is deliberate: a slow hull must not lock a player
 *      out of a planet.
 *
 *   4. STEERING IS THE SAME ASSIST, TURNED DOWN. `transitFalloff` multiplies
 *      the SAME `gain` that `authorityFalloff` builds in `_stepAngular` -
 *      there is no second steering mechanism and no separate clamp. At
 *      5,000 m/s full authority would make a mouse twitch a 90-degree course
 *      change; 30% of it is a supercruise you can hold a bearing in.
 *
 *   5. IT DOES NOT KNOW WHAT A PLANET IS. This file has no `Bodies.js` import
 *      and is not getting one. The altitude and the mass lock arrive through
 *      `env.transitAltitude` and `env.transitLock`, filled by `Piloting`,
 *      which is the class that already owns `approachState`. `engageTransit`
 *      is therefore a dumb latch: it is `Piloting._pollTransit` that refuses,
 *      and refuses out loud.
 *
 * -- Where the two numbers came from -----------------------------------------
 *
 * `transitTop` 5,000 m/s and `transitK` 0.20 1/s were solved against the real
 * layout and then MEASURED by flying it; the arithmetic is written out at the
 * constants and the flown times are in `scripts/tests/ship-transit.test.mjs`.
 */

/* ══════════════════════════════════════════════════════════════════════════
 *  BODY AXES. Read this before touching a sign.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Local frame is three.js' object convention: +X starboard, +Y up, -Z NOSE.
 * The camera uses the same one, so a ship quaternion can be handed straight to
 * a camera without a correction quaternion, and `forward` below is `(0,0,-1)`
 * rather than a number someone has to remember.
 *
 * The command struct is in PILOT terms, which do not line up with the axis
 * signs, and that mismatch is where a sign bug would live. Written out once:
 *
 *   cmd.pitch > 0  nose UP     = +rotation about +X   (+Y tips toward +Z, so
 *                                                      the nose at -Z rises)
 *   cmd.yaw   > 0  nose RIGHT  = -rotation about +Y   (+rotation about +Y
 *                                                      takes -Z toward -X,
 *                                                      which is nose LEFT)
 *   cmd.roll  > 0  roll RIGHT  = -rotation about +Z   (+rotation about +Z
 *                                                      takes +X toward +Y,
 *                                                      i.e. starboard wing up,
 *                                                      which is a LEFT roll)
 *
 * so the body angular velocity vector is `(pitch, -yaw, -roll)`. All three
 * signs are pinned by cases in `ship-flight.test.mjs`, because two of the
 * three are inverted from the naive reading and a flipped one is the kind of
 * bug that survives a whole playtest as "the controls feel wrong".
 */

/**
 * Every tunable, in one frozen table.
 *
 * Rates are rad/s, accelerations m/s², speeds m/s, damper lambdas 1/s. Each
 * number is either derived (the derivation is written next to it) or measured
 * by driving this integrator - there are no numbers here that were picked
 * because they looked about right.
 */
export const FLIGHT = Object.freeze({
  /* ── Rotation ────────────────────────────────────────────────────────── */
  /** Nose up/down, rad/s at `powerMul` 1. 77.3 deg/s. */
  pitchRate: 1.35,
  /** Nose left/right. Deliberately the SLOWEST axis: a ship that yaws as fast
   *  as it roll-and-pulls has no reason to ever roll, and roll is the verb
   *  that makes a spaceship read as a spaceship. 60.2 deg/s. */
  yawRate: 1.05,
  /** Roll. The fastest axis by a factor of ~2. 149.0 deg/s. */
  rollRate: 2.60,
  /** Exponential lambda the body rate chases its target through. 3/11 = 0.273 s
   *  to 95% of a commanded rate; measured 0.283 s at dt 1/60. */
  angResponse: 11,
  /** ASSIST 2, the anti-tumble clamp: hard ceiling on |omega|, times powerMul.
   *  Pitch+yaw+roll all pinned wants hypot(1.35, 1.05, 2.60) = 3.112 rad/s. */
  omegaCap: 2.80,
  /** ASSIST 4: turn authority lost by cruise top. 1 -> 0.60. */
  authorityFalloff: 0.40,

  /* ── Translation ─────────────────────────────────────────────────────── */
  /** Main engine, m/s² at `powerMul` 1. */
  thrust: 78,
  /** Reverse is a retro-thruster, not the main bell. */
  reverseFrac: 0.45,
  /** Vertical (Space/C) and lateral, as a fraction of main thrust. */
  verticalFrac: 0.50,
  lateralFrac: 0.50,
  /** Linear drag, 1/s. `thrust / drag` = 120 m/s IS the cruise top speed. */
  drag: 0.65,
  /** Airbrake, added to drag while held. 0.65 -> 3.25, a 5x deceleration. */
  brakeDrag: 2.60,
  /** Below this, a braking ship is set to a dead stop rather than left to
   *  crawl down an exponential forever. Docking needs a real zero. */
  brakeStop: 0.05,
  /** Boost multiplies THRUST, not speed - so it has a build-up. Settles at
   *  312 m/s, which the cap below stops first. */
  boostThrustMul: 2.60,
  /** The one hard speed cap, times powerMul. Governs boost; never binds at
   *  cruise (120 < 260), which is why releasing boost does not snap. */
  hardCap: 260,

  /* ── Boost budget ────────────────────────────────────────────────────── */
  boostEnergy: 100,
  /** 100/30 = 3.33 s of boost from full. */
  boostDrain: 30,
  boostRegen: 20,
  /** Seconds after releasing boost before the pool starts refilling. */
  boostRegenDelay: 1.2,

  /* ── TRANSIT DRIVE. See the third-ceiling section in the header. ─────── */
  /**
   * The drive's own ceiling, m/s. NOT multiplied by `powerMul`, and that is
   * the one deliberate break with every other speed in this table.
   *
   * `thrust`, `hardCap` and `omegaCap` are all per-hull because cruise and
   * boost are what a DOGFIGHT is made of and a hull should be better or worse
   * at one. Transit is not a fight, it is the road between them: a Dray
   * hauling ore and a tier-3 Kestrel cross the volume in the same time, so a
   * player who bought the cheap hull is not locked out of a planet by it.
   *
   * The `powerMul` spread is x1.90 (Dray stock 1.25 to Kestrel tier 3 2.38).
   * Run the closed form at the constant below with this number tiered as
   * `2,857 * powerMul` - which gives a stock Kestrel the same 5,000 - and the
   * dock-to-Cinder leg becomes 24.8 s in a stock Dray against 20.5 s in a
   * tier-3 Kestrel. Not a disaster, but it is a 21% tax on being poor levied
   * on the one part of the game that is pure travel time, and it buys nothing:
   * there is no skill in it, no decision in it and nothing to feel.
   *
   * 5,000 m/s is 5 km/s, which is why the HUD switches to km/s above 1,000 -
   * "4,983" is a number a pilot reads as noise.
   */
  transitTop: 5000,
  /**
   * The altitude law, 1/s: metres of surface clearance to m/s of allowance.
   *
   * ── THE ARITHMETIC, against the real layout in `Bodies.js` ───────────────
   *
   * Cinder sits 62,000 m from the dock with a 9,000 m radius and a 9,900 m
   * handoff, so the outbound leg is 52,100 m long and the altitude above its
   * surface runs 53,000 m (at the dock) down to 900 m (at handoff). Flying it
   * radially, the time is the integral of da/v(a) with v = clamp(aK, cruise,
   * transitTop), which splits into three closed-form pieces:
   *
   *   a1 = transitTop/K      the altitude above which the drive is flat out
   *   a0 = cruiseTop/K       the altitude below which it is back at cruise
   *
   *   t = (53,000 - a1)/transitTop  +  (1/K)·ln(a1/a0)  +  (a0 - 900)/cruiseTop
   *
   * At K = 0.20 and transitTop = 5,000, for a stock Kestrel (powerMul 1.75,
   * cruiseTop 210): a1 = 25,000 m, a0 = 1,050 m, and
   *
   *   t = 28,000/5,000 + (1/0.20)·ln(23.81) + 150/210
   *     = 5.60 + 15.85 + 0.71 = 22.2 s
   *
   * against a target window of 15-25 s. The same arithmetic on a 270 km leg
   * (the furthest Phase 2 body) gives 47.2 s of flat-out running plus the same
   * 16.6 s tail = 63.8 s, against a target of 60-90 s. Both land inside, and
   * the middle term - the logarithm - is what makes that possible: it is the
   * only part that does not scale with the length of the leg, so a leg five
   * times longer costs under three times the time.
   *
   * The closed form is the DERIVATION, not the claim. `ship-transit.test.mjs`
   * flies both legs through the real integrator with the real steering and
   * asserts the flown numbers; the flown Cinder time comes out about 1.4 s
   * longer than 22.2 s because a real leg pays for the 1.8 s spool and for the
   * ship not starting at 5,000 m/s.
   *
   * ── AND K IS PINNED FROM ABOVE BY A SAFETY PROPERTY, NOT BY TASTE ────────
   *
   * The speed at a given altitude is `a·K` directly, so raising K makes the
   * hop faster AND the arrival hotter in the same stroke. Cinder's atmosphere
   * shell is 1,600 m above its surface, and the slowest thing the yard sells -
   * a stock Dray, powerMul 1.25 - boosts at 260 x 1.25 = 325 m/s. Requiring
   * that the drive never put ANY hull into a body's air faster than that hull
   * could have got there on its own engine gives
   *
   *     1,600 · K  <=  325       ->       K <= 0.203
   *
   * 0.20 is that ceiling, rounded down to two figures: 320 m/s at the
   * atmosphere shell, 5 m/s of margin under the slowest hull's own boost. Go
   * to 0.25 and it is 400 m/s, faster than a stock Dray can ever move, which
   * is the "arrived at a planet at a speed the flight model has no answer for"
   * failure with a smaller number on it. By the handoff radius (900 m up) the
   * law wants 180 m/s and the cruise floor has already taken over for every
   * hull above a Dray tier 1.
   */
  transitK: 0.20,
  /** Seconds from the key to full drive. Long enough to be an event, short
   *  enough that a player who mis-timed it is not stuck watching. */
  transitSpoolUp: 1.8,
  /**
   * Seconds from full drive back to normal space.
   *
   * Shorter than the spool-up because dropping out is usually URGENT - it is
   * what you do when something appears - but not instant: the speed cap sweeps
   * `transitTop` -> `hardCap*pm` across this window, so a Kestrel sheds 5,000
   * to 455 m/s at about 3,800 m/s² over 1.2 s and 3.3 km. Cutting it to one
   * frame instead would be a `setLength` from 5,000 to 455 in 16 ms, which is
   * the same one-frame teleport the two-cap boost arrangement was thrown out
   * for at the top of this file.
   */
  transitSpoolDown: 1.2,
  /**
   * The drive's push along the velocity, m/s², at full spool. Times accelMul.
   *
   * Drag is suppressed by the spool (see `_stepLinear`), so this does not
   * fight a drag term the way `thrust` does - it runs until the altitude cap
   * stops it. 5,000 - 210 = 4,790 m/s of build at 2,400 m/s² is 2.0 s, which
   * lands just after the 1.8 s spool finishes, so the drive reaches its
   * ceiling right as the sound settles rather than long after.
   */
  transitThrust: 2400,
  /**
   * ASSIST 4, in transit: authority LOST at full spool. 1 -> 0.30.
   *
   * Multiplied into the same `gain` that `authorityFalloff` builds, so this is
   * a turn of the existing knob and not a second steering system. The number
   * is set by what a mouse can hold: at 5,000 m/s a stock Kestrel with full
   * authority (0.6, since speed/cruiseTop is pinned) turns at 1.42 rad/s and a
   * 20 ms twitch is 1.6 degrees of course - 140 m of lateral error per second
   * of flight, which is unflyable over a 250 km leg. At 0.30 of that it turns
   * at 0.42 rad/s: 90 degrees takes 3.7 s, which is a supercruise you steer
   * rather than one you fight.
   */
  transitFalloff: 0.70,
  /**
   * FOV at full spool is `baseFov + this`, BLENDED toward rather than added.
   *
   * Added would stack on top of the cruise and boost kicks, which are both
   * already pinned at their maxima at 5,000 m/s - 75 + 7 + 12 = 94 for any
   * hull - and 94 + 24 is a fisheye. Blending means transit HOLDS 99 degrees
   * whatever the speed and whatever the hull, which is 5 degrees clear of the
   * boost peak (so the two read differently) and cannot run away.
   */
  fovTransitKick: 24,
  /** Chase distance added at full spool, m. 21 m at boost -> 35 m in transit;
   *  the hull has to get small for 5 km/s to read as 5 km/s. */
  chaseTransitPull: 14,

  /* ── ASSIST 3: velocity alignment ────────────────────────────────────── */
  /** rad/s the velocity vector is rotated toward the nose while coasting. */
  alignBase: 0.45,
  /** ...plus this much at full throttle. 2.00 rad/s total under power. */
  alignThrust: 1.55,

  /* ── Mouse ───────────────────────────────────────────────────────────── */
  /** Look delta (already radians, `CONFIG.player.mouseSensitivity` applied by
   *  `Input`) -> virtual stick deflection. 1/1.8 = 0.556 rad of on-foot turn,
   *  i.e. 253 px at the shipped sensitivity, is full deflection. */
  mouseGain: 1.8,
  /** How fast the virtual stick self-centres, 1/s. */
  stickReturn: 2.5,

  /* ── Camera. The sprint kick in `Player._applyFov` is the precedent. ──── */
  fovCruiseKick: 7,
  fovBoostKick: 12,
  chaseBase: 12,
  chasePull: 9,
  chaseHeight: 3.2,
});

/** Cruise top speed at a power multiplier: the drag fixed point. */
export function cruiseTopSpeed(powerMul = 1) {
  return (FLIGHT.thrust * powerMul) / FLIGHT.drag;
}

/** Absolute top speed at a power multiplier: the hard cap, which boost reaches. */
export function boostTopSpeed(powerMul = 1) {
  return FLIGHT.hardCap * powerMul;
}

/**
 * Steady-state turning radius, m, for a speed and axis.
 *
 * Exported because it is the number lesson 1 is about, and a caller (a spec
 * board, a tutorial, the test) should read it from the same arithmetic the
 * integrator uses rather than restating it.
 *
 * `spool` defaults to 0, so every existing caller asks the question it always
 * asked. Pass the drive's spool to get the transit answer from the same line
 * rather than from a second formula that could drift.
 */
export function turnRadius(speed, powerMul = 1, axis = 'pitch', spool = 0) {
  const rate = axis === 'roll' ? FLIGHT.rollRate
    : axis === 'yaw' ? FLIGHT.yawRate
      : FLIGHT.pitchRate;
  const authority = 1 - FLIGHT.authorityFalloff * clamp(speed / cruiseTopSpeed(powerMul), 0, 1);
  const trim = 1 - FLIGHT.transitFalloff * clamp(spool, 0, 1);
  const omega = Math.min(rate * powerMul * authority * trim, FLIGHT.omegaCap * powerMul);
  return omega > 0 ? speed / omega : Infinity;
}

/**
 * THE ALTITUDE LAW. The whole of the transit drive's speed rule, in one line.
 *
 *     clamp(altitude * transitK, cruiseTop(powerMul), transitTop)
 *
 * Exported and pure so the HUD, the test and the integrator all read the same
 * arithmetic - a governor whose displayed number is computed by a second copy
 * of the rule is a governor that will one day disagree with itself.
 *
 * ── EVERY WAY `altitude` CAN BE HOSTILE, AND WHAT EACH ONE GETS ─────────────
 *
 * This project lost a day to a single NaN reaching `UnrealBloomPass` and
 * blacking out a whole frame (19 NaN pixels destroyed 921,600), so the guards
 * here are not defensive habit, they are the house rule:
 *
 *   NEGATIVE   `approachState().altitude` is surface distance and goes NEGATIVE
 *              inside a body. Unclamped, `-9,000 * 0.18` is -1,620 m/s, and a
 *              negative cap fed to `Vector3.setLength` reverses the velocity -
 *              a ship that clipped a planet would fly out backwards at 1.6
 *              km/s. Clamped to 0 first, so inside a body the answer is the
 *              cruise floor.
 *   +Infinity  a volume with no bodies in it. There is nothing to be near, so
 *              the drive gets its ceiling.
 *   NaN / -Inf both mean "the caller does not know", and the safe answer to
 *              that is never the fast one: they get the cruise floor, which is
 *              a speed the ship can already reach without this drive at all.
 *
 * @param {number} altitude metres to the nearest SURFACE, negative inside
 * @param {number} [powerMul]
 * @returns {number} a finite, positive m/s ceiling. Always.
 */
export function transitSpeedLimit(altitude, powerMul = 1) {
  const cruise = cruiseTopSpeed(powerMul);
  if (altitude === Infinity) return FLIGHT.transitTop;
  if (!Number.isFinite(altitude)) return cruise;
  const clear = altitude > 0 ? altitude : 0;
  const want = clear * FLIGHT.transitK;
  return want < cruise ? cruise : want > FLIGHT.transitTop ? FLIGHT.transitTop : want;
}

/** The drive's states, in the order a flight walks them. */
export const TRANSIT_STATE = Object.freeze({
  off: 'off',
  spooling: 'spooling',
  engaged: 'engaged',
  dropping: 'dropping',
});

/* ══════════════════════════════════════════════════════════════════════════
 *  Module-level scratch. HOUSE RULE: never allocate inside a frame handler.
 * ══════════════════════════════════════════════════════════════════════════
 * One set, reused by every Flight instance, because `step` is not re-entrant
 * and there is exactly one ship being flown at a time. Anything that outlives
 * a step is a field on the instance instead.
 */
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _accel = new THREE.Vector3();
const _target = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _dq = new THREE.Quaternion();

const FWD_LOCAL = new THREE.Vector3(0, 0, -1);
const UP_LOCAL = new THREE.Vector3(0, 1, 0);
const RIGHT_LOCAL = new THREE.Vector3(1, 0, 0);

/** Fresh, fully-zeroed command. The shape `setCommand` merges into. */
export function blankCommand() {
  return {
    /** -1..1, nose down..up */
    pitch: 0,
    /** -1..1, nose left..right */
    yaw: 0,
    /** -1..1, roll left..right */
    roll: 0,
    /** -1..1, reverse..main thrust */
    throttle: 0,
    /** -1..1, thrust down..up (body axis, not world) */
    vertical: 0,
    /** -1..1, thrust port..starboard. Unbound on the keyboard; see readInput. */
    lateral: 0,
    boost: false,
    brake: false,
  };
}

export class Flight {
  /**
   * @param {object} [o]
   * @param {THREE.Vector3} [o.position]
   * @param {THREE.Quaternion} [o.quaternion]
   * @param {object} [o.ship] a `Ship` or its `snapshot()`; see `setShip`
   */
  constructor({ position = null, quaternion = null, ship = null } = {}) {
    this.position = new THREE.Vector3();
    if (position) this.position.copy(position);
    this.quaternion = new THREE.Quaternion();
    if (quaternion) this.quaternion.copy(quaternion);
    this.velocity = new THREE.Vector3();

    /** Body-frame angular velocity on LOCAL axes: (about +X, about +Y, about +Z).
     *  NOT the pilot's (pitch, yaw, roll) - see the axis note above. */
    this.omega = new THREE.Vector3();

    this.command = blankCommand();

    /** Virtual mouse stick, -1..1 per axis. Owned by `readInput`. */
    this._stick = { x: 0, y: 0 };

    this._powerMul = 1;
    this._accelMul = 1;
    this.boostFuel = FLIGHT.boostEnergy;
    this._boostIdle = FLIGHT.boostRegenDelay;
    /** Whether boost was actually granted last step (fuel AND throttle both). */
    this.boosting = false;

    /* ── The transit drive. See the third-ceiling section in the header. ──
     *
     * Four fields and nothing else: a state, the 0..1 ramp everything else
     * rides, the altitude cap recomputed each step, and why it last dropped.
     * Deliberately NOT part of `command`: the command struct is what a
     * keyboard writes sixty times a second, and this is a latched mode that
     * survives the player letting go of every key. */
    /** @type {'off'|'spooling'|'engaged'|'dropping'} */
    this.transitState = TRANSIT_STATE.off;
    /** 0..1. Drives speed, steering authority, FOV, chase distance and sound. */
    this._transitSpool = 0;
    /** m/s, from the altitude law. Recomputed every step, never stale. */
    this._transitCap = cruiseTopSpeed(this._powerMul);
    /** Why the drive last left `engaged`. Null while it never has. */
    this.transitDropReason = null;

    if (ship) this.setShip(ship);
  }

  /**
   * Take the ship's stats.
   *
   * Accepts a `Ship` (reads the private multipliers it already computes) or a
   * `Ship.snapshot()`, because the yard hands out snapshots and the world
   * holds the object, and making the caller remember which is which is how a
   * stat silently stops applying. `Ship.js:107-118` is emphatic that a tier
   * which is banked and applied to nothing is the recorded failure here - the
   * dragon's `applyPowers` hook did not exist for a while and every purchase
   * in that window bought nothing.
   *
   * ── AND IT THROWS, BECAUSE THE HOLE IS STILL OPEN UPSTREAM ───────────────
   *
   * `new Ship(...)` initialises `_powerMul` to 1 and computes the real value
   * only inside `applyPowers`. The HULL BIAS lives in there too, not in the
   * constructor - so a world that boards a brand-new stock Kestrel without
   * calling `applyPowers({})` first hands this model a `powerMul` of 1, and
   * that Kestrel cruises at 120 m/s instead of 210. Not "a tier did nothing":
   * every hull flies identically, slower than the slowest ship in the yard,
   * and nothing anywhere says so.
   *
   * That is the dragon bug with the numbers changed, and it is one forgotten
   * line away at every call site, so it is not left to be noticed. A `Ship`
   * whose hull has a power bias but whose multiplier is still exactly 1 is
   * provably un-applied, and this throws. `applyPowers({})` with an empty bag
   * is the fix and is always correct - it is what "no upgrades bought" means.
   *
   * Snapshots are exempt: `snapshot()` reports whatever the ship computed, and
   * a snapshot with `powerMul` 1 could legitimately come from a test rig.
   */
  setShip(ship) {
    if (!ship) return this;
    const p = ship.powerMul ?? ship._powerMul;
    const a = ship.accelMul ?? ship._accelMul;
    const bias = ship.baseStats?.power ?? 0;
    if (bias > 0 && p === 1 && ship.applyPowers) {
      throw new Error(
        `Flight.setShip: ${ship.id ?? 'ship'} has a hull power bias of ${bias} but powerMul is `
        + 'still 1, so applyPowers() was never called. Every hull would fly at 120 m/s. '
        + 'Call ship.applyPowers(tiers) - an empty bag is correct for a stock hull.'
      );
    }
    if (Number.isFinite(p) && p > 0) this._powerMul = p;
    if (Number.isFinite(a) && a > 0) this._accelMul = a;
    return this;
  }

  get powerMul() { return this._powerMul; }
  get accelMul() { return this._accelMul; }
  /** m/s. */
  get speed() { return this.velocity.length(); }
  /** The drag fixed point for this ship. */
  get cruiseTop() { return cruiseTopSpeed(this._powerMul); }
  /** The hard cap for this ship, which is what boost reaches. */
  get boostTop() { return boostTopSpeed(this._powerMul); }

  /* ── Transit drive ─────────────────────────────────────────────────── */

  /** 0..1: how far into the drive this ship is. The one number everything rides. */
  get transitSpool() { return this._transitSpool; }
  /** True once the drive is at full authority. False all through the spool. */
  get transitEngaged() { return this.transitState === TRANSIT_STATE.engaged; }
  /** True from the key press until the drive is fully back down. */
  get transitLive() { return this.transitState !== TRANSIT_STATE.off; }
  /** m/s the altitude law is allowing right now. */
  get transitCap() { return this._transitCap; }

  /**
   * Start the drive. A DUMB LATCH, and that is the design.
   *
   * Every reason to refuse - an approach phase, the yard's handoff sphere, a
   * hostile lock - is a fact about the body layout, and this file has no
   * `Bodies.js` import and is not getting one (see the header). `Piloting`
   * owns `approachState`, so `Piloting._pollTransit` is what refuses and what
   * tells the player why. What this DOES own is the one refusal that is a fact
   * about the drive itself: you cannot re-engage something already running.
   *
   * @returns {boolean} true if the spool actually started
   */
  engageTransit() {
    if (this.transitState === TRANSIT_STATE.spooling
      || this.transitState === TRANSIT_STATE.engaged) return false;
    this.transitState = TRANSIT_STATE.spooling;
    this.transitDropReason = null;
    return true;
  }

  /**
   * Bring the drive down.
   *
   * `hard` exists for exactly two callers and neither of them is gameplay:
   * `halt()` and `place()`, which teleport a ship into a berth or a cutscene
   * and must not leave a drive spooling in a hangar. Everything a PLAYER can
   * do - the toggle, a mass lock, taking a hit - goes through the ramp, so the
   * speed cap sweeps down over `transitSpoolDown` instead of snapping.
   *
   * @param {string|null} reason recorded for the HUD and the tests
   * @param {boolean} [hard] skip the ramp entirely
   * @returns {boolean} true if there was anything to drop
   */
  dropTransit(reason = null, hard = false) {
    const was = this.transitState !== TRANSIT_STATE.off;
    if (was) this.transitDropReason = reason;
    if (hard) {
      this.transitState = TRANSIT_STATE.off;
      this._transitSpool = 0;
      return was;
    }
    if (this.transitState === TRANSIT_STATE.off
      || this.transitState === TRANSIT_STATE.dropping) return false;
    this.transitState = TRANSIT_STATE.dropping;
    return true;
  }

  /** The player's key: engage if it is down, drop if it is up. */
  toggleTransit(reason = 'pilot') {
    return this.transitLive ? this.dropTransit(reason) : this.engageTransit();
  }

  /** Unit nose vector, into `out` (allocation-free for callers that pass one). */
  forward(out = _fwd) { return out.copy(FWD_LOCAL).applyQuaternion(this.quaternion); }
  up(out = _up) { return out.copy(UP_LOCAL).applyQuaternion(this.quaternion); }
  right(out = _right) { return out.copy(RIGHT_LOCAL).applyQuaternion(this.quaternion); }

  /** Put the ship somewhere with no momentum - a berth, a pad, a respawn. */
  place(position, quaternion = null) {
    this.position.copy(position);
    if (quaternion) this.quaternion.copy(quaternion);
    this.halt();
    return this;
  }

  /** Kill all motion but keep the pose. Docking, cutscenes, a hard landing. */
  halt() {
    this.velocity.set(0, 0, 0);
    this.omega.set(0, 0, 0);
    this._stick.x = 0;
    this._stick.y = 0;
    /* A ship that has been stopped dead is not in transit, and the drop is
     * HARD rather than ramped: `halt` is called by `place`, which is how a
     * hull gets put in a berth, and a berthed ship counting down a spool would
     * come back up to 5 km/s the moment anybody read `transitLive`. */
    this.dropTransit('halted', true);
    return this;
  }

  /** A shove from outside the model: a laser hit, a collision, a tractor. */
  applyImpulse(v) {
    this.velocity.add(v);
    return this;
  }

  /** Merge a partial command. The headless entry point; `readInput` is the other. */
  setCommand(partial) {
    const c = this.command;
    if (partial.pitch !== undefined) c.pitch = clamp(partial.pitch, -1, 1);
    if (partial.yaw !== undefined) c.yaw = clamp(partial.yaw, -1, 1);
    if (partial.roll !== undefined) c.roll = clamp(partial.roll, -1, 1);
    if (partial.throttle !== undefined) c.throttle = clamp(partial.throttle, -1, 1);
    if (partial.vertical !== undefined) c.vertical = clamp(partial.vertical, -1, 1);
    if (partial.lateral !== undefined) c.lateral = clamp(partial.lateral, -1, 1);
    if (partial.boost !== undefined) c.boost = !!partial.boost;
    if (partial.brake !== undefined) c.brake = !!partial.brake;
    return this;
  }

  /**
   * THE CONTROL SCHEME. Read `src/core/Input.js`'s state and produce a command.
   *
   * ── Every binding, and why it is that key ────────────────────────────────
   *
   *   Mouse X / Y     yaw / pitch, through a self-centring virtual stick
   *   A / D           ROLL left / right          (`state.right`)
   *   W / S           main / reverse thrust      (`state.forward`)
   *   Space           thrust UP                  (`state.jump`)
   *   C               thrust DOWN                (`state.crouch`)
   *   Shift           BOOST                      (`state.sprint`)
   *   X (held)        AIRBRAKE                   (`held('KeyX')`)
   *
   * Not one of these is a new binding, with the single exception of the
   * airbrake, and that is the point. `BINDABLE` already labels Space as
   * "Jump / climb / fly up" and C as "Crouch / dive / roll" - which is five
   * meanings including "fly down" and "swim down". Vertical thrust is the
   * sixth and it is the same idea, so a player who has flown the dragon
   * already knows it and a rebind moves both. Shift is "Sprint": go faster is
   * go faster, and the sprint FOV kick in `Player._applyFov` is the precedent
   * `cameraRig` follows below.
   *
   * A/D is the one place the shipped LABEL ("Strafe left/right") and the
   * behaviour part company, and it is deliberate: on a ship the sideways verb
   * IS the bank. With full roll authority plus vertical thrust, roll-and-pull
   * reaches every direction, which is what the assist is for.
   *
   *   CTRL IS NOT A GAME KEY. It is not an alternate for the airbrake and it
   *   must not become one. `Input.js:1-19` and `Input._syncAxes` record why at
   *   length: Ctrl+W closes the tab outside fullscreen, Ctrl+Shift is the
   *   Windows IME switcher, and a player found the consequence the hard way.
   *   `KeyX` was chosen instead because it is genuinely unbound, it is one key
   *   right of C so the brake and the down-thruster are neighbours, and it
   *   composes with everything. It is read through `held()` rather than a
   *   `BINDABLE` row only because this file does not own `Input.js`; adding
   *   the row is a one-line change and `held()` already resolves rebinds.
   *
   *   THE TRANSIT KEY IS NOT READ HERE, and that is the one deliberate hole
   *   in "readInput is the ONE method that knows what a keyboard is". The
   *   drive is a LATCH with a refusal, and every reason to refuse - an
   *   approach phase, the yard's handoff sphere, a hostile lock - is a fact
   *   about `Bodies.js`, which this file does not import and is not going to.
   *   A toggle read here could only ever engage blindly and then be dropped a
   *   step later by the mass lock, which is a control that appears to do
   *   nothing. So `Piloting._pollTransit` owns the key (Z, see `TRANSIT_KEY`
   *   there), polls it exactly the way `_pollBoard` polls F, and calls
   *   `toggleTransit` / `dropTransit` on this object.
   *
   *   `cmd.lateral` IS NOT BOUND, and that is a decision rather than an
   *   oversight. The integrator supports it fully and it is tested; there is
   *   simply no free ADJACENT key pair left for it. Q is free and E is
   *   `interact` - which the space world will want for docking - so a Q/E
   *   lateral pair would silently steal the dock key from a world that has not
   *   been written yet. When a gamepad or a docking scheme lands, the axis is
   *   already here and already integrated.
   *
   * @param {object} input a `src/core/Input.js` instance (duck-typed, so the
   *   test can drive a plain object and pin this scheme without a DOM)
   * @param {number} dt FRAME delta, not the fixed step: the mouse stick is a
   *   per-frame quantity and `Player` consumes look per frame for the same reason.
   */
  readInput(input, dt) {
    const s = input.state;
    const look = input.consumeLook ? input.consumeLook() : { dx: 0, dy: 0 };

    /* Self-centring virtual stick. A flick is a hard turn that eases off; a
     * sustained sweep is a sustained turn. It has to be a stick rather than a
     * per-frame delta because the assist is built on a RATE command: an
     * impulse cannot be damped toward, and a model that rotated by the raw
     * delta would have no angular assist at all on the two axes that matter
     * most. */
    const ret = Math.exp(-FLIGHT.stickReturn * Math.max(0, dt));
    this._stick.x = clamp(this._stick.x * ret + look.dx * FLIGHT.mouseGain, -1, 1);
    this._stick.y = clamp(this._stick.y * ret + look.dy * FLIGHT.mouseGain, -1, 1);

    const c = this.command;
    c.yaw = this._stick.x;
    /* Mouse DOWN is +dy (`Player` does `_pitch - look.dy`), and pitch is
     * nose-up positive, so this inverts. Matching the on-foot sense matters
     * more than any flight-sim convention: it is the same mouse. */
    c.pitch = -this._stick.y;
    c.roll = clamp(s.right ?? 0, -1, 1);
    c.throttle = clamp(s.forward ?? 0, -1, 1);
    c.vertical = (s.jump ? 1 : 0) - (s.crouch ? 1 : 0);
    c.lateral = 0;
    c.boost = !!s.sprint;
    c.brake = input.held ? !!input.held('KeyX') : false;
    return c;
  }

  /**
   * One fixed step. Call at `Engine.fixedStep` (1/60).
   *
   * @param {number} dt seconds
   * @param {object} [env]
   * @param {THREE.Vector3} [env.gravity] world acceleration, m/s². For a
   *   planet's pull. NOT scaled by `accelMul` - see `_stepLinear`.
   * @param {number} [env.dragMul] 1 in vacuum, higher in an atmosphere. The
   *   volcanic planet's descent is the first caller that will want it.
   * @param {number} [env.transitAltitude] metres to the NEAREST SURFACE, for
   *   the transit drive's altitude law. Negative inside a body, `Infinity`
   *   when there is nothing to be near. Absent means "no idea", which the law
   *   reads as the cruise floor - see `transitSpeedLimit`.
   * @param {string|null} [env.transitLock] a mass-lock reason. Non-null drops
   *   the drive. `Piloting` fills it; this file does not know what a planet is.
   */
  step(dt, env = null) {
    if (!(dt > 0)) return this;
    this._stepTransit(dt, env);
    this._stepAngular(dt);
    this._stepBoost(dt);
    this._stepLinear(dt, env);
    this._stepAlign(dt);
    this.position.addScaledVector(this.velocity, dt);
    this._assertFinite();
    return this;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Advance the drive's state machine and re-read the altitude law.
   *
   * Runs FIRST, before any of the other four, because `_stepAngular`,
   * `_stepLinear` and `_stepAlign` all read `_transitSpool` and all three have
   * to see this step's value rather than last step's. `SpaceCombat` had the
   * mirror-image bug against `interdicted` (see its header) and paid one step
   * of 8x displacement for it every time a wing launched; one step at 5,000
   * m/s is 83 m, and it is free to not have.
   *
   * The cap is recomputed unconditionally - not only while the drive is live -
   * so the HUD can show a pilot what the drive WOULD give them here before
   * they press the key.
   */
  _stepTransit(dt, env) {
    this._transitCap = transitSpeedLimit(env?.transitAltitude ?? NaN, this._powerMul);

    /* MASS LOCK. `Piloting` decides what counts; this only obeys. The drop is
     * ramped, so entering a lock at 5 km/s is a deceleration you feel over
     * `transitSpoolDown` rather than a one-frame `setLength`. */
    const lock = env?.transitLock ?? null;
    if (lock) this.dropTransit(lock);

    const climbing = this.transitState === TRANSIT_STATE.spooling
      || this.transitState === TRANSIT_STATE.engaged;
    /* `dt` can spike - a tab regaining focus, a world build stalling a frame -
     * and `dt / transitSpoolUp` is unbounded above. `clamp` to 0..1 is what
     * makes a 0.5 s spike a completed spool rather than a spool of 1.28, which
     * would leak into every consumer as a >100% authority trim and a cap above
     * `transitTop`. */
    const step = climbing ? dt / FLIGHT.transitSpoolUp : -dt / FLIGHT.transitSpoolDown;
    this._transitSpool = clamp(this._transitSpool + step, 0, 1);

    if (this.transitState === TRANSIT_STATE.spooling && this._transitSpool >= 1) {
      this.transitState = TRANSIT_STATE.engaged;
    } else if (this.transitState === TRANSIT_STATE.dropping && this._transitSpool <= 0) {
      this.transitState = TRANSIT_STATE.off;
    }
  }

  _stepAngular(dt) {
    const pm = this._powerMul;
    const c = this.command;

    /* ASSIST 4, and LESSON 1, in one expression.
     *
     * The falloff divides by the TIERED cruise top, so a Kestrel at 200 m/s
     * and a Dray at 200 m/s do NOT have the same authority - they have the
     * authority appropriate to how fast each one is FOR ITSELF. That is the
     * half of lesson 1 that is easy to miss: dividing by the untiered 120
     * would make every power tier a straight widening of the turning radius,
     * which is exactly what the mounts measured (eagle x1.52, board x1.65). */
    const authority = 1 - FLIGHT.authorityFalloff
      * clamp(this.velocity.length() / cruiseTopSpeed(pm), 0, 1);

    /* ASSIST 4 AGAIN, FOR THE TRANSIT DRIVE, AND ON THE SAME LINE ON PURPOSE.
     *
     * The falloff above is already pinned at its floor of 0.6 in transit -
     * `speed / cruiseTop` is 24 at 5,000 m/s and the clamp eats it - so it has
     * nothing left to say about the difference between 300 m/s and 5,000. This
     * trim is what says it, and it is a second factor on the SAME `gain`
     * rather than a separate clamp or a separate rate table, because a second
     * steering mechanism is a second thing that can disagree with `turnRadius`
     * (which multiplies the identical trim, from the identical constant).
     *
     * It rides `_transitSpool` rather than switching on `transitEngaged`, so
     * authority bleeds away over the spool and comes back over the drop -
     * a ship does not become a truck in one frame. */
    const trim = 1 - FLIGHT.transitFalloff * this._transitSpool;
    const gain = pm * authority * trim;

    /* Pilot terms -> body axes. See the axis note at the top of the file:
     * two of these three signs are inverted from the naive reading. */
    _target.set(
      c.pitch * FLIGHT.pitchRate * gain,
      -c.yaw * FLIGHT.yawRate * gain,
      -c.roll * FLIGHT.rollRate * gain
    );

    /* ASSIST 1. One damper, no branch: a zero target IS "stop asking", so
     * there is no separate decay path that could disagree with the drive
     * path. `damp` is `lerp(x, target, 1 - exp(-lambda*dt))`, which is
     * step-length independent - the same run at 1/120 lands in the same place. */
    this.omega.x = damp(this.omega.x, _target.x, FLIGHT.angResponse, dt);
    this.omega.y = damp(this.omega.y, _target.y, FLIGHT.angResponse, dt);
    this.omega.z = damp(this.omega.z, _target.z, FLIGHT.angResponse, dt);

    /* ASSIST 2, the anti-tumble clamp, and the reason it is on the MAGNITUDE
     * rather than per-axis: the per-axis targets are already inside their own
     * limits, so a per-axis clamp is a no-op and would prove nothing. What can
     * actually tumble a ship is all three at once - hypot(1.35, 1.05, 2.60) =
     * 3.112 rad/s, or 178 deg/s of compound spin. This takes it to 2.80.
     *
     * Scaled by `pm`, per lesson 1: an unscaled cap would bite a fast hull
     * earlier than a slow one and quietly widen its turning radius. */
    const om = this.omega.length();
    const cap = FLIGHT.omegaCap * pm;
    if (om > cap) this.omega.multiplyScalar(cap / om);

    const rate = this.omega.length();
    if (rate > 1e-9) {
      _axis.copy(this.omega).divideScalar(rate);
      _dq.setFromAxisAngle(_axis, rate * dt);
      /* Post-multiply: the rate is in the BODY frame, so it composes on the
       * right. `q * dq`, never `dq * q` - the latter would be a world-frame
       * rate, and a rolled ship would then pitch toward world up. */
      this.quaternion.multiply(_dq).normalize();
    }
  }

  _stepBoost(dt) {
    const c = this.command;
    /* Boost is a THROTTLE afterburner, not a speed setting: it multiplies the
     * main engine, so asking for it with the throttle closed does nothing and
     * costs nothing. Otherwise the pool drains while coasting and the player
     * is punished for a key they are holding out of habit. */
    const wants = c.boost && c.throttle > 0;
    if (wants && this.boostFuel > 0) {
      this.boosting = true;
      this.boostFuel = Math.max(0, this.boostFuel - FLIGHT.boostDrain * dt);
      this._boostIdle = 0;
    } else {
      this.boosting = false;
      this._boostIdle += dt;
      if (this._boostIdle >= FLIGHT.boostRegenDelay) {
        this.boostFuel = Math.min(FLIGHT.boostEnergy, this.boostFuel + FLIGHT.boostRegen * dt);
      }
    }
  }

  _stepLinear(dt, env) {
    const pm = this._powerMul;
    const c = this.command;
    const base = FLIGHT.thrust * pm;

    this.forward(_fwd);
    this.up(_up);
    this.right(_right);

    _accel.set(0, 0, 0);
    if (c.throttle > 0) {
      _accel.addScaledVector(_fwd, base * c.throttle * (this.boosting ? FLIGHT.boostThrustMul : 1));
    } else if (c.throttle < 0) {
      _accel.addScaledVector(_fwd, base * FLIGHT.reverseFrac * c.throttle);
    }
    if (c.vertical) _accel.addScaledVector(_up, base * FLIGHT.verticalFrac * c.vertical);
    if (c.lateral) _accel.addScaledVector(_right, base * FLIGHT.lateralFrac * c.lateral);

    const sp = this._transitSpool;

    /* ── THE TRANSIT DRIVE IS CAP-GOVERNED, WHICH MEANS DRAG HAS TO GO ─────
     *
     * Cruise is drag-governed on purpose (`thrust / drag` IS the cruise top),
     * and that is exactly why the drive cannot be. Holding 5,000 m/s against
     * `drag` 0.65 would need 3,250 m/s² of engine, and every metre of that
     * would be a thrust term inside the `accelMul` multiply - which is lesson
     * 2's leak, wearing a bigger number: a tier-3 Kestrel would settle at a
     * different transit speed from a stock Dray and the volume would take a
     * different time to cross depending on what you had bought.
     *
     * So drag is faded out by the spool and the ALTITUDE CAP below is what
     * stops the ship instead. `accelMul` then changes how fast a hull reaches
     * transit speed and nothing whatsoever about what that speed is.
     *
     * The airbrake fades with it, and that is the intended answer to "how do I
     * slow down in transit": you drop the drive. A 5x drag term that still
     * bit at 5,000 m/s would be 16,250 m/s² of deceleration on one held key. */
    const dragMul = env?.dragMul ?? 1;
    const drag = (FLIGHT.drag + (c.brake ? FLIGHT.brakeDrag : 0)) * dragMul * (1 - sp);
    _accel.addScaledVector(this.velocity, -drag);

    /* The drive's own push. ALONG THE VELOCITY, not along the nose.
     *
     * Along the nose it would be a second steering mechanism fighting ASSIST
     * 3, which already rotates the velocity onto the nose and which
     * `_stepAlign` runs at full rate in transit for this reason. Along the
     * velocity it is a pure speed governor: direction stays entirely the
     * assist's job and there is exactly one thing turning the ship.
     *
     * From a dead stop there is no velocity to push along, so it falls back to
     * the nose - `_dir` would otherwise be a normalise of a zero vector, which
     * is three NaNs and, downstream, a black frame. */
    if (sp > 0) {
      const s = this.velocity.length();
      if (s > 1e-3) _dir.copy(this.velocity).divideScalar(s);
      else _dir.copy(_fwd);
      /* The target ramps with the spool from this hull's own cruise top, so
       * engaging never asks the drive to SLOW a ship that is already boosting
       * and dropping out never asks it to hold a speed it has lost. */
      const want = this.cruiseTop + (this._transitCap - this.cruiseTop) * sp;
      if (s < want) _accel.addScaledVector(_dir, FLIGHT.transitThrust * sp);
    }

    /* ═══ LESSON 2, and it is this ONE line ═══════════════════════════════
     *
     * `Ship.js:36-42`: "On a drag-limited craft, Acceleration leaks into top
     * speed unless the NET is scaled: `speed += (thrust - drag) * accelMul *
     * dt`, never `thrust * accelMul`."
     *
     * `_accel` at this point is engine MINUS drag, and the multiply is on the
     * sum. The fixed point is therefore `thrust*pm = drag*v`, i.e.
     * `v = thrust*pm/drag`, with `accelMul` algebraically absent - it changes
     * how fast you GET there (time constant `1/(drag*accelMul)`) and nothing
     * else. Move the multiply up into the thrust terms and a stock Kestrel's
     * cruise top goes 210.0 -> 367.5 m/s; `ship-flight.test.mjs` reproduces
     * exactly that number by doing it. */
    this.velocity.addScaledVector(_accel, this._accelMul * dt);

    /* Gravity is OUTSIDE the multiply above, deliberately: it is not the
     * engine, and folding it in would make a fall accelerate faster for a ship
     * with a bigger reactor. Measured: with the multiply covering gravity, one
     * frame of 9 m/s² gives a Dray -0.150 m/s and a Kestrel -0.357; outside it,
     * both get -0.150 exactly.
     *
     * ── The second-order effect is real, and it is kept on purpose ─────────
     * Drag is inside the multiply (it has to be - see lesson 2), and drag acts
     * on ALL velocity including the part gravity put there. So the TERMINAL
     * fall speed is `g / (drag * accelMul)`, which does differ by hull: at
     * g = 9 a stock Dray settles at 11.08 m/s and a tier-3 Kestrel at 5.82.
     * That is the heavy ore tender dropping through an atmosphere faster than
     * the light courier, which is the right way round, and the alternative -
     * taking drag out of the multiply - is precisely the leak lesson 2
     * forbids. It is written down here so the next reader knows it was chosen
     * rather than missed. */
    if (env?.gravity) this.velocity.addScaledVector(env.gravity, dt);

    /* The hard cap. One number, boost or not - see the header note on why two
     * caps snapped. It binds under boost (drag alone would settle at 312*pm)
     * and never at cruise (120*pm), so releasing boost is a drag settle rather
     * than a one-frame teleport.
     *
     * ── ...AND IN TRANSIT IT IS THE ALTITUDE LAW, BLENDED IN BY THE SPOOL ──
     *
     * `hardCap*pm -> transitCap` across the spool, and back again across the
     * drop. Written as a blend rather than a branch for the reason the two-cap
     * boost arrangement was thrown out: a cap that CHANGES VALUE between one
     * frame and the next is a `setLength` you can see, and a 5,000 -> 455 step
     * is that same defect with an extra digit. Because the blend is continuous
     * in both the spool AND the altitude, everything about closing on a planet
     * is smooth for free - the ship rides the cap down as the surface comes up,
     * shedding `transitK * v` m/s² without a single line of braking code.
     *
     * It is a CLAMP and not just a governor target on purpose. The governor
     * above decides the feel; this decides the guarantee. "You cannot arrive
     * at a planet at 5 km/s" has to be true on the frame a caller hands in a
     * spiked `dt` or a hostile impulse, not merely true in the steady state. */
    const capBase = FLIGHT.hardCap * pm;
    const cap = sp > 0 ? capBase + (this._transitCap - capBase) * sp : capBase;
    if (this.velocity.lengthSq() > cap * cap) this.velocity.setLength(cap);

    /* A braking ship gets a real zero. An exponential never reaches one, and
     * "nearly stopped" is not a state you can dock from. */
    if (c.brake && this.velocity.lengthSq() < FLIGHT.brakeStop * FLIGHT.brakeStop) {
      this.velocity.set(0, 0, 0);
    }
  }

  /**
   * ASSIST 3: rotate the velocity vector toward the nose, magnitude preserved.
   *
   * This is the mechanism that makes pointing and going the same verb, and the
   * reason it ROTATES rather than damping the perpendicular component is feel:
   * damping bleeds speed in every turn, so a corner costs you and the ship
   * reads as heavy. Rotating costs nothing, which is the arcade half of
   * "arcade six-degree with assist".
   *
   * The rate scales with throttle, which is the difference between an assist
   * and a rail. At full throttle it is 2.00 rad/s and a 90 deg error is gone
   * in 0.65 s measured (faster than the 0.79 s the rate alone predicts,
   * because the main engine is adding on-axis velocity at the same time).
   * Coasting it is 0.45 rad/s, so vertical thrust and a drifting broadside are
   * still real manoeuvres: a pure Space burn from rest still holds 42.2% of
   * its off-axis velocity a full second after the thruster is released.
   *
   * ── THE TARGET IS THE THRUST AXIS, NOT THE NOSE, AND THAT IS A BUG FIX ──
   *
   * It aligned to the nose unconditionally at first, and measurement caught
   * what that does to REVERSE: retro thrust pushes the velocity to
   * anti-parallel with the nose, and the assist then spends 2.00 rad/s
   * dragging it back. Reverse terminal speed came out at 16.8 m/s against the
   * 54.0 the thrust and drag alone specify - a x3.2 shortfall, and the
   * degenerate anti-parallel branch below was being taken on nearly every
   * step of a manoeuvre players use constantly (backing off a pier).
   *
   * So the target is the nose SIGNED BY THROTTLE. Reversing aligns to the
   * tail, which is where you are going, and "point and go" still holds - it
   * just holds in both directions. Vertical and lateral thrust deliberately do
   * NOT steer the target, or the strafe verbs would each become their own
   * autopilot and the ship would have no way to slip sideways at all.
   */
  _stepAlign(dt) {
    const speed = this.velocity.length();
    if (speed < 1e-3) return;
    this.forward(_fwd);
    if (this.command.throttle < 0) _fwd.negate();
    _dir.copy(this.velocity).divideScalar(speed);
    const dot = clamp(_dir.dot(_fwd), -1, 1);
    if (dot > 0.999999) return;
    const angle = Math.acos(dot);
    /* THE SPOOL COUNTS AS THROTTLE HERE, and it has to.
     *
     * Coasting, the assist runs at `alignBase` 0.45 rad/s. In transit the NOSE
     * turns at about 0.42 rad/s (the `transitFalloff` trim in `_stepAngular`),
     * so at 0.45 the velocity would track the nose by a whisker and every turn
     * would be flown half-sideways at 5 km/s. The drive is not a coast: its
     * field is carrying the ship, so the velocity is locked to the nose
     * whether or not the player is also holding the throttle down. `max`, not
     * a sum, so full throttle in transit is still 2.00 rad/s and not 3.55. */
    const pull = Math.max(Math.abs(this.command.throttle), this._transitSpool);
    const rate = FLIGHT.alignBase + FLIGHT.alignThrust * pull;
    const stepAngle = Math.min(angle, rate * dt);
    if (stepAngle <= 0) return;

    _axis.crossVectors(_dir, _fwd);
    if (_axis.lengthSq() < 1e-12) {
      /* Exactly reversed: the cross product is degenerate and any axis
       * perpendicular to the nose will do. Without this branch a ship flying
       * dead backwards normalises a zero vector and puts NaN into the
       * velocity - and "NaN propagates through bloom and blacks out the whole
       * frame" is a defect this world has already paid a day for. */
      _axis.copy(this.up(_up));
    }
    _axis.normalize();
    _dq.setFromAxisAngle(_axis, stepAngle);
    this.velocity.applyQuaternion(_dq);
  }

  /**
   * Camera and FOV, which is where the speed is actually SOLD.
   *
   * The precedent is `Player._applyFov`'s sprint kick, including its habit of
   * normalising against a reference speed rather than the cap so the number
   * means something. Two stacked terms, because the brief asks for the ship to
   * feel different at different speeds and one linear ramp over a 260 m/s
   * range would be imperceptible in the 0-120 half where most flying happens:
   *
   *   cruise term   0 -> +7 deg   over 0 .. cruise top   (120*pm m/s)
   *   boost term    0 -> +12 deg  over cruise top .. cap (120*pm .. 260*pm)
   *
   * The chase camera pulls back 12 -> 21 m over the same range, which doubles
   * the sense of the second half.
   *
   * Measured for a stock Kestrel (cruise top 210, boost cap 455) against a
   * 75 deg base: 75.0 parked, 78.5 at 105 m/s, 82.0 at its 210 cruise top,
   * 86.4 at 300, 91.3 at 400 and 94.0 pinned at 455. Chase distance runs
   * 12.0 -> 16.2 -> 21.0 m across the same points.
   *
   * Fills a caller-provided object: this is read every frame and the house
   * rule is that a frame handler allocates nothing.
   *
   * @param {number} baseFov usually `CONFIG.render.fov`
   * @param {object} out
   */
  cameraRig(baseFov, out = {}) {
    const cruise = this.cruiseTop;
    const cap = this.boostTop;
    const s = this.speed;
    const cruiseFrac = clamp(s / cruise, 0, 1);
    const boostFrac = cap > cruise ? clamp((s - cruise) / (cap - cruise), 0, 1) : 0;
    const normalFov = baseFov + FLIGHT.fovCruiseKick * cruiseFrac + FLIGHT.fovBoostKick * boostFrac;

    /* ── TRANSIT: A BLEND, NOT A THIRD ADDEND ──────────────────────────────
     *
     * Both kicks above are pinned at their maxima anywhere near transit speed
     * - `s / cruise` is 24 at 5,000 m/s - so any hull is already sitting at
     * baseFov + 19 before the drive is even mentioned, and stacking a fourth
     * term on top of that is a fisheye. Blending toward one fixed transit FOV
     * means the drive HOLDS `baseFov + fovTransitKick` at full spool whatever
     * the speed and whatever the hull, it is bounded by construction, and the
     * sweep from 82 (cruise) to 99 over the 1.8 s spool is the visual half of
     * "engaging is an event". `Player._applyFov`'s sprint kick is the
     * precedent for the shape; this is that shape with a ceiling on it. */
    const tf = this._transitSpool;
    const transitFov = baseFov + FLIGHT.fovTransitKick;
    out.fov = normalFov + (transitFov - normalFov) * tf;
    out.distance = FLIGHT.chaseBase + FLIGHT.chasePull * clamp(s / cap, 0, 1)
      + FLIGHT.chaseTransitPull * tf;
    out.height = FLIGHT.chaseHeight;
    out.speed = s;
    out.speedFrac = clamp(s / cap, 0, 1);
    out.boosting = this.boosting;
    out.boostFuel = this.boostFuel / FLIGHT.boostEnergy;
    out.transitState = this.transitState;
    out.transitSpool = tf;
    /* Normalised against the DRIVE's ceiling rather than the hull's, because
     * `speedFrac` is stuck at 1 for the whole of a transit leg and therefore
     * cannot drive anything that is meant to change during one. */
    out.transitFrac = clamp(s / FLIGHT.transitTop, 0, 1);
    return out;
  }

  /** Everything a HUD wants, in one read. Pass `out` if calling per frame. */
  snapshot(out = {}) {
    out.speed = this.speed;
    out.cruiseTop = this.cruiseTop;
    out.boostTop = this.boostTop;
    out.powerMul = this._powerMul;
    out.boosting = this.boosting;
    out.boostFuel = this.boostFuel;
    out.omega = this.omega.length();
    out.transitState = this.transitState;
    out.transitSpool = this._transitSpool;
    /* The cap is published even when the drive is off: it is what the drive
     * WOULD give you here, which is the number that tells a pilot whether it
     * is worth engaging at all. */
    out.transitCap = this._transitCap;
    out.transitTop = FLIGHT.transitTop;
    out.transitDropReason = this.transitDropReason;
    return out;
  }

  /**
   * NaN GUARD, and it throws on purpose.
   *
   * "NaN propagates through bloom and blacks out the whole frame" is a
   * recorded, day-costing defect in this world: four boxes with a zero tile
   * gave NaN uvs and 19 NaN pixels blacked out 921,600. The guard that came
   * out of that throws rather than warns, and this is the same guard for the
   * same reason - a ship position that has gone non-finite will be handed to a
   * camera, and a NaN camera matrix is a black screen with no stack trace.
   *
   * The two ways this model could produce one are both real: normalising a
   * zero-length axis (handled explicitly in `_stepAlign`) and a caller passing
   * a non-finite gravity. Failing here names the frame it happened in.
   */
  _assertFinite() {
    const ok = Number.isFinite(this.position.x) && Number.isFinite(this.position.y)
      && Number.isFinite(this.position.z)
      && Number.isFinite(this.velocity.x) && Number.isFinite(this.velocity.y)
      && Number.isFinite(this.velocity.z)
      && Number.isFinite(this.omega.x) && Number.isFinite(this.omega.y)
      && Number.isFinite(this.omega.z)
      && Number.isFinite(this.quaternion.x) && Number.isFinite(this.quaternion.y)
      && Number.isFinite(this.quaternion.z) && Number.isFinite(this.quaternion.w)
      /* The drive's two scalars are in here for the same reason as the rest:
       * `_transitSpool` multiplies the steering gain, the drag term, the FOV
       * and the chase distance, and `_transitCap` is a `setLength` argument.
       * A NaN in either reaches a camera matrix within one frame - and one NaN
       * in a camera matrix is a black screen with no stack trace, which is the
       * defect this whole guard exists for. */
      && Number.isFinite(this._transitSpool) && this._transitSpool >= 0 && this._transitSpool <= 1
      && Number.isFinite(this._transitCap) && this._transitCap > 0;
    if (!ok) {
      throw new Error(
        `Flight: non-finite state. pos=${this.position.toArray()} `
        + `vel=${this.velocity.toArray()} omega=${this.omega.toArray()} `
        + `quat=${this.quaternion.toArray()} `
        + `transit=${this.transitState}/${this._transitSpool}/${this._transitCap}`
      );
    }
  }
}
