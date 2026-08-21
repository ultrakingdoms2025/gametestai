import * as THREE from 'three';
import { proxyPlacement } from './Scale.js';

/**
 * HALBERD REACH - the asteroid field, and the one thing out here you fly INTO
 * rather than at.
 *
 * ===========================================================================
 *  WHY THE ROCKS ARE PLACED ONE BY ONE
 * ===========================================================================
 *
 * `Backdrop` can place a whole rigid group with a single position and scale,
 * and the result is angularly EXACT for every child - a uniform scale about
 * the camera preserves all directions. So the obvious thing is to hand the
 * belt over as one member and be done.
 *
 * It is exact and it is still wrong, for a reason that has nothing to do with
 * how it looks. Stand at the edge of the field: the belt CENTRE is 5.5 km
 * away, which maps to a proxy distance of 1503 and a scale of 0.273. A rock
 * 50 m off the nose is then DRAWN at 13.7 m while its collider - which lives
 * in the true frame, because that is where flight and collision live - is
 * still at 50 m. The player swerves round a rock they have already passed and
 * hits one that is not there.
 *
 * The proxy is a rendering trick and it has to stay one. Anything the player's
 * ship can touch must be drawn where it actually is. So each rock is placed
 * through `proxyPlacement` individually: rocks inside `NEAR_FIELD` come out at
 * exactly their true position with scale 1 (the map is the identity there),
 * and the rest compress smoothly behind them with no seam, because the map is
 * continuous through the join.
 *
 * Cost: 260 placements per frame, each a subtract, a length, a log and a
 * matrix compose. Module-level scratch throughout - nothing here allocates
 * after `build`. Measured together with the whole backdrop at 0.020-0.030 ms
 * for both, over 300-400 frames in Chrome at 1600x900; separating the two is
 * below the resolution a browser's `performance.now()` will give you.
 *
 * ===========================================================================
 *  WHAT MAKES IT READ AS A FIELD AND NOT AS CONFETTI
 * ===========================================================================
 *
 * Three things, in order of how much they matter:
 *
 * 1. A SIZE DISTRIBUTION, not a size range. Radii are drawn as r = lo * (hi/lo)^(u^3),
 *    which is heavily biased small: 8 rocks over 200 m, about 40 over 90 m,
 *    the rest gravel. A uniform range gives you a field of identically-sized
 *    lumps, which is the single clearest tell of procedural placement.
 * 2. FLATTENING. The shell is 5.5 km across and 1.4 km thick, so it has a
 *    plane, and a plane is what makes it a BELT rather than a cloud. It also
 *    means you can go over it or through it, which is a decision.
 * 3. A HOLLOW MIDDLE. Rocks sit in a shell between 0.34 and 1.0 of the
 *    extent, so flying in has an outside and an inside.
 *
 * The rocks themselves are three distinct lumpy solids rather than one, so
 * neighbouring silhouettes differ; each instance then gets its own non-uniform
 * stretch and its own tumble. One shared shape with random rotation still
 * reads as one shape - the eye locks onto a repeated silhouette faster than
 * onto a repeated colour.
 */

/* Module-level scratch. See the house rule. */
const _camPos = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scl = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _mat = new THREE.Matrix4();
const _place = { d: 0, scale: 0 };

