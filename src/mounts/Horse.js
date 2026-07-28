import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { COLLISION_LAYER } from '../physics/Physics.js';

/**
 * HORSE - the ground mount.
 *
 * ── What makes a horse different from the other three mounts ──────────────
 * The hoverboard, the car and the dragon are all *vehicles*: they have a
 * throttle, they hold whatever speed you ask for, and they turn at a rate the
 * player sets. A horse is an animal, and three things follow from that:
 *
 *   1. **It has gaits, not a speed dial.** Halt, walk, trot, canter, gallop -
 *      discrete bands with their own footfall pattern, and the animation is
 *      driven by which band you are in rather than by a single blend. That is
 *      what stops it looking like a sofa sliding across the ground.
 *   2. **It leans into turns and cannot pivot.** Steering rate falls off with
 *      speed, so a gallop commits you to a line. Turning a galloping horse on
 *      the spot is the single most common way a mount stops reading as an
 *      animal.
 *   3. **It follows the ground closely.** No suspension, no hover: the hooves
 *      are on the terrain, and the body pitches with the slope it is on.
 *
 * ── Legs ──────────────────────────────────────────────────────────────────
 * Four legs on phase offsets, and the offsets change with the gait, because
 * that *is* the difference between a trot and a gallop. A trot is diagonal
 * pairs in antiphase; a gallop is a four-beat rotary with a moment of
 * suspension. Getting those two patterns right is most of what sells it, and
 * neither costs anything beyond a different phase table.
 *
 * ── Build ─────────────────────────────────────────────────────────────────
 * Everything static is merged into one geometry per material, and only the
 * parts that must articulate - four legs, neck, head, tail - stay separate.
 * That keeps a horse at about eight draw calls rather than forty.
 */

const TAU = Math.PI * 2;
const clamp = THREE.MathUtils.clamp;
const damp = THREE.MathUtils.damp;

/* Scratch, one block per method. */
const _hs1 = new THREE.Vector3();   // getSeat
const _gp1 = new THREE.Vector3();   // ground probe
const _gp2 = new THREE.Vector3();
const _mv1 = new THREE.Vector3();   // fixedUpdate

/** Withers height - the rider sits a little behind and above it. */
const BODY_Y = 1.42;
/** Distance from the shoulder to the hip. */
const BARREL = 1.34;
/** Half the track between left and right legs. */
const TRACK = 0.34;

/** Gait bands, in metres per second. */
/**
 * Gait bands. `stride` is the ground covered by one *complete* cycle of all
 * four legs, so speed / stride is the cycle rate that drives both the legs and
 * the hoofbeats.
 *
 * These were originally 2.1 / 3.0 / 2.5 / 2.2, which has a gallop taking a
 * shorter stride than a trot - backwards, and short enough that the animal ran
 * at seven cycles a second. Real horses manage about two and a half. The legs
 * blurred, and once the hooves were given a voice it came out as twenty-eight
 * beats a second: not a gallop, a sewing machine. A horse lengthens its stride
 * as it speeds up, which is most of where the extra speed comes from.
 */
const GAITS = [
  { name: 'halt', max: 0.2, stride: 0, lift: 0, bob: 0 },
  { name: 'walk', max: 2.6, stride: 2.6, lift: 0.17, bob: 0.035 },
  { name: 'trot', max: 6.4, stride: 4.4, lift: 0.28, bob: 0.075 },
  { name: 'canter', max: 10.5, stride: 5.6, lift: 0.36, bob: 0.13 },
  { name: 'gallop', max: Infinity, stride: 6.8, lift: 0.44, bob: 0.2 },
];

/**
 * Leg phase offsets per gait, in turns, ordered [FL, FR, HL, HR].
 *
 * These are the real footfall patterns and they are the whole reason the gaits
 * read differently: a walk is an even four-beat, a trot is diagonal pairs
 * exactly out of phase, and a gallop is a rotary sequence with the hind pair
 * landing close together and a moment of suspension after them.
 */
