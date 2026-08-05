import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { COLLISION_LAYER } from '../physics/Physics.js';

/**
 * BICYCLE - the pedal mount.
 *
 * ── What makes a bicycle different from the other five mounts ─────────────
 * The car and the hoverboard have a throttle: ask for speed and you get it.
 * The horse has gaits. A bicycle has neither, and three things follow:
 *
 *   1. **The rider is the engine.** There is no idle and no holding speed for
 *      free - stop pedalling and the freewheel takes over, so it coasts and
 *      slowly bleeds off. Sprint is not a boost button, it is standing on the
 *      pedals, and it costs the rider's stamina rather than a fuel gauge.
 *   2. **It steers by leaning, and cannot turn on the spot.** Heading follows
 *      the *bicycle model* - `dHeading = v * tan(steer) / wheelbase` - which is
 *      the actual kinematics of two wheels on a frame. It falls out of that for
 *      free that a stationary bike does not turn however hard you shove the
 *      bars, and that the faster you go the wider the arc.
 *   3. **Every moving part is geared to the ground.** The wheels turn by
 *      distance over radius, the cranks by distance over development, so the
 *      cadence is *derived* from how fast you are actually travelling. Nothing
 *      here is a decorative spin at a made-up rate, which is what stops the
 *      pedals skating when the speed changes.
 *
 * ── Why the rider is not keyframed onto it ────────────────────────────────
 * The pedals orbit and the bars turn. A keyframed pedalling cycle has to match
 * the crank exactly or the feet swim, and it cannot match it, because cadence
 * depends on speed. So the bike publishes its pedal platforms through
 * `getStirrupWorld` and its bar grips through `getGripWorld`, and
 * `MountManager._poseCyclist` solves the legs and arms onto them by IK - the
 * same arrangement the dragon's stirrups and the car's wheel rim use. The feet
 * are then on the pedals *because they are on the pedals*, at any cadence, and
 * the arms follow the steering without anyone animating them.
 *
 * ── Mounting and dismounting ──────────────────────────────────────────────
 * Both are real transitions rather than a snap, and both are driven through the
 * same IK. `_mountT` runs 0..1; while it is short of 1 the near foot is on the
 * ground beside the bike and the far foot is swinging over the saddle along an
 * arc, so the leg-over reads properly. The bike leans onto its near side for
 * the swing and straightens as the rider settles. Dismounting runs it backwards
 * and, because `canDismount()` refuses until the bike has stopped, `F` at speed
 * brakes to a halt and steps off rather than dropping the player at 8 m/s.
 *
 * Sports areas already have bike racks and parked bikes as scenery, so this is
 * also the mount that belongs there.
 */

const TAU = Math.PI * 2;
const clamp = THREE.MathUtils.clamp;
const damp = THREE.MathUtils.damp;

/* Scratch - one set per concern, never shared across them. */
const _gp1 = new THREE.Vector3();   // ground probe
const _gp2 = new THREE.Vector3();   // forward ray
const _mv1 = new THREE.Vector3();   // fixedUpdate travel
const _an1 = new THREE.Vector3();   // anchor read
const _hd1 = new THREE.Vector3();   // steer frame construction

/* ------------------------------------------------------------------ */
/* Dimensions - a 56 cm road frame on 700x32, in metres                */
/* ------------------------------------------------------------------ */

/** Wheel radius over the tyre. Everything geared to the ground uses this. */
const WHEEL_R = 0.345;
const TYRE_T = 0.032;
/** Axle positions. -Z is forward, matching every other mount here. */
const REAR_Z = 0.44;
const FRONT_Z = -0.605;
/** Wheelbase, derived rather than typed twice - the steering model needs it. */
const WHEELBASE = REAR_Z - FRONT_Z;
/** Bottom bracket: the crank axis, and the origin of the drivetrain. */
const BB_Y = 0.272;
const BB_Z = 0.035;
const CRANK_LEN = 0.1725;
/**
 * Saddle top and the seat-tube junction beneath it.
 *
 * The height is not a style choice: it is set by the rider's leg, so that the
 * knee is very nearly straight at the bottom of the pedal stroke. The rider
 * proxy measures 0.86 m hip to ankle and the bottom of the stroke is at 0.10,
 * so a saddle much under this leaves the figure riding with its knees round
 * its ears - which is exactly how the first pass looked.
 */
const SEAT_Y = 1.035;
const SEAT_Z = 0.15;
/** Head tube, top and bottom. The line between them is the steering axis. */
const HEAD_TOP_Y = 0.925;
const HEAD_TOP_Z = -0.45;
const HEAD_BOT_Y = 0.70;
const HEAD_BOT_Z = -0.382;
/**
 * Handlebar: a swept-back riser, not a road drop.
 *
 * This is measured against the rider rather than styled. The proxy's shoulder
 * to hand is 0.562 m fully extended, and a road cockpit - low bars 0.67 m
 * ahead of the saddle - puts the grips 0.82 m from the shoulder. The IK then
 * does the only thing it can with an unreachable target and straightens the
 * arm at it, so the rider sat bolt upright with both arms stretched at a bar
 * they never touched. A high bar swept back toward the rider brings the grips
 * inside 0.50 m, which is a comfortable bend - and an upright park bike is
 * what belongs in a sports area anyway.
 */
const BAR_Y = 1.085;
const BAR_Z = -0.4;
const BAR_HALF = 0.235;
/** How far the bar ends sweep back toward the rider. */
const BAR_SWEEP = 0.19;

