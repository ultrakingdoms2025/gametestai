import * as THREE from 'three';

/**
 * Combat visual effects: tracers, impact bursts, smoke and light pulses.
 *
 * Everything here is pooled. Three instanced quad systems (additive sparks,
 * alpha-blended smoke, alpha-blended debris) cover every effect the game needs,
 * which means the entire combat VFX budget is **three draw calls** and zero
 * allocations once constructed - important, because the machine gun fires 12
 * rounds a second and each one spawns 20-30 particles.
 *
 * Billboarding happens in the vertex shader rather than on the CPU. Particles
 * with `stretch > 0` are cylindrically billboarded around their velocity vector
 * (tracers, sparks); the rest are camera-facing with a per-particle roll.
 */

/* ------------------------------------------------------------------ */
/* Scratch - reused every emit, never reallocated.                     */
/* ------------------------------------------------------------------ */
const _bx = new THREE.Vector3();
const _by = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _alt = new THREE.Vector3(1, 0, 0);
const _pos = new THREE.Vector3();

const TAU = Math.PI * 2;

/** Orthonormal basis around `n`, written into the shared `_bx`/`_by`. */
function basis(n) {
  const ref = Math.abs(n.y) > 0.94 ? _alt : _up;
  _bx.crossVectors(ref, n).normalize();
  _by.crossVectors(n, _bx);
}

/**
 * Random direction inside a cone about `n`, written to `_dir`.
 * `spread` is the tangent of the half-angle; sampling is uniform in the disc
 * (sqrt of the radial random), not uniform in the radius - the naive version
 * clusters everything at the cone axis.
 */
function coneDir(n, spread) {
  basis(n);
  const r = Math.sqrt(Math.random()) * spread;
  const a = Math.random() * TAU;
  _dir.copy(n).addScaledVector(_bx, Math.cos(a) * r).addScaledVector(_by, Math.sin(a) * r);
  return _dir.normalize();
}

function rand(lo, hi) {
  return lo + Math.random() * (hi - lo);
}

/* ------------------------------------------------------------------ */
/* Procedural texture atlases                                          */
/* ------------------------------------------------------------------ */

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}

/** Additive atlas: 0 soft glow, 1 head-weighted streak, 2 hot point, 3 star flare. */
function buildSparkAtlas() {
  const S = 256;
  const H = S / 2;
  const cv = makeCanvas(S);
  const g = cv.getContext('2d');

  // 0 - soft glow
  let grad = g.createRadialGradient(H / 2, H / 2, 0, H / 2, H / 2, H / 2 - 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.65)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.16)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, H, H);

  // 1 - streak: an ellipse squashed on Y with the energy pushed toward +U so a
  //     tracer reads as a bright head dragging a tail.
  g.save();
  g.translate(H + H * 0.5, H * 0.5);
  g.scale(1, 0.14);
  grad = g.createRadialGradient(0, 0, 0, 0, 0, H * 0.48);
  grad.addColorStop(0, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.4)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(0, 0, H * 0.48, 0, TAU);
  g.fill();
  g.restore();
  g.save();
  g.globalCompositeOperation = 'lighter';
  grad = g.createRadialGradient(H + H * 0.86, H * 0.5, 0, H + H * 0.86, H * 0.5, H * 0.16);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(H, 0, H, H);
  g.restore();

  // 2 - hot point
  grad = g.createRadialGradient(H * 0.5, H + H * 0.5, 0, H * 0.5, H + H * 0.5, H * 0.42);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.12, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.36, 'rgba(255,255,255,0.22)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, H, H, H);

  // 3 - star flare
  const scx = H + H * 0.5;
  const scy = H + H * 0.5;
  grad = g.createRadialGradient(scx, scy, 0, scx, scy, H * 0.3);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.3, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(H, H, H, H);
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.translate(scx, scy);
  for (let i = 0; i < 6; i++) {
    g.rotate(TAU / 6);
    const spike = g.createLinearGradient(0, 0, H * 0.48, 0);
    spike.addColorStop(0, 'rgba(255,255,255,0.85)');
    spike.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = spike;
    g.beginPath();
    g.moveTo(0, -H * 0.035);
    g.lineTo(H * 0.48, 0);
    g.lineTo(0, H * 0.035);
    g.closePath();
    g.fill();
  }
  g.restore();

  return cv;
}

