import * as THREE from 'three';

/**
 * Pooled bullet-hole / splatter decals.
 *
 * A fixed-size ring buffer of oriented quads drawn as a single `InstancedMesh`.
 * Four decal variants live in one 2x2 texture atlas so every surface type gets a
 * bespoke hole without costing an extra draw call or material.
 *
 * Two things make decals hard and are solved explicitly here:
 *  - **Z-fighting.** Decals are coplanar with the wall they sit on, so they get
 *    both a normal-direction offset *and* polygon offset. Depth writes are off
 *    so overlapping decals blend instead of fighting each other.
 *  - **Recycling pop.** When the ring wraps, the decal that is about to be
 *    overwritten would vanish in one frame. Instead every slot's opacity is
 *    scaled by how close the write head is to reaching it, so the oldest decals
 *    visibly dissolve before their slot is reused.
 */

/** Atlas cell indices. */
export const DECAL = {
  HARD: 0,   // concrete / stone / asphalt - cratered hole with radial cracks
  METAL: 1,  // torn metal petals, bright scarred rim
  WOOD: 2,   // splintered hole
  BLOOD: 3,  // wet splatter with cast-off droplets
};

const ATLAS_SIZE = 512;
const CELL = ATLAS_SIZE / 2;

/* Module-scope scratch - decals spawn inside the shooting hot path. */
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();
const _v1 = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _forward = new THREE.Vector3(0, 0, 1);

