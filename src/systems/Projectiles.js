import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { COLLISION_LAYER } from '../physics/Physics.js';

/**
 * Pooled projectile simulation: fireballs and arrows.
 *
 * ── Why swept, and why the sweep is the *whole* step ───────────────────────
 * An arrow leaves the bow at 80 m/s. At the 60 Hz fixed step that is 1.33 m of
 * travel per tick, and a fireball at 52 m/s covers 0.87 m. A castle wall is
 * 0.4 m thick and an NPC capsule is 0.6 m across, so integrating first and
 * testing the *new* position would let both weapons pass straight through
 * geometry roughly half the time. Every projectile therefore raycasts the
 * segment it is about to traverse - world first via `physics.raycast`, NPCs via
 * `npcManager.raycastNPCs` along the same segment - and the nearest hit wins.
 * Tunnelling is structurally impossible rather than merely unlikely.
 *
 * ── Allocation ─────────────────────────────────────────────────────────────
 * Projectiles, trail particles, embers, smoke, scorch decals, shockwaves and
 * stuck arrows all live in fixed-size pools backed by flat typed arrays. Nothing
 * in `fixedUpdate`/`update` allocates. `physics.raycast` returns a fresh result
 * object per call, which is the one allocation we cannot avoid without editing a
 * module we do not own; at ~4 casts per tick it is noise next to the frame's
 * own garbage.
 *
 * Rendering budget: 2 particle draw calls, 1 fireball core, 1 arrow batch,
 * 1 stuck-arrow batch, 1 scorch batch, 1 shockwave batch - 7 total, plus three
 * pooled point lights that are added once and idle at zero intensity (adding or
 * hiding a light rebuilds every program in the scene).
 *
 * Every texture here is painted with canvas2d at construction. No assets.
 */

/* ------------------------------------------------------------------ */
/* Scratch. Each routine owns its own set - sharing them between the   */
/* integrator and the damage path has bitten this project twice.       */
/* ------------------------------------------------------------------ */
/* integrate/sweep */
const _sw1 = new THREE.Vector3();
const _sw2 = new THREE.Vector3();
const _sw3 = new THREE.Vector3();
const _sw4 = new THREE.Vector3();
const _sw5 = new THREE.Vector3();
/* explosion + area damage */
const _ex1 = new THREE.Vector3();
const _ex2 = new THREE.Vector3();
const _ex3 = new THREE.Vector3();
/* mesh transform building */
const _mx1 = new THREE.Vector3();
const _mx2 = new THREE.Vector3();
const _mxq = new THREE.Quaternion();
const _mxm = new THREE.Matrix4();
/* decal / shockwave orientation */
const _or1 = new THREE.Vector3();
const _orq = new THREE.Quaternion();
const _orm = new THREE.Matrix4();
/* emitters */
const _em1 = new THREE.Vector3();
const _em2 = new THREE.Vector3();
const _em3 = new THREE.Vector3();

const UP = new THREE.Vector3(0, 1, 0);
const SIDE = new THREE.Vector3(1, 0, 0);
const FWD_Z = new THREE.Vector3(0, 0, 1);
const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);

/** Pool sizes. Generous enough that saturation is never visible in play. */
const MAX_PROJECTILES = 32;
const MAX_STUCK = 20;
const MAX_SCORCH = 18;
const MAX_WAVES = 5;
const SPARK_CAPACITY = 900;
const SMOKE_CAPACITY = 320;

const KIND_FIREBALL = 0;
const KIND_ARROW = 1;

/* ------------------------------------------------------------------ */
/* Procedural textures                                                 */
/* ------------------------------------------------------------------ */

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}

function finish(canvas, renderer, srgb) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = renderer?.capabilities?.getMaxAnisotropy?.() ?? 1;
  t.needsUpdate = true;
  return t;
}

/**
 * 2x2 particle atlas.
 *   0 soft glow (fireball aura, muzzle bloom)
 *   1 turbulent flame lobe
 *   2 hot point (embers, sparks)
 *   3 soft smoke puff
 *
 * Painted greyscale so the per-instance colour is the only thing deciding hue -
 * one atlas therefore serves both the additive and the alpha-blended pass.
 */
function buildParticleAtlas() {
  const S = 256;
  const H = S / 2;
  const cv = makeCanvas(S);
  const g = cv.getContext('2d');

  /* 0 - soft glow: a wide falloff with a small hot centre. */
  let grad = g.createRadialGradient(H * 0.5, H * 0.5, 0, H * 0.5, H * 0.5, H * 0.5 - 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.16, 'rgba(255,255,255,0.72)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.24)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, H, H);

  /* 1 - flame lobe: stacked offset blobs make a turbulent silhouette that a
   *     single radial gradient cannot fake. Feathered so no hard disc shows. */
  const tmp = makeCanvas(H);
  const t = tmp.getContext('2d');
  t.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 40; i++) {
    const a = Math.random() * TAU;
    const d = Math.pow(Math.random(), 0.55) * H * 0.3;
    const x = H * 0.5 + Math.cos(a) * d;
    const y = H * 0.5 + Math.sin(a) * d * 0.85;
    const r = H * (0.08 + Math.random() * 0.2);
    const bg = t.createRadialGradient(x, y, 0, x, y, r);
    bg.addColorStop(0, 'rgba(255,255,255,0.34)');
    bg.addColorStop(0.5, 'rgba(255,255,255,0.13)');
    bg.addColorStop(1, 'rgba(255,255,255,0)');
    t.fillStyle = bg;
    t.beginPath();
    t.arc(x, y, r, 0, TAU);
    t.fill();
  }
  t.globalCompositeOperation = 'destination-in';
  const mask = t.createRadialGradient(H * 0.5, H * 0.5, 0, H * 0.5, H * 0.5, H * 0.5);
  mask.addColorStop(0, 'rgba(255,255,255,1)');
  mask.addColorStop(0.6, 'rgba(255,255,255,0.9)');
  mask.addColorStop(1, 'rgba(255,255,255,0)');
  t.fillStyle = mask;
  t.fillRect(0, 0, H, H);
  g.drawImage(tmp, H, 0);

  /* 2 - hot point: tight core for embers and impact sparks. */
  grad = g.createRadialGradient(H * 0.5, H + H * 0.5, 0, H * 0.5, H + H * 0.5, H * 0.4);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.1, 'rgba(255,255,255,0.92)');
  grad.addColorStop(0.32, 'rgba(255,255,255,0.22)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, H, H, H);

  /* 3 - smoke puff: same turbulence, much softer and rounder. */
  t.globalCompositeOperation = 'source-over';
  t.clearRect(0, 0, H, H);
  t.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 52; i++) {
    const a = Math.random() * TAU;
    const d = Math.pow(Math.random(), 0.7) * H * 0.32;
    const x = H * 0.5 + Math.cos(a) * d;
    const y = H * 0.5 + Math.sin(a) * d;
    const r = H * (0.1 + Math.random() * 0.18);
    const bg = t.createRadialGradient(x, y, 0, x, y, r);
    bg.addColorStop(0, 'rgba(255,255,255,0.26)');
    bg.addColorStop(0.6, 'rgba(255,255,255,0.09)');
    bg.addColorStop(1, 'rgba(255,255,255,0)');
    t.fillStyle = bg;
    t.beginPath();
    t.arc(x, y, r, 0, TAU);
    t.fill();
  }
  t.globalCompositeOperation = 'destination-in';
  t.fillStyle = mask;
  t.fillRect(0, 0, H, H);
  g.drawImage(tmp, H, H);

  return cv;
}

