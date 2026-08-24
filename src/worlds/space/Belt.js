import * as THREE from 'three';
import { proxyPlacement } from './Scale.js';
import { heroGeometry } from './BeltAssets.js';

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
 *
 * ===========================================================================
 *  PHASE 9 (art-space): TWO THINGS A PHOTOGRAPH FOUND THAT NOTHING TESTED
 * ===========================================================================
 *
 * The field was screenshotted at 900 m from its largest rock - a second and a
 * half of cruise, and a distance the collider set says a pilot can reach.
 * It measured **mean luma 4.9 with 99.6% of its pixels under 48/255**. Two
 * separate faults, and the second is invisible until the first is fixed.
 *
 * 1. THE ALBEDO WAS APPLIED TWICE. The material carried `color: tint` AND
 *    every instance carried `setColorAt(i, tint * variation)`. Three
 *    multiplies `vColor` into `diffuseColor`, so the field's albedo was
 *    `0x5d564e` SQUARED: linear 0.0117 against the 0.108 the tint names, which
 *    is charcoal. The material is now white and the whole albedo rides on the
 *    per-instance colour, which is where the variation already lived. A/B on
 *    three facets of the same rock in the same framing: 4.5 -> 36.8,
 *    8.4 -> 57.8, 8.9 -> 56.6.
 *
 *    It is worth naming the shape of this bug, because it is not a typo: both
 *    halves are individually correct and each has a comment explaining itself.
 *    Only the product is wrong, and nothing renders in a unit test.
 *
 * 2. EIGHTY TRIANGLES IS A DIE, NOT A BOULDER. On an 18 m pebble drawn four
 *    pixels across, 80 is generous. On the 336 m rock above it is twenty
 *    visible facets over 700 px of screen. The rocks at or above `HERO_RADIUS`
 *    now draw from an authored 500-triangle mesh with craters and fracture
 *    planes in it - see `BeltAssets.js` and `scripts/make-belt-glb.mjs` - and
 *    the other 216 keep the three procedural silhouettes unchanged.
 *
 * ---- What that costs, stated rather than buried --------------------------
 *
 * One renderable, one instanced mesh and one draw call: an `InstancedMesh`
 * carries exactly one geometry, so hero detail for the 44 rocks that need it
 * is either a fourth bucket or a silhouette taken away from the 216 that do
 * not, and the paragraph above argues for keeping three.
 *
 * It is paid back twice over in materials. This file built THREE
 * byte-identical `MeshStandardMaterial`s, one per silhouette, for no reason
 * anyone recorded - the per-instance colour is an attribute and needs no
 * material of its own. There is now one, shared by every bucket, so the
 * world's material count goes DOWN by two even with the fourth mesh added.
 * Shader programs do not move either way: three keys its program cache on
 * material CONFIGURATION, and three identical configurations were always one
 * program.
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

/**
 * Radius at or above which a rock is drawn from the authored hero mesh.
 *
 * It is the SAME number the collider set uses, and that is the rule rather
 * than a coincidence: **every rock the flight model can hit is a rock drawn at
 * hero detail**. A second threshold would be a second number to keep in step
 * with the first. Exported so `SpaceWorld._buildBelt` and
 * `scripts/tests/belt-assets.test.mjs` read it rather than repeat it.
 */
export const HERO_RADIUS = 90;

/** Procedural silhouettes for the bulk field. See the header on why three. */
const SHAPES = 3;

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
    /**
     * Index of the authored hero bucket in `meshes`, or -1 when no asset was
     * loaded. -1 is the whole headless suite and any deploy missing the file;
     * see `BeltAssets.js`. Read by tests rather than re-derived.
     * @type {number}
     */
    this.heroMesh = -1;
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

    for (let i = 0; i < SHAPES; i++) this._geoms.push(makeRockGeometry(rand));

    /**
     * The authored hero mesh, or null. Null is the normal path in the whole
     * headless suite and on any deploy where the file is missing; see the
     * header of `BeltAssets.js`.
     *
     * CLONED, because `dispose()` below disposes every geometry it was given
     * and the session cache outlives one build of this world. A second build
     * handed the same buffer would draw from a disposed one.
     */
    const hero = heroGeometry();
    this.heroMesh = hero ? SHAPES : -1;
    if (hero) this._geoms.push(hero.clone());

    /* The provisional bucket, one `rand()` per rock. This loop is UNCHANGED
     * and must stay unchanged: it consumes exactly `count` values out of the
     * shared stream, and every position, radius, stretch and tumble in the
     * field is drawn from what follows it. Moving a single call re-rolls the
     * whole of Halberd Reach, including the collider set that
     * `space-backdrop.test.mjs` measures. */
    for (let i = 0; i < this.count; i++) {
      this.mesh[i] = Math.floor(rand() * SHAPES) % SHAPES;
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

      if (r >= HERO_RADIUS) {
        this.colliderRocks.push({
          x: this.trueX[i],
          y: this.trueY[i],
          z: this.trueZ[i],
          r,
        });
      }
    }

    /* Now the radii are known, move every rock big enough to be worth a
     * collider into the hero bucket, and only then hand out slots. No `rand()`
     * is consulted here - the field is already decided; this only re-labels
     * which mesh draws which rock. With no authored geometry the label never
     * changes and the buckets are exactly the three this world always had. */
    const meshCount = this.heroMesh >= 0 ? SHAPES + 1 : SHAPES;
    const perMesh = new Array(meshCount).fill(0);
    for (let i = 0; i < this.count; i++) {
      if (this.heroMesh >= 0 && this.radius[i] >= HERO_RADIUS) this.mesh[i] = this.heroMesh;
      this.slot[i] = perMesh[this.mesh[i]]++;
    }

    /**
     * ONE material, shared by every bucket, and WHITE.
     *
     * White because the tint rides on the per-instance colour below and three
     * multiplies the two together - see fault 1 in the header. Shared because
     * three identical `MeshStandardMaterial`s are three material instances,
     * one shader program and no difference at all; the per-instance colour is
     * an `InstancedBufferAttribute` and has never needed a material of its own.
     *
     * Named, and that is not decoration: `scripts/world-shot.mjs --ablate`
     * identifies materials BY NAME, and `art-station` found all 225 of its
     * world's materials anonymous and its whole A/B silently useless. The name
     * is not part of three's program cache key, so it is free.
     */
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.94,
      metalness: 0.06,
      flatShading: true,
      fog: false,
    });
    mat.name = 'space:belt:rock';
    this._mats.push(mat);

    for (let m = 0; m < meshCount; m++) {
      const im = new THREE.InstancedMesh(this._geoms[m], mat, perMesh[m]);
      im.name = m === this.heroMesh ? 'space:belt:hero' : `space:belt:rock${m}`;
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

    /**
     * Per-instance colour, so the field is not one flat grey. Three tints
     * around the base: cold iron, warm dust, and a pale icy one. Set once.
     *
     * This now carries the WHOLE albedo, because the material above is white.
     * Nothing in this loop changed - it always produced `tint * variation`,
     * which is exactly the albedo the spec names - and that is the point: the
     * bug was never here, it was that the material multiplied the tint in a
     * second time. The counter walks the same ascending-`i` order the slots
     * were handed out in, so instance `slot[i]` and colour `counters[m]` are
     * the same rock.
     */
    const tint = new THREE.Color(spec.tint);
    const c = new THREE.Color();
    const counters = new Array(meshCount).fill(0);
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
