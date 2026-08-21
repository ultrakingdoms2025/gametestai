import * as THREE from 'three';
import { CONFIG } from '../core/Config.js';
import { Flight, FLIGHT } from './Flight.js';
import { buildShipModel, FLYABLE, NOSE_YAW } from './ShipModel.js';
import { holdCapacity, SHIP_CLASSES } from './ShipStats.js';
import { BERTHS } from '../worlds/dock/YardPlan.js';
import {
  DOCK_ANCHOR, BODY_BY_ID, approachState, navTargets, APPROACH_PHASE, HULL_WARN_BAND,
} from '../worlds/space/Bodies.js';
import { applyLivery } from '../mounts/Livery.js';
import { worldGravity } from '../worlds/WorldRules.js';

/**
 * PILOTING - the mode that joins the yard, the void and the planet into one loop.
 *
 * ===========================================================================
 *  PILOTING IS A MODE, NOT A WORLD
 * ===========================================================================
 *
 * `MountManager` is the precedent and this file follows it deliberately rather
 * than inventing a second way to take the body off the player:
 *
 *   MountManager._mount            Piloting.board
 *   ---------------------------    -----------------------------------------
 *   player.movementOverride = true player.movementOverride = true
 *   camera rig -> 'third'          camera written directly (see below)
 *   avatar.setVisible(false)       avatar.setVisible(false)
 *   _applySeat every fixed step    player.position = flight.position, same step
 *   `mount:mounted` on the bus     `pilot:boarded` on the bus
 *   F dismounts                    F disembarks
 *
 * There are exactly three deliberate differences, and each one is a decision:
 *
 *  1. **The capsule is not resolved.** `MountManager._applySeat` calls
 *     `physics.resolveCapsule` so a rider cannot be posted through a wall. A
 *     ship is 14-28 m long and 800 km from anything; running a 0.35 m capsule
 *     solve at its origin would eject the SHIP out of the hangar roof it is
 *     legitimately flying under. `player.movementOverrideCollide = false` is
 *     the switch `Player` already provides for exactly this, and it is set on
 *     board and cleared on disembark.
 *
 *  2. **The camera is taken, not framed.** A mount reuses the third-person
 *     boom, which orbits the player's yaw/pitch. A ship rolls, and a boom that
 *     cannot roll turns a barrel roll into the world spinning round a level
 *     camera - which is the single thing that makes six-degree flight read as
 *     a menu. So the chase camera is composed here from the flight quaternion,
 *     and `player._harnessFrozen` suppresses `Player._applyCamera`,
 *     `Player._applyFov`, `CameraRig._composeThird`, the first-person viewmodel
 *     and `Unstuck` in one flag. That flag is named for the dev harness because
 *     the harness was the first thing that needed it; it means "something else
 *     owns the camera this frame" and this is the second such thing. It is
 *     re-asserted every frame, so a harness screenshot mid-flight cannot clear
 *     it out from under us.
 *
 *  3. **It survives a world change.** `MountManager` listens for
 *     `world:changing` and calls `clear()`, because a mount is bound to the
 *     world it was summoned in. A ship is the opposite: the whole point is that
 *     it carries you between worlds. So this listens for the same event and
 *     RE-ASSERTS instead - unless the destination is a world you cannot fly in,
 *     in which case it puts the ship back in its berth first (see `_onWorldChanging`).
 *
 * ===========================================================================
 *  THE FIVE SEAMS
 * ===========================================================================
 *
 *   dock  -> space    fly out past the pier heads (z < LAUNCH_Z)
 *   space -> planet   `approachState().shouldHandoff` (Bodies.js owns the test)
 *   planet -> space   climb above DEPART_ALT, or leave the playfield high
 *   space -> dock     come within DOCK_RANGE of the yard mouth under DOCK_SPEED
 *   dock  -> (foot)   disembark on the pier apron
 *
 * Every one of them is the same three steps in the same order, in `_travel`:
 * remember the pose in the frame you are LEAVING, `worldManager.activate`, then
 * write the pose in the frame you have ARRIVED in. The frames genuinely differ
 * - the yard's mouth is at z -104 in `dock` and at z -18 in `space`, because
 * one is a hangar and the other is a 285 m structure seen from outside - so a
 * seam that "kept the position" would drop the ship inside the building.
 *
 * ===========================================================================
 *  YOU CAN ALWAYS GET BACK, AND IT IS PROVED RATHER THAN INTENDED
 * ===========================================================================
 *
 * Two ways to strand a player, both of which this project has shipped the
 * equivalent of before:
 *
 *   LANDED AND CANNOT TAKE OFF. Every touchdown records `_landedSite`; boarding
 *   a landed ship and applying throttle lifts it, because `_landed` is cleared
 *   the moment vertical thrust or throttle is commanded. A ship that comes down
 *   too fast, or on ground too steep to sit on, is NOT left there: it is set
 *   down on the nearest landing pad instead (`_forceSetDown`). The player is
 *   hurt and told; they are never parked at the bottom of a fissure.
 *
 *   FLEW OUT AND CANNOT FIND HOME. `navReport()` always carries the yard, with
 *   bearing and range, from anywhere in the volume - it is the first row and it
 *   is never conditional. `scripts/tests/piloting-loop.test.mjs` flies a ship to
 *   a random bearing 200 km out and then flies it home with nothing but that
 *   readout, and asserts it docks.
 *
 * ===========================================================================
 *  TRANSIT, AND WHY THE FLIGHT MODEL IS NOT TOUCHED TO GET IT
 * ===========================================================================
 *
 * `Bodies.js` laid the volume out against an assumed boost of 1,600 m/s and
 * says so. The flight model that actually landed boosts a Kestrel at 455 m/s.
 * At 455 m/s, Cinder at 62 km is 136 seconds of holding W with nothing
 * happening, which is not a flight, it is a wait.
 *
 * Neither file is mine to re-tune, and both are right about their own half. So
 * the seam layer adds the third thing: while the throttle is pinned, the ship
 * is already up to speed, and nothing is within `TRANSIT_CLEAR` metres, the
 * DISPLACEMENT is scaled up to `TRANSIT_MAX` over `TRANSIT_RAMP` seconds. The
 * integrator is untouched - drag, boost, turn rates, the tumble cap and every
 * number `ship-flight.test.mjs` pins all still hold, and `flight.speed` still
 * reports the honest 455. What changes is how much ground a second of it
 * covers, which is exactly what a supercruise is.
 *
 * It disengages instantly - not damped - the moment the throttle comes off or
 * anything comes within `TRANSIT_CLEAR`, because a scaled displacement near a
 * planet is a ship that teleports through it. Measured with a stock Kestrel:
 * the dock-to-Cinder run is 136 s without it and 20.4 s with it.
 *
 * ===========================================================================
 *  ...AND THE TRANSIT *DRIVE*, WHICH IS A DIFFERENT THING WITH THE SAME NAME
 * ===========================================================================
 *
 * The multiplier above is a COURTESY. It is invisible, it engages itself when
 * you hold W in the open, and it exists so a player who never learns anything
 * is not stranded in a nine-minute hold. It is not a control and it teaches a
 * player nothing.
 *
 * `Flight`'s transit DRIVE is the control: a latched mode on Z, with a spool,
 * a sound, an FOV sweep, a speed governed by altitude above the nearest body,
 * a mass lock that refuses out loud, and a HUD row. It is the thing a player
 * uses to cross a solar system on purpose. Everything about how it FLIES is in
 * `Flight.js`; what lives here is the three things `Flight` deliberately
 * cannot know, because it has no `Bodies.js` import:
 *
 *   1. THE KEY.        `_pollTransit`, polled exactly the way `_pollBoard`
 *                      polls F.
 *   2. THE ALTITUDE.   `_env` fills `transitAltitude` from `approachState`
 *                      every step. The whole speed law hangs off it.
 *   3. THE MASS LOCK.  `transitRefusal` (may I start?) and `_transitBreak`
 *                      (must I stop?). Two rings, not one - see below.
 *
 * -- THE TWO RINGS, AND WHY THEY ARE NOT THE SAME RING ----------------------
 *
 * The obvious design is one rule: refuse to engage inside a body's `approach`
 * phase, and cut a live drive that enters one. Measured against THIS layout,
 * the second half of that is a feature that builds itself and cannot be used.
 *
 * `APPROACH_AT_RADII` is 6 and Cinder's radius is 9,000 m, so its approach
 * ring is 54,000 m from its centre. The dock is 62,000 m from that same
 * centre. The outbound leg is 52,100 m long and 44,100 m of it - 85% - is
 * inside Cinder's approach ring. A drive cut at the ring would therefore die
 * 8,000 m after leaving the yard, and the remaining 44.1 km would be flown at
 * cruise: 210 seconds against a 23-second budget. Built, shipped, useless.
 *
 * So:
 *
 *   ENGAGE RING   `approach` phase, the yard's own sphere, a hostile lock, or
 *                 a world a ship cannot fly in. You may not START a run here.
 *   BREAK RING    `atmosphere` phase - one ring tighter - plus the same yard,
 *                 lock and world tests. A LIVE run is cut here.
 *
 * The approach ring is safe to fly through under drive precisely because the
 * altitude law is doing the work a cut would otherwise have to do: at the ring
 * a ship is 45 km up and allowed 5,000 m/s, and by the atmosphere shell the
 * same law has already brought it to 320 m/s - under the boost ceiling of the
 * slowest hull the yard sells. The approach ring stops you STARTING a run you
 * should be finishing; it does not need to end one.
 *
 * -- Taking fire ends a run. That is a decision, and here is the reasoning ---
 *
 * `SpaceCombat` already writes `interdicted` for the multiplier, and the drive
 * reads the same flag: a wing with a lock keeps you in normal space. But an
 * interdiction only exists while the wing is ENGAGED, and a drive that could
 * be spooled up mid-fight the moment the flag flickered would be an "I win"
 * button - three hostiles built, aimed and never fought, which is the same
 * defect the interdiction hook was added to fix.
 *
 * So a HIT also drops the drive, and it drops it whatever the flag says:
 * `combat:playerHit` is listened for here and calls `dropTransit('hit')`. The
 * cost of getting this wrong in the other direction is small - a player who is
 * genuinely fleeing has `transitSpoolDown` + `transitSpoolUp` = 3.0 s of
 * exposure per attempt - and the cost of getting it wrong this way is that the
 * whole combat drop becomes optional.
 */

/* ------------------------------------------------------------------ */
/* Seam constants. Every one measured against the geometry it guards.  */
/* ------------------------------------------------------------------ */

/**
 * Past this Z in the yard, you are in space.
 *
 * `DockWorld.bounds.min.z` is -196 and Berth Zero's pad reaches -180, so -205
 * is 9 m clear of the furthest structure in the world. Any nearer and a ship
 * hovering over the end of Berth Zero would launch itself; any further and the
 * player flies through the edge of the world before the seam fires.
 */
export const LAUNCH_Z = -205;

/**
 * Where a launched ship appears in `space`, along the mouth normal.
 *
 * `DOCK_ANCHOR.radius` is 285 - the sphere that contains the whole yard - and
 * `DOCK_RANGE` below is 260, so 380 puts the arrival 120 m outside the
 * structure and 120 m outside its own docking trigger. Both margins matter: the
 * first stops the ship materialising inside a pier, the second stops it docking
 * again on the frame after it launched.
 */
export const SPACE_ARRIVAL_OUT = 380;

/** Come this close to the yard mouth, under `DOCK_SPEED`, and traffic takes you. */
export const DOCK_RANGE = 260;
/** m/s. Faster than this is a fly-by, not an approach. */
export const DOCK_SPEED = 90;

/**
 * Seconds after any seam before another can fire.
 *
 * Not politeness: `space -> dock` and `dock -> space` are each other's inverse
 * and their trigger volumes are 120 m apart. Without this a launch that clipped
 * the docking sphere on the way out would ping-pong forever inside one second.
 */
export const SEAM_COOLDOWN = 2.5;

/** Metres above the pad a ship enters a planet's playfield at. */
export const ENTRY_ALT = 420;
/** ...and how far short of it, so entry is a descent rather than a drop. */
export const ENTRY_OUT = 500;
/** Climb above this on a planet and you are leaving it. */
export const DEPART_ALT = 560;

/** Keel clearance under which the ship is touching the ground. */
export const TOUCH_CLEAR = 1.4;
/**
 * m/s. Come down faster than this and it is an impact, not a landing.
 *
 * Chosen against the flight model rather than by taste: `FLIGHT.brakeStop` is
 * 0.05 and a braked ship sheds 180.6 m to 33.7 m of stopping distance, so a
 * pilot who starts braking one ship-length up arrives well under 26. A pilot
 * who does not, does not.
 */
export const LAND_SPEED = 26;

/* ------------------------------------------------------------------ */
/* LIFT-OFF. The three constants that make "W to lift" a true sentence. */
/* ------------------------------------------------------------------ */

/**
 * ===========================================================================
 *  THE TAKE-OFF THAT KILLED YOU, AND WHAT EACH NUMBER BELOW IS FOR
 * ===========================================================================
 *
 * Measured in a real boot, three times out of three. Land a Kestrel on Cinder
 * at 5.3 m/s with a full hold, then hold **W and Space** - which is exactly
 * what the loading card, `board`'s own toast and the HUD's sit row all say
 * those keys do:
 *
 *     t+0.0   parked, integrity 100
 *     t+0.3   1.0 m up, 16.9 m/s, integrity 80   ("Hard landing - 42 m/s")
 *     t+0.8   1.3 m up, 28.4 m/s, integrity 25   ("Hard landing - 85 m/s")
 *     t+1.4   dead. World back to 'dock'. Hold gone. Card: SHOT DOWN.
 *
 * Three impacts in 1.1 seconds. Three compounding causes, and all three are
 * fixed here rather than one of them:
 *
 *  1. A LANDED HULL WOULD NOT ROTATE. `fixedUpdate` returns before `f.step`
 *     while `_landed`, so `_stepAngular` never runs: 180 frames of nose-up
 *     mouse moved the pitch from 0.00 to 0.00 degrees. "Pitch up before you
 *     go" was not available to the player, so the only take-off attitude was
 *     dead level. `_aimOnGround` restores it, clamped - see there.
 *
 *  2. FULL THROTTLE ON A LEVEL NOSE IS A RUNWAY, AND THERE IS NO RUNWAY.
 *     `FLIGHT.thrust * powerMul` is 136.5 m/s^2 forward; vertical is
 *     `verticalFrac` of it, 68.25, and inside Cinder's air `dragMul` is 2.8,
 *     so the settled climb is 37 m/s against a horizontal that is off the
 *     scale. The hull covers a hundred metres of rising caldera before it
 *     clears its own landing gear.
 *
 *  3. THE KEYS WERE STILL DOWN WHEN `_forceSetDown` PUT IT BACK ON A PAD, so
 *     the next step lifted off into the same hillside. That is what turned one
 *     survivable knock into a death.
 *
 * ── WHY AN ASSIST AND NOT "TELL THE PLAYER TO PITCH UP" ───────────────────
 * Because the game already tells them the opposite, in three places, and all
 * three are right: a ship with 68 m/s^2 of vertical thrust SHOULD go straight
 * up off a pad. The defect was never the instruction. It was that holding the
 * documented keys did not do the documented thing.
 */

/** Seconds of launch assist after a commanded lift-off. */
export const LIFTOFF_S = 2.6;
/**
 * Keel clearance at which the assist ends early, metres.
 *
 * 45 m is above every authored pad structure and above the caldera lip the
 * measured crash ran into, and it is reached in about 1.4 s of assisted climb
 * - so on flat ground the assist is over before its timer is, and the pilot
 * has the throttle back while still inside the first breath of the take-off.
 */
export const LIFTOFF_CLEAR = 45;
/**
 * Fraction of forward throttle allowed while the assist runs.
 *
 * Not zero, and that is deliberate: a launch with the throttle GATED SHUT
 * reads as a control that stopped working, and the player is holding W. A
 * fifth of it is 30 m/s^2, enough that the hull visibly moves off the pad the
 * way the pilot asked and nowhere near enough to reach the 42 m/s the first
 * impact was recorded at.
 */
export const LIFTOFF_THROTTLE = 0.2;
/**
 * m/s of climb the assist guarantees, as a FLOOR on the vertical velocity.
 *
 * A floor rather than an impulse because the thing being promised is "you
 * leave the ground", and an impulse has to be re-derived for every hull, every
 * gravity and every atmosphere in the system. 14 m/s clears `LIFTOFF_CLEAR`
 * in 3.2 s from a standstill - inside the timer - on the heaviest hull the
 * yard sells and in the thickest air any planet has, without ever exceeding a
 * speed the touchdown rule itself calls a landing (`LAND_SPEED * 0.8` is
 * 20.8). So a pilot who lifts and immediately changes their mind can set back
 * down without being hurt for it.
 */
