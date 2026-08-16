import * as THREE from 'three';

/**
 * Collectables scattered along the circuit, taken by driving over them.
 *
 * ── Why these are not colliders ───────────────────────────────────────────
 *
 * The obvious implementation is a trigger volume in the physics world, and it
 * is the wrong one here. The circuit already carries twelve thousand colliders
 * and the broadphase is the thing that decides whether ten cars at 34 m/s stay
 * above 60 fps; adding forty more that exist only to be overlapped, and that
 * must then be filtered out of every capsule resolve so nobody *stands* on a
 * floating coin, is cost and complexity for nothing.
 *
 * A pickup is a point on the centreline. A racer already knows its own distance
 * along that centreline, because that is how the whole race is scored. So
 * collection is a comparison of two numbers plus a lateral check - no spatial
 * query at all, and it stays exact at any speed because it tests the *interval*
 * travelled rather than where the car happened to land on a frame.
 *
 * ── What they are worth ───────────────────────────────────────────────────
 *
 * Credits, paid at the flag rather than instantly. Paying on contact would let
 * a player farm a lap and quit, and the race already has a payout moment that
 * this belongs in.
 */

const SPIN = 2.4;
const BOB = 0.55;
/** Half-width of the corridor a car has to be in to take one, in metres. */
const LATERAL = 3.2;
/** Credits per pickup. Deliberately small next to the 10 for a win. */
export const PICKUP_VALUE = 1;
/**
 * How far over the road a drop floats when nobody says otherwise, in metres.
 *
 * A number rather than a hard-coded `+ 1.0` in `_refresh` because a dragon race
 * is flown fifteen metres up: collection is a centreline interval and a lateral
 * check, so a drop laid on the tarmac would be claimed by a mount that never
 * came within fifteen metres of it. That is not a rounding error the player can
 * be asked to ignore - it is a coin awarded for flying over a coin. `scatter`
 * takes the height the race is actually run at.
 */
const ROAD_HEIGHT = 1.0;

export class Pickups {
  /**
   * @param {{scene:THREE.Scene, bus:any, materials:any}} ctx
   */
  constructor({ scene, bus, materials }) {
    this.scene = scene;
    this.bus = bus ?? null;
    this.materials = materials ?? null;

    /** @type {Array<{s:number, lat:number, taken:boolean, by:string|null}>} */
    this.items = [];
    /** Metres above the centreline the current set is drawn at. @see scatter */
    this.height = ROAD_HEIGHT;
    this._path = null;
    this._owned = [];
    this._time = 0;

    this.root = new THREE.Group();
    this.root.name = 'race:pickups';
    this.root.visible = false;
    scene.add(this.root);
    this._build();
  }

