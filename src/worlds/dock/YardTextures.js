import * as THREE from 'three';
import { tfbm, mulberry32 } from '../station/StationKit.js';

/**
 * LODESTAR YARD — the surface set.
 *
 * ── Why the yard paints its own tiles instead of importing the station's ──
 * `StationWorld.js` has a first-rate painter set and every one of them is
 * module-private. Exporting them would drag an 11,000-line world module into
 * the dock's import graph and into every headless test that builds the dock,
 * for six canvases. So the TECHNIQUE is lifted verbatim — three canvases per
 * surface (albedo / height / roughness), a Sobel of the height canvas into a
 * tangent-space normal, wear and grain passes over the top, and every feature
 * authored against a 512 px reference and scaled by `k` so raising the
 * resolution buys texels per rib and not more ribs — and the CONTENT is the
 * yard's own. A shipyard is not a concourse: the plate is heavier and the paint
 * is chalk and stencil rather than wayfinding vinyl.
 *
 * This header used to add "and the whole set runs about fifteen points darker
 * so the sodium worklights have somewhere to land", and that sentence cost the
 * world its legibility - fifteen sRGB points at these plate values is a factor
 * of two in the linear space where albedo is actually multiplied. Every albedo
 * canvas now passes through `ALBEDO_GAMMA`, which is calibrated against a
 * rendered measurement rather than against a display-space intuition. Read that
 * note before darkening anything here.
 *
 * ── The budget this file is written against ───────────────────────────────
 * Eight tiled keys at 1024 px, normal strength <= 1.6, and the sign sheet at
 * 1024 x 1536 (4 x 4 cells of 256 x 384). The station's sheet is 3072 x 4224
 * and costed in-comment at 28 MB for 28 signs; the yard has sixteen and does
 * not need a row it cannot fill. A 512 tile with a strong normal repeated
 * twenty times boils at grazing angles, which is why nothing here is 512
 * except the two surfaces that are never seen at a grazing angle (tarp, crate).
 */

/* ------------------------------------------------------------------ */
/* Canvas plumbing                                                     */
/* ------------------------------------------------------------------ */

export function makeCanvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function ctx2d(canvas) {
  const c = canvas.getContext('2d', { willReadFrequently: true });
  c.imageSmoothingEnabled = true;
  return c;
}

/**
 * Wrap a canvas as a texture. Tiling is baked into the GEOMETRY's uvs, never
 * into `repeat`, so meshes of different sizes still share one material and
 * therefore still merge into one draw call.
 */
export function canvasTexture(canvas, srgb, aniso) {
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

/** Sobel a greyscale height canvas into a tangent-space normal map. */
export function normalFromHeight(heightCanvas, strength, aniso) {
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
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= inv; ny *= inv;
      const i = (y * S + x) * 4;
      dst[i] = (nx * 0.5 + 0.5) * 255;
      dst[i + 1] = (ny * 0.5 + 0.5) * 255;
      dst[i + 2] = (inv * 0.5 + 0.5) * 255;
      dst[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return canvasTexture(out, false, aniso);
}

/**
 * Multiply tileable fbm grain over an already-painted canvas.
 *
 * ── Why the noise is evaluated on a coarse lattice ────────────────────────
 * The obvious version calls `tfbm` once per pixel, and `tfbm` is four octaves
 * of four hashes each. At 1024 px that is a million calls per surface and it
 * measured as the single largest cost in this file: 802 ms of an 1,008 ms
 * build, against a 400 ms texture budget.
 *
 * But the grain's own period is `scale` cycles across the whole tile — 14 to
 * 24 here — so its highest frequency is one cycle every ~43 px at 1024. A
 * lattice at `STEP` = 4 px is still ten samples per cycle, an order of
 * magnitude inside Nyquist, and bilinear interpolation between them is exactly
 * what the GPU would do to the same field anyway. Measured on the same
 * machine: 802 ms -> 214 ms for the whole texture phase, with no visible
 * difference in the field it produces (the ONLY thing that changes is that
 * per-pixel hash noise, which this never had, would be lost).
 *
 * ── What that number does and does not include ───────────────────────────
 * Both figures are HEADLESS, taken in node against the stub 2D context the
 * `dock-*` tests install, and they measure the JavaScript in this file - this
 * lattice, `normalFromHeight`'s Sobel, and the per-pixel loops - and nothing
 * else. Instrumented on the current tree, one full `buildYardTextures` costs
 * 329 ms headless while issuing 12,513 `beginPath`, 11,174 `arc`, 11,148
 * `fill` and 5,891 `fillRect` calls that the stub returns `undefined` for, and
 * ten 1024x1024 `getImageData` readbacks that cost nothing here and are a
 * GPU->CPU sync in a browser. So this is a floor on the real cost and a fair
 * instrument for a REGRESSION in the JS, which is what it is used for; it is
 * not the browser figure, and the 400 ms design budget is a browser budget.
 * Quote it as headless wherever it is quoted.
 *
 * The lattice wraps at `S / STEP`, so the tile still tiles.
 *
 * ── It is also where the albedo set is CALIBRATED ─────────────────────────
 * See `ALBEDO_GAMMA`. Every one of the eight tiled painters ends with a call
 * to this function and passes its ALBEDO canvas (the height and roughness
 * canvases never come through here), so this is the one place every albedo
 * texel in the yard is guaranteed to pass through exactly once. The transfer
 * costs one 256-entry table lookup per channel inside a loop that was already
 * reading and writing every pixel.
 */
const GRAIN_STEP = 4;

/**
 * THE YARD'S ALBEDO TRANSFER, AND THE DEFECT IT CORRECTS.
 *
 * The file header used to say the set "runs about fifteen points darker" than
 * the station's so the sodium worklights have somewhere to land. Fifteen
 * points is an sRGB DISPLAY figure; the multiply that decides how much light a
 * surface returns happens in LINEAR space, and down at the plate values this
 * set is painted at, fifteen sRGB points is very nearly a factor of two. It
 * then compounded with a base tint in `buildYardMaterials` that was darkened
 * for the same reason and measured in the same wrong units.
 *
 * Measured, in the browser, at `VIEWS.dock` `berth-b1`, by rendering the yard's
 * own geometry under the yard's own lights twice - once with its own materials
 * and once with a neutral white `MeshStandardMaterial` - and taking the ratio
 * of the mean frame luminance. That ratio IS the reflectance of the world as
 * rendered, and it is the only number here that does not depend on how bright
 * the lamps happen to be:
 *
 *     station  plaza-wide 0.253   street-level 0.430   district-east 0.229
 *     yard     berth-b1   0.061   datum        0.071   gantry-crossing 0.053
 *
 * The yard returned a QUARTER of what its sibling returns. A 2.7% surface is
 * darker than charcoal, and no lamp fixes it: flooding ambient from 0.22 to
 * 6.0 - twenty-seven times - moved the frame's mean luminance from 8.4 to 9.4,
 * because there was nothing there to reflect it.
 *
 * The two halves, measured by ablation on the same framing with a direct
 * `renderer.render` (mean frame luma, 0-255):
 *
 *     as authored                              4.68
 *     every `map` removed                     32.91    <- the albedo maps, 7.0x
 *     every `normalMap` removed                4.75    <- normal maps, 1.5%
 *     every material `color` set to white      8.67    <- the tints, 1.85x
 *     neutral white MeshStandardMaterial      77.75    <- the reference
 *
 * `ALBEDO_GAMMA` is applied to every albedo texel and lifts the mid-tones
 * while leaving 0 and 255 exactly where they were, so the paint, the oil
 * blooms and the chalk keep their relationship to each other and only the
 * overall reflectance moves. Calibrated against the station's own albedo set,
 * whose maps average 0.241 mean linear luminance against this set's 0.067
 * before the transfer.
 */
export const ALBEDO_GAMMA = 0.52;

/**
 * The transfer itself, on 0-255 sRGB display values, exported so a test can
 * assert what this set's authored plate values actually reflect rather than
 * asserting that a constant has a particular value. Headless builds get a stub
 * 2D context whose `getImageData` returns zeros, so the painted canvases cannot
 * be measured under `node --test`; the authored literals and this function can.
 */
export function albedoLift(v) {
  return Math.round(255 * Math.pow(Math.max(0, Math.min(255, v)) / 255, ALBEDO_GAMMA));
}

/** 256-entry transfer, built once. `i -> 255 * (i/255) ** ALBEDO_GAMMA`. */
const ALBEDO_LUT = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) t[i] = Math.round(255 * Math.pow(i / 255, ALBEDO_GAMMA));
  return t;
})();