export const LIFTOFF_CLIMB = 14;
/**
 * Seconds after an impact set-down during which a lift-off is refused.
 *
 * THE WHOLE OF FIX 3 ABOVE. `_forceSetDown` is the anti-stranding rule and it
 * works; what it could not survive was being called again on the next step by
 * keys that were never released. One second is under the reaction time of a
 * player who is about to let go anyway, and long enough that three impacts in
 * 1.1 s cannot happen: the second is 1.0 s after the first, by which time the
 * assist is available again and takes the hull straight up.
 */
export const SETTLE_LOCK = 1.0;
/**
 * Attitude a hull standing on its gear may be aimed to, degrees.
 *
 * NOSE-UP ONLY, and no roll. The pilot needs exactly one thing on a pad -
 * to point the ship where they intend to leave - and a hull that could pitch
 * 40 degrees DOWN on its own landing gear, or lie on its side, would look
 * broken in the one framing the player is guaranteed to be looking at
 * (`_composeCamera` is behind and above a stationary ship). Yaw is
 * unrestricted because turning on the spot is what a ship on a pad does.
 */
export const GROUND_PITCH_MAX = 42;

/**
 * Metres from a landing pad's centre inside which the HUD names it.
 *
 * 400 m is about nine seconds at the 45 m/s a controlled descent runs at, and
 * it is nearly twenty times the widest authored disc - so the pad is named
 * while there is still time to go round, rather than as an epitaph.
 */
export const PAD_HINT_RANGE = 400;
/**
 * How exposed a pad has to be before the readout says so, in degrees of
 * horizon lost and metres of fall.
 *
 * `PlanetWorld` publishes `drop: { deg, metres }` per pad and until now
 * nothing read it. Cinder's three read 38 deg / 12 m (Ashfall), 75 / 18.1
 * (Colonnade) and 270 / 66.9 (Rimhold Shelf) - and only the last of those is
 * something a pilot needs telling, because it is the one where stepping off
 * the disc is a fall you do not climb back up. A readout that annotated all
 * three would be annotating "this is a pad".
 */
export const PAD_EXPOSED_DEG = 120;
export const PAD_EXPOSED_DROP = 25;

/** Transit: displacement multiplier, ramp time, and the clear-space it needs. */
export const TRANSIT_MAX = 8;
export const TRANSIT_RAMP = 1.6;
export const TRANSIT_CLEAR = 4000;

/**
 * THE TRANSIT DRIVE'S KEY. Z, and every other letter was taken.
 *
 * The claimed set, swept out of the source rather than remembered: W A S D
 * Space Shift C (movement), E R F V T M L [ ] (BINDABLE actions), X (the
 * airbrake, via `held`), I B J K (panels: inventory, marketplace, quest board,
 * unstuck), N (inside `navigator.keyboard.lock`), and 1-6 (weapons and the
 * mount wheel). That leaves G H O P Q U Y Z, and only Q Z G are anywhere near
 * a left hand resting on WASD.
 *
 * Q IS DELIBERATELY NOT TAKEN. `Flight.readInput` records that Q is the only
 * free half of a Q/E lateral-thruster pair, that `cmd.lateral` is fully
 * implemented and tested and unbound for want of exactly that pair, and that E
 * is `interact`. Taking Q here would quietly close that door.
 *
 * Z is the same argument that put the airbrake on X, one key over: X was
 * chosen because "the brake and the down-thruster are neighbours". Z X C is
 * now a contiguous run of three ship verbs under the left hand - drive,
 * airbrake, thrust down - and it composes with W, Shift and the mouse.
 *
 * It is a real `BINDABLE` row rather than a bare `pressed('KeyZ')`, so it
 * appears in the rebinding panel and in F1 like every other ship control. The
 * literal here IS the action's identity; `Input.pressed` resolves the rebind.
 */
export const TRANSIT_KEY = 'KeyZ';

/**
 * Metres from the yard's centre inside which the drive is mass-locked.
 *
 * The requirement is "inside the dock's handoff radius", which is
 * `DOCK_ANCHOR.handoff` = 130 m - and 130 m is smaller than the yard itself.
 * `DOCK_ANCHOR.radius` is 285 m, measured against the geometry in
 * `DockExterior.js` as the sphere that contains the whole structure, so it
 * strictly contains the 130 m the rule asks for and additionally covers every
 * pier a spooling ship could be pointed at.
 *
 * BIGGER WAS MEASURED AND REJECTED. `TRANSIT_CLEAR` (4,000 m) is the radius
 * the displacement multiplier uses for the same question, and it looked like
 * the obvious answer - but a launched ship arrives at `SPACE_ARRIVAL_OUT`
 * (380 m) and would then have to fly 3.6 km of ordinary space before the drive
 * would light. At a stock Kestrel's 210 m/s cruise from a standing start that
 * is 19 seconds added to a 23-second budget, which is most of the problem the
 * drive exists to solve. At 285 m the launch point is already 95 m clear and
 * the drive is available from the moment the blast door closes.
 */
export const TRANSIT_DOCK_LOCK = DOCK_ANCHOR.radius;

/**
 * Why the drive refused or dropped, keyed by code.
 *
 * A CONTROL THAT SILENTLY DOES NOTHING IS WORSE THAN ONE THAT IS NOT THERE,
 * and this table is the whole of that promise: `_pollTransit` looks the code
 * up and puts the sentence on the HUD. Written out here rather than at the
 * three call sites so the same refusal cannot be phrased two ways, and so a
 * new lock reason without a sentence is a missing key rather than a silent
 * return.
 *
 * Each one names the CONDITION and, where the player can act, the ACTION -
 * "mass-locked" alone tells a pilot nothing they can do about it.
 */
export const TRANSIT_REASONS = Object.freeze({
  /* Both halves, because this fires in the hangar AND over a planet and a
   * sentence that named only one of them would be wrong half the time. */
  world: 'Transit drive needs open vacuum. Get clear of the yard or the planet first.',
  landed: 'Transit drive needs open vacuum. Lift off first.',
  dock: 'Mass-locked by Lodestar Yard. Clear the structure first.',
  approach: 'Mass-locked by the gravity well. Pull away from the body first.',
  atmosphere: 'Transit drive cut - atmospheric interface.',
  /* A body with no ground under it. `_hullContact` cuts the drive on the step
   * the clamp fires, because a drive still pushing at a wall is a drive
   * holding you against it. */
  hull: 'Transit drive cut - pressure hull.',
  interdicted: 'Interdicted. Transit drive will not spin up while something has a lock.',
  hit: 'Transit drive cut - hull under fire.',
  pilot: 'Transit drive disengaged.',
});

/**
 * Downward pull inside the pressurised bay, m/s^2.
 *
 * There IS gravity in a hangar - the hulls sit on cradles - but a ship under a
 * 23.6 m roof has to hold station while the pilot lines up on a 164 m mouth,
 * and a hull that sinks onto the deck every time the player reads the nav
 * panel is a hull that never leaves. A quarter g is enough to feel and not
 * enough to punish; `Cinder` runs its published 8.44 unmodified.
 */
export const YARD_GRAVITY = 2.4;

/**
 * Chase-camera shape, as fractions of the hull rather than as metres.
 *
 * See `_composeCamera` for what each one fixes. Chosen by looking at all three
 * hulls in a browser at rest, at cruise and under boost - there is no
 * arithmetic that produces a framing, and pretending otherwise would be a
 * number in a comment nobody measured.
 */
export const CHASE_LENGTH_FRAC = 0.55;
export const CHASE_SPINE_FRAC = 0.65;
/** Metres ahead of the hull the camera aims at. */
export const CHASE_LOOK = 30;

/** Worlds this mode can fly in. Anything else forces a dock first. */
export const FLIGHT_WORLDS = Object.freeze(['dock', 'space']);

/* Module-level scratch. HOUSE RULE: a frame handler allocates nothing. */
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _rig = {};
/* Scratch for `_addHullSolid`. Module level, because it runs inside a loop over
 * forty-odd boxes and a fresh Vector3 per box per landing is exactly the
 * allocation this project bans. */
const _hc = new THREE.Vector3();
const _hh = new THREE.Vector3();
const _mouth = new THREE.Vector3(...DOCK_ANCHOR.mouth);
const _normal = new THREE.Vector3(...DOCK_ANCHOR.mouthNormal).normalize();
/* Every field `Flight.snapshot` writes, declared up front: an object that
 * grows keys after creation is a hidden-class transition on the first frame of
 * every flight, and this is read sixty times a second. */
const _snap = {
  speed: 0, cruiseTop: 0, boostTop: 0, powerMul: 1, boosting: false, boostFuel: 0, omega: 0,
  transitState: 'off', transitSpool: 0, transitCap: 0, transitTop: 0, transitDropReason: null,
};
/** The one `env` object handed to `Flight.step`. Refilled, never reallocated. */
const _envOut = { gravity: null, dragMul: 1, transitAltitude: NaN, transitLock: null };
/** The yard's centre, for the drive's mass lock. `_mouth` is 18 m in front. */
const _dockCentre = new THREE.Vector3(...DOCK_ANCHOR.position);

const clamp = THREE.MathUtils.clamp;

export class Piloting {
  /**
   * @param {{scene:THREE.Scene, engine:any, physics:any, bus:any, input:any,
   *          player:any, camera:THREE.PerspectiveCamera, cameraRig?:any,
   *          avatar?:any, worldManager:any, ships?:any, economy?:any,
   *          mounts?:any, portals?:any}} ctx
   */
  constructor({
    scene, engine, physics, bus, input, player, camera,
    cameraRig = null, avatar = null, worldManager = null,
    ships = null, economy = null, mounts = null, portals = null,
  }) {
    this.scene = scene;
    this.engine = engine;
    this.physics = physics;
    this.bus = bus;
    this.input = input;
    this.player = player;
    this.camera = camera;
    this.cameraRig = cameraRig;
    this.avatar = avatar;
    this.worldManager = worldManager;
    this.ships = ships;
    this.economy = economy;
    this.mounts = mounts;
    this.portals = portals;

    /** The integrator. One instance for the session - it is the ship's state. */
    this.flight = new Flight();
    /** @type {string|null} hull currently boarded, or last flown. */
    this.shipId = null;
    /** @type {boolean} is the player in the seat right now. */
    this._active = false;
    /** @type {{group:THREE.Group}|null} the flown hull's geometry. */
    this._model = null;
    /** @type {Map<string, object>} one model per hull, built on first board. */
    this._models = new Map();

    /**
     * Where the ship physically IS when the player is not in it.
     * `'berth'` - parked in the yard. `'ground'` - set down on a planet.
     * Null means the player has never flown.
     * @type {'berth'|'ground'|null}
     */
    this._parked = 'berth';
    /** World id the ship is parked in, when `_parked === 'ground'`. */
    this._parkedWorld = null;
    /** Landing site id the ship is standing on, or null for open ground. */
    this._landedSite = null;
    /** True while the ship is resting on a surface rather than flying. */
    this._landed = false;

    /**
     * THE HOLD BELONGS TO THE HULL, not to the session.
     *
     * One map, keyed by ship id, and `_cargo` / `_cargoUnits` below are
     * accessors onto the entry for whichever hull is currently selected. It
     * used to be two plain fields on the manager, which meant the ore followed
     * the PLAYER: driven against the real rig, six nodes stowed in a Dray came
     * out as `12/40 m3, 91 cr`, and boarding the Pike - `SHIP_BASE_STATS.pike.hold`
     * is 0 - read `12/0 m3, 91 cr` and `_dock()` paid the 91 out. That made the
     * customiser's `hold` stat and the Pike's deliberate zero-hold design inert
     * for any player who boarded a Dray first, and park-and-swap at the piers
     * is the intended verb, not an obscure path.
     *
     * @type {Map<string, {cargo: Record<string, {units:number, credits:number, name:string}>, units: number}>}
     */
    this._holds = new Map();

    this._seamLock = 0;
    this._travelling = false;
    this._transit = 1;
    /**
     * True while something hostile has a lock. Written by `SpaceCombat`, read
     * by `_clearOfEverything`, and false whenever nobody has set it - so this
     * mode still runs identically with no combat system present at all.
     */
    this.interdicted = false;
    /** Last transit state the bus was told about, so `pilot:transit` is an
     *  EDGE and the audio director is not asked to start a sound per step. */
    this._transitSaid = 'off';
    this._prevMode = null;
    this._boardPrompt = null;
    this._fov = CONFIG.render?.fov ?? 75;
    /** Last step's Y, for the swept ground probe. Null before the first step. */
    this._prevY = null;
    /** False from lift-off until the hull is genuinely clear of the ground. */
    this._airborne = true;
    /** Seconds of launch assist left. See LIFTOFF_S. */
    this._liftoff = 0;
    /** Seconds a lift-off is refused for after an impact. See SETTLE_LOCK. */
    this._settleLock = 0;
    /**
     * Which hulled body the pilot has already been warned about, so the
     * sentence is said once per approach rather than sixty times a second.
     * Cleared when they leave the band. @see `_hullContact`
     */
    this._hullWarned = null;
    /** ...and which one has already said its hull is the end of the road. */
    this._hullSaid = null;
    /** Where the ship was when it last touched down. See `fixedUpdate`. */
    this._landedAt = new THREE.Vector3();
    /**
     * The hull's colliders, live in the world, while it is standing on a
     * surface. Empty otherwise. @see `_syncHullSolid`
     * @type {import('../physics/Physics.js').Collider[]}
     */
    this._hullColliders = [];
    /* The pose those colliders were built for, as primitives. Compared
     * numerically every fixed step: a string key would allocate every frame. */
    this._solidShip = null;
    this._solidWorld = null;
    this._solidX = 0;
    this._solidY = 0;
    this._solidZ = 0;
    this._solidYaw = 0;
    this._edgeSaid = -99;

    /* A world change is the one event that can happen underneath this mode.
     * Unlike a mount, the ship does not go away - it is HOW you changed world -
     * so the handler re-asserts rather than clearing, and only bails out when
     * the destination is somewhere a ship cannot be. */
    this._offChanging = bus?.on?.('world:changing', (e) => this._onWorldChanging(e));
    this._offChanged = bus?.on?.('world:changed', (e) => this._onWorldChanged(e));
    /* Dying in the seat must not leave a corpse flying a ship at 455 m/s.
     * `Player._die` runs its own 3.2 s respawn; the ship is brought home first
     * so the respawn lands the player somewhere they can walk. */
    /* `killerId` comes straight off `Player.applyDamage`'s attributions -
     * 'laser' for a hostile bolt, a hard-landing tag for a bad set-down - and
     * it is the one field that answers "what happened to me". It was published
     * to the event log and shown to the player nowhere. */
    this._offDied = bus?.on?.('player:died', (e) => this._onDied(e?.killerId ?? null));
    /* A repaint on the pier has to reach the hull you are flying, or a livery
     * bought in the yard is invisible the moment you leave it. */
    this._offLivery = bus?.on?.('ship:livery', (e) => this._applyLivery(e?.shipId));
    /* TAKING FIRE ENDS A TRANSIT RUN. See the header for the reasoning.
     *
     * A bus listener rather than a hook inside `SpaceCombat._playerHit`,
     * because `combat:playerHit` is already published for the HUD flash and
     * the audio, and a mode that reads an event nobody had to add for it keeps
     * working in a build with no combat system at all. */
    this._offHit = bus?.on?.('combat:playerHit', () => this._breakTransit('hit'));
  }

  /* ================================================================== */
  /* Contract API                                                        */
  /* ================================================================== */

  /** True while the player is in the seat. */
  get active() { return this._active; }
  /** True when the ship is resting on a surface (a pad, a pier, open ground). */
  get landed() { return this._landed; }
  /** The landing site the ship is standing on, or null. */
  get landedSite() { return this._landedSite; }
  /** Hulls the player may fly. */
  get flyable() { return [...FLYABLE]; }

  /** A hull's display name, available before its model has ever been built. */
  hullName(id = this.shipId) {
    return this._models.get(id)?.displayName ?? SHIP_CLASSES[id]?.name ?? id ?? 'ship';
  }

  /** Cubic metres of ore aboard. */
  get cargoUnits() { return this._cargoUnits; }