/**
 * Scorch mark: a charred irregular core, a soot halo and a few radiating
 * cracks. Drawn with a wobbling radius so it never reads as a stamped circle.
 */
function buildScorchTexture() {
  const S = 256;
  const cv = makeCanvas(S);
  const g = cv.getContext('2d');
  const c = S / 2;

  const blob = (radius, wobble, lobes, phase) => {
    g.beginPath();
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * TAU;
      const n =
        Math.sin(a * lobes + phase) * 0.55 +
        Math.sin(a * (lobes * 1.9 + 1) + phase * 1.7) * 0.3 +
        Math.sin(a * (lobes * 3.3 + 2) + phase * 0.6) * 0.15;
      const r = radius * (1 + n * wobble);
      const x = c + Math.cos(a) * r;
      const y = c + Math.sin(a) * r;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
  };

  // Soot halo: wide, faint, no hard edge.
  const halo = g.createRadialGradient(c, c, 4, c, c, c - 4);
  halo.addColorStop(0, 'rgba(24,18,15,0.85)');
  halo.addColorStop(0.42, 'rgba(30,23,19,0.44)');
  halo.addColorStop(0.75, 'rgba(34,27,22,0.14)');
  halo.addColorStop(1, 'rgba(34,27,22,0)');
  g.fillStyle = halo;
  g.fillRect(0, 0, S, S);

  // Charred core, then the burnt-through centre.
  g.fillStyle = 'rgba(14,10,9,0.9)';
  blob(74, 0.26, 5, 0.4);
  g.fill();
  g.fillStyle = 'rgba(6,4,4,0.96)';
  blob(46, 0.3, 6, 2.1);
  g.fill();

  // Heat-cracked edges licking outward.
  g.lineCap = 'round';
  for (let i = 0; i < 18; i++) {
    const a = Math.random() * TAU;
    const len = 74 + Math.random() * 44;
    g.strokeStyle = `rgba(12,8,7,${0.25 + Math.random() * 0.4})`;
    g.lineWidth = 1 + Math.random() * 4;
    g.beginPath();
    g.moveTo(c + Math.cos(a) * 40, c + Math.sin(a) * 40);
    g.quadraticCurveTo(
      c + Math.cos(a + 0.2) * len * 0.6,
      c + Math.sin(a + 0.2) * len * 0.6,
      c + Math.cos(a + (Math.random() - 0.5) * 0.7) * len,
      c + Math.sin(a + (Math.random() - 0.5) * 0.7) * len
    );
    g.stroke();
  }

  // A few embers still glowing in the crater.
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 22; i++) {
    const a = Math.random() * TAU;
    const d = Math.random() * 58;
    const x = c + Math.cos(a) * d;
    const y = c + Math.sin(a) * d;
    const r = 1.5 + Math.random() * 4;
    const eg = g.createRadialGradient(x, y, 0, x, y, r);
    eg.addColorStop(0, `rgba(255,${120 + Math.random() * 80 | 0},40,0.5)`);
    eg.addColorStop(1, 'rgba(120,30,0,0)');
    g.fillStyle = eg;
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
  }

  return cv;
}

