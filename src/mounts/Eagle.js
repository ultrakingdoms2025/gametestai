import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

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

    this._owned = [];
    this._build();
  }

  _mat(color, opts = {}) {
    const m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      roughness: opts.roughness ?? 0.72,
      metalness: opts.metalness ?? 0.04,
      ...opts,
    });
    this._owned.push(m);
    return m;
  }

  _build() {
    this.root = new THREE.Group();
    this.root.name = 'mount:eagle';
    this.tilt = new THREE.Group();
    this.root.add(this.tilt);

    const body = this._mat(0x4a3524, { roughness: 0.8 });
    const headMat = this._mat(0xe8e2d4, { roughness: 0.72 });
    const beakMat = this._mat(0xe2a92c, { roughness: 0.42, metalness: 0.2 });
    const flight = this._mat(0x3a2a1c, { roughness: 0.85 });
    const tackMat = this._mat(0x6d4522, { roughness: 0.6 });

    /* ---- torso ---- */
    const torso = merge([
      box(0.72, 0.66, 1.9, 0, 0, 0),
      box(0.56, 0.5, 0.6, 0, -0.04, -1.05),     // breast
      box(0.5, 0.42, 0.5, 0, 0.02, 0.98),       // rump
    ]);
    this._owned.push(torso);
    const torsoMesh = new THREE.Mesh(torso, body);
    torsoMesh.castShadow = true;
    this.tilt.add(torsoMesh);

    /* ---- head, white, on a short neck ---- */
    this.head = new THREE.Group();
    this.head.position.set(0, 0.2, -1.28);
    this.tilt.add(this.head);
    const headGeo = merge([
      box(0.34, 0.34, 0.42, 0, 0, -0.1),
      box(0.2, 0.16, 0.2, 0, 0.04, -0.34),
    ]);
    this._owned.push(headGeo);
    const hm = new THREE.Mesh(headGeo, headMat);
    hm.castShadow = true;
    this.head.add(hm);
    this.head.add(new THREE.Mesh(box(0.13, 0.16, 0.3, 0, -0.02, -0.5, 0.16), beakMat));

    /* ---- wings: three segments a side ---- *
     * Shoulder, elbow, hand. A two-bone wing can only flap; the third joint is
     * what lets it *fold*, and the fold is the entire visual difference between
     * a soar and a dive. */
    this.wings = [];
    for (const side of [-1, 1]) {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.3, 0.16, -0.15);
      this.tilt.add(shoulder);

      const armGeo = box(1.5, 0.1, 0.72, side * 0.75, 0, 0.02);
      this._owned.push(armGeo);
      const arm = new THREE.Mesh(armGeo, body);
      arm.castShadow = true;
      shoulder.add(arm);

      const elbow = new THREE.Group();
      elbow.position.set(side * 1.5, 0, 0);
      shoulder.add(elbow);
      const foreGeo = box(1.55, 0.09, 0.62, side * 0.78, 0, 0.06);
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
        prim.push(box(len, 0.05, 0.17, side * (len * 0.5 + 0.05), 0, 0.16 + i * 0.19, 0, side * spread, 0));
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
    const tailGeo = merge([
      box(0.72, 0.06, 1.1, 0, 0, 0.5),
      box(0.5, 0.05, 0.4, 0, 0, 1.05),
    ]);
    this._owned.push(tailGeo);
    const tm = new THREE.Mesh(tailGeo, flight);
    tm.castShadow = true;
    this.tail.add(tm);

    /* ---- talons ---- */
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(box(0.12, 0.34, 0.12, side * 0.2, -0.42, 0.3), beakMat);
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
    let pitchIn = ridden ? -clamp(ctrl.throttle, -1, 1) : 0;
    const steer = ridden ? -clamp(ctrl.strafe, -1, 1) : 0;
    let wantBeat = ridden && !!ctrl.boost;

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
      stam.drain(BEAT_STAMINA * dt, 'eagle');
      if (stam.exhausted) beating = false;
    }
    this._beat = damp(this._beat, beating ? 1 : 0, 5, dt);

    /* ---- attitude ------------------------------------------------------ */
    // Nose down on W, up on S. Clamped well short of vertical: an eagle that
    // can fly straight up is a helicopter.
    this._pitch = damp(this._pitch, pitchIn * 0.65, PITCH_RATE * 2.2, dt);
    this._pitch = clamp(this._pitch, -0.72, 0.72);

    const bankTarget = steer * MAX_BANK;
    this._bank = damp(this._bank, bankTarget, 3.4, dt);
    // A bird turns because it is banked, not because it yaws. Deriving the turn
    // from the roll is what makes it carve instead of skid.
    this.heading += (this._bank / MAX_BANK) * BANK_TURN * dt
      + steer * TURN_RATE * 0.28 * dt;

    /* ---- energy: height and speed trade -------------------------------- *
     * Nose down converts altitude into speed, nose up spends speed to climb.
     * That exchange is the whole feel of the mount. */
    const dive = -this._pitch;                       // +ve when nose-down
    this.speed += dive * 17 * dt;
    // Drag, rising with the square of speed, gives a natural terminal velocity.
    this.speed -= (0.012 * this.speed * this.speed) * dt;
    // Beating adds thrust as well as lift.
    if (this._beat > 0.01) this.speed += this._beat * 9 * dt;
    /* Floored, not clamped to zero.
     *
     * At the first tuning a sustained pull-up bled 32 m/s to a dead stop in two
     * seconds, and a stationary eagle is just a player falling out of the sky
     * with a bird attached. Dropping below {@link STALL} already costs real
     * altitude, which is punishment enough; the floor keeps some way on so the
     * bird can always be flown out of it. */
    this.speed = clamp(this.speed, 4.5, MAX_SPEED);

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
    if (this.speed < STALL) vy -= (STALL - this.speed) * 1.4;

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
    this._flapPhase = (this._flapPhase + dt * freq) % 1;
    const flap = Math.sin(this._flapPhase * TAU) * this._beat;

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

  dispose() {
    this.kill();
    for (const o of this._owned) o.dispose?.();
    this._owned.length = 0;
  }
}

export default Eagle;
