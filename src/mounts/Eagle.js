import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { sweep, blob, blade } from '../gfx/Organic.js';
import { applyLivery, MOUNT_STATS } from './Livery.js';

/**
 * EAGLE - the flight mount.
 *
 * ── Why it is not a smaller dragon ────────────────────────────────────────
 * The dragon is a powered aircraft: it beats, it climbs when you ask, and it
 * holds altitude. An eagle is a *glider* with a limited engine, and that single
 * difference is the whole design:
 *
 *   1. **Height is a resource.** Level flight bleeds altitude. You buy height
 *      back by beating your wings, which costs stamina, or by finding a thermal.
 *      That turns every flight into a budget rather than a free camera.
 *   2. **Speed and height trade.** Dive and you gain speed; pull up and you
 *      convert it back into altitude. A pure energy exchange, and it is what
 *      makes swooping from the great tower to the far wall feel like flying
 *      rather than like driving in the air.
 *   3. **It never hovers.** Below stall speed it drops. There is no stationary
 *      hang, because a bird that can park in mid-air is a drone.
 *
 * ── Thermals ──────────────────────────────────────────────────────────────
 * The citadel is a hot mesa, so its cliff faces and its stone town generate
 * rising air. Rather than author thermals as data, lift is derived from what is
 * *underneath* the bird: high ground and sun-facing stone push up, and the void
 * off the cliff edge does not. That is free, it needs no world support, and it
 * happens to put the strongest lift exactly along the cliff rim - which is
 * where a player launching from the viewpoint already is.
 *
 * ── Wings ─────────────────────────────────────────────────────────────────
 * Three segments a side - shoulder, elbow, hand - because a two-bone wing can
 * only flap and a real wing *folds*. The fold is what reads as a dive: the
 * silhouette narrows as speed rises, entirely from the same three angles.
 */

const TAU = Math.PI * 2;
const clamp = THREE.MathUtils.clamp;
const damp = THREE.MathUtils.damp;

const _es1 = new THREE.Vector3();  // getSeat
const _ev1 = new THREE.Vector3();  // fixedUpdate
const _eg1 = new THREE.Vector3();  // ground probe

/** Level-flight cruise, and the speed below which it stalls and drops. */
const CRUISE = 22;
const STALL = 9;
const MAX_SPEED = 46;
/** Metres per second of altitude lost in unpowered level flight. */
const SINK = 3.4;
/** Climb rate while beating, and what a beat costs per second. */
const BEAT_CLIMB = 9.5;
const BEAT_STAMINA = 12;
/** Pitch and yaw authority, radians per second. */
const PITCH_RATE = 1.15;
const TURN_RATE = 1.35;
/** How hard a bank turns the bird - a bird steers with its roll, not its tail. */
const BANK_TURN = 1.5;
const MAX_BANK = 1.15;
/** Thermal strength, and how far below the bird it samples for hot ground. */
const THERMAL_MAX = 7.5;
const THERMAL_PROBE = 90;
/** How fast the bird turns itself back when it strays out over the void. */
const TURN_BACK = 1.1;

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

export class Eagle {
  /** Colour slots the F10 menu offers. `defaultColor` = factory swatch. */
  static CUSTOM_SLOTS = Object.freeze([
    Object.freeze({ id: 'plumage', label: 'Plumage', finish: false, defaultColor: 0x6b4c30, palette: 'natural' }),
    Object.freeze({ id: 'harness', label: 'Harness', finish: true, defaultColor: 0x6d4522, palette: 'paint' }),
  ]);
  static STATS = MOUNT_STATS.eagle;

  /**
   * @param {{scene:THREE.Scene, engine:any, physics:any, bus:any, materials:any,
   *          camera:THREE.PerspectiveCamera, player?:any}} ctx
   */
  constructor({ scene, engine, physics, bus, materials, camera, player }) {
    this.id = 'eagle';
    this.displayName = 'EAGLE';
    this.riderPose = 'ride';
    this.spawnDistance = 4.2;

    this.scene = scene;
    this.engine = engine;
    this.physics = physics;
    this.bus = bus;
    this.materials = materials;
    this.camera = camera;
    this.player = player ?? null;

    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.heading = 0;
    this.speed = CRUISE;
    this._pitch = 0;
    this._bank = 0;
    this._beat = 0;          // 0..1 how hard we are flapping
    this._flapPhase = 0;
    this._thermal = 0;
    this._alive = false;
    this._ridden = false;
    this._spawnT = 1;
    this._despawnT = -1;
    this._time = 0;
    this._grounded = false;
    this._landing = false;
    this._lastGround = new THREE.Vector3();
    this._haveGround = false;
    this._void = 0;

    /** Purchased-power multipliers, 1 == stock (see MountManager.grantPower). */
    this._powerMul = 1;
    this._accelMul = 1;
    this._staminaMul = 1;
    this._shieldTier = 0;
    this._livery = null;
    this._slotMats = null;

    this._owned = [];
    this._build();
  }