/**
 * Head angle, derived from the head tube rather than typed.
 *
 * The steering axis is raked back, which is what gives a bicycle trail and
 * therefore self-centring. Deriving it means the fork, the bars and the front
 * wheel cannot drift out of line with the frame they are drawn on.
 */
const RAKE = Math.atan2(HEAD_TOP_Z - HEAD_BOT_Z, HEAD_TOP_Y - HEAD_BOT_Y);

/* ------------------------------------------------------------------ */
/* Ride                                                                */
/* ------------------------------------------------------------------ */

/**
 * Speeds, in m/s.
 *
 * A fit rider cruises at about 6 and sprints into the low tens; these are a
 * shade quicker because this is a game and a bicycle that a jogging NPC can
 * keep up with is not worth summoning. Still comfortably under the horse's
 * 15.5, which is the point - the bicycle is the mount you take because it is
 * quiet and turns tightly, not because it is fastest.
 */
const CRUISE_SPEED = 8.2;
const SPRINT_SPEED = 13.4;
/** Walking the bike backwards. A crank cannot drive a freewheel in reverse. */
const REVERSE_SPEED = 1.5;
const MAX_SPEED = 16.5;

/** Pedalling acceleration, and the two things that take speed away. */
const PEDAL_ACCEL = 4.6;
const BRAKE_DECEL = 9.5;
/** Freewheel drag: rolling resistance plus a v^2 air term. Coasting is slow. */
const ROLL_DRAG = 0.42;
const AIR_DRAG = 0.028;

/**
 * Steering limits.
 *
 * ── Why the limit is derived from the lean and not from the speed ──────────
 * The first pass interpolated the maximum steering angle between a slow and a
 * fast figure, which is what most games do and is wrong here. At 6.5 m/s it
 * still allowed 29 degrees of steering - a 1.9 m turning radius - and the lean
 * that corner physically requires is 66 degrees, so the bike spent every corner
 * pinned against its lean clamp with the wheels tracking an arc no bicycle
 * could hold.
 *
 * The real constraint on a bicycle is not the bars, it is how far the rider
 * dares lean. Invert the lean equation for the steering angle and the limit
 * falls out: tan(steer) = tan(leanMax) * g * L / v^2. The bars then tighten as
 * speed rises without a curve to tune, the lean never reaches its clamp, and
 * the turning circle is correct at every speed - about 0.9 m at walking pace
 * and 6 m at a cruise, which is what a bicycle actually does.
 */
const LEAN_MAX = 0.62;
/** Bars against the frame. The mechanical limit, for when the lean allows more. */
const STEER_MECH = 0.85;
const STEER_RATE = 5.2;

const GRAVITY = -22;
const HOP_V = 4.4;
const STEP_UP = 0.42;

/** Seconds for the leg-over, in each direction. */
const MOUNT_TIME = 0.85;

/**
 * Development: metres travelled per crank revolution.
 *
 * A 50x17 on 700c is about 6.2 m, which is a middle gear. Using one fixed
 * value means cadence rises linearly with speed - at 8.2 m/s that is 79 rpm,
 * which is exactly where a rider would be, and at a 13.4 m/s sprint it reads
 * as 130 rpm, which is where a sprinter would be. No gearbox needed to make
 * the legs look right.
 */
const DEVELOPMENT = 6.2;

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                    */
/* ------------------------------------------------------------------ */

/**
 * A tube between two points in the frame's XZ/Y plane.
 *
 * A bicycle frame is nothing but tubes between joints, and authoring each one
 * as "cylinder, length, rotation, position" is how the top tube ends up not
 * quite meeting the seat tube. Given the two ends it cannot miss.
 */
function tube(radius, x0, y0, z0, x1, y1, z1, seg = 10) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dy, dz);
  const g = new THREE.CylinderGeometry(radius, radius, len, seg, 1);
  // Cylinders are built along +Y; rotate that onto the segment direction.
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(dx / len, dy / len, dz / len)
  );
  g.applyQuaternion(q);
  g.translate((x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5);
  return g;
}