/** Expanding shockwave ring: a bright rim with an inner falloff. */
function buildRingTexture() {
  const S = 256;
  const cv = makeCanvas(S);
  const g = cv.getContext('2d');
  const c = S / 2;
  const grad = g.createRadialGradient(c, c, 0, c, c, c);
  grad.addColorStop(0.0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.62, 'rgba(255,120,40,0)');
  grad.addColorStop(0.8, 'rgba(255,170,80,0.55)');
  grad.addColorStop(0.9, 'rgba(255,246,220,1)');
  grad.addColorStop(0.97, 'rgba(255,130,40,0.35)');
  grad.addColorStop(1, 'rgba(255,90,20,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  return cv;
}

/* ------------------------------------------------------------------ */
/* Instanced billboard particles                                       */
/* ------------------------------------------------------------------ */

const PARTICLE_VERT = /* glsl */ `
attribute vec3 aPos;
attribute vec3 aColor;
attribute vec2 aCell;
attribute float aSize;
attribute float aOpacity;
attribute float aRot;

varying vec2 vUv;
varying vec3 vColor;
varying float vOpacity;

#ifdef USE_FOG
  varying float vFogDepth;
#endif

void main() {
  vColor = aColor;
  vOpacity = aOpacity;
  vUv = uv * 0.5 + aCell;

  vec3 centre = ( modelViewMatrix * vec4( aPos, 1.0 ) ).xyz;
  vec2 q = position.xy * aSize;
  float c = cos( aRot );
  float s = sin( aRot );
  vec3 offset = vec3( q.x * c - q.y * s, q.x * s + q.y * c, 0.0 );
  vec4 mv = vec4( centre + offset, 1.0 );

  #ifdef USE_FOG
    vFogDepth = -mv.z;
  #endif

  gl_Position = projectionMatrix * mv;
}
`;

const PARTICLE_FRAG = /* glsl */ `
uniform sampler2D map;
uniform float uIntensity;

varying vec2 vUv;
varying vec3 vColor;
varying float vOpacity;

#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif

void main() {
  vec4 tex = texture2D( map, vUv );
  float alpha = tex.a * vOpacity;
  if ( alpha < 0.004 ) discard;

  vec3 col = vColor * tex.rgb * uIntensity;

  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    #ifdef ADDITIVE_BLEND
      // Emitted light is swallowed by haze rather than tinted by it.
      col *= 1.0 - fogFactor;
    #else
      col = mix( col, fogColor, fogFactor );
    #endif
  #endif

  gl_FragColor = vec4( col, alpha );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * One draw call of camera-facing quads with an O(1) free list.
 *
 * Deliberately narrower than `systems/VFX.js`: this one has no velocity
 * billboarding and no preset table, because fire is round and there is nothing
 * here that needs to be stretched along its travel vector.
 */
class Billboards {
  constructor(scene, { capacity, texture, additive, intensity, renderOrder }) {
    const n = (this.capacity = capacity);
    this.scene = scene;

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
        3
      )
    );
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);

    const inst = (name, size) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(n * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, a);
      return a.array;
    };
    this._aPos = inst('aPos', 3);
    this._aColor = inst('aColor', 3);
    this._aCell = inst('aCell', 2);
    this._aSize = inst('aSize', 1);
    this._aOpacity = inst('aOpacity', 1);
    this._aRot = inst('aRot', 1);
    this._attrs = ['aPos', 'aColor', 'aCell', 'aSize', 'aOpacity', 'aRot'].map((k) =>
      geo.getAttribute(k)
    );
    geo.instanceCount = 0;
    this.geometry = geo;

    const uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      { map: { value: null }, uIntensity: { value: intensity ?? 1 } },
    ]);
    uniforms.map.value = texture;

    this.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      defines: additive ? { ADDITIVE_BLEND: '' } : {},
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
      fog: true,
      toneMapped: true,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder ?? 5;
    this.mesh.matrixAutoUpdate = false;
    scene.add(this.mesh);

    const f = () => new Float32Array(n);
    this.px = f(); this.py = f(); this.pz = f();
    this.vx = f(); this.vy = f(); this.vz = f();
    this.life = f(); this.maxLife = f();
    this.s0 = f(); this.s1 = f();
    this.c0r = f(); this.c0g = f(); this.c0b = f();
    this.c1r = f(); this.c1g = f(); this.c1b = f();
    this.op = f(); this.fadePow = f();
    this.rot = f(); this.rotVel = f();
    this.grav = f(); this.drag = f();
    this.cellU = f(); this.cellV = f();
    this.alive = new Uint8Array(n);

    this._free = new Int32Array(n);
    for (let i = 0; i < n; i++) this._free[i] = n - 1 - i;
    this._freeCount = n;
    this._cursor = 0;
    this.count = 0;
  }

  /**
   * Spawn one quad. Every argument is a primitive so the emitters never build
   * an options object in the hot path.
   */
  emit(
    px, py, pz, vx, vy, vz,
    s0, s1, c0r, c0g, c0b, c1r, c1g, c1b,
    life, cell, grav, drag, opacity, fadePow, rotVel
  ) {
    let i;
    if (this._freeCount > 0) i = this._free[--this._freeCount];
    else {
      // Saturated pool: steal round-robin. At that spawn rate the screen is
      // already a wall of fire, so the theft is invisible - and emit stays O(1).
      i = this._cursor;
      this._cursor = (i + 1) % this.capacity;
    }
    this.px[i] = px; this.py[i] = py; this.pz[i] = pz;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.s0[i] = s0; this.s1[i] = s1;
    this.c0r[i] = c0r; this.c0g[i] = c0g; this.c0b[i] = c0b;
    this.c1r[i] = c1r; this.c1g[i] = c1g; this.c1b[i] = c1b;
    this.op[i] = opacity;
    this.fadePow[i] = fadePow;
    this.rot[i] = Math.random() * TAU;
    this.rotVel[i] = rotVel;
    this.grav[i] = grav;
    this.drag[i] = drag;
    this.cellU[i] = (cell & 1) * 0.5;
    this.cellV[i] = (cell >> 1) * 0.5;
    this.alive[i] = 1;
  }

  update(dt) {
    let n = 0;
    const aP = this._aPos, aC = this._aColor, aCell = this._aCell;
    const aS = this._aSize, aO = this._aOpacity, aR = this._aRot;

    for (let i = 0; i < this.capacity; i++) {
      if (this.alive[i] === 0) continue;
      const life = (this.life[i] -= dt);
      if (life <= 0) {
        this.alive[i] = 0;
        if (this._freeCount < this.capacity) this._free[this._freeCount++] = i;
        continue;
      }

      // Linearised exponential drag, clamped so a dt spike cannot flip the sign.
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.vy[i] += this.grav[i] * dt;
      this.vx[i] *= d; this.vy[i] *= d; this.vz[i] *= d;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      this.rot[i] += this.rotVel[i] * dt;

      const k = life / this.maxLife[i];
      const u = 1 - k;
      const j3 = n * 3;
      aP[j3] = this.px[i]; aP[j3 + 1] = this.py[i]; aP[j3 + 2] = this.pz[i];
      aC[j3] = this.c0r[i] + (this.c1r[i] - this.c0r[i]) * u;
      aC[j3 + 1] = this.c0g[i] + (this.c1g[i] - this.c0g[i]) * u;
      aC[j3 + 2] = this.c0b[i] + (this.c1b[i] - this.c0b[i]) * u;
      const j2 = n * 2;
      aCell[j2] = this.cellU[i];
      aCell[j2 + 1] = this.cellV[i];
      aS[n] = this.s0[i] + (this.s1[i] - this.s0[i]) * u;
      aO[n] = this.op[i] * Math.pow(k, this.fadePow[i]);
      aR[n] = this.rot[i];
      n++;
    }

    if (n === 0 && this.count === 0) return;
    this.count = n;
    this.geometry.instanceCount = n;
    if (n > 0) for (const a of this._attrs) a.needsUpdate = true;
  }

  clear() {
    this.alive.fill(0);
    this.count = 0;
    this.geometry.instanceCount = 0;
    this._cursor = 0;
    for (let i = 0; i < this.capacity; i++) this._free[i] = this.capacity - 1 - i;
    this._freeCount = this.capacity;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}

/* ------------------------------------------------------------------ */
/* Arrow geometry                                                      */
/* ------------------------------------------------------------------ */

/**
 * A whole arrow merged into one geometry, modelled along -Z so it can be
 * oriented with a single `setFromUnitVectors(+Z, velocity)`-style quaternion.
 * Shaft, bodkin head, socket and three fletches - it is seen up close when it
 * sticks into a wall, so a bare cylinder would not survive.
 */
function buildArrowGeometry() {
  const parts = [];
  const push = (geo, x, y, z, rx = 0, ry = 0, rz = 0) => {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    for (const k of Object.keys(g.attributes)) {
      if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    }
    g.rotateX(rx);
    g.rotateY(ry);
    g.rotateZ(rz);
    g.translate(x, y, z);
    parts.push(g);
  };

  // Shaft: a slight taper toward the head reads as a real arrow at 30 cm.
  const shaft = new THREE.CylinderGeometry(0.0055, 0.0068, 0.62, 8);
  shaft.rotateX(Math.PI / 2);
  push(shaft, 0, 0, 0.02);

  // Bodkin point: a four-sided pyramid, not a cone - it catches a highlight.
  const head = new THREE.ConeGeometry(0.0135, 0.075, 4);
  head.rotateX(-Math.PI / 2);
  push(head, 0, 0, -0.325, 0, Math.PI * 0.25);
  // Socket collar where the head meets the shaft.
  const collar = new THREE.CylinderGeometry(0.0092, 0.0078, 0.026, 8);
  collar.rotateX(Math.PI / 2);
  push(collar, 0, 0, -0.276);

  // Three fletches at 120 degrees, swept back along the shaft. Transformed
  // before `push` because the sequence (edge-on, offset, spun, slid aft) is not
  // expressible in push's fixed rotate-then-translate order - and they must
  // still go through it, or `mergeGeometries` sees an indexed plane next to a
  // de-indexed cone and returns null.
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU;
    const fl = new THREE.PlaneGeometry(0.028, 0.11);
    fl.rotateY(Math.PI / 2);
    fl.translate(0.017, 0, 0);
    fl.rotateZ(a);
    fl.translate(0, 0, 0.262);
    push(fl, 0, 0, 0);
  }

  // Nock.
  const nock = new THREE.CylinderGeometry(0.0072, 0.0062, 0.03, 8);
  nock.rotateX(Math.PI / 2);
  push(nock, 0, 0, 0.335);

  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  merged.computeBoundingSphere();
  return merged;
}

/* ------------------------------------------------------------------ */

export class ProjectileSystem {
  /**
   * @param {{scene:THREE.Scene, engine:any, physics:any, bus:any, materials:any,
   *          player:any, npcManager:any, combat:any}} ctx
   */
  constructor({ scene, engine, physics, bus, materials, player, npcManager, combat }) {
    this.scene = scene;
    this.engine = engine;
    this.physics = physics;
    this.bus = bus;
    this.materials = materials;
    this.player = player;
    this.npcManager = npcManager;
    this.combat = combat;

    const renderer = engine?.renderer ?? null;
    this._disposables = [];

    /* ---- particle systems ---- */
    const atlas = finish(buildParticleAtlas(), renderer, true);
    this._disposables.push(atlas);
    this.sparks = new Billboards(scene, {
      capacity: SPARK_CAPACITY, texture: atlas, additive: true, intensity: 2.2, renderOrder: 6,
    });
    this.smoke = new Billboards(scene, {
      capacity: SMOKE_CAPACITY, texture: atlas, additive: false, intensity: 1, renderOrder: 4,
    });

    this._buildFireballMesh();
    this._buildArrowMeshes();
    this._buildScorchPool(renderer);
    this._buildWavePool(renderer);
    this._buildLightPool();

    /* ---- projectile state, flat arrays ---- */
    const n = MAX_PROJECTILES;
    const f = () => new Float32Array(n);
    this._p = {
      px: f(), py: f(), pz: f(),
      vx: f(), vy: f(), vz: f(),
      grav: f(), damage: f(), radius: f(), aoe: f(),
      life: f(), maxLife: f(), age: f(), trail: f(), spin: f(), scale: f(),
      kind: new Uint8Array(n),
      active: new Uint8Array(n),
      light: new Int8Array(n),
    };
    this._p.light.fill(-1);
    this._activeCount = 0;

    this._offs = [];
    this._offs.push(this.bus.on('world:changing', () => this.clear()));
  }

  /* ================================================================ */
  /* Resources                                                         */
  /* ================================================================ */

  /**
   * The travelling fireball: a hot inner core plus a rotating additive shell.
   * Both are instanced, so any number of fireballs costs two draw calls.
   */
  _buildFireballMesh() {
    const coreGeo = new THREE.IcosahedronGeometry(1, 2);
    this._coreMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(3.4, 1.5, 0.42), // >1 so bloom picks it up
      toneMapped: false,
      fog: false,
    });
    this._coreMesh = new THREE.InstancedMesh(coreGeo, this._coreMat, MAX_PROJECTILES);
    this._coreMesh.name = 'projectile:fireball-core';
    this._coreMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._coreMesh.frustumCulled = false;
    this._coreMesh.castShadow = false;
    this._coreMesh.count = 0;
    this.scene.add(this._coreMesh);

    const shellGeo = new THREE.IcosahedronGeometry(1, 1);
    this._shellMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(1.5, 0.42, 0.08),
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.BackSide, // draw the far hull so the core reads through it
      toneMapped: false,
      fog: false,
    });
    this._shellMesh = new THREE.InstancedMesh(shellGeo, this._shellMat, MAX_PROJECTILES);
    this._shellMesh.name = 'projectile:fireball-shell';
    this._shellMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._shellMesh.frustumCulled = false;
    this._shellMesh.renderOrder = 6;
    this._shellMesh.count = 0;
    this.scene.add(this._shellMesh);

    this._disposables.push(coreGeo, shellGeo, this._coreMat, this._shellMat);
  }

  _buildArrowMeshes() {
    const geo = buildArrowGeometry();
    this._arrowMat = new THREE.MeshStandardMaterial({
      name: 'projectile.arrow',
      color: new THREE.Color(0x6b5335),
      roughness: 0.72,
      metalness: 0.18,
      side: THREE.DoubleSide, // the fletches are single-sided planes
    });
    this._arrowMesh = new THREE.InstancedMesh(geo, this._arrowMat, MAX_PROJECTILES);
    this._arrowMesh.name = 'projectile:arrows';
    this._arrowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._arrowMesh.frustumCulled = false;
    this._arrowMesh.castShadow = true;
    this._arrowMesh.count = 0;
    this.scene.add(this._arrowMesh);

    // Arrows that have stuck: their own batch so they persist independently of
    // the flight pool and can fade out on a slow timer.
    this._stuckMesh = new THREE.InstancedMesh(geo, this._arrowMat, MAX_STUCK);
    this._stuckMesh.name = 'projectile:arrows-stuck';
    this._stuckMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._stuckMesh.frustumCulled = false;
    this._stuckMesh.castShadow = true;
    this._stuckMesh.count = MAX_STUCK;
    this.scene.add(this._stuckMesh);

    _mxm.makeScale(0, 0, 0);
    for (let i = 0; i < MAX_STUCK; i++) this._stuckMesh.setMatrixAt(i, _mxm);
    this._stuckMesh.instanceMatrix.needsUpdate = true;

    this._stuck = {
      life: new Float32Array(MAX_STUCK),
      maxLife: new Float32Array(MAX_STUCK),
      mat: new Float32Array(MAX_STUCK * 16),
      head: 0,
      live: 0,
    };

    this._disposables.push(geo, this._arrowMat);
  }

  _buildScorchPool(renderer) {
    const tex = finish(buildScorchTexture(), renderer, true);
    this._scorchMat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      opacity: 1,
      // Coplanar with the wall it burns: a normal offset alone still fights at
      // grazing angles on a 2000 m far plane.
      polygonOffset: true,
      polygonOffsetFactor: -8,
      polygonOffsetUnits: -18,
      fog: true,
    });
    const geo = new THREE.PlaneGeometry(1, 1);
    this._scorchMesh = new THREE.InstancedMesh(geo, this._scorchMat, MAX_SCORCH);
    this._scorchMesh.name = 'projectile:scorch';
    this._scorchMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._scorchMesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_SCORCH * 3), 3
    );
    this._scorchMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this._scorchMesh.frustumCulled = false;
    this._scorchMesh.renderOrder = 2;
    this._scorchMesh.castShadow = false;
    this.scene.add(this._scorchMesh);

    _mxm.makeScale(0, 0, 0);
    for (let i = 0; i < MAX_SCORCH; i++) {
      this._scorchMesh.setMatrixAt(i, _mxm);
      this._scorchMesh.instanceColor.setXYZ(i, 1, 1, 1);
    }
    this._scorchMesh.instanceMatrix.needsUpdate = true;

    this._scorch = {
      life: new Float32Array(MAX_SCORCH),
      maxLife: new Float32Array(MAX_SCORCH),
      head: 0,
      live: 0,
    };
    this._disposables.push(tex, geo, this._scorchMat);
  }

  _buildWavePool(renderer) {
    const tex = finish(buildRingTexture(), renderer, true);
    this._waveMat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
      opacity: 1,
    });
    const geo = new THREE.PlaneGeometry(1, 1);
    this._waveMesh = new THREE.InstancedMesh(geo, this._waveMat, MAX_WAVES);
    this._waveMesh.name = 'projectile:shockwave';
    this._waveMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._waveMesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_WAVES * 3), 3
    );
    this._waveMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this._waveMesh.frustumCulled = false;
    this._waveMesh.renderOrder = 7;
    this.scene.add(this._waveMesh);

    _mxm.makeScale(0, 0, 0);
    for (let i = 0; i < MAX_WAVES; i++) this._waveMesh.setMatrixAt(i, _mxm);
    this._waveMesh.instanceMatrix.needsUpdate = true;

    this._waves = {
      t: new Float32Array(MAX_WAVES),
      dur: new Float32Array(MAX_WAVES),
      size: new Float32Array(MAX_WAVES),
      pos: new Float32Array(MAX_WAVES * 3),
      quat: new Float32Array(MAX_WAVES * 4),
      head: 0,
    };
    this._disposables.push(tex, geo, this._waveMat);
  }

  /**
   * Three pooled point lights: two ride live fireballs, one is reserved for the
   * detonation flash. Added once and never hidden - flipping a light's
   * `visible` flag changes the renderer's light count and rebuilds every
   * program in the scene.
   */
  _buildLightPool() {
    this._lights = [];
    for (let i = 0; i < 3; i++) {
      const l = new THREE.PointLight(0xff7a22, 0, 22, 2);
      l.castShadow = false;
      l.position.set(0, -1000, 0);
      this.scene.add(l);
      this._lights.push({ light: l, owner: -1, flash: 0, flashDur: 1, peak: 0 });
    }
  }

  /* ================================================================ */
  /* Spawning                                                          */
  /* ================================================================ */

  /**
   * Launch a projectile.
   *
   * @param {{kind:'fireball'|'arrow', origin:THREE.Vector3, direction:THREE.Vector3,
   *          speed:number, damage:number, gravity?:number, radius?:number,
   *          aoe?:number, owner?:any, life?:number, scale?:number}} opts
   * @returns {number} pool slot, or -1 if the pool is saturated
   */
  spawn(opts) {
    const p = this._p;
    let slot = -1;
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      if (p.active[i] === 0) { slot = i; break; }
    }
    // Saturated: recycle the oldest rather than silently dropping the shot.
    if (slot < 0) {
      let oldest = 0;
      for (let i = 1; i < MAX_PROJECTILES; i++) if (p.age[i] > p.age[oldest]) oldest = i;
      this._release(oldest);
      slot = oldest;
    }

    const kind = opts.kind === 'arrow' ? KIND_ARROW : KIND_FIREBALL;
    const o = opts.origin;
    const d = opts.direction;
    const speed = opts.speed ?? 40;

    p.px[slot] = o.x; p.py[slot] = o.y; p.pz[slot] = o.z;
    p.vx[slot] = d.x * speed; p.vy[slot] = d.y * speed; p.vz[slot] = d.z * speed;
    p.grav[slot] = opts.gravity ?? 0;
    p.damage[slot] = opts.damage ?? 30;
    p.radius[slot] = opts.radius ?? (kind === KIND_ARROW ? 0.05 : 0.28);
    p.aoe[slot] = opts.aoe ?? 0;
    p.maxLife[slot] = opts.life ?? (kind === KIND_ARROW ? 6 : 5);
    p.life[slot] = p.maxLife[slot];
    p.age[slot] = 0;
    p.trail[slot] = 0;
    p.spin[slot] = Math.random() * TAU;
    p.scale[slot] = opts.scale ?? 1;
    p.kind[slot] = kind;
    p.active[slot] = 1;
    p.light[slot] = -1;
    this._activeCount++;

    if (kind === KIND_FIREBALL) {
      this._claimLight(slot);
      this._muzzleBloom(o, d);
    }
    return slot;
  }

  /** Attach a travelling light to a fireball if one is free. */
  _claimLight(slot) {
    for (let i = 0; i < this._lights.length; i++) {
      const L = this._lights[i];
      if (L.owner < 0 && L.flash <= 0) {
        L.owner = slot;
        this._p.light[slot] = i;
        return;
      }
    }
  }

  /** A short bloom of flame at the launch point so the shot has a departure. */
  _muzzleBloom(origin, dir) {
    for (let i = 0; i < 8; i++) {
      const sp = rand(1.5, 5);
      _em1.set(dir.x, dir.y, dir.z);
      _em2.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize();
      _em3.copy(_em1).addScaledVector(_em2, 0.55).normalize();
      this.sparks.emit(
        origin.x, origin.y, origin.z,
        _em3.x * sp, _em3.y * sp, _em3.z * sp,
        0.16, 0.42,
        2.6, 1.15, 0.32, 0.7, 0.09, 0.01,
        rand(0.16, 0.34), 1, -1.5, 3.2, 0.95, 1.4, rand(-4, 4)
      );
    }
  }

  /* ================================================================ */
  /* Simulation                                                        */
  /* ================================================================ */

  /**
   * Integrate every live projectile and resolve its swept segment.
   * @param {number} dt fixed timestep seconds
   */
  fixedUpdate(dt) {
    if (this._activeCount === 0) return;
    const p = this._p;

    for (let i = 0; i < MAX_PROJECTILES; i++) {
      if (p.active[i] === 0) continue;

      p.age[i] += dt;
      p.life[i] -= dt;
      if (p.life[i] <= 0) {
        // Fireballs always detonate; a spent arrow simply drops out of the world.
        if (p.kind[i] === KIND_FIREBALL) {
          _sw1.set(p.px[i], p.py[i], p.pz[i]);
          _sw2.set(0, 1, 0);
          // Airburst: no surface, so no scorch mark.
          this._explode(i, _sw1, _sw2, null, false);
        }
        this._release(i);
        continue;
      }

      // Semi-implicit Euler: gravity first, so the step uses the end velocity.
      p.vy[i] += p.grav[i] * dt;
      _sw1.set(p.px[i], p.py[i], p.pz[i]);            // segment start
      _sw2.set(p.vx[i] * dt, p.vy[i] * dt, p.vz[i] * dt); // step
      const segLen = _sw2.length();
      if (segLen < 1e-6) continue;
      _sw3.copy(_sw2).multiplyScalar(1 / segLen);      // unit direction

      // Extend the cast by the projectile's own radius so a fat fireball
      // detonates on contact rather than after its centre is inside the wall.
      const reach = segLen + p.radius[i];

      let npcHit = null;
      try {
        npcHit = this.npcManager?.raycastNPCs?.(_sw1, _sw3, reach) ?? null;
      } catch (err) {
        npcHit = null;
      }
      const npcDist = npcHit
        ? (Number.isFinite(npcHit.distance) ? npcHit.distance : _sw1.distanceTo(npcHit.point))
        : Infinity;

      const worldHit = this.physics.raycast(
        _sw1, _sw3, Math.min(reach, npcDist), COLLISION_LAYER.WORLD
      );

      if (worldHit) {
        _sw4.copy(worldHit.point).addScaledVector(worldHit.normal, 0.012);
        _sw5.copy(worldHit.normal);
        this._impact(i, _sw4, _sw5, null, _sw3, worldHit.collider);
        continue;
      }
      if (npcHit) {
        _sw4.copy(npcHit.point ?? _sw1);
        // NPC casts report no surface normal, so face the effect back down the
        // incoming path - which is where the player is standing.
        _sw5.copy(_sw3).negate();
        this._impact(i, _sw4, _sw5, npcHit, _sw3, null);
        continue;
      }

      p.px[i] += _sw2.x;
      p.py[i] += _sw2.y;
      p.pz[i] += _sw2.z;
    }
  }

  /** Resolve a confirmed hit for slot `i`. */
  _impact(i, point, normal, npcHit, travelDir, collider) {
    const p = this._p;
    if (p.kind[i] === KIND_FIREBALL) {
      this._explode(i, point, normal, npcHit, npcHit === null);
    } else {
      this._arrowHit(i, point, normal, npcHit, travelDir, collider);
    }
    this._release(i);
  }

  /* ---------------- fireball ---------------- */

  _explode(i, point, normal, npcHit, onSurface) {
    const p = this._p;
    const damage = p.damage[i];
    const aoe = Math.max(1.2, p.aoe[i]);
    const weaponId = 'fireball';

    let directNPC = npcHit?.npc ?? null;
    let dealt = 0;

    // Direct hit lands full damage and can headshot; everything else in the
    // blast takes a falloff share. `_hitThisBlast` prevents the direct target
    // being damaged twice by its own explosion.
    if (directNPC && !directNPC.isDead) {
      const dmg = damage * (npcHit.isHeadshot ? 1.35 : 1);
      const res = this.combat?.applyNPCDamage?.(directNPC, dmg, {
        isHeadshot: !!npcHit.isHeadshot,
        sourcePosition: point,
        weaponId,
        byPlayer: true,
      });
      dealt = dmg;
      this.bus.emit('combat:hitmarker', {
        isHeadshot: !!npcHit.isHeadshot,
        isKill: res?.killed === true,
        damage: dmg,
        point: point.clone(),
      });
    }

    const npcs = this.npcManager?.npcs ?? [];
    for (let n = 0; n < npcs.length; n++) {
      const npc = npcs[n];
      if (!npc || npc.isDead || npc === directNPC) continue;
      _ex1.copy(npc.position);
      _ex1.y += (npc.height ?? 1.8) * 0.5;
      const dist = _ex1.distanceTo(point);
      if (dist > aoe) continue;
      // Quadratic falloff with a 35% floor at the rim: a linear curve makes the
      // edge of the blast feel like a whiff, and no falloff makes splash damage
      // strictly better than aiming.
      const t = 1 - dist / aoe;
      const dmg = damage * (0.35 + 0.65 * t * t);
      const res = this.combat?.applyNPCDamage?.(npc, dmg, {
        isHeadshot: false,
        sourcePosition: point,
        weaponId,
        byPlayer: true,
      });
      if (res?.applied > 0) dealt += dmg;
    }

    // The player is not immune to their own blast, but it is heavily reduced so
    // a close-quarters fireball is a mistake rather than a suicide.
    const player = this.player;
    if (player && !player.isDead) {
      _ex2.copy(player.position);
      _ex2.y += 0.9;
      const pd = _ex2.distanceTo(point);
      if (pd < aoe) {
        const t = 1 - pd / aoe;
        player.applyDamage?.(damage * 0.22 * t * t, point, 'self');
      }
      const near = Math.max(0, 1 - pd / (aoe * 4));
      if (near > 0) {
        this.bus.emit('camera:shake', { amount: 0.12 + near * 0.55, duration: 0.42 });
      }
    }

    this._explosionVFX(point, normal, aoe);
    this._flashLight(point, aoe);
    if (onSurface) this._stampScorch(point, normal, aoe);

    this.bus.emit('projectile:hit', {
      kind: 'fireball',
      point: point.clone(),
      normal: (normal?.clone?.() ?? new THREE.Vector3(0, 1, 0)),
      npc: directNPC,
      damage: dealt,
    });
  }

  /** Fireball, embers, smoke column and shockwave ring. */
  _explosionVFX(point, normal, aoe) {
    const s = Math.min(2.2, aoe / 3.2);

    // Core flash: a few very bright, very short-lived lobes.
    for (let i = 0; i < 5; i++) {
      this.sparks.emit(
        point.x + rand(-0.2, 0.2) * s, point.y + rand(-0.2, 0.2) * s, point.z + rand(-0.2, 0.2) * s,
        0, 0, 0,
        1.6 * s, 3.4 * s,
        4.2, 2.6, 1.4, 1.8, 0.35, 0.05,
        rand(0.1, 0.2), 0, 0, 4, 1, 1.1, rand(-2, 2)
      );
    }

    // Rolling flame lobes climbing out of the blast.
    for (let i = 0; i < 26; i++) {
      _em1.set(rand(-1, 1), rand(-0.35, 1), rand(-1, 1)).normalize();
      _em1.addScaledVector(normal, 0.5).normalize();
      const sp = rand(2.5, 11) * s;
      this.sparks.emit(
        point.x, point.y, point.z,
        _em1.x * sp, _em1.y * sp + 1.4, _em1.z * sp,
        0.5 * s, 1.5 * s,
        3.0, 1.35, 0.35, 0.55, 0.06, 0.01,
        rand(0.3, 0.62), 1, 1.4, 2.6, 0.9, 1.5, rand(-3, 3)
      );
    }

    // Embers: fast, thin, and they arc down under gravity.
    for (let i = 0; i < 34; i++) {
      _em2.set(rand(-1, 1), rand(-0.2, 1), rand(-1, 1)).normalize();
      const sp = rand(5, 20) * s;
      this.sparks.emit(
        point.x, point.y, point.z,
        _em2.x * sp, _em2.y * sp + rand(1, 5), _em2.z * sp,
        0.075 * s, 0.014,
        3.4, 1.5, 0.4, 1.2, 0.14, 0.02,
        rand(0.55, 1.5), 2, -9.5, 0.7, 1, 1.7, rand(-8, 8)
      );
    }

    // Smoke: slow, dark, lingering - this is what sells the scale afterwards.
    for (let i = 0; i < 16; i++) {
      _em3.set(rand(-1, 1), rand(0, 1), rand(-1, 1)).normalize();
      const sp = rand(1, 5) * s;
      this.smoke.emit(
        point.x, point.y, point.z,
        _em3.x * sp, _em3.y * sp + 1.1, _em3.z * sp,
        0.5 * s, 3.2 * s,
        0.30, 0.21, 0.18, 0.12, 0.11, 0.11,
        rand(1.2, 2.6), 3, 0.5, 1.3, 0.5, 1.2, rand(-0.9, 0.9)
      );
    }

    // Ground-hugging dust ring where the blast meets the surface.
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU + rand(-0.2, 0.2);
      _em1.set(Math.cos(a), 0, Math.sin(a));
      // Project into the surface plane so the ring hugs walls as well as floors.
      _em1.addScaledVector(normal, -_em1.dot(normal)).normalize();
      const sp = rand(4, 9) * s;
      this.smoke.emit(
        point.x + normal.x * 0.1, point.y + normal.y * 0.1, point.z + normal.z * 0.1,
        _em1.x * sp, _em1.y * sp, _em1.z * sp,
        0.4 * s, 2.4 * s,
        0.46, 0.4, 0.35, 0.3, 0.27, 0.25,
        rand(0.7, 1.4), 3, 0.3, 2.6, 0.4, 1.5, rand(-1, 1)
      );
    }

    this._spawnWave(point, normal, aoe);
  }

  _spawnWave(point, normal, aoe) {
    const w = this._waves;
    const i = w.head;
    w.head = (w.head + 1) % MAX_WAVES;
    // Lie the ring in the surface plane; a wave that intersects the wall it came
    // off looks like a bug, not a shockwave.
    _or1.copy(normal);
    if (!Number.isFinite(_or1.x) || _or1.lengthSq() < 1e-6) _or1.set(0, 1, 0);
    _orq.setFromUnitVectors(FWD_Z, _or1);
    w.pos[i * 3] = point.x + _or1.x * 0.06;
    w.pos[i * 3 + 1] = point.y + _or1.y * 0.06;
    w.pos[i * 3 + 2] = point.z + _or1.z * 0.06;
    w.quat[i * 4] = _orq.x;
    w.quat[i * 4 + 1] = _orq.y;
    w.quat[i * 4 + 2] = _orq.z;
    w.quat[i * 4 + 3] = _orq.w;
    w.dur[i] = 0.42;
    w.t[i] = w.dur[i];
    w.size[i] = aoe * 2.4;
  }

  _stampScorch(point, normal, aoe) {
    const s = this._scorch;
    const i = s.head;
    s.head = (s.head + 1) % MAX_SCORCH;
    if (s.life[i] <= 0) s.live++;

    _or1.copy(normal);
    _orq.setFromUnitVectors(FWD_Z, _or1);
    // A random roll about the normal keeps repeated hits on one wall from
    // reading as a stamped pattern.
    _mxq.setFromAxisAngle(_or1, Math.random() * TAU);
    _orq.premultiply(_mxq);

    const size = Math.min(6.5, aoe * 1.5) * rand(0.9, 1.15);
    // Staggered lift: identical offsets on overlapping decals z-fight.
    _mx1.copy(point).addScaledVector(_or1, 0.016 + (i % 6) * 0.0015);
    _mx2.set(size, size, size);
    _orm.compose(_mx1, _orq, _mx2);
    this._scorchMesh.setMatrixAt(i, _orm);
    this._scorchMesh.instanceColor.setXYZ(i, 1, 1, 1);

    s.maxLife[i] = 26;
    s.life[i] = s.maxLife[i];
    this._scorchMesh.instanceMatrix.needsUpdate = true;
    this._scorchMesh.instanceColor.needsUpdate = true;
  }

  _flashLight(point, aoe) {
    // Prefer a light that is not currently riding a fireball.
    let best = this._lights[0];
    for (const L of this._lights) {
      if (L.owner < 0 && L.flash <= 0) { best = L; break; }
      if (L.flash < best.flash) best = L;
    }
    if (best.owner >= 0) {
      this._p.light[best.owner] = -1;
      best.owner = -1;
    }
    best.light.position.copy(point);
    best.light.color.setRGB(1, 0.55, 0.2);
    best.light.distance = Math.max(14, aoe * 5);
    best.peak = 26 + aoe * 7;
    best.flashDur = 0.5;
    best.flash = best.flashDur;
    best.light.intensity = best.peak;
  }

  /* ---------------- arrow ---------------- */

  _arrowHit(i, point, normal, npcHit, travelDir, collider) {
    const p = this._p;
    const damage = p.damage[i];
    const npc = npcHit?.npc ?? null;

    if (npc && !npc.isDead) {
      const isHeadshot = npcHit.isHeadshot === true;
      // Bows reward precision harder than the machine gun does.
      const dmg = damage * (isHeadshot ? 2.6 : 1);
      const res = this.combat?.applyNPCDamage?.(npc, dmg, {
        isHeadshot,
        sourcePosition: point,
        weaponId: 'bow',
        byPlayer: true,
      });
      this.combat?.vfx?.bloodImpact?.(point, normal, travelDir);
      this.bus.emit('combat:hitmarker', {
        isHeadshot,
        isKill: res?.killed === true,
        damage: dmg,
        point: point.clone(),
      });
      this.bus.emit('projectile:hit', {
        kind: 'arrow',
        point: point.clone(),
        normal: normal.clone(),
        npc,
        damage: dmg,
      });
      return;
    }

    // Stuck in the world: surface debris, a puff, and the shaft left standing
    // proud of the wall at the angle it arrived.
    this._stickArrow(i, point, travelDir);
    // Combat owns surface classification and the shared VFX pools, so the
    // debris an arrow kicks up matches what a bullet would have kicked up.
    this.combat?.impactFX?.(point, normal, collider, 0.55, false);
    for (let k = 0; k < 4; k++) {
      _em1.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize();
      const sp = rand(0.6, 2.4);
      this.smoke.emit(
        point.x, point.y, point.z,
        _em1.x * sp, _em1.y * sp + 0.4, _em1.z * sp,
        0.05, 0.28,
        0.62, 0.58, 0.52, 0.4, 0.38, 0.35,
        rand(0.4, 0.8), 3, 0.2, 3, 0.35, 1.6, rand(-1, 1)
      );
    }

    this.bus.emit('projectile:hit', {
      kind: 'arrow',
      point: point.clone(),
      normal: normal.clone(),
      npc: null,
      damage: 0,
    });
  }

  /** Park the arrow's transform in the persistent stuck-arrow batch. */
  _stickArrow(i, point, travelDir) {
    const st = this._stuck;
    const slot = st.head;
    st.head = (st.head + 1) % MAX_STUCK;
    if (st.life[slot] <= 0) st.live++;

    // Push the head into the surface so the shaft protrudes rather than
    // balancing on the skin of the wall.
    _mx1.copy(point).addScaledVector(travelDir, 0.14);
    _mxq.setFromUnitVectors(FWD_Z, travelDir);
    _mx2.set(1, 1, 1);
    _mxm.compose(_mx1, _mxq, _mx2);
    _mxm.toArray(st.mat, slot * 16);
    this._stuckMesh.setMatrixAt(slot, _mxm);
    this._stuckMesh.instanceMatrix.needsUpdate = true;

    st.maxLife[slot] = 22;
    st.life[slot] = st.maxLife[slot];
    this._p.spin[i] = 0;
  }

  _release(i) {
    const p = this._p;
    if (p.active[i] === 0) return;
    p.active[i] = 0;
    this._activeCount = Math.max(0, this._activeCount - 1);
    const li = p.light[i];
    if (li >= 0) {
      const L = this._lights[li];
      if (L.owner === i) {
        L.owner = -1;
        if (L.flash <= 0) L.light.intensity = 0;
      }
      p.light[i] = -1;
    }
  }

  /* ================================================================ */
  /* Per-frame                                                         */
  /* ================================================================ */

  /** @param {number} dt frame seconds */
  update(dt, elapsed) {
    this._updateProjectileVisuals(dt, elapsed);
    this._updateStuck(dt);
    this._updateScorch(dt);
    this._updateWaves(dt);
    this._updateLights(dt);
    this.sparks.update(dt);
    this.smoke.update(dt);
  }

  _updateProjectileVisuals(dt, elapsed) {
    const p = this._p;
    let cores = 0;
    let arrows = 0;

    for (let i = 0; i < MAX_PROJECTILES; i++) {
      if (p.active[i] === 0) continue;
      const x = p.px[i], y = p.py[i], z = p.pz[i];

      if (p.kind[i] === KIND_FIREBALL) {
        const sc = p.scale[i];
        // Breathe the core so it reads as burning rather than as a lit sphere.
        const pulse = 1 + Math.sin(elapsed * 26 + p.spin[i]) * 0.13;
        _mx1.set(x, y, z);
        _mxq.setFromAxisAngle(UP, elapsed * 3 + p.spin[i]);
        _mx2.setScalar(0.17 * sc * pulse);
        _mxm.compose(_mx1, _mxq, _mx2);
        this._coreMesh.setMatrixAt(cores, _mxm);
        _mxq.setFromAxisAngle(SIDE, -elapsed * 4.4 + p.spin[i]);
        _mx2.setScalar(0.34 * sc * (1.05 + Math.sin(elapsed * 17 + p.spin[i]) * 0.11));
        _mxm.compose(_mx1, _mxq, _mx2);
        this._shellMesh.setMatrixAt(cores, _mxm);
        cores++;

        const li = p.light[i];
        if (li >= 0) {
          const L = this._lights[li];
          if (L.owner === i && L.flash <= 0) {
            L.light.position.set(x, y, z);
            L.light.color.setRGB(1, 0.48, 0.16);
            L.light.distance = 16 * sc;
            L.light.intensity = (11 + Math.sin(elapsed * 22) * 2) * sc;
          }
        }

        // Trail on a distance accumulator, not a frame counter: the ribbon then
        // has the same density at 40 fps and at 144.
        p.trail[i] += Math.hypot(p.vx[i], p.vy[i], p.vz[i]) * dt;
        while (p.trail[i] > 0.28) {
          p.trail[i] -= 0.28;
          this._emitTrail(x, y, z, sc);
        }
      } else {
        // Rotate to face travel. `setFromUnitVectors` is exact and cheaper than
        // building a lookAt matrix, and the arrow model points along -Z... which
        // is why the direction is negated here.
        _em1.set(p.vx[i], p.vy[i], p.vz[i]);
        const sp = _em1.length();
        if (sp > 1e-4) _em1.multiplyScalar(1 / sp);
        else _em1.set(0, 0, -1);
        _mx1.set(x, y, z);
        _mxq.setFromUnitVectors(FWD_Z, _em1);
        _mx2.set(1, 1, 1);
        _mxm.compose(_mx1, _mxq, _mx2);
        this._arrowMesh.setMatrixAt(arrows, _mxm);
        arrows++;
      }
    }

    this._coreMesh.count = cores;
    this._shellMesh.count = cores;
    this._arrowMesh.count = arrows;
    if (cores > 0) {
      this._coreMesh.instanceMatrix.needsUpdate = true;
      this._shellMesh.instanceMatrix.needsUpdate = true;
    }
    if (arrows > 0) this._arrowMesh.instanceMatrix.needsUpdate = true;
  }

  _emitTrail(x, y, z, sc) {
    // Flame lobe.
    this.sparks.emit(
      x + rand(-0.06, 0.06), y + rand(-0.06, 0.06), z + rand(-0.06, 0.06),
      rand(-0.5, 0.5), rand(0.3, 1.5), rand(-0.5, 0.5),
      0.42 * sc, 0.9 * sc,
      3.0, 1.3, 0.34, 0.5, 0.05, 0.01,
      rand(0.22, 0.42), 1, 0.9, 2.4, 0.85, 1.5, rand(-3, 3)
    );
    // Aura: very short life, sits exactly on the core.
    this.sparks.emit(
      x, y, z, 0, 0, 0,
      1.05 * sc, 0.62 * sc,
      1.9, 0.72, 0.2, 1.0, 0.22, 0.04,
      0.09, 0, 0, 0, 0.6, 1, 0
    );
    // Occasional ember shedding off the back.
    if (Math.random() < 0.55) {
      this.sparks.emit(
        x, y, z,
        rand(-1.4, 1.4), rand(-0.4, 1.4), rand(-1.4, 1.4),
        0.05, 0.008,
        3.2, 1.4, 0.35, 1.1, 0.12, 0.02,
        rand(0.35, 0.85), 2, -7, 1.1, 1, 1.6, rand(-6, 6)
      );
    }
    // Thin smoke wake.
    if (Math.random() < 0.5) {
      this.smoke.emit(
        x, y, z,
        rand(-0.3, 0.3), rand(0.2, 0.9), rand(-0.3, 0.3),
        0.22 * sc, 1.1 * sc,
        0.34, 0.28, 0.25, 0.2, 0.18, 0.17,
        rand(0.6, 1.2), 3, 0.35, 1.6, 0.24, 1.4, rand(-1, 1)
      );
    }
  }

  _updateStuck(dt) {
    const st = this._stuck;
    if (st.live === 0) return;
    let live = 0;
    for (let i = 0; i < MAX_STUCK; i++) {
      if (st.life[i] <= 0) continue;
      st.life[i] -= dt;
      if (st.life[i] <= 0) {
        _mxm.makeScale(0, 0, 0);
        this._stuckMesh.setMatrixAt(i, _mxm);
        this._stuckMesh.instanceMatrix.needsUpdate = true;
        continue;
      }
      live++;
      // Shrink into the wall over the last two seconds rather than blinking out.
      const k = Math.min(1, st.life[i] / 2);
      if (k < 1) {
        _mxm.fromArray(st.mat, i * 16);
        _mxm.decompose(_mx1, _mxq, _mx2);
        _mx2.setScalar(k);
        _mxm.compose(_mx1, _mxq, _mx2);
        this._stuckMesh.setMatrixAt(i, _mxm);
        this._stuckMesh.instanceMatrix.needsUpdate = true;
      }
    }
    st.live = live;
  }

  _updateScorch(dt) {
    const s = this._scorch;
    if (s.live === 0) return;
    let live = 0;
    for (let i = 0; i < MAX_SCORCH; i++) {
      if (s.life[i] <= 0) continue;
      s.life[i] -= dt;
      if (s.life[i] <= 0) {
        _mxm.makeScale(0, 0, 0);
        this._scorchMesh.setMatrixAt(i, _mxm);
        this._scorchMesh.instanceMatrix.needsUpdate = true;
        continue;
      }
      live++;
      // Fade through instanceColor: the material is shared, so per-instance
      // opacity has to travel on the only per-instance channel available.
      const k = Math.min(1, s.life[i] / (s.maxLife[i] * 0.35));
      this._scorchMesh.instanceColor.setXYZ(i, k, k, k);
    }
    s.live = live;
    this._scorchMesh.instanceColor.needsUpdate = true;
  }

  _updateWaves(dt) {
    const w = this._waves;
    let any = false;
    for (let i = 0; i < MAX_WAVES; i++) {
      if (w.t[i] <= 0) continue;
      any = true;
      w.t[i] -= dt;
      const u = 1 - Math.max(0, w.t[i]) / w.dur[i];
      // Ease-out expansion; a linear ring reads as a growing circle, not a blast.
      const e = 1 - Math.pow(1 - u, 2.4);
      const size = w.size[i] * (0.18 + e * 1.0);
      _mx1.set(w.pos[i * 3], w.pos[i * 3 + 1], w.pos[i * 3 + 2]);
      _mxq.set(w.quat[i * 4], w.quat[i * 4 + 1], w.quat[i * 4 + 2], w.quat[i * 4 + 3]);
      _mx2.set(size, size, size);
      _mxm.compose(_mx1, _mxq, _mx2);
      this._waveMesh.setMatrixAt(i, _mxm);
      const a = Math.pow(1 - u, 1.6);
      this._waveMesh.instanceColor.setXYZ(i, a * 1.6, a * 0.75, a * 0.3);
      if (w.t[i] <= 0) {
        _mxm.makeScale(0, 0, 0);
        this._waveMesh.setMatrixAt(i, _mxm);
      }
    }
    if (any) {
      this._waveMesh.instanceMatrix.needsUpdate = true;
      this._waveMesh.instanceColor.needsUpdate = true;
    }
  }

  _updateLights(dt) {
    for (const L of this._lights) {
      if (L.flash > 0) {
        L.flash -= dt;
        if (L.flash <= 0) {
          L.flash = 0;
          L.light.intensity = 0;
        } else {
          const k = L.flash / L.flashDur;
          L.light.intensity = L.peak * k * k;
        }
      } else if (L.owner < 0 && L.light.intensity !== 0) {
        L.light.intensity = 0;
      }
    }
  }

  /* ================================================================ */

  /** Drop everything in flight and every mark left behind. */
  clear() {
    for (let i = 0; i < MAX_PROJECTILES; i++) this._release(i);
    this._activeCount = 0;
    this._coreMesh.count = 0;
    this._shellMesh.count = 0;
    this._arrowMesh.count = 0;

    _mxm.makeScale(0, 0, 0);
    for (let i = 0; i < MAX_STUCK; i++) {
      this._stuck.life[i] = 0;
      this._stuckMesh.setMatrixAt(i, _mxm);
    }
    this._stuck.live = 0;
    this._stuckMesh.instanceMatrix.needsUpdate = true;

    for (let i = 0; i < MAX_SCORCH; i++) {
      this._scorch.life[i] = 0;
      this._scorchMesh.setMatrixAt(i, _mxm);
    }
    this._scorch.live = 0;
    this._scorchMesh.instanceMatrix.needsUpdate = true;

    for (let i = 0; i < MAX_WAVES; i++) {
      this._waves.t[i] = 0;
      this._waveMesh.setMatrixAt(i, _mxm);
    }
    this._waveMesh.instanceMatrix.needsUpdate = true;

    for (const L of this._lights) {
      L.owner = -1;
      L.flash = 0;
      L.light.intensity = 0;
    }
    this.sparks.clear();
    this.smoke.clear();
  }

  /** @returns {number} projectiles currently in flight */
  get activeCount() {
    return this._activeCount;
  }

  dispose() {
    for (const off of this._offs) off();
    this._offs.length = 0;
    this.sparks.dispose();
    this.smoke.dispose();
    for (const m of [
      this._coreMesh, this._shellMesh, this._arrowMesh,
      this._stuckMesh, this._scorchMesh, this._waveMesh,
    ]) {
      m.removeFromParent();
      m.dispose();
    }
    for (const L of this._lights) L.light.removeFromParent();
    for (const d of this._disposables) d?.dispose?.();
    this._disposables.length = 0;
  }
}
