import './maze-map.css';
import { MAZE } from '../worlds/maze/MazeTopology.js';
import { levelSegments } from '../worlds/maze/MazePlan.js';
import { mapActionOwner } from '../worlds/WorldRules.js';

/**
 * The `M` map — the level you are standing in, and nothing else.
 *
 * ## What it draws, and from what
 *
 * One level, rasterised from `world.cells` via `levelSegments`, never from
 * geometry. That is the spec's rule (section 3: the topology array is the
 * single source of truth for the map) and it is also the only thing that could
 * work — geometry exists only for the handful of districts currently streamed
 * in, so a map drawn from it would be a map of wherever you happen to be
 * standing.
 *
 * ## It shows where you are, by the owner's decision
 *
 * The original spec was emphatic that it must NOT. The player was to get the
 * shape of the level and locate themselves by matching the junction pattern
 * around them, and that was called the central navigational challenge and the
 * reason a map does not trivialise a 2.4 km maze. This file used to carry a
 * test that grepped it for a player position and failed if one appeared.
 *
 * The owner reversed that decision, so the marker is here and the spec has
 * been amended to match rather than left contradicting the code. Recorded
 * because the original reasoning was sound and someone may want it back: the
 * argument against was difficulty, not correctness.
 *
 * ## Why it bakes
 *
 * 400 × 400 cells is 160,000 cells and roughly 160,000 line segments. That is
 * rasterised ONCE per level into an offscreen canvas and then panned and
 * zoomed as an image; re-stroking it per frame would be absurd, and the spec
 * says once. The bake is keyed on seed AND level for the same reason
 * `minimapPlanKey` is: the maze re-rolls, and a cache that ignores the seed
 * draws the previous run's walls.
 */

/**
 * Pixels per cell in the baked image. 400 cells × 4 = a 1600 px square.
 *
 * The spec suggested 2 px/cell, and 2 was measured unreadable: an 800 px image
 * shown in a ~600 px panel puts a cell under 1.5 px, and the walls merge into
 * green noise rather than junctions anyone could match against a corridor.
 * 1600² costs about 10 MB once, which is nothing next to being able to read
 * the thing.
 */
const MAP_PX_PER_CELL = 4;
const MAP_BG = '#0d130e';
/* Muted deliberately. The walls were a bright #8fd67a, and against 160,000 of
 * them a marker dot simply disappeared - the map has to carry both, and the
 * walls are the thing there is most of. */
const MAP_WALL = '#4b7a3f';
/**
 * Zoom 1 fits the whole level in the panel. That view is a SHAPE, not a map -
 * 400 cells across any real screen is sub-pixel per cell - so it is the floor
 * rather than the default.
 */
/** Marker palette. Distinct hues, because the whole point is telling them apart. */
const MARK = Object.freeze({
  player: '#ffffff',
  stair: '#d8cdb0',
  lift: '#8ad0ff',
  tunnel: '#e0b070',
  token: '#8fe0c9',
  portal: '#8fd67a',
  centre: '#ffd479',
  path: '#ff7ad4',
});

const MIN_ZOOM = 1;
const MAX_ZOOM = 16;

/**
 * How many cells to show across the panel when the map opens.
 *
 * A player reads this by matching the junction pattern around them against the
 * drawing, so the opening view has to be at junction scale. `DEFAULT_ZOOM` is
 * derived from it rather than written down: at zoom z the panel shows
 * `MAZE.CELLS / z` cells across.
 */
const OPEN_CELLS_ACROSS = 90;

