import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { World } from './World.js';
// The station frames each gateway with its own iris and rings, so it needs the
// portal system's aperture geometry rather than a copy of the numbers.
import { PORTAL_DISC_OFFSET_Y } from '../systems/Portals.js';
/* The layout constants, deterministic noise, UV helpers and GeoBatch moved out
 * to station/StationKit.js when the ring grew four outer zones. Each of those is
 * a world in its own right, built from exactly the same parts as the hub, and
 * two copies of `boxGeo` would have drifted inside a week. */
import {
  DEG,
  DECK_R, HULL_R, WALL_H, CEIL_Y, PLAZA_R, ROAD_W, LOOP_R, LOOP_Y, PORTAL_R,
  OCULUS_R, WINDOW_HALF, GATEWAY_DECK_Y, PYLON_OFF,
  ZONES, ZONE_R, ZONE_CENTRE_R, LINK_LEN,
  DOME_R, DOME_WALL_H, DOME_APEX, domeHeightAt, WORLD_R,
  COLLIDE_CEILING, CHUNK_TRIS, PLANTING_TRIS, OCC_CELL, occKeyOf, occCellKey,
  NON_SOLID_KEYS, PROXY_KEYS,
  SPAWN_X, SPAWN_Z, SPAWN_YAW,
  SIGN_COLS, SIGN_ROWS,
  mulberry32, hashi, tnoise, tfbm,
  boxUV, uvScale, cylUV, cylGeo, atlasUV, signUV, boxGeo,
  instanced, GeoBatch, chunkTriangles,
  roadPos, faceRoadYaw, zoneCentre, zoneLocal, zoneYaw,
} from './station/StationKit.js';
import { StationActors } from './station/StationActors.js';
import { buildOuterRing, LINK_MOUTH_HALF_DEG } from './station/OuterRing.js';
import { buildTower } from './station/Tower.js';

/**
 * AETHER NEXUS - "Aether Nexus Station", the entry world.
 *
 * A 400 m habitable ring interior: a central plaza with the two outbound
 * portals, six plated avenues radiating into six districts, an elevated
 * walkway loop, and a 110-degree curved window wall opening onto space.
 *
 * Everything here is generated in code. Textures are painted to 2D canvases
 * and turned into albedo / normal / roughness sets; geometry is composed from
 * primitives and then *merged per material* so a district of forty buildings
 * costs a handful of draw calls instead of a thousand. Repeated props go
 * through InstancedMesh.
 */

/* ------------------------------------------------------------------ */
/* Scratch - reused every frame, never allocated in update()           */
/* ------------------------------------------------------------------ */

const _dummy = new THREE.Object3D();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _col = new THREE.Color();
const _mat4 = new THREE.Matrix4();
const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();
const _scl = new THREE.Vector3(1, 1, 1);


/* ------------------------------------------------------------------ */
/* Deterministic noise + rng                                           */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/* Canvas helpers                                                      */
/* ------------------------------------------------------------------ */

function makeCanvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function ctx2d(canvas) {
  const c = canvas.getContext('2d', { willReadFrequently: true });
  c.imageSmoothingEnabled = true;
  return c;
}

/**
 * Wrap a canvas as a texture. UV tiling is baked into geometry rather than the
 * material so that meshes with different footprints can share one material and
 * therefore merge into a single draw call.
 */
function canvasTexture(canvas, srgb, aniso) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/**
 * Sobel a greyscale height canvas into a tangent-space normal map. Kept as a
 * canvas (not a DataTexture) so flipY matches the albedo texture exactly.
 */
function normalFromHeight(heightCanvas, strength, aniso) {
  const S = heightCanvas.width;
  const T = heightCanvas.height;
  const src = ctx2d(heightCanvas).getImageData(0, 0, S, T).data;
  const out = makeCanvas(S, T);
  const octx = ctx2d(out);
  const img = octx.createImageData(S, T);
  const dst = img.data;
  const at = (x, y) => src[(((y + T) % T) * S + ((x + S) % S)) * 4] / 255;

  for (let y = 0; y < T; y++) {
    for (let x = 0; x < S; x++) {
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      let nx = -dx * strength;
      let ny = -dy * strength;
      const nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv; ny *= inv;
      const i = (y * S + x) * 4;
      dst[i] = (nx * 0.5 + 0.5) * 255;
      dst[i + 1] = (ny * 0.5 + 0.5) * 255;
      dst[i + 2] = (nz * inv * 0.5 + 0.5) * 255;
      dst[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return canvasTexture(out, false, aniso);
}

/** Multiply tileable fbm grain over an already-painted canvas. */
function grainOverlay(cx, amount, scale, seed, tintR = 1, tintG = 1, tintB = 1) {
  const S = cx.canvas.width, T = cx.canvas.height;
  const img = cx.getImageData(0, 0, S, T);
  const d = img.data;
  const period = Math.max(2, Math.round(scale));
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < S; x++) {
      const n = tfbm((x / S) * scale, (y / T) * scale, period, seed, 4);
      const f = 1 + (n - 0.5) * 2 * amount;
      const i = (y * S + x) * 4;
      d[i] = Math.max(0, Math.min(255, d[i] * f * tintR));
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] * f * tintG));
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2] * f * tintB));
    }
  }
  cx.putImageData(img, 0, 0);
}

/** Scratches, streaks and edge wear - the difference between CG and "used". */
function wearPass(a, h, r, S, rng, opts = {}) {
  const k = S / 512;
  const streaks = opts.streaks ?? 60;
  a.save();
  a.globalCompositeOperation = 'source-over';
  for (let i = 0; i < streaks; i++) {
    const x = rng() * S;
    const y = rng() * S;
    const len = 8 * k + rng() * (S * 0.35);
    const w = (0.6 + rng() * 2.4) * k;
    const dark = rng() < 0.65;
    a.globalAlpha = 0.03 + rng() * 0.09;
    a.fillStyle = dark ? '#0b0d11' : '#a8b4c2';
    a.fillRect(x, y, w, len);
    r.globalAlpha = 0.06 + rng() * 0.1;
    r.fillStyle = dark ? '#ffffff' : '#4a4a4a';
    r.fillRect(x, y, w, len);
    r.globalAlpha = 1;
  }
  // Scratches
  for (let i = 0; i < (opts.scratches ?? 40); i++) {
    const x = rng() * S, y = rng() * S;
    const ang = rng() * Math.PI * 2;
    const len = (6 + rng() * 40) * k;
    a.globalAlpha = 0.10 + rng() * 0.16;
    a.strokeStyle = '#c9d6e4';
    a.lineWidth = (0.7 + rng() * 0.8) * k;
    a.beginPath();
    a.moveTo(x, y);
    a.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    a.stroke();
    h.globalAlpha = 0.25;
    h.strokeStyle = '#9a9a9a';
    h.lineWidth = a.lineWidth;
    h.beginPath();
    h.moveTo(x, y);
    h.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    h.stroke();
    h.globalAlpha = 1;
  }
  a.globalAlpha = 1;
  a.restore();
}

/** Bolt/rivet with a bevel in height and a specular pip in roughness. */
function rivet(a, h, r, x, y, rad, tint = '#8e9aa8') {
  a.fillStyle = tint;
  a.beginPath(); a.arc(x, y, rad, 0, Math.PI * 2); a.fill();
  a.fillStyle = 'rgba(255,255,255,0.30)';
  a.beginPath(); a.arc(x - rad * 0.25, y - rad * 0.25, rad * 0.55, 0, Math.PI * 2); a.fill();
  a.fillStyle = 'rgba(0,0,0,0.35)';
  a.beginPath(); a.arc(x + rad * 0.3, y + rad * 0.3, rad * 0.45, 0, Math.PI * 2); a.fill();

  const g = h.createRadialGradient(x, y, 0, x, y, rad);
  g.addColorStop(0, '#e8e8e8');
  g.addColorStop(0.7, '#a0a0a0');
  g.addColorStop(1, '#6a6a6a');
  h.fillStyle = g;
  h.beginPath(); h.arc(x, y, rad, 0, Math.PI * 2); h.fill();

  r.fillStyle = '#3c3c3c';
  r.beginPath(); r.arc(x, y, rad * 0.9, 0, Math.PI * 2); r.fill();
}

/* ------------------------------------------------------------------ */
/* Surface painters - each fills albedo / height / roughness contexts  */
/* ------------------------------------------------------------------ */

/** Shared plate-grid pass used by deck, hull and panel surfaces. */
function paintPlateGrid(a, h, r, S, rng, o) {
  // Every feature below was authored against a 512 px canvas. Scaling by `k`
  // keeps the *world-space* rib pitch identical when the canvas resolution goes
  // up, which is the entire point of raising it: more texels per rib, not more
  // ribs. Sub-texel ribs tiled across a 200 m deck are what produces moire.
  const k = S / 512;
  const cols = o.cols, rows = o.rows;
  const cw = S / cols, ch = S / rows;
  const gap = (o.gap ?? 3) * k;

  a.fillStyle = o.base; a.fillRect(0, 0, S, S);
  h.fillStyle = '#8a8a8a'; h.fillRect(0, 0, S, S);
  r.fillStyle = o.rough ?? '#b4b4b4'; r.fillRect(0, 0, S, S);

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x = cx * cw, y = cy * ch;
      const v = rng();
      // Per-plate albedo jitter keeps the grid from reading as wallpaper, but a
      // +/-14% swing per cell reads as a random checkerboard rather than as
      // metal: the eye locks onto the cell boundary, not onto the surface. Half
      // that range plus the low-frequency macro octave in `withMacro` (which
      // drifts across whole pillars, not per quad) is what actually breaks the
      // tiling read.
      const shade = 0.935 + v * 0.13;
      a.save();
      a.globalAlpha = 1;
      a.fillStyle = o.plate;
      a.fillRect(x + gap, y + gap, cw - gap * 2, ch - gap * 2);
      a.globalCompositeOperation = 'source-atop';
      a.fillStyle = `rgba(255,255,255,${Math.max(0, (shade - 1) * 0.9)})`;
      a.fillRect(x + gap, y + gap, cw - gap * 2, ch - gap * 2);
      a.fillStyle = `rgba(0,0,0,${Math.max(0, (1 - shade) * 0.9)})`;
      a.fillRect(x + gap, y + gap, cw - gap * 2, ch - gap * 2);
      a.restore();

      // Bevel: light on the top/left, shadow bottom/right.
      a.fillStyle = 'rgba(255,255,255,0.13)';
      a.fillRect(x + gap, y + gap, cw - gap * 2, 1.6 * k);
      a.fillRect(x + gap, y + gap, 1.6 * k, ch - gap * 2);
      a.fillStyle = 'rgba(0,0,0,0.42)';
      a.fillRect(x + gap, y + ch - gap - 1.8 * k, cw - gap * 2, 1.8 * k);
      a.fillRect(x + cw - gap - 1.8 * k, y + gap, 1.8 * k, ch - gap * 2);

      const hv = 168 + Math.floor(v * 20);
      h.fillStyle = `rgb(${hv},${hv},${hv})`;
      h.fillRect(x + gap, y + gap, cw - gap * 2, ch - gap * 2);

      /* Roughness carried a +/-23% flat jitter per plate. Under a bright
       * environment probe that turns a wall into a checkerboard of unrelated
       * greys - the "random-per-quad grey values rather than a textured
       * surface" read in the review. Metal varies *within* a plate (rolling
       * direction, wipe marks) far more than it varies between plates, so the
       * flat jitter drops to +/-4% and the variance moves into a brushed
       * micro-streak pass that runs along the plate. */
      const rv = 170 + Math.floor(rng() * 14);
      r.fillStyle = `rgb(${rv},${rv},${rv})`;
      r.fillRect(x + gap, y + gap, cw - gap * 2, ch - gap * 2);
      r.save();
      r.beginPath();
      r.rect(x + gap, y + gap, cw - gap * 2, ch - gap * 2);
      r.clip();
      const brush = Math.max(3, Math.round((ch - gap * 2) / (7 * k)));
      for (let s = 0; s < brush; s++) {
        const sy = y + gap + ((ch - gap * 2) * (s + rng())) / brush;
        const amp = 10 + rng() * 26;
        r.fillStyle = rng() < 0.5
          ? `rgba(255,255,255,${(amp / 255) * 0.5})`
          : `rgba(0,0,0,${(amp / 255) * 0.5})`;
        r.fillRect(x + gap, sy, cw - gap * 2, (0.6 + rng() * 1.4) * k);
      }
      r.restore();

      if (o.rivets) {
        const inset = (o.rivetInset ?? 9) * k;
        const rr = (o.rivetSize ?? 2.6) * k;
        const pts = [
          [x + gap + inset, y + gap + inset],
          [x + cw - gap - inset, y + gap + inset],
          [x + gap + inset, y + ch - gap - inset],
          [x + cw - gap - inset, y + ch - gap - inset],
        ];
        for (const p of pts) rivet(a, h, r, p[0], p[1], rr, o.rivetTint ?? '#8b97a5');
      }

      // A minority of plates get a stencilled index or vent slot.
      if (o.greeble && rng() < 0.22) {
        const gw = cw * 0.34, gh = ch * 0.13;
        const gx = x + cw * 0.5 - gw / 2, gy = y + ch * 0.7;
        a.fillStyle = 'rgba(10,14,20,0.75)';
        a.fillRect(gx, gy, gw, gh);
        h.fillStyle = '#606060';
        h.fillRect(gx, gy, gw, gh);
        const slats = 4;
        for (let s = 0; s < slats; s++) {
          const sy = gy + (gh / slats) * s + k;
          a.fillStyle = 'rgba(160,180,200,0.22)';
          a.fillRect(gx + k, sy, gw - 2 * k, 1.2 * k);
        }
      }
    }
  }
}

/** Deck plating: dark blue-grey industrial floor outside the roads. */
function paintDeck(a, h, r, S, rng) {
  paintPlateGrid(a, h, r, S, rng, {
    cols: 4, rows: 4, gap: 3,
    base: '#141920', plate: '#2b323c', rough: '#a8a8a8',
    rivets: true, greeble: true, rivetTint: '#7e8996',
  });
  // Oil stains: darker albedo, smoother roughness.
  for (let i = 0; i < 10; i++) {
    const x = rng() * S, y = rng() * S, rad = S * (0.03 + rng() * 0.09);
    const g = a.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, 'rgba(6,8,12,0.55)');
    g.addColorStop(1, 'rgba(6,8,12,0)');
    a.fillStyle = g; a.beginPath(); a.arc(x, y, rad, 0, Math.PI * 2); a.fill();
    const g2 = r.createRadialGradient(x, y, 0, x, y, rad);
    g2.addColorStop(0, 'rgba(30,30,30,0.8)');
    g2.addColorStop(1, 'rgba(30,30,30,0)');
    r.fillStyle = g2; r.beginPath(); r.arc(x, y, rad, 0, Math.PI * 2); r.fill();
  }
  /* Scuff arcs.
   *
   * Plate seams and oil blooms are both *large* features; between them the
   * plate was a clean field, so a 60 m sweep of deck answered light with one
   * value and read as a shaded polygon with a grid drawn on it. Scuff arcs are
   * the sub-metre wear a walked floor actually carries - swept, directional,
   * and biased into the roughness channel more than into albedo, because
   * polished-through paint changes how a plate reflects long before it changes
   * what colour it is.
   */
  for (let i = 0; i < 44; i++) {
    const x = rng() * S, y = rng() * S;
    const rad = S * (0.02 + rng() * 0.09);
    const a0 = rng() * Math.PI * 2;
    const sweep = 0.6 + rng() * 2.2;
    a.save();
    a.strokeStyle = `rgba(178,192,208,${0.05 + rng() * 0.08})`;
    a.lineWidth = S * (0.002 + rng() * 0.005);
    a.beginPath(); a.arc(x, y, rad, a0, a0 + sweep); a.stroke();
    a.restore();
    r.save();
    r.strokeStyle = `rgba(${60 + Math.floor(rng() * 60)},60,60,0.5)`;
    r.lineWidth = S * (0.003 + rng() * 0.008);
    r.beginPath(); r.arc(x, y, rad, a0, a0 + sweep); r.stroke();
    r.restore();
  }
  // Water / coolant stains: light albedo mottle, strongly smoother roughness.
  for (let i = 0; i < 12; i++) {
    const x = rng() * S, y = rng() * S, rad = S * (0.02 + rng() * 0.06);
    const g = r.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, 'rgba(20,20,20,0.85)');
    g.addColorStop(0.7, 'rgba(70,70,70,0.4)');
    g.addColorStop(1, 'rgba(70,70,70,0)');
    r.fillStyle = g; r.beginPath(); r.arc(x, y, rad, 0, Math.PI * 2); r.fill();
    const g3 = a.createRadialGradient(x, y, 0, x, y, rad);
    g3.addColorStop(0, 'rgba(120,134,150,0.16)');
    g3.addColorStop(1, 'rgba(120,134,150,0)');
    a.fillStyle = g3; a.beginPath(); a.arc(x, y, rad, 0, Math.PI * 2); a.fill();
  }
  wearPass(a, h, r, S, rng, { streaks: 130, scratches: 150 });
  grainOverlay(a, 0.15, 24, 7, 1, 1.02, 1.06);
}

/**
 * Road surface. The texture maps 1:1 across the 18 m carriageway (U) and tiles
 * every 18 m along it (V), so lane markings, grates and joints stay in place
 * no matter how long the road is.
 */
function paintRoad(a, h, r, S, rng) {
  const k = S / 768;
  a.fillStyle = '#20252c'; a.fillRect(0, 0, S, S);
  h.fillStyle = '#8c8c8c'; h.fillRect(0, 0, S, S);
  r.fillStyle = '#a0a0a0'; r.fillRect(0, 0, S, S);

  // Longitudinal plate seams across the width.
  const seams = [0.0, 0.16, 0.33, 0.5, 0.67, 0.84];
  for (const u of seams) {
    const x = u * S;
    a.fillStyle = 'rgba(0,0,0,0.55)'; a.fillRect(x - 1.5 * k, 0, 3 * k, S);
    a.fillStyle = 'rgba(190,205,220,0.09)'; a.fillRect(x + 1.5 * k, 0, 1.5 * k, S);
    h.fillStyle = '#3c3c3c'; h.fillRect(x - 1.5 * k, 0, 3 * k, S);
  }
  // Expansion joints across the road (V), twice per tile.
  for (const v of [0.0, 0.5]) {
    const y = v * S;
    a.fillStyle = 'rgba(0,0,0,0.6)'; a.fillRect(0, y - 2 * k, S, 4 * k);
    a.fillStyle = 'rgba(200,215,230,0.08)'; a.fillRect(0, y + 2 * k, S, 2 * k);
    h.fillStyle = '#303030'; h.fillRect(0, y - 2 * k, S, 4 * k);
    r.fillStyle = '#d0d0d0'; r.fillRect(0, y - 2 * k, S, 4 * k);
  }

  // Tyre-polished wear bands.
  for (const u of [0.29, 0.71]) {
    const g = a.createLinearGradient((u - 0.09) * S, 0, (u + 0.09) * S, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.5, 'rgba(0,0,0,0.35)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    a.fillStyle = g; a.fillRect((u - 0.09) * S, 0, 0.18 * S, S);
    const g2 = r.createLinearGradient((u - 0.09) * S, 0, (u + 0.09) * S, 0);
    g2.addColorStop(0, 'rgba(60,60,60,0)');
    g2.addColorStop(0.5, 'rgba(60,60,60,0.7)');
    g2.addColorStop(1, 'rgba(60,60,60,0)');
    r.fillStyle = g2; r.fillRect((u - 0.09) * S, 0, 0.18 * S, S);
  }

  // Recessed light channels (the emissive strip itself is separate geometry).
  for (const u of [0.135, 0.865]) {
    const x = u * S;
    a.fillStyle = '#0a0d12'; a.fillRect(x - 5 * k, 0, 10 * k, S);
    h.fillStyle = '#2a2a2a'; h.fillRect(x - 5 * k, 0, 10 * k, S);
    a.fillStyle = 'rgba(120,200,235,0.16)'; a.fillRect(x - 2 * k, 0, 4 * k, S);
  }

  // Painted lane markings - worn, not pristine.
  const paint = (x, w, dash) => {
    a.save();
    a.fillStyle = '#d8dee6';
    if (dash) {
      const period = S / 3;
      for (let i = 0; i < 3; i++) {
        a.globalAlpha = 0.72 + rng() * 0.2;
        a.fillRect(x - w / 2, i * period + period * 0.15, w, period * 0.55);
        h.fillStyle = '#a4a4a4';
        h.fillRect(x - w / 2, i * period + period * 0.15, w, period * 0.55);
      }
    } else {
      a.globalAlpha = 0.78;
      a.fillRect(x - w / 2, 0, w, S);
      h.fillStyle = '#a4a4a4';
      h.fillRect(x - w / 2, 0, w, S);
    }
    a.restore();
  };
  paint(0.10 * S, S * 0.011, false);
  paint(0.90 * S, S * 0.011, false);
  paint(0.50 * S, S * 0.010, true);

  // Hazard chevrons in the outer margins.
  for (const side of [0, 1]) {
    const x0 = side === 0 ? 0.015 * S : 0.925 * S;
    const w = 0.06 * S;
    a.save();
    a.beginPath(); a.rect(x0, 0, w, S); a.clip();
    for (let i = -1; i < 16; i++) {
      a.fillStyle = i % 2 === 0 ? 'rgba(228,176,32,0.80)' : 'rgba(22,24,28,0.85)';
      a.beginPath();
      const y = (i * S) / 14;
      a.moveTo(x0 - 4, y);
      a.lineTo(x0 + w + 4, y + w * 0.9);
      a.lineTo(x0 + w + 4, y + w * 0.9 + S / 28);
      a.lineTo(x0 - 4, y + S / 28);
      a.closePath(); a.fill();
    }
    a.restore();
  }

  // Drainage grates, one pair per tile.
  const grate = (cx, cy, gw, gh) => {
    a.fillStyle = '#0c1015'; a.fillRect(cx - gw / 2, cy - gh / 2, gw, gh);
    h.fillStyle = '#404040'; h.fillRect(cx - gw / 2, cy - gh / 2, gw, gh);
    const bars = 9;
    for (let i = 0; i < bars; i++) {
      const bx = cx - gw / 2 + (gw / bars) * i + k;
      a.fillStyle = '#3a434e'; a.fillRect(bx, cy - gh / 2 + 2 * k, gw / bars - 2.5 * k, gh - 4 * k);
      h.fillStyle = '#c8c8c8'; h.fillRect(bx, cy - gh / 2 + 2 * k, gw / bars - 2.5 * k, gh - 4 * k);
    }
    a.strokeStyle = 'rgba(200,215,230,0.18)'; a.lineWidth = 2 * k;
    a.strokeRect(cx - gw / 2, cy - gh / 2, gw, gh);
    r.fillStyle = '#e0e0e0'; r.fillRect(cx - gw / 2, cy - gh / 2, gw, gh);
  };
  grate(0.22 * S, 0.25 * S, S * 0.075, S * 0.035);
  grate(0.78 * S, 0.75 * S, S * 0.075, S * 0.035);

  wearPass(a, h, r, S, rng, { streaks: 40, scratches: 50 });
  grainOverlay(a, 0.09, 20, 31, 1, 1, 1.03);
}

/** Structural hull: huge welded plates, ribs, stencilled frame numbers. */
function paintHull(a, h, r, S, rng) {
  paintPlateGrid(a, h, r, S, rng, {
    cols: 2, rows: 2, gap: 5,
    base: '#10151b', plate: '#39424e', rough: '#9a9a9a',
    rivets: true, rivetInset: 14, rivetSize: 3.4, rivetTint: '#96a2b0',
  });
  // Weld beads along the plate seams.
  const kh = S / 512;
  a.save();
  for (const u of [0.5]) {
    for (let i = 0; i < S; i += 4 * kh) {
      const w = (3 + rng() * 3) * kh;
      a.fillStyle = `rgba(${120 + rng() * 40 | 0},${128 + rng() * 40 | 0},${140 + rng() * 40 | 0},0.5)`;
      a.fillRect(u * S - w / 2, i, w, 4 * kh);
      a.fillRect(i, u * S - w / 2, 4 * kh, w);
      h.fillStyle = '#c4c4c4';
      h.fillRect(u * S - w / 2, i, w, 4 * kh);
      h.fillRect(i, u * S - w / 2, 4 * kh, w);
    }
  }
  a.restore();
  // Large-scale blotching: oxidised patches and washed-down areas that break
  // the plate grid at a frequency the eye cannot lock a repeat onto.
  for (let i = 0; i < 7; i++) {
    const x = rng() * S, y = rng() * S, rad = S * (0.10 + rng() * 0.22);
    const warm = rng() < 0.5;
    const g = a.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, warm ? 'rgba(96,62,38,0.28)' : 'rgba(120,138,158,0.16)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    a.fillStyle = g;
    a.beginPath(); a.arc(x, y, rad, 0, Math.PI * 2); a.fill();
    const g2 = r.createRadialGradient(x, y, 0, x, y, rad);
    g2.addColorStop(0, 'rgba(240,240,240,0.5)');
    g2.addColorStop(1, 'rgba(240,240,240,0)');
    r.fillStyle = g2;
    r.beginPath(); r.arc(x, y, rad, 0, Math.PI * 2); r.fill();
  }
  // Rust runs bleeding down from the upper rivet line.
  for (let i = 0; i < 9; i++) {
    const x = rng() * S, y = rng() * S * 0.6;
    const len = S * (0.12 + rng() * 0.3);
    const w = (1.5 + rng() * 3.5) * kh;
    const g = a.createLinearGradient(x, y, x, y + len);
    g.addColorStop(0, 'rgba(112,66,38,0.42)');
    g.addColorStop(1, 'rgba(112,66,38,0)');
    a.fillStyle = g; a.fillRect(x - w / 2, y, w, len);
    r.fillStyle = 'rgba(255,255,255,0.25)'; r.fillRect(x - w / 2, y, w, len);
  }
  wearPass(a, h, r, S, rng, { streaks: 80, scratches: 30 });
  grainOverlay(a, 0.13, 16, 91, 1.02, 1, 0.98);
}

/** Building cladding: fine ribbed composite panels with recessed seams. */
function paintPanel(a, h, r, S, rng) {
  paintPlateGrid(a, h, r, S, rng, {
    cols: 6, rows: 3, gap: 2,
    base: '#1a2029', plate: '#59626e', rough: '#8e8e8e',
    rivets: true, rivetInset: 6, rivetSize: 1.7, greeble: true,
  });
  // Vertical micro-ribs give the cladding a direction under grazing light.
  // A minimum 12 px pitch is enforced: below that the rib pair lands inside a
  // single texel of mip 2 and turns into a shimmering interference field.
  const kp = S / 512;
  const pitch = Math.max(12, 6 * kp);
  const rw = Math.max(3, 2 * kp);
  for (let x = 0; x < S; x += pitch) {
    h.fillStyle = 'rgba(255,255,255,0.09)'; h.fillRect(x, 0, rw, S);
    h.fillStyle = 'rgba(0,0,0,0.09)'; h.fillRect(x + pitch * 0.5, 0, rw, S);
    a.fillStyle = 'rgba(255,255,255,0.022)'; a.fillRect(x, 0, rw, S);
    a.fillStyle = 'rgba(0,0,0,0.04)'; a.fillRect(x + pitch * 0.5, 0, rw, S);
  }
  // Grime history: streaks descending from the seam line, plus a couple of
  // repair patches so a wall run is never two identical tiles side by side.
  for (let i = 0; i < 14; i++) {
    const x = rng() * S;
    const y = rng() * S * 0.7;
    const len = S * (0.1 + rng() * 0.35);
    const w = (2 + rng() * 5) * kp;
    const g = a.createLinearGradient(x, y, x, y + len);
    g.addColorStop(0, 'rgba(10,13,18,0.34)');
    g.addColorStop(1, 'rgba(10,13,18,0)');
    a.fillStyle = g; a.fillRect(x - w / 2, y, w, len);
    r.fillStyle = 'rgba(255,255,255,0.22)'; r.fillRect(x - w / 2, y, w, len);
  }
  for (let i = 0; i < 3; i++) {
    const pw = S * (0.08 + rng() * 0.1);
    const ph = S * (0.06 + rng() * 0.08);
    const px = rng() * (S - pw), py = rng() * (S - ph);
    a.fillStyle = `rgba(${96 + rng() * 40 | 0},${106 + rng() * 40 | 0},${118 + rng() * 40 | 0},0.5)`;
    a.fillRect(px, py, pw, ph);
    a.strokeStyle = 'rgba(0,0,0,0.5)'; a.lineWidth = 1.5 * kp;
    a.strokeRect(px, py, pw, ph);
    for (let b = 0; b < 6; b++) {
      rivet(a, h, r, px + 4 * kp + (pw - 8 * kp) * (b / 5), py + 4 * kp, 2 * kp, '#9aa6b4');
      rivet(a, h, r, px + 4 * kp + (pw - 8 * kp) * (b / 5), py + ph - 4 * kp, 2 * kp, '#9aa6b4');
    }
  }
  wearPass(a, h, r, S, rng, { streaks: 45, scratches: 30 });
  grainOverlay(a, 0.10, 22, 13, 1, 1.01, 1.03);
}

/** Catwalk / gantry grating. */
function paintGrate(a, h, r, S, rng) {
  // Eight bars rather than twelve: a catwalk seen at 40 m puts a 12-bar tile
  // well under one texel per bar, and the grate is the worst offender in the
  // whole set for grazing-angle shimmer.
  const k = S / 512;
  a.fillStyle = '#0b0e13'; a.fillRect(0, 0, S, S);
  h.fillStyle = '#303030'; h.fillRect(0, 0, S, S);
  r.fillStyle = '#7a7a7a'; r.fillRect(0, 0, S, S);
  const bars = 8;
  const bar = S / bars;
  for (let i = 0; i < bars; i++) {
    const y = i * bar;
    a.fillStyle = '#4c5561'; a.fillRect(0, y + 2 * k, S, bar - 6 * k);
    h.fillStyle = '#d6d6d6'; h.fillRect(0, y + 2 * k, S, bar - 6 * k);
    a.fillStyle = 'rgba(255,255,255,0.10)'; a.fillRect(0, y + 2 * k, S, 1.5 * k);
    a.fillStyle = 'rgba(0,0,0,0.45)'; a.fillRect(0, y + bar - 5 * k, S, 2 * k);
  }
  // Cross-bars welded over the top.
  for (let i = 0; i < 5; i++) {
    const x = i * (S / 5);
    a.fillStyle = 'rgba(96,108,122,0.9)'; a.fillRect(x + 4 * k, 0, 5 * k, S);
    h.fillStyle = '#f0f0f0'; h.fillRect(x + 4 * k, 0, 5 * k, S);
    a.fillStyle = 'rgba(255,255,255,0.14)'; a.fillRect(x + 4 * k, 0, 1.5 * k, S);
  }
  wearPass(a, h, r, S, rng, { streaks: 25, scratches: 40 });
  grainOverlay(a, 0.12, 18, 55);
}

/** Plaza floor: inlaid concentric bands, seams and a brushed sheen. */
function paintPlaza(a, h, r, S, rng) {
  paintPlateGrid(a, h, r, S, rng, {
    cols: 8, rows: 8, gap: 2,
    base: '#151a22', plate: '#39414d', rough: '#7a7a7a',
    rivets: false,
  });
  // Inlaid light-metal ribbons.
  const k = S / 768;
  for (let i = 0; i < 5; i++) {
    const y = (i + 0.5) * (S / 5);
    a.fillStyle = 'rgba(150,170,192,0.16)'; a.fillRect(0, y - 3 * k, S, 6 * k);
    a.fillStyle = 'rgba(90,210,240,0.10)'; a.fillRect(0, y - 1 * k, S, 2 * k);
    h.fillStyle = '#b8b8b8'; h.fillRect(0, y - 3 * k, S, 6 * k);
    r.fillStyle = '#2e2e2e'; r.fillRect(0, y - 3 * k, S, 6 * k);
  }
  wearPass(a, h, r, S, rng, { streaks: 30, scratches: 50 });
  grainOverlay(a, 0.08, 26, 77, 1, 1.01, 1.05);
}

/** Shipping crate / container skin with stencilled markings. */
function paintCrate(a, h, r, S, rng) {
  paintPlateGrid(a, h, r, S, rng, {
    cols: 1, rows: 1, gap: 4,
    base: '#0f1319', plate: '#6b7280', rough: '#a4a4a4',
    rivets: true, rivetInset: 12, rivetSize: 3,
  });
  // Corrugation.
  for (let x = 0; x < S; x += S / 16) {
    const g = a.createLinearGradient(x, 0, x + S / 16, 0);
    g.addColorStop(0, 'rgba(0,0,0,0.35)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.14)');
    g.addColorStop(1, 'rgba(0,0,0,0.35)');
    a.fillStyle = g; a.fillRect(x, 0, S / 16, S);
    const g2 = h.createLinearGradient(x, 0, x + S / 16, 0);
    g2.addColorStop(0, '#5a5a5a');
    g2.addColorStop(0.5, '#e0e0e0');
    g2.addColorStop(1, '#5a5a5a');
    h.fillStyle = g2; h.fillRect(x, 0, S / 16, S);
  }
  // Stencils.
  a.save();
  a.translate(S * 0.5, S * 0.42);
  a.fillStyle = 'rgba(232,238,246,0.82)';
  a.font = `bold ${Math.round(S * 0.14)}px "Chakra Petch","Rajdhani",sans-serif`;
  a.textAlign = 'center';
  a.fillText('KESSLER', 0, 0);
  a.font = `bold ${Math.round(S * 0.08)}px "Chakra Petch",sans-serif`;
  a.fillStyle = 'rgba(232,176,44,0.85)';
  a.fillText('CARGO / AX-' + (100 + Math.floor(rng() * 800)), 0, S * 0.11);
  a.restore();
  a.strokeStyle = 'rgba(232,176,44,0.55)';
  a.lineWidth = S * 0.012;
  a.strokeRect(S * 0.08, S * 0.08, S * 0.84, S * 0.84);
  wearPass(a, h, r, S, rng, { streaks: 55, scratches: 45 });
  grainOverlay(a, 0.14, 20, 123);
}

/** Yellow/black hazard striping for kerbs, guards and machine bases. */
function paintHazard(a, h, r, S, rng) {
  a.fillStyle = '#15171c'; a.fillRect(0, 0, S, S);
  h.fillStyle = '#909090'; h.fillRect(0, 0, S, S);
  r.fillStyle = '#c0c0c0'; r.fillRect(0, 0, S, S);
  const band = S / 4;
  a.save();
  a.translate(-S, 0);
  for (let i = 0; i < 12; i++) {
    a.fillStyle = i % 2 ? '#12141a' : '#e0aa1e';
    a.beginPath();
    a.moveTo(i * band, 0);
    a.lineTo(i * band + band, 0);
    a.lineTo(i * band + band + S, S);
    a.lineTo(i * band + S, S);
    a.closePath(); a.fill();
  }
  a.restore();
  wearPass(a, h, r, S, rng, { streaks: 50, scratches: 60 });
  grainOverlay(a, 0.16, 14, 201);
}

/**
 * Foliage.
 *
 * The planters were sampling the crate texture - a plate grid with plank seams.
 * Wrapped six times round a 1 m lobe that produces regular horizontal ribbing,
 * which is why the plaza trees photographed as ribbed grey-green pods rather
 * than as planting. Leaf-scale clutter with no repeating structure and a strong
 * height map is what makes a smooth-shaded blob read as a canopy: the silhouette
 * is a lie either way, the surface is what sells it.
 *
 * Values stay near-neutral so the material's own colour does the tinting.
 */
function paintLeaf(a, h, r, S, rng) {
  const k = S / 512;
  a.fillStyle = '#5f6a53'; a.fillRect(0, 0, S, S);
  h.fillStyle = '#4c4c4c'; h.fillRect(0, 0, S, S);
  r.fillStyle = '#d8d8d8'; r.fillRect(0, 0, S, S);

  // Two passes: a dark underlayer, then the lit leaves on top, so the canopy
  // has depth instead of one flat value.
  for (const pass of [0, 1]) {
    const count = pass ? 1500 : 700;
    for (let i = 0; i < count; i++) {
      const x = rng() * S, y = rng() * S;
      const w = (7 + rng() * 16) * k;
      const hh = w * (0.38 + rng() * 0.44);
      const ang = rng() * Math.PI * 2;
      const v = pass ? 0.72 + rng() * 0.62 : 0.34 + rng() * 0.28;
      const cr = Math.round(126 * v), cg = Math.round(150 * v), cb = Math.round(108 * v);
      a.save(); a.translate(x, y); a.rotate(ang);
      a.fillStyle = `rgb(${cr},${cg},${cb})`;
      a.beginPath(); a.ellipse(0, 0, w, hh, 0, 0, Math.PI * 2); a.fill();
      if (pass) {
        a.strokeStyle = `rgba(${cr + 40},${cg + 44},${cb + 30},0.55)`;
        a.lineWidth = Math.max(1, 1.2 * k);
        a.beginPath(); a.moveTo(-w * 0.9, 0); a.lineTo(w * 0.9, 0); a.stroke();
      }
      a.restore();

      const hv = pass ? Math.round(150 + rng() * 95) : Math.round(40 + rng() * 40);
      h.save(); h.translate(x, y); h.rotate(ang);
      h.fillStyle = `rgb(${hv},${hv},${hv})`;
      h.beginPath(); h.ellipse(0, 0, w, hh, 0, 0, Math.PI * 2); h.fill();
      h.restore();

      if (pass) {
        const rv = Math.round(158 + rng() * 62);
        r.save(); r.translate(x, y); r.rotate(ang);
        r.fillStyle = `rgb(${rv},${rv},${rv})`;
        r.beginPath(); r.ellipse(0, 0, w * 0.92, hh * 0.92, 0, 0, Math.PI * 2); r.fill();
        r.restore();
      }
    }
  }

  // Shadow pockets between leaf clusters - the ambient occlusion a blob lacks.
  for (let i = 0; i < 150; i++) {
    const x = rng() * S, y = rng() * S, rad = S * (0.018 + rng() * 0.05);
    const g = a.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, 'rgba(12,20,12,0.52)');
    g.addColorStop(1, 'rgba(12,20,12,0)');
    a.fillStyle = g; a.beginPath(); a.arc(x, y, rad, 0, Math.PI * 2); a.fill();
  }
  grainOverlay(a, 0.09, 6, 331, 1, 1.03, 0.97);
}

/**
 * Garment cloth for the ambient crowd.
 *
 * `M.crowd` had no map, no normal map and no roughness map at all - a solid
 * `MeshStandardMaterial` colour, which is the one thing CONTRACTS.md calls an
 * automatic fail, and it is why every review described the crowd as "coloured
 * plastic capsules". Values stay near-neutral because the per-instance colour
 * is the garment colour; this map supplies weave, seams and wear only.
 */
function paintCloth(a, h, r, S, rng) {
  const k = S / 512;
  a.fillStyle = '#b6b6b6'; a.fillRect(0, 0, S, S);
  h.fillStyle = '#808080'; h.fillRect(0, 0, S, S);
  r.fillStyle = '#e6e6e6'; r.fillRect(0, 0, S, S);

  // Weave: two crossed line sets at slightly different pitch so the pattern
  // never lands on the pixel grid and moires.
  for (const [pitch, alpha, angle] of [[3.1, 0.16, 0], [3.7, 0.12, Math.PI / 2]]) {
    a.save(); h.save();
    a.translate(S / 2, S / 2); a.rotate(angle); a.translate(-S / 2, -S / 2);
    h.translate(S / 2, S / 2); h.rotate(angle); h.translate(-S / 2, -S / 2);
    a.lineWidth = h.lineWidth = Math.max(1, 1.1 * k);
    for (let y = -S; y < S * 2; y += pitch * k) {
      a.strokeStyle = `rgba(148,148,148,${alpha})`;
      h.strokeStyle = 'rgba(96,96,96,0.5)';
      a.beginPath(); a.moveTo(-S, y); a.lineTo(S * 2, y); a.stroke();
      h.beginPath(); h.moveTo(-S, y); h.lineTo(S * 2, y); h.stroke();
    }
    a.restore(); h.restore();
  }

  // Panel seams and topstitching - what makes fabric read as a made garment.
  for (let i = 0; i < 14; i++) {
    const vertical = rng() < 0.6;
    const p = rng() * S;
    a.strokeStyle = 'rgba(96,98,104,0.55)';
    h.strokeStyle = 'rgba(40,40,40,0.85)';
    a.lineWidth = h.lineWidth = Math.max(1, 2.2 * k);
    a.beginPath(); h.beginPath();
    if (vertical) { a.moveTo(p, 0); a.lineTo(p, S); h.moveTo(p, 0); h.lineTo(p, S); }
    else { a.moveTo(0, p); a.lineTo(S, p); h.moveTo(0, p); h.lineTo(S, p); }
    a.stroke(); h.stroke();
    a.setLineDash([4 * k, 4 * k]);
    a.strokeStyle = 'rgba(198,198,198,0.4)';
    a.lineWidth = Math.max(1, 1.2 * k);
    a.beginPath();
    if (vertical) { a.moveTo(p + 3 * k, 0); a.lineTo(p + 3 * k, S); }
    else { a.moveTo(0, p + 3 * k); a.lineTo(S, p + 3 * k); }
    a.stroke();
    a.setLineDash([]);
  }

  // Wear at the folds: cloth is never one roughness.
  for (let i = 0; i < 90; i++) {
    const x = rng() * S, y = rng() * S, rad = S * (0.03 + rng() * 0.1);
    const g = r.createRadialGradient(x, y, 0, x, y, rad);
    const v = rng() < 0.5 ? 200 : 255;
    g.addColorStop(0, `rgba(${v},${v},${v},0.55)`);
    g.addColorStop(1, `rgba(${v},${v},${v},0)`);
    r.fillStyle = g; r.beginPath(); r.arc(x, y, rad, 0, Math.PI * 2); r.fill();
  }
  grainOverlay(a, 0.1, 5, 419);
}

/**
 * Alpha-cut leaf-cluster card.
 *
 * A convex hull is a convex hull no matter what texture is on it: three
 * independent reviews called the planters "broccoli" because a smooth
 * icosphere silhouette cannot be argued out of by surface detail. The only
 * thing that turns a ball into a plant is *holes* in the outline, which means
 * alpha-tested cards at the canopy edge. Four cells so a canopy can vary its
 * cards and not repeat the same sprig four times.
 *
 * Background stays fully transparent; alphaTest does the cutting, so there is
 * no sorting cost and the cards still cast correct shadows.
 */
function paintLeafCard(a, S, rng) {
  a.clearRect(0, 0, S, S);
  const cw = S / 2;
  for (let cell = 0; cell < 4; cell++) {
    const ox = (cell % 2) * cw, oy = Math.floor(cell / 2) * cw;
    a.save();
    a.translate(ox + cw / 2, oy + cw * 0.88);

    const sprigs = 5 + Math.floor(rng() * 3);
    for (let s = 0; s < sprigs; s++) {
      const ang = -Math.PI / 2 + (s / (sprigs - 1) - 0.5) * 2.1 + (rng() - 0.5) * 0.25;
      const len = cw * (0.42 + rng() * 0.36);
      a.save();
      a.rotate(ang + Math.PI / 2);
      // Stem.
      a.strokeStyle = 'rgba(72,84,56,0.95)';
      a.lineWidth = Math.max(1, cw * 0.008);
      a.beginPath(); a.moveTo(0, 0); a.lineTo(0, -len); a.stroke();

      const leaflets = 9 + Math.floor(rng() * 7);
      for (let i = 1; i <= leaflets; i++) {
        const t = i / leaflets;
        const y = -len * t;
        const side = i % 2 ? 1 : -1;
        const lw = cw * (0.10 + rng() * 0.06) * (1.15 - t * 0.5);
        const lh = lw * (0.42 + rng() * 0.22);
        // Value spread inside a single card: a canopy lit to one value is the
        // other half of why these read as plastic.
        const v = 0.52 + rng() * 0.62;
        const cr = Math.round(104 * v), cg = Math.round(138 * v), cb = Math.round(84 * v);
        a.save();
        a.translate(side * lw * 0.5, y);
        a.rotate(side * (0.5 + rng() * 0.5));
        a.fillStyle = `rgb(${cr},${cg},${cb})`;
        a.beginPath(); a.ellipse(0, 0, lw, lh, 0, 0, Math.PI * 2); a.fill();
        a.strokeStyle = `rgba(${cr + 34},${cg + 38},${cb + 22},0.6)`;
        a.lineWidth = Math.max(1, cw * 0.004);
        a.beginPath(); a.moveTo(-lw * 0.85, 0); a.lineTo(lw * 0.85, 0); a.stroke();
        a.restore();
      }
      a.restore();
    }
    a.restore();
  }
}

/* ------------------------------------------------------------------ */
/* Emissive / atlas painters                                           */
/* ------------------------------------------------------------------ */

const ROOM_PALETTE = [
  ['#2a3d52', '#ffd9a0', '#7fd6ff'],
  ['#3a2c3f', '#ffb06a', '#ff7fb0'],
  ['#243a37', '#d6ffca', '#7fffd0'],
  ['#2e3346', '#e8ecff', '#9fb8ff'],
];

/**
 * Lit-interior "billboard" painted behind a window pane. Silhouetted furniture
 * and a warm ceiling wash read convincingly as an occupied room from outside,
 * for the cost of one textured quad.
 */
function paintRoomGlow(a, S, rng) {
  const cells = 4;
  const cw = S / cells;
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const pal = ROOM_PALETTE[(cx + cy) % ROOM_PALETTE.length];
      const x0 = cx * cw, y0 = cy * cw;
      a.save();
      a.beginPath(); a.rect(x0, y0, cw, cw); a.clip();

      const g = a.createLinearGradient(x0, y0, x0, y0 + cw);
      g.addColorStop(0, pal[1]);
      g.addColorStop(0.28, pal[0]);
      g.addColorStop(1, '#05070b');
      a.fillStyle = g; a.fillRect(x0, y0, cw, cw);

      // Ceiling strip.
      a.fillStyle = pal[1];
      a.fillRect(x0 + cw * 0.1, y0 + cw * 0.06, cw * 0.8, cw * 0.035);

      // Back wall panelling.
      a.globalAlpha = 0.25;
      for (let i = 1; i < 6; i++) {
        a.fillStyle = '#000';
        a.fillRect(x0 + (cw / 6) * i, y0, 2, cw);
      }
      a.globalAlpha = 1;

      // Furniture silhouettes.
      const n = 2 + Math.floor(rng() * 3);
      for (let i = 0; i < n; i++) {
        const fw = cw * (0.12 + rng() * 0.24);
        const fh = cw * (0.14 + rng() * 0.3);
        const fx = x0 + cw * 0.08 + rng() * (cw * 0.84 - fw);
        const fy = y0 + cw - cw * 0.06 - fh;
        a.fillStyle = 'rgba(4,6,10,0.86)';
        a.fillRect(fx, fy, fw, fh);
        a.fillStyle = 'rgba(255,255,255,0.06)';
        a.fillRect(fx, fy, fw, 2);
      }
      // A screen or terminal.
      if (rng() < 0.7) {
        const sw = cw * 0.16, sh = cw * 0.1;
        const sx = x0 + cw * 0.12 + rng() * (cw * 0.6);
        const sy = y0 + cw * 0.4;
        a.fillStyle = pal[2];
        a.fillRect(sx, sy, sw, sh);
        a.fillStyle = 'rgba(0,0,0,0.4)';
        for (let l = 0; l < 4; l++) a.fillRect(sx + 2, sy + 2 + l * (sh / 4), sw - 4, 1);
      }
      // Occasional figure.
      if (rng() < 0.35) {
        const px = x0 + cw * 0.2 + rng() * cw * 0.55;
        const py = y0 + cw * 0.98;
        a.fillStyle = 'rgba(2,3,6,0.9)';
        a.beginPath();
        a.ellipse(px, py - cw * 0.13, cw * 0.035, cw * 0.13, 0, 0, Math.PI * 2);
        a.fill();
        a.beginPath();
        a.arc(px, py - cw * 0.29, cw * 0.032, 0, Math.PI * 2);
        a.fill();
      }
      a.restore();
    }
  }
}

/*
 * Signage atlas layout.
 *
 * Round 2 shipped two hero frames with the *same* sign rendered twice, stacked
 * vertically at two scales, because the gantry board and the portal lintel were
 * both handed the same cell. The fix is not "randomise harder" - it is to give
 * the atlas enough cells that every sign role owns its own text, and then to
 * assign by role (see SIGN_ROLE below) instead of by index arithmetic.
 */

const SIGNS = [
  ['NOVA RAMEN', 'HOT BROTH 24/7', '#ff8a3c'],
  ['ORBITAL OUTFITTERS', 'EVA & TECHWEAR', '#4fe3ff'],
  ['VEGA HYDROPONICS', 'REAL GREEN, NO PRINT', '#6cff9e'],
  ['THE SLOW BURN', 'CAFE + BUNKS', '#ffc857'],
  ['KESSLER SALVAGE', 'WE BUY ANYTHING', '#ff5f6d'],
  ['IONWORKS TOOLS', 'RATED TO 9 ATM', '#8fb8ff'],
  ['PALE HORSE', 'BAR / NO CREDIT', '#ff6fd8'],
  ['TITAN NOODLE CO', 'BOWL 4 CR', '#ffd166'],
  ['HELIOS OPTICS', 'LENSES + SIGHTS', '#7ef9ff'],
  ['DRIFT & CO', 'CARGO BROKERS', '#c0d4ff'],
  ['RING 7 CLINIC', 'TRAUMA / TRIAGE', '#ff7a7a'],
  ['SUNSIDE LAUNDRY', 'PRESSED IN 1HR', '#a8ffdd'],
  ['DOCK 4 // ARRIVALS', 'HOLD YELLOW LINE', '#ffb020'],
  ['SECTOR MAP', 'YOU ARE HERE', '#4fe3ff'],
  ['CAUTION', 'PRESSURE DOOR', '#ffcc33'],
  ['AETHER NEXUS', 'GATEWAY PLAZA', '#7fe9ff'],
  // --- wayfinding, reserved by role: never share a cell with a shop fascia ---
  ['GATEWAY 01', 'ASHFALL REACH', '#ffb347'],
  ['GATEWAY 02', 'MERIDIAN COMPLEX', '#5cffb0'],
  /* The two approach boards, on the gateway axis about 20 m in front of each
   * arch. They used to read PLATFORM A and PLATFORM B - generic transit
   * wayfinding hung directly over the doors to two other worlds, and the only
   * sign a player reads on the walk in. The copy names the destination now;
   * the lintel 20 m behind still carries the gateway number, so the two boards
   * complement each other instead of competing. */
  ['ASHFALL REACH', 'GATEWAY 01 AHEAD', '#ffb347'],
  ['MERIDIAN COMPLEX', 'GATEWAY 02 AHEAD', '#5cffb0'],
  ['RING CONCOURSE', 'LEVEL 2 // PROMENADE', '#7fe9ff'],
  ['TRANSIT CONTROL', 'REPORT ANOMALIES', '#c0d4ff'],
  ['HYDRO GALLERY', 'QUIET ZONE PLEASE', '#6cff9e'],
  ['MUSTER POINT 3', 'FOLLOW THE GREEN LINE', '#4dffa6'],
  // The two axis gateways. They had no placard at all, so from the plaza they
  // were the only doors on the station a player could not name before walking
  // into them - the other two announce themselves from thirty metres.
  ['GATEWAY 03', 'SUNSPIRE CITADEL', '#ffc46b'],
  ['GATEWAY 04', 'VELLUM RIDGE', '#ff5a3c'],
  ['RING 4 AIRLOCK', 'SUIT CHECK REQUIRED', '#8fb8ff'],
  ['OBSERVATION', 'MIND THE GLASS', '#7fe9ff'],
  /* --- The outer ring ------------------------------------------------
   * One board per zone, hung over the link mouth and again at the arrival
   * plaza, plus the four placards the zones themselves need. These are the
   * only wayfinding a player gets between leaving the plaza and arriving
   * somewhere 500 m away, so the copy names the destination rather than the
   * corridor - "THE LONG GALLEY", not "LINK 4". */
  ['HAB RING C', 'CREW QUARTERS // DECKS 1-7', '#8fe6c8'],
  ['DECK 9 ATHLETICS', 'CREW CONDITIONING', '#c9b0ff'],
  ['RING 8 EXPANSION', 'HARD HAT AREA', '#ff9d6a'],
  ['THE LONG GALLEY', 'MESS + PROVISIONS', '#ffc98a'],
  ['GALLEY PROVISIONS', 'RATIONS / MEDICAL / KIT', '#ffc857'],
  ['ORDER HERE', 'TAP TO PAY // COLLECT LEFT', '#ffd166'],
  ['RACK YOUR WEIGHTS', 'SPOTTERS ON THE BENCH', '#c9b0ff'],
  ['SCAFFOLD ACCESS', 'CLIP ON ABOVE 2 M', '#ffb020'],
  // --- Gateway 05: the maze. Appended, never inserted - SIGN_ROLE indexes
  //     this array positionally and inserting would re-label every sign after
  //     the insertion point.
  ['GATEWAY 05', 'THE VERDANT COIL', '#8fd67a'],
  ['THE VERDANT COIL', 'GATEWAY 05 AHEAD', '#8fd67a'],
  ['NO WAY BACK BUT THROUGH', 'HEDGE MAZE // NO EQUIPMENT', '#8fd67a'],
  ['LOST PROPERTY', 'ENQUIRE AT GATEWAY 05', '#8fe6c8'],
];

/**
 * Cell reservations by role. A sign's text is a function of what the sign *is*,
 * not of where it happens to fall in a loop counter, so two signs in the same
 * 40 m cluster can never carry identical copy.
 */
const SIGN_ROLE = {
  shopFirst: 0,          // cells 0-11 belong to the commercial strip
  dock: 12,
  sectorMap: 13,
  caution: 14,
  plaza: 15,
  gatewayMedieval: 16,
  gatewaySports: 17,
  approachA: 18,
  approachB: 19,
  concourse: 20,
  control: 21,
  hydro: 22,
  muster: 23,
  gatewayCitadel: 24,
  gatewayRace: 25,
  airlock: 26,
  observation: 27,
  // The outer ring. `ZONES[i].signCell` in station/StationKit.js points at
  // these four; keep the two in step or a link will announce the wrong zone.
  zoneHabitation: 28,
  zoneGym: 29,
  zoneConstruction: 30,
  zoneCanteen: 31,
  galleyStall: 32,
  orderPoint: 33,
  gymNotice: 34,
  siteNotice: 35,
  gatewayMaze: 36,
  approachMaze: 37,
  mazeWarning: 38,
  lostProperty: 39,
};

/** Atlas of holographic signage - one texture, one draw call. */
function paintSignAtlas(a, W, H, rng) {
  const cells = SIGN_COLS * SIGN_ROWS;
  const cw = W / SIGN_COLS, ch = H / SIGN_ROWS;
  a.fillStyle = '#000'; a.fillRect(0, 0, W, H);
  for (let i = 0; i < cells; i++) {
    const cx = (i % SIGN_COLS) * cw;
    const cy = Math.floor(i / SIGN_COLS) * ch;
    const [name, sub, accent] = SIGNS[i];
    a.save();
    a.beginPath(); a.rect(cx, cy, cw, ch); a.clip();
    a.translate(cx, cy);

    // Backing plate with a subtle vertical falloff.
    const g = a.createLinearGradient(0, 0, 0, ch);
    g.addColorStop(0, '#0a1018');
    g.addColorStop(1, '#04070c');
    a.fillStyle = g; a.fillRect(0, 0, cw, ch);

    // Accent bar + frame.
    a.fillStyle = accent;
    a.fillRect(cw * 0.05, ch * 0.08, cw * 0.02, ch * 0.84);
    a.globalAlpha = 0.35;
    a.strokeStyle = accent; a.lineWidth = 3;
    a.strokeRect(cw * 0.03, ch * 0.06, cw * 0.94, ch * 0.88);
    a.globalAlpha = 1;

    /* Text, to a legibility floor rather than to a layout.
     *
     * Two rules, both absolute: the primary line never falls under 13% of cell
     * height and the secondary never under 7%. If a string cannot meet that at
     * the available width it gets condensed rather than shrunk, because an
     * empty band reads better than noise and a squashed word still reads as a
     * word. Both lines also get an opaque backing bar - emissive glyphs bloom
     * into their own housing without one, which is what turned the subtitles
     * into grey smears in the first place.
     */
    a.textAlign = 'left';
    a.textBaseline = 'middle';
    const MIN_PRIMARY = ch * 0.13;
    let fs = Math.round(ch * 0.30);
    const setFont = (w, size, stretch) =>
      (a.font = `${w} ${Math.round(size)}px ${stretch}"Chakra Petch","Rajdhani",sans-serif`);
    setFont(700, fs, '');
    while (a.measureText(name).width > cw * 0.82 && fs > MIN_PRIMARY) {
      fs -= 2;
      setFont(700, fs, '');
    }
    // Below the floor we condense instead of shrinking further.
    let squeeze = 1;
    if (a.measureText(name).width > cw * 0.82) squeeze = (cw * 0.82) / a.measureText(name).width;

    // Backing bars: an unlit field for the glyphs to sit on.
    a.fillStyle = 'rgba(3,5,9,0.88)';
    a.fillRect(cw * 0.09, ch * 0.42 - fs * 0.62, cw * 0.86, fs * 1.24);
    const subFs = Math.round(ch * 0.17);
    a.fillStyle = 'rgba(3,5,9,0.78)';
    a.fillRect(cw * 0.09, ch * 0.71 - subFs * 0.72, cw * 0.60, subFs * 1.44);

    a.save();
    a.translate(cw * 0.11, ch * 0.42);
    a.scale(squeeze, 1);
    a.shadowColor = accent;
    a.shadowBlur = ch * 0.09;
    a.fillStyle = '#ffffff';
    setFont(700, fs, '');
    a.fillText(name, 0, 0);
    a.restore();
    a.shadowBlur = 0;

    a.save();
    a.translate(cw * 0.11, ch * 0.71);
    setFont(600, subFs, '');
    const subW = a.measureText(sub).width;
    if (subW > cw * 0.56) a.scale((cw * 0.56) / subW, 1);
    a.fillStyle = accent;
    a.fillText(sub, 0, 0);
    a.restore();

    // Registration ticks + a fake barcode for texture.
    a.fillStyle = 'rgba(255,255,255,0.30)';
    for (let b = 0; b < 26; b++) {
      const bw = (1 + rng() * 3) * (cw / 512);
      a.fillRect(cw * 0.72 + b * (cw / 512) * 6, ch * 0.80, bw, ch * 0.09);
    }

    // Scanlines sell the "hologram" read. Spaced against cell height rather
    // than in pixels, so raising the atlas resolution does not turn them into
    // a sub-texel moire pattern the mip chain has to average away to grey.
    a.globalAlpha = 0.13;
    a.fillStyle = '#000';
    const sl = ch / 48;
    for (let y = 0; y < ch; y += sl) a.fillRect(0, y, cw, sl * 0.45);
    a.globalAlpha = 1;
    a.restore();
  }
}

const DECALS = [
  'chevron', 'arrow', 'circle', 'keepclear',
  'number', 'radiation', 'noentry', 'crosshatch',
  'dock', 'grate', 'stain', 'cable',
  'stop', 'walk', 'load', 'vent',
];

/** 4x4 atlas of floor decals, drawn with alpha so they sit over the plating. */
function paintDecalAtlas(a, S, rng) {
  const cw = S / 4;
  a.clearRect(0, 0, S, S);
  for (let i = 0; i < 16; i++) {
    const cx = (i % 4) * cw + cw / 2;
    const cy = Math.floor(i / 4) * cw + cw / 2;
    const k = DECALS[i];
    a.save();
    a.translate(cx, cy);
    a.lineCap = 'square';
    const amber = 'rgba(226,172,40,0.85)';
    const white = 'rgba(222,232,244,0.80)';
    const red = 'rgba(220,70,60,0.85)';

    if (k === 'chevron') {
      a.strokeStyle = amber; a.lineWidth = cw * 0.09;
      for (let j = -1; j <= 1; j++) {
        a.beginPath();
        a.moveTo(-cw * 0.34, j * cw * 0.24 + cw * 0.1);
        a.lineTo(0, j * cw * 0.24 - cw * 0.12);
        a.lineTo(cw * 0.34, j * cw * 0.24 + cw * 0.1);
        a.stroke();
      }
    } else if (k === 'arrow') {
      a.fillStyle = white;
      a.beginPath();
      a.moveTo(0, -cw * 0.36);
      a.lineTo(cw * 0.22, -cw * 0.05);
      a.lineTo(cw * 0.08, -cw * 0.05);
      a.lineTo(cw * 0.08, cw * 0.36);
      a.lineTo(-cw * 0.08, cw * 0.36);
      a.lineTo(-cw * 0.08, -cw * 0.05);
      a.lineTo(-cw * 0.22, -cw * 0.05);
      a.closePath(); a.fill();
    } else if (k === 'circle' || k === 'dock') {
      a.strokeStyle = k === 'dock' ? amber : white;
      a.lineWidth = cw * 0.05;
      a.beginPath(); a.arc(0, 0, cw * 0.33, 0, Math.PI * 2); a.stroke();
      a.lineWidth = cw * 0.03;
      a.beginPath(); a.arc(0, 0, cw * 0.22, 0, Math.PI * 2); a.stroke();
      a.setLineDash([cw * 0.06, cw * 0.06]);
      a.beginPath(); a.arc(0, 0, cw * 0.42, 0, Math.PI * 2); a.stroke();
      a.setLineDash([]);
    } else if (k === 'keepclear' || k === 'stop' || k === 'walk' || k === 'load') {
      const label = { keepclear: 'KEEP CLEAR', stop: 'HOLD', walk: 'WALKWAY', load: 'LOAD ZONE' }[k];
      a.fillStyle = k === 'stop' ? red : white;
      a.font = `700 ${Math.round(cw * 0.15)}px "Chakra Petch",sans-serif`;
      a.textAlign = 'center'; a.textBaseline = 'middle';
      a.fillText(label, 0, 0);
      a.strokeStyle = a.fillStyle; a.lineWidth = cw * 0.03;
      a.strokeRect(-cw * 0.4, -cw * 0.2, cw * 0.8, cw * 0.4);
    } else if (k === 'number') {
      a.fillStyle = white;
      a.font = `700 ${Math.round(cw * 0.5)}px "Chakra Petch",sans-serif`;
      a.textAlign = 'center'; a.textBaseline = 'middle';
      a.fillText('07', 0, 0);
    } else if (k === 'radiation' || k === 'noentry') {
      a.strokeStyle = k === 'radiation' ? amber : red;
      a.lineWidth = cw * 0.06;
      a.beginPath(); a.arc(0, 0, cw * 0.34, 0, Math.PI * 2); a.stroke();
      a.fillStyle = a.strokeStyle;
      if (k === 'radiation') {
        for (let s = 0; s < 3; s++) {
          a.beginPath();
          a.moveTo(0, 0);
          a.arc(0, 0, cw * 0.28, s * 2.094 - 0.5, s * 2.094 + 0.5);
          a.closePath(); a.fill();
        }
      } else {
        a.fillRect(-cw * 0.3, -cw * 0.06, cw * 0.6, cw * 0.12);
      }
    } else if (k === 'crosshatch' || k === 'grate') {
      a.strokeStyle = k === 'grate' ? 'rgba(150,170,190,0.5)' : 'rgba(226,172,40,0.5)';
      a.lineWidth = cw * 0.035;
      for (let j = -5; j <= 5; j++) {
        a.beginPath();
        a.moveTo(-cw * 0.42, j * cw * 0.09);
        a.lineTo(cw * 0.42, j * cw * 0.09 + (k === 'grate' ? 0 : cw * 0.3));
        a.stroke();
      }
      a.strokeRect(-cw * 0.42, -cw * 0.42, cw * 0.84, cw * 0.84);
    } else if (k === 'stain') {
      const g = a.createRadialGradient(0, 0, 0, 0, 0, cw * 0.46);
      g.addColorStop(0, 'rgba(0,0,0,0.55)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      a.fillStyle = g;
      a.beginPath(); a.arc(0, 0, cw * 0.46, 0, Math.PI * 2); a.fill();
    } else if (k === 'cable') {
      a.strokeStyle = 'rgba(18,20,26,0.85)';
      for (let j = 0; j < 4; j++) {
        a.lineWidth = cw * (0.03 + rng() * 0.03);
        a.beginPath();
        a.moveTo(-cw * 0.48, -cw * 0.2 + j * cw * 0.12);
        a.bezierCurveTo(-cw * 0.1, -cw * 0.3 + j * cw * 0.14, cw * 0.1, cw * 0.2 + j * cw * 0.1, cw * 0.48, -cw * 0.1 + j * cw * 0.12);
        a.stroke();
      }
    } else if (k === 'vent') {
      a.fillStyle = 'rgba(14,17,22,0.8)';
      a.fillRect(-cw * 0.4, -cw * 0.28, cw * 0.8, cw * 0.56);
      a.fillStyle = 'rgba(140,158,178,0.55)';
      for (let j = 0; j < 7; j++) a.fillRect(-cw * 0.36, -cw * 0.24 + j * cw * 0.075, cw * 0.72, cw * 0.035);
    }
    a.restore();
  }

  /* Edge wear.
   *
   * Painted markings on a deck that carries freight traffic do not have crisp
   * corners: the tips of a chevron and the corners of a stencil scuff through
   * to the plate first. Eroding the atlas alpha with a scatter of soft
   * punch-outs plus a coarse dry-brush band is the difference between "painted
   * marking" and "decal sheet composited over 3D". It also breaks the perfect
   * repeat between the sixteen cells, which is otherwise very visible when a
   * chevron run repeats the same tile eight times down an avenue.
   */
  a.save();
  a.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 900; i++) {
    const x = rng() * S, y = rng() * S;
    const rad = S * (0.002 + rng() * 0.012);
    const g = a.createRadialGradient(x, y, 0, x, y, rad);
    const strength = 0.25 + rng() * 0.55;
    g.addColorStop(0, `rgba(0,0,0,${strength})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    a.fillStyle = g;
    a.beginPath(); a.arc(x, y, rad, 0, Math.PI * 2); a.fill();
  }
  // Dry-brush streaks along the traffic axis - wear is directional.
  for (let i = 0; i < 160; i++) {
    const x = rng() * S, y = rng() * S;
    const w = S * (0.02 + rng() * 0.09);
    a.fillStyle = `rgba(0,0,0,${0.12 + rng() * 0.3})`;
    a.fillRect(x, y, w, S * (0.002 + rng() * 0.006));
  }
  a.restore();
}

/** Equirectangular deep-space backdrop: nebula, galactic band, star field. */
function paintStars(a, W, H, rng) {
  a.fillStyle = '#02030a'; a.fillRect(0, 0, W, H);

  // Nebula clouds - a few large soft blobs in teal and violet.
  for (let i = 0; i < 26; i++) {
    const x = rng() * W;
    const y = H * (0.2 + rng() * 0.6);
    const rad = W * (0.04 + rng() * 0.16);
    const teal = rng() < 0.5;
    const g = a.createRadialGradient(x, y, 0, x, y, rad);
    if (teal) {
      g.addColorStop(0, 'rgba(30,110,150,0.20)');
      g.addColorStop(0.5, 'rgba(20,60,110,0.09)');
    } else {
      g.addColorStop(0, 'rgba(110,50,140,0.18)');
      g.addColorStop(0.5, 'rgba(60,30,110,0.08)');
    }
    g.addColorStop(1, 'rgba(0,0,0,0)');
    a.fillStyle = g;
    a.beginPath(); a.arc(x, y, rad, 0, Math.PI * 2); a.fill();
  }

  // Galactic band across the equator.
  a.save();
  const band = a.createLinearGradient(0, H * 0.34, 0, H * 0.66);
  band.addColorStop(0, 'rgba(0,0,0,0)');
  band.addColorStop(0.5, 'rgba(120,140,190,0.10)');
  band.addColorStop(1, 'rgba(0,0,0,0)');
  a.fillStyle = band;
  a.fillRect(0, H * 0.34, W, H * 0.32);
  a.restore();

  // Stars: many faint, few bright, with occasional coloured giants.
  for (let i = 0; i < 5200; i++) {
    const x = rng() * W;
    const y = rng() * H;
    // Concentrate along the band.
    const bandBias = Math.exp(-Math.pow((y / H - 0.5) / 0.16, 2));
    if (rng() > 0.35 + bandBias * 0.65) continue;
    const b = Math.pow(rng(), 3.2);
    const rad = 0.35 + b * 2.1;
    const hue = rng();
    let colr = 255, colg = 255, colb = 255;
    if (hue < 0.18) { colr = 190; colg = 210; colb = 255; }
    else if (hue > 0.88) { colr = 255; colg = 205; colb = 170; }
    a.fillStyle = `rgba(${colr},${colg},${colb},${0.18 + b * 0.82})`;
    a.beginPath(); a.arc(x, y, rad, 0, Math.PI * 2); a.fill();
    if (b > 0.72) {
      a.strokeStyle = `rgba(${colr},${colg},${colb},${0.10 + b * 0.2})`;
      a.lineWidth = 0.7;
      a.beginPath();
      a.moveTo(x - rad * 4.5, y); a.lineTo(x + rad * 4.5, y);
      a.moveTo(x, y - rad * 4.5); a.lineTo(x, y + rad * 4.5);
      a.stroke();
    }
  }
}

/** Gas-giant albedo: banded turbulence with a storm and polar haze. */
function paintPlanet(a, W, H, rng) {
  const base = a.createLinearGradient(0, 0, 0, H);
  base.addColorStop(0.00, '#8f6f4a');
  base.addColorStop(0.18, '#c8a878');
  base.addColorStop(0.35, '#e6d3b0');
  base.addColorStop(0.50, '#b9926a');
  base.addColorStop(0.66, '#e2cdaa');
  base.addColorStop(0.82, '#a87e58');
  base.addColorStop(1.00, '#6d5238');
  a.fillStyle = base; a.fillRect(0, 0, W, H);

  // Turbulent bands: sinusoidally displaced horizontal streaks.
  for (let i = 0; i < 220; i++) {
    const y = rng() * H;
    const th = 2 + rng() * 16;
    const light = rng() < 0.5;
    a.globalAlpha = 0.06 + rng() * 0.14;
    a.fillStyle = light ? '#fff2d8' : '#5c422c';
    a.beginPath();
    a.moveTo(0, y);
    const amp = 2 + rng() * 9;
    const freq = 1 + Math.floor(rng() * 5);
    for (let x = 0; x <= W; x += 12) a.lineTo(x, y + Math.sin((x / W) * Math.PI * 2 * freq) * amp);
    for (let x = W; x >= 0; x -= 12) a.lineTo(x, y + th + Math.sin((x / W) * Math.PI * 2 * freq) * amp);
    a.closePath(); a.fill();
  }
  a.globalAlpha = 1;

  // The storm.
  const sx = W * 0.62, sy = H * 0.62;
  const g = a.createRadialGradient(sx, sy, 0, sx, sy, W * 0.075);
  g.addColorStop(0, 'rgba(214,96,60,0.95)');
  g.addColorStop(0.55, 'rgba(178,80,52,0.7)');
  g.addColorStop(1, 'rgba(178,80,52,0)');
  a.save();
  a.translate(sx, sy); a.scale(1, 0.5); a.translate(-sx, -sy);
  a.fillStyle = g;
  a.beginPath(); a.arc(sx, sy, W * 0.075, 0, Math.PI * 2); a.fill();
  a.restore();

  // Polar haze.
  const pole = a.createLinearGradient(0, 0, 0, H * 0.1);
  pole.addColorStop(0, 'rgba(180,205,235,0.55)');
  pole.addColorStop(1, 'rgba(180,205,235,0)');
  a.fillStyle = pole; a.fillRect(0, 0, W, H * 0.1);
  a.save();
  a.translate(0, H); a.scale(1, -1);
  a.fillStyle = pole; a.fillRect(0, 0, W, H * 0.1);
  a.restore();
}

/** Vertical white->black ramp used as the falloff for light shafts. */
function makeRampTexture(aniso) {
  const c = makeCanvas(8, 128);
  const x = ctx2d(c);
  const g = x.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0.0, '#ffffff');
  g.addColorStop(0.35, '#8d8d8d');
  g.addColorStop(1.0, '#000000');
  x.fillStyle = g; x.fillRect(0, 0, 8, 128);
  const t = canvasTexture(c, false, aniso);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/**
 * Very-low-frequency tileable fbm. Sampled at a tiny UV scale inside the panel
 * and hull shaders, it multiplies a large-scale value/roughness drift over the
 * tiled detail so the eye cannot lock onto the repeat of the base tile.
 */
function makeMacroNoise(aniso) {
  const S = 256;
  const c = makeCanvas(S);
  const x = ctx2d(c);
  const img = x.createImageData(S, S);
  const d = img.data;
  for (let y = 0; y < S; y++) {
    for (let i = 0; i < S; i++) {
      // Two decorrelated octave stacks: broad blotching plus a slower drift.
      const n = tfbm(i / S * 4, y / S * 4, 4, 909, 4) * 0.65 + tfbm(i / S * 1.5, y / S * 1.5, 2, 313, 3) * 0.35;
      const v = Math.max(0, Math.min(255, Math.round(n * 255)));
      const k = (y * S + i) * 4;
      d[k] = d[k + 1] = d[k + 2] = v;
      d[k + 3] = 255;
    }
  }
  x.putImageData(img, 0, 0);
  return canvasTexture(c, false, aniso);
}

/**
 * Inverted radial blob: black at the centre, white at the rim. Rendered with
 * multiply blending it is a contact-occlusion patch - the cheapest way to seat
 * a prop on the deck when the AO pass only resolves at metre scale.
 */
function makeContactTexture(aniso) {
  const S = 128;
  const c = makeCanvas(S);
  const x = ctx2d(c);
  const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  // Tighter and darker than before. These patches were being described as
  // invisible in review, and the reason is the falloff: a gradient that is
  // already half-strength at 45% of the radius spreads its occlusion over the
  // whole patch and darkens nothing in particular. Contact occlusion is a
  // *small, dark* term right where two surfaces meet, with a fast falloff.
  g.addColorStop(0.0, 'rgba(14,17,23,1)');
  g.addColorStop(0.30, 'rgba(74,82,95,1)');
  g.addColorStop(0.62, 'rgba(178,184,196,1)');
  g.addColorStop(1.0, 'rgba(255,255,255,1)');
  x.fillStyle = g; x.fillRect(0, 0, S, S);
  const t = canvasTexture(c, false, aniso);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/**
 * Broad, soft, blotchy dirt patch - multiply-blended onto the deck.
 *
 * `makeContactTexture` is deliberately a *tight, dark* falloff for the 20 cm
 * where a prop meets the floor; scaled up to 15 m it just punches a black hole.
 * Grime is the other half of the same problem: the near-camera deck is 40% of a
 * street-level frame and the macro octaves in `withMacro` all have periods
 * either far longer or far shorter than a single plate, so a 12 m tile answers
 * light with one value. This is a gentle, irregular, *aperiodic* darkening - no
 * two instances share a rotation or a size - that gives the foreground plate
 * traffic pooling at the one frequency the shader cannot supply.
 */
function makeGrimeTexture(aniso) {
  const S = 256;
  const c = makeCanvas(S);
  const x = ctx2d(c);
  x.fillStyle = '#ffffff';
  x.fillRect(0, 0, S, S);
  const rng = mulberry32(0x6d13);
  // Irregular soft lobes, all inside a radius that leaves the border white so
  // the patch dissolves into the deck instead of ending on an edge.
  for (let i = 0; i < 26; i++) {
    const a = rng() * Math.PI * 2;
    const d = rng() * S * 0.26;
    const cx = S / 2 + Math.cos(a) * d;
    const cy = S / 2 + Math.sin(a) * d;
    const r = S * (0.09 + rng() * 0.15);
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
    const v = 150 + Math.floor(rng() * 55);
    g.addColorStop(0, `rgba(${v},${v + 4},${v + 10},0.55)`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g;
    x.beginPath(); x.arc(cx, cy, r, 0, 6.2832); x.fill();
  }
  // Hard-mask the border to pure white so instances never tile-seam.
  const edge = x.createRadialGradient(S / 2, S / 2, S * 0.30, S / 2, S / 2, S * 0.5);
  edge.addColorStop(0, 'rgba(255,255,255,0)');
  edge.addColorStop(1, 'rgba(255,255,255,1)');
  x.fillStyle = edge;
  x.fillRect(0, 0, S, S);
  const t = canvasTexture(c, false, aniso);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Soft radial blob used for ground light pools and glow sprites. */
function makeRadialTexture(aniso, hard = 0.0) {
  const S = 256;
  const c = makeCanvas(S);
  const x = ctx2d(c);
  const g = x.createRadialGradient(S / 2, S / 2, S * hard * 0.5, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.42)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, S, S);
  const t = canvasTexture(c, false, aniso);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                    */
/* ------------------------------------------------------------------ */

/**
 * Rescale a single-segment BoxGeometry's UVs so texel density is constant in
 * world space regardless of the box dimensions. Face order in BoxGeometry is
 * px, nx, py, ny, pz, nz - four vertices each.
 */

/**
 * A canopy lobe with occlusion baked into its vertex colours.
 *
 * The lobes were lit identically top and bottom, which is the single reason
 * they photographed as plastic balls rather than as planting: a real canopy is
 * a stack of translucent layers and its underside sits two stops down. There
 * is no cheap way to compute that at runtime for a merged static mesh, so it
 * is baked - downward-facing vertices darken, and an extra term darkens
 * vertices facing back toward the trunk axis so the canopy interior is not as
 * bright as its outside.
 *
 * @param {number} radius
 * @param {[number,number,number]} scale non-uniform lobe scale; a sphere is a ball
 * @param {number} uv      uv repeat (leaf-scale clutter, not melon stripes)
 * @param {number} shade   per-lobe value multiplier, for canopy-internal range
 * @param {number} inward  0..1 direction back toward the trunk, in local X/Z
 */
function foliageLobe(radius, scale, uv, shade, inwardX = 0, inwardZ = 0, hue = 0) {
  /* Detail level 2, not 1.
   *
   * At level 1 an icosphere is eighty flat facets, and a flat facet the size of
   * a leaf cluster is what makes a canopy read as a faceted rock. Level 2 is
   * four times the triangles on a 0.5 m lobe - trivial in absolute terms, and
   * the difference between a smooth mass and a low-poly blob at the screen
   * sizes these actually occupy.
   */
  const geo = new THREE.IcosahedronGeometry(radius, 2);
  /* Radial displacement before scaling.
   *
   * A perfect spheroid has no silhouette information at all: every profile is
   * the same arc, which is precisely why these photographed as moss balls. A
   * deterministic per-vertex push along the normal breaks the outline into
   * lobes and hollows, so the shape reads as a plant mass rather than as a
   * primitive - and it costs nothing at runtime because it is baked here.
   */
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
    const l = Math.hypot(px, py, pz) || 1;
    const k = 0.74 + tfbm(px * 1.9 / radius + 4, pz * 1.9 / radius + hue * 7 + 2, 6, 41, 3) * 0.62
      + tnoise(py * 3.1 / radius + 9, px * 3.1 / radius + 1, 8, 77) * 0.22;
    pos.setXYZ(i, (px / l) * radius * k, (py / l) * radius * k, (pz / l) * radius * k);
  }
  pos.needsUpdate = true;
  geo.scale(scale[0], scale[1], scale[2]);
  geo.computeVertexNormals();
  uvScale(geo, uv, uv);
  const nrm = geo.getAttribute('normal');
  const n = nrm.count;
  const col = new Float32Array(n * 3);
  const il = Math.hypot(inwardX, inwardZ) || 1;
  const ix = inwardX / il, iz = inwardZ / il;
  for (let i = 0; i < n; i++) {
    const nx = nrm.getX(i), ny = nrm.getY(i), nz = nrm.getZ(i);
    // Underside occlusion: -1 (straight down) -> 0.30, +0.6 up -> 1.0.
    const down = Math.min(1, Math.max(0, (ny + 0.85) / 1.45));
    let v = 0.30 + (down * down * (3 - 2 * down)) * 0.70;
    // Interior occlusion: the face pointing back at the trunk sees no sky.
    v *= 1 - 0.28 * Math.min(1, Math.max(0, nx * ix + nz * iz));
    // Leaf-cluster value break, so the lobe is not one flat tone even where
    // the geometry is smooth. This is the high-frequency detail the reviewers
    // could not find anywhere on the canopies.
    v *= 0.78 + tfbm(pos.getX(i) * 5.0 + 11, pos.getZ(i) * 5.0 + 3, 8, 53, 3) * 0.46;
    v *= shade;
    col[i * 3] = v * (1 - hue * 0.16);
    col[i * 3 + 1] = v * 1.03;
    col[i * 3 + 2] = v * (0.9 - hue * 0.20);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** Build an InstancedMesh from [x,y,z,rx,ry,rz,sx,sy,sz] tuples. */

/* ================================================================== */
/* StationWorld                                                        */
/* ================================================================== */

export class StationWorld extends World {
  static id = 'station';
  static displayName = 'Aether Nexus Station';

  constructor(ctx) {
    super(ctx);

    /** Textures we own, so dispose() can actually free them. */
    this._textures = [];
    /** Materials we own. */
    this.mat = {};
    /** Contact-shadow patches queued by every builder, flushed as one mesh. */
    this._contacts = [];
    /** Rotated footprints for authored enterable rooms; used to keep dressing clear. */
    this._enterableRoomFootprints = [];
    /* Buildings the Interiors system can open, and the collectibles inside them.
     *
     * Created here rather than in `_buildEnterableRooms`, which is where it used
     * to appear. That was fine while the crew pods were the only enterables on
     * the ring; now the habitat stacks are enterable too and they are raised at
     * step 0.77, well before the pods at 0.905, so the first `push` landed on
     * `undefined` and took the whole world build down with it. */
    this.enterables = [];
    /** Animated handles resolved during build; update() only touches these. */
    this._anim = {
      holoRings: [],
      holoCore: null,
      ads: [],
      ships: [],
      farStation: null,
      planet: null,
      beacons: [],
      beaconLights: [],
      steam: null,
      steamSeeds: null,
      shafts: null,
      crowdMeshes: null,
      crowdPhase: null,
      crowdBase: null,
      crowdYaw: null,
      crowdSeated: null,
      flicker: [],
      craneHook: null,
      dockArm: null,
      elevator: null,
      drones: [],
      droneMesh: null,
      droneLights: null,
      moon: null,
    };
    this._rng = mulberry32(0x5eed1);

    /* --- The outer ring ------------------------------------------------ */
    /** Articulated instanced figures for the four zones. See station/StationActors.js. */
    this._actors = null;
    /** Moving walkway plates in the links; see `_moveOnSurfaces`. */
    this._travelators = [];
    /** Escalator banks, one entry per tower; treads scroll, riders are carried. */
    this._escalators = [];
    /** Rooftops published for the relic placer. See `Relics._onWorld`. */
    this._roofs = [];
    /**
     * Footprints of buildings that collide themselves completely.
     *
     * `_collisionSoup` skips anything drawn inside one. See the note where
     * `buildTower` publishes them.
     */
    this._selfCollided = [];
  }

  /* ---------------------------------------------------------------- */
  /* Build                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * @param {(fraction:number, label:string)=>void} [onProgress]
   */
  async build(onProgress) {
    const step = async (f, label, fn) => {
      onProgress?.(f, label);
      await yieldFrame();
      fn.call(this);
    };

    onProgress?.(0.02, 'Printing hull plating');
    await yieldFrame();
    this._buildTextures();

    onProgress?.(0.16, 'Fabricating materials');
    await yieldFrame();
    this._buildMaterials();

    await step(0.22, 'Opening the sky', this._buildSpace);
    await step(0.32, 'Raising the pressure hull', this._buildHull);
    await step(0.42, 'Laying the deck and avenues', this._buildDeck);
    await step(0.50, 'Erecting Gateway Plaza', this._buildPlazaCentre);
    await step(0.55, 'Anchoring the gateway daises', this._buildPortalDaises);
    await step(0.60, 'Hanging the promenade loop', this._buildWalkwayLoop);
    await step(0.66, 'Opening the commercial strip', this._buildCommercial);
    await step(0.72, 'Pressurising Hangar Bay 4', this._buildHangar);
    await step(0.77, 'Stacking habitat blocks', this._buildHabitat);
    await step(0.81, 'Wiring the residential terrace', this._buildResidential);
    await step(0.85, 'Calibrating Traffic Control', this._buildControlTower);
    await step(0.89, 'Stacking the cargo yard', this._buildCargo);
    await step(0.905, 'Cutting crew-room access hatches', this._buildEnterableRooms);
    await step(0.92, 'Raising the outer skyline', this._buildSkyline);
    await step(0.94, 'Rigging the canopy', this._buildCanopy);
    await step(0.95, 'Scattering set dressing', this._buildDressing);

    /* The outer ring goes in before the two solidify passes, so its instanced
     * props are swept by the same collider sweep the hub's are, and its
     * structure is already standing when `_solidifyStructure` decides which
     * triangles are enclosed and can be dropped. */
    await step(0.955, 'Spanning the great dome', this._buildOuterRing);
    /* Strictly before `_solidifyProps`: a prop that is sitting in a platform
     * has to be lifted out of it before that pass measures where its collider
     * goes, or the collider is built at the wrong height too. */
    await step(0.960, 'Standing the set dressing up', this._settleDressing);
    await step(0.962, 'Making the set dressing solid', this._solidifyProps);
    // Strictly after `_solidifyProps`: that pass decides what is already solid
    // by probing with `groundHeight`, and it reads every box this one then uses
    // to discard triangles it does not need to collide twice.
    await step(0.97, 'Collecting structure collision', this._solidifyStructure);
    await step(0.98, 'Striking the lights', this._buildLights);

    onProgress?.(0.99, 'Registering crew');
    await yieldFrame();
    this._fillSpawns();
    this._fillEnvironment();

    // Scene membership belongs to WorldManager - it adds this group in
    // `_activate` and removes it on the way out. Adding it here parked a world
    // the player may never have visited in the live scene, hidden but still
    // traversed on every frame.
    onProgress?.(1, 'Station online');
  }

  /* ---------------------------------------------------------------- */
  /* Textures + materials                                              */
  /* ---------------------------------------------------------------- */

  /** Paint every canvas surface set this world needs. */
  _buildTextures() {
    const aniso = this.engine?.renderer?.capabilities?.getMaxAnisotropy?.() ?? 8;
    this._aniso = aniso;
    const keep = this._textures;

    /** Run a painter over albedo/height/roughness canvases and build the set. */
    const surface = (name, size, painter, normalStrength, seed) => {
      const ca = makeCanvas(size), ch = makeCanvas(size), cr = makeCanvas(size);
      painter(ctx2d(ca), ctx2d(ch), ctx2d(cr), size, mulberry32(seed));
      const map = canvasTexture(ca, true, aniso);
      const normalMap = normalFromHeight(ch, normalStrength, aniso);
      const roughnessMap = canvasTexture(cr, false, aniso);
      keep.push(map, normalMap, roughnessMap);
      this._tex[name] = { map, normalMap, roughnessMap };
      return this._tex[name];
    };

    // 1024 px on every large tiled surface, and normal strengths roughly half
    // what they were. Both changes attack the same defect: a 512 px tile with a
    // strong normal map, repeated twenty times across a 200 m deck, puts its rib
    // frequency past Nyquist at grazing angles and boils. More texels per rib
    // plus a gentler normal is the only fix available inside the world file -
    // MSAA and temporal AA belong to the renderer.
    this._tex = {};
    surface('deck', 1024, paintDeck, 1.35, 11);
    surface('road', 1024, paintRoad, 1.55, 23);
    surface('hull', 1024, paintHull, 1.5, 37);
    surface('panel', 1024, paintPanel, 1.2, 53);
    surface('grate', 1024, paintGrate, 1.8, 71);
    surface('plaza', 1024, paintPlaza, 1.0, 89);
    surface('crate', 512, paintCrate, 1.6, 101);
    surface('hazard', 256, paintHazard, 1.4, 113);
    surface('leaf', 512, paintLeaf, 1.9, 211);
    surface('cloth', 512, paintCloth, 0.9, 233);

    // Emissive / unlit sheets.
    const room = makeCanvas(1024);
    paintRoomGlow(ctx2d(room), 1024, mulberry32(131));
    this._tex.room = canvasTexture(room, true, aniso);

    /* Cells are 768 x 384, up from 512 x 256.
     *
     * Signage legibility was called out by two reviewers independently: the
     * primary line resolved, the secondary line ("ASHFALL REACH", "STAND CLEAR
     * OF DOORS") came back as grey mush. That is not a filtering problem, it is
     * a source-resolution problem - a 33 px cap height rendered into a 256 px
     * cell, then minified onto a 2 m board seen from 25 m, has no letterforms
     * left to resolve. Half again in each axis costs 28 MB for the one texture
     * in the world whose entire job is to be read.
     */
    const signs = makeCanvas(768 * SIGN_COLS, 384 * SIGN_ROWS);
    paintSignAtlas(ctx2d(signs), 768 * SIGN_COLS, 384 * SIGN_ROWS, mulberry32(151));
    this._tex.signs = canvasTexture(signs, true, aniso);

    // Alpha-cut leaf sprigs. RGBA, so the canvas alpha survives into the
    // texture and `alphaTest` can punch the canopy silhouette full of holes.
    const leafCard = makeCanvas(512);
    paintLeafCard(ctx2d(leafCard), 512, mulberry32(223));
    this._tex.leafCard = canvasTexture(leafCard, true, aniso);

    const decals = makeCanvas(1024);
    paintDecalAtlas(ctx2d(decals), 1024, mulberry32(167));
    this._tex.decals = canvasTexture(decals, true, aniso);

    const stars = makeCanvas(2048, 1024);
    paintStars(ctx2d(stars), 2048, 1024, mulberry32(181));
    this._tex.stars = canvasTexture(stars, true, aniso);

    const planet = makeCanvas(1024, 512);
    paintPlanet(ctx2d(planet), 1024, 512, mulberry32(197));
    this._tex.planet = canvasTexture(planet, true, aniso);

    this._tex.ramp = makeRampTexture(aniso);
    this._tex.radial = makeRadialTexture(aniso);
    this._tex.macro = makeMacroNoise(aniso);
    this._tex.contact = makeContactTexture(aniso);
    this._tex.grime = makeGrimeTexture(aniso);

    keep.push(
      this._tex.room, this._tex.signs, this._tex.decals, this._tex.leafCard,
      this._tex.stars, this._tex.planet, this._tex.ramp, this._tex.radial,
      this._tex.macro, this._tex.contact, this._tex.grime
    );
  }

  /** One material per visual class; buildings merge into these buckets. */
  _buildMaterials() {
    const T = this._tex;
    const M = this.mat;

    const std = (tex, o = {}) =>
      new THREE.MeshStandardMaterial({
        map: tex.map,
        normalMap: tex.normalMap,
        roughnessMap: tex.roughnessMap,
        normalScale: new THREE.Vector2(o.ns ?? 1, o.ns ?? 1),
        metalness: o.metalness ?? 0.85,
        roughness: o.roughness ?? 1.0,
        color: o.color ?? 0xffffff,
        envMapIntensity: o.env ?? 1.4,
        side: o.side ?? THREE.FrontSide,
        ...(o.extra || {}),
      });

    /**
     * Low-frequency macro variation, injected into the standard shader.
     *
     * Tiling is the single most visible "procedural" tell: a 200 m wall run
     * repeats the same 8 m tile twenty-five times and the eye locks onto it in
     * under a second. Multiplying a very-low-repeat noise into albedo and
     * roughness breaks that read for the cost of one extra texture fetch and no
     * extra texture memory (one shared 256 px map).
     */
    const macroTex = T.macro;
    /**
     * Two octaves, not one.
     *
     * The existing octave runs *very* low: on the deck its period is 0.028 uv,
     * i.e. one cycle across four hundred metres, which is a global gradient and
     * nothing else. That is why a 60 m sweep of floor answered light
     * identically from the camera to the horizon and photographed as one
     * untextured reflective slab. The second octave is an order of magnitude
     * higher - roughly one blotch every ten to fifteen metres - and it drives
     * roughness as well as albedo, across a band wide enough (about 0.35 to
     * 0.95 on the deck) that traffic-worn lanes and dull unwalked plate read as
     * genuinely different surfaces.
     *
     * @param {THREE.Material} mat
     * @param {number} scale      first-octave uv scale (global drift)
     * @param {number} strength   first-octave albedo amount
     * @param {number} second     second-octave uv scale (metre-scale blotching)
     * @param {number} secondAmt  second-octave albedo + roughness amount
     * @param {number} third      third-octave uv scale (sub-metre wet/dry break)
     * @param {number} thirdAmt   third-octave roughness-only amount
     *
     * The third octave exists because octaves one and two both have periods
     * *longer than a near-camera floor tile*: on the deck (12 m per uv unit)
     * they land at ~400 m and ~14 m, so the whole foreground plate falls inside
     * one blotch and answers light with a single constant value. Running a
     * ~1.5 m octave into roughness *only* (never albedo, which would read as
     * visible noise) gives the near deck the wet/dry traffic breakup that
     * separates a used floor from a grey card, at the cost of one texture
     * fetch and zero texture memory.
     */
    const withMacro = (
      mat, scale = 0.05, strength = 0.28,
      second = scale * 6, secondAmt = 0.26,
      third = second * 9.4, thirdAmt = 0.18
    ) => {
      mat.onBeforeCompile = (sh) => {
        sh.uniforms.uMacro = { value: macroTex };
        sh.uniforms.uMacroScale = { value: scale };
        sh.uniforms.uMacroAmt = { value: strength };
        sh.uniforms.uMacro2Scale = { value: second };
        sh.uniforms.uMacro2Amt = { value: secondAmt };
        sh.uniforms.uMacro3Scale = { value: third };
        sh.uniforms.uMacro3Amt = { value: thirdAmt };
        sh.fragmentShader = sh.fragmentShader
          .replace(
            '#include <common>',
            `#include <common>
            uniform sampler2D uMacro;
            uniform float uMacroScale;
            uniform float uMacroAmt;
            uniform float uMacro2Scale;
            uniform float uMacro2Amt;
            uniform float uMacro3Scale;
            uniform float uMacro3Amt;
            float stationMacro = 0.5;
            float stationWide = 0.5;
            float stationFine = 0.5;`
          )
          .replace(
            '#include <map_fragment>',
            `#include <map_fragment>
            #ifdef USE_MAP
              stationMacro = texture2D( uMacro, vMapUv * uMacroScale ).r;
              stationWide = texture2D( uMacro, vMapUv * uMacro2Scale + vec2( 0.37, 0.71 ) ).r;
              stationFine = texture2D( uMacro, vMapUv * uMacro3Scale + vec2( 0.63, 0.19 ) ).r;
              diffuseColor.rgb *= mix( 1.0 - uMacroAmt, 1.0 + uMacroAmt * 0.75, stationMacro );
              diffuseColor.rgb *= mix( 1.0 - uMacro2Amt, 1.0 + uMacro2Amt * 0.7, stationWide );
            #endif`
          )
          .replace(
            '#include <roughnessmap_fragment>',
            `#include <roughnessmap_fragment>
            float stationRough = mix( 0.90, 1.14, stationMacro )
              * mix( 1.0 - uMacro2Amt * 1.6, 1.0 + uMacro2Amt * 1.6, stationWide )
              * mix( 1.0 - uMacro3Amt, 1.0 + uMacro3Amt, stationFine );
            roughnessFactor = clamp( roughnessFactor * stationRough, 0.05, 1.0 );`
          );
      };
      // Without a stable cache key three reuses the un-patched program for any
      // other material with the same defines.
      mat.customProgramCacheKey = () => 'station-macro';
      return mat;
    };

    // Material families are deliberately *separated* rather than all landing in
    // the same metalness 0.3 / roughness 0.6 band: painted deck, structural
    // hull metal and composite cladding have to answer light differently or
    // every surface in the frame reads as the same grey plastic. Metalness on
    // the big masses still stays under ~0.65 because the only environment
    // energy in here is a starfield and a window wall.
    // The deck and the plaza fill the bottom 40% of every wide shot, so they get
    // the strongest wide-octave drive and the least environment energy: a
    // 60 m floor plane with envMapIntensity 1.35 is a mirror, and a mirror with
    // one albedo tile on it photographs as an untextured slab.
    // Second-octave scales are expressed against each map's own uv density:
    // the deck tiles at 12 m per uv unit, the panel family at 2 m, so 0.85 and
    // 0.3 respectively both land near a ten-metre blotch in world space.
    /* Deck albedo.
     *
     * These were 0xb4c0cf / 0xbfc9d9 / 0xc0cddf - about 0.45 linear, i.e. a
     * near-white paint. A 0.45-albedo floor under any competent key lands well
     * above mid-grey and, in the street-level frame, straight through the bloom
     * threshold: the veiling glare was coming off *diffuse deck plate*, not off
     * an emitter. Painted station decking is dark grey-blue; at ~0.30 linear a
     * lit plate now lands mid-slate and the plaza inlay has somewhere to go
     * above it. The third macro octave (see withMacro) is what keeps that
     * darker value from reading as flat.
     */
    /* Macro amplitudes on the three floor materials are deliberately the
     * highest in the file. The deck is 40-55% of every hero frame; at the old
     * 0.20/0.30 it still answered light with essentially one value across sixty
     * metres of depth, which is what "the plates are effectively untextured"
     * means. 0.34 albedo modulation on a ~14 m blotch plus a 1.5 m
     * roughness-only octave is the difference between a walked plate and a
     * shaded polygon with a line grid on it. */
    M.deck = withMacro(std(T.deck, { metalness: 0.08, roughness: 0.86, color: 0x94a0b0, env: 0.6 }), 0.028, 0.34, 0.85, 0.34, 8.0, 0.28);
    M.road = withMacro(std(T.road, { metalness: 0.06, roughness: 0.9, color: 0x9ca7b8, ns: 1.0, env: 0.6 }), 0.05, 0.30, 1.1, 0.32, 10.0, 0.28);
    M.plaza = withMacro(std(T.plaza, { metalness: 0.2, roughness: 0.78, color: 0x9daaba, env: 0.7 }), 0.05, 0.30, 0.9, 0.34, 8.6, 0.28);
    /**
     * Plaza laid *on top of* another opaque deck surface.
     *
     * The habitat terrace caps the end of avenue 120 and is therefore drawn at
     * the same 0.10 as the carriageway under it - two opaque, depth-writing,
     * unoffset surfaces sharing a plane, which is a z-fight. On the deck it
     * reads as ground that flickers between road and grass as the camera
     * moves, with the darker of the two showing through in patches like a
     * shadow.
     *
     * Polygon offset rather than a few centimetres of lift, for two reasons.
     * It leaves the geometry, the planter positions and the colliders exactly
     * where they were - a lift would have to be tuned against the kerbs and
     * the inset light strips that share this ground - and it is expressed in
     * depth-buffer units, so it holds at 150 m down the avenue where a 30 mm
     * gap would be only twice the depth resolution and starting to lose again.
     *
     * Everything else on this deck that sits at a shared height already does
     * this: the gateway aprons, the commercial forecourts and the floor decals
     * are all offset overlays. The terrace was the one surface that was not.
     */
    M.plazaOnDeck = M.plaza.clone();
    M.plazaOnDeck.polygonOffset = true;
    M.plazaOnDeck.polygonOffsetFactor = -2;
    M.plazaOnDeck.polygonOffsetUnits = -4;
    M.hull = withMacro(std(T.hull, { metalness: 0.62, roughness: 0.46, color: 0xa9b6c6, env: 1.5 }), 0.05, 0.26, 0.28, 0.24);
    M.hullIn = withMacro(std(T.hull, { metalness: 0.6, roughness: 0.5, color: 0x99a6b6, side: THREE.BackSide, env: 1.35 }), 0.05, 0.26, 0.28, 0.24);
    /* Wall macro amplitude.
     *
     * The left-hand wall in the plaza wide is one 8 m module stamped twenty-odd
     * times with a perfectly constant vertical rhythm, and the low-frequency
     * drift that is supposed to break that read was running at 0.22 - under the
     * threshold at which the eye stops locking onto the repeat. Raised on both
     * panel families, on the octave whose period lands around ten metres in
     * world space, which is roughly the module size it has to disguise.
     */
    M.panel = withMacro(std(T.panel, { metalness: 0.07, roughness: 0.78, color: 0xc6d1e0, env: 1.1 }), 0.06, 0.32, 0.30, 0.32);
    // Less metallic than it was: at 0.52 with only a starfield probe to reflect,
    // every large dark mass in the frame - columns, gantry soffits, the whole
    // left wall below the trim - returned almost nothing and clipped to black.
    M.panelDark = withMacro(std(T.panel, { metalness: 0.34, roughness: 0.52, color: 0x76828f, env: 1.6 }), 0.06, 0.32, 0.30, 0.32);
    /* The overhead plate.
     *
     * This used to be M.panelDark, and at 62 m up there is no light source
     * pointed at it: the practicals are all sub-16 m with a 40-96 m falloff, so
     * the plate received ambient and nothing else and rendered to near zero.
     * That is why the ceiling photographed as a black void with several hundred
     * disconnected emissive rectangles floating in it - the housings, the grid
     * bars and the plate itself were all present and all invisible. A roof
     * needs to occupy a value band, so this material is lighter, far less
     * metallic (metal with nothing to reflect renders black) and carries a
     * small self-illumination that stands in for the bounce a real lighting
     * grid throws back up at its own soffit.
     */
    M.ceiling = withMacro(std(T.panel, { metalness: 0.14, roughness: 0.84, color: 0x7b8a9e, env: 0.7 }), 0.05, 0.26, 0.30, 0.28);
    M.ceiling.emissive = new THREE.Color(0x2c3d52);
    M.ceiling.emissiveIntensity = 1.5;
    /* Roof structure.
     *
     * The ceiling beams were `panelDark` - metalness 0.52 with a 0x66727f
     * albedo, 62 m above the nearest practical, receiving hemisphere 0.26 off a
     * 0x2b2620 ground colour and nothing else. Measured, that is under 0.02
     * linear: black. So the entire truss grid was present, correct and
     * *invisible*, and only the emissive strips threaded through it survived -
     * which is the exact definition of "a glowing wireframe with no
     * architecture behind it".
     *
     * The fix is three things at once and none of them work alone: a lighter,
     * far less metallic albedo (metal with no environment to reflect returns
     * nothing), a small self-illumination standing in for the bounce a lighting
     * grid throws back onto its own structure, and - in `_buildLights` - a
     * dedicated upward bounce light so beam *undersides*, the only faces a deck
     * camera ever sees, are actually lit.
     */
    M.beam = withMacro(std(T.panel, { metalness: 0.18, roughness: 0.62, color: 0x8794a6, env: 1.0 }), 0.05, 0.22, 0.30, 0.24);
    M.beam.emissive = new THREE.Color(0x1c2836);
    M.beam.emissiveIntensity = 1.0;
    M.panelWarm = withMacro(std(T.panel, { metalness: 0.1, roughness: 0.7, color: 0xd6ae83, env: 1.1 }), 0.06, 0.22, 0.30, 0.26);
    // District identity: the service side of the ring is oxidised rust, the
    // utility volumes are a cold teal. A single-hue world has no colour script.
    M.panelRust = withMacro(std(T.panel, { metalness: 0.16, roughness: 0.8, color: 0x8f6a50, env: 1.0 }), 0.06, 0.28, 0.30, 0.30);
    M.panelTeal = withMacro(std(T.panel, { metalness: 0.2, roughness: 0.72, color: 0x51787f, env: 1.2 }), 0.06, 0.26, 0.30, 0.26);
    M.grate = withMacro(std(T.grate, { metalness: 0.72, roughness: 0.62, color: 0x9fadbd, env: 1.6 }), 0.05, 0.20, 0.34, 0.22);
    M.crate = withMacro(std(T.crate, { metalness: 0.18, roughness: 0.76, color: 0xb2bcc7, env: 1.0 }), 0.09, 0.26, 0.45, 0.26);
    /* Hazard striping.
     *
     * Flat, uncontaminated, full-chroma yellow with a crisp edge and one value
     * across thirty metres of depth is vector overlay art, not paint on a used
     * deck. Three changes: the macro variation the rest of the world already
     * runs (so a chevron thirty metres away is not the same value as the one at
     * the camera), a knocked-back tint so the lighting has to bring the chroma
     * up rather than the albedo starting there, and enough roughness that the
     * practicals catch it unevenly instead of uniformly.
     */
    M.hazard = withMacro(
      std(T.hazard, { metalness: 0.12, roughness: 0.86, color: 0xd9d2c2, env: 0.9 }),
      0.08, 0.30, 0.7, 0.28, 6.4, 0.24
    );

    // A polished trim material - the specular highlight that sells "metal".
    //
    // Metalness 0.75 at roughness 0.3 has *no diffuse term*: every photon it
    // returns comes from the environment map, and the only environment in here
    // is a starfield. That is why every bench, stanchion and bollard in the
    // round-2 street-level frame photographed as a solid black primitive with
    // no face-to-face shading - not because they were untextured, but because
    // they were mirrors in a room with nothing to reflect. Pulling metalness
    // back and adding roughness restores a real diffuse response.
    M.trim = new THREE.MeshStandardMaterial({
      map: T.panel.map,
      normalMap: T.panel.normalMap,
      roughnessMap: T.panel.roughnessMap,
      color: 0x93a1b2,
      metalness: 0.36,
      roughness: 0.5,
      envMapIntensity: 1.4,
    });
    // A darker structural variant for prop bases and bench legs: still metal,
    // still never black, because it keeps a diffuse albedo to fall back on.
    M.trimDark = new THREE.MeshStandardMaterial({
      map: T.panel.map,
      normalMap: T.panel.normalMap,
      roughnessMap: T.panel.roughnessMap,
      // Small dark props photographed as solid black placeholder cubes: a
      // 0.4 m box in a 0x6b7684 material at roughness 0.66 gets almost no
      // specular and no bounce, so it collapses to zero. Lighter base, more
      // environment, less roughness - it reads as painted steel, not as a hole.
      color: 0x828d9c,
      metalness: 0.28,
      roughness: 0.58,
      envMapIntensity: 1.5,
    });

    // Glass. Real transmission is too costly at this surface count, so these
    // are tuned reflective dielectrics that read as glass under the bloom pass.
    M.glassHull = new THREE.MeshPhysicalMaterial({
      color: 0x9ec9dd,
      metalness: 0.0,
      roughness: 0.045,
      transparent: true,
      opacity: 0.14,
      transmission: 0.0,
      side: THREE.DoubleSide,
      depthWrite: false,
      envMapIntensity: 2.6,
      clearcoat: 1.0,
      clearcoatRoughness: 0.05,
    });
    M.glassWindow = new THREE.MeshPhysicalMaterial({
      color: 0x2d4658,
      metalness: 0.25,
      roughness: 0.08,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthWrite: false,
      envMapIntensity: 2.2,
      clearcoat: 1.0,
      clearcoatRoughness: 0.04,
    });

    // Lit interiors seen through the glass.
    M.room = new THREE.MeshBasicMaterial({ map: T.room, toneMapped: true, fog: true });

    // Emissive families. Intensity sits just over 1 so the bright pass still
    // catches them, but the *core* of a strip no longer clips to flat white -
    // an emitter that clips has no readable structure left for the bloom to
    // bloom around, which is what turned every light in the frame into a blob.
    /**
     * Distance-graded emissive.
     *
     * A 0.5 m emissive bar 150 m away subtends well under a pixel, and a
     * sub-pixel emitter at full intensity is not a light - it is an aliasing
     * source. Hundreds of them are what turned the upper volume into crawling
     * confetti. Grading emissive down with view distance is also the only
     * aerial perspective an interior gets for free: the far districts settle
     * into the haze instead of sitting in the same value band as the near
     * field, which is the depth cue the frames were missing.
     *
     * Never to zero - a run of ceiling luminaires 180 m out should still read
     * as a dim converging line, it just must not compete with the plaza.
     */
    const emissive = (c, i, fade = true) => {
      const m = new THREE.MeshStandardMaterial({
        color: 0x05070a,
        emissive: c,
        emissiveIntensity: i,
        metalness: 0.1,
        roughness: 0.35,
        toneMapped: true,
      });
      if (!fade) return m;
      m.onBeforeCompile = (sh) => {
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nvarying float vStationDist;')
          .replace('#include <project_vertex>', '#include <project_vertex>\nvStationDist = -mvPosition.z;');
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying float vStationDist;')
          .replace(
            '#include <emissivemap_fragment>',
            `#include <emissivemap_fragment>
            totalEmissiveRadiance *= mix( 0.30, 1.0, smoothstep( 120.0, 46.0, vStationDist ) );`
          );
      };
      m.customProgramCacheKey = () => 'station-emfade';
      return m;
    };
    // Cyan is reserved for wayfinding - signage, route paint, gateway rings -
    // and deliberately runs *below* the sodium family so amber practicals own
    // the value peaks instead of the world reading as one cyan chord.
    M.emCyan = emissive(0x4fe3ff, 1.2);
    M.emAmber = emissive(0xffb347, 1.7);
    M.emGreen = emissive(0x4dffa6, 1.6);
    // Service / industrial arc. A third emissive family so the 240-300 degree
    // bearings are identifiable by hue alone from the plaza centre.
    M.emSodium = emissive(0xff8a3c, 1.5);
    // Lamp heads and strip lights are the fixtures that detonated into
    // featureless discs. Capped low enough that the bloom high-pass sees a core
    // with structure rather than a saturated plateau.
    M.emWhite = emissive(0xdff2ff, 1.0);
    M.emRed = emissive(0xff4b45, 1.8);
    // Retail identity for the 60/120 degree avenues.
    M.emMagenta = emissive(0xff5fd2, 1.6);
    // The plaza landmark gets a hue nothing else in the world uses, so it is
    // chromatically distinct from the cyan lamp population at any distance -
    // and it must *not* grade off with distance, because carrying across the
    // whole ring is the entire job of a landmark.
    M.emLandmark = emissive(0xffd8f5, 1.9, false);
    // A deliberately dim, dark-cored emissive for rings that must stay *legible*
    // right next to the portal: they read as geometry, not as glow.
    M.emDim = emissive(0x9fd8ff, 0.9);

    // FrontSide, always. The sign atlas is text: shown through its own back
    // face it renders mirrored, which reads as a broken build rather than a
    // style. Anything that must be legible from two directions gets a second
    // front-facing quad (see `_signBoard`), never a double-sided one.
    M.signs = new THREE.MeshStandardMaterial({
      map: T.signs,
      emissiveMap: T.signs,
      emissive: 0xffffff,
      emissiveIntensity: 1.35,
      color: 0x0a0d12,
      metalness: 0.2,
      roughness: 0.5,
      side: THREE.FrontSide,
    });

    M.decal = new THREE.MeshStandardMaterial({
      map: T.decals,
      transparent: true,
      alphaTest: 0.02,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      metalness: 0.3,
      roughness: 0.75,
    });

    /* Painted wayfinding routes.
     *
     * One material, vertex-coloured, so six differently coloured avenue routes
     * merge into a single draw call. It samples the deck's own albedo/normal/
     * roughness so a route reads as paint *on* the plate rather than as a flat
     * coloured quad hovering over it.
     */
    M.route = new THREE.MeshStandardMaterial({
      map: T.deck.map,
      normalMap: T.deck.normalMap,
      roughnessMap: T.deck.roughnessMap,
      vertexColors: true,
      metalness: 0.05,
      roughness: 0.84,
      envMapIntensity: 0.5,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });

    M.pool = new THREE.MeshBasicMaterial({
      map: T.radial,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: true,
    });

    // Contact occlusion patch. Multiply blending against the deck, so white
    // rim = no change and the dark core seats the prop. The screen-space AO
    // pass resolves at metre scale and never reaches the base of a bollard.
    M.contact = new THREE.MeshBasicMaterial({
      map: T.contact,
      transparent: true,
      blending: THREE.MultiplyBlending,
      // Multiply blending in three resolves to (DST_COLOR, ZERO), which is only
      // correct - and only accepted without a warning - on premultiplied alpha.
      premultipliedAlpha: true,
      depthWrite: false,
      toneMapped: false,
      fog: true,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });

    // Traffic grime. Same blend path as the contact patches but a far gentler
    // falloff and no hard core, so it can be scaled to 20 m without punching a
    // hole. Sorts *under* the painted decals - dirt is on the paint, but the
    // paint's own decal quads must still read as paint.
    M.grime = new THREE.MeshBasicMaterial({
      map: T.grime,
      transparent: true,
      blending: THREE.MultiplyBlending,
      premultipliedAlpha: true,
      depthWrite: false,
      toneMapped: false,
      fog: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });

    M.shaft = new THREE.MeshBasicMaterial({
      map: T.ramp,
      transparent: true,
      opacity: 0.11,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: true,
    });
    // A light shaft with a hard silhouette reads as translucent solid geometry.
    // Fading by the view-facing term turns the cone edge into a soft falloff and
    // kills the polygonal flanks; the height ramp already fades the base.
    this._shaftUniformSets = [];
    M.shaft.onBeforeCompile = (sh) => {
      sh.uniforms.uShaftTime = { value: 0 };
      sh.uniforms.uShaftDust = { value: macroTex };
      this._shaftUniforms = sh.uniforms;
      this._shaftUniformSets.push(sh.uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vShaftN;\nvarying vec3 vShaftV;\nvarying vec2 vShaftUv;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          #ifdef USE_INSTANCING
            vec4 shaftWorld = modelMatrix * instanceMatrix * vec4( transformed, 1.0 );
            vShaftN = normalize( mat3( modelMatrix ) * mat3( instanceMatrix ) * normal );
          #else
            vec4 shaftWorld = modelMatrix * vec4( transformed, 1.0 );
            vShaftN = normalize( mat3( modelMatrix ) * normal );
          #endif
          vShaftV = normalize( cameraPosition - shaftWorld.xyz );
          vShaftUv = uv;`
        );
      sh.fragmentShader = sh.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec3 vShaftN;
          varying vec3 vShaftV;
          varying vec2 vShaftUv;
          uniform float uShaftTime;
          uniform sampler2D uShaftDust;`
        )
        .replace(
          '#include <opaque_fragment>',
          `#include <opaque_fragment>
          /* Centre-weighted, not rim-weighted.
           *
           * A hollow shell shaded by (1 - |N.V|) is brightest exactly at its
           * silhouette, which is why these still photographed as polygonal
           * cones with a hard outline: the shader was drawing the edge. Weight
           * by |N.V| instead and the alpha goes to zero at the silhouette,
           * while the front and back faces both face the camera near the axis
           * and sum under additive blending. The result peaks down the middle
           * of the beam and has no edge left to be polygonal. */
          float shaftFace = abs( dot( normalize( vShaftN ), normalize( vShaftV ) ) );
          float shaftEdge = pow( clamp( shaftFace, 0.0, 1.0 ), 1.35 ) * 2.6;
          // Cylinder v runs 0 at the deck to 1 at the fixture. Melting the last
          // 28% into nothing is what stops the shaft terminating on a razor-flat
          // ellipse where it meets the floor - the single most obvious "this is
          // a translucent plastic cone" tell in the round-2 frames.
          float shaftFoot = smoothstep( 0.0, 0.34, vShaftUv.y );
          shaftFoot *= shaftFoot;
          // ...and the same treatment at the emitter end, so the cone has no
          // hard top ring either. A beam that fades at both ends has no
          // silhouette left to read as a solid object.
          shaftFoot *= 1.0 - smoothstep( 0.80, 1.0, vShaftUv.y ) * 0.85;
          // A slow vertical crawl of low-frequency noise gives the beam dust
          // structure rather than a uniform interior fill.
          float dust = texture2D( uShaftDust, vec2( vShaftUv.x * 2.0, vShaftUv.y * 0.7 - uShaftTime * 0.035 ) ).r;
          gl_FragColor.rgb *= shaftEdge * shaftFoot * mix( 0.55, 1.35, dust );`
        );
    };
    M.shaft.customProgramCacheKey = () => 'station-shaft';

    /* The overhead shafts.
     *
     * The ceiling is almost entirely emitters and not one of them was putting a
     * visible cone into the volume, so a 62 m interior had no atmosphere doing
     * any work at all. These are the same shader - same dust crawl, same
     * view-facing falloff, same double-ended dissolve - at a third of the
     * opacity, because a 60 m cone covers a great deal more screen than a 8 m
     * one and additive overdraw compounds.
     */
    M.shaftBig = M.shaft.clone();
    M.shaftBig.opacity = 0.038;
    M.shaftBig.onBeforeCompile = M.shaft.onBeforeCompile;
    M.shaftBig.customProgramCacheKey = () => 'station-shaft';

    M.holo = new THREE.MeshBasicMaterial({
      color: 0x6ff0ff,
      transparent: true,
      opacity: 0.42,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: true,
    });
    M.holoLine = new THREE.LineBasicMaterial({
      color: 0x7ff4ff,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: true,
    });
    M.steam = new THREE.MeshBasicMaterial({
      map: T.radial,
      transparent: true,
      opacity: 0.30,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: true,
    });

    // 0x14171d at close range is indistinguishable from a missing material.
    M.rubber = new THREE.MeshStandardMaterial({
      color: 0x2a3038, metalness: 0.22, roughness: 0.82, envMapIntensity: 1.2,
    });
    M.copper = new THREE.MeshStandardMaterial({
      map: T.panel.map,
      normalMap: T.panel.normalMap,
      color: 0x9a5a34, metalness: 0.85, roughness: 0.42, envMapIntensity: 1.8,
    });
    M.mirror = new THREE.MeshStandardMaterial({
      color: 0x9fb4c8, metalness: 1.0, roughness: 0.09, envMapIntensity: 3.0,
    });

    /* --- Authored roughness tiers -------------------------------------
     *
     * Almost everything above clusters at roughness 0.46-0.86, which is one
     * manufacturing process: a semi-gloss moulding. A frame containing a
     * painted deck, a bare steel truss, a chromed handrail, a rubber hose and a
     * composite kiosk shell should return five different specular signatures,
     * and the reviewers correctly read a single one. These three sit at the
     * ends of the range the existing families do not reach, and the near-field
     * dressing pass below applies them by *function* rather than by object.
     */
    // Handrails, bollard caps, stanchion tops: the only surfaces in the world
    // authored to throw a tight specular. Nothing else is allowed under 0.3.
    M.chrome = new THREE.MeshStandardMaterial({
      map: T.panel.map,
      normalMap: T.panel.normalMap,
      normalScale: new THREE.Vector2(0.4, 0.4),
      color: 0xb6c4d4,
      metalness: 0.88,
      roughness: 0.20,
      envMapIntensity: 2.4,
    });
    // Kiosk shells, lockers, signage housings: injection-moulded composite.
    // Fully dielectric, so it answers the practicals with a broad diffuse
    // rolloff instead of the hard metal falloff every other surface has.
    M.shell = withMacro(std(T.panel, {
      metalness: 0.0, roughness: 0.55, color: 0xb9c2cc, env: 0.9, ns: 0.6,
    }), 0.07, 0.20, 0.34, 0.22);
    // Standing water on a deck that is washed down every shift. Near-mirror,
    // fully dielectric: this is what actually picks the emissives up off the
    // floor and stops the lower third reading as one flat value field.
    M.wet = new THREE.MeshStandardMaterial({
      map: T.deck.map,
      normalMap: T.deck.normalMap,
      normalScale: new THREE.Vector2(0.18, 0.18),
      color: 0x39485a,
      metalness: 0.0,
      roughness: 0.06,
      envMapIntensity: 2.2,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });

    /* Fixture halo.
     *
     * A 1.6 m luminaire 60 m up still resolves to a couple of pixels, and a
     * two-pixel emitter with a hard edge is a hairline no matter how bright it
     * is. A wide, very low additive lozenge under each trough gives the fixture
     * a soft footprint, so the eye reads a lit run rather than a drawn line -
     * and it costs one extra draw call for the entire ceiling because the tint
     * travels in vertex colour rather than in the material.
     */
    M.ceilHalo = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.34,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: true,
      fog: true,
    });

    /**
     * Worn-smooth deck patches.
     *
     * The round-2 plaza wide shot was disqualified by a razor-straight tonal
     * seam running the full width of frame: a 14 m mirror quad, unfeathered,
     * lying 11 cm above the deck two metres in front of a 1.7 m camera. Its
     * silhouette edge read as a broken render pass. This material is the fix -
     * a per-vertex alpha ramp that dissolves each patch over its outer third,
     * roughness high enough to read as polished wear rather than as chrome, and
     * a polygon offset so it can never z-fight the deck disc underneath.
     *
     * Vertex alpha rather than an alphaMap on purpose: the albedo still has to
     * tile at world density, and one UV set cannot serve both a tiling map and
     * a 0-1 feather ramp.
     */
    M.polish = new THREE.MeshStandardMaterial({
      map: T.deck.map,
      normalMap: T.deck.normalMap,
      roughnessMap: T.deck.roughnessMap,
      color: 0xa9bacb,
      metalness: 0.55,
      roughness: 0.55,
      envMapIntensity: 1.4,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });

    /**
     * Hydroponic canopy. Round 2 grew its planters out of flat-shaded
     * octahedra in a metal panel material, which read - correctly - as grey
     * boulders sitting on a space station deck. Smooth-shaded icosphere lobes
     * in a saturated, wholly non-metallic leaf material read as a plant.
     */
    /* Both foliage materials now read their occlusion from vertex colours (see
     * `foliageLobe`), and both are pulled well back in chroma: 0x5f9a63 is a
     * poster-paint green that no other hue in this world's cyan/sodium script
     * can sit next to, and it is a large part of why the planters read as toys.
     * Muted, and with a real internal value range coming from the geometry. */
    M.foliage = new THREE.MeshStandardMaterial({
      map: T.leaf.map,
      normalMap: T.leaf.normalMap,
      roughnessMap: T.leaf.roughnessMap,
      normalScale: new THREE.Vector2(1.7, 1.7),
      color: 0x4a7350,
      metalness: 0.0,
      roughness: 0.9,
      envMapIntensity: 0.6,
      vertexColors: true,
    });
    M.foliagePale = new THREE.MeshStandardMaterial({
      map: T.leaf.map,
      normalMap: T.leaf.normalMap,
      roughnessMap: T.leaf.roughnessMap,
      normalScale: new THREE.Vector2(1.7, 1.7),
      color: 0x6d8f57,
      metalness: 0.0,
      roughness: 0.92,
      envMapIntensity: 0.6,
      vertexColors: true,
    });
    /* Alpha-cut sprig cards at the canopy edge. `transparent: false` with a
     * hard alphaTest keeps them in the opaque queue - no sort order to get
     * wrong, no depth-write games - and the shadow pass honours the same cut,
     * so a canopy throws a broken dappled shadow instead of a sphere's. */
    M.foliageCard = new THREE.MeshStandardMaterial({
      map: T.leafCard,
      color: 0x93a884,
      metalness: 0.0,
      roughness: 0.94,
      envMapIntensity: 0.55,
      transparent: false,
      alphaTest: 0.45,
      side: THREE.DoubleSide,
    });

    /**
     * Ambient crowd. Tinted per instance through `setColorAt`, so a whole
     * crowd in assorted garment colours costs one material.
     *
     * The map/normal/roughness set is the point: without it these are solid
     * flat-shaded capsules, which is exactly what every reviewer saw. The
     * per-part value break (dark trousers, mid jacket, dark shoes) is baked
     * into the geometry's vertex colours - see `_crowdBodyGeo` - and multiplies
     * with the instance colour, so one draw call still carries a three-band
     * figure rather than a single-value pill.
     */
    M.crowd = new THREE.MeshStandardMaterial({
      map: T.cloth.map,
      normalMap: T.cloth.normalMap,
      roughnessMap: T.cloth.roughnessMap,
      normalScale: new THREE.Vector2(0.8, 0.8),
      color: 0xffffff,
      metalness: 0.0,
      /* A fully-rough matte body under a single raked key has no specular
       * shoulder at all: every face that is not pointed at the key returns
       * ambient only, so a figure collapses to one near-black value and reads
       * as a cutout composited over a lit deck. Dropping roughness and doubling
       * the environment term is what gives the crowd an internal value
       * gradient - a lit shoulder, a turned cheek, a dark flank. */
      roughness: 0.72,
      envMapIntensity: 0.95,
      vertexColors: true,
    });
    /** Heads and necks. Skin is not cloth: less rough, and its own tint pool. */
    M.skin = new THREE.MeshStandardMaterial({
      map: T.cloth.map,
      normalMap: T.cloth.normalMap,
      normalScale: new THREE.Vector2(0.25, 0.25),
      color: 0xffffff,
      metalness: 0.0,
      roughness: 0.62,
      envMapIntensity: 0.95,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Small helpers used by every district builder                      */
  /* ---------------------------------------------------------------- */

  /** Axis-aligned solid volume. */
  _solid(cx, cy, cz, hx, hy, hz) {
    return this.track(this.physics.addBox(cx, cy, cz, hx, hy, hz));
  }

  /**
   * Give every free-standing prop a collider.
   *
   * ── Why this is a sweep and not a `_solid` call per builder ────────────────
   * Colliders here are authored by hand, one call beside each piece of
   * geometry, and that is fine for the things a builder thinks of as
   * structure - buildings, kerbs, walkway segments. It is not fine for set
   * dressing, because dressing is scattered in bulk through instanced meshes
   * and the collider call is easy to simply not write. Audited across the
   * finished station, 463 free-standing props were resting on a walkable floor
   * with nothing behind them: barrels, crates, service bollards, the big
   * cargo blocks and - the ones that get noticed - the roof blocks up on the
   * commercial and habitat rooftops. All of them could be walked through.
   *
   * A sweep over what was actually built cannot drift from it the way a
   * parallel list of hand-written calls does, and a prop added next year is
   * covered without anybody remembering. The cost is small: the station
   * carries ~692 colliders and this adds ~460 to a uniform-grid broadphase.
   *
   * ── What it deliberately skips ────────────────────────────────────────────
   *   * anything thinner than 0.45 m on any axis - trim, decals, cable runs,
   *     signage faces, which should not stop a player;
   *   * anything over 12 m tall, which is architecture and already collided
   *     by whoever raised it;
   *   * anything not resting on a walkable surface, which is the test that
   *     leaves the overhead canopy rigging at y=48 alone - it is scenery seen
   *     from below, not something anybody can bump into;
   *   * anything already solid, so a builder that did write its own call keeps
   *     exactly the collider it chose.
   *
   * Instances are Y-rotated, so each box is registered with the instance's own
   * yaw and its local extents rather than a world-axis-aligned bound. A 4.7 x
   * 5.5 m block turned 45 degrees has a 7.2 m square AABB, and handing that to
   * physics would quietly fatten every rotated crate into an invisible wall.
   */
  _solidifyProps() {
    const ph = this.physics;
    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const centre = new THREE.Vector3();
    let added = 0;

    this.group.updateMatrixWorld(true);
    this.group.traverse((o) => {
      if (!o.isInstancedMesh || !o.visible || !o.geometry) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const bb = o.geometry.boundingBox;
      const lx = bb.max.x - bb.min.x, ly = bb.max.y - bb.min.y, lz = bb.max.z - bb.min.z;

      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m);
        m.premultiply(o.matrixWorld);
        m.decompose(pos, quat, scl);
        const hx = (lx * Math.abs(scl.x)) / 2;
        const hy = (ly * Math.abs(scl.y)) / 2;
        const hz = (lz * Math.abs(scl.z)) / 2;
        // 0.4 m on every axis. Slim service bollards measure 0.44 and are very
        // much things you walk into; trim and cable runs are far under it.
        if (hx < 0.2 || hy < 0.2 || hz < 0.2) continue;
        if (hy > 6) continue;

        // Local bbox centre through the instance transform - props are rarely
        // modelled about their own middle.
        centre.set((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, (bb.min.z + bb.max.z) / 2)
          .applyMatrix4(m);
        // Whole map, not just the hub deck: the zones scatter chairs, dumbbells,
        // pallets and crates through the same instanced path, and a chair you
        // can walk through is exactly the defect this sweep exists to catch.
        if (Math.hypot(centre.x, centre.z) > WORLD_R) continue;

        const base = centre.y - hy;
        const floor = ph.groundHeight(centre.x, centre.z, base + 0.4, 2.0);
        if (floor === null || Math.abs(floor - base) > 0.6) continue;   // not standing on anything
        const top = ph.groundHeight(centre.x, centre.z, centre.y + hy + 0.4, hy * 2 + 1.2);
        if (top !== null && top > base + Math.min(0.35, hy * 0.8)) continue;  // already solid

        const e = new THREE.Euler().setFromQuaternion(quat, 'YXZ');
        this._solidRot(centre.x, centre.y, centre.z, hx, hy, hz, e.y);
        added++;
      }
    });
    if (added) console.info(`[station] ${added} set-dressing props made solid`);
  }

  /**
   * Collide the station's structure from the triangles it actually drew.
   *
   * ── Why this exists ───────────────────────────────────────────────────────
   * Every collider above this line is authored by hand next to the geometry it
   * covers, and across a world this size that list drifts from the world. Play
   * testing surfaced walk-throughs in five separate builders - plaza props,
   * dressing, hull structure, skyline, gateway props - and each round of
   * coordinate-by-coordinate fixes turned up a builder the previous round had
   * not touched. `_solidifyProps` above closes the instanced-prop half of the
   * gap, but it cannot see inside a `GeoBatch`: this world merges aggressively
   * to hold its draw-call budget, so by the time a bench reaches the scene its
   * four slats and four legs have stopped existing as separate objects. The
   * plaza's structural columns had no collider at all.
   *
   * Triangles cannot drift. Whatever a builder made, however it was merged,
   * and whoever adds one next year, it is solid because it is there.
   *
   * ── Why it is affordable ──────────────────────────────────────────────────
   * The obvious version of this is not. A `mesh` collider is a flat triangle
   * array with no internal tree, so the whole cost of a chunk is paid by any
   * query that reaches it, and the broadphase can only discriminate down to
   * one 12 m cell. A first attempt at fixed 8 m chunks measured 1,254 us per
   * `resolveCapsule` and ran the game at 10 fps. Three things make the
   * difference, and all three are needed:
   *
   *   1. **Nothing already inside a box collider is emitted.** Every building
   *      here is raised by `_block`, which ends with a full-mass `_solidRot`
   *      around the whole massing - so its cladding, string courses, pilasters
   *      and roof kit are already solid and would be collided twice. Dropping
   *      triangles enclosed by an existing box removes 118,784 of 226,794,
   *      including all 82,632 of the outer skyline's window trim. The coarse
   *      proxy the builder already wrote is better collision than the geometry
   *      it stands for, and this is what lets it be used instead of duplicated.
   *
   *   2. **Chunks are split adaptively, not on a grid.** Geometry here is
   *      wildly uneven - the monument dais and the plaza colonnade pack more
   *      triangles into 20 m than a whole district does - so a fixed grid puts
   *      tens of thousands of triangles in the cells that matter and a handful
   *      in the rest. Splitting each chunk at the median of its longest axis
   *      until it holds `CHUNK_TRIS` bounds the cost of every chunk instead of
   *      the average.
   *
   *   3. **Anything a player walks under or through is skipped**: leaf
   *      canopies, cable runs and hoses, floor films, decals, sign faces and
   *      every emissive strip. These are the densest meshes in the world and
   *      none of them should stop anybody.
   *
   * Measured on the plaza, the busiest square metre in the game: 4,096 chunks
   * holding 108,010 triangles, `resolveCapsule` 2.4 -> 34 us, ground probes
   * 5.8 -> 38 us, median frame 11.6 -> 12.0 ms.
   *
   * ── What it deliberately does not do ──────────────────────────────────────
   * Nothing above `COLLIDE_CEILING` is collided: that band is the ceiling
   * plate, the hung canopy rigging and the top of the hull wall, none of it
   * reachable, and all of it expensive. Neither is anything outside the deck.
   */
  _solidifyStructure() {
    const t0 = performance.now();
    const soup = this._collisionSoup();
    const extracted = soup.length / 9;
    const kept = this._dropEnclosedTriangles(soup);
    const chunks = chunkTriangles(kept, CHUNK_TRIS);
    for (const positions of chunks) this.track(this.physics.addTriangleSoup(positions));
    const planters = this._solidifyPlanting();

    console.info(
      `[station] structure collided from geometry: ${extracted} triangles found, ` +
        `${extracted - kept.length / 9} already inside a box, ${kept.length / 9} kept ` +
        `in ${chunks.length} chunks (${(kept.byteLength / 1048576).toFixed(1)} MB), ` +
        `${planters} planting proxies, ${Math.round(performance.now() - t0)}ms`
    );
  }

  /**
   * Collide planting as coarse boxes rather than as leaves.
   *
   * A shrub is a blob, and triangle-accurate collision for one is both wasteful
   * and pointless: nobody can tell where a hedge's surface is to within a leaf.
   * The station's planting is 52,290 triangles - half again as much as its
   * entire collided structure - so putting it through the same path would cost
   * more than everything else here put together and buy nothing.
   *
   * Instead the lobes are split by the same median chunker and each chunk
   * becomes one box sized to its own bounds. Small chunks are what make this
   * honest: a chunk of a lobe's surface is a patch, and a patch's box hugs it,
   * where one box per lobe would be a crate around a sphere. The union is a
   * shell rather than a solid, which is all a capsule can ever touch.
   *
   * Leaves buried inside their own planter are dropped first, so a tub that is
   * already solid does not get a second collider inside it.
   */
  _solidifyPlanting() {
    const soup = this._collisionSoup((k) => PROXY_KEYS.has(k));
    if (!soup.length) return 0;
    const kept = this._dropEnclosedTriangles(soup);
    const chunks = chunkTriangles(kept, PLANTING_TRIS);
    const box = new THREE.Box3();
    let added = 0;
    for (const positions of chunks) {
      box.makeEmpty();
      for (let i = 0; i < positions.length; i += 3) {
        _v1.set(positions[i], positions[i + 1], positions[i + 2]);
        box.expandByPoint(_v1);
      }
      const s = box.getSize(_v1);
      const c = box.getCenter(_v2);
      // A patch flat enough to be a single leaf card has nothing to stop.
      if (Math.max(s.x, s.y, s.z) < 0.12) continue;
      this._solid(c.x, c.y, c.z, Math.max(s.x / 2, 0.04), Math.max(s.y / 2, 0.04), Math.max(s.z / 2, 0.04));
      added++;
    }
    return added;
  }

  /**
   * World-space triangles of everything that should stop a character.
   *
   * Material decides, not mesh name: unnamed standalone meshes and merged
   * batches both reach the scene here, and the material is the one thing both
   * carry. Transparent, non-depth-writing and additive materials are holograms
   * and glow cards, which have no business being solid.
   */
  _collisionSoup(wantKey = (k) => !NON_SOLID_KEYS.has(k) && !PROXY_KEYS.has(k) && !k.startsWith('em')) {
    const keyOf = new Map();
    for (const [k, m] of Object.entries(this.mat ?? {})) if (m?.isMaterial) keyOf.set(m, k);

    this.group.updateMatrixWorld(true);
    const tris = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();

    this.group.traverse((o) => {
      // Instanced props are already covered by `_solidifyProps`, which can read
      // each instance's own yaw and give it a tight oriented box - strictly
      // better than the triangles would be.
      if (!o.isMesh || o.isInstancedMesh || !o.visible) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!m || m.transparent || m.depthWrite === false || m.blending === THREE.AdditiveBlending) return;
      const key = keyOf.get(m) ?? (o.name || '').split(':')[1] ?? '';
      if (!wantKey(key)) return;

      const geo = o.geometry;
      const pos = geo.getAttribute('position');
      if (!pos) return;
      const idx = geo.getIndex();
      const n = idx ? idx.count : pos.count;
      for (let i = 0; i < n; i += 3) {
        const i0 = idx ? idx.getX(i) : i;
        const i1 = idx ? idx.getX(i + 1) : i + 1;
        const i2 = idx ? idx.getX(i + 2) : i + 2;
        a.fromBufferAttribute(pos, i0).applyMatrix4(o.matrixWorld);
        b.fromBufferAttribute(pos, i1).applyMatrix4(o.matrixWorld);
        c.fromBufferAttribute(pos, i2).applyMatrix4(o.matrixWorld);
        const cy = (a.y + b.y + c.y) / 3;
        if (cy < -2 || cy > COLLIDE_CEILING) continue;
        const cx = (a.x + b.x + c.x) / 3;
        const cz = (a.z + b.z + c.z) / 3;
        if (cx * cx + cz * cz > DECK_R * DECK_R) continue;
        if (this._insideSelfCollided(cx, cy, cz)) continue;
        tris.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      }
    });
    return new Float32Array(tris);
  }

  /**
   * Drop every triangle whose three corners all sit inside a solid box.
   *
   * This is where the buildings go. A triangle inside a box adds nothing a
   * query can reach, so keeping it would be paying twice for one surface, and
   * the boxes are the better half of the pair - one slab test against a whole
   * tower beats ten thousand triangles of its cladding.
   *
   * The tolerance is outward, so a face lying exactly on its box's surface -
   * the deck plating on the deck slab, a facade panel flush with its massing -
   * counts as enclosed rather than surviving as a redundant sheet.
   *
   * Its own grid, rather than `physics.query`, because that allocates a dedup
   * `Set` per call and this asks a quarter of a million questions.
   */
  _dropEnclosedTriangles(soup, tol = 0.03) {
    const CELL = 16;
    const grid = new Map();
    const cellKey = (i, j) => (i + 4096) * 16384 + (j + 4096);
    for (const col of this.physics.colliders) {
      if (col.type !== 'box' || !col.solid) continue;
      const r = col.boundingRadius;
      const ci = col.center;
      for (let i = Math.floor((ci.x - r) / CELL); i <= Math.floor((ci.x + r) / CELL); i++) {
        for (let j = Math.floor((ci.z - r) / CELL); j <= Math.floor((ci.z + r) / CELL); j++) {
          const k = cellKey(i, j);
          let list = grid.get(k);
          if (!list) grid.set(k, (list = []));
          list.push(col);
        }
      }
    }

    const p = _v1;
    const enclosed = (x, y, z) => {
      const list = grid.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
      if (!list) return false;
      for (let i = 0; i < list.length; i++) {
        const col = list[i];
        p.set(x, y, z).applyMatrix4(col.inverse);
        const e = col.halfExtents;
        if (
          Math.abs(p.x) <= e.x + tol &&
          Math.abs(p.y) <= e.y + tol &&
          Math.abs(p.z) <= e.z + tol
        ) return true;
      }
      return false;
    };

    const count = soup.length / 9;
    const keep = new Float32Array(soup.length);
    let w = 0;
    for (let i = 0; i < count; i++) {
      const o = i * 9;
      if (
        enclosed(soup[o], soup[o + 1], soup[o + 2]) &&
        enclosed(soup[o + 3], soup[o + 4], soup[o + 5]) &&
        enclosed(soup[o + 6], soup[o + 7], soup[o + 8])
      ) continue;
      keep.set(soup.subarray(o, o + 9), w);
      w += 9;
    }
    return keep.subarray(0, w);
  }

  /**
   * Is this footprint clear of everything already built?
   *
   * Bulk scatter here rejects carriageways, enterable footprints and the two
   * gateway sightlines - everything the author thought of - but never asked
   * whether a district was already standing where the prop was about to land.
   * Across the finished station that put 633 triangles of shipping container
   * inside solid architecture, one stack 4.7 m into a building, which is what
   * "the cargo boxes go into buildings" looks like from the deck.
   *
   * Sampling rather than an exact oriented-box overlap because the props are
   * scattered in the hundreds and the answer only has to be right to about a
   * prop's width. `y0` starts above the deck slab so the deck itself - which is
   * a solid box from -6 to 0 - never reports as an obstruction.
   *
   * Only usable by builders that run *after* the districts they need to avoid:
   * colliders are the record being consulted, and a district that has not been
   * raised yet has none. See the build order in `build()`.
   */
  _footprintClear(x, z, halfX, halfZ, yTop, y0 = 0.4) {
    const steps = Math.max(1, Math.ceil(Math.max(halfX, halfZ) / 0.75));
    for (let i = -steps; i <= steps; i++) {
      for (let j = -steps; j <= steps; j++) {
        const px = x + (halfX * i) / steps;
        const pz = z + (halfZ * j) / steps;
        if (this._occupied?.has(this._occKey(px, pz))) return false;
        for (let k = 0; k <= 2; k++) {
          const py = y0 + ((yTop - y0) * k) / 2;
          if (this.physics.containsPoint(_v2.set(px, py, pz))) return false;
        }
      }
    }
    return true;
  }

  _occKey(x, z) {
    return occKeyOf(x, z);
  }

  /**
   * Mark every square metre of deck that already has something standing on it.
   *
   * `_footprintClear` alone reads colliders, and a surprising amount of this
   * station is drawn without one - overhead masses, canopies, the service
   * shafts. A container was scattered directly under a 30 m shaft wall that had
   * no collider to consult, so only the bottom metre of it showed, poking out
   * from beneath a building. Triangles cannot be forgotten the way a collider
   * call can, so the occupancy comes from what was drawn.
   *
   * The band starts above the deck plating, kerbs and floor decals, and stops
   * at 6 m - higher than anything a deck-level prop can reach, low enough that
   * a walkway soffit 20 m up does not reserve the ground beneath it.
   */
  _markOccupancy() {
    this.group.updateMatrixWorld(true);
    const occ = new Set();
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const m = new THREE.Matrix4();
    this.group.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      const mat = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!mat || mat.transparent || mat.depthWrite === false) return;
      const geo = o.geometry;
      const pos = geo.getAttribute('position');
      if (!pos) return;
      const idx = geo.getIndex();
      const n = idx ? idx.count : pos.count;
      const instances = o.isInstancedMesh ? o.count : 1;
      for (let e = 0; e < instances; e++) {
        if (o.isInstancedMesh) o.getMatrixAt(e, m).premultiply(o.matrixWorld);
        else m.copy(o.matrixWorld);
        for (let i = 0; i < n; i += 3) {
          const i0 = idx ? idx.getX(i) : i;
          const i1 = idx ? idx.getX(i + 1) : i + 1;
          const i2 = idx ? idx.getX(i + 2) : i + 2;
          a.fromBufferAttribute(pos, i0).applyMatrix4(m);
          b.fromBufferAttribute(pos, i1).applyMatrix4(m);
          c.fromBufferAttribute(pos, i2).applyMatrix4(m);
          /* Span, not centroid, on both counts. A 30 m shaft wall is two
           * triangles whose centroids sit at 17 m - a centroid test says the
           * band is empty and the ground below it is free, which is exactly how
           * a container ended up under one. And a wall triangle 20 m long
           * occupies every cell it crosses, not the one its middle lands in. */
          if (Math.min(a.y, b.y, c.y) > 6 || Math.max(a.y, b.y, c.y) < 0.5) continue;
          const x0 = Math.min(a.x, b.x, c.x), x1 = Math.max(a.x, b.x, c.x);
          const z0 = Math.min(a.z, b.z, c.z), z1 = Math.max(a.z, b.z, c.z);
          if (Math.hypot(Math.max(0, Math.abs(x0 + x1) / 2), Math.max(0, Math.abs(z0 + z1) / 2)) > DECK_R + 20) continue;
          /* Packed by the same function `_occKey` reads with. This was two
           * hand-inlined copies of the same bit-twiddle, biased by 512 and
           * shifted by 11 - which silently aliases anything past 768 m onto a
           * cell near the origin. The hub never got near that; the galley's far
           * rim is at 698. See `occKeyOf`. */
          for (let gx = Math.floor(x0 / OCC_CELL); gx <= Math.floor(x1 / OCC_CELL); gx++) {
            for (let gz = Math.floor(z0 / OCC_CELL); gz <= Math.floor(z1 / OCC_CELL); gz++) {
              occ.add(occCellKey(gx, gz));
            }
          }
        }
      }
    });
    this._occupied = occ;
    return occ.size;
  }

  /**
   * Stand every scattered prop on whatever is actually under it.
   *
   * ── The defect ────────────────────────────────────────────────────────────
   * `_buildDressing` scatters bins, crates, barrels, bollards, spools and
   * trolleys across the deck at a fixed height, having tested only that the
   * footprint is *clear*. Clear is not the same as flat. Wherever the deck is
   * raised - the plaza's grate platforms, the skyline plinths, the monument
   * steps, the cargo yard's pads - the prop was authored at deck level and the
   * platform came up through it. Measured over the hub, 74 props were sunk into
   * a collided surface, the worst of them 1.35 m into a 1.52 m bin: you saw the
   * top third of a bin and no bin.
   *
   * ── Why a sweep, and why here ────────────────────────────────────────────
   * Same reasoning as `_solidifyProps`, which is a few lines below: the scatter
   * is emitted in bulk from a dozen loops, and a height lookup that has to be
   * remembered at each of them is a height lookup that will be forgotten at the
   * next one. A sweep over what was actually built cannot drift from it.
   *
   * It runs before `_solidifyProps` deliberately. At this point the props
   * themselves carry no colliders, so a downward probe answers with the deck or
   * the platform rather than with the prop's own body - and the collider that
   * pass then builds is placed at the corrected height rather than the wrong
   * one.
   *
   * ── What it will not touch ───────────────────────────────────────────────
   * It only ever lifts, and only when the surface it finds is inside the prop's
   * own height. So a crate resting on a shelf that was drawn without a collider
   * is left alone (the probe finds the floor *below* it and does nothing), and
   * anything deliberately in the air - the canopy rigging at 48 m, a crane's
   * slung load - is left alone too, because the drop to the deck is far larger
   * than the prop is tall.
   */
  /**
   * Settle the hub's scatter groups.
   *
   * Restricted to the passes that emit loose props onto the deck and leave them
   * to `_solidifyProps` to collide. The outer zones are excluded on purpose:
   * they author a collider beside every prop they place, so lifting the drawn
   * instance here would leave its collider behind at the old height - a worse
   * defect than the one being fixed.
   */
  _settleDressing() {
    const groups = ['dressing', 'monument', 'cargo', 'control', 'skyline', 'commercial', 'hangar']
      .map((n) => this.group.getObjectByName(n))
      .filter(Boolean);
    return this._settleScatter(groups);
  }

  _settleScatter(groups) {
    const t0 = performance.now();
    this.group.updateMatrixWorld(true);

    /* ── The support set, and why it is the DRAWN geometry ─────────────────
     * The first version of this probed `physics.groundHeight`, which is fast
     * and wrong here: at this point in the build only hand-authored boxes are
     * colliders, and most of the raised surfaces a prop can sink into - the
     * plaza's grate platforms, the skyline plinths, the monument's steps - are
     * drawn geometry that `_solidifyStructure` will not collide until three
     * steps later. It found 7 of the 74 sunk props and left the rest.
     *
     * So the probe is a raycast against the merged batches instead. Instanced
     * meshes are excluded, which is the important half: a crate must not be
     * held up by the crate beside it, and a crate legitimately stacked on
     * another one sees only the floor far below and is correctly left alone.
     */
    /* Triangle cap, and the deck handled separately.
     *
     * `THREE.Mesh.raycast` has no acceleration structure: a ray whose bounding
     * box test passes walks every triangle in the mesh. A merged district batch
     * is 90,000 of them, and the deck and the dome are in every prop's way, so
     * the honest version of this pass measured 10.9 s and put the world build
     * from 2.4 s to 14.4.
     *
     * The big flat plates - the deck, the zone decks, the dome floor - are also
     * the ones `physics.groundHeight` already answers for in microseconds,
     * because they are authored box colliders. So they are dropped from the
     * raycast and folded back in as a floor underneath the result. What is left
     * to raycast is the small stuff a prop can actually be sunk into: platform
     * plates, plinths, steps, kerbs, pads.
     */
    const MAX_TRIS = 20000;
    const supports = [];
    const boxes = [];
    this.group.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh || !o.visible || !o.geometry) return;
      const g = o.geometry;
      const idx = g.getIndex();
      const tris = (idx ? idx.count : (g.getAttribute('position')?.count ?? 0)) / 3;
      if (tris > MAX_TRIS) return;
      if (!g.boundingBox) g.computeBoundingBox();
      const b = new THREE.Box3().copy(g.boundingBox).applyMatrix4(o.matrixWorld);
      supports.push(o);
      boxes.push(b);
    });

    /* A grid over those boxes. Without it this is every prop against every
     * merged batch on the map - and a merged batch has no internal tree, so a
     * bounding-box hit walks all of its triangles. Measured in the browser at
     * 15 s for 1,400 props; with the grid each prop tests a handful. */
    const CELL = 24;
    const grid = new Map();
    const key = (i, j) => i * 100003 + j;
    for (let n = 0; n < boxes.length; n++) {
      const b = boxes[n];
      const i0 = Math.floor(b.min.x / CELL), i1 = Math.floor(b.max.x / CELL);
      const j0 = Math.floor(b.min.z / CELL), j1 = Math.floor(b.max.z / CELL);
      // A batch spanning the whole map would be listed in every cell; those are
      // the decks and the dome, and they are exactly what a prop needs to find,
      // so they go in a short always-tested list instead.
      if ((i1 - i0) * (j1 - j0) > 400) { (grid.__wide ??= []).push(n); continue; }
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const k = key(i, j);
          let list = grid.get(k);
          if (!list) grid.set(k, (list = []));
          list.push(n);
        }
      }
    }
    const wide = grid.__wide ?? [];

    const rc = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);
    const origin = new THREE.Vector3();
    const bb = new THREE.Box3();
    const world = new THREE.Box3();
    const m = new THREE.Matrix4();
    const near = [];
    let moved = 0, worst = 0, checked = 0;

    for (const group of groups) {
      group.traverse((o) => {
        if (!o.isInstancedMesh || !o.geometry) return;
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        bb.copy(o.geometry.boundingBox);
        let dirty = false;
        for (let i = 0; i < o.count; i++) {
          o.getMatrixAt(i, m);
          world.copy(bb).applyMatrix4(m).applyMatrix4(o.matrixWorld);
          const h = world.max.y - world.min.y;
          // Trim, decals and cable runs are meant to lie flush; leave them.
          if (h < 0.4) continue;
          checked++;
          const cx = (world.min.x + world.max.x) / 2;
          const cz = (world.min.z + world.max.z) / 2;

          // The authored floor, which covers the decks and everything else with
          // a collider, for free.
          let surf = this.physics.groundHeight(cx, cz, world.max.y + 0.6, h + 6);
          if (surf === null) surf = -Infinity;

          /* Only bother raycasting where something could plausibly be sunk
           * into: a candidate whose box contains this XZ and whose top is
           * ABOVE the prop's base. On open deck - which is most of the map -
           * nothing qualifies and the raycast is skipped entirely. This is the
           * difference between 4.9 s and a fifth of that, and it cannot change
           * the answer: a candidate that fails this test cannot produce a
           * positive `sink`. */
          near.length = 0;
          const cell = grid.get(key(Math.floor(cx / CELL), Math.floor(cz / CELL)));
          const consider = (n) => {
            const b = boxes[n];
            if (b.max.y <= world.min.y + 0.12) return;
            if (cx < b.min.x || cx > b.max.x || cz < b.min.z || cz > b.max.z) return;
            near.push(supports[n]);
          };
          if (cell) for (const n of cell) consider(n);
          for (const n of wide) consider(n);
          if (near.length) {
            origin.set(cx, world.max.y - 0.02, cz);
            rc.set(origin, down);
            rc.far = h + 2.5;
            const hit = rc.intersectObjects(near, false)[0];
            if (hit && hit.point.y > surf) surf = hit.point.y;
          }
          if (surf === -Infinity) continue;
          const sink = surf - world.min.y;
          // Only ever lift, and only out of something it is genuinely inside.
          if (sink <= 0.12 || sink >= h * 0.95) continue;
          m.elements[13] += sink;        // translation Y, in the mesh's own frame
          o.setMatrixAt(i, m);
          dirty = true;
          moved++;
          if (sink > worst) worst = sink;
        }
        if (dirty) {
          o.instanceMatrix.needsUpdate = true;
          o.computeBoundingSphere();
        }
      });
    }
    console.info(
      `[station] set dressing settled: ${moved} of ${checked} props lifted out of the surface ` +
      `they were sunk into (worst ${worst.toFixed(2)} m, ${Math.round(performance.now() - t0)}ms)`
    );
    return moved;
  }

  /** Y-rotated solid volume - buildings, walkway segments, kerbs. */
  _solidRot(x, y, z, hx, hy, hz, ry) {
    return this.track(
      this.physics.addRotatedBox(_v1.set(x, y, z), _v2.set(hx, hy, hz), ry)
    );
  }

  /**
   * A walkable ramp. Physics only rotates boxes about Y, so tilted surfaces go
   * through an invisible proxy mesh whose full world matrix is baked instead.
   */
  _ramp(x, y, z, width, run, rise, yaw) {
    const len = Math.hypot(run, rise);
    const pitch = Math.atan2(rise, run);
    const proxy = new THREE.Mesh(new THREE.BoxGeometry(width, 0.5, len));
    proxy.visible = false;
    proxy.position.set(x, y, z);
    proxy.rotation.set(0, yaw, 0, 'YXZ');
    proxy.rotateX(-pitch);
    proxy.updateWorldMatrix(true, false);
    this.group.add(proxy);
    this.track(this.physics.addBoxFromObject(proxy));
    return proxy;
  }

  _mmRect(x, z, w, d, rotation, fill, stroke) {
    this.minimapShapes.push({ kind: 'rect', x, z, w, d, rotation: rotation || 0, fill, stroke });
  }

  _mmCircle(x, z, r, fill, stroke) {
    this.minimapShapes.push({ kind: 'circle', x, z, r, fill, stroke });
  }

  _mmPath(points, stroke, width, closed) {
    this.minimapShapes.push({ kind: 'path', points, stroke, width, closed: !!closed });
  }

  /**
   * Queue a contact-occlusion patch on the deck under a prop.
   *
   * Screen-space AO is tuned for metre-scale creases and never darkens the
   * 20 cm where a bollard meets the floor, so props read as decals pasted onto
   * the deck. These flush at the end of dressing as one instanced draw call.
   */
  _contact(x, z, size, y = 0.055) {
    this._contacts.push([x, y, z, -Math.PI / 2, 0, 0, size, size, size]);
  }

  /**
   * Building-local (lx, ly, lz) -> world, matching `GeoBatch.localAt` exactly.
   * Build-time only, so allocating the result is fine.
   */
  _localPoint(ox, oz, yaw, lx, ly, lz) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return new THREE.Vector3(ox + lx * c + lz * s, ly, oz - lx * s + lz * c);
  }

  /**
   * Place an atlas sign so it can only ever be read the right way round.
   *
   * A PlaneGeometry faces +Z; rotating it by PI to aim it at something shows
   * its *back*, and a text atlas seen through its back face renders mirrored -
   * the single most credibility-destroying defect in the last review. `M.signs`
   * is FrontSide, so instead of relying on DoubleSide this emits a front-facing
   * quad, an opaque backer board behind it and, for signs that hang in open
   * space, a second correctly-wound quad on the reverse.
   */
  _signBoard(B, cell, w, h, x, y, z, yaw, opts = {}) {
    const quad = () => {
      const q = new THREE.PlaneGeometry(w, h);
      signUV(q, cell);
      return q;
    };
    // Facing normal of a +Z plane after a yaw rotation.
    const nx = Math.sin(yaw), nz = Math.cos(yaw);
    const t = opts.thickness ?? 0.18;
    B.at('signs', quad(), x + nx * t * 0.55, y, z + nz * t * 0.55, yaw);
    if (opts.twoSided) B.at('signs', quad(), x - nx * t * 0.55, y, z - nz * t * 0.55, yaw + Math.PI);
    if (opts.backer !== false) {
      B.at(opts.backerKey ?? 'panelDark', boxGeo(w * 1.07, h * 1.24, t, 2), x, y, z, yaw);
    }
    if (opts.accent) {
      B.at(opts.accent, boxGeo(w * 1.07, 0.1, t * 1.15, 1), x, y - h * 0.63, z, yaw);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Space beyond the glass                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Everything outside the hull. All of it opts out of fog and shadows - it is
   * hundreds of metres away and must stay crisp behind the interior haze.
   */
  _buildSpace() {
    const g = new THREE.Group();
    g.name = 'space';
    this.group.add(g);
    const rng = mulberry32(0xa11ce);

    // Starfield shell. depthWrite off + a very low render order means it never
    // occludes the objects we place "inside" it.
    const domeGeo = new THREE.SphereGeometry(1500, 48, 32);
    const domeMat = new THREE.MeshBasicMaterial({
      map: this._tex.stars,
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
      toneMapped: true,
    });
    const dome = new THREE.Mesh(domeGeo, domeMat);
    dome.renderOrder = -1000;
    dome.frustumCulled = false;
    dome.castShadow = dome.receiveShadow = false;
    g.add(dome);
    this._skyMat = domeMat;

    // The planet the station orbits, framed by the window sector at +X.
    const planetMat = new THREE.MeshStandardMaterial({
      map: this._tex.planet,
      roughness: 0.95,
      metalness: 0.0,
      fog: false,
      emissive: 0x1a2233,
      emissiveIntensity: 0.35,
    });
    const planet = new THREE.Mesh(new THREE.SphereGeometry(430, 72, 48), planetMat);
    planet.position.set(1120, 190, 250);
    planet.rotation.z = 0.22;
    planet.castShadow = planet.receiveShadow = false;
    planet.frustumCulled = false;
    g.add(planet);
    this._anim.planet = planet;

    // Fresnel atmosphere. A tiny shader is cheaper and far better looking than
    // stacking transparent shells.
    const atmoMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0x6fb6ff) },
        uPower: { value: 3.1 },
        uIntensity: { value: 1.35 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vN; varying vec3 vV;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vN = normalize(mat3(modelMatrix) * normal);
          vV = normalize(cameraPosition - wp.xyz);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uPower; uniform float uIntensity;
        varying vec3 vN; varying vec3 vV;
        void main() {
          float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), uPower);
          gl_FragColor = vec4(uColor * f * uIntensity, f);
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.BackSide,
      fog: false,
    });
    const atmo = new THREE.Mesh(new THREE.SphereGeometry(452, 48, 32), atmoMat);
    atmo.position.copy(planet.position);
    atmo.frustumCulled = false;
    g.add(atmo);
    this._atmoMat = atmoMat;

    /* A moon almost directly overhead, framed by the ceiling oculus.
     * The oculus only earns its place if there is something to look at through
     * it: an empty starfield still reads as a hole in the roof. Sitting the
     * moon at ~72 degrees elevation puts it inside the 30-degree cone the
     * opening subtends from the plaza, so it is the payoff for looking up.
     */
    /* Round 3 put this at (-190, 980, 150) with r=150. From the plaza spawn
     * that is not inside the oculus cone at all - it clipped the top-right
     * corner of the hero frame as a lumpy 150 m sand-coloured mass with no rim,
     * no separation and a palette nothing else in the image shares. It was the
     * single most frame-breaking element in the build.
     *
     * Fixed three ways: pushed to 2400 m on a near-vertical bearing so it sits
     * centred in the opening and subtends the same angle from a distance that
     * reads as *astronomical*; re-tinted cool blue-grey so it belongs to the
     * world's cyan/slate script instead of fighting it; and left as a
     * MeshStandardMaterial with almost no emissive so the scene's sun
     * (env.sunDirection, raking in through the window wall on +X) carves a real
     * terminator across it rather than flat-lighting a ball. */
    const moonMat = new THREE.MeshStandardMaterial({
      map: this._tex.planet,
      color: 0x8296b4,
      roughness: 1.0,
      metalness: 0.0,
      fog: false,
      // Just enough that the night side is a dark blue silhouette rather than a
      // hole; anything more and the terminator disappears again.
      emissive: 0x090d16,
      emissiveIntensity: 0.55,
    });
    // 1500 m, not further: CONFIG.render.camera.far is 2000, so anything beyond
    // ~1700 is depth-clipped and simply vanishes.
    const moon = new THREE.Mesh(new THREE.SphereGeometry(260, 56, 36), moonMat);
    moon.position.set(-52, 1500, 34);
    moon.rotation.set(0.4, 1.1, 0.3);
    moon.castShadow = moon.receiveShadow = false;
    moon.frustumCulled = false;
    g.add(moon);
    this._anim.moon = moon;

    // Nebula wash behind the moon so the opening is never a pure black disc.
    const nebulaMat = new THREE.MeshBasicMaterial({
      map: this._tex.stars,
      color: 0x4d6ea8,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.BackSide,
      fog: false,
      toneMapped: true,
    });
    const nebula = new THREE.Mesh(new THREE.SphereGeometry(1300, 24, 16, 0, Math.PI * 2, 0, 0.62), nebulaMat);
    nebula.renderOrder = -999;
    nebula.frustumCulled = false;
    nebula.castShadow = nebula.receiveShadow = false;
    g.add(nebula);

    // Distant station superstructure: a counter-rotating ring module with
    // spokes, silhouetted against the planet for parallax.
    const far = new THREE.Group();
    far.position.set(640, 120, -420);
    far.rotation.set(0.5, 0.7, 0.2);
    const farMat = new THREE.MeshStandardMaterial({
      color: 0x6a7382, metalness: 0.95, roughness: 0.42, fog: false, envMapIntensity: 1.4,
    });
    const farEm = new THREE.MeshBasicMaterial({ color: 0x9fe8ff, fog: false, toneMapped: true });
    const spin = new THREE.Group();
    spin.add(new THREE.Mesh(new THREE.TorusGeometry(90, 9, 12, 64), farMat));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      // Long axis is local +Y, so a Z-rotation aims it straight down the radius.
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(5, 90, 5), farMat);
      spoke.position.set(Math.cos(a) * 45, Math.sin(a) * 45, 0);
      spoke.rotation.z = a - Math.PI / 2;
      spin.add(spoke);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(2.4, 8, 6), farEm);
      lamp.position.set(Math.cos(a) * 90, Math.sin(a) * 90, 0);
      spin.add(lamp);
    }
    far.add(spin);
    const hubMat = farMat;
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(16, 16, 60, 16), hubMat);
    hub.rotation.x = Math.PI / 2;
    far.add(hub);
    const dish = new THREE.Mesh(new THREE.SphereGeometry(24, 20, 12, 0, Math.PI * 2, 0, 0.9), hubMat);
    dish.position.set(0, 0, 42);
    dish.rotation.x = -0.6;
    far.add(dish);
    far.traverse((o) => { o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; });
    g.add(far);
    this._anim.farStation = spin;

    // Traffic: shuttles and freighters on slow linear paths.
    const shipBody = new THREE.MeshStandardMaterial({
      color: 0x8d97a6, metalness: 0.9, roughness: 0.4, fog: false, envMapIntensity: 1.2,
    });
    const navRed = new THREE.MeshBasicMaterial({ color: 0xff4030, fog: false, toneMapped: true });
    const navGreen = new THREE.MeshBasicMaterial({ color: 0x40ff70, fog: false, toneMapped: true });
    const thrust = new THREE.MeshBasicMaterial({
      color: 0x9fdcff, fog: false, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: true,
    });

    for (let i = 0; i < 7; i++) {
      const ship = new THREE.Group();
      const len = 12 + rng() * 30;
      const rad = 1.6 + rng() * 3.2;
      const hullM = new THREE.Mesh(new THREE.CapsuleGeometry(rad, len, 4, 10), shipBody);
      hullM.rotation.z = Math.PI / 2;
      ship.add(hullM);
      const fin = new THREE.Mesh(new THREE.BoxGeometry(len * 0.35, rad * 0.4, rad * 4.2), shipBody);
      ship.add(fin);
      const nacL = new THREE.Mesh(new THREE.CylinderGeometry(rad * 0.5, rad * 0.55, len * 0.5, 8), shipBody);
      nacL.rotation.z = Math.PI / 2;
      nacL.position.set(-len * 0.1, 0, rad * 2.1);
      ship.add(nacL);
      const nacR = nacL.clone();
      nacR.position.z = -rad * 2.1;
      ship.add(nacR);
      const flame = new THREE.Mesh(new THREE.ConeGeometry(rad * 0.7, len * 0.7, 8, 1, true), thrust);
      flame.rotation.z = Math.PI / 2;
      flame.position.x = -(len * 0.5 + rad + len * 0.3);
      ship.add(flame);
      const l1 = new THREE.Mesh(new THREE.SphereGeometry(rad * 0.35, 6, 5), navRed);
      l1.position.set(len * 0.4, 0, rad * 2.6);
      ship.add(l1);
      const l2 = new THREE.Mesh(new THREE.SphereGeometry(rad * 0.35, 6, 5), navGreen);
      l2.position.set(len * 0.4, 0, -rad * 2.6);
      ship.add(l2);

      ship.traverse((o) => { o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; });

      const start = new THREE.Vector3(
        420 + rng() * 500,
        -160 + rng() * 340,
        -700 + rng() * 1400
      );
      const dir = new THREE.Vector3(
        -0.15 + rng() * 0.3,
        -0.08 + rng() * 0.16,
        rng() < 0.5 ? -1 : 1
      ).normalize();
      ship.position.copy(start);
      ship.quaternion.setFromUnitVectors(_v1.set(1, 0, 0), dir);
      g.add(ship);
      this._anim.ships.push({
        obj: ship, origin: start, dir,
        speed: 14 + rng() * 26, span: 900, t: rng() * 900,
      });
    }

    // A cargo hauler parked on the docking arm, seen just outside the window.
    const arm = new THREE.Group();
    arm.position.set(238, 26, 96);
    arm.rotation.y = -0.5;
    const armMat = new THREE.MeshStandardMaterial({
      color: 0x7b8593, metalness: 0.95, roughness: 0.4, fog: false, envMapIntensity: 1.4,
    });
    const boom = new THREE.Mesh(new THREE.BoxGeometry(70, 3.2, 3.2), armMat);
    boom.position.x = 35;
    arm.add(boom);
    for (let i = 0; i < 10; i++) {
      const brace = new THREE.Mesh(new THREE.BoxGeometry(0.9, 5.5, 0.9), armMat);
      brace.position.set(4 + i * 7, 0, 0);
      brace.rotation.z = i % 2 ? 0.7 : -0.7;
      arm.add(brace);
    }
    const clamp = new THREE.Mesh(new THREE.CylinderGeometry(5, 6.5, 6, 12), armMat);
    clamp.position.set(70, 0, 0);
    clamp.rotation.z = Math.PI / 2;
    arm.add(clamp);
    const hauler = new THREE.Group();
    hauler.position.set(96, 0, 0);
    const hBody = new THREE.Mesh(new THREE.BoxGeometry(56, 16, 18), armMat);
    hauler.add(hBody);
    const hNose = new THREE.Mesh(new THREE.CylinderGeometry(6, 9, 14, 10), armMat);
    hNose.rotation.z = Math.PI / 2;
    hNose.position.x = 34;
    hauler.add(hNose);
    for (let i = 0; i < 5; i++) {
      const pod = new THREE.Mesh(new THREE.BoxGeometry(9, 9, 9), armMat);
      pod.position.set(-22 + i * 10, 12, 0);
      hauler.add(pod);
    }
    const hGlow = new THREE.Mesh(new THREE.BoxGeometry(50, 1.2, 1.2), navGreen);
    hGlow.position.set(0, 8.6, 9.2);
    hauler.add(hGlow);
    const hGlow2 = hGlow.clone();
    hGlow2.position.z = -9.2;
    hauler.add(hGlow2);
    arm.add(hauler);
    arm.traverse((o) => { o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; });
    g.add(arm);
    this._anim.dockArm = arm;
  }

  /* ---------------------------------------------------------------- */
  /* Pressure hull, window wall and overhead deck                      */
  /* ---------------------------------------------------------------- */

  _buildHull() {
    const M = this.mat;
    const B = new GeoBatch();
    const g = new THREE.Group();
    g.name = 'hull';
    this.group.add(g);

    // Cylinder theta runs from +Z toward +X, so the window sector centred on
    // +X spans theta [35, 145] degrees.
    const winStart = (90 - WINDOW_HALF) * DEG;
    const winLen = WINDOW_HALF * 2 * DEG;

    /* --- Solid hull shell, with the link mouths cut out ---------------
     *
     * This used to be one 250-degree cylinder. It cannot be, now that four
     * avenues keep going: a corridor that leaves the ring has to leave through
     * something, and the hull is the only thing in the way.
     *
     * Cylinder theta runs from +Z toward +X and a compass bearing runs from +X
     * toward +Z, so the two are mirror images about 90 degrees: theta = 90 - b.
     * The window sector, centred on bearing 0, is therefore theta [35, 145],
     * and the four links at bearings 120 / 180 / 240 / 300 sit at theta 330 /
     * 270 / 210 / 150 - all inside the solid arc, which is what made those four
     * avenues the ones to extend.
     *
     * The 300 mouth is the tight one: at theta 150 with a 3.5-degree half-angle
     * it leaves 1.5 degrees of hull - about five metres - between its frame and
     * the window's edge mullion. That is deliberate rather than lucky. The
     * galley link is the only one that passes the great window, and arriving at
     * the mess with the planet over your shoulder is worth the pier being thin.
     */
    const mouths = ZONES
      .map((zone) => ((90 - zone.deg) * DEG + Math.PI * 4) % (Math.PI * 2))
      .sort((a, b) => a - b);
    const mouthHalf = LINK_MOUTH_HALF_DEG * DEG;
    const arcStart = winStart + winLen;
    const arcEnd = winStart + Math.PI * 2;
    const cuts = [];
    for (const m of mouths) {
      // Lift each mouth into the same revolution as the arc it interrupts.
      let t = m;
      while (t < arcStart) t += Math.PI * 2;
      if (t + mouthHalf < arcEnd) cuts.push(t);
    }
    cuts.sort((a, b) => a - b);

    /** Emit `fn(from, length)` for every stretch of the solid arc that survives. */
    const arcSegments = (fn) => {
      let from = arcStart;
      for (const t of cuts) {
        if (t - mouthHalf > from + 0.001) fn(from, t - mouthHalf - from);
        from = t + mouthHalf;
      }
      if (arcEnd > from + 0.001) fn(from, arcEnd - from);
    };

    /* The mouths are DOORWAYS, not slots.
     *
     * The first version cut each mouth through the full 48 m of wall, which is
     * what you get if you think of the opening as "a gap in the arc" rather than
     * as a hole in a building. From the deck it read as a 24 m wide, 48 m tall
     * slit with the hull's own transom rings - which run right round the ring at
     * 12, 24, 36 and 47 m - sailing straight across it at four heights. Long
     * horizontal tubes passing over a doorway, uninterrupted, which is exactly
     * what it looked like.
     *
     * The corridor behind is 9.5 m to its soffit and 10.1 m over its roof plate,
     * and the mouth's own lit frame sits at 11.3 to 12.6. So the wall is built
     * in two bands: below the lintel it is cut for the mouths, and above it runs
     * unbroken all the way round. The transoms above then cross solid plate,
     * where they belong.
     */
    const MOUTH_H = 11.2;
    const band = (y0, y1, cut) => {
      const emit = (from, len) => {
        const seg = new THREE.Mesh(
          uvScale(
            new THREE.CylinderGeometry(HULL_R, HULL_R, y1 - y0, Math.max(6, Math.round((len / (Math.PI * 2)) * 96)), 1, true, from, len),
            (HULL_R * len) / 10,
            (y1 - y0) / 10
          ),
          M.hullIn
        );
        seg.position.y = (y0 + y1) / 2;
        seg.castShadow = false;
        seg.receiveShadow = true;
        g.add(seg);
      };
      if (cut) arcSegments(emit);
      else emit(arcStart, arcEnd - arcStart);
    };
    band(0, MOUTH_H, true);
    band(MOUTH_H, WALL_H, false);

    // Reveal each mouth with a lit frame, so the opening reads as an aperture
    // rather than as a hole where the wall failed to generate.
    for (const t of cuts) {
      for (const s of [-1, 1]) {
        const th = t + s * mouthHalf;
        const x = Math.sin(th) * (HULL_R - 0.8);
        const z = Math.cos(th) * (HULL_R - 0.8);
        B.at('panelDark', boxGeo(1.8, 11.5, 3.4, 3), x, 5.75, z, th);
        B.at('emCyan', boxGeo(0.5, 10.5, 0.24, 1), x - Math.sin(th) * 1.6, 5.75, z - Math.cos(th) * 1.6, th);
      }
      const cx = Math.sin(t) * (HULL_R - 0.8);
      const cz = Math.cos(t) * (HULL_R - 0.8);
      B.at('panelDark', boxGeo(mouthHalf * 2 * HULL_R + 3.6, 2.2, 3.4, 3), cx, 12.6, cz, t);
      B.at('hazard', boxGeo(mouthHalf * 2 * HULL_R, 0.5, 0.3, 1), cx - Math.sin(t) * 1.7, 11.3, cz - Math.cos(t) * 1.7, t);
    }

    // --- Window wall --------------------------------------------------
    const glass = new THREE.Mesh(
      new THREE.CylinderGeometry(HULL_R, HULL_R, WALL_H, 72, 1, true, winStart, winLen),
      M.glassHull
    );
    glass.position.y = WALL_H / 2;
    glass.renderOrder = 6;
    glass.castShadow = glass.receiveShadow = false;
    g.add(glass);

    // The window leans inward at the top, so the dome reads as a dome.
    const canopy = new THREE.Mesh(
      new THREE.CylinderGeometry(HULL_R - 26, HULL_R, 20, 72, 1, true, winStart, winLen),
      M.glassHull
    );
    canopy.position.y = WALL_H + 10;
    canopy.renderOrder = 6;
    canopy.castShadow = canopy.receiveShadow = false;
    g.add(canopy);

    // --- Mullions, transoms and buttresses ---------------------------
    const mullionGeo = boxGeo(1.1, WALL_H, 2.4, 3);
    for (let i = 0; i <= 22; i++) {
      const th = winStart + (winLen * i) / 22;
      const x = Math.sin(th) * (HULL_R - 1.3);
      const z = Math.cos(th) * (HULL_R - 1.3);
      B.at('trim', mullionGeo.clone(), x, WALL_H / 2, z, th);
      // The angled canopy rib above it.
      const rib = boxGeo(1.1, 21, 2.0, 3);
      const rx = Math.sin(th) * (HULL_R - 14);
      const rz = Math.cos(th) * (HULL_R - 14);
      B.at('trim', rib, rx, WALL_H + 10, rz, th, 0.92);
    }
    mullionGeo.dispose();

    /* Horizontal transoms every 12 m.
     *
     * All but the lowest run the full ring: the link ceiling is at 9.5 m, so
     * the bands at 12 and above pass over a mouth without touching it. The one
     * at 0.9 is a 1.1 m tube sitting on the deck and would lie straight across
     * every doorway, so it is emitted in arcs like the shell above it.
     *
     * A torus's own angle runs from +X counter-clockwise while cylinder theta
     * runs from +Z toward +X, which puts them 90 degrees apart in opposite
     * senses - `phi = theta - PI/2` after the -X quarter turn that lays the ring
     * flat. Getting that relationship wrong does not fail loudly; it just puts
     * the gaps somewhere other than the doors.
     */
    for (const y of [12, 24, 36, 47.2]) {
      const t = new THREE.TorusGeometry(HULL_R - 0.6, 0.62, 8, 96);
      t.rotateX(-Math.PI / 2);
      uvScale(t, 40, 1);
      B.at('trim', t, 0, y, 0);
    }
    arcSegments((from, len) => {
      const t = new THREE.TorusGeometry(HULL_R - 0.6, 1.1, 8, Math.max(4, Math.round((len / (Math.PI * 2)) * 96)), len);
      t.rotateZ(from - Math.PI / 2);
      t.rotateX(-Math.PI / 2);
      uvScale(t, 40, 1);
      B.at('trim', t, 0, 0.9, 0);
    });

    // Exterior structural ribs on the solid section - reads as depth from
    // inside because they poke past the wall silhouette at the seams.
    const ribGeo = boxGeo(2.2, WALL_H + 14, 5, 4);
    for (let i = 0; i < 26; i++) {
      const th = winStart + winLen + ((Math.PI * 2 - winLen) * (i + 0.5)) / 26;
      // A rib is a 48 m column standing on the deck. One landing in a doorway
      // is a pillar in the middle of a corridor, so the mouths win.
      if (cuts.some((t) => Math.abs(th - t) < mouthHalf + 0.022)) continue;
      const x = Math.sin(th) * (HULL_R - 2.6);
      const z = Math.cos(th) * (HULL_R - 2.6);
      B.at('panelDark', ribGeo.clone(), x, (WALL_H + 14) / 2 - 1, z, th);
      // Conduit runs and a service ladder on every third rib.
      if (i % 3 === 0) {
        const pipe = new THREE.CylinderGeometry(0.42, 0.42, WALL_H, 8);
        uvScale(pipe, 6, WALL_H / 3);
        B.at('copper', pipe, x - Math.sin(th) * 2.4, WALL_H / 2, z - Math.cos(th) * 2.4, th);
      }
    }
    ribGeo.dispose();

    // --- Overhead deck ------------------------------------------------
    // Half the previous repeat count. A 12 m tile on a ceiling 62 m up, seen at
    // an extreme grazing angle across 400 m, lands its panel seams well inside a
    // pixel; 20 m gives the mip chain something it can actually resolve.
    /* The plate is now an annulus: a glazed oculus sits directly over the
     * monument. Round 2's ceiling was an unbroken black disc that ate the top
     * third of every frame; an oculus turns that dead area into the brightest,
     * highest-contrast element in the composition - starfield, planet limb and
     * a radial truss rose - and it gives the plaza a reason to be where it is.
     */
    const ceilRing = new THREE.RingGeometry(OCULUS_R, DECK_R + 6, 96, 1);
    uvScale(ceilRing, (DECK_R * 2) / 20, (DECK_R * 2) / 20);
    const ceil = new THREE.Mesh(ceilRing, M.ceiling);
    ceil.rotation.x = Math.PI / 2; // face down
    ceil.position.y = CEIL_Y;
    ceil.castShadow = false;
    ceil.receiveShadow = false;
    g.add(ceil);

    // Oculus glazing, its structural rose, and the machined collar that seats
    // the whole assembly into the plate.
    const oculus = new THREE.Mesh(new THREE.CircleGeometry(OCULUS_R + 0.4, 72), M.glassHull);
    oculus.rotation.x = Math.PI / 2;
    oculus.position.y = CEIL_Y - 0.3;
    oculus.renderOrder = 6;
    oculus.castShadow = oculus.receiveShadow = false;
    g.add(oculus);

    for (let i = 0; i < 20; i++) {
      const th = (i / 20) * Math.PI * 2;
      // Radial mullion, from the collar in to the hub.
      B.at('trim', boxGeo(OCULUS_R - 3.2, 0.75, 1.5, 3),
        Math.cos(th) * ((OCULUS_R + 3.2) / 2), CEIL_Y - 1.0, Math.sin(th) * ((OCULUS_R + 3.2) / 2), -th);
      // Rim downlight aimed at the plaza, tucked under the collar.
      const dx = Math.cos(th) * (OCULUS_R - 1.4), dz = Math.sin(th) * (OCULUS_R - 1.4);
      B.at('emWhite', boxGeo(2.6, 0.22, 0.7, 1), dx, CEIL_Y - 2.3, dz, -th);
      B.at('trimDark', boxGeo(3.1, 0.5, 1.2, 1), dx, CEIL_Y - 1.95, dz, -th);
      /* Louvre cage under every rim fixture.
       *
       * The blown, structureless white mass at the top of the street-level
       * frame was this ring of bare emissive cards seen from a low camera: no
       * housing, no filament, no silhouette, so the bright pass had nothing to
       * bloom *around* and smeared the lot into one featureless disc. Four
       * blades and a pair of cheeks give each fixture a hard occluding shape,
       * which is the difference between a light source and a hole in the image.
       */
      for (let b = 0; b < 4; b++) {
        const o = (b - 1.5) * 0.62;
        B.at('trimDark', boxGeo(0.12, 0.36, 0.9, 1),
          dx + Math.cos(-th) * o, CEIL_Y - 2.48, dz - Math.sin(-th) * o, -th);
      }
      for (const s2 of [-1, 1]) {
        B.at('trimDark', boxGeo(0.1, 0.44, 1.1, 1),
          dx + Math.cos(-th) * s2 * 1.42, CEIL_Y - 2.42, dz - Math.sin(-th) * s2 * 1.42, -th);
      }
    }
    for (const [rr, tube] of [[OCULUS_R, 1.15], [OCULUS_R * 0.62, 0.5], [OCULUS_R * 0.3, 0.38]]) {
      const hoop = new THREE.TorusGeometry(rr, tube, 8, 72);
      hoop.rotateX(-Math.PI / 2);
      uvScale(hoop, 40, 1);
      B.at('trim', hoop, 0, CEIL_Y - 0.9, 0);
    }
    // Emissive collar: the oculus rim is the brightest ring in the world and
    // the thing that pulls the eye up out of the deck. The reveal is an *open*
    // cylinder and the soffit an annulus - a capped drum here would plug the
    // opening with a 37 m disc and put the black ceiling straight back.
    const collar = new THREE.TorusGeometry(OCULUS_R + 1.5, 0.34, 8, 84);
    collar.rotateX(-Math.PI / 2);
    B.at('emCyan', collar, 0, CEIL_Y - 2.9, 0);
    B.at('panelDark', cylGeo(OCULUS_R + 3.4, OCULUS_R + 3.4, 3.0, 72, 2.4, true), 0, CEIL_Y - 1.5, 0);
    const soffit = new THREE.RingGeometry(OCULUS_R + 0.2, OCULUS_R + 3.4, 72, 1);
    uvScale(soffit, 24, 24);
    B.at('trim', soffit.rotateX(Math.PI / 2), 0, CEIL_Y - 3.0, 0);
    B.at('trim', cylGeo(2.6, 3.4, 2.2, 16, 1.8), 0, CEIL_Y - 1.4, 0);

    // Radial roof trusses + a ring of hanging light booms. Stopped short of the
    // oculus collar so nothing crosses the glazing.
    const TRUSS_L = DECK_R - 14 - OCULUS_R;
    const trussGeo = boxGeo(TRUSS_L, 2.2, 3.2, 5);
    for (let i = 0; i < 24; i++) {
      const th = (i / 24) * Math.PI * 2;
      const mr = OCULUS_R + 5 + TRUSS_L / 2;
      B.at('panelDark', trussGeo.clone(), Math.cos(th) * mr, CEIL_Y - 1.6, Math.sin(th) * mr, -th);
    }
    trussGeo.dispose();
    for (const rr of [60, 110, 160]) {
      const t = new THREE.TorusGeometry(rr, 1.0, 6, 72);
      t.rotateX(-Math.PI / 2);
      uvScale(t, 30, 1);
      B.at('panelDark', t, 0, CEIL_Y - 2.4, 0);
    }

    /* --- Ceiling: structure, lighting grid and service runs ------------
     *
     * Round 3's ceiling was emitted one 12 m instance per grid cell - roughly
     * seven hundred discrete boxes and rails. At 62 m up, seen across 150-200 m
     * of hall, a 12 m bar is about four pixels long with a gap after it: the eye
     * never links them into a line, so the top half of every frame read as a
     * confetti field of disconnected bright dashes floating in black. Worse,
     * only the *emissive* instances survived at all, because the M.panelDark
     * housings and grid bars around them rendered to near zero against an unlit
     * plate.
     *
     * Three rules govern the rebuild, and they are the whole fix:
     *
     *   1. ONE BEAM PER GRID LINE. Every run below spans its full chord (split
     *      only where it would cross the oculus glazing), so a rail is an
     *      unbroken converging line, not a dotted one. This is also *cheaper*:
     *      a box costs twelve triangles whatever its length, so ~90 continuous
     *      runs replace ~700 instances, and because they merge into the hull
     *      batch's existing buckets they cost no extra draw call either.
     *   2. NOTHING FLOATS. Every emitter sits inside a `trim` trough that
     *      straddles it (metal, so it catches the emitter's own light and
     *      resolves as a fixture) and every trough hangs from pendant drop rods
     *      that physically reach the plate.
     *   3. THE PLATE IS LIT. See M.ceiling - the roof occupies a value band, so
     *      the beams are silhouetted against structure instead of against a
     *      hole.
     */
    /* Round 4 postscript - why the above was still not enough.
     *
     * Continuous runs fixed the dashes and did nothing about the real defect:
     * *density* and *gauge*. Two orthogonal families of lit troughs on a 12 m
     * grid across +/-13 cells is 54 lit lines crossing at right angles, and the
     * emitter carrying each one was 0.56 m wide. At 62 m up seen from 1.7 m
     * across 100+ m of hall that is well under a pixel, so each line shimmered
     * rather than resolved and the whole upper volume read as a plaid of
     * crawling hairlines - a debug wireframe, exactly as three reviewers
     * independently called it.
     *
     * Round 5 therefore changes the *plan*, not the shading:
     *
     *   - GRID 12 -> 18 and RAIL_EVERY 2 -> 3: nine lit runs per axis becomes
     *     seven, on a coarser lattice. Fewer, further apart, individually
     *     legible.
     *   - Only ONE axis carries luminaires. The cross family is structural
     *     steel and nothing else, so the ceiling reads as beams spanned by a
     *     lighting run instead of as two competing light grids.
     *   - Every gauge roughly triples: beam 1.0 -> 1.8 m, trough 1.1 -> 2.6 m,
     *     emitter 0.56 -> 1.7 m. A fixture has to cover more than a pixel at
     *     the distance it is actually viewed from or no amount of intensity
     *     will make it read as a fixture.
     *   - The two families separate to 1.05 m and 3.9 m below the plate, so
     *     their crossings parallax apart instead of forming a flat plaid.
     *   - Each luminaire gets a wide, very low additive halo so it has a soft
     *     footprint rather than a hard one-pixel edge (see M.ceilHalo).
     */
    const GRID = 18;
    const CEIL_R = DECK_R - 8;         // outer radius of the ceiling structure
    const OC_CLEAR = OCULUS_R + 7;     // nothing crosses the oculus glazing
    const WARM_R = 86;                 // amber over the plaza core, cyan beyond

    /**
     * Cut a run [a, b] (measured along the beam axis, `perp` from it) into the
     * pieces that are inside and outside the warm core, so a single continuous
     * rail changes colour where it leaves the plaza rather than the ceiling
     * being two disjoint sets of dashes.
     * @returns {Array<[number, number, boolean]>} [start, end, isWarm]
     */
    const warmSplit = (a, b, perp) => {
      const out = [];
      const cuts = [a];
      if (Math.abs(perp) < WARM_R) {
        const t = Math.sqrt(WARM_R * WARM_R - perp * perp);
        for (const c of [-t, t]) if (c > a + 0.5 && c < b - 0.5) cuts.push(c);
      }
      cuts.push(b);
      for (let i = 0; i < cuts.length - 1; i++) {
        const s = cuts[i], e = cuts[i + 1];
        if (e - s < 2) continue;
        out.push([s, e, Math.hypot((s + e) / 2, perp) < WARM_R]);
      }
      return out;
    };

    /** Runs of a grid line, chord-clipped and cut clear of the oculus. */
    const chordRuns = (perp) => {
      const half = Math.sqrt(Math.max(0, CEIL_R * CEIL_R - perp * perp));
      if (half < GRID) return [];
      if (Math.abs(perp) >= OC_CLEAR) return [[-half, half]];
      const gap = Math.sqrt(OC_CLEAR * OC_CLEAR - perp * perp);
      const runs = [];
      if (gap < half - 4) runs.push([-half, -gap], [gap, half]);
      return runs;
    };

    const rods = [];   // pendant drop rods, the one instanced mesh left here
    const ceilShafts = [];
    const ceilShaftColors = [];
    const RAIL_EVERY = 3;
    const GI = Math.floor((CEIL_R - 4) / GRID);   // 10 cells either side at 18 m
    const _warmCol = new THREE.Color(0xffb98a);
    const _coolCol = new THREE.Color(0x8fd6ff);

    /** A wide, soft additive footprint under a luminaire run. */
    const halo = (cx, cz, len, width, warm) => {
      const q = new THREE.PlaneGeometry(width, len, 2, 1);
      q.rotateX(-Math.PI / 2);
      const pos = q.getAttribute('position');
      const col = new Float32Array(pos.count * 3);
      const c = warm ? _warmCol : _coolCol;
      for (let i = 0; i < pos.count; i++) {
        // Linear cross-section ramp: full tint down the axis, nothing at the
        // flanks, so the lozenge has no silhouette edge under additive blend.
        const t = 1 - Math.min(1, Math.abs(pos.getX(i)) / (width * 0.5));
        col[i * 3] = c.r * t; col[i * 3 + 1] = c.g * t; col[i * 3 + 2] = c.b * t;
      }
      q.setAttribute('color', new THREE.BufferAttribute(col, 3));
      B.at('ceilHalo', q, cx, CEIL_Y - 2.6, cz);
    };

    for (let gi = -GI; gi <= GI; gi++) {
      const p = gi * GRID;
      const runs = chordRuns(p);
      if (!runs.length) continue;
      const lit = gi % RAIL_EVERY === 0;
      const walkway = (gi + 1) % 3 === 0;

      // `axis` 0 = the beam runs along Z at x = p; 1 = along X at z = p. Only
      // axis 0 is ever lit: a second orthogonal family of luminaires is what
      // turned this into a plaid. Axis 1 stays pure structure, hung a further
      // 2.9 m down so the two families parallax apart from a deck camera.
      for (let axis = 0; axis < 2; axis++) {
        const beamY = CEIL_Y - (axis ? 3.9 : 1.05);
        const along = (u, v) => (axis ? [u, v] : [v, u]);   // -> [x, z]

        for (const [a, b] of runs) {
          const len = b - a, mid = (a + b) / 2;
          const [bx, bz] = along(mid, p);
          // Structural beam, full chord. Deep enough to have a soffit and a
          // web, in a material that is not black (see M.beam).
          B.at('beam',
            axis ? boxGeo(len, 1.5, 1.8, 3) : boxGeo(1.8, 1.5, len, 3),
            bx, beamY, bz);
          // Bottom flange: a hard bright line along the underside is what makes
          // a beam read as an I-section rather than as a bar.
          B.at('trim',
            axis ? boxGeo(len, 0.16, 2.5, 3) : boxGeo(2.5, 0.16, len, 3),
            bx, beamY - 0.78, bz);

          if (axis || !lit) continue;

          // Trough + emitter. The trough straddles the emitter and hangs
          // proud of it, so from deck level you read a fixture with a light
          // inside it instead of a bare glowing card.
          const tY = beamY - 0.95;
          B.at('trim', boxGeo(2.6, 0.7, len, 3), bx, tY, bz);
          // Louvre blades across the trough: structure in front of a source
          // always photographs better than a clean strip, and it breaks the
          // run into a rhythm the eye can count instead of a solid line.
          for (let d = a + 3; d < b - 2; d += 6) {
            B.at('trimDark', boxGeo(2.8, 0.5, 0.34, 1), p, tY - 0.16, d);
          }

          for (const [s, e, warm] of warmSplit(a, b, p)) {
            const sl = e - s, sm = (s + e) / 2;
            const [ex, ez] = along(sm, p);
            B.at(warm ? 'emAmber' : 'emCyan', boxGeo(1.7, 0.5, sl, 2), ex, tY - 0.42, ez);
            halo(ex, ez, sl, 7.0, warm);
          }

          // Pendant drops every 14 m: the light is physically attached.
          for (let d = a + 7; d < b - 3; d += 14) {
            const [rx, rz] = along(d, p);
            rods.push([rx, (CEIL_Y + tY) / 2, rz, 0, 0, 0, 1, (CEIL_Y - tY) / 2.6, 1]);
          }

          /* Volumetric cones off the luminaire run.
           *
           * Restricted to the plaza core: a 60 m additive cone covers a great
           * deal of screen, and the point is to grade the *hero* volume, not to
           * fill the whole ring with haze. Every 30 m along the run and only
           * inside r < 96, which is roughly one cone per hero-frame quadrant.
           */
          if (Math.abs(p) > 60) continue;
          for (let d = Math.ceil(a / 30) * 30; d < b; d += 30) {
            if (Math.hypot(d, p) > 96 || Math.hypot(d, p) < OC_CLEAR + 6) continue;
            ceilShafts.push([p, (tY - 0.6) / 2, d, 0, 0, 0, 1, 1, 1]);
            ceilShaftColors.push(Math.hypot(d, p) < WARM_R ? _warmCol : _coolCol);
          }
        }
      }

      // Every third line also carries a hung service walkway, again as one
      // continuous run - a maintenance catwalk is the strongest scale cue the
      // upper volume has, and it only works if it reads as a single object.
      if (!walkway) continue;
      for (const [a, b] of runs) {
        const len = b - a, mid = (a + b) / 2;
        B.at('grate', boxGeo(3.0, 0.34, len, 2.4), p, CEIL_Y - 7.2, mid);
        for (const lz of [1.3, -1.3]) {
          const pipe = cylGeo(0.30, 0.30, len, 6, 2.2);
          B.at('copper', pipe, p + lz, CEIL_Y - 8.1, mid, 0, Math.PI / 2, 0);
        }
        // Handrail so the catwalk has a silhouette from below. Chrome, not
        // trim: a handrail is the one thing up there allowed a sharp specular.
        for (const hx of [1.55, -1.55]) {
          B.at('chrome', boxGeo(0.11, 0.11, len, 1.6), p + hx, CEIL_Y - 6.1, mid);
          B.at('trimDark', boxGeo(0.08, 0.55, len, 1.6), p + hx, CEIL_Y - 6.7, mid);
        }
        for (let d = a + 6; d < b - 3; d += 12) {
          rods.push([p, CEIL_Y - 4.4, d, 0, 0, 0, 1.6, 2.5, 1.6]);
        }
      }
    }

    /* Oculus downshafts.
     *
     * The oculus is the brightest thing in the world and had no physical light
     * path under it at all - the reason it photographed as an unmotivated white
     * blob rather than as a source. Four wide cones landing on the plaza give
     * the blob somewhere to go.
     */
    for (let i = 0; i < 6; i++) {
      const th = (i / 6) * Math.PI * 2 + 0.3;
      ceilShafts.push([Math.cos(th) * (OCULUS_R * 0.55), (CEIL_Y - 4) / 2, Math.sin(th) * (OCULUS_R * 0.55), 0, th, 0, 1.7, 1, 1.7]);
      ceilShaftColors.push(_coolCol);
    }

    if (ceilShafts.length) {
      // Tapering from the fixture gauge out to ~3x at the deck, open-ended, and
      // fading at both ends in the shader so it has no silhouette to read as a
      // translucent solid.
      const csGeo = new THREE.CylinderGeometry(2.2, 8.5, CEIL_Y - 4.2, 20, 6, true);
      const csMesh = instanced(csGeo, M.shaftBig, ceilShafts, { cast: false, recv: false });
      if (csMesh.isInstancedMesh) {
        for (let i = 0; i < ceilShaftColors.length; i++) csMesh.setColorAt(i, ceilShaftColors[i]);
        csMesh.instanceColor.needsUpdate = true;
        csMesh.renderOrder = 8;
      }
      g.add(csMesh);
    }

    /* Ring luminaires.
     *
     * These were 96 discrete 7.5 m boxes on three rings - the "several hundred
     * white rectangles" in the street-level frame. Three continuous emissive
     * troughs read as unbroken light lines at any distance, cost three
     * geometries instead of two instanced meshes, and give the ceiling the
     * concentric structure the deck below it already has.
     */
    for (const rr of [58, 108, 158]) {
      const seg = Math.max(96, Math.round(rr * 1.2));
      const body = new THREE.TorusGeometry(rr, 0.52, 8, seg);
      body.rotateX(-Math.PI / 2);
      body.scale(1, 0.8, 1);
      uvScale(body, rr / 3, 1);
      B.at('trim', body, 0, CEIL_Y - 3.1, 0);

      const tube = new THREE.TorusGeometry(rr, 0.3, 8, seg);
      tube.rotateX(-Math.PI / 2);
      tube.scale(1, 0.7, 1);
      B.at('emWhite', tube, 0, CEIL_Y - 3.62, 0);

      // Suspension: one rod every ~9 m of circumference.
      const drops = Math.max(16, Math.round((Math.PI * 2 * rr) / 9));
      for (let i = 0; i < drops; i++) {
        const th = (i / drops) * Math.PI * 2;
        rods.push([Math.cos(th) * rr, CEIL_Y - 1.55, Math.sin(th) * rr, 0, 0, 0, 1, 1.2, 1]);
      }
    }

    // One instanced mesh for every pendant in the building.
    g.add(instanced(cylGeo(0.06, 0.06, 2.6, 6, 1.4), M.trim, rods, { cast: false, recv: false }));

    /* --- Collision ----------------------------------------------------
     *
     * A ring of tangent boxes keeps the player inside the pressure hull - and
     * it is the ONLY thing that does. The drawn hull sits at r = 202, and
     * `_collisionSoup` discards any triangle whose centroid is past `DECK_R`,
     * so nothing about the wall a player sees is collided. That is deliberate
     * and cheap, but it means this ring is load-bearing in a way that is easy
     * to miss: it was a closed circle of forty boxes, so cutting four doorways
     * through the *drawn* hull left four doorways you could see through, walk
     * up to, and not walk through. Nothing in the geometry says otherwise.
     *
     * So the ring is built from the same spans as the shell. Each surviving arc
     * is subdivided into boxes of about thirty metres of chord with a healthy
     * overlap, rather than the old fixed forty: an arc that happens to be
     * slightly shorter than one box would otherwise vanish entirely.
     */
    let hullBoxes = 0;
    arcSegments((from, len) => {
      const n = Math.max(1, Math.round((HULL_R * len) / 30));
      const step = len / n;
      for (let i = 0; i < n; i++) {
        // Cylinder theta -> bearing. `_solidRot`'s local +Z must end up radial,
        // which for a bearing `a` is `PI/2 - a`; here that is simply `th`.
        const th = from + step * (i + 0.5);
        const bearing = Math.PI / 2 - th;
        const x = Math.cos(bearing) * (HULL_R + 1.5);
        const z = Math.sin(bearing) * (HULL_R + 1.5);
        // 0.56 rather than a half: neighbouring boxes have to overlap or the
        // seams between them are hairline gaps a capsule can squeeze through.
        this._solidRot(x, WALL_H / 2, z, HULL_R * step * 0.56, WALL_H / 2 + 12, 2.0, th);
        hullBoxes++;
      }
    });
    console.info(`[station] hull collision: ${hullBoxes} panels, ${cuts.length} link mouths left open`);

    for (const mesh of B.flush(g, M, 'hull', {
      cast: false, recv: true, ceilHalo: { cast: false, recv: false },
    })) {
      // Additive, unlit, and it must draw after the plate it sits under.
      if (mesh.name === 'hull:ceilHalo') mesh.renderOrder = 6;
    }

    this._mmCircle(0, 0, DECK_R, 'rgba(12,20,30,0.55)', 'rgba(90,180,220,0.35)');
    // Window arc, drawn as a bright stroke so the minimap reads orientation.
    const arc = [];
    for (let i = 0; i <= 24; i++) {
      const th = -WINDOW_HALF * DEG + (WINDOW_HALF * 2 * DEG * i) / 24;
      arc.push([Math.cos(th) * (DECK_R - 2), Math.sin(th) * (DECK_R - 2)]);
    }
    this._mmPath(arc, 'rgba(120,230,255,0.85)', 3, false);
  }

  /* ---------------------------------------------------------------- */
  /* Deck, plaza and the six avenues                                   */
  /* ---------------------------------------------------------------- */

  _buildDeck() {
    const M = this.mat;
    const B = new GeoBatch();
    const g = new THREE.Group();
    g.name = 'deck';
    this.group.add(g);
    const rng = mulberry32(0xd3c0);

    // Deck slab. One collider for the whole floor - flat is flat.
    // 12 m per tile rather than 8: the deck fills the bottom half of every wide
    // shot, and at 8 m the plate seams were interfering into a herringbone.
    const floor = new THREE.Mesh(
      uvScale(new THREE.CircleGeometry(DECK_R + 4, 96), (DECK_R * 2) / 12, (DECK_R * 2) / 12),
      M.deck
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    floor.castShadow = false;
    g.add(floor);
    this._solid(0, -3, 0, DECK_R + 12, 3, DECK_R + 12);

    // Plaza inlay.
    const plaza = new THREE.Mesh(
      uvScale(new THREE.CircleGeometry(PLAZA_R, 80), (PLAZA_R * 2) / 12, (PLAZA_R * 2) / 12),
      M.plaza
    );
    plaza.rotation.x = -Math.PI / 2;
    plaza.position.y = 0.08;
    plaza.receiveShadow = true;
    plaza.castShadow = false;
    g.add(plaza);

    /* Concentric seams sunk into the plaza.
     *
     * These were bare emissive tori lying on the deck - a uniform flat-colour
     * band with no shading variation along its whole length, no fixture and no
     * contact, which is why the foreground one was read as a "yellow tube"
     * rather than as a lit seam. Each is now a recessed metal channel with the
     * emitter sunk *inside* it: the channel catches the light unevenly along
     * its run, the emitter is occluded at grazing angles, and the whole thing
     * reads as inlaid rather than laid on top.
     */
    for (const rr of [14, 22, 30, 37]) {
      const chan = new THREE.TorusGeometry(rr, 0.30, 6, 120);
      chan.rotateX(-Math.PI / 2);
      chan.scale(1, 0.42, 1);
      uvScale(chan, rr * 2, 1);
      B.at('trimDark', chan, 0, 0.11, 0);

      const t = new THREE.TorusGeometry(rr, 0.13, 5, 120);
      t.rotateX(-Math.PI / 2);
      t.scale(1, 0.55, 1);
      uvScale(t, 24, 1);
      B.at(rr === 30 ? 'emAmber' : 'emCyan', t, 0, 0.14, 0);
    }
    // Radial inlay ribbons between the avenues.
    const inlay = boxGeo(PLAZA_R - 4, 0.06, 0.5, 3);
    for (let i = 0; i < 12; i++) {
      const th = (i / 12) * Math.PI * 2 + Math.PI / 12;
      B.at('trim', inlay.clone(), Math.cos(th) * (PLAZA_R / 2 + 2), 0.14, Math.sin(th) * (PLAZA_R / 2 + 2), -th);
    }
    inlay.dispose();

    // Plaza kerb ring - a flush inlaid lip, not a pipe lying on the deck.
    const kerbRing = new THREE.TorusGeometry(PLAZA_R + 0.3, 0.16, 5, 120);
    kerbRing.rotateX(-Math.PI / 2);
    kerbRing.scale(1, 0.55, 1);
    uvScale(kerbRing, 150, 1);
    B.at('hazard', kerbRing, 0, 0.09, 0);

    /* --- Avenues ---------------------------------------------------- */
    this.roadAngles = [0, 60, 120, 180, 240, 300];
    const R0 = PLAZA_R - 3;
    const R1 = DECK_R - 12;
    const L = R1 - R0;
    const stripEntries = [];
    const decalCells = [];

    for (const deg of this.roadAngles) {
      const yaw = -deg * DEG - Math.PI / 2;
      const mid = roadPos(deg, (R0 + R1) / 2, 0, 0.10, new THREE.Vector3());

      const geo = new THREE.PlaneGeometry(ROAD_W, L);
      geo.rotateX(-Math.PI / 2);
      uvScale(geo, 1, L / ROAD_W);
      const road = new THREE.Mesh(geo, M.road);
      road.position.copy(mid);
      road.rotation.y = yaw;
      road.receiveShadow = true;
      road.castShadow = false;
      g.add(road);

      // Kerbs: hazard-striped lips that terminate the carriageway.
      for (const s of [-1, 1]) {
        const kerb = boxGeo(0.9, 0.34, L, 2);
        const p = roadPos(deg, (R0 + R1) / 2, s * (ROAD_W / 2 + 0.45), 0.17, new THREE.Vector3());
        B.at('hazard', kerb, p.x, p.y, p.z, yaw);
      }

      // Inset light strips down both sides of every avenue.
      const segs = Math.floor(L / 6);
      for (let i = 0; i < segs; i++) {
        const r = R0 + 3 + i * 6;
        for (const s of [-1, 1]) {
          const p = roadPos(deg, r, s * 6.57, 0.14, new THREE.Vector3());
          stripEntries.push([p.x, p.y, p.z, 0, yaw, 0, 1, 1, 1]);
        }
      }

      // Floor decals along the avenue: chevrons, arrows, hold lines, numbers.
      for (let i = 0; i < 9; i++) {
        const r = R0 + 10 + i * (L / 9);
        const cell = [0, 1, 3, 4, 8, 12, 13, 14, 2][i % 9];
        const off = i % 2 ? 5.4 : -5.4;
        const p = roadPos(deg, r, off, 0.135, new THREE.Vector3());
        decalCells.push({ cell, x: p.x, z: p.z, size: 4.2, yaw });
      }
      this._mmPath(
        [
          [Math.cos(deg * DEG) * R0, Math.sin(deg * DEG) * R0],
          [Math.cos(deg * DEG) * R1, Math.sin(deg * DEG) * R1],
        ],
        'rgba(150,200,230,0.5)',
        ROAD_W,
        false
      );
    }

    // Long axis is local Z, which the avenue yaw maps onto the carriageway.
    const strips = instanced(boxGeo(0.42, 0.1, 5.4, 3), M.emCyan, stripEntries, { cast: false, recv: false });
    g.add(strips);

    /* --- Traffic-lane wear ------------------------------------------
     * A transit deck is a patchwork of wear zones, not one uniform reflective
     * sheet. The strongest tell in the round-2 frames was that the floor
     * answered light identically from the camera to the horizon. Painted lanes
     * radiating from the dais to each gateway and each avenue mouth break the
     * grazing-angle specular, and they double as a navigation affordance:
     * a worn path tells the player where the traffic goes.
     */
    for (const bearing of [90, 270, 0, 60, 120, 180, 240, 300]) {
      const th = bearing * DEG;
      const isGate = bearing === 90 || bearing === 270;
      const span = isGate ? 40 : 54;
      const steps = isGate ? 7 : 9;
      for (let i = 0; i < steps; i++) {
        const r = 14 + (span / steps) * i;
        // Cell 10 is the grime/scuff stain: a wear path, not painted lineage.
        // Anything graphic here (arrows, grating, hazard) turns the plaza into
        // a car park floor - the wear has to read as traffic, not as signage.
        decalCells.push({
          cell: 10,
          x: Math.cos(th) * r,
          z: Math.sin(th) * r,
          size: 7.5 + (i % 2) * 2.5,
          yaw: -th,
        });
        // One directional callout per run, at the plaza edge only.
        if (i === steps - 1) {
          decalCells.push({
            cell: isGate ? 1 : 0,
            x: Math.cos(th) * (r + 3),
            z: Math.sin(th) * (r + 3),
            size: 3.6,
            yaw: -th + (isGate ? Math.PI / 2 : 0),
          });
        }
      }
    }

    /* --- Scattered decals -------------------------------------------
     *
     * ── Why these are rejected against each other ─────────────────────
     * Each of the three loops below used to take a bare random bearing and
     * radius and commit it, with nothing stopping two - or six - landing on
     * the same square metre. Sixty decals averaging five metres across go into
     * a plaza annulus of about 4,600 m², so a third of it is covered and
     * collisions are not unlucky, they are arithmetic. Where several bold
     * cells stacked, the hazard hatching, dock circles and callouts piled into
     * an unreadable yellow scribble - reported on the deck just off the plaza
     * kerb, and visible from any height.
     *
     * `scatter` re-rolls a placement that lands too close to one already
     * committed, which keeps the count while spreading them out. Grime is
     * allowed to sit much closer than paint: overlapping dirt is what dirt
     * does, whereas two overlapping chevrons are a mistake.
     *
     * ── And why the radius is a square root ───────────────────────────
     * `r = lo + rand*(hi-lo)` is uniform in *radius*, which is not uniform in
     * *area* - it packs the inner ring at the expense of the outer one and
     * makes the clumping worse exactly where the plaza is busiest. Sampling
     * r = sqrt(lo² + rand*(hi²-lo²)) spreads them evenly over the annulus.
     */
    const annulus = (lo, hi) => Math.sqrt(lo * lo + rng() * (hi * hi - lo * lo));
    const scatter = (make, spacing, tries = 8) => {
      for (let t = 0; t < tries; t++) {
        const d = make();
        let clear = true;
        for (const o of decalCells) {
          if (Math.hypot(o.x - d.x, o.z - d.z) < (o.size + d.size) * spacing) { clear = false; break; }
        }
        if (clear) { decalCells.push(d); return; }
      }
    };
    const pick = (list) => list[Math.floor(rng() * list.length)];

    // Plaza decals: dock circles, walkway callouts, spill stains.
    for (let i = 0; i < 26; i++) {
      scatter(() => {
        const th = rng() * Math.PI * 2;
        const rr = annulus(8, PLAZA_R - 4);
        return {
          cell: pick([2, 6, 7, 10, 11, 13, 15]),
          x: Math.cos(th) * rr, z: Math.sin(th) * rr,
          size: 3.4 + rng() * 3.6, yaw: rng() * Math.PI * 2,
        };
      }, 0.5);
    }
    // Scattered grime and cable runs across the open deck.
    for (let i = 0; i < 110; i++) {
      scatter(() => {
        const th = rng() * Math.PI * 2;
        const rr = annulus(PLAZA_R, DECK_R - 16);
        return {
          cell: pick([10, 11, 10, 7]),
          x: Math.cos(th) * rr, z: Math.sin(th) * rr,
          size: 4 + rng() * 7, yaw: rng() * Math.PI * 2,
        };
      }, 0.3);
    }
    // Grime inside the plaza itself. The bottom of every hero frame is plaza
    // inlay, and an inlay with no oil, no scuffing and no service hatches is
    // the clearest "untextured slab" tell in the set.
    for (let i = 0; i < 34; i++) {
      scatter(() => {
        const th = rng() * Math.PI * 2;
        const rr = annulus(12, PLAZA_R - 1);
        return {
          cell: pick([10, 11, 7, 10, 11]),
          x: Math.cos(th) * rr, z: Math.sin(th) * rr,
          size: 2.6 + rng() * 4.4, yaw: rng() * Math.PI * 2,
        };
      }, 0.3);
    }

    /* --- Radial wayfinding -------------------------------------------
     *
     * The world had exactly one axis of floor navigation language - the chevron
     * run down the +Z gateway approach - so the moment a player stepped off it
     * the plaza was an undifferentiated tiled field and every bearing looked
     * identical. Six painted routes, one per avenue, each in its district's
     * accent colour and each carrying a lit centre inlay and a chevron run,
     * turn the plaza from a field into a hub: colour itself becomes the
     * wayfinding signal, which is also the cheapest colour zoning available
     * (the frame had no chromatic events at all outside the portals).
     */
    /* District emissive families, not per-fixture accents.
     *
     * Round 4 was effectively a single chord - cyan plus amber over navy - so
     * no bearing out of the plaza had a colour identity and the eye could not
     * tell transit from retail from industrial. Three families now split the
     * ring: magenta owns retail, sodium owns the service and cargo arc, and
     * cyan is reserved for wayfinding and the cold utility side. Each avenue
     * mouth is identifiable by hue alone from the plaza centre, which is the
     * cheapest orientation cue an open world has.
     */
    const ROUTE_ACCENT = {
      0: [0xff8fd8, 'emMagenta'],   // commercial strip - retail
      60: [0xffbe86, 'emSodium'],   // hangar apron - service
      120: [0x8fe6c8, 'emCyan'],    // habitat - cold utility
      180: [0xc9b0ff, 'emMagenta'], // control tower approach
      240: [0xff9d6a, 'emSodium'],  // cargo yard - industrial
      300: [0x9fd4ff, 'emCyan'],    // residential terrace
    };
    const routeGeos = [];
    for (const deg of this.roadAngles) {
      const [hex, em] = ROUTE_ACCENT[deg];
      _col.set(hex);
      const th = deg * DEG;
      const c = Math.cos(th), s = Math.sin(th);
      const r0 = 9, r1 = PLAZA_R + 5;
      // Painted band. Two strips either side of the centre line rather than one
      // wide one - a solid 2 m colour block reads as a rug, a pair of lines
      // reads as a route.
      for (const off of [-0.85, 0.85]) {
        const q = new THREE.PlaneGeometry(r1 - r0, 0.5);
        q.rotateX(-Math.PI / 2);
        uvScale(q, (r1 - r0) / 12, 0.5 / 12);
        _euler.set(0, -th, 0);
        _quat.setFromEuler(_euler);
        _mat4.compose(
          _v1.set(c * (r0 + r1) / 2 - s * off, 0.115, s * (r0 + r1) / 2 + c * off),
          _quat, _scl.set(1, 1, 1)
        );
        q.applyMatrix4(_mat4);
        const n = q.getAttribute('position').count;
        const col = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          col[i * 3] = _col.r; col[i * 3 + 1] = _col.g; col[i * 3 + 2] = _col.b;
        }
        q.setAttribute('color', new THREE.BufferAttribute(col, 3));
        routeGeos.push(q);
      }
      // Lit centre inlay, flush in the plate.
      B.at(em, boxGeo(r1 - r0, 0.05, 0.14, 1), c * (r0 + r1) / 2, 0.12, s * (r0 + r1) / 2, -th);
      // Chevron run pointing outward down the avenue.
      for (let i = 0; i < 5; i++) {
        const rr = r0 + 3 + i * ((r1 - r0 - 6) / 4);
        decalCells.push({
          cell: 0, x: c * rr, z: s * rr, size: 3.4, yaw: -th + Math.PI / 2,
        });
      }
      // Bearing marker where the route leaves the plaza kerb.
      decalCells.push({ cell: 1, x: c * (PLAZA_R - 3), z: s * (PLAZA_R - 3), size: 3.0, yaw: -th + Math.PI / 2 });
    }
    if (routeGeos.length) {
      const routeMesh = new THREE.Mesh(mergeGeometries(routeGeos, false), M.route);
      for (const q of routeGeos) q.dispose();
      routeMesh.receiveShadow = true;
      routeMesh.castShadow = false;
      routeMesh.renderOrder = 1;
      g.add(routeMesh);
    }

    const decalGeos = [];
    for (const d of decalCells) {
      const q = new THREE.PlaneGeometry(d.size, d.size);
      q.rotateX(-Math.PI / 2);
      atlasUV(q, d.cell % 4, Math.floor(d.cell / 4), 4, 4);
      _euler.set(0, d.yaw, 0);
      _quat.setFromEuler(_euler);
      _mat4.compose(_v1.set(d.x, 0.13, d.z), _quat, _scl.set(1, 1, 1));
      q.applyMatrix4(_mat4);
      decalGeos.push(q);
    }
    const decalMesh = new THREE.Mesh(mergeGeometries(decalGeos, false), M.decal);
    for (const q of decalGeos) q.dispose();
    decalMesh.receiveShadow = true;
    decalMesh.castShadow = false;
    decalMesh.renderOrder = 2;
    g.add(decalMesh);

    B.flush(g, M, 'deck', { cast: false, recv: true });

    this._mmCircle(0, 0, PLAZA_R, 'rgba(40,90,120,0.45)', 'rgba(140,230,255,0.7)');
  }

  /* ---------------------------------------------------------------- */
  /* Gateway Plaza centrepiece                                         */
  /* ---------------------------------------------------------------- */

  _buildPlazaCentre() {
    const M = this.mat;
    const B = new GeoBatch();
    const g = new THREE.Group();
    g.name = 'monument';
    this.group.add(g);

    // Stepped dais.
    const steps = [[11.6, 0.36], [10.6, 0.36], [9.6, 0.36]];
    let y = 0.08;
    for (const [r, h] of steps) {
      // World-derived UVs, not a flat uvScale: the caps of these cylinders are
      // 20 m across and were being handed the side's tiling, which stretched
      // the plate grid into metre-wide smears on the most-looked-at floor in
      // the world.
      B.at('plaza', cylGeo(r, r + 0.25, h, 48, 2.4), 0, y + h / 2, 0);
      y += h;
    }
    B.at('trim', cylGeo(9.2, 9.2, 0.3, 48, 2.0), 0, y + 0.15, 0);
    const daisY = y + 0.3;
    // Collider top must match the visible top plate exactly or the player sinks.
    this._solid(0, daisY / 2, 0, 9.4, daisY / 2, 9.4);

    // Glowing rim.
    const rim = new THREE.TorusGeometry(9.25, 0.16, 6, 72);
    rim.rotateX(-Math.PI / 2);
    B.at('emCyan', rim, 0, daisY - 0.06, 0);

    // Eight lamp pylons ringing the monument.
    for (let i = 0; i < 8; i++) {
      const th = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const px = Math.cos(th) * 7.6, pz = Math.sin(th) * 7.6;
      B.at('trim', cylGeo(0.22, 0.3, 4.2, 10, 1.2), px, daisY + 2.1, pz);
      const head = new THREE.CylinderGeometry(0.55, 0.34, 0.7, 10);
      B.at('emCyan', head, px, daisY + 4.4, pz);
    }

    // Central holo-table.
    B.at('panelDark', cylGeo(3.4, 3.9, 1.05, 32, 1.6), 0, daisY + 0.52, 0);
    const bezel = new THREE.TorusGeometry(3.42, 0.18, 8, 48);
    bezel.rotateX(-Math.PI / 2);
    B.at('emAmber', bezel, 0, daisY + 1.06, 0);
    const dish = new THREE.CylinderGeometry(3.1, 3.1, 0.12, 32);
    B.at('emCyan', dish, 0, daisY + 1.02, 0);
    this._solid(0, daisY + 0.5, 0, 3.6, 0.55, 3.6);

    /* --- Spire: the landmark you can see from anywhere on the deck ----
     * Round 2's spire was a 19 m pole tapering from 2.3 m to 0.7 m diameter -
     * at plaza distance it subtended the same handful of pixels as the lamp
     * pylons standing next to it, so the one thing a player was supposed to
     * navigate by was indistinguishable from street furniture. It is now 34 m
     * tall on a 4 m base, built as three stacked tapered sections with a flared
     * collar at each junction and a buttress triad down to the dais, so it has
     * stepped mass and a silhouette that survives at 150 m. Its rings are the
     * only magenta-white emitters in the world: chromatic distinctness is what
     * actually makes a landmark findable in a sea of cyan practicals.
     */
    // Buttress triad, straddling the holo-table: a 10 m footing that reads the
    // monument as engineered rather than as a stick pushed into the floor, and
    // that puts three strong diagonals into the plaza silhouette.
    const LEG_R0 = 5.4, LEG_R1 = 1.7, LEG_TOP = 8.4;
    const legLen = Math.hypot(LEG_R0 - LEG_R1, LEG_TOP);
    const legLean = Math.atan2(LEG_R0 - LEG_R1, LEG_TOP);
    for (let i = 0; i < 3; i++) {
      const th = (i / 3) * Math.PI * 2 + 0.52;
      const mr = (LEG_R0 + LEG_R1) / 2;
      const bx = Math.cos(th) * mr, bz = Math.sin(th) * mr;
      B.at('panelDark', boxGeo(1.15, legLen, 1.7, 2.2), bx, daisY + LEG_TOP / 2, bz, -th, 0, legLean);
      B.at('trim', boxGeo(1.5, 0.45, 2.3, 1.5), Math.cos(th) * LEG_R0, daisY + 0.22, Math.sin(th) * LEG_R0, -th);
      B.at('emLandmark', boxGeo(0.15, legLen - 1.2, 0.15, 1), bx + Math.cos(th) * 0.62, daisY + LEG_TOP / 2, bz + Math.sin(th) * 0.62, -th, 0, legLean);
      this._solid(Math.cos(th) * LEG_R0, daisY + 0.5, Math.sin(th) * LEG_R0, 0.9, 0.5, 0.9);
    }
    // Collar drum where the legs converge, then three stacked tapered sections.
    B.at('trim', cylGeo(2.35, 2.6, 1.5, 20, 1.8), 0, daisY + LEG_TOP, 0);
    B.at('panelDark', cylGeo(2.05, 2.35, 0.8, 20, 1.6), 0, daisY + LEG_TOP + 1.1, 0);
    const SPIRE = [
      { r0: 2.00, r1: 1.34, h: 12 },
      { r0: 1.30, r1: 0.84, h: 9 },
      { r0: 0.80, r1: 0.30, h: 7 },
    ];
    let sy = LEG_TOP + 1.4;
    for (const sec of SPIRE) {
      B.at('panel', cylGeo(sec.r1, sec.r0, sec.h, 20, 2.4), 0, daisY + sy + sec.h / 2, 0);
      // Flared collar at every junction - the step that turns a pole into mass.
      B.at('trim', cylGeo(sec.r1 * 1.6, sec.r1 * 1.15, 0.85, 20, 1.8), 0, daisY + sy + sec.h, 0);
      sy += sec.h;
    }
    const spireTop = daisY + sy;
    this._solid(0, daisY + LEG_TOP / 2, 0, 1.9, LEG_TOP / 2, 1.9);
    for (let i = 0; i < 8; i++) {
      const t = i / 7;
      const y = daisY + LEG_TOP + 1.8 + t * 25;
      const rr = 2.0 - t * 1.6;
      const ring = new THREE.TorusGeometry(rr + 0.44, 0.13, 6, 30);
      ring.rotateX(-Math.PI / 2);
      B.at('emLandmark', ring, 0, y, 0);
      // A dark bezel under every ring so the glow has an unlit field to bloom
      // against and keeps a readable core instead of turning into a disc.
      B.at('panelDark', cylGeo(rr + 0.52, rr + 0.52, 0.22, 20, 1.6), 0, y - 0.26, 0);
    }
    B.at('trim', cylGeo(1.5, 2.0, 1.6, 16, 2.0), 0, spireTop + 0.8, 0);
    const cap = new THREE.OctahedronGeometry(2.5, 0);
    B.at('emLandmark', cap, 0, spireTop + 4.0, 0);

    B.flush(g, M, 'monument', { cast: true, recv: true });

    /* --- The hologram itself (animated, additive) -------------------- */
    const holo = new THREE.Group();
    holo.position.set(0, daisY + 1.2, 0);
    g.add(holo);

    // A wireframe of the station ring plus three orbiting world markers.
    const wire = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1.9, 1)),
      M.holoLine
    );
    holo.add(wire);
    this._anim.holoCore = wire;

    const gridGeo = new THREE.RingGeometry(0.6, 2.9, 48, 4);
    gridGeo.rotateX(-Math.PI / 2);
    const grid = new THREE.Mesh(gridGeo, M.holo);
    grid.position.y = 0.1;
    holo.add(grid);
    this._anim.holoRings.push({ obj: grid, speed: -0.22, bob: 0 });

    const markers = [
      { r: 2.4, y: 1.5, color: 0x7fe9ff, speed: 0.5 },
      { r: 2.9, y: 2.3, color: 0xffb347, speed: -0.34 },
      { r: 2.1, y: 3.0, color: 0x4dffa6, speed: 0.62 },
    ];
    for (const m of markers) {
      const pivot = new THREE.Group();
      holo.add(pivot);
      const mat = new THREE.MeshBasicMaterial({
        color: m.color, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: true,
      });
      const node = new THREE.Mesh(new THREE.IcosahedronGeometry(0.34, 0), mat);
      node.position.set(m.r, m.y, 0);
      pivot.add(node);
      const orbit = new THREE.Mesh(new THREE.TorusGeometry(m.r, 0.02, 4, 64), mat);
      orbit.rotation.x = -Math.PI / 2;
      orbit.position.y = m.y;
      pivot.add(orbit);
      this._anim.holoRings.push({ obj: pivot, speed: m.speed, bob: m.y });
    }

    // Vendor stalls + benches around the plaza give it human scale.
    const D = new GeoBatch();
    // Deliberately clear of the -X approach: that is the spawn sightline and
    // it must stay open all the way to the window wall.
    const stallSpots = [
      [-17, 15, 0.6], [16, 14, -0.8], [-14, -19, 2.1], [19, -11, 1.4], [3, 24, 0.2], [-21, -9, -1.2],
    ];
    /* Market units.
     *
     * These were a 4.4 x 2.4 x 3.0 solid box in `panelWarm` - a tan 0xd6ae83
     * plank-seamed texture - with a flat lid on top. Two independent reviewers
     * called them "brown timber crates", and they were right: a closed tan
     * rectangular prism with horizontal seams is a shipping crate in any
     * register, and there is no lighting fix for a silhouette problem.
     *
     * The replacement is built from the read outwards. A market stall is
     * legible at 30 m because it has a *canopy on legs with a gap under it* and
     * a counter you can see through to; the body is the least important part.
     * So: an open frame of four uprights carrying a raised soffit, an
     * illuminated serving counter at 1.05 m with a dark recessed under-run, a
     * cold-store cabinet occupying only half the footprint, goods on the
     * counter, and a menu board hung off the frame. Nothing in it is tan and
     * nothing in it is a closed box.
     */
    for (const [si, [sx, sz, ry]] of stallSpots.entries()) {
      const P = (lx, ly, lz) => this._localPoint(sx, sz, ry, lx, ly, lz);
      // Kerbed base pad: the unit is parked on the deck, not growing out of it.
      D.at('panelDark', boxGeo(4.8, 0.16, 3.4, 2), sx, 0.08, sz, ry);
      D.at('trimDark', boxGeo(5.0, 0.09, 3.6, 2), sx, 0.04, sz, ry);

      // Frame: four uprights to 2.9 m plus a header rail on each long side.
      for (const lx of [-2.2, 2.2]) {
        for (const lz of [-1.5, 1.5]) {
          const p = P(lx, 0, lz);
          D.at('trim', boxGeo(0.14, 2.85, 0.14, 1.6), p.x, 1.55, p.z, ry);
        }
      }
      for (const lz of [-1.5, 1.5]) {
        const p = P(0, 0, lz);
        D.at('trim', boxGeo(4.5, 0.16, 0.13, 2), p.x, 2.9, p.z, ry);
      }

      // Soffit: a shallow ribbed canopy, held 3.0 m up so the gap under it
      // stays open. The under-face carries the light, not the top.
      D.at('panelTeal', boxGeo(5.2, 0.22, 3.7, 2.4), sx, 3.06, sz, ry);
      D.at('trim', boxGeo(5.4, 0.09, 3.9, 2.6), sx, 3.19, sz, ry);
      D.at('grate', boxGeo(4.9, 0.06, 3.4, 2.2), sx, 2.93, sz, ry);
      // Two strip fittings recessed into the soffit.
      for (const lz of [-0.85, 0.85]) {
        const p = P(0, 0, lz);
        D.at('trimDark', boxGeo(4.3, 0.14, 0.34, 1.6), p.x, 2.9, p.z, ry);
        D.at('emWhite', boxGeo(4.1, 0.06, 0.24, 1), p.x, 2.83, p.z, ry);
      }

      // Serving counter: worktop, a dark recessed toe-space under it, and a
      // warm under-counter glow that puts light on the deck the unit stands on.
      const cf = P(0, 0, 1.35);
      D.at('panelDark', boxGeo(4.4, 0.92, 1.5, 2), cf.x, 0.62, cf.z, ry);
      D.at('trim', boxGeo(4.7, 0.11, 1.75, 2), cf.x, 1.13, cf.z, ry);
      const toe = P(0, 0, 2.06);
      D.at('emAmber', boxGeo(4.3, 0.07, 0.1, 1), toe.x, 1.02, toe.z, ry);
      D.at('trimDark', boxGeo(4.4, 0.3, 0.12, 1.4), toe.x, 0.2, toe.z, ry);

      // Cold-store cabinet: glazed, lit from inside, half the footprint only -
      // the open half is what stops the unit reading as a solid mass again.
      const cab = P(-1.25, 0, -0.9);
      D.at('panelDark', boxGeo(2.0, 1.75, 1.3, 1.8), cab.x, 0.96, cab.z, ry);
      D.at('glassWindow', boxGeo(1.75, 1.35, 1.36, 1.4), cab.x, 1.05, cab.z, ry);
      D.at('emCyan', boxGeo(1.7, 0.05, 1.2, 1), cab.x, 1.68, cab.z, ry);
      D.at('trim', boxGeo(2.1, 0.1, 1.4, 1.4), cab.x, 1.88, cab.z, ry);

      // Goods: three crates of stock on the open half of the counter, so the
      // unit reads as trading rather than shuttered.
      for (let i = 0; i < 3; i++) {
        const p = P(0.7 + i * 0.62, 0, 1.1 + (i % 2) * 0.28);
        D.at('crate', boxGeo(0.5, 0.36, 0.44, 1), p.x, 1.36 + (i === 1 ? 0.36 : 0), p.z, ry + i * 0.4);
      }
      // A tall stock rack on the back corner: 2.4 m of vertical silhouette.
      const rk = P(1.75, 0, -1.05);
      D.at('trimDark', boxGeo(1.3, 2.3, 0.55, 1.6), rk.x, 1.2, rk.z, ry);
      for (let i = 0; i < 3; i++) {
        D.at('grate', boxGeo(1.2, 0.06, 0.5, 1), rk.x, 0.7 + i * 0.62, rk.z, ry);
      }

      // Hung menu board, facing out over the counter.
      const mb = P(0, 0, 1.42);
      this._signBoard(D, SIGN_ROLE.shopFirst + (si * 2) % 12, 2.4, 0.86, mb.x, 2.42, mb.z, ry, {
        thickness: 0.1, accent: 'emAmber',
      });

      this._solidRot(sx, 1.2, sz, 2.4, 1.2, 1.7, ry);
      this._contact(sx, sz, 9);
      this._mmRect(sx, sz, 5.4, 3.9, ry, 'rgba(120,190,210,0.45)', null);
    }

    /* --- Composition: near / mid / far layers ------------------------
     * A plaza with nothing between the player and the far wall photographs as
     * a car park no matter how good the ceiling is. Three things go in: gates
     * on the two portal axes to frame the hero shots, entrance gantries on the
     * four inter-avenue bearings, and a ring of planters and kiosks that puts
     * silhouette at 15 m, 25 m and 45 m depth from any angle.
     */

    // Approach gates straddling each gateway axis, clear of the service ramps.
    for (const gz of [-76, 76]) {
      const sgn = Math.sign(gz);
      for (const gx of [-17, 17]) {
        D.at('panelDark', boxGeo(2.6, 15.4, 2.6, 2.6), gx, 7.7, gz);
        D.at('hazard', boxGeo(3.0, 1.6, 3.0, 1.6), gx, 0.8, gz);
        D.at('trim', boxGeo(2.9, 0.4, 2.9, 1.4), gx, 15.6, gz);
        D.at('emAmber', boxGeo(0.24, 11.0, 0.24, 1), gx + (gx < 0 ? 1.45 : -1.45), 7.6, gz);
        this._solid(gx, 7.7, gz, 1.4, 7.7, 1.4);
        this._contact(gx, gz, 7.5);
      }
      // Light bridge, kept high enough to frame the top of the approach rather
      // than sit across the gateway it is supposed to be pointing at.
      D.at('panelDark', boxGeo(37, 1.7, 2.8, 3), 0, 16.7, gz);
      D.at('trim', boxGeo(37.6, 0.3, 3.4, 2), 0, 17.7, gz);
      for (let i = 0; i < 9; i++) {
        D.at('emWhite', boxGeo(2.6, 0.28, 0.5, 1), -14.4 + i * 3.6, 15.7, gz);
      }
      D.at('emCyan', boxGeo(36, 0.14, 0.2, 1), 0, 15.8, gz + sgn * 1.5);
      // Destination board, legible from both approaches.
      // Role-reserved copy. These sit on the same azimuth as the gateway lintel
      // 20 m behind them, so they must never draw from the same pool.
      this._signBoard(D, gz < 0 ? SIGN_ROLE.approachA : SIGN_ROLE.approachB, 6.6, 1.6, 0, 14.2, gz, gz < 0 ? 0 : Math.PI, {
        twoSided: true, accent: 'emAmber',
      });

      /* Approach apron: the plaza wide shot was 45% empty deck between the
       * camera and the gate. Kerb rails, bollards and painted chevrons give the
       * near and middle ground something to read, and they double as a genuine
       * navigational funnel towards the gateway. */
      // The apron straddles the gate so it reads from both the plaza side and
      // the outer deck rather than only from behind.
      for (const kx of [-19.5, 19.5]) {
        for (let i = 0; i < 8; i++) {
          const kz = gz + sgn * (-16 + i * 4.6);
          D.at('hazard', boxGeo(1.0, 0.36, 4.2, 1.6), kx, 0.18, kz);
          D.at('trim', boxGeo(1.1, 0.08, 4.3, 1.2), kx, 0.38, kz);
        }
        for (let i = 0; i < 11; i++) {
          const bz = gz + sgn * (-17 + i * 3.4);
          const bx = kx - Math.sign(kx) * 2.2;
          D.at('trim', cylGeo(0.16, 0.22, 1.05, 8, 1.2), bx, 0.52, bz);
          D.at('emAmber', cylGeo(0.2, 0.2, 0.12, 8, 1.0), bx, 1.09, bz);
          this._contact(bx, bz, 1.5);
        }
      }
      for (let i = 0; i < 6; i++) {
        const dz = gz + sgn * (-14 + i * 5.5);
        const q = new THREE.PlaneGeometry(9, 5);
        q.rotateX(-Math.PI / 2);
        atlasUV(q, 0, 0, 4, 4);
        D.at('decal', q, 0, 0.135, dz, sgn > 0 ? 0 : Math.PI);
      }
      /* Near-floor detail down the whole approach corridor.
       *
       * The gateway wide shot is framed from 96 m out on this axis, so "fill
       * the near floor" means the 55-105 m band, not the plaza. Everything here
       * is under 1.2 m and offset 7-26 m off the centreline: the sightline to
       * the gateway stays completely open while the bottom of frame gains
       * expansion joints, recessed hatches, cable trays and kerb detail instead
       * of forty metres of undifferentiated plate.
       */
      const apRng = mulberry32(gz < 0 ? 0x4a71 : 0x4a72);
      for (let i = 0; i < 22; i++) {
        const ax2 = (apRng() < 0.5 ? -1 : 1) * (7 + apRng() * 19);
        const az2 = gz + sgn * (-22 + apRng() * 52);
        const k = apRng();
        if (k < 0.3) {
          // Recessed hatch with a raised lip.
          const hw = 2.0 + apRng() * 2.0;
          D.at('panelDark', boxGeo(hw + 0.5, 0.1, hw * 0.7 + 0.5, 1.6), ax2, 0.09, az2, apRng() * 3);
          D.at('grate', boxGeo(hw, 0.13, hw * 0.7, 1.4), ax2, 0.14, az2, 0);
          this._contact(ax2, az2, hw * 1.8);
        } else if (k < 0.56) {
          // Surface-run cable tray on stand-offs.
          const len = 5 + apRng() * 7;
          D.at('grate', boxGeo(0.7, 0.16, len, 1.4), ax2, 0.28, az2);
          for (let c = -1; c <= 1; c++) {
            D.at('trimDark', boxGeo(0.8, 0.28, 0.24, 1), ax2, 0.14, az2 + c * len * 0.34);
          }
          this._contact(ax2, az2, len * 1.1);
        } else if (k < 0.78) {
          // Expansion joint: a long metal strip breaking the plate rhythm.
          D.at('trim', boxGeo(9 + apRng() * 8, 0.07, 0.42, 1.4), ax2, 0.12, az2, apRng() < 0.5 ? 0 : Math.PI / 2);
        } else {
          // Kerbed planter kit at deck level - low mass, warm accent.
          D.at('trimDark', cylGeo(1.15, 1.3, 0.6, 12, 1.4), ax2, 0.3, az2);
          D.at('panelDark', cylGeo(1.0, 1.0, 0.18, 12, 1.2), ax2, 0.64, az2);
          D.at('emAmber', new THREE.TorusGeometry(1.2, 0.05, 5, 22), ax2, 0.6, az2, 0, -Math.PI / 2);
          // Three overlapping lobes rather than one sphere: a kerbside shrub
          // with a single convex outline is the same "broccoli" read as the
          // planters, just smaller.
          for (let b2 = 0; b2 < 3; b2++) {
            const ba = apRng() * Math.PI * 2;
            const br2 = b2 === 0 ? 0 : 0.28 + apRng() * 0.24;
            D.at(b2 === 1 ? 'foliagePale' : 'foliage',
              foliageLobe(0.46 + apRng() * 0.3,
                [1.15 + apRng() * 0.3, 0.6 + apRng() * 0.35, 1.15 + apRng() * 0.3],
                7, 0.78 + apRng() * 0.24,
                -Math.cos(ba) * br2, -Math.sin(ba) * br2, apRng()),
              ax2 + Math.cos(ba) * br2, 0.98 + apRng() * 0.3, az2 + Math.sin(ba) * br2,
              ba, (apRng() - 0.5) * 0.4, (apRng() - 0.5) * 0.4);
          }
          // Alpha-cut sprigs standing proud of the mass. One card cannot break
          // a silhouette; five crossed at random yaw and pitch can, and they
          // are the only thing in the kit that puts holes in the outline.
          for (let c2 = 0; c2 < 5; c2++) {
            const ca = c2 * 1.257 + apRng() * 0.5;
            D.at('foliageCard', new THREE.PlaneGeometry(0.8 + apRng() * 0.5, 0.7 + apRng() * 0.4),
              ax2 + Math.cos(ca) * 0.42, 1.06 + apRng() * 0.42, az2 + Math.sin(ca) * 0.42,
              -ca + Math.PI / 2, (apRng() - 0.5) * 0.9, (apRng() - 0.5) * 0.8);
          }
          // A visible stem: a plant with no stem always reads as a rock.
          D.at('copper', cylGeo(0.035, 0.05, 0.7, 5, 1.0), ax2, 0.95, az2, 0, 0.12, 0.08);
          this._solid(ax2, 0.3, az2, 1.2, 0.3, 1.2);
          this._contact(ax2, az2, 4.4);
        }
      }

      // Parked freight on the apron: silhouette at 15 m, 25 m and 40 m depth so
      // the wide approach is never an uninterrupted floor plane.
      const apron = [
        [-27, -6, 0.5, 1.0], [26, 4, -0.9, 1.25], [-30, 14, 1.9, 0.85],
        [24, -14, 2.4, 1.1], [-22, 22, 0.3, 0.9],
      ];
      for (const [px, dzo, py, sc] of apron) {
        const pz = gz + sgn * dzo;
        D.at('panelWarm', boxGeo(3.0 * sc, 0.3, 2.0 * sc, 1.5), px, 0.15, pz, py);
        D.at('crate', boxGeo(1.7 * sc, 1.7 * sc, 1.7 * sc, 1.7), px, 1.15 * sc, pz, py + 0.3);
        D.at('crate', boxGeo(1.4 * sc, 1.4 * sc, 1.4 * sc, 1.5), px + 0.4, 2.7 * sc, pz - 0.3, py - 0.4);
        D.at('emAmber', boxGeo(1.5 * sc, 0.08, 0.1, 1), px, 2.02 * sc, pz + 0.9 * sc, py);
        this._solidRot(px, 1.1 * sc, pz, 1.1 * sc, 1.1 * sc, 1.1 * sc, py);
        this._contact(px, pz, 7 * sc);
      }
      // Light the approach. Emissive geometry alone puts no energy into the
      // deck, which is why the outer apron photographed as a black field: these
      // are the practicals that make the bottom of a wide shot readable.
      for (const [ax, dzo] of [[-13, -6], [13, 14]]) {
        const az = gz + sgn * dzo;
        // Give the light a visible source. An unmotivated pool of light on an
        // empty deck reads as a rendering artefact, not as a lamp.
        D.at('trim', cylGeo(0.16, 0.3, 8.6, 10, 1.6), ax, 4.3, az);
        D.at('panelDark', cylGeo(0.5, 0.5, 0.35, 10, 1.2), ax, 0.18, az);
        D.at('panelDark', boxGeo(0.5, 0.4, 2.6, 1.4), ax, 8.5, az - Math.sign(ax) * 0);
        D.at('emWhite', boxGeo(0.42, 0.16, 2.2, 1), ax, 8.26, az);
        this._contact(ax, az, 3.2);
        const l = new THREE.PointLight(0xbfe0ff, 1150, 58, 2);
        l.position.set(ax, 8.0, az);
        l.castShadow = false;
        g.add(l);
      }

      // Two container stacks reading as mid-depth mass on the approach axis.
      for (const [cxs, dzo, cyaw] of [[-13, 26, 0.18], [14, 33, -0.24]]) {
        const cz2 = gz + sgn * dzo;
        D.at('crate', boxGeo(6.2, 2.9, 2.6, 2.4), cxs, 1.45, cz2, cyaw);
        D.at('crate', boxGeo(5.6, 2.7, 2.5, 2.4), cxs + 0.6, 4.25, cz2 + 0.2, cyaw - 0.1);
        D.at('hazard', boxGeo(6.4, 0.3, 2.8, 1.6), cxs, 0.15, cz2, cyaw);
        D.at('emCyan', boxGeo(5.0, 0.09, 0.12, 1), cxs, 2.82, cz2 - 1.3, cyaw);
        this._solidRot(cxs, 2.8, cz2, 3.2, 2.8, 1.4, cyaw);
        this._contact(cxs, cz2, 12);
      }
    }

    // Entrance gantries on the four bearings that are not an avenue or a portal.
    for (const deg of [30, 150, 210, 330]) {
      const th = deg * DEG;
      const cx = Math.cos(th) * 46, cz = Math.sin(th) * 46;
      const yaw = -th;
      const rx = Math.cos(th + Math.PI / 2), rz = Math.sin(th + Math.PI / 2);
      for (const s2 of [-1, 1]) {
        const px = cx + rx * s2 * 9, pz = cz + rz * s2 * 9;
        D.at('panel', boxGeo(1.8, 9.6, 1.8, 2.4), px, 4.8, pz, yaw);
        D.at('hazard', boxGeo(2.2, 1.1, 2.2, 1.4), px, 0.55, pz, yaw);
        D.at('emCyan', boxGeo(0.18, 7.2, 0.18, 1), px, 5.0, pz + 0.95, yaw);
        this._solid(px, 4.8, pz, 0.95, 4.8, 0.95);
        this._contact(px, pz, 5.5);
      }
      D.at('panelDark', boxGeo(20, 1.3, 2.2, 2.6), cx, 10.2, cz, yaw);
      D.at('emAmber', boxGeo(18, 0.12, 0.18, 1), cx, 9.5, cz + 1.2, yaw);
      D.at('emAmber', boxGeo(18, 0.12, 0.18, 1), cx, 9.5, cz - 1.2, yaw);
      this._signBoard(D, SIGN_ROLE.plaza, 6.0, 1.5, cx, 8.2, cz, yaw, { twoSided: true, accent: 'emCyan' });
    }

    // Planters: 2.2 m of mass at mid depth, and the only organic shape in the
    // frame - a station that grows nothing reads as a set, not a place.
    for (let i = 0; i < 10; i++) {
      let th = (i / 10) * Math.PI * 2 + 0.42;
      const rr = i % 2 ? 25 : 33;
      /* Keep the canopies out of the spawn's near field.
       *
       * The ring put one of these five metres off the spawn point, so a 2 m
       * organic mass filled the top corner of the hero frame at close range -
       * the "gold/brown smeared blob, no normal detail, no readable silhouette"
       * two reviewers picked out. Displaced foliage is authored to read at 15 m
       * and up; at five it is a lump whatever the material does. Rotating the
       * offender a fifth of a sector along the ring costs nothing and moves it
       * out of the corner.
       */
      for (let guard = 0; guard < 4; guard++) {
        const gx = Math.cos(th) * rr, gz = Math.sin(th) * rr;
        if (Math.hypot(gx - SPAWN_X, gz - SPAWN_Z) > 14) break;
        th += 0.42;
      }
      const px = Math.cos(th) * rr, pz = Math.sin(th) * rr;
      D.at('trim', cylGeo(2.3, 2.5, 1.1, 12, 1.6), px, 0.6, pz);
      D.at('panelDark', cylGeo(2.05, 2.05, 0.3, 12, 1.4), px, 1.2, pz);
      D.at('emCyan', new THREE.TorusGeometry(2.34, 0.07, 6, 26), px, 1.12, pz, 0, -Math.PI / 2);
      /* Foliage.
       *
       * Round 2 grew these out of detail-1 octahedra in a metal panel material:
       * hard creases at every edge, one flat value per facet, no albedo grain -
       * they photographed as grey boulders scattered through a space station,
       * which is exactly the wrong fiction. Smooth-shaded icosphere lobes on a
       * real trunk, in a dedicated non-metallic leaf material with a normal map,
       * read as a planted tree at any distance.
       */
      /* Hydroponic column, not a tree.
       *
       * Round 3 grew a single roughly-spherical mass of eleven-to-fourteen
       * smooth lobes on a short trunk. Every note it got back said the same
       * word - broccoli - and the note was about *form*, not about material:
       * one convex blob of green on a stick is a broccoli floret at any
       * resolution, in any shader, and it belongs to a parkland fiction that a
       * pressurised orbital ring does not have.
       *
       * What replaces it is an engineered growing unit: a slim central riser
       * carrying three horizontal culture trays at 2.4 / 3.5 / 4.5 m, each tray
       * a perforated metal disc with planting *spilling over its rim*, in a
       * cage of four uprights with a magenta grow-bar under every tray. The
       * silhouette is now a narrow vertical stack of flat discs - concave
       * between the tiers, hard-edged metal at every tier line - which is the
       * exact opposite read to a single convex ball, and it gives the plaza a
       * 5 m vertical accent it did not have.
       */
      const fr = mulberry32(0x1eaf + i * 977);
      // Riser and the cage that supports the trays.
      D.at('trim', cylGeo(0.20, 0.26, 5.0, 8, 2.2), px, 2.9, pz);
      for (let k = 0; k < 4; k++) {
        const ca = k * (Math.PI / 2) + 0.5 + i * 0.31;
        D.at('trimDark', cylGeo(0.055, 0.055, 4.4, 5, 1.8),
          px + Math.cos(ca) * 1.32, 2.6, pz + Math.sin(ca) * 1.32);
      }
      // Feed lines climbing the riser - the plumbing is the fiction.
      for (const off of [-0.28, 0.28]) {
        D.at('copper', cylGeo(0.045, 0.045, 4.2, 5, 1.8), px + off, 2.55, pz + off * 0.6);
      }

      const TIERS = [
        [2.42, 1.42, 0.95],   // [y, tray radius, foliage scale]
        [3.52, 1.18, 0.82],
        [4.48, 0.88, 0.66],
      ];
      for (let ti = 0; ti < TIERS.length; ti++) {
        const [ty, tr, ts] = TIERS[ti];
        // Tray: a perforated deck with a raised rim and a lit soffit under it.
        D.at('grate', cylGeo(tr, tr, 0.11, 16, tr * 1.6), px, ty, pz);
        D.at('trim', new THREE.TorusGeometry(tr, 0.075, 5, 26), px, ty + 0.06, pz, 0, -Math.PI / 2);
        D.at('trimDark', cylGeo(tr * 0.88, tr * 0.7, 0.2, 14, tr * 1.3), px, ty - 0.14, pz);
        // Grow bar on the underside of each tray: motivates the magenta and
        // throws a colour that nothing else in the plaza owns.
        D.at('emMagenta', new THREE.TorusGeometry(tr * 0.74, 0.045, 4, 20), px, ty - 0.23, pz, 0, -Math.PI / 2);

        /* Planting. Low, wide, *radially arranged* lobes that break the tray
         * rim rather than pile into a dome: each one is scaled about 2.6:1 in
         * plan against height, tilted outward and downward, so the tier reads
         * as spilling foliage over a hard edge. Two shades alternate along the
         * ring, and the tray's own occlusion is baked into the vertex colours
         * by foliageLobe (inward vector = towards the riser).
         */
        const n = 7 + Math.floor(fr() * 3);
        for (let k = 0; k < n; k++) {
          const a2 = (k / n) * Math.PI * 2 + fr() * 0.5 + ti * 0.7;
          const rr2 = tr * (0.5 + fr() * 0.5);
          const lx = Math.cos(a2) * rr2, lz = Math.sin(a2) * rr2;
          const shade = 0.72 + fr() * 0.3 + ti * 0.06;
          const lobe = foliageLobe(
            ts * (0.40 + fr() * 0.26),
            [1.5 + fr() * 0.7, 0.44 + fr() * 0.24, 1.3 + fr() * 0.6],
            7, shade, -lx, -lz, fr()
          );
          D.at(k % 3 === 1 ? 'foliagePale' : 'foliage', lobe,
            px + lx, ty + 0.16 + fr() * 0.22, pz + lz,
            a2, (fr() - 0.5) * 0.55, (fr() - 0.5) * 0.55);
        }
        // Alpha-cut fronds standing proud of the rim: the only thing that
        // actually punches holes in a silhouette.
        for (let k = 0; k < 8; k++) {
          const a2 = k * 0.7854 + fr() * 0.6 + ti;
          const cw2 = ts * (0.9 + fr() * 0.5);
          D.at('foliageCard', new THREE.PlaneGeometry(cw2, cw2 * (0.7 + fr() * 0.4)),
            px + Math.cos(a2) * tr * 0.92, ty + 0.34 + fr() * 0.3, pz + Math.sin(a2) * tr * 0.92,
            -a2 + Math.PI / 2, (fr() - 0.5) * 0.7, (fr() - 0.5) * 0.6);
        }
      }
      // Crown: a capped service head, so the column terminates instead of
      // fading out into loose lobes.
      D.at('panelDark', cylGeo(0.34, 0.24, 0.42, 10, 1.2), px, 5.24, pz);
      D.at('emCyan', new THREE.TorusGeometry(0.3, 0.035, 4, 16), px, 5.32, pz, 0, -Math.PI / 2);
      // Nutrient console on the kerb: reads the unit as machinery.
      D.at('panelDark', boxGeo(0.6, 0.9, 0.42, 1.2), px + 1.9, 1.05, pz, 0.4);
      D.at('emCyan', boxGeo(0.42, 0.3, 0.06, 1), px + 1.9, 1.32, pz - 0.22, 0.4);
      this._solid(px, 0.6, pz, 2.3, 0.6, 2.3);
      this._contact(px, pz, 8);
      this._mmCircle(px, pz, 2.4, 'rgba(80,170,150,0.4)', null);
    }

    // Wayfinding kiosks: a 3 m vertical at close range in every hero angle.
    for (const [kx, kz, kyaw] of [[-26, 30, 0.9], [28, 27, -1.1], [-30, -24, 2.4], [25, -30, -2.2]]) {
      D.at('panelDark', boxGeo(2.6, 0.5, 1.4, 1.6), kx, 0.25, kz, kyaw);
      D.at('panel', boxGeo(2.2, 3.0, 0.6, 2), kx, 1.8, kz, kyaw);
      D.at('trim', boxGeo(2.5, 0.24, 0.9, 1.4), kx, 3.4, kz, kyaw);
      const kn = this._localPoint(kx, kz, kyaw, 0, 2.1, -0.42);
      this._signBoard(D, SIGN_ROLE.sectorMap, 1.9, 1.15, kn.x, kn.y, kn.z, kyaw + Math.PI, { thickness: 0.1, accent: 'emCyan' });
      const kb = this._localPoint(kx, kz, kyaw, 0, 2.1, 0.42);
      this._signBoard(D, SIGN_ROLE.control, 1.9, 1.15, kb.x, kb.y, kb.z, kyaw, { thickness: 0.1, accent: 'emAmber' });
      this._solidRot(kx, 1.5, kz, 1.4, 1.5, 0.8, kyaw);
      this._contact(kx, kz, 5);
    }

    // Queue stanchions and dropped freight - the residue of a used space.
    for (const [qx, qz, qyaw] of [[-9, 41, 0], [9, 41, 0], [-9, -41, 0], [9, -41, 0]]) {
      for (let i = 0; i < 5; i++) {
        const sx2 = qx + Math.cos(qyaw) * (i - 2) * 1.9;
        const sz2 = qz + Math.sin(qyaw) * (i - 2) * 1.9;
        D.at('trim', cylGeo(0.06, 0.14, 1.0, 8, 1.2), sx2, 0.5, sz2);
        D.at('panelDark', cylGeo(0.28, 0.32, 0.09, 10, 1.2), sx2, 0.05, sz2);
        if (i < 4) D.at('emAmber', boxGeo(1.86, 0.05, 0.05, 1), sx2 + 0.95, 0.92, sz2, qyaw);
      }
    }
    for (const [fx, fz, fy] of [[-20, 34, 0.4], [22, 36, -1.2], [-24, -34, 2.0], [18, -37, 0.7], [34, 8, 1.5], [-35, -6, -0.6]]) {
      D.at('panelWarm', boxGeo(2.6, 0.26, 1.7, 1.4), fx, 0.13, fz, fy);
      D.at('crate', boxGeo(1.5, 1.5, 1.5, 1.6), fx - 0.2, 1.0, fz, fy + 0.2);
      D.at('crate', boxGeo(1.2, 1.2, 1.2, 1.4), fx + 0.5, 2.35, fz + 0.2, fy - 0.5);
      this._solidRot(fx, 0.9, fz, 1.0, 0.9, 1.0, fy);
      this._contact(fx, fz, 6.5);
    }
    /* Benches.
     *
     * These were the "untextured pure-black placeholder cube and floating plank"
     * in the round-2 street-level frame. Nothing was missing a material: the
     * seat was M.trim at metalness 0.75 / roughness 0.3 and the legs were
     * M.panelDark at 0.52, which in a room whose only environment map is a
     * starfield return almost no light at all - a mirror with nothing to
     * reflect renders black. They now use the rebalanced trim/panelWarm pair,
     * carry a slatted seat that breaks the plank silhouette, and every one of
     * them gets a contact patch so it is seated on the deck instead of floating
     * on the tile grid.
     */
    for (let i = 0; i < 14; i++) {
      const th = (i / 14) * Math.PI * 2 + 0.3;
      const rr = 27 + (i % 3) * 3;
      const bx = Math.cos(th) * rr, bz = Math.sin(th) * rr;
      /* A yaw of -th maps the bench's local +X onto U and its local +Z onto V.
       * Round 2 had these two swapped: the four seat slats were offset along
       * their own length (so they merged into one bar) and the legs were pushed
       * 1.2 m out along the *depth* axis, which left them standing free of the
       * seat entirely. That is the "solid black placeholder cube next to a
       * floating plank" in the street-level frame - not a missing material, a
       * broken basis. */
      const ux = Math.cos(th), uz = Math.sin(th);       // along the seat
      const vx = -Math.sin(th), vz = Math.cos(th);      // across the seat
      for (let s2 = 0; s2 < 4; s2++) {
        const o = (s2 - 1.5) * 0.235;
        D.at('panelWarm', boxGeo(3.2, 0.13, 0.19, 1.2), bx + vx * o, 0.66, bz + vz * o, -th);
      }
      D.at('trim', boxGeo(3.3, 0.09, 0.94, 1.2), bx, 0.56, bz, -th);
      // Splayed tube legs rather than solid blocks, plus an under-seat glow so
      // the shaded volume beneath the bench is never a black void.
      for (const s2 of [-1, 1]) {
        const lx = bx + ux * s2 * 1.24, lz = bz + uz * s2 * 1.24;
        for (const d2 of [-1, 1]) {
          D.at('trim', cylGeo(0.05, 0.07, 0.62, 6, 1.0),
            lx + vx * d2 * 0.17, 0.3, lz + vz * d2 * 0.17, -th, -d2 * 0.26, 0);
        }
        D.at('trim', boxGeo(0.12, 0.07, 0.86, 1), lx, 0.05, lz, -th);
      }
      D.at('emCyan', boxGeo(2.9, 0.05, 0.07, 1), bx, 0.5, bz, -th);
      /* One box for the whole bench, deck to seat top.
       *
       * A bench is four 13 cm slats on four splayed tube legs, and not one of
       * those pieces is a solid volume - which is why a sweep looking for
       * prop-shaped geometry never found it, and why you could walk straight
       * through every bench on the plaza. The obstacle is the assembly, so the
       * collider is authored here with it rather than inferred from it. */
      this._solidRot(bx, 0.36, bz, 1.65, 0.36, 0.47, -th);
      this._contact(bx, bz, 5.4);
    }

    /* --- Near-camera deck dressing ------------------------------------
     * Every round-2 frame gave 45-60% of its area to bare deck between the
     * camera and the first prop. A standing eye sits at 1.7 m, so anything that
     * is going to break up the near floor has to live inside r<40 and stand
     * 0.3-1.6 m tall: recessed grating inserts, cable runs pinned to the deck,
     * expansion joints and stray kit. Target is roughly one silhouette-breaking
     * element every 6 m of plaza.
     */
    const nearRng = mulberry32(0x91d0);
    for (let i = 0; i < 26; i++) {
      const th = nearRng() * Math.PI * 2;
      const rr = 13 + nearRng() * 25;
      const nx = Math.cos(th) * rr, nz = Math.sin(th) * rr;
      // Skip the two gateway sightlines: they stay open by design.
      if (Math.abs(nx) < 8 && Math.abs(nz) > 12) continue;
      const kind = nearRng();
      if (kind < 0.34) {
        // Recessed service grating with a raised kerb - a real floor feature.
        const gw = 2.2 + nearRng() * 2.4;
        D.at('panelDark', boxGeo(gw + 0.4, 0.12, gw * 0.62 + 0.4, 1.5), nx, 0.1, nz, th);
        D.at('grate', boxGeo(gw, 0.14, gw * 0.62, 1.4), nx, 0.15, nz, th);
        D.at('trim', boxGeo(gw + 0.5, 0.09, 0.14, 1), nx, 0.16, nz + gw * 0.36, th);
        this._contact(nx, nz, gw * 1.7);
      } else if (kind < 0.62) {
        // Cable run pinned across the deck with hoop clamps.
        const len = 4 + nearRng() * 6;
        D.at('rubber', cylGeo(0.09, 0.09, len, 6, 1.0), nx, 0.15, nz, th, 0, Math.PI / 2);
        D.at('rubber', cylGeo(0.07, 0.07, len, 6, 1.0), nx + Math.sin(th) * 0.22, 0.14, nz + Math.cos(th) * 0.22, th, 0, Math.PI / 2);
        for (let c = -1; c <= 1; c++) {
          D.at('trim', boxGeo(0.16, 0.3, 0.62, 1), nx + Math.cos(th) * c * len * 0.36, 0.13, nz - Math.sin(th) * c * len * 0.36, th);
        }
        this._contact(nx, nz, len * 1.2);
      } else if (kind < 0.82) {
        // A dropped equipment case with a lit status panel.
        D.at('crate', boxGeo(1.3, 0.72, 0.9, 1.4), nx, 0.36, nz, th);
        D.at('trimDark', boxGeo(1.36, 0.1, 0.96, 1), nx, 0.75, nz, th);
        D.at('emAmber', boxGeo(0.34, 0.06, 0.1, 1), nx + Math.sin(th) * 0.46, 0.56, nz + Math.cos(th) * 0.46, th);
        this._contact(nx, nz, 3.6);
      } else {
        // Low bollard pair with a strung hazard chain.
        for (const s2 of [-1, 1]) {
          const ox = nx + Math.cos(th) * s2 * 1.35, oz = nz - Math.sin(th) * s2 * 1.35;
          D.at('hazard', cylGeo(0.14, 0.19, 0.95, 8, 1.0), ox, 0.47, oz);
          D.at('emAmber', cylGeo(0.17, 0.17, 0.1, 8, 1.0), ox, 1.0, oz);
          this._contact(ox, oz, 1.4);
        }
        D.at('rubber', cylGeo(0.045, 0.045, 2.7, 4, 1.0), nx, 0.62, nz, th, 0, Math.PI / 2);
      }
    }

    D.flush(g, M, 'plaza-props', { cast: true, recv: true });

    this._mmCircle(0, 0, 11.6, 'rgba(90,200,240,0.35)', 'rgba(180,240,255,0.8)');
  }

  /* ---------------------------------------------------------------- */
  /* Portal daises                                                     */
  /* ---------------------------------------------------------------- */

  _buildPortalDaises() {
    const M = this.mat;
    const g = new THREE.Group();
    g.name = 'gateways';
    this.group.add(g);

    const specs = [
      { z: -PORTAL_R, target: 'medieval', label: 'Ashfall Reach', accent: 0xffb347, em: 'emAmber', yaw: Math.PI },
      { z: PORTAL_R, target: 'sports', label: 'Meridian Athletic Complex', accent: 0x2ffb9a, em: 'emGreen', yaw: 0 },
    ];

    for (const s of specs) {
      const B = new GeoBatch();
      const sign = Math.sign(s.z);
      const cz = s.z;

      /* The portal is the thing the whole composition terminates on, and it was
       * losing the frame: its luminance sat inside a stop of the cyan strips and
       * amber practicals around it, so the eye had no reason to travel down the
       * axis to it. This material is the separation - a dedicated emissive at
       * roughly double the brightest competing emitter, in the destination's own
       * hue, and deliberately *not* distance-graded, because a beacon that fades
       * with range is not a beacon.
       */
      const key = `emGate_${s.target}`;
      M[key] = new THREE.MeshStandardMaterial({
        color: 0x05070a,
        emissive: new THREE.Color(s.accent),
        emissiveIntensity: 3.4,
        metalness: 0.1,
        roughness: 0.35,
        toneMapped: true,
      });

      // Octagonal dais. Texel density is derived from the world size rather
      // than from a flat uvScale: the old (20, 3) stretched the top cap into
      // 1 x 7 m rectangles, which is why the largest object in the portal shot
      // read as an untextured placeholder next to finely detailed pillars.
      B.at('plaza', cylGeo(11, 11.4, 2.4, 8, 2.6), 0, 1.2, cz, Math.PI / 8);
      B.at('trim', cylGeo(11.15, 11.15, 0.35, 8, 2.0), 0, 2.45, cz, Math.PI / 8);
      this._solid(0, 1.2, cz, 10.6, 1.2, 10.6);

      // Chamfered, hazard-marked nosing around the dais lip: it breaks the flat
      // mass that eats the bottom of the hero frame and gives the silhouette an
      // edge to catch light on.
      for (let i = 0; i < 8; i++) {
        const th = (i / 8) * Math.PI * 2 + Math.PI / 8;
        const ex = Math.cos(th) * 10.6, ez = cz + Math.sin(th) * 10.6;
        B.at('hazard', boxGeo(8.6, 0.34, 0.5, 1.4), ex, 2.28, ez, -th + Math.PI / 2);
        B.at(s.em, boxGeo(7.6, 0.09, 0.14, 1), ex, 2.5, ez, -th + Math.PI / 2);

        /* The dais lip is the single largest tonal mass in the gateway hero
         * frame - a bare grey parapet across the bottom third with no detail,
         * no wear and no light interaction. AAA foregrounds are never a blank
         * value block, so every facet that is not the approach or the ramp gets
         * a chamfered handrail with stanchions: readable silhouette at 3 m, and
         * a top edge that actually catches the gateway key. */
        const isApproach = Math.abs(Math.sin(th) - -sign) < 0.5;   // stairs side
        const isRamp = Math.abs(Math.sin(th) - sign) < 0.5;        // service ramp
        if (isApproach || isRamp) continue;
        // A rolled tube reads as a handrail; a box reads as a kerb. Local +Y is
        // the cylinder's long axis, so rz brings it horizontal and ry then
        // aligns it with this facet (Euler order is YXZ: R = Ry * Rx * Rz).
        // Handrails are the one family authored under roughness 0.3, so they
        // alone throw a tight specular and the frame stops reading as a single
        // injection-moulded material.
        const rail = cylGeo(0.075, 0.075, 8.6, 8, 1.0);
        B.at('chrome', rail, ex, 3.55, ez, -th + Math.PI / 2, 0, Math.PI / 2);
        B.at('trim', boxGeo(8.6, 0.07, 0.07, 1), ex, 3.0, ez, -th + Math.PI / 2);
        for (let k = -1; k <= 1; k++) {
          const sx2 = ex + Math.cos(-th + Math.PI / 2) * k * 3.1;
          const sz2 = ez - Math.sin(-th + Math.PI / 2) * k * 3.1;
          B.at('trimDark', boxGeo(0.09, 1.25, 0.09, 1), sx2, 2.95, sz2, -th + Math.PI / 2);
        }
      }

      /* Silhouette props on the dais shoulders: the foreground mass now carries
       * readable shapes instead of one flat grey plane. Kept off the portal
       * axis so nothing occludes the event horizon. */
      for (const px of [-8.2, 8.2]) {
        const pz = cz + sign * 5.6;
        B.at('crate', boxGeo(1.5, 1.5, 1.4, 1.5), px, 3.15, pz, px < 0 ? 0.3 : -0.42);
        B.at('crate', boxGeo(1.2, 1.1, 1.1, 1.3), px + (px < 0 ? 0.5 : -0.5), 4.45, pz - 0.3, px < 0 ? -0.2 : 0.5);
        B.at('hazard', boxGeo(1.9, 0.22, 1.8, 1.4), px, 2.5, pz, 0);
        // A field terminal with a lit face - human-scale detail against the mass.
        const tx = px * 0.72, tz = cz - sign * 6.4;
        B.at('trimDark', boxGeo(0.9, 1.35, 0.7, 1.4), tx, 3.07, tz, 0);
        B.at(s.em, boxGeo(0.66, 0.44, 0.06, 1), tx, 3.5, tz - sign * 0.38, 0);
        B.at('trim', cylGeo(0.06, 0.06, 1.4, 6, 1.0), tx, 3.1, tz + sign * 0.4);
        // Coiled cable run spilling off the dais edge.
        const coil = new THREE.TorusGeometry(0.55, 0.11, 6, 20);
        coil.rotateX(-Math.PI / 2);
        B.at('rubber', coil, px * 0.5, 2.46, cz + sign * 8.4, 0);
      }

      /* Wide approach steps on the plaza-facing side, each with a trim nosing
       * and an emissive edge so the flight reads as stairs at 30 m rather than
       * as one black wedge.
       *
       * `i` counts *outward* from the dais, so the step nearest the gateway is
       * the tallest. It used to count the other way, which built the flight
       * upside down: the first thing a player walking in from the plaza met was
       * the 2.4 m top step presented as a sheer face, with the shorter steps
       * hidden behind it descending the wrong way. Measured on the deck, the
       * approach profile ran 0 -> 2.40 -> 1.92 -> 1.44 -> 0.96 -> 0.48 before
       * reaching the dais; it now rises 0.48 -> 2.40 in five even treads. */
      /* Six treads of 0.40 m, not five of 0.48 m. `CONFIG.player.stepHeight` is
       * 0.45, so every tread in the original flight was three centimetres too
       * tall to walk up - the flight was unclimbable on its own terms quite
       * apart from being built upside down. Same 2.4 m total rise. */
      const TREADS = 6;
      for (let i = 0; i < TREADS; i++) {
        const w = 14 - i * 0.75;
        const z = cz - sign * (11 + i * 1.3);
        const rise = 0.40 * (TREADS - i);
        B.at('plaza', boxGeo(w, rise, 1.4, 2), 0, rise / 2, z);
        B.at('trim', boxGeo(w, 0.08, 1.5, 1), 0, rise + 0.02, z);
        B.at(s.em, boxGeo(w - 1.2, 0.06, 0.1, 1), 0, rise - 0.06, z - sign * 0.72);
        this._solid(0, rise / 2, z, w / 2, rise / 2, 0.75);
      }
      // Service ramp on the far side, so the dais is reachable without stairs.
      const rampYaw = sign > 0 ? Math.PI : 0;
      const rampPitch = Math.atan2(2.4, 8);
      this._ramp(0, 0.96, cz + sign * 12, 5, 8, 2.4, rampYaw);
      B.at('grate', boxGeo(5, 0.2, 8.4, 2), 0, 1.2, cz + sign * 12, rampYaw, -rampPitch);

      // Guide lights marching up to the threshold.
      for (let i = 0; i < 7; i++) {
        const t = i / 6;
        const z = cz - sign * (14 - t * 4);
        B.at(s.em, boxGeo(0.5, 0.14, 0.5, 1), -6, 2.5, z);
        B.at(s.em, boxGeo(0.5, 0.14, 0.5, 1), 6, 2.5, z);
      }

      // Ceremonial arch: two buttresses and a lintel framing the event horizon,
      // standing on the dais.
      const archBase = GATEWAY_DECK_Y;
      for (const sx of [-4.6, 4.6]) {
        B.at('panelDark', boxGeo(1.5, 8.6, 2.4, 3), sx, archBase + 4.3, cz);
        B.at(s.em, boxGeo(0.3, 7.6, 0.3, 1), sx + (sx < 0 ? 0.9 : -0.9), archBase + 4.2, cz + 1.25);
        B.at('trim', boxGeo(2.2, 0.6, 3.0, 2), sx, archBase + 8.9, cz);
      }
      B.at('panelDark', boxGeo(11.2, 1.6, 2.4, 3), 0, archBase + 9.6, cz);
      B.at(s.em, boxGeo(9.4, 0.28, 0.3, 1), 0, archBase + 8.9, cz + 1.3);
      B.at(s.em, boxGeo(9.4, 0.28, 0.3, 1), 0, archBase + 8.9, cz - 1.3);

      /* --- Aperture surround -----------------------------------------
       * The event horizon itself is a very bright emitter owned by the portal
       * system, and under any bright pass it clips to a featureless white disc.
       * Structure therefore has to come from *around* it: a dark machined iris
       * that survives the bloom as a silhouette, then two concentric rings that
       * fall off outwards, so the aperture reads hot-core / cool-rim instead of
       * as one flat blob. Radii start at 3.1 m to clear the portal's own arch.
       */
      const nx = Math.sin(s.yaw), nz = Math.cos(s.yaw);
      /* Concentric with the event horizon, taken from the portal system rather
       * than guessed.
       *
       * This was hard-coded to 2.45 - the gateway's *floor* - while the disc's
       * centre is a further `PORTAL_DISC_OFFSET_Y` (2.68 m) above the spec. The
       * iris, its teeth, both rings and the backing plate therefore sat almost
       * three metres below the aperture they exist to frame, clustered around
       * the plinth: from the approach the surround read as the gateway and the
       * disc appeared to be missing its lower half. */
      const apY = GATEWAY_DECK_Y + PORTAL_DISC_OFFSET_Y;
      const back = (d) => [0 - nx * d, apY, cz - nz * d];
      const iris = new THREE.TorusGeometry(3.6, 0.5, 10, 44);
      B.at('panelDark', iris, 0, apY, cz, s.yaw);
      // Machined teeth around the iris: a hard, readable silhouette element.
      for (let i = 0; i < 12; i++) {
        const th = (i / 12) * Math.PI * 2;
        const rx = Math.cos(th) * 3.6, ry = Math.sin(th) * 3.6;
        B.at('trim', boxGeo(0.5, 1.0, 0.34, 1), rx * Math.cos(s.yaw), apY + ry, cz - rx * Math.sin(s.yaw), s.yaw, 0, th);
      }
      const d1 = back(0.3);
      const r1 = new THREE.TorusGeometry(4.35, 0.22, 8, 48);
      B.at(key, r1, d1[0], d1[1], d1[2], s.yaw);
      const d2 = back(0.55);
      const r2 = new THREE.TorusGeometry(5.05, 0.11, 8, 52);
      B.at('emDim', r2, d2[0], d2[1], d2[2], s.yaw);
      // Dark backing plate so the glow always has an unlit field behind it.
      const backer = new THREE.RingGeometry(3.05, 5.6, 44, 1);
      uvScale(backer, 3, 3);
      const d3 = back(0.75);
      B.at('panelDark', backer, d3[0], d3[1], d3[2], s.yaw);

      // Destination placard above the arch. It hangs in open space over the
      // plaza axis and is approached from both directions, so it gets a proper
      // two-sided board - two correctly-wound quads around an opaque backer -
      // rather than one DoubleSide quad that renders mirrored from behind.
      this._signBoard(
        B, s.target === 'medieval' ? SIGN_ROLE.gatewayMedieval : SIGN_ROLE.gatewaySports, 9, 2.2,
        0, GATEWAY_DECK_Y + 11.1, cz - sign * 1.35, s.yaw + Math.PI,
        { twoSided: true, accent: s.em }
      );

      /* Backdrop pylons so the portal reads against something solid.
       *
       * Pulled in to `PYLON_OFF`. They stood at a radius of 10.5, and a 2.6 m
       * box at that radius puts its outer corner at 12.3 - past the 11 m dais
       * rim, so a corner of every pylon overhung the edge with nothing under
       * it. From the deck that reads as a tower hanging in the air, which is
       * exactly what it is. */
      for (const sx of [-PYLON_OFF.a, PYLON_OFF.a]) {
        B.at('panel', boxGeo(2.6, 14, 2.6, 3), sx, GATEWAY_DECK_Y + 7, cz + sign * PYLON_OFF.b);
        B.at(s.em, boxGeo(0.34, 12, 0.34, 1), sx + (sx < 0 ? 1.5 : -1.5), GATEWAY_DECK_Y + 7, cz + sign * (PYLON_OFF.b - 1.3));
        this._solid(sx, 7, cz + sign * PYLON_OFF.b, 1.3, 7, 1.3);
      }

      /* --- The light has to have a path ---------------------------------
       *
       * A bright disc at the end of a sightline with nothing between it and the
       * camera reads as a decal. Two things fix that and neither is the portal
       * itself: a pool of the destination's colour spilled across the deck in
       * front of the steps, and a broad cone of haze running from the aperture
       * plane back down the approach. Together they make the gateway the
       * brightest *and* the most saturated event in the frame, and they give
       * the eye a lit corridor to travel along to reach it.
       */
      const poolCol = new THREE.Color(s.accent);
      const pool = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), M.pool);
      pool.position.set(0, 0.13, cz - sign * 15);
      pool.rotation.x = -Math.PI / 2;
      pool.scale.set(26, 34, 1);
      pool.renderOrder = 3;
      pool.castShadow = pool.receiveShadow = false;
      const poolMat = M.pool.clone();
      poolMat.color = poolCol;
      pool.material = poolMat;
      M[`gatePool_${s.target}`] = poolMat;
      g.add(pool);

      const cone = new THREE.Mesh(
        new THREE.CylinderGeometry(3.4, 9.0, 30, 22, 6, true),
        M.shaftBig
      );
      cone.position.set(0, 3.4, cz - sign * 15.5);
      // Lay the cone down the approach axis: narrow end at the aperture, wide
      // end spilling across the plaza-side deck.
      cone.rotation.set(sign > 0 ? Math.PI / 2 : -Math.PI / 2, 0, 0);
      cone.renderOrder = 8;
      cone.castShadow = cone.receiveShadow = false;
      g.add(cone);

      B.flush(g, M, `gateway-${s.target}`, { cast: true, recv: true });

      // Local light spill from the gateway, plus a low bounce that separates
      // the dais from the deck it sits on.
      //
      // 760 cd with decay 2 at y=6.5 lands >100 lux on the dais deck 2.5 m
      // away, which is roughly thirty times the bloom threshold: that is what
      // produced the three featureless white discs around the gateway and the
      // blowout that erased the front planter's top face. Raising the source to
      // 9 m gets the near field off the deck, and 210 cd at 4.5 m of throw is a
      // practical rather than a flash unit.
      const lamp = new THREE.PointLight(s.accent, 210, 32, 2);
      lamp.position.set(0, 9.0, cz + sign * 0.5);
      lamp.castShadow = false;
      g.add(lamp);
      const spill = new THREE.PointLight(s.accent, 60, 20, 2);
      spill.position.set(0, 1.6, cz - sign * 9);
      spill.castShadow = false;
      g.add(spill);

      // Ground the dais and the arch feet.
      this._contact(0, cz, 30);
      for (const sx of [-4.6, 4.6]) this._contact(sx, cz, 5.5);

      this.portalSpecs.push({
        position: new THREE.Vector3(0, GATEWAY_DECK_Y, cz),
        rotationY: s.yaw,
        target: s.target,
        label: s.label,
        accent: s.accent,
      });
      this._mmCircle(0, cz, 11, 'rgba(255,180,70,0.22)', `#${new THREE.Color(s.accent).getHexString()}`);
    }

    this._buildAxisGateway(g, {
      side: -1, target: 'citadel', label: 'Sunspire Citadel', accent: 0xffc46b,
      signRole: SIGN_ROLE.gatewayCitadel,
    });
    this._buildAxisGateway(g, {
      side: 1, target: 'race', label: 'Vellum Ridge', accent: 0xff5a3c,
      signRole: SIGN_ROLE.gatewayRace,
    });
    /* The fifth arch. The other four occupy the two axes at +-PORTAL_R, so this
     * one is offset along Z to keep an 11 m dais clear of the citadel's. */
    this._buildAxisGateway(g, {
      side: -1, target: 'maze', label: 'The Verdant Coil', accent: 0x8fd67a,
      signRole: SIGN_ROLE.gatewayMaze, offsetZ: 128,
    });
  }

  /**
   * Third gateway: the citadel, on the -X axis.
   *
   * Deliberately *not* run through the loop above. That builder is written
   * around `s.z` and `Math.sign(s.z)` - fifty-odd references decide dais
   * orientation, cone direction, sign placement and contact patches from the
   * Z coordinate alone - so a gateway on the X axis cannot be expressed as
   * another entry in its spec list without rewriting it, and rewriting a
   * working world to add a door to a new one is a bad trade.
   *
   * It needs far less anyway: `PortalSystem` builds the arch, disc, halo,
   * signage, light and collider from the spec, so all a world owes a gateway is
   * somewhere to stand and a reason for the eye to go there.
   *
   * @param {THREE.Group} g the gateways group
   */
  /**
   * The two gateways that stand on the plaza's east-west axis.
   *
   * Written for the citadel and then generalised rather than copied when the
   * race circuit needed one: ninety lines of arch, dais and lighting duplicated
   * for a second destination is ninety lines that drift apart the first time
   * either is touched. `side` mirrors it across the plaza; everything else is
   * the destination's own identity.
   *
   * @param {THREE.Group} g
   * @param {{side:number, target:string, label:string, accent:number}} spec
   */
  _buildAxisGateway(g, spec) {
    const M = this.mat;
    const B = new GeoBatch();
    const cx = PORTAL_R * spec.side;
    const cz = spec.offsetZ ?? 0;

    /* Dais: stepped discs, matching the language of the other two - and, now,
     * their *height*.
     *
     * This dais topped out at 0.86 m while the Z-axis pair stand at
     * GATEWAY_DECK_Y, and the portal spec, the approach and the backdrop pylons
     * are all measured from that. The mismatch is what left the pylons hanging
     * one and a half metres over their own dais. One height for all four
     * gateways, taken from the constant, so a gateway cannot half-agree with
     * itself again. */
    const D = GATEWAY_DECK_Y;
    B.at('panelDark', cylGeo(11, 11, D * 0.62, 28, 2.2), cx, D * 0.31, cz);
    B.at('panelWarm', cylGeo(8.6, 8.6, D, 28, 1.8), cx, D * 0.5, cz);
    B.at('trim', cylGeo(8.9, 8.9, 0.12, 28, 1.2), cx, D + 0.06, cz);
    this._solid(cx, D * 0.5, cz, 11, D * 0.5, 11);

    // Approach lip so the step up reads from across the plaza.
    for (let i = 0; i < 3; i++) {
      const r = 12.4 + i * 1.5;
      B.at('panelDark', cylGeo(r, r, 0.18, 28, 1.4), cx, 0.09 - i * 0.06, cz);
    }

    // Four sandstone-warm standing stones, so the citadel gateway reads as
    // older than the two beside it before the player is close enough to read
    // the sign.
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI * 0.25;
      const px = cx + Math.cos(a) * 6.4;
      const pz = cz + Math.sin(a) * 6.4;
      // Standing on the dais, not on where the dais used to end.
      B.at('panelWarm', boxGeo(1.1, 5.2, 1.1, 1.4), px, D + 2.6, pz, -a);
      B.at('emAmber', boxGeo(0.3, 0.22, 0.3, 1), px, D + 4.6, pz, -a);
      this._solidRot(px, D + 2.6, pz, 0.55, 2.6, 0.55, -a);
      this._contact(px, pz, 3.0);
    }

    /* Destination placard, stairs and a service ramp - everything the two
     * Z-axis gateways have and these two were missing.
     *
     * The dais top is 0.8 m above the deck. That is over a step and under a
     * mantle, so without a flight of stairs it was simply a wall: the two
     * newest worlds in the game were behind the only doors on the station with
     * no way up to them and no sign saying what they were.
     *
     * `sgn` points from the plaza toward the dais, so the stairs land on the
     * plaza-facing side and the ramp on the far side, mirroring the other two.
     */
    const sgn = spec.side;
    const em = spec.target === 'citadel' ? 'emAmber' : 'emGreen';

    // Two-sided board on the plaza axis - it is approached from both sides.
    this._signBoard(
      B,
      spec.signRole ?? SIGN_ROLE.gatewayRace,
      9, 2.2,
      cx - sgn * 1.35, GATEWAY_DECK_Y + 11.1, cz, Math.PI * 0.5 * sgn + Math.PI,
      { twoSided: true, accent: em }
    );

    // Backdrop pylons, so the placard and the aperture read against something
    // solid instead of floating against the far hull. Same inset as the pair on
    // the other axis - see the note there.
    for (const sz of [-PYLON_OFF.a, PYLON_OFF.a]) {
      B.at('panel', boxGeo(2.6, 14, 2.6, 3), cx + sgn * PYLON_OFF.b, GATEWAY_DECK_Y + 7, cz + sz);
      B.at(em, boxGeo(0.34, 12, 0.34, 1), cx + sgn * (PYLON_OFF.b - 1.3), GATEWAY_DECK_Y + 7, cz + sz + (sz < 0 ? 1.5 : -1.5));
      this._solid(cx + sgn * PYLON_OFF.b, 7, cz + sz, 1.3, 7, 1.3);
    }

    /* Approach ramp from the plaza deck up to the gateway deck.
     *
     * A ramp rather than the stair flight the other two use, because these
     * gateways sit on the raised deck at 2.87 m with nothing between them and
     * the plaza at 0 - measured, the profile went 0, 0, 0 ... 0, then 2.87. That
     * is a wall, and it was the only way in to two of the five worlds. Ten
     * metres of run over 2.87 m of rise is about 16 degrees, which walks, drives
     * and rides without anyone having to aim for a step.
     *
     * The collider comes from `_ramp` (an invisible tilted box, because physics
     * only rotates colliders about Y); the visible wedge is drawn on top of it
     * at the same pitch so the two describe the same slope. */
    const DECK_Y = GATEWAY_DECK_Y;
    const RUN = 10;
    /* The ramp starts at the *rim* of the dais and runs outward. It used to
     * start 5 m from the centre, which is six metres inside an eleven-metre
     * dais - most of the slope was buried in the thing it was supposed to
     * climb, and only its last few metres ever saw daylight. */
    const DECK_EDGE = 11;
    const rampPitch = Math.atan2(DECK_Y, RUN);
    /* `_ramp` builds its proxy long in local +Z and tilts that end *up*, so the
     * yaw has to point local +Z at the deck. `sgn` already points from the plaza
     * toward the gateway, which makes this just `sgn * 90 degrees` - getting the
     * sign backwards builds a ramp that descends into the dais, which is what
     * the first attempt did. */
    const rampYaw = sgn * Math.PI / 2;
    const rampMidX = cx - sgn * (DECK_EDGE + RUN * 0.5);
    // `_ramp`'s box is 0.5 thick, so its centre sits half a thickness below the
    // walking surface once pitched.
    this._ramp(rampMidX, DECK_Y * 0.5 - 0.25 / Math.cos(rampPitch), cz, 8, RUN, DECK_Y, rampYaw);
    // Visible wedge: long in local Z to match the collider, since `GeoBatch.at`
    // composes YXZ and therefore tilts about the yawed X axis.
    B.at('plaza', boxGeo(8, 0.3, RUN + 0.4, 2), rampMidX, DECK_Y * 0.5, cz, rampYaw, -rampPitch);
    // Kerbs, so the edge of the slope reads before you walk off it.
    for (const sz of [-4.2, 4.2]) {
      B.at('trim', boxGeo(0.4, 0.34, RUN + 0.4, 1), rampMidX, DECK_Y * 0.5 + 0.24, cz + sz, rampYaw, -rampPitch);
      B.at(em, boxGeo(0.12, 0.07, RUN, 1), rampMidX, DECK_Y * 0.5 + 0.42, cz + sz, rampYaw, -rampPitch);
    }

    // Guide lights marching across the dais to the threshold. Kept inside the
    // rim so they sit on the deck rather than hanging over the ramp's slope.
    for (let i = 0; i < 7; i++) {
      const t = i / 6;
      const sx = cx - sgn * (10.4 - t * 4);
      B.at(em, boxGeo(0.5, 0.14, 0.5, 1), sx, D + 0.1, cz - 6);
      B.at(em, boxGeo(0.5, 0.14, 0.5, 1), sx, D + 0.1, cz + 6);
    }

    this._contact(cx, cz, 30);
    B.flush(g, M, `gateway-${spec.target}`, { cast: true, recv: true });

    this.portalSpecs.push({
      position: new THREE.Vector3(cx, GATEWAY_DECK_Y, cz),
      // Face the plaza, whichever side it is on.
      rotationY: Math.PI * 0.5 * spec.side,
      target: spec.target,
      label: spec.label,
      accent: spec.accent,
    });
    this._mmCircle(
      cx, cz, 11, 'rgba(255,180,70,0.22)',
      `#${new THREE.Color(spec.accent).getHexString()}`
    );
  }

  /* ---------------------------------------------------------------- */
  /* Elevated walkway loop                                             */
  /* ---------------------------------------------------------------- */

  _buildWalkwayLoop() {
    const M = this.mat;
    const B = new GeoBatch();
    const g = new THREE.Group();
    g.name = 'promenade';
    this.group.add(g);

    const SEGS = 36;
    const segAng = (Math.PI * 2) / SEGS;
    const chord = 2 * LOOP_R * Math.tan(segAng / 2) + 0.4;
    const width = 6;

    const postEntries = [];
    for (let i = 0; i < SEGS; i++) {
      const th = i * segAng;
      const x = Math.cos(th) * LOOP_R;
      const z = Math.sin(th) * LOOP_R;
      // Local +X must follow the ring tangent, not the radius, or the deck
      // segments end up 13 m deep and 6 m apart with gaps between them.
      const yaw = -th - Math.PI / 2;

      B.at('grate', boxGeo(chord, 0.45, width, 1.6), x, LOOP_Y - 0.22, z, yaw);
      // Under-slung beam + service conduit.
      B.at('panelDark', boxGeo(chord, 0.9, 1.1, 3), x, LOOP_Y - 0.95, z, yaw);
      const cond = new THREE.CylinderGeometry(0.18, 0.18, chord, 6);
      cond.rotateZ(Math.PI / 2);
      uvScale(cond, chord / 2, 3);
      B.at('copper', cond, Math.cos(th) * (LOOP_R + 2.4), LOOP_Y - 1.2, Math.sin(th) * (LOOP_R + 2.4), yaw);

      this._solidRot(x, LOOP_Y - 0.25, z, chord / 2, 0.3, width / 2, yaw);

      // Railing rails on both edges.
      for (const s of [-1, 1]) {
        const rr = LOOP_R + s * (width / 2 - 0.15);
        const rx = Math.cos(th) * rr, rz = Math.sin(th) * rr;
        B.at('trim', boxGeo(chord, 0.09, 0.09, 1), rx, LOOP_Y + 1.08, rz, yaw);
        B.at('emCyan', boxGeo(chord, 0.06, 0.06, 1), rx, LOOP_Y + 1.14, rz, yaw);
        B.at('trim', boxGeo(chord, 0.07, 0.07, 1), rx, LOOP_Y + 0.6, rz, yaw);
        // A short kickplate so you cannot see under the deck.
        B.at('panelDark', boxGeo(chord, 0.35, 0.08, 1), rx, LOOP_Y + 0.18, rz, yaw);
        /* Warm soffit run under the walkway edge.
         *
         * The gateway wide shot was a single-hue image: left wall, right
         * corridor, deck, gantry and ceiling all inside one narrow blue band,
         * with the yellow chevrons and the green portal as the only chromatic
         * events - so the eye had nothing to navigate by. The loop encircles
         * the whole plaza at 10 m, which makes its underside the one surface
         * that appears in *every* framing: a continuous 2700 K run down it is
         * the cheapest way to put a motivated warm source into the frame and
         * give the cool structure something to be cool against. Warm below,
         * cool handrail above - the split is legible as a height cue too.
         */
        B.at('trim', boxGeo(chord, 0.16, 0.26, 1), rx, LOOP_Y - 0.46, rz, yaw);
        B.at('emAmber', boxGeo(chord - 0.2, 0.08, 0.17, 1), rx, LOOP_Y - 0.56, rz, yaw);
        postEntries.push([rx, LOOP_Y + 0.55, rz, 0, yaw, 0, 1, 1, 1]);
        // Keep the player from walking off the loop.
        this._solidRot(rx, LOOP_Y + 0.6, rz, chord / 2, 0.6, 0.08, yaw);
      }
    }
    g.add(instanced(boxGeo(0.08, 1.1, 0.08, 1), M.trim, postEntries, { cast: true, recv: false }));

    // Support columns, kept clear of the avenues.
    for (let i = 0; i < 12; i++) {
      const th = (i / 12) * Math.PI * 2 + 15 * DEG;
      const x = Math.cos(th) * LOOP_R, z = Math.sin(th) * LOOP_R;
      const col = new THREE.CylinderGeometry(0.85, 1.25, LOOP_Y - 1, 12);
      uvScale(col, 8, 6);
      B.at('panelDark', col, x, (LOOP_Y - 1) / 2, z);
      B.at('hazard', new THREE.CylinderGeometry(1.3, 1.45, 1.2, 12), x, 0.6, z);
      const brace = boxGeo(0.5, 4.2, 0.5, 2);
      B.at('trim', brace, x - Math.cos(th) * 1.6, LOOP_Y - 2.6, z - Math.sin(th) * 1.6, -th, 0, 0.5);
      this._solid(x, (LOOP_Y - 1) / 2, z, 1.0, (LOOP_Y - 1) / 2, 1.0);
    }

    // Four radial stair flights up from the deck.
    const stepEntries = [];
    for (const deg of [30, 150, 210, 330]) {
      const th = deg * DEG;
      const yaw = -th - Math.PI / 2;
      const rOuter = 88, rInner = LOOP_R;
      const run = rOuter - rInner;
      const rise = LOOP_Y - 0.45;
      const midR = (rOuter + rInner) / 2;
      const cx = Math.cos(th) * midR, cz = Math.sin(th) * midR;
      this._ramp(cx, rise / 2 - 0.24, cz, 4.6, run, rise, yaw);

      const N = 26;
      for (let i = 0; i < N; i++) {
        const t = (i + 0.5) / N;
        const r = rOuter - t * run;
        const y = t * rise;
        // Tread width across the flight, going along the radius.
        stepEntries.push([
          Math.cos(th) * r, y - 0.09, Math.sin(th) * r,
          0, -th - Math.PI / 2, 0, 1, 1, 1,
        ]);
      }
      // Stair stringers and handrails.
      for (const s of [-1, 1]) {
        const off = s * 2.5;
        const p0 = roadPos(deg, rOuter, off, 0, new THREE.Vector3());
        const p1 = roadPos(deg, rInner, off, rise, new THREE.Vector3());
        const mid = p0.clone().add(p1).multiplyScalar(0.5);
        const len = p0.distanceTo(p1);
        const rail = boxGeo(0.12, 0.12, len, 1);
        const pitch = Math.atan2(rise, run);
        B.at('trim', rail, mid.x, mid.y + 1.05, mid.z, yaw, -pitch);
        B.at('panelDark', boxGeo(0.3, 0.7, len, 2), mid.x, mid.y - 0.5, mid.z, yaw, -pitch);
      }
      this._mmPath(
        [[Math.cos(th) * rOuter, Math.sin(th) * rOuter], [Math.cos(th) * rInner, Math.sin(th) * rInner]],
        'rgba(120,220,255,0.6)', 5, false
      );
    }
    const stepGeo = boxGeo(4.6, 0.18, 0.62, 1.5);
    g.add(instanced(stepGeo, M.grate, stepEntries, { cast: true, recv: true }));

    B.flush(g, M, 'promenade', { cast: true, recv: true });

    this._mmCircle(0, 0, LOOP_R, null, 'rgba(120,220,255,0.55)');
  }

  /* ---------------------------------------------------------------- */
  /* Reusable building kit                                             */
  /* ---------------------------------------------------------------- */

  /**
   * A glazed window band on one face of a block: recess, mullions, pane and a
   * painted lit-interior card behind it. The card is what makes the buildings
   * read as inhabited rather than as boxes with blue rectangles on them.
   */
  _windowBand(B, o, yaw, lz, faceRy, bandW, bandH, ly, rng, lit = true) {
    const { x, z } = o;
    // `inward` points from the facade back into the building, whichever face
    // this band sits on, so the stack reads glass -> lit card -> dark reveal.
    const inward = lz < 0 ? 1 : -1;
    B.localAt('panelDark', boxGeo(bandW + 0.9, bandH + 0.7, 0.55, 2), x, 0, z, yaw, 0, ly, lz + 0.42 * inward, faceRy);
    if (lit) {
      const card = new THREE.PlaneGeometry(bandW, bandH);
      const cell = Math.floor(rng() * 16);
      atlasUV(card, cell % 4, Math.floor(cell / 4), 4, 4);
      B.localAt('room', card, x, 0, z, yaw, 0, ly, lz + 0.14 * inward, faceRy);
    }
    const pane = new THREE.PlaneGeometry(bandW + 0.5, bandH + 0.3);
    B.localAt('glassWindow', pane, x, 0, z, yaw, 0, ly, lz, faceRy);

    // Mullions and the cill stand proud of the glazing line.
    const cols = Math.max(2, Math.round(bandW / 2.4));
    for (let i = 0; i <= cols; i++) {
      const lx = -bandW / 2 + (bandW * i) / cols;
      B.localAt('trim', boxGeo(0.15, bandH + 0.5, 0.42, 1), x, 0, z, yaw, lx, ly, lz - 0.12 * inward, faceRy);
    }
    B.localAt('trim', boxGeo(bandW + 0.9, 0.2, 0.5, 1), x, 0, z, yaw, 0, ly - bandH / 2 - 0.25, lz - 0.18 * inward, faceRy);
  }

  /** Roof clutter: plant rooms, vents, dishes, antennae, ladders, placards. */
  _roofKit(B, x, z, yaw, w, d, y, rng) {
    const n = 2 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) {
      const bw = 1.6 + rng() * 3.4;
      const bd = 1.6 + rng() * 3.0;
      const bh = 1.0 + rng() * 2.2;
      const lx = (rng() - 0.5) * (w - bw - 1.5);
      const lz = (rng() - 0.5) * (d - bd - 1.5);
      B.localAt('panelDark', boxGeo(bw, bh, bd, 2), x, y, z, yaw, lx, bh / 2, lz);
      // Extract fan on top of the bigger plant rooms.
      if (bw > 2.6) {
        const fan = new THREE.CylinderGeometry(bw * 0.28, bw * 0.3, 0.5, 12);
        uvScale(fan, 6, 1);
        B.localAt('grate', fan, x, y, z, yaw, lx, bh + 0.25, lz);
      }
    }
    // Antenna cluster.
    const ax = (rng() - 0.5) * (w - 3);
    const az = (rng() - 0.5) * (d - 3);
    const mast = new THREE.CylinderGeometry(0.1, 0.16, 3.5 + rng() * 4, 6);
    uvScale(mast, 3, 4);
    B.localAt('trim', mast, x, y, z, yaw, ax, 2.4, az);
    for (let i = 0; i < 3; i++) {
      B.localAt('trim', boxGeo(1.4 - i * 0.3, 0.07, 0.07, 1), x, y, z, yaw, ax, 2.6 + i * 0.7, az);
    }
    B.localAt('emRed', new THREE.SphereGeometry(0.16, 8, 6), x, y, z, yaw, ax, 4.6, az);

    // Parapet rail so roofs do not end in a hard edge.
    for (const [sx, sz, lw, ld] of [[0, -d / 2 + 0.2, w, 0.16], [0, d / 2 - 0.2, w, 0.16], [-w / 2 + 0.2, 0, 0.16, d], [w / 2 - 0.2, 0, 0.16, d]]) {
      B.localAt('trim', boxGeo(lw, 0.1, ld, 1), x, y, z, yaw, sx, 1.0, sz);
      B.localAt('panelDark', boxGeo(lw, 0.9, ld, 1.5), x, y, z, yaw, sx, 0.45, sz);
    }
  }

  /** Exposed services: conduit stack, cable tray and a caged ladder. */
  _servicesRun(B, x, z, yaw, w, d, h, rng) {
    const side = rng() < 0.5 ? -1 : 1;
    const lx = side * (w / 2 + 0.35);
    for (let i = 0; i < 3; i++) {
      const pipe = new THREE.CylinderGeometry(0.16 + i * 0.05, 0.16 + i * 0.05, h - 1, 6);
      uvScale(pipe, 3, h / 3);
      B.localAt(i === 1 ? 'copper' : 'trim', pipe, x, 0, z, yaw, lx, (h - 1) / 2 + 0.4, -d / 4 + i * 0.55);
    }
    // Cable bundle sagging between brackets.
    for (let i = 0; i < 4; i++) {
      const ly = 2.2 + i * (h - 4) / 4;
      B.localAt('rubber', boxGeo(0.5, 0.16, 0.16, 1), x, 0, z, yaw, lx + side * 0.25, ly, -d / 4 + 1.1);
    }
    // Caged ladder.
    const lz2 = d / 2 - 0.6;
    for (const dx of [-0.28, 0.28]) {
      const rail = new THREE.CylinderGeometry(0.05, 0.05, h - 0.6, 5);
      B.localAt('trim', rail, x, 0, z, yaw, -w / 2 - 0.3 + dx * 0, (h - 0.6) / 2, lz2 + dx);
    }
    const rungs = Math.floor((h - 1) / 0.42);
    for (let i = 0; i < rungs; i++) {
      B.localAt('trim', boxGeo(0.06, 0.05, 0.62, 1), x, 0, z, yaw, -w / 2 - 0.3, 0.6 + i * 0.42, lz2);
    }
    for (let i = 0; i < Math.floor(h / 1.6); i++) {
      const hoop = new THREE.TorusGeometry(0.45, 0.035, 4, 10, Math.PI * 1.35);
      hoop.rotateY(Math.PI / 2);
      B.localAt('trim', hoop, x, 0, z, yaw, -w / 2 - 0.75, 2.4 + i * 1.6, lz2, 0, 0, Math.PI / 2);
    }
  }

  /**
   * The workhorse: a modular habitat / commercial block with a plinth, glazed
   * floor bands, a string course, roof clutter and exposed services.
   * @returns {number} total height
   */
  _block(B, o) {
    const rng = o.rng;
    const { x, z, yaw, w, d } = o;
    const floors = o.floors;
    const fh = o.floorH ?? 3.6;
    const plinth = 0.9;
    const parapet = o.parapet ?? 1.4;
    const h = plinth + floors * fh + parapet;
    const body = o.body ?? 'panel';

    // Plinth + main mass.
    B.localAt('panelDark', boxGeo(w + 0.7, plinth, d + 0.7, 2), x, 0, z, yaw, 0, plinth / 2, 0);
    B.localAt(body, boxGeo(w, h - plinth, d, 2), x, 0, z, yaw, 0, plinth + (h - plinth) / 2, 0);

    // Corner pilasters break the silhouette and catch the rim light.
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        B.localAt('panelDark', boxGeo(1.1, h - plinth - 0.2, 1.1, 2), x, 0, z, yaw, sx * (w / 2 - 0.3), plinth + (h - plinth) / 2, sz * (d / 2 - 0.3));
      }
    }

    // Glazed bands on the facade (and the flank of corner blocks).
    const faces = o.faces ?? [{ lz: -d / 2 - 0.02, ry: Math.PI, span: w }];
    for (let f = 0; f < floors; f++) {
      const ly = plinth + f * fh + fh * 0.56;
      const bandH = fh * 0.52;
      for (const face of faces) {
        this._windowBand(B, o, yaw, face.lz, face.ry, face.span - 3.2, bandH, ly, rng, rng() > 0.18);
      }
      // String course between floors.
      B.localAt('trim', boxGeo(w + 0.5, 0.22, d + 0.5, 2), x, 0, z, yaw, 0, plinth + (f + 1) * fh, 0);
    }

    // Entrance canopy with a lit soffit.
    if (o.entrance !== false) {
      const ez = -d / 2 - 1.1;
      B.localAt('panelDark', boxGeo(5.4, 0.42, 2.4, 2), x, 0, z, yaw, 0, 3.5, ez);
      B.localAt('emCyan', boxGeo(4.8, 0.12, 1.8, 1), x, 0, z, yaw, 0, 3.26, ez);
      B.localAt('panelDark', boxGeo(4.2, 3.3, 0.5, 2), x, 0, z, yaw, 0, 1.65, -d / 2 - 0.2);
      B.localAt('emAmber', boxGeo(4.4, 0.14, 0.2, 1), x, 0, z, yaw, 0, 3.36, -d / 2 - 0.42);
      for (const sx of [-2.5, 2.5]) {
        const post = new THREE.CylinderGeometry(0.12, 0.12, 3.3, 6);
        B.localAt('trim', post, x, 0, z, yaw, sx, 1.65, ez);
      }
    }

    // Vents and warning placards scattered over the cladding.
    for (let i = 0; i < 4; i++) {
      const lx = (rng() - 0.5) * (w - 3);
      const ly = plinth + 1 + rng() * (h - plinth - 3);
      B.localAt('grate', boxGeo(1.3, 0.9, 0.35, 1), x, 0, z, yaw, lx, ly, d / 2 + 0.15);
    }
    B.localAt('hazard', boxGeo(1.1, 0.8, 0.1, 1), x, 0, z, yaw, w / 2 - 1.4, 2.4, -d / 2 - 0.09, Math.PI);

    this._servicesRun(B, x, z, yaw, w, d, h, rng);
    this._roofKit(B, x, z, yaw, w - 1.5, d - 1.5, h, rng);

    this._solidRot(x, h / 2, z, w / 2 + 0.4, h / 2, d / 2 + 0.4, yaw);
    this._mmRect(x, z, w, d, yaw, 'rgba(96,116,140,0.55)', 'rgba(160,200,230,0.5)');
    return h;
  }

  /* ---------------------------------------------------------------- */
  /* Commercial strip + observation promenade (avenue 0, the window)   */
  /* ---------------------------------------------------------------- */

  _buildCommercial() {
    const M = this.mat;
    const B = new GeoBatch();
    const g = new THREE.Group();
    g.name = 'commercial';
    this.group.add(g);
    const rng = mulberry32(0xc0ffee);

    const deg = 0;
    let signIndex = 0;

    for (const side of [-1, 1]) {
      for (let i = 0; i < 6; i++) {
        const r = 84 + i * 15.5;
        const depth = 13;
        const off = side * (ROAD_W / 2 + 4.5 + depth / 2);
        const p = roadPos(deg, r, off, 0, new THREE.Vector3());
        const yaw = faceRoadYaw(deg, side);
        const width = 13.5;
        const height = 8.5 + (i % 3) * 2.2;

        // --- Shell built as separate walls so the interior stays visible ---
        const wallT = 0.5;
        B.localAt('panel', boxGeo(width, height, wallT, 2), p.x, 0, p.z, yaw, 0, height / 2, depth / 2);            // back
        B.localAt('panel', boxGeo(wallT, height, depth, 2), p.x, 0, p.z, yaw, -width / 2, height / 2, 0);            // left
        B.localAt('panel', boxGeo(wallT, height, depth, 2), p.x, 0, p.z, yaw, width / 2, height / 2, 0);             // right
        B.localAt('panelDark', boxGeo(width + 1.2, 0.9, depth + 1.2, 2), p.x, 0, p.z, yaw, 0, height + 0.45, 0);     // roof slab
        B.localAt('panel', boxGeo(width, height - 5.4, wallT, 2), p.x, 0, p.z, yaw, 0, height - (height - 5.4) / 2, -depth / 2); // header
        B.localAt('panelDark', boxGeo(width, 0.7, 1.1, 2), p.x, 0, p.z, yaw, 0, 0.35, -depth / 2 + 0.2);             // sill
        for (const sx of [-1, 1]) {
          B.localAt('trim', boxGeo(1.0, 5.4, 0.7, 2), p.x, 0, p.z, yaw, sx * (width / 2 - 0.5), 2.7, -depth / 2);
        }

        // --- Interior: floor, back panelling, ceiling wash, furniture -----
        B.localAt('panelDark', boxGeo(width - 1, 0.2, depth - 1, 2), p.x, 0, p.z, yaw, 0, 0.1, 0);
        B.localAt('emWhite', boxGeo(width - 3, 0.16, 0.5, 1), p.x, 0, p.z, yaw, 0, height - 1.0, 1.5);
        B.localAt('emAmber', boxGeo(width - 5, 0.16, 0.4, 1), p.x, 0, p.z, yaw, 0, height - 1.0, -2.0);
        const backCard = new THREE.PlaneGeometry(width - 1.4, height - 2.2);
        const cell = (i * 3 + (side > 0 ? 1 : 2)) % 16;
        atlasUV(backCard, cell % 4, Math.floor(cell / 4), 4, 4);
        B.localAt('room', backCard, p.x, 0, p.z, yaw, 0, (height - 2.2) / 2 + 0.4, depth / 2 - 0.4, Math.PI);
        // Counter + shelving + stools.
        B.localAt('panelWarm', boxGeo(width - 4, 1.05, 0.9, 1.5), p.x, 0, p.z, yaw, 0, 0.72, -1.4);
        B.localAt('trim', boxGeo(width - 4, 0.1, 1.05, 1), p.x, 0, p.z, yaw, 0, 1.28, -1.4);
        B.localAt('panelDark', boxGeo(width - 3, 2.6, 0.6, 1.5), p.x, 0, p.z, yaw, 0, 1.5, depth / 2 - 1.1);
        for (let s2 = 0; s2 < 4; s2++) {
          const stool = new THREE.CylinderGeometry(0.28, 0.22, 0.85, 8);
          B.localAt('trim', stool, p.x, 0, p.z, yaw, -3.6 + s2 * 2.4, 0.62, -3.0);
        }
        // Shop glazing.
        const front = new THREE.PlaneGeometry(width - 2.2, 4.6);
        B.localAt('glassWindow', front, p.x, 0, p.z, yaw, 0, 3.0, -depth / 2 - 0.05, Math.PI);

        // --- Signage: a fascia board plus a projecting blade sign ---------
        // Both go through _signBoard: FrontSide quads with an opaque backer,
        // and the blade - which is read from both ends of the street - gets a
        // genuine second face instead of a mirrored back-face read.
        // Twelve shops, twelve reserved commercial cells: no shop can ever
        // repeat another shop's fascia, and none of them can collide with the
        // wayfinding block that starts at SIGN_ROLE.dock.
        const cellId = SIGN_ROLE.shopFirst + (signIndex % 12);
        const fasciaLocal = this._localPoint(p.x, p.z, yaw, 0, height - 2.4, -depth / 2 - 0.42);
        this._signBoard(B, cellId, width - 1.6, 2.0, fasciaLocal.x, fasciaLocal.y, fasciaLocal.z, yaw + Math.PI, {
          accent: 'emCyan', thickness: 0.22,
        });
        const bladeLocal = this._localPoint(p.x, p.z, yaw, -side * (width / 2 + 1.7), height - 1.4, -depth / 2 + 1.2);
        this._signBoard(B, cellId, 3.4, 1.5, bladeLocal.x, bladeLocal.y, bladeLocal.z, yaw + Math.PI / 2, {
          twoSided: true, thickness: 0.2, accent: 'emAmber',
        });
        B.localAt('trim', boxGeo(0.12, 0.12, 2.0, 1), p.x, 0, p.z, yaw, -side * (width / 2 + 0.4), height - 0.7, -depth / 2 + 1.2);
        signIndex++;

        // Awning + kerbside clutter.
        B.localAt('panelWarm', boxGeo(width, 0.18, 2.6, 2), p.x, 0, p.z, yaw, 0, 5.6, -depth / 2 - 1.3, 0, -0.16);
        B.localAt('emAmber', boxGeo(width - 1, 0.1, 0.14, 1), p.x, 0, p.z, yaw, 0, 5.2, -depth / 2 - 2.5);

        this._solidRot(p.x, height / 2 + 0.5, p.z, width / 2 + 0.5, height / 2 + 0.5, depth / 2 + 0.5, yaw);
        this._roofKit(B, p.x, p.z, yaw, width - 2, depth - 2, height + 0.9, rng);
        this._mmRect(p.x, p.z, width, depth, yaw, 'rgba(150,120,70,0.6)', 'rgba(255,200,120,0.6)');
      }
    }

    /* --- Service alley behind each shop row -------------------------- */
    // The rear of the strip is what the eastern approach actually looks at, and
    // it was 80 m of unbroken flat cladding: no doors, no lights, no pipes, no
    // reason to walk down it. It is now working back-of-house, broken on a 4.5 m
    // rhythm, with pools of light and dark instead of one flat ambient value.
    const alleyPools = [];
    const alleyPoolColors = [];
    const alleyWarm = new THREE.Color(0xffb877);
    for (const side of [-1, 1]) {
      const zW = side * 26.9;
      for (let i = 0; i < 6; i++) {
        const r = 84 + i * 15.5;
        const width = 13.5;
        const height = 8.5 + (i % 3) * 2.2;

        // Oxidised refacing: the service side of the ring is a different
        // material family from the polished plaza, which is the cheapest way to
        // tell a player which district they are standing in.
        B.at('panelRust', boxGeo(width, height - 1.2, 0.4, 2.6), r, (height - 1.2) / 2, zW, 0);
        B.at('panelDark', boxGeo(width + 0.6, 0.7, 0.9, 2), r, height - 0.6, zW + side * 0.2, 0);

        // Pilaster ribs every 4.5 m break the wall run's silhouette.
        for (let k = -1; k <= 1; k++) {
          B.at('panelDark', boxGeo(0.65, height - 0.9, 0.55, 2), r + k * 4.5, (height - 0.9) / 2, zW + side * 0.36, 0);
        }

        /* Recessed service door with a lit jamb and a threshold spill.
         *
         * The leaf is `trimDark`, not `crate`. `M.crate` is the shipping
         * container skin - ribbed steel with "KESSLER CARGO / AX-357"
         * stencilled across it - and a door leaf wearing it is a 2.2 x 2.9 m
         * container standing flush with the wall, 14 cm of it inside the
         * cladding. From the alley that reads exactly as a cargo box driven
         * halfway into the building, which is what it was reported as. The
         * recess is deliberate; the branding on it was not. */
        const dx = r + (i % 2 ? 3.0 : -3.0);
        B.at('panelDark', boxGeo(3.0, 3.4, 0.8, 2), dx, 1.7, zW - side * 0.25, 0);
        B.at('trimDark', boxGeo(2.2, 2.9, 0.24, 1.6), dx, 1.45, zW + side * 0.18, 0);
        for (const jx of [-1.25, 1.25]) {
          B.at('emAmber', boxGeo(0.1, 2.9, 0.1, 1), dx + jx, 1.5, zW + side * 0.3, 0);
        }
        B.at('emWhite', boxGeo(2.4, 0.1, 0.12, 1), dx, 3.05, zW + side * 0.3, 0);
        alleyPools.push([dx, 0.14, zW + side * 2.4, -Math.PI / 2, 0, 0, 7, 7, 7]);
        alleyPoolColors.push(alleyWarm);
        this._contact(dx, zW + side * 0.9, 5.5);

        // Extract vent with a grille and a stained apron below it.
        const vx = r + (i % 2 ? -4.6 : 4.6);
        B.at('grate', boxGeo(2.2, 1.5, 0.5, 1.4), vx, 5.4, zW + side * 0.3, 0);
        B.at('panelDark', boxGeo(2.6, 0.4, 1.1, 1.4), vx, 6.3, zW + side * 0.55, 0);
        B.at('hazard', boxGeo(2.4, 0.9, 0.12, 1), vx, 1.1, zW + side * 0.28, 0);

        // Caged wall lamp: a real pool of light every 15 m down the alley.
        const lx = r + 7.2;
        B.at('trim', boxGeo(0.6, 0.16, 0.7, 1), lx, 4.6, zW + side * 0.5, 0);
        B.at('emAmber', boxGeo(0.44, 0.3, 0.44, 1), lx, 4.35, zW + side * 0.75, 0);
        B.at('trim', boxGeo(0.52, 0.06, 0.52, 1), lx, 4.1, zW + side * 0.75, 0);
        alleyPools.push([lx, 0.13, zW + side * 1.9, -Math.PI / 2, 0, 0, 9, 9, 9]);
        alleyPoolColors.push(alleyWarm);

        // Back-of-house clutter: stacked crates, barrels, a cable spool.
        const cx = r - 6.4;
        B.at('crate', boxGeo(1.6, 1.6, 1.6, 1.6), cx, 0.8, zW + side * 1.5, 0.2);
        B.at('crate', boxGeo(1.4, 1.4, 1.4, 1.5), cx + 0.2, 2.3, zW + side * 1.4, -0.35);
        B.at('crate', boxGeo(1.5, 1.5, 1.5, 1.6), cx + 1.9, 0.75, zW + side * 1.8, 0.6);
        this._contact(cx + 0.6, zW + side * 1.6, 6);
        for (let b = 0; b < 3; b++) {
          const bx = r + 1.4 + b * 0.95;
          B.at('hazard', cylGeo(0.55, 0.55, 1.2, 12, 1.6), bx, 0.6, zW + side * 1.5, 0);
          this._contact(bx, zW + side * 1.5, 2.1);
        }
        const spool = cylGeo(1.0, 1.0, 0.9, 14, 1.4);
        B.at('rubber', spool, r - 2.2, 1.0, zW + side * 2.2, 0, Math.PI / 2);
        this._contact(r - 2.2, zW + side * 2.2, 3.6);
      }

      // Continuous overhead pipe run and cable tray down the whole alley: the
      // horizontal line that ties twelve separate buildings into one street.
      const span = 96;
      const rMid = 84 + 2.5 * 15.5;
      for (let k = 0; k < 3; k++) {
        const pipe = cylGeo(0.22 + k * 0.07, 0.22 + k * 0.07, span, 10, 2.2, true);
        pipe.rotateZ(Math.PI / 2);
        B.at(k === 1 ? 'copper' : 'trim', pipe, rMid, 6.4 + k * 0.55, zW + side * (1.1 + k * 0.5), 0);
      }
      B.at('grate', boxGeo(span, 0.22, 0.8, 2), rMid, 7.6, zW + side * 1.9, 0);
      for (let c = 0; c < 11; c++) {
        const cxp = rMid - span / 2 + 4 + c * 8.8;
        B.at('panelDark', boxGeo(0.5, 2.2, 2.6, 1.6), cxp, 7.3, zW + side * 1.6, 0);
      }

      // A terminating vista so the alley is a sightline to something.
      const rEnd = 84 + 5.6 * 15.5;
      B.at('panelDark', boxGeo(2.0, 11, 2.0, 2.4), rEnd, 5.5, zW + side * 5.5, 0);
      B.at('panelDark', boxGeo(2.0, 11, 2.0, 2.4), rEnd, 5.5, zW - side * 4.5, 0);
      B.at('panelTeal', boxGeo(2.0, 2.4, 12.5, 2.4), rEnd, 11.6, zW + side * 0.5, 0);
      B.at('emCyan', boxGeo(0.5, 0.34, 11.5, 1), rEnd - 1.1, 10.4, zW + side * 0.5, 0);
      this._signBoard(B, side > 0 ? SIGN_ROLE.hydro : SIGN_ROLE.muster, 6.4, 1.6, rEnd - 1.3, 9.0, zW + side * 0.5, -Math.PI / 2, {
        twoSided: true, accent: 'emCyan',
      });
      alleyPools.push([rEnd, 0.15, zW + side * 0.5, -Math.PI / 2, 0, 0, 16, 16, 16]);
      alleyPoolColors.push(new THREE.Color(0x8fdcff));

      // Two practicals per alley - enough for a real light-and-shadow read
      // without pushing the forward renderer's per-pixel light loop.
      // Intensity is set against the *wall distance*, not the plaza's 10 m
      // throws: at 1.6 m an inverse-square light needs about a seventh of the
      // energy or it clips the cladding to white.
      for (const rl of [96, 127, 158]) {
        const l = new THREE.PointLight(0xffae66, 190, 26, 2);
        l.position.set(rl, 4.3, zW + side * 2.2);
        l.castShadow = false;
        g.add(l);
      }
    }
    const alleyPoolMesh = instanced(new THREE.PlaneGeometry(1, 1), M.pool, alleyPools, { cast: false, recv: false });
    if (alleyPoolMesh.isInstancedMesh) {
      for (let i = 0; i < alleyPoolColors.length; i++) alleyPoolMesh.setColorAt(i, alleyPoolColors[i]);
      alleyPoolMesh.instanceColor.needsUpdate = true;
      alleyPoolMesh.renderOrder = 3;
    }
    g.add(alleyPoolMesh);

    /* --- Observation promenade against the window ------------------- */
    const promR0 = 158, promR1 = 190;
    const arcSegs = 26;
    const halfArc = 48 * DEG;
    for (let i = 0; i < arcSegs; i++) {
      const th = -halfArc + (halfArc * 2 * i) / (arcSegs - 1);
      const chord = (2 * Math.PI * ((promR0 + promR1) / 2) * (halfArc * 2)) / (Math.PI * 2) / arcSegs + 0.6;
      const mr = (promR0 + promR1) / 2;
      const x = Math.cos(th) * mr, z = Math.sin(th) * mr;
      // Raised viewing deck.
      B.at('grate', boxGeo(promR1 - promR0, 0.5, chord, 2), x, 1.75, z, -th);
      this._solidRot(x, 1.75, z, (promR1 - promR0) / 2, 0.3, chord / 2, -th);
      // Balustrade on the inner edge.
      const bx = Math.cos(th) * promR0, bz = Math.sin(th) * promR0;
      B.at('glassWindow', new THREE.PlaneGeometry(chord, 1.15), bx, 2.6, bz, -th + Math.PI / 2);
      B.at('trim', boxGeo(0.14, 0.14, chord, 1), bx, 3.2, bz, -th);
      B.at('emCyan', boxGeo(0.09, 0.09, chord, 1), bx, 3.28, bz, -th);
      this._solidRot(bx, 2.6, bz, 0.2, 1.2, chord / 2, -th);
    }
    // Two flights up onto the promenade.
    for (const th of [-18 * DEG, 18 * DEG]) {
      const cx = Math.cos(th) * (promR0 - 3), cz = Math.sin(th) * (promR0 - 3);
      this._ramp(cx, 0.85, cz, 6, 6, 2.0, -th - Math.PI / 2 + Math.PI);
      B.at('grate', boxGeo(6.4, 0.2, 6.4, 2), cx, 1.1, cz, -th, -0.32);
    }
    // Viewing telescopes and benches facing the planet.
    for (let i = 0; i < 9; i++) {
      const th = -40 * DEG + (80 * DEG * i) / 8;
      const x = Math.cos(th) * 178, z = Math.sin(th) * 178;
      B.at('trim', new THREE.CylinderGeometry(0.18, 0.3, 1.5, 8), x, 2.75, z);
      B.at('panelDark', new THREE.CylinderGeometry(0.22, 0.34, 1.6, 10), x, 3.7, z, -th, 0, 0.9);
      B.at('emCyan', new THREE.SphereGeometry(0.12, 8, 6), x, 4.2, z);
      const bx = Math.cos(th) * 170, bz = Math.sin(th) * 170;
      B.at('trim', boxGeo(1.0, 0.2, 3.4, 2), bx, 2.55, bz, -th);
      B.at('panelDark', boxGeo(0.9, 0.5, 0.5, 1), bx, 2.25, bz + 1.2, -th);
      B.at('panelDark', boxGeo(0.9, 0.5, 0.5, 1), bx, 2.25, bz - 1.2, -th);
    }

    B.flush(g, M, 'commercial', { cast: true, recv: true });
    this._mmPath(
      [[Math.cos(-halfArc) * 174, Math.sin(-halfArc) * 174], [174, 0], [Math.cos(halfArc) * 174, Math.sin(halfArc) * 174]],
      'rgba(120,220,255,0.45)', 30, false
    );
  }

  /* ---------------------------------------------------------------- */
  /* Hangar Bay 4 (avenue 60)                                          */
  /* ---------------------------------------------------------------- */

  _buildHangar() {
    const M = this.mat;
    const B = new GeoBatch();
    const g = new THREE.Group();
    g.name = 'hangar';
    this.group.add(g);
    const rng = mulberry32(0x4a49a2);

    const deg = 60;
    const p = roadPos(deg, 142, 40, 0, new THREE.Vector3());
    const yaw = faceRoadYaw(deg, 1);
    const W = 62, D = 44, H = 24;

    // Shell: back, sides, roof - the front is the open bay mouth.
    B.localAt('panel', boxGeo(W, H, 1.2, 3), p.x, 0, p.z, yaw, 0, H / 2, D / 2);
    for (const sx of [-1, 1]) {
      B.localAt('panel', boxGeo(1.2, H, D, 3), p.x, 0, p.z, yaw, sx * W / 2, H / 2, 0);
      this._solidRot(p.x + Math.cos(yaw) * (sx * W / 2), H / 2, p.z - Math.sin(yaw) * (sx * W / 2), 1.0, H / 2, D / 2, yaw);
    }
    B.localAt('panelDark', boxGeo(W + 2, 1.6, D + 2, 3), p.x, 0, p.z, yaw, 0, H + 0.8, 0);
    // Barrel roof ribs.
    for (let i = 0; i < 7; i++) {
      // Half-torus in its own XY plane already spans the bay width.
      const arch = new THREE.TorusGeometry(W / 2, 0.7, 6, 20, Math.PI);
      B.localAt('panelDark', arch, p.x, 0, p.z, yaw, 0, H + 1.4, -D / 2 + 3 + i * (D - 6) / 6);
    }
    // Bay mouth frame + blast-door pockets.
    B.localAt('hazard', boxGeo(W + 2, 3.0, 2.4, 2), p.x, 0, p.z, yaw, 0, H - 1.5, -D / 2);
    for (const sx of [-1, 1]) {
      B.localAt('hazard', boxGeo(5.0, H - 3, 2.4, 2), p.x, 0, p.z, yaw, sx * (W / 2 - 2.5), (H - 3) / 2, -D / 2);
      this._solidRot(
        p.x + Math.cos(yaw) * (sx * (W / 2 - 2.5)) + Math.sin(yaw) * (-D / 2),
        H / 2,
        p.z - Math.sin(yaw) * (sx * (W / 2 - 2.5)) + Math.cos(yaw) * (-D / 2),
        2.5, H / 2, 1.2, yaw
      );
    }
    B.localAt('panel', boxGeo(W - 10, H - 17, 1.2, 3), p.x, 0, p.z, yaw, 0, H - 4.5, -D / 2);

    // Interior: sealed floor, lane markings, service pits.
    B.localAt('grate', boxGeo(W - 4, 0.3, D - 3, 2), p.x, 0, p.z, yaw, 0, 0.15, 0);
    for (let i = 0; i < 3; i++) {
      B.localAt('hazard', boxGeo(0.5, 0.06, D - 6, 1), p.x, 0, p.z, yaw, -18 + i * 18, 0.33, 0);
    }
    // Ceiling light banks.
    for (let i = 0; i < 4; i++) {
      B.localAt('emWhite', boxGeo(W - 12, 0.4, 1.4, 2), p.x, 0, p.z, yaw, 0, H - 1.2, -D / 2 + 6 + i * (D - 12) / 3);
    }

    // Overhead gantry crane on rails, with a docking arm gripping a shuttle.
    for (const sx of [-1, 1]) {
      B.localAt('trim', boxGeo(1.0, 0.8, D - 4, 2), p.x, 0, p.z, yaw, sx * (W / 2 - 3), H - 4, 0);
    }
    const crane = new THREE.Group();
    crane.position.copy(p);
    crane.rotation.y = yaw;
    g.add(crane);
    const craneMat = M.hazard;
    const bridge = new THREE.Mesh(boxGeo(W - 6, 1.4, 2.2, 2), craneMat);
    bridge.position.set(0, H - 5.2, -4);
    crane.add(bridge);
    const trolley = new THREE.Mesh(boxGeo(4, 1.8, 3.2, 2), M.panelDark);
    trolley.position.set(6, H - 6.6, -4);
    crane.add(trolley);
    const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 8, 5), M.trim);
    cable.position.set(6, H - 11.4, -4);
    crane.add(cable);
    const hook = new THREE.Mesh(boxGeo(2.4, 1.0, 2.4, 1.5), M.hazard);
    hook.position.set(6, H - 15.6, -4);
    crane.add(hook);
    crane.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
    this._anim.craneHook = { trolley, cable, hook, base: -4 };

    // The shuttle under maintenance - the hangar's hero prop.
    const shuttle = new THREE.Group();
    shuttle.position.set(p.x, 0, p.z);
    shuttle.rotation.y = yaw + 0.18;
    g.add(shuttle);
    const sBody = new THREE.Mesh(new THREE.CapsuleGeometry(2.6, 14, 5, 14), M.mirror);
    sBody.rotation.z = Math.PI / 2;
    sBody.position.set(-8, 4.4, 4);
    shuttle.add(sBody);
    const sWing = new THREE.Mesh(boxGeo(7, 0.5, 16, 3), M.panel);
    sWing.position.set(-10, 3.6, 4);
    shuttle.add(sWing);
    const sTail = new THREE.Mesh(boxGeo(4, 5, 0.5, 2), M.panel);
    sTail.position.set(-16, 6.6, 4);
    shuttle.add(sTail);
    const sGlass = new THREE.Mesh(new THREE.SphereGeometry(2.35, 16, 12, 0, Math.PI * 2, 0, 1.1), M.glassWindow);
    sGlass.position.set(-2.2, 4.9, 4);
    sGlass.rotation.z = -0.5;
    shuttle.add(sGlass);
    for (const sz of [-1, 1]) {
      const eng = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.5, 3.6, 12), M.panelDark);
      eng.rotation.z = Math.PI / 2;
      eng.position.set(-17, 4.4, 4 + sz * 4.4);
      shuttle.add(eng);
      const glow = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.05, 0.3, 12), M.emCyan);
      glow.rotation.z = Math.PI / 2;
      glow.position.set(-18.7, 4.4, 4 + sz * 4.4);
      shuttle.add(glow);
      const gear = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 3.2, 6), M.trim);
      gear.position.set(-6 + sz * 6, 1.6, 4 + sz * 3);
      shuttle.add(gear);
    }
    shuttle.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
    this._solidRot(p.x - Math.cos(yaw) * 8, 3, p.z + Math.sin(yaw) * 8, 10, 3, 8, yaw);

    // Support clutter around the bay: toolboxes, fuel bowsers, work lights.
    for (let i = 0; i < 12; i++) {
      const lx = (rng() - 0.5) * (W - 12);
      const lz = (rng() - 0.5) * (D - 12);
      const bw = 1.2 + rng() * 2.4;
      B.localAt(rng() < 0.5 ? 'crate' : 'panelDark', boxGeo(bw, 1.0 + rng(), bw * 0.8, 1.6), p.x, 0, p.z, yaw, lx, 0.8, lz);
    }
    // Control mezzanine along the back wall.
    B.localAt('grate', boxGeo(W - 14, 0.4, 5, 2), p.x, 0, p.z, yaw, 0, 8, D / 2 - 3.5);
    B.localAt('glassWindow', new THREE.PlaneGeometry(W - 18, 3.4), p.x, 0, p.z, yaw, 0, 10, D / 2 - 6.2);
    B.localAt('room', new THREE.PlaneGeometry(W - 18, 3.4), p.x, 0, p.z, yaw, 0, 10, D / 2 - 6.5);
    B.localAt('trim', boxGeo(W - 14, 0.1, 0.1, 1), p.x, 0, p.z, yaw, 0, 9.3, D / 2 - 6.0);

    // Landing pad and approach markings outside the bay mouth.
    const padCentre = roadPos(deg, 108, 40, 0, new THREE.Vector3());
    const pad = new THREE.Mesh(
      uvScale(new THREE.CircleGeometry(20, 48), 4, 4),
      M.plaza
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(padCentre.x, 0.12, padCentre.z);
    pad.receiveShadow = true;
    pad.castShadow = false;
    g.add(pad);
    const padRing = new THREE.TorusGeometry(18.5, 0.22, 6, 64);
    padRing.rotateX(-Math.PI / 2);
    B.at('emAmber', padRing, padCentre.x, 0.2, padCentre.z);
    for (let i = 0; i < 12; i++) {
      const th = (i / 12) * Math.PI * 2;
      B.at('emAmber', boxGeo(0.6, 0.12, 0.6, 1), padCentre.x + Math.cos(th) * 16, 0.2, padCentre.z + Math.sin(th) * 16);
    }

    B.flush(g, M, 'hangar', { cast: true, recv: true });

    const bayLight = new THREE.PointLight(0xbfe4ff, 2600, 90, 2);
    bayLight.position.set(p.x, 16, p.z);
    g.add(bayLight);

    this._mmRect(p.x, p.z, W, D, yaw, 'rgba(70,110,140,0.6)', 'rgba(140,220,255,0.7)');
    this._mmCircle(padCentre.x, padCentre.z, 19, 'rgba(200,150,60,0.2)', 'rgba(255,190,90,0.7)');
  }

  /* ---------------------------------------------------------------- */
  /* Habitat blocks (avenue 120)                                       */
  /* ---------------------------------------------------------------- */

  _buildHabitat() {
    const M = this.mat;
    const B = new GeoBatch();
    const g = new THREE.Group();
    g.name = 'habitat';
    this.group.add(g);
    const rng = mulberry32(0x4ab17a7);

    /* --- The habitat stacks are the buildings you can go inside --------
     *
     * These six were the clearest example of the thing that was wrong with the
     * whole ring: seven and nine storeys of glazed facade, a lit entrance
     * canopy with a painted door under it, and a single collider around the
     * lot. From the avenue they read as blocks of flats; walk up to one and the
     * door is a texture.
     *
     * They are the obvious candidates because they were already tall enough -
     * the brief is buildings of seven floors or more, and `floors` here was
     * already 5, 7 or 9 on a rotation. The floor of 7 is now the actual floor:
     * a five-storey shell with a lift, two escalator banks and a core costs
     * almost exactly what a seven-storey one does, and seven is what makes the
     * climb worth doing.
     *
     * See station/Tower.js for the section. The external stair core below is
     * kept even though the building now has two internal routes up, because it
     * is what breaks the silhouette against the hull from the plaza.
     */
    const deg = 120;
    const towers = [];
    for (const side of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const r = 92 + i * 30;
        const w = 24, d = 22;
        const off = side * (ROAD_W / 2 + 6 + d / 2);
        const p = roadPos(deg, r, off, 0, new THREE.Vector3());
        const yaw = faceRoadYaw(deg, side);
        const floors = 7 + ((i + (side > 0 ? 1 : 0)) % 3);
        const built = buildTower(
          this, B, g,
          {
            x: p.x, z: p.z, yaw, w, d, floors,
            label: `Habitat Stack ${side > 0 ? 'N' : 'S'}${i + 1}`,
            accent: 'emCyan',
            body: i % 2 ? 'panel' : 'panelWarm',
            fit: 'hab',
          },
          rng
        );
        this.enterables.push(built.enterable);
        this._selfCollided.push(built.footprint);
        this._roofs.push({ x: p.x, y: built.roofY, z: p.z });
        const h = built.height;
        this._mmRect(p.x, p.z, w, d, yaw, 'rgba(96,116,140,0.55)', 'rgba(160,200,230,0.5)');
        towers.push({ p, yaw, h, floors, w, d, side, i });

        // Cylindrical stair core bolted onto the flank.
        const core = new THREE.CylinderGeometry(3.2, 3.2, h + 2, 16);
        uvScale(core, 12, h / 3);
        B.localAt('panelDark', core, p.x, 0, p.z, yaw, side * (w / 2 + 2.4), (h + 2) / 2, 0);
        for (let f = 0; f < 6; f++) {
          const band = new THREE.TorusGeometry(3.3, 0.16, 6, 20);
          band.rotateX(-Math.PI / 2);
          B.localAt('emCyan', band, p.x, 0, p.z, yaw, side * (w / 2 + 2.4), 3 + f * 3.6, 0);
        }
        this._solidRot(
          p.x + Math.cos(yaw) * (side * (w / 2 + 2.4)),
          (h + 2) / 2,
          p.z - Math.sin(yaw) * (side * (w / 2 + 2.4)),
          3.2, (h + 2) / 2, 3.2, yaw
        );
      }
    }

    /* Skybridges linking the towers across the avenue.
     *
     * The deck height comes from the shorter tower's floor plate. It used to be
     * `12 + i * 3.6`, a stagger picked for the silhouette with no relation to
     * either building it lands on - and these towers are 5, 7 or 9 floors
     * depending on where they sit, so the pairs are rarely the same height. The
     * worst case is the outer pair: a 34.7 m tower joined to a 20.3 m one by a
     * bridge at 19.2, which puts its deck 1.1 m *below* the short tower's roof -
     * connecting to no floor at all - while its canopy at 22.0 stands 1.7 m
     * proud of that roof and through the parapet. Standing on the short tower
     * you are looking at a bridge that arrives above the building it arrives at.
     *
     * Floors are `plinth + f * fh` (see `_block`), so this picks the highest
     * floor plate of the shorter tower that still leaves the bridge's own
     * 2.95 m of section under that tower's roof slab.
     */
    for (let i = 0; i < 3; i++) {
      const a = towers[i];
      const b = towers[i + 3];
      /* Land on a floor plate of the shorter tower, leaving its own roof slab
       * clear of the bridge's 2.95 m section. The towers are built by
       * station/Tower.js now, so the storey height is that file's 3.9 and the
       * plates start at zero rather than on a 0.9 plinth - the old arithmetic
       * here was against `_block`'s 3.6 over a plinth and would land a metre
       * out on every span. */
      const shorterFloors = Math.min(a.floors, b.floors);
      const floor = Math.max(1, shorterFloors - 2);
      const y = floor * 3.9;
      const mid = a.p.clone().add(b.p).multiplyScalar(0.5);
      const len = a.p.distanceTo(b.p) - a.d;
      const dir = _v1.subVectors(b.p, a.p).normalize();
      const bYaw = Math.atan2(dir.x, dir.z);
      B.at('grate', boxGeo(3.6, 0.4, len, 2), mid.x, y, mid.z, bYaw);
      B.at('panelDark', boxGeo(4.2, 0.7, len, 2), mid.x, y - 0.55, mid.z, bYaw);
      for (const sx of [-1.9, 1.9]) {
        B.at('glassWindow', new THREE.PlaneGeometry(len, 2.2), mid.x + Math.cos(bYaw) * sx, y + 1.3, mid.z - Math.sin(bYaw) * sx, bYaw + Math.PI / 2);
        B.at('trim', boxGeo(0.14, 0.14, len, 1), mid.x + Math.cos(bYaw) * sx, y + 2.45, mid.z - Math.sin(bYaw) * sx, bYaw);
        B.at('emCyan', boxGeo(0.09, 0.09, len, 1), mid.x + Math.cos(bYaw) * sx, y + 2.53, mid.z - Math.sin(bYaw) * sx, bYaw);
      }
      B.at('trim', boxGeo(4.4, 0.25, len, 2), mid.x, y + 2.8, mid.z, bYaw);
      this._solidRot(mid.x, y, mid.z, 1.9, 0.3, len / 2, bYaw);
      this._mmPath([[a.p.x, a.p.z], [b.p.x, b.p.z]], 'rgba(140,200,240,0.35)', 3, false);
    }

    // A small green terrace between the blocks - the only plants on the ring.
    const parkP = roadPos(deg, 172, 0, 0, new THREE.Vector3());
    // `plazaOnDeck`, not `plaza`: this disc caps the end of the avenue and so
    // shares its plane with the carriageway. See the material for why.
    const park = new THREE.Mesh(uvScale(new THREE.CircleGeometry(16, 40), 3, 3), M.plazaOnDeck);
    park.rotation.x = -Math.PI / 2;
    park.position.set(parkP.x, 0.1, parkP.z);
    park.receiveShadow = true;
    park.castShadow = false;
    g.add(park);
    for (let i = 0; i < 10; i++) {
      const th = (i / 10) * Math.PI * 2;
      const px = parkP.x + Math.cos(th) * 12, pz = parkP.z + Math.sin(th) * 12;
      B.at('panelDark', new THREE.CylinderGeometry(1.5, 1.7, 1.0, 12), px, 0.6, pz);
      B.at('emGreen', new THREE.SphereGeometry(1.25, 12, 8), px, 1.6, pz);
      this._solid(px, 0.6, pz, 1.6, 0.6, 1.6);
    }

    B.flush(g, M, 'habitat', { cast: true, recv: true });
    this._mmCircle(parkP.x, parkP.z, 16, 'rgba(60,150,100,0.4)', 'rgba(120,255,180,0.5)');
  }

  /* ---------------------------------------------------------------- */
  /* Residential terrace (avenue 180)                                  */
  /* ---------------------------------------------------------------- */

  _buildResidential() {
    const M = this.mat;
    const B = new GeoBatch();
    const g = new THREE.Group();
    g.name = 'residential';
    this.group.add(g);
    const rng = mulberry32(0x7e77ace);

    const deg = 180;
    for (const side of [-1, 1]) {
      const yaw = faceRoadYaw(deg, side);
      const depth = 12;
      const off = side * (ROAD_W / 2 + 5 + depth / 2);
      const unitW = 9.5;
      const units = 9;
      const rStart = 86;

      // Continuous terrace shell, then per-unit articulation.
      for (let u = 0; u < units; u++) {
        const r = rStart + u * unitW;
        const p = roadPos(deg, r, off, 0, new THREE.Vector3());
        const storeys = 2 + (u % 3 === 0 ? 1 : 0);
        const h = 0.8 + storeys * 3.5 + 1.0;

        B.localAt('panelDark', boxGeo(unitW + 0.4, 0.8, depth + 0.6, 2), p.x, 0, p.z, yaw, 0, 0.4, 0);
        B.localAt(u % 2 ? 'panelWarm' : 'panel', boxGeo(unitW, h - 0.8, depth, 2), p.x, 0, p.z, yaw, 0, 0.8 + (h - 0.8) / 2, 0);
        // Party walls stand slightly proud so the terrace reads as units.
        B.localAt('panelDark', boxGeo(0.7, h + 0.5, depth + 0.8, 2), p.x, 0, p.z, yaw, unitW / 2, (h + 0.5) / 2, 0);

        // Door + stoop.
        B.localAt('panelDark', boxGeo(1.5, 2.4, 0.35, 1.5), p.x, 0, p.z, yaw, -2.4, 1.2, -depth / 2 - 0.15);
        B.localAt('emAmber', boxGeo(1.7, 0.14, 0.2, 1), p.x, 0, p.z, yaw, -2.4, 2.55, -depth / 2 - 0.3);
        B.localAt('grate', boxGeo(2.4, 0.24, 1.2, 1.5), p.x, 0, p.z, yaw, -2.4, 0.12, -depth / 2 - 0.8);

        // Glazed bands + balconies.
        for (let f = 0; f < storeys; f++) {
          const ly = 0.8 + f * 3.5 + 2.0;
          this._windowBand(B, { x: p.x, z: p.z }, yaw, -depth / 2 - 0.02, Math.PI, unitW - 3.2, 1.9, ly, rng, rng() > 0.15);
          if (f > 0) {
            B.localAt('grate', boxGeo(unitW - 1.6, 0.2, 1.9, 1.5), p.x, 0, p.z, yaw, 0, ly - 1.15, -depth / 2 - 1.0);
            B.localAt('trim', boxGeo(unitW - 1.6, 0.1, 0.1, 1), p.x, 0, p.z, yaw, 0, ly + 0.05, -depth / 2 - 1.9);
            B.localAt('glassWindow', new THREE.PlaneGeometry(unitW - 1.6, 1.1), p.x, 0, p.z, yaw, 0, ly - 0.5, -depth / 2 - 1.9, Math.PI);
            // Balcony clutter: a planter and a stowed crate.
            B.localAt('panelWarm', boxGeo(1.1, 0.6, 0.9, 1), p.x, 0, p.z, yaw, unitW / 2 - 1.6, ly - 0.75, -depth / 2 - 1.3);
            B.localAt('emGreen', new THREE.SphereGeometry(0.42, 8, 6), p.x, 0, p.z, yaw, unitW / 2 - 1.6, ly - 0.2, -depth / 2 - 1.3);
          }
        }

        // Rear yard: bins, conduit, a satellite dish.
        B.localAt('crate', boxGeo(1.3, 1.5, 1.1, 1.5), p.x, 0, p.z, yaw, 2.6, 0.75, depth / 2 + 1.2);
        const dish = new THREE.SphereGeometry(0.85, 14, 10, 0, Math.PI * 2, 0, 1.0);
        B.localAt('trim', dish, p.x, 0, p.z, yaw, -3.0, h - 0.8, depth / 2 - 0.4, 0, -0.9);

        this._roofKit(B, p.x, p.z, yaw, unitW - 2, depth - 2, h, rng);
        this._solidRot(p.x, h / 2, p.z, unitW / 2 + 0.3, h / 2, depth / 2 + 0.4, yaw);
        this._mmRect(p.x, p.z, unitW, depth, yaw, 'rgba(120,110,90,0.55)', 'rgba(210,190,150,0.45)');
      }

      // Shared stair tower closing the terrace.
      const capP = roadPos(deg, rStart + units * unitW + 5, off, 0, new THREE.Vector3());
      const capH = 15;
      B.localAt('panelDark', boxGeo(9, capH, depth, 2), capP.x, 0, capP.z, yaw, 0, capH / 2, 0);
      for (let f = 0; f < 4; f++) {
        B.localAt('glassWindow', new THREE.PlaneGeometry(6, 2.2), capP.x, 0, capP.z, yaw, 0, 2.4 + f * 3.4, -depth / 2 - 0.03, Math.PI);
        B.localAt('room', new THREE.PlaneGeometry(6, 2.2), capP.x, 0, capP.z, yaw, 0, 2.4 + f * 3.4, -depth / 2 - 0.35, Math.PI);
      }
      this._roofKit(B, capP.x, capP.z, yaw, 7, depth - 2, capH, rng);
      this._solidRot(capP.x, capH / 2, capP.z, 4.5, capH / 2, depth / 2, yaw);
    }

    B.flush(g, M, 'residential', { cast: true, recv: true });
  }

  /* ---------------------------------------------------------------- */
  /* Traffic Control + antenna field (avenue 240)                      */
  /* ---------------------------------------------------------------- */

  _buildControlTower() {
    const M = this.mat;
    const B = new GeoBatch();
    const g = new THREE.Group();
    g.name = 'control';
    this.group.add(g);
    const rng = mulberry32(0xc0117201);

    const deg = 240;
    /* Off the carriageway, not on it.
     *
     * Traffic Control stood dead on the avenue centre line at r=128, which was
     * right while avenue 240 was a cul-de-sac that existed to lead the eye to
     * it. It is now the route to the Ring 8 expansion site, and a 13 m drum in
     * the middle of a through road is not a landmark, it is a blockage: marched
     * down every lane of the corridor from the plaza to the hull, not one
     * straight line got past r=196, and most stopped at 119 - the tower's near
     * face. 26 m clears the 18 m carriageway and the tower's own radius with
     * five metres to spare, and the building reads better for it. You pass it
     * now instead of stopping at it.
     */
    const p = roadPos(deg, 128, 26, 0, new THREE.Vector3());
    const yaw = -deg * DEG;
    const H = 44;

    // Base bunker.
    const base = new THREE.CylinderGeometry(11, 13, 6, 20);
    uvScale(base, 30, 2);
    B.at('panelDark', base, p.x, 3, p.z);
    const bandRing = new THREE.TorusGeometry(11.2, 0.3, 6, 40);
    bandRing.rotateX(-Math.PI / 2);
    B.at('emAmber', bandRing, p.x, 5.6, p.z);
    this._solid(p.x, 3, p.z, 12, 3, 12);

    // Shaft with a spiral conduit and access ladder.
    const shaft = new THREE.CylinderGeometry(4.6, 5.6, H - 6, 20);
    uvScale(shaft, 22, (H - 6) / 3);
    B.at('panel', shaft, p.x, 6 + (H - 6) / 2, p.z);
    this._solid(p.x, H / 2, p.z, 5.2, H / 2, 5.2);
    for (let i = 0; i < 9; i++) {
      const ring = new THREE.TorusGeometry(4.9 - i * 0.09, 0.16, 6, 28);
      ring.rotateX(-Math.PI / 2);
      B.at(i % 3 === 0 ? 'emCyan' : 'trim', ring, p.x, 9 + i * 3.6, p.z);
    }
    for (let i = 0; i < Math.floor((H - 8) / 0.45); i++) {
      B.at('trim', boxGeo(0.6, 0.05, 0.06, 1), p.x + 5.0, 7 + i * 0.45, p.z, yaw);
    }

    // Flared observation head with raked glazing - the classic tower read.
    const headLower = new THREE.CylinderGeometry(10.5, 5.2, 4.5, 24);
    uvScale(headLower, 30, 2);
    B.at('panelDark', headLower, p.x, H - 4, p.z);
    const headGlass = new THREE.CylinderGeometry(11.6, 10.5, 5.0, 24, 1, true);
    B.at('glassWindow', headGlass, p.x, H + 0.6, p.z);
    const headRoom = new THREE.CylinderGeometry(9.8, 9.4, 4.6, 24, 1, true);
    uvScale(headRoom, 12, 1);
    B.at('room', headRoom, p.x, H + 0.6, p.z);
    for (let i = 0; i < 12; i++) {
      const th = (i / 12) * Math.PI * 2;
      B.at('trim', boxGeo(0.22, 5.2, 0.5, 1), p.x + Math.cos(th) * 11.0, H + 0.6, p.z + Math.sin(th) * 11.0, -th, 0, 0.1);
    }
    const roof = new THREE.CylinderGeometry(12.4, 11.9, 1.2, 24);
    uvScale(roof, 34, 1);
    B.at('panelDark', roof, p.x, H + 3.7, p.z);
    const gallery = new THREE.TorusGeometry(12.6, 0.15, 6, 44);
    gallery.rotateX(-Math.PI / 2);
    B.at('emCyan', gallery, p.x, H + 4.4, p.z);
    this._solid(p.x, H + 1, p.z, 11.6, 3.5, 11.6);

    // Radar mast + rotating beacon.
    const mast = new THREE.CylinderGeometry(0.5, 0.9, 10, 10);
    uvScale(mast, 6, 4);
    B.at('trim', mast, p.x, H + 9, p.z);
    for (let i = 0; i < 4; i++) {
      B.at('trim', boxGeo(3.6 - i * 0.6, 0.09, 0.09, 1), p.x, H + 8 + i * 1.4, p.z, i * 0.7);
    }

    B.flush(g, M, 'control', { cast: true, recv: true });

    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.7, 12, 10), M.emRed);
    beacon.position.set(p.x, H + 14.4, p.z);
    g.add(beacon);
    this._anim.beacons.push(beacon);
    const beaconLight = new THREE.PointLight(0xff4b45, 1400, 70, 2);
    beaconLight.position.copy(beacon.position);
    g.add(beaconLight);
    this._anim.beaconLights.push(beaconLight);

    const towerLight = new THREE.PointLight(0x9fe0ff, 1600, 60, 2);
    towerLight.position.set(p.x, H + 1, p.z);
    g.add(towerLight);

    // Antenna field flanking the tower.
    const A = new GeoBatch();
    const dishEntries = [];
    for (let i = 0; i < 14; i++) {
      const r = 150 + rng() * 38;
      /* Kept off the carriageway for the same reason as the tower. A dish mast
       * is only a 1.2 m collider, so one on the road is not a wall - but
       * fourteen scattered across +/-45 m reliably put two or three of them in
       * the traffic lane, and a through route that makes you weave between
       * radio masts reads as an accident rather than as a yard. */
      let off = (rng() - 0.5) * 90;
      if (Math.abs(off) < ROAD_W / 2 + 4) off = Math.sign(off || 1) * (ROAD_W / 2 + 4 + rng() * 30);
      const q = roadPos(deg, r, off, 0, new THREE.Vector3());
      const hgt = 3 + rng() * 5;
      A.at('trim', new THREE.CylinderGeometry(0.3, 0.45, hgt, 8), q.x, hgt / 2, q.z);
      A.at('panelDark', new THREE.CylinderGeometry(1.4, 1.6, 0.7, 10), q.x, 0.35, q.z);
      dishEntries.push([q.x, hgt + 1.2, q.z, -0.5 - rng() * 0.5, rng() * Math.PI * 2, 0, 1, 1, 1]);
      this._solid(q.x, hgt / 2, q.z, 0.6, hgt / 2, 0.6);
    }
    A.flush(g, M, 'antennae', { cast: true, recv: true });
    const dishGeo = new THREE.SphereGeometry(2.4, 18, 12, 0, Math.PI * 2, 0, 1.0);
    uvScale(dishGeo, 3, 3);
    g.add(instanced(dishGeo, M.trim, dishEntries));

    this._mmCircle(p.x, p.z, 13, 'rgba(90,130,170,0.6)', 'rgba(160,230,255,0.8)');
  }

  /* ---------------------------------------------------------------- */
  /* Cargo yard + maintenance (avenue 300)                             */
  /* ---------------------------------------------------------------- */

  _buildCargo() {
    const M = this.mat;
    const B = new GeoBatch();
    const g = new THREE.Group();
    g.name = 'cargo';
    this.group.add(g);
    const rng = mulberry32(0xca2607);

    const deg = 300;

    // Container stacks. Everything here is one instanced draw call.
    const containers = [];
    for (let row = 0; row < 7; row++) {
      for (let colI = 0; colI < 6; colI++) {
        const r = 92 + row * 15;
        const off = -42 + colI * 15;
        if (Math.abs(off) < ROAD_W / 2 + 6) continue;
        const stack = 1 + Math.floor(rng() * 3);
        for (let s = 0; s < stack; s++) {
          const p = roadPos(deg, r + (rng() - 0.5) * 2, off + (rng() - 0.5) * 2, 0, new THREE.Vector3());
          const yaw = -deg * DEG + (rng() - 0.5) * 0.14;
          containers.push([p.x, 1.5 + s * 3.0, p.z, 0, yaw, 0, 1, 1, 1]);
          if (s === 0) this._solidRot(p.x, (stack * 3) / 2, p.z, 3.2, (stack * 3) / 2, 6.2, yaw);
        }
      }
    }
    const contGeo = boxGeo(6.1, 2.9, 12.2, 3);
    g.add(instanced(contGeo, M.crate, containers, { cast: true, recv: true }));
    // Container end-caps in emissive so the stacks catch the eye at distance.
    const capEntries = containers
      .filter((_, i) => i % 3 === 0)
      .map((c) => [c[0], c[1] + 1.3, c[2], 0, c[4], 0, 1, 1, 1]);
    g.add(instanced(boxGeo(5.2, 0.12, 0.5, 1), M.emAmber, capEntries, { cast: false, recv: false }));

    // Straddle gantry crane spanning the yard.
    const gp = roadPos(deg, 132, 0, 0, new THREE.Vector3());
    const gYaw = -deg * DEG;
    const span = 46, legH = 22;
    for (const s of [-1, 1]) {
      for (const t of [-1, 1]) {
        B.localAt('hazard', boxGeo(1.4, legH, 1.4, 2), gp.x, 0, gp.z, gYaw, s * span / 2, legH / 2, t * 7);
        this._solidRot(gp.x + Math.cos(gYaw) * (s * span / 2) + Math.sin(gYaw) * (t * 7), legH / 2,
          gp.z - Math.sin(gYaw) * (s * span / 2) + Math.cos(gYaw) * (t * 7), 0.8, legH / 2, 0.8, gYaw);
      }
      B.localAt('trim', boxGeo(1.0, 1.0, 15, 2), gp.x, 0, gp.z, gYaw, s * span / 2, legH - 2, 0);
    }
    B.localAt('hazard', boxGeo(span + 6, 2.2, 3.0, 3), gp.x, 0, gp.z, gYaw, 0, legH + 1, 0);
    B.localAt('panelDark', boxGeo(span + 6, 0.8, 1.0, 2), gp.x, 0, gp.z, gYaw, 0, legH - 0.4, 3.0);
    B.localAt('grate', boxGeo(span + 6, 0.3, 1.6, 2), gp.x, 0, gp.z, gYaw, 0, legH + 2.3, 2.4);
    B.localAt('emAmber', boxGeo(span + 4, 0.14, 0.2, 1), gp.x, 0, gp.z, gYaw, 0, legH + 2.5, 3.2);
    B.localAt('panelDark', boxGeo(3.4, 3.0, 3.4, 2), gp.x, 0, gp.z, gYaw, -10, legH - 0.5, 0);
    B.localAt('glassWindow', new THREE.PlaneGeometry(3.0, 1.8), gp.x, 0, gp.z, gYaw, -10, legH - 0.3, -1.75, Math.PI);

    // Pipe farm and pressure vessels along the outer edge.
    for (let i = 0; i < 6; i++) {
      const q = roadPos(deg, 176, -50 + i * 20, 0, new THREE.Vector3());
      const tank = new THREE.CylinderGeometry(3.2, 3.2, 9, 18);
      uvScale(tank, 14, 3);
      B.at('panel', tank, q.x, 4.5, q.z);
      const domeTop = new THREE.SphereGeometry(3.2, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2);
      uvScale(domeTop, 14, 3);
      B.at('panel', domeTop, q.x, 9, q.z);
      B.at('hazard', new THREE.CylinderGeometry(3.4, 3.6, 1.4, 18), q.x, 0.7, q.z);
      B.at('emRed', boxGeo(1.4, 0.14, 0.2, 1), q.x, 6.5, q.z - 3.3);
      this._solid(q.x, 5, q.z, 3.4, 5, 3.4);
      if (i < 5) {
        const link = new THREE.CylinderGeometry(0.45, 0.45, 20, 8);
        link.rotateZ(Math.PI / 2);
        uvScale(link, 8, 3);
        B.at('copper', link, (q.x + roadPos(deg, 176, -50 + (i + 1) * 20, 0, _v2).x) / 2, 7.5,
          (q.z + roadPos(deg, 176, -50 + (i + 1) * 20, 0, _v2).z) / 2, -deg * DEG + Math.PI / 2);
      }
    }

    // Maintenance shed with an open roller door and a lit workshop inside.
    const sp = roadPos(deg, 100, -40, 0, new THREE.Vector3());
    const sYaw = faceRoadYaw(deg, -1);
    B.localAt('panel', boxGeo(24, 9, 0.6, 3), sp.x, 0, sp.z, sYaw, 0, 4.5, 9);
    B.localAt('panel', boxGeo(0.6, 9, 18, 3), sp.x, 0, sp.z, sYaw, -12, 4.5, 0);
    B.localAt('panel', boxGeo(0.6, 9, 18, 3), sp.x, 0, sp.z, sYaw, 12, 4.5, 0);
    B.localAt('panelDark', boxGeo(25, 0.9, 19, 3), sp.x, 0, sp.z, sYaw, 0, 9.4, 0);
    B.localAt('hazard', boxGeo(24, 2.4, 0.8, 2), sp.x, 0, sp.z, sYaw, 0, 7.8, -9);
    B.localAt('grate', boxGeo(23, 0.2, 17, 2), sp.x, 0, sp.z, sYaw, 0, 0.1, 0);
    B.localAt('emWhite', boxGeo(18, 0.3, 0.9, 1), sp.x, 0, sp.z, sYaw, 0, 8.4, 2);
    B.localAt('room', new THREE.PlaneGeometry(22, 6), sp.x, 0, sp.z, sYaw, 0, 4, 8.6, Math.PI);
    B.localAt('panelWarm', boxGeo(6, 1.0, 1.6, 1.5), sp.x, 0, sp.z, sYaw, -6, 0.7, 4);
    B.localAt('crate', boxGeo(2.2, 2.2, 2.2, 2), sp.x, 0, sp.z, sYaw, 7, 1.2, 5);
    this._solidRot(sp.x, 5, sp.z, 12.5, 5, 9.5, sYaw);
    this._mmRect(sp.x, sp.z, 25, 19, sYaw, 'rgba(110,100,90,0.6)', 'rgba(230,190,120,0.5)');

    B.flush(g, M, 'cargo', { cast: true, recv: true });

    const yardLight = new THREE.PointLight(0xffc98a, 2200, 80, 2);
    yardLight.position.set(gp.x, legH, gp.z);
    g.add(yardLight);

    this._mmRect(gp.x, gp.z, span + 6, 16, gYaw, 'rgba(180,140,60,0.35)', 'rgba(255,200,110,0.6)');
  }

  /* ---------------------------------------------------------------- */
  /* Authored enterable corridor rooms                                 */
  /* ---------------------------------------------------------------- */

  /**
   * True inside a building that collides itself completely.
   *
   * Cheap and called once per extracted triangle, so it is a plain loop over a
   * handful of rotated rectangles rather than anything indexed.
   */
  _insideSelfCollided(x, y, z) {
    const list = this._selfCollided;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (y > f.top) continue;
      const dx = x - f.x, dz = z - f.z;
      const c = Math.cos(f.yaw), s = Math.sin(f.yaw);
      if (Math.abs(dx * c - dz * s) > f.hw) continue;
      if (Math.abs(dx * s + dz * c) > f.hd) continue;
      return true;
    }
    return false;
  }

  _insideStationEnterableFootprint(x, z, pad = 0) {
    const rooms = this._enterableRoomFootprints;
    if (!Array.isArray(rooms) || !rooms.length) return false;
    for (const r of rooms) {
      const dx = x - r.x;
      const dz = z - r.z;
      const c = Math.cos(r.yaw);
      const s = Math.sin(r.yaw);
      const lx = dx * c - dz * s;
      const lz = dx * s + dz * c;
      if (Math.abs(lx) <= r.hw + pad && Math.abs(lz) <= r.hd + pad) return true;
    }
    return false;
  }

  _buildEnterableRooms() {
    if (!Array.isArray(this.enterables)) this.enterables = [];
    this._enterableRoomFootprints.length = 0;

    const M = this.mat;
    const B = new GeoBatch();
    const g = new THREE.Group();
    g.name = 'station-enterables';
    this.group.add(g);

    const specs = [
      { label: 'Retail Clinic', deg: 0, r: 66, side: -1, w: 6.2, d: 7.0, accent: 'emMagenta', fit: 'lab' },
      { label: 'Flight Lab', deg: 60, r: 68, side: -1, w: 6.6, d: 7.2, accent: 'emSodium', fit: 'lab' },
      { label: 'Hydroponics Prep', deg: 120, r: 62, side: -1, w: 6.0, d: 6.8, accent: 'emCyan', fit: 'console' },
      { label: 'Crew Quarters A', deg: 180, r: 58, side: 1, w: 5.8, d: 6.6, accent: 'emMagenta', fit: 'bunk' },
      { label: 'Traffic Spares', deg: 240, r: 70, side: -1, w: 6.4, d: 7.0, accent: 'emSodium', fit: 'storage' },
      { label: 'Cargo Lockers', deg: 300, r: 70, side: -1, w: 6.8, d: 7.4, accent: 'emCyan', fit: 'storage' },
    ];

    const wallT = 0.36;
    const H = 3.8;
    const doorHW = 0.95;
    const doorH = 2.55;
    const doorT = 0.16;

    const localPoint = (room, lx, ly, lz) => this._localPoint(room.x, room.z, room.yaw, lx, ly, lz);
    const solidLocal = (room, lx, cy, lz, hx, hy, hz, opts) => {
      const p = localPoint(room, lx, cy, lz);
      return this.track(this.physics.addRotatedBox(p, _v2.set(hx, hy, hz), room.yaw, opts));
    };
    const put = (room, key, geo, lx, ly, lz, ry = 0, rx = 0, rz = 0) => {
      B.localAt(key, geo, room.x, 0, room.z, room.yaw, lx, ly, lz, ry, rx, rz);
    };

    const buildDoor = (room, index) => {
      const doorZ = -room.d / 2 - 0.03;
      const hingeX = -doorHW + 0.02;
      const leafW = doorHW * 2 - 0.04;
      const leafH = doorH - 0.12;
      const pivot = new THREE.Group();
      pivot.position.copy(localPoint(room, hingeX, leafH / 2 + 0.08, doorZ));
      pivot.rotation.y = room.yaw;

      const leafGeo = boxGeo(leafW, leafH, doorT, 1.2);
      leafGeo.translate(leafW / 2, 0, 0);
      const leaf = new THREE.Mesh(leafGeo, M.panelDark);
      leaf.castShadow = leaf.receiveShadow = true;
      pivot.add(leaf);

      const bandGeo = boxGeo(leafW * 0.88, 0.12, doorT + 0.05, 1);
      bandGeo.translate(leafW / 2, 0, -0.01);
      for (const y of [-0.62, 0.62]) {
        const band = new THREE.Mesh(bandGeo.clone(), M[room.accent]);
        band.position.y = y;
        band.castShadow = false;
        band.receiveShadow = false;
        pivot.add(band);
      }
      g.add(pivot);

      const cp = localPoint(room, 0, doorH / 2, -room.d / 2);
      const collider = this.track(
        this.physics.addRotatedBox(cp, new THREE.Vector3(doorHW, doorH / 2, 0.13), room.yaw, { solid: true })
      );
      return {
        id: `station_room_${index}`,
        leaves: [{ pivot, closed: room.yaw, open: room.yaw - Math.PI * 0.55 }],
        collider,
        position: localPoint(room, 0, 1.2, -room.d / 2 - 0.22),
        open: false,
        anim: 0,
      };
    };

    specs.forEach((spec, index) => {
      const room = {
        ...spec,
        ...roadPos(spec.deg, spec.r, spec.side * (ROAD_W / 2 + 1.15 + spec.d / 2), 0, new THREE.Vector3()),
        yaw: faceRoadYaw(spec.deg, spec.side),
      };
      this._enterableRoomFootprints.push({ x: room.x, z: room.z, yaw: room.yaw, hw: room.w / 2 + 0.8, hd: room.d / 2 + 0.8 });

      // Hollow sci-fi pod: rear wall, side walls, split front wall, and lintel.
      put(room, 'panel', boxGeo(room.w, H, wallT, 2), 0, H / 2, room.d / 2 - wallT / 2);
      for (const sx of [-1, 1]) {
        put(room, 'panel', boxGeo(wallT, H, room.d, 2), sx * (room.w / 2 - wallT / 2), H / 2, 0);
      }
      const frontSeg = room.w / 2 - doorHW;
      for (const sx of [-1, 1]) {
        put(room, 'panelDark', boxGeo(frontSeg, H, wallT, 2), sx * (doorHW + frontSeg / 2), H / 2, -room.d / 2 + wallT / 2);
      }
      put(room, 'panelDark', boxGeo(doorHW * 2 + 0.5, H - doorH, wallT, 1.4), 0, doorH + (H - doorH) / 2, -room.d / 2 + wallT / 2);
      put(room, 'grate', boxGeo(room.w - 0.25, 0.14, room.d - 0.25, 1.4), 0, 0.07, 0);
      put(room, 'panelDark', boxGeo(room.w + 0.3, 0.22, room.d + 0.3, 2), 0, H - 0.11, 0);
      put(room, spec.accent, boxGeo(room.w - 1.2, 0.08, 0.16, 1), 0, 2.82, -room.d / 2 - 0.1);
      put(room, 'emWhite', boxGeo(room.w - 1.0, 0.10, 0.36, 1), 0, H - 0.45, 0.8);
      put(room, 'room', atlasUV(new THREE.PlaneGeometry(room.w - 1.1, H - 1.2), index % 4, (index >> 2) % 4, 4, 4), 0, 1.95, room.d / 2 - wallT - 0.02, Math.PI);

      // Colliders: separate walls with a real doorway gap, lintel, floor and ceiling.
      solidLocal(room, 0, H / 2, room.d / 2 - wallT / 2, room.w / 2, H / 2, wallT / 2 + 0.04);
      for (const sx of [-1, 1]) {
        solidLocal(room, sx * (room.w / 2 - wallT / 2), H / 2, 0, wallT / 2 + 0.04, H / 2, room.d / 2);
      }
      for (const sx of [-1, 1]) {
        solidLocal(room, sx * (doorHW + frontSeg / 2), H / 2, -room.d / 2 + wallT / 2, frontSeg / 2 + 0.04, H / 2, wallT / 2 + 0.04);
      }
      solidLocal(room, 0, doorH + (H - doorH) / 2, -room.d / 2 + wallT / 2, doorHW + 0.08, (H - doorH) / 2 + 0.03, wallT / 2 + 0.04);
      solidLocal(room, 0, 0.06, 0, room.w / 2 - 0.05, 0.06, room.d / 2 - 0.05);
      solidLocal(room, 0, H - 0.11, 0, room.w / 2, 0.12, room.d / 2);

      // Light furnishings; all solid where they can block the capsule.
      if (spec.fit === 'bunk') {
        put(room, 'panelWarm', boxGeo(1.35, 0.45, 2.55, 1), room.w / 2 - 1.05, 0.38, 0.9);
        put(room, 'shell', boxGeo(1.22, 0.18, 2.35, 1), room.w / 2 - 1.05, 0.73, 0.9);
        put(room, 'crate', boxGeo(1.0, 1.0, 1.0, 1), -room.w / 2 + 1.0, 0.55, room.d / 2 - 1.0);
        solidLocal(room, room.w / 2 - 1.05, 0.45, 0.9, 0.74, 0.45, 1.35);
      } else if (spec.fit === 'storage') {
        for (const [lx, lz, sy] of [[-1.8, 1.7, 1.0], [0.0, 1.8, 1.4], [1.7, 1.35, 0.8]]) {
          put(room, 'crate', boxGeo(1.2, sy, 1.2, 1), lx, sy / 2, lz);
          solidLocal(room, lx, sy / 2, lz, 0.62, sy / 2, 0.62);
        }
        put(room, 'hazard', boxGeo(room.w - 1.4, 0.08, 0.16, 1), 0, 0.18, -1.45);
      } else {
        put(room, 'panelWarm', boxGeo(2.2, 1.0, 0.8, 1), -room.w / 2 + 1.55, 0.62, 1.2);
        put(room, 'emCyan', boxGeo(1.8, 0.08, 0.18, 1), -room.w / 2 + 1.55, 1.2, 0.75);
        put(room, 'trim', boxGeo(1.2, 0.12, 1.2, 1), room.w / 2 - 1.25, 0.82, 0.6, 0.35);
        solidLocal(room, -room.w / 2 + 1.55, 0.62, 1.2, 1.15, 0.62, 0.45);
      }

      const door = buildDoor(room, index);
      const spot = localPoint(room, room.w * 0.22, 0.75, room.d * 0.18);
      this.enterables.push({
        label: spec.label,
        origin: new THREE.Vector3(room.x, 0, room.z),
        doors: [door],
        collectibleSpots: [{ position: spot, tier: 'common' }],
      });
      this._contact(room.x, room.z, Math.max(room.w, room.d) + 2);
      this._mmRect(room.x, room.z, room.w, room.d, room.yaw, 'rgba(70,110,140,0.55)', 'rgba(120,230,255,0.55)');
    });

    B.flush(g, M, 'station-enterables', { cast: true, recv: true, room: { cast: false, recv: false } });
  }

  /* ---------------------------------------------------------------- */
  /* Outer skyline - depth behind every district                       */
  /* ---------------------------------------------------------------- */

  _buildSkyline() {
    const M = this.mat;
    const B = new GeoBatch();
    const g = new THREE.Group();
    g.name = 'skyline';
    this.group.add(g);
    const rng = mulberry32(0x5c1);

    /* Twelve mid-rises between the avenues, plus backdrop mass behind the
     * portal daises so the gateways never silhouette against void.
     *
     * The gateway axes (+/-Z, i.e. bearings 90 and 270) are the two hero
     * sightlines of the world - the establishing shot is framed from 96 m out
     * on the +Z axis looking back at the plaza. Round 2 put a 26x22 block
     * centred on (0, 104): its footprint swallowed z = 93..115, so the wide
     * shot was taken from *inside* a building. That is what produced the
     * razor-straight full-width tonal seam at 58% frame height (the far edge of
     * the block's floor slab), the black band across the top (its ceiling) and
     * the "half the frame is featureless floor" read. Nothing may stand on
     * either gateway axis inside |x| < 26 between r = 60 and r = 128.
     */
    const specs = [];
    for (let i = 0; i < 12; i++) specs.push({ deg: 15 + i * 30, r: 158, w: 20, d: 18, floors: 6 + (i % 4) * 2 });
    // Inter-avenue backdrop, minus the two gateway bearings.
    for (const deg of [30, 150, 210, 330]) {
      specs.push({ deg, r: 104, w: 26, d: 22, floors: 5 + (deg % 3) });
    }
    // Gateway backdrop: a pair flanking each axis, plus a taller mass set well
    // behind it, so the portal still reads against architecture from the plaza
    // while the axis itself stays open all the way to the hull.
    for (const base of [90, 270]) {
      for (const off of [-25, 25]) {
        specs.push({ deg: base + off, r: 114, w: 26, d: 22, floors: 6 + (off > 0 ? 2 : 0) });
      }
      specs.push({ deg: base, r: 146, w: 42, d: 26, floors: 9 });
    }

    for (const s of specs) {
      // Keep clear of the window sector's promenade.
      const wrapped = ((s.deg + 180) % 360) - 180;
      if (Math.abs(wrapped) < 22 && s.r > 140) continue;
      const p = roadPos(s.deg, s.r, 0, 0, new THREE.Vector3());
      const yaw = -s.deg * DEG + Math.PI;
      this._block(B, {
        x: p.x, z: p.z, yaw, w: s.w, d: s.d, floors: s.floors, rng,
        body: rng() < 0.4 ? 'panelWarm' : 'panel',
        faces: [
          { lz: -s.d / 2 - 0.02, ry: Math.PI, span: s.w },
          { lz: s.d / 2 + 0.02, ry: 0, span: s.w },
        ],
      });
    }

    B.flush(g, M, 'skyline', { cast: true, recv: true });
  }

  /* ---------------------------------------------------------------- */
  /* Canopy: everything that hangs between the deck and the plate       */
  /* ---------------------------------------------------------------- */

  /**
   * The 24-52 m band of air over this station was completely empty, so every
   * frame split into "stuff on the floor" and "black plate", with a dead gap
   * between them - the "thin content band" in the review. Real transit halls
   * fill that volume: banner drops, festoon runs, hung ring lights. All of it
   * is one merged batch plus two instanced meshes, and none of it touches the
   * eye-line sightlines to the two gateways.
   */
  _buildCanopy() {
    const M = this.mat;
    const B = new GeoBatch();
    const g = new THREE.Group();
    g.name = 'canopy';
    this.group.add(g);
    const rng = mulberry32(0xba77e2);

    /* --- Banner drops ------------------------------------------------
     * Hung from the ceiling grid on paired cables. Deliberately narrow and
     * very tall: a vertical element is what a frame dominated by horizontals
     * (deck, walkway, light bridge, ceiling plate) is missing.
     */
    const banners = [];
    // Ring around the plaza, then a colonnade down both gateway corridors.
    for (let i = 0; i < 14; i++) {
      const th = (i / 14) * Math.PI * 2 + 0.22;
      const rr = 48 + (i % 3) * 15;
      // Never over a carriageway, never on a gateway axis.
      if (Math.abs(Math.cos(th) * rr) < 20 && Math.abs(Math.sin(th) * rr) > 40) continue;
      // A 12 m drop from a 56 m ceiling sits entirely above the top of frame
      // for any eye-level camera; these have to come down to ~24 m before they
      // are in shot at all, which is the whole point of hanging them.
      banners.push([Math.cos(th) * rr, Math.sin(th) * rr, -th, 27 + (i % 3) * 4]);
    }
    for (const sgn of [-1, 1]) {
      for (let i = 0; i < 4; i++) {
        const z = sgn * (66 + i * 15);
        for (const x of [-21, 21]) banners.push([x, z, sgn > 0 ? 0 : Math.PI, 29 + (i % 2) * 4]);
      }
    }

    const accents = ['emCyan', 'emAmber', 'emLandmark'];
    for (let i = 0; i < banners.length; i++) {
      const [bx, bz, byaw, drop] = banners[i];
      const top = CEIL_Y - 6;
      const w = 5.4;
      const midY = top - drop / 2;
      // Suspension: two cables and a batten, so the banner is hung, not floating.
      for (const s of [-1, 1]) {
        B.at('trimDark', cylGeo(0.055, 0.055, 5.4, 4, 2), bx + Math.cos(byaw) * s * (w / 2 - 0.4), top + 2.7, bz - Math.sin(byaw) * s * (w / 2 - 0.4));
      }
      B.at('trim', boxGeo(w + 0.7, 0.3, 0.5, 1.4), bx, top + 0.1, bz, byaw);
      // A panelDark body vanishes against a dark ceiling and leaves only the
      // emissive rails, which then read as bare neon rods. A mid-value textured
      // body keeps the banner reading as fabric hung on a frame.
      B.at('panelWarm', boxGeo(w, drop, 0.16, 2.6), bx, midY, bz, byaw);
      // Emissive edge rails - the part that actually reads at 100 m.
      const accent = accents[i % accents.length];
      for (const s of [-1, 1]) {
        B.at(accent, boxGeo(0.14, drop - 0.8, 0.28, 1),
          bx + Math.cos(byaw) * s * (w / 2 - 0.2), midY, bz - Math.sin(byaw) * s * (w / 2 - 0.2), byaw);
      }
      B.at('hazard', boxGeo(w + 0.1, 1.5, 0.2, 1.4), bx, top - drop * 0.62, bz, byaw);
      // Three banded blocks down the face give it internal rhythm.
      for (let k = 0; k < 3; k++) {
        B.at(k === 1 ? accent : 'trim', boxGeo(w - 1.0, 0.34, 0.22, 1),
          bx, top - drop * (0.22 + k * 0.26), bz, byaw);
      }
      B.at('trim', boxGeo(w + 0.4, 0.34, 0.42, 1.2), bx, top - drop, bz, byaw);
    }

    /* --- Festoon runs ------------------------------------------------
     * Catenaries from the oculus collar out to masts on the promenade loop.
     * Twelve sagging strings of bulbs put a readable, human-scale pattern
     * across the biggest empty volume in the world.
     */
    const beads = [];
    const cables = [];
    for (let i = 0; i < 12; i++) {
      const th = (i / 12) * Math.PI * 2 + 0.26;
      const c = Math.cos(th), s = Math.sin(th);
      const r0 = OCULUS_R + 4, y0 = CEIL_Y - 5;
      const r1 = LOOP_R - 2, y1 = LOOP_Y + 7.5;
      const SEG = 16;
      let px = c * r0, py = y0, pz = s * r0;
      for (let k = 1; k <= SEG; k++) {
        const t = k / SEG;
        const r = r0 + (r1 - r0) * t;
        // Catenary sag, strongest at mid-span.
        const y = y0 + (y1 - y0) * t - Math.sin(t * Math.PI) * 7.5;
        const nx = c * r, nz = s * r;
        const len = Math.hypot(nx - px, y - py, nz - pz);
        const mx = (nx + px) / 2, my = (y + py) / 2, mz = (nz + pz) / 2;
        const pitch = Math.atan2(y - py, Math.hypot(nx - px, nz - pz));
        cables.push([mx, my, mz, 0, -th, pitch - Math.PI / 2, 1, len, 1]);
        if (k % 2 === 0) beads.push([nx, y - 0.42, nz, 0, 0, 0, 1, 1, 1]);
        px = nx; py = y; pz = nz;
      }
    }
    g.add(instanced(new THREE.CylinderGeometry(0.045, 0.045, 1, 4), M.trimDark, cables, { cast: false, recv: false }));
    g.add(instanced(new THREE.SphereGeometry(0.30, 6, 5), M.emWhite, beads, { cast: false, recv: false }));

    /* --- Hung ring lights over the two gateway approaches ------------ */
    for (const sgn of [-1, 1]) {
      for (const [z, rr] of [[sgn * 62, 9], [sgn * 88, 7.5]]) {
        const y = 30 - Math.abs(z) * 0.06;
        for (const s of [-1, 1]) {
          B.at('trimDark', cylGeo(0.07, 0.07, CEIL_Y - 4 - y, 4, 2), s * rr * 0.8, (CEIL_Y - 4 + y) / 2, z);
        }
        const hoop = new THREE.TorusGeometry(rr, 0.42, 8, 40);
        hoop.rotateX(-Math.PI / 2);
        uvScale(hoop, 30, 1);
        B.at('trim', hoop, 0, y, z);
        const glow = new THREE.TorusGeometry(rr - 0.5, 0.2, 6, 40);
        glow.rotateX(-Math.PI / 2);
        B.at('emWhite', glow, 0, y - 0.35, z);
      }
    }

    /* --- Airborne traffic: service drones on slow orbits -------------
     * Motion in the upper volume, and a size cue that reads the hall as huge.
     */
    const droneParts = [
      boxGeo(1.5, 0.5, 0.9, 1.4),
      (() => { const q = boxGeo(0.35, 0.22, 2.3, 1); q.translate(0, 0.24, 0); return q; })(),
    ];
    const droneGeo = mergeGeometries(droneParts, false);
    for (const p of droneParts) p.dispose();
    const drones = [];
    this._anim.drones = [];
    for (let i = 0; i < 10; i++) {
      const rr = 52 + rng() * 96;
      const y = 22 + rng() * 26;
      const ph = rng() * Math.PI * 2;
      drones.push([Math.cos(ph) * rr, y, Math.sin(ph) * rr, 0, -ph, 0, 1, 1, 1]);
      this._anim.drones.push({ r: rr, y, phase: ph, speed: (rng() < 0.5 ? -1 : 1) * (0.02 + rng() * 0.03) });
    }
    const droneMesh = instanced(droneGeo, M.panel, drones, { cast: false, recv: false });
    g.add(droneMesh);
    this._anim.droneMesh = droneMesh.isInstancedMesh ? droneMesh : null;
    const droneLights = instanced(new THREE.SphereGeometry(0.16, 6, 5), M.emRed,
      drones.map((d) => [d[0], d[1] - 0.34, d[2], 0, 0, 0, 1, 1, 1]), { cast: false, recv: false });
    g.add(droneLights);
    this._anim.droneLights = droneLights.isInstancedMesh ? droneLights : null;

    B.flush(g, M, 'canopy', { cast: false, recv: true });
  }

  /* ---------------------------------------------------------------- */
  /* Inhabitation and silhouette hierarchy                             */
  /* ---------------------------------------------------------------- */

  /**
   * One low-poly biped body, merged into a single geometry so a whole crowd
   * variant is one InstancedMesh and one draw call.
   *
   * @param {number} variant 0 plain, 1 backpack, 2 hood + satchel
   *
   * Round 2 shipped three wide shots of a transit hub - clinic, bar, arrivals
   * dock - containing exactly one visible human, roughly eight pixels tall. The
   * space read as evacuated, and worse, it read as *scaleless*: without figures
   * a 400 m ring and a 40 m room are the same image. The fifteen patrolling
   * NPCs are a gameplay roster, not a crowd; this is the crowd.
   *
   * @returns {THREE.BufferGeometry} a 1.75 m figure standing on y = 0
   */
  _crowdBodyGeo(variant) {
    const parts = [];
    /**
     * @param {THREE.BufferGeometry} geo
     * @param {number} shade baked garment value - dark trousers, mid jacket,
     *   dark shoes. This multiplies the per-instance colour, so one draw call
     *   still yields a figure with internal value structure instead of a
     *   single-value pill.
     */
    const put = (geo, x, y, z, shade, rz = 0, rx = 0, uv = 4) => {
      uvScale(geo, uv, uv);
      _euler.set(rx, 0, rz, 'YXZ');
      _quat.setFromEuler(_euler);
      _mat4.compose(_v1.set(x, y, z), _quat, _scl.set(1, 1, 1));
      geo.applyMatrix4(_mat4);
      const n = geo.getAttribute('position').count;
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        col[i * 3] = shade; col[i * 3 + 1] = shade; col[i * 3 + 2] = shade;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      parts.push(geo);
    };
    // Torso: a tapered capsule reads as a coat at 40 m; a box reads as a crate.
    put(new THREE.CapsuleGeometry(0.20, 0.44, 3, 10), 0, 1.20, 0, 1.0);
    put(new THREE.CylinderGeometry(0.215, 0.185, 0.30, 10), 0, 0.95, 0, 0.86);

    /* Shoulders and stance.
     *
     * The arms were 0.235 off centre and the legs 0.098 apart: at 20-40 m the
     * negative space between the limbs closes and the whole figure merges into
     * one mass, which is the geometric reason these read as capsules. Wider
     * shoulders and a genuinely split, asymmetric stance keep gaps of light
     * through the silhouette at plaza distance - that is what the eye actually
     * uses to identify a person.
     */
    for (const s of [-1, 1]) {
      put(new THREE.CapsuleGeometry(0.062, 0.46, 2, 6), s * 0.30, 1.16, 0.01, 0.94, s * 0.14);
      // Fore/aft offset as well as lateral: a stance, not a pair of pillars.
      const fore = s > 0 ? 0.09 : -0.07;
      put(new THREE.CapsuleGeometry(0.085, 0.52, 2, 6), s * 0.16, 0.50, fore, 0.58, s * 0.06);
      put(new THREE.BoxGeometry(0.12, 0.07, 0.26), s * 0.16, 0.04, fore + 0.04, 0.34);
    }
    // Shoulder yoke: closes the gap the wider arms open at the top.
    put(new THREE.CapsuleGeometry(0.09, 0.30, 2, 8), 0, 1.40, 0, 1.0, Math.PI / 2);

    /* Silhouette-breaking accessories.
     *
     * A third of a real crowd is carrying something, and a bag or a hood is the
     * cheapest way to stop a hundred instances of one mesh reading as a hundred
     * copies of one mesh.
     */
    if (variant === 1) {
      // Backpack.
      put(new THREE.BoxGeometry(0.30, 0.42, 0.20), 0, 1.24, -0.24, 0.68);
      put(new THREE.BoxGeometry(0.26, 0.10, 0.06), 0, 1.06, -0.36, 0.5);
      for (const s of [-1, 1]) put(new THREE.BoxGeometry(0.05, 0.30, 0.05), s * 0.13, 1.30, -0.11, 0.5);
    } else if (variant === 2) {
      // Hood down over the shoulders, plus a satchel slung on one hip.
      put(new THREE.SphereGeometry(0.15, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.62), 0, 1.46, -0.05, 0.9);
      put(new THREE.BoxGeometry(0.28, 0.22, 0.11), 0.24, 0.94, 0.06, 0.62, 0, 0, 3);
      put(new THREE.BoxGeometry(0.05, 0.52, 0.04), 0.08, 1.22, -0.02, 0.5, -0.42);
    }

    const merged = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    return merged;
  }

  /**
   * Seated pose, authored around a 0.66 m bench seat.
   *
   * A dozen figures all standing in the identical T-form is the read that made
   * the crowd look like a placed asset rather than a population - identical
   * silhouettes at identical spacing. One genuinely different pose, snapped
   * onto furniture that already exists in the plaza, does more for that than
   * another fifty standing instances would.
   *
   * The figure faces -Z at yaw 0, matching the standing variants.
   *
   * @returns {THREE.BufferGeometry}
   */
  _crowdSeatedGeo() {
    const parts = [];
    const put = (geo, x, y, z, shade, rz = 0, rx = 0, uv = 4) => {
      uvScale(geo, uv, uv);
      _euler.set(rx, 0, rz, 'YXZ');
      _quat.setFromEuler(_euler);
      _mat4.compose(_v1.set(x, y, z), _quat, _scl.set(1, 1, 1));
      geo.applyMatrix4(_mat4);
      const n = geo.getAttribute('position').count;
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        col[i * 3] = shade; col[i * 3 + 1] = shade; col[i * 3 + 2] = shade;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      parts.push(geo);
    };
    // Torso leaning very slightly back, hips on the seat.
    put(new THREE.CapsuleGeometry(0.20, 0.38, 3, 10), 0, 1.06, 0.02, 1.0, 0, -0.10);
    put(new THREE.CylinderGeometry(0.215, 0.20, 0.26, 10), 0, 0.79, 0, 0.86);
    put(new THREE.CapsuleGeometry(0.09, 0.30, 2, 8), 0, 1.26, 0.01, 1.0, Math.PI / 2);
    for (const s of [-1, 1]) {
      // Thigh forward (-Z), calf down, foot planted.
      put(new THREE.CapsuleGeometry(0.085, 0.34, 2, 6), s * 0.14, 0.72, -0.24, 0.58, 0, Math.PI / 2);
      put(new THREE.CapsuleGeometry(0.075, 0.34, 2, 6), s * 0.14, 0.36, -0.44, 0.58, 0, 0.12);
      put(new THREE.BoxGeometry(0.12, 0.07, 0.26), s * 0.14, 0.04, -0.50, 0.34);
      // Forearm resting on the thigh: the pose reads even in silhouette.
      put(new THREE.CapsuleGeometry(0.06, 0.30, 2, 6), s * 0.26, 1.00, -0.06, 0.94, s * 0.10, 0.55);
    }
    const merged = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    return merged;
  }

  /**
   * Head and neck, split out so skin can be its own material and its own tint
   * pool. Sharing the garment material meant a navy jacket produced a navy
   * face, which is a large part of why the figures read as plastic.
   *
   * @returns {THREE.BufferGeometry}
   */
  _crowdHeadGeo(dy = 0, dz = 0) {
    const parts = [];
    const neck = new THREE.CylinderGeometry(0.055, 0.07, 0.10, 8);
    neck.translate(0, 1.535 + dy, dz);
    parts.push(neck);
    const head = new THREE.SphereGeometry(0.105, 12, 10);
    head.scale(0.94, 1.12, 1.0);
    head.translate(0, 1.66 + dy, dz);
    parts.push(head);
    // A brow/jaw break so the head is not a perfect ball at close range.
    const jaw = new THREE.BoxGeometry(0.13, 0.07, 0.11);
    jaw.translate(0, 1.60 + dy, 0.03 + dz);
    parts.push(jaw);
    for (const p of parts) uvScale(p, 2, 2);
    const merged = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    return merged;
  }

  /**
   * Distribute the ambient crowd along the routes a real transit hub funnels
   * people down: the plaza dais ring, the two gateway queues, the commercial
   * strip pavements and the elevated promenade loop. Three depth bands so every
   * hero angle has a figure near, mid and far.
   */
  _buildCrowd(parent) {
    const rng = mulberry32(0xc0d3d);
    const entries = [];
    const colors = [];
    const skins = [];
    const variants = [];
    /* Garment palette.
     *
     * Every entry is pulled a quarter of the way to 0x2a2f36 and clamped under
     * 0.35 saturation. The saturated 0x7a3a3a in the old pool was landing as
     * the single highest-chroma object in the plaza frame - on a background
     * extra, twenty metres behind the actual subject. High chroma is a
     * storytelling resource and it belongs to the portals, the hazard language
     * and the hero NPCs, not to the crowd.
     */
    const palette = [
      0x2c3743, 0x3a332e, 0x554438, 0x2f4441, 0x4b4d53,
      0x5a3f3f, 0x36404f, 0x504b41, 0x28313a, 0x554e59,
      0x3f4a52, 0x463d38,
    ];
    // Skin tones stay inside a narrow, unsaturated range; the map and the
    // lighting do the rest.
    const skinTones = [0xd8b394, 0xbe9070, 0x8d6448, 0x6b4630, 0xe6c6a8, 0xa07a5c];
    const push = (x, z, y = 0, scale = 1, yaw = null, variant = null) => {
      /* Deck test, before anything is committed.
       *
       * Every one of the four parallel arrays below is indexed together, so
       * the reject has to happen here rather than at instancing time. The
       * routes are hand-authored and currently top out at r=190, well inside
       * the r=200 deck, but the near-band loop above places off a random
       * bearing and a random distance from the spawn and the cluster helper
       * jitters on top of that - the pattern that puts a figure on nothing in
       * every other world in this project. A body standing past the deck rim
       * is standing in vacuum.
       */
      if (Math.hypot(x, z) > DECK_R - 4) return;

      /* Keep the crowd off the gateway plinths.
       *
       * `PortalSystem` builds the arch, the disc and the plinth at *activation*,
       * after this world has finished generating, so the support probe below
       * cannot see the top half-metre of dais and drops anyone standing there
       * onto the landing underneath it. Rejecting the plinth footprint is both
       * the fix and the better staging: a queue that stops at the foot of the
       * steps reads as a queue, where civilians milling about on the threshold
       * of an interdimensional gate does not. */
      for (const [px, pz] of [[0, -PORTAL_R], [0, PORTAL_R], [-PORTAL_R, 0], [PORTAL_R, 0]]) {
        if (Math.hypot(x - px, z - pz) < 5.5) return;
      }

      /* Stand on whatever is actually there, not on the level the caller
       * assumed.
       *
       * `y` was taken literally, which is fine on open deck and wrong the
       * moment anything is built on it. The queues that walk toward the
       * gateways are authored at deck level and run straight into the approach
       * steps, so every figure inside the flight stood buried to the knee in a
       * tread. Probing from just above the requested height and dropping a few
       * metres puts them on the step, the deck or the promenade as appropriate,
       * and keeps working whatever gets built there next.
       *
       * The origin has to clear the *highest* thing a figure might be standing
       * on - the gateway deck at 2.87 m, not just the 2.4 m top tread - because
       * a ray that starts below the surface it is looking for skips straight
       * past it onto whatever is underneath, which is how a queue ends up
       * standing half a metre inside the dais it is queueing on.
       *
       * 4 m clears every deck-level structure and still stops well short of the
       * promenade at LOOP_Y = 10, so a figure authored up there lands on the
       * promenade rather than falling to the plaza. */
      const support = this.physics.groundHeight(x, z, y + 4.0, 12.0);
      let baseY = support === null ? y : support;

      /* Reject a support the figure is standing *under* rather than *on*.
       *
       * The probe has to start 4 m up so it can see the gateway treads, and
       * from up there it cannot tell a step from a roof - it returns the first
       * solid thing below it either way. Over the plaza kiosks that is the
       * stall at 2.40 m, so two figures out of the cluster authored at
       * (-22, -6.5) were snapped onto the counter and left standing waist-deep
       * through the canopy, with head and shoulders above the roofline.
       *
       * Height alone cannot separate the two cases, which is what makes this
       * worth spelling out: the tallest legitimate tread is 2.4 m and the
       * kiosk collider is 2.40 m. What separates them is *where*. Ground only
       * rises like that on a gateway approach, so a lift of more than one step
       * is honoured there and nowhere else; anywhere else the figure re-probes
       * from just above its authored level and stands on the floor it was
       * actually placed onto - the deck under the canopy, here.
       *
       * Deliberately not solved by moving the cluster. The jitter that put
       * these two under a canopy will put the next ones under whatever is
       * built next, and a crowd that quietly climbs onto scenery is the bug.
       */
      const STEP_UP = 0.35;
      const APPROACH_R = 26;
      if (baseY - y > STEP_UP) {
        const onApproach = [[0, -PORTAL_R], [0, PORTAL_R], [-PORTAL_R, 0], [PORTAL_R, 0]]
          .some(([px, pz]) => Math.hypot(x - px, z - pz) < APPROACH_R);
        if (!onApproach) {
          const floor = this.physics.groundHeight(x, z, y + STEP_UP, 12.0);
          baseY = floor === null ? y : floor;
        }
      }

      const s = scale * (0.93 + rng() * 0.15);
      entries.push([x, baseY, z, 0, yaw === null ? rng() * Math.PI * 2 : yaw, 0, s, s, s]);
      colors.push(new THREE.Color(palette[Math.floor(rng() * palette.length)]));
      skins.push(new THREE.Color(skinTones[Math.floor(rng() * skinTones.length)]));
      // Roughly a third carry a pack, a hood or a satchel.
      const v = rng();
      variants.push(variant === null ? (v < 0.68 ? 0 : v < 0.85 ? 1 : 2) : variant);
      /* Every ground-level figure gets a contact patch, unconditionally and at
       * a radius that actually reads. Two thirds of the crowd used to float
       * because this only fired on every third instance, and a figure whose
       * feet meet the deck on a clean bright line is the fastest way to make a
       * whole frame read as composited rather than photographed. */
      if (baseY < 0.5) this._contact(x, z, 1.8);
    };

    /* Grouped placement.
     *
     * A crowd of evenly-spaced singletons at a uniform yaw is a particle
     * system, not a population. Real transit halls resolve into knots of two
     * and three people standing 1.1-1.5 m apart facing each other, with gaps
     * between the knots. `cluster` emits one of those; the callers below spend
     * roughly a third of the roster through it.
     */
    const cluster = (x, z, y = 0) => {
      const n = rng() < 0.55 ? 2 : 3;
      const base = rng() * Math.PI * 2;
      const rad = 0.62 + rng() * 0.32;
      for (let i = 0; i < n; i++) {
        const a = base + (i / n) * Math.PI * 2 + (rng() - 0.5) * 0.4;
        const px = x + Math.cos(a) * rad, pz = z + Math.sin(a) * rad;
        // Face the knot's centre: yaw such that forward = -(radial direction).
        push(px, pz, y, 1, Math.atan2(Math.cos(a), Math.sin(a)));
      }
    };

    /* --- Near band ----------------------------------------------------
     * Nobody was inside fifteen metres of the camera in either hero frame, so
     * the crowd read as distant scenery and did nothing for scale. These are
     * placed against the spawn's own framing: 5-16 m out, spread across the
     * width of the shot, deliberately including two knots close enough to
     * occlude deck in the lower third.
     */
    for (let i = 0; i < 9; i++) {
      const a = SPAWN_YAW + Math.PI / 2 + (rng() - 0.5) * 1.7;   // ahead of camera
      const d = 5.5 + rng() * 10.5;
      const px = SPAWN_X + Math.cos(a) * d, pz = SPAWN_Z + Math.sin(a) * d;
      if (Math.hypot(px, pz) < 11) continue;
      push(px, pz);
    }
    for (const [cx, cz] of [[-22, -6.5], [-20.5, 7.5], [-14, 1.5]]) cluster(cx, cz);

    // Ring around the monument dais - the mid band in any plaza framing.
    for (let i = 0; i < 22; i++) {
      const th = rng() * Math.PI * 2;
      const rr = 13 + rng() * 12;
      push(Math.cos(th) * rr, Math.sin(th) * rr);
    }
    for (let i = 0; i < 6; i++) {
      const th = rng() * Math.PI * 2;
      const rr = 14 + rng() * 11;
      cluster(Math.cos(th) * rr, Math.sin(th) * rr);
    }

    /* Seated figures, snapped onto the plaza bench transforms.
     *
     * The benches photographed empty next to a standing crowd, which reads as
     * staging rather than as life. Mirrors the placement loop in
     * `_buildPlazaCentre` exactly - 14 benches, seat axis along the radial
     * tangent - so a seated figure lands on the slats rather than near them.
     */
    for (let i = 0; i < 14; i++) {
      if (rng() < 0.35) continue;
      const th = (i / 14) * Math.PI * 2 + 0.3;
      const rr = 27 + (i % 3) * 3;
      const bx = Math.cos(th) * rr, bz = Math.sin(th) * rr;
      const ux = Math.cos(th), uz = Math.sin(th);
      const seats = rng() < 0.45 ? [-0.72, 0.66] : [(rng() - 0.5) * 1.4];
      for (const off of seats) {
        push(bx + ux * off, bz + uz * off, 0, 1, Math.PI - th, 3);
      }
    }
    // Queues on both gateway approaches, loosely lined up on the axis.
    for (const sgn of [-1, 1]) {
      for (let i = 0; i < 18; i++) {
        const lane = (i % 3) - 1;
        push(lane * 3.4 + (rng() - 0.5) * 1.6, sgn * (30 + i * 1.9 + rng() * 1.4));
      }
    }
    // Commercial strip pavements, both sides of the +X avenue.
    for (let i = 0; i < 30; i++) {
      const r = 80 + rng() * 92;
      const side = rng() < 0.5 ? -1 : 1;
      push(r, side * (ROAD_W / 2 + 1.4 + rng() * 3.2));
    }
    // The other five avenues get a thinner scatter so no bearing reads empty.
    for (const deg of [60, 120, 180, 240, 300]) {
      for (let i = 0; i < 8; i++) {
        const r = PLAZA_R + 10 + rng() * 110;
        const off = (rng() < 0.5 ? -1 : 1) * (ROAD_W / 2 + 1.2 + rng() * 3.4);
        const p = roadPos(deg, r, off, 0, new THREE.Vector3());
        push(p.x, p.z);
      }
    }
    // Elevated promenade: figures on the loop are what tells a player the
    // walkway is walkable, and they put human scale at height.
    for (let i = 0; i < 26; i++) {
      const th = rng() * Math.PI * 2;
      const rr = LOOP_R + (rng() - 0.5) * 3.4;
      push(Math.cos(th) * rr, Math.sin(th) * rr, LOOP_Y);
    }

    /* Four body variants plus two head meshes: six draw calls for the whole
     * crowd. The animator drives all of them from a single set of base
     * transforms via each mesh's index map, so a figure's head never separates
     * from its body. The seated variant needs its own head mesh purely because
     * the skull sits 0.38 m lower and 0.06 m forward of a standing one. */
    const groups = [[], [], [], []];
    for (let i = 0; i < entries.length; i++) groups[variants[i]].push(i);

    /** @type {Array<{mesh:THREE.InstancedMesh, idx:Int32Array}>} */
    const meshes = [];
    for (let v = 0; v < 4; v++) {
      if (!groups[v].length) continue;
      const idx = Int32Array.from(groups[v]);
      const sub = groups[v].map((i) => entries[i]);
      const geo = v === 3 ? this._crowdSeatedGeo() : this._crowdBodyGeo(v);
      const m = instanced(geo, this.mat.crowd, sub, { cast: true, recv: true });
      if (!m.isInstancedMesh) continue;
      for (let j = 0; j < idx.length; j++) m.setColorAt(j, colors[idx[j]]);
      m.instanceColor.needsUpdate = true;
      parent.add(m);
      meshes.push({ mesh: m, idx });
    }
    const standing = [];
    for (let i = 0; i < entries.length; i++) if (variants[i] !== 3) standing.push(i);
    for (const [list, geo] of [
      [standing, this._crowdHeadGeo()],
      [groups[3], this._crowdHeadGeo(-0.38, 0.02)],
    ]) {
      if (!list.length) { geo.dispose(); continue; }
      const idx = Int32Array.from(list);
      const headMesh = instanced(geo, this.mat.skin, list.map((i) => entries[i]), { cast: true, recv: true });
      if (!headMesh.isInstancedMesh) continue;
      for (let j = 0; j < idx.length; j++) headMesh.setColorAt(j, skins[idx[j]]);
      headMesh.instanceColor.needsUpdate = true;
      parent.add(headMesh);
      meshes.push({ mesh: headMesh, idx });
    }

    if (meshes.length) {
      this._anim.crowdMeshes = meshes;
      this._anim.crowdPhase = new Float32Array(entries.length);
      this._anim.crowdBase = new Float32Array(entries.length * 4);
      for (let i = 0; i < entries.length; i++) {
        this._anim.crowdPhase[i] = rng() * 6.28;
        this._anim.crowdBase[i * 4] = entries[i][0];
        this._anim.crowdBase[i * 4 + 1] = entries[i][1];
        this._anim.crowdBase[i * 4 + 2] = entries[i][2];
        this._anim.crowdBase[i * 4 + 3] = entries[i][6];
      }
      this._anim.crowdYaw = new Float32Array(entries.map((e) => e[4]));
      // Seated figures are anchored to furniture: the idle sway that reads as
      // life on a standing figure reads as sliding on a bench.
      this._anim.crowdSeated = Uint8Array.from(variants.map((v) => (v === 3 ? 1 : 0)));
    }
  }

  /**
   * Hero silhouette masses.
   *
   * The round-2 mid-ground was a uniform field of similarly sized rectangular
   * slabs at one value - no size cascade, so the eye had nothing to rest on. A
   * few elements at 2-3x the height of everything around them fix that faster
   * than any amount of extra small detail: a gantry crane straddling the deck,
   * a cargo pod hanging on cables over the plaza approach, and a lattice
   * antenna mast, each placed on a plaza sightline so they read against the
   * ceiling rather than against other buildings.
   */
  _buildLandmarkMasses(B) {
    /* --- Gantry crane straddling the spawn sightline -----------------
     * The player spawns at (-34, 2) facing +X, straight down the plaza axis and
     * out along the commercial avenue. The 44 m of open deck between the plaza
     * kerb and the first shopfront was the emptiest band in the hero frame; a
     * 30 m crane straddling it puts a dominant mass against the ceiling exactly
     * where the eye was finding nothing to rest on, and it frames the avenue
     * rather than blocking it.
     */
    const cxp = 66, czp = 0;
    const CH = 30, SPAN = 46;
    for (const s of [-1, 1]) {
      const lx = cxp, lz = czp + s * (SPAN / 2);
      B.at('panelDark', boxGeo(3.0, CH, 3.0, 3), lx, CH / 2, lz);
      B.at('hazard', boxGeo(4.2, 2.2, 4.2, 1.8), lx, 1.1, lz);
      B.at('trim', boxGeo(1.0, CH - 6, 1.0, 2), lx + 2.4, CH / 2, lz, 0, 0, 0.06);
      B.at('emAmber', boxGeo(0.24, CH - 8, 0.24, 1), lx - 1.7, CH / 2, lz);
      this._solid(lx, CH / 2, lz, 1.6, CH / 2, 1.6);
      this._contact(lx, lz, 12);
    }
    B.at('panelDark', boxGeo(4.4, 3.4, SPAN + 6, 3), cxp, CH + 1.6, czp);
    B.at('trim', boxGeo(5.2, 0.5, SPAN + 7, 2), cxp, CH + 3.5, czp);
    for (let i = 0; i < 9; i++) {
      const z = czp - SPAN / 2 + (SPAN / 8) * i;
      B.at('trim', boxGeo(0.4, 3.0, 0.4, 1), cxp, CH + 1.6, z, 0, 0, 0.5);
      if (i % 2 === 0) B.at('emWhite', boxGeo(0.5, 0.16, 1.2, 1), cxp, CH - 0.3, z);
    }
    // Trolley + hook: the detail that gives the crane a purpose.
    B.at('panelDark', boxGeo(3.4, 1.8, 4.4, 2), cxp, CH - 0.8, czp + 8);
    B.at('trimDark', cylGeo(0.09, 0.09, 12, 4, 2.0), cxp, CH - 7.5, czp + 8);
    B.at('trim', boxGeo(2.0, 1.0, 2.0, 1.4), cxp, CH - 14, czp + 8);
    B.at('crate', boxGeo(5.4, 2.6, 2.4, 2.2), cxp, CH - 16.2, czp + 8, 0.08);

    /* --- Cargo pod suspended over the +Z gateway approach ------------ */
    const px = 44, pz = 96, py = 26;
    B.at('hull', cylGeo(3.2, 3.2, 12, 18, 2.6), px, py, pz, 0, 0, Math.PI / 2);
    B.at('panelDark', cylGeo(3.5, 3.5, 1.2, 18, 1.8), px - 5.2, py, pz, 0, 0, Math.PI / 2);
    B.at('panelDark', cylGeo(3.5, 3.5, 1.2, 18, 1.8), px + 5.2, py, pz, 0, 0, Math.PI / 2);
    B.at('hazard', boxGeo(12.4, 0.5, 1.4, 1.6), px, py - 3.0, pz);
    B.at('emRed', boxGeo(0.6, 0.22, 0.6, 1), px, py - 3.4, pz);
    for (const s of [-1, 1]) {
      B.at('trimDark', cylGeo(0.08, 0.08, CEIL_Y - py - 4, 4, 2.0), px + s * 4.4, (CEIL_Y - 4 + py) / 2, pz, 0, 0, s * 0.055);
      B.at('trim', boxGeo(1.4, 0.9, 1.4, 1.2), px + s * 4.4, py + 3.4, pz);
    }
    B.at('panelDark', boxGeo(14, 1.4, 3.4, 2.4), px, CEIL_Y - 4.2, pz);

    /* --- Lattice antenna mast on the -Z bearing ----------------------
     * 57 m to the tip, in a deliberately empty pocket between the control tower
     * and the -Z skyline block, so it reads as the tallest thing on that
     * bearing instead of competing with a district.
     */
    const ax = -30, az = -118;
    B.at('panelDark', cylGeo(3.4, 4.2, 4, 12, 2.0), ax, 2, az);
    this._solid(ax, 2, az, 3.8, 2, 3.8);
    this._contact(ax, az, 14);
    for (let i = 0; i < 10; i++) {
      const y0 = 4 + i * 4.4;
      const r0 = 3.0 - i * 0.24;
      for (let k = 0; k < 3; k++) {
        const th = (k / 3) * Math.PI * 2;
        B.at('trim', cylGeo(0.17, 0.17, 4.6, 5, 1.6), ax + Math.cos(th) * r0, y0 + 2.2, az + Math.sin(th) * r0, 0, 0, 0.05);
        // Cross bracing: what makes a lattice read as a lattice.
        B.at('trim', boxGeo(r0 * 1.75, 0.13, 0.13, 1), ax + Math.cos(th + 1.05) * r0 * 0.5, y0 + 2.2, az + Math.sin(th + 1.05) * r0 * 0.5, -th, 0, 0.62);
      }
      const hoop = new THREE.TorusGeometry(r0, 0.11, 4, 14);
      hoop.rotateX(-Math.PI / 2);
      B.at(i % 3 === 0 ? 'emRed' : 'trim', hoop, ax, y0 + 4.4, az);
    }
    B.at('trim', cylGeo(0.14, 0.22, 9, 6, 2.0), ax, 52, az);
    B.at('emRed', new THREE.SphereGeometry(0.55, 8, 6), ax, 56.8, az);
    // Dishes hung off the mast at two heights - the size cascade in miniature.
    for (const [dy, dr, dth] of [[18, 2.6, 0.4], [31, 1.9, 3.4]]) {
      const dish = new THREE.SphereGeometry(dr, 16, 10, 0, Math.PI * 2, 0, 0.95);
      B.at('panel', dish, ax + Math.cos(dth) * 3.6, dy, az + Math.sin(dth) * 3.6, -dth, -0.9);
      B.at('trim', boxGeo(2.6, 0.22, 0.22, 1), ax + Math.cos(dth) * 2.0, dy, az + Math.sin(dth) * 2.0, -dth);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Set dressing: lamps, light shafts, props, steam, holo advertising */
  /* ---------------------------------------------------------------- */

  /**
   * The 0-26 m camera band.
   *
   * Three independent reviews landed on the same sentence: the bottom third of
   * every frame is undifferentiated deck plate with no props, no clutter, no
   * decals and no cast shadow inside twelve metres of the camera, and that is
   * the single strongest "this is a level, not a shot" tell in the set. The
   * existing near-camera pass placed twenty-six items across four thousand
   * square metres - about one silhouette every thirteen metres, which is not a
   * dressing pass, it is a scatter.
   *
   * This one works to a rule instead of a count: no 6 m square of deck inside
   * the plaza may be empty of both a prop and a decal, and every hero anchor
   * (the spawn, the plaza centre, both gateway approaches) gets deliberate
   * near-field silhouette breakers placed to occlude the bottom corners of the
   * frame rather than scattered randomly around it.
   *
   * Everything merges into the caller's batch, so the whole pass is a handful
   * of draw calls.
   *
   * @param {GeoBatch} B           the dressing batch
   * @param {THREE.Group} g        the dressing group (owns the extra decal mesh)
   */
  _buildNearField(B, g) {
    const rng = mulberry32(0x4e4a11);
    const decals = [];

    /* --- Placement legality ------------------------------------------
     * Keep the monument, both daises, the two gateway sightlines and the six
     * painted routes clear. A prop standing on a wayfinding line does more
     * damage than an empty plate does.
     */
    const legal = (x, z, clearance = 1.6) => {
      const r = Math.hypot(x, z);
      if (r < 12 || r > 44) return false;
      // Gateway approach corridors stay open by design.
      if (Math.abs(x) < 9 + clearance && Math.abs(z) > 12) return false;
      for (const s of [-1, 1]) if (Math.hypot(x, z - s * PORTAL_R) < 16 + clearance) return false;
      for (const deg of this.roadAngles) {
        const t = deg * DEG;
        // Perpendicular distance from the route centreline, outbound half only.
        const along = x * Math.cos(t) + z * Math.sin(t);
        if (along < 0) continue;
        const across = Math.abs(-x * Math.sin(t) + z * Math.cos(t));
        if (across < 3.4 + clearance) return false;
      }
      return true;
    };

    /* --- The prop kit -------------------------------------------------
     * Every entry is authored at 0.6-2.4 m, i.e. inside the band a 1.7 m eye
     * actually reads as "near", and every one of them is a different
     * manufacturing story: bare steel spools, painted composite lockers,
     * rubber hose, galvanised grating, hazard-striped barriers.
     */
    const spool = (x, z, yaw, s) => {
      // Flanges are offset along the spool's own axis, not stacked.
      const ax = Math.cos(yaw), az = -Math.sin(yaw);
      for (const o of [-0.34, 0.34]) {
        B.at('trimDark', cylGeo(0.82 * s, 0.82 * s, 0.09, 16, 1.2),
          x + ax * o, 0.85 * s, z + az * o, yaw, 0, Math.PI / 2);
      }
      B.at('rubber', cylGeo(0.58 * s, 0.58 * s, 0.62, 14, 1.0), x, 0.85 * s, z, yaw, 0, Math.PI / 2);
      B.at('chrome', cylGeo(0.09, 0.09, 1.1, 8, 1.0), x, 0.85 * s, z, yaw, 0, Math.PI / 2);
      // Tail of cable spilling onto the deck - the detail that says "in use".
      const coil = new THREE.TorusGeometry(0.46, 0.055, 5, 18);
      coil.rotateX(-Math.PI / 2);
      B.at('rubber', coil, x + ax * 1.1, 0.06, z + az * 1.1, yaw);
      this._contact(x, z, 3.4 * s);
    };

    const crateStack = (x, z, yaw) => {
      B.at('panelWarm', boxGeo(1.7, 0.16, 1.2, 1.2), x, 0.08, z, yaw);
      const n = 1 + Math.floor(rng() * 3);
      let y = 0.16;
      for (let i = 0; i < n; i++) {
        const h = 0.55 + rng() * 0.35;
        const w = 1.25 - i * 0.14;
        B.at('crate', boxGeo(w, h, w * 0.82, 1.4), x + (rng() - 0.5) * 0.18, y + h / 2, z + (rng() - 0.5) * 0.18, yaw + (rng() - 0.5) * 0.4);
        y += h;
      }
      if (rng() < 0.4) B.at('emAmber', boxGeo(0.26, 0.05, 0.08, 1), x, y - 0.24, z + 0.5, yaw);
      this._contact(x, z, 3.6);
    };

    const barrier = (x, z, yaw, toppled) => {
      const tilt = toppled ? Math.PI / 2 - 0.08 : 0;
      const yc = toppled ? 0.34 : 0.55;
      B.at('hazard', boxGeo(2.4, 0.9, 0.12, 1.4), x, yc, z, yaw, 0, tilt);
      B.at('chrome', boxGeo(2.5, 0.07, 0.07, 1), x, yc + (toppled ? 0.0 : 0.5), z, yaw);
      if (!toppled) {
        for (const s of [-1, 1]) {
          B.at('trimDark', boxGeo(0.1, 0.2, 0.9, 1), x + Math.cos(yaw) * s * 1.1, 0.1, z - Math.sin(yaw) * s * 1.1, yaw);
        }
      }
      this._contact(x, z, toppled ? 4.0 : 3.2);
    };

    const hose = (x, z) => {
      for (let i = 0; i < 3; i++) {
        const t = new THREE.TorusGeometry(0.42 + i * 0.13, 0.075, 6, 22);
        t.rotateX(-Math.PI / 2);
        B.at('rubber', t, x, 0.08 + i * 0.03, z, rng() * 3);
      }
      B.at('copper', cylGeo(0.1, 0.1, 0.3, 8, 1.0), x + 0.7, 0.16, z + 0.2, 0, 0, Math.PI / 2);
      this._contact(x, z, 2.6);
    };

    const trolley = (x, z, yaw) => {
      B.at('trim', boxGeo(1.3, 0.06, 0.72, 1.2), x, 0.34, z, yaw);
      B.at('trim', boxGeo(1.3, 0.06, 0.72, 1.2), x, 0.86, z, yaw);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const px = x + Math.cos(yaw) * sx * 0.6 + Math.sin(yaw) * sz * 0.32;
        const pz = z - Math.sin(yaw) * sx * 0.6 + Math.cos(yaw) * sz * 0.32;
        B.at('trimDark', cylGeo(0.028, 0.028, 0.62, 5, 1.0), px, 0.63, pz);
        B.at('rubber', cylGeo(0.09, 0.09, 0.05, 8, 1.0), px, 0.09, pz, 0, 0, Math.PI / 2);
      }
      B.at('chrome', cylGeo(0.03, 0.03, 0.74, 6, 1.0), x - Math.sin(yaw) * 0.36, 1.02, z - Math.cos(yaw) * 0.36, yaw, 0, Math.PI / 2);
      B.at('crate', boxGeo(0.8, 0.42, 0.5, 1.2), x, 1.09, z, yaw + 0.15);
      this._contact(x, z, 3.0);
    };

    const grateInset = (x, z, yaw, w) => {
      B.at('trimDark', boxGeo(w + 0.34, 0.16, w * 0.66 + 0.34, 1.5), x, 0.06, z, yaw);
      B.at('grate', boxGeo(w, 0.1, w * 0.66, 1.4), x, 0.11, z, yaw);
      // A visible depth well under the grating: the reason a floor insert reads
      // as an opening rather than as a printed square.
      B.at('panelDark', boxGeo(w - 0.3, 0.5, w * 0.66 - 0.3, 1.2), x, -0.22, z, yaw);
      this._contact(x, z, w * 1.9);
    };

    const locker = (x, z, yaw, h = 1.9) => {
      B.at('shell', boxGeo(1.5, h, 0.72, 1.6), x, h / 2, z, yaw);
      B.at('trimDark', boxGeo(1.56, 0.12, 0.78, 1.2), x, h + 0.04, z, yaw);
      B.at('trimDark', boxGeo(1.56, 0.16, 0.78, 1.2), x, 0.08, z, yaw);
      // Door split + two handles, so the shell is not a blank box.
      B.at('trimDark', boxGeo(0.05, h - 0.3, 0.02, 1), x + Math.sin(yaw) * 0.37, h / 2, z + Math.cos(yaw) * 0.37, yaw);
      for (const s of [-1, 1]) {
        B.at('chrome', boxGeo(0.06, 0.3, 0.05, 1),
          x + Math.cos(yaw) * s * 0.16 + Math.sin(yaw) * 0.38, h * 0.55, z - Math.sin(yaw) * s * 0.16 + Math.cos(yaw) * 0.38, yaw);
      }
      B.at('emCyan', boxGeo(0.5, 0.05, 0.03, 1), x + Math.sin(yaw) * 0.38, h - 0.28, z + Math.cos(yaw) * 0.38, yaw);
      this._contact(x, z, 4.2);
      this._solidRot(x, h / 2, z, 0.8, h / 2, 0.4, yaw);
    };

    const wasteUnit = (x, z, yaw) => {
      B.at('shell', cylGeo(0.44, 0.38, 1.05, 12, 1.4), x, 0.53, z, yaw);
      B.at('trimDark', cylGeo(0.48, 0.48, 0.12, 12, 1.2), x, 1.1, z, yaw);
      B.at('chrome', new THREE.TorusGeometry(0.44, 0.03, 5, 18).rotateX(-Math.PI / 2), x, 1.16, z);
      B.at('emCyan', boxGeo(0.2, 0.14, 0.02, 1), x + Math.sin(yaw) * 0.4, 0.78, z + Math.cos(yaw) * 0.4, yaw);
      this._contact(x, z, 2.2);
    };

    /** Stanchion run with a slack chain - the queue language of a transit hub. */
    const stanchions = (x, z, yaw, n, gap) => {
      const ax = Math.cos(yaw), az = -Math.sin(yaw);
      for (let i = 0; i < n; i++) {
        const px = x + ax * (i - (n - 1) / 2) * gap;
        const pz = z + az * (i - (n - 1) / 2) * gap;
        B.at('trimDark', cylGeo(0.19, 0.24, 0.1, 12, 1.0), px, 0.05, pz);
        B.at('trim', cylGeo(0.045, 0.06, 0.95, 8, 1.0), px, 0.53, pz);
        B.at('chrome', cylGeo(0.075, 0.075, 0.1, 10, 1.0), px, 1.05, pz);
        this._contact(px, pz, 1.3);
        if (i === n - 1) continue;
        // Three short links approximating the catenary between two posts.
        for (let k = 0; k < 3; k++) {
          const t = (k + 0.5) / 3;
          const sag = Math.sin(t * Math.PI) * 0.16;
          B.at('rubber', cylGeo(0.018, 0.018, gap / 3, 4, 1.0),
            px + ax * gap * t, 0.94 - sag, pz + az * gap * t, yaw, 0, Math.PI / 2);
        }
      }
    };

    /* --- Wet patches ---------------------------------------------------
     * A washed-down deck picks the emissives up off the floor. Feathered with a
     * per-vertex alpha ramp for the same reason the polish patches are: an
     * unfeathered near-mirror quad two metres from the camera reads as a broken
     * render pass, which is exactly what got round 2 disqualified.
     */
    const puddle = (x, z, size) => {
      const q = new THREE.PlaneGeometry(size, size * (0.6 + rng() * 0.6), 10, 10);
      const pos = q.getAttribute('position');
      const col = new Float32Array(pos.count * 4);
      for (let v = 0; v < pos.count; v++) {
        const px = pos.getX(v), py = pos.getY(v);
        // Irregular, noise-warped boundary: a circular puddle is a stamp.
        const d = Math.hypot(px / (size * 0.5), py / (size * 0.36));
        const wob = 0.78 + tfbm(px * 0.7 + 3, py * 0.7 + 5, 8, 21, 3) * 0.5;
        const a = Math.max(0, Math.min(1, (wob - d) * 2.2));
        col[v * 4] = col[v * 4 + 1] = col[v * 4 + 2] = 1;
        col[v * 4 + 3] = a * a * 0.92;
      }
      q.setAttribute('color', new THREE.BufferAttribute(col, 4));
      q.rotateX(-Math.PI / 2);
      B.at('wet', q, x, 0.104, z, rng() * Math.PI * 2);
    };

    /* --- Hero anchors --------------------------------------------------
     * Placed by hand against the framing, not scattered. The spawn looks down
     * +X, so "frame left" is -Z and "frame right" is +Z; these two occlude the
     * bottom corners of that shot and give the eye a foothold at 7 m.
     */
    const sx = SPAWN_X, sz = SPAWN_Z;
    locker(sx + 7.5, sz + 6.2, -1.35, 2.1);                 // frame right
    crateStack(sx + 9.6, sz + 5.2, 0.5);
    for (let i = 0; i < 5; i++) {                            // frame left cluster
      const a = -0.9 + i * 0.42;
      const bx = sx + 6.4 + Math.cos(a) * 1.9, bz = sz - 5.4 + Math.sin(a) * 1.9;
      B.at('hazard', cylGeo(0.15, 0.21, 1.02, 10, 1.0), bx, 0.51, bz);
      B.at('chrome', cylGeo(0.185, 0.185, 0.1, 10, 1.0), bx, 1.06, bz);
      B.at('emAmber', cylGeo(0.14, 0.14, 0.05, 8, 1.0), bx, 1.13, bz);
      this._contact(bx, bz, 1.5);
    }
    spool(sx + 11.5, sz - 4.4, 0.9, 1.0);
    hose(sx + 12.6, sz - 6.0);
    trolley(sx + 13.8, sz + 3.4, -0.6);
    grateInset(sx + 5.4, sz - 0.4, 0.1, 3.2);
    puddle(sx + 6.2, sz + 1.2, 4.6);
    puddle(sx + 12.0, sz - 2.6, 3.4);
    barrier(sx + 15.5, sz + 6.8, 0.35, false);
    barrier(sx + 16.4, sz - 7.4, -0.5, true);

    // Both gateway approaches: queue furniture at the foot of the steps, which
    // is where a transit hub would actually put it.
    for (const s of [-1, 1]) {
      const gz = s * (PORTAL_R - 18);
      for (const ox of [-11.5, 11.5]) {
        stanchions(ox, gz, Math.PI / 2, 4, 2.1);
        locker(ox * 1.35, gz - s * 6, ox < 0 ? 1.2 : -1.2, 1.8);
        wasteUnit(ox * 1.16, gz + s * 5.5, 0);
      }
      crateStack(s * 13.4, gz + s * 9, 0.7);
      spool(-s * 14.2, gz + s * 3, 1.6, 0.9);
      puddle(s * 8.5, gz + s * 2, 5.2);
      grateInset(s * 12.6, gz - s * 2.4, 0, 2.8);
    }

    /* --- The rule: no empty 6 m square --------------------------------- */
    const KIND = ['spool', 'crate', 'barrier', 'hose', 'trolley', 'grate', 'locker', 'waste'];
    let placed = 0;
    for (let i = 0; i < 420 && placed < 96; i++) {
      const th = rng() * Math.PI * 2;
      const rr = 12 + Math.sqrt(rng()) * 30;
      const x = Math.cos(th) * rr, z = Math.sin(th) * rr;
      if (!legal(x, z)) continue;
      // Never inside the spawn's own 4 m bubble.
      if (Math.hypot(x - sx, z - sz) < 4.5) continue;
      const yaw = rng() * Math.PI * 2;
      switch (KIND[Math.floor(rng() * KIND.length)]) {
        case 'spool': spool(x, z, yaw, 0.8 + rng() * 0.5); break;
        case 'crate': crateStack(x, z, yaw); break;
        case 'barrier': barrier(x, z, yaw, rng() < 0.22); break;
        case 'hose': hose(x, z); break;
        case 'trolley': trolley(x, z, yaw); break;
        case 'grate': grateInset(x, z, yaw, 1.8 + rng() * 2.2); break;
        case 'locker': locker(x, z, yaw, 1.5 + rng() * 0.7); break;
        default: wasteUnit(x, z, yaw); break;
      }
      placed++;
    }

    // Scattered wet patches over the same annulus - these are what make the
    // deck stop reading as one flat value field under the ceiling emitters.
    for (let i = 0; i < 26; i++) {
      const th = rng() * Math.PI * 2;
      const rr = 11 + Math.sqrt(rng()) * 32;
      const x = Math.cos(th) * rr, z = Math.sin(th) * rr;
      if (Math.hypot(x, z) < 11) continue;
      puddle(x, z, 3 + rng() * 5.5);
    }

    /* --- Decal density --------------------------------------------------
     * Weighted onto stain / cable / dock cells, small and numerous rather than
     * a handful of large stamps, and with a scuff arc at the base of anything
     * that has been walked around.
     */
    for (let i = 0; i < 300; i++) {
      const th = rng() * Math.PI * 2;
      const rr = 9 + Math.sqrt(rng()) * 36;
      decals.push({
        cell: [10, 11, 8, 10, 11, 7, 3, 10][Math.floor(rng() * 8)],
        x: Math.cos(th) * rr,
        z: Math.sin(th) * rr,
        size: 0.7 + rng() * 2.6,
        yaw: rng() * Math.PI * 2,
      });
    }
    const geos = [];
    for (const d of decals) {
      const q = new THREE.PlaneGeometry(d.size, d.size);
      q.rotateX(-Math.PI / 2);
      atlasUV(q, d.cell % 4, Math.floor(d.cell / 4), 4, 4);
      _euler.set(0, d.yaw, 0);
      _quat.setFromEuler(_euler);
      _mat4.compose(_v1.set(d.x, 0.132, d.z), _quat, _scl.set(1, 1, 1));
      q.applyMatrix4(_mat4);
      geos.push(q);
    }
    const mesh = new THREE.Mesh(mergeGeometries(geos, false), this.mat.decal);
    for (const q of geos) q.dispose();
    mesh.name = 'nearfield:decals';
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.renderOrder = 2;
    g.add(mesh);
  }

  _buildDressing() {
    const M = this.mat;
    const B = new GeoBatch();
    const g = new THREE.Group();
    g.name = 'dressing';
    this.group.add(g);
    const rng = mulberry32(0xd2e551);

    /* --- Avenue lighting -------------------------------------------- */
    const lampPosts = [];
    const lampHeads = [];
    const pools = [];
    const shafts = [];
    const shaftColors = [];
    const poolColors = [];
    const cool = new THREE.Color(0x9adcff);
    /* The pools and shafts under the avenue lamps are the largest area of pure
     * hue in any wide shot, so they carry the district colour script rather
     * than a global warm/cool alternation. Retail avenues run magenta-pink,
     * the service and cargo arc runs sodium, the utility side stays cold. */
    const AVENUE_HUE = {
      0: new THREE.Color(0xff8fd0),
      60: new THREE.Color(0xffb268),
      120: new THREE.Color(0x9de8d6),
      180: new THREE.Color(0xc2acff),
      240: new THREE.Color(0xff9152),
      300: new THREE.Color(0x9adcff),
    };

    for (const deg of this.roadAngles) {
      const yaw = -deg * DEG - Math.PI / 2;
      const hue = AVENUE_HUE[deg] ?? cool;
      for (let i = 0; i < 8; i++) {
        const r = PLAZA_R + 8 + i * 19;
        const side = i % 2 ? 1 : -1;
        const p = roadPos(deg, r, side * (ROAD_W / 2 + 1.6), 0, new THREE.Vector3());
        this._contact(p.x, p.z, 2.6);
        lampPosts.push([p.x, 4.0, p.z, 0, yaw, 0, 1, 1, 1]);
        lampHeads.push([p.x - side * 0 + Math.cos(deg * DEG) * 0, 8.0, p.z, 0, yaw, 0, 1, 1, 1]);
        pools.push([p.x, 0.16, p.z, -Math.PI / 2, 0, 0, 9, 9, 9]);
        poolColors.push(hue);
        shafts.push([p.x, 4.1, p.z, 0, rng() * 3, 0, 1, 1, 1]);
        shaftColors.push(hue);
      }
    }
    // Plaza perimeter lighting.
    for (let i = 0; i < 16; i++) {
      const th = (i / 16) * Math.PI * 2 + 0.19;
      const p = new THREE.Vector3(Math.cos(th) * (PLAZA_R - 3), 0, Math.sin(th) * (PLAZA_R - 3));
      this._contact(p.x, p.z, 2.6);
      lampPosts.push([p.x, 4.0, p.z, 0, -th, 0, 1, 1, 1]);
      lampHeads.push([p.x, 8.0, p.z, 0, -th, 0, 1, 1, 1]);
      pools.push([p.x, 0.17, p.z, -Math.PI / 2, 0, 0, 8, 8, 8]);
      poolColors.push(cool);
      shafts.push([p.x, 4.1, p.z, 0, rng() * 3, 0, 1, 1, 1]);
      shaftColors.push(cool);
    }

    const postGeo = new THREE.CylinderGeometry(0.14, 0.24, 8, 8);
    uvScale(postGeo, 4, 4);
    g.add(instanced(postGeo, M.trim, lampPosts, { cast: true, recv: false }));
    const headGeo = boxGeo(1.9, 0.34, 0.6, 1.5);
    g.add(instanced(headGeo, M.emWhite, lampHeads, { cast: false, recv: false }));
    // Dark bezel + housing around every lamp head. A bare emissive card has no
    // silhouette for the bloom to bloom *against*, so it detonates into a
    // shapeless white disc; a hard unlit frame keeps a readable core. Both
    // parts merge into one geometry so the fixture kit is a single draw call.
    const bezelParts = [boxGeo(2.26, 0.30, 0.94, 1.5)];
    const yoke = boxGeo(0.9, 0.5, 0.5, 1.2);
    yoke.translate(0, 0.27, 0);
    bezelParts.push(yoke);
    const bezelGeo = mergeGeometries(bezelParts, false);
    for (const p of bezelParts) p.dispose();
    g.add(instanced(
      bezelGeo, M.trimDark,
      lampHeads.map((e) => [e[0], e[1] + 0.15, e[2], e[3], e[4], e[5], 1, 1, 1]),
      { cast: false, recv: false }
    ));

    const poolMesh = instanced(new THREE.PlaneGeometry(1, 1), M.pool, pools, { cast: false, recv: false });
    if (poolMesh.isInstancedMesh) {
      for (let i = 0; i < poolColors.length; i++) poolMesh.setColorAt(i, poolColors[i]);
      poolMesh.instanceColor.needsUpdate = true;
      poolMesh.renderOrder = 3;
    }
    g.add(poolMesh);

    // Volumetric-feeling shafts under every fixture. 48 radial segments plus
    // the view-facing alpha falloff, the foot dissolve and the crawling dust
    // noise in M.shaft: at 28 the flanks still resolved as facets at these
    // screen sizes, and the cone terminated on a razor-flat ellipse at the
    // deck. Vertically segmented too, so the foot fade interpolates smoothly.
    const shaftGeo = new THREE.CylinderGeometry(0.55, 3.4, 7.9, 48, 6, true);
    const shaftMesh = instanced(shaftGeo, M.shaft, shafts, { cast: false, recv: false });
    if (shaftMesh.isInstancedMesh) {
      for (let i = 0; i < shaftColors.length; i++) shaftMesh.setColorAt(i, shaftColors[i]);
      shaftMesh.instanceColor.needsUpdate = true;
      shaftMesh.renderOrder = 8;
      this._anim.shafts = shaftMesh;
    }
    g.add(shaftMesh);

    /* --- Scattered props --------------------------------------------
     * Everything above this line in every builder is already drawn, so this is
     * the moment to record what the deck is carrying. Both loops below consult
     * it through `_footprintClear`. */
    this._markOccupancy();
    const crates = [];
    const pallets = [];
    const barrels = [];
    const bollards = [];
    for (let i = 0; i < 240; i++) {
      const th = rng() * Math.PI * 2;
      const rr = PLAZA_R + 14 + rng() * (DECK_R - PLAZA_R - 34);
      const x = Math.cos(th) * rr, z = Math.sin(th) * rr;
      // Keep the carriageways clear.
      let onRoad = false;
      for (const deg of this.roadAngles) {
        const d = Math.atan2(Math.sin(th - deg * DEG), Math.cos(th - deg * DEG));
        if (Math.abs(d) * rr < ROAD_W / 2 + 3) onRoad = true;
      }
      if (this._insideStationEnterableFootprint(x, z, 1.0)) continue;
      if (onRoad) continue;
      // Every district is standing by the time dressing runs, so ask.
      if (!this._footprintClear(x, z, 1.2, 1.2, 1.6)) continue;
      const kind = rng();
      const yaw = rng() * Math.PI * 2;
      if (kind < 0.45) {
        const s = 0.7 + rng() * 0.7;
        crates.push([x, 0.75 * s, z, 0, yaw, 0, s, s, s]);
        this._contact(x, z, 4.4 * s);
        if (s > 1.05) this._solidRot(x, 0.75 * s, z, 0.8 * s, 0.75 * s, 0.8 * s, yaw);
      } else if (kind < 0.7) {
        pallets.push([x, 0.12, z, 0, yaw, 0, 1, 1, 1]);
        this._contact(x, z, 4.2);
      } else if (kind < 0.9) {
        barrels.push([x, 0.6, z, 0, yaw, 0, 1, 1, 1]);
        this._contact(x, z, 2.4);
      } else {
        bollards.push([x, 0.5, z, 0, yaw, 0, 1, 1, 1]);
        this._contact(x, z, 1.5);
      }
    }
    // Taller mass on the open deck. The 1.5 m crates above all sit below the
    // sightline of any standing or elevated camera, so the deck between the
    // plaza and the districts photographed as an empty apron; 3-6 m container
    // stacks are what actually break that floor plane at 40-100 m.
    const stackLo = [];
    const stackHi = [];
    const stackPad = [];
    for (let i = 0; i < 70; i++) {
      const th = rng() * Math.PI * 2;
      const rr = PLAZA_R + 12 + rng() * 110;
      const x = Math.cos(th) * rr, z = Math.sin(th) * rr;
      let clear = true;
      for (const deg of this.roadAngles) {
        const d = Math.atan2(Math.sin(th - deg * DEG), Math.cos(th - deg * DEG));
        if (Math.abs(d) * rr < ROAD_W / 2 + 7) clear = false;
      }
      if (this._insideStationEnterableFootprint(x, z, 2.0)) clear = false;
      // Keep the two gateway approach corridors readable.
      if (Math.abs(x) < 24 && Math.abs(z) > 44 && Math.abs(z) < 100) clear = false;
      if (!clear) continue;
      const yaw = rng() * Math.PI * 2;
      const s = 0.85 + rng() * 0.5;
      /* A 6 m container is the biggest loose object on the deck and the one
       * that reads worst half-buried, so it gets the real footprint tested at
       * its own yaw rather than a circle: a stack turned 45 degrees has an
       * axis-aligned bound half again its width, and rejecting on that would
       * thin the deck out for clearance it does not need. */
      const cs = Math.abs(Math.cos(yaw)), sn = Math.abs(Math.sin(yaw));
      if (!this._footprintClear(x, z, 3.1 * s * cs + 1.3 * s * sn, 3.1 * s * sn + 1.3 * s * cs, 3.0 * s)) continue;
      stackPad.push([x, 0.15, z, 0, yaw, 0, s, 1, s]);
      stackLo.push([x, 1.45 * s, z, 0, yaw, 0, s, s, s]);
      if (rng() < 0.55) stackHi.push([x + Math.cos(yaw) * 0.4, 4.2 * s, z, 0, yaw + 0.12, 0, s * 0.9, s * 0.9, s * 0.9]);
      this._solidRot(x, 1.5 * s, z, 3.1 * s, 1.5 * s, 1.3 * s, yaw);
      this._contact(x, z, 11 * s);
    }
    g.add(instanced(boxGeo(6.1, 2.9, 2.5, 2.4), M.crate, stackLo, { cast: true, recv: true }));
    g.add(instanced(boxGeo(5.5, 2.7, 2.4, 2.4), M.crate, stackHi, { cast: true, recv: true }));
    g.add(instanced(boxGeo(6.5, 0.3, 2.9, 1.6), M.hazard, stackPad, { cast: false, recv: true }));

    g.add(instanced(boxGeo(1.5, 1.5, 1.5, 1.5), M.crate, crates, { cast: true, recv: true }));
    g.add(instanced(boxGeo(2.4, 0.24, 1.6, 1.2), M.panelWarm, pallets, { cast: true, recv: true }));
    const barrelGeo = new THREE.CylinderGeometry(0.55, 0.55, 1.2, 12);
    uvScale(barrelGeo, 3, 1);
    g.add(instanced(barrelGeo, M.hazard, barrels, { cast: true, recv: true }));
    const bollardGeo = new THREE.CylinderGeometry(0.16, 0.22, 1.0, 8);
    g.add(instanced(bollardGeo, M.hazard, bollards, { cast: true, recv: true }));
    const bollardCaps = bollards.map((b) => [b[0], b[1] + 0.55, b[2], 0, 0, 0, 1, 1, 1]);
    g.add(instanced(new THREE.CylinderGeometry(0.24, 0.24, 0.1, 10), M.chrome,
      bollards.map((b) => [b[0], b[1] + 0.5, b[2], 0, 0, 0, 1, 1, 1]), { cast: false, recv: false }));
    g.add(instanced(new THREE.CylinderGeometry(0.2, 0.2, 0.14, 8), M.emAmber, bollardCaps, { cast: false, recv: false }));

    /* --- +Z avenue-mouth anchor ---------------------------------------
     *
     * From the spawn the player faces +X, so the right third of the hero frame
     * is the +Z shoulder of the commercial approach - and it had no key, no
     * emissive mass and no lit facade anywhere in it. Half a composition doing
     * no work also kills the sense that the world continues in that direction,
     * which is the more expensive failure. A 12 m sign pylon plus a run of lit
     * shopfront glazing gives that bearing a destination to read.
     */
    for (const [ax, az, ayaw] of [[70, 52, -0.9], [118, 47, -0.65], [62, -54, 2.3]]) {
      B.at('panelDark', boxGeo(2.0, 12.5, 2.0, 3), ax, 6.25, az, ayaw);
      B.at('trim', boxGeo(2.6, 0.5, 2.6, 1.6), ax, 12.6, az, ayaw);
      B.at('hazard', boxGeo(2.8, 1.4, 2.8, 1.6), ax, 0.7, az, ayaw);
      for (const s of [-1, 1]) {
        B.at('emSodium', boxGeo(0.34, 10.5, 0.34, 1), ax + Math.cos(ayaw) * s * 1.05, 6.4, az - Math.sin(ayaw) * s * 1.05, ayaw);
      }
      this._signBoard(B, SIGN_ROLE.dock, 5.2, 2.6, ax, 10.0, az, ayaw, { twoSided: true, accent: 'emSodium' });
      this._signBoard(B, SIGN_ROLE.concourse, 3.4, 1.7, ax, 6.6, az, ayaw + Math.PI / 2, { twoSided: true, accent: 'emCyan' });
      this._solid(ax, 6, az, 1.2, 6, 1.2);
      this._contact(ax, az, 8);
      this._mmCircle(ax, az, 2, 'rgba(255,150,80,0.4)', null);
    }
    // Lit shopfront band along the +Z facade of the commercial approach: an
    // inhabited wall of windows rather than a black one.
    for (let i = 0; i < 14; i++) {
      const bx = 62 + i * 8.4;
      const bz = 47 + Math.sin(i * 0.9) * 2.6;
      B.at('panel', boxGeo(7.6, 7.0, 1.2, 2.4), bx, 5.6, bz, 0);
      const room = new THREE.PlaneGeometry(6.6, 4.2);
      atlasUV(room, i % 4, (i >> 2) % 4, 4, 4);
      B.at('room', room, bx, 5.6, bz - 0.68, Math.PI);
      B.at('trim', boxGeo(7.9, 0.34, 1.5, 1.4), bx, 9.3, bz, 0);
      B.at(i % 3 === 0 ? 'emSodium' : 'emMagenta', boxGeo(6.4, 0.16, 0.22, 1), bx, 2.4, bz - 0.72, 0);
      this._contact(bx, bz, 10);
    }

    /* --- Hull-side services: pipe runs and cable trays ---------------
     *
     * Three pipes, a cable tray and a cabinet run, following the hull all the
     * way round at chest and head height.
     *
     * They used to go *all* the way round, and that was the single most visible
     * defect on the ring once the avenues gained doorways: standing at a link
     * mouth you were looking down a corridor through four horizontal tubes that
     * crossed the opening at 3.2, 4.1, 4.9 and 6.2 m and carried on out the
     * other side. Nothing in a building runs a live service main across a
     * doorway; it stops each side and goes over the head, or it goes round.
     *
     * So each 42 m chord is now clipped against the mouth angles and emitted as
     * however many pieces survive. A chord that misses every mouth is emitted
     * whole, exactly as before, so the other 26 of the 30 bays are untouched.
     */
    const R_SERV = HULL_R - 3.2;
    const servMouths = ZONES.map((zn) => zn.deg * DEG);
    // A little wider than the structural opening so the run stops clear of the
    // mouth's own frame rather than dying against it.
    const servHalf = (LINK_MOUTH_HALF_DEG + 1.6) * DEG;
    const norm = (a) => Math.atan2(Math.sin(a), Math.cos(a));

    /** Sub-spans of [a0, a1] that lie outside every mouth. */
    const clearSpans = (a0, a1) => {
      let spans = [[a0, a1]];
      for (const m of servMouths) {
        const next = [];
        for (const [s0, s1] of spans) {
          // Work relative to the mouth so wrap-around is somebody else's problem.
          const d0 = norm(s0 - m), d1 = d0 + (s1 - s0);
          if (d1 <= -servHalf || d0 >= servHalf) { next.push([s0, s1]); continue; }
          if (d0 < -servHalf) next.push([s0, m - servHalf]);
          if (d1 > servHalf) next.push([m + servHalf, s0 + (d1 - d0)]);
        }
        spans = next;
      }
      return spans;
    };

    for (let i = 0; i < 30; i++) {
      const a0 = (i / 30) * Math.PI * 2, a1 = ((i + 1) / 30) * Math.PI * 2;
      for (const [s0, s1] of clearSpans(a0, a1)) {
        const th = (s0 + s1) / 2;
        const chord = R_SERV * (s1 - s0) + 0.5;
        if (chord < 1.5) continue;
        const x = Math.cos(th) * R_SERV, z = Math.sin(th) * R_SERV;
        for (let k = 0; k < 3; k++) {
          const pipe = new THREE.CylinderGeometry(0.22 + k * 0.08, 0.22 + k * 0.08, chord, 6);
          pipe.rotateZ(Math.PI / 2);
          uvScale(pipe, chord / 2, 2);
          B.at(k === 1 ? 'copper' : 'trim', pipe, x, 3.2 + k * 0.85, z, -th - Math.PI / 2);
        }
        B.at('grate', boxGeo(chord, 0.25, 0.7, 1.5), x - Math.cos(th) * 0.9, 6.2, z - Math.sin(th) * 0.9, -th - Math.PI / 2);
      }
      // Cabinets are point objects, not runs - one test against the mouths does.
      const thc = (a0 + a1) / 2;
      if (i % 3 === 0 && !servMouths.some((m) => Math.abs(norm(thc - m)) < servHalf + 0.02)) {
        const x = Math.cos(thc) * R_SERV, z = Math.sin(thc) * R_SERV;
        B.at('panelDark', boxGeo(1.6, 2.4, 1.2, 2), x - Math.cos(thc) * 1.4, 1.2, z - Math.sin(thc) * 1.4, -thc);
        B.at('emAmber', boxGeo(1.2, 0.12, 0.18, 1), x - Math.cos(thc) * 2.1, 2.1, z - Math.sin(thc) * 2.1, -thc);
      }
    }

    /* --- Steam vents ------------------------------------------------- */
    const ventSpots = [];
    for (let i = 0; i < 14; i++) {
      const th = rng() * Math.PI * 2;
      const rr = PLAZA_R + 20 + rng() * 120;
      const x = Math.cos(th) * rr, z = Math.sin(th) * rr;
      ventSpots.push([x, z]);
      B.at('grate', boxGeo(2.2, 0.4, 2.2, 1.5), x, 0.2, z, rng() * 3);
      B.at('hazard', boxGeo(2.6, 0.18, 2.6, 1.5), x, 0.06, z, rng() * 3);
    }
    const puffs = [];
    const puffColors = [];
    this._anim.steamSeeds = new Float32Array(ventSpots.length * 4);
    for (let i = 0; i < ventSpots.length; i++) {
      for (let k = 0; k < 4; k++) {
        puffs.push([ventSpots[i][0], 1, ventSpots[i][1], 0, 0, 0, 1, 1, 1]);
        puffColors.push(new THREE.Color(0.35, 0.42, 0.5));
      }
      this._anim.steamSeeds[i * 4] = ventSpots[i][0];
      this._anim.steamSeeds[i * 4 + 1] = ventSpots[i][1];
      this._anim.steamSeeds[i * 4 + 2] = rng() * 6.28;
      this._anim.steamSeeds[i * 4 + 3] = 1.6 + rng() * 1.6;
    }
    const steamMesh = instanced(new THREE.PlaneGeometry(3.2, 3.2), M.steam, puffs, { cast: false, recv: false });
    if (steamMesh.isInstancedMesh) {
      for (let i = 0; i < puffColors.length; i++) steamMesh.setColorAt(i, puffColors[i]);
      steamMesh.instanceColor.needsUpdate = true;
      steamMesh.renderOrder = 7;
      this._anim.steam = steamMesh;
    }
    g.add(steamMesh);

    /* --- Holographic advertising ------------------------------------ */
    const adSpots = [
      [56, 12, 26], [-40, 14, 62], [70, 16, -48], [-64, 13, -40],
      [110, 15, 24], [-96, 15, 30], [30, 18, -92], [-24, 16, 96],
    ];
    for (let i = 0; i < adSpots.length; i++) {
      const [ax, ay, az] = adSpots[i];
      const pivot = new THREE.Group();
      pivot.position.set(ax, ay, az);
      g.add(pivot);
      // Holographic advertising only ever draws from the commercial block, so a
      // floating ad can never repeat a wayfinding board's copy.
      const cell = i % 12;
      // Two correctly-wound quads back to back rather than one DoubleSide quad.
      // A double-sided text plate spun through 360 degrees shows the player its
      // mirrored back face for half of every revolution - the defect that made
      // "RING 7 CLINIC" read as "CINILC 7 GNIR" in the review frames.
      const faceA = new THREE.PlaneGeometry(9, 4.5);
      signUV(faceA, cell);
      const faceB = faceA.clone();
      faceB.rotateY(Math.PI);
      faceA.translate(0, 0, 0.05);
      faceB.translate(0, 0, -0.05);
      const geo = mergeGeometries([faceA, faceB], false);
      faceA.dispose();
      faceB.dispose();
      const adMat = new THREE.MeshBasicMaterial({
        map: this._tex.signs,
        transparent: true,
        opacity: 0.68,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.FrontSide,
        toneMapped: true,
      });
      const ad = new THREE.Mesh(geo, adMat);
      pivot.add(ad);
      const halo = new THREE.Mesh(new THREE.RingGeometry(5.2, 5.6, 40), M.holo);
      pivot.add(halo);
      // Oscillate rather than spin: a slow yaw sweep keeps the plate broadside
      // to the plaza instead of presenting an edge-on sliver half the time.
      this._anim.ads.push({
        pivot,
        mat: adMat,
        phase: rng() * 6.28,
        speed: 0.12 + rng() * 0.18,
        baseYaw: Math.atan2(-ax, -az),
        sweep: 0.75,
      });

      // A projector mast so the hologram has a source.
      B.at('trim', new THREE.CylinderGeometry(0.16, 0.28, ay - 1, 8), ax, (ay - 1) / 2, az);
      B.at('emCyan', new THREE.ConeGeometry(0.5, 0.9, 10), ax, ay - 1.2, az);
      this._solid(ax, (ay - 1) / 2, az, 0.5, (ay - 1) / 2, 0.5);
    }

    /* --- Worn-smooth deck patches ------------------------------------
     * Five small feathered patches, never nearer than 60 m to the plaza centre
     * and never larger than 6 m. The round-2 build put ten hard-edged 14 m
     * mirror quads at 50 m, one of which cut a razor-straight tonal seam across
     * the full width of the hero frame. A patch has to dissolve into the deck
     * or it reads as a broken render pass, so each one carries a radial vertex
     * alpha ramp and gets no silhouette edge at all.
     */
    for (let i = 0; i < 5; i++) {
      const th = rng() * Math.PI * 2;
      const rr = 62 + rng() * 96;
      const size = 3 + rng() * 3;
      const q = new THREE.PlaneGeometry(size, size, 8, 8);
      uvScale(q, size / 12, size / 12);
      q.rotateX(-Math.PI / 2);
      const pos = q.attributes.position;
      const col = new Float32Array(pos.count * 4);
      for (let v = 0; v < pos.count; v++) {
        // Distance from the patch centre in normalised units; alpha is gone
        // well before the geometry's own edge.
        const d = Math.min(1, Math.hypot(pos.getX(v), pos.getZ(v)) / (size * 0.5));
        const a = Math.max(0, 1 - d * d) * 0.85;
        col[v * 4] = col[v * 4 + 1] = col[v * 4 + 2] = 1;
        col[v * 4 + 3] = a;
      }
      q.setAttribute('color', new THREE.BufferAttribute(col, 4));
      B.at('polish', q, Math.cos(th) * rr, 0.105, Math.sin(th) * rr, rng() * 3);
    }

    /* --- Traffic grime ------------------------------------------------
     *
     * The last note on the street-level frame was that the near deck is "a flat
     * untextured field with only seam lines: no grime, traffic wear, roughness
     * variation or sub-metre detail". Roughness variation the macro shader does
     * have; what it cannot have is anything *aperiodic*, because every octave it
     * runs is a tiling fetch off the same 256 px map, so the answer at 3 m and
     * the answer at 63 m are the same answer.
     *
     * These are 90 hand-scattered multiply patches, weighted onto the plaza and
     * the avenue mouths where footfall actually is, each with its own size and
     * rotation. One instanced draw call, no shadow, no depth write.
     */
    const grime = [];
    const gr = mulberry32(0x7ea1);
    for (let i = 0; i < 90; i++) {
      let gx, gz;
      const roll = gr();
      if (roll < 0.42) {
        // Plaza ring: densest where the crowd walks, clear of the monument.
        const th = gr() * Math.PI * 2;
        const rr = 9 + Math.sqrt(gr()) * 30;
        gx = Math.cos(th) * rr; gz = Math.sin(th) * rr;
      } else if (roll < 0.78) {
        // Avenue mouths - the wear runs down the carriageway, not across it.
        const deg = this.roadAngles[Math.floor(gr() * this.roadAngles.length)];
        const p = roadPos(deg, PLAZA_R + gr() * 62, (gr() - 0.5) * ROAD_W * 0.9, 0, new THREE.Vector3());
        gx = p.x; gz = p.z;
      } else {
        const th = gr() * Math.PI * 2;
        const rr = 60 + gr() * 110;
        gx = Math.cos(th) * rr; gz = Math.sin(th) * rr;
      }
      const size = 7 + gr() * 15;
      // Stretched along its own yaw: pooled dirt on a walked route is
      // directional, and a ring of circles reads as a repeated stamp.
      grime.push([gx, 0.075, gz, -Math.PI / 2, 0, gr() * Math.PI * 2,
        size, size * (0.55 + gr() * 0.7), 1]);
    }
    const grimeMesh = instanced(new THREE.PlaneGeometry(1, 1), M.grime, grime, { cast: false, recv: false });
    if (grimeMesh.isInstancedMesh) {
      grimeMesh.renderOrder = 0;
      this.group.add(grimeMesh);
    }

    /* --- Silhouette hierarchy and inhabitation ----------------------- */
    this._buildLandmarkMasses(B);
    this._buildNearField(B, g);
    this._buildCrowd(g);

    for (const mesh of B.flush(g, M, 'dressing', {
      cast: true, recv: true,
      polish: { cast: false, recv: true },
      wet: { cast: false, recv: true },
    })) {
      // The feathered deck patches are transparent; they must sort under the
      // painted decals and the contact patches, never over them.
      if (mesh.name === 'dressing:polish') mesh.renderOrder = 1;
      if (mesh.name === 'dressing:wet') mesh.renderOrder = 1;
    }

    /* --- Contact occlusion ------------------------------------------- */
    // Every builder above queued patches; they resolve into one instanced,
    // multiply-blended draw call. Without this nothing in the frame is seated:
    // props, lamp posts and dais feet all meet the deck on a clean bright line.
    const contactMesh = instanced(new THREE.PlaneGeometry(1, 1), M.contact, this._contacts, { cast: false, recv: false });
    if (contactMesh.isInstancedMesh) {
      contactMesh.renderOrder = 1;
      this.group.add(contactMesh);
    }
    this._contacts.length = 0;
  }

  /* ---------------------------------------------------------------- */
  /* Lighting                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Real lights are expensive, so the ring runs on emissive geometry plus a
   * short list of hand-placed point lights at the story beats.
   */
  _buildLights() {
    const g = new THREE.Group();
    g.name = 'lights';
    this.group.add(g);

    const add = (color, intensity, dist, x, y, z) => {
      const l = new THREE.PointLight(color, intensity, dist, 2);
      l.position.set(x, y, z);
      l.castShadow = false;
      g.add(l);
      return l;
    };

    add(0x8fd8ff, 1900, 90, 0, 16, 0);           // monument key
    /* Practicals hung at head height, not at knee height.
     *
     * A 1050 cd point with quadratic decay sitting 5 m over a deck puts about
     * forty lux on the plate directly beneath it - eight times the bloom
     * threshold - so each one burned an unmotivated white blob into the floor
     * with no fixture anywhere near it. Same energy from 9 m spreads the pool
     * over four times the area and lands just under the bright pass, which is
     * what a practical is supposed to do. */
    add(0xffc07a, 1050, 60, 0, 9, 24);           // plaza vendor warmth
    add(0xffc07a, 1050, 60, 18, 9, -20);
    /* The plaza wide shot had no warm anchor at all: every practical, every
     * accent and the portal glow itself sat in the same 480-510 nm band, so a
     * frame the grade is split-toning warm-over-cool photographed as a
     * monochrome teal image. These four are inside the plaza core and inside
     * the wide-shot frustum, and they are the 20% sodium half of the 70/20/10
     * cool / sodium / hazard split the world is authored to.
     *
     * Trimmed ~30% from round 3: at the old levels these four *were* the plaza
     * key from most azimuths, and an unshadowed practical acting as a key is
     * exactly what makes a deck read as cream with nothing seated on it. */
    add(0xffb070, 1120, 55, -26, 9.5, 8);
    add(0xff9d55, 940, 48, 22, 9.5, -14);
    add(0xffb877, 790, 44, -14, 8.5, -30);
    add(0xffa860, 710, 42, 30, 8.5, 22);
    /* Motivated warm sources for the promenade soffit run (see
     * _buildWalkwayLoop). Eight of them around the loop at 8 m, throwing down
     * and inward onto the deck: this is the sodium half of the colour script
     * actually reaching a surface, rather than only existing as an emissive
     * strip that nothing receives. Short range and quadratic decay keep them
     * off the far districts, which stay cold. */
    for (let i = 0; i < 8; i++) {
      const th = (i / 8) * Math.PI * 2 + 0.4;
      add(0xffb271, 560, 30, Math.cos(th) * (LOOP_R - 1), LOOP_Y - 1.6, Math.sin(th) * (LOOP_R - 1));
    }
    add(0x9fe0ff, 2000, 96, 120, 14, 0);         // commercial strip
    add(0x9fe0ff, 1800, 96, 172, 12, 0);         // promenade / window wash
    add(0xffb060, 1900, 70, -110, 12, 6);        // residential terrace
    this._anim.flicker.push(add(0x7fe9ff, 1500, 64, -66, 11, 108)); // habitat, flickering ballast

    // District colour temperature. With the global ambient pulled down, these
    // are what actually models form - and giving each district its own white
    // point is the cheapest orientation cue an open world has: the player can
    // tell where they are from the colour of the light before they read a sign.
    add(0xffbe86, 1500, 74, 62, 10, 118);        // hangar apron, sodium warm
    add(0xffa860, 1400, 70, -96, 9, -84);        // cargo yard, warmer still
    add(0xa6e2ff, 1500, 72, -62, 11, 96);        // habitat, cold service light
    add(0xcfe8ff, 1300, 66, -110, 14, -14);      // control tower approach

    /* --- The key ------------------------------------------------------
     *
     * Round 3 spent the entire shadow budget on two SpotLights 40-44 m over the
     * monument and still photographed a plaza with no cast shadow anywhere on
     * it. Measured rather than assumed, that is arithmetic, not a bug: a spot
     * at 44 m with quadratic decay puts well under one unit of irradiance on
     * the deck, while ambient + hemisphere + two non-shadowing directionals +
     * twenty practicals put roughly four on it. A shadow term worth 15% of the
     * total is a smudge, and the grade's toe eats it.
     *
     * The scene-level sun in main.js is worse than neutral in here. It is a
     * *directional* light on a pressurised interior: the hull occludes it
     * completely everywhere inside its 120 m player-tracking shadow frustum,
     * and lights everything *outside* that frustum at full strength - so the
     * far districts were brighter than the plaza the camera is standing in.
     * `_fillEnvironment` now runs it near zero and this light does the job.
     *
     * Why a directional and not a brighter spot: no falloff. One value covers
     * the whole 220 m box, so the key can be authored against the fill instead
     * of against the inverse-square law, and a bollard 60 m out casts the same
     * shadow as one at the camera. Raked from +X/+Z at 38 degrees - motivated
     * by the window wall, which is the only real light source in the fiction -
     * so shadows sweep *across* the street-level frame rather than hiding
     * behind their own casters.
     *
     * Intensity is deliberately far above the value a "balanced" rig would
     * suggest, and that is the whole point. A shadow is only ever as deep as
     * the fraction of the incident light the caster removes: with the key at
     * 2.6 against ~2.5 units of ambient + hemisphere + rim + counter + IBL +
     * twenty practicals, the A/B render with `castShadow` toggled was visually
     * identical - the shadows were there and worth about a tenth of a stop.
     * At 5.4 against a fill halved again below, a cast shadow removes most of
     * the light that was on that plate, which is what "deep readable shadows"
     * means. Exposure comes back down to compensate.
     */
    const KEY_DIR = new THREE.Vector3(0.45, 0.62, 0.64).normalize();
    const key = new THREE.DirectionalLight(0xd7e7ff, 5.4);
    key.position.copy(KEY_DIR).multiplyScalar(190);
    key.target.position.set(0, 0.5, 0);
    key.castShadow = true;
    // 3072 over a 160 m box is 5 cm per texel: enough for a stall leg, a bench
    // slat and a planter lip, which is the scale that reads as "seated".
    key.shadow.mapSize.set(3072, 3072);
    const sc = key.shadow.camera;
    sc.left = -80; sc.right = 80; sc.top = 80; sc.bottom = -80;
    sc.near = 60; sc.far = 330;
    sc.updateProjectionMatrix();
    // Both biases are small on purpose: at 5 cm per texel a 0.11 m normal bias
    // erases every shadow cast by anything under half a metre thick, which is
    // most of the props the plaza is dressed with.
    key.shadow.bias = -0.00035;
    key.shadow.normalBias = 0.04;
    // A shadow pass is a second render of everything in the box - measured at
    // ~300 draw calls. Refreshing it seven times a second instead of every
    // frame keeps the steady-state cost near a seventh of that while still
    // tracking the NPCs walking through the plaza. See update().
    key.shadow.autoUpdate = false;
    key.shadow.needsUpdate = true;
    g.add(key);
    g.add(key.target);
    this._keyLight = key;
    this._keyShadowT = 0;
    // The map is `autoUpdate = false`, so for the first frames after activation
    // it is stale or empty - and a screenshot taken in that window has the
    // whole plaza unseated. Force it for the first second of world time.
    this._shadowWarm = 0;
    this._fillLight = null;
    this._shadowPhase = 0;

    // Monument accent. This used to be the shadow caster; it is now a pure
    // shaping light on the spire and the dais nosings, which is all a 0.5
    // half-angle cone at 40 m was ever actually doing.
    const accent = new THREE.SpotLight(0xdcefff, 3400, 110, 0.5, 0.55, 2);
    accent.position.set(-14, 40, 26);
    accent.target.position.set(2, 1, -4);
    accent.castShadow = false;
    g.add(accent);
    g.add(accent.target);

    // Cool rim from the opposite azimuth so building edges separate from the
    // background instead of dissolving into the same slate-blue value band.
    // Pulled back hard from 1.35: every unit of unshadowed directional is a
    // unit the key has to out-shout before a shadow becomes visible.
    // 0.34 was measurably doing nothing for figure separation against a key of
    // 5.4; a crowd photographed as flat dark posts partly because of it.
    const rim = new THREE.DirectionalLight(0x8fc7ff, 0.52);
    rim.position.set(-140, 60, -90);
    rim.target.position.set(20, 0, 20);
    rim.castShadow = false;
    g.add(rim);
    g.add(rim.target);

    // A low warm counter-fill from the plaza's -Z side, kept just strong enough
    // that a bench leg facing away from the key is dark rather than black.
    const counter = new THREE.DirectionalLight(0xffbd8a, 0.16);
    counter.position.set(90, 26, 120);
    counter.target.position.set(-10, 2, -20);
    counter.castShadow = false;
    g.add(counter);
    g.add(counter.target);

    /* --- Uplight on the roof structure -------------------------------
     *
     * Every light in this file points down, and the only faces of the ceiling
     * truss a player can ever see are its undersides. So the entire upper 45%
     * of frame was lit by hemisphere 0.26 against a 0x2b2620 ground colour -
     * about a fiftieth of a stop - and rendered black, leaving the emissive
     * strips floating in a void with no structure behind them. This is the
     * bounce that a hall full of lit deck plate would actually throw back up,
     * and it is the single change that turns the "glowing wireframe" into a
     * ceiling. Aimed straight up so it grazes nothing at deck level and cannot
     * flatten the key's shadows.
     */
    const bounce = new THREE.DirectionalLight(0x8aa5c4, 0.62);
    bounce.position.set(0, 0, 0);
    bounce.target.position.set(0, CEIL_Y, 0);
    bounce.castShadow = false;
    g.add(bounce);
    g.add(bounce.target);

    /* --- +Z district anchor -------------------------------------------
     *
     * From the spawn the player faces +X, so the right third of the hero frame
     * is the +Z quadrant of the commercial approach - and it had no practical,
     * no emissive mass and no lit facade anywhere in it, so half the
     * composition collapsed into unreadable navy. These three bring that
     * district's mean luminance to within ~1.5 stops of the plaza core.
     */
    add(0xffb37a, 2100, 105, 108, 14, 32);
    add(0xffc490, 1400, 78, 74, 10, 52);
    add(0x9fd6ff, 1200, 72, 138, 12, 22);
  }

  /* ---------------------------------------------------------------- */
  /* Spawns, portals, minimap frame and environment                    */
  /* ---------------------------------------------------------------- */

  /* ---------------------------------------------------------------- */
  /* The outer ring                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Build the great dome, the apron, the four links and the four zones.
   *
   * Everything structural lives in station/OuterRing.js; this is the seam where
   * what the zones produced - enterables, named NPCs, collectables, rooftops -
   * is folded back into the world's own published surfaces.
   */
  _buildOuterRing() {
    const g = new THREE.Group();
    g.name = 'actors';
    this.group.add(g);

    this._actors = new StationActors({ materials: this.mat, seed: 0xac70 });
    const zones = buildOuterRing(this, this._actors);
    this._actors.finish(g);

    if (!Array.isArray(this.enterables)) this.enterables = [];
    this._zoneNpcSpawns = [];
    let relics = 0;

    for (const ctx of zones) {
      for (const e of ctx.enterables) this.enterables.push(e);
      for (const s of ctx.npcSpawns) this._zoneNpcSpawns.push(s);
      for (const r of ctx.roofs) this._roofs.push(r);

      /* A zone's loose collectables ride in on a synthetic enterable.
       *
       * `Interiors` is already the system that owns authored collectibles: it
       * tags them, remembers which have been taken across a save, and now
       * streams them in and out by proximity. A zone's hidden relics want all
       * three of those, and inventing a parallel spawner beside it would mean a
       * second thing to keep in step with the save format. So each zone hands
       * over one door-less, lift-less enterable that is nothing but a list of
       * places worth looking.
       */
      if (ctx.relicSpots.length) {
        this.enterables.push({
          label: `${ctx.spec.id} caches`,
          origin: ctx.centre.clone(),
          doors: [],
          lifts: [],
          collectibleSpots: ctx.relicSpots,
        });
        relics += ctx.relicSpots.length;
      }
    }

    const spots = this.enterables.reduce((n, e) => n + (e.collectibleSpots?.length ?? 0), 0);
    console.info(
      `[station] outer ring: ${zones.length} zones, ${this._actors.count} actors, ` +
      `${this.enterables.length} enterables (${spots} collectible spots, ${relics} loose), ` +
      `${this._roofs.length} published roofs, ${this._escalators.length} escalator banks`
    );
  }

  _fillSpawns() {
    // Spawn behind the monument looking down the +X avenue: the holo-table and
    // spire frame the shot, the great window and the planet close it, and both
    // gateways sit in peripheral vision to the left and right.
    this.playerSpawn.set(SPAWN_X, 0.25, SPAWN_Z);
    this.playerSpawnYaw = SPAWN_YAW;

    const F = (name, persona, x, z, patrol) => ({
      position: new THREE.Vector3(x, 0.2, z),
      type: 'friendly',
      name,
      persona,
      patrol: patrol ? patrol.map(([px, pz]) => new THREE.Vector3(px, 0.2, pz)) : undefined,
    });

    const H = (x, z, patrol) => ({
      position: new THREE.Vector3(x, 0.2, z),
      type: 'hostile',
      name: 'Rogue Security Unit',
      persona: 'A hijacked station security drone running corrupted enforcement code. It does not negotiate.',
      patrol: patrol.map(([px, pz]) => new THREE.Vector3(px, 0.2, pz)),
    });

    const hangar = roadPos(60, 120, 34, 0, new THREE.Vector3());
    // Kept on the carriageway itself: the yard either side is solid containers.
    const cargo = roadPos(300, 104, -6, 0, new THREE.Vector3());
    const comms = roadPos(240, 126, 16, 0, new THREE.Vector3());
    const terrace = roadPos(180, 96, -20, 0, new THREE.Vector3());

    this.npcSpawns = [
      F('Bex Corrado',
        'A blunt, sun-starved dockworker who has loaded freight on this ring for nineteen years and has an opinion about every pilot who ever scratched her deck plating. She swears affectionately, calls everyone "boss", and will happily tell you which crates you should not look inside.',
        hangar.x, hangar.z,
        [[hangar.x, hangar.z], [hangar.x + 14, hangar.z + 10], [hangar.x - 10, hangar.z + 16]]),

      F('Marta Vale',
        'Barkeep of the Pale Horse on the commercial strip: dry, unshockable, and the unofficial clearing house for every rumour on the ring. She pours honestly, listens more than she talks, and remembers exactly what you said last time.',
        104, 11,
        [[104, 11], [118, 12], [96, 10]]),

      F('Lt. Idris Fane',
        'Comms officer on the Traffic Control watch. Precise, faintly exhausted, and permanently mid-handover; he speaks in call signs and clearance numbers and is quietly proud that nothing has collided on his shift.',
        comms.x, comms.z,
        [[comms.x, comms.z], [comms.x + 12, comms.z - 14], [comms.x - 16, comms.z + 8]]),

      F('Oyo Tannen',
        'A relentlessly cheerful plaza food vendor selling something he insists is noodles. He upsells constantly, invents new limited-edition flavours on the spot, and treats the two gateways mainly as a source of exotic ingredients.',
        -13, 19,
        [[-13, 19], [-4, 24], [-22, 12]]),

      F('Sparrow Nkemdi',
        'Maintenance engineer for the cargo yard, permanently covered in coolant and mildly annoyed at the universe. She explains catastrophic failures in a bored monotone and genuinely believes duct sealant can fix anything, including people.',
        cargo.x, cargo.z,
        [[cargo.x, cargo.z], [cargo.x - 18, cargo.z + 12], [cargo.x + 14, cargo.z - 10]]),

      F('Wen Halloway',
        'The station lore-keeper, an old wanderer who has stepped through both gateways more times than anyone alive and come back with stories nobody quite believes. He speaks in fragments of Ashfall legend and Meridian scoreboards, and he insists the portals are older than the station bolted around them.',
        6, -22,
        [[6, -22], [-6, -30], [16, -14], [0, -40]]),

      // The plaza is the busiest space on the ring and photographed empty. This
      // second rank of friendlies works the gateway queues, the stalls and the
      // commercial strip so the hero angles always have figures in them at
      // three different depths.
      F('Prue Okonkwo',
        'Gateway marshal on the plaza approach, running the queue for the Ashfall gate with a clipboard and zero patience for people who wander onto the dais. Brisk, fair, and secretly keeps a tally of who comes back through and who does not.',
        -8, 41,
        [[-8, 41], [8, 41], [0, 33], [-12, 36]]),

      F('Dr Ilse Varga',
        'Trauma physician from the Ring 7 clinic, on the plaza between shifts and permanently assessing everyone she meets for untreated injuries. Dry, direct, and describes appalling things in a reassuring voice.',
        18, 30,
        [[18, 30], [26, 20], [10, 34], [24, 34]]),

      F('Tobi Renner',
        'A dockhand apprentice killing time at the noodle stall, three months on the ring and still visibly amazed by the portals. Talks too fast, knows every rumour badly, and desperately wants to be taken seriously.',
        -19, 16,
        [[-19, 16], [-9, 22], [-24, 6], [-14, 26]]),

      F('Anselm Kade',
        'Freight broker working the plaza with a folding terminal and an unshakeable belief that everything is negotiable. Charming in a way that leaves you checking your pockets, and genuinely good at his job.',
        30, -12,
        [[30, -12], [20, -26], [36, 2], [24, -6]]),

      F('Nia Sorrel',
        'Sanitation tech on the plaza rotation, pushing a cart and unbothered by anything the station can produce. She has seen what comes out of the gateways at 04:00 and considers it a workload issue.',
        -30, -18,
        [[-30, -18], [-38, -4], [-22, -30], [-34, -26]]),

      F('Hask Merrow',
        'Runs the blade-sign shop halfway down the commercial strip, an ageing sign-painter who resents holograms on principle. Grumbles beautifully, and knows the name of every business that ever failed on this ring.',
        128, -22,
        [[128, -22], [112, -22], [144, -20], [120, -14]]),

      H(cargo.x + 26, cargo.z + 30, [[cargo.x + 26, cargo.z + 30], [cargo.x + 54, cargo.z + 12], [cargo.x + 30, cargo.z - 24]]),
      H(cargo.x - 34, cargo.z + 46, [[cargo.x - 34, cargo.z + 46], [cargo.x - 6, cargo.z + 58], [cargo.x - 48, cargo.z + 20]]),
      H(cargo.x + 8, cargo.z + 62, [[cargo.x + 8, cargo.z + 62], [cargo.x + 40, cargo.z + 52], [cargo.x - 14, cargo.z + 74]]),
      H(comms.x + 30, comms.z + 22, [[comms.x + 30, comms.z + 22], [comms.x + 56, comms.z - 6], [comms.x + 18, comms.z + 44]]),
      H(comms.x - 28, comms.z - 30, [[comms.x - 28, comms.z - 30], [comms.x - 52, comms.z - 8], [comms.x - 10, comms.z - 52]]),
      H(comms.x + 4, comms.z + 56, [[comms.x + 4, comms.z + 56], [comms.x + 34, comms.z + 68], [comms.x - 20, comms.z + 60]]),
      H(terrace.x - 30, terrace.z + 34, [[terrace.x - 30, terrace.z + 34], [terrace.x - 58, terrace.z + 16], [terrace.x - 18, terrace.z + 58]]),
      H(terrace.x - 52, terrace.z - 26, [[terrace.x - 52, terrace.z - 26], [terrace.x - 76, terrace.z - 2], [terrace.x - 34, terrace.z - 48]]),
      H(hangar.x + 46, hangar.z + 34, [[hangar.x + 46, hangar.z + 34], [hangar.x + 70, hangar.z + 8], [hangar.x + 30, hangar.z + 58]]),
      H(-140, -110, [[-140, -110], [-166, -78], [-118, -140]]),
    ];

    /* The zones' own characters, appended rather than authored above.
     *
     * `NPCManager.spawnForWorld` walks this array in order and stops at its
     * authored-friendly cap, so order is priority. The hub's cast comes first
     * because a player who never leaves the plaza should still meet the people
     * the plaza is about; the zone characters follow, and the manager's crowd
     * filler tops up whatever budget is left around whichever hub the player is
     * actually standing in. */
    for (const s of this._zoneNpcSpawns ?? []) this.npcSpawns.push(s);

    /* Bounds now describe the dome, not the hub.
     *
     * Six things read this and every one of them was wrong at the old +/-206:
     * the minimap baked a floorplan that stopped at the hull, `Relics` and
     * `Caches` threw their darts into a box that could not reach a zone,
     * `MountManager` clamped a flying mount to the hub's rim and told the player
     * they had reached the edge of the region 500 m early, and `Unstuck` took
     * its void floor from `min.y`.
     *
     * The top sits just UNDER the dome apex rather than above it. `MountManager`
     * clamps a mount's Y against `max.y`, and a ceiling above the roof is not a
     * ceiling: a dragon would climb to it straight through the glazing. The roof
     * is collided in bands now (see `buildGreatDome`) so this is only the
     * backstop, but the backstop has to be inside the building.
     */
    this.bounds = new THREE.Box3(
      new THREE.Vector3(-WORLD_R, -6, -WORLD_R),
      new THREE.Vector3(WORLD_R, DOME_APEX - 6, WORLD_R)
    );
  }

  _fillEnvironment() {
    const env = this.environment;
    env.background = new THREE.Color(0x02030a);
    env.fogColor = new THREE.Color(0x1a2a3d);
    /* Aerial perspective.
     *
     * fogNear 48 on a 220 m interior means the haze does not start accumulating
     * until well past the midground, so the 40 m plane and the 140 m plane
     * landed in the same value band and the image compressed into a single
     * tonal plate carried entirely by scale. Starting the ramp at 14 m and
     * closing it at 290 - roughly the far hull - is what actually separates the
     * near pillars from the far arcade. The colour is lifted and desaturated
     * toward the ceiling wash rather than sitting at near-black, because fog
     * that is darker than the geometry behind it reads as a vignette, not as
     * atmosphere.
     */
    env.fogNear = 14;
    /* Reaches the far side of the dome, not the far side of the hub.
     *
     * 290 was "roughly the far hull" and it was the right number for a world
     * that ended at 202 m. Under the dome the sightlines are seven times
     * longer - the great window now looks across half a kilometre of apron, and
     * standing in a zone's court you can see the hub's roofline - and at 290
     * every one of those views resolved to flat fog colour about a fifth of the
     * way out. The near end is unchanged, so the separation between the
     * foreground and the midground that the ramp was tuned for is untouched;
     * this only extends the tail so distance keeps reading as distance.
     */
    env.fogFar = 1450;
    /* Exposure and the fill stack.
     *
     * Round 3 shipped two frames that do not look like the same renderer: the
     * gateway wide read mid-slate, the street-level plaza read paper. The cause
     * was not the grade, it was the *sum of the fill terms* - ambient 0.8 plus
     * hemisphere 1.2 with a bright warm ground bounce is ~2.0 units of
     * omnidirectional light arriving on every up-facing deck plate, and the
     * deck is the surface that fills the bottom 55% of a street-level frame.
     * Everything the four hand-placed shaping lights were doing was buried
     * under it, so the "key/fill/rim" rig photographed as a flat ambient dome
     * and the plaza clipped.
     *
     * The rule the rest of this file is now tuned against: ambient + hemi must
     * stay under ~1.0 combined so that a lit plate lands mid-grey and the
     * spots, the window rake and the practicals own the top two stops.
     *
     * Round 4 goes one step further, because "under 1.0 combined" was still
     * measured against nothing: with the shadow-casting spots contributing
     * under a unit at the deck, ambient + hemi + rim + counter + practicals
     * *were* the lighting and the two shadow maps were decoration. The fill is
     * now roughly half what it was and the single directional key in
     * `_buildLights` carries the top two stops on its own, which is the only
     * arrangement in which a cast shadow is visible at all.
     */
    /* Down a touch from 0.62 because the fill went up.
     *
     * Raising ambient and hemisphere to reopen the crushed shadows also lifts
     * everything already near the top of the curve - the hazard paint and the
     * chevron runs were the first things to clip. Trading a third of a stop of
     * exposure for the fill lift compresses the image toward the middle, which
     * is the whole point: a shipped frame has recoverable detail at both ends,
     * not neon against void. */
    env.exposure = 0.575;
    /* The shadow floor.
     *
     * Round 4 pulled the fill so far down that the columns, the gantry soffit
     * and the whole left wall below the trim clipped to RGB 8-14 with nothing
     * recoverable in them - a two-value image of neon lines against void. A
     * shipped frame carries bounce into shadow so structure stays legible. This
     * is the smallest lift that reopens those regions without giving the key
     * anything meaningful to out-shout: ambient +0.05, hemisphere +0.10, and a
     * sky colour with enough chroma that the lift reads as reflected light
     * rather than as a grey wash.
     */
    env.ambientColor = new THREE.Color(0x46617d);
    env.ambientIntensity = 0.20;
    env.skyColor = new THREE.Color(0x54759c);
    /* Ground bounce.
     *
     * A hemisphere light mixes sky and ground by dot(N, up), so this term is
     * what a *vertical* face gets from below and what an up-facing face gets
     * nothing of. It has to be a plausible bounce off a dark painted deck, not
     * a second key: 0x6b5c46 at intensity 1.2 was pumping roughly a third of a
     * stop of warm energy into every surface in the world and is the reason the
     * blowout photographed cream rather than neutral.
     */
    env.groundColor = new THREE.Color(0x352f27);
    // Hemisphere still carries more of the fill than ambient does - it is
    // directional, so it separates up-facing from down-facing geometry instead
    // of flattening everything - but at a level a key light can beat.
    env.hemiIntensity = 0.36;
    env.sunColor = new THREE.Color(0xdcefff);
    /* The scene sun is main.js's, and main.js aims its shadow frustum at the
     * player. On a pressurised interior that is the worst of both worlds: the
     * hull occludes it entirely within 60 m of the camera and it lights every
     * district beyond 60 m at full strength, so the deck the player is standing
     * on was the darkest plate in the ring and the far side of the world was
     * the brightest. Run it as a whisper of skylight through the oculus and let
     * the world's own directional key (see _buildLights) do the modelling.
     */
    env.sunIntensity = 0.8;
    // Matched to the deck key so the world tells one story about where the
    // light comes from - raked in from the window wall on +X/+Z.
    env.sunDirection = new THREE.Vector3(0.45, 0.62, 0.64).normalize();
    // A 200 m deck with a full-strength starfield probe on it is a mirror, and
    // an unshadowed one: IBL is the other term a cast shadow has to beat.
    env.envMapIntensity = 0.68;
    // NOTE: there is deliberately no `env.bloom` here. It was a second,
    // competing declaration at threshold 1.05 - below the luminance of a lit
    // deck plate, so under any code path that consumed it every panel in the
    // frame glowed. Bloom is owned by `env.grade.bloom` below, in the linear
    // HDR units the bright pass actually measures.
    env.grade = {
      // Warm highlights against cool shadows. The previous grade tinted both
      // ends blue, which is why the frame read as a single-hue image with two
      // accent lights in it and no colour script.
      contrast: 1.16,
      saturation: 1.2,
      /* The toe pedestal is *absolute* (PostFX passes `lift` through without
       * luminance-normalising it), and 0x111a26 is roughly three times the
       * station preset's own value. That is a global shadow lift of ~0.02 in
       * linear, which is exactly why the plaza deck had no local contrast and
       * why the frame read milky: the black point never closed. This value
       * still keeps information in the grate and the under-gantry shadow
       * without turning the whole lower third into one value band. */
      lift: new THREE.Color(0x080d15),
      // Gain is luma-normalised into a pure tint by PostFX, so this only steers
      // hue - but a hard warm gain on top of an already-hot highlight is what
      // made the blown region cream instead of neutral. Pulled most of the way
      // back; the split-tone below still carries the warm highlight story.
      gain: new THREE.Color(0xfff1e0),
      shadowTint: new THREE.Color(0x9ec2ff),
      highlightTint: new THREE.Color(0xffd8ac),
      split: 0.44,
      // Both of these were fighting the frame rather than finishing it: a 0.34
      // vignette on an image whose corners already fall off crushes readable
      // structure, and 0.0017 of chroma separation is visible as red/cyan
      // fringing on every high-contrast edge near the frame border.
      vignette: 0.24,
      chromatic: 0.0007,
      grain: 0.02,
      // Bloom in linear-HDR terms. Threshold raised well clear of anything a
      // practical puts on a nearby surface and the radius pulled in hard: a
      // wide, strong halo is what turned every lamp head, the portal base and
      // the yellow strip lights into featureless paper-white discs with no
      // filament, no fixture and no core left inside them. At 0.28/0.42/5.0
      // only true emitters bloom, and they keep their shape while doing it.
      bloom: { strength: 0.28, radius: 0.42, threshold: 5.0 },
    };

    // A cheap PMREM of the starfield + window glow so every metal surface has
    // something plausible to reflect.
    try {
      const renderer = this.engine?.renderer;
      if (renderer) {
        const envScene = new THREE.Scene();
        const shell = new THREE.Mesh(
          new THREE.SphereGeometry(60, 24, 16),
          new THREE.MeshBasicMaterial({ map: this._tex.stars, side: THREE.BackSide })
        );
        envScene.add(shell);
        // The window wall and the overhead light banks are the only real
        // sources of reflected energy inside the ring; without them every
        // metal surface would resolve to black.
        const glow = new THREE.Mesh(
          new THREE.PlaneGeometry(90, 46),
          new THREE.MeshBasicMaterial({ color: 0xcfe6ff })
        );
        glow.position.set(40, 5, 0);
        glow.rotation.y = -Math.PI / 2;
        envScene.add(glow);
        const ceilingWash = new THREE.Mesh(
          new THREE.PlaneGeometry(140, 140),
          new THREE.MeshBasicMaterial({ color: 0x6d8296 })
        );
        ceilingWash.position.y = 30;
        ceilingWash.rotation.x = Math.PI / 2;
        envScene.add(ceilingWash);
        const floorWash = new THREE.Mesh(
          new THREE.PlaneGeometry(140, 140),
          new THREE.MeshBasicMaterial({ color: 0x2b3644 })
        );
        floorWash.position.y = -20;
        floorWash.rotation.x = -Math.PI / 2;
        envScene.add(floorWash);
        const amberWash = new THREE.Mesh(
          new THREE.PlaneGeometry(50, 24),
          new THREE.MeshBasicMaterial({ color: 0x8a5a28 })
        );
        amberWash.position.set(-40, 2, 0);
        amberWash.rotation.y = Math.PI / 2;
        envScene.add(amberWash);

        const pmrem = new THREE.PMREMGenerator(renderer);
        const rt = pmrem.fromScene(envScene, 0.04, 1, 200);
        env.envMap = rt.texture;
        this._envRT = rt;
        pmrem.dispose();
        for (const m of [shell, glow, ceilingWash, floorWash, amberWash]) {
          m.geometry.dispose();
          m.material.dispose();
        }
      }
    } catch (err) {
      console.warn('[StationWorld] environment map generation skipped:', err?.message ?? err);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Per-frame animation                                               */
  /* ---------------------------------------------------------------- */

  /**
   * Only world-owned animation lives here. Everything reuses module scratch,
   * so a frame in the station allocates nothing.
   */
  update(dt, elapsed, motion = 0) {
    const A = this._anim;

    // Amortised shadow refresh (see _buildLights). The plaza key light is a
    // fixed full-deck caster, so a character running or strafing through it
    // leaves a stepped "trail" silhouette whenever the map refreshes only a few
    // times a second. The stepping is only ever visible while something is
    // actually moving fast, so refresh every frame while the player is moving
    // and fall back to a cheap idle cadence (~16 Hz) when the deck is calm.
    if (this._keyLight) {
      const sh = this._keyLight.shadow;
      // Warm-up: render every frame until the map is known good, so nothing is
      // ever photographed floating on an empty shadow map.
      if (this._shadowWarm < 1.0) {
        this._shadowWarm += dt;
        sh.needsUpdate = true;
      } else {
        this._keyShadowT += dt;
        // ~2.4 m/s sits just above a walk, so a jog or sprint pins the map to
        // per-frame while standing still keeps the cheap idle refresh.
        const interval = motion > 2.4 ? 0 : 0.06;
        if (this._keyShadowT >= interval) {
          this._keyShadowT = 0;
          sh.needsUpdate = true;
        }
      }
    }

    // Dust crawl inside the light shafts - both the lamp cones and the big
    // overhead ones compile the same shader but get their own uniform block.
    const shaftSets = this._shaftUniformSets;
    if (shaftSets) for (let i = 0; i < shaftSets.length; i++) shaftSets[i].uShaftTime.value = elapsed;

    // Monument hologram: slow counter-rotating rings with a gentle bob.
    if (A.holoCore) {
      A.holoCore.rotation.y += dt * 0.35;
      A.holoCore.rotation.x = Math.sin(elapsed * 0.4) * 0.12;
    }
    for (let i = 0; i < A.holoRings.length; i++) {
      const r = A.holoRings[i];
      r.obj.rotation.y += dt * r.speed;
      if (r.bob) r.obj.position.y = Math.sin(elapsed * 0.7 + i) * 0.14;
    }

    // Holographic advertising: sweep about the plaza-facing yaw, breathe, and
    // occasionally glitch. A full rotation would swing the plate edge-on and
    // then present its reverse - clamping the sweep keeps it legible.
    for (let i = 0; i < A.ads.length; i++) {
      const ad = A.ads[i];
      ad.pivot.rotation.y = ad.baseYaw + Math.sin(elapsed * ad.speed + ad.phase) * ad.sweep;
      const flick = Math.sin(elapsed * 7 + ad.phase);
      ad.mat.opacity = 0.55 + 0.14 * Math.sin(elapsed * 1.6 + ad.phase) + (flick > 0.985 ? -0.4 : 0);
    }

    // Beacons on the control tower and a failing ballast in the habitat block.
    for (let i = 0; i < A.beacons.length; i++) {
      const s = 0.6 + 0.7 * Math.pow(Math.max(0, Math.sin(elapsed * 2.4)), 4);
      A.beacons[i].scale.setScalar(s);
      if (A.beaconLights[i]) A.beaconLights[i].intensity = 300 + 1400 * Math.pow(Math.max(0, Math.sin(elapsed * 2.4)), 4);
    }
    for (let i = 0; i < A.flicker.length; i++) {
      const n = Math.sin(elapsed * 37.3 + i) * Math.sin(elapsed * 11.1);
      A.flicker[i].intensity = n > 0.72 ? 260 : 1500;
    }

    // Far traffic drifting past the window.
    for (let i = 0; i < A.ships.length; i++) {
      const s = A.ships[i];
      s.t += dt * s.speed;
      if (s.t > s.span) s.t -= s.span;
      s.obj.position.copy(s.origin).addScaledVector(s.dir, s.t - s.span * 0.5);
    }
    if (A.farStation) A.farStation.rotation.z += dt * 0.045;
    if (A.planet) A.planet.rotation.y += dt * 0.006;

    // Service drones on slow horizontal orbits through the upper volume.
    if (A.droneMesh) {
      for (let i = 0; i < A.drones.length; i++) {
        const d = A.drones[i];
        d.phase += dt * d.speed;
        const x = Math.cos(d.phase) * d.r;
        const z = Math.sin(d.phase) * d.r;
        const y = d.y + Math.sin(elapsed * 0.4 + i) * 0.9;
        _dummy.position.set(x, y, z);
        _dummy.rotation.set(0, -d.phase + (d.speed < 0 ? Math.PI : 0), 0);
        _dummy.scale.setScalar(1);
        _dummy.updateMatrix();
        A.droneMesh.setMatrixAt(i, _dummy.matrix);
        if (A.droneLights) {
          _dummy.position.y = y - 0.34;
          _dummy.rotation.set(0, 0, 0);
          _dummy.updateMatrix();
          A.droneLights.setMatrixAt(i, _dummy.matrix);
        }
      }
      A.droneMesh.instanceMatrix.needsUpdate = true;
      if (A.droneLights) A.droneLights.instanceMatrix.needsUpdate = true;
    }
    if (A.dockArm) A.dockArm.rotation.z = Math.sin(elapsed * 0.13) * 0.012;

    // Hangar crane creeps along its bridge.
    if (A.craneHook) {
      const x = Math.sin(elapsed * 0.14) * 14;
      const drop = 6 + Math.sin(elapsed * 0.21) * 2.4;
      A.craneHook.trolley.position.x = x;
      A.craneHook.cable.position.x = x;
      A.craneHook.hook.position.x = x;
      A.craneHook.cable.position.y = A.craneHook.trolley.position.y - drop / 2 - 0.9;
      A.craneHook.cable.scale.y = drop / 8;
      A.craneHook.hook.position.y = A.craneHook.trolley.position.y - drop - 1.4;
    }

    // Steam puffs: rise, expand and fade, then recycle.
    const steam = A.steam;
    if (steam) {
      const seeds = A.steamSeeds;
      const vents = seeds.length / 4;
      let idx = 0;
      for (let v = 0; v < vents; v++) {
        const vx = seeds[v * 4];
        const vz = seeds[v * 4 + 1];
        const phase = seeds[v * 4 + 2];
        const rate = seeds[v * 4 + 3];
        for (let k = 0; k < 4; k++) {
          const t = ((elapsed * rate * 0.35 + phase + k * 0.25) % 1);
          const s = 0.5 + t * 3.4;
          _dummy.position.set(vx + Math.sin(phase + t * 3) * t * 1.2, 0.5 + t * 5.5, vz + Math.cos(phase * 1.7 + t * 2) * t * 1.0);
          _dummy.rotation.set(0, 0, phase + t * 1.4);
          _dummy.scale.set(s, s, s);
          _dummy.updateMatrix();
          steam.setMatrixAt(idx, _dummy.matrix);
          const fade = Math.sin(t * Math.PI) * 0.5;
          _col.setRGB(fade * 0.7, fade * 0.82, fade);
          steam.setColorAt(idx, _col);
          idx++;
        }
      }
      steam.instanceMatrix.needsUpdate = true;
      steam.instanceColor.needsUpdate = true;
    }

    // Light shafts breathe very slightly so they never look like static cones.
    if (A.shafts) A.shafts.material.opacity = 0.10 + Math.sin(elapsed * 0.5) * 0.022;

    /* Ambient crowd.
     *
     * Static figures at the right density would already fix the scale read, but
     * a station full of statues is its own tell. Each instance breathes, shifts
     * weight and sways on its own phase - no pathing, no collision, no per-frame
     * allocation, and the whole crowd stays one draw call. Only a sixth of the
     * roster is touched per frame, so the matrix upload cost is amortised.
     */
    const crowdMeshes = A.crowdMeshes;
    if (crowdMeshes) {
      const base = A.crowdBase;
      const from = (A.crowdCursor | 0) % 6;
      A.crowdCursor = (from + 1) % 6;
      for (let m = 0; m < crowdMeshes.length; m++) {
        const cm = crowdMeshes[m];
        const idx = cm.idx;
        for (let j = from; j < idx.length; j += 6) {
          const i = idx[j];
          const ph = A.crowdPhase[i];
          const t = elapsed * 0.9 + ph;
          const s = base[i * 4 + 3];
          // Seated figures keep the breathing and lose the drift: a bench that
          // its occupant slides along reads worse than a static one.
          const anchored = A.crowdSeated && A.crowdSeated[i] ? 0.12 : 1;
          // Breathing + weight shift: a few centimetres, which is all it takes.
          const bob = Math.sin(t * 1.7) * 0.018 + Math.sin(t * 0.43) * 0.012;
          _dummy.position.set(
            base[i * 4] + Math.sin(t * 0.31 + ph) * 0.09 * anchored,
            base[i * 4 + 1] + bob,
            base[i * 4 + 2] + Math.cos(t * 0.27 + ph * 1.3) * 0.09 * anchored
          );
          _dummy.rotation.set(0, A.crowdYaw[i] + Math.sin(t * 0.22 + ph) * 0.34 * anchored, 0);
          _dummy.scale.set(s, s * (1 + Math.sin(t * 1.7) * 0.006), s);
          _dummy.updateMatrix();
          cm.mesh.setMatrixAt(j, _dummy.matrix);
        }
        cm.mesh.instanceMatrix.needsUpdate = true;
      }
    }

    /* The outer ring's population. Unlike the plaza crowd above, these figures
     * are articulated - a dozen instanced meshes posed from a joint chain - so
     * they cannot be amortised round-robin the way the crowd is. A hammer arm
     * travels seven centimetres a frame; hold it for five and release it and
     * the result reads as a dropped frame, not as economy. `StationActors`
     * culls by distance instead, which is why it wants the camera. */
    if (this._actors) {
      this._actors.setCamera(this.engine?.camera?.position ?? null);
      this._actors.update(dt, elapsed);
    }

    this._runEscalators(dt, elapsed);
    this._moveOnSurfaces(dt);
  }

  /* ---------------------------------------------------------------- */
  /* Moving surfaces                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * Scroll every escalator's treads.
   *
   * The treads are instanced boxes that slide along their own slope and wrap,
   * rather than a scrolling texture on the tread material. That is not a
   * stylistic choice: `M.chrome` is shared with every handrail, fitting and
   * machine face on the map, so animating its `map.offset` would set the entire
   * station sliding.
   */
  _runEscalators(dt, elapsed) {
    const banks = this._escalators;
    if (!banks?.length) return;
    const cam = this.engine?.camera?.position;

    for (const bank of banks) {
      // A staircase 300 m away is four pixels tall; moving its steps costs a
      // matrix upload per tread and buys nothing.
      if (cam) {
        const m = bank.mesh.position;
        const dx = cam.x - m.x, dz = cam.z - m.z;
        if (dx * dx + dz * dz > 160 * 160) continue;
      }
      const travel = (elapsed * bank.speed) % 1e6;
      for (const r of bank.runs) {
        for (let i = 0; i < r.count; i++) {
          // Wrap on the slope length so a tread leaving the head reappears at
          // the comb plate, which is what a real escalator's return loop does.
          const s = (((i / r.count) * r.len + travel) % r.len + r.len) % r.len;
          const f = s / r.len;
          _dummy.position.set(r.lane, r.y0 + r.rise * f + 0.06, r.z0 + r.dir * r.runH * f);
          _dummy.rotation.set(r.pitch, 0, 0);
          _dummy.scale.set(1, 1, 1);
          _dummy.updateMatrix();
          bank.mesh.setMatrixAt(r.first + i, _dummy.matrix);
        }
      }
      bank.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * Carry the player along a travelator or up an escalator.
   *
   * ── Why this is a position nudge and not a velocity ───────────────────────
   * `Player` owns its own velocity and rewrites it from input every frame, so
   * anything added to it is gone before it is integrated. A displacement
   * applied after the player has already resolved for the frame survives, and
   * is corrected by the capsule solver on the next one - at 1.6 m/s that is
   * 2.7 cm of overlap in the worst case, which is well inside what the solver
   * pushes out without the player ever seeing it.
   *
   * ── Why the tests are so fussy ────────────────────────────────────────────
   * Both surfaces are things you can also walk *beside*, *under* and *along the
   * rail of*. A footprint test alone carries somebody standing on the handrail
   * of a travelator, and a height test alone carries somebody on the floor
   * below an escalator. Each needs the plate's own frame, its width, and a
   * height band that starts just under the surface and stops at head height.
   */
  _moveOnSurfaces(dt) {
    const p = this.ctx?.player?.position;
    if (!p) return;

    for (const b of this._travelators ?? []) {
      const dx = p.x - b.x, dz = p.z - b.z;
      const along = dx * b.dx + dz * b.dz;
      const across = -dx * b.dz + dz * b.dx;
      if (Math.abs(along) > b.halfLong || Math.abs(across) > b.halfWide) continue;
      if (p.y < b.top - 0.35 || p.y > b.top + 2.4) continue;
      // 1.6 m/s: a shade under a walking pace, so walking with the belt feels
      // fast and walking against it feels like wading rather than a wall.
      const v = 1.6 * dt;
      p.x += b.dx * v;
      p.z += b.dz * v;
      return;
    }

    for (const bank of this._escalators ?? []) {
      for (const r of bank.runs) {
        const a = r.world.a, c = r.world.b;
        const ax = c.x - a.x, az = c.z - a.z;
        const len = Math.hypot(ax, az);
        if (len < 0.01) continue;
        const ux = ax / len, uz = az / len;
        const dx = p.x - a.x, dz = p.z - a.z;
        const t = dx * ux + dz * uz;
        if (t < -0.4 || t > len + 0.4) continue;
        if (Math.abs(-dx * uz + dz * ux) > r.world.halfW) continue;
        const slope = (c.y - a.y) / len;
        const surfaceY = a.y + slope * Math.min(Math.max(t, 0), len);
        if (p.y < surfaceY - 0.35 || p.y > surfaceY + 2.6) continue;

        /* Carry the rider the way a moving platform carries one: advance them
         * along the flight and then PUT them on the tread, rather than nudging
         * and hoping.
         *
         * Two earlier versions of this failed in the same place for the same
         * underlying reason. Applying only a horizontal push wedged the capsule
         * against the 30-degree face, because a player standing still on an
         * escalator has no velocity of their own and the solver's only possible
         * response to being pushed into a slope is to push back. Adding the
         * vertical component as an increment did not fix it either: the lift is
         * about 5 mm a frame, comfortably inside the distance the solver moves
         * a capsule that is intersecting the ramp, so it was cancelled as fast
         * as it was applied. A rider reached 2.84 m of the 4.80 they should,
         * both times, and then sat there.
         *
         * Assigning the height removes the argument. It is also what the lift
         * in `Interiors` already does with `setBoxColliderY`, so the two moving
         * things in this world now work the same way.
         *
         * The snap only applies to somebody actually standing on the flight -
         * within 0.9 m of the tread - so jumping off, or being thrown clear,
         * still behaves normally.
         */
        const v = bank.speed * dt;
        p.x += ux * v;
        p.z += uz * v;
        const t2 = Math.min(Math.max(t + v, 0), len);
        const nextY = a.y + slope * t2;
        if (p.y < nextY + 0.9) p.y = Math.max(p.y, nextY + 0.02);
        return;
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Teardown                                                          */
  /* ---------------------------------------------------------------- */

  /** Re-arm the amortised key shadow so it is correct on the first frame back. */
  onActivate() {
    super.onActivate();
    if (this._keyLight) {
      this._keyLight.shadow.needsUpdate = true;
      this._keyShadowT = 0;
      this._shadowWarm = 0;
    }
  }

  dispose() {
    super.dispose();
    /* Before `super.dispose()`'s traverse would have been wrong and after it is
     * fine: `StationActors` owns geometries the traverse never reaches, because
     * they are shared between its left and right limb meshes and disposing a
     * mesh twice is what leaves a dangling buffer. It does not own its
     * materials - those are this world's, and are disposed below. */
    this._actors?.dispose?.();
    this._actors = null;
    this._travelators.length = 0;
    this._escalators.length = 0;
    this._roofs.length = 0;
    this._keyLight = null;
    this._fillLight = null;
    this._shaftUniforms = null;
    this._anim.crowdMeshes = null;
    this._anim.crowdPhase = null;
    this._anim.crowdBase = null;
    this._anim.crowdYaw = null;
    this._anim.crowdSeated = null;
    this._shaftUniformSets = null;
    for (const t of this._textures) t.dispose?.();
    this._textures.length = 0;
    this._envRT?.dispose?.();
    this._envRT = null;
    for (const key in this.mat) this.mat[key]?.dispose?.();
    this.mat = {};
    this._anim.holoRings.length = 0;
    this._anim.ads.length = 0;
    this._anim.ships.length = 0;
    this._anim.beacons.length = 0;
    this._anim.beaconLights.length = 0;
    this._anim.flicker.length = 0;
    this._anim.steam = null;
    this._anim.shafts = null;
  }
}

/** Hand a frame back to the browser so the loading bar can animate. */
function yieldFrame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}