  /**
   * A surface for this bird. See the note on `Horse._mat` - same contract, same
   * reason: a flat colour with no normal map reads as plastic no matter how
   * dense the mesh is.
   */
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
      } catch { /* fall through to the flat material below */ }
    }
    const m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      roughness: rest.roughness ?? 0.72,
      metalness: rest.metalness ?? 0.04,
      ...rest,
    });
    this._owned.push(m);
    return m;
  }

  _build() {
    this.root = new THREE.Group();
    this.root.name = 'mount:eagle';
    this.tilt = new THREE.Group();
    this.root.add(this.tilt);

    // Body and head take the feather bake; the flight feathers take it too but
    // darker, so the primaries read against the coverts. The beak is keratin.
    /* Feathers tile far denser across a wing than along a body - see the note
     * on the horse's coat for why the ratio is not 1:1. */
    const body = this._mat(0x6b4c30, { surface: 'hide.feather:5,8' });
    const headMat = this._mat(0xf2ede2, { surface: 'hide.feather:4,6' });
    const beakMat = this._mat(0xe2a92c, { roughness: 0.38, metalness: 0.18 });
    const flight = this._mat(0x4a3626, { surface: 'hide.feather:2,3' });
    const tackMat = this._mat(0x6d4522, { roughness: 0.6 });
    this._slotMats = { plumage: [body, flight], harness: [tackMat] };

    /* ---- torso ----
     *
     * One swept surface from the base of the neck to the tail root. A bird's
     * body is the most obviously streamlined shape in nature and three stacked
     * boxes made a brick of it; the section swells to a deep keel just behind
     * the shoulder - where all the flight muscle is - and tapers away aft. */
    const torso = merge([
      sweep([
        { y: 0.06, z: -1.20, rx: 0.16, ry: 0.17 },   // base of the neck
        { y: 0.00, z: -0.95, rx: 0.28, ry: 0.29 },
        { y: -0.04, z: -0.55, rx: 0.36, ry: 0.35 },  // breast, deepest keel
        { y: -0.02, z: -0.10, rx: 0.37, ry: 0.34 },
        { y: 0.02, z: 0.45, rx: 0.32, ry: 0.29 },
        { y: 0.04, z: 0.90, rx: 0.24, ry: 0.21 },    // rump
        { y: 0.04, z: 1.18, rx: 0.13, ry: 0.12 },    // tail root
      ], 20),
    ]);
    this._owned.push(torso);
    const torsoMesh = new THREE.Mesh(torso, body);
    torsoMesh.castShadow = true;
    this.tilt.add(torsoMesh);

    /* ---- head, white, on a short neck ---- */
    this.head = new THREE.Group();
    this.head.position.set(0, 0.2, -1.28);
    this.tilt.add(this.head);
    /* Swept skull, with the brow ridge that gives a raptor its glare. */
    const headGeo = merge([
      sweep([
        { y: -0.02, z: 0.16, rx: 0.15, ry: 0.15 },
        { y: 0.00, z: 0.00, rx: 0.17, ry: 0.17 },   // crown
        { y: -0.01, z: -0.18, rx: 0.14, ry: 0.14 },
        { y: -0.03, z: -0.32, rx: 0.10, ry: 0.10 },
      ], 16),
      blob(0.13, 0.05, 0.09, 0, 0.07, -0.14, 10),   // brow
    ]);
    this._owned.push(headGeo);
    const hm = new THREE.Mesh(headGeo, headMat);
    hm.castShadow = true;
    this.head.add(hm);
    /* Hooked beak: swept, then dropped at the tip. Nothing says raptor like
     * the downward hook, and a straight box reads as a duck. */
    const beakGeo = sweep([
      { y: -0.01, z: -0.30, rx: 0.085, ry: 0.09 },
      { y: -0.03, z: -0.40, rx: 0.070, ry: 0.075 },
      { y: -0.07, z: -0.50, rx: 0.048, ry: 0.055 },
      { y: -0.14, z: -0.55, rx: 0.026, ry: 0.036 },
      { y: -0.19, z: -0.545, rx: 0.010, ry: 0.016 },
    ], 12);
    this._owned.push(beakGeo);
    this.head.add(new THREE.Mesh(beakGeo, beakMat));

    /* ---- wings: three segments a side ---- *
     * Shoulder, elbow, hand. A two-bone wing can only flap; the third joint is
     * what lets it *fold*, and the fold is the entire visual difference between
     * a soar and a dive. */
    this.wings = [];
    for (const side of [-1, 1]) {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.3, 0.16, -0.15);
      this.tilt.add(shoulder);

      // Wing bones as aerofoils: thick at the leading edge, thin at the trailing.
      const armGeo = sweep([
        { x: 0, y: 0, z: 0.02, rx: 0.11, ry: 0.10 },
        { x: side * 0.5, y: 0.01, z: 0.03, rx: 0.36, ry: 0.075 },
        { x: side * 1.05, y: 0.01, z: 0.04, rx: 0.36, ry: 0.06 },
        { x: side * 1.48, y: 0, z: 0.04, rx: 0.30, ry: 0.05 },
      ], 12, { capStart: false });
      this._owned.push(armGeo);
      const arm = new THREE.Mesh(armGeo, body);
      arm.castShadow = true;
      shoulder.add(arm);

      const elbow = new THREE.Group();
      elbow.position.set(side * 1.5, 0, 0);
      shoulder.add(elbow);
      const foreGeo = sweep([
        { x: 0, y: 0, z: 0.05, rx: 0.28, ry: 0.055 },
        { x: side * 0.6, y: 0, z: 0.07, rx: 0.30, ry: 0.048 },
        { x: side * 1.2, y: 0, z: 0.08, rx: 0.26, ry: 0.040 },
        { x: side * 1.53, y: 0, z: 0.08, rx: 0.18, ry: 0.032 },
      ], 12, { capStart: false });
      this._owned.push(foreGeo);
      const fore = new THREE.Mesh(foreGeo, body);
      fore.castShadow = true;
      elbow.add(fore);

      const hand = new THREE.Group();
      hand.position.set(side * 1.55, 0, 0);
      elbow.add(hand);
      // Primaries: separate slats, which is what makes the wingtip read as
      // feathers rather than as a board.
      const prim = [];
      for (let i = 0; i < 6; i++) {
        const len = 1.35 - i * 0.1;
        const spread = i * 0.055;
        // A real feather: tapered, slightly curved, and with thickness so it
        // catches light and casts a shadow instead of vanishing edge-on.
        const f = blade(len, 0.19, 0.07, 0.035, 0.16 + i * 0.02, 5);
        f.rotateZ(-Math.PI / 2 * side);
        f.rotateY(side * spread);
        f.translate(side * 0.05, 0, 0.16 + i * 0.19);
        prim.push(f);
      }
      const primGeo = merge(prim);
      this._owned.push(primGeo);
      const primMesh = new THREE.Mesh(primGeo, flight);
      primMesh.castShadow = true;
      hand.add(primMesh);

      this.wings.push({ side, shoulder, elbow, hand });
    }

    /* ---- tail fan ---- */
    this.tail = new THREE.Group();
    this.tail.position.set(0, 0.02, 1.15);
    this.tilt.add(this.tail);
    // Tail as separate rectrices, so the fan reads as feathers when it spreads.
    const rects = [];
    for (let i = -3; i <= 3; i++) {
      const t = Math.abs(i) / 3;
      const len = 1.25 - t * 0.32;
      const f = blade(len, 0.17, 0.10, 0.032, 0.05, 4);
      f.rotateY(Math.PI);
      f.rotateY(i * 0.115);
      f.translate(0, 0, 0.06);
      rects.push(f);
    }
    const tailGeo = merge(rects);
    this._owned.push(tailGeo);
    const tm = new THREE.Mesh(tailGeo, flight);
    tm.castShadow = true;
    this.tail.add(tm);

    /* ---- talons ---- */
    for (const side of [-1, 1]) {
      const legGeo = sweep([
        { x: side * 0.2, y: -0.26, z: 0.30, rx: 0.075, ry: 0.075 },
        { x: side * 0.2, y: -0.46, z: 0.31, rx: 0.055, ry: 0.055 },
        { x: side * 0.2, y: -0.58, z: 0.33, rx: 0.042, ry: 0.042 },
      ], 10, { capStart: false });
      this._owned.push(legGeo);
      const leg = new THREE.Mesh(legGeo, beakMat);
      this.tilt.add(leg);
    }

    /* ---- harness + rider anchor ---- */
    this.tilt.add(new THREE.Mesh(box(0.78, 0.1, 0.5, 0, 0.34, -0.1), tackMat));
    this.riderAnchor = new THREE.Object3D();
    this.riderAnchor.position.set(0, 0.52, -0.08);
    this.tilt.add(this.riderAnchor);
    this.footAnchors = [];
    for (const sx of [-0.34, 0.34]) {
      const f = new THREE.Object3D();
      f.position.set(sx, 0.02, 0.1);
      this.tilt.add(f);
      this.footAnchors.push(f);
    }
    /* Harness straps, forward at the base of the neck, for the rider's hands.
     *
     * Without a `getGripWorld` the seated pose leaves the arms wherever the
     * character rig last had them, which on a bird 40 m up is a rider sitting
     * with both arms out like a scarecrow. */
    this.gripAnchors = [];
    for (const sx of [-0.2, 0.2]) {
      const g = new THREE.Object3D();
      g.position.set(sx, 0.42, -0.52);
      this.tilt.add(g);
      this.gripAnchors.push(g);
    }
    this.tilt.add(new THREE.Mesh(box(0.5, 0.07, 0.1, 0, 0.42, -0.52), tackMat));

    this.root.visible = false;
    this.applyCustomization(this._livery);
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
    const g = this.physics.groundHeight(position.x, position.z, position.y + 2, 14);
    const base = g === null ? position.y : g;
    // Launched, not parked: an eagle that materialises standing on the deck and
    // then has to take off is three seconds of nothing before the mount is fun.
    this.position.set(position.x, base + 6.5, position.z);
    this.heading = yaw;
    this.speed = CRUISE;
    this._pitch = 0;
    this._bank = 0;
    this._beat = 1;
    this._thermal = 0;
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
    this._beat = 0;
    this._landing = false;
  }

  /**
   * Only once the bird is low enough that stepping off is a step, not a fall.
   *
   * Without this method {@link MountManager.dismount} reads `undefined`, treats
   * every press as "not safe yet", and the player has to press F twice even to
   * get off a bird skimming the deck.
   */
  canDismount() {
    const g = this.physics.groundHeight(this.position.x, this.position.z, this.position.y + 2, 60);
    return g === null ? false : this.position.y - g <= 3.2;
  }

  /** Glide down and land. The dismount completes by itself on touchdown. */
  requestLanding() {
    this._landing = true;
  }

  /* ------------------------------------------------------------------ */
  /* Flight                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * @param {number} dt
   * @param {number} elapsed
   * @param {{throttle:number, strafe:number, pitch:number, up:number, boost:boolean}|null} ctrl
   */
  fixedUpdate(dt, elapsed, ctrl) {
    if (!this._alive) return;
    this._time += dt;
    if (this._spawnT < 1) this._spawnT = Math.min(1, this._spawnT + dt * 2);
    if (this._despawnT >= 0) {
      this._despawnT += dt * 1.8;
      if (this._despawnT >= 1) { this.kill(); return; }
    }

    const ridden = !!ctrl;
    /* W noses down, S noses up - negated because `throttle` is +1 on W.
     *
     * This is the glider convention rather than the vehicle one, and it is the
     * right way round for this mount: holding W trades height for speed, which
     * is how you cross the map from the great tower, and releasing it converts
     * that speed back into altitude. Making W mean "go faster and stay level"
     * would remove the only interesting decision the eagle has. */
    /* Space climbs, Ctrl dives, the mouse steers - the same contract the dragon
     * already teaches.
     *
     * The first version mapped altitude onto W/S and steering onto A/D strafe
     * alone, on the theory that a glider should be flown like a glider. In the
     * player's hands that mount simply could not be made to go up or down: they
     * pressed the key that flies the dragon and nothing happened, and the mouse
     * they steer everything else in this game with did nothing either. A control
     * scheme nobody can find is not a design decision, it is a broken mount.
     *
     * The glider energy model underneath is untouched and still does all the
     * interesting work - it is now driven by the vertical control instead of
     * being the vertical control. W and S remain as a fine pitch trim for anyone
     * who wants to fly it on energy alone. */
    const climb = ridden ? clamp(ctrl.up, -1, 1) : 0;
    const trim = ridden ? -clamp(ctrl.throttle, -1, 1) : 0;
    let pitchIn = clamp(climb * 0.85 + trim * 0.4, -1, 1);
    const steer = ridden ? -clamp(ctrl.strafe, -1, 1) : 0;
    let wantBeat = ridden && !!ctrl.boost;
    // Asking to climb beats the wings by itself; a bird gains height by flapping,
    // and requiring a second key for the obvious thing is the same trap again.
    if (climb > 0.01) wantBeat = true;

    /* A requested landing overrides the stick.
     *
     * Held nose-down until the last few metres and then flared, which both
     * looks like a bird landing and stops the descent being a plummet. Beating
     * is forced off - flapping is what keeps it up, so the one thing a landing
     * must not do is flap. */
    if (this._landing) {
      const g = this.physics.groundHeight(this.position.x, this.position.z, this.position.y + 2, 90);
      if (g === null) {
        // Nothing under us to land on. Hold the nose up and let the turn-back
        // below carry us over ground again; descending here is how the first
        // test flew the player down to y = -353 with nothing to stop them.
        pitchIn = 0.25;
        wantBeat = true;
      } else {
        pitchIn = this.position.y - g > 6 ? -0.55 : 0.35;
        wantBeat = false;
      }
    }

    /* ---- beating costs stamina; without it the bird is a glider -------- */
    const stam = this.player?.stamina;
    let beating = wantBeat;
    if (beating && stam) {
      stam.drain(BEAT_STAMINA * this._staminaMul * dt, 'eagle');
      if (stam.exhausted) beating = false;
    }
    this._beat = damp(this._beat, beating ? 1 : 0, 5, dt);

    /* ---- attitude ------------------------------------------------------ */
    // Nose down on W, up on S. Clamped well short of vertical: an eagle that
    // can fly straight up is a helicopter.
    this._pitch = damp(this._pitch, pitchIn * 0.65, PITCH_RATE * 2.2, dt);
    this._pitch = clamp(this._pitch, -0.72, 0.72);

    /* Steering: chase the camera, and bank into whatever turn that produces.
     *
     * The turn comes from the look direction (plus A/D as a nudge), and the roll
     * is then derived from how hard we are actually turning. That ordering is
     * what keeps a bird flown with the mouse from skidding flat through its
     * turns, and it means the roll is always honest about the manoeuvre rather
     * than being a separate thing the player has to ask for. */
    let turn = steer * TURN_RATE;
    if (ridden) {
      let diff = ((ctrl.yaw - this.heading + Math.PI * 3) % TAU) - Math.PI;
      turn += clamp(diff * 2.1, -TURN_RATE * 1.6, TURN_RATE * 1.6);
    }
    // Slower to answer at speed: a bird doing 40 m/s cannot pivot.
    const authority = 1 - clamp(this.speed / MAX_SPEED, 0, 1) * 0.45;
    turn *= authority;
    this.heading += turn * dt;

    const bankTarget = clamp(-turn / TURN_RATE, -1, 1) * MAX_BANK;
    this._bank = damp(this._bank, bankTarget, 3.4, dt);

    /* ---- energy: height and speed trade -------------------------------- *
     * Nose down converts altitude into speed, nose up spends speed to climb.
     * That exchange is the whole feel of the mount. */
    const dive = -this._pitch;                       // +ve when nose-down
    /* Strength time-scales the WHOLE net acceleration, not just the thrust
     * term. Multiplying thrust alone moved the point where thrust balances
     * drag, so an Acceleration tier quietly raised the bird's terminal speed
     * as well - which is Speed's job. Scaling the sum leaves the balance
     * point (dv = 0) exactly where it was and only changes how fast the bird
     * gets there, which is what the stat says on the tin. */
    let dv = dive * 17;
    // Drag, rising with the square of speed, gives a natural terminal velocity.
    dv -= (0.012 / (this._powerMul * this._powerMul)) * this.speed * this.speed;
    // Beating adds thrust as well as lift.
    if (this._beat > 0.01) dv += this._beat * 9;
    this.speed += dv * this._accelMul * dt;
    /* Floored, not clamped to zero.
     *
     * At the first tuning a sustained pull-up bled 32 m/s to a dead stop in two
     * seconds, and a stationary eagle is just a player falling out of the sky
     * with a bird attached. Dropping below {@link STALL} already costs real
     * altitude, which is punishment enough; the floor keeps some way on so the
     * bird can always be flown out of it. */
    this.speed = clamp(this.speed, 4.5, MAX_SPEED * this._powerMul);

    /* ---- thermals ------------------------------------------------------ *
     * Derived from what is under the bird rather than authored: high, sunlit
     * ground gives back lift, the void off a cliff does not. Free, needs no
     * world support, and puts the best lift along the cliff rim where a player
     * launching from the viewpoint already is. */
    const below = this.physics.groundHeight(this.position.x, this.position.z, this.position.y, THERMAL_PROBE);
    if (below !== null) {
      const agl = this.position.y - below;
      // Strongest close to the ground, gone by 70 m - which is what stops a
      // thermal being an infinite elevator.
      const near = clamp(1 - agl / 70, 0, 1);
      const hot = clamp(below / 30, 0, 1);   // high ground is hot ground
      this._thermal = damp(this._thermal, near * hot * THERMAL_MAX, 2, dt);
      this._lastGround.set(this.position.x, below, this.position.z);
      this._haveGround = true;
      this._void = 0;
    } else {
      this._thermal = damp(this._thermal, 0, 2, dt);
      this._void += dt;
    }

    /* ---- off the edge of the world ------------------------------------- *
     * Every world here is a finite slab, so a bird with a 46 m/s top speed can
     * and does leave it. The first flight test flew 313 m out from the mesa and
     * fell to y = -353 still mounted, with no ground to land on and no floor to
     * stop it - the player simply left the world.
     *
     * Rather than fence the sky with an invisible wall, the bird treats the
     * void as unflyable air: it banks back toward the last ground it saw and
     * refuses to sink any further. That reads as a bird declining to fly out to
     * sea, and it needs no per-world bounds to be configured anywhere. */
    if (this._void > 0.15 && this._haveGround) {
      const want = Math.atan2(this._lastGround.x - this.position.x, this._lastGround.z - this.position.z) + Math.PI;
      let d = ((want - this.heading + Math.PI * 3) % TAU) - Math.PI;
      this.heading += clamp(d, -1, 1) * TURN_BACK * dt;
      this._bank = damp(this._bank, clamp(d, -1, 1) * MAX_BANK, 2.5, dt);
    }

    /* ---- vertical ------------------------------------------------------ */
    // Lift scales with airspeed: below stall there is not enough and the bird
    // falls, which is what stops it hovering.
    const lift = clamp(this.speed / CRUISE, 0, 1.4);
    let vy = -SINK * (2 - lift);
    vy += this._beat * BEAT_CLIMB;
    vy += this._thermal;
    vy += this._pitch * this.speed * 0.55;    // nose attitude carries you
    /* Stall costs height - but only while gliding.
     *
     * Flapping generates lift from the wing itself rather than from airspeed
     * over it, so a bird beating hard is not stalling however slowly it is
     * moving. Without the `1 - beat` term the two penalties for being slow
     * (reduced lift, plus this) together outweighed BEAT_CLIMB, and the result
     * was a bird that could not take off from a standstill: full wingbeats,
     * stamina draining, and it sat pinned on the ground clamp. It only ever
     * climbed in testing because those tests began already at cruise speed. */
    if (this.speed < STALL) vy -= (STALL - this.speed) * 1.4 * (1 - this._beat);

    /* ---- integrate ----------------------------------------------------- */
    const fx = -Math.sin(this.heading);
    const fz = -Math.cos(this.heading);
    _ev1.set(fx * this.speed, vy, fz * this.speed);
    this.position.addScaledVector(_ev1, dt);
    this.velocity.copy(_ev1);

    /* ---- do not fly into the ground ------------------------------------ */
    /* Deliberately a short, local probe: casting from high above would find
     * whatever roof or bridge happens to be overhead and shove the bird up onto
     * it every time it flew through an arch. */
    let g = this.physics.groundHeight(this.position.x, this.position.z, this.position.y + 3, 12);
    /* The cost of that short probe is that it cannot see a surface far above
     * the bird - so a dive off the mesa rim put it 24 m *under* the terrain,
     * where nothing could push it back out. When the local probe finds nothing
     * and we are below ground we last knew about, re-probe from high overhead
     * to find the real surface. Rare enough that the extra cast is free, and it
     * is the only thing standing between a steep dive and flying under the map. */
    if (g === null && this._haveGround && this.position.y < this._lastGround.y) {
      const top = this._lastGround.y + 90;
      g = this.physics.groundHeight(this.position.x, this.position.z, top, top - this.position.y + 6);
    }
    if (g !== null && this.position.y < g + 1.6) {
      this.position.y = g + 1.6;
      // Skimming rather than crashing: an eagle brushing the deck should climb
      // away, not stop dead.
      if (this.velocity.y < 0) this.velocity.y = 0;
      this._grounded = true;
    } else {
      this._grounded = false;
    }
    // Ceiling, so the player cannot leave the world.
    if (this.position.y > 240) this.position.y = 240;
    /* ...and a floor for the same reason. Only meaningful out over the void,
     * where there is no terrain to clamp against; 25 m below the last real
     * ground is low enough to dip under a cliff rim and still be a hard stop. */
    if (this._haveGround) {
      const floor = this._lastGround.y - 25;
      if (this.position.y < floor) {
        this.position.y = floor;
        if (this.velocity.y < 0) this.velocity.y = 0;
      }
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
    this.tilt.rotation.set(this._pitch * 0.8, 0, -this._bank);

    /* ---- flap ---- */
    // Beat frequency rises with effort and falls with speed: a soaring bird at
    // 40 m/s barely moves its wings, a climbing one hammers them.
    const freq = 0.9 + this._beat * 2.1 - clamp(this.speed / MAX_SPEED, 0, 1) * 0.4;
    const prevPhase = this._flapPhase;
    this._flapPhase = (this._flapPhase + dt * freq) % 1;
    /* Asymmetric stroke.
     *
     * A plain sine spends as long going up as coming down, which is a rowing
     * motion, not a wingbeat. A real downstroke is the fast, powerful half and
     * the recovery is slower and softer, so the phase is skewed before it is
     * turned into an angle: quick push through the first third, lazy return
     * over the rest. Costs one remap and it is most of what makes the bird look
     * like it is pushing on the air rather than waving at it. */
    const ph = this._flapPhase;
    const skew = ph < 0.34 ? (ph / 0.34) * 0.5 : 0.5 + ((ph - 0.34) / 0.66) * 0.5;
    const flap = Math.sin(skew * TAU) * this._beat;

    /* The bottom of the downstroke is where the air gets hit, so that is where
     * the sound belongs. Taken from the same phase that drives the wing, for
     * the same reason the horse's hooves are: a timer drifts, and a wingbeat
     * you hear at the top of the stroke reads as somebody else's bird. */
    if (prevPhase < 0.34 && ph >= 0.34 && this._beat > 0.12) {
      this.bus?.emit('mount:wingbeat', {
        id: this.id, position: this.position, power: clamp(this._beat, 0, 1),
      });
    }

    // Fold with speed. This is the dive silhouette and it comes free from the
    // three-joint wing.
    const fold = clamp((this.speed - CRUISE) / (MAX_SPEED - CRUISE), 0, 1);

    for (const w of this.wings) {
      const sd = w.side;
      // Shoulder carries the beat; a soaring wing sits slightly above level.
      w.shoulder.rotation.z = sd * (0.06 + flap * 0.62 - fold * 0.1);
      // Sweep back as it folds, which narrows the silhouette from the front.
      w.shoulder.rotation.y = sd * fold * 0.55;
      // Elbow and hand fold progressively - the hand most, as in a real stoop.
      w.elbow.rotation.z = sd * (-0.05 - fold * 0.7 + flap * 0.22);
      w.hand.rotation.z = sd * (-0.02 - fold * 0.95 + flap * 0.3);
      // Primaries twist on the downstroke, which is where the thrust is.
      w.hand.rotation.x = -flap * 0.35;
    }

    // Tail fans to brake and steer, and closes at speed.
    this.tail.rotation.x = 0.06 + this._pitch * 0.4 + (1 - fold) * 0.05;
    this.tail.rotation.z = this._bank * 0.35;
    this.tail.scale.x = 1 - fold * 0.35;

    // The head stays level with the horizon regardless of what the body does,
    // which is the single most bird-like thing an eagle model can do.
    this.head.rotation.x = -this._pitch * 0.9;
    this.head.rotation.z = this._bank * 0.55;
    this.head.rotation.y = -this._bank * 0.25;
  }

  /* ------------------------------------------------------------------ */
  /* Queries                                                             */
  /* ------------------------------------------------------------------ */

  getSeat(out) {
    this.root.position.copy(this.position);
    this.root.rotation.y = this.heading;
    this.tilt.rotation.set(this._pitch * 0.8, 0, -this._bank);
    this.root.updateMatrixWorld(true);
    return out.setFromMatrixPosition(this.riderAnchor.matrixWorld);
  }

  getFootWorld(side, out, lift = 0) {
    const a = this.footAnchors[side < 0 ? 0 : 1];
    this.root.updateWorldMatrix(true, true);
    out.setFromMatrixPosition(a.matrixWorld);
    if (lift) out.y += lift;
    return out;
  }

  /** Stirrup for the rider's foot IK. @returns {boolean} */
  getStirrupWorld(side, out) {
    this.getFootWorld(side, out);
    return true;
  }

  /** Harness strap for the rider's hand IK. @returns {boolean} */
  getGripWorld(side, out) {
    const a = this.gripAnchors[side < 0 ? 0 : 1];
    if (!a) return false;
    this.root.updateWorldMatrix(true, true);
    out.setFromMatrixPosition(a.matrixWorld);
    return true;
  }

  /** Drives the rider's forward lean: hardest when beating, easiest soaring. */
  get boost01() {
    return this._beat;
  }

  /** The wingbeat itself, so the rider's seat absorbs each stroke. */
  get flap01() {
    return Math.sin(this._flapPhase * TAU) * 0.5 + 0.5;
  }

  /**
   * Where the rider ends up when they step off.
   *
   * Straight down to the ground, not beside the bird: dismounting an eagle
   * happens in mid-air more often than not, and putting the player next to it
   * at altitude is a fall they did not ask for. Dropping them onto whatever is
   * below at least makes the landing legible - and `Parkour` will charge them
   * for it if it is a long way down, which is the correct outcome.
   *
   * @param {THREE.Vector3} out
   */
  dismountPoint(out) {
    const g = this.physics.groundHeight(this.position.x, this.position.z, this.position.y + 2, 300);
    return out.set(
      this.position.x,
      g === null ? this.position.y - 1.6 : Math.min(this.position.y - 1.6, g + 0.05),
      this.position.z
    );
  }

  get speed01() {
    return clamp(this.speed / MAX_SPEED, 0, 1);
  }

  /**
   * Speed as the held mount voice is allowed to see it - see Dragon.voiceSpeed
   * for the measured drift this exists to stop. Every visual cue on the bird
   * saturates at MAX_SPEED, so the wind and wingbeat loop has to saturate
   * there too, or a Power tier runs the audio past wings that have stopped
   * changing. Unsigned: an eagle's speed is airspeed and never negative.
   */
  get voiceSpeed() {
    return Math.min(this.speed, MAX_SPEED);
  }

  get bankRoll() {
    return -this._bank;
  }

  get bankPitch() {
    return this._pitch;
  }

  get airborne() {
    return !this._grounded;
  }

  get boostActive() {
    return this._beat > 0.5;
  }

  /** Metres per second of climb, for the HUD. */
  get climbRate() {
    return this.velocity.y;
  }

  /** True while riding a thermal, so the HUD can say so. */
  get soaring() {
    return this._thermal > 1.5 && this._beat < 0.2;
  }

  get fovKick() {
    return this.speed01 * 0.22;
  }

  get cameraHint() {
    return { distance: 7.5 + this.speed01 * 3.5, height: 2.2 };
  }

  applyCustomization(livery) {
    this._livery = livery && typeof livery === 'object' ? livery : {};
    if (!this._slotMats) return;
    applyLivery(this._livery, this.constructor.CUSTOM_SLOTS, this._slotMats);
  }

  /** Same ladder as Car: +12% top speed, +10% thrust (and cheaper beats), shield stored. */
  applyPowers({ strength = 0, shield = 0, power = 0 } = {}) {
    this._powerMul = 1 + Math.max(0, power) * 0.12;
    this._accelMul = 1 + Math.max(0, strength) * 0.10;
    this._staminaMul = Math.max(0.5, 1 - Math.max(0, strength) * 0.08);
    this._shieldTier = Math.max(0, shield);
  }

  get shieldTier() {
    return this._shieldTier;
  }

  dispose() {
    this.kill();
    for (const o of this._owned) o.dispose?.();
    this._owned.length = 0;
    this._slotMats = null;
  }
}

export default Eagle;
