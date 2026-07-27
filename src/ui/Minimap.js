import { CONFIG } from '../core/Config.js';

/**
 * Tactical minimap.
 *
 * The world floorplan is expensive to rasterise from `world.minimapShapes`, so
 * it is baked once per world into an offscreen canvas in *world space* and then
 * blitted through a rotate/scale transform each frame. Markers are drawn
 * afterwards in screen space so glyphs and text never inherit the rotation.
 *
 * Everything is procedural — no image assets.
 */

/* Module-scope scratch. The draw loop runs every frame; it must not allocate. */
const _pt = { x: 0, y: 0, dist: 0, inside: false };

const MAX_CACHE_PX = 1024;
const HEX_SIDES = 6;

/** Accept `0xrrggbb`, a CSS string, or undefined. */
function toCss(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `#${(value >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
  }
  if (typeof value === 'string' && value.length) return value;
  return fallback;
}

export class Minimap {
  /**
   * @param {{ canvas: HTMLCanvasElement, player: any, worldManager: any,
   *           npcManager: any, portals: any, input: any }} ctx
   */
  constructor({ canvas, player, worldManager, npcManager, portals }) {
    this.canvas = canvas;
    this.player = player;
    this.worldManager = worldManager;
    this.npcManager = npcManager;
    this.portals = portals;

    this.size = CONFIG.minimap.size;
    this.baseRange = CONFIG.minimap.range;
    this.zoomLevel = 1;

    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(this.size * this.dpr);
    canvas.height = Math.round(this.size * this.dpr);
    canvas.style.width = `${this.size}px`;
    canvas.style.height = `${this.size}px`;

    this.ctx = canvas.getContext('2d', { alpha: true });
    this.ctx.scale(this.dpr, this.dpr);

    /** @type {Map<string, {canvas: HTMLCanvasElement, minX:number, minZ:number, w:number, d:number}>} */
    this._cache = new Map();
    this._world = null;
    this._plan = null;

    /** id of the friendly currently offering conversation, drawn with a speech glyph */
    this.chatNpcId = null;

    this._r = this.size * 0.5 - 3;
    this._cx = this.size * 0.5;
    this._cy = this.size * 0.5;

    this._hex = new Path2D();
    for (let i = 0; i < HEX_SIDES; i++) {
      const a = (i / HEX_SIDES) * Math.PI * 2 - Math.PI / 2;
      const x = this._cx + Math.cos(a) * this._r;
      const y = this._cy + Math.sin(a) * this._r;
      if (i === 0) this._hex.moveTo(x, y);
      else this._hex.lineTo(x, y);
    }
    this._hex.closePath();
  }

  /** Metres visible from the centre to the rim. */
  get range() {
    return this.baseRange / this.zoomLevel * 0.5;
  }

  /**
   * Zoom by one step. `delta > 0` zooms out. Driven by the `[` / `]` keys —
   * the mouse wheel belongs to weapon switching (CONTRACTS-V2 §1).
   */
  zoom(delta) {
    if (!delta) return;
    const step = CONFIG.minimap.zoomStep;
    this.zoomLevel = Math.min(4, Math.max(0.4, this.zoomLevel * (delta > 0 ? 1 / step : step)));
  }

  /** Swap the baked floorplan when the active world changes. */
  setWorld(world) {
    this._world = world || null;
    this._plan = world ? this._bakePlan(world) : null;
  }

  /* ------------------------------------------------------------------ bake */

  _bakePlan(world) {
    const id = world.id ?? world.constructor?.id ?? 'unknown';
    const cached = this._cache.get(id);
    if (cached) return cached;

    const b = world.bounds;
    let minX = -200;
    let minZ = -200;
    let maxX = 200;
    let maxZ = 200;
    if (b && b.min && b.max && Number.isFinite(b.min.x) && Number.isFinite(b.max.x)) {
      minX = b.min.x;
      minZ = b.min.z;
      maxX = b.max.x;
      maxZ = b.max.z;
    }
    const w = Math.max(20, maxX - minX);
    const d = Math.max(20, maxZ - minZ);

    // Bake at ~2 px/m, clamped so a huge world never allocates a giant texture.
    const ppm = Math.min(2.4, MAX_CACHE_PX / Math.max(w, d));
    const cw = Math.max(2, Math.round(w * ppm));
    const ch = Math.max(2, Math.round(d * ppm));

    const cv = document.createElement('canvas');
    cv.width = cw;
    cv.height = ch;
    const c = cv.getContext('2d');
    c.setTransform(ppm, 0, 0, ppm, -minX * ppm, -minZ * ppm);
    c.lineJoin = 'round';
    c.lineCap = 'round';

    const shapes = Array.isArray(world.minimapShapes) ? world.minimapShapes : [];
    for (let i = 0; i < shapes.length; i++) {
      const s = shapes[i];
      if (!s) continue;
      const fill = toCss(s.fill, null);
      const stroke = toCss(s.stroke, null);
      c.beginPath();

      if (s.kind === 'rect') {
        const hw = (s.w ?? 1) * 0.5;
        const hd = (s.d ?? 1) * 0.5;
        const rot = s.rotation ?? 0;
        if (rot) {
          const cs = Math.cos(rot);
          const sn = Math.sin(rot);
          const corners = [
            [-hw, -hd],
            [hw, -hd],
            [hw, hd],
            [-hw, hd],
          ];
          for (let k = 0; k < 4; k++) {
            const lx = corners[k][0];
            const lz = corners[k][1];
            const px = s.x + lx * cs - lz * sn;
            const pz = s.z + lx * sn + lz * cs;
            if (k === 0) c.moveTo(px, pz);
            else c.lineTo(px, pz);
          }
          c.closePath();
        } else {
          c.rect(s.x - hw, s.z - hd, hw * 2, hd * 2);
        }
      } else if (s.kind === 'circle') {
        c.arc(s.x, s.z, Math.max(0.2, s.r ?? 1), 0, Math.PI * 2);
      } else if (s.kind === 'path' && Array.isArray(s.points) && s.points.length > 1) {
        for (let k = 0; k < s.points.length; k++) {
          const p = s.points[k];
          if (k === 0) c.moveTo(p[0], p[1]);
          else c.lineTo(p[0], p[1]);
        }
        if (s.closed) c.closePath();
      } else {
        continue;
      }

      if (fill) {
        c.fillStyle = fill;
        c.fill();
      }
      if (stroke) {
        c.strokeStyle = stroke;
        c.lineWidth = Math.max(0.25, s.width ?? 0.65);
        c.stroke();
      }
      if (!fill && !stroke) {
        c.fillStyle = 'rgba(96,150,180,0.35)';
        c.fill();
      }
    }

    const plan = { canvas: cv, minX, minZ, w, d };
    this._cache.set(id, plan);
    return plan;
  }

  /* ------------------------------------------------------------------ draw */

  /**
   * Project a world position into minimap screen space, writing into `_pt`.
   * Player faces -Z at yaw 0, so forward maps to screen-up.
   */
  _project(x, z, px, pz, sin, cos, scale) {
    const dx = x - px;
    const dz = z - pz;
    const right = dx * cos - dz * sin;
    const up = -dx * sin - dz * cos;
    _pt.x = this._cx + right * scale;
    _pt.y = this._cy - up * scale;
    const rx = _pt.x - this._cx;
    const ry = _pt.y - this._cy;
    _pt.dist = Math.hypot(rx, ry);
    _pt.inside = _pt.dist <= this._r - 8;
    if (!_pt.inside && _pt.dist > 0.0001) {
      const k = (this._r - 9) / _pt.dist;
      _pt.x = this._cx + rx * k;
      _pt.y = this._cy + ry * k;
    }
    return _pt;
  }

  update(_dt, elapsed) {
    const ctx = this.ctx;
    const size = this.size;
    const cx = this._cx;
    const cy = this._cy;
    const r = this._r;

    ctx.clearRect(0, 0, size, size);

    const p = this.player?.position;
    const yaw = this.player?.yaw ?? 0;
    const px = p ? p.x : 0;
    const pz = p ? p.z : 0;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const scale = r / this.range;

    ctx.save();
    ctx.clip(this._hex);

    // --- backdrop --------------------------------------------------------
    const bg = ctx.createRadialGradient(cx, cy, 4, cx, cy, r);
    bg.addColorStop(0, 'rgba(12,26,40,0.86)');
    bg.addColorStop(0.72, 'rgba(6,13,22,0.86)');
    bg.addColorStop(1, 'rgba(2,5,10,0.92)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, size, size);

    // --- floorplan (rotated blit of the baked canvas) ---------------------
    if (this._plan) {
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.setTransform(
        this.dpr * scale * cos,
        this.dpr * scale * sin,
        this.dpr * -scale * sin,
        this.dpr * scale * cos,
        this.dpr * cx,
        this.dpr * cy
      );
      ctx.imageSmoothingEnabled = true;
      const pl = this._plan;
      ctx.drawImage(pl.canvas, pl.minX - px, pl.minZ - pz, pl.w, pl.d);
      ctx.restore();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }

    // --- range rings + cardinal hairlines --------------------------------
    ctx.strokeStyle = 'rgba(82,233,255,0.10)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, (r * i) / 3.4, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx, cy + r);
    ctx.moveTo(cx - r, cy);
    ctx.lineTo(cx + r, cy);
    ctx.strokeStyle = 'rgba(82,233,255,0.055)';
    ctx.stroke();

    // --- portals ---------------------------------------------------------
    const portals = this.portals?.portals;
    if (portals) {
      for (let i = 0; i < portals.length; i++) {
        const po = portals[i];
        const pos = po?.position;
        if (!pos) continue;
        this._project(pos.x, pos.z, px, pz, sin, cos, scale);
        const accent = toCss(po.accent, '#d46bff');
        const pulse = 0.5 + 0.5 * Math.sin(elapsed * 3 + i);
        ctx.save();
        ctx.translate(_pt.x, _pt.y);
        ctx.strokeStyle = accent;
        ctx.globalAlpha = 0.28 + 0.42 * (1 - pulse);
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(0, 0, 5 + pulse * 6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(0, 0, 3.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(0, 0, 5.4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    // --- NPCs ------------------------------------------------------------
    const npcs = this.npcManager?.npcs;
    if (npcs) {
      for (let i = 0; i < npcs.length; i++) {
        const n = npcs[i];
        if (!n || n.isDead || !n.position) continue;
        this._project(n.position.x, n.position.z, px, pz, sin, cos, scale);
        const hostile = n.type === 'hostile';

        if (!_pt.inside) {
          // Off-range contacts collapse to a rim chevron pointing outward.
          const a = Math.atan2(_pt.y - cy, _pt.x - cx);
          ctx.save();
          ctx.translate(_pt.x, _pt.y);
          ctx.rotate(a);
          ctx.fillStyle = hostile ? 'rgba(255,61,85,0.85)' : 'rgba(82,233,255,0.7)';
          ctx.beginPath();
          ctx.moveTo(4.5, 0);
          ctx.lineTo(-2.5, 3.4);
          ctx.lineTo(-2.5, -3.4);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
          continue;
        }

        if (hostile) {
          ctx.save();
          ctx.translate(_pt.x, _pt.y);
          ctx.rotate(Math.PI * 0.25);
          ctx.fillStyle = '#ff3d55';
          ctx.shadowColor = 'rgba(255,61,85,0.9)';
          ctx.shadowBlur = 7;
          ctx.fillRect(-3, -3, 6, 6);
          ctx.restore();
        } else {
          ctx.save();
          ctx.fillStyle = '#52e9ff';
          ctx.shadowColor = 'rgba(82,233,255,0.9)';
          ctx.shadowBlur = 6;
          ctx.beginPath();
          ctx.arc(_pt.x, _pt.y, 2.9, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();

          if (this.chatNpcId != null && n.id === this.chatNpcId) {
            this._speechGlyph(ctx, _pt.x, _pt.y - 9, elapsed);
          }
        }
      }
    }

    // --- player arrow + view cone ----------------------------------------
    const fov = (CONFIG.render.fov * Math.PI) / 180;
    const coneR = r * 0.52;
    const grad = ctx.createRadialGradient(cx, cy, 2, cx, cy, coneR);
    grad.addColorStop(0, 'rgba(82,233,255,0.34)');
    grad.addColorStop(1, 'rgba(82,233,255,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, coneR, -Math.PI / 2 - fov * 0.5, -Math.PI / 2 + fov * 0.5);
    ctx.closePath();
    ctx.fill();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(6,14,24,0.9)';
    ctx.lineWidth = 1.4;
    ctx.shadowColor = 'rgba(82,233,255,0.95)';
    ctx.shadowBlur = 9;
    ctx.beginPath();
    ctx.moveTo(0, -7.5);
    ctx.lineTo(5.4, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-5.4, 6);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.stroke();
    ctx.restore();

    ctx.restore(); // end clip

    // --- rim chrome (dark casing first, luminous edge on top) -------------
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(3,8,14,0.75)';
    ctx.stroke(this._hex);
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = 'rgba(82,233,255,0.5)';
    ctx.stroke(this._hex);

    // Corner ticks give the rim a machined feel.
    ctx.strokeStyle = 'rgba(255,180,74,0.55)';
    ctx.lineWidth = 2;
    for (let i = 0; i < HEX_SIDES; i++) {
      const a = (i / HEX_SIDES) * Math.PI * 2 - Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * (r - 5), cy + Math.sin(a) * (r - 5));
      ctx.lineTo(cx + Math.cos(a) * (r + 1), cy + Math.sin(a) * (r + 1));
      ctx.stroke();
    }

    // North tick — rides the rim so orientation is always readable.
    const na = yaw - Math.PI / 2;
    const nx = cx + Math.cos(na) * (r - 12);
    const ny = cy + Math.sin(na) * (r - 12);
    ctx.save();
    ctx.translate(nx, ny);
    ctx.fillStyle = '#ffb44a';
    ctx.shadowColor = 'rgba(255,180,74,0.8)';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(0, -5);
    ctx.lineTo(3.6, 3);
    ctx.lineTo(-3.6, 3);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.font = '700 8px "Chakra Petch", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,180,74,0.95)';
    ctx.fillText('N', 0, 9);
    ctx.restore();

    // Range readout.
    ctx.font = '600 9px "Chakra Petch", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(3,8,14,0.85)';
    ctx.fillRect(cx - 24, size - 15, 48, 12);
    ctx.fillStyle = 'rgba(140,215,235,0.95)';
    ctx.fillText(`${Math.round(this.range)} M`, cx, size - 6);
  }

  /** Small speech bubble marking a friendly the player can talk to. */
  _speechGlyph(ctx, x, y, elapsed) {
    const bob = Math.sin(elapsed * 4) * 1.1;
    ctx.save();
    ctx.translate(x, y + bob);
    ctx.fillStyle = '#ffb44a';
    ctx.shadowColor = 'rgba(255,180,74,0.85)';
    ctx.shadowBlur = 7;
    ctx.beginPath();
    ctx.moveTo(-5, -4);
    ctx.lineTo(5, -4);
    ctx.lineTo(5, 2);
    ctx.lineTo(0.5, 2);
    ctx.lineTo(-1.5, 5);
    ctx.lineTo(-2, 2);
    ctx.lineTo(-5, 2);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#2a1a05';
    ctx.fillRect(-3, -2, 6, 1);
    ctx.fillRect(-3, 0, 4, 1);
    ctx.restore();
  }

  dispose() {
    this._cache.clear();
    this._plan = null;
    this._world = null;
  }
}
