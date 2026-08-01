import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { fbm01, ridgedFbm2D, clamp01, smoothstep } from '../gfx/Textures.js';
import { ParticlePool, SpeedLines, standardFromBake, makeGlowTexture } from './Hoverboard.js';

/**
 * The drivable car.
 *
 * A car is a *contact patch* problem. The hoverboard cheats - it springs a
 * single ride height off an averaged probe and never has to explain where the
 * grip comes from. A car cannot: the four wheels have to sit on four different
 * heights, the body has to pitch and roll around them, and none of it may
 * launch the vehicle when the ground curves away underneath, which is exactly
 * what the skate park bowl does. So the model here is:
 *
 *   - `position` is the *contact plane* under the car, not the body. Wheels
 *     hang off `root` (yaw only) and find their own height from a per-wheel
 *     ground probe; the body hangs off `tilt` (pitch/roll about a waist-height
 *     pivot) so it leans over the wheels rather than about the road.
 *   - The ride spring's *upward* response is rate limited and backed by a hard
 *     floor. Ground rising faster than the spring can answer pushes the car up
 *     without ever being converted into vertical speed, which is what stops a
 *     bowl transition from firing the car into orbit. Falling is pure gravity,
 *     so drops still read as drops.
 *   - Collision is three overlapping capsules along the length resolved against
 *     the same `physics` the player uses. One capsule wide enough to cover a
 *     4.3 m car would be wider than the car; three narrow ones trace the
 *     footprint and cannot be threaded through a wall diagonally.
 *
 * Steering chases the look direction like the other mounts (the third-person
 * boom sits behind the player's yaw, so anything else fights the camera), but
 * through a speed-dependent yaw-rate limit: no authority when stopped, most at
 * town speed, less again flat out. That single curve is most of what separates
 * "car" from "turret".
 *
 * Car space: -Z forward, +Y up, +X right (house convention). The origin is on
 * the road between the wheels.
 */

/* ---- module scratch. One private block per function - two aliasing bugs in */
/* this project came from sharing them, so they are never reused. ---- */
const _fu1 = new THREE.Vector3(); // fixedUpdate
const _rc1 = new THREE.Vector3(); // _resolveCollision
const _rc2 = new THREE.Vector3();
const _gs1 = new THREE.Vector3(); // getSeat
const _dp1 = new THREE.Vector3(); // dismountPoint
const _lr1 = new THREE.Vector3(); // _updateLightRig
const _mk1 = new THREE.Vector3(); // TyreMarks.spawn
const _mkQ = new THREE.Quaternion();
const _mkS = new THREE.Vector3();
const _mkM = new THREE.Matrix4();
const _mkAxis = new THREE.Vector3(0, 1, 0);
const _lf1 = new THREE.Vector3(); // loft ring build

const damp = THREE.MathUtils.damp;
const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;

/* ---- dimensions, metres ---- */
const WHEELBASE = 2.62;
const TRACK = 1.60;
const AXLE_Z = WHEELBASE * 0.5;
const HALF_TRACK = TRACK * 0.5;
const WHEEL_R = 0.36;
const WHEEL_W = 0.26;
/** Suspension travel either side of the nominal wheel height. */
const SUSP_UP = 0.16;
const SUSP_DOWN = 0.20;
/** Body pitch/roll pivot - roughly the centre of mass, not the road. */
const PIVOT_Y = 0.52;

/* ---- performance ---- */
const CRUISE_SPEED = 22;
const BOOST_SPEED = 34;
const REVERSE_SPEED = 7;
const GRAVITY = -22;
/** Peak visual steering angle at the front wheels. */
const MAX_STEER = 0.50;
/** Steering-wheel turns per unit of road-wheel lock. */
const STEER_RATIO = 2.6;
/**
 * Lateral acceleration the tyres are allowed to generate, m/s^2. This is the
 * grip budget, and dividing it by road speed is what gives the corner radius
 * its speed dependence - without it the yaw-rate limit alone lets a car at
 * 34 m/s turn like a go-kart.
 */
const LAT_GRIP = 13.5;

/* ---- collision hull: three capsules along the centreline ---- */
const HULL_Z = [-1.42, 0, 1.42];
const HULL_R = 0.76;
const HULL_H = 1.15;
/** Clearance above the local ground at which the hull capsules start, so kerbs
 *  and skate-park lips are driven over instead of being walls. */
const HULL_LIFT = 0.16;
/** Gap above the rest height beyond which the car is considered airborne. */
const AIR_GAP = 0.34;

const CAR_CAMERA = { scale: 2.15, lift: 0.35 };

/* ================================================================== */
/* Surfaces                                                            */
/* ================================================================== */

/**
 * Metallic paint: clear over a flake basecoat.
 *
 * The flake is deliberately two-scale - a dense sparkle plus a much coarser
 * mottle. A single frequency reads as noise; the beat between the two is what
 * makes a curved panel look like it has depth under the lacquer.
 */
function shadeCarPaint(u, v, out) {
  const flake = fbm01(u, v, 320, 320, 2, 41);
  const mottle = fbm01(u, v, 26, 26, 3, 7);
  const peel = fbm01(u, v, 90, 90, 2, 63); // orange peel, in the normal only
  const spark = flake > 0.80 ? (flake - 0.80) * 4.2 : 0;
  const base = 0.72 + mottle * 0.10 + spark * 0.22;
  out.r = base * 0.92;
  out.g = base * 0.97;
  out.b = base * 1.0;
  out.h = 0.45 + peel * 0.55;
  out.rough = 0.11 + mottle * 0.05 - spark * 0.05;
  out.metal = 0.88 + spark * 0.1;
  out.ao = 1;
}

/** Matte grained polymer: bumper inserts, splitter, mirrors, pillars. */
function shadeCarTrim(u, v, out) {
  const grain = fbm01(u, v, 210, 210, 3, 23);
  const swirl = fbm01(u, v, 18, 18, 2, 88);
  const base = 0.055 + grain * 0.045 + swirl * 0.015;
  out.r = base;
  out.g = base * 1.02;
  out.b = base * 1.08;
  out.h = 0.35 + grain * 0.65;
  out.rough = 0.74 + grain * 0.2;
  out.metal = 0.05;
  out.ao = 0.82 + grain * 0.18;
}

/**
 * Tyre. The lathe's UVs run u around the circumference and v across the
 * profile, so the crown band (0.3 < v < 0.7) gets directional tread blocks and
 * the sidewalls get moulding rings and lettering-scale noise.
 */
function shadeTyre(u, v, out) {
  const crown = smoothstep(0.26, 0.33, v) * (1 - smoothstep(0.67, 0.74, v));
  // Block pattern: circumferential ribs cut by angled lateral grooves.
  const rib = Math.abs(((v - 0.5) * 9) % 1 - 0.5) * 2;
  const lat = Math.abs((u * 46 + (v - 0.5) * 5) % 1 - 0.5) * 2;
  const groove = Math.min(smoothstep(0.16, 0.34, rib), smoothstep(0.10, 0.30, lat));
  const wear = fbm01(u, v, 160, 40, 3, 11);
  const wall = fbm01(u * 2, v, 60, 220, 3, 77);
  const ring = Math.abs((v * 26) % 1 - 0.5) * 2;
  const sidewall = (1 - crown) * (0.02 + wall * 0.02 + smoothstep(0.6, 1, ring) * 0.012);
  const tread = crown * (0.018 + groove * 0.03 + wear * 0.012);
  const base = 0.021 + sidewall + tread;
  out.r = base;
  out.g = base;
  out.b = base * 1.03;
  out.h = crown > 0.5 ? 0.25 + groove * 0.75 : 0.45 + wall * 0.3 + ring * 0.15;
  out.rough = 0.93 - groove * 0.08 + (1 - crown) * 0.03;
  out.metal = 0.0;
  out.ao = 0.72 + groove * 0.28;
}

/** Perforated leather with a stitch line - the cabin is seen through glass. */
function shadeCabin(u, v, out) {
  const grain = ridgedFbm2D(u, v, 150, 150, 3, 31) * 0.5 + 0.5;
  const cell = fbm01(u, v, 40, 40, 2, 19);
  // Perforations on a coarse grid, only in the panel field.
  const px = Math.abs((u * 30) % 1 - 0.5) * 2;
  const py = Math.abs((v * 30) % 1 - 0.5) * 2;
  const perf = 1 - smoothstep(0.55, 0.85, Math.min(px, py));
  const stitch = smoothstep(0.94, 0.985, Math.abs((v * 6) % 1 - 0.5) * 2);
  const base = 0.048 + grain * 0.035 + cell * 0.02 - perf * 0.03;
  out.r = base * 1.06 + stitch * 0.16;
  out.g = base * 0.98 + stitch * 0.10;
  out.b = base * 0.95 + stitch * 0.04;
  out.h = 0.4 + grain * 0.45 - perf * 0.5 + stitch * 0.35;
  out.rough = 0.78 + grain * 0.16 - stitch * 0.2;
  out.metal = 0.02;
  out.ao = 0.7 + grain * 0.3 - perf * 0.2;
}

/** Brushed alloy - shared with the hoverboard when it got there first. */
function shadeAlloy(u, v, out) {
  const brush = fbm01(u, v * 0.06, 40, 500, 3, 33);
  const grain = fbm01(u, v, 300, 12, 2, 71);
  const base = 0.30 + brush * 0.16 + grain * 0.05;
  out.r = base;
  out.g = base * 1.03;
  out.b = base * 1.1;
  out.h = 0.45 + grain * 0.55;
  out.rough = 0.26 + brush * 0.2;
  out.metal = 0.95;
  out.ao = 0.85 + grain * 0.15;
}

/**
 * Build (once) and publish the car's materials into the shared library.
 *
 * `mount.alloy` is shared with the hoverboard and registered by whichever mount
 * is constructed first, which is why every key is guarded rather than assumed.
 */
