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
          <span class="mz-map-hint">DRAG · WHEEL · ESC</span>
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
  }

  /**
   * Which level to draw.
   *
   * Read from the world's own level tracking rather than recomputed here, so
   * the map, the minimap's plan key and the shaft markers can never disagree
   * about which level the player is on.
   */
  _level(w) {
    return w._markersLevel ?? 0;
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
    const w = this._mazeWorld();
    if (!w || !this._open) return;
    const level = this._level(w);
    const baked = this._render(w, level);
    if (this.levelEl) this.levelEl.textContent = `LEVEL ${level + 1} OF ${MAZE.LEVELS}`;

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

    this._drawPlayer(ctx, level, ox, oy, scale, r);
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

  _clampPan(rect, baked) {
    /* Never let the level be lost off-screen entirely - panning past the edge
     * by more than half the view is how a player ends up staring at nothing
     * and assumes the map is broken. */
    const fit = Math.min(rect.width / baked.width, rect.height / baked.height);
    const dw = baked.width * fit * this._zoom, dh = baked.height * fit * this._zoom;
    const limX = Math.max(rect.width * 0.5, dw / 2);
    const limY = Math.max(rect.height * 0.5, dh / 2);
    this._panX = Math.max(-limX, Math.min(limX, this._panX));
    this._panY = Math.max(-limY, Math.min(limY, this._panY));
  }

  _onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (this._open && e.code === 'Escape') {
      e.preventDefault();
      this.close();
      return;
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

  _onWheel(e) {
    if (!this._open) return;
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0015);
    this._zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this._zoom * factor));
    if (this._baked) this._clampPan(this.canvas.getBoundingClientRect(), this._baked);
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
