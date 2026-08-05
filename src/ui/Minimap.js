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
/** Traders held back for a second pass so nothing draws over them. Reused. */
const _traders = [];

/* Widest edge of a baked floorplan, in pixels.
 *
 * 1024 was sized for a 412 m world, which it baked at the full 2.4 px/m. The
 * station is now 1,488 m across and at 1024 that collapses to 0.69 px/m - a
 * 5 m market stall becomes three pixels and the whole plan turns to mush.
 *
 * 2048 holds ~1.4 px/m, which keeps every authored shape down to about a metre
 * legible, for a 16 MB canvas. It is a compromise rather than a fix: the real
 * answer to a map this size is a two-level bake, coarse for the whole dome and
 * fine for whichever deck the player is on. What makes 2048 affordable in the
 * meantime is that the per-frame blit no longer draws the whole sheet - see
 * `_visibleSource`. */
const MAX_CACHE_PX = 2048;
/**
 * Zoom range.
 *
 * `range = baseRange / zoomLevel * 0.5`, so the old [0.4, 4] clamp spanned a
 * factor of ten. That covered a 200 m deck. It cannot cover a map where the
 * player wants both a 30 m view of the shop they are standing in and a 780 m
 * view of all five decks, which is a factor of twenty-six.
 */
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 14;
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
  constructor({ canvas, player, worldManager, npcManager, portals, caches, contracts }) {
    this.canvas = canvas;
    this.player = player;
    this.worldManager = worldManager;
    this.npcManager = npcManager;
    this.portals = portals;
    /** World caches, drawn as navigation targets. @see systems/Caches.js */
    this.caches = caches ?? null;
    /** Standing jobs, so the giver is findable. @see systems/Contracts.js */
    this.contracts = contracts ?? null;

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

    /* ---- race overlay -------------------------------------------------
     * Fed by RaceManager, and null whenever there is no circuit. It is drawn
     * live rather than baked into the floorplan for two reasons: the circuit
     * belongs to a *race*, not to a world, so it must come and go without
     * invalidating the world's cached plan; and the racer dots move every
     * frame, so they were never bakeable anyway. */
    /** @type {Array<[number,number]>|null} circuit outline, world XZ */
    this.circuit = null;
    /** @type {Array<{x:number,z:number,isPlayer:boolean,color:number,place:number}>|null} */
    this.racers = null;
    /** Metres to the rim while a race is on; overrides the zoom. */
    this.raceRange = null;

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
    // A race is the one time the map has a job the player's zoom cannot do:
    // show the *whole* circuit, so a gap to the car two corners ahead is
    // readable. The manual zoom is restored the moment the circuit clears.
    if (this.raceRange) return this.raceRange;
    return this.baseRange / this.zoomLevel * 0.5;
  }

  /**
   * Show a circuit and its field, or clear both.
   *
   * The range is derived from the circuit's own extent rather than configured:
   * the rim has to reach the far side of the track from wherever on it the
   * player happens to be, which is the full diameter plus a margin.
   *
   * @param {Array<[number,number]>|null} points world-space XZ outline
   * @param {Array<object>|null} [racers] live markers, read every frame
   */
  setCircuit(points, racers = null) {
    if (!Array.isArray(points) || points.length < 3) {
      this.circuit = null;
      this.racers = null;
      this.raceRange = null;
      return;
    }
    this.circuit = points;
    this.racers = racers ?? null;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of points) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minZ) minZ = p[1];
      if (p[1] > maxZ) maxZ = p[1];
    }
    // 0.55 of the widest extent, not half: half would clip the far side whenever
    // the player is at one end of the circuit, and much more than this leaves the
    // track as a small doodle in the middle of a large empty dial.
    this.raceRange = Math.max(40, Math.max(maxX - minX, maxZ - minZ) * 0.55);
  }

  /**
   * Zoom by one step. `delta > 0` zooms out. Driven by the `[` / `]` keys —
   * the mouse wheel belongs to weapon switching (CONTRACTS-V2 §1).
   */
  zoom(delta) {
    if (!delta) return;
    const step = CONFIG.minimap.zoomStep;
    this.zoomLevel = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.zoomLevel * (delta > 0 ? 1 / step : step)));
  }

  /**
   * Swap the baked floorplan when the active world changes.
   *
   * The zoom-out limit is derived from the world rather than configured. A
   * fixed `CONFIG.minimap.range` was right when every world was about 400 m
   * across; with the station at 1,488 m and the medieval valley at 400 the same
   * number cannot serve both - it either will not show the station's outer
   * zones at all or leaves the valley as a doodle in the middle of an empty
   * dial.
   *
   * The *starting* view stays where it has always been, about 45 m to the rim,
   * by picking the zoom level that produces it. So nothing changes for a player
   * who never touches the zoom keys; the extra range is there when they do.
   */
  setWorld(world) {
    this._world = world || null;
    this._plan = world ? this._bakePlan(world) : null;

    const b = world?.bounds;
    const extent = b && Number.isFinite(b.min?.x)
      ? Math.max(b.max.x - b.min.x, b.max.z - b.min.z)
      : 400;
    // 0.55 of the widest extent at full zoom-out, matching `setCircuit`: half
    // would clip the far side whenever the player is at one end of the map.
    const fullOut = Math.max(CONFIG.minimap.range, extent * 0.55);
    this.baseRange = fullOut * ZOOM_MIN * 2;
    const want = CONFIG.minimap.range * 0.5;
    this.zoomLevel = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, (this.baseRange * 0.5) / want));
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
      // Knocked back while a circuit is up. The world floorplan is a wall of
      // pale terrain rectangles and the road is a 3 px line over the top of it;
      // at full strength the two compete and the track is the one that loses,
      // which is exactly backwards during a race.
      ctx.globalAlpha = this.circuit ? 0.42 : 0.9;
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
      /* Blit only the part of the plan the dial can actually show.
       *
       * This used to hand `drawImage` the whole sheet every frame and let the
       * transform scale it down. At 989 px that was survivable; at 2048 it is
       * four times the source pixels, sampled through a rotation, sixty times a
       * second, to fill a 220 px hexagon - and all but a sliver of it is
       * outside the clip.
       *
       * The window is the dial's radius times root two, because the plan is
       * drawn rotated and a square source rect has to contain the dial at any
       * heading. Clamped to the sheet, and skipped entirely when the player is
       * outside it. */
      const half = this.range * Math.SQRT2;
      const ppmX = pl.canvas.width / pl.w;
      const ppmY = pl.canvas.height / pl.d;
      // Source window in sheet pixels, clamped to the sheet.
      const sx0 = Math.max(0, (px - half - pl.minX) * ppmX);
      const sy0 = Math.max(0, (pz - half - pl.minZ) * ppmY);
      const sx1 = Math.min(pl.canvas.width, (px + half - pl.minX) * ppmX);
      const sy1 = Math.min(pl.canvas.height, (pz + half - pl.minZ) * ppmY);
      if (sx1 - sx0 > 0.5 && sy1 - sy0 > 0.5) {
        /* Destination is in world metres relative to the player, because that
         * is what the transform above consumes - so it is simply the source
         * window converted back out of pixels and re-centred. Deriving it from
         * the *clamped* source rather than from the requested window is what
         * keeps the plan registered with the world when the player is near an
         * edge of the sheet and part of the window falls off it. */
        ctx.drawImage(
          pl.canvas,
          sx0, sy0, sx1 - sx0, sy1 - sy0,
          pl.minX + sx0 / ppmX - px,
          pl.minZ + sy0 / ppmY - pz,
          (sx1 - sx0) / ppmX,
          (sy1 - sy0) / ppmY
        );
      }
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

    // --- race circuit ----------------------------------------------------
    // Under every marker, over the floorplan: it is the road, not a contact.
    if (this.circuit) this._drawCircuit(px, pz, sin, cos, scale);

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

    // --- caches ----------------------------------------------------------
    // Drawn before the crowd so a passing civilian never hides a destination,
    // and kept on the rim when out of range: a cache the player cannot see the
    // bearing of is a cache they will never go and get.
    const cacheList = this.caches?.markers;
    if (cacheList) {
      for (let i = 0; i < cacheList.length; i++) {
        const c = cacheList[i];
        if (!c.stocked || !c.position) continue;
        this._project(c.position.x, c.position.z, px, pz, sin, cos, scale);
        this._cacheMarker(ctx, cx, cy, elapsed, _pt.inside, c.kind, i);
      }
    }

    // --- NPCs ------------------------------------------------------------
    const npcs = this.npcManager?.npcs;
    if (npcs) {
      // Traders are held back and drawn last. They are the only NPC the player
      // ever goes looking for - everyone else is scenery or a threat - so their
      // marker must never end up underneath a passing wanderer's dot.
      const traders = _traders;
      traders.length = 0;

      for (let i = 0; i < npcs.length; i++) {
        const n = npcs[i];
        if (!n || n.isDead || !n.position) continue;
        if (n.isVendor) { traders.push(n); continue; }
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

      for (let i = 0; i < traders.length; i++) {
        const n = traders[i];
        this._project(n.position.x, n.position.z, px, pz, sin, cos, scale);
        this._traderMarker(ctx, cx, cy, elapsed, _pt.inside);
      }
      traders.length = 0;

      // Contract givers ride on top of whatever marker they already had, so a
      // trader who is also offering a job reads as both.
      const jobs = this.contracts?.all;
      if (jobs) {
        for (let i = 0; i < jobs.length; i++) {
          const c = jobs[i];
          if (c.state === 'done' || !c.npc || c.npc.isDead || !c.npc.position) continue;
          this._project(c.npc.position.x, c.npc.position.z, px, pz, sin, cos, scale);
          this._contractMarker(ctx, elapsed, c.state === 'active' && c.have >= c.need);
        }
      }
    }

    // --- race field ------------------------------------------------------
    // Last of the contacts, so a rival is never hidden under a bystander.
    if (this.racers) this._drawRacers(px, pz, sin, cos, scale, elapsed);

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

  /**
   * The circuit outline.
   *
   * Stroked twice - a wide dark casing under a thin luminous centre - which is
   * the same trick the rim chrome uses, and is what keeps a 3 px road legible
   * over a floorplan that is itself full of pale rectangles. Points are
   * projected raw rather than through {@link _project}, because that clamps
   * off-range contacts onto the rim: doing that to a road would fold the far
   * side of the track into a ring round the edge of the dial.
   */
  _drawCircuit(px, pz, sin, cos, scale) {
    const pts = this.circuit;
    const ctx = this.ctx;
    const cx = this._cx;
    const cy = this._cy;

    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const dx = pts[i][0] - px;
      const dz = pts[i][1] - pz;
      const x = cx + (dx * cos - dz * sin) * scale;
      const y = cy - (-dx * sin - dz * cos) * scale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(2,7,12,0.92)';
    ctx.lineWidth = 7.5;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(120,196,220,0.8)';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(226,246,255,0.9)';
    ctx.lineWidth = 1.3;
    ctx.stroke();

    // Start/finish, across the road rather than along it: the tangent at
    // sample 0 gives the road direction, so its perpendicular is the line.
    const a = pts[0];
    const b = pts[1 % pts.length];
    const tx = b[0] - a[0];
    const tz = b[1] - a[1];
    const len = Math.hypot(tx, tz) || 1;
    const nx = (-tz / len) * 9;
    const nz = (tx / len) * 9;
    const p0x = cx + ((a[0] - nx - px) * cos - (a[1] - nz - pz) * sin) * scale;
    const p0y = cy - (-(a[0] - nx - px) * sin - (a[1] - nz - pz) * cos) * scale;
    const p1x = cx + ((a[0] + nx - px) * cos - (a[1] + nz - pz) * sin) * scale;
    const p1y = cy - (-(a[0] + nx - px) * sin - (a[1] + nz - pz) * cos) * scale;
    ctx.beginPath();
    ctx.moveTo(p0x, p0y);
    ctx.lineTo(p1x, p1y);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.6;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  /**
   * One dot per rival, in its livery colour.
   *
   * The player is *not* drawn here: they are the arrow at the centre, which
   * already reads as "you" everywhere else in this game and additionally shows
   * which way they are pointing. A ring is drawn round it instead, so the arrow
   * is visibly a member of the same set as the dots rather than a different
   * kind of thing that happens to be on the same map.
   *
   * Place numbers are drawn for the leader and for whoever is immediately ahead
   * of and behind the player - the three that decide what the driver does next.
   * Numbering all ten turns a 220 px dial into a wall of digits.
   */
  _drawRacers(px, pz, sin, cos, scale, elapsed) {
    const ctx = this.ctx;
    const list = this.racers;
    let mine = 0;
    for (let i = 0; i < list.length; i++) if (list[i].isPlayer) mine = list[i].place;

    for (let i = 0; i < list.length; i++) {
      const ring = list[i];
      if (ring.type !== 'ring') continue;
      this._project(ring.x, ring.z, px, pz, sin, cos, scale);
      const pulse = ring.next ? 0.5 + 0.5 * Math.sin(elapsed * 5.0) : 0;
      ctx.save();
      ctx.translate(_pt.x, _pt.y);
      ctx.strokeStyle = ring.next ? '#52e9ff' : 'rgba(255,209,102,0.92)';
      ctx.fillStyle = ring.next ? 'rgba(82,233,255,0.14)' : 'rgba(255,209,102,0.10)';
      ctx.shadowColor = ring.next ? 'rgba(82,233,255,0.95)' : 'rgba(255,209,102,0.75)';
      ctx.shadowBlur = ring.next ? 8 + pulse * 7 : 5;
      ctx.lineWidth = ring.next ? 2.2 : 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, ring.next ? 6.2 + pulse * 1.8 : 5.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.font = '700 7px "Chakra Petch", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = ring.next ? '#d8fbff' : '#ffe4a3';
      ctx.fillText(String(ring.number ?? ring.index + 1), 0, 0.3);
      ctx.restore();
    }

    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (r.type === 'ring' || r.isPlayer) continue;
      this._project(r.x, r.z, px, pz, sin, cos, scale);
      const css = toCss(r.color, '#9fb4c4');
      ctx.save();
      ctx.translate(_pt.x, _pt.y);
      ctx.fillStyle = css;
      ctx.shadowColor = css;
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.arc(0, 0, 3.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(3,8,14,0.9)';
      ctx.lineWidth = 1;
      ctx.stroke();

      const near = mine > 0 && Math.abs(r.place - mine) === 1;
      if (r.place === 1 || near) {
        ctx.font = '700 8px "Chakra Petch", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(3,8,14,0.9)';
        ctx.fillRect(-6, -13, 12, 9);
        ctx.fillStyle = r.place === 1 ? '#ffd166' : css;
        ctx.fillText(String(r.place), 0, -8.5);
      }
      ctx.restore();
    }

    const pulse = 0.5 + 0.5 * Math.sin(elapsed * 3.4);
    ctx.save();
    ctx.strokeStyle = `rgba(82,233,255,${0.35 + pulse * 0.4})`;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(this._cx, this._cy, 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Gold coin marking a trader, at {@link _pt}.
   *
   * Traders are the one thing on this map the player actively navigates *to*,
   * so unlike every other contact they stay legible off-range: instead of the
   * generic cyan rim chevron they keep their own gold chevron with the coin
   * riding on it, which means the map always answers "which way is a shop"
   * however far the player has wandered or however far the map is zoomed in.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} cx map centre x
   * @param {number} cy map centre y
   * @param {number} elapsed seconds, for the idle shimmer
   * @param {boolean} inside whether the trader is within the mapped range
   */
  _traderMarker(ctx, cx, cy, elapsed, inside) {
    const x = _pt.x;
    const y = _pt.y;
    ctx.save();
    ctx.translate(x, y);

    if (!inside) {
      // Point the chevron outward, then un-rotate so the coin stays upright.
      const a = Math.atan2(y - cy, x - cx);
      ctx.save();
      ctx.rotate(a);
      ctx.fillStyle = 'rgba(255,201,92,0.9)';
      ctx.beginPath();
      ctx.moveTo(6.5, 0);
      ctx.lineTo(-1.5, 4);
      ctx.lineTo(-1.5, -4);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      // Nudge the coin back toward the middle so it is not half off the dial.
      ctx.translate(Math.cos(a) * -6, Math.sin(a) * -6);
    }

    // A slow breath keeps it findable against a busy floorplan without the
    // twitchiness of a blink.
    const pulse = 0.5 + 0.5 * Math.sin(elapsed * 2.2);
    ctx.shadowColor = 'rgba(255,201,92,0.95)';
    ctx.shadowBlur = 6 + pulse * 5;

    ctx.fillStyle = '#ffc95c';
    ctx.beginPath();
    ctx.arc(0, 0, 4.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(60,38,4,0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, 4.2, 0, Math.PI * 2);
    ctx.stroke();

    // Coin face: a bar through a stroked ring reads as currency at 8 px far
    // better than a glyph does - a letterform at this size is just a smudge.
    ctx.strokeStyle = 'rgba(60,38,4,0.95)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(0, 0, 1.9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -3.1);
    ctx.lineTo(0, 3.1);
    ctx.stroke();

    ctx.restore();
  }

  /**
   * A world cache, at {@link _pt}.
   *
   * Two kinds and two silhouettes, because the difference is the whole point:
   * a droplet means "you are going to have to swim for this", a chevron means
   * "you are going to have to get up there". Like traders they keep a rim
   * marker when off-range, since a cache is only ever worth drawing if the
   * player can work out which way to walk.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} cx map centre x
   * @param {number} cy map centre y
   * @param {number} elapsed seconds
   * @param {boolean} inside within the mapped range
   * @param {'sunken'|'high'} kind
   * @param {number} i index, to decorrelate the pulses
   */
  _cacheMarker(ctx, cx, cy, elapsed, inside, kind, i) {
    const sunken = kind === 'sunken';
    const tint = sunken ? '#4fd8ff' : '#b6ff5a';
    const x = _pt.x;
    const y = _pt.y;
    ctx.save();
    ctx.translate(x, y);

    if (!inside) {
      const a = Math.atan2(y - cy, x - cx);
      ctx.save();
      ctx.rotate(a);
      ctx.fillStyle = sunken ? 'rgba(79,216,255,0.85)' : 'rgba(182,255,90,0.85)';
      ctx.beginPath();
      ctx.moveTo(6, 0);
      ctx.lineTo(-1.5, 3.6);
      ctx.lineTo(-1.5, -3.6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      ctx.translate(Math.cos(a) * -6, Math.sin(a) * -6);
    }

    const pulse = 0.5 + 0.5 * Math.sin(elapsed * 1.9 + i * 1.3);
    ctx.shadowColor = tint;
    ctx.shadowBlur = 5 + pulse * 6;
    ctx.fillStyle = tint;

    ctx.beginPath();
    if (sunken) {
      // Droplet: round bottom, pointed top.
      ctx.moveTo(0, -5);
      ctx.quadraticCurveTo(3.6, -0.6, 3.2, 1.4);
      ctx.arc(0, 1.4, 3.2, 0, Math.PI);
      ctx.quadraticCurveTo(-3.6, -0.6, 0, -5);
    } else {
      // Double chevron pointing up: "above you".
      ctx.moveTo(0, -4.6);
      ctx.lineTo(4, 0.4);
      ctx.lineTo(1.9, 0.4);
      ctx.lineTo(0, -1.5);
      ctx.lineTo(-1.9, 0.4);
      ctx.lineTo(-4, 0.4);
      ctx.closePath();
      ctx.moveTo(0, -0.6);
      ctx.lineTo(4, 4.4);
      ctx.lineTo(1.9, 4.4);
      ctx.lineTo(0, 2.5);
      ctx.lineTo(-1.9, 4.4);
      ctx.lineTo(-4, 4.4);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /**
   * Ring over a contract giver at {@link _pt}. Solid once the job is ready to
   * hand in, hollow while it is still outstanding - the same read as a quest
   * marker in any game the player has met before.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} elapsed
   * @param {boolean} ready
   */
  _contractMarker(ctx, elapsed, ready) {
    const bob = Math.sin(elapsed * 3) * 1.2;
    ctx.save();
    ctx.translate(_pt.x, _pt.y - 10 + bob);
    ctx.shadowColor = 'rgba(255,180,74,0.9)';
    ctx.shadowBlur = ready ? 8 : 4;
    ctx.strokeStyle = '#ffb44a';
    ctx.fillStyle = '#ffb44a';
    ctx.lineWidth = 1.6;
    // A bang: stem plus dot, the least ambiguous "something here" glyph there is.
    ctx.beginPath();
    ctx.moveTo(0, -4.4);
    ctx.lineTo(0, 0.6);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 3, 1.25, 0, Math.PI * 2);
    if (ready) ctx.fill();
    else ctx.stroke();
    ctx.restore();
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