/** Deterministic PRNG. A field that re-rolled between visits is not a place. */
function makeRandom(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/**
 * A lumpy solid. An icosahedron at detail 1 (80 triangles) with every vertex
 * pushed in or out along its own normal, then re-normalled flat so the facets
 * catch the light separately. Smooth shading on an 80-triangle rock makes a
 * potato; flat shading makes a rock.
 */
function makeRockGeometry(rand) {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const pos = g.attributes.position;
  /* Displace by vertex POSITION, not by index: an icosahedron's buffer has
   * duplicated vertices at the seams, and displacing per index tears them
   * apart into a shape with holes in it. Hashing the rounded position gives
   * every copy of a shared vertex the same displacement. */
  const seen = new Map();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const key = `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
    let k = seen.get(key);
    if (k === undefined) {
      k = 0.62 + rand() * 0.62;
      seen.set(key, k);
    }
    pos.setXYZ(i, x * k, y * k, z * k);
  }
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

export class Belt {
  /**
   * @param {typeof import('./Bodies.js').BELT} spec
   * @param {THREE.Camera|null} camera null in a head-less build; `update` then
   *        no-ops and the rocks stay at the origin, which nothing renders.
   */
  constructor(spec, camera) {
    this.spec = spec;
    this.camera = camera;
    this.group = new THREE.Group();
    this.group.name = 'space:belt';

    /** Per-rock true-frame data. Parallel arrays, so the per-frame loop reads
     *  linearly and never touches an object. */
    this.count = spec.count;
    this.trueX = new Float32Array(this.count);
    this.trueY = new Float32Array(this.count);
    this.trueZ = new Float32Array(this.count);
    this.radius = new Float32Array(this.count);
    /** Non-uniform stretch, in units of `radius`. */
    this.sx = new Float32Array(this.count);
    this.sy = new Float32Array(this.count);
    this.sz = new Float32Array(this.count);
    /** Tumble: axis, phase and rate. */
    this.axX = new Float32Array(this.count);
    this.axY = new Float32Array(this.count);
    this.axZ = new Float32Array(this.count);
    this.phase = new Float32Array(this.count);
    this.rate = new Float32Array(this.count);
    /** Which InstancedMesh, and which slot in it. */
    this.mesh = new Uint8Array(this.count);
    this.slot = new Uint16Array(this.count);

    /** @type {THREE.InstancedMesh[]} */
    this.meshes = [];
    /** @type {THREE.BufferGeometry[]} */
    this._geoms = [];
    /** @type {THREE.Material[]} */
    this._mats = [];

    /** Rocks big enough to be worth a collider, as {x,y,z,r} in the TRUE frame.
     *  Published so the flight model can do sphere tests rather than reading
     *  boxes back out of the physics grid. */
    this.colliderRocks = [];

    this._build();
  }

  _build() {
    const spec = this.spec;
    const rand = makeRandom(0xa1be27);
    const [ex, ey, ez] = spec.extent;
    const [cx, cy, cz] = spec.position;
    const [rLo, rHi] = spec.rockRadius;
    const SHAPES = 3;

    for (let i = 0; i < SHAPES; i++) this._geoms.push(makeRockGeometry(rand));

    // Bucket first so each InstancedMesh can be allocated at its exact size.
    const perMesh = new Array(SHAPES).fill(0);
    for (let i = 0; i < this.count; i++) {
      const m = Math.floor(rand() * SHAPES) % SHAPES;
      this.mesh[i] = m;
      this.slot[i] = perMesh[m]++;
    }

    for (let i = 0; i < this.count; i++) {
      /* Direction: uniform on the sphere, then squashed by the extent. Taking
       * a uniform point in a BOX and normalising would pile rocks up at the
       * corners of the box, which is visible as eight clumps. */
      const u = rand() * 2 - 1;
      const th = rand() * Math.PI * 2;
      const rp = Math.sqrt(1 - u * u);
      // Shell: radius^(1/3) of a uniform between hollow^3 and 1 fills the
      // shell evenly by VOLUME, so the inner surface is not over-populated.
      const h3 = spec.hollow * spec.hollow * spec.hollow;
      const t = Math.cbrt(h3 + rand() * (1 - h3));

      this.trueX[i] = cx + Math.cos(th) * rp * ex * t;
      this.trueY[i] = cy + u * ey * t;
      this.trueZ[i] = cz + Math.sin(th) * rp * ez * t;

      const v = rand();
      const r = rLo * Math.pow(rHi / rLo, v * v * v);
      this.radius[i] = r;

      this.sx[i] = 0.72 + rand() * 0.56;
      this.sy[i] = 0.72 + rand() * 0.56;
      this.sz[i] = 0.72 + rand() * 0.56;

      _axis.set(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1);
      if (_axis.lengthSq() < 1e-6) _axis.set(0, 1, 0);
      _axis.normalize();
      this.axX[i] = _axis.x;
      this.axY[i] = _axis.y;
      this.axZ[i] = _axis.z;
      this.phase[i] = rand() * Math.PI * 2;
      /* Big rocks tumble slower. Not physics - just the thing that stops a
       * 300 m boulder spinning like a pebble, which is the detail that gives
       * the field its sense of mass. */
      this.rate[i] = (0.05 + rand() * 0.22) * (60 / (r + 60));

      if (r >= 90) {
        this.colliderRocks.push({
          x: this.trueX[i],
          y: this.trueY[i],
          z: this.trueZ[i],
          r,
        });
      }
    }

    const tint = new THREE.Color(spec.tint);
    for (let m = 0; m < SHAPES; m++) {
      const mat = new THREE.MeshStandardMaterial({
        color: tint,
        roughness: 0.94,
        metalness: 0.06,
        flatShading: true,
        fog: false,
      });
      this._mats.push(mat);
      const im = new THREE.InstancedMesh(this._geoms[m], mat, perMesh[m]);
      im.name = `space:belt:rock${m}`;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      /* Off, both ways. The shadow cascade covers 120 m around the player and
       * these are drawn at proxy positions the cascade knows nothing about;
       * asking for shadows here buys a cascade refresh and nothing visible. */
      im.castShadow = false;
      im.receiveShadow = false;
      /* Culling off: the bounding sphere would have to be recomputed every
       * frame because the instances move every frame, and the field is one
       * draw call whether it is on screen or not. */
      im.frustumCulled = false;
      this.meshes.push(im);
      this.group.add(im);
    }

    /* Per-instance colour, so the field is not one flat grey. Three tints
     * around the base: cold iron, warm dust, and a pale icy one. Set once. */
    const c = new THREE.Color();
    const counters = new Array(SHAPES).fill(0);
    const r2 = makeRandom(0x5eed11);
    for (let i = 0; i < this.count; i++) {
      const m = this.mesh[i];
      const t = r2();
      c.copy(tint);
      if (t < 0.18) c.lerp(new THREE.Color(0x8fa4ad), 0.45);
      else if (t > 0.82) c.lerp(new THREE.Color(0x7a5a3c), 0.35);
      c.multiplyScalar(0.72 + r2() * 0.55);
      this.meshes[m].setColorAt(counters[m]++, c);
    }
    for (const im of this.meshes) if (im.instanceColor) im.instanceColor.needsUpdate = true;
  }

  /**
   * Place every rock for this frame.
   *
   * @param {number} elapsed seconds, for the tumble
   */
  update(elapsed) {
    // No camera means a headless build, which renders no frames. See the same
    // guard and the same reason in Backdrop.update.
    if (!this.camera) return;
    this.camera.getWorldPosition(_camPos);
    const meshes = this.meshes;

    for (let i = 0; i < this.count; i++) {
      _dir.set(this.trueX[i] - _camPos.x, this.trueY[i] - _camPos.y, this.trueZ[i] - _camPos.z);
      const D = _dir.length();
      const r = this.radius[i];

      let s;
      if (D < 1e-3) {
        // Inside a rock. Draw it where it is and let collision have the argument.
        _pos.set(this.trueX[i], this.trueY[i], this.trueZ[i]);
        s = 1;
      } else {
        _dir.multiplyScalar(1 / D);
        proxyPlacement(D, r, _place);
        s = _place.scale;
        _pos.copy(_camPos).addScaledVector(_dir, _place.d);
      }

      _axis.set(this.axX[i], this.axY[i], this.axZ[i]);
      _quat.setFromAxisAngle(_axis, this.phase[i] + elapsed * this.rate[i]);
      _scl.set(r * s * this.sx[i], r * s * this.sy[i], r * s * this.sz[i]);
      _mat.compose(_pos, _quat, _scl);
      meshes[this.mesh[i]].setMatrixAt(this.slot[i], _mat);
    }

    for (let m = 0; m < meshes.length; m++) meshes[m].instanceMatrix.needsUpdate = true;
  }

  dispose() {
    for (const g of this._geoms) g.dispose();
    for (const m of this._mats) m.dispose();
    for (const im of this.meshes) im.dispose();
    this._geoms.length = 0;
    this._mats.length = 0;
    this.meshes.length = 0;
  }
}
