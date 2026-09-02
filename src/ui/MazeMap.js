import './maze-map.css';
import { MAZE } from '../worlds/maze/MazeTopology.js';
import { levelSegments } from '../worlds/maze/MazePlan.js';
import { mapActionOwner } from '../worlds/WorldRules.js';
import { OVERVIEW, sheetFor, paneAt, verticalLinks } from './MazeMapLayout.js';

/**
 * The `M` map — all four levels of the maze, and where you are in them.
 *
 * ## What it draws, and from what
 *
 * Levels, rasterised from `world.cells` via `levelSegments`, never from
 * geometry. That is the spec's rule (section 3: the topology array is the
 * single source of truth for the map) and it is also the only thing that could
 * work — geometry exists only for the handful of districts currently streamed
 * in, so a map drawn from it would be a map of wherever you happen to be
 * standing.
 *
 * ## Why it opens on all four
 *
 * It used to open on the level under your feet, with `1`–`4` to page. By the
 * owner's ruling (2026-08-09) `M` now opens the whole building: four
 * floorplans side by side, laid out by `MazeMapLayout`. The maze is one
 * connected volume and the thing a player is actually asking is "where does
 * this floor let me up" — a question a single floorplan cannot answer, and one
 * that four of them answer at a glance.
 *
 * Paging survives it. `1`–`4` (and the tabs, and the brackets) still drop to a
 * single floor at junction scale, which is the scale you read a corridor at;
 * `0` or the ALL tab comes back. The overview is the index, the single floor
 * is the page — and since it is an index, clicking a floorplan opens it, which
 * is what anyone who has ever used one expects and is a shorter reach than a
 * number key nobody has been told about.
 *
 * ## Why side by side and never superimposed
 *
 * The four levels share one XZ footprint, so they could be overlaid and tinted
 * by depth. They are not, for the reason the route drawing has always given:
 * flattened, a corridor on the floor above reads as a way through this one.
 * Where the route does change floor, that is drawn as an explicit link between
 * two panes — see `_drawLevelChanges`.
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
 *
 * All four bakes are now kept rather than one, because the overview needs
 * them all at once and because paging between floors used to re-rasterise on
 * every press. They are dropped the moment the seed changes, which is the only
 * thing that can invalidate them.
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
/* The frame and caption around each floorplan in the overview. Without them
 * four abutting grids of identical hedge texture read as one 800-cell maze. */
const PANE_EDGE = 'rgba(143, 214, 122, 0.30)';
const PANE_EDGE_HERE = 'rgba(255, 255, 255, 0.55)';
const PANE_LABEL = '#cfe6c4';
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
 * How far the pointer may travel, and how long it may be held, and still count
 * as a click on a floorplan rather than a pan that happened to end where it
 * started.
 *
 * The canvas has to serve both gestures on the same button, so something has
 * to separate them. Distance alone was the first attempt and is not enough: a
 * long, careful drag around the sheet that returns to within a few pixels of
 * its origin would page the map to a floor the player never asked for. The
 * time bound closes that, and costs nothing, because nobody clicks a thing for
 * half a second.
 *
 * 5 px rather than the 3 a mouse would want: the map is also usable by touch
 * and by pen, where a finger rolls a couple of pixels on every tap and a 3 px
 * bound simply makes taps stop working.
 */