  /**
   * The hold for one hull, created empty on first use.
   * @param {string|null} [shipId]
   */
  _hold(shipId = this.shipId) {
    const key = shipId ?? '';
    let h = this._holds.get(key);
    if (!h) { h = { cargo: Object.create(null), units: 0 }; this._holds.set(key, h); }
    return h;
  }

  /* `_cargo` and `_cargoUnits` read and write the CURRENT hull's hold. They are
   * accessors rather than a rename so that every existing reader - `stow`,
   * `sellCargo`, `cargoValue`, `cargoManifest`, `deserialize` - keeps the shape
   * it was written against, and so a future third hold-owner cannot forget to
   * ask which ship it is talking about. */
  get _cargo() { return this._hold().cargo; }
  set _cargo(v) { this._hold().cargo = v; }
  get _cargoUnits() { return this._hold().units; }
  set _cargoUnits(v) { this._hold().units = v; }
  /** Hold size of the boarded hull, including purchased tiers. */
  get cargoCapacity() {
    const id = this.shipId ?? FLYABLE[0];
    const tiers = this.ships?.getPowers?.(id) ?? {};
    return holdCapacity(id, tiers.hold ?? 0);
  }
  /** What the hold is worth if it were sold now. */
  get cargoValue() {
    let v = 0;
    for (const k in this._cargo) v += this._cargo[k].credits;
    return v;
  }
  /** A copy, for the HUD and the save. */
  cargoManifest() {
    const out = [];
    for (const k in this._cargo) {
      out.push({ type: k, name: this._cargo[k].name, units: this._cargo[k].units, credits: this._cargo[k].credits });
    }
    out.sort((a, b) => b.credits - a.credits);
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Boarding                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * The hull the player is standing close enough to board, or null.
   *
   * In the yard that is a berth the ship is parked at; on a planet it is the
   * flown hull sitting where it was set down. Deliberately generous - 60% of a
   * hull's own length past its bounding radius - because a boarding radius
   * measured from a keel origin on a 28 m ore tender is a ship you have to
   * stand in a specific square metre to get into.
   */
  boardableAt(position = this.player?.position) {
    if (!position) return null;
    const wid = this.worldManager?.active?.id ?? null;
    if (this._active || this._travelling) return null;
    /* NOT WHILE RIDING SOMETHING ELSE.
     *
     * F is `BINDABLE`'s "dismount" row and this mode reuses it deliberately -
     * "leave the vehicle" is exactly what it already means. But `MountManager`
     * also polls it, and both polls run in the same frame off the same
     * edge-triggered `pressed()`. A player who rode a hoverboard out onto Pier
     * Three and pressed F would dismount AND board in one frame, which leaves
     * a mount despawning underneath a ship that has just taken the body.
     * The mount wins: get off first, then get in.
     *
     * Only the yard can reach this - `SpaceWorld` and `PlanetWorld` both set
     * `mounts: false` - but the yard is exactly where the ships are. */
    if (this.mounts?.mounted) return null;

    if (this._parked === 'ground' && this._parkedWorld === wid && this.shipId) {
      const m = this._models.get(this.shipId);
      const r = (m?.radius ?? 10) + (m?.length ?? 16) * 0.6;
      if (position.distanceTo(this.flight.position) <= r) return this.shipId;
      return null;
    }

    if (wid !== 'dock' || this._parked !== 'berth') return null;
    for (const b of BERTHS) {
      if (!FLYABLE.includes(b.id)) continue;
      const dx = position.x - b.apron.x;
      const dz = position.z - b.apron.z;
      /* Measured off the APRON - the ramp foot - not the berth centre. The
       * berth centre of the Dray is under 28 m of hull; the apron is where a
       * body actually stands to board, and `YardPlan` publishes it for exactly
       * this reason. */
      if (dx * dx + dz * dz <= 12 * 12) return b.id;
    }
    return null;
  }

  /**
   * Take the seat.
   * @param {string} shipId
   * @param {{silent?:boolean}} [opts]
   * @returns {boolean}
   */
  board(shipId, { silent = false } = {}) {
    if (this._active) return false;
    if (!FLYABLE.includes(shipId)) return false;

    const model = this._ensureModel(shipId);
    this.shipId = shipId;

    /* THE LINE `Flight.setShip` THROWS WITHOUT.
     *
     * `new Ship()` leaves `powerMul` at 1 and computes the hull bias inside
     * `applyPowers`, so a world that boards a stock hull without calling it
     * gets every ship at 120 m/s - slower than the slowest hull's real 150 -
     * with no symptom anywhere. `Flight.setShip` throws on it rather than let
     * that ship. An empty bag is what "no upgrades bought" means. */
    const ship = this._shipRecord(shipId);
    if (ship) {
      ship.applyPowers?.(this.ships?.getPowers?.(shipId) ?? {});
      this.flight.setShip(ship);
    } else {
      this.flight.setShip({ powerMul: 1, accelMul: 1 });
    }

    /* Place the ship where it actually is: at its berth if parked, or exactly
     * where it was set down if the player walked away from it on a planet. */
    if (this._parked === 'berth') this._placeAtBerth(shipId);
    else if (this._parked === null) this._setLanded(false);

    this._active = true;
    this._prevY = null;
    this._setLanded(this._parked !== null);
    this._airborne = !this._landed;
    this.flight.halt();
    this.flight.setCommand({ pitch: 0, yaw: 0, roll: 0, throttle: 0, vertical: 0, boost: false, brake: false });

    this._takeBody();
    this._showParkedHull(shipId, false);
    if (model) {
      if (!model.group.parent) this.scene.add(model.group);
      model.group.visible = true;
      this._model = model;
    }
    this._applyLivery(shipId);
    this._poseModel();

    this.bus?.emit?.('pilot:boarded', { shipId, world: this.worldManager?.active?.id ?? null });
    if (!silent) {
      this.bus?.emit?.('hud:notify', {
        text: `${this.hullName(shipId)} - systems live. W to lift.`,
        tone: 'info',
      });
    }
    return true;
  }

  /**
   * Leave the seat.
   *
   * Refuses in flight, because stepping out at 455 m/s is not a feature - the
   * player is told to set down first. Refuses in `space` at all: there is no
   * floor out there, and a body released in vacuum is the definition of
   * stranded.
   */
  disembark({ silent = false, force = false } = {}) {
    if (!this._active) return false;
    const wid = this.worldManager?.active?.id ?? null;

    if (!force) {
      if (wid === 'space') {
        this.bus?.emit?.('hud:notify', { text: 'Not in vacuum. Dock at the yard or land first.', tone: 'warn' });
        return false;
      }
      if (!this._landed) {
        this.bus?.emit?.('hud:notify', { text: 'Set down first - hold X to brake, C to descend.', tone: 'warn' });
        return false;
      }
    }

    const shipId = this.shipId;
    this._active = false;
    /* NOBODY IS IN THE SEAT, SO NOTHING IS SPOOLING.
     *
     * `fixedUpdate` returns before the integrator when `_active` is false, so
     * a live drive left behind here does not wind down - it FREEZES at
     * whatever spool it had, and the next `board` resumes a ship at 5 km/s
     * with a mass lock that has not been evaluated since. The normal exits
     * (dock, land) go through `place` -> `halt`, which already hard-drops it;
     * `force: true` - which `_onDied` uses to hand a body back mid-flight -
     * does not, and that is the hole. `_transitSaid` goes with it so the next
     * flight's first `pilot:transit` is a clean edge rather than a stale one. */
    this.flight.dropTransit('disembark', true);
    this._transitSaid = 'off';
    /* A HULL YOU WALK AWAY FROM SITS LEVEL.
     *
     * `_aimOnGround` lets a pilot point the nose up to 42 degrees before they
     * leave, and `_addHullSolid` builds the parked hull's colliders from its
     * YAW alone - which is right for a ship on its gear and wrong for one
     * standing nose-up, because the boxes would then be somewhere the drawn
     * hull is not. Levelling on the way out keeps the two honest and costs the
     * pilot nothing: the aim was for the take-off, and there is no take-off
     * happening while they are outside it. */
    if (this._landed) this._settle(this.flight, this._yawOf(this.flight.quaternion));
    this._giveBody();

    /* ── WHICH SIDE YOU GET OUT OF, AND IT WAS THE WRONG ONE ────────────
     *
     * Every walkable hull cuts its boarding hatch in local -X (`boardSide` is
     * -1 for all three berths). The MODEL carries `NOSE_YAW` - a PI yaw that
     * turns a nose-+Z hull to face the flight frame's nose-(-Z) - so hull local
     * -X maps to the flight frame's +X, which is `flight.right()` POSITIVE.
     *
     * This stepped out along NEGATIVE right, i.e. through the far flank, and
     * the consequence was visible the moment a docked ship was walked away
     * from: the pilot came out on the blind side of a 28 m ore tender, 24 m
     * from her own apron, and `boardableAt` returned null - you could not get
     * back into the ship you had just parked without walking round it.
     *
     * At a BERTH the answer is better than a vector anyway: `YardPlan` already
     * publishes the apron, which is where the ramp foot actually lands, and
     * that is the one point in the yard the boarding prompt is measured from.
     * Off a berth - on a planet - the sign is the whole fix. */
    if (this.player) {
      const m = this._models.get(shipId);
      const off = (m?.radius ?? 8) * 0.55 + 3.0;
      const berth = this._parked === 'berth' && wid === 'dock'
        ? BERTHS.find((b) => b.id === shipId) : null;
      if (berth) _v.set(berth.apron.x, this.flight.position.y, berth.apron.z);
      else _v.copy(this.flight.right(_v2)).multiplyScalar(off).add(this.flight.position);
      const g = this.physics?.groundHeight?.(_v.x, _v.z, _v.y + 12, 60);
      _v.y = g === null || g === undefined ? this.flight.position.y : g + 0.05;
      this.physics?.resolveCapsule?.(_v, 0.35, 1.75);
      this.player.position.copy(_v);
      this.player.velocity?.set?.(0, 0, 0);
    }

    if (this._parked === 'berth' && wid === 'dock') {
      // Back on the cradle: the yard's own hull is the one you can walk into.
      this._showParkedHull(shipId, true);
      if (this._model) this._model.group.visible = false;
    }

    this.bus?.emit?.('pilot:left', { shipId, world: wid });
    if (!silent) this.bus?.emit?.('hud:notify', { text: 'Hatch open.', tone: 'info' });
    return true;
  }

  /* ================================================================== */
  /* Fixed step - the physics and the seams                              */
  /* ================================================================== */

  /**
   * Runs BEFORE `player.fixedUpdate`, for the same reason `MountManager` does:
   * the position written here is what the player controller, the audio listener
   * and every downstream reader see this step.
   */
  fixedUpdate(dt, elapsed) {
    if (this._seamLock > 0) this._seamLock -= dt;
    if (this._settleLock > 0) this._settleLock -= dt;
    if (!this._active || this._travelling) return;

    const wid = this.worldManager?.active?.id ?? null;
    const f = this.flight;

    /* A landed ship is not integrated at all: it is standing on something, and
     * running gravity against a heightfield probe every step would either sink
     * it or jitter it. It leaves the ground the moment the pilot asks it to. */
    if (this._landed) {
      /* A LANDED SHIP THAT HAS BEEN MOVED IS NOT LANDED ANY MORE.
       *
       * This branch RETURNS before `f.step`, so a ship that believes it is
       * resting on something cannot rotate, cannot accelerate and cannot even
       * turn to face the way it wants to leave. That is correct on a pad and
       * it is a deadlock anywhere else - and `_landed` can be true anywhere
       * else, because `Flight.place` is a public verb that moves a ship
       * without telling this class. Measured: three of twelve homing legs, set
       * up by placing a berthed ship out in the volume, never moved at all
       * because their starting heading was more than 115 degrees off and the
       * throttle gate never opened.
       *
       * So "landed" is corroborated by WHERE, not just by a flag. Two metres
       * of tolerance covers the touchdown settle and nothing else. A ground
       * probe would be the obvious alternative and is wrong here: at a berth
       * the downward ray hits the cradle bolsters 2.9 m ABOVE the keel origin,
       * so a probe would report every parked ship as buried. */
      if (f.position.distanceToSquared(this._landedAt) > 4) {
        /* `_setLanded`, not `_landed = false`: it is what drops the hull's own
         * colliders, and a hull that is no longer standing on the ground must
         * not still be standing in the world. See the note on the lift-off
         * branch below - this one has the same hazard for the same reason. */
        this._setLanded(false);
        this._parked = null;
        this._parkedWorld = null;
        this._landedSite = null;
        this._airborne = true;
      }
    }

    if (this._landed) {
      const c = f.command;
      const wantsUp = c.vertical > 0.1 || c.throttle > 0.1 || c.boost;
      /* AIM IT WHILE IT SITS THERE. Runs before the lift test, so the frame a
       * pilot lines up on is the frame they leave on. See `_aimOnGround`. */
      this._aimOnGround(dt);
      /* A HULL THAT HAS JUST BEEN PUT DOWN BY AN IMPACT DOES NOT LEAVE AGAIN
       * ON THE SAME HELD KEY. See SETTLE_LOCK - this one line is the
       * difference between one survivable knock and three in 1.1 seconds. */
      if (wantsUp && this._settleLock > 0) {
        this._seatPlayer();
        return;
      }
      if (wantsUp) {
        /* `_setLanded(false)` AND NOT `_landed = false`, and the difference is
         * a stranding.
         *
         * A landed hull registers its own boxes in the world (see
         * `_syncHullSolid`), and `_groundContact` below asks
         * `physics.groundHeight` what is under the ship. Clear `_landed`
         * without dropping those colliders and the very next step's ground
         * probe finds THE SHIP'S OWN BELLY: measured on Ashfall Flat, the
         * terrain is at 8.79 and the probe returned 14.65, so a hull sitting at
         * 9.50 read a clearance of -2.9 and `_forceSetDown` put it back on the
         * pad, every step, for ever. Driven, all three landing sites went from
         * "lifts off" to STRANDED.
         *
         * `_setLanded` runs `_syncHullSolid`, which drops them on the same step
         * the flag changes. */
        this._setLanded(false);
        /* NOT airborne yet, and that word is doing real work. The ship is
         * still standing on the pad this step, so the ground probe below would
         * find it 0.7 m up and land it again on the very next step - which is
         * exactly what happened: 22 `pilot:landed` events in a row while the
         * throttle was pinned, and a hull that never actually left. It counts
         * as airborne once it has climbed clear of its own landing clearance,
         * and only an airborne ship can land. */
        this._airborne = false;
        this._landedSite = null;
        this._parked = null;
        this._parkedWorld = null;
        this._showParkedHull(this.shipId, false);
        /* THE LAUNCH ASSIST ARMS HERE, and only in a world with a floor. In
         * the yard the bay is 23.6 m high, the hull is already flying under a
         * roof, and a guaranteed 14 m/s climb would put it through that roof;
         * the yard has its own launch (`_launch`, past the pier heads) and
         * does not need this one. */
        this._liftoff = wid === 'dock' ? 0 : LIFTOFF_S;
        this.bus?.emit?.('pilot:liftoff', { shipId: this.shipId, world: wid });
      } else {
        this._seatPlayer();
        return;
      }
    }

    const env = this._env(wid);
    /* BEFORE the step: the assist is a change to the COMMAND, so the
     * integrator sees one consistent set of inputs and every number
     * `ship-flight.test.mjs` pins still comes out of an untouched `step`. */
    if (this._liftoff > 0) this._applyLiftoff(dt, wid);
    f.step(dt, env);
    /* ...and the climb FLOOR after it, because it is a floor on the result
     * rather than a force: drag, gravity and `dragMul` have all had their say
     * by now and the promise is about what the hull is doing, not about what
     * is being applied to it. */
    if (this._liftoff > 0 && f.velocity.y < LIFTOFF_CLIMB) f.velocity.y = LIFTOFF_CLIMB;
    /* Immediately after the step, so a mass lock that fired INSIDE
     * `_stepTransit` is announced on the step it fired rather than a frame
     * later. It is an edge compare and a return when nothing moved. */
    this._announceTransit();

    /* TRANSIT. Displacement only - see the header. The integrator above ran
     * with the honest numbers and `f.speed` still reports them. */
    this._transit = this._transitFactor(dt, wid);
    if (this._transit > 1) f.position.addScaledVector(f.velocity, (this._transit - 1) * dt);

    this._groundContact(wid);
    /* AFTER the transit displacement, deliberately: the multiplier can move a
     * hull four kilometres in one step and a hull limit tested before that
     * displacement is a limit the displacement steps straight over. */
    this._hullContact(wid);
    this._seams(wid, elapsed);
    this._seatPlayer();
  }

  /**
   * The launch assist, applied to the COMMAND for one step.
   *
   * Two edits and both are named in the block above LIFTOFF_S:
   *
   *   THE THROTTLE IS GATED to `LIFTOFF_THROTTLE` while the hull is still
   *   inside its own landing clearance, because 136.5 m/s^2 along a level nose
   *   is a runway and a caldera has no runway.
   *
   *   THE UP-THRUSTER IS COMMANDED whether or not the pilot is holding Space,
   *   because the card, the boarding toast and the HUD's own sit row all say
   *   **W lifts**, and this is that sentence being true.
   *
   * It ends on any of three things, and the third is the one that matters:
   * the timer runs out, the hull gets `LIFTOFF_CLEAR` metres of daylight under
   * it, or THE PILOT ASKS TO GO DOWN. An assist a player cannot cancel is a
   * cutscene; C cancels it on the frame it is pressed.
   */
  _applyLiftoff(dt, wid) {
    const f = this.flight;
    const c = f.command;
    if (c.vertical < -0.1) { this._liftoff = 0; return; }
    this._liftoff -= dt;
    if (this._liftoff <= 0) { this._liftoff = 0; return; }

    /* Clear of the ground already? Then the assist has done its job and the
     * throttle is the pilot's again, whatever the timer says. `groundHeight`
     * is the same probe `_groundContact` uses and it is null in a world with
     * no floor, which is the yard - where this never runs anyway. */
    const g = this.physics?.groundHeight?.(f.position.x, f.position.z, f.position.y + 6, 400);
    if (g !== null && g !== undefined && f.position.y - g > LIFTOFF_CLEAR) {
      this._liftoff = 0;
      return;
    }

    if (c.throttle > LIFTOFF_THROTTLE) c.throttle = LIFTOFF_THROTTLE;
    if (c.vertical < 1) c.vertical = 1;
    void wid;
  }

  /**
   * A HULL STANDING ON ITS GEAR CAN STILL BE AIMED.
   *
   * `fixedUpdate` returns before `f.step` while `_landed`, which is right -
   * running gravity against a heightfield probe every step would sink or
   * jitter a parked ship - but it also meant `_stepAngular` never ran, and
   * measured, 180 frames of nose-up mouse moved the pitch from 0.00 to 0.00
   * degrees. The pilot could not point the ship anywhere before leaving, which
   * is half of why the obvious take-off flew into a hillside.
   *
   * So the attitude is integrated here and NOTHING else is: no thrust, no
   * gravity, no drag, no position. It is composed from the yaw and pitch the
   * stick has accumulated rather than by calling into the integrator, because
   * the clamp is the whole point - see GROUND_PITCH_MAX - and a clamp applied
   * after a free rotation would fight the assist's own damping every step.
   *
   * Roll is deliberately dropped rather than clamped: there is no reading of
   * "roll while standing on three legs" that is not a bug.
   */
  _aimOnGround(dt) {
    const f = this.flight;
    const c = f.command;
    if (!(dt > 0)) return;
    if (Math.abs(c.yaw) < 1e-3 && Math.abs(c.pitch) < 1e-3) return;

    _e.setFromQuaternion(f.quaternion, 'YXZ');
    /* The same rates the integrator turns at, so a pilot who learns the ship
     * in the air is not learning a second ship on the ground. */
    const yaw = _e.y - c.yaw * FLIGHT.yawRate * dt;
    let pitch = _e.x + c.pitch * FLIGHT.pitchRate * dt;
    const lim = GROUND_PITCH_MAX * Math.PI / 180;
    if (pitch > lim) pitch = lim;
    if (pitch < 0) pitch = 0;
    _e.set(pitch, yaw, 0);
    f.quaternion.setFromEuler(_e);
    f.omega.set(0, 0, 0);
  }

  /**
   * THE PRESSURE HULL of a body that has no ground to hand you to.
   *
   * See the block in `space/Bodies.js`; this is the enforcement. A position
   * clamp and a velocity projection, both onto the same sphere:
   *
   *   - the ship is put back ON the hull radius, so it can never end a step
   *     inside a body however big the step was;
   *   - the INWARD component of the velocity is removed and the tangential
   *     component is left alone, so the hull skims the cloud deck rather than
   *     stopping dead against an invisible wall;
   *   - the pilot is told, once, in the body's own words.
   *
   * The warning band is a separate sentence said further out, because a pilot
   * who only learns there is no surface at the moment they stop has spent the
   * whole approach believing they were going to land.
   */
  _hullContact(wid) {
    if (wid !== 'space') return;
    const f = this.flight;
    const a = approachState(f.position);
    const b = a.body;
    if (!b || !(b.hull > 0)) { this._hullWarned = null; return; }

    /* Out of the band entirely: forget the warning so a second approach, or a
     * second body, gets its own sentence. */
    if (a.distance > b.hull * HULL_WARN_BAND) {
      if (this._hullWarned === b.id) this._hullWarned = null;
      if (this._hullSaid === b.id) this._hullSaid = null;
      return;
    }

    if (this._hullWarned !== b.id) {
      this._hullWarned = b.id;
      this.bus?.emit?.('hud:notify', {
        text: `${b.name}: no surface, nowhere to land. Turn back.`,
        tone: 'warn',
      });
    }

    if (a.hullDepth <= 0) return;

    _v.copy(f.position).sub(_v2.set(b.position[0], b.position[1], b.position[2]));
    const d = _v.length();
    /* Dead centre is the one degenerate case and it is reachable - a save
     * loaded at a body's origin, or a debug teleport. Any radial will do; the
     * one that matters is that it is a UNIT vector, because the alternative is
     * three NaNs and, through the bloom, a black frame. */
    if (d > 1e-3) _v.divideScalar(d); else _v.set(0, 1, 0);
    f.position.copy(_v2).addScaledVector(_v, b.hull);

    const inward = f.velocity.dot(_v);
    if (inward < 0) f.velocity.addScaledVector(_v, -inward);
    /* A drive still running against a wall is a drive holding you there. */
    this._breakTransit('hull');
    this._transit = 1;

    if (this._hullSaid !== b.id) {
      this._hullSaid = b.id;
      this.bus?.emit?.('pilot:hullpress', { body: b.id, speed: +f.speed.toFixed(2) });
      this.bus?.emit?.('hud:notify', {
        text: b.hullNote ?? `${b.name} has no surface. The hull will go no deeper.`,
        tone: 'warn',
      });
    }
  }

  /**
   * Gravity, air, and the two facts the transit drive cannot look up itself.
   *
   * Filled into ONE reused object rather than the three different literals the
   * first version returned: `step` is called sixty times a second and the
   * house rule is that a frame handler allocates nothing. It also means every
   * branch below has to think about `transitAltitude` and `transitLock`, and a
   * branch that forgot one would hand `Flight` a stale altitude from the last
   * world - which is a 5 km/s drive governed by how high something was over a
   * planet you already left.
   */
  _env(wid) {
    const w = this.worldManager?.active ?? null;
    const e = _envOut;
    e.gravity = null;
    e.dragMul = 1;
    /* NOT `Infinity`. Outside the void there is no "nearest surface" this law
     * means anything about, and `transitSpeedLimit` reads a non-finite,
     * non-Infinity altitude as "the caller does not know" and answers with the
     * cruise floor - the safe answer. `transitLock` below stops the drive in
     * these worlds anyway; this is the belt to that pair of braces. */
    e.transitAltitude = NaN;

    if (wid === 'space') {
      /* Falling into a planet's air is the one place the void has weather. The
       * flight model takes `dragMul` for exactly this and the planet agent flew
       * it: a coasting Dray settles at 8.49 m/s down and 4.71 m/s forward,
       * because the alignment assist acts as a wing. */
      const a = approachState(this.flight.position);
      e.transitAltitude = a.altitude;
      if (a.atmoDepth > 0) e.dragMul = 1 + a.atmoDepth * 1.8;
      /* The SAME approach state, handed on rather than recomputed. It is a
       * loop over every body in the volume with a square root each, and the
       * break ring wants exactly the phase this call just produced. */
      e.transitLock = this._transitBreak(wid, a);
      return e;
    }
    e.transitLock = this._transitBreak(wid, null);
    /* THE SHARED READER, not the predicate this line used to inline.
     *
     * It was the finite-number test spelled out here in full, and the identical
     * test spelled out again in
     * `Player.setWorldGravity`. Two copies of one question is how a hull came to
     * settle onto Tessera at a sixth of a g while the pilot who stepped out of
     * it walked in the station's -22, and the fix for that was to give both
     * consumers ONE reader. Re-implementing it here would have kept the shape
     * of the defect alive underneath the fix. @see ../worlds/WorldRules.js */
    const surface = worldGravity(w);
    if (surface !== null) {
      _v.set(0, -surface, 0);
      e.gravity = _v;
      e.dragMul = 1.35;
      return e;
    }
    /* The yard. There IS gravity in a pressurised hangar - the ships sit on
     * cradles - but a ship under a 23.6 m roof needs to hover on the spot while
     * the pilot lines up on the mouth, and a hull that sinks the moment the
     * player looks at the nav readout is a hull that lands on the deck. Held at
     * a quarter g, which is enough to feel and not enough to punish. */
    _v.set(0, -YARD_GRAVITY, 0);
    e.gravity = _v;
    e.dragMul = 1.1;
    return e;
  }

  /** Ramp the transit multiplier up or drop it instantly. See the header. */
  _transitFactor(dt, wid) {
    const f = this.flight;
    /* THE DRIVE SUPERSEDES THE MULTIPLIER, and they must never compound.
     *
     * x8 displacement on top of a 5,000 m/s drive is 40 km/s, which crosses
     * Cinder's whole 18 km diameter inside half a fixed step - the exact
     * tunnelling `_groundContact` was rewritten as a swept probe to stop. The
     * multiplier is the courtesy for a player who never presses Z; the moment
     * they do, the honest speed is the only speed. */
    if (f.transitLive) return 1;
    const clear = wid === 'space' && this._clearOfEverything();
    const pinned = f.command.throttle > 0.9 && f.speed > f.cruiseTop * 0.6;
    if (!clear || !pinned) return 1;
    const next = this._transit + (TRANSIT_MAX - 1) * (dt / TRANSIT_RAMP);
    return next > TRANSIT_MAX ? TRANSIT_MAX : next;
  }

  /* ------------------------------------------------------------------ */
  /* The transit drive: the key, the two rings, and the readout           */
  /* ------------------------------------------------------------------ */

  /**
   * THE ENGAGE RING. May the drive be started, here, now?
   *
   * Returns null when it may, and a key of `TRANSIT_REASONS` when it may not.
   * A code rather than a sentence so the caller can act on it (`_pollTransit`
   * notifies, the test asserts) without matching on prose.
   *
   * The order is the order a pilot would ask the questions in, and it matters
   * only for which sentence they get: "lift off first" is more use than
   * "mass-locked by Lodestar Yard" to someone sitting on a pier, and both are
   * true of a hull parked at berth 3.
   *
   * @returns {keyof typeof TRANSIT_REASONS | null}
   */
  transitRefusal() {
    const wid = this.worldManager?.active?.id ?? null;
    if (wid !== 'space') return this._landed ? 'landed' : 'world';
    if (this._landed) return 'landed';
    if (this.interdicted) return 'interdicted';
    const p = this.flight.position;
    if (p.distanceTo(_dockCentre) <= TRANSIT_DOCK_LOCK) return 'dock';
    /* THE SPECIFIED RULE, and `APPROACH_PHASE` is compared by RANK rather than
     * by string: `Bodies.js` publishes the ranks precisely so a caller can ask
     * "am I at least in approach" without a lookup table of its own, and a
     * three-way string comparison here would have to be re-edited the day a
     * fifth phase is added between two of them. */
    const a = approachState(p);
    if ((APPROACH_PHASE[a.phase] ?? 0) >= APPROACH_PHASE.approach) return 'approach';
    return null;
  }

  /**
   * THE BREAK RING. Must a LIVE drive be cut, here, now?
   *
   * One ring tighter than `transitRefusal` and the header explains at length
   * why: cutting at the approach ring would end 85% of the dock-to-Cinder leg
   * before it started, because that ring is 54 km from Cinder's centre and the
   * yard is 62 km. Everything else - the yard, a lock, a world with a floor in
   * it - is the same test in both directions, because none of those is
   * something the altitude law can make safe.
   *
   * Handed to `Flight` through `env.transitLock` every single step, so a ship
   * that arrives inside a ring by any route at all - a seam, a save load, a
   * debug teleport - is dropped on the next step rather than only on the frame
   * something noticed it move.
   *
   * @param {string|null} wid the active world id
   * @param {ReturnType<typeof approachState>|null} [state] the approach state
   *   `_env` has already computed this step. Reused rather than recomputed:
   *   `approachState` walks every body in the volume with a square root each,
   *   and this runs inside the fixed step.
   * @returns {keyof typeof TRANSIT_REASONS | null}
   */
  _transitBreak(wid, state = null) {
    if (!this.flight.transitLive) return null;
    if (wid !== 'space') return this._landed ? 'landed' : 'world';
    if (this._landed) return 'landed';
    if (this.interdicted) return 'interdicted';
    const p = this.flight.position;
    if (p.distanceTo(_dockCentre) <= TRANSIT_DOCK_LOCK) return 'dock';
    const a = state ?? approachState(p);
    if ((APPROACH_PHASE[a.phase] ?? 0) >= APPROACH_PHASE.atmosphere) return 'atmosphere';
    /* ── AND THE TURN-BACK BAND OF A BODY WITH NO GROUND ──────────────────
     *
     * The altitude law governs the drive by height above the nearest SURFACE,
     * and a gas giant does not have one: `approachState` measures Ceraunus's
     * altitude from its 38 km radius, so at the wall the law still reads 26 km
     * of clearance and allows the full 5,000 m/s. The `atmosphere` ring above
     * would have caught it - except that for Ceraunus that ring is at 38,000 m
     * and the wall is at 64,600, so it sits INSIDE the wall and can never
     * fire. Cut here instead, at the same band the turn-back sentence is said
     * in, which is 29 km of ordinary space before the stop. */
    if (a.body?.hull > 0 && a.distance <= a.body.hull * HULL_WARN_BAND) return 'hull';
    return null;
  }

  /** Cut a live drive. The sentence is said by `_announceTransit`, on the edge. */
  _breakTransit(code) {
    if (!this.flight.transitLive) return false;
    return this.flight.dropTransit(code);
  }

  /**
   * Z, polled the way `_pollBoard` polls F.
   *
   * A CONTROL THAT SILENTLY DOES NOTHING IS WORSE THAN ONE THAT IS NOT THERE:
   * the refusal path is the whole reason this is not three lines inside
   * `Flight.readInput`. Every press produces either a drive or a sentence.
   */
  _pollTransit() {
    if (!this.input || this.input.textCaptured) return;
    if (!this.input.pressed?.(TRANSIT_KEY)) return;
    const f = this.flight;
    /* A second press is always a DROP, whatever the rings say. A pilot who
     * wants out must never be told they may not have it - the refusal path
     * below is about starting, and only about starting. */
    if (f.transitLive) { f.dropTransit('pilot'); return; }
    const why = this.transitRefusal();
    if (why) { this._sayTransit(why); return; }
    f.engageTransit();
    this.bus?.emit?.('hud:notify', { text: 'Transit drive spinning up.', tone: 'info' });
  }

  /** One sentence from `TRANSIT_REASONS`, on the channel the HUD already draws. */
  _sayTransit(code, tone = 'warn') {
    const text = TRANSIT_REASONS[code];
    if (!text) return;
    this.bus?.emit?.('hud:notify', { text, tone });
  }

  /**
   * Publish the drive's state on the EDGE, for the audio director.
   *
   * `pilot:transit` carries the state it moved to and the spool it moved at,
   * so a listener can play a spin-up on `spooling`, a settle on `engaged` and
   * a wind-down on `dropping` without polling anything. Edge-latched because
   * `fixedUpdate` runs sixty times a second and `Sfx` would otherwise be asked
   * to start sixty overlapping voices.
   */
  _announceTransit() {
    const f = this.flight;
    const s = f.transitState;
    if (s === this._transitSaid) return;
    this._transitSaid = s;
    /* THE ONE PLACE A DROP IS EXPLAINED, and it is the edge rather than the
     * three call sites, because a drop can arrive from four directions - the
     * key, a bus event, a mass lock inside `Flight._stepTransit`, and a hard
     * `halt()` - and a sentence written at each of them is four sentences that
     * will one day disagree. `'pilot'` is the player's own key and reads as
     * information; everything else is something happening TO them. */
    if (s === 'dropping') this._sayTransit(f.transitDropReason, f.transitDropReason === 'pilot' ? 'info' : 'warn');
    this.bus?.emit?.('pilot:transit', {
      state: s,
      spool: f.transitSpool,
      reason: f.transitDropReason,
      shipId: this.shipId,
    });
  }

  /** Nothing worth colliding with inside `TRANSIT_CLEAR`. */
  _clearOfEverything() {
    /* INTERDICTION. Written by `ships/SpaceCombat.js` while a hostile wing is
     * alive, and it is the only hook this mode gives the combat system.
     *
     * Without it every encounter in the volume would be flown past at
     * 3,640 m/s before the first burst arrived - built, functional, and never
     * experienced, which is this project's signature defect wearing a new
     * costume. It is also the genre's own answer: something has a lock on you,
     * so you are in normal space until it does not. */
    if (this.interdicted) return false;
    const p = this.flight.position;
    const a = approachState(p);
    if (a.altitude < TRANSIT_CLEAR) return false;
    if (p.distanceTo(_mouth) < TRANSIT_CLEAR) return false;
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Ground contact                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * One downward probe per step: is the keel on something?
   *
   * ── IT IS A SWEPT PROBE, AND THE FIRST VERSION WAS NOT ────────────────────
   *
   * A point probe at the current position asks "is there ground within
   * TOUCH_CLEAR of where I am now", and at 130 m/s a fixed step moves the ship
   * 2.2 m - more than the 1.4 m clearance. Measured: a Dray entering Cinder's
   * air at its entry speed passed clean THROUGH the caldera floor and kept
   * going, and 200 seconds later the test found it at y -13,270. Below the
   * heightfield the downward probe misses everything, so nothing ever stopped
   * it again.
   *
   * So the probe spans the whole segment the ship travelled this step: it
   * starts above the HIGHER of the two Y values and runs past the lower one.
   * Contact is either "close enough" (normal landing) or "the segment crossed
   * the surface" (an impact that would otherwise have tunnelled).
   *
   * It is still a vertical ray and not a swept volume, because `Physics` has
   * no swept query and one raycast per step is the budget. At the worst speed
   * this can reach outside transit - 455 m/s - the horizontal gap between
   * consecutive probes is 7.6 m, which is smaller than every landform on the
   * planet. Transit, which is the only thing that moves faster, is disabled
   * inside `TRANSIT_CLEAR` of any body for exactly this reason.
   */
  _groundContact(wid) {
    if (wid === 'space') return;
    const f = this.flight;
    const prevY = this._prevY === null ? f.position.y : this._prevY;
    this._prevY = f.position.y;
    const top = Math.max(prevY, f.position.y) + 4;
    const span = top - (Math.min(prevY, f.position.y) - 60);
    const g = this.physics?.groundHeight?.(f.position.x, f.position.z, top, span);
    if (g === null || g === undefined) return;
    const clearance = f.position.y - g;
    const crossed = prevY >= g && f.position.y < g;

    /* A ship that has just lifted off is still inside its own touchdown
     * clearance. See the note in the landed branch above.
     *
     * ── ...AND A SHIP THAT IS INSIDE THE PLANET IS NOT ONE OF THOSE ─────────
     *
     * The early return here disables the landing check entirely, and `_airborne`
     * only came back when the hull climbed 3.36 m CLEAR. Go the other way
     * instead - lift off and immediately push the nose down - and the hull
     * sinks straight through the heightfield with nothing watching, because
     * clearance is now negative and can never exceed 3.36 again.
     *
     * Found by flying it. A hand-flown approach to Ashfall Flat touched down,
     * the autopilot tapped climb once to arrest a 4 m/s sink, then held
     * descend: the Kestrel went through the surface at y 8.8 and kept going -
     * -48 m, -176 m, -447 m - with `_airborne` false, `_landed` false and the
     * ground probe returning `null` because its ray now STARTS below the
     * terrain. It is recoverable, but only by a player who works out that they
     * have to hold climb for ten seconds through solid rock; measured, it took
     * 500 m of blind ascent to cross `DEPART_ALT` and pop out in space.
     *
     * So a hull that is under the SURFACE is set down on the nearest pad,
     * exactly as an impact is.
     *
     * The surface, and not `clearance`, and that distinction is measured. A
     * berthed hull in the yard sits on cradle bolsters that stand above its
     * keel origin: driven, a boarded Kestrel at y 1.20 has its ground probe
     * return 4.12, i.e. a clearance of -2.92 - which is 0.44 m from the -3.36
     * this rule would otherwise fire at, and 0.44 m is not a margin, it is a
     * coincidence. `_underTerrain` asks the HEIGHT FIELD instead, and the yard
     * has none (`physics.heightfields.length` is 0 there, and
     * `terrainHeight` returns null), so a cradle can never be mistaken for a
     * planet however the bolsters are re-cut.
     */
    if (!this._airborne) {
      if (clearance > TOUCH_CLEAR * 2.4) this._airborne = true;
      else if (this._underTerrain(f.position)) this._forceSetDown(wid, f.speed);
      return;
    }
    if (clearance > TOUCH_CLEAR && !crossed) return;

    const speed = f.speed;
    const down = -f.velocity.y;

    /* Hard arrival. Not a game over and not a bounce: the ship is put down on
     * the nearest pad and the pilot is hurt. Leaving a wreck at the bottom of a
     * ravine is the stranding this whole file exists to prevent. */
    if (speed > LAND_SPEED || down > LAND_SPEED * 0.8 || clearance < -TOUCH_CLEAR) {
      this._forceSetDown(wid, speed);
      return;
    }

    f.position.y = g + TOUCH_CLEAR * 0.5;
    f.halt();
    /* LEVEL IT. A ship keeps whatever attitude it was flying when it touched
     * down, and a pilot on final approach is nose-down - so a perfectly good
     * 8 m/s landing on the primary pad left the Kestrel standing on its tail
     * at 65 degrees off level, looking like a crash. No test caught it: the
     * hard-landing case levels through `_forceSetDown`, and a NORMAL touchdown
     * had no levelling at all. It was found by walking away from the ship and
     * turning round to look at it. */
    this._settle(f, this._yawOf(f.quaternion));
    this._setLanded(true);
    this._parked = wid === 'dock' ? 'berth' : 'ground';
    this._parkedWorld = wid;
    this._landedSite = this._siteUnder(wid, f.position);
    this.bus?.emit?.('pilot:landed', {
      shipId: this.shipId, world: wid, site: this._landedSite, speed: +speed.toFixed(2),
    });
    this.bus?.emit?.('hud:notify', {
      text: this._landedSite
        ? `Down at ${this._landedSite.name}. F to step out.`
        : 'Down on open ground. F to step out.',
      tone: 'info',
    });
  }

  /**
   * Is the hull INSIDE the world's own height field?
   *
   * Deliberately not "is there something over the keel": boxes stand over a
   * keel all the time - cradle bolsters, gantries, a hangar roof - and none of
   * them means the ship is buried. Only a heightfield is a planet's surface,
   * and only a world that has one can be flown into.
   *
   * @param {THREE.Vector3} pos
   */
  _underTerrain(pos) {
    const t = this.physics?.terrainHeight?.(pos.x, pos.z);
    if (t === null || t === undefined || !Number.isFinite(t)) return false;
    return pos.y < t - TOUCH_CLEAR * 2.4;
  }

  /** The authored landing site the ship is standing in, or null for open ground. */
  _siteUnder(wid, pos) {
    const sites = this.worldManager?.active?.landingSites;
    if (!Array.isArray(sites)) return null;
    for (const s of sites) {
      const dx = pos.x - s.position.x;
      const dz = pos.z - s.position.z;
      if (dx * dx + dz * dz <= s.radius * s.radius) return { id: s.id, name: s.name };
    }
    return null;
  }

  /**
   * An impact. Put the hull on the nearest pad, hurt the pilot, say so.
   *
   * The pad is chosen by distance rather than by "the one you came from",
   * because the pad you came from can be 700 m away across a caldera and the
   * player's mental model after a crash is "where am I now".
   */
  _forceSetDown(wid, speed) {
    const f = this.flight;
    const sites = this.worldManager?.active?.landingSites ?? [];
    let best = null;
    let bestD = Infinity;
    for (const s of sites) {
      const d = f.position.distanceTo(s.position);
      if (d < bestD) { bestD = d; best = s; }
    }

    /* The hull is LEVELLED in both branches, and there is exactly one place
     * that does it in each.
     *
     * It used to be levelled twice - once inside the pad branch and once again
     * after both branches - and the second pass was therefore dead on the only
     * path any test could reach. A mutation that deleted it stayed green,
     * which is the honest signal that it was not doing anything. One
     * `setFromEuler` per branch, with the yaw each branch actually wants: the
     * pad's own heading when there is a pad, the hull's current heading when
     * it is coming down on open ground.
     *
     * Levelling matters because a ship set down after an impact with the nose
     * 40 degrees into the dirt looks broken AND flies straight back into the
     * ground on the next take-off - which would turn the recovery into a crash
     * loop. */
    if (best) {
      this._settle(f, best.yaw ?? 0);
      f.place(_v.set(best.position.x, best.position.y + TOUCH_CLEAR * 0.5, best.position.z));
      this._landedSite = { id: best.id, name: best.name };
    } else {
      this._settle(f, this._yawOf(f.quaternion));
      const g = this.physics?.groundHeight?.(f.position.x, f.position.z, f.position.y + 40, 300);
      f.place(_v.set(f.position.x, (g ?? f.position.y) + TOUCH_CLEAR * 0.5, f.position.z));
      this._landedSite = null;
    }

    this._setLanded(true);
    this._parked = wid === 'dock' ? 'berth' : 'ground';
    this._parkedWorld = wid;

    /* THE KEYS ARE PROBABLY STILL DOWN. See SETTLE_LOCK: without this the very
     * next step lifts the hull back into whatever it just hit, and measured,
     * that turned one 20-point knock into three impacts and a death inside
     * 1.1 seconds. The assist above then takes the hull straight up when the
     * lock expires, so the recovery is a launch rather than a crash loop. */
    this._settleLock = SETTLE_LOCK;
    this._liftoff = 0;

    const hurt = clamp(Math.round((speed - LAND_SPEED) * 1.2), 6, 55);
    this.player?.applyDamage?.(hurt, null, 'impact');
    this.bus?.emit?.('pilot:impact', { shipId: this.shipId, speed: +speed.toFixed(2), damage: hurt });

    /* ── "HULL HOLDS" AND "SHOT DOWN", ONE FRAME APART ────────────────────
     *
     * This sentence used to say `Hull holds` unconditionally, and the death
     * card that follows an impact that kills says `SHOT DOWN - Lost to impact
     * over Cinder`. Both fired on the same touchdown, one frame apart, and the
     * reassurance is read first. A player told the hull held and then shown a
     * death card does not learn that they were hurt twice; they learn that the
     * game is lying to one of them.
     *
     * So the health is READ BACK after the damage is applied rather than
     * predicted: `applyDamage` owns armour, difficulty and whatever else the
     * player system decides, and a copy of that arithmetic here would be a
     * second answer to the same question. When it is fatal this says nothing
     * at all - the card is already on its way and it is specific and correct,
     * and a toast underneath it would only be competing with it. */
    const left = this.player?.health;
    const killed = typeof left === 'number' && left <= 0;
    if (!killed) {
      this.bus?.emit?.('hud:notify', {
        text: `Hard landing - ${Math.round(speed)} m/s. Hull holds`
          + `${typeof left === 'number' ? ` at ${Math.round(left)}%` : ''}`
          + `. Set down at ${this._landedSite?.name ?? 'the nearest flat'}.`,
        tone: 'warn',
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* The seams                                                           */
  /* ------------------------------------------------------------------ */

  _seams(wid, elapsed) {
    if (this._seamLock > 0 || this._travelling) return;
    const f = this.flight;

    if (wid === 'dock') {
      if (f.position.z < LAUNCH_Z) this._launch();
      return;
    }

    if (wid === 'space') {
      const a = approachState(f.position);
      if (a.shouldHandoff && a.body?.surfaceWorld) {
        this._descend(a.body);
        return;
      }
      if (f.position.distanceTo(_mouth) < DOCK_RANGE && f.speed < DOCK_SPEED) this._dock();
      return;
    }

    // A planet surface.
    const half = this.worldManager?.active?.planet?.half ?? 400;
    const out = Math.max(Math.abs(f.position.x), Math.abs(f.position.z));
    if (f.position.y > DEPART_ALT || (out > half + 60 && f.position.y > 140)) {
      this._ascend();
      return;
    }
    /* Off the edge and LOW is not a departure, it is a pilot skimming out over
     * the rim. Turn them round rather than either stranding them past the end
     * of the heightfield or firing a seam they did not ask for. The rule is
     * `MountManager._holdInBounds`'s, one world up. */
    if (out > half + 60) {
      const k = half + 60;
      if (f.position.x > k) { f.position.x = k; if (f.velocity.x > 0) f.velocity.x = 0; }
      if (f.position.x < -k) { f.position.x = -k; if (f.velocity.x < 0) f.velocity.x = 0; }
      if (f.position.z > k) { f.position.z = k; if (f.velocity.z > 0) f.velocity.z = 0; }
      if (f.position.z < -k) { f.position.z = -k; if (f.velocity.z < 0) f.velocity.z = 0; }
      /* The notify is rate-limited and the SEAM IS NOT. An early version set
       * `_seamLock` here, and `_seams` returns early while that is held - so
       * the clamp ran once and then let the ship fly free for a second and a
       * half at a time. Over 200 s of test that is 133 unclamped windows and
       * the ship ended 29 km outside an 800 m playfield. A boundary that only
       * holds one step in ninety is not a boundary. */
      if (elapsed - this._edgeSaid > 3) {
        this._edgeSaid = elapsed;
        this.bus?.emit?.('hud:notify', { text: 'Survey boundary - climb to leave orbit.', tone: 'warn' });
      }
    }
  }

  /** yard -> void. */
  _launch() {
    const f = this.flight;
    const keep = f.speed;
    this._travel('space', () => {
      /* The mouth is at z -104 in the yard and z -18 in the void, because one
       * is an opening in a shed and the other is a 285 m structure seen from
       * outside. Carrying the raw Z across would put the ship inside a pier. */
      _v.copy(_mouth).addScaledVector(_normal, SPACE_ARRIVAL_OUT);
      _v.x += clamp(f.position.x, -90, 90);
      _v.y += clamp(f.position.y, -40, 60);
      _e.set(0, 0, 0);
      f.quaternion.setFromEuler(_e);
      f.place(_v);
      /* Momentum survives the seam. A launch that arrived at a dead stop would
       * be the loading screen this design is trying not to be. */
      f.velocity.copy(_normal).multiplyScalar(Math.max(keep, 40));
    });
    this.bus?.emit?.('pilot:launched', { shipId: this.shipId });
  }

  /** void -> planet surface. */
  _descend(body) {
    const target = this._resolveSurfaceWorld(body.surfaceWorld);
    if (!target) {
      /* Named a world nobody registered. Say it out loud rather than silently
       * bouncing off an atmosphere forever - that is the exact shape of the
       * built-but-unreachable defect this project keeps shipping. */
      console.error(`[Piloting] ${body.id} names surfaceWorld "${body.surfaceWorld}", which is not a registered world`);
      this.bus?.emit?.('hud:notify', { text: `${body.name} has no surface to land on.`, tone: 'warn' });
      this._seamLock = 6;
      return;
    }
    const keep = clamp(this.flight.speed, 45, 130);
    this._travel(target, () => {
      const w = this.worldManager?.active;
      const pad = w?.landingSites?.find((s) => s.primary) ?? w?.landingSites?.[0] ?? null;
      const px = pad ? pad.position.x : 0;
      const pz = pad ? pad.position.z : 0;
      const py = pad ? pad.position.y : 0;
      /* Entry is a slanting approach, not a drop: ENTRY_OUT metres short of the
       * pad and ENTRY_ALT above it, nose already on the pad. At 90 m/s that is
       * about eight seconds of flying down through the ash with the caldera
       * filling the frame, which is the descent the brief asks for.
       *
       * ── THE RUN-IN POINTS INWARD, AND THE FIRST VERSION DID NOT ──────────
       * It was `pz + ENTRY_OUT`: 500 m along +Z from a pad at z 205, which on
       * a playfield with `half` 400 is 305 m OUTSIDE the world. The seam that
       * fires when a ship leaves the survey area fired on the first step, and
       * every descent bounced straight back into orbit having never seen the
       * planet. Measured: entry to departure in 2.5 s, having travelled
       * nowhere.
       *
       * So the run-in comes from the direction of the playfield CENTRE and is
       * clamped to stay inside it. That also reads better: you fly in over the
       * middle of the map toward a pad near its edge, rather than in from
       * outside past terrain that stops existing. */
      const w2 = this.worldManager?.active;
      const half = w2?.planet?.half ?? 400;
      const inward = Math.hypot(px, pz) > 1 ? 1 / Math.hypot(px, pz) : 0;
      const dx = inward ? -px * inward : 0;
      const dz = inward ? -pz * inward : 1;
      const lim = half - 60;
      _v.set(
        clamp(px + dx * ENTRY_OUT, -lim, lim),
        py + ENTRY_ALT,
        clamp(pz + dz * ENTRY_OUT, -lim, lim)
      );
      _v2.set(px, py, pz);
      this._faceAlong(_v, _v2);
      this.flight.place(_v, _q);
      this.flight.velocity.copy(_v2).sub(_v).normalize().multiplyScalar(keep);
    });
    this.bus?.emit?.('pilot:entry', { body: body.id, world: target });
  }

  /** planet surface -> void. */
  _ascend() {
    const bodyId = this._bodyForWorld(this.worldManager?.active?.id ?? null);
    const body = bodyId ? BODY_BY_ID[bodyId] : null;
    const keep = clamp(this.flight.speed, 60, 260);
    this._travel('space', () => {
      if (!body) {
        _v.copy(_mouth).addScaledVector(_normal, SPACE_ARRIVAL_OUT);
        this._faceAlong(_v, _mouth);
        this.flight.place(_v, _q);
        this.flight.velocity.set(0, 0, 0);
        return;
      }
      /* Out along the line home. Two reasons and both are the player's: the
       * atmosphere is behind you rather than in front (so `approachState` does
       * not hand you straight back down - the arrival is 900 m outside
       * `body.atmosphere`), and the yard is dead ahead, which is what "you can
       * always get back" means in practice rather than in a test. */
      _v2.set(body.position[0], body.position[1], body.position[2]);
      _v.copy(_mouth).sub(_v2).normalize().multiplyScalar(body.atmosphere + 900).add(_v2);
      this._faceAlong(_v, _mouth);
      this.flight.place(_v, _q);
      this.flight.velocity.copy(_mouth).sub(_v).normalize().multiplyScalar(keep);
    });
    this.bus?.emit?.('pilot:orbit', { body: bodyId });
  }

  /** void -> yard, and out of the seat. */
  _dock() {
    const shipId = this.shipId;
    this._travel('dock', () => {
      this._placeAtBerth(shipId);
      this._parked = 'berth';
      this._parkedWorld = 'dock';
      this._landedSite = null;
    }, () => {
      const earned = this.sellCargo();
      this.disembark({ silent: true, force: true });
      this.bus?.emit?.('hud:notify', {
        text: earned > 0
          ? `Docked. Hold sold for ${earned} credits.`
          : 'Docked at Lodestar Yard.',
        tone: 'info',
      });
      this.bus?.emit?.('pilot:docked', { shipId, earned });
    });
  }

  /**
   * The one world-swap path, and the reason there is only one.
   *
   * Three steps, always in this order: read whatever is needed from the frame
   * being LEFT (the caller has already done that, in the closure it captured),
   * activate, then write the pose in the frame ARRIVED in. `place` runs after
   * `activate` resolves, so it sees the new world's `landingSites`,
   * `planet.half` and colliders rather than the old world's.
   *
   * `_travelling` gates `fixedUpdate` for the duration: the activation is
   * asynchronous and yields frames, and an integrator that kept stepping
   * through a world swap would fly the ship several hundred metres inside
   * whatever was being torn down.
   */
  _travel(worldId, place, after = null) {
    const wm = this.worldManager;
    if (!wm || this._travelling) return;
    this._travelling = true;
    this._seamLock = SEAM_COOLDOWN;
    this.flight.halt();
    this.bus?.emit?.('pilot:travelling', { to: worldId });

    Promise.resolve()
      .then(() => wm.activate(worldId))
      .then(() => {
        try { place(); } finally { this._travelling = false; }
        /* The swept ground probe compares this step's Y with last step's, and
         * last step happened in a different world. Forget it, or the first
         * probe after a seam spans two frames of reference and reports a
         * crossing that never happened. */
        this._prevY = null;
        this._airborne = true;
        this._poseModel();
        this._seatPlayer();
        after?.();
      })
      .catch((err) => {
        this._travelling = false;
        console.error(`[Piloting] transition to "${worldId}" failed:`, err);
        this.bus?.emit?.('hud:notify', { text: 'Navigation failure - returning to the yard.', tone: 'warn' });
        this._recoverToBerth();
      });
  }

  /* ------------------------------------------------------------------ */
  /* Frame - input, camera, model                                        */
  /* ------------------------------------------------------------------ */

  update(dt, elapsed) {
    /* Before anything else, and OUTSIDE the `_active` gate: a ship the player
     * has walked away from is still standing on the ground and still has to be
     * solid. Six float compares and a return when nothing has moved. */
    this._syncHullSolid();
    if (!this._active) {
      this._pollBoard();
      return;
    }
    this._pollLeave();
    if (!this._active) return;

    /* `readInput` takes the FRAME delta and `step` takes the FIXED one - the
     * virtual mouse stick is a per-frame quantity, exactly as `Player` consumes
     * look per frame. Getting these the wrong way round is a stick that
     * self-centres at the wrong rate on every machine but this one. */
    if (this.input && !this.input.textCaptured) this.flight.readInput(this.input, dt);
    else this.flight.setCommand({ pitch: 0, yaw: 0, roll: 0, throttle: 0, vertical: 0, boost: false, brake: false });

    /* AFTER `readInput`, because the drive is a latch and not a command:
     * `readInput` overwrites the whole command struct every frame and would
     * wipe anything the drive had written into it. It is polled here rather
     * than inside `readInput` because refusing needs `Bodies.js`, which
     * `Flight` deliberately does not import - see `TRANSIT_KEY`. */
    this._pollTransit();

    this._takeBody();
    this._poseModel();
    this._composeCamera(dt);
    void elapsed;
  }

  /** F boards whatever you are standing at; the prompt is published either way. */
  _pollBoard() {
    const id = this.boardableAt();
    if (id !== this._boardPrompt) {
      this._boardPrompt = id;
      this.bus?.emit?.('pilot:prompt', {
        /* `source` NAMES THE SLOT, and it is not decoration.
         *
         * Two systems publish on this channel - this one and `Mining` - and
         * both were edge-latched on their own state, so whichever wrote last in
         * a frame owned the line. `mining.update` runs after `piloting.update`
         * (`main.js`), and `Mining._setPrompt(null)` fires the moment you step
         * off a seam. Measured with the ship landed 16 m from a sulfur seam:
         * 7.3 m from the hull the prompt read "[F] Board the Kestrel"; at the
         * node it read "[E] Work the Sulfur Crust"; walking BACK to 5 m from
         * the hull it read nothing at all, and stayed empty, while
         * `boardableAt()` said `kestrel` the whole time. F still worked and
         * nothing said so. The overlap is guaranteed, not unlucky: boarding
         * radius is 16.2 m for a Kestrel and `MINE_RANGE` is 3.2 m.
         *
         * With a slot each, clearing one cannot clear the other. */
        source: 'board',
        /* The NAME, not the id. `_models` is empty until a hull has been
         * boarded once, so reading the display name off the model made the
         * very first prompt a player ever sees say "Board the kestrel". */
        text: id ? `Board the ${this.hullName(id)}` : null,
        key: 'F',
      });
    }
    if (!id || !this.input || this.input.textCaptured) return;
    if (this.input.pressed?.('KeyF')) this.board(id);
  }

  _pollLeave() {
    if (this._boardPrompt !== null) {
      this._boardPrompt = null;
      this.bus?.emit?.('pilot:prompt', { source: 'board', text: null, key: 'F' });
    }
    if (!this.input || this.input.textCaptured) return;
    if (this.input.pressed?.('KeyF')) this.disembark();
  }

  /**
   * The chase camera, composed from the FLIGHT quaternion rather than from a
   * yaw and a pitch.
   *
   * That is the whole difference between this and `CameraRig._composeThird`,
   * and it is why the rig is not reused. A boom built from Euler angles has no
   * roll: fly a barrel roll and the ship rotates inside a level frame, which
   * reads as the model spinning rather than as the player rolling. Copying the
   * quaternion carries all three axes, so the horizon rolls with you - and the
   * galactic band, which `SpaceWorld` put in the sky specifically to be the
   * thing you orient against, does its job.
   */
  _composeCamera(dt) {
    const cam = this.camera;
    if (!cam) return;
    const f = this.flight;
    f.cameraRig(CONFIG.render?.fov ?? 75, _rig);

    /* THE BOOM IS SCALED BY THE HULL, AND IT HAS TO BE.
     *
     * `Flight.cameraRig` returns 12 -> 21 m of chase and 3.2 m of lift, and
     * those are hull-agnostic by design: the flight model does not know what
     * shape is bolted to it. Applied raw to a real hull they are wrong in both
     * axes, and the first browser screenshot showed exactly how - 12 m behind
     * the KEEL ORIGIN of a 14 m Kestrel is six metres behind her transom, and
     * 3.2 m of lift is below a spine that stands at 5.16, so the frame was
     * filled with the underside of two engine pods and nothing else. On the
     * 28 m Dray it would be worse.
     *
     * So the boom grows with the hull's length and lifts with its spine. Both
     * fractions were chosen by looking at all three hulls in the browser, not
     * derived: 0.55 of length puts the whole ship in frame with room around it
     * at every speed, and 0.65 of spine height looks down the deck rather than
     * along the belly.
     */
    const len = this._model?.length ?? 14;
    const spine = this._model?.spineY ?? 5;
    const dist = _rig.distance + len * CHASE_LENGTH_FRAC;
    const lift = _rig.height + spine * CHASE_SPINE_FRAC;

    f.forward(_fwd);
    f.up(_up);
    cam.position.copy(f.position)
      .addScaledVector(_fwd, -dist)
      .addScaledVector(_up, lift);

    /* AIMED AHEAD OF THE SHIP, NOT ALONG ITS NOSE.
     *
     * Copying the flight quaternion straight onto the camera points it exactly
     * where the nose points - which, from a camera that is above and behind,
     * leaves the ship pinned to the bottom edge of the frame with the whole
     * upper half empty. Looking at a point `CHASE_LOOK` metres ahead of the
     * hull tips the view down by just enough to sit the ship in the lower
     * third and put what it is flying towards in the rest.
     *
     * `cam.up` is the SHIP's up, not world up, which is what keeps the roll.
     * That is the entire reason this camera exists instead of `CameraRig`'s
     * boom: a barrel roll has to roll the horizon, not spin the model. */
    _v.copy(f.position).addScaledVector(_fwd, CHASE_LOOK);
    cam.up.copy(_up);
    cam.lookAt(_v);

    /* The FOV kick is damped rather than written raw: `_rig.fov` tracks speed
     * exactly, and speed changes by 90 m/s in a second under boost. Undamped
     * that is a lens that breathes. 6/s matches `Player._applyFov`'s 9 closely
     * enough to feel like the same camera and is slower because the range is
     * three times as wide (75 -> 94 against 75 -> 81.5). */
    const next = THREE.MathUtils.damp(this._fov, _rig.fov, 6, dt);
    if (Math.abs(next - cam.fov) > 0.01) {
      this._fov = next;
      cam.fov = next;
      cam.updateProjectionMatrix();
    }
  }

  _poseModel() {
    const m = this._model;
    if (!m) return;
    m.group.position.copy(this.flight.position);
    /* The hull's nose is +Z and the flight frame's is -Z. See ShipModel.NOSE_YAW. */
    _q2.setFromAxisAngle(_up.set(0, 1, 0), NOSE_YAW);
    m.group.quaternion.copy(this.flight.quaternion).multiply(_q2);
    /* AND THE ENGINES. This used to be the whole of the function, and a hull
     * under full burn was pixel-identical at the nozzles to one on a cradle:
     * throttle, boost, airbrake and reverse all looked the same from the seat.
     *
     * Reverse burns too - the engine is doing work either way, and a ship that
     * goes dark when you back it off a pad reads as broken - but at less than
     * half, because the retro bells are not these ones. `_landed` forces it to
     * idle so a ship standing at a berth is not blowtorching the shed. */
    if (m.setThrust) {
      const c = this.flight.command;
      const th = Math.abs(c.throttle ?? 0) * (c.throttle < 0 ? 0.45 : 1);
      m.setThrust(this._landed ? 0 : th + (c.boost ? 0.6 : 0) + Math.abs(c.vertical ?? 0) * 0.25);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Body handover                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Take the player's body and camera.
   *
   * Re-asserted every frame rather than set once. Two things clear these from
   * underneath us: `Player.teleport` (which `WorldManager._activate` calls on
   * every world change, and which calls `_releaseMovement`) and the dev
   * harness's `freezeCamera(false)`. Both are legitimate; re-asserting is
   * cheaper and more robust than making either of them know about this mode.
   */
  _takeBody() {
    const p = this.player;
    if (!p) return;
    p.movementOverride = true;
    /* No capsule solve. A 0.35 m capsule resolved at a 14 m hull's keel origin
     * would eject the SHIP from the hangar it is legitimately flying inside. */
    p.movementOverrideCollide = false;
    /* THE MOUSE BELONGS TO THE SHIP, AND SAYING SO IS WHAT MAKES IT STEER.
     *
     * `Flight.readInput` calls `input.consumeLook()` from `piloting.update`,
     * which `main.js` runs AFTER `player.update` - and `consumeLook` zeroes
     * what it returns. So without this flag the player controller took the
     * whole mouse delta every frame and threw it away (it is `_harnessFrozen`,
     * so it does not use it either), and the ship's pitch and yaw were exactly
     * zero for the entire drop. You could throttle and boost and brake; you
     * could not turn.
     *
     * `Player.movementOverrideLook` already existed for precisely this - "let a
     * driver own yaw/pitch entirely instead of taking mouse-look from here" -
     * and had no writer anywhere in the game. This is it. Cleared in
     * `_giveBody`, so an ordinary walk gets its mouse back. */
    p.movementOverrideLook = false;
    p._harnessFrozen = true;
    const a = this.avatar ?? p.avatar ?? null;
    a?.setVisible?.(false);
    if (this.cameraRig && this._prevMode === null) this._prevMode = this.cameraRig.mode ?? null;
  }

  _giveBody() {
    const p = this.player;
    if (p) {
      p.movementOverride = false;
      p.movementOverrideCollide = true;
      /* Back to the default. See the note in `_takeBody`. */
      p.movementOverrideLook = true;
      p._harnessFrozen = false;
    }
    const a = this.avatar ?? p?.avatar ?? null;
    a?.setVisible?.(true);
    const cam = this.camera;
    if (cam) {
      cam.fov = CONFIG.render?.fov ?? 75;
      cam.updateProjectionMatrix();
    }
    this._fov = CONFIG.render?.fov ?? 75;
    if (this.cameraRig && this._prevMode) this.cameraRig.setMode?.(this._prevMode);
    this._prevMode = null;
  }

  /**
   * The player rides at the ship's origin.
   *
   * Not the cockpit: the origin is what every downstream system wants. The
   * audio listener, `LightRig`'s ranking, the world's own LOD bands, the
   * minimap and `SaveGame` all read `player.position`, and a listener offset
   * three metres forward of the hull would pan the engines. The camera is
   * composed separately and is the only thing that needs the chase offset.
   */
  _seatPlayer() {
    const p = this.player;
    if (!p) return;
    p.position.copy(this.flight.position);
    p.velocity?.copy?.(this.flight.velocity);
    /* Keep the on-foot yaw pointed the way the ship is, so a disembark does not
     * spin the player round to face wherever they were looking before boarding. */
    if (typeof p.setYaw === 'function') p.setYaw(this._yawOf(this.flight.quaternion));
  }

  /* ------------------------------------------------------------------ */
  /* Cargo                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Put a mineral node in the hold.
   *
   * Refuses when the hold is full, and refuses BEFORE anything is consumed -
   * `MountSkins.js` records the ordering rule and it is the same one here: a
   * node must never be removed from the world with nowhere for it to land.
   *
   * @param {{type:string,name:string,credits:number,size?:number}} node
   * @returns {{ok:boolean, reason?:string, units?:number}}
   */
  stow(node) {
    if (!node?.type) return { ok: false, reason: 'no-node' };
    if (!this.shipId) return { ok: false, reason: 'no-ship' };
    /* One cubic metre per node, times its own size. A tephra nodule and a
     * 260-credit iridite seam are not the same volume, and a hold that ignored
     * that would make the Dray's 40 m3 meaningless. */
    const units = Math.max(1, Math.round((node.size ?? 1) * 1.6));
    if (this._cargoUnits + units > this.cargoCapacity) {
      return { ok: false, reason: 'hold-full', units };
    }
    const row = this._cargo[node.type] || (this._cargo[node.type] = { units: 0, credits: 0, name: node.name ?? node.type });
    row.units += units;
    row.credits += Math.max(0, Math.round(node.credits ?? 0));
    this._cargoUnits += units;
    this.bus?.emit?.('pilot:cargo', {
      units: this._cargoUnits, capacity: this.cargoCapacity, value: this.cargoValue,
    });
    return { ok: true, units };
  }

  /** Empty the hold into the ledger. Returns the credits paid. */
  sellCargo() {
    const value = this.cargoValue;
    if (value <= 0) return 0;
    this.economy?.add?.(value, 'ore');
    for (const k in this._cargo) delete this._cargo[k];
    this._cargoUnits = 0;
    this.bus?.emit?.('pilot:cargo', { units: 0, capacity: this.cargoCapacity, value: 0 });
    return value;
  }

  /* ------------------------------------------------------------------ */
  /* Navigation                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Everything the HUD needs to keep a pilot oriented, as plain numbers.
   *
   * The yard is ALWAYS the first row and is never conditional on distance,
   * phase, world or whether it is on screen. A player who cannot find home is
   * stranded just as surely as one who cannot take off, and this is the readout
   * that makes that impossible.
   */
  navReport(out = null) {
    const rows = out ?? [];
    rows.length = 0;
    const wid = this.worldManager?.active?.id ?? null;
    if (wid !== 'space') return rows;
    const p = this.flight.position;
    const vel = this.flight.velocity;
    this.flight.forward(_fwd);
    this.flight.up(_up);
    this.flight.right(_right);
    for (const t of navTargets()) {
      _v.set(t.position[0], t.position[1], t.position[2]);
      const range = _v.distanceTo(p);
      _v2.copy(_v).sub(p).normalize();
      /* CLOSING SPEED, not speed: the component of the velocity that is
       * actually shortening the range. A ship doing 5,000 m/s across a
       * target's bearing is not arriving at all, and `range / speed` would
       * cheerfully report that it lands in forty seconds.
       *
       * `_v2` is already the unit vector to the target, so this is one dot and
       * no allocation - which is what lets the ETA live on every row instead
       * of on a "selected target" that this readout has never had. The
       * selection the HUD draws is `ahead`, and it is already published below;
       * building a second one here would be a second thing to keep in step. */
      const closing = vel.dot(_v2);
      rows.push({
        id: t.id,
        name: t.name,
        kind: t.kind,
        range,
        closing,
        /* Seconds, or null when nothing is closing. Null and not Infinity:
         * `Infinity` formats as "Infinity" in a template string and looks like
         * a bug on the HUD, and a caller that wants to draw a dash has to test
         * for it either way. The 0.5 m/s floor stops a ship drifting sideways
         * from publishing a four-hour ETA that ticks backwards. */
        eta: closing > 0.5 ? range / closing : null,
        /* Signed dot with the nose: 1 dead ahead, -1 dead astern. A bearing in
         * degrees would need a plane to measure in, and there is no horizon out
         * here to pick one. */
        ahead: _v2.dot(_fwd),
        above: _v2.dot(_up),
        /* All THREE axes, not two.
         *
         * The glyph the HUD draws only needs ahead/above, and an early version
         * published only those - which is a readout you cannot actually fly on,
         * because "not ahead and not above" does not say which way to turn.
         * `piloting-return.test.mjs` flies twelve homeward legs using nothing
         * but these three numbers, so if one of them goes missing the case that
         * proves you can always get home stops being able to pass. */
        right: _v2.dot(_right),
      });
    }
    rows.sort((a, b) => a.range - b.range);
    // Home first, always, whatever the ranking says.
    const home = rows.findIndex((r) => r.id === DOCK_ANCHOR.id);
    if (home > 0) rows.unshift(rows.splice(home, 1)[0]);
    return rows;
  }

  /** Speed, boost, altitude and phase, for the flight HUD. One read, no alloc. */
  report(out = {}) {
    this.flight.snapshot(_snap);
    out.active = this._active;
    out.shipId = this.shipId;
    out.name = this._models.get(this.shipId)?.displayName ?? this.shipId;
    out.speed = _snap.speed;
    out.cruiseTop = _snap.cruiseTop;
    out.boostTop = _snap.boostTop;
    out.boosting = _snap.boosting;
    out.boostFuel = _snap.boostFuel;
    out.transit = this._transit;
    /* The DRIVE, which is not the multiplier above. See the header. */
    out.transitState = _snap.transitState;
    out.transitSpool = _snap.transitSpool;
    out.transitCap = _snap.transitCap;
    out.transitTop = _snap.transitTop;
    /* What would happen if the player pressed Z right now: null means "it
     * would work". Published so the HUD can grey the row rather than waiting
     * for the pilot to press a key and be told no. */
    out.transitRefusal = this._active ? this.transitRefusal() : 'world';
    out.landed = this._landed;
    out.world = this.worldManager?.active?.id ?? null;
    out.cargoUnits = this._cargoUnits;
    out.cargoCap = this.cargoCapacity;
    out.cargoValue = this.cargoValue;
    out.noSurface = false;
    out.hullClear = null;
    if (out.world === 'space') {
      const a = approachState(this.flight.position);
      out.bodyName = a.body?.name ?? null;
      out.altitude = a.altitude;
      out.phase = a.phase;
      out.atmoDepth = a.atmoDepth;
      /* WHAT THE NEAREST BODY IS FOR, published because the HUD cannot ask.
       *
       * The readout used to print `Ceraunus - ALT 0 m - ATMOSPHERE` while the
       * ship was thirty-seven kilometres INSIDE a gas giant, and the objective
       * line one panel over said "fly in until the readout says APPROACH, then
       * descend". Two true-looking rows inviting a descent onto a body that
       * has no ground. `noSurface` is what lets the phase read NO SURFACE
       * instead, and `hullClear` is how far there is left before the hull
       * stops - the number a pilot can actually act on. */
      out.noSurface = !!a.body && !a.body.surfaceWorld;
      out.hullClear = Number.isFinite(a.hullClear) ? a.hullClear : null;
    } else {
      const g = this.physics?.groundHeight?.(this.flight.position.x, this.flight.position.z, this.flight.position.y + 4, 600);
      out.bodyName = this.worldManager?.active?.displayName ?? null;
      out.altitude = g === null || g === undefined ? null : this.flight.position.y - g;
      out.phase = this._landed ? 'landed' : 'surface';
      out.atmoDepth = 0;
    }
    /**
     * Rate of descent, positive DOWN, and the number the touchdown test is
     * actually made against.
     *
     * `_groundContact` refuses a landing when `down > LAND_SPEED * 0.8` -
     * 20.8 m/s - and nothing on the HUD said so or showed the number. Holding
     * C from 121 m over the pad reached 70 m/s down in 1.4 s (vertical thrust
     * is roughly 50 m/s^2 ON TOP of gravity, and there is no flare or hover
     * hold), so a first attempt at "press descend" is a crash, and each crash
     * costs up to 55 hp and teleports the hull to the nearest pad - twice, that
     * was the ship-only Rimhold Shelf, 130 m and 540 m from where I was aiming.
     * Two crashes inside the regen window is a death.
     *
     * It IS landable by hand - a -11 / -5 / -2 m/s profile put a Kestrel down
     * at 4.08 m/s with no damage - so the instrument is the whole fix.
     * `descentLimit` is published beside it rather than duplicated in the HUD,
     * because a warning threshold that drifts from the rule it warns about is
     * worse than none.
     */
    out.descent = -this.flight.velocity.y;
    out.descentLimit = LAND_SPEED * 0.8;
    /**
     * ...AND THE OTHER HALF OF THE TOUCHDOWN RULE, WHICH WAS NEVER PUBLISHED.
     *
     * `_groundContact` refuses a landing on EITHER `speed > LAND_SPEED` or
     * `down > LAND_SPEED * 0.8`, and only the second of the two had a number
     * on screen. That is why six landings out of six were "hard": a pilot
     * flying the descent rate perfectly still arrives at 78 m/s of GROUND
     * speed, fails the first test, and is told they landed hard with no idea
     * which of the two numbers they missed. Both are published, both are drawn
     * beside their limits, and neither is duplicated in the HUD.
     */
    out.touchdownSpeed = LAND_SPEED;

    /**
     * THE PAD YOU ARE ABOUT TO BE COMMITTED TO.
     *
     * Seven of the ten worlds have a landing site you can walk off and never
     * climb back onto, and they are exactly the exotic-seam pads - the ones
     * worth flying to. `PlanetWorld` measures each disc's rim by marching the
     * height field around it and publishes `drop: { deg, metres }`, and until
     * this line nothing anywhere read it. A pilot on final has no way to know
     * whether the disc under them is a clearing or a shelf until they are
     * standing on it, which is one step too late.
     *
     * Named while AIRBORNE and inside `PAD_HINT_RANGE`, which is the window in
     * which going round is still a decision.
     */
    out.padName = null;
    out.padRimDeg = null;
    out.padDrop = null;
    if (!this._landed && out.world !== 'space') {
      const sites = this.worldManager?.active?.landingSites;
      if (Array.isArray(sites)) {
        let best = null;
        let bestD = PAD_HINT_RANGE * PAD_HINT_RANGE;
        for (const site of sites) {
          const dx = this.flight.position.x - site.position.x;
          const dz = this.flight.position.z - site.position.z;
          const d = dx * dx + dz * dz;
          if (d < bestD) { bestD = d; best = site; }
        }
        if (best) {
          out.padName = best.name;
          const deg = best.drop?.deg;
          const metres = best.drop?.metres;
          if (Number.isFinite(deg) && Number.isFinite(metres)
            && (deg >= PAD_EXPOSED_DEG || metres >= PAD_EXPOSED_DROP)) {
            out.padRimDeg = deg;
            out.padDrop = metres;
          }
        }
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle hazards                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Somebody else is changing world underneath us.
   *
   * Three cases, and the third is the one that matters:
   *   - we asked for it (`_travelling`): nothing to do, `_travel` owns the pose.
   *   - not flying: nothing to do.
   *   - somebody ELSE asked for it while we were flying - a portal, a debug
   *     console, a save load. The ship cannot come; it goes back to its berth
   *     and the player is handed their body back before the swap completes, so
   *     they arrive on foot rather than arriving as a ship in a world with no
   *     space in it.
   */
  _onWorldChanging(e) {
    if (this._travelling || !this._active) return;
    const to = e?.to ?? null;
    if (to && (FLIGHT_WORLDS.includes(to) || this._bodyForWorld(to))) return;
    this.bus?.emit?.('hud:notify', { text: 'Ship left at the yard.', tone: 'info' });
    this._recoverToBerth();
  }

  _onWorldChanged() {
    /* The world swap took its colliders with it, ours included. Forget them
     * without trying to unregister from a `Physics` that has been cleared, then
     * let the sync decide whether this world wants them back. */
    this._clearHullSolid();
    this._syncHullSolid();
    if (!this._active) {
      /* Not flying, but the parked hull's visibility is per-world state: the
       * yard rebuilds its own group on activation and the hull we hid is a
       * fresh object. Re-apply on arrival. */
      if (this._parked === 'berth' && this.shipId) this._showParkedHull(this.shipId, true);
      return;
    }
    this._takeBody();
    this._poseModel();
  }

  /**
   * Died in the seat. The hull goes home - AND SO DOES THE PILOT.
   *
   * The second half is not decoration, it is the fix for a permanent stranding
   * that this file's own header claims cannot happen.
   *
   * `_recoverToBerth` sets `_parked = 'berth'`, `_parkedWorld = 'dock'` and
   * teleports the hull to the yard. `Player.respawn` then teleports the BODY to
   * `_spawnPosition`, which is an anchor in the world the player died in. On a
   * planet that leaves a body standing on a volcano with:
   *
   *   - no ship (it is 600 km away at a berth),
   *   - no portal (`PlanetWorld` publishes `portalSpecs: []`),
   *   - no "return" in the pause menu, and
   *   - `boardableAt()` returning null, so not even a prompt.
   *
   * Driven: world `cinder`, player on foot at (330.4, 13.0, 354.8), hull at the
   * berth (-68, 1.2, -143), 0 portals. There is no in-session escape, and it
   * survives a save - `serialize` writes `world:'cinder'`, `parked:'berth'`,
   * and `deserialize` re-parks the hull at the yard on load. It is reachable by
   * a real player path: `_forceSetDown` deals up to 55 hp and two hard landings
   * inside the regen window kill you.
   *
   * So the world change is part of the recovery. The notification already says
   * the autopilot took the hull to the yard; taking the pilot with it is the
   * only reading of that sentence which is not a lie. `worldManager.activate`
   * teleports the player to the yard's arrival anchor, and because `teleport`
   * anchors by default that becomes the `_spawnPosition` the respawn 3.2 s
   * later lands on.
   *
   * It does NOT go through `_travel`: the body has already been handed back
   * synchronously by `_recoverToBerth`, and `_travel` would re-seat it.
   */
  _onDied(killerId = null) {
    if (!this._active) return;
    const wid = this.worldManager?.active?.id ?? null;

    /* ── BEING SHOT DOWN NOW COSTS THE HOLD ────────────────────────────────
     *
     * It cost nothing at all. `_recoverToBerth` never touched `_hold`, so a
     * Dray carrying 1,894 credits of iridite was shot down over Cinder and
     * arrived at the berth with `{"iridite":{"units":10,"credits":1894}}`
     * intact and the credit balance unchanged. With a kill counter that only
     * increments, no repair bill and a self-charging gun, the optimal play for
     * the kill ladder was to attack recklessly: death was a free, instant
     * fast-travel to the one place you wanted to be.
     *
     * The un-banked hold is the right thing to charge, and it is the ONLY
     * thing charged. It is:
     *   - the thing the player chose to risk. Ore pays nothing until it is
     *     sold at the yard, so "push on for one more seam or fly home" is the
     *     single real decision mining has, and it was a decision with no
     *     downside on either side.
     *   - proportional. A pilot flying empty loses nothing; a pilot 40 m3 deep
     *     over a volcano loses a trip.
     *   - already legible. `pilot:cargo` drives a hold readout the player has
     *     been watching climb the whole flight.
     *
     * Banked credits, the ship, the hulls, the refits and the ladders are all
     * untouched. This is a lost cargo, not a punishment.
     */
    const lost = this.cargoValue;
    const lostUnits = this._cargoUnits;
    if (lostUnits > 0) {
      for (const k in this._cargo) delete this._cargo[k];
      this._cargoUnits = 0;
      this.bus?.emit?.('pilot:cargo', { units: 0, capacity: this.cargoCapacity, value: 0 });
    }

    /* ── AND IT SAYS SO ────────────────────────────────────────────────────
     *
     * The entire death experience was one `warn` toast reading "Autopilot
     * returned the hull to Lodestar Yard." Driven cold, three sessions ended
     * with the tester standing in the yard with no idea why; integrity read
     * 100 on the last check before it happened. No death screen, no "shot
     * down", no cause.
     *
     * `pilot:downed` carries the whole story - where, what killed you, what
     * it cost - and `FlightHUD` draws it as a card that stays up until it is
     * dismissed. A toast that expires is not an explanation.
     */
    this.bus?.emit?.('pilot:downed', {
      shipId: this.shipId,
      hullName: this.hullName(this.shipId),
      world: wid,
      place: this.worldManager?.active?.displayName ?? null,
      killer: killerId,
      lostCredits: lost,
      lostUnits,
    });
    this._recoverToBerth();
    if (!wid || wid === 'dock') return;
    const wm = this.worldManager;
    Promise.resolve()
      .then(() => wm?.activate?.('dock'))
      .catch((err) => {
        console.error('[Piloting] recovery to the yard failed:', err);
      });
  }

  /**
   * The unconditional way home. Used by every failure path.
   *
   * It does NOT go through `_travel`: this runs when something has already gone
   * wrong, and a recovery that can itself fail asynchronously is not a
   * recovery. The body is handed back synchronously, first, so the player is
   * never left with `movementOverride` raised and no ship writing their
   * position - which is a player who cannot move at all.
   */
  _recoverToBerth() {
    const shipId = this.shipId;
    this._active = false;
    this._travelling = false;
    this._clearHullSolid();
    this._giveBody();
    this._parked = 'berth';
    this._parkedWorld = 'dock';
    this._landedSite = null;
    this._placeAtBerth(shipId);
    if (this._model) this._model.group.visible = false;
    this._showParkedHull(shipId, true);
    this.bus?.emit?.('pilot:left', { shipId, world: this.worldManager?.active?.id ?? null, reason: 'recovered' });
  }

  /* ------------------------------------------------------------------ */
  /* Persistence                                                         */
  /* ------------------------------------------------------------------ */

  serialize() {
    const f = this.flight;
    return {
      shipId: this.shipId,
      aboard: this._active,
      world: this.worldManager?.active?.id ?? null,
      /* A ship in flight is parked on NOTHING, whatever it was last resting on.
       * Recording a stale 'berth' here is what let a mid-flight save restore
       * to the cradle. */
      parked: this._active && !this._landed ? null : this._parked,
      parkedWorld: this._parkedWorld,
      landed: this._landed,
      site: this._landedSite?.id ?? null,
      pos: [f.position.x, f.position.y, f.position.z],
      quat: [f.quaternion.x, f.quaternion.y, f.quaternion.z, f.quaternion.w],
      cargo: JSON.parse(JSON.stringify(this._cargo)),
      /* Every hull's hold, not just the one in the seat. `cargo` above stays
       * for the hull that is selected, so a save written before holds were
       * per-hull still loads its ore into the ship it was carried in. */
      holds: (() => {
        const out = Object.create(null);
        for (const [id, h] of this._holds) {
          if (!id || !h.units) continue;
          out[id] = JSON.parse(JSON.stringify(h.cargo));
        }
        return out;
      })(),
    };
  }

  /**
   * Restore. Runs AFTER the world has been activated and the player placed -
   * `SaveGame._restoreProgress` is the last step of a load for exactly this
   * reason, and a ship boarded before its world exists is a ship at the origin
   * of the wrong place.
   */
  deserialize(data) {
    if (!data) return;
    if (typeof data.shipId === 'string' && FLYABLE.includes(data.shipId)) this.shipId = data.shipId;

    /* Every hold is rebuilt, not just the selected hull's: `holds` is the
     * authority when it is present and `cargo` is the pre-holds fallback, which
     * belongs to whichever hull the save had selected. */
    this._holds.clear();
    const loadHold = (id, rows) => {
      if (!rows || typeof rows !== 'object') return;
      const h = this._hold(id);
      for (const k in rows) {
        const row = rows[k];
        const units = Math.max(0, Math.round(Number(row?.units) || 0));
        if (!units) continue;
        h.cargo[k] = { units, credits: Math.max(0, Math.round(Number(row?.credits) || 0)), name: row?.name ?? k };
        h.units += units;
      }
    };
    if (data.holds && typeof data.holds === 'object') {
      for (const id in data.holds) loadHold(id, data.holds[id]);
    } else {
      loadHold(this.shipId, data.cargo);
    }

    this._parked = data.parked === 'ground' ? 'ground' : (data.parked === null ? null : 'berth');
    this._parkedWorld = typeof data.parkedWorld === 'string' ? data.parkedWorld : 'dock';
    this._setLanded(data.landed !== false);
    this._landedSite = null;

    const here = this.worldManager?.active?.id ?? null;
    if (Array.isArray(data.pos) && data.pos.length === 3 && data.pos.every(Number.isFinite)) {
      this.flight.position.set(data.pos[0], data.pos[1], data.pos[2]);
    }
    if (Array.isArray(data.quat) && data.quat.length === 4 && data.quat.every(Number.isFinite)) {
      this.flight.quaternion.set(data.quat[0], data.quat[1], data.quat[2], data.quat[3]).normalize();
    }
    this.flight.halt();

    /* Boarded when the game was saved, and the save's world is the one we are
     * standing in: get back in the seat. If the world does not match - a load
     * that failed over to the station, say - the ship is at its berth and the
     * player is on foot, which is a state you can always play out of. */
    if (data.aboard && this.shipId && here && (here === data.world)) {
      this.board(this.shipId, { silent: true });
      /* THE POSE IS RESTATED AFTER `board`, UNCONDITIONALLY.
       *
       * `board` calls `_placeAtBerth` for a ship it believes is parked, and
       * whether it believes that is a field the save also carries - so a save
       * taken 40 km out with a stale `parked: 'berth'` came back at the berth,
       * 40,374 m from where the player quit. The saved POSITION is the
       * authority for where the ship is; `parked` only says what it is resting
       * on. For a genuinely berthed ship the two agree and restating is a
       * no-op. */
      if (Array.isArray(data.pos) && data.pos.length === 3 && data.pos.every(Number.isFinite)) {
        this.flight.position.set(data.pos[0], data.pos[1], data.pos[2]);
        if (Array.isArray(data.quat) && data.quat.length === 4 && data.quat.every(Number.isFinite)) {
          this.flight.quaternion.set(data.quat[0], data.quat[1], data.quat[2], data.quat[3]).normalize();
        }
        this._setLanded(data.landed !== false);
        this._airborne = !this._landed;
        this._prevY = null;
        this._poseModel();
        this._seatPlayer();
      }
    } else if (this._parked === 'berth') {
      this._placeAtBerth(this.shipId);
      this._showParkedHull(this.shipId, true);
    }
    this.bus?.emit?.('pilot:cargo', {
      units: this._cargoUnits, capacity: this.cargoCapacity, value: this.cargoValue,
    });
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * The hull record `board` hands to `Flight.setShip`.
   *
   * ── THE LAST TWO LINES ARE THE FIX, AND THE BUG WAS IN THE GAME ──────────
   *
   * Both of the first two lookups are world-scoped: `worldManager.active.ships`
   * is only published by `DockWorld`, and `ShipRegistry.hulls()` reads
   * `_ships`, which `_adopt` REPLACES on every `world:changed` (deliberately —
   * a `Ship` holding disposed materials is a livery write into a dead uniform).
   *
   * So this returned null everywhere except inside the yard, `board` took its
   * `{ powerMul: 1 }` fallback, and the hull flew at 120 m/s — the exact
   * failure `Flight.setShip`'s throw exists to catch, arriving through the one
   * door that guard cannot watch, because a bare snapshot is exempt from it.
   * Reached in play by getting out of the ship on a planet and getting back in,
   * and by loading a save taken in flight (`deserialize` re-boards at :2217).
   *
   * `statsFor` is world-independent by construction and re-syncs from the owned
   * tier bag on every call, so it is correct in the yard, in the void, and on
   * a planet, and there is no second copy of the ladder arithmetic to drift.
   */
  _shipRecord(shipId) {
    const list = this.worldManager?.active?.ships;
    if (Array.isArray(list)) {
      const found = list.find((s) => s.id === shipId);
      if (found) return found;
    }
    const known = this.ships?.hulls?.().find?.((s) => s.id === shipId);
    return known ?? this.ships?.statsFor?.(shipId) ?? null;
  }

  _ensureModel(shipId) {
    let m = this._models.get(shipId);
    if (m) return m;
    const mats = this._yardMaterials();
    if (!mats) return null;
    try {
      m = buildShipModel({ id: shipId, yardMaterials: mats });
    } catch (err) {
      console.error(`[Piloting] could not build the ${shipId} model:`, err);
      return null;
    }
    this._models.set(shipId, m);
    this.scene?.add?.(m.group);
    m.group.visible = false;
    return m;
  }

  /**
   * The yard's material set, which the flown hull is cloned from.
   *
   * Read off the `dock` world instance rather than rebuilt, because
   * `buildYardTextures` paints eleven procedural canvases and a second set
   * would be a second megabyte of GPU memory for pixels identical to the first.
   * `WorldManager` keeps world instances alive across deactivation, so once the
   * yard has been built once - which it has, because that is where you board -
   * these are available from anywhere.
   */
  _yardMaterials() {
    const wm = this.worldManager;
    if (!wm) return null;
    try {
      const dock = wm.getWorld?.('dock');
      return dock?.mat?.plate ? dock.mat : null;
    } catch {
      return null;
    }
  }

  _applyLivery(shipId) {
    if (!shipId || shipId !== this.shipId) return;
    const m = this._models.get(shipId);
    if (!m) return;
    const livery = this.ships?.getLivery?.(shipId) ?? {};
    const slots = this._shipRecord(shipId)?.slots ?? [];
    try { applyLivery(livery, slots, m.slotMats); } catch { /* a repaint must never strand a flight */ }
  }

  /** Hide or show the yard's own parked hull for this berth. */
  _showParkedHull(shipId, visible) {
    if (!shipId) return;
    const w = this.worldManager?.getWorld?.('dock');
    if (!w?.group) return;
    for (const name of [`yard:ship-${shipId}`, `yard:ship-${shipId}:interior`]) {
      const g = w.group.getObjectByName(name);
      if (g) g.visible = visible;
    }
  }

  /** Put the flight state on this hull's cradle, nose out. */
  _placeAtBerth(shipId) {
    const berth = BERTHS.find((b) => b.id === shipId) ?? BERTHS[0];
    /* `berth.yaw` is the HULL's yaw and the hull's nose is +Z; the flight frame's
     * nose is -Z. See ShipModel.NOSE_YAW - this is the same PI, applied to the
     * state rather than to the model. */
    _e.set(0, berth.yaw - NOSE_YAW, 0);
    _q.setFromEuler(_e);
    this.flight.place(_v.set(berth.x, berth.cradleTop, berth.z), _q);
    this._setLanded(true);
  }

  /**
   * Sit the hull flat on its gear, keeping only its heading.
   *
   * The one place any landing writes an attitude, so there is one answer to
   * "what does a parked ship look like" rather than one per code path. A ship
   * left at the pitch it was flying looks broken standing still AND flies
   * straight back into the ground on the next take-off, which turns a landing
   * into a crash loop.
   */
  _settle(f, yaw) {
    _e.set(0, yaw, 0);
    f.quaternion.setFromEuler(_e);
  }

  /** Set (or clear) the landed flag and remember where it was set. */
  _setLanded(on) {
    this._landed = on;
    if (on) {
      this._landedAt.copy(this.flight.position);
      /* Whatever is left of a launch assist belongs to the launch that is over.
       * One choke point rather than a clear at each of the three callers. */
      this._liftoff = 0;
    }
    this._syncHullSolid();
  }

  /* ------------------------------------------------------------------ */
  /* A LANDED SHIP IS A SOLID OBJECT                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Keep the hull's colliders in step with where the hull actually is.
   *
   * `ShipModel` deliberately drops every collider `ShipBuild` registers,
   * because a flown hull's boxes would be baked at the origin of whatever world
   * was live and the player would collide with an invisible ship at 0,0,0
   * forever. That is right in flight and wrong on the ground: driven, a Kestrel
   * landed on Ashfall Flat could be walked straight through - out at
   * (145.7, 8.79, 210.9), through the hull centre, to (161.5, 8.79, 189.2) in
   * 5.9 s with Y never changing - and standing beside it put the camera inside
   * the belly plating.
   *
   * So the boxes are registered on touchdown and dropped on lift-off, which are
   * the two edges this class already owns. Only on a SURFACE world: in `dock`
   * the yard's own parked hull is the solid one (and is shown again the moment
   * you park), and in `space` there is nothing to walk on.
   *
   * Called from `_setLanded` and once per fixed step. It compares the pose it
   * built for against the pose the ship is in, numerically and with no
   * allocation, so the common case - a ship sitting still - is six float
   * compares and a return.
   */
  _syncHullSolid() {
    const wid = this.worldManager?.active?.id ?? null;
    const f = this.flight;
    const want = !!(this._landed && !this._travelling && this.shipId && this.physics
      && wid && wid !== 'dock' && wid !== 'space');
    if (!want) {
      if (this._solidWorld !== null) this._clearHullSolid();
      return;
    }
    const yaw = this._yawOf(f.quaternion);
    if (this._solidWorld === wid && this._solidShip === this.shipId
      && Math.abs(this._solidX - f.position.x) < 0.02
      && Math.abs(this._solidY - f.position.y) < 0.02
      && Math.abs(this._solidZ - f.position.z) < 0.02
      && Math.abs(this._solidYaw - yaw) < 0.01) return;
    this._clearHullSolid();
    this._addHullSolid(wid, yaw);
  }

  /** @param {string} wid @param {number} yaw flight-frame yaw of the landed hull */
  _addHullSolid(wid, yaw) {
    const model = this._models.get(this.shipId);
    const boxes = model?.hullBoxes;
    if (!boxes || !boxes.length) return;
    const f = this.flight;
    /* NOSE_YAW, exactly as `_poseModel` composes it: the plan's nose is +Z and
     * the flight frame's is -Z, so the drawn hull carries a fixed PI and the
     * colliders have to carry the same one or the solid Kestrel points the
     * other way from the visible one. */
    const a = yaw + NOSE_YAW;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      _hc.set(
        f.position.x + b.x * cos + b.z * sin,
        f.position.y + b.y,
        f.position.z - b.x * sin + b.z * cos
      );
      _hh.set(b.hx, b.hy, b.hz);
      this._hullColliders.push(this.physics.addRotatedBox(_hc, _hh, a + b.ry, {
        userData: { kind: 'ship', shipId: this.shipId },
      }));
    }
    this._solidShip = this.shipId;
    this._solidWorld = wid;
    this._solidX = f.position.x;
    this._solidY = f.position.y;
    this._solidZ = f.position.z;
    this._solidYaw = yaw;
  }

  /** Drop them. Safe to call when there are none, and after a world wiped them. */
  _clearHullSolid() {
    for (let i = 0; i < this._hullColliders.length; i++) {
      this.physics?.remove?.(this._hullColliders[i]);
    }
    this._hullColliders.length = 0;
    this._solidShip = null;
    this._solidWorld = null;
  }

  /** Point `_q` from `from` toward `to`, wings level. */
  _faceAlong(from, to) {
    _v2.copy(to).sub(from);
    const yaw = Math.atan2(-_v2.x, -_v2.z);
    const pitch = Math.atan2(_v2.y, Math.hypot(_v2.x, _v2.z));
    _e.set(pitch, yaw, 0);
    _q.setFromEuler(_e);
    return _q;
  }

  _yawOf(q) {
    _fwd.set(0, 0, -1).applyQuaternion(q);
    return Math.atan2(-_fwd.x, -_fwd.z);
  }

  /**
   * A body's `surfaceWorld` string, resolved to a world id that is actually
   * registered.
   *
   * `Bodies.js` says `'planet:cinder'` and `planets/index.js` registers
   * `'cinder'`, because one names a namespace and the other names a class.
   * Neither is wrong and neither file is this one's to rewrite, so the seam
   * resolves it - exactly, then by stripping a `planet:` prefix - and
   * `piloting-loop.test.mjs` asserts every landable body resolves to a
   * registered world. Without that test this is a planet you can approach
   * forever and never reach, which is the defect this project keeps shipping.
   */
  _resolveSurfaceWorld(name) {
    if (!name) return null;
    const ids = this.worldManager?.ids ?? [];
    if (ids.includes(name)) return name;
    const bare = name.startsWith('planet:') ? name.slice(7) : null;
    if (bare && ids.includes(bare)) return bare;
    return null;
  }

  /** The space body a surface world belongs to, or null. */
  _bodyForWorld(worldId) {
    if (!worldId) return null;
    for (const id in BODY_BY_ID) {
      const b = BODY_BY_ID[id];
      if (!b.surfaceWorld) continue;
      if (b.surfaceWorld === worldId || b.surfaceWorld === `planet:${worldId}`) return id;
    }
    return null;
  }

  dispose() {
    this._offChanging?.();
    this._offChanged?.();
    this._offDied?.();
    this._offLivery?.();
    this._offHit?.();
    if (this._active) this._recoverToBerth();
    for (const m of this._models.values()) m.dispose?.();
    this._models.clear();
    this._model = null;
  }
}