function ensureMaterials(materials) {
  if (!materials.has('mount.carpaint')) {
    const m = standardFromBake(256, shadeCarPaint, 0.55, { repeat: 1, color: 0x2b3d55 });
    m.envMapIntensity = 2.1;
    materials.register('mount.carpaint', m);
  }
  if (!materials.has('mount.cartrim')) {
    const m = standardFromBake(256, shadeCarTrim, 1.4, { repeat: 2 });
    m.envMapIntensity = 0.9;
    materials.register('mount.cartrim', m);
  }
  if (!materials.has('mount.tyre')) {
    const m = standardFromBake(512, shadeTyre, 2.6, { repeat: 1 });
    m.envMapIntensity = 0.6;
    materials.register('mount.tyre', m);
  }
  if (!materials.has('mount.cabin')) {
    const m = standardFromBake(256, shadeCabin, 1.6, { repeat: 2 });
    m.envMapIntensity = 0.7;
    materials.register('mount.cabin', m);
  }
  if (!materials.has('mount.alloy')) {
    const m = standardFromBake(256, shadeAlloy, 0.8, { repeat: 1 });
    m.envMapIntensity = 1.5;
    materials.register('mount.alloy', m);
  }
  if (!materials.has('mount.carglass')) {
    // Deliberately *not* the shared `glass.tinted`: that one is a transmission
    // material, and a transmissive canopy hides the driver behind a blurred
    // backdrop render. The whole point of the glasshouse is that you can see
    // the player at the wheel, so this is a plain alpha-blended tint.
    const m = new THREE.MeshPhysicalMaterial({
      color: 0x223642,
      transparent: true,
      opacity: 0.34,
      roughness: 0.06,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.03,
      ior: 1.52,
      specularIntensity: 1,
      envMapIntensity: 1.8,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    materials.register('mount.carglass', m);
  }
}

/* ================================================================== */
/* Tyre marks                                                          */
/* ================================================================== */

/**
 * Rubber laid on the road, as a pooled instanced quad field.
 *
 * The interesting constraint is fading. `InstancedMesh` gives one free
 * per-instance channel - the colour - and a *dark* additive mark is a
 * contradiction, so the marks are drawn with `MultiplyBlending`: the fragment
 * multiplies whatever is already in the frame buffer. White is then the
 * identity, which means fading a mark out is simply lerping its instance colour
 * to white, and a dead slot is invisible without any shader patching at all.
 */
class TyreMarks {
  /** @param {THREE.Scene} scene @param {number} count pool size */
  constructor(scene, count = 220) {
    this.count = count;
    this._texture = makeSkidTexture(64);
    this.material = new THREE.MeshBasicMaterial({
      map: this._texture,
      color: 0xffffff,
      transparent: true,
      blending: THREE.MultiplyBlending,
      // Multiply resolves to (DST_COLOR, ZERO), which is only correct on
      // premultiplied alpha - and three warns once per frame otherwise.
      premultipliedAlpha: true,
      depthWrite: false,
      // The road is a big flat collider; without an offset the marks z-fight
      // with it at grazing angles even at a 2 cm lift.
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.geometry.rotateX(-Math.PI / 2); // lie flat, +Y up
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, count);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3).fill(1), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

    this._life = new Float32Array(count);
    this._maxLife = new Float32Array(count);
    this._dark = new Float32Array(count);
    this._cursor = 0;
    this._live = 0;
    for (let i = 0; i < count; i++) this._hide(i);
    scene.add(this.mesh);
  }

  /**
   * Lay one patch of rubber.
   * @param {number} x @param {number} y @param {number} z world position
   * @param {number} yaw travel direction
   * @param {number} width across the tyre
   * @param {number} length along travel
   * @param {number} dark 0..1 opacity of the mark
   * @param {number} life seconds before it has faded away
   */
  spawn(x, y, z, yaw, width, length, dark, life) {
    const i = this._cursor;
    this._cursor = (this._cursor + 1) % this.count;
    _mk1.set(x, y, z);
    _mkQ.setFromAxisAngle(_mkAxis, yaw);
    _mkS.set(width, 1, length);
    _mkM.compose(_mk1, _mkQ, _mkS);
    this.mesh.setMatrixAt(i, _mkM);
    this._life[i] = life;
    this._maxLife[i] = life;
    this._dark[i] = dark;
    this._live++;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** @param {number} dt */
  update(dt) {
    if (this._live <= 0) return;
    const c = this.mesh.instanceColor.array;
    let live = 0;
    for (let i = 0; i < this.count; i++) {
      const l = this._life[i];
      if (l <= 0) continue;
      const nl = l - dt;
      if (nl <= 0) {
        this._life[i] = 0;
        this._hide(i);
        continue;
      }
      this._life[i] = nl;
      live++;
      // Hold, then fade: rubber does not start disappearing the instant it is
      // laid, and an immediate ramp reads as a flicker behind a fast car.
      const t = nl / this._maxLife[i];
      const k = 1 - this._dark[i] * smoothstep(0, 0.45, t);
      const i3 = i * 3;
      c[i3] = k; c[i3 + 1] = k; c[i3 + 2] = k;
    }
    this._live = live;
    this.mesh.instanceColor.needsUpdate = true;
  }

  _hide(i) {
    _mk1.set(0, -9999, 0);
    _mkQ.identity();
    _mkS.set(0, 0, 0);
    _mkM.compose(_mk1, _mkQ, _mkS);
    this.mesh.setMatrixAt(i, _mkM);
    const c = this.mesh.instanceColor.array;
    // White is the identity under multiply - a dead slot must never be dark.
    c[i * 3] = 1; c[i * 3 + 1] = 1; c[i * 3 + 2] = 1;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
  }

  clear() {
    for (let i = 0; i < this.count; i++) {
      this._life[i] = 0;
      this._hide(i);
    }
    this._live = 0;
  }

  setVisible(v) {
    this.mesh.visible = v;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this._texture.dispose();
  }
}

/**
 * Soft-edged dark patch that fades to *white* at the rim, because it is drawn
 * with multiply blending and white is the no-op there.
 */
function makeSkidTexture(size = 64) {
  const data = new Uint8Array(size * size * 4);
  const c = (size - 1) * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - c) / c;
      const dy = (y - c) / c;
      // Elongated along the travel axis with ragged edges: a tyre lays a band,
      // not a dot.
      const d = Math.sqrt(dx * dx * 1.0 + dy * dy * 0.55);
      const edge = clamp01(1 - d);
      const grain = fbm01((x + 0.5) / size, (y + 0.5) / size, 14, 5, 3, 3);
      const v = clamp01(1 - edge * edge * (0.62 + grain * 0.38));
      const b = Math.round(v * 255);
      const i = (y * size + x) * 4;
      data[i] = b; data[i + 1] = b; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/* ================================================================== */
/* Geometry                                                            */
/* ================================================================== */

/**
 * Superellipse ring sample. `n = 2` is an ellipse, higher is squarer - which is
 * how a car body gets its taut shoulder without a single hand-placed vertex.
 */
function superPoint(t, a, b, n, out) {
  const c = Math.cos(t);
  const s = Math.sin(t);
  const e = 2 / n;
  out.x = a * Math.sign(c) * Math.pow(Math.abs(c), e);
  out.y = b * Math.sign(s) * Math.pow(Math.abs(s), e);
  return out;
}

/**
 * Loft a closed tube through a list of cross sections.
 *
 * Each section is `{ z, hw, top, bl, bot, nTop, nBot, tuck }`: half width, the
 * beltline the ring pivots about, the top and bottom of the section, the
 * superellipse exponents above and below the belt, and how far the lower body
 * pulls in toward the sill. Ends are capped with a fan so the hull is closed.
 *
 * @param {Array<object>} sections ordered by increasing z
 * @param {number} R ring resolution
 * @returns {THREE.BufferGeometry}
 */
function loftClosed(sections, R) {
  const S = sections.length;
  const vcount = S * R + 2;
  const pos = new Float32Array(vcount * 3);
  const uv = new Float32Array(vcount * 2);
  const idx = [];
  const z0 = sections[0].z;
  const zSpan = sections[S - 1].z - z0 || 1;

  for (let s = 0; s < S; s++) {
    const sec = sections[s];
    const nTop = sec.nTop ?? 2.6;
    const nBot = sec.nBot ?? 3.0;
    const tuck = sec.tuck ?? 0;
    for (let i = 0; i < R; i++) {
      const t = (i / R) * Math.PI * 2;
      const upper = Math.sin(t) >= 0;
      superPoint(t, sec.hw, upper ? sec.top - sec.bl : sec.bl - sec.bot, upper ? nTop : nBot, _lf1);
      const y = upper ? sec.bl + _lf1.y : sec.bl + _lf1.y;
      // Lower body pulls in toward the sill; continuous at the beltline
      // because the taper is driven by |sin t|, which is zero there.
      const pull = upper ? 1 : 1 - tuck * Math.pow(Math.abs(Math.sin(t)), 1.4);
      const k = (s * R + i) * 3;
      pos[k] = _lf1.x * pull;
      pos[k + 1] = y;
      pos[k + 2] = sec.z;
      const k2 = (s * R + i) * 2;
      uv[k2] = i / R;
      uv[k2 + 1] = (sec.z - z0) / zSpan;
    }
  }

  for (let s = 0; s < S - 1; s++) {
    for (let i = 0; i < R; i++) {
      const i2 = (i + 1) % R;
      const a = s * R + i;
      const b = s * R + i2;
      const c = (s + 1) * R + i;
      const d = (s + 1) * R + i2;
      // Winding checked against a +Z cylinder: (a,b,c) faces outward.
      idx.push(a, b, c, b, d, c);
    }
  }

  // End caps. The nose fan must face -Z and the tail fan +Z, hence the flip.
  const nose = S * R;
  const tail = nose + 1;
  const s0 = sections[0];
  const sN = sections[S - 1];
  pos[nose * 3] = 0; pos[nose * 3 + 1] = s0.bl; pos[nose * 3 + 2] = s0.z;
  pos[tail * 3] = 0; pos[tail * 3 + 1] = sN.bl; pos[tail * 3 + 2] = sN.z;
  uv[nose * 2] = 0.5; uv[nose * 2 + 1] = 0;
  uv[tail * 2] = 0.5; uv[tail * 2 + 1] = 1;
  for (let i = 0; i < R; i++) {
    const i2 = (i + 1) % R;
    idx.push(nose, i2, i);
    idx.push(tail, (S - 1) * R + i, (S - 1) * R + i2);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Loft an open shell over the top half of a section list - the canopy. Left
 * open at the beltline where it meets the body deck, and drawn double sided so
 * the missing backfaces never show.
 */
function loftShell(sections, R) {
  const S = sections.length;
  const pos = new Float32Array(S * R * 3);
  const uv = new Float32Array(S * R * 2);
  const idx = [];
  const z0 = sections[0].z;
  const zSpan = sections[S - 1].z - z0 || 1;

  for (let s = 0; s < S; s++) {
    const sec = sections[s];
    const n = sec.nTop ?? 2.5;
    for (let i = 0; i < R; i++) {
      const t = (i / (R - 1)) * Math.PI;
      superPoint(t, sec.hw, sec.top - sec.bl, n, _lf1);
      const k = (s * R + i) * 3;
      pos[k] = _lf1.x;
      pos[k + 1] = sec.bl + _lf1.y;
      pos[k + 2] = sec.z;
      const k2 = (s * R + i) * 2;
      uv[k2] = i / (R - 1);
      uv[k2 + 1] = (sec.z - z0) / zSpan;
    }
  }
  for (let s = 0; s < S - 1; s++) {
    for (let i = 0; i < R - 1; i++) {
      const a = s * R + i;
      const b = s * R + i + 1;
      const c = (s + 1) * R + i;
      const d = (s + 1) * R + i + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** Body cross sections: a low, wide two-seat coupe with a taut shoulder line. */
const BODY_SECTIONS = [
  { z: -2.14, hw: 0.30, top: 0.78, bl: 0.62, bot: 0.50, nTop: 2.6, nBot: 2.4, tuck: 0.35 },
  { z: -2.02, hw: 0.66, top: 0.83, bl: 0.62, bot: 0.40, nTop: 2.8, nBot: 2.6, tuck: 0.28 },
  { z: -1.82, hw: 0.85, top: 0.87, bl: 0.66, bot: 0.31, nTop: 3.1, nBot: 2.8, tuck: 0.20 },
  { z: -1.50, hw: 0.93, top: 0.91, bl: 0.72, bot: 0.26, nTop: 3.4, nBot: 3.2, tuck: 0.14 },
  { z: -1.10, hw: 0.955, top: 0.94, bl: 0.76, bot: 0.245, nTop: 3.6, nBot: 3.4, tuck: 0.12 },
  { z: -0.70, hw: 0.965, top: 0.985, bl: 0.80, bot: 0.24, nTop: 3.8, nBot: 3.5, tuck: 0.12 },
  { z: -0.20, hw: 0.97, top: 1.00, bl: 0.82, bot: 0.24, nTop: 4.0, nBot: 3.5, tuck: 0.12 },
  { z: 0.40, hw: 0.97, top: 1.005, bl: 0.83, bot: 0.24, nTop: 4.0, nBot: 3.5, tuck: 0.12 },
  { z: 1.00, hw: 0.962, top: 1.00, bl: 0.82, bot: 0.245, nTop: 3.8, nBot: 3.4, tuck: 0.12 },
  { z: 1.45, hw: 0.945, top: 0.995, bl: 0.79, bot: 0.26, nTop: 3.5, nBot: 3.2, tuck: 0.15 },
  { z: 1.85, hw: 0.87, top: 0.975, bl: 0.73, bot: 0.32, nTop: 3.1, nBot: 2.9, tuck: 0.22 },
  { z: 2.06, hw: 0.70, top: 0.94, bl: 0.68, bot: 0.40, nTop: 2.8, nBot: 2.6, tuck: 0.30 },
  { z: 2.16, hw: 0.34, top: 0.88, bl: 0.64, bot: 0.50, nTop: 2.6, nBot: 2.4, tuck: 0.35 },
];

/** Canopy: raked screen, high roof over the seats, fastback tail. */
const CANOPY_SECTIONS = [
  { z: -0.84, hw: 0.60, top: 1.005, bl: 0.97, nTop: 2.2 },
  { z: -0.62, hw: 0.735, top: 1.13, bl: 0.97, nTop: 2.3 },
  { z: -0.34, hw: 0.795, top: 1.32, bl: 0.975, nTop: 2.5 },
  { z: 0.02, hw: 0.825, top: 1.415, bl: 0.98, nTop: 2.8 },
  { z: 0.44, hw: 0.83, top: 1.44, bl: 0.985, nTop: 2.9 },
  { z: 0.84, hw: 0.82, top: 1.415, bl: 0.98, nTop: 2.8 },
  { z: 1.20, hw: 0.785, top: 1.30, bl: 0.975, nTop: 2.6 },
  { z: 1.48, hw: 0.72, top: 1.12, bl: 0.97, nTop: 2.3 },
  { z: 1.64, hw: 0.56, top: 1.01, bl: 0.96, nTop: 2.1 },
];

/** Push a box's vertices onto a rounded shell. Seats and dashboards are not boxes. */
function roundBox(w, h, d, r, seg = 3) {
  const geo = new THREE.BoxGeometry(w, h, d, seg, seg, seg);
  const hx = Math.max(0, w * 0.5 - r);
  const hy = Math.max(0, h * 0.5 - r);
  const hz = Math.max(0, d * 0.5 - r);
  const p = geo.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const cx = clamp(x, -hx, hx);
    const cy = clamp(y, -hy, hy);
    const cz = clamp(z, -hz, hz);
    let dx = x - cx;
    let dy = y - cy;
    let dz = z - cz;
    const len = Math.hypot(dx, dy, dz);
    if (len > 1e-6) {
      const k = r / len;
      dx *= k; dy *= k; dz *= k;
    }
    p.setXYZ(i, cx + dx, cy + dy, cz + dz);
  }
  p.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** Merge helper: rotate, translate and collect. */
function pushGeo(parts, g, x, y, z, rx = 0, ry = 0, rz = 0) {
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  parts.push(g);
  return g;
}

/** Tyre carcass: a lathe about X with rounded shoulders and a crowned tread. */
function buildTyreGeometry() {
  const hw = WHEEL_W * 0.5;
  const rimR = 0.225;
  const pts = [
    new THREE.Vector2(rimR, -hw),
    new THREE.Vector2(rimR + 0.03, -hw - 0.008),
    new THREE.Vector2(0.30, -hw + 0.002),
    new THREE.Vector2(0.338, -hw * 0.86),
    new THREE.Vector2(0.356, -hw * 0.60),
    new THREE.Vector2(0.3605, -hw * 0.25),
    new THREE.Vector2(0.361, 0),
    new THREE.Vector2(0.3605, hw * 0.25),
    new THREE.Vector2(0.356, hw * 0.60),
    new THREE.Vector2(0.338, hw * 0.86),
    new THREE.Vector2(0.30, hw - 0.002),
    new THREE.Vector2(rimR + 0.03, hw + 0.008),
    new THREE.Vector2(rimR, hw),
  ];
  const geo = new THREE.LatheGeometry(pts, 34);
  geo.rotateZ(Math.PI / 2); // lathe axis Y -> X
  return geo;
}

/** Rim: barrel, outer lip and five twisted spokes, merged to one draw. */
function buildRimGeometry() {
  const parts = [];
  const hw = WHEEL_W * 0.5;
  const barrel = new THREE.CylinderGeometry(0.225, 0.215, WHEEL_W * 0.92, 24, 1, true);
  pushGeo(parts, barrel, 0, 0, 0, 0, 0, Math.PI / 2);
  const lip = new THREE.TorusGeometry(0.222, 0.018, 6, 26);
  pushGeo(parts, lip, hw - 0.012, 0, 0, 0, Math.PI / 2);
  const face = new THREE.CircleGeometry(0.222, 26);
  pushGeo(parts, face, hw - 0.05, 0, 0, 0, Math.PI / 2);
  const hub = new THREE.CylinderGeometry(0.062, 0.055, 0.09, 14);
  pushGeo(parts, hub, hw - 0.03, 0, 0, 0, 0, Math.PI / 2);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const spoke = new THREE.BoxGeometry(0.055, 0.175, 0.045, 1, 2, 1);
    // Y is radial before rotation: build it standing up, twist it, then swing
    // it round the hub. Twisting is what stops five flat plates reading as a
    // hubcap sticker.
    spoke.translate(0, 0.115, 0);
    spoke.rotateY(0.28);
    spoke.rotateX(a);
    spoke.rotateZ(Math.PI / 2);
    spoke.translate(hw - 0.06, 0, 0);
    parts.push(spoke);
  }
  return mergeGeometries(parts, false);
}

/** Vented brake disc and a caliper block, in one merged mesh per wheel. */
function buildBrakeGeometry(side) {
  const parts = [];
  const disc = new THREE.CylinderGeometry(0.185, 0.185, 0.022, 22, 1);
  pushGeo(parts, disc, 0, 0, 0, 0, 0, Math.PI / 2);
  const caliper = roundBox(0.055, 0.10, 0.16, 0.022, 2);
  pushGeo(parts, caliper, side * -0.045, 0.13, 0.05);
  return mergeGeometries(parts, false);
}

/**
 * Cabin furniture: floor pan, dash, console, two buckets and the parcel shelf.
 * All of it is seen through tinted glass, so silhouettes matter more than
 * detail - but a stack of raw boxes reads as a placeholder, hence `roundBox`.
 */
function buildInteriorGeometry() {
  const parts = [];
  pushGeo(parts, roundBox(1.68, 0.06, 2.30, 0.03, 2), 0, 0.395, 0.18);
  // Dash, raked back toward the driver.
  pushGeo(parts, roundBox(1.66, 0.26, 0.40, 0.09, 3), 0, 0.88, -0.62, -0.28);
  pushGeo(parts, roundBox(1.60, 0.10, 0.30, 0.045, 2), 0, 0.98, -0.80, -0.5);
  // Transmission tunnel and centre console.
  pushGeo(parts, roundBox(0.30, 0.26, 1.30, 0.08, 3), 0, 0.50, 0.20);
  for (const side of [-1, 1]) {
    const x = side * 0.40;
    // Cushion top lands at 0.52; the H-point (the seat anchor) is 0.55, which
    // is what puts the driver's head under a 1.44 m roof instead of through it.
    pushGeo(parts, roundBox(0.52, 0.12, 0.54, 0.06, 3), x, 0.46, 0.30);
    pushGeo(parts, roundBox(0.50, 0.62, 0.14, 0.06, 3), x, 0.78, 0.60, -0.14);
    pushGeo(parts, roundBox(0.26, 0.20, 0.11, 0.05, 2), x, 1.13, 0.66, -0.14);
    // Bolsters: a bucket seat is a channel, not a slab.
    for (const s2 of [-1, 1]) {
      pushGeo(parts, roundBox(0.09, 0.13, 0.48, 0.04, 2), x + s2 * 0.215, 0.51, 0.30);
      pushGeo(parts, roundBox(0.09, 0.50, 0.16, 0.04, 2), x + s2 * 0.19, 0.80, 0.55, -0.14);
    }
  }
  // Rear bulkhead / parcel shelf.
  pushGeo(parts, roundBox(1.55, 0.10, 0.55, 0.05, 2), 0, 0.86, 1.15, -0.10);
  return mergeGeometries(parts, false);
}

/** Steering wheel: rim, three spokes, boss. Built about its own axis (+Z out). */
function buildWheelRimGeometry() {
  const parts = [];
  const rim = new THREE.TorusGeometry(0.172, 0.019, 8, 30);
  parts.push(rim);
  const boss = new THREE.CylinderGeometry(0.05, 0.045, 0.05, 14);
  pushGeo(parts, boss, 0, 0, 0.01, Math.PI / 2);
  for (const a of [Math.PI, Math.PI * 1.6, Math.PI * 0.4]) {
    const spoke = new THREE.BoxGeometry(0.035, 0.14, 0.018, 1, 1, 1);
    spoke.translate(0, 0.082, 0);
    spoke.rotateZ(a - Math.PI / 2);
    parts.push(spoke);
  }
  return mergeGeometries(parts, false);
}

/* ================================================================== */
/* Car                                                                 */
/* ================================================================== */

export class Car {
  /**
   * @param {{scene:THREE.Scene, engine:any, physics:any, bus:any, materials:any,
   *          camera:THREE.PerspectiveCamera}} ctx
   */
  constructor({ scene, engine, physics, bus, materials, camera }) {
    this.id = 'car';
    this.displayName = 'INTERCEPTOR';
    this.scene = scene;
    this.engine = engine;
    this.physics = physics;
    this.bus = bus;
    this.materials = materials;
    this.camera = camera;

    ensureMaterials(materials);

    /* ---- kinematics ---- */
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.heading = 0;
    this.speed = 0;
    this._vy = 0;
    this._accel = 0;
    this._pitch = 0;
    this._roll = 0;
    this._pitchTarget = 0;
    this._rollTarget = 0;
    this._steer = 0;
    this._spin = 0;
    this._turnRate = 0;
    this._slip = 0;
    this._groundY = 0;
    this._groundValid = false;
    this._airborne = false;
    this._boost = 0;
    this._boostActive = false;
    /**
     * Purchased-power multipliers (see MountManager.grantPower). 1 == stock.
     * `_powerMul` lifts top/boost speed, `_accelMul` sharpens throttle response,
     * `_shieldTier` is read by the collision code to soften impacts.
     */
    this._powerMul = 1;
    this._accelMul = 1;
    this._shieldTier = 0;
    this._braking = false;
    this._reversing = false;
    this._bodyBob = 0;
    this._bobVel = 0;
    this._markAccum = 0;
    this._dustAccum = 0;
    this._ridden = false;
    this._spawnT = 1;
    this._despawnT = -1;
    this._alive = false;
    /** Per-wheel ground height from this step's probes. FL, FR, RL, RR. */
    this._wheelGround = [0, 0, 0, 0];
    this._wheelHit = [false, false, false, false];
    /** Hip height of whoever is in the seat; refined by `setRiderDrop`. */
    this._riderDrop = 0.99;
    /** Ambient darkness of the current world, 0 bright .. 1 night. */
    this._nightness = 0.6;

    this._geo = {};
    this._buildModel();
    this._buildLightRig();

    this._dust = new ParticlePool(scene, 90, { color: 0xd6c4a6, drag: 2.6, gravity: 0.6 });
    this._sparks = new ParticlePool(scene, 48, { color: 0xffd08a, drag: 1.0, gravity: -6 });
    this._marks = new TyreMarks(scene, 240);
    this._speedLines = new SpeedLines(scene, 56, 0xdfeeff);

    // Headlights are brighter where the world is darker. There is no authored
    // light-level field to read, so this keys off the world id, which is stable
    // and cheap - and the alternative (sampling the sun each frame) would tie a
    // mount to a module it does not own.
    this._onWorldChanged = ({ id }) => {
      this._nightness = id === 'station' ? 1 : id === 'medieval' ? 0.6 : 0.22;
    };
    bus?.on?.('world:changed', this._onWorldChanged);

    this.setVisible(false);
  }

  /* ---------------------------------------------------------------- */
  /* Model                                                             */
  /* ---------------------------------------------------------------- */

  _buildModel() {
    const M = this.materials;
    // The body paint and the alloy are shared singletons - the AI grid uses the
    // same library - so a per-car livery has to run on *clones*. Cloning a
    // MeshStandard copies the map references (no new textures, cheap) and gives
    // this one car its own `.color` to tint. `_paintMat`/`_wheelMat` are what the
    // customisation writes into; everything else stays on the shared material.
    this._paintMat = M.get('mount.carpaint').clone();
    this._wheelMat = M.get('mount.alloy').clone();
    const paint = this._paintMat;
    const trim = M.get('mount.cartrim');
    const alloy = M.get('mount.alloy');
    const tyre = M.get('mount.tyre');
    const cabin = M.get('mount.cabin');
    const glass = M.get('mount.carglass');
    // A livery chosen before the model existed applies now.
    if (this._livery) this.applyCustomization(this._livery);

    this.root = new THREE.Group();
    this.root.name = 'car';

    // tilt pivots at waist height so the body leans *over* the wheels; body
    // carries the suspension bob so the two never fight for one transform.
    this.tilt = new THREE.Group();
    this.tilt.position.y = PIVOT_Y;
    this.root.add(this.tilt);
    this.body = new THREE.Group();
    this.body.position.y = -PIVOT_Y;
    this.tilt.add(this.body);
    // `skin` carries the materialisation squash-and-grow. The cabin, the seat
    // anchor and the IK targets deliberately sit *outside* it: scaling the
    // group that reports where the pedals are would drag the driver's feet
    // around for the length of the spawn animation.
    this.skin = new THREE.Group();
    this.body.add(this.skin);

    /* ---- shell ---- */
    this._geo.body = loftClosed(BODY_SECTIONS, 40);
    const shell = new THREE.Mesh(this._geo.body, paint);
    shell.castShadow = true;
    shell.receiveShadow = true;
    this.skin.add(shell);

    /* ---- canopy ---- */
    this._geo.canopy = loftShell(CANOPY_SECTIONS, 20);
    const canopy = new THREE.Mesh(this._geo.canopy, glass);
    canopy.renderOrder = 8;
    this.skin.add(canopy);

    /* ---- pillars and roof spine ---- */
    this._geo.pillars = this._buildPillarGeometry();
    const pillars = new THREE.Mesh(this._geo.pillars, trim);
    pillars.castShadow = true;
    this.skin.add(pillars);

    /* ---- arches, splitter, mirrors, exhausts ---- */
    this._geo.dress = this._buildDressGeometry();
    const dress = new THREE.Mesh(this._geo.dress, trim);
    dress.castShadow = true;
    dress.receiveShadow = true;
    this.skin.add(dress);

    this._geo.flares = this._buildFlareGeometry();
    const flares = new THREE.Mesh(this._geo.flares, paint);
    flares.castShadow = true;
    this.skin.add(flares);

    /* ---- interior ---- */
    this._geo.interior = buildInteriorGeometry();
    this._cabinMesh = new THREE.Mesh(this._geo.interior, cabin);
    this._cabinMesh.receiveShadow = true;
    this.body.add(this._cabinMesh);

    /* ---- steering wheel, on its own rotating node ---- */
    this.steerColumn = new THREE.Group();
    this.steerColumn.position.set(-0.40, 0.94, -0.24);
    this.steerColumn.rotation.x = 0.42; // raked toward the driver
    this.body.add(this.steerColumn);
    this._geo.column = new THREE.CylinderGeometry(0.035, 0.03, 0.34, 10);
    this._geo.column.rotateX(Math.PI / 2);
    this._geo.column.translate(0, 0, -0.17);
    const column = new THREE.Mesh(this._geo.column, trim);
    this.steerColumn.add(column);

    this.steerWheel = new THREE.Group();
    this.body.add(this.steerWheel);
    this.steerWheel.position.copy(this.steerColumn.position);
    this.steerWheel.rotation.copy(this.steerColumn.rotation);
    this._geo.wheelRim = buildWheelRimGeometry();
    const swheel = new THREE.Mesh(this._geo.wheelRim, trim);
    this.steerWheel.add(swheel);

    /**
     * Hand targets, on the *rotating* rim at ten-to-two. Parenting them to the
     * wheel rather than to the cabin is the whole trick: the rider's IK then
     * follows the wheel round as it is turned, instead of the hands sliding off
     * a steering wheel that rotates underneath them.
     */
    this.grips = [];
    for (const side of [1, -1]) {
      const g = new THREE.Object3D();
      const a = side > 0 ? Math.PI * 0.18 : Math.PI * 0.82;
      g.position.set(Math.cos(a) * 0.168, Math.sin(a) * 0.168, 0.045);
      this.steerWheel.add(g);
      this.grips.push(g);
    }

    /** Pedal ankle rests. The driver's feet are solved onto these. */
    this.pedals = [];
    this._geo.pedal = roundBox(0.10, 0.17, 0.035, 0.014, 2);
    for (const side of [1, -1]) {
      // Placed at 0.78 m from the seat anchor: a 1.78 m rider's hip-to-ankle is
      // ~0.91 m, so anything further out solves as a locked-straight leg.
      const p = new THREE.Object3D();
      p.position.set(-0.40 + side * 0.125, 0.42, -0.48);
      this.body.add(p);
      this.pedals.push(p);
      const mesh = new THREE.Mesh(this._geo.pedal, alloy);
      mesh.position.set(-0.40 + side * 0.125, 0.43, -0.54);
      mesh.rotation.x = -0.42;
      this.body.add(mesh);
    }

    /** Seat anchor - the H-point. The driver's pelvis rests here. */
    this.riderAnchor = new THREE.Object3D();
    this.riderAnchor.position.set(-0.40, 0.55, 0.28);
    this.body.add(this.riderAnchor);

    /* ---- wheels ---- */
    this._geo.tyre = buildTyreGeometry();
    this._geo.rim = buildRimGeometry();
    this._geo.brakeL = buildBrakeGeometry(-1);
    this._geo.brakeR = buildBrakeGeometry(1);
    this.wheels = [];
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const sx = i % 2 === 0 ? -1 : 1;
      // susp -> steer -> spin. Three nodes because the three motions are
      // independent and stacking them into one Euler would couple camber into
      // the steering angle.
      const susp = new THREE.Group();
      susp.position.set(sx * HALF_TRACK, WHEEL_R, front ? -AXLE_Z : AXLE_Z);
      this.root.add(susp);
      const steer = new THREE.Group();
      susp.add(steer);
      const spin = new THREE.Group();
      steer.add(spin);

      const t = new THREE.Mesh(this._geo.tyre, tyre);
      t.castShadow = true;
      t.receiveShadow = true;
      spin.add(t);
      const r = new THREE.Mesh(this._geo.rim, this._wheelMat);
      r.castShadow = true;
      r.scale.x = sx; // outer face outboard on both sides
      spin.add(r);
      const b = new THREE.Mesh(sx < 0 ? this._geo.brakeL : this._geo.brakeR, this._wheelMat);
      b.scale.x = sx;
      steer.add(b); // brakes do not spin with the wheel

      this.wheels.push({ susp, steer, spin, front, sx });
    }

    /* ---- lamps ---- */
    this._headMat = new THREE.MeshBasicMaterial({
      color: 0xfff2d2, transparent: true, opacity: 0.2, toneMapped: false, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this._brakeMat = new THREE.MeshBasicMaterial({
      color: 0xff2a1c, transparent: true, opacity: 0.35, toneMapped: false, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this._accentMat = new THREE.MeshBasicMaterial({
      color: 0x59e2ff, transparent: true, opacity: 0.6, toneMapped: false, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this._geo.headLens = this._buildHeadLensGeometry();
    this._headLens = new THREE.Mesh(this._geo.headLens, this._headMat);
    this._headLens.renderOrder = 6;
    this.skin.add(this._headLens);
    this._geo.tailLens = this._buildTailLensGeometry();
    this._tailLens = new THREE.Mesh(this._geo.tailLens, this._brakeMat);
    this._tailLens.renderOrder = 6;
    this.skin.add(this._tailLens);
    this._geo.accent = this._buildAccentGeometry();
    this._accent = new THREE.Mesh(this._geo.accent, this._accentMat);
    this._accent.renderOrder = 6;
    this.skin.add(this._accent);

    /* ---- headlight beams ---- */
    this._beamMat = new THREE.MeshBasicMaterial({
      color: 0xfff0cf,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this._geo.beam = new THREE.ConeGeometry(1.5, 11, 14, 1, true);
    this._geo.beam.rotateX(Math.PI / 2); // apex -> +Z
    this._geo.beam.translate(0, 0, -5.5); // apex at the lamp, opening forward
    this._beams = [];
    for (const side of [-1, 1]) {
      const b = new THREE.Mesh(this._geo.beam, this._beamMat);
      b.position.set(side * 0.60, 0.78, -2.0);
      b.renderOrder = 5;
      b.visible = false;
      this.skin.add(b);
      this._beams.push(b);
    }

    /* ---- light pool on the road ahead ---- */
    this._glowTex = makeGlowTexture(128, 2.0);
    this._poolMat = new THREE.MeshBasicMaterial({
      map: this._glowTex, color: 0xffeecb, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    this._geo.pool = new THREE.PlaneGeometry(7, 14);
    this._geo.pool.rotateX(-Math.PI / 2);
    this._pool = new THREE.Mesh(this._geo.pool, this._poolMat);
    this._pool.renderOrder = 3;
    this.root.add(this._pool); // on the root: stays flat on the road

    this.root.matrixAutoUpdate = true;
  }

  /** A-pillars, roof rails and the C-pillar buttresses, traced off the canopy. */
  _buildPillarGeometry() {
    const parts = [];
    for (const side of [-1, 1]) {
      const pts = [];
      for (const s of CANOPY_SECTIONS) {
        // Follow the canopy's shoulder, a touch outboard so the pillar reads as
        // a frame around the glass rather than a stripe on it.
        pts.push(new THREE.Vector3(side * s.hw * 0.985, s.bl + (s.top - s.bl) * 0.30, s.z));
      }
      const curve = new THREE.CatmullRomCurve3(pts);
      parts.push(new THREE.TubeGeometry(curve, 26, 0.028, 6, false));
    }
    // Roof spine.
    const spine = [];
    for (const s of CANOPY_SECTIONS) spine.push(new THREE.Vector3(0, s.top + 0.004, s.z));
    parts.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(spine), 24, 0.026, 6, false));
    // Windscreen header and rear screen header.
    for (const [z0, z1] of [[-0.84, -0.34], [1.20, 1.64]]) {
      const a = CANOPY_SECTIONS.find((s) => s.z === z0) ?? CANOPY_SECTIONS[0];
      const b = CANOPY_SECTIONS.find((s) => s.z === z1) ?? CANOPY_SECTIONS[0];
      const arc = [];
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        const sec = t < 0.5 ? a : b;
        void sec;
        const hw = lerp(a.hw, b.hw, t);
        const top = lerp(a.top, b.top, t);
        const bl = lerp(a.bl, b.bl, t);
        const ang = Math.PI * (0.12 + t * 0.76);
        arc.push(new THREE.Vector3(
          Math.cos(ang) * hw * 0.99,
          bl + (top - bl) * Math.max(0.05, Math.sin(ang)),
          lerp(z0, z1, t)
        ));
      }
      parts.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(arc), 14, 0.022, 5, false));
    }
    return mergeGeometries(parts, false);
  }

  /** Splitter, side skirts, diffuser, mirrors, door shut lines and exhausts. */
  _buildDressGeometry() {
    const parts = [];
    // Front splitter and rear diffuser.
    pushGeo(parts, roundBox(1.78, 0.05, 0.34, 0.022, 2), 0, 0.245, -1.94, 0.06);
    pushGeo(parts, roundBox(1.66, 0.06, 0.42, 0.025, 2), 0, 0.27, 1.94, -0.05);
    for (let i = -2; i <= 2; i++) {
      pushGeo(parts, roundBox(0.045, 0.14, 0.40, 0.018, 1), i * 0.28, 0.31, 1.94);
    }
    // Side skirts.
    for (const side of [-1, 1]) {
      pushGeo(parts, roundBox(0.10, 0.09, 1.60, 0.035, 2), side * 0.93, 0.28, 0.16);
      // Mirrors on a stalk.
      pushGeo(parts, new THREE.CylinderGeometry(0.016, 0.016, 0.16, 8), side * 1.00, 0.94, -0.66, 0, 0, Math.PI / 2 + side * 0.25);
      pushGeo(parts, roundBox(0.06, 0.09, 0.17, 0.03, 2), side * 1.09, 0.965, -0.66, 0, side * 0.28, 0);
      // Exhaust tips.
      pushGeo(parts, new THREE.CylinderGeometry(0.055, 0.06, 0.14, 12, 1, true), side * 0.46, 0.36, 2.08, Math.PI / 2);
      // Intake vent behind the front arch.
      pushGeo(parts, roundBox(0.045, 0.13, 0.30, 0.02, 2), side * 0.955, 0.60, -0.98, 0, 0, 0);
    }
    // Bonnet vents.
    for (const side of [-1, 1]) {
      pushGeo(parts, roundBox(0.30, 0.03, 0.22, 0.012, 2), side * 0.44, 0.955, -1.24, -0.06);
    }
    return mergeGeometries(parts, false);
  }

  /** Painted arch flares, one per wheel. */
  _buildFlareGeometry() {
    const parts = [];
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const sx = i % 2 === 0 ? -1 : 1;
      const arch = new THREE.TorusGeometry(0.485, 0.085, 8, 20, Math.PI * 1.05);
      arch.rotateZ(-Math.PI * 0.025);
      arch.rotateY(Math.PI / 2);
      arch.scale(2.9, 1, 1); // widen the tube into a flare
      arch.translate(sx * 0.86, WHEEL_R + 0.02, front ? -AXLE_Z : AXLE_Z);
      parts.push(arch);
    }
    return mergeGeometries(parts, false);
  }

  /** Headlight lenses plus a daytime-running strip across the nose. */
  _buildHeadLensGeometry() {
    const parts = [];
    for (const side of [-1, 1]) {
      const lens = new THREE.SphereGeometry(0.115, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.45);
      lens.scale(1.5, 0.75, 1);
      pushGeo(parts, lens, side * 0.60, 0.79, -1.94, -Math.PI / 2);
      const drl = roundBox(0.30, 0.032, 0.05, 0.015, 1);
      pushGeo(parts, drl, side * 0.60, 0.665, -1.965);
    }
    return mergeGeometries(parts, false);
  }

  /** Full-width tail bar plus two brake pods. */
  _buildTailLensGeometry() {
    const parts = [];
    pushGeo(parts, roundBox(1.52, 0.055, 0.05, 0.02, 1), 0, 0.845, 2.055);
    for (const side of [-1, 1]) {
      const pod = roundBox(0.34, 0.11, 0.06, 0.028, 2);
      pushGeo(parts, pod, side * 0.56, 0.845, 2.06);
    }
    return mergeGeometries(parts, false);
  }

  /** Cyan underbody accent strips - the mount family's signature. */
  _buildAccentGeometry() {
    const parts = [];
    for (const side of [-1, 1]) {
      pushGeo(parts, roundBox(0.03, 0.022, 1.70, 0.01, 1), side * 0.965, 0.315, 0.16);
    }
    pushGeo(parts, roundBox(0.90, 0.02, 0.03, 0.008, 1), 0, 0.30, -1.98);
    return mergeGeometries(parts, false);
  }

  /**
   * Headlights, as a real light.
   *
   * The rig is parented to the *scene*, not to the car, and is created here in
   * the constructor rather than on spawn. That is not tidiness: Three keys its
   * shader program cache on light counts, so a light that appears when the car
   * is summoned invalidates and recompiles every material in view - the exact
   * failure that cost this project a measured 63 s freeze on the first bow
   * draw. Created once at construction (which happens during the boot warmup)
   * and never removed, the count is constant for the whole session and the car
   * can be summoned and dismissed as often as the player likes for free.
   * Intensity, not membership, is what gets switched.
   */
  _buildLightRig() {
    this._lightGroup = new THREE.Group();
    this._lightGroup.name = 'car-lights';
    this._spot = new THREE.SpotLight(0xfff0d0, 0, 42, 0.46, 0.55, 1.6);
    this._spot.castShadow = false;
    this._spotTarget = new THREE.Object3D();
    this._lightGroup.add(this._spot);
    this._lightGroup.add(this._spotTarget);
    this._spot.target = this._spotTarget;
    this.scene.add(this._lightGroup);
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  get alive() {
    return this._alive;
  }

  setVisible(v) {
    this.root.visible = v;
    this._dust.setVisible(v);
    this._sparks.setVisible(v);
    this._marks.setVisible(v);
    if (!v) this._spot.intensity = 0;
  }

  /**
   * Place the car and start the materialisation animation.
   * @param {THREE.Vector3} position feet-height point to spawn on
   * @param {number} yaw radians
   */
  spawn(position, yaw) {
    this.position.copy(position);
    // Probe locally, from just above the requested point: a long cast from the
    // sky finds whatever gantry happens to be overhead and parks the car on it.
    const g = this.physics.groundHeight(position.x, position.z, position.y + 1.6, 10);
    this._groundY = g === null ? position.y : g;
    this._groundValid = g !== null;
    this.position.y = this._groundY;
    for (let i = 0; i < 4; i++) {
      this._wheelGround[i] = this._groundY;
      this._wheelHit[i] = this._groundValid;
    }
    this.heading = yaw;
    this.velocity.set(0, 0, 0);
    this.speed = 0;
    this._vy = 0;
    this._accel = 0;
    this._pitch = 0;
    this._roll = 0;
    this._steer = 0;
    this._boost = 0;
    this._bodyBob = 0;
    this._bobVel = 0;
    this._spawnT = 0;
    this._despawnT = -1;
    this._alive = true;
    this.root.position.copy(this.position);
    this.root.rotation.y = yaw;
    if (!this.root.parent) this.scene.add(this.root);
    this.setVisible(true);
    this._dust.clear();
    this._sparks.clear();
    this._marks.clear();

    // Arrival: a ring of sparks off the contact patches.
    for (let i = 0; i < 30; i++) {
      const a = (i / 30) * Math.PI * 2;
      this._sparks.spawn(
        this.position.x + Math.cos(a) * 1.1,
        this.position.y + 0.08,
        this.position.z + Math.sin(a) * 1.6,
        Math.cos(a) * 2.2, 1.8 + Math.random() * 2.2, Math.sin(a) * 2.2,
        0.5 + Math.random() * 0.3, 0.16, 0.7, 0.92, 1
      );
    }
  }

  /** Begin the despawn dissolve. `alive` clears once it finishes. */
  despawn() {
    if (!this._alive || this._despawnT >= 0) return;
    this._despawnT = 0;
    for (let i = 0; i < 24; i++) {
      const a = Math.random() * Math.PI * 2;
      this._sparks.spawn(
        this.position.x + Math.cos(a) * 0.8,
        this.position.y + 0.3 + Math.random() * 0.6,
        this.position.z + Math.sin(a) * 1.2,
        Math.cos(a) * 1.3, 1.4 + Math.random() * 1.5, Math.sin(a) * 1.3,
        0.5, 0.15, 0.5, 0.86, 1
      );
    }
  }

  /** Remove immediately, no animation. Used when the world changes under us. */
  kill() {
    this._alive = false;
    this._ridden = false;
    this._despawnT = -1;
    this._spawnT = 1;
    this.setVisible(false);
    this._dust.clear();
    this._sparks.clear();
    this._marks.clear();
    this._speedLines.update(0.016, this.camera, 0);
    this._spot.intensity = 0;
    this.root.removeFromParent();
  }

  onMount() {
    this._ridden = true;
  }

  onDismount() {
    this._ridden = false;
    this._boost = 0;
    this._boostActive = false;
    this._braking = false;
  }

  /* ---------------------------------------------------------------- */
  /* Simulation                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * @param {number} dt fixed step
   * @param {number} elapsed
   * @param {{throttle:number, strafe:number, yaw:number, boost:boolean}|null} ctrl
   *        null while parked
   */
  fixedUpdate(dt, elapsed, ctrl) {
    if (!this._alive) return;
    const ridden = !!ctrl;
    const throttle = ridden ? ctrl.throttle : 0;
    const strafe = ridden ? ctrl.strafe : 0;
    const wantBoost = ridden && !!ctrl.boost && throttle > 0;
    const v = Math.abs(this.speed);

    /* ---- steering ---------------------------------------------------- */
    if (ridden) {
      // A/D trims the target heading either side of the look direction, so the
      // car can be placed on a line without swinging the camera.
      const target = ctrl.yaw - strafe * 0.45;
      let diff = ((target - this.heading + Math.PI) % (Math.PI * 2)) - Math.PI;
      if (diff < -Math.PI) diff += Math.PI * 2;
      // No authority parked, most at town speed, less again flat out. This one
      // curve is most of the difference between a car and a turret.
      const authority = smoothstep(0.2, 4.0, v);
      // Two limits, whichever bites first: a mechanical lock at low speed and
      // the grip budget above it.
      const maxRate = Math.min(1.95, LAT_GRIP / Math.max(v, 2)) * authority;
      const rate = clamp(diff * 3.6, -maxRate, maxRate);
      // In reverse the steered axle trails, so the car swings the other way.
      this.heading += rate * dt * (this.speed < -0.4 ? -1 : 1);
      this._turnRate = damp(this._turnRate, rate, 9, dt);
      // Visible lock from the bicycle model - the angle the front wheels would
      // actually need for this yaw rate at this speed. It is why the wheels are
      // cranked over in a car park and barely off centre at a motorway sweep,
      // which no amount of driving them from the raw input can reproduce.
      const want = v < 1.6
        ? clamp(diff * 1.4, -1, 1) * MAX_STEER
        : clamp(Math.atan((WHEELBASE * rate) / Math.max(v, 1.2)), -MAX_STEER, MAX_STEER);
      this._steer = damp(this._steer, want, 9, dt);
    } else {
      this._turnRate = damp(this._turnRate, 0, 6, dt);
      this._steer = damp(this._steer, 0, 5, dt);
    }

    /* ---- longitudinal ------------------------------------------------ */
    this._boost = damp(this._boost, wantBoost ? 1 : 0, wantBoost ? 2.6 : 2.0, dt);
    this._boostActive = wantBoost;

    const braking = throttle < 0 && this.speed > 1.2;
    this._braking = braking;
    this._reversing = this.speed < -0.4;
    let targetSpeed = 0;
    if (throttle > 0) targetSpeed = lerp(CRUISE_SPEED, BOOST_SPEED, this._boost) * this._powerMul;
    else if (throttle < 0) targetSpeed = braking ? 0 : -REVERSE_SPEED;

    // Airborne wheels have nothing to push against: coast only.
    const grip = this._airborne ? 0.12 : 1;
    const rate = (throttle === 0
      ? 0.55
      : braking ? 5.5 : (Math.abs(targetSpeed) > v ? (1.15 + this._boost * 0.55) : 3.0)) * this._accelMul;
    const prevSpeed = this.speed;
    this.speed = damp(this.speed, targetSpeed, rate * grip, dt);
    if (Math.abs(this.speed) < 0.03 && throttle === 0) this.speed = 0;
    this._accel = dt > 0 ? (this.speed - prevSpeed) / dt : 0;

    const fx = -Math.sin(this.heading);
    const fz = -Math.cos(this.heading);
    this.velocity.set(fx * this.speed, this._vy, fz * this.speed);

    /* ---- per-wheel ground probes ------------------------------------- */
    const rx = Math.cos(this.heading);
    const rz = -Math.sin(this.heading);
    let sum = 0;
    let hits = 0;
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const sx = i % 2 === 0 ? -1 : 1;
      const along = front ? AXLE_Z : -AXLE_Z;
      const px = this.position.x + fx * along + rx * sx * HALF_TRACK;
      const pz = this.position.z + fz * along + rz * sx * HALF_TRACK;
      const h = this.physics.groundHeight(px, pz, this.position.y + 1.4, 7);
      this._wheelHit[i] = h !== null;
      // A missed probe means a hole or a ledge: pretend the ground fell away so
      // the wheel droops and the car pitches into it, rather than snapping.
      this._wheelGround[i] = h === null ? this._groundY - 2.5 : h;
      if (h !== null) { sum += h; hits++; }
    }
    const groundAvg = hits > 0 ? sum / hits : this._groundY - 2.5;
    this._groundValid = hits > 0;
    this._groundY = groundAvg;

    /* ---- ride height ------------------------------------------------- */
    const gap = this.position.y - groundAvg;
    if (gap > AIR_GAP) {
      this._airborne = true;
      this._vy += GRAVITY * dt;
      this.position.y += this._vy * dt;
    } else {
      if (this._airborne && this._vy < -3.5) this._onLanding(-this._vy);
      this._airborne = false;
      // Suspension. The upward term is rate limited and finished off by a hard
      // floor below, so ground rising faster than the spring can answer pushes
      // the car up without ever becoming vertical *speed*. That is what stops
      // the skate-park bowl from launching the car into orbit.
      this._vy += (-gap * 90 - this._vy * 14) * dt;
      this._vy = clamp(this._vy, -20, 3.0);
      this.position.y += this._vy * dt;
    }
    if (this.position.y < groundAvg) {
      this.position.y = groundAvg;
      if (this._vy < 0) this._vy = 0;
    }

    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;

    /* ---- keep out of walls ------------------------------------------- */
    this._resolveCollision(fx, fz);

    /* ---- attitude ---------------------------------------------------- */
    const front = (this._wheelGround[0] + this._wheelGround[1]) * 0.5;
    const rear = (this._wheelGround[2] + this._wheelGround[3]) * 0.5;
    const left = (this._wheelGround[0] + this._wheelGround[2]) * 0.5;
    const right = (this._wheelGround[1] + this._wheelGround[3]) * 0.5;
    const slopePitch = this._airborne ? 0 : Math.atan2(front - rear, WHEELBASE);
    const slopeRoll = this._airborne ? 0 : Math.atan2(right - left, TRACK);
    // Weight transfer: the nose lifts under power and dives under brakes.
    const transfer = clamp(this._accel * 0.011, -0.11, 0.09);
    // Body roll leans onto the *outside* of the corner, so the sign is inverted
    // against the turn rate.
    const lateral = this._turnRate * v;
    this._slip = damp(this._slip, Math.abs(lateral), 6, dt);
    const bodyRoll = clamp(lateral * 0.020, -0.16, 0.16);
    this._pitchTarget = clamp(slopePitch, -0.6, 0.6) + transfer;
    this._rollTarget = clamp(slopeRoll, -0.5, 0.5) - bodyRoll;
    this._pitch = damp(this._pitch, this._pitchTarget, 7, dt);
    this._roll = damp(this._roll, this._rollTarget, 7.5, dt);

    // Ride bob: a light second-order spring so landings compress and recover
    // rather than snapping back.
    this._bobVel += (-this._bodyBob * 180 - this._bobVel * 17) * dt;
    this._bodyBob = clamp(this._bodyBob + this._bobVel * dt, -0.10, 0.05);

    this._spin += (this.speed / WHEEL_R) * dt;
  }

  /**
   * Push the car out of anything it drove into.
   *
   * Three capsules along the centreline, resolved independently: the largest
   * horizontal correction wins, the velocity component that caused it is
   * removed, and hitting a wall costs speed so it feels like a mistake. A
   * single capsule big enough to cover a 4.3 m car would be wider than the car
   * and would refuse to fit through doorways it can visibly clear.
   */
  _resolveCollision(fx, fz) {
    let bx = 0;
    let bz = 0;
    let best = 0;
    for (let i = 0; i < HULL_Z.length; i++) {
      const along = -HULL_Z[i];
      const px = this.position.x + fx * along;
      const pz = this.position.z + fz * along;
      // Start each capsule above the *local* ground, so kerbs, ramp lips and
      // bowl transitions are driven over instead of acting as walls.
      const localGround = i === 0
        ? (this._wheelGround[0] + this._wheelGround[1]) * 0.5
        : i === 2 ? (this._wheelGround[2] + this._wheelGround[3]) * 0.5 : this._groundY;
      _rc1.set(px, Math.max(this.position.y, localGround) + HULL_LIFT, pz);
      _rc2.copy(_rc1);
      this.physics.resolveCapsule(_rc1, HULL_R, HULL_H);
      const dx = _rc1.x - _rc2.x;
      const dy = _rc1.y - _rc2.y;
      const dz = _rc1.z - _rc2.z;
      const lenSq = dx * dx + dz * dz;
      /* Ground is not a wall.
       *
       * `resolveCapsule` pushes out along the surface normal, and only the
       * horizontal part of that was ever read - `dy` was thrown away. On level
       * ground that is harmless, because the normal is straight up and there is
       * no horizontal part. On a *slope* there always is one, and since `nx/nz`
       * below are normalised, its magnitude is discarded too: two millimetres
       * of push from a 1% rise produced exactly the same "square hit" as
       * driving into a barrier, and cost the same 45% of speed every single
       * step. The car settled at 0.5 m/s on any gradient above about 0.05%.
       *
       * No world had ever shown this, because every ground collider in the game
       * until now was a level-topped box. The race circuit climbs 11%, and the
       * first thing anyone did was drive up it.
       *
       * A pushout that is mostly vertical is the floor holding the car up. Only
       * a predominantly horizontal one is something in its way. */
      if (Math.abs(dy) >= Math.sqrt(lenSq)) continue;
      if (lenSq > best) {
        best = lenSq;
        bx = dx;
        bz = dz;
      }
    }
    if (best <= 1e-8) return;
    const len = Math.sqrt(best);
    const nx = bx / len;
    const nz = bz / len;
    this.position.x += bx;
    this.position.z += bz;
    const into = this.velocity.x * nx + this.velocity.z * nz;
    if (into < 0) {
      this.velocity.x -= nx * into;
      this.velocity.z -= nz * into;
      // Scrubbing a wall costs speed - proportional to how square the hit was.
      const square = clamp01(-into / (Math.abs(this.speed) + 1e-3));
      this.speed *= 1 - 0.45 * square;
      if (square > 0.5 && Math.abs(this.speed) > 5) this._onScrape(len);
    }
  }

  _onScrape(depth) {
    for (let i = 0; i < 4; i++) {
      this._sparks.spawn(
        this.position.x + (Math.random() - 0.5) * 1.6,
        this.position.y + 0.35 + Math.random() * 0.4,
        this.position.z + (Math.random() - 0.5) * 2.4,
        (Math.random() - 0.5) * 3, 1 + Math.random() * 2, (Math.random() - 0.5) * 3,
        0.28, 0.07 + depth * 0.1, 1, 0.72, 0.3
      );
    }
  }

  _onLanding(impact) {
    this._bobVel -= Math.min(impact, 14) * 0.028;
    const n = Math.min(16, 4 + impact);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      this._dust.spawn(
        this.position.x + Math.cos(a) * 0.9,
        this.position.y + 0.06,
        this.position.z + Math.sin(a) * 1.4,
        Math.cos(a) * 2.2, 0.9 + Math.random(), Math.sin(a) * 2.2,
        0.55, 0.28, 1, 0.94, 0.8
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* Presentation                                                      */
  /* ---------------------------------------------------------------- */

  update(dt, elapsed) {
    if (!this._alive) {
      // Keep draining the pools so a despawn does not freeze sprites in mid-air.
      this._dust.update(dt, this.camera);
      this._sparks.update(dt, this.camera);
      this._marks.update(dt);
      this._speedLines.update(dt, this.camera, 0);
      return;
    }

    /* ---- spawn / despawn envelopes ---- */
    if (this._spawnT < 1) this._spawnT = Math.min(1, this._spawnT + dt * 1.7);
    if (this._despawnT >= 0) {
      this._despawnT += dt * 2.2;
      if (this._despawnT >= 1) {
        this._alive = false;
        this.setVisible(false);
        this.root.removeFromParent();
        return;
      }
    }
    const materialise = this._despawnT >= 0 ? 1 - this._despawnT : this._spawnT;
    const ease = materialise * materialise * (3 - 2 * materialise);

    /* ---- transforms ---- */
    this._syncTransform();
    // Assemble upward out of the road, and sink back into it on dismissal.
    this.skin.scale.set(1, 0.25 + ease * 0.75, 1);
    this.skin.position.y = -(1 - ease) * 0.30;
    this.body.position.y = -PIVOT_Y + this._bodyBob;
    const solid = ease > 0.45;
    this._cabinMesh.visible = solid;
    this.steerWheel.visible = solid;
    this.steerColumn.visible = solid;

    /* ---- wheels ---- */
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      // Wheel height is measured against the contact plane the root sits on, so
      // a wheel simply tracks its own probe until the suspension runs out of
      // travel - which is also what makes a wheel hang in the air on a jump.
      const want = this._wheelGround[i] + WHEEL_R - this.position.y;
      const y = clamp(want, WHEEL_R - SUSP_DOWN, WHEEL_R + SUSP_UP);
      w.susp.position.y = damp(w.susp.position.y, y, 18, dt);
      if (w.front) w.steer.rotation.y = this._steer;
      w.spin.rotation.x = this._spin;
      w.susp.visible = ease > 0.35;
    }

    /* ---- lamps ---- */
    const sp01 = clamp01(Math.abs(this.speed) / BOOST_SPEED);
    const headOn = this._nightness * 0.85 + 0.15;
    this._headMat.opacity = (0.25 + headOn * 0.75) * ease;
    this._brakeMat.opacity = (this._braking ? 1.0 : this._reversing ? 0.75 : 0.28 + sp01 * 0.12) * ease;
    this._brakeMat.color.setRGB(1, this._reversing ? 0.75 : 0.14, this._reversing ? 0.62 : 0.10);
    this._accentMat.opacity = (0.35 + sp01 * 0.35 + this._boost * 0.4) * ease;
    this._accentMat.color.setRGB(0.32 + this._boost * 0.6, 0.86, 1);

    const beam = clamp01(this._nightness * 1.15 - 0.12) * ease;
    this._beamMat.opacity = beam * 0.055;
    for (const b of this._beams) b.visible = beam > 0.02;
    this._poolMat.opacity = beam * 0.22;
    this._pool.position.set(0, this._groundY - this.position.y + 0.04, -5.6);
    this._updateLightRig(beam);

    /* ---- ground effects ---- */
    if (this._despawnT < 0) {
      this._emitMarks(dt);
      this._emitDust(dt, sp01);
    }
    this._dust.update(dt, this.camera);
    this._sparks.update(dt, this.camera);
    this._marks.update(dt);

    const rush = this._ridden
      ? clamp01((Math.abs(this.speed) - CRUISE_SPEED * 0.8) / (BOOST_SPEED - CRUISE_SPEED * 0.8))
      : 0;
    this._speedLines.update(dt, this.camera, rush * (0.16 + this._boost * 0.4));
    void elapsed;
  }

  /** Write the simulation state onto the scene graph. */
  _syncTransform() {
    this.root.position.copy(this.position);
    this.root.rotation.y = this.heading;
    this.tilt.rotation.set(this._pitch, 0, this._roll);
    // Seen from the driver's seat the wheel face is the +Z side, where a
    // positive Z rotation reads as anticlockwise - i.e. turning left, which is
    // the direction a positive road-wheel angle takes the car.
    this.steerWheel.rotation.z = this._steer * STEER_RATIO;
  }

  /**
   * Aim the persistent headlight rig. World space, because the rig deliberately
   * does not hang off the car - see `_buildLightRig`.
   */
  _updateLightRig(beam) {
    const fx = -Math.sin(this.heading);
    const fz = -Math.cos(this.heading);
    _lr1.set(this.position.x + fx * 1.9, this.position.y + 0.8, this.position.z + fz * 1.9);
    this._spot.position.copy(_lr1);
    this._spotTarget.position.set(
      this.position.x + fx * 15,
      this._groundY + 0.1,
      this.position.z + fz * 15
    );
    this._spot.intensity = beam * 260;
  }

  /**
   * Lay rubber. Marks come from the *lateral* demand the tyres cannot meet plus
   * hard braking and boost launches - the three moments a real tyre lets go.
   */
  _emitMarks(dt) {
    const v = Math.abs(this.speed);
    if (v < 2.5) { this._markAccum = 0; return; }
    const slide = clamp01((this._slip - 6.5) / 8);
    const brake = this._braking ? clamp01((v - 6) / 16) : 0;
    const launch = clamp01((this._accel - 4) / 8) * clamp01(1 - v / 14);
    const dark = clamp01(Math.max(slide, brake * 0.85, launch * 0.9));
    if (dark < 0.06 || this._airborne) { this._markAccum = 0; return; }

    this._markAccum += v * dt;
    // One patch every 0.32 m of travel: dense enough to read as a continuous
    // line at speed, sparse enough that the pool covers a long corner.
    while (this._markAccum > 0.32) {
      this._markAccum -= 0.32;
      const fx = -Math.sin(this.heading);
      const fz = -Math.cos(this.heading);
      const rx = Math.cos(this.heading);
      const rz = -Math.sin(this.heading);
      // Rears always; fronts only when the brakes are what let go.
      const axles = brake > slide ? [0, 1, 2, 3] : [2, 3];
      for (const i of axles) {
        const front = i < 2;
        const sx = i % 2 === 0 ? -1 : 1;
        const along = front ? AXLE_Z : -AXLE_Z;
        this._marks.spawn(
          this.position.x + fx * along + rx * sx * HALF_TRACK,
          this._wheelGround[i] + 0.02,
          this.position.z + fz * along + rz * sx * HALF_TRACK,
          this.heading,
          WHEEL_W * 1.15,
          0.42,
          dark * 0.7,
          5.5 + Math.random() * 2.5
        );
      }
    }
  }

  /** Dust kicked off the contact patches, and hot exhaust under boost. */
  _emitDust(dt, sp01) {
    const v = Math.abs(this.speed);
    const rate = (v > 2 ? 5 + sp01 * 22 : 0) + this._slip * 1.6 + this._boost * 14;
    if (rate <= 0) { this._dustAccum = 0; return; }
    this._dustAccum += rate * dt;
    const n = Math.floor(this._dustAccum);
    if (n <= 0) return;
    this._dustAccum -= n;

    const fx = -Math.sin(this.heading);
    const fz = -Math.cos(this.heading);
    const rx = Math.cos(this.heading);
    const rz = -Math.sin(this.heading);
    for (let i = 0; i < n && i < 5; i++) {
      const rear = Math.random() < 0.72;
      const sx = Math.random() < 0.5 ? -1 : 1;
      const along = rear ? -AXLE_Z : AXLE_Z;
      const px = this.position.x + fx * along + rx * sx * HALF_TRACK;
      const pz = this.position.z + fz * along + rz * sx * HALF_TRACK;
      const back = 1.4 + sp01 * 3.5;
      this._dust.spawn(
        px, this._groundY + 0.06 + Math.random() * 0.1, pz,
        -fx * back + (Math.random() - 0.5) * 1.6 + rx * sx * 0.7,
        0.5 + Math.random() * 0.9,
        -fz * back + (Math.random() - 0.5) * 1.6 + rz * sx * 0.7,
        0.42 + Math.random() * 0.3,
        0.20 + Math.random() * 0.16,
        1, 0.94, 0.84
      );
    }
    // Exhaust heat haze under boost, straight out of the tips.
    if (this._boost > 0.25 && Math.random() < this._boost * 0.7) {
      for (const side of [-1, 1]) {
        this._dust.spawn(
          this.position.x - fx * 2.08 + rx * side * 0.46,
          this.position.y + 0.36,
          this.position.z - fz * 2.08 + rz * side * 0.46,
          fx * 2.5, 0.7, fz * 2.5,
          0.26, 0.16, 1, 0.72, 0.42
        );
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Queries used by MountManager                                      */
  /* ---------------------------------------------------------------- */

  /** Which rider pose MountManager should hold this mount's occupant in. */
  get riderPose() {
    return 'drive';
  }

  /** How far in front of the player to materialise - a car needs the room. */
  get spawnDistance() {
    return 4.4;
  }

  /**
   * Feet position for the player capsule.
   *
   * `riderAnchor` is the seat - where the driver's *pelvis* sits - so the
   * capsule is dropped by the rider's hip height, exactly as the dragon's
   * saddle does. It is then floored at the car's own contact plane: the seat
   * base is only 0.63 m up, so an unclamped drop would post the capsule under
   * the road and leave the physics solver fighting it every step.
   */
  getSeat(out) {
    this._syncTransform();
    this.root.updateMatrixWorld(true);
    _gs1.setFromMatrixPosition(this.riderAnchor.matrixWorld);
    out.copy(_gs1);
    out.y = Math.max(_gs1.y - this._riderDrop, this.position.y + 0.05);
    return out;
  }

  /**
   * Hip height of the figure actually in the seat, in metres.
   * @param {number} d
   */
  setRiderDrop(d) {
    if (Number.isFinite(d) && d > 0.2 && d < 1.6) this._riderDrop = d;
  }

  /**
   * World position of a pedal's ankle rest. Named for the dragon's stirrups so
   * MountManager's seated-rider solver can drive both without knowing which
   * mount it is posing.
   * @param {number} side +1 right, -1 left
   * @param {THREE.Vector3} out
   */
  getStirrupWorld(side, out) {
    const o = this.pedals?.[side > 0 ? 0 : 1];
    if (!o) return null;
    o.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(o.matrixWorld);
  }

  /**
   * World position of a hand's grip on the steering wheel rim.
   * @param {number} side +1 right, -1 left
   * @param {THREE.Vector3} out
   */
  getGripWorld(side, out) {
    const o = this.grips?.[side > 0 ? 0 : 1];
    if (!o) return null;
    o.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(o.matrixWorld);
  }

  /** Third-person framing: 4.3 m of car needs a longer boom than a rider. */
  get cameraHint() {
    return CAR_CAMERA;
  }

  get fovKick() {
    return this._boost * 10 + clamp01(Math.abs(this.speed) / BOOST_SPEED) * 4;
  }

  get boostActive() {
    return this._boostActive;
  }

  get speed01() {
    return clamp01(Math.abs(this.speed) / BOOST_SPEED);
  }

  get boost01() {
    return this._boost;
  }

  /** Signed longitudinal acceleration, -1..1. The driver braces against it. */
  get accel01() {
    return clamp(this._accel / 11, -1, 1);
  }

  /** Current body roll in radians; the driver leans against it. */
  get bankRoll() {
    return this._roll;
  }

  get groundY() {
    return this._groundY;
  }

  get altitude() {
    return this.position.y - this._groundY;
  }

  /** Do not let the player step out of a car that is mid-air. */
  canDismount() {
    return !this._airborne || this.altitude < 1.6;
  }

  /**
   * Where to stand the player when they get out: alongside the driver's door,
   * settled onto whatever floor is actually there.
   */
  dismountPoint(out) {
    const rx = Math.cos(this.heading);
    const rz = -Math.sin(this.heading);
    _dp1.set(this.position.x - rx * 1.75, 0, this.position.z - rz * 1.75);
    const g = this.physics.groundHeight(_dp1.x, _dp1.z, this.position.y + 1.6, 8);
    return out.set(_dp1.x, (g === null ? this._groundY : g) + 0.05, _dp1.z);
  }

  /**
   * Apply a player livery. Tints the *cloned* body paint and alloy, so the
   * shared material library and the AI grid keep their factory colours. Fields
   * are independent 0xRRGGBB values (number or '#rrggbb'); a missing one is left
   * untouched. Safe to call before or after the model is built.
   * @param {{paint?:number|string, wheel?:number|string}} livery
   */
  applyCustomization(livery) {
    if (!livery) return;
    this._livery = { ...(this._livery || {}), ...livery };
    if (this._paintMat && this._livery.paint != null) this._paintMat.color.set(this._livery.paint);
    if (this._wheelMat && this._livery.wheel != null) this._wheelMat.color.set(this._livery.wheel);
  }

  /**
   * Apply purchased mount powers. Tiers are small integers (0 == none); each
   * tier is a modest, stacking bump so a fully-kitted car is quick but not
   * broken. `power` lifts top speed, `strength` sharpens acceleration, `shield`
   * is stored for the collision code to read.
   * @param {{strength?:number, shield?:number, power?:number}} tiers
   */
  applyPowers({ strength = 0, shield = 0, power = 0 } = {}) {
    this._powerMul = 1 + Math.max(0, power) * 0.12;   // +12% top speed / tier
    this._accelMul = 1 + Math.max(0, strength) * 0.10; // +10% throttle bite / tier
    this._shieldTier = Math.max(0, shield);
  }

  /** Purchased shield tier, for collision damping. */
  get shieldTier() {
    return this._shieldTier;
  }

  dispose() {
    this.bus?.off?.('world:changed', this._onWorldChanged);
    this.root.removeFromParent();
    this._lightGroup.removeFromParent();
    this._spot.dispose?.();
    for (const key in this._geo) this._geo[key].dispose();
    this._paintMat?.dispose();
    this._wheelMat?.dispose();
    this._headMat.dispose();
    this._brakeMat.dispose();
    this._accentMat.dispose();
    this._beamMat.dispose();
    this._poolMat.dispose();
    this._glowTex.dispose();
    this._dust.dispose();
    this._sparks.dispose();
    this._marks.dispose();
    this._speedLines.dispose();
  }
}