/** Alpha atlas: four soft turbulent puffs, greyscale so instance colour tints them. */
function buildSmokeAtlas() {
  const S = 256;
  const H = S / 2;
  const cv = makeCanvas(S);
  const g = cv.getContext('2d');
  const tmp = makeCanvas(H);
  const t = tmp.getContext('2d');

  for (let cell = 0; cell < 4; cell++) {
    t.clearRect(0, 0, H, H);
    t.globalCompositeOperation = 'lighter';
    // Stack many soft lobes to fake fbm turbulence without a noise texture.
    for (let i = 0; i < 46; i++) {
      const a = Math.random() * TAU;
      const d = Math.pow(Math.random(), 0.62) * H * 0.34;
      const x = H * 0.5 + Math.cos(a) * d;
      const y = H * 0.5 + Math.sin(a) * d;
      const r = H * (0.07 + Math.random() * 0.19);
      const grad = t.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, 'rgba(255,255,255,0.30)');
      grad.addColorStop(0.55, 'rgba(255,255,255,0.11)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      t.fillStyle = grad;
      t.beginPath();
      t.arc(x, y, r, 0, TAU);
      t.fill();
    }
    // Feather the silhouette so puffs never show a hard disc edge.
    t.globalCompositeOperation = 'destination-in';
    const mask = t.createRadialGradient(H * 0.5, H * 0.5, 0, H * 0.5, H * 0.5, H * 0.5);
    mask.addColorStop(0, 'rgba(255,255,255,1)');
    mask.addColorStop(0.55, 'rgba(255,255,255,0.92)');
    mask.addColorStop(1, 'rgba(255,255,255,0)');
    t.fillStyle = mask;
    t.fillRect(0, 0, H, H);
    t.globalCompositeOperation = 'source-over';

    g.drawImage(tmp, (cell & 1) * H, (cell >> 1) * H);
  }
  return cv;
}

/** Alpha atlas: 0 stone chip, 1 wood splinter, 2 metal shard, 3 droplet cluster. */
function buildDebrisAtlas() {
  const S = 256;
  const H = S / 2;
  const cv = makeCanvas(S);
  const g = cv.getContext('2d');

  const shard = (ox, oy, pts, light, dark, scaleY) => {
    g.save();
    g.translate(ox + H * 0.5, oy + H * 0.5);
    g.scale(1, scaleY);
    g.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const [x, y] = pts[i];
      if (i === 0) g.moveTo(x * H * 0.42, y * H * 0.42);
      else g.lineTo(x * H * 0.42, y * H * 0.42);
    }
    g.closePath();
    g.fillStyle = dark;
    g.fill();
    // Bright facet on one half sells the tumble as the quad rotates.
    g.save();
    g.clip();
    const grad = g.createLinearGradient(-H * 0.42, -H * 0.42, H * 0.42, H * 0.42);
    grad.addColorStop(0, light);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(-H, -H, H * 2, H * 2);
    g.restore();
    g.restore();
  };

  // 0 - angular stone chip
  shard(0, 0,
    [[-0.9, -0.35], [-0.2, -1.0], [0.75, -0.6], [1.0, 0.25], [0.15, 0.95], [-0.7, 0.6]],
    'rgba(255,255,255,0.95)', 'rgba(150,150,150,0.98)', 1);

  // 1 - wood splinter, long and thin
  shard(H, 0,
    [[-1.0, -0.16], [0.55, -0.28], [1.0, -0.05], [0.6, 0.22], [-0.95, 0.14]],
    'rgba(255,255,255,0.9)', 'rgba(138,138,138,0.98)', 0.55);

  // 2 - metal sliver, brighter and sharper
  shard(0, H,
    [[-1.0, -0.1], [0.1, -0.42], [1.0, -0.12], [0.45, 0.3], [-0.5, 0.36]],
    'rgba(255,255,255,1)', 'rgba(196,196,196,0.98)', 0.7);

  // 3 - droplet cluster (blood / water)
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU + 0.4;
    const d = i === 0 ? 0 : H * 0.2;
    const x = H + H * 0.5 + Math.cos(a) * d;
    const y = H + H * 0.5 + Math.sin(a) * d;
    const r = i === 0 ? H * 0.26 : H * (0.07 + Math.random() * 0.07);
    const grad = g.createRadialGradient(x - r * 0.3, y - r * 0.3, 0, x, y, r);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.65, 'rgba(190,190,190,0.98)');
    grad.addColorStop(1, 'rgba(120,120,120,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
  }

  return cv;
}

/* ------------------------------------------------------------------ */
/* Instanced quad particle system                                      */
/* ------------------------------------------------------------------ */

