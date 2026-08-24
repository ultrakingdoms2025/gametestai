/* eslint-disable */
/**
 * THE IN-PAGE INSTRUMENT.
 *
 * Everything here runs inside the game page. The point is that an ablation and
 * the pixels that judge it happen in the SAME JavaScript task: hide, render,
 * readPixels, restore - so the rAF loop cannot slip a frame in between and no
 * result can be a comparison of two different moments.
 *
 * `Engine` is constructed with `preserveDrawingBuffer: true` whenever `?dev=1`
 * is set, which is exactly how `scripts/world-shot.mjs` boots the page, so
 * `gl.readPixels` on the default framebuffer returns the frame that was just
 * composited rather than transparent black.
 *
 * `postfx.render(0)` is deliberate: `PostFX.render` advances `_time` by `dt`
 * and the film-grain pass keys its noise on `_time`, so a dt of exactly 0
 * reproduces the previous frame bit-for-bit. That is what makes the null pair
 * meaningful instead of a measurement of the grain.
 */
(function () {
  const G = window.GAME;
  const renderer = G.engine.renderer;
  const gl = renderer.getContext();

  const API = {
    w: 0, h: 0, a: null, b: null,
    /** id -> object, for the ablation sweep */
    objs: [], meta: [],
  };

  API.size = function size() {
    API.w = gl.drawingBufferWidth;
    API.h = gl.drawingBufferHeight;
    const n = API.w * API.h * 4;
    if (!API.a || API.a.length !== n) { API.a = new Uint8Array(n); API.b = new Uint8Array(n); }
    return { w: API.w, h: API.h, cssW: renderer.domElement.clientWidth, cssH: renderer.domElement.clientHeight };
  };

  /** One composer render at dt 0 - deterministic, see the header note. */
  API.render = function render() {
    if (G.engine.postfx) G.engine.postfx.render(0);
    else renderer.render(G.engine.scene, G.engine.camera);
  };

  /** Read the whole default framebuffer into `into`. Bottom-left origin. */
  API.grab = function grab(into) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, API.w, API.h, gl.RGBA, gl.UNSIGNED_BYTE, into);
    return into;
  };

  API.shoot = function shoot(into) { API.render(); return API.grab(into); };

  const LUM = (r, g, b) => r * 0.2126 + g * 0.7152 + b * 0.0722;

  /** Convert a top-left (x,y) to the flat RGBA index of a bottom-left buffer. */
  const idx = (x, y) => (((API.h - 1 - y) * API.w) + x) * 4;

  /* ---------------------------------------------------------------- */
  /* Null pair                                                         */
  /* ---------------------------------------------------------------- */

  API.nullPair = function nullPair() {
    API.size();
    API.shoot(API.a);
    API.shoot(API.b);
    let maxD = 0, count = 0, at = null;
    for (let y = 0; y < API.h; y++) {
      for (let x = 0; x < API.w; x++) {
        const i = idx(x, y);
        const d = Math.abs(LUM(API.a[i], API.a[i + 1], API.a[i + 2]) - LUM(API.b[i], API.b[i + 1], API.b[i + 2]));
        if (d > 1) count++;
        if (d > maxD) { maxD = d; at = [x, y]; }
      }
    }
    return { maxDeltaLum: Math.round(maxD * 100) / 100, pixelsOver1: count, at, w: API.w, h: API.h };
  };

  /* ---------------------------------------------------------------- */
  /* Orb detection                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * A blob is an orb if it is (a) near-white/near-clipped, (b) compact, and
   * (c) much brighter than the ring of sky or ground around it. (c) is what
   * keeps a bright sunset sky out of the list: the sky is bright everywhere,
   * so it has no local contrast.
   */
  API.findOrbs = function findOrbs(opts) {
    const o = Object.assign({ lum: 246, minArea: 3, maxArea: 6000, maxSpan: 160, ringGap: 24, minContrast: 22 }, opts || {});
    API.size();
    API.shoot(API.a);
    const px = API.a;
    const W = API.w, H = API.h;
    const lum = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = idx(x, y);
        lum[y * W + x] = LUM(px[i], px[i + 1], px[i + 2]);
      }
    }
    const seen = new Uint8Array(W * H);
    const orbs = [];
    const stack = new Int32Array(W * H);
    for (let y0 = 0; y0 < H; y0++) {
      for (let x0 = 0; x0 < W; x0++) {
        const p0 = y0 * W + x0;
        if (seen[p0] || lum[p0] < o.lum) continue;
        let sp = 0; stack[sp++] = p0; seen[p0] = 1;
        let area = 0, minx = W, maxx = 0, miny = H, maxy = 0, peak = -1, peakP = p0, sx = 0, sy = 0;
        while (sp > 0) {
          const p = stack[--sp];
          const x = p % W, y = (p / W) | 0;
          area++; sx += x; sy += y;
          if (x < minx) minx = x; if (x > maxx) maxx = x;
          if (y < miny) miny = y; if (y > maxy) maxy = y;
          if (lum[p] > peak) { peak = lum[p]; peakP = p; }
          if (x > 0 && !seen[p - 1] && lum[p - 1] >= o.lum) { seen[p - 1] = 1; stack[sp++] = p - 1; }
          if (x < W - 1 && !seen[p + 1] && lum[p + 1] >= o.lum) { seen[p + 1] = 1; stack[sp++] = p + 1; }
          if (y > 0 && !seen[p - W] && lum[p - W] >= o.lum) { seen[p - W] = 1; stack[sp++] = p - W; }
          if (y < H - 1 && !seen[p + W] && lum[p + W] >= o.lum) { seen[p + W] = 1; stack[sp++] = p + W; }
        }
        const spanX = maxx - minx + 1, spanY = maxy - miny + 1;
        if (area < o.minArea || area > o.maxArea || spanX > o.maxSpan || spanY > o.maxSpan) continue;
        // ring contrast
        const rx0 = Math.max(0, minx - o.ringGap), rx1 = Math.min(W - 1, maxx + o.ringGap);
        const ry0 = Math.max(0, miny - o.ringGap), ry1 = Math.min(H - 1, maxy + o.ringGap);
        let ringSum = 0, ringN = 0;
        for (let y = ry0; y <= ry1; y++) {
          for (let x = rx0; x <= rx1; x++) {
            if (x >= minx && x <= maxx && y >= miny && y <= maxy) continue;
            ringSum += lum[y * W + x]; ringN++;
          }
        }
        const ring = ringN ? ringSum / ringN : 0;
        if (peak - ring < o.minContrast) continue;
        const pkx = peakP % W, pky = (peakP / W) | 0;
        const i = idx(pkx, pky);
        orbs.push({
          id: orbs.length,
          cx: Math.round(sx / area), cy: Math.round(sy / area),
          px: pkx, py: pky,
          area, spanX, spanY,
          peakLum: Math.round(peak * 10) / 10,
          ringLum: Math.round(ring * 10) / 10,
          rgb: [px[i], px[i + 1], px[i + 2]],
        });
      }
    }
    orbs.sort((a, b) => b.area - a.area);
    orbs.forEach((v, k) => { v.id = k; });
    API.orbs = orbs;
    return orbs;
  };

  /** Manually pin the orb list (so a sweep can target hand-picked boxes). */
  API.setOrbs = function setOrbs(list) { API.orbs = list; return API.orbs.length; };

  /** rgb + luminance at a top-left coordinate, from the last grabbed frame. */
  API.probeAt = function probeAt(x, y) {
    const i = idx(x, y);
    const p = API.a;
    return { x, y, rgb: [p[i], p[i + 1], p[i + 2]], lum: Math.round(LUM(p[i], p[i + 1], p[i + 2]) * 10) / 10 };
  };

  /** Luminance histogram of the last grabbed frame, 16 buckets. */
  API.hist = function hist() {
    const b = new Array(16).fill(0);
    for (let y = 0; y < API.h; y++) {
      for (let x = 0; x < API.w; x++) {
        const i = idx(x, y);
        b[Math.min(15, (LUM(API.a[i], API.a[i + 1], API.a[i + 2]) / 16) | 0)]++;
      }
    }
    return b;
  };

  /* ---------------------------------------------------------------- */
  /* Per-orb sampling                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * Integrated |delta luminance| inside a box centred on each orb, plus the
   * peak. A box rather than a pixel: bloom moves a neighbourhood, and a single
   * pixel of a sub-pixel-wide source is a coin flip on which pixel it lands on.
   */
  API.sampleOrbs = function sampleOrbs(A, B, half) {
    const H2 = half == null ? 14 : half;
    const out = [];
    for (const orb of API.orbs) {
      let sum = 0, peak = 0;
      const x0 = Math.max(0, orb.cx - H2), x1 = Math.min(API.w - 1, orb.cx + H2);
      const y0 = Math.max(0, orb.cy - H2), y1 = Math.min(API.h - 1, orb.cy + H2);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = idx(x, y);
          const d = Math.abs(LUM(A[i], A[i + 1], A[i + 2]) - LUM(B[i], B[i + 1], B[i + 2]));
          sum += d;
          if (d > peak) peak = d;
        }
      }
      out.push({ id: orb.id, sum: Math.round(sum), peak: Math.round(peak * 10) / 10 });
    }
    return out;
  };

  /* ---------------------------------------------------------------- */
  /* The catalogue                                                     */
  /* ---------------------------------------------------------------- */

  /** Path from the scene root, so a hit names something a human can find. */
  function pathOf(o) {
    const parts = [];
    let n = o, guard = 0;
    while (n && guard++ < 40) {
      parts.unshift(n.name || (n.type + (n.isMesh ? '' : '')));
      n = n.parent;
    }
    return parts.join('/');
  }

  /**
   * Every currently-VISIBLE renderable leaf in the scene.
   *
   * Leaves only - never a Group. Hiding a group can hide a light under it, and
   * `WebGLRenderer.projectObject` drops a hidden light from the count, which
   * re-keys every shader program in the scene (see src/gfx/LightAnchor.js). An
   * ablation that recompiles the world is not an ablation, it is a different
   * session. Leaves cannot contain lights, so the counts hold.
   */
  API.catalog = function catalog() {
    API.objs = []; API.meta = [];
    G.engine.scene.traverse((o) => {
      if (o.isLight) return;
      if (!(o.isMesh || o.isPoints || o.isSprite || o.isLine)) return;
      if (!o.visible) return;
      // an invisible ancestor means this leaf is not on screen anyway
      let n = o.parent, hidden = false;
      while (n) { if (!n.visible) { hidden = true; break; } n = n.parent; }
      if (hidden) return;
      const id = API.objs.length;
      API.objs.push(o);
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      API.meta.push({
        id,
        name: o.name || '',
        type: o.type,
        path: pathOf(o),
        mat: m ? (m.name || m.type) : null,
        matType: m ? m.type : null,
        count: o.isInstancedMesh ? o.count : (o.isPoints && o.geometry?.attributes?.position ? o.geometry.attributes.position.count : null),
      });
    });
    return { n: API.objs.length };
  };

  /**
   * Hide each catalogued leaf in turn, render, and record how much each orb box
   * moved. One render per object, all inside this one task.
   */
  API.sweep = function sweep(half) {
    API.size();
    API.shoot(API.a);              // baseline
    const rows = [];
    for (let i = 0; i < API.objs.length; i++) {
      const o = API.objs[i];
      o.visible = false;
      API.shoot(API.b);
      o.visible = true;
      const s = API.sampleOrbs(API.a, API.b, half);
      let best = 0, bestId = -1, total = 0;
      for (const r of s) { total += r.sum; if (r.peak > best) { best = r.peak; bestId = r.id; } }
      if (best > 0.5 || total > 0) {
        rows.push({ id: i, meta: API.meta[i], peak: best, peakOrb: bestId, total, per: s.filter((r) => r.peak > 0.5) });
      }
    }
    return rows;
  };

  /** Hide every leaf whose id is in `ids`, render, sample, restore. */
  API.ablateSet = function ablateSet(ids, half) {
    API.size();
    API.shoot(API.a);
    for (const i of ids) API.objs[i].visible = false;
    API.shoot(API.b);
    for (const i of ids) API.objs[i].visible = true;
    return API.sampleOrbs(API.a, API.b, half);
  };

  /** Hide by predicate over the meta rows; returns [ids, samples]. */
  API.ablateWhere = function ablateWhere(fnSrc, half) {
    const fn = new Function('m', 'o', `return (${fnSrc});`);
    const ids = [];
    for (let i = 0; i < API.meta.length; i++) if (fn(API.meta[i], API.objs[i])) ids.push(i);
    return { ids: ids.length, sample: ids.length ? API.ablateSet(ids, half) : null, names: ids.slice(0, 12).map((i) => API.meta[i].path) };
  };

  /**
   * Connected components of |delta luminance| between the last two grabs.
   *
   * This, not the brightness detector, is the honest count of "how many orbs
   * did that ablation remove": it needs no threshold on how bright a thing has
   * to look and no guess about local contrast. It counts footprints.
   */
  API.diffBlobs = function diffBlobs(t) {
    const T = t == null ? 20 : t;
    const A = API.a, B = API.b, W = API.w, H = API.h;
    const d = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = idx(x, y);
        d[y * W + x] = Math.abs(LUM(A[i], A[i + 1], A[i + 2]) - LUM(B[i], B[i + 1], B[i + 2]));
      }
    }
    const seen = new Uint8Array(W * H);
    const stack = new Int32Array(W * H);
    const blobs = [];
    for (let p0 = 0; p0 < W * H; p0++) {
      if (seen[p0] || d[p0] < T) continue;
      let sp = 0; stack[sp++] = p0; seen[p0] = 1;
      let area = 0, peak = 0, sx = 0, sy = 0, px = 0, py = 0;
      while (sp > 0) {
        const p = stack[--sp];
        const x = p % W, y = (p / W) | 0;
        area++; sx += x; sy += y;
        if (d[p] > peak) { peak = d[p]; px = x; py = y; }
        if (x > 0 && !seen[p - 1] && d[p - 1] >= T) { seen[p - 1] = 1; stack[sp++] = p - 1; }
        if (x < W - 1 && !seen[p + 1] && d[p + 1] >= T) { seen[p + 1] = 1; stack[sp++] = p + 1; }
        if (y > 0 && !seen[p - W] && d[p - W] >= T) { seen[p - W] = 1; stack[sp++] = p - W; }
        if (y < H - 1 && !seen[p + W] && d[p + W] >= T) { seen[p + W] = 1; stack[sp++] = p + W; }
      }
      if (area < 2) continue;
      blobs.push({ cx: Math.round(sx / area), cy: Math.round(sy / area), area, peak: Math.round(peak * 10) / 10, px, py });
    }
    blobs.sort((a, b) => b.area - a.area);
    return blobs;
  };

  /** Where in the world is object `id`, and how big is it? */
  API.locate = function locate(id) {
    const THREE = G.THREE || window.THREE;
    const o = API.objs[id];
    o.updateWorldMatrix(true, false);
    const p = { x: 0, y: 0, z: 0 };
    const e = o.matrixWorld.elements;
    p.x = e[12]; p.y = e[13]; p.z = e[14];
    let bb = null;
    if (o.geometry) {
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const b = o.geometry.boundingBox;
      bb = { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] };
    }
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    return {
      id, path: API.meta[id].path, type: o.type, origin: [p.x, p.y, p.z], bbox: bb,
      scale: [o.scale.x, o.scale.y, o.scale.z],
      material: m ? {
        name: m.name, type: m.type, color: m.color ? m.color.getHexString() : null,
        emissive: m.emissive ? m.emissive.getHexString() : null,
        emissiveIntensity: m.emissiveIntensity ?? null,
        opacity: m.opacity, transparent: m.transparent, blending: m.blending,
        depthWrite: m.depthWrite, fog: m.fog, map: !!m.map, sizeAttenuation: m.sizeAttenuation ?? null,
        size: m.size ?? null, toneMapped: m.toneMapped,
      } : null,
      instances: o.isInstancedMesh ? o.count : null,
      points: o.isPoints ? o.geometry?.attributes?.position?.count ?? null : null,
    };
  };

  window.__ORB = API;
  return 'installed';
})();
