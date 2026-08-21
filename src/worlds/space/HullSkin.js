import * as THREE from 'three';

/**
 * THE YARD'S OUTER SKIN - plate, seams, bolts and wear, painted once.
 *
 * ===========================================================================
 *  WHY THIS EXISTS AT ALL
 * ===========================================================================
 *
 * The verdict on the previous exterior was "a big flat untextured grey slab",
 * and "untextured" was literally true: every surface was a bare
 * `MeshStandardMaterial` with a colour and nothing else. At two hundred metres
 * a 180 m wall of one flat colour has no scale in it - there is nothing in the
 * image whose real size you know, so the wall could be two metres away or two
 * kilometres. Panel lines and bolts ARE the scale. They are the only thing in
 * the frame a human eye can measure the building against.
 *
 * ===========================================================================
 *  THREE CANVASES, AND THE ONE THAT MATTERS MOST IS NOT THE COLOUR
 * ===========================================================================
 *
 * The star is at bearing (0.578, 0.469, 0.668) - up, to starboard, and BEHIND
 * the yard. So the face a player approaching the mouth sees is not lit by the
 * key at all; it is lit by 0.28 of blue ambient and the camera's own rim fill.
 * Under that lighting an albedo map is nearly invisible and a NORMAL map is
 * nearly everything, because a normal map turns one flat rim value into a
 * gradient across every plate and a hard line at every seam.
 *
 * So the height canvas is authored first and the albedo second, and the normal
 * is a Sobel of the height rather than a hand-drawn thing that can disagree
 * with it. Same technique as `dock/YardTextures.js`; the content is different
 * because this is a hull seen from kilometres out rather than a floor seen
 * from two metres.
 *
 * ===========================================================================
 *  WORLD-SCALED UVs, NOT PER-FACE UVs
 * ===========================================================================
 *
 * `BoxGeometry` puts 0..1 across every face whatever its size, so a 180 m wall
 * and a 3 m strut would carry the same number of plates and the plates would
 * differ in size by sixty times. `DockExterior._bake` therefore re-projects
 * every vertex's uv from its WORLD position along its dominant normal axis and
 * divides by `TILE`. Two consequences worth stating:
 *
 *   - every surface on the station has plates of the same real size, which is
 *     what makes them work as a ruler;
 *   - the tiling lives in the geometry, so meshes of every size still share
 *     one material and still merge into one draw call. That is the same rule
 *     `YardTextures` records, and it is the reason this whole station is
 *     fifteen draws rather than a hundred.
 *
 * `TILE` is 16 m. A 12 m structural bay therefore does not land on a texture
 * repeat, which is deliberate: coincident structural and texture periods read
 * as a printed pattern, offset ones read as a building.
 *
 * ===========================================================================
 *  COST
 * ===========================================================================
 *
 * One 512 set - albedo, normal, roughness - shared by every plated material on
 * the station, tinted per material. 512 and not 1024 because the largest this
 * ever gets on screen is a wall filling a third of the frame at 60 m, which is
 * about 2.2 texels per pixel at 512 with the tile at 16 m. Three 512 RGBA
 * canvases with mipmaps is about 4 MB of VRAM for the whole exterior.
 */

/* ------------------------------------------------------------------ */
/* Plumbing                                                            */
/* ------------------------------------------------------------------ */

/** Metres of hull across one repeat of the plate set. */
export const TILE = 16;

/** Canvas side. See the cost note above. */
const S = 512;

/**
 * Deterministic noise. The station has to look the same on every load or a
 * screenshot taken to justify a number is not reproducible, which makes the
 * number worthless.
 */
function rng32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function ctx2d(c) {
  const x = c.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingEnabled = true;
  return x;
}

