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
 * ## There is no you-are-here marker, and that is the feature
 *
 * The player gets the shape of the level and has to locate themselves by
 * matching the junction pattern around them against the drawing. That is the
 * central navigational challenge, and it is the reason a map does not
 * trivialise a 2.4 km maze that re-rolls every entry.
 *
 * It is also, obviously, the first thing anyone would add to be helpful — so
 * `scripts/tests/maze-map-binding.test.mjs` greps this file for the
 * ingredients (a player position, a marker) and fails if they appear. A
 * comment asking nicely would not have survived.
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

/** Pixels per cell in the baked image. 400 cells × 2 = an 800 px square. */
const MAP_PX_PER_CELL = 2;
const MAP_BG = '#0d130e';
const MAP_WALL = '#8fd67a';
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 6;

export class MazeMap {
  /**
   * @param {{root:HTMLElement, bus:any, input:any, worldManager:any}} ctx
   */
  constructor({ root, bus, input, worldManager }) {
    this.bus = bus ?? null;
    this.input = input ?? null;
    this.worldManager = worldManager ?? null;

    this._open = false;
    this._baked = null;
    this._bakedKey = null;
    this._zoom = 1;
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
          <span class="mz-map-hint">DRAG TO PAN · WHEEL TO ZOOM · M OR ESC TO CLOSE</span>
        </div>
        <canvas class="mz-map-canvas"></canvas>
        <div class="mz-map-foot">This map shows the level you are standing on. It does not show where you are.</div>
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
    this._zoom = 1;
    this._panX = 0;
    this._panY = 0;
    this._draw();
    this.bus?.emit('ui:modal', { id: 'maze-map', open: true });
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this.el.hidden = true;
    this.bus?.emit('ui:modal', { id: 'maze-map', open: false });
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
    c.lineWidth = Math.max(1, px * 0.5);
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
    ctx.imageSmoothingEnabled = this._zoom < 2;
    ctx.drawImage(baked, ox, oy, dw, dh);
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