const CLICK_SLOP_PX = 5;
const CLICK_HOLD_MS = 500;

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
    /* Which view the player has paged to: a level number, `OVERVIEW`, or null
     * for "the level they are standing on". Reset to OVERVIEW on every open -
     * see `_view`. */
    this._levelOverride = OVERVIEW;

    this._open = false;
    /* Whether the pointer was locked at the moment the map opened, so `close`
     * knows whether restoring the lock is putting something back or taking
     * something the player never had. See `open` for why the lock is dropped
     * at all, and `close` for why the restore is conditional. */
    this._hadLock = false;
    /* One baked floorplan per level, keyed by level, all thrown away together
     * when the seed changes. See the header: the overview needs four at once,
     * and a cache of one re-rasterised 160,000 segments on every page. */
    this._bakes = new Map();
    this._bakeSeed = null;
    this._zoom = MAZE.CELLS / OPEN_CELLS_ACROSS;
    this._panX = 0;
    this._panY = 0;
    this._drag = null;
    /**
     * Every pointer currently down on the canvas, by `pointerId`.
     *
     * The pan only ever needed one and tracked it in `_drag`. A pinch needs
     * two AT ONCE, and there is no event that hands you both - `pointermove`
     * fires once per finger with only that finger's position on it - so the
     * live set has to be kept.
     * @type {Map<number, {x:number, y:number}>}
     */
    this._pointers = new Map();
    /**
     * The span and midpoint the pinch was last measured at, or null.
     *
     * Both terms are needed. The RATIO of the spans is the zoom factor, and
     * the midpoint is both the anchor to zoom about and, by its own movement,
     * the pan - two fingers that travel together across the panel are dragging
     * it, and a pinch that only zoomed would fight that.
     * @type {{d:number, x:number, y:number}|null}
     */
    this._pinch = null;

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
          <span class="mz-map-hint">WHEEL OR PINCH ZOOMS · DRAG PANS · CLICK A FLOOR TO ENLARGE · FIND ME RECENTRES · 0 ALL · 1-4 FLOOR · CTRL+M ROUTE</span>
          <button type="button" class="mz-map-tab mz-map-close" data-close title="Close [Esc]">✕</button>
        </div>
        <canvas class="mz-map-canvas"></canvas>
        <div class="mz-map-foot">
          <span class="mz-key"><i style="background:#ff7ad4"></i>route (ctrl+m)</span>
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
    /* ALL first, then one tab per level. ALL leads because it is what the map
     * opens on: a player who has paged down to one floor needs the way back to
     * be the obvious control, not a `0` they were never told about. */
    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'mz-map-tab';
    all.textContent = 'ALL';
    all.dataset.lvl = OVERVIEW;
    all.addEventListener('click', () => this.showAllLevels());
    this.levelsEl.appendChild(all);
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

    /* CLOSE, as a control rather than as a word in a hint line.
     *
     * The header's hint ended in "ESC" and that was the entire close
     * affordance - which on a phone is not an affordance at all. Worse here
     * than anywhere else in the game: `open()` calls `input.exitLock()`, and
     * `TouchControls.shown` gates the whole on-screen tray on `input.locked`,
     * so opening this map takes away every touch control INCLUDING the `≡`
     * pause button. A player four levels into the Verdant Coil - the one world
     * where the map is the difference between finishing and giving up - was
     * left with a full-screen panel, no keyboard, and no way out but reloading
     * the page and losing the run.
     *
     * A `mz-map-tab` so it matches ALL and the four floor buttons it sits
     * beside; `✕` because it is universal and needs no line of hint text of its
     * own. The ESC token is dropped from the hint, because the control is now
     * the thing that says it. */
    this.el.querySelector('[data-close]').addEventListener('click', () => this.close());

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
    /* A finger that leaves the panel, a palm the browser decides is not a
     * gesture, a phone call arriving mid-drag: `pointercancel` and no
     * `pointerup`. Without it that pointer stays in `_pointers` for ever and
     * the NEXT single finger down is silently the second half of a pinch. */
    window.addEventListener('pointercancel', this._onUp);
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

    /* Give the pointer back, or none of this panel can be used.
     *
     * ── The bug this exists for (owner's report) ──────────────────────────
     *
     * "when i have map open i can not scroll wheel to zoom or use mouse to
     * select a map or find me, the mouse is locked on the game play window and
     * not the map so as i try things it is just moving the game".
     *
     * Exactly right, and it is not a listener problem: the handlers below are
     * bound to the canvas and to the buttons and always were. While the game
     * holds POINTER LOCK there is no cursor and no hit-testing at all - every
     * mouse event is delivered to the locked element as `movementX/Y`, so the
     * wheel, the floorplan click and FIND ME are not merely hard to hit, they
     * are unreachable. The map was the only panel in `src/ui` that released
     * the lock on open, which is why it was the only one that felt broken.
     *
     * `exitLock` rather than `document.exitPointerLock` directly: it also
     * hands back the keyboard lock, which is the pair `relockKeyboard` puts
     * back on close - see `Input`.
     *
     * Deliberately NOT `menuFocusIn` (InventoryUI), which the sibling panels
     * use. That helper also calls `setTextCapture(true)`, and this panel reads
     * `input.textCaptured` in `_onKey` as its "a text field owns the keyboard"
     * guard - so capturing text here would make the map key stop CLOSING the
     * map, locking the player inside the panel they just opened. */
    this._hadLock = !!this.input?.locked;
    /* Before the lock goes, not after: unlocking makes `main.js` raise the
     * STANDBY overlay, and this class is what keeps it off the map (see
     * `maze-map.css`, and the identical rules the inventory, character and
     * quest panels carry). A frame's gap here is a frame of STANDBY drawn on
     * top of the map. */
    document.body.classList.add('mz-map-open');
    this.input?.exitLock?.();

    /* All four floors, whole. The overview opens FITTED rather than at
     * junction scale: it is a plan of the building, and the question it
     * answers - which floor connects to which, and where - is answered by the
     * shape. OPEN_CELLS_ACROSS still governs the single-floor view, which is
     * the one you read a corridor against. */
    this._levelOverride = OVERVIEW;
    this._zoom = MIN_ZOOM;
    this._panX = 0;
    this._panY = 0;
    /* The Ctrl+M cheat is off on open, every time. The constructor has always
     * claimed this and never did it, so a route switched on in one visit came
     * back up in the next one, uninvited. */
    this._showPath = false;
    /* ...then centred on the player, which does nothing at all while the whole
     * sheet fits the panel and is exactly right the moment they zoom in. */
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

  /**
   * Every way out of the map comes through here.
   *
   * There are four - the map key via `toggle`, Escape in `_onKey`, and `_draw`
   * when the player has left the maze with the panel still up - and a restore
   * written into any one of them would leave the player cursor-bound on the
   * others. So the restore lives here and nowhere else; `_open` is only ever
   * cleared on this line.
   */
  close() {
    if (!this._open) return;
    this._open = false;
    this.el.hidden = true;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
    document.body.classList.remove('mz-map-open');
    /* A panel that went away mid-gesture. Escape can close the map with two
     * fingers still on the glass, and those `pointerup`s land on a hidden
     * canvas - so the set is emptied here rather than waiting for events that
     * would leave the NEXT single finger down looking like half a pinch. */
    this._pointers.clear();
    this._pinch = null;
    this._drag = null;
    /* Wheel ticks spent zooming the map are the map's, not the loadout's.
     * `Input` accumulates every wheel event on `window` regardless of who
     * handled it, and `Loadout` drains that accumulator to switch weapons - so
     * without this a zoom from 1x to 16x is banked and cashed in as a burst of
     * weapon switches the moment the map closes and gameplay resumes. */
    this.input?.consumeWheel?.();

    const hadLock = this._hadLock;
    this._hadLock = false;
    /* Only if there was a lock to put back. A player who opened the map from
     * an unlocked state - the STANDBY overlay, or another panel already up -
     * did not ask to be dropped into mouse-look on close, and grabbing the
     * pointer out from under a menu they can still see is the same bug this
     * commit is fixing, pointed the other way. */
    if (hadLock) {
      /* Delayed, and through `relockKeyboard` first, for the reasons
       * `InventoryUI.menuFocusOut` and `CharacterMenu.close` both record:
       * browsers refuse a lock request that follows an Escape-driven exit too
       * closely, and `exitLock` released the KEYBOARD lock as well as the
       * pointer - re-taking only the pointer leaves Ctrl+W live again. */
      setTimeout(() => {
          /* `reengage()` decides which engagement to re-take: the pointer
           * lock on a mouse session, the touch session on a phone. It used to
           * be `canvas.requestPointerLock()` here, which on a touch device does
           * nothing at all and left the player stood down with the world frozen
           * behind no card. @see core/Input.js `reengage` */
          const p = this.input?.reengage?.();
          if (p && typeof p.catch === 'function') p.catch(() => {});
      }, 140);
    }
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
    const w = this._mazeWorld();
    if (!pos || !w) return;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 2) return;
    const sheet = this._sheet(w);
    const fit = Math.min(rect.width / sheet.width, rect.height / sheet.height);
    const scale = fit * this._zoom;
    const dw = sheet.width * scale, dh = sheet.height * scale;
    /* Where the player would land with no pan, and how far that is from the
     * middle of the view. In the overview that means their own floor's pane -
     * centring on the sheet's origin would centre on level 1 whatever floor
     * they are standing on. */
    const pane = this._paneFor(sheet, this._standingLevel());
    const ox = (rect.width - dw) / 2 + pane.x * scale;
    const oy = (rect.height - dh) / 2 + pane.y * scale;
    const px = ox + (pos.x / MAZE.CELL + 0.5) * MAP_PX_PER_CELL * scale;
    const py = oy + (pos.z / MAZE.CELL + 0.5) * MAP_PX_PER_CELL * scale;
    this._panX = rect.width / 2 - px;
    this._panY = rect.height / 2 - py;
    /* Then pull back inside the grid. A player at the entrance is on the very
     * edge, so "centred on them" is off the map by half a panel; the marker
     * ends up off-centre instead, which is correct - there is nothing on that
     * side to look at. */
    this._clampPan(rect, sheet);
  }

  /**
   * Which view to draw: `OVERVIEW`, or one level.
   *
   * The override is reset to `OVERVIEW` on every open, so `M` always shows the
   * whole building and paging down to a floor is something you chose to do in
   * this visit rather than something the last visit left switched on.
   */
  _view(w) {
    return this._levelOverride ?? this._playerLevel(w);
  }

  /**
   * Which single level the level keys act on.
   *
   * In the overview there is no "current" floor, so the brackets and PageUp
   * step from the one the player is standing on - which is where someone
   * paging out of the overview means to start.
   */
  _level(w) {
    const view = this._view(w);
    return view === OVERVIEW ? this._playerLevel(w) : view;
  }

  /** Which level the player is actually standing on, override or not. */
  _playerLevel(w) {
    return w?.playerLevel ?? 0;
  }

  /**
   * The sheet of floorplans the current view is made of, in baked pixels.
   *
   * Cheap enough to build per frame (four small objects) and deliberately not
   * cached: pan, zoom and clamping all measure against it, and a stale sheet
   * would put the clamp and the drawing in different coordinate systems.
   */
  _sheet(w) {
    return sheetFor(this._view(w), MAZE.CELLS * MAP_PX_PER_CELL);
  }

  /** The pane a level is drawn in, or the only pane there is. */
  _paneFor(sheet, level) {
    return sheet.panes.find((p) => p.level === level) ?? sheet.panes[0];
  }

  /**
   * The one projection: where the sheet lands on the canvas, right now.
   *
   * `_draw` used to work these four terms out inline, which was fine while
   * nothing else needed them. Clicking a pane and zooming about the pointer
   * both have to INVERT them, and a second copy of the fit-then-pan arithmetic
   * is a second convention waiting to drift half a gutter away from the first —
   * the same failure `_centreOnPlayer` warns about with the half-cell offset.
   * So it is computed once, and the two things that have to run it BACKWARDS —
   * the click hit-test and the pointer-anchored zoom — invert this and nothing
   * else. (`_centreOnPlayer` still works forwards, on purpose, for the reason
   * its own comment gives.)
   */
  _frame() {
    const w = this._mazeWorld();
    if (!w) return null;
    const rect = this.canvas.getBoundingClientRect();
    const sheet = this._sheet(w);
    /* Fit the whole SHEET, then apply the player's zoom on top, so zoom 1 is
     * always "everything this view contains, whole" regardless of the window's
     * size - one level when paged to one, four when not. */
    const fit = Math.min(rect.width / sheet.width, rect.height / sheet.height);
    const scale = fit * this._zoom;
    return {
      w,
      rect,
      sheet,
      scale,
      ox: (rect.width - sheet.width * scale) / 2 + this._panX,
      oy: (rect.height - sheet.height * scale) / 2 + this._panY,
    };
  }

  /**
   * Which floorplan is under a client-space point, or `null`.
   *
   * Straight inversion of `_frame`, then `paneAt` decides — the arrangement of
   * the panes is the layout module's business and stays testable there, while
   * the part that needs a live canvas stays here and is two divisions.
   */
  _paneAtClient(clientX, clientY) {
    const f = this._frame();
    if (!f || !(f.scale > 0)) return null;
    return paneAt(
      f.sheet,
      (clientX - f.rect.left - f.ox) / f.scale,
      (clientY - f.rect.top - f.oy) / f.scale,
    );
  }

  /** Where the player is, as a level index, whatever the map is showing. */
  _standingLevel() {
    const y = this.player?.position?.y ?? 0;
    return Math.max(0, Math.min(MAZE.LEVELS - 1, Math.round(y / MAZE.LEVEL_HEIGHT)));
  }

  /** Rasterise one level once, at MAP_PX_PER_CELL, and keep it. */
  _render(w, level) {
    /* Seed change means a different maze, and every bake taken from the old
     * one is now a map of somewhere that no longer exists. */
    if (this._bakeSeed !== w.seed) { this._bakes.clear(); this._bakeSeed = w.seed; }
    const held = this._bakes.get(level);
    if (held) return held;

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

    this._bakes.set(level, cv);
    return cv;
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
    const view = this._view(w);
    const here = this._playerLevel(w);
    this._syncHeader(view, here);

    /* The same four terms the click hit-test and the pointer-anchored zoom
     * invert - see `_frame`. */
    const { rect, sheet, scale, ox, oy } = this._frame();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(2, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(2, Math.round(rect.height * dpr));

    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = MAP_BG;
    ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.imageSmoothingEnabled = this._zoom < 1.5;

    /* Asked for once for the whole frame rather than once per pane: the world
     * caches the route against the player's cell, but four calls would still
     * be four chances for the panes to be drawing different routes if that
     * cache is ever keyed on something else. */
    const route = this._showPath ? (w.solutionPath?.(this.player?.position) ?? null) : null;

    for (const pane of sheet.panes) {
      const baked = this._render(w, pane.level);
      const px = ox + pane.x * scale;
      const py = oy + pane.y * scale;
      const side = pane.side * scale;
      ctx.drawImage(baked, px, py, side, side);
      if (sheet.panes.length > 1) this._drawPaneChrome(ctx, pane, px, py, side, pane.level === here);
      /* Markers go on TOP of the baked image, never into it: the bake is
       * cached per seed and level, so a token that has been picked up or a
       * portal that has just opened would be frozen into it. */
      this._drawMarkers(ctx, w, pane.level, px, py, scale, route);
    }

    /* Last, and across panes: where the route leaves one floor for another. */
    if (route && sheet.panes.length > 1) this._drawLevelChanges(ctx, sheet, route, ox, oy, scale);
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

  /**
   * The header readout and the tab states.
   *
   * Split out of `_draw` when the view stopped being a single number: `ALL`
   * and a level are different sentences, and deciding which one inside the
   * drawing loop is how a header ends up saying "LEVEL NaN".
   */
  _syncHeader(view, here) {
    if (this.levelEl) {
      this.levelEl.textContent = view === OVERVIEW
        ? `ALL ${MAZE.LEVELS} LEVELS — YOU ARE ON ${here + 1}`
        : (view === here
          ? `LEVEL ${view + 1} OF ${MAZE.LEVELS}`
          : `LEVEL ${view + 1} OF ${MAZE.LEVELS} — YOU ARE ON ${here + 1}`);
    }
    if (!this.levelsEl) return;
    for (const b of this.levelsEl.children) {
      const tab = b.dataset.lvl === OVERVIEW ? OVERVIEW : Number(b.dataset.lvl);
      b.classList.toggle('is-on', tab === view);
      /* The player's own floor stays marked in the overview too - four
       * identical grids and no clue which one you are standing in is the
       * failure this view could most easily have. */
      b.classList.toggle('is-here', tab === here);
    }
  }

  /**
   * A floorplan's frame and caption, in the overview only.
   *
   * Four abutting grids of identical hedge texture read as one 800-cell maze,
   * and a player would try to walk from one into another. The frame says these
   * are four separate drawings; the caption says which is which without
   * having to count squares.
   */
  _drawPaneChrome(ctx, pane, px, py, side, isHere) {
    ctx.lineWidth = isHere ? 2 : 1;
    ctx.strokeStyle = isHere ? PANE_EDGE_HERE : PANE_EDGE;
    ctx.strokeRect(px + 0.5, py + 0.5, side - 1, side - 1);

    /* Fixed pixel size, not scaled with the map: a caption that shrank with
     * the zoom would be unreadable in exactly the fitted view it exists for. */
    ctx.font = '600 12px Rajdhani, Segoe UI, sans-serif';
    ctx.textBaseline = 'top';
    const label = `LEVEL ${pane.level + 1}${isHere ? ' — YOU' : ''}`;
    const w = ctx.measureText(label).width + 10;
    ctx.fillStyle = 'rgba(4, 10, 5, 0.78)';
    ctx.fillRect(px + 4, py + 4, w, 17);
    ctx.fillStyle = isHere ? '#ffffff' : PANE_LABEL;
    ctx.fillText(label, px + 9, py + 7);
  }

  /**
   * Where the route leaves one floor for another.
   *
   * The one thing no single floorplan can show, and the reason the overview
   * exists: a route that stops dead at a staircase tells you there is a way
   * up, but not where it comes out. A line between the two panes says both, at
   * the same point in both footprints.
   *
   * Dashed, and drawn last, so it is legible as a link between drawings rather
   * than mistaken for a corridor in either of them.
   */
  _drawLevelChanges(ctx, sheet, route, ox, oy, scale) {
    const links = verticalLinks(route);
    if (!links.length) return;

    ctx.save();
    ctx.strokeStyle = MARK.path;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([7, 5]);
    ctx.globalAlpha = 0.7;
    for (const link of links) {
      const from = this._paneFor(sheet, link.from);
      const to = this._paneFor(sheet, link.to);
      const a = this._project(link.x, link.z, ox + from.x * scale, oy + from.y * scale, scale);
      const b = this._project(link.x, link.z, ox + to.x * scale, oy + to.y * scale, scale);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      /* A ring at each end, so the exact cell the route changes floor at is
       * findable once the dashes are lost in the hedges. */
      ctx.save();
      ctx.setLineDash([]);
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.95;
      for (const p of [a, b]) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();
  }

  _drawMarkers(ctx, world, level, ox, oy, scale, route) {
    const m = world.mapMarkers?.(level);
    if (!m) return;

    /* Sized against the DRAWN CELL rather than the zoom number, because the
     * overview draws a level at half the scale the same zoom gives a single
     * floor - and a marker sized from the zoom alone came out four cells wide
     * there, turning a hundred staircases into a wall of dots. */
    const r = Math.max(2.2, Math.min(10, MAP_PX_PER_CELL * scale * 0.87));

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
    if (route) this._drawSolution(ctx, route, level, ox, oy, scale, r);
    this._drawPlayer(ctx, level, ox, oy, scale, r);
  }

  /**
   * The Ctrl+M solution route, from where the player is standing to the centre.
   *
   * Only the segments on the level this pane draws. Flattening the route onto
   * one floorplan would suggest a way through a floor, which is why it has
   * never been drawn that way - and why the overview draws four floorplans
   * side by side and links them, rather than one with everything on it.
   */
  _drawSolution(ctx, path, level, ox, oy, scale, r) {
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
    /* Only on the pane drawing the level being stood on. In the overview that
     * means one arrow among four floorplans, which is the point; paged to a
     * single floor it means standing on level 2 while reading level 0 plants
     * no marker in a corridor the player is nowhere near. */
    if (this._standingLevel() !== level) return;

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
   * Keep the drawn sheet covering the whole viewport.
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
  _clampPan(rect, sheet) {
    const fit = Math.min(rect.width / sheet.width, rect.height / sheet.height);
    const dw = sheet.width * fit * this._zoom, dh = sheet.height * fit * this._zoom;
    const limX = Math.max(0, (dw - rect.width) / 2);
    const limY = Math.max(0, (dh - rect.height) / 2);
    this._panX = Math.max(-limX, Math.min(limX, this._panX));
    this._panY = Math.max(-limY, Math.min(limY, this._panY));
  }

  /**
   * Clamp against whatever is on screen right now.
   *
   * The pan bound depends on the SHEET, and the sheet changes when the view
   * does - so the pointer and wheel handlers ask for it rather than holding a
   * reference to the last thing that was baked, which is what they did while
   * there was only ever one.
   */
  _clampNow() {
    const w = this._mazeWorld();
    if (!w) return;
    this._clampPan(this.canvas.getBoundingClientRect(), this._sheet(w));
  }

  _onKey(e) {
    /* Ctrl+M: the solution route, across every floor the map is showing.
     *
     * Checked BEFORE the modifier guard below, which exists so that browser
     * and OS chords are not swallowed - this one is deliberately a chord, and
     * only while the map is already open, so it cannot be found by mashing
     * keys in a corridor.
     *
     * It goes through `mapActionOwner` and `codeFor('map')` like the plain
     * press does, and for the same reason (commit 6e863e3): it is the same
     * key, so a second rule about who owns it would be a second way for the
     * map and the mount wheel to disagree. */
    const bound = this.input?.codeFor?.('map') ?? 'KeyM';
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.code === bound && this._open
        && mapActionOwner(this.worldManager?.active) === 'map') {
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
      /* Back out to all four. `0` because it sits next to the floor keys and
       * is the one digit that names no floor; the backquote for anyone who
       * reaches for a "step back out" key instead. */
      if (/^(?:Digit0|Numpad0|Backquote)$/.test(e.code)) {
        e.preventDefault(); this.showAllLevels(); return;
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
   * The wheel ZOOMS the map. Ctrl, Cmd or Shift with it scrolls.
   *
   * This was round the other way, and the reasoning was that the map opens
   * zoomed in on a grid four times wider than the panel, so scrolling is what
   * you do constantly and zooming is what you do once. That reasoning had a
   * hole in it: drag-to-pan arrived afterwards and is the better way to move a
   * map anyway, so the wheel was spending itself on the gesture the mouse
   * already had. The owner asked for zoom (2026-08-09), and with panning
   * covered by the drag nothing becomes unreachable — Ctrl and Cmd keep the
   * old scroll for anyone with no free hand for a drag, and Shift keeps
   * swapping to the horizontal axis as it does in every scroll pane.
   *
   * Zooming about the POINTER rather than the centre is not a refinement, it
   * is what makes a wheel usable as the primary zoom: centre-anchored zoom
   * walks whatever you were looking at off the edge of the panel, which was
   * tolerable on a chord you press once and is not on the plain wheel.
   */
  _onWheel(e) {
    if (!this._open) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      const step = e.deltaMode === 1 ? 24 : 1;    // 1 = lines, 0 = pixels
      const dx = e.deltaX * step, dy = e.deltaY * step;
      if (e.shiftKey) this._panX -= dy || dx;
      else { this._panX -= dx; this._panY -= dy; }
    } else {
      this._zoomAbout(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
    }
    this._clampNow();
    this._draw();
  }

  /**
   * Change the zoom while holding one canvas point still.
   *
   * Solved rather than nudged: the sheet-space point under the cursor is read
   * out through `_frame`'s projection, and the pan is then whatever value puts
   * that same point back under the same pixel at the new scale. An incremental
   * "pan by a fraction of the delta" approximation drifts, and it drifts most
   * on a trackpad, which is where a pinch arrives as a hundred small wheel
   * events in a row.
   *
   * `_clampPan` may of course pull the result back inside the grid afterwards,
   * so the anchor is not honoured at the very edges of the sheet. That is the
   * correct trade: there is nothing outside the maze to hold still.
   */
  _zoomAbout(clientX, clientY, factor) {
    const f = this._frame();
    if (!f || !(f.scale > 0)) return;
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this._zoom * factor));
    const after = (f.scale / this._zoom) * zoom;
    const cx = clientX - f.rect.left, cy = clientY - f.rect.top;
    const sx = (cx - f.ox) / f.scale;
    const sy = (cy - f.oy) / f.scale;
    this._zoom = zoom;
    this._panX = cx - sx * after - (f.rect.width - f.sheet.width * after) / 2;
    this._panY = cy - sy * after - (f.rect.height - f.sheet.height * after) / 2;
  }

  /**
   * Snap the view back to the player: their own floor, at junction scale.
   *
   * The zoom is part of it now. FIND ME pressed from the fitted overview used
   * to drop you onto one floorplan still fitted, which is 400 cells across a
   * panel - a shape, not somewhere you can see yourself standing. The whole
   * request is "show me where I am", so it arrives at the scale that answers.
   */
  recentre() {
    this._levelOverride = null;
    this._zoom = MAZE.CELLS / OPEN_CELLS_ACROSS;
    this._centreOnPlayer();
    this._draw();
  }

  /** Back out to all four floorplans, fitted, as the map opens. */
  showAllLevels() {
    if (this._levelOverride === OVERVIEW) return;
    this._levelOverride = OVERVIEW;
    /* Fitted, because a zoom carried in from a single floor would put the
     * overview somewhere in the middle of one pane with the other three off
     * screen - which is the view the player just asked to leave. */
    this._zoom = MIN_ZOOM;
    this._panX = 0;
    this._panY = 0;
    this._draw();
  }

  /**
   * Show a single level of the maze.
   *
   * Pan is deliberately KEPT when paging from one floor to the next. The four
   * levels stack in the same XZ footprint, so holding position is what makes
   * flicking between them useful - you are comparing the same patch of ground,
   * looking for where the corridor above continues.
   */
  setLevel(level) {
    const n = Math.max(0, Math.min(MAZE.LEVELS - 1, Math.round(level)));
    if (n === this._levelOverride) return;
    /* Coming out of the overview, the pan and the zoom are in sheet terms and
     * mean nothing on a single floorplan - so both reset. To the floor FITTED
     * WHOLE, which is a reversal worth recording: this used to drop to
     * junction scale centred on the player, on the argument that a fitted
     * 400-cell floor is a shape rather than a map. The owner's report showed
     * why that loses. Paging out of the overview is "enlarge THAT pane", and
     * a junction-scale window around the player's own position is a different
     * request answered uninvited - with the Ctrl+M route up it showed a
     * fragment of route (or, on a floor the player is not standing on, an
     * empty corridor somewhere else entirely), which read as the route
     * CHANGING between views. The route never changed; the window did.
     * Junction scale is still one FIND ME press away, and the wheel zooms.
     *
     * Paging BETWEEN floors still holds pan and zoom, which is what makes
     * comparing the same patch of ground across levels useful. */
    const fromOverview = this._levelOverride === OVERVIEW;
    this._levelOverride = n;
    if (fromOverview) {
      this._zoom = MIN_ZOOM;
      this._panX = 0;
      this._panY = 0;
    }
    this._draw();
  }

  /**
   * Where the press started, as well as where the pointer was last frame.
   *
   * `x`/`y` are consumed and rewritten by every move, because the pan is
   * incremental. The press origin has to be kept separately or there is
   * nothing left to measure a click against by the time the button comes up.
   */
  _onDown(e) {
    if (!this._open) return;
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.canvas.setPointerCapture?.(e.pointerId);

    /* A SECOND FINGER ENDS THE PAN AND BEGINS A PINCH.
     *
     * The wheel was the only way to zoom this map, and a phone has no wheel:
     * a touch player could pan a 400-cell grid around at whatever scale it
     * opened at and never change it. Two fingers is the gesture everyone
     * already knows, and the canvas is `touch-action: none` (maze-map.css) so
     * the browser hands us both rather than scrolling the page with them.
     *
     * `_drag` is cleared rather than left running: the first finger's motion
     * during a pinch is half of the pinch, and counting it as a pan as well
     * would move the sheet twice. */
    if (this._pointers.size === 2) {
      this._drag = null;
      this._pinch = this._span();
      return;
    }
    /* Three or more is not a gesture this panel has, and guessing which two of
     * them meant it is worse than doing nothing. */
    if (this._pointers.size > 2) {
      this._drag = null;
      this._pinch = null;
      return;
    }
    this._drag = { x: e.clientX, y: e.clientY, fromX: e.clientX, fromY: e.clientY, at: e.timeStamp };
  }

  /** The distance between the two live pointers, and the point between them. */
  _span() {
    const [a, b] = [...this._pointers.values()];
    if (!a || !b) return null;
    return {
      d: Math.hypot(b.x - a.x, b.y - a.y),
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
    };
  }

  _onMove(e) {
    if (!this._open) return;
    const held = this._pointers.get(e.pointerId);
    if (held) { held.x = e.clientX; held.y = e.clientY; }

    if (this._pinch && this._pointers.size === 2) {
      const now = this._span();
      if (!now) return;
      /* Zoom about where the fingers WERE, then translate to where they are.
       *
       * Anchoring on the new midpoint instead would be a frame late: the
       * content the player is pinching is the content under the OLD midpoint,
       * and holding the new one still walks the sheet out from under them.
       * `_zoomAbout` solves the pan rather than nudging it, so the two steps
       * compose exactly - see its own note on why that matters most on the
       * small, frequent deltas a pinch is made of. */
      if (this._pinch.d > 1 && now.d > 1) {
        this._zoomAbout(this._pinch.x, this._pinch.y, now.d / this._pinch.d);
      }
      this._panX += now.x - this._pinch.x;
      this._panY += now.y - this._pinch.y;
      this._pinch = now;
      this._clampNow();
      this._draw();
      return;
    }

    if (!this._drag) return;
    this._panX += e.clientX - this._drag.x;
    this._panY += e.clientY - this._drag.y;
    this._drag.x = e.clientX;
    this._drag.y = e.clientY;
    this._clampNow();
    this._draw();
  }

  /**
   * A press that did not become a pan is a click on a floorplan.
   *
   * Only in the overview. On a single floor the click would mean "enlarge the
   * thing already filling the panel", so it does nothing at all — and, more to
   * the point, that view is the one you drag around most, and a stray page on
   * every twitchless drag would be maddening.
   *
   * `e.timeStamp` rather than `performance.now()` so the two ends of the
   * gesture are measured on the same clock the events were stamped with; a
   * queued-up pointerup would otherwise be timed against when we got round to
   * it rather than when it happened.
   */
  _onUp(e) {
    this._pointers.delete(e.pointerId);

    /* Coming out of a pinch.
     *
     * Lifting one of two fingers leaves the other one down, and it is
     * somewhere quite different from where it started - so the pan resumes
     * from where that finger IS, and the press is marked `pinched` so the
     * click test below cannot page the map to a floor the player never asked
     * for on the way out of a zoom. */
    if (this._pinch) {
      if (this._pointers.size >= 2) return;
      this._pinch = null;
      const rest = [...this._pointers.values()][0];
      this._drag = rest
        ? { x: rest.x, y: rest.y, fromX: rest.x, fromY: rest.y, at: e.timeStamp, pinched: true }
        : null;
      return;
    }

    const press = this._drag;
    this._drag = null;
    if (!press || !this._open || press.pinched) return;
    const moved = Math.hypot(e.clientX - press.fromX, e.clientY - press.fromY);
    if (moved > CLICK_SLOP_PX || e.timeStamp - press.at > CLICK_HOLD_MS) return;
    const w = this._mazeWorld();
    if (!w || this._view(w) !== OVERVIEW) return;
    /* Null in the gutter, and null outside the sheet - see `paneAt`. Both mean
     * the player did not name a floor, and guessing one for them is worse than
     * letting them click again. */
    const pane = this._paneAtClient(e.clientX, e.clientY);
    if (pane) this.setLevel(pane.level);
  }

  dispose() {
    window.removeEventListener('keydown', this._onKey, true);
    window.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp);
    window.removeEventListener('pointercancel', this._onUp);
    this._pointers.clear();
    this._pinch = null;
    /* Torn down with the map still open. Deliberately not `close()` - there is
     * nothing left to hand a pointer lock back to - but the class must go, or a
     * body class outliving its panel hides the STANDBY overlay for good. */
    document.body.classList.remove('mz-map-open');
    this.el.remove();
    this._bakes.clear();
    this._bakeSeed = null;
  }
}