/** Deterministic RNG so the generated atlas is identical every run. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}

/** Irregular closed blob, used for craters and splatter so nothing reads as a circle. */
function blobPath(ctx, cx, cy, radius, wobble, lobes, rnd) {
  ctx.beginPath();
  const steps = 48;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const n =
      Math.sin(a * lobes + rnd() * 0.001) * 0.5 +
      Math.sin(a * (lobes * 1.7 + 1) + 1.3) * 0.3 +
      Math.sin(a * (lobes * 3.1 + 2) + 2.7) * 0.2;
    const r = radius * (1 + n * wobble);
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/* ------------------------------------------------------------------ */
/* Atlas painting                                                      */
/* ------------------------------------------------------------------ */

function paintHardHole(a, h, r, ox, oy, rnd) {
  const cx = ox + CELL * 0.5;
  const cy = oy + CELL * 0.5;

  // Powder halo thrown out of the hole.
  const halo = a.createRadialGradient(cx, cy, 8, cx, cy, 108);
  halo.addColorStop(0, 'rgba(214,209,198,0.34)');
  halo.addColorStop(0.45, 'rgba(196,190,178,0.16)');
  halo.addColorStop(1, 'rgba(196,190,178,0)');
  a.fillStyle = halo;
  a.beginPath();
  a.arc(cx, cy, 108, 0, Math.PI * 2);
  a.fill();

  // Hairline cracks radiating from the impact.
  a.lineCap = 'round';
  for (let i = 0; i < 15; i++) {
    const ang = rnd() * Math.PI * 2;
    const len = 34 + rnd() * 62;
    const bend = (rnd() - 0.5) * 0.8;
    a.strokeStyle = `rgba(46,44,41,${0.30 + rnd() * 0.35})`;
    a.lineWidth = 0.8 + rnd() * 2.0;
    a.beginPath();
    a.moveTo(cx + Math.cos(ang) * 14, cy + Math.sin(ang) * 14);
    a.quadraticCurveTo(
      cx + Math.cos(ang + bend * 0.4) * len * 0.6,
      cy + Math.sin(ang + bend * 0.4) * len * 0.6,
      cx + Math.cos(ang + bend) * len,
      cy + Math.sin(ang + bend) * len
    );
    a.stroke();
  }

  // Spalled ring then the black core.
  a.fillStyle = 'rgba(126,121,112,0.92)';
  blobPath(a, cx, cy, 30, 0.30, 5, rnd);
  a.fill();
  a.fillStyle = 'rgba(74,70,64,0.96)';
  blobPath(a, cx, cy, 21, 0.26, 6, rnd);
  a.fill();
  a.fillStyle = 'rgba(14,13,12,0.99)';
  blobPath(a, cx, cy, 13, 0.22, 7, rnd);
  a.fill();

  // Height: raised spall lip, deep core.
  h.fillStyle = 'rgb(150,150,150)';
  blobPath(h, cx, cy, 31, 0.30, 5, rnd);
  h.fill();
  const crater = h.createRadialGradient(cx, cy, 2, cx, cy, 24);
  crater.addColorStop(0, 'rgb(4,4,4)');
  crater.addColorStop(0.6, 'rgb(60,60,60)');
  crater.addColorStop(1, 'rgb(140,140,140)');
  h.fillStyle = crater;
  h.beginPath();
  h.arc(cx, cy, 24, 0, Math.PI * 2);
  h.fill();

  // Roughness: fractured stone is very rough, the powder halo slightly less so.
  r.fillStyle = 'rgb(232,232,232)';
  r.beginPath();
  r.arc(cx, cy, 108, 0, Math.PI * 2);
  r.fill();
  r.fillStyle = 'rgb(250,250,250)';
  blobPath(r, cx, cy, 30, 0.30, 5, rnd);
  r.fill();
}

function paintMetalHole(a, h, r, ox, oy, rnd) {
  const cx = ox + CELL * 0.5;
  const cy = oy + CELL * 0.5;

  // Scorch first, so scratches read over it.
  const burn = a.createRadialGradient(cx, cy, 6, cx, cy, 74);
  burn.addColorStop(0, 'rgba(26,22,20,0.62)');
  burn.addColorStop(0.5, 'rgba(46,38,33,0.30)');
  burn.addColorStop(1, 'rgba(46,38,33,0)');
  a.fillStyle = burn;
  a.beginPath();
  a.arc(cx, cy, 74, 0, Math.PI * 2);
  a.fill();

  // Bright radial scars where the round skidded across the plate.
  a.lineCap = 'round';
  for (let i = 0; i < 26; i++) {
    const ang = rnd() * Math.PI * 2;
    const r0 = 18 + rnd() * 10;
    const r1 = r0 + 16 + rnd() * 52;
    a.strokeStyle = `rgba(206,212,222,${0.14 + rnd() * 0.34})`;
    a.lineWidth = 0.7 + rnd() * 1.6;
    a.beginPath();
    a.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
    a.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
    a.stroke();
  }

  // Torn petals of bare metal peeled back around the entry.
  a.fillStyle = 'rgba(198,204,214,0.95)';
  for (let i = 0; i < 9; i++) {
    const ang = (i / 9) * Math.PI * 2 + rnd() * 0.3;
    const len = 24 + rnd() * 18;
    const w = 0.18 + rnd() * 0.14;
    a.beginPath();
    a.moveTo(cx + Math.cos(ang - w) * 11, cy + Math.sin(ang - w) * 11);
    a.lineTo(cx + Math.cos(ang) * len, cy + Math.sin(ang) * len);
    a.lineTo(cx + Math.cos(ang + w) * 11, cy + Math.sin(ang + w) * 11);
    a.closePath();
    a.fill();
  }
  a.fillStyle = 'rgba(8,9,11,1)';
  blobPath(a, cx, cy, 11, 0.24, 6, rnd);
  a.fill();

  h.fillStyle = 'rgb(226,226,226)';
  for (let i = 0; i < 9; i++) {
    const ang = (i / 9) * Math.PI * 2 + rnd() * 0.3;
    const len = 24 + rnd() * 18;
    const w = 0.2;
    h.beginPath();
    h.moveTo(cx + Math.cos(ang - w) * 11, cy + Math.sin(ang - w) * 11);
    h.lineTo(cx + Math.cos(ang) * len, cy + Math.sin(ang) * len);
    h.lineTo(cx + Math.cos(ang + w) * 11, cy + Math.sin(ang + w) * 11);
    h.closePath();
    h.fill();
  }
  h.fillStyle = 'rgb(6,6,6)';
  h.beginPath();
  h.arc(cx, cy, 12, 0, Math.PI * 2);
  h.fill();

  // Freshly exposed metal is polished by the impact; the scorch is matte.
  r.fillStyle = 'rgb(190,190,190)';
  r.beginPath();
  r.arc(cx, cy, 74, 0, Math.PI * 2);
  r.fill();
  r.fillStyle = 'rgb(78,78,78)';
  for (let i = 0; i < 9; i++) {
    const ang = (i / 9) * Math.PI * 2 + rnd() * 0.3;
    const len = 24 + rnd() * 18;
    r.beginPath();
    r.moveTo(cx + Math.cos(ang - 0.2) * 11, cy + Math.sin(ang - 0.2) * 11);
    r.lineTo(cx + Math.cos(ang) * len, cy + Math.sin(ang) * len);
    r.lineTo(cx + Math.cos(ang + 0.2) * 11, cy + Math.sin(ang + 0.2) * 11);
    r.closePath();
    r.fill();
  }
}

function paintWoodHole(a, h, r, ox, oy, rnd) {
  const cx = ox + CELL * 0.5;
  const cy = oy + CELL * 0.5;

  const dust = a.createRadialGradient(cx, cy, 10, cx, cy, 92);
  dust.addColorStop(0, 'rgba(178,142,96,0.26)');
  dust.addColorStop(1, 'rgba(178,142,96,0)');
  a.fillStyle = dust;
  a.beginPath();
  a.arc(cx, cy, 92, 0, Math.PI * 2);
  a.fill();

  // Splinters lift along the grain, so bias their length on the U axis.
  for (let i = 0; i < 16; i++) {
    const ang = rnd() * Math.PI * 2;
    const grain = 1 + Math.abs(Math.cos(ang)) * 1.1;
    const len = (20 + rnd() * 34) * grain;
    const w = 0.06 + rnd() * 0.1;
    const shade = 118 + Math.floor(rnd() * 62);
    a.fillStyle = `rgba(${shade},${Math.floor(shade * 0.74)},${Math.floor(shade * 0.46)},0.88)`;
    a.beginPath();
    a.moveTo(cx + Math.cos(ang - w) * 14, cy + Math.sin(ang - w) * 14);
    a.lineTo(cx + Math.cos(ang) * len, cy + Math.sin(ang) * len);
    a.lineTo(cx + Math.cos(ang + w) * 14, cy + Math.sin(ang + w) * 14);
    a.closePath();
    a.fill();

    h.fillStyle = `rgb(${190 + Math.floor(rnd() * 50)},${190},${190})`;
    h.beginPath();
    h.moveTo(cx + Math.cos(ang - w) * 14, cy + Math.sin(ang - w) * 14);
    h.lineTo(cx + Math.cos(ang) * len, cy + Math.sin(ang) * len);
    h.lineTo(cx + Math.cos(ang + w) * 14, cy + Math.sin(ang + w) * 14);
    h.closePath();
    h.fill();
  }

  a.fillStyle = 'rgba(30,19,11,0.98)';
  blobPath(a, cx, cy, 16, 0.3, 6, rnd);
  a.fill();
  h.fillStyle = 'rgb(8,8,8)';
  blobPath(h, cx, cy, 16, 0.3, 6, rnd);
  h.fill();

  r.fillStyle = 'rgb(240,240,240)';
  r.beginPath();
  r.arc(cx, cy, 92, 0, Math.PI * 2);
  r.fill();
}

function paintBlood(a, h, r, ox, oy, rnd) {
  const cx = ox + CELL * 0.5;
  const cy = oy + CELL * 0.5;

  // Cast-off droplets first so the main pool overlaps them naturally.
  for (let i = 0; i < 26; i++) {
    const ang = rnd() * Math.PI * 2;
    const dist = 40 + rnd() * 72;
    const dx = cx + Math.cos(ang) * dist;
    const dy = cy + Math.sin(ang) * dist;
    const rad = 1.6 + rnd() * 7;
    a.save();
    a.translate(dx, dy);
    a.rotate(ang);
    a.fillStyle = `rgba(${86 + Math.floor(rnd() * 34)},${8 + Math.floor(rnd() * 10)},${9 + Math.floor(rnd() * 8)},${0.66 + rnd() * 0.3})`;
    a.beginPath();
    a.ellipse(0, 0, rad * (1 + rnd() * 1.4), rad, 0, 0, Math.PI * 2);
    a.fill();
    a.restore();

    r.fillStyle = 'rgb(44,44,44)';
    r.beginPath();
    r.arc(dx, dy, rad * 1.2, 0, Math.PI * 2);
    r.fill();
  }

  a.fillStyle = 'rgba(104,12,14,0.90)';
  blobPath(a, cx, cy, 46, 0.34, 4, rnd);
  a.fill();
  a.fillStyle = 'rgba(66,6,9,0.95)';
  blobPath(a, cx, cy, 31, 0.30, 5, rnd);
  a.fill();
  a.fillStyle = 'rgba(38,3,5,0.95)';
  blobPath(a, cx, cy, 17, 0.28, 6, rnd);
  a.fill();

  // Blood is a thin wet film: barely any relief, very low roughness.
  h.fillStyle = 'rgb(146,146,146)';
  blobPath(h, cx, cy, 46, 0.34, 4, rnd);
  h.fill();

  r.fillStyle = 'rgb(38,38,38)';
  blobPath(r, cx, cy, 47, 0.34, 4, rnd);
  r.fill();
}

/**
 * Sobel the height field into a tangent-space normal map, written into a fresh
 * canvas.
 *
 * A canvas (rather than a DataTexture) is deliberate: `CanvasTexture` uploads
 * with `flipY = true` while `DataTexture` defaults to `false`, and mixing the
 * two would flip the normal map's V axis relative to the albedo atlas - the
 * cells would sample from the wrong row and the lighting would invert.
 */
function heightToNormalCanvas(heightCanvas, strength) {
  const size = heightCanvas.width;
  const src = heightCanvas.getContext('2d', { willReadFrequently: true })
    .getImageData(0, 0, size, size).data;
  const dst = makeCanvas(size);
  const ctx = dst.getContext('2d');
  const img = ctx.createImageData(size, size);
  const out = img.data;
  const mask = size - 1;
  const at = (x, y) => src[(((y & mask) * size + (x & mask)) << 2)] / 255;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), rr = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
      const dx = tl + 2 * l + bl - (tr + 2 * rr + br);
      const dy = tl + 2 * t + tr - (bl + 2 * b + br);
      // n = normalize(-dH/du, -dH/dv, 1). Canvas Y runs down but the texture is
      // uploaded flipped, so the V derivative picks up a sign flip on top of the
      // usual negation - hence dx stays positive and dy is negated.
      let nx = dx * strength;
      let ny = -dy * strength;
      const inv = 1 / Math.hypot(nx, ny, 1);
      nx *= inv;
      ny *= inv;
      const i = (y * size + x) << 2;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (inv * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return dst;
}

/* ------------------------------------------------------------------ */

export class DecalPool {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.WebGLRenderer} renderer used only for the anisotropy cap
   * @param {number} capacity ring-buffer size
   */
  constructor(scene, renderer, capacity = 120) {
    this.scene = scene;
    this.capacity = capacity;
    this._head = 0;
    this._live = 0;

    const { albedo, normal, roughness } = DecalPool._buildAtlas(renderer);
    this._textures = [albedo, normal, roughness];

    this.material = new THREE.MeshStandardMaterial({
      map: albedo,
      normalMap: normal,
      roughnessMap: roughness,
      normalScale: new THREE.Vector2(1.25, 1.25),
      roughness: 1,
      metalness: 0,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
      // Pull decals toward the camera in depth: the mesh offset alone is not
      // enough at grazing angles or on large-far-plane scenes.
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -14,
    });
    this.material.onBeforeCompile = DecalPool._patchShader;
    // Without this, three reuses the un-patched physical program.
    this.material.customProgramCacheKey = () => 'aether-decal-v1';

    const geo = new THREE.PlaneGeometry(1, 1);
    this._atlasAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    this._fadeAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this._atlasAttr.setUsage(THREE.DynamicDrawUsage);
    this._fadeAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aAtlas', this._atlasAttr);
    geo.setAttribute('aFade', this._fadeAttr);
    this._geometry = geo;

    this.mesh = new THREE.InstancedMesh(geo, this.material, capacity);
    this.mesh.name = 'combat:decals';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false; // decals are scattered world-wide
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);

    /** Per-slot state, flat typed arrays so nothing allocates on spawn. */
    this._age = new Float32Array(capacity);
    this._life = new Float32Array(capacity);
    this._active = new Uint8Array(capacity);

    // Park every instance at zero scale until it is used.
    _m1.makeScale(0, 0, 0);
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, _m1);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Shared shader patch: per-instance atlas cell + fade, both instanced attributes. */
  static _patchShader(shader) {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec2 aAtlas;
        attribute float aFade;
        varying float vDecalFade;`
      )
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
        vDecalFade = aFade;
        // Remap the unit-quad UV into this instance's 2x2 atlas cell. Doing it
        // here rather than in the fragment shader keeps texture-gradient based
        // derivatives (and therefore mip selection) correct.
        #ifdef USE_MAP
          vMapUv = vMapUv * 0.5 + aAtlas;
        #endif
        #ifdef USE_NORMALMAP
          vNormalMapUv = vNormalMapUv * 0.5 + aAtlas;
        #endif
        #ifdef USE_ROUGHNESSMAP
          vRoughnessMapUv = vRoughnessMapUv * 0.5 + aAtlas;
        #endif`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vDecalFade;')
      .replace(
        '#include <opaque_fragment>',
        '#include <opaque_fragment>\ngl_FragColor.a *= vDecalFade;'
      );
  }

  /** Paint the 2x2 decal atlas (albedo + normal + roughness) once at startup. */
  static _buildAtlas(renderer) {
    const rnd = mulberry32(0x5eed1e);

    const albedoCanvas = makeCanvas(ATLAS_SIZE);
    const heightCanvas = makeCanvas(ATLAS_SIZE);
    const roughCanvas = makeCanvas(ATLAS_SIZE);
    const a = albedoCanvas.getContext('2d');
    const h = heightCanvas.getContext('2d', { willReadFrequently: true });
    const r = roughCanvas.getContext('2d');

    // Height and roughness need a defined base everywhere; albedo stays clear so
    // atlas bleed between cells resolves to fully transparent, not to a smear.
    h.fillStyle = 'rgb(128,128,128)';
    h.fillRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
    r.fillStyle = 'rgb(200,200,200)';
    r.fillRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);

    paintHardHole(a, h, r, 0, 0, rnd);
    paintMetalHole(a, h, r, CELL, 0, rnd);
    paintWoodHole(a, h, r, 0, CELL, rnd);
    paintBlood(a, h, r, CELL, CELL, rnd);

    const aniso = renderer?.capabilities?.getMaxAnisotropy?.() ?? 1;

    const albedo = new THREE.CanvasTexture(albedoCanvas);
    const normal = new THREE.CanvasTexture(heightToNormalCanvas(heightCanvas, 3.2));
    const roughness = new THREE.CanvasTexture(roughCanvas);

    for (const t of [albedo, normal, roughness]) {
      t.colorSpace = t === albedo ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = THREE.ClampToEdgeWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.anisotropy = aniso;
      t.needsUpdate = true;
    }
    return { albedo, normal, roughness };
  }

  /**
   * Stamp a decal onto a surface.
   *
   * @param {THREE.Vector3} point world-space hit point
   * @param {THREE.Vector3} normal unit surface normal
   * @param {number} size edge length in metres
   * @param {number} cell one of `DECAL.*`
   * @param {number} [life] seconds before it dissolves
   */
  spawn(point, normal, size, cell, life = 34) {
    if (!Number.isFinite(point.x) || !Number.isFinite(size)) return;

    const i = this._head;
    this._head = (this._head + 1) % this.capacity;
    if (this._active[i] === 0) this._live++;

    // Orient the quad's +Z along the surface normal, then roll it randomly so
    // repeated hits on one wall never read as a stamped pattern.
    _q1.setFromUnitVectors(_forward, normal);
    _q2.setFromAxisAngle(normal, Math.random() * Math.PI * 2);
    _q1.premultiply(_q2);

    // Constant lift plus a sub-millimetre stagger: the stagger is what stops two
    // overlapping decals from fighting each other.
    const lift = 0.014 + (i % 8) * 0.0012;
    _v1.copy(point).addScaledVector(normal, lift);
    _scale.set(size, size, size);
    _m1.compose(_v1, _q1, _scale);
    this.mesh.setMatrixAt(i, _m1);

    const ai = i * 2;
    this._atlasAttr.array[ai] = (cell & 1) * 0.5;
    this._atlasAttr.array[ai + 1] = (cell >> 1) * 0.5;

    this._age[i] = 0;
    this._life[i] = life;
    this._active[i] = 1;
    this._fadeAttr.array[i] = 1;

    this.mesh.instanceMatrix.needsUpdate = true;
    this._atlasAttr.needsUpdate = true;
    this._fadeAttr.needsUpdate = true;
  }

  /** Age every live decal and recompute its opacity. */
  update(dt) {
    if (this._live === 0) return;
    const cap = this.capacity;
    const fade = this._fadeAttr.array;
    // Slots within this many steps of the write head are visibly dissolving.
    const recycleWindow = Math.max(6, Math.floor(cap * 0.1));
    let live = 0;

    for (let i = 0; i < cap; i++) {
      if (this._active[i] === 0) continue;
      const age = (this._age[i] += dt);
      const life = this._life[i];

      if (age >= life) {
        this._active[i] = 0;
        fade[i] = 0;
        _m1.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, _m1);
        this.mesh.instanceMatrix.needsUpdate = true;
        continue;
      }
      live++;

      // Long plateau then a soft dissolve; nothing should blink out.
      const byAge = Math.min(1, (life - age) / (life * 0.28));
      const untilRecycled = (i - this._head + cap) % cap;
      const byRecycle = Math.min(1, untilRecycled / recycleWindow);
      fade[i] = Math.min(byAge, byRecycle);
    }

    this._live = live;
    this._fadeAttr.needsUpdate = true;
  }

  /** Wipe every decal - called on world change so holes never bleed between worlds. */
  clear() {
    _m1.makeScale(0, 0, 0);
    for (let i = 0; i < this.capacity; i++) {
      this._active[i] = 0;
      this._age[i] = 0;
      this._fadeAttr.array[i] = 0;
      this.mesh.setMatrixAt(i, _m1);
    }
    this._head = 0;
    this._live = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this._fadeAttr.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this._geometry.dispose();
    this.material.dispose();
    for (const t of this._textures) t.dispose();
  }
}