const PARTICLE_VERT = /* glsl */ `
attribute vec3 aPos;
attribute vec3 aDir;
attribute vec3 aColor;
attribute vec2 aCell;
attribute float aSize;
attribute float aOpacity;
attribute float aRot;
attribute float aStretch;

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
  vec3 offset;

  if ( aStretch > 0.001 ) {
    // Cylindrical billboard: hold the quad's U axis along the travel direction
    // and spin the V axis to face the camera. This is what makes a tracer look
    // like a streak of light rather than a flat card.
    vec3 axis = ( modelViewMatrix * vec4( aDir, 0.0 ) ).xyz;
    float al = length( axis );
    axis = al > 1e-5 ? axis / al : vec3( 1.0, 0.0, 0.0 );
    vec3 toCam = normalize( -centre );
    vec3 side = cross( axis, toCam );
    float sl = length( side );
    side = sl > 1e-4 ? side / sl : vec3( 0.0, 1.0, 0.0 );
    offset = axis * ( q.x * aStretch ) + side * q.y;
  } else {
    float c = cos( aRot );
    float s = sin( aRot );
    offset = vec3( q.x * c - q.y * s, q.x * s + q.y * c, 0.0 );
  }

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
      // Additive light does not "become" fog colour with distance - it just
      // gets swallowed by the haze, so attenuate instead of mixing.
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

class QuadParticles {
  /**
   * @param {THREE.Scene} scene
   * @param {{capacity:number, texture:THREE.Texture, additive:boolean,
   *          intensity?:number, renderOrder?:number}} opts
   */
  constructor(scene, opts) {
    const n = (this.capacity = opts.capacity);
    this.scene = scene;
    this.count = 0;

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
        3
      )
    );
    geo.setAttribute(
      'uv',
      new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2)
    );
    geo.setIndex([0, 1, 2, 0, 2, 3]);

    const inst = (name, size) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(n * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, a);
      return a.array;
    };
    this._aPos = inst('aPos', 3);
    this._aDir = inst('aDir', 3);
    this._aColor = inst('aColor', 3);
    this._aCell = inst('aCell', 2);
    this._aSize = inst('aSize', 1);
    this._aOpacity = inst('aOpacity', 1);
    this._aRot = inst('aRot', 1);
    this._aStretch = inst('aStretch', 1);
    this._attrs = [
      geo.getAttribute('aPos'), geo.getAttribute('aDir'), geo.getAttribute('aColor'),
      geo.getAttribute('aCell'), geo.getAttribute('aSize'), geo.getAttribute('aOpacity'),
      geo.getAttribute('aRot'), geo.getAttribute('aStretch'),
    ];
    geo.instanceCount = 0;
    this.geometry = geo;

    const uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      { map: { value: null }, uIntensity: { value: opts.intensity ?? 1 } },
    ]);
    uniforms.map.value = opts.texture;

    this.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      defines: opts.additive ? { ADDITIVE_BLEND: '' } : {},
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
      fog: true,
      toneMapped: true,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false; // particles live anywhere; culling by a stale bbox pops
    this.mesh.renderOrder = opts.renderOrder ?? 3;
    this.mesh.matrixAutoUpdate = false;
    scene.add(this.mesh);

    /* Simulation state - one flat array per field, indexed by slot. */
    const f = () => new Float32Array(n);
    this.px = f(); this.py = f(); this.pz = f();
    this.vx = f(); this.vy = f(); this.vz = f();
    this.life = f(); this.maxLife = f();
    this.s0 = f(); this.s1 = f();
    this.c0r = f(); this.c0g = f(); this.c0b = f();
    this.c1r = f(); this.c1g = f(); this.c1b = f();
    this.op0 = f(); this.fadeIn = f(); this.fadePow = f();
    this.rot = f(); this.rotVel = f();
    this.grav = f(); this.drag = f(); this.stretch = f();
    this.cellU = f(); this.cellV = f();
    this.alive = new Uint8Array(n);

    // O(1) allocation: a stack of free slots, refilled as particles expire.
    this._free = new Int32Array(n);
    for (let i = 0; i < n; i++) this._free[i] = n - 1 - i;
    this._freeCount = n;
    this._cursor = 0;
  }

  /**
   * Spawn one particle. All parameters are primitives so the hot path never
   * builds an options object.
   *
   * @param {object} p preset (see PRESETS)
   * @param {number} sizeMul multiplier on both start and end size
   * @param {number} lifeOverride >0 forces an exact lifetime (used by tracers,
   *   which must expire exactly when they reach the impact point)
   */
  emit(p, px, py, pz, vx, vy, vz, tr, tg, tb, sizeMul, lifeOverride) {
    // Pop a free slot; if the pool is saturated, round-robin steal one. At these
    // spawn rates a full pool means the screen is already busy, so the theft is
    // invisible - and it keeps emit() O(1) with no allocation either way.
    let i;
    if (this._freeCount > 0) {
      i = this._free[--this._freeCount];
    } else {
      i = this._cursor;
      this._cursor = (i + 1) % this.capacity;
    }

    const life = lifeOverride > 0 ? lifeOverride : rand(p.life[0], p.life[1]);
    this.px[i] = px; this.py[i] = py; this.pz[i] = pz;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.s0[i] = rand(p.size[0], p.size[1]) * sizeMul;
    this.s1[i] = rand(p.size[2], p.size[3]) * sizeMul;
    this.c0r[i] = p.c0[0] * tr; this.c0g[i] = p.c0[1] * tg; this.c0b[i] = p.c0[2] * tb;
    this.c1r[i] = p.c1[0] * tr; this.c1g[i] = p.c1[1] * tg; this.c1b[i] = p.c1[2] * tb;
    this.op0[i] = rand(p.op[0], p.op[1]);
    this.fadeIn[i] = p.fadeIn;
    this.fadePow[i] = p.fadePow;
    this.rot[i] = Math.random() * TAU;
    this.rotVel[i] = rand(-p.rotVel, p.rotVel);
    this.grav[i] = p.grav;
    this.drag[i] = p.drag;
    this.stretch[i] = p.stretch[1] > 0 ? rand(p.stretch[0], p.stretch[1]) : 0;
    const cell = p.cells[(Math.random() * p.cells.length) | 0];
    this.cellU[i] = (cell & 1) * 0.5;
    this.cellV[i] = (cell >> 1) * 0.5;
    this.alive[i] = 1;
  }

  /** Integrate, then pack the survivors into a contiguous instance range. */
  update(dt) {
    let n = 0;
    const aP = this._aPos, aD = this._aDir, aC = this._aColor, aCell = this._aCell;
    const aS = this._aSize, aO = this._aOpacity, aR = this._aRot, aSt = this._aStretch;

    for (let i = 0; i < this.capacity; i++) {
      if (this.alive[i] === 0) continue;
      const life = (this.life[i] -= dt);
      if (life <= 0) {
        this.alive[i] = 0;
        if (this._freeCount < this.capacity) this._free[this._freeCount++] = i;
        continue;
      }

      // Exponential drag approximated linearly; clamped so a large dt spike can
      // never flip the velocity sign.
      const damp = Math.max(0, 1 - this.drag[i] * dt);
      this.vy[i] += this.grav[i] * dt;
      this.vx[i] *= damp; this.vy[i] *= damp; this.vz[i] *= damp;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      this.rot[i] += this.rotVel[i] * dt;

      const maxLife = this.maxLife[i];
      const k = life / maxLife;       // 1 at birth -> 0 at death
      const t = 1 - k;
      const age = maxLife - life;

      const j3 = n * 3;
      aP[j3] = this.px[i]; aP[j3 + 1] = this.py[i]; aP[j3 + 2] = this.pz[i];

      const sp = Math.hypot(this.vx[i], this.vy[i], this.vz[i]);
      if (sp > 1e-4) {
        const inv = 1 / sp;
        aD[j3] = this.vx[i] * inv; aD[j3 + 1] = this.vy[i] * inv; aD[j3 + 2] = this.vz[i] * inv;
      } else {
        aD[j3] = 0; aD[j3 + 1] = 1; aD[j3 + 2] = 0;
      }

      aC[j3] = this.c0r[i] + (this.c1r[i] - this.c0r[i]) * t;
      aC[j3 + 1] = this.c0g[i] + (this.c1g[i] - this.c0g[i]) * t;
      aC[j3 + 2] = this.c0b[i] + (this.c1b[i] - this.c0b[i]) * t;

      const j2 = n * 2;
      aCell[j2] = this.cellU[i];
      aCell[j2 + 1] = this.cellV[i];

      aS[n] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      const fin = this.fadeIn[i] > 0 ? Math.min(1, age / this.fadeIn[i]) : 1;
      aO[n] = this.op0[i] * fin * Math.pow(k, this.fadePow[i]);
      aR[n] = this.rot[i];
      aSt[n] = this.stretch[i];
      n++;
    }

    // Skip the upload entirely on quiet frames.
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
/* Effect presets - frozen at module scope, never allocated per shot.  */
/* ------------------------------------------------------------------ */

/** @typedef {{life:number[],size:number[],c0:number[],c1:number[],op:number[],
 *   fadeIn:number,fadePow:number,rotVel:number,grav:number,drag:number,
 *   stretch:number[],cells:number[]}} Preset */
const PRESETS = {
  /* --- additive --- */
  tracer: {
    life: [0.05, 0.05], size: [0.075, 0.095, 0.055, 0.07],
    c0: [1.0, 0.83, 0.42], c1: [1.0, 0.42, 0.10], op: [0.85, 1.0],
    fadeIn: 0.012, fadePow: 0.55, rotVel: 0, grav: 0, drag: 0,
    stretch: [62, 88], cells: [1],
  },
  sparkHot: {
    life: [0.22, 0.62], size: [0.030, 0.052, 0.005, 0.012],
    c0: [1.0, 0.94, 0.72], c1: [1.0, 0.20, 0.03], op: [0.9, 1.0],
    fadeIn: 0.0, fadePow: 1.35, rotVel: 0, grav: -15, drag: 1.5,
    stretch: [5, 20], cells: [1],
  },
  sparkGlass: {
    life: [0.18, 0.44], size: [0.020, 0.036, 0.004, 0.008],
    c0: [0.82, 0.96, 1.0], c1: [0.35, 0.6, 0.85], op: [0.7, 1.0],
    fadeIn: 0.0, fadePow: 1.5, rotVel: 0, grav: -17, drag: 1.2,
    stretch: [4, 14], cells: [1],
  },
  flash: {
    life: [0.055, 0.085], size: [0.34, 0.58, 0.04, 0.08],
    c0: [1.0, 0.88, 0.60], c1: [1.0, 0.55, 0.18], op: [0.85, 1.0],
    fadeIn: 0.0, fadePow: 0.9, rotVel: 0, grav: 0, drag: 6,
    stretch: [0, 0], cells: [3],
  },
  emberGlow: {
    life: [0.5, 1.1], size: [0.02, 0.035, 0.002, 0.006],
    c0: [1.0, 0.55, 0.16], c1: [0.5, 0.06, 0.01], op: [0.5, 0.8],
    fadeIn: 0.05, fadePow: 1.8, rotVel: 0, grav: -6, drag: 2.4,
    stretch: [2, 7], cells: [2],
  },

  /* --- smoke / dust (alpha) --- */
  dust: {
    life: [0.75, 1.55], size: [0.10, 0.20, 0.55, 0.95],
    c0: [0.80, 0.77, 0.72], c1: [0.62, 0.60, 0.57], op: [0.24, 0.44],
    fadeIn: 0.03, fadePow: 1.5, rotVel: 1.3, grav: -0.55, drag: 2.4,
    stretch: [0, 0], cells: [0, 1, 2, 3],
  },
  smokeWisp: {
    life: [0.9, 1.9], size: [0.07, 0.14, 0.42, 0.78],
    c0: [0.30, 0.30, 0.31], c1: [0.17, 0.17, 0.18], op: [0.24, 0.40],
    fadeIn: 0.05, fadePow: 1.3, rotVel: 0.9, grav: 0.55, drag: 1.7,
    stretch: [0, 0], cells: [0, 1, 2, 3],
  },
  muzzleSmoke: {
    life: [1.1, 2.2], size: [0.07, 0.13, 0.48, 0.90],
    c0: [0.56, 0.55, 0.53], c1: [0.34, 0.34, 0.34], op: [0.10, 0.20],
    fadeIn: 0.09, fadePow: 1.15, rotVel: 0.7, grav: 0.42, drag: 1.5,
    stretch: [0, 0], cells: [0, 1, 2, 3],
  },
  bloodMist: {
    life: [0.42, 0.9], size: [0.09, 0.17, 0.34, 0.62],
    c0: [0.52, 0.045, 0.05], c1: [0.20, 0.012, 0.016], op: [0.5, 0.82],
    fadeIn: 0.0, fadePow: 1.7, rotVel: 1.6, grav: -2.2, drag: 2.8,
    stretch: [0, 0], cells: [0, 1, 2, 3],
  },
  splash: {
    life: [0.4, 0.85], size: [0.08, 0.16, 0.40, 0.70],
    c0: [0.86, 0.92, 0.96], c1: [0.62, 0.72, 0.80], op: [0.35, 0.6],
    fadeIn: 0.0, fadePow: 1.5, rotVel: 1.1, grav: -3.5, drag: 2.2,
    stretch: [0, 0], cells: [0, 1, 2, 3],
  },

  /* --- debris (alpha) --- */
  chipStone: {
    life: [0.55, 1.25], size: [0.030, 0.060, 0.024, 0.048],
    c0: [0.72, 0.70, 0.66], c1: [0.56, 0.55, 0.52], op: [0.85, 1.0],
    fadeIn: 0.0, fadePow: 2.4, rotVel: 13, grav: -20, drag: 0.45,
    stretch: [0, 0], cells: [0],
  },
  chipWood: {
    life: [0.6, 1.4], size: [0.038, 0.075, 0.030, 0.060],
    c0: [0.74, 0.55, 0.33], c1: [0.50, 0.36, 0.21], op: [0.9, 1.0],
    fadeIn: 0.0, fadePow: 2.2, rotVel: 16, grav: -19, drag: 0.6,
    stretch: [0, 0], cells: [1],
  },
  chipMetal: {
    life: [0.45, 1.0], size: [0.024, 0.048, 0.018, 0.036],
    c0: [0.88, 0.90, 0.95], c1: [0.55, 0.57, 0.62], op: [0.85, 1.0],
    fadeIn: 0.0, fadePow: 2.4, rotVel: 18, grav: -20, drag: 0.5,
    stretch: [0, 0], cells: [2],
  },
  chipGlass: {
    life: [0.5, 1.1], size: [0.022, 0.044, 0.016, 0.032],
    c0: [0.80, 0.94, 1.0], c1: [0.50, 0.66, 0.78], op: [0.6, 0.9],
    fadeIn: 0.0, fadePow: 2.2, rotVel: 20, grav: -20, drag: 0.4,
    stretch: [0, 0], cells: [2],
  },
  bloodDrop: {
    life: [0.45, 0.95], size: [0.026, 0.055, 0.020, 0.042],
    c0: [0.46, 0.030, 0.036], c1: [0.26, 0.016, 0.020], op: [0.9, 1.0],
    fadeIn: 0.0, fadePow: 2.0, rotVel: 9, grav: -17, drag: 0.7,
    stretch: [0, 0], cells: [3],
  },
  clod: {
    life: [0.5, 1.1], size: [0.035, 0.070, 0.028, 0.055],
    c0: [0.55, 0.45, 0.33], c1: [0.38, 0.31, 0.23], op: [0.85, 1.0],
    fadeIn: 0.0, fadePow: 2.4, rotVel: 11, grav: -20, drag: 0.6,
    stretch: [0, 0], cells: [0],
  },
};

/* ------------------------------------------------------------------ */

export class VFX {
  /**
   * @param {{scene:THREE.Scene, engine:any, bus:any}} ctx
   */
  constructor({ scene, engine, bus }) {
    this.scene = scene;
    this.bus = bus;
    const renderer = engine?.renderer ?? null;
    const aniso = renderer?.capabilities?.getMaxAnisotropy?.() ?? 1;

    const tex = (canvas, srgb) => {
      const t = new THREE.CanvasTexture(canvas);
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = THREE.ClampToEdgeWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = true;
      t.anisotropy = aniso;
      t.needsUpdate = true;
      return t;
    };

    this._textures = [
      tex(buildSparkAtlas(), true),
      tex(buildSmokeAtlas(), true),
      tex(buildDebrisAtlas(), true),
    ];

    // Additive first so hot sparks read over smoke; renderOrder keeps the three
    // transparent passes deterministic instead of depending on centroid sorting.
    this.sparks = new QuadParticles(scene, {
      capacity: 512, texture: this._textures[0], additive: true, intensity: 2.4, renderOrder: 5,
    });
    this.smoke = new QuadParticles(scene, {
      capacity: 288, texture: this._textures[1], additive: false, intensity: 1.0, renderOrder: 3,
    });
    this.debris = new QuadParticles(scene, {
      capacity: 288, texture: this._textures[2], additive: false, intensity: 1.0, renderOrder: 4,
    });

    /**
     * Two pooled point lights give impacts real bounce light.
     *
     * They are added once, stay `visible`, and idle at zero intensity. Adding,
     * removing or hiding a light changes the renderer's light counts, which
     * invalidates and rebuilds *every* shader program in the scene - a hitch you
     * would feel on the first shot of every firefight. A zero-intensity light
     * costs a few ALU ops and nothing else.
     */
    this._lights = [];
    for (let i = 0; i < 2; i++) {
      const l = new THREE.PointLight(0xffb066, 0, 9, 2);
      l.castShadow = false;
      l.position.set(0, -1000, 0);
      scene.add(l);
      this._lights.push({ light: l, t: 0, dur: 1, peak: 0 });
    }
  }

  /* ---------------- public effects ---------------- */

  /**
   * A single tracer round travelling from `origin` toward `dir`.
   *
   * @param {THREE.Vector3} origin muzzle position
   * @param {THREE.Vector3} dir unit direction
   * @param {number} distance metres to the impact (or to the range limit)
   * @param {number} speed metres/second
   */
  tracer(origin, dir, distance, speed) {
    const p = PRESETS.tracer;
    const travel = Math.max(1.5, distance - 1.0);
    // Life is derived, not randomised: the tracer must wink out at the impact.
    const life = Math.max(0.045, travel / Math.max(40, speed));
    this.sparks.emit(
      p,
      origin.x, origin.y, origin.z,
      dir.x * speed, dir.y * speed, dir.z * speed,
      1, 1, 1, 1, life
    );
  }

  /**
   * Surface-appropriate impact burst.
   *
   * @param {THREE.Vector3} point
   * @param {THREE.Vector3} normal unit surface normal
   * @param {string} surface one of metal|concrete|stone|wood|glass|dirt|snow|water|soft|flesh
   * @param {THREE.Color|null} tint albedo tint for dust/debris
   * @param {number} intensity 0..1 scale on particle counts
   */
  impact(point, normal, surface, tint, intensity = 1) {
    const tr = tint ? tint.r : 1;
    const tg = tint ? tint.g : 1;
    const tb = tint ? tint.b : 1;
    const s = Math.max(0.25, intensity);

    switch (surface) {
      case 'metal':
        this._burst(this.sparks, PRESETS.sparkHot, point, normal, (14 * s) | 0, 5, 20, 0.95, 1, 1, 1);
        this._burst(this.sparks, PRESETS.emberGlow, point, normal, (5 * s) | 0, 1.5, 5, 0.9, 1, 1, 1);
        this._burst(this.debris, PRESETS.chipMetal, point, normal, (4 * s) | 0, 2.5, 7, 0.8, tr, tg, tb);
        this._burst(this.smoke, PRESETS.smokeWisp, point, normal, 2, 0.4, 1.4, 0.7, 1, 1, 1);
        this._flashAt(point, normal, 1.0);
        this._pulse(point, 1.0, 0.62, 0.30, 2.6 * s, 0.09);
        break;

      case 'stone':
      case 'concrete':
        this._burst(this.smoke, PRESETS.dust, point, normal, (5 * s) | 0, 0.7, 2.6, 0.85, tr, tg, tb);
        this._burst(this.debris, PRESETS.chipStone, point, normal, (7 * s) | 0, 2.5, 8, 0.75, tr, tg, tb);
        this._burst(this.sparks, PRESETS.sparkHot, point, normal, (3 * s) | 0, 4, 12, 0.9, 1, 0.95, 0.9);
        this._flashAt(point, normal, 0.55);
        this._pulse(point, 1.0, 0.85, 0.62, 1.1 * s, 0.06);
        break;

      case 'wood':
        this._burst(this.debris, PRESETS.chipWood, point, normal, (9 * s) | 0, 2.5, 8.5, 0.8, tr, tg, tb);
        this._burst(this.smoke, PRESETS.dust, point, normal, (3 * s) | 0, 0.6, 2.0, 0.8, 0.85, 0.72, 0.55);
        this._burst(this.sparks, PRESETS.emberGlow, point, normal, 2, 1, 3, 0.9, 1, 1, 1);
        this._flashAt(point, normal, 0.4);
        break;

      case 'glass':
        this._burst(this.debris, PRESETS.chipGlass, point, normal, (11 * s) | 0, 3, 9, 0.9, 1, 1, 1);
        this._burst(this.sparks, PRESETS.sparkGlass, point, normal, (9 * s) | 0, 4, 13, 0.95, 1, 1, 1);
        this._flashAt(point, normal, 0.7);
        this._pulse(point, 0.75, 0.9, 1.0, 1.4 * s, 0.07);
        break;

      case 'snow':
        this._burst(this.smoke, PRESETS.dust, point, normal, (8 * s) | 0, 0.8, 3.0, 1.15, 1.05, 1.08, 1.12);
        this._burst(this.debris, PRESETS.clod, point, normal, (4 * s) | 0, 1.5, 5, 0.7, 1.1, 1.12, 1.15);
        break;

      case 'dirt':
        this._burst(this.smoke, PRESETS.dust, point, normal, (7 * s) | 0, 0.8, 3.0, 1.05, tr, tg, tb);
        this._burst(this.debris, PRESETS.clod, point, normal, (6 * s) | 0, 2, 6.5, 0.8, tr, tg, tb);
        break;

      case 'water':
        this._burst(this.smoke, PRESETS.splash, point, normal, (9 * s) | 0, 1.5, 5.0, 1.0, 1, 1, 1);
        this._burst(this.debris, PRESETS.bloodDrop, point, normal, (6 * s) | 0, 2, 7, 0.6, 2.4, 2.8, 3.0);
        break;

      case 'flesh':
        this.bloodImpact(point, normal, null);
        break;

      default: // fabric, rubber, plastic, thatch - soft, no sparks
        this._burst(this.smoke, PRESETS.dust, point, normal, (4 * s) | 0, 0.5, 1.8, 0.8, tr, tg, tb);
        this._burst(this.debris, PRESETS.chipStone, point, normal, (3 * s) | 0, 1.5, 4.5, 0.6, tr, tg, tb);
        break;
    }
  }

  /**
   * Distinct wound effect: a mist cone that follows the bullet through the body
   * plus heavier droplets that arc back toward the shooter.
   *
   * @param {THREE.Vector3} point
   * @param {THREE.Vector3} normal surface normal (points back at the shooter)
   * @param {THREE.Vector3|null} through bullet direction, for the exit spray
   */
  bloodImpact(point, normal, through) {
    this._burst(this.smoke, PRESETS.bloodMist, point, normal, 6, 0.6, 2.4, 1.0, 1, 1, 1);
    this._burst(this.debris, PRESETS.bloodDrop, point, normal, 7, 1.5, 5.0, 1.0, 1, 1, 1);
    if (through) {
      // Exit-side spray: tighter cone, faster, continues along the round's path.
      this._burst(this.smoke, PRESETS.bloodMist, point, through, 4, 2.0, 5.5, 0.9, 1, 1, 1);
      this._burst(this.debris, PRESETS.bloodDrop, point, through, 6, 3.0, 8.0, 0.9, 1, 1, 1);
    }
  }

  /**
   * Lingering muzzle smoke. Emitted sparsely by the caller - firing at 720 rpm
   * would otherwise bury the screen in grey.
   */
  muzzleSmoke(origin, dir) {
    for (let i = 0; i < 2; i++) {
      coneDir(dir, 0.5);
      const sp = rand(0.5, 1.6);
      _pos.copy(origin).addScaledVector(dir, rand(0, 0.25));
      this.smoke.emit(
        PRESETS.muzzleSmoke,
        _pos.x, _pos.y, _pos.z,
        _dir.x * sp, _dir.y * sp + 0.35, _dir.z * sp,
        1, 1, 1, 1, 0
      );
    }
  }

  /** Short bright flare, used for near-miss cracks and suppressive impacts. */
  sparkle(point, normal, count = 4) {
    this._burst(this.sparks, PRESETS.sparkHot, point, normal, count, 3, 9, 0.7, 1, 1, 1);
  }

  /* ---------------- internals ---------------- */

  _burst(system, preset, point, normal, count, speedMin, speedMax, sizeMul, tr, tg, tb) {
    for (let i = 0; i < count; i++) {
      // Wide cone hugging the surface normal: real ejecta sprays back along the
      // hemisphere, it does not fire straight out like a firework.
      coneDir(normal, 1.15);
      const sp = rand(speedMin, speedMax);
      // Nudge the origin off the surface so particles are not half-buried.
      _pos.copy(point).addScaledVector(normal, 0.03);
      system.emit(
        preset,
        _pos.x, _pos.y, _pos.z,
        _dir.x * sp, _dir.y * sp, _dir.z * sp,
        tr, tg, tb, sizeMul, 0
      );
    }
  }

  _flashAt(point, normal, scale) {
    _pos.copy(point).addScaledVector(normal, 0.05);
    this.sparks.emit(
      PRESETS.flash,
      _pos.x, _pos.y, _pos.z,
      0, 0, 0,
      1, 1, 1, scale, 0
    );
  }

  /** Fire the least-busy pooled point light. */
  _pulse(point, r, g, b, intensity, duration) {
    let slot = this._lights[0];
    for (const s of this._lights) if (s.t < slot.t) slot = s;
    slot.light.position.copy(point);
    slot.light.color.setRGB(r, g, b);
    slot.peak = intensity;
    slot.dur = duration;
    slot.t = duration;
    slot.light.intensity = intensity;
  }

  /** @param {number} dt seconds */
  update(dt) {
    this.sparks.update(dt);
    this.smoke.update(dt);
    this.debris.update(dt);

    for (const s of this._lights) {
      if (s.t <= 0) continue;
      s.t -= dt;
      if (s.t <= 0) {
        s.t = 0;
        s.light.intensity = 0;
      } else {
        const k = s.t / s.dur;
        s.light.intensity = s.peak * k * k;
      }
    }
  }

  /** Drop everything in flight - used on world change. */
  clear() {
    this.sparks.clear();
    this.smoke.clear();
    this.debris.clear();
    for (const s of this._lights) {
      s.t = 0;
      s.light.intensity = 0;
    }
  }

  dispose() {
    this.sparks.dispose();
    this.smoke.dispose();
    this.debris.dispose();
    for (const t of this._textures) t.dispose();
    for (const s of this._lights) this.scene.remove(s.light);
  }
}