function grain(cx, amount, scale, seed, tintR = 1, tintG = 1, tintB = 1) {
  const S = cx.canvas.width, T = cx.canvas.height;
  const img = cx.getImageData(0, 0, S, T);
  const d = img.data;
  const period = Math.max(2, Math.round(scale));
  const gw = Math.max(2, Math.ceil(S / GRAIN_STEP));
  const gh = Math.max(2, Math.ceil(T / GRAIN_STEP));
  // One extra row and column so the last cell has a far corner to lerp to,
  // wrapped back to the first so the seam is continuous.
  const lat = new Float32Array((gw + 1) * (gh + 1));
  for (let j = 0; j <= gh; j++) {
    for (let i = 0; i <= gw; i++) {
      lat[j * (gw + 1) + i] = tfbm(((i % gw) / gw) * scale, ((j % gh) / gh) * scale, period, seed, 4);
    }
  }
  for (let y = 0; y < T; y++) {
    const fy = (y / T) * gh;
    const j0 = Math.floor(fy);
    const ty = fy - j0;
    const row0 = j0 * (gw + 1);
    const row1 = (j0 + 1) * (gw + 1);
    for (let x = 0; x < S; x++) {
      const fx = (x / S) * gw;
      const i0 = Math.floor(fx);
      const tx = fx - i0;
      const a = lat[row0 + i0], b = lat[row0 + i0 + 1];
      const c = lat[row1 + i0], e = lat[row1 + i0 + 1];
      const n = (a + (b - a) * tx) * (1 - ty) + (c + (e - c) * tx) * ty;
      const f = 1 + (n - 0.5) * 2 * amount;
      const i = (y * S + x) * 4;
      /* Grain first, then the calibration transfer - in that order, because
       * the grain is a MULTIPLY on reflectance and applying it after the
       * transfer would make its depth depend on the transfer's slope. */
      d[i] = ALBEDO_LUT[Math.max(0, Math.min(255, Math.round(d[i] * f * tintR)))];
      d[i + 1] = ALBEDO_LUT[Math.max(0, Math.min(255, Math.round(d[i + 1] * f * tintG)))];
      d[i + 2] = ALBEDO_LUT[Math.max(0, Math.min(255, Math.round(d[i + 2] * f * tintB)))];
    }
  }
  cx.putImageData(img, 0, 0);
}

/**
 * Scratches, drag marks and weld spatter — the difference between CG and used.
 *
 * Biased harder into ROUGHNESS than into albedo, for the reason the station's
 * deck records: polished-through paint changes how a plate answers light long
 * before it changes what colour the plate is, and a wear pass that only moves
 * albedo reads as dirt printed on a clean surface.
 */