function texture(c, srgb, aniso) {
  const t = new THREE.CanvasTexture(c);
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
 * Sobel a height canvas into a tangent-space normal map.
 *
 * Lifted in technique from `dock/YardTextures.normalFromHeight`, not imported,
 * because importing it drags `station/StationKit.js` into the space world's
 * graph and into every headless test that builds it - for one function.
 */
function normalFromHeight(height, strength, aniso) {
  const src = ctx2d(height).getImageData(0, 0, S, S).data;
  const out = canvas(S);
  const octx = ctx2d(out);
  const img = octx.createImageData(S, S);
  const dst = img.data;
  const at = (x, y) => src[(((y + S) % S) * S + ((x + S) % S)) * 4] / 255;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv; ny *= inv; nz *= inv;
      const i = (y * S + x) * 4;
      dst[i] = (nx * 0.5 + 0.5) * 255;
      dst[i + 1] = (ny * 0.5 + 0.5) * 255;
      dst[i + 2] = (nz * 0.5 + 0.5) * 255;
      dst[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

/* ------------------------------------------------------------------ */
/* The plate set                                                       */
/* ------------------------------------------------------------------ */

/**
 * Paint albedo, height and roughness for one 16 m square of station hull.
 *
 * The layout is a 4 x 4 grid of 4 m plates, and 4 m is chosen against the
 * thing the plates have to measure: a human is 1.8 m and the mouth is 23.6 m,
 * so a plate is a bit over twice a person and the aperture is six plates tall.
 * Both of those are readable at a glance, which is the whole job.
 */
function paintPlate(a, h, r, seed) {
  const rand = rng32(seed);
  const cell = S / 4;

  // --- base ---------------------------------------------------------
  a.fillStyle = '#8d949d'; a.fillRect(0, 0, S, S);
  h.fillStyle = '#8a8a8a'; h.fillRect(0, 0, S, S);
  r.fillStyle = '#9c9c9c'; r.fillRect(0, 0, S, S);

  // --- individual plates, each a slightly different batch of steel ---
  for (let gy = 0; gy < 4; gy++) {
    for (let gx = 0; gx < 4; gx++) {
      const x = gx * cell, y = gy * cell;
      const v = 0.88 + rand() * 0.26;
      const g = Math.round(141 * v);
      a.fillStyle = `rgb(${g},${Math.round(g * 1.03)},${Math.round(g * 1.09)})`;
      a.fillRect(x, y, cell, cell);
      // Plate thickness: each plate sits a hair proud or shy of its neighbour.
      const hv = Math.round(132 + (rand() - 0.5) * 26);
      h.fillStyle = `rgb(${hv},${hv},${hv})`;
      h.fillRect(x + 2, y + 2, cell - 4, cell - 4);
      const rv = Math.round(146 + (rand() - 0.5) * 44);
      r.fillStyle = `rgb(${rv},${rv},${rv})`;
      r.fillRect(x, y, cell, cell);
    }
  }

  // --- seams: a dark groove with a light lip on one side -------------
  a.lineWidth = 3; h.lineWidth = 3;
  for (let i = 0; i <= 4; i++) {
    const p = i * cell;
    a.strokeStyle = 'rgba(28,32,38,0.86)';
    a.beginPath(); a.moveTo(p, 0); a.lineTo(p, S); a.moveTo(0, p); a.lineTo(S, p); a.stroke();
    h.strokeStyle = 'rgba(24,24,24,1)';
    h.beginPath(); h.moveTo(p, 0); h.lineTo(p, S); h.moveTo(0, p); h.lineTo(S, p); h.stroke();
    a.lineWidth = 1;
    a.strokeStyle = 'rgba(206,216,228,0.30)';
    a.beginPath(); a.moveTo(p + 2, 0); a.lineTo(p + 2, S); a.moveTo(0, p + 2); a.lineTo(S, p + 2); a.stroke();
    a.lineWidth = 3;
  }

  // --- scribe lines: a half-plate division, shallower than a seam ----
  a.lineWidth = 1; h.lineWidth = 1;
  a.strokeStyle = 'rgba(52,58,66,0.42)'; h.strokeStyle = 'rgba(96,96,96,1)';
  for (let i = 0; i < 4; i++) {
    const p = i * cell + cell / 2;
    a.beginPath(); a.moveTo(p, 0); a.lineTo(p, S); a.stroke();
    h.beginPath(); h.moveTo(p, 0); h.lineTo(p, S); h.stroke();
  }

  // --- bolts, on the seam lines where a real one would be ------------
  for (let gy = 0; gy <= 4; gy++) {
    for (let gx = 0; gx <= 4; gx++) {
      for (let k = 0; k < 4; k++) {
        const bx = gx * cell + (k % 2 ? cell * 0.5 : 0);
        const by = gy * cell + (k > 1 ? cell * 0.5 : 0);
        if (bx > S || by > S) continue;
        if (rand() < 0.34) continue;
        a.fillStyle = 'rgba(168,178,190,0.85)';
        a.beginPath(); a.arc(bx, by, 2.6, 0, Math.PI * 2); a.fill();
        h.fillStyle = 'rgba(216,216,216,1)';
        h.beginPath(); h.arc(bx, by, 2.4, 0, Math.PI * 2); h.fill();
        r.fillStyle = 'rgba(96,96,96,0.8)';
        r.beginPath(); r.arc(bx, by, 3.2, 0, Math.PI * 2); r.fill();
      }
    }
  }

  // --- wear: thermal staining and micrometeorite scoring -------------
  for (let i = 0; i < 26; i++) {
    const x = rand() * S, y = rand() * S, rad = 12 + rand() * 46;
    const g = a.createRadialGradient(x, y, 0, x, y, rad);
    const dark = rand() < 0.7;
    g.addColorStop(0, dark ? 'rgba(46,42,38,0.30)' : 'rgba(196,204,214,0.16)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    a.fillStyle = g; a.beginPath(); a.arc(x, y, rad, 0, Math.PI * 2); a.fill();
    const rg = r.createRadialGradient(x, y, 0, x, y, rad);
    rg.addColorStop(0, dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.18)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    r.fillStyle = rg; r.beginPath(); r.arc(x, y, rad, 0, Math.PI * 2); r.fill();
  }
  a.lineWidth = 1;
  for (let i = 0; i < 90; i++) {
    const x = rand() * S, y = rand() * S, ang = rand() * Math.PI * 2, len = 4 + rand() * 26;
    a.strokeStyle = rand() < 0.5 ? 'rgba(214,222,232,0.22)' : 'rgba(38,40,46,0.26)';
    a.beginPath(); a.moveTo(x, y); a.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len); a.stroke();
  }
  // Pits: small, dark, and slightly proud at the rim, which is what a crater is.
  for (let i = 0; i < 34; i++) {
    const x = rand() * S, y = rand() * S, rad = 1.5 + rand() * 3.5;
    a.fillStyle = 'rgba(24,26,30,0.55)';
    a.beginPath(); a.arc(x, y, rad, 0, Math.PI * 2); a.fill();
    h.fillStyle = 'rgba(44,44,44,0.9)';
    h.beginPath(); h.arc(x, y, rad, 0, Math.PI * 2); h.fill();
  }
}

/** Fine grain over the albedo, so a flat plate is never a flat colour. */
function grain(cx, amount, seed) {
  const img = cx.getImageData(0, 0, S, S);
  const d = img.data;
  const rand = rng32(seed);
  for (let i = 0; i < d.length; i += 4) {
    const n = (rand() - 0.5) * amount;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  cx.putImageData(img, 0, 0);
}

/**
 * Build the shared plate set.
 *
 * @param {number} aniso renderer max anisotropy, or 1 headless
 * @returns {{map:THREE.Texture, normalMap:THREE.Texture, roughnessMap:THREE.Texture,
 *            dispose:()=>void}}
 */
export function buildHullSkin(aniso = 1) {
  const ac = canvas(S), hc = canvas(S), rc = canvas(S);
  paintPlate(ctx2d(ac), ctx2d(hc), ctx2d(rc), 0x5eed);
  grain(ctx2d(ac), 13, 0x1234);

  const map = texture(ac, true, aniso);
  const normalMap = texture(normalFromHeight(hc, 2.6, aniso), false, aniso);
  const roughnessMap = texture(rc, false, aniso);

  return {
    map,
    normalMap,
    roughnessMap,
    dispose() {
      map.dispose(); normalMap.dispose(); roughnessMap.dispose();
    },
  };
}

/**
 * Re-project a geometry's uvs from world position, along each vertex's
 * dominant normal axis, divided by `TILE`.
 *
 * Call this AFTER the geometry has been moved into place, because the whole
 * point is that the mapping is fixed to the station and not to the box. Two
 * boxes that meet at a corner therefore share a seam line rather than each
 * starting a fresh sheet of plate at the join.
 *
 * The dominant-axis rule is exact for a box (every face has one constant
 * normal) and behaves for the faceted prisms here (an eight-sided spine is
 * eight flat facets, each with its own constant normal). It is wrong for a
 * smoothly curved surface, which is why the habitat torus is not plated.
 *
 * @param {THREE.BufferGeometry} geo indexed or not, must carry position+normal+uv
 * @param {number} [tile] metres per repeat
 */
export function worldProjectUV(geo, tile = TILE) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const uv = geo.attributes.uv;
  if (!pos || !nrm || !uv) {
    throw new Error('[space/HullSkin] worldProjectUV needs position, normal and uv');
  }
  const inv = 1 / tile;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const nx = Math.abs(nrm.getX(i)), ny = Math.abs(nrm.getY(i)), nz = Math.abs(nrm.getZ(i));
    let u, v;
    if (ny >= nx && ny >= nz) { u = x; v = z; }        // floors and roofs
    else if (nx >= nz) { u = z; v = y; }               // port and starboard
    else { u = x; v = y; }                             // fore and aft
    uv.setXY(i, u * inv, v * inv);
  }
  uv.needsUpdate = true;
  return geo;
}