/** A rounded box, in the horse's convention. Saddle, pedals, small fittings. */
function box(w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) {
  const r = Math.min(w, h, d) * 0.24;
  const g = r > 0.006
    ? new RoundedBoxGeometry(w, h, d, 2, r)
    : new THREE.BoxGeometry(w, h, d);
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

/** A ring lying in the XY plane - the wheel's own plane. Rims and tyres. */
function ring(radius, thickness, tubular = 28, radial = 8) {
  return new THREE.TorusGeometry(radius, thickness, radial, tubular);
}

function merge(list) {
  const clean = list.map((g) => (g.index ? g.toNonIndexed() : g));
  const m = mergeGeometries(clean, false);
  for (const g of clean) g.dispose();
  return m;
}

export class Bicycle {
  /**
   * @param {{scene:THREE.Scene, engine:any, physics:any, bus:any, materials:any,
   *          camera:THREE.PerspectiveCamera}} ctx
   */
  constructor({ scene, engine, physics, bus, materials, camera }) {
    this.id = 'bicycle';
    this.displayName = 'BICYCLE';
    /** Seated, pedalling, hands on the bars - solved, not keyframed. */
    this.riderPose = 'cycle';
    /** Close: a bicycle is small and the player has to reach it. */
    this.spawnDistance = 2.2;
    /** Shown when `F` is pressed before the step-off has finished. */
    this.dismountHint = 'Slowing down - [F] again to hop off';

    this.scene = scene;
    this.engine = engine;
    this.physics = physics;
    this.bus = bus;
    this.materials = materials;
    this.camera = camera;

    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.heading = 0;
    this.speed = 0;

    this._vy = 0;
    this._grounded = true;
    this._groundY = 0;
    this._pitch = 0;
    this._lean = 0;
    this._steer = 0;
    /** Crank and wheel angles, both integrated from distance travelled. */
    this._crank = 0;
    this._wheel = 0;
    /** 0 coasting, 1 driving. Drives the freewheel tick and the rider's effort. */
    this._drive = 0;
    /** 0 standing beside the bike, 1 seated and pedalling. */
    this._mountT = 0;
    this._mountDir = 0;
    /** True while the step-off is bleeding speed to a halt. */
    this._braking = false;
    this._alive = false;
    this._ridden = false;
    this._spawnT = 1;
    this._despawnT = -1;
    this._time = 0;

    this._owned = [];
    this._build();
  }

  /* ------------------------------------------------------------------ */
  /* Build                                                               */
  /* ------------------------------------------------------------------ */

  /** Shared-library surface if there is one, a flat material if not. */
  _mat(color, opts = {}) {
    const { surface = null, ...rest } = opts;
    if (surface && this.materials?.get) {
      try {
        const base = this.materials.get(surface);
        if (base) {
          const m = base.clone();
          m.color = new THREE.Color(color);
          if (rest.roughness !== undefined) m.roughness = rest.roughness;
          if (rest.metalness !== undefined) m.metalness = rest.metalness;
          this._owned.push(m);
          return m;
        }
      } catch { /* fall through */ }
    }
    const m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      roughness: rest.roughness ?? 0.5,
      metalness: rest.metalness ?? 0.35,
      ...rest,
    });
    this._owned.push(m);
    return m;
  }

  _build() {
    this.root = new THREE.Group();
    this.root.name = 'mount:bicycle';

    /* Pitch (slope) and roll (lean) both live on one node, so everything
     * hanging off the frame inherits the attitude without being told. */
    this.tilt = new THREE.Group();
    this.root.add(this.tilt);

    const paint = this._mat(0x2f7fd4, { surface: 'metal.trim', roughness: 0.32, metalness: 0.55 });
    const alloy = this._mat(0xb9bfc7, { surface: 'metal.iron', roughness: 0.38, metalness: 0.85 });
    const rubber = this._mat(0x1b1b1e, { surface: 'rubber.track', roughness: 0.92, metalness: 0.02 });
    const trim = this._mat(0x24262b, { roughness: 0.62, metalness: 0.2 });

    this._buildFrame(paint, alloy, trim);
    this._buildSteering(paint, alloy, rubber, trim);
    this._buildRearWheel(alloy, rubber);
    this._buildDrivetrain(alloy, trim);
    this._buildAnchors();
  }

  /**
   * The diamond frame, plus the seat post and saddle.
   *
   * Every tube is drawn between two named joints (see the dimension block), so
   * the frame closes by construction. Two triangles - main and rear - which is
   * the shape that has to read at a glance or it is not a bicycle.
   */
  _buildFrame(paint, alloy, trim) {
    const seatJoinY = SEAT_Y - 0.19;
    const geo = [
      // Main triangle.
      tube(0.021, 0, HEAD_TOP_Y, HEAD_TOP_Z, 0, seatJoinY + 0.03, SEAT_Z),          // top tube
      tube(0.026, 0, HEAD_BOT_Y, HEAD_BOT_Z, 0, BB_Y, BB_Z),                        // down tube
      tube(0.024, 0, BB_Y, BB_Z, 0, seatJoinY + 0.05, SEAT_Z - 0.012),              // seat tube
      tube(0.030, 0, HEAD_BOT_Y - 0.03, HEAD_BOT_Z - 0.01, 0, HEAD_TOP_Y + 0.02, HEAD_TOP_Z + 0.006), // head tube
    ];
    // Rear triangle: paired stays either side of the wheel.
    for (const sx of [-0.055, 0.055]) {
      geo.push(tube(0.014, 0, BB_Y, BB_Z + 0.02, sx, WHEEL_R, REAR_Z));             // chain stay
      geo.push(tube(0.013, sx * 0.62, seatJoinY + 0.04, SEAT_Z + 0.01, sx, WHEEL_R, REAR_Z)); // seat stay
    }
    const frame = new THREE.Mesh(merge(geo), paint);
    frame.castShadow = true;
    frame.receiveShadow = true;
    this.tilt.add(frame);

    /* ---- seat post and saddle ---- */
    const post = [
      tube(0.0155, 0, seatJoinY, SEAT_Z - 0.006, 0, SEAT_Y - 0.035, SEAT_Z + 0.032),
    ];
    this.tilt.add(new THREE.Mesh(merge(post), alloy));

    // Saddle: a nose, a wide tail and the rails under it. Small, but it is what
    // the rider is sitting on, so its silhouette is on screen constantly.
    const saddleGeo = merge([
      box(0.062, 0.028, 0.26, 0, SEAT_Y, SEAT_Z + 0.028, 0.1, 0, 0),
      box(0.135, 0.024, 0.1, 0, SEAT_Y + 0.004, SEAT_Z + 0.115, 0.06, 0, 0),
      box(0.03, 0.02, 0.09, 0, SEAT_Y - 0.004, SEAT_Z - 0.075, 0.14, 0, 0),
    ]);
    const saddle = new THREE.Mesh(saddleGeo, trim);
    saddle.castShadow = true;
    this.tilt.add(saddle);

    /* ---- bottle cage, because a bare frame reads as a toy ---- */
    const cage = [];
    for (let i = 0; i < 3; i++) {
      const t = i / 2;
      const y = BB_Y + 0.16 + t * 0.2;
      const z = BB_Z - 0.13 - t * 0.055;
      cage.push(tube(0.005, -0.033, y, z, 0.033, y, z, 6));
    }
    this.tilt.add(new THREE.Mesh(merge(cage), alloy));
  }

  /**
   * Fork, front wheel and handlebars, on the steering axis.
   *
   * ── Why there are three nested nodes and not one ──────────────────────────
   * A bicycle does not steer about a vertical axis; it steers about the head
   * tube, which is raked back by `RAKE`. Turning the bars therefore also tips
   * the wheel slightly and drops the front of the frame, and that is most of
   * what makes a turning bicycle read as one.
   *
   *   `_steerPivot` sits on the axis and tilts to it,
   *   `_steerYaw`   turns about it - this is the steering angle,
   *   `_steerFrame` undoes the tilt again.
   *
   * The last one is the trick worth keeping: it means the fork, the wheel and
   * the bars are all authored in ordinary frame coordinates, straight out of
   * the dimension block, instead of in a rotated space where nothing lines up
   * with anything else.
   */
  _buildSteering(paint, alloy, rubber, trim) {
    this._steerPivot = new THREE.Group();
    this._steerPivot.position.set(0, HEAD_BOT_Y, HEAD_BOT_Z);
    this._steerPivot.rotation.x = RAKE;
    this.tilt.add(this._steerPivot);

    this._steerYaw = new THREE.Group();
    this._steerPivot.add(this._steerYaw);

    this._steerFrame = new THREE.Group();
    this._steerFrame.rotation.x = -RAKE;
    // Position that exactly cancels the pivot: -Rx(-RAKE) * headPoint.
    _hd1.set(0, HEAD_BOT_Y, HEAD_BOT_Z).applyAxisAngle(new THREE.Vector3(1, 0, 0), -RAKE);
    this._steerFrame.position.copy(_hd1).multiplyScalar(-1);
    this._steerYaw.add(this._steerFrame);

    /* ---- fork: two blades from the crown to the axle, with a slight offset
     * forward of the steering axis. That offset is fork rake, and without it
     * the trail is wrong and the front end looks like a shopping trolley. ---- */
    const forkGeo = [];
    const crownY = HEAD_BOT_Y - 0.03;
    for (const sx of [-0.045, 0.045]) {
      forkGeo.push(tube(0.016, sx * 0.5, crownY, HEAD_BOT_Z - 0.005, sx, WHEEL_R, FRONT_Z));
    }
    forkGeo.push(box(0.09, 0.05, 0.05, 0, crownY + 0.012, HEAD_BOT_Z - 0.004));
    this._steerFrame.add(new THREE.Mesh(merge(forkGeo), paint));

    /* ---- handlebars: stem, a flat bar and two grips ---- */
    const barGeo = [
      // Stem: up and forward out of the steerer to the bar clamp.
      tube(0.018, 0, HEAD_TOP_Y + 0.02, HEAD_TOP_Z + 0.004, 0, BAR_Y - 0.006, BAR_Z + 0.008),
      tube(0.015, -0.09, BAR_Y, BAR_Z, 0.09, BAR_Y, BAR_Z, 8),
    ];
    // The sweep: each half runs out and back toward the rider.
    for (const sx of [-1, 1]) {
      barGeo.push(tube(0.015, sx * 0.09, BAR_Y, BAR_Z,
        sx * BAR_HALF, BAR_Y + 0.012, BAR_Z + BAR_SWEEP * 0.55, 8));
      barGeo.push(tube(0.014, sx * BAR_HALF, BAR_Y + 0.012, BAR_Z + BAR_SWEEP * 0.55,
        sx * (BAR_HALF - 0.012), BAR_Y + 0.018, BAR_Z + BAR_SWEEP, 8));
    }
    this._steerFrame.add(new THREE.Mesh(merge(barGeo), alloy));

    const gripGeo = [];
    for (const sx of [-1, 1]) {
      gripGeo.push(tube(0.02, sx * (BAR_HALF - 0.002), BAR_Y + 0.014, BAR_Z + BAR_SWEEP * 0.72,
        sx * (BAR_HALF - 0.014), BAR_Y + 0.018, BAR_Z + BAR_SWEEP + 0.006, 8));
      // Brake lever, hanging forward and down off the grip.
      gripGeo.push(tube(0.007, sx * (BAR_HALF - 0.006), BAR_Y + 0.01, BAR_Z + BAR_SWEEP * 0.66,
        sx * (BAR_HALF - 0.03), BAR_Y - 0.022, BAR_Z + BAR_SWEEP * 0.3, 6));
    }
    this._steerFrame.add(new THREE.Mesh(merge(gripGeo), trim));

    /* ---- front wheel, on its own spin node at the axle ---- */
    this._frontWheel = new THREE.Group();
    this._frontWheel.position.set(0, WHEEL_R, FRONT_Z);
    this._steerFrame.add(this._frontWheel);
    this._frontWheel.add(this._wheelMesh(alloy, rubber));

    /* ---- grips the rider's hands are solved onto ---- */
    this.gripAnchors = [];
    for (const sx of [-1, 1]) {
      const a = new THREE.Object3D();
      a.position.set(sx * (BAR_HALF - 0.008), BAR_Y + 0.016, BAR_Z + BAR_SWEEP * 0.86);
      this._steerFrame.add(a);
      this.gripAnchors.push(a);
    }
  }

  /**
   * One wheel: tyre, rim, hub and spokes, built in the XY plane so the node it
   * is added to spins it about X.
   *
   * The spokes are eight crossing pairs rather than thirty-two singles. At the
   * distance a rider ever sees their own wheel the count is unreadable, but the
   * *pattern* - a disc of fine lines that blurs as it turns - is the whole
   * effect, and sixteen thin boxes buys it for a fraction of the geometry.
   */
  _wheelMesh(alloy, rubber) {
    const g = new THREE.Group();

    const tyre = new THREE.Mesh(ring(WHEEL_R - TYRE_T * 0.5, TYRE_T, 30, 8), rubber);
    tyre.castShadow = true;
    g.add(tyre);

    const parts = [ring(WHEEL_R - TYRE_T - 0.012, 0.013, 30, 6)];
    parts.push(new THREE.CylinderGeometry(0.034, 0.034, 0.1, 10).rotateZ(Math.PI / 2));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI;
      // Two spokes per position, crossed slightly, so the pattern reads as
      // laced rather than as a wagon wheel.
      for (const lace of [-0.055, 0.055]) {
        const s = new THREE.BoxGeometry(0.0035, (WHEEL_R - TYRE_T - 0.02) * 2, 0.0035);
        s.rotateZ(a + lace);
        parts.push(s);
      }
    }
    const spokes = new THREE.Mesh(merge(parts), alloy);
    g.add(spokes);
    return g;
  }

  _buildRearWheel(alloy, rubber) {
    this._rearWheel = new THREE.Group();
    this._rearWheel.position.set(0, WHEEL_R, REAR_Z);
    this.tilt.add(this._rearWheel);
    this._rearWheel.add(this._wheelMesh(alloy, rubber));

    // Cassette, so the drive side has something the chain can plausibly reach.
    const cogs = [];
    for (let i = 0; i < 4; i++) {
      cogs.push(new THREE.CylinderGeometry(0.052 - i * 0.008, 0.052 - i * 0.008, 0.004, 14)
        .rotateZ(Math.PI / 2)
        .translate(0.052 + i * 0.007, 0, 0));
    }
    this._rearWheel.add(new THREE.Mesh(merge(cogs), alloy));
  }

  /**
   * Cranks, pedals and chainring.
   *
   * The two crank arms are 180 degrees apart on one node, and each pedal hangs
   * off its arm on a node that counter-rotates by exactly the crank angle. That
   * counter-rotation is not a detail: a pedal welded to its arm cartwheels, and
   * a cartwheeling pedal drags the rider's foot round with it, because the foot
   * is solved onto the platform.
   */
  _buildDrivetrain(alloy, trim) {
    this._crankNode = new THREE.Group();
    this._crankNode.position.set(0, BB_Y, BB_Z);
    this.tilt.add(this._crankNode);

    // Chainring, on the drive side, static relative to the cranks.
    const rings = [
      new THREE.CylinderGeometry(0.108, 0.108, 0.004, 22).rotateZ(Math.PI / 2).translate(0.058, 0, 0),
      new THREE.CylinderGeometry(0.079, 0.079, 0.004, 20).rotateZ(Math.PI / 2).translate(0.049, 0, 0),
      new THREE.CylinderGeometry(0.021, 0.021, 0.13, 12).rotateZ(Math.PI / 2),
    ];
    this._crankNode.add(new THREE.Mesh(merge(rings), alloy));

    /** Pedal platforms, in crank order: index 0 left, 1 right. */
    this._pedals = [];
    this.pedalAnchors = [];
    for (const side of [-1, 1]) {
      const arm = new THREE.Group();
      // Left and right cranks are opposed - that is what makes it pedalling
      // rather than two feet bobbing in unison.
      arm.rotation.x = side < 0 ? 0 : Math.PI;
      this._crankNode.add(arm);

      const armGeo = box(0.028, CRANK_LEN, 0.018, side * 0.068, -CRANK_LEN * 0.5 + 0.012, 0);
      arm.add(new THREE.Mesh(armGeo, alloy));

      // Pedal node at the end of the arm. Counter-rotated every frame.
      const pedal = new THREE.Group();
      pedal.position.set(side * 0.082, -CRANK_LEN, 0);
      arm.add(pedal);
      const platform = merge([
        box(0.028, 0.014, 0.09, 0, 0, 0),
        box(0.062, 0.008, 0.078, 0, -0.004, 0),
      ]);
      pedal.add(new THREE.Mesh(platform, trim));
      this._pedals.push(pedal);

      // The foot target sits on top of the platform, at the ball of the foot.
      const a = new THREE.Object3D();
      a.position.set(0, 0.022, 0);
      pedal.add(a);
      this.pedalAnchors.push(a);
    }

    /* ---- chain: two straight runs between chainring and cassette. A real
     * chain wraps, but at this scale the two runs are the whole silhouette. ---- */
    const chain = [
      tube(0.006, 0.058, BB_Y + 0.105, BB_Z, 0.058, WHEEL_R + 0.045, REAR_Z, 6),
      tube(0.006, 0.058, BB_Y - 0.105, BB_Z, 0.058, WHEEL_R - 0.045, REAR_Z, 6),
    ];
    this.tilt.add(new THREE.Mesh(merge(chain), trim));
  }

  _buildAnchors() {
    /* Where the rider's pelvis goes. Sat on the saddle, not floating over it -
     * `MountManager` drops the figure by its own pelvis height from here. */
    this.riderAnchor = new THREE.Object3D();
    this.riderAnchor.position.set(0, SEAT_Y + 0.045, SEAT_Z + 0.02);
    this.tilt.add(this.riderAnchor);

    /**
     * Where the mounting foot starts and finishes: on the ground, on the near
     * side, level with the bottom bracket. The leg-over arc is interpolated
     * between this and the pedal, so it is expressed in the bike's own space
     * and stays correct however the bike is leaning.
     */
    this.groundAnchor = new THREE.Object3D();
    this.groundAnchor.position.set(-0.34, 0.055, BB_Z + 0.1);
    this.tilt.add(this.groundAnchor);
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  get alive() {
    return this._alive;
  }

  setVisible(v) {
    this.root.visible = v;
  }

  spawn(position, yaw) {
    this.position.copy(position);
    // Short probe, like the horse's: a long one finds the roof overhead and
    // parks the bike on top of it.
    const g = this.physics.groundHeight(position.x, position.z, position.y + 3.0, 14);
    this._groundY = g === null ? position.y : g;
    this.position.y = this._groundY;
    this.heading = yaw;
    this.velocity.set(0, 0, 0);
    this.speed = 0;
    this._vy = 0;
    this._pitch = 0;
    this._lean = 0;
    this._steer = 0;
    this._drive = 0;
    this._grounded = true;
    this._spawnT = 0;
    this._despawnT = -1;
    this._alive = true;
    this.root.position.copy(this.position);
    this.root.rotation.y = yaw;
    if (!this.root.parent) this.scene.add(this.root);
    this.setVisible(true);
    this.bus?.emit('mount:summoned', { id: this.id, position: this.position.clone() });
  }

  despawn() {
    if (!this._alive || this._despawnT >= 0) return;
    this._despawnT = 0;
  }

  kill() {
    this._alive = false;
    this._ridden = false;
    this._despawnT = -1;
    this._spawnT = 1;
    this._mountT = 0;
    this._mountDir = 0;
    this.setVisible(false);
    this.root.removeFromParent();
  }

  /** Swing a leg over. `_mountT` drives the rest; see `_poseCyclist`. */
  onMount() {
    this._ridden = true;
    this._mountT = 0;
    this._mountDir = 1;
  }

  onDismount() {
    this._ridden = false;
    this._mountT = 0;
    this._mountDir = 0;
  }

  /**
   * Only once the rider is off the pedals and the bike has stopped.
   *
   * `MountManager.dismount` reads this: false makes it call `requestLanding`
   * and wait, which is exactly the window the step-off animation needs. A
   * second press of F overrides, so nobody is ever trapped on a bicycle.
   */
  canDismount() {
    return this._mountDir <= 0 && this._mountT <= 0.02 && Math.abs(this.speed) < 0.4;
  }

  /** Brake to a halt and step off. The manager finishes on `canDismount`. */
  requestLanding() {
    this._mountDir = -1;
    this.speed *= 0.5;
    this._braking = true;
  }

  /* ------------------------------------------------------------------ */
  /* Simulation                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * @param {number} dt
   * @param {number} elapsed
   * @param {{throttle:number, strafe:number, yaw:number, boost:boolean, up:number}|null} ctrl
   */
  fixedUpdate(dt, elapsed, ctrl) {
    if (!this._alive) return;
    this._time += dt;

    if (this._spawnT < 1) this._spawnT = Math.min(1, this._spawnT + dt * 2.2);
    if (this._despawnT >= 0) {
      this._despawnT += dt * 2.0;
      if (this._despawnT >= 1) { this.kill(); return; }
    }

    /* ---- mount / dismount transition -------------------------------- *
     * Held at 0 until the rider is aboard, so a bike standing in the street
     * is not mid-leg-over with nobody on it. */
    if (this._mountDir > 0) {
      this._mountT = Math.min(1, this._mountT + dt / MOUNT_TIME);
      if (this._mountT >= 1) this._mountDir = 0;
    } else if (this._mountDir < 0) {
      this._mountT = Math.max(0, this._mountT - dt / MOUNT_TIME);
    }
    // Feet are not on the pedals yet, so there is nothing to pedal with.
    const seated = this._mountT > 0.75 && this._mountDir >= 0;

    const ridden = !!ctrl;
    const throttle = ridden && seated ? clamp(ctrl.throttle, -1, 1) : 0;
    const steerIn = ridden ? -clamp(ctrl.strafe, -1, 1) : 0;
    const sprint = ridden && seated && !!ctrl.boost && throttle > 0.1;

    /* ---- drive and drag --------------------------------------------- *
     * There is no "hold this speed" here. Pedalling adds, everything else
     * takes away, and the top speed is simply where they balance. */
    const top = sprint ? SPRINT_SPEED : CRUISE_SPEED;
    let drive = 0;
    if (throttle > 0.05) {
      // Effort falls away as the gear runs out, which is what a fixed
      // development means in practice.
      const head = clamp(1 - this.speed / top, 0, 1);
      drive = throttle * PEDAL_ACCEL * head * (sprint ? 1.55 : 1);
      this.speed += drive * dt;
    } else if (throttle < -0.05) {
      // Back brake, then walking it backwards once stopped.
      if (this.speed > 0.05) this.speed += throttle * BRAKE_DECEL * dt;
      else this.speed = damp(this.speed, REVERSE_SPEED * throttle, 6, dt);
    }
    if (this._braking) {
      this.speed = damp(this.speed, 0, 7, dt);
      if (Math.abs(this.speed) < 0.35) this._braking = false;
    }
    // Freewheel: rolling resistance is constant, air resistance is not.
    if (this.speed > 0) {
      const drag = (ROLL_DRAG + AIR_DRAG * this.speed * this.speed) * dt;
      this.speed = Math.max(0, this.speed - drag);
    }
    this.speed = clamp(this.speed, -REVERSE_SPEED, MAX_SPEED);
    if (Math.abs(this.speed) < 0.02) this.speed = 0;
    // How hard the legs are working, for the rider's lean and the crank blur.
    this._drive = damp(this._drive, drive > 0.01 ? (sprint ? 1 : 0.55) : 0, 6, dt);

    /* ---- steering: the bicycle model -------------------------------- *
     * The bars can be turned a long way at walking pace and barely at all at
     * speed, and heading follows from the geometry rather than from a turn
     * rate. A stationary bicycle therefore does not spin on the spot, which
     * is the single thing that stops a two-wheeler reading as a hoverboard. */
    const vv = Math.max(this.speed * this.speed, 0.04);
    const steerMax = Math.min(STEER_MECH, Math.atan(Math.tan(LEAN_MAX) * 9.81 * WHEELBASE / vv));
    this._steer = damp(this._steer, steerIn * steerMax, STEER_RATE, dt);
    if (Math.abs(this._steer) > 1e-4 && Math.abs(this.speed) > 0.05) {
      this.heading += (this.speed * Math.tan(this._steer) / WHEELBASE) * dt;
    }

    /* ---- lean: the angle that actually balances the corner ----------- *
     * tan(lean) = v^2 / (r * g), and r = wheelbase / tan(steer), so the whole
     * thing collapses to v^2 * tan(steer) / (g * wheelbase). Free, and it
     * means the bike lies down in a fast corner and stays upright in a slow
     * one without a single hand-tuned number. */
    const lat = (this.speed * this.speed * Math.tan(this._steer)) / (9.81 * WHEELBASE);
    let leanTarget = -clamp(Math.atan(lat), -LEAN_MAX, LEAN_MAX);
    // Propped over on the near side while the rider is swinging a leg across.
    if (this._mountT < 1) leanTarget += (1 - this._mountT) * 0.13;
    this._lean = damp(this._lean, leanTarget, 7, dt);

    /* ---- hop --------------------------------------------------------- */
    if (ridden && seated && ctrl.up > 0.5 && this._grounded) {
      this._vy = HOP_V;
      this._grounded = false;
      this.bus?.emit('mount:jump', { id: this.id });
    }

    /* ---- integrate ---------------------------------------------------- */
    const fx = -Math.sin(this.heading);
    const fz = -Math.cos(this.heading);
    _mv1.set(fx * this.speed, 0, fz * this.speed);
    this.position.x += _mv1.x * dt;
    this.position.z += _mv1.z * dt;

    this._vy += GRAVITY * dt;
    this.position.y += this._vy * dt;

    /* ---- ground follow ------------------------------------------------ */
    _gp1.set(this.position.x, this.position.y + STEP_UP + 0.4, this.position.z);
    let g = this.physics.groundHeight(_gp1.x, _gp1.z, _gp1.y, STEP_UP + 4.0);
    if (g === null) {
      // Buried-bike recovery, as the horse has: once under a surface the
      // downward probe can never see it again.
      const far = this.physics.groundHeight(_gp1.x, _gp1.z, this.position.y + 26, 34);
      if (far !== null && far > this.position.y) {
        this.position.y = far;
        this._vy = 0;
        this._grounded = true;
        g = far;
      }
    }
    if (g !== null && (this.position.y <= g + 0.02 || (this.position.y - g < 0.3 && this._vy <= 0))) {
      this.position.y = g;
      this._vy = 0;
      this._grounded = true;
    } else {
      this._grounded = false;
    }
    this._groundY = g ?? this._groundY;

    // Pitch to the slope, sampled at the two contact patches rather than at
    // arbitrary distances - a bike on a kerb should pitch by exactly the angle
    // its own wheelbase spans.
    const ahead = this.physics.groundHeight(
      this.position.x + fx * (WHEELBASE * 0.5), this.position.z + fz * (WHEELBASE * 0.5),
      this.position.y + 2, 5
    );
    const behind = this.physics.groundHeight(
      this.position.x - fx * (WHEELBASE * 0.5), this.position.z - fz * (WHEELBASE * 0.5),
      this.position.y + 2, 5
    );
    if (ahead !== null && behind !== null) {
      this._pitch = damp(this._pitch, -Math.atan2(ahead - behind, WHEELBASE), 8, dt);
    }

    /* ---- blocked ahead ------------------------------------------------ */
    if (Math.abs(this.speed) > 0.2) {
      _gp2.set(fx * Math.sign(this.speed), 0, fz * Math.sign(this.speed));
      _gp1.set(this.position.x, this.position.y + 0.55, this.position.z);
      const hit = this.physics.raycast(_gp1, _gp2, 0.9, COLLISION_LAYER.WORLD);
      if (hit && Math.abs(hit.normal?.y ?? 0) < 0.6) {
        this.position.x -= _mv1.x * dt;
        this.position.z -= _mv1.z * dt;
        this.speed *= 0.15;
      }
    }

    this.velocity.set(_mv1.x, this._vy, _mv1.z);

    /* ---- everything that turns, geared to the ground ------------------ *
     * Distance over radius for the wheels, distance over development for the
     * cranks. Neither is a rate anybody chose, so neither can skate. */
    const travel = this.speed * dt;
    this._wheel += travel / WHEEL_R;
    // The freewheel is the whole reason these are two separate integrations:
    // stop pedalling and the wheels keep turning while the cranks do not.
    if (throttle > 0.05) this._crank += (travel / DEVELOPMENT) * TAU;
    else if (this.speed < 0) this._crank += (travel / DEVELOPMENT) * TAU;
    this._crank %= TAU;

    void elapsed;
  }

  /* ------------------------------------------------------------------ */
  /* Presentation                                                        */
  /* ------------------------------------------------------------------ */

  update(dt) {
    if (!this._alive) return;
    const s = this._spawnT * (this._despawnT >= 0 ? 1 - this._despawnT : 1);
    this.root.position.copy(this.position);
    this.root.rotation.y = this.heading;
    this.root.scale.setScalar(Math.max(0.01, s));
    this.tilt.rotation.set(this._pitch, 0, this._lean);

    this._steerYaw.rotation.y = this._steer;
    this._frontWheel.rotation.x = this._wheel;
    this._rearWheel.rotation.x = this._wheel;
    this._crankNode.rotation.x = this._crank;
    // Keep the platforms level in the frame: the pedal spindle is free, so a
    // pedal does not rotate with its arm.
    for (let i = 0; i < this._pedals.length; i++) {
      this._pedals[i].rotation.x = -this._crank - (i === 0 ? 0 : Math.PI);
    }
    void dt;
  }

  /* ------------------------------------------------------------------ */
  /* Queries used by MountManager                                        */
  /* ------------------------------------------------------------------ */

  getSeat(out) {
    this.root.position.copy(this.position);
    this.root.rotation.y = this.heading;
    this.tilt.rotation.set(this._pitch, 0, this._lean);
    this.root.updateMatrixWorld(true);
    return out.setFromMatrixPosition(this.riderAnchor.matrixWorld);
  }

  /**
   * Where the rider's foot goes.
   *
   * Seated, that is the pedal platform, which orbits - so the legs pedal
   * simply because they are solved onto something that is going round.
   *
   * Mid-mount it is a point on an arc from the ground beside the bike to that
   * pedal. The near foot stays down until the far leg is over, which is how
   * anyone actually gets on a bicycle, and the arc lifts clear of the saddle
   * rather than dragging the boot through it.
   *
   * @param {number} side -1 left, +1 right
   * @param {THREE.Vector3} out
   * @returns {boolean}
   */
  getStirrupWorld(side, out) {
    const pedal = this.pedalAnchors[side < 0 ? 0 : 1];
    if (!pedal) return false;
    this.root.updateWorldMatrix(true, true);
    out.setFromMatrixPosition(pedal.matrixWorld);

    const t = this._mountT;
    if (t >= 1) return true;

    // The left (near) foot is the one that stays on the ground; the right
    // swings over. Mirrored for the step-off, which runs the same arc back.
    const swinging = side > 0;
    const ground = _an1.setFromMatrixPosition(this.groundAnchor.matrixWorld);
    if (swinging) {
      // Arc: hold on the ground, then lift over the saddle in the back half.
      const u = clamp((t - 0.15) / 0.75, 0, 1);
      const ease = u * u * (3 - 2 * u);
      out.lerpVectors(ground, out, ease);
      // Lift over the saddle: a half sine, tallest at the midpoint of the swing.
      out.y += Math.sin(ease * Math.PI) * 0.55;
    } else {
      // The near foot leaves the ground last and arrives first.
      const u = clamp((t - 0.55) / 0.45, 0, 1);
      const ease = u * u * (3 - 2 * u);
      out.lerpVectors(ground, out, ease);
      out.y += Math.sin(ease * Math.PI) * 0.09;
    }
    return true;
  }

  /** Bar grips, so the arms follow the steering. @returns {boolean} */
  getGripWorld(side, out) {
    const a = this.gripAnchors[side < 0 ? 0 : 1];
    if (!a) return false;
    this.root.updateWorldMatrix(true, true);
    out.setFromMatrixPosition(a.matrixWorld);
    return true;
  }

  /**
   * Where the rider ends up when they step off: beside the bike on the near
   * side, which is the side they swung their leg over towards.
   */
  dismountPoint(out) {
    const rx = Math.cos(this.heading);
    const rz = -Math.sin(this.heading);
    return out.set(
      this.position.x - rx * 0.95,
      this._groundY + 0.05,
      this.position.z - rz * 0.95
    );
  }

  /* ---- state the rider pose and the HUD read ---- */

  /** 0..1 of sprint speed, for the FOV kick and the rider's forward lean. */
  get speed01() {
    return clamp(Math.abs(this.speed) / SPRINT_SPEED, 0, 1);
  }

  /** 0..1 effort. Out of the saddle at 1, spinning easily at 0. */
  get boost01() {
    return this._drive;
  }

  /** Crank angle, so the pose can shift the rider's weight with the stroke. */
  get crankPhase() {
    return this._crank;
  }

  /** 0 standing beside the bike, 1 seated. Drives the mount/dismount blend. */
  get mountBlend() {
    return this._mountT;
  }

  get bankRoll() {
    return this._lean;
  }

  get bankPitch() {
    return this._pitch;
  }

  get airborne() {
    return !this._grounded;
  }

  get boostActive() {
    return this._drive > 0.8;
  }

  get fovKick() {
    return this.speed01 * 0.14;
  }

  dispose() {
    this.kill();
    for (const o of this._owned) o.dispose?.();
    this._owned.length = 0;
  }
}

export default Bicycle;