function wear(a, h, r, S, rng, o = {}) {
  const k = S / 512;
  a.save();
  for (let i = 0; i < (o.streaks ?? 70); i++) {
    const x = rng() * S, y = rng() * S;
    const len = 8 * k + rng() * (S * 0.4);
    const w = (0.6 + rng() * 2.6) * k;
    const dark = rng() < 0.7;
    a.globalAlpha = 0.03 + rng() * 0.1;
    a.fillStyle = dark ? '#090b0e' : '#9fabb9';
    a.fillRect(x, y, w, len);
    r.globalAlpha = 0.07 + rng() * 0.12;
    r.fillStyle = dark ? '#ffffff' : '#3e3e3e';
    r.fillRect(x, y, w, len);
    r.globalAlpha = 1;
  }
  for (let i = 0; i < (o.scratches ?? 60); i++) {
    const x = rng() * S, y = rng() * S;
    const ang = rng() * Math.PI * 2;
    const len = (6 + rng() * 46) * k;
    a.globalAlpha = 0.09 + rng() * 0.17;
    a.strokeStyle = '#c4d1de';
    a.lineWidth = (0.7 + rng() * 0.9) * k;
    a.beginPath();
    a.moveTo(x, y);
    a.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    a.stroke();
    h.globalAlpha = 0.28;
    h.strokeStyle = '#9c9c9c';
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

/** Bolt head: bevel in height, specular pip in roughness. */
function bolt(a, h, r, x, y, rad, tint = '#8b96a3') {
  a.fillStyle = tint;
  a.beginPath(); a.arc(x, y, rad, 0, Math.PI * 2); a.fill();
  a.fillStyle = 'rgba(255,255,255,0.28)';
  a.beginPath(); a.arc(x - rad * 0.26, y - rad * 0.26, rad * 0.55, 0, Math.PI * 2); a.fill();
  a.fillStyle = 'rgba(0,0,0,0.38)';
  a.beginPath(); a.arc(x + rad * 0.3, y + rad * 0.3, rad * 0.46, 0, Math.PI * 2); a.fill();
  const g = h.createRadialGradient(x, y, 0, x, y, rad);
  g.addColorStop(0, '#ececec');
  g.addColorStop(0.7, '#a2a2a2');
  g.addColorStop(1, '#666666');
  h.fillStyle = g;
  h.beginPath(); h.arc(x, y, rad, 0, Math.PI * 2); h.fill();
  r.fillStyle = '#383838';
  r.beginPath(); r.arc(x, y, rad * 0.9, 0, Math.PI * 2); r.fill();
}

/** Shared plate-grid pass. Same construction as the station's, yard values. */
function plateGrid(a, h, r, S, rng, o) {
  const k = S / 512;
  const cw = S / o.cols, ch = S / o.rows;
  const gap = (o.gap ?? 3) * k;

  a.fillStyle = o.base; a.fillRect(0, 0, S, S);
  h.fillStyle = '#8a8a8a'; h.fillRect(0, 0, S, S);
  r.fillStyle = o.rough ?? '#b0b0b0'; r.fillRect(0, 0, S, S);

  for (let cy = 0; cy < o.rows; cy++) {
    for (let cx = 0; cx < o.cols; cx++) {
      const x = cx * cw, y = cy * ch;
      const v = rng();
      // +/-6.5% per plate, not +/-14%: a wider swing reads as a random
      // checkerboard because the eye locks onto the cell boundary rather than
      // onto the surface. The low-frequency macro octave in the material does
      // the drifting.
      const shade = 0.935 + v * 0.13;
      a.save();
      a.fillStyle = o.plate;
      a.fillRect(x + gap, y + gap, cw - gap * 2, ch - gap * 2);
      a.globalCompositeOperation = 'source-atop';
      a.fillStyle = `rgba(255,255,255,${Math.max(0, (shade - 1) * 0.9)})`;
      a.fillRect(x + gap, y + gap, cw - gap * 2, ch - gap * 2);
      a.fillStyle = `rgba(0,0,0,${Math.max(0, (1 - shade) * 0.9)})`;
      a.fillRect(x + gap, y + gap, cw - gap * 2, ch - gap * 2);
      a.restore();

      a.fillStyle = 'rgba(255,255,255,0.12)';
      a.fillRect(x + gap, y + gap, cw - gap * 2, 1.6 * k);
      a.fillRect(x + gap, y + gap, 1.6 * k, ch - gap * 2);
      a.fillStyle = 'rgba(0,0,0,0.46)';
      a.fillRect(x + gap, y + ch - gap - 1.8 * k, cw - gap * 2, 1.8 * k);
      a.fillRect(x + cw - gap - 1.8 * k, y + gap, 1.8 * k, ch - gap * 2);

      const hv = 166 + Math.floor(v * 22);
      h.fillStyle = `rgb(${hv},${hv},${hv})`;
      h.fillRect(x + gap, y + gap, cw - gap * 2, ch - gap * 2);

      const rv = 168 + Math.floor(rng() * 14);
      r.fillStyle = `rgb(${rv},${rv},${rv})`;
      r.fillRect(x + gap, y + gap, cw - gap * 2, ch - gap * 2);
      // Metal varies far more WITHIN a plate (rolling direction, wipe marks)
      // than between plates, so the variance lives in a brushed micro-streak
      // pass along the plate rather than in a flat per-cell jitter.
      r.save();
      r.beginPath();
      r.rect(x + gap, y + gap, cw - gap * 2, ch - gap * 2);
      r.clip();
      const brush = Math.max(3, Math.round((ch - gap * 2) / (7 * k)));
      for (let s = 0; s < brush; s++) {
        const sy = y + gap + ((ch - gap * 2) * (s + rng())) / brush;
        const amp = 12 + rng() * 28;
        r.fillStyle = rng() < 0.5
          ? `rgba(255,255,255,${(amp / 255) * 0.5})`
          : `rgba(0,0,0,${(amp / 255) * 0.5})`;
        r.fillRect(x + gap, sy, cw - gap * 2, (0.6 + rng() * 1.5) * k);
      }
      r.restore();

      if (o.bolts) {
        const inset = (o.boltInset ?? 9) * k;
        const rr = (o.boltSize ?? 2.7) * k;
        for (const p of [
          [x + gap + inset, y + gap + inset],
          [x + cw - gap - inset, y + gap + inset],
          [x + gap + inset, y + ch - gap - inset],
          [x + cw - gap - inset, y + ch - gap - inset],
        ]) bolt(a, h, r, p[0], p[1], rr, o.boltTint ?? '#8b96a3');
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* The yard's surfaces                                                 */
/* ------------------------------------------------------------------ */

/**
 * Assembly floor: heavy chequer plate, oil, chalk ghosts and burn scars.
 *
 * Darker than the station deck (0x232932 against 0x2b323c) because the yard is
 * lit by sodium worklights and a floor that starts at station value has
 * nowhere left to go under an amber key — the station's own note records the
 * same fix in the other direction.
 */
function paintFloor(a, h, r, S, rng) {
  plateGrid(a, h, r, S, rng, {
    cols: 4, rows: 4, gap: 3.4,
    base: '#10141a', plate: '#232932', rough: '#a4a4a4',
    bolts: true, boltTint: '#79838f',
  });
  const k = S / 512;
  // Chequer teardrops. Two per plate quadrant, alternating bias, in HEIGHT
  // mostly: a chequer plate is a relief, and painting it into albedo alone
  // makes a sticker.
  for (let i = 0; i < 220; i++) {
    const x = rng() * S, y = rng() * S;
    const ang = (i % 2 ? 0.6 : -0.6) + rng() * 0.18;
    const len = (7 + rng() * 3) * k;
    h.save();
    h.translate(x, y);
    h.rotate(ang);
    h.fillStyle = '#d6d6d6';
    h.fillRect(-len / 2, -1.6 * k, len, 3.2 * k);
    h.restore();
    a.save();
    a.translate(x, y);
    a.rotate(ang);
    a.fillStyle = 'rgba(178,190,204,0.10)';
    a.fillRect(-len / 2, -1.6 * k, len, 1.4 * k);
    a.fillStyle = 'rgba(0,0,0,0.22)';
    a.fillRect(-len / 2, 0, len, 1.6 * k);
    a.restore();
  }
  // Oil blooms: darker albedo, much smoother roughness.
  for (let i = 0; i < 13; i++) {
    const x = rng() * S, y = rng() * S, rad = S * (0.03 + rng() * 0.1);
    const g = a.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, 'rgba(5,6,9,0.62)');
    g.addColorStop(1, 'rgba(5,6,9,0)');
    a.fillStyle = g; a.beginPath(); a.arc(x, y, rad, 0, Math.PI * 2); a.fill();
    const g2 = r.createRadialGradient(x, y, 0, x, y, rad);
    g2.addColorStop(0, 'rgba(24,24,24,0.85)');
    g2.addColorStop(1, 'rgba(24,24,24,0)');
    r.fillStyle = g2; r.beginPath(); r.arc(x, y, rad, 0, Math.PI * 2); r.fill();
  }
  // Chalk setting-out ghosts: half-erased arcs and tick marks. This is the
  // yard's signature and the reason the floor never reads as a station deck.
  for (let i = 0; i < 26; i++) {
    const x = rng() * S, y = rng() * S;
    const rad = S * (0.05 + rng() * 0.22);
    const a0 = rng() * Math.PI * 2;
    a.save();
    a.strokeStyle = `rgba(226,232,240,${0.05 + rng() * 0.09})`;
    a.lineWidth = S * (0.0016 + rng() * 0.0022);
    a.setLineDash([S * 0.02, S * (0.01 + rng() * 0.03)]);
    a.beginPath(); a.arc(x, y, rad, a0, a0 + 0.5 + rng() * 1.6); a.stroke();
    a.restore();
  }
  // Cutting burns: a small dark core with a heat-tint halo, rough as hell.
  for (let i = 0; i < 9; i++) {
    const x = rng() * S, y = rng() * S, rad = S * (0.012 + rng() * 0.02);
    const g = a.createRadialGradient(x, y, 0, x, y, rad * 2.6);
    g.addColorStop(0, 'rgba(12,10,8,0.8)');
    g.addColorStop(0.45, 'rgba(96,70,44,0.35)');
    g.addColorStop(1, 'rgba(96,70,44,0)');
    a.fillStyle = g; a.beginPath(); a.arc(x, y, rad * 2.6, 0, Math.PI * 2); a.fill();
    r.fillStyle = 'rgba(240,240,240,0.55)';
    r.beginPath(); r.arc(x, y, rad * 1.6, 0, Math.PI * 2); r.fill();
  }
  wear(a, h, r, S, rng, { streaks: 150, scratches: 170 });
  grain(a, 0.16, 24, 7, 1, 1.01, 1.05);
}

/** Hull / wall plating: big welded sections with a bolted string course. */
function paintPlate(a, h, r, S, rng) {
  plateGrid(a, h, r, S, rng, {
    cols: 2, rows: 3, gap: 5,
    base: '#0d1116', plate: '#333b46', rough: '#989898',
    bolts: true, boltInset: 13, boltSize: 3.5, boltTint: '#94a0ae',
  });
  const k = S / 512;
  // Weld beads down every seam: a proud, irregular ridge in height and a
  // scorched, matt band in roughness. The whole premise of the yard is that
  // its hulls were pinned back together, so the welds are the story.
  for (let i = 1; i < 3; i++) {
    const y = (S * i) / 3;
    h.save();
    for (let x = 0; x < S; x += 2 * k) {
      const w = 3.4 * k + Math.sin(x * 0.07) * 1.1 * k;
      h.fillStyle = '#c8c8c8';
      h.fillRect(x, y - w / 2, 2.2 * k, w);
    }
    h.restore();
    a.fillStyle = 'rgba(150,164,180,0.14)';
    a.fillRect(0, y - 2.4 * k, S, 4.8 * k);
    r.fillStyle = 'rgba(255,255,255,0.35)';
    r.fillRect(0, y - 3 * k, S, 6 * k);
  }
  // Rust weep below each seam — the yard is cold and half-finished.
  for (let i = 0; i < 34; i++) {
    const x = rng() * S;
    const y = (S * (1 + Math.floor(rng() * 2))) / 3;
    const len = (10 + rng() * 60) * k;
    const g = a.createLinearGradient(0, y, 0, y + len);
    g.addColorStop(0, 'rgba(118,72,38,0.36)');
    g.addColorStop(1, 'rgba(118,72,38,0)');
    a.fillStyle = g;
    a.fillRect(x, y, (1 + rng() * 3) * k, len);
  }
  wear(a, h, r, S, rng, { streaks: 90, scratches: 110 });
  grain(a, 0.13, 20, 37, 1.02, 1, 0.99);
}

/** Structural steel: painted box section, chipped to bare metal on the edges. */
function paintSteel(a, h, r, S, rng) {
  plateGrid(a, h, r, S, rng, {
    cols: 3, rows: 3, gap: 2.4,
    base: '#14181e', plate: '#3d4750', rough: '#8e8e8e',
    bolts: false,
  });
  const k = S / 512;
  // Paint chipping to bare bright steel. Bright, small, and only where an
  // edge would take a knock.
  for (let i = 0; i < 130; i++) {
    const x = rng() * S, y = rng() * S;
    const w = (1.5 + rng() * 5) * k, hh = (1.2 + rng() * 3.4) * k;
    a.fillStyle = `rgba(186,196,208,${0.18 + rng() * 0.3})`;
    a.fillRect(x, y, w, hh);
    r.fillStyle = 'rgba(0,0,0,0.5)';
    r.fillRect(x, y, w, hh);
  }
  wear(a, h, r, S, rng, { streaks: 60, scratches: 130 });
  grain(a, 0.11, 18, 53);
}

/** Open mesh grating: catwalks, the trench cover, stair treads. */
function paintGrate(a, h, r, S, rng) {
  const k = S / 512;
  a.fillStyle = '#07090c'; a.fillRect(0, 0, S, S);
  h.fillStyle = '#101010'; h.fillRect(0, 0, S, S);
  r.fillStyle = '#8a8a8a'; r.fillRect(0, 0, S, S);
  const bars = 16;
  const pitch = S / bars;
  for (let i = 0; i < bars; i++) {
    const x = i * pitch;
    a.fillStyle = '#414b56'; a.fillRect(x, 0, pitch * 0.30, S);
    a.fillStyle = 'rgba(200,214,228,0.16)'; a.fillRect(x, 0, pitch * 0.09, S);
    h.fillStyle = '#e0e0e0'; h.fillRect(x, 0, pitch * 0.30, S);
    r.fillStyle = '#4c4c4c'; r.fillRect(x, 0, pitch * 0.30, S);
  }
  // Cross ties, half as often as the bearing bars and a touch proud.
  for (let i = 0; i < bars / 2; i++) {
    const y = i * pitch * 2 + pitch * 0.4;
    a.fillStyle = '#37404a'; a.fillRect(0, y, S, pitch * 0.16);
    h.fillStyle = '#f0f0f0'; h.fillRect(0, y, S, pitch * 0.16);
  }
  // Trodden polish on the bearing bars: the top edge of a walked grating goes
  // bright and smooth long before the web does.
  for (let i = 0; i < 90; i++) {
    const x = Math.floor(rng() * bars) * pitch;
    const y = rng() * S;
    const len = (12 + rng() * 70) * k;
    a.fillStyle = `rgba(214,226,238,${0.07 + rng() * 0.1})`;
    a.fillRect(x, y, pitch * 0.12, len);
    r.fillStyle = 'rgba(0,0,0,0.55)';
    r.fillRect(x, y, pitch * 0.16, len);
  }
  grain(a, 0.1, 16, 71);
}

/**
 * Hazard striping. Knocked back and dirty, never full-chroma vector yellow —
 * the station's own note: flat saturated yellow with one value across thirty
 * metres of depth is overlay art, not paint on a used deck.
 */
function paintHazard(a, h, r, S, rng) {
  const k = S / 256;
  a.fillStyle = '#1b1d21'; a.fillRect(0, 0, S, S);
  h.fillStyle = '#8c8c8c'; h.fillRect(0, 0, S, S);
  r.fillStyle = '#c0c0c0'; r.fillRect(0, 0, S, S);
  a.save();
  a.translate(S / 2, S / 2);
  a.rotate(Math.PI / 4);
  for (let i = -8; i < 10; i++) {
    a.fillStyle = '#c9a13c';
    a.fillRect(i * (S / 4), -S, S / 8, S * 2);
    h.save(); h.translate(S / 2, S / 2); h.rotate(Math.PI / 4);
    h.fillStyle = '#a8a8a8';
    h.fillRect(i * (S / 4), -S, S / 8, S * 2);
    h.restore();
  }
  a.restore();
  // Scuffed-through paint: the stripe is worn where the traffic crosses it.
  for (let i = 0; i < 120; i++) {
    const x = rng() * S, y = rng() * S;
    a.fillStyle = `rgba(28,30,34,${0.1 + rng() * 0.4})`;
    a.fillRect(x, y, (1 + rng() * 7) * k, (1 + rng() * 5) * k);
  }
  wear(a, h, r, S, rng, { streaks: 30, scratches: 60 });
  grain(a, 0.15, 12, 113, 1.02, 1, 0.96);
}

/** Poured concrete apron: the one non-metal ground in the yard. */
function paintApron(a, h, r, S, rng) {
  const k = S / 512;
  a.fillStyle = '#3a3e44'; a.fillRect(0, 0, S, S);
  h.fillStyle = '#909090'; h.fillRect(0, 0, S, S);
  r.fillStyle = '#d2d2d2'; r.fillRect(0, 0, S, S);
  // Aggregate.
  for (let i = 0; i < 5200; i++) {
    const x = rng() * S, y = rng() * S, rad = (0.5 + rng() * 2.2) * k;
    const v = 0.5 + rng() * 0.5;
    a.fillStyle = `rgba(${Math.floor(120 * v + 40)},${Math.floor(124 * v + 42)},${Math.floor(130 * v + 46)},${0.1 + rng() * 0.3})`;
    a.beginPath(); a.arc(x, y, rad, 0, Math.PI * 2); a.fill();
    h.fillStyle = `rgba(255,255,255,${0.06 + rng() * 0.12})`;
    h.beginPath(); h.arc(x, y, rad, 0, Math.PI * 2); h.fill();
  }
  // Saw-cut control joints on a 1/2 tile grid, and the cracks that follow.
  for (const u of [0, 0.5]) {
    a.fillStyle = 'rgba(6,8,10,0.72)'; a.fillRect(u * S, 0, 3 * k, S);
    a.fillRect(0, u * S, S, 3 * k);
    h.fillStyle = '#303030'; h.fillRect(u * S, 0, 3 * k, S);
    h.fillRect(0, u * S, S, 3 * k);
  }
  for (let i = 0; i < 16; i++) {
    let x = rng() * S, y = rng() * S;
    a.strokeStyle = 'rgba(8,10,12,0.4)';
    a.lineWidth = (0.7 + rng()) * k;
    a.beginPath(); a.moveTo(x, y);
    for (let s = 0; s < 8; s++) {
      x += (rng() - 0.5) * 34 * k;
      y += (rng() - 0.5) * 34 * k;
      a.lineTo(x, y);
    }
    a.stroke();
  }
  wear(a, h, r, S, rng, { streaks: 40, scratches: 30 });
  grain(a, 0.14, 22, 89, 1, 1, 1.02);
}

/** Weatherproof tarpaulin: the sheets over the spares and over the clean hull. */
function paintTarp(a, h, r, S, rng) {
  const k = S / 512;
  a.fillStyle = '#4a4034'; a.fillRect(0, 0, S, S);
  h.fillStyle = '#888888'; h.fillRect(0, 0, S, S);
  r.fillStyle = '#e2e2e2'; r.fillRect(0, 0, S, S);
  // Coarse woven weft. Two passes at 90 degrees, height-led.
  for (let i = 0; i < S; i += 3 * k) {
    h.fillStyle = 'rgba(255,255,255,0.14)'; h.fillRect(i, 0, 1.5 * k, S);
    h.fillStyle = 'rgba(0,0,0,0.14)'; h.fillRect(i + 1.5 * k, 0, 1.5 * k, S);
    h.fillStyle = 'rgba(255,255,255,0.10)'; h.fillRect(0, i, S, 1.5 * k);
  }
  for (let i = 0; i < 900; i++) {
    const x = rng() * S, y = rng() * S;
    a.fillStyle = `rgba(${90 + rng() * 40 | 0},${76 + rng() * 34 | 0},${58 + rng() * 26 | 0},0.3)`;
    a.fillRect(x, y, (1 + rng() * 3) * k, (1 + rng() * 3) * k);
  }
  // Eyelets and rope wear at the edges.
  for (const u of [0.06, 0.94]) {
    for (let i = 0; i < 7; i++) {
      const y = (i + 0.5) * (S / 7);
      bolt(a, h, r, u * S, y, 4.5 * k, '#7f8892');
      bolt(a, h, r, y, u * S, 4.5 * k, '#7f8892');
    }
  }
  wear(a, h, r, S, rng, { streaks: 50, scratches: 20 });
  grain(a, 0.2, 14, 151, 1.03, 1, 0.95);
}

/** Crates, dunnage and pallet timber. */
function paintCrate(a, h, r, S, rng) {
  const k = S / 512;
  a.fillStyle = '#6b5a41'; a.fillRect(0, 0, S, S);
  h.fillStyle = '#8e8e8e'; h.fillRect(0, 0, S, S);
  r.fillStyle = '#dcdcdc'; r.fillRect(0, 0, S, S);
  const boards = 6;
  for (let i = 0; i < boards; i++) {
    const y = (S / boards) * i;
    const v = 0.86 + rng() * 0.28;
    a.fillStyle = `rgba(${Math.floor(118 * v)},${Math.floor(98 * v)},${Math.floor(70 * v)},1)`;
    a.fillRect(0, y + 1.5 * k, S, S / boards - 3 * k);
    a.fillStyle = 'rgba(0,0,0,0.42)';
    a.fillRect(0, y, S, 1.6 * k);
    h.fillStyle = `rgb(${150 + Math.floor(rng() * 40)},${150},${150})`;
    h.fillRect(0, y + 1.5 * k, S, S / boards - 3 * k);
    // Grain lines along the board.
    for (let g2 = 0; g2 < 16; g2++) {
      const gy = y + rng() * (S / boards);
      a.strokeStyle = `rgba(56,42,26,${0.1 + rng() * 0.2})`;
      a.lineWidth = (0.6 + rng()) * k;
      a.beginPath();
      a.moveTo(0, gy);
      a.bezierCurveTo(S * 0.3, gy + (rng() - 0.5) * 8 * k, S * 0.7, gy + (rng() - 0.5) * 8 * k, S, gy);
      a.stroke();
    }
  }
  for (const u of [0.1, 0.9]) {
    for (let i = 0; i < boards; i++) {
      bolt(a, h, r, u * S, (i + 0.5) * (S / boards), 3.4 * k, '#6d7681');
    }
  }
  wear(a, h, r, S, rng, { streaks: 30, scratches: 70 });
  grain(a, 0.16, 18, 199, 1.04, 1, 0.94);
}

/* ------------------------------------------------------------------ */
/* Sign atlas                                                          */
/* ------------------------------------------------------------------ */

/**
 * The yard's own signage. Sixteen cells, 4 x 4 at 256 x 384 = 1024 x 1536.
 *
 * Reserved BY ROLE, exactly as `StationWorld`'s is and for the same reason:
 * a sign's text is a function of what the sign IS, not of where it falls in a
 * loop counter, and two signs 40 m apart carrying identical copy is the defect
 * that arrangement exists to make impossible. Sixteen is the whole sheet with
 * nothing spare — `paintYardSigns` destructures every cell unconditionally, so
 * a short table throws at build time rather than painting a blank board.
 */
export const YARD_SIGNS = [
  ['LODESTAR YARD', 'ASSEMBLY BAY // SECTION 06', '#ffb347'],
  ['LAUNCHES', '000', '#ff8a3c'],
  ['KEEL LINE', 'KEEP CLEAR OF CRANE PATH', '#4fe3ff'],
  ['DATUM 06/00', 'ALL SETTING-OUT FROM THIS PLATE', '#c9a13c'],
  ['BERTH B1', 'KESTREL // COURIER', '#4fe3ff'],
  ['BERTH B2', 'DRAY // ORE TENDER', '#4fe3ff'],
  ['BERTH B3', 'PIKE // INTERCEPTOR', '#4fe3ff'],
  ['BERTH B4', 'BASTION // HULK, NOT FITTED', '#ff8a3c'],
  ['YARD CHANDLERY', 'STORES // MEDICAL // KIT', '#ffb347'],
  ['FITTING SHOP', 'HULLS // ORDNANCE', '#ffb347'],
  ['PAINT & ROPE', 'LIVERY // CORDAGE // TACK', '#ffb347'],
  ['SITE OFFICE', 'SIGN ON HERE', '#4fe3ff'],
  ['SERVICE TRENCH', 'MIND THE OPEN BAYS', '#c9a13c'],
  ['GANTRY ACCESS', 'CLIP ON ABOVE 2 M', '#c9a13c'],
  ['BLAST DOOR', 'NO ENTRY WHILE THE LAMP IS LIT', '#ff4b45'],
  ['GATEWAY 06', 'AETHER NEXUS STATION', '#9fb8c8'],
];

/** Cell reservations by role. Indexes `YARD_SIGNS` positionally. */
export const YARD_SIGN = Object.freeze({
  yard: 0,
  launches: 1,
  keelLine: 2,
  datum: 3,
  berthB1: 4,
  berthB2: 5,
  berthB3: 6,
  berthB4: 7,
  chandler: 8,
  fitter: 9,
  paint: 10,
  office: 11,
  trench: 12,
  gantry: 13,
  blastDoor: 14,
  gateway: 15,
});

export const SIGN_COLS = 4;
export const SIGN_ROWS = 4;
const CELL_W = 256;
const CELL_H = 384;

/** Remap a quad's uvs onto one cell of the yard sign sheet. */
export function yardSignUV(geo, cell) {
  const n = SIGN_COLS * SIGN_ROWS;
  const c = ((cell % n) + n) % n;
  const col = c % SIGN_COLS;
  const row = Math.floor(c / SIGN_COLS);
  const uv = geo.attributes.uv;
  const iu = 1 / SIGN_COLS, iv = 1 / SIGN_ROWS;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, col * iu + uv.getX(i) * iu, 1 - (row + 1) * iv + uv.getY(i) * iv);
  }
  uv.needsUpdate = true;
  return geo;
}

/** Paint the whole sheet. Stencil-and-enamel, not backlit vinyl. */
function paintYardSigns(a, W, H, rng) {
  a.fillStyle = '#0a0d11';
  a.fillRect(0, 0, W, H);
  for (let i = 0; i < SIGN_COLS * SIGN_ROWS; i++) {
    const col = i % SIGN_COLS;
    const row = Math.floor(i / SIGN_COLS);
    const x = col * CELL_W;
    const y = row * CELL_H;
    const [primary, secondary, accent] = YARD_SIGNS[i];

    a.save();
    a.beginPath();
    a.rect(x, y, CELL_W, CELL_H);
    a.clip();
    a.translate(x, y);

    // Enamel ground with a lit gradient, so a board is never one flat value.
    const g = a.createLinearGradient(0, 0, 0, CELL_H);
    g.addColorStop(0, '#141a21');
    g.addColorStop(0.55, '#0d1218');
    g.addColorStop(1, '#0a0e13');
    a.fillStyle = g;
    a.fillRect(0, 0, CELL_W, CELL_H);

    // Border, inset, with bolt heads at the corners.
    a.strokeStyle = accent;
    a.globalAlpha = 0.8;
    a.lineWidth = 5;
    a.strokeRect(10, 10, CELL_W - 20, CELL_H - 20);
    a.globalAlpha = 1;
    a.fillStyle = 'rgba(150,162,176,0.85)';
    for (const [bx, by] of [[20, 20], [CELL_W - 20, 20], [20, CELL_H - 20], [CELL_W - 20, CELL_H - 20]]) {
      a.beginPath(); a.arc(bx, by, 5, 0, Math.PI * 2); a.fill();
    }

    // The two lines. Primary at a cap height that survives minification from
    // 25 m; secondary deliberately half again smaller and never the same hue,
    // so the board still reads as two pieces of information at distance.
    a.textAlign = 'center';
    a.textBaseline = 'middle';
    a.fillStyle = '#e8f2ff';
    a.font = '700 62px "Arial Narrow", system-ui, sans-serif';
    a.fillText(primary, CELL_W / 2, CELL_H * 0.40, CELL_W - 34);
    a.fillStyle = accent;
    a.font = '600 30px "Arial Narrow", system-ui, sans-serif';
    a.fillText(secondary, CELL_W / 2, CELL_H * 0.60, CELL_W - 34);

    // Accent bar under the copy, and a stencilled section number over it.
    a.fillStyle = accent;
    a.globalAlpha = 0.9;
    a.fillRect(34, CELL_H * 0.70, CELL_W - 68, 6);
    a.globalAlpha = 0.55;
    a.font = '700 22px "Courier New", monospace';
    a.fillStyle = '#8b97a5';
    a.fillText(`06 / ${String(i + 1).padStart(2, '0')}`, CELL_W / 2, CELL_H * 0.80);
    a.globalAlpha = 1;

    // Weather: rust weep and chipped enamel, so the boards belong to the yard.
    for (let s = 0; s < 26; s++) {
      const sx = rng() * CELL_W, sy = rng() * CELL_H;
      a.fillStyle = `rgba(112,70,38,${0.05 + rng() * 0.18})`;
      a.fillRect(sx, sy, 1 + rng() * 3, 6 + rng() * 40);
    }
    for (let s = 0; s < 18; s++) {
      const sx = rng() * CELL_W, sy = rng() * CELL_H;
      a.fillStyle = `rgba(178,188,200,${0.06 + rng() * 0.16})`;
      a.fillRect(sx, sy, 2 + rng() * 6, 2 + rng() * 4);
    }
    a.restore();
  }
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

/**
 * Paint the whole set. `breathe` is the world's slice hook — a no-op behind
 * the loading screen (`WorldManager` sets `report.slice` to a no-op while
 * `engine.running` is false), a frame yield once the player has frames worth
 * protecting.
 *
 * @param {{aniso:number, keep:THREE.Texture[], breathe:() => Promise<void>|void}} o
 * @returns {Promise<Record<string, any>>} the `T` table the materials read
 */
export async function buildYardTextures({ aniso = 8, keep = [], breathe = () => {} } = {}) {
  const T = {};

  const surface = async (name, size, painter, normalStrength, seed) => {
    await breathe();
    const ca = makeCanvas(size), ch = makeCanvas(size), cr = makeCanvas(size);
    painter(ctx2d(ca), ctx2d(ch), ctx2d(cr), size, mulberry32(seed));
    const map = canvasTexture(ca, true, aniso);
    const normalMap = normalFromHeight(ch, normalStrength, aniso);
    const roughnessMap = canvasTexture(cr, false, aniso);
    keep.push(map, normalMap, roughnessMap);
    T[name] = { map, normalMap, roughnessMap };
    return T[name];
  };

  // Eight tiled keys. Six at 1024 (everything walked on or seen at a grazing
  // angle) and two at 512 (tarp and crate are always near and never tiled far).
  await surface('floor', 1024, paintFloor, 1.45, 601);
  await surface('plate', 1024, paintPlate, 1.5, 613);
  await surface('steel', 1024, paintSteel, 1.3, 619);
  await surface('grate', 1024, paintGrate, 1.6, 631);
  await surface('apron', 1024, paintApron, 1.25, 641);
  await surface('hazard', 256, paintHazard, 1.4, 643);
  await surface('tarp', 512, paintTarp, 1.1, 647);
  await surface('crate', 512, paintCrate, 1.35, 653);

  await breathe();
  const signs = makeCanvas(CELL_W * SIGN_COLS, CELL_H * SIGN_ROWS);
  paintYardSigns(ctx2d(signs), CELL_W * SIGN_COLS, CELL_H * SIGN_ROWS, mulberry32(659));
  T.signs = canvasTexture(signs, true, aniso);
  keep.push(T.signs);

  return T;
}

/**
 * One material per visual class. Buildings merge into these buckets, so the
 * key set IS the draw-call budget: nine opaque keys plus glass and the
 * emissive family.
 *
 * @param {Record<string, any>} T the texture table from `buildYardTextures`
 * @returns {Record<string, THREE.Material>}
 */
export function buildYardMaterials(T) {
  const M = {};

  const std = (tex, o = {}) => new THREE.MeshStandardMaterial({
    map: tex.map,
    normalMap: tex.normalMap,
    roughnessMap: tex.roughnessMap,
    normalScale: new THREE.Vector2(o.ns ?? 1, o.ns ?? 1),
    metalness: o.metalness ?? 0.4,
    roughness: o.roughness ?? 1.0,
    color: o.color ?? 0xffffff,
    envMapIntensity: o.env ?? 1.0,
    side: o.side ?? THREE.FrontSide,
  });

  /* Material families are separated rather than all landing in the same
   * metalness/roughness band. The station's note is the one to obey here:
   * metal at 0.75/0.3 has no diffuse term at all and returns only what the
   * environment gives it, and the only environment in a shed is a starfield
   * through a door. Nothing below goes past 0.62. */
  M.floor = std(T.floor, { metalness: 0.10, roughness: 0.88, color: 0x8e99a6, env: 0.55 });
  M.apron = std(T.apron, { metalness: 0.04, roughness: 0.94, color: 0x9aa3ad, env: 0.5 });
  M.plate = std(T.plate, { metalness: 0.58, roughness: 0.50, color: 0xa2aebd, env: 1.35 });
  /* There is no `plateIn`.
   *
   * It was defined here as a BackSide clone, on the reasoning that one shell
   * could serve as both the outside skin and the inside lining without a second
   * mesh. `_buildShell` does not build the shed that way — it draws four
   * FrontSide inward-facing planes — so the material was declared, counted,
   * disposed and never bound to a single mesh. A material nothing uses is a
   * comment that describes a building this world does not have. */
  M.steel = std(T.steel, { metalness: 0.34, roughness: 0.54, color: 0x8996a6, env: 1.4 });
  M.steelDark = std(T.steel, { metalness: 0.30, roughness: 0.62, color: 0x6f7a88, env: 1.3 });
  /* 0.62 and not the 0.66 first shipped: the rule three lines up is a rule, and
   * this is the surface it matters most on — the grate is every catwalk, every
   * stair tread and the trench cover, i.e. every metal surface in the yard that
   * is walked on and therefore seen at a metre. */
  M.grate = std(T.grate, { metalness: 0.62, roughness: 0.60, color: 0x9dabbb, env: 1.5 });
  M.hazard = std(T.hazard, { metalness: 0.12, roughness: 0.86, color: 0xd6cfc0, env: 0.85 });
  M.tarp = std(T.tarp, { metalness: 0.0, roughness: 0.92, color: 0xb8a789, env: 0.6 });
  M.crate = std(T.crate, { metalness: 0.06, roughness: 0.82, color: 0xb0a58f, env: 0.8 });

  /* The roof plate. Twenty-six metres up with no practical pointed at it, so
   * it takes the station's ceiling fix wholesale: lighter, far less metallic
   * (metal with nothing to reflect renders black) and carrying a small
   * self-illumination standing in for the bounce a lighting grid throws back
   * at its own soffit. Without it the truss is present, correct and invisible,
   * and the roof photographs as a void with glowing strips floating in it. */
  M.roof = std(T.plate, { metalness: 0.14, roughness: 0.86, color: 0x707d8e, env: 0.6 });
  M.roof.emissive = new THREE.Color(0x232f3d);
  M.roof.emissiveIntensity = 1.4;

  M.glass = new THREE.MeshPhysicalMaterial({
    color: 0x2b3f52,
    metalness: 0.2,
    roughness: 0.09,
    transparent: true,
    opacity: 0.5,
    side: THREE.DoubleSide,
    depthWrite: false,
    envMapIntensity: 2.0,
    clearcoat: 1.0,
    clearcoatRoughness: 0.05,
  });

  /**
   * Distance-graded emissive, lifted from `StationWorld._buildMaterials`.
   *
   * A 0.5 m emissive bar 150 m away subtends well under a pixel, and a
   * sub-pixel emitter at full intensity is an aliasing source rather than a
   * light. Grading with view distance is also the only aerial perspective the
   * inside of a shed gets for free. Never to zero: the strips over the blast
   * door 150 m away should still read as a dim converging line.
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
        .replace('#include <common>', '#include <common>\nvarying float vYardDist;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvYardDist = -mvPosition.z;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vYardDist;')
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          totalEmissiveRadiance *= mix( 0.30, 1.0, smoothstep( 140.0, 46.0, vYardDist ) );`
        );
    };
    m.customProgramCacheKey = () => 'yard-emfade';
    return m;
  };

  /* Sodium OVER cyan, which is the yard's whole colour script and the inverse
   * of the station's. The worklights own the value peaks; cyan is reserved for
   * wayfinding — the keel line, the berth numbers, the gateway ring — and runs
   * below them so the shed never reads as one cyan chord. */
  M.emSodium = emissive(0xff8a3c, 1.9);
  M.emAmber = emissive(0xffb347, 1.6);
  M.emCyan = emissive(0x4fe3ff, 1.05);
  M.emRed = emissive(0xff4b45, 1.8);
  M.emGreen = emissive(0x4dffa6, 1.4);
  // The launch aperture. It must not grade off with distance: reading from the
  // apron 150 m away is the entire job of the thing the yard is named after.
  M.emLaunch = emissive(0x9fd8ff, 1.7, false);

  /* Signage. FrontSide, always: the sheet is text, and text seen through its
   * own back face renders mirrored — which reads as a broken build rather than
   * as a style. Anything legible from two sides gets a second correctly-wound
   * quad, never `DoubleSide`. */
  M.signs = new THREE.MeshStandardMaterial({
    map: T.signs,
    emissiveMap: T.signs,
    emissive: 0xffffff,
    emissiveIntensity: 1.15,
    color: 0x0a0d12,
    metalness: 0.2,
    roughness: 0.55,
    side: THREE.FrontSide,
  });

  /**
   * Painted floor markings — the keel line, the chalk grid, the berth bays.
   *
   * One vertex-coloured material sampling the FLOOR's own maps, so every
   * marking in the yard is a single draw call and reads as paint ON the plate
   * rather than as a coloured quad hovering over it. Polygon offset rather
   * than a lift, so the marking holds at 150 m down the bay where three
   * centimetres of gap is twice the depth resolution and starting to lose.
   */
  const painted = (tex, o) => new THREE.MeshStandardMaterial({
    map: tex.map,
    normalMap: tex.normalMap,
    roughnessMap: tex.roughnessMap,
    vertexColors: true,
    metalness: o.metalness,
    roughness: o.roughness,
    envMapIntensity: o.env,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -4,
  });
  M.paint = painted(T.floor, { metalness: 0.08, roughness: 0.82, env: 0.5 });
  /**
   * The same markings, on the apron's concrete.
   *
   * The apron is a real 0.12 m pad over the plate, so every marking that runs
   * under it has to be re-struck on TOP of it or it is 55-90 mm inside the
   * concrete — which is where the keel line's first 27 m were, the 27 m the
   * player is standing on when they step out of the gateway. Re-striking them
   * in the `paint` bucket instead would print the deck's chequer plate onto the
   * concrete, because that bucket samples `T.floor`. So: one more material,
   * one more draw, and both grounds carry their own markings.
   */
  M.paintApron = painted(T.apron, { metalness: 0.04, roughness: 0.9, env: 0.45 });

  return M;
}
