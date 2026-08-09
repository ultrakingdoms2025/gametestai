/**
 * Where the four floorplans sit when the map shows all of them at once.
 *
 * ## Why this is a file and not four numbers in `MazeMap`
 *
 * A canvas cannot be imported under Node, so anything the map decides inside
 * `_draw` is decided where no test can see it — the same division that put
 * `levelSegments` in `MazePlan.js` rather than in the drawing code. What is
 * worth asserting here is small and load-bearing: that every level gets a
 * pane, that no two panes overlap, and that a route's level changes are
 * enumerated the same way the drawing enumerates them.
 *
 * ## Why a grid and not a stack
 *
 * The four levels occupy the SAME 400×400 XZ footprint, so the tempting
 * arrangement is to superimpose them and tint by depth. The spec has refused
 * that from the start, for one reason that has not changed: a flattened route
 * suggests a way through a floor. Side by side, a corridor on level 2 can
 * never be mistaken for a corridor on level 1, and the places where the route
 * does change floor are drawn as explicit links between panes rather than
 * being implied by an overlap.
 *
 * ## Why 2×2 rather than a strip
 *
 * The panel is square — `min(92vw, 92vh)` in `maze-map.css`. A 1×4 strip fits
 * each level into a quarter of the panel's edge; a 2×2 fits each into a half.
 * That is twice the linear scale, on four floorplans whose cells are already
 * sub-pixel when the whole grid is fitted, for exactly the same screen.
 */
import { MAZE } from '../worlds/maze/MazeTopology.js';

/**
 * The "show me every floor" view, used where a level number would otherwise go.
 *
 * A string rather than -1 or null: `null` already means "the level the player
 * is standing on" in `MazeMap._levelOverride`, and a numeric sentinel would
 * survive `Math.round` and every clamp it passed through, which is how a
 * sentinel ends up drawn as a floor.
 */
export const OVERVIEW = 'all';

/**
 * The gutter between floorplans, in the same units as a pane's edge.
 *
 * Not decoration. Four grids of identical hedge texture butted together read
 * as one 800-cell maze, and the first thing a player would do is try to walk
 * from one into another.
 */
export const PANE_GAP = 40;

/**
 * One floorplan's place in the sheet.
 * @typedef {{level:number, x:number, y:number, side:number}} MapPane
 */

/**
 * Every level at once, in reading order.
 *
 * Reading order — 1 2 above 3 4 — rather than a building elevation with the
 * ground floor at the bottom, because the header tabs and the `1`–`4` keys
 * already name the levels in that order and a 2×2 grid cannot read as an
 * elevation anyway. Two conventions for "which square is level 3" would be one
 * too many.
 *
 * The column count is derived rather than written down, so a fifth level would
 * arrange itself instead of being drawn off the sheet.
 *
 * @param {number} side one floorplan's edge, in whatever units the caller bakes at
 * @param {number} [gap]
 * @returns {{width:number, height:number, panes:MapPane[]}}
 */
export function overviewSheet(side, gap = PANE_GAP) {
  const cols = Math.ceil(Math.sqrt(MAZE.LEVELS));
  const rows = Math.ceil(MAZE.LEVELS / cols);
  const panes = [];
  for (let level = 0; level < MAZE.LEVELS; level++) {
    panes.push({
      level,
      x: (level % cols) * (side + gap),
      y: Math.floor(level / cols) * (side + gap),
      side,
    });
  }
  return {
    width: cols * side + (cols - 1) * gap,
    height: rows * side + (rows - 1) * gap,
    panes,
  };
}

/**
 * One level, filling the sheet.
 *
 * The single-floor view is not a special case of the grid with three panes
 * hidden: it has to land at the origin so that the pan, the clamp and the
 * junction-scale opening zoom all mean what they meant before the overview
 * existed.
 *
 * @returns {{width:number, height:number, panes:MapPane[]}}
 */
export function singleSheet(level, side) {
  return { width: side, height: side, panes: [{ level, x: 0, y: 0, side }] };
}

/** The sheet for whichever view is showing. */
export function sheetFor(view, side, gap = PANE_GAP) {
  return view === OVERVIEW ? overviewSheet(side, gap) : singleSheet(view, side);
}

/**
 * Where a route leaves one floor for another.
 *
 * The route arrives as one flat list with the level changes inside it, which
 * is right for a single-floor view — it simply stops at the staircase. Drawn
 * across four floorplans, those changes are the most useful thing on the map
 * and the only part that no single pane can show, so they are pulled out here
 * and drawn as links between panes.
 *
 * Takes the position from the step BEFORE the change: a vertical link has the
 * same x and z on both sides, and using the earlier step means a route that
 * ends on a change still reports where it left.
 *
 * @param {Array<{x:number,z:number,level:number}>} path
 * @returns {Array<{x:number,z:number,from:number,to:number}>}
 */
export function verticalLinks(path) {
  const out = [];
  if (!path) return out;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    if (a.level === b.level) continue;
    out.push({ x: a.x, z: a.z, from: a.level, to: b.level });
  }
  return out;
}