  _build() {
    /* One instanced mesh for the lot.
     *
     * Forty separate meshes is forty draw calls for something the size of a
     * dinner plate, and they are all identical - the only thing that differs is
     * where they are and whether they are still there, both of which an
     * instance matrix carries. */
    const geo = new THREE.OctahedronGeometry(0.62, 0);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffc247,
      emissive: 0xff8c1a,
      // Bright enough to clear the bloom threshold, so a pickup reads as a
      // light source on a grey road rather than as a yellow pebble.
      emissiveIntensity: 2.4,
      roughness: 0.28,
      metalness: 0.65,
    });
    this._owned.push(geo, mat);
    this.mesh = new THREE.InstancedMesh(geo, mat, 128);
    this.mesh.count = 0;
    this.mesh.castShadow = false;
    this.mesh.frustumCulled = false;
    this.root.add(this.mesh);

    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._p = new THREE.Vector3();
    this._sample = { x: 0, y: 0, z: 0, width: 0, tx: 0, tz: 1 };
    this._s = new THREE.Vector3(1, 1, 1);
  }

  /**
   * Scatter a fresh set along a circuit.
   *
   * @param {any} path a `TrackPath` - needs `length` and `sample(s, out)`
   * @param {number} count
   * @param {() => number} rnd
   * @param {number} [height] metres above the centreline to draw them at. The
   *   height the race is FLOWN at, not a decoration: see ROAD_HEIGHT.
   */
  scatter(path, count, rnd = Math.random, height = ROAD_HEIGHT) {
    this._path = path ?? null;
    this.items.length = 0;
    this.height = Number.isFinite(height) ? height : ROAD_HEIGHT;
    if (!this._path || !this._path.length) {
      this.mesh.count = 0;
      this.root.visible = false;
      return 0;
    }
    const L = this._path.length;
    const n = Math.min(count, this.mesh.instanceMatrix.count);
    for (let i = 0; i < n; i++) {
      /* Evenly spaced with jitter rather than uniformly random.
       *
       * Pure random on a 1.6 km lap clumps badly - you get six in fifty metres
       * and then nothing for a quarter of the circuit - and a pickup you cannot
       * find is not a reward. */
      const slot = (i + 0.5) / n;
      const s = ((slot + (rnd() - 0.5) * 0.6 / n) * L + L) % L;
      this.items.push({ s, lat: (rnd() * 2 - 1) * (LATERAL * 0.72), taken: false, by: null });
    }
    this.mesh.count = this.items.length;
    this.root.visible = true;
    this._refresh();
    return this.items.length;
  }

  /** Put every pickup back. Called at the start of a race, not at the flag. */
  reset() {
    for (const it of this.items) { it.taken = false; it.by = null; }
    this._refresh();
  }

  clear() {
    this.items.length = 0;
    this.mesh.count = 0;
    this.root.visible = false;
    this._path = null;
  }

  /**
   * Award anything the interval `[from, to]` along the centreline passed over.
   *
   * The interval, not the position: at 34 m/s a car covers half a metre a
   * frame, and a test against where it *is* would miss anything it drove
   * through between two frames. Wrapping is handled so the lap seam is not a
   * gap in the road.
   *
   * @param {string} id who is claiming
   * @param {number} from distance along the centreline last step
   * @param {number} to distance along the centreline now
   * @param {number} lat lateral offset from the centreline
   * @param {boolean} isPlayer only the player scores; the AI drive through
   * @returns {number} how many were taken
   */
  claim(id, from, to, lat, isPlayer) {
    if (!isPlayer || !this.items.length || !this._path) return 0;
    const L = this._path.length;
    let a = from;
    let b = to;
    // Normalise a possibly-wrapping interval into one that increases.
    if (b < a) b += L;
    if (b - a > L * 0.5) return 0;      // a teleport, not a drive
    let took = 0;
    for (const it of this.items) {
      if (it.taken) continue;
      if (Math.abs(lat - it.lat) > LATERAL) continue;
      let s = it.s;
      if (s < a) s += L;
      if (s < a || s > b) continue;
      it.taken = true;
      it.by = id;
      took++;
    }
    if (took) {
      this._refresh();
      this.bus?.emit('race:pickup', { id, count: took, value: took * PICKUP_VALUE });
    }
    return took;
  }

  /** Credits owed to the player for what they collected this race. */
  get collected() {
    let n = 0;
    for (const it of this.items) if (it.taken) n++;
    return n;
  }

  update(dt) {
    if (!this.root.visible || !this.items.length) return;
    this._time += dt;
    this._refresh();
  }

  /** Rewrite the instance matrices: spin, bob, and collapse the taken ones. */
  _refresh() {
    if (!this._path) return;
    const t = this._time;
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      /* Position from the centreline sample plus a lateral offset along the
       * road's right vector, which is (-tz, tx) - the same convention
       * `TrackPath.lateralOf` uses, so a pickup laid at lat L is taken by a car
       * reporting lateral L. Getting this the wrong way round would put every
       * pickup on the opposite side of the road from where it is collected. */
      const sm = this._path.sample(it.s, this._sample);
      this._p.set(sm.x + -sm.tz * it.lat, sm.y, sm.z + sm.tx * it.lat);
      // A taken pickup scales to nothing rather than being removed: the
      // instance count stays put, so there is no buffer churn mid-race.
      const k = it.taken ? 0 : 1;
      this._e.set(0, t * SPIN + i, 0.42);
      this._q.setFromEuler(this._e);
      this._p.y += this.height + Math.sin(t * 2.2 + i) * BOB * 0.25;
      this._s.setScalar(k);
      this._m4.compose(this._p, this._q, this._s);
      this.mesh.setMatrixAt(i, this._m4);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.root.removeFromParent();
    for (const o of this._owned) o.dispose?.();
    this._owned.length = 0;
  }
}

export default Pickups;