export class MazeMap {
  /**
   * @param {{root:HTMLElement, bus:any, input:any, worldManager:any}} ctx
   */
  constructor({ root, bus, input, worldManager, player }) {
    this.bus = bus ?? null;
    this.input = input ?? null;
    this.worldManager = worldManager ?? null;
    /* For the you-are-here marker. Read live rather than cached: the marker
     * has to track, which is also why the map redraws on a frame loop while it
     * is open instead of only on pan and zoom. */
    this.player = player ?? null;
    this._raf = 0;
    /* The Ctrl+M cheat. Off on open, every time - it is a way out of being
     * stuck, not a mode to leave switched on. */
    this._showPath = false;
    /* Which level the player has paged to, or null for "the one they are on".
     * Cleared on every open - see `_level`. */
    this._levelOverride = null;

    this._open = false;
    this._baked = null;
    this._bakedKey = null;
    this._zoom = MAZE.CELLS / OPEN_CELLS_ACROSS;
    this._panX = 0;
    this._panY = 0;
    this._drag = null;

    this.el = document.createElement('div');
    this.el.className = 'mz-map';
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="mz-map-panel">
        <div class="mz-map-head">
          <span class="mz-map-title">THE VERDANT COIL</span>
          <span class="mz-map-level" data-level></span>
          <span class="mz-map-levels" data-levels></span>
          <button type="button" class="mz-map-tab mz-map-recentre" data-recentre>FIND ME</button>
          <span class="mz-map-hint">WHEEL SCROLLS · CTRL+WHEEL ZOOMS · 1-4 FLOOR · ESC</span>
        </div>
        <canvas class="mz-map-canvas"></canvas>
        <div class="mz-map-foot">
          <span class="mz-key"><i style="background:#ffffff"></i>you</span>
          <span class="mz-key"><i style="background:#d8cdb0"></i>stairs</span>
          <span class="mz-key"><i style="background:#8ad0ff"></i>lift</span>
          <span class="mz-key"><i style="background:#e0b070"></i>tunnel</span>
          <span class="mz-key"><i style="background:#8fe0c9"></i>token</span>
          <span class="mz-key"><i style="background:#ffd479"></i>centre</span>
          <span class="mz-key"><i style="background:#8fd67a"></i>portal</span>
        </div>
      </div>`;
    (root ?? document.body).appendChild(this.el);

    this.canvas = this.el.querySelector('.mz-map-canvas');
    this.levelEl = this.el.querySelector('[data-level]');
    this.levelsEl = this.el.querySelector('[data-levels]');
    /* One tab per level, so paging between the four floors is visible rather
     * than a key you have to already know about. */
    for (let i = 0; i < MAZE.LEVELS; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mz-map-tab';
      b.textContent = String(i + 1);
      b.dataset.lvl = String(i);
      b.addEventListener('click', () => this.setLevel(i));
      this.levelsEl.appendChild(b);
    }
    /* Recentre. Free scrolling over a 400-cell grid means losing yourself is
     * one flick of the wheel, and hunting for a marker you cannot see is worse
     * than not having scrolled at all. Snaps back to the player's own level
     * too - being centred on where you are while reading a different floor
     * would centre on nothing. */
    this.el.querySelector('[data-recentre]').addEventListener('click', () => this.recentre());

    this._onKey = this._onKey.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onDown = this._onDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);

    window.addEventListener('keydown', this._onKey, true);
    this.canvas.addEventListener('wheel', this._onWheel, { passive: false });
    this.canvas.addEventListener('pointerdown', this._onDown);
    window.addEventListener('pointermove', this._onMove);
    window.addEventListener('pointerup', this._onUp);
  }

  get isOpen() {
    return this._open;
  }

  /** The active world, but only when it is one this map can draw. */
  _mazeWorld() {
    const w = this.worldManager?.active;
    if (!w || mapActionOwner(w) !== 'map' || !w.cells) return null;
    return w;
  }

  toggle() {
    if (this._open) this.close(); else this.open();
  }

  open() {
    const w = this._mazeWorld();
    if (!w || this._open) return;
    this._open = true;
    this.el.hidden = false;
    /* Open at junction scale, not fitted. See OPEN_CELLS_ACROSS. */
    this._zoom = MAZE.CELLS / OPEN_CELLS_ACROSS;
    this._panX = 0;
    this._panY = 0;
    this._levelOverride = null;
    /* ...and centred on the player. Opening centred on the LEVEL put the
     * player off-screen almost always - the entrance is at one edge and the
     * view spans a quarter of the grid - so the first thing a map that exists
     * to show you where you are did was fail to. */
    const w0 = this._mazeWorld();
    if (w0) this._render(w0, this._level(w0));      // the bake is what centring measures against
    this._centreOnPlayer();
    this._draw();
    /* Live while open: the player moves, tokens get taken, and the centre's
     * return portal appears. A map drawn once would be wrong within seconds. */
    const tick = () => {
      if (!this._open) return;
      this._draw();
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
    this.bus?.emit('ui:modal', { id: 'maze-map', open: true });
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this.el.hidden = true;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
    this.bus?.emit('ui:modal', { id: 'maze-map', open: false });
  }

  /**
   * Pan so the player sits in the middle of the view.
   *
   * Done in the same terms `_project` uses, rather than by inverting it: the
   * two have to agree about the half-cell offset between a cell's centre and
   * the baked image's corner, and deriving one from the other is how they stop
   * agreeing.
   */
  _centreOnPlayer() {
    const pos = this.player?.position;
    const baked = this._baked;
    if (!pos || !baked) return;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 2) return;
    const fit = Math.min(rect.width / baked.width, rect.height / baked.height);
    const scale = fit * this._zoom;
    const dw = baked.width * scale, dh = baked.height * scale;
    /* Where the player would land with no pan, and how far that is from the
     * middle of the view. */
    const ox = (rect.width - dw) / 2;
    const oy = (rect.height - dh) / 2;
    const px = ox + (pos.x / MAZE.CELL + 0.5) * MAP_PX_PER_CELL * scale;
    const py = oy + (pos.z / MAZE.CELL + 0.5) * MAP_PX_PER_CELL * scale;
    this._panX = rect.width / 2 - px;
    this._panY = rect.height / 2 - py;
    /* Then pull back inside the grid. A player at the entrance is on the very
     * edge, so "centred on them" is off the map by half a panel; the marker
     * ends up off-centre instead, which is correct - there is nothing on that
     * side to look at. */
    this._clampPan(rect, baked);
  }

  /**
   * Which level to draw.
   *
   * The player's own level by default - read from the world's level tracking
   * rather than recomputed here, so the map, the minimap's plan key and the
   * shaft markers can never disagree about which level the player is on - and
   * whichever level they have paged to once they have. The override is cleared
   * on every open, so the map always starts on the floor you are standing on.
   */
  _level(w) {
    return this._levelOverride ?? this._playerLevel(w);
  }

  /** Which level the player is actually standing on, override or not. */
  _playerLevel(w) {
    return w?.playerLevel ?? 0;
  }

  /** Rasterise one level once, at MAP_PX_PER_CELL, and keep it. */
  _render(w, level) {
    const key = `${w.seed}:${level}`;
    if (this._bakedKey === key && this._baked) return this._baked;

    const px = MAP_PX_PER_CELL;
    const cv = document.createElement('canvas');
    cv.width = MAZE.CELLS * px;
    cv.height = MAZE.CELLS * px;
    const c = cv.getContext('2d');
    c.fillStyle = MAP_BG;
    c.fillRect(0, 0, cv.width, cv.height);
    c.strokeStyle = MAP_WALL;
    c.lineWidth = Math.max(1, px * 0.4);
    c.lineCap = 'square';
    c.beginPath();
    for (const s of levelSegments(w.cells, level)) {
      c.moveTo(s.x0 * px, s.z0 * px);
      c.lineTo(s.x1 * px, s.z1 * px);
    }
    c.stroke();

    this._baked = cv;
    this._bakedKey = key;
    return this._baked;
  }

  _draw() {
    if (!this._open) return;
    const w = this._mazeWorld();
    /* Left the maze with the map still up - through the centre's return portal,
     * an Unstuck respawn, or any other world change. This used to return early
     * and leave the panel frozen on the last maze it drew, over a station that
     * had nothing to do with it, swallowing clicks and with no world left whose
     * map key would close it. It is not a map of anywhere any more, so it goes. */
    if (!w) { this.close(); return; }
    const level = this._level(w);
    const baked = this._render(w, level);
    const here = this._playerLevel(w);
    if (this.levelEl) {
      this.levelEl.textContent = level === here
        ? `LEVEL ${level + 1} OF ${MAZE.LEVELS}`
        : `LEVEL ${level + 1} OF ${MAZE.LEVELS} — YOU ARE ON ${here + 1}`;
    }
    if (this.levelsEl) {
      for (const b of this.levelsEl.children) {
        const n = Number(b.dataset.lvl);
        b.classList.toggle('is-on', n === level);
        b.classList.toggle('is-here', n === here);
      }
    }

    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(2, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(2, Math.round(rect.height * dpr));

    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = MAP_BG;
    ctx.fillRect(0, 0, rect.width, rect.height);

    /* Fit the whole level, then apply the player's zoom on top, so zoom 1 is
     * always "the level, whole" regardless of the window's size. */
    const fit = Math.min(rect.width / baked.width, rect.height / baked.height);
    const scale = fit * this._zoom;
    const dw = baked.width * scale, dh = baked.height * scale;
    const ox = (rect.width - dw) / 2 + this._panX;
    const oy = (rect.height - dh) / 2 + this._panY;
    ctx.imageSmoothingEnabled = this._zoom < 1.5;
    ctx.drawImage(baked, ox, oy, dw, dh);

    /* Markers go on TOP of the baked image, never into it: the bake is cached
     * per seed and level, so a token that has been picked up or a portal that
     * has just opened would be frozen into it. */
    this._drawMarkers(ctx, w, level, ox, oy, scale);
  }

  /**
   * World metres to canvas pixels, for the current pan and zoom.
   *
   * The half-cell offset is because cell 0,0's CENTRE is the world origin,
   * while the baked image starts at that cell's top-left corner. Without it
   * every marker sits half a corridor off its wall, which is exactly wrong
   * enough to look like a rounding bug rather than an offset one.
   */
  _project(wx, wz, ox, oy, scale) {
    return {
      x: ox + (wx / MAZE.CELL + 0.5) * MAP_PX_PER_CELL * scale,
      y: oy + (wz / MAZE.CELL + 0.5) * MAP_PX_PER_CELL * scale,
    };
  }

  /**
   * A marker dot with a dark ring.
   *
   * The ring is not decoration: a flat dot on a dense wall pattern reads as
   * one more wall, and the first pass was measured unreadable for exactly
   * that reason. The ring gives every marker its own edge whatever it lands on.
   */
  _dot(ctx, p, r, colour) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    ctx.fill();
    ctx.lineWidth = Math.max(1, r * 0.42);
    ctx.strokeStyle = 'rgba(3, 8, 4, 0.9)';
    ctx.stroke();
  }

  _drawMarkers(ctx, world, level, ox, oy, scale) {
    const m = world.mapMarkers?.(level);
    if (!m) return;

    /* Sized against the VIEW rather than the world, so a marker stays legible
     * zoomed out and does not swamp the corridor zoomed in. */
    const r = Math.max(3.4, Math.min(10, 4.0 * this._zoom ** 0.35));

    for (const s of m.stair) this._dot(ctx, this._project(s.x, s.z, ox, oy, scale), r, MARK.stair);
    for (const s of m.lift) this._dot(ctx, this._project(s.x, s.z, ox, oy, scale), r, MARK.lift);
    for (const s of m.tunnel) this._dot(ctx, this._project(s.x, s.z, ox, oy, scale), r, MARK.tunnel);
    for (const s of m.token) this._dot(ctx, this._project(s.x, s.z, ox, oy, scale), r * 0.7, MARK.token);
    for (const s of m.centre) this._dot(ctx, this._project(s.x, s.z, ox, oy, scale), r * 1.5, MARK.centre);

    /* Portals as a ring, so a way out does not read as one more collectable in
     * a field of dots. */
    for (const s of m.portal) {
      const p = this._project(s.x, s.z, ox, oy, scale);
      ctx.strokeStyle = MARK.portal;
      ctx.lineWidth = Math.max(1.5, r * 0.5);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 1.6, 0, Math.PI * 2);
      ctx.stroke();
    }

    /* Under the player marker but over everything else, so it never hides the
     * thing you are trying to locate. */
    if (this._showPath) this._drawSolution(ctx, world, level, ox, oy, scale, r);
    this._drawPlayer(ctx, level, ox, oy, scale, r);
  }

  /**
   * The Ctrl+M solution path, from where the player is standing to the centre.
   *
   * Only the segments on the level being drawn. A route that vanishes at a
   * staircase and picks up again on the level above is what the player needs
   * to see - drawing the whole thing flattened would suggest a way through a
   * floor.
   */
  _drawSolution(ctx, world, level, ox, oy, scale, r) {
    const path = world.solutionPath?.(this.player?.position);
    if (!path || path.length < 2) return;

    ctx.strokeStyle = MARK.path;
    ctx.lineWidth = Math.max(2, r * 0.9);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.globalAlpha = 0.85;

    let drawing = false;
    ctx.beginPath();
    for (const step of path) {
      if (step.level !== level) { drawing = false; continue; }
      const p = this._project(step.x, step.z, ox, oy, scale);
      if (!drawing) { ctx.moveTo(p.x, p.y); drawing = true; } else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /** You are here - a triangle, because a dot would not say which way you face. */
  _drawPlayer(ctx, level, ox, oy, scale, r) {
    const pos = this.player?.position;
    if (!pos) return;
    /* Only on the level being drawn. Standing on level 2 while reading level 0
     * must not plant a marker in a corridor the player is nowhere near. */
    const on = Math.max(0, Math.min(MAZE.LEVELS - 1, Math.round(pos.y / MAZE.LEVEL_HEIGHT)));
    if (on !== level) return;

    const p = this._project(pos.x, pos.z, ox, oy, scale);
    /* `Player.yaw` uses the same convention MazeWorld's DIR_YAW does - forward
     * is (-sin yaw, -cos yaw) - and -z is up-screen on this canvas, so the
     * world's forward vector maps straight onto it. */
    const yaw = Number.isFinite(this.player?.yaw) ? this.player.yaw : 0;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const size = Math.max(9, r * 3.0);

    ctx.fillStyle = MARK.player;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(p.x + fx * size, p.y + fz * size);
    ctx.lineTo(p.x - fz * size * 0.6 - fx * size * 0.5, p.y + fx * size * 0.6 - fz * size * 0.5);
    ctx.lineTo(p.x + fz * size * 0.6 - fx * size * 0.5, p.y - fx * size * 0.6 - fz * size * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  /**
   * Keep the drawn level covering the whole viewport.
   *
   * The old rule allowed panning by up to half the image, which let the view
   * slide clean off the grid - and `_centreOnPlayer` did exactly that on every
   * open, because the entrance is ON the edge of the 400-cell grid, so putting
   * the player dead centre left the outside-the-maze void filling half the
   * panel. It read as a half-drawn map.
   *
   * So: while the image is at least as big as the view - which it is at every
   * zoom above "fitted", including the one the map opens at - pan is bounded so
   * neither edge can come inside the viewport. Below that there is nothing to
   * pan and the image is simply centred.
   */
  _clampPan(rect, baked) {
    const fit = Math.min(rect.width / baked.width, rect.height / baked.height);
    const dw = baked.width * fit * this._zoom, dh = baked.height * fit * this._zoom;
    const limX = Math.max(0, (dw - rect.width) / 2);
    const limY = Math.max(0, (dh - rect.height) / 2);
    this._panX = Math.max(-limX, Math.min(limX, this._panX));
    this._panY = Math.max(-limY, Math.min(limY, this._panY));
  }

  _onKey(e) {
    /* Ctrl+M: the hidden solution path.
     *
     * Checked BEFORE the modifier guard below, which exists so that browser
     * and OS chords are not swallowed - this one is deliberately a chord, and
     * only while the map is already open, so it cannot be found by mashing
     * keys in a corridor. */
    const bound = this.input?.codeFor?.('map') ?? 'KeyM';
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.code === bound && this._open) {
      e.preventDefault();
      this._showPath = !this._showPath;
      this._draw();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (this._open && e.code === 'Escape') {
      e.preventDefault();
      this.close();
      return;
    }
    /* Paging between floors while the map is open: 1-4, or the bracket and
     * page keys for anyone who reaches for those instead. Guarded on `_open`
     * so none of them shadow a binding out in the corridor. */
    if (this._open) {
      const digit = e.code.match(/^(?:Digit|Numpad)([1-9])$/);
      if (digit) {
        const n = Number(digit[1]) - 1;
        if (n < MAZE.LEVELS) { e.preventDefault(); this.setLevel(n); return; }
      }
      const w = this._mazeWorld();
      const cur = w ? this._level(w) : 0;
      if (e.code === 'BracketRight' || e.code === 'PageUp') {
        e.preventDefault(); this.setLevel(cur + 1); return;
      }
      if (e.code === 'BracketLeft' || e.code === 'PageDown') {
        e.preventDefault(); this.setLevel(cur - 1); return;
      }
      if (e.code === 'Home') { e.preventDefault(); this.recentre(); return; }
    }
    if (this.input?.textCaptured) return;
    /* The bound `map` code, so a rebind moves this and the mount wheel
     * together - see `mapActionOwner`. Falls back to KeyM if Input has no
     * opinion, which is what the default binding is anyway. */
    const code = this.input?.codeFor?.('map') ?? 'KeyM';
    if (e.code !== code) return;
    if (mapActionOwner(this.worldManager?.active) !== 'map') return;
    e.preventDefault();
    this.toggle();
  }

  /**
   * The wheel SCROLLS the map. Ctrl (or Cmd) with it zooms.
   *
   * Round the other way at first, which is the usual choice for a map widget,
   * but this one opens zoomed in on a grid four times wider than the panel, so
   * scrolling is the thing you do constantly and zooming is the thing you do
   * once. Shift swaps the axis, as it does in every scroll pane, and a
   * trackpad's own horizontal delta is honoured directly.
   */
  _onWheel(e) {
    if (!this._open) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.exp(-e.deltaY * 0.0015);
      this._zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this._zoom * factor));
    } else {
      const step = e.deltaMode === 1 ? 24 : 1;    // 1 = lines, 0 = pixels
      const dx = e.deltaX * step, dy = e.deltaY * step;
      if (e.shiftKey) this._panX -= dy || dx;
      else { this._panX -= dx; this._panY -= dy; }
    }
    if (this._baked) this._clampPan(this.canvas.getBoundingClientRect(), this._baked);
    this._draw();
  }

  /**
   * Show a different level of the maze.
   *
   * Pan is deliberately KEPT across the switch. The four levels stack in the
   * same XZ footprint, so holding position is what makes flicking between them
   * useful - you are comparing the same patch of ground, looking for where the
   * corridor above continues.
   */
  /** Snap the view back to the player, on the player's own level. */
  recentre() {
    this._levelOverride = null;
    const w = this._mazeWorld();
    if (w) this._render(w, this._level(w));
    this._centreOnPlayer();
    this._draw();
  }

  setLevel(level) {
    const n = Math.max(0, Math.min(MAZE.LEVELS - 1, Math.round(level)));
    if (n === this._levelOverride) return;
    this._levelOverride = n;
    this._draw();
  }

  _onDown(e) {
    if (!this._open) return;
    this._drag = { x: e.clientX, y: e.clientY };
    this.canvas.setPointerCapture?.(e.pointerId);
  }

  _onMove(e) {
    if (!this._open || !this._drag) return;
    this._panX += e.clientX - this._drag.x;
    this._panY += e.clientY - this._drag.y;
    this._drag = { x: e.clientX, y: e.clientY };
    if (this._baked) this._clampPan(this.canvas.getBoundingClientRect(), this._baked);
    this._draw();
  }

  _onUp() {
    this._drag = null;
  }

  dispose() {
    window.removeEventListener('keydown', this._onKey, true);
    window.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp);
    this.el.remove();
    this._baked = null;
    this._bakedKey = null;
  }
}