const PHASE = {
  halt: [0, 0, 0, 0],
  walk: [0, 0.5, 0.25, 0.75],
  trot: [0, 0.5, 0.5, 0],
  canter: [0, 0.15, 0.55, 0.7],
  gallop: [0, 0.12, 0.5, 0.62],
};

const MAX_SPEED = 15.5;
const GALLOP_SPEED = 15.5;
const CRUISE_SPEED = 8.4;
const ACCEL = 7.0;
const BRAKE = 11.0;
/** Steering, radians per second, at a standstill and at full gallop. */
const TURN_SLOW = 2.5;
const TURN_FAST = 0.85;
/** How far the horse can step up without being blocked. */
const STEP_UP = 0.75;
const GRAVITY = -22;
const JUMP_V = 7.6;

function box(w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

function merge(list) {
  const clean = list.map((g) => (g.index ? g.toNonIndexed() : g));
  const m = mergeGeometries(clean, false);
  for (const g of clean) g.dispose();
  return m;
}

export class Horse {
  /**
   * @param {{scene:THREE.Scene, engine:any, physics:any, bus:any, materials:any,
   *          camera:THREE.PerspectiveCamera}} ctx
   */
  constructor({ scene, engine, physics, bus, materials, camera }) {
    this.id = 'horse';
    this.displayName = 'HORSE';
    /** Seated astride, like the dragon - not standing, like the board. */
    this.riderPose = 'ride';
    /** Spawned this far in front of the player. */
    this.spawnDistance = 3.4;

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
    this._roll = 0;
    this._gait = GAITS[0];
    this._stridePhase = 0;
    this._alive = false;
    this._ridden = false;
    this._spawnT = 1;
    this._despawnT = -1;
    this._time = 0;
    this._headBob = 0;

    this._owned = [];
    this._build();
  }

  /* ------------------------------------------------------------------ */
  /* Build                                                               */
  /* ------------------------------------------------------------------ */

  _mat(color, opts = {}) {
    const m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      roughness: opts.roughness ?? 0.78,
      metalness: opts.metalness ?? 0.05,
      ...opts,
    });
    this._owned.push(m);
    return m;
  }

  _build() {
    this.root = new THREE.Group();
    this.root.name = 'mount:horse';

    // A single tilt node under the root carries pitch and roll, so the legs
    // (which hang off the body) inherit the body's attitude for free.
    this.tilt = new THREE.Group();
    this.root.add(this.tilt);

    const coat = this._mat(0x5b4230, { roughness: 0.82 });
    const dark = this._mat(0x2a1d14, { roughness: 0.75 });
    const hair = this._mat(0x1d140e, { roughness: 0.9 });
    const tack = this._mat(0x6d4522, { roughness: 0.6, metalness: 0.15 });
    const metal = this._mat(0xb9a06a, { roughness: 0.35, metalness: 0.9 });

    /* ---- barrel, chest, hindquarters: one merged body ---- */
    const body = merge([
      box(0.78, 0.86, BARREL, 0, BODY_Y, 0),
      box(0.86, 0.9, 0.5, 0, BODY_Y + 0.02, -BARREL * 0.42),      // chest
      box(0.9, 0.94, 0.62, 0, BODY_Y + 0.04, BARREL * 0.4),       // hindquarters
      box(0.7, 0.5, 0.34, 0, BODY_Y - 0.36, -BARREL * 0.3),       // brisket
    ]);
    this._owned.push(body);
    const bodyMesh = new THREE.Mesh(body, coat);
    bodyMesh.castShadow = true;
    bodyMesh.receiveShadow = true;
    this.tilt.add(bodyMesh);

    /* ---- neck + head, on their own pivot so they can nod ---- */
    this.neck = new THREE.Group();
    this.neck.position.set(0, BODY_Y + 0.3, -BARREL * 0.55);
    this.tilt.add(this.neck);
    const neckGeo = merge([
      box(0.42, 0.86, 0.5, 0, 0.4, -0.18, 0.42),
      box(0.36, 0.3, 0.42, 0, 0.78, -0.5, 0.42),
    ]);
    this._owned.push(neckGeo);
    const neckMesh = new THREE.Mesh(neckGeo, coat);
    neckMesh.castShadow = true;
    this.neck.add(neckMesh);

    this.head = new THREE.Group();
    this.head.position.set(0, 0.92, -0.62);
    this.neck.add(this.head);
    const headGeo = merge([
      box(0.3, 0.34, 0.62, 0, 0, -0.2, 0.2),
      box(0.26, 0.2, 0.26, 0, -0.1, -0.48, 0.2),  // muzzle
    ]);
    this._owned.push(headGeo);
    const headMesh = new THREE.Mesh(headGeo, coat);
    headMesh.castShadow = true;
    this.head.add(headMesh);
    // Bridle, so it reads as tacked up rather than wild.
    const bridle = new THREE.Mesh(box(0.32, 0.05, 0.05, 0, -0.02, -0.3), tack);
    this.head.add(bridle);

    /* Ears on their own pivots rather than merged into the skull.
     *
     * Two extra nodes, and they carry more of the animal's state than any other
     * part of it: pinned flat at the gallop, forward and flicking at rest. A
     * horse whose ears never move is a statue of a horse, however well its legs
     * are animated. */
    this.ears = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.1, 0.14, 0.04);
      const geo = box(0.07, 0.18, 0.07, 0, 0.09, 0);
      this._owned.push(geo);
      pivot.add(new THREE.Mesh(geo, coat));
      this.head.add(pivot);
      this.ears.push(pivot);
    }

    // Mane along the crest, on a pivot so it can lift and stream.
    this.mane = new THREE.Group();
    this.mane.position.set(0, 0.36, -0.12);
    this.neck.add(this.mane);
    const maneGeo = merge([
      box(0.08, 0.3, 0.8, 0, 0.14, -0.08, 0.42),
      box(0.08, 0.22, 0.4, 0, 0.5, -0.4, 0.42),
    ]);
    this._owned.push(maneGeo);
    this.mane.add(new THREE.Mesh(maneGeo, hair));

    /* ---- saddle + stirrups ---- */
    const saddleGeo = merge([
      box(0.72, 0.16, 0.72, 0, BODY_Y + 0.47, 0.02),
      box(0.5, 0.22, 0.12, 0, BODY_Y + 0.58, -0.3),   // pommel
      box(0.56, 0.2, 0.12, 0, BODY_Y + 0.56, 0.34),   // cantle
    ]);
    this._owned.push(saddleGeo);
    const saddle = new THREE.Mesh(saddleGeo, tack);
    saddle.castShadow = true;
    this.tilt.add(saddle);
    for (const sx of [-0.46, 0.46]) {
      const st = new THREE.Mesh(box(0.06, 0.42, 0.06, sx, BODY_Y + 0.18, 0.04), metal);
      this.tilt.add(st);
      const tread = new THREE.Mesh(box(0.18, 0.05, 0.14, sx, BODY_Y - 0.04, 0.04), metal);
      this.tilt.add(tread);
    }

    /* ---- rider anchor ---- */
    this.riderAnchor = new THREE.Object3D();
    this.riderAnchor.position.set(0, BODY_Y + 0.62, 0.02);
    this.tilt.add(this.riderAnchor);
    /** Where the rider's boots go, so the mount rider IK has a target. */
    this.footAnchors = [];
    for (const sx of [-0.5, 0.5]) {
      const f = new THREE.Object3D();
      f.position.set(sx, BODY_Y - 0.02, 0.04);
      this.tilt.add(f);
      this.footAnchors.push(f);
    }

    /* ---- tail ---- */
    this.tail = new THREE.Group();
    this.tail.position.set(0, BODY_Y + 0.3, BARREL * 0.62);
    this.tilt.add(this.tail);
    const tailGeo = merge([box(0.16, 0.72, 0.16, 0, -0.3, 0.1, -0.3)]);
    this._owned.push(tailGeo);
    this.tail.add(new THREE.Mesh(tailGeo, hair));

    /* ---- legs ---- *
     * Order is [front-left, front-right, hind-left, hind-right] to match the
     * phase tables. Each is a two-segment chain so the knee can actually fold;
     * a single rigid leg swinging from the shoulder reads as a table being
     * dragged. */
    this.legs = [];
    const legSpec = [
      { x: -TRACK, z: -BARREL * 0.36, front: true },
      { x: TRACK, z: -BARREL * 0.36, front: true },
      { x: -TRACK, z: BARREL * 0.38, front: false },
      { x: TRACK, z: BARREL * 0.38, front: false },
    ];
    for (const spec of legSpec) {
      const hipY = BODY_Y - (spec.front ? 0.16 : 0.1);
      const upper = new THREE.Group();
      upper.position.set(spec.x, hipY, spec.z);
      this.tilt.add(upper);
      const upperGeo = box(0.22, 0.62, 0.24, 0, -0.31, 0);
      this._owned.push(upperGeo);
      const upperMesh = new THREE.Mesh(upperGeo, coat);
      upperMesh.castShadow = true;
      upper.add(upperMesh);

      const lower = new THREE.Group();
      lower.position.set(0, -0.62, 0);
      upper.add(lower);
      const lowerGeo = merge([
        box(0.15, 0.6, 0.16, 0, -0.3, 0),
        box(0.2, 0.14, 0.26, 0, -0.63, 0.02),   // hoof
      ]);
      this._owned.push(lowerGeo);
      const lowerMesh = new THREE.Mesh(lowerGeo, spec.front ? coat : coat);
      lowerMesh.castShadow = true;
      lower.add(lowerMesh);
      const hoof = new THREE.Mesh(box(0.22, 0.1, 0.28, 0, -0.66, 0.02), dark);
      lower.add(hoof);

      this.legs.push({ upper, lower, front: spec.front, prevT: 0 });
    }

    this.root.visible = false;
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
    // Local probe, as the other mounts do: a cast from the sky finds whatever
    // roof happens to be overhead and spawns the horse on top of it.
    const g = this.physics.groundHeight(position.x, position.z, position.y + 1.8, 12);
    this._groundY = g === null ? position.y : g;
    this.position.y = this._groundY;
    this.heading = yaw;
    this.velocity.set(0, 0, 0);
    this.speed = 0;
    this._vy = 0;
    this._pitch = 0;
    this._roll = 0;
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
    this.setVisible(false);
    this.root.removeFromParent();
  }

  onMount() {
    this._ridden = true;
  }

  onDismount() {
    this._ridden = false;
  }

  /**
   * Any time the horse has its feet on the ground.
   *
   * A ground mount has no landing sequence to run, but the method still has to
   * exist: {@link MountManager.dismount} reads `canDismount?.()`, and an absent
   * method returns `undefined`, which it cannot tell apart from "not safe yet".
   * Without this, stepping off a horse standing still needs two presses of F.
   *
   * Refusing mid-jump is deliberate and costs the player nothing - gravity ends
   * the jump within a second and the manager completes the dismount itself.
   */
  canDismount() {
    return this._grounded;
  }

  /** Pull up. There is nowhere to land from, so this only sheds speed. */
  requestLanding() {
    this.speed *= 0.35;
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

    if (this._spawnT < 1) this._spawnT = Math.min(1, this._spawnT + dt * 1.6);
    if (this._despawnT >= 0) {
      this._despawnT += dt * 1.8;
      if (this._despawnT >= 1) { this.kill(); return; }
    }

    const ridden = !!ctrl;
    const throttle = ridden ? clamp(ctrl.throttle, -1, 1) : 0;
    const steer = ridden ? -clamp(ctrl.strafe, -1, 1) : 0;
    const gallop = ridden && !!ctrl.boost && throttle > 0.1;

    /* ---- gait target ------------------------------------------------- */
    let target = 0;
    if (throttle > 0.05) target = gallop ? GALLOP_SPEED : CRUISE_SPEED * throttle;
    else if (throttle < -0.05) target = CRUISE_SPEED * 0.28 * throttle;  // rein back

    const rate = target > this.speed ? ACCEL : BRAKE;
    this.speed = damp(this.speed, target, rate * 0.35, dt);
    if (Math.abs(this.speed) < 0.05) this.speed = 0;
    this.speed = clamp(this.speed, -4, MAX_SPEED);

    /* ---- steering ---------------------------------------------------- *
     * Rate falls off with speed. A horse that can pivot at a gallop stops
     * being a horse - the commitment to a line is most of what riding one
     * feels like. */
    const sp01 = clamp(Math.abs(this.speed) / MAX_SPEED, 0, 1);
    const turnRate = THREE.MathUtils.lerp(TURN_SLOW, TURN_FAST, sp01);
    if (steer !== 0 && (Math.abs(this.speed) > 0.15 || !gallop)) {
      this.heading += steer * turnRate * dt;
    }
    // Lean into the turn, proportional to how fast we are going round it.
    const leanTarget = -steer * sp01 * 0.22;
    this._roll = damp(this._roll, leanTarget, 6, dt);
    // Smoothed, and kept for the frame update: the head and shoulders carry the
    // turn as much as the roll does, and they must not snap when the key does.
    this._turnRate = damp(this._turnRate ?? 0, steer, 5, dt);

    /* ---- jump -------------------------------------------------------- */
    if (ridden && ctrl.up > 0.5 && this._grounded) {
      this._vy = JUMP_V;
      this._grounded = false;
      this.bus?.emit('mount:jump', { id: this.id });
    }

    /* ---- integrate --------------------------------------------------- */
    const fx = -Math.sin(this.heading);
    const fz = -Math.cos(this.heading);
    _mv1.set(fx * this.speed, 0, fz * this.speed);
    this.position.x += _mv1.x * dt;
    this.position.z += _mv1.z * dt;

    this._vy += GRAVITY * dt;
    this.position.y += this._vy * dt;

    /* ---- ground follow ----------------------------------------------- *
     * Probed from above the current position so a step up is caught, and the
     * body pitches to the slope it is standing on. */
    _gp1.set(this.position.x, this.position.y + STEP_UP + 0.4, this.position.z);
    const g = this.physics.groundHeight(_gp1.x, _gp1.z, _gp1.y, STEP_UP + 4.5);
    if (g !== null && this.position.y <= g + 0.02) {
      this.position.y = g;
      this._vy = 0;
      this._grounded = true;
    } else if (g !== null && this.position.y - g < 0.35 && this._vy <= 0) {
      this.position.y = g;
      this._vy = 0;
      this._grounded = true;
    } else {
      this._grounded = false;
    }
    this._groundY = g ?? this._groundY;

    // Pitch to the slope: sample a little ahead and behind.
    const ahead = this.physics.groundHeight(
      this.position.x + fx * 0.9, this.position.z + fz * 0.9, this.position.y + 2, 5
    );
    const behind = this.physics.groundHeight(
      this.position.x - fx * 0.9, this.position.z - fz * 0.9, this.position.y + 2, 5
    );
    if (ahead !== null && behind !== null) {
      const slope = Math.atan2(ahead - behind, 1.8);
      this._pitch = damp(this._pitch, -slope, 7, dt);
    }

    /* ---- blocked ahead ------------------------------------------------ *
     * One forward ray at chest height. A horse cannot walk through a wall, and
     * a full capsule resolve is more than this needs - stopping dead is the
     * correct and readable failure. */
    if (Math.abs(this.speed) > 0.2) {
      _gp2.set(fx * Math.sign(this.speed), 0, fz * Math.sign(this.speed));
      _gp1.set(this.position.x, this.position.y + 1.0, this.position.z);
      const hit = this.physics.raycast(_gp1, _gp2, 1.25, COLLISION_LAYER.WORLD);
      if (hit && Math.abs(hit.normal?.y ?? 0) < 0.6) {
        this.position.x -= _mv1.x * dt;
        this.position.z -= _mv1.z * dt;
        this.speed *= 0.25;
      }
    }

    this.velocity.set(_mv1.x, this._vy, _mv1.z);

    /* ---- gait selection + stride phase -------------------------------- */
    const abs = Math.abs(this.speed);
    let gait = GAITS[0];
    for (const gt of GAITS) { gait = gt; if (abs <= gt.max) break; }
    this._gait = gait;
    if (gait.stride > 0) {
      // Phase advances with distance travelled, not with time, so the hooves
      // do not skate when the horse changes speed.
      this._stridePhase = (this._stridePhase + (abs * dt) / gait.stride) % 1;
    }
    void elapsed;
  }

  /* ------------------------------------------------------------------ */
  /* Pose                                                                */
  /* ------------------------------------------------------------------ */

  update(dt) {
    if (!this._alive) return;
    const s = this._spawnT * (this._despawnT >= 0 ? 1 - this._despawnT : 1);
    this.root.position.copy(this.position);
    this.root.rotation.y = this.heading;
    this.root.scale.setScalar(Math.max(0.01, s));
    this.tilt.rotation.set(this._pitch, 0, this._roll);

    const gait = this._gait;
    const phase = this._stridePhase;
    const table = PHASE[gait.name] ?? PHASE.walk;

    for (let i = 0; i < this.legs.length; i++) {
      const leg = this.legs[i];
      const t = (phase + table[i]) % 1;
      // Swing phase over the first 40% of the cycle, stance for the rest -
      // that asymmetry is what makes a leg look like it is pushing off rather
      // than pedalling.
      let swing;
      let lift;
      if (t < 0.4) {
        const u = t / 0.4;
        swing = Math.sin(u * Math.PI) * (leg.front ? 0.85 : 0.7);
        lift = Math.sin(u * Math.PI) * gait.lift;
      } else {
        const u = (t - 0.4) / 0.6;
        swing = -Math.sin(u * Math.PI) * (leg.front ? 0.5 : 0.62);
        lift = 0;
      }
      leg.upper.rotation.x = swing;
      // The knee folds only on the way through, and only forwards.
      leg.lower.rotation.x = -Math.max(0, swing) * (leg.front ? 0.8 : 1.05);
      leg.upper.position.y = (leg.front ? BODY_Y - 0.16 : BODY_Y - 0.1) + lift * 0.12;

      /* The instant this hoof touches down.
       *
       * t = 0.4 is where the swing ends and the stance begins, which is by
       * definition the moment the foot is on the ground. Taking the sound from
       * the same phase table that placed the leg is the only way four hooves
       * land audibly in the pattern they visibly land in - a timer would drift
       * out of step with the gait within a couple of strides, and a trot that
       * sounds like a canter is worse than no sound at all. */
      const landed = leg.prevT < 0.4 && t >= 0.4;
      leg.prevT = t;
      if (landed && this._grounded && Math.abs(this.speed) > 0.4) {
        this.bus?.emit('mount:footfall', {
          id: this.id,
          position: this.position,
          hard: clamp(Math.abs(this.speed) / MAX_SPEED, 0.15, 1),
        });
      }
    }

    // Body bob, twice a stride, and the head nods against it - a horse's head
    // moves in opposition to its body, which is the tell that it is alive.
    const bob = Math.sin(phase * TAU * 2) * gait.bob;
    this.tilt.position.y = bob;
    this._headBob = damp(this._headBob, Math.sin(phase * TAU) * gait.bob * 2.2, 10, dt);
    this.neck.rotation.x = -0.06 + this._headBob;
    this.head.rotation.x = 0.1 - this._headBob * 0.6;

    // Tail streams with speed and swings gently at rest.
    const sp01 = clamp(Math.abs(this.speed) / MAX_SPEED, 0, 1);
    this.tail.rotation.x = -0.15 - sp01 * 0.55;
    this.tail.rotation.z = Math.sin(this._time * 2.2) * (0.12 - sp01 * 0.08);

    /* ---- the parts that separate a gallop from a fast walk -------------- *
     *
     * Leg timing alone reads as one animation played at different rates. What
     * actually distinguishes the gaits to the eye is the whole animal changing
     * shape: a galloping horse flattens out and reaches with its neck, a halted
     * one stands up and looks around. All of it is driven off the same speed and
     * stride phase, so nothing can fall out of sync with the legs. */

    // Neck lowers and extends into the gallop, rises at the halt.
    const reach = sp01 * sp01;
    this.neck.rotation.x = -0.06 + this._headBob + reach * 0.42;
    this.head.rotation.x = 0.1 - this._headBob * 0.6 - reach * 0.3;

    // Body flexes along its length twice a stride, strongest at the gallop -
    // this is the bunch-and-extend that makes the animal look like it is
    // driving off its hind legs rather than being pushed along.
    this.tilt.rotation.x = this._pitch + Math.sin(phase * TAU * 2) * gait.bob * 0.5 * (0.3 + reach);

    // Lean into the turn. A horse banks a little and, more visibly, carries its
    // head to the inside of the corner.
    const lean = clamp(this._turnRate ?? 0, -1, 1);
    this.tilt.rotation.z = this._roll - lean * 0.16 * sp01;
    this.neck.rotation.y = damp(this.neck.rotation.y ?? 0, -lean * 0.3, 6, dt);

    /* Ears, which cost two rotations and do more for "alive" than anything else
     * here: swivelled back flat at the gallop, forward and flicking at rest. */
    if (this.ears) {
      const flick = Math.sin(this._time * 3.1) * Math.sin(this._time * 1.3);
      for (let i = 0; i < this.ears.length; i++) {
        const side = i === 0 ? -1 : 1;
        this.ears[i].rotation.x = -reach * 0.9 + (1 - sp01) * flick * 0.18;
        this.ears[i].rotation.z = side * (0.12 + reach * 0.35);
      }
    }

    // Mane lifts and streams behind at speed.
    if (this.mane) {
      this.mane.rotation.x = -0.1 - sp01 * 0.7 + Math.sin(phase * TAU * 2) * 0.12 * sp01;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Queries used by MountManager                                        */
  /* ------------------------------------------------------------------ */

  getSeat(out) {
    this.root.position.copy(this.position);
    this.root.rotation.y = this.heading;
    this.tilt.rotation.set(this._pitch, 0, this._roll);
    this.root.updateMatrixWorld(true);
    return out.setFromMatrixPosition(this.riderAnchor.matrixWorld);
  }

  /**
   * World position of a stirrup, so the rider's foot IK has somewhere to go.
   * @param {number} side -1 left, +1 right
   * @param {THREE.Vector3} out
   * @param {number} [lift] metres up the mount's own axis
   */
  getFootWorld(side, out, lift = 0) {
    const a = this.footAnchors[side < 0 ? 0 : 1];
    this.root.updateWorldMatrix(true, true);
    out.setFromMatrixPosition(a.matrixWorld);
    if (lift) out.y += lift;
    return out;
  }

  /**
   * Where the rider ends up when they step off. Beside the horse, on the
   * ground - `MountManager` resolves the capsule from here, so it only has to
   * be approximately right, not guaranteed clear.
   * @param {THREE.Vector3} out
   */
  dismountPoint(out) {
    const rx = Math.cos(this.heading);
    const rz = -Math.sin(this.heading);
    return out.set(
      this.position.x + rx * 1.35,
      this._groundY + 0.05,
      this.position.z + rz * 1.35
    );
  }

  /** 0..1 speed, for camera FOV kick and audio. */
  get speed01() {
    return clamp(Math.abs(this.speed) / MAX_SPEED, 0, 1);
  }

  get bankRoll() {
    return this._roll;
  }

  get bankPitch() {
    return this._pitch;
  }

  get airborne() {
    return !this._grounded;
  }

  get boostActive() {
    return this._gait.name === 'gallop';
  }

  /** Current gait name, for the HUD. */
  get gait() {
    return this._gait.name;
  }

  get fovKick() {
    return this.speed01 * 0.16;
  }

  dispose() {
    this.kill();
    for (const o of this._owned) o.dispose?.();
    this._owned.length = 0;
  }
}

export default Horse;
