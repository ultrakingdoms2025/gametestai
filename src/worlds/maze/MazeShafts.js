/**
 * Vertical connectors and the machinery that proves them safe.
 *
 * Split out of `MazeColliders.js` in Phase 2c, when two more connector shapes
 * arrived and the one file stopped being readable at 793 lines. The division
 * is by responsibility, not by size: everything here is about getting a
 * player between two levels and proving they cannot use that geometry to
 * leave the maze, while `MazeColliders.js` keeps the hedges, floors and
 * forecourt that have nothing to do with either.
 *
 * Pure - no THREE, no DOM, and it imports only `MazeTopology.js`. That is
 * asserted textually by `scripts/tests/maze-enclosure.test.mjs`, because
 * export-name checks alone would not stop a `three` import being added, and
 * this module's purity is what lets the enclosure, containment and
 * anti-ladder gates run headless in seconds.
 *
 * @typedef {import('./MazeColliders.js').ColliderDesc} ColliderDesc
 */

import {
  MAZE, DIR, cellIndex, isOpen, cellToWorld, connectorAt, hash32,
} from './MazeTopology.js';

/**
 * Steps per shaft. `LEVEL_HEIGHT / this` must not exceed the 0.45 m auto-step,
 * or the player cannot walk up it - 9.0 / 24 = 0.375 m, comfortably under.
 *
 * The last of the 24 rises is the LANDING, not a tread: it is the slab a
 * climber steps out onto, flush with level N+1's floor. So the spiral itself
 * has `SHAFT_STEPS - 1` = 23 treads.
 */
export const SHAFT_STEPS = 24;

/* ------------------------------------------------------------------ */
/* The stair well                                                      */
/*                                                                     */
/* Everything about a shaft's geometry is derived from ONE box - the   */
/* well - so the stair, the hole punched through level N+1's floor and */
/* the guard walls around that hole cannot drift apart. Fix round 4:   */
/* rounds 1-3 each derived their own footprint independently, which is */
/* how the hole ended up the size of the whole cell while the stair    */
/* needed only part of it, leaving an open 9 m pit over every shaft.   */
/* ------------------------------------------------------------------ */

/**
 * Spiral radius, and how far a tread reaches from its own centre.
 *
 * These two are not free. Three constraints fix them, and they pull against
 * each other - the previous spiral (r 1.90 m, tread half 0.9 m, 1.5 turns)
 * satisfied the first two and failed the third badly:
 *
 * 1. HEADROOM. The player's own capsule is 1.75 m, so standing on tread `i`
 *    they must clear treads `i+2 .. i+4` (`i+1` is the next step, and a
 *    0.375 m rise is what the auto-step is for). At `STAIR_TREADS_PER_TURN`
 *    = 8 the nearest of those sits a quarter-turn away, and the nearest
 *    point of its axis-aligned box to the standing spot is
 *    `(STAIR_RADIUS - TREAD_HALF) * sqrt(2)` = 0.57 m, clear of the 0.35 m
 *    capsule radius by 0.22 m.
 * 2. REACHABILITY. Consecutive tread footprints must overlap, or the climb
 *    has a hole in it. The largest single-axis offset between consecutive
 *    treads is `2 * STAIR_RADIUS * sin(pi/8)` = 0.69 m against a 1.0 m tread,
 *    so they overlap by 0.31 m on the tightest axis and fully on the other.
 * 3. FOOTPRINT. Everything - stair, landing, the capsule climbing it - must
 *    fit inside a box small enough that the hole it needs through level
 *    N+1's floor is a stairwell opening rather than a missing floor, AND
 *    that leaves level N+1's corridor cross walkable around it. That is what
 *    `STAIR_WELL_HALF` and `STAIR_WELL_OFFSET` below encode.
 */
export const STAIR_RADIUS = 0.9;
export const TREAD_HALF = 0.5;

/** Treads per full turn of the spiral. 8 = 45 degrees per step. */
export const STAIR_TREADS_PER_TURN = 8;

/**
 * Half-width of the stair well - the square column the whole staircase lives
 * inside, and exactly the hole punched through level N+1's floor.
 *
 * A tread's own footprint reaches `STAIR_RADIUS + TREAD_HALF` from the
 * spiral's axis, and that is the whole of it: nothing a shaft emits reaches
 * further. A climbing capsule reaches `STAIR_RADIUS + RADIUS` (1.25 m), which
 * is 0.15 m inside this, so no part of a climbing player ever meets level
 * N+1's floor slab either.
 */
export const STAIR_WELL_HALF = STAIR_RADIUS + TREAD_HALF;

/**
 * How far the well's centre is offset from the shaft cell's centre, on both
 * axes.
 *
 * The well is pushed into one quadrant of the cell (+x/+z) so that its outer
 * faces stop just short of the corridor's own edge (`CORRIDOR / 2`, where the
 * hedges begin) and its inner faces stop just short of the cell's centre
 * lines. That is what keeps a shaft from severing the corridor it sits in, on
 * BOTH levels: an L-shaped strip 1.9 m wide runs along the north and west of
 * the cell, clear of the well on every side, so north-south, east-west and
 * every turn between them still have a route through the cell that never
 * crosses the well. A well centred on the cell would block all four.
 *
 * `WELL_EDGE_MARGIN` keeps the treads from touching the shaft's own side
 * walls (which stand `CORRIDOR / 2` from the cell centre, being
 * `HEDGE_THICK / 2` thick about the cell boundary); a tread embedded in a
 * wall is a tread the player cannot stand on.
 */
const WELL_EDGE_MARGIN = 0.1;
export const STAIR_WELL_OFFSET = MAZE.CORRIDOR / 2 - STAIR_WELL_HALF - WELL_EDGE_MARGIN;

/**
 * Thickness and height of the guard walls standing round the hole in level
 * N+1's floor. Full hedge height, so they read as part of the maze and cannot
 * be hopped onto (their tops are at exactly `HEDGE_HEIGHT`, which is the top
 * of the anti-ladder gate's band, not inside it).
 */
export const GUARD_HALF_THICK = 0.1;

/**
 * The stair well's world-space bounds for a shaft in cell (x, z) at `level`.
 *
 * Single source of truth, deliberately: `shaftColliders` places the stair and
 * its landing inside this box, and `districtColliders` punches exactly this
 * box out of level N+1's floor and rails the result. Two independent
 * derivations of "where the stair is" is precisely the bug class this task's
 * history is made of.
 */
export function stairWellBounds(x, z, level) {
  const w = cellToWorld(x, z, level);
  const cx = w.x + STAIR_WELL_OFFSET;
  const cz = w.z + STAIR_WELL_OFFSET;
  return {
    cx,
    cz,
    x0: cx - STAIR_WELL_HALF,
    x1: cx + STAIR_WELL_HALF,
    z0: cz - STAIR_WELL_HALF,
    z1: cz + STAIR_WELL_HALF,
  };
}

/**
 * How far above a shaft's floor its OPEN (entry) side's wall must begin.
 *
 * Fix round 1: the first version of this rule sealed the entry side from
 * the shaft floor upward (offset by the auto-step height, 0.45 m), which is
 * stricter than the physics needs and made the maze unplayable - it left a
 * 0.45 m doorway against a 1.75 m player, so every one of the first 617
 * generated shafts was sound AND unenterable. See
 * `docs/superpowers/specs/2026-08-07-maze-world-design.md`, "Sealing starts
 * partway up, not at the floor".
 *
 * Leaving a shaft low down is harmless - there is nothing outside to stand
 * on, so a player who walks out at low height simply drops back into the
 * corridor. It becomes an exploit only once they are high enough that a hop
 * plus a step-up lands them on a `HEDGE_HEIGHT`-tall hedge top, i.e. at
 * `HEDGE_HEIGHT - HOP - STEP_HEIGHT` = 5.0 - 0.93 - 0.45 = 3.62 m.
 * `ENTRY_SEAL_MARGIN` shaves a little more off that so sealing starts
 * strictly below the break-even point, not exactly on it - the same
 * "margin below a derived bar, not a bare derived bar" shape as
 * `ENCLOSURE_MARGIN` below.
 *
 * This single constant is used both to place the physical doorway
 * (`shaftColliders`) and as the lower bound `isEnclosureSound` checks
 * coverage from. The two must never drift apart - a physical wall starting
 * even slightly higher than the height the gate accepts is exactly the
 * shape of bug this fix round exists to close (there, the gap ran the other
 * way: the wall started too LOW for the player, but the lesson is the same -
 * geometry and gate must share one number, not two that happen to agree
 * today).
 */
const ENTRY_SEAL_MARGIN = 0.05;
export const ENTRY_SEAL_FROM = MAZE.HEDGE_HEIGHT - MAZE.HOP - MAZE.STEP_HEIGHT - ENTRY_SEAL_MARGIN;

/**
 * A staircase from `level` to `level + 1`, inside the cell that carries the
 * UP link.
 *
 * Reached through `shaftColliders`, which is what decides a link is a stair
 * rather than a lift or a tunnel. Kept callable directly so tests can build
 * a stair without going through the dispatcher.
 *
 * The steps spiral inside the STAIR WELL - a 2.8 m box tucked into one
 * quadrant of the cell (see `STAIR_WELL_HALF` / `STAIR_WELL_OFFSET`) - three
 * turns of eight, so a 6 m cell can climb 9 m without any single rise
 * exceeding the auto-step. The 24th and last rise is not a tread but a
 * LANDING: a slab filling the well's inner quarter, its top flush with level
 * N+1's floor and its inner edges flush with the edge of the hole in that
 * floor, so a climber walks off it onto level N+1 with no step at all.
 *
 * Fix round 4 moved the spiral off the cell's edge (r 1.90 m, 1.5 turns,
 * 0.9 m treads) and into the well. That earlier spiral was the root of the
 * pit: the last eight treads - the ones whose climbing capsule has to pass
 * through level N+1's 1 m floor slab - swept 157 degrees of a 1.9 m circle,
 * so the hole they needed was very nearly the whole cell, and a hole that
 * size is a missing floor rather than a stairwell. Tightening the spiral
 * until the WHOLE staircase fits in one 2.8 m box is what lets the hole be
 * 2.8 m too. See `STAIR_RADIUS` for the three constraints that fix the
 * spiral's dimensions and why they cannot be traded against each other.
 *
 * Tread half-extents stay well under the ceiling `overlappingShaftCells`
 * needs: a tread reaches at most `STAIR_WELL_OFFSET + STAIR_WELL_HALF` =
 * 2.3 m from the cell centre, inside the 3.0 m half-cell by 0.7 m.
 * `overlappingShaftCells`/`isEnclosureSound` group a descriptor into every
 * cell its footprint touches, boundary-inclusive, and a tread flush to the
 * cell pitch would wrongly pull in four cells it only meets at a corner.
 *
 * The shaft's own walls are emitted on the cell's CLOSED sides, and on the
 * OPEN side (the horizontal passage you actually walk in through) only from
 * `ENTRY_SEAL_FROM` above the floor, leaving a doorway roughly 3.5 m tall
 * below that - comfortably clear of the 1.75 m player. Fix round 1 sealed
 * the open side from the floor instead (offset by the auto-step height
 * alone), which left only a 0.45 m doorway and made every shaft unenterable;
 * see `ENTRY_SEAL_FROM`'s own comment for the derivation and the spec
 * amendment that replaced it. `isEnclosureSound` applies that same lower
 * bound itself, so a caller proving a real shaft sound passes the shaft's
 * true floor - it no longer has to know about or duplicate this offset.
 *
 * On the NORTH and WEST closed sides specifically (fix round 2, Finding 4),
 * the wall starts at `HEDGE_HEIGHT` rather than the floor, stacking
 * CONTIGUOUSLY on top of the ordinary 5 m hedge `districtColliders` already
 * draws there (that hedge is owned by - always emitted by - this same
 * cell, so it is always present alongside this wall; `isEnclosureSound`
 * already treats vertically contiguous pieces as one span, so this loses no
 * coverage) instead of duplicating it floor-to-top. EAST and SOUTH keep
 * full floor-to-top walls: those sides' 5 m hedge, when it exists, is owned
 * and emitted by the NEIGHBOURING cell, which can be a different district
 * on a seam - `districtColliders`'s own doc comment explains why S/E
 * ownership works that way. Relying on that neighbour's output here would
 * reintroduce exactly the district-seam dependency Task 3's Trap 2 was
 * written to avoid, for a purely cosmetic collider-count saving, so it is
 * not worth it: E/S stay fully self-sufficient.
 *
 * The walls stop at `LEVEL_HEIGHT`, not `LEVEL_HEIGHT + HEDGE_HEIGHT` (fix
 * round 3, Finding 1 - the mirror image of round 2's ceiling bug). Above a
 * shaft's own `LEVEL_HEIGHT` the cell simply BECOMES a level N+1 cell, and
 * level N+1's own topology governs it from there - its hedges, its
 * passages, its doorways. A wall standing on all four sides up to
 * `+ HEDGE_HEIGHT` (14 m absolute) had no way to know that level N+1 might
 * mark one of those sides OPEN, so it walled off a corridor level N+1's own
 * carving had deliberately opened - severing up to 397 of 399 cells in a
 * district in the reviewer's flood-fill, and trapping a player who had just
 * climbed 9 m inside a sealed 6x6 m box with no way out sideways at all.
 * `requiredWallTop` is capped to match - see its own comment for why a
 * player's hop reach above `LEVEL_HEIGHT` is not this shaft's problem.
 */
export function stairColliders(cells, x, z, level) {
  const idx = cellIndex(x, z, level);
  if (!isOpen(cells, idx, DIR.UP)) return [];

  const w = cellToWorld(x, z, level);
  const out = [];
  const rise = MAZE.LEVEL_HEIGHT / SHAFT_STEPS;
  const well = stairWellBounds(x, z, level);

  /* Treads 0 .. SHAFT_STEPS-2. The phase is chosen so the LAST tread sits at
   * 180 degrees and the landing it steps onto occupies the well's inner
   * quarter - the corner nearest the cell centre, which is the corner whose
   * two faces are the mouth of the stairwell at level N+1. */
  for (let i = 0; i < SHAFT_STEPS - 1; i++) {
    const a = Math.PI * 1.5 + (i / STAIR_TREADS_PER_TURN) * Math.PI * 2;
    const bottom = w.y + i * rise;
    const top = w.y + (i + 1) * rise;
    out.push({
      cx: well.cx + Math.cos(a) * STAIR_RADIUS,
      cy: (bottom + top) / 2,
      cz: well.cz + Math.sin(a) * STAIR_RADIUS,
      hx: TREAD_HALF, hy: (top - bottom) / 2, hz: TREAD_HALF,
      kind: 'stair',
      enclosed: true,
    });
  }

  /* The landing. Fills the well's inner quarter, top flush with level N+1's
   * floor (`w.y + LEVEL_HEIGHT`), inner edges flush with the hole punched in
   * it - so stepping off the stair onto the next level is a walk across a
   * seam, not a step up or a hop. Its underside is one rise below, so the
   * last tread reaches it with the same 0.375 m the other 23 use. */
  const landBottom = w.y + (SHAFT_STEPS - 1) * rise;
  const landTop = w.y + MAZE.LEVEL_HEIGHT;
  out.push({
    cx: (well.x0 + well.cx) / 2,
    cy: (landBottom + landTop) / 2,
    cz: (well.z0 + well.cz) / 2,
    hx: (well.cx - well.x0) / 2,
    hy: (landTop - landBottom) / 2,
    hz: (well.cz - well.z0) / 2,
    kind: 'stair',
    enclosed: true,
  });

  /* Walls. Shared with the lift via `shaftWalls` - see that function, and
   * this one's own comment above for the per-side reasoning and for why the
   * walls stop at LEVEL_HEIGHT rather than LEVEL_HEIGHT + HEDGE_HEIGHT. */
  for (const d of shaftWalls(cells, x, z, level)) out.push(d);

  return out;
}

/**
 * Every collider for the vertical connector rising out of (x, z, level).
 *
 * The single entry point `districtColliders` calls. Which shape gets built is
 * the TOPOLOGY ARRAY's decision, not this module's - see `connectorAt` - so
 * no seed is threaded through geometry, and the `M` map, NPC routing and the
 * headless gates all resolve a link's kind exactly the way this does.
 *
 * A cell with no UP link emits nothing, which is what makes this safe to call
 * for any cell.
 *
 * @param {Uint8Array} cells
 * @returns {ColliderDesc[]}
 */
export function shaftColliders(cells, x, z, level) {
  if (!isOpen(cells, cellIndex(x, z, level), DIR.UP)) return [];
  switch (connectorAt(cells, x, z, level)) {
    /* The two identical fallbacks are deliberate and temporary. They are
     * written as separate cases rather than folded into the default so that
     * Tasks 5 and 9 each change exactly one line, and so a reader can see at
     * a glance which connectors are real yet. */
    case 'lift':   return liftColliders(cells, x, z, level);
    case 'tunnel': return tunnelColliders(cells, x, z, level);
    default:       return stairColliders(cells, x, z, level);
  }
}

/**
 * The highest point a descriptor's top ever reaches.
 *
 * For almost everything this is just `cy + hy`. For a SWEPT descriptor - one
 * that moves, which today means a lift car - `cy`/`hy` describe where it
 * physically rests, and that is true at one instant and false at every other.
 * A gate reading the rest position would judge a lift car parked at 0.30 m to
 * be harmless while it spends most of its life sweeping the whole 0.45-5.0 m
 * band, which is the exact band the maze's entire safety argument is about.
 *
 * Every gate that asks "how high does this go" must ask it here, and there
 * are two: `requiredWallTop` below, and the anti-ladder band scan in
 * `scripts/tests/maze-colliders.test.mjs`. One definition, imported by both,
 * for the same reason `ENTRY_SEAL_FROM` is one constant shared by the
 * geometry and its gate - two derivations that happen to agree today are a
 * bug waiting for someone to edit one of them.
 *
 * The `Math.max` is not belt-and-braces: it keeps the answer conservative for
 * a malformed descriptor whose rest position sits above its declared travel,
 * which is an input the gate should survive rather than trust.
 *
 * @param {ColliderDesc} d
 * @returns {number} world-space Y of the highest reachable top
 */
export function descriptorTop(d) {
  const resting = d.cy + d.hy;
  return d.swept ? Math.max(d.swept.y1, resting) : resting;
}

/**
 * Extra clearance added above `highest standable + HOP` when deriving a
 * shaft's required wall height.
 *
 * This is not floating-point slop - it is `Player.js`'s own step-up assist.
 * Landing near a hop's apex, the step-up gated on `_grounded || _coyote`
 * (`Player.js:800`) can mount an additional `stepHeight` on top of the hop
 * itself, so the real maximum reach above a standable surface is
 * `HOP + STEP_HEIGHT`, not `HOP` alone - a wall that only clears the bare hop
 * is unsafe regardless of how comfortably it clears it. `MAZE.STEP_HEIGHT`
 * mirrors `Config.js`'s `player.stepHeight` for the same reason `MAZE.HOP`
 * mirrors `jumpVelocity`/`gravity`: this module may only import
 * `MazeTopology.js`. The `+ 0.05` on top of that is the only part that is
 * genuine floating-point slop.
 *
 * UNSTATED PREMISE, now stated: this margin is `HOP + STEP_HEIGHT` because
 * `rules.climb === false` in the maze. `Climb.js` mantles up to `MAX_RISE`
 * 2.4 m - 1.7x this margin - and is only unreachable here because
 * `MazeWorld` sets `rules.climb = false` (enforced in `Player.js`, a
 * different module this one cannot see or import). If the maze ever regains
 * climbing, every derived wall height in this file goes silently unsafe
 * without a single test here failing to say so. Whoever touches that flag
 * must widen this margin to account for `Climb.js`'s reach, not just retest.
 */
const ENCLOSURE_MARGIN = MAZE.STEP_HEIGHT + 0.05;

/**
 * How high a shaft's walls must reach to contain what is inside it.
 *
 * The first draft of this rule used a constant - hedge height - and that was
 * wrong in a way that destroyed the guarantee it existed to protect:
 * `LEVEL_HEIGHT` is 9.0 m, so a staircase climbing a real level inside 5.0 m
 * walls satisfied a fixed bar while leaving the top of the stairs 4 m above
 * the walls meant to contain them. A shaft's walls must clear its own
 * contents, so the bar is derived from the highest `enclosed` standable
 * surface actually inside the shaft's footprint - the highest point a player
 * can reach by walking to the top of it - plus one hop plus a margin. A shaft
 * with nothing enclosed in it (there is nothing to climb) falls back to hedge
 * height, matching the original band rule.
 *
 * Fix round 3, Finding 1: that raw bar is capped at `shaft.floorY +
 * LEVEL_HEIGHT` and must not be allowed to exceed it. A player standing on
 * the topmost tread (at `LEVEL_HEIGHT`) and hopping reaches roughly
 * `LEVEL_HEIGHT + HOP + ENCLOSURE_MARGIN` ~= 10.38 m uncapped - but
 * everything at or above `LEVEL_HEIGHT` is no longer this shaft's hazard to
 * contain. That height is level N+1's own floor; from there upward, level
 * N+1's own hedges are what matter, and THEIR tops sit at
 * `floorY + LEVEL_HEIGHT + HEDGE_HEIGHT` (14 m), comfortably above the
 * 10.38 m a hop from the top tread reaches - there is nothing to land on.
 * Capping here, rather than excluding the topmost tread(s) from the `highest`
 * scan above, is what actually brings the bar down to something the walls
 * (themselves capped at `LEVEL_HEIGHT` - see `shaftColliders`) can satisfy:
 * excluding only the exact-`LEVEL_HEIGHT` tread would still leave the 23rd
 * tread's own hop reach (~10.1 m) above the cap. The cap does not weaken the
 * bar that stopped the original 9 m-stairs-in-5 m-walls bug: that fixture's
 * walls are only 5 m tall, still far short of the capped 9 m requirement, so
 * it still fails.
 *
 * @param {ColliderDesc[]} descs
 * @param {{cx:number, cz:number, floorY:number}} shaft
 * @returns {number} absolute world Y the walls must reach
 */
export function requiredWallTop(descs, shaft) {
  /* `hx`/`hz` widen the footprint from ONE CELL to a connector's whole region.
   * A tunnel folds across two cells (Task 7), so "the shaft" stopped being a
   * synonym for "the cell". They default to a half-cell, so every existing
   * caller is unchanged. */
  const halfX = shaft.hx ?? MAZE.CELL / 2;
  const halfZ = shaft.hz ?? MAZE.CELL / 2;
  const EPS = 1e-6;
  const cap = shaft.floorY + MAZE.LEVEL_HEIGHT;
  let highest = -Infinity;
  for (const d of descs) {
    if (!d.enclosed) continue;
    // Only surfaces that actually sit inside this shaft's footprint count -
    // an enclosed descriptor belonging to a neighbouring shaft must not raise
    // this one's bar.
    if (d.cx - d.hx > shaft.cx + halfX - EPS || d.cx + d.hx < shaft.cx - halfX + EPS) continue;
    if (d.cz - d.hz > shaft.cz + halfZ - EPS || d.cz + d.hz < shaft.cz - halfZ + EPS) continue;
    /* Not `d.cy + d.hy`. A swept descriptor rests low and travels high, and
     * the bar must come from where it GOES - see `descriptorTop`. */
    const top = descriptorTop(d);
    if (top > highest) highest = top;
  }
  const bar = highest === -Infinity ? shaft.floorY + MAZE.HEDGE_HEIGHT : highest + MAZE.HOP + ENCLOSURE_MARGIN;
  return Math.min(bar, cap);
}

/**
 * Is a shaft genuinely sealed?
 *
 * Phase 1's rule was absolute: nothing standable between 0.45 m and 5.0 m,
 * because anything there is a step onto a 5 m hedge. A staircase is made
 * entirely of such steps, so four levels cannot exist under that rule.
 *
 * The rule is therefore narrowed rather than dropped: a step may sit in the
 * band only inside a sealed shaft. This function is what makes that exemption
 * honest - it checks that the shaft's cell is walled on all four sides, from
 * `ENTRY_SEAL_FROM` above its floor up to `requiredWallTop` (a function of
 * what is actually inside the shaft, never a constant - see that function's
 * comment), so a player using the steps arrives on the next level rather
 * than on top of the maze.
 *
 * Coverage is required from `ENTRY_SEAL_FROM` upward, not from the true
 * floor. Fix round 1 required coverage from the floor, which is stricter
 * than the physics needs - a player who walks out of a shaft below that
 * height has nothing to stand on and just drops into the corridor, so it is
 * not an exploit - and it made every real shaft unenterable while still
 * reporting SOUND, because a sealed box genuinely is sound; it just cannot
 * be walked into. See `ENTRY_SEAL_FROM`'s own comment for the derivation.
 *
 * Coverage on a side may be assembled from several colliders, as long as they
 * are vertically contiguous - two wall pieces stacked with no gap between
 * them wall a side exactly as well as one collider spanning the same range.
 * A gap between two pieces does not.
 *
 * @param {ColliderDesc[]} descs every collider near the shaft
 * @param {{cx:number, cz:number, floorY:number}} shaft cell centre and floor
 * @returns {boolean}
 */
export function isEnclosureSound(descs, shaft) {
  /* The region's OUTER boundary, not each cell's four sides - see
   * `connectorRegion`. Defaults to one cell, so existing callers are
   * unchanged. */
  const halfX = shaft.hx ?? MAZE.CELL / 2;
  const halfZ = shaft.hz ?? MAZE.CELL / 2;
  const need = requiredWallTop(descs, shaft);
  const sides = [
    { axis: 'x', at: shaft.cx - halfX },
    { axis: 'x', at: shaft.cx + halfX },
    { axis: 'z', at: shaft.cz - halfZ },
    { axis: 'z', at: shaft.cz + halfZ },
  ];
  for (const side of sides) if (!sideCovered(descs, shaft, side, need)) return false;
  return true;
}

/**
 * Is one side of a shaft covered, from `ENTRY_SEAL_FROM` above its floor up to
 * `need`?
 *
 * Extracted from `isEnclosureSound` in Phase 2c, unchanged in behaviour, so
 * that a REGION can be checked face by face (see `isRegionEnclosureSound`)
 * without either function owning a second copy of these rules: a piece must
 * reach the side's plane AND span the shaft's full width along it, and
 * coverage may be assembled from several pieces as long as they are vertically
 * contiguous. A gap between two pieces does not cover.
 */
function sideCovered(descs, shaft, side, need) {
  const halfX = shaft.hx ?? MAZE.CELL / 2;
  const halfZ = shaft.hz ?? MAZE.CELL / 2;
  const lowerBound = shaft.floorY + ENTRY_SEAL_FROM;
  const EPS = 1e-6;

  {
    // Every wall piece that reaches this side's plane and spans the shaft's
    // full width along it, regardless of its own vertical extent - coverage
    // is decided by merging these intervals, not by any single piece alone.
    const intervals = [];
    for (const d of descs) {
      if (d.enclosed) continue;                      // steps do not wall a shaft

      // A wall covers this side only if its slab actually reaches the side's
      // plane *and* spans the shaft's full width along that plane - not merely
      // if its centre happens to sit within some distance of it. A north/south
      // wall's half-extent along x can equal a whole cell (it runs the cell's
      // full width), which makes a naive distance-to-centre test mistake it
      // for an east/west wall reaching that far; checking the wall's own
      // thin axis (here, z) against the shaft's full span is what tells the
      // two apart.
      if (side.axis === 'x') {
        if (d.cx - d.hx > side.at + EPS || d.cx + d.hx < side.at - EPS) continue;
        if (d.cz - d.hz > shaft.cz - halfZ + EPS || d.cz + d.hz < shaft.cz + halfZ - EPS) continue;
      } else {
        if (d.cz - d.hz > side.at + EPS || d.cz + d.hz < side.at - EPS) continue;
        if (d.cx - d.hx > shaft.cx - halfX + EPS || d.cx + d.hx < shaft.cx + halfX - EPS) continue;
      }
      intervals.push([d.cy - d.hy, d.cy + d.hy]);
    }

    intervals.sort((a, b) => a[0] - b[0]);
    let covered = false;
    let runBottom = null;
    let runTop = null;
    for (const [bottom, top] of intervals) {
      if (runBottom === null) {
        runBottom = bottom;
        runTop = top;
      } else if (bottom <= runTop + EPS) {
        // Overlaps or touches the run so far - extend it.
        if (top > runTop) runTop = top;
      } else {
        // A gap opened before this piece. Check whether the run that just
        // closed already satisfied the requirement; if not, start a fresh run
        // rather than letting an earlier, insufficient run keep being tested.
        if (runBottom <= lowerBound + EPS && runTop >= need - EPS) { covered = true; break; }
        runBottom = bottom;
        runTop = top;
      }
    }
    if (!covered && runBottom !== null && runBottom <= lowerBound + EPS && runTop >= need - EPS) {
      covered = true;
    }
    return covered;
  }
}

/**
 * Is every face of a connector's REGION sealed?
 *
 * `isEnclosureSound` asks about one rectangle and requires each side to be
 * covered by pieces that span that whole side. That is right for a stair or a
 * lift, which occupy one cell, and wrong for a tunnel: its region is two
 * cells, and its cross-fold faces are emitted as one piece PER CELL - they
 * have to be, because the two cells can have different topology and so can
 * need different doorway heights. A full-width test rejects both halves and
 * calls a sealed tunnel unsealed, which is exactly what it did.
 *
 * So a region is checked CELL BY CELL, at each cell's own four faces, with one
 * exemption and one only: a face shared with another cell OF THE SAME
 * CONNECTOR is skipped, because that is where the fold runs and a wall there
 * would be a wall through the middle of the tunnel.
 *
 * That exemption is deliberately the narrowest thing that works. It is NOT
 * "skip faces with no wall" - a genuinely missing wall on any other face still
 * fails, and a two-cell region still has six faces every one of which must be
 * covered. The bar each face is held to is the REGION's `requiredWallTop`, so
 * a tread high up in one cell raises the requirement for both.
 */
export function isRegionEnclosureSound(descs, cells, x, z, level) {
  const region = connectorRegion(cells, x, z, level);
  const shaft = regionShaft(cells, x, z, level);
  const need = requiredWallTop(descs, shaft);
  const half = MAZE.CELL / 2;
  const steps = [{ dx: -1, dz: 0 }, { dx: 1, dz: 0 }, { dx: 0, dz: -1 }, { dx: 0, dz: 1 }];

  for (let cz = region.z0; cz <= region.z1; cz++) {
    for (let cx = region.x0; cx <= region.x1; cx++) {
      const w = cellToWorld(cx, cz, level);
      const cell = { cx: w.x, cz: w.z, floorY: w.y };
      for (const s of steps) {
        const nx = cx + s.dx, nz = cz + s.dz;
        if (nx >= region.x0 && nx <= region.x1 && nz >= region.z0 && nz <= region.z1) continue;
        const side = s.dx
          ? { axis: 'x', at: w.x + s.dx * half }
          : { axis: 'z', at: w.z + s.dz * half };
        if (!sideCovered(descs, cell, side, need)) return false;
      }
    }
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* The lift                                                            */
/*                                                                     */
/* Phase 2c Task 4 proved this arrangement BEFORE any of it was built.  */
/* The measurements, and the two candidates it rejected, are in         */
/* docs/superpowers/specs/2026-08-08-maze-world-phase-2c-ledger.md; the */
/* proof itself is scripts/tests/maze-lift-footprint.test.mjs.          */
/* ------------------------------------------------------------------ */

/**
 * The car's footprint, inset slightly inside the well so it never catches on
 * the shaft walls as it travels.
 */
const LIFT_CAR_INSET = 0.05;
export const LIFT_CAR_HALF = STAIR_WELL_HALF - LIFT_CAR_INSET;
const LIFT_CAR_HALF_THICK = 0.15;

/**
 * How high the car's top sits above the shaft floor when it is down.
 *
 * DERIVED from the auto-step rather than written as 0.30, so the car is
 * always something the player WALKS onto rather than hops onto - and because
 * both of this project's shaft constants have been wrong when written as
 * literals: `requiredWallTop`'s bar and `ENTRY_SEAL_FROM` each shipped as a
 * number unrelated to the thing it was supposed to bound.
 */
const LIFT_REST_CLEARANCE = MAZE.STEP_HEIGHT * (2 / 3);

/**
 * How far the landing door's top stands above level N+1's floor when OPEN.
 *
 * Derived from the auto-step, and under it, so an open door is something the
 * player walks straight over without even a step up - a door you have to hop
 * is a door that reads as still shut.
 */
export const LIFT_DOOR_OPEN_RISE = MAZE.STEP_HEIGHT * 0.5;

/** A lift uses the same well a stair does, so the hole above it is the same hole. */
export const liftWellBounds = stairWellBounds;

/**
 * The four sides of a shaft cell, walled from the floor - or from
 * `ENTRY_SEAL_FROM` on a side the topology leaves open - up to `LEVEL_HEIGHT`.
 *
 * Extracted from `stairColliders` in Phase 2c so the lift gets exactly the
 * same enclosure rather than a second implementation of it. Every word of
 * `stairColliders`'s comment about per-side ownership, about the doorway, and
 * about why these walls stop at `LEVEL_HEIGHT` rather than a hedge higher
 * applies here unchanged - that comment is this function's specification.
 */
export function shaftWalls(cells, x, z, level) {
  const idx = cellIndex(x, z, level);
  const w = cellToWorld(x, z, level);
  const H = MAZE.LEVEL_HEIGHT;
  const half = MAZE.CELL / 2;
  const out = [];
  const sides = [
    { dir: DIR.N, dx: 0, dz: -1, selfOwned: true }, { dir: DIR.E, dx: 1, dz: 0, selfOwned: false },
    { dir: DIR.S, dx: 0, dz: 1, selfOwned: false }, { dir: DIR.W, dx: -1, dz: 0, selfOwned: true },
  ];
  for (const s of sides) {
    const open = isOpen(cells, idx, s.dir);
    let baseY;
    if (open) baseY = w.y + ENTRY_SEAL_FROM;
    else if (s.selfOwned) baseY = w.y + MAZE.HEDGE_HEIGHT;
    else baseY = w.y;
    const topY = w.y + H;
    out.push({
      cx: w.x + s.dx * half,
      cy: (baseY + topY) / 2,
      cz: w.z + s.dz * half,
      hx: s.dx ? 0.6 : half,
      hy: (topY - baseY) / 2,
      hz: s.dz ? 0.6 : half,
      kind: 'shaftWall',
    });
  }
  return out;
}

/**
 * A counterweight lift from `level` to `level + 1`.
 *
 * The car is ONE swept descriptor filling the well, inside the same enclosure
 * a staircase gets. What is deliberately NOT here is the landing door: that
 * stands on level N+1's floor and is emitted by `landingColliders` alongside
 * the guard rails, because it is level N+1's geometry and not this shaft's -
 * exactly the division the stair's own guard walls already follow.
 *
 * The car's `swept` range is the whole point. `cy`/`hy` place the physical box
 * where it RESTS, which `MazeChunks` turns into a collider and then drives
 * with `Physics.setBoxColliderY`; `swept` tells the static gates where it
 * GOES. Its top of travel is `LEVEL_HEIGHT`, flush with level N+1's floor,
 * which is exactly where the staircase's landing sits - so `requiredWallTop`
 * derives the same 9 m bar for a lift shaft as for a stair shaft, and the
 * walls `shaftWalls` emits already satisfy it. That is the enclosure rule
 * behaving as designed on a new shape, not a coincidence, but if a lift ever
 * gains a rest position ABOVE the landing the bar moves with it.
 */
export function liftColliders(cells, x, z, level) {
  const w = cellToWorld(x, z, level);
  const well = liftWellBounds(x, z, level);
  const out = shaftWalls(cells, x, z, level);

  const downTop = w.y + LIFT_REST_CLEARANCE;
  const upTop = w.y + MAZE.LEVEL_HEIGHT;
  out.push({
    cx: well.cx,
    cy: downTop - LIFT_CAR_HALF_THICK,
    cz: well.cz,
    hx: LIFT_CAR_HALF, hy: LIFT_CAR_HALF_THICK, hz: LIFT_CAR_HALF,
    kind: 'lift',
    enclosed: true,
    swept: { y0: downTop - 2 * LIFT_CAR_HALF_THICK, y1: upTop },
    /* Which link this belongs to. A lift's car and its landing door are
     * emitted by DIFFERENT districts - the car by the one at level N, the door
     * by the one at level N+1 - and either can be evicted while the other
     * stays resident. `MazeChunks` keys its lift registry on this so the two
     * halves find each other, rather than on the district that happened to
     * emit them. */
    cell: cellIndex(x, z, level),
  });
  return out;
}

/** The one moving car among a set of descriptors, or null. */
export function liftCarDescriptor(descs) {
  return descs.find((d) => d.kind === 'lift') ?? null;
}

/** The one landing door among a set of descriptors, or null. */
export function liftDoorDescriptor(descs) {
  return descs.find((d) => d.kind === 'liftDoor') ?? null;
}

/**
 * Guard rails - and for a lift, the landing door - standing on level N+1's
 * floor around the hole a connector opens in it.
 *
 * This is level N+1's own geometry rather than the shaft's, which is why it
 * lives in its own function and why `THE CAP` check is stated against what the
 * SHAFT emits. `x`, `z` and `level` are the CONNECTOR's, one level below the
 * floor being railed.
 *
 * Both layouts leave their way in on the well's INNER faces - the ones facing
 * the L-shaped strip along the cell's north and west that `STAIR_WELL_OFFSET`
 * exists to preserve. The outer faces have only 0.7 m to the cell boundary,
 * no wider than the player's own capsule, so a doorway there would be one
 * nobody could reach.
 */
export function landingColliders(cells, x, z, level) {
  const well = stairWellBounds(x, z, level);
  const baseY = (level + 1) * MAZE.LEVEL_HEIGHT;
  const guardTop = baseY + MAZE.HEDGE_HEIGHT;
  const T = GUARD_HALF_THICK * 2;
  const out = [];
  const push = (gx0, gx1, gz0, gz1, kind = 'hedge', extra = {}) => {
    out.push({
      cx: (gx0 + gx1) / 2, cy: (baseY + guardTop) / 2, cz: (gz0 + gz1) / 2,
      hx: (gx1 - gx0) / 2, hy: (guardTop - baseY) / 2, hz: (gz1 - gz0) / 2,
      kind, ...extra,
    });
  };

  if (connectorAt(cells, x, z, level) === 'tunnel' && tunnelOrientation(cells, x, z, level)) {
    /* A tunnel's rails go round the hole IT actually opens, which is
     * `tunnelExitBounds` and nowhere near the stair well. Railing the stair
     * well instead put a fence across level N+1's corridor where no hole was
     * AND left the real opening unguarded - measured as a crossing 3.95 m
     * short on seed 7, level 1.
     *
     * Three sides railed; the fourth is left open where the final tread
     * arrives, because that tread's top is flush with this floor and walking
     * off it is a step across a seam rather than a fall. Which side that is
     * is DERIVED from the geometry rather than assumed - the fold's
     * orientation decides it. */
    const ex = tunnelExitBounds(cells, x, z, level);
    const treads = tunnelColliders(cells, x, z, level).filter((d) => d.kind === 'tunnel');
    const last = treads.reduce((a2, d) => (d.cy + d.hy > a2.cy + a2.hy ? d : a2));
    const dLeft = Math.abs(last.cx - ex.x0), dRight = Math.abs(ex.x1 - last.cx);
    const dNear = Math.abs(last.cz - ex.z0), dFar = Math.abs(ex.z1 - last.cz);
    const nearest = Math.min(dLeft, dRight, dNear, dFar);
    if (nearest !== dLeft) push(ex.x0 - T, ex.x0, ex.z0 - T, ex.z1 + T);
    if (nearest !== dRight) push(ex.x1, ex.x1 + T, ex.z0 - T, ex.z1 + T);
    if (nearest !== dNear) push(ex.x0 - T, ex.x1 + T, ex.z0 - T, ex.z0);
    if (nearest !== dFar) push(ex.x0 - T, ex.x1 + T, ex.z1, ex.z1 + T);
    return out;
  }

  if (connectorAt(cells, x, z, level) === 'lift') {
    /* Three rails and a door, the door on the well's WEST inner face so it
     * opens onto the wide strip.
     *
     * It is emitted CLOSED, which is both the safe default and the true one:
     * the car's own rest state is down, and a lift whose car is down must have
     * its landing shut or the opening is a nine-metre pit - measured at
     * exactly 9.000 m in Task 4, before this door existed.
     *
     * `swept` declares the door's travel for the same reason the car's does,
     * and note what it means for the anti-ladder scan: `descriptorTop` returns
     * the top of that travel, `baseY + HEDGE_HEIGHT`, which sits exactly ON
     * the band's ceiling rather than inside it - the same position the guard
     * rails occupy and safe for the same reason. The door's TRANSIT through
     * the band is not made safe by that scan. It is made safe by the invariant
     * that the door never moves while its footprint is occupied, which is
     * behavioural and proven in `maze-lift-footprint.test.mjs`. An unguarded
     * door was measured carrying a rider to 14.000 m - the hedge top - so that
     * invariant is load-bearing, not a nicety. */
    push(well.x0 - T, well.x1 + T, well.z0 - T, well.z0);        // north (inner), railed
    push(well.x1, well.x1 + T, well.z0 - T, well.z1 + T);        // east (outer), railed
    push(well.x0 - T, well.x1 + T, well.z1, well.z1 + T);        // south (outer), railed
    push(well.x0 - T, well.x0, well.z0, well.z1, 'liftDoor', {   // west (inner), the door
      swept: { y0: baseY, y1: guardTop },
      /* Same link as the car one level below - see the car's own `cell`. */
      cell: cellIndex(x, z, level),
      /* Where this door's top sits when it is open, so `MazeChunks` does not
       * have to re-derive it and cannot disagree with the geometry. */
      openTop: baseY + LIFT_DOOR_OPEN_RISE,
    });
    return out;
  }

  /* The staircase's rails, unchanged from Phase 2b. Every rail sits just
   * OUTSIDE the surface it guards, never overhanging it: the well's own bounds
   * are exactly the space a climbing capsule needs, so a rail that leaned in
   * would be a rail the climber's head walks into on the last turn. */
  // The well's two inner faces, guarded everywhere except along the landing.
  push(well.x0 - T, well.x0, well.cz, well.z1 + T);
  push(well.cx, well.x1 + T, well.z0 - T, well.z0);
  // The well's two outer faces, guarded for their whole length.
  push(well.x1, well.x1 + T, well.z0 - T, well.z1 + T);
  push(well.x0 - T, well.x1 + T, well.z1, well.z1 + T);
  /* The head of the stair. A spiral is continuous everywhere but here: go one
   * more step round from the landing and the highest thing under you is the
   * turn BELOW, a drop of several metres rather than one riser. So the landing
   * is railed on both its inner faces EXCEPT the stretch the last tread lies
   * across, which is the way down. */
  push(well.cx, well.cx + T, well.z0, well.cz);
  push(well.cx - TREAD_HALF, well.cx + T, well.cz, well.cz + T);
  return out;
}

/**
 * The rectangle a connector needs punched out of level N+1's floor.
 *
 * One function, dispatching on kind, because the hole and the geometry that
 * climbs through it must come from a single derivation - `stairWellBounds`'s
 * own comment sets that rule out and this is it extended to three shapes
 * rather than abandoned for them. `districtColliders` calls this and nothing
 * else; it never re-derives a connector's extent itself.
 *
 * Returns the same `{cx, cz, x0, x1, z0, z1}` shape `stairWellBounds` does, so
 * the floor tiling that already handles any axis-aligned rectangle needs no
 * change at all - only its input widens.
 */
export function connectorHoleBounds(cells, x, z, level) {
  switch (connectorAt(cells, x, z, level)) {
    case 'lift':   return liftWellBounds(x, z, level);
    case 'tunnel': return tunnelOrientation(cells, x, z, level)
      ? tunnelExitBounds(cells, x, z, level)
      : stairWellBounds(x, z, level);
    default:       return stairWellBounds(x, z, level);
  }
}

/**
 * Every cell a connector's geometry occupies, as a rectangle in cell
 * coordinates.
 *
 * A stair and a lift each live inside ONE cell. A tunnel folds across TWO
 * (Task 7: four flights over two lanes, 5.70 m of body in a 12 m two-cell
 * region), so "the shaft" stops being a synonym for "the cell" and the
 * enclosure proof has to reason about the region's OUTER boundary instead -
 * the face between two cells of the same tunnel is deliberately open, and a
 * per-cell check would demand a wall there and fail a legitimate tunnel.
 */
export function connectorRegion(cells, x, z, level) {
  if (connectorAt(cells, x, z, level) === 'tunnel') return tunnelRegion(cells, x, z, level);
  return { x0: x, x1: x, z0: z, z1: z };
}

/**
 * The world-space bounds of a connector's region, as a shaft argument for
 * `isEnclosureSound` and `requiredWallTop`.
 */
export function regionShaft(cells, x, z, level) {
  const r = connectorRegion(cells, x, z, level);
  const a = cellToWorld(r.x0, r.z0, level);
  const b = cellToWorld(r.x1, r.z1, level);
  const half = MAZE.CELL / 2;
  return {
    cx: (a.x + b.x) / 2,
    cz: (a.z + b.z) / 2,
    floorY: a.y,
    hx: (b.x - a.x) / 2 + half,
    hz: (b.z - a.z) / 2 + half,
  };
}

/* ------------------------------------------------------------------ */
/* The tunnel                                                          */
/*                                                                     */
/* Phase 2c Task 7 proved this footprint before any of it was built,   */
/* and it is NOT the shape the plan assumed. The measurements are in   */
/* scripts/tests/maze-tunnel-footprint.test.mjs and the ledger.        */
/* ------------------------------------------------------------------ */

/**
 * Flights, and why four rather than the two the plan sized for.
 *
 * A 2-flight U needs 12 treads per flight = 9.0 m of run, so its body is
 * 10.20 m long inside a 12 m two-cell region and leaves **0.90 m** of end gap
 * against a 0.70 m capsule - 0.10 m of clearance each side. That is the
 * identical razor margin 2b flagged on the stair's narrowest tread strip and
 * warned had no headroom if extents ever changed.
 *
 * Four flights of six treads run 4.5 m each, so the body is 5.70 m and the
 * gaps are **3.15 m**. Those gaps are what keeps the region walkable: Task 7
 * measured 12/12 side pairs reachable, and measured that connectivity survives
 * every flight half-width from 0.5 up to 1.0, failing only at 1.2 where the
 * side strip closes to exactly zero.
 *
 * The reason four flights looks impossible at first is worth writing down:
 * flight 2 sits directly above flight 0, but TWO flights up, so the headroom
 * between them is `2 * flightRise` = 4.5 m and not the 2.25 m a first reading
 * gives.
 */
const TUNNEL_FLIGHTS = 4;
const TUNNEL_TREADS_PER_FLIGHT = SHAFT_STEPS / TUNNEL_FLIGHTS;
const TUNNEL_TREAD = 0.75;
const TUNNEL_RUN = TUNNEL_TREADS_PER_FLIGHT * TUNNEL_TREAD;
const TUNNEL_FLIGHT_RISE = TUNNEL_TREADS_PER_FLIGHT * (MAZE.LEVEL_HEIGHT / SHAFT_STEPS);

/**
 * One flight's half-width.
 *
 * Free to choose, and that is a measured result rather than an assumption: the
 * plan expected a narrow flight to be needed so a walkable strip survived
 * beside the body, but Task 7 found the END GAPS carry connectivity and every
 * width from 0.5 to 1.0 works. 0.6 leaves a 1.20 m strip beside the body and a
 * 3.15 m gap at each end - comfortable on both counts rather than tight on
 * either.
 */
const TUNNEL_HALF_WIDTH = 0.6;
const TUNNEL_BODY_LEN = TUNNEL_RUN + 2 * TUNNEL_HALF_WIDTH;

/** The four directions a tunnel's second cell can lie in. */
const TUNNEL_DIRS = Object.freeze([
  { dx: 1, dz: 0 }, { dx: 0, dz: 1 }, { dx: -1, dz: 0 }, { dx: 0, dz: -1 },
]);

/**
 * Which way this tunnel folds.
 *
 * Hashed like everything else, but CONSTRAINED to the directions whose second
 * cell stays inside the same district. District independence is what lets two
 * neighbours agree on their openings without either having been generated, and
 * it is what makes both streaming and the headless gates possible - a tunnel
 * reaching across a district seam would break it. A cell in a district corner
 * simply has fewer directions available, never a tunnel that reaches out.
 */
export function tunnelOrientation(cells, x, z, level) {
  const D = MAZE.DISTRICT;
  const lx = ((x % D) + D) % D, lz = ((z % D) + D) % D;

  /* A tunnel's body is a BAR running the length of both its cells, so it
   * blocks any passage that crosses it - and unlike the staircase, which hides
   * in one quadrant and leaves an L-shaped strip joining all four sides, there
   * is no arrangement of a bar that leaves a crossroads walkable.
   *
   * Measured, by flood fill, on real geometry: a tunnel folded through a cell
   * whose topology opens all four sides cut 2 of those 4 faces off from the
   * others. That is the round-3 Critical from Phase 2b - "do not sever the
   * corridors" - and it is not a bug in the fold but a property of its shape.
   *
   * So placement is constrained rather than the geometry patched: a direction
   * is only valid if NEITHER cell of the region has a passage PERPENDICULAR to
   * the fold, on EITHER level - the region is claimed on both. A cell with no
   * such direction gets a staircase instead, which is the connector this
   * project has proven six ways.
   */
  const perp = (d) => (d.dx ? [DIR.N, DIR.S] : [DIR.E, DIR.W]);
  const valid = TUNNEL_DIRS.filter((d) => {
    const nx = lx + d.dx, nz = lz + d.dz;
    if (nx < 0 || nx >= D || nz < 0 || nz >= D) return false;      // stay in the district
    /* The constraint applies at level N, where the BODY is - it is the bar
     * that severs. At level N+1 the tunnel claims only its exit hole, which is
     * a fraction of one cell rather than a bar across two, and the rails round
     * it leave the corridor's own strips clear. Testing level N+1 as if the
     * whole region were claimed there rejected almost everything: it took the
     * survival rate down to 3 links in 92. The flood fill is what decides
     * whether that relaxation is safe, and it is run on both levels. */
    for (const [cx, cz] of [[x, z], [x + d.dx, z + d.dz]]) {
      for (const bit of perp(d)) {
        if (isOpen(cells, cellIndex(cx, cz, level), bit)) return false;
      }
    }
    /* And at level N+1, for the EXIT CELL only. The body is a bar across two
     * cells at level N, but above it the tunnel claims just its exit hole, in
     * cell C - so C is the only cell whose crossing passages that hole and its
     * rails can sever. Dropping this check entirely (on the reasoning that a
     * hole is smaller than a bar) was MEASURED unsafe: a tunnel at 5,388 on
     * seed 1 cut 2 of 4 open faces off at level 1. Applying it to both cells
     * instead is over-strict and costs most of the connector. */
    if (level + 1 < MAZE.LEVELS) {
      for (const bit of perp(d)) {
        if (isOpen(cells, cellIndex(x, z, level + 1), bit)) return false;
      }
    }
    return true;
  });
  if (valid.length === 0) return null;
  return valid[hash32(x, z, level, 0x7d1) % valid.length];
}

/**
 * A tunnel's two cells, as an inclusive rectangle in cell coordinates.
 */
export function tunnelRegion(cells, x, z, level) {
  const d = tunnelOrientation(cells, x, z, level);
  if (!d) return { x0: x, x1: x, z0: z, z1: z };
  return {
    x0: Math.min(x, x + d.dx), x1: Math.max(x, x + d.dx),
    z0: Math.min(z, z + d.dz), z1: Math.max(z, z + d.dz),
  };
}

/**
 * A four-flight switchback tunnel from `level` to `level + 1`, folded across
 * two cells and surfacing above the cell it started under.
 *
 * That last part is the whole reason for the fold. 24 rises at 0.375 m is
 * 18 m of run, which would surface three cells away, and a displaced vertical
 * link would drag `neighbourCell`, `carveDistrict`, `solve`, reachability and
 * the map along with it. Folding keeps the topology link C->C and pays for it
 * in footprint instead.
 */
export function tunnelColliders(cells, x, z, level) {
  const d = tunnelOrientation(cells, x, z, level);
  if (!d) return stairColliders(cells, x, z, level);

  const w = cellToWorld(x, z, level);
  const out = [];
  const rise = MAZE.LEVEL_HEIGHT / SHAFT_STEPS;
  const W = TUNNEL_HALF_WIDTH;

  /* Local axes: `a` runs along the fold, `b` across it. Working in these and
   * mapping to world x/z at the end is what keeps one implementation for all
   * four orientations instead of four nearly-identical ones. */
  const along = (v) => ({ x: w.x + d.dx * v, z: w.z + d.dz * v });
  const across = (v) => ({ x: w.x + d.dz * v, z: w.z + d.dx * v });
  const at = (a, b) => ({
    x: w.x + d.dx * a + d.dz * b,
    z: w.z + d.dz * a + d.dx * b,
  });
  /* Half-extents follow the same mapping: a box `ha` long and `hb` wide is
   * (ha, hb) or (hb, ha) in world terms depending on the axis. */
  const ext = (ha, hb) => ({
    hx: d.dx ? ha : hb,
    hz: d.dx ? hb : ha,
  });

  const regionHalf = MAZE.CELL;                       // two cells, measured from C's centre
  const gap = (2 * MAZE.CELL - TUNNEL_BODY_LEN) / 2;
  const bodyA0 = -MAZE.CELL / 2 + gap;                // start of the body, along the fold

  for (let f = 0; f < TUNNEL_FLIGHTS; f++) {
    const lane = (f % 2) === 0 ? -W : W;
    const forward = (f % 2) === 0;
    for (let i = 0; i < TUNNEL_TREADS_PER_FLIGHT; i++) {
      const bottom = w.y + f * TUNNEL_FLIGHT_RISE + i * rise;
      const top = bottom + rise;
      const a = bodyA0 + W + (forward ? (i + 0.5) * TUNNEL_TREAD
        : TUNNEL_RUN - (i + 0.5) * TUNNEL_TREAD);
      const c = at(a, lane);
      const e = ext(TUNNEL_TREAD / 2, W);
      out.push({
        cx: c.x, cy: (bottom + top) / 2, cz: c.z,
        hx: e.hx, hy: (top - bottom) / 2, hz: e.hz,
        kind: 'tunnel', enclosed: true,
      });
    }
    if (f < TUNNEL_FLIGHTS - 1) {
      const turnTop = w.y + (f + 1) * TUNNEL_FLIGHT_RISE;
      const a = bodyA0 + (forward ? TUNNEL_BODY_LEN - W : W);
      const c = at(a, 0);
      const e = ext(W, W * 2);
      out.push({
        cx: c.x, cy: (w.y + turnTop) / 2, cz: c.z,
        hx: e.hx, hy: (turnTop - w.y) / 2, hz: e.hz,
        kind: 'tunnel', enclosed: true,
      });
    }
  }

  /* The region's OUTER walls. Six faces, not eight: the face between the two
   * cells is deliberately open, because that is where the fold runs. A
   * per-cell enclosure check would demand a wall there and fail a legitimate
   * tunnel, which is exactly why `isEnclosureSound` gained `hx`/`hz` in
   * Task 8 and is asked about the REGION rather than about each cell. */
  const H = MAZE.LEVEL_HEIGHT;
  const half = MAZE.CELL / 2;
  const idx = cellIndex(x, z, level);
  const other = cellIndex(x + d.dx, z + d.dz, level);
  const faces = [
    // Along the fold: C's far face and C+1's far face.
    { a: -half, b: 0, ha: 0.6, hb: half, cell: idx, dir: dirFor(-d.dx, -d.dz) },
    { a: 2 * MAZE.CELL - half, b: 0, ha: 0.6, hb: half, cell: other, dir: dirFor(d.dx, d.dz) },
    // Across the fold: both cells, both sides.
    { a: 0, b: -half, ha: half, hb: 0.6, cell: idx, dir: dirFor(-d.dz, -d.dx) },
    { a: 0, b: half, ha: half, hb: 0.6, cell: idx, dir: dirFor(d.dz, d.dx) },
    { a: MAZE.CELL, b: -half, ha: half, hb: 0.6, cell: other, dir: dirFor(-d.dz, -d.dx) },
    { a: MAZE.CELL, b: half, ha: half, hb: 0.6, cell: other, dir: dirFor(d.dz, d.dx) },
  ];
  for (const fc of faces) {
    const open = fc.dir !== 0 && isOpen(cells, fc.cell, fc.dir);
    const baseY = open ? w.y + ENTRY_SEAL_FROM : w.y;
    const c = at(fc.a, fc.b);
    const e = ext(fc.ha, fc.hb);
    out.push({
      cx: c.x, cy: (baseY + w.y + H) / 2, cz: c.z,
      hx: e.hx, hy: (w.y + H - baseY) / 2, hz: e.hz,
      kind: 'shaftWall',
    });
  }

  return out;
}

/** The DIR bit for a unit step, or 0 if it is not one of the four. */
function dirFor(dx, dz) {
  if (dx === 1) return DIR.E;
  if (dx === -1) return DIR.W;
  if (dz === 1) return DIR.S;
  if (dz === -1) return DIR.N;
  return 0;
}

/**
 * Where a tunnel breaks through level N+1's floor.
 *
 * DERIVED from the treads themselves rather than written down: the hole is the
 * bounding box of every tread that reaches into the floor slab, widened by a
 * capsule radius so a climber's shoulders clear it too. Deriving it is the
 * rule `stairWellBounds` set - the hole and the geometry inside it must come
 * from one place or they drift, and this project's history is made of that
 * drift.
 */
export function tunnelExitBounds(cells, x, z, level) {
  const slabBottom = (level + 1) * MAZE.LEVEL_HEIGHT - 1.0;
  const descs = tunnelColliders(cells, x, z, level).filter((d) => d.kind === 'tunnel');
  const through = descs.filter((d) => d.cy + d.hy > slabBottom + 1e-6);
  const src = through.length ? through : descs;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const d of src) {
    x0 = Math.min(x0, d.cx - d.hx); x1 = Math.max(x1, d.cx + d.hx);
    z0 = Math.min(z0, d.cz - d.hz); z1 = Math.max(z1, d.cz + d.hz);
  }
  const pad = 0.4;
  return {
    cx: (x0 + x1) / 2, cz: (z0 + z1) / 2,
    x0: x0 - pad, x1: x1 + pad, z0: z0 - pad, z1: z1 + pad,
  };
}


/* ------------------------------------------------------------------ */
/* The one-way gate                                                    */
/* ------------------------------------------------------------------ */

/**
 * How far the gate's top stands above the floor when it is OPEN.
 *
 * Under the auto-step, so an open gate is walked straight over. Derived from
 * `STEP_HEIGHT` rather than written down, for the same reason
 * `LIFT_REST_CLEARANCE` is: both of this project's shaft constants were wrong
 * when they were literals.
 */
const GATE_OPEN_RISE = MAZE.STEP_HEIGHT * 0.5;

/**
 * A one-way gate across the passage leaving (x, z, level) in `dir`.
 *
 * Stands OPEN - recessed, walked over - until the player passes it in the
 * forward direction, then closes behind them and stays closed for the visit.
 * A committal, not a trap: `MazePuzzles` places gates only along the
 * entrance-to-centre path and pointing forward, so passing one always moves
 * the player closer to the centre and no closure can put the centre behind a
 * door. Hold-L guarantees a way out regardless.
 *
 * The closed top sits at exactly `HEDGE_HEIGHT` - ON the anti-ladder band's
 * ceiling rather than inside it, the same position the guard rails and the
 * lift door occupy, and safe for the same reason. Its TRANSIT through the band
 * is not made safe by that; it is made safe by the same halt-while-occupied
 * invariant that governs the lift door, which Phase 2c measured at 14.000 m
 * when it was removed.
 *
 * @param {number} dir a DIR bit - which passage this gate closes
 * @returns {ColliderDesc[]}
 */
export function gateColliders(cells, x, z, level, dir) {
  const w = cellToWorld(x, z, level);
  const half = MAZE.CELL / 2;
  const dx = dir === DIR.E ? 1 : dir === DIR.W ? -1 : 0;
  const dz = dir === DIR.S ? 1 : dir === DIR.N ? -1 : 0;
  if (dx === 0 && dz === 0) return [];

  const openTop = w.y + GATE_OPEN_RISE;
  const closedTop = w.y + MAZE.HEDGE_HEIGHT;
  const hy = (closedTop - w.y) / 2;

  return [{
    /* Sits ON the cell boundary the passage crosses, thin across it and the
     * corridor's full width along it - the same footprint the hedge that
     * would otherwise be there occupies. */
    cx: w.x + dx * half,
    cy: openTop - hy,
    cz: w.z + dz * half,
    hx: dx ? 0.3 : MAZE.CORRIDOR / 2,
    hy,
    hz: dz ? 0.3 : MAZE.CORRIDOR / 2,
    kind: 'gate',
    /* Which way through it counts as FORWARD. `MazePuzzles` only ever places
     * a gate pointing along the entrance-to-centre path, so closing behind a
     * player who passed this way always leaves them closer to the centre. */
    dir,
    /* Where it GOES, for the static gates - see `descriptorTop`. `cy`/`hy`
     * above place it where it RESTS, which is open. */
    swept: { y0: w.y, y1: closedTop },
    cell: cellIndex(x, z, level),
    openY: openTop - hy,
    closedY: closedTop - hy,
  }];
}

/* -------------------------------------------------------------------- */
/* The sliding hedge wall                                               */
/* -------------------------------------------------------------------- */

/**
 * How far back along the approach the plate may sit, in cells.
 *
 * The spec asks for a plate that opens "a wall elsewhere IN SIGHT", so the
 * plate is walked back along a STRAIGHT open run from the doorway - line of
 * sight in a hedge maze is a straight corridor and nothing else. Four cells is
 * 24 m, which is far enough to be somewhere else and near enough that a wall
 * sliding open at the end of it is legible as the thing you just caused.
 */
const PLATE_MAX_BACK = 4;

/**
 * ...and how short a run is too short to bother.
 *
 * Measured over 2,323 candidate walls across twelve seeds, the straight run
 * back from a doorway is zero cells 46% of the time - a hedge maze turns
 * constantly, so most doorways are corners. A plate in the doorway cell sits
 * three metres from the wall it opens, which is not a puzzle: you walk up to
 * the wall, you are already standing on the trigger, and it opens. That reads
 * as an automatic door.
 *
 * So a wall whose plate would land there is NOT BUILT AT ALL, and the doorway
 * is left plainly open. `MazePuzzles` places these only off the
 * entrance-to-centre path, so dropping one costs an optional shortcut and
 * nothing else - and a quality bar on placement is a better answer than a
 * degenerate wall at half of them. It leaves roughly a hundred per maze, every
 * one of them nine metres or more from its plate and in sight of it.
 */
const PLATE_MIN_BACK = 1;

/** A plate is a flush stone pad. Well under the 0.45 m band floor. */
export const PLATE_HALF_HEIGHT = 0.04;
export const PLATE_HALF_WIDTH = 0.55;

/**
 * A sliding hedge wall, and the plate that opens it.
 *
 * THE GATE, INVERTED. It occupies the same footprint a gate does and moves
 * between the same two heights; the difference is entirely in the trigger and
 * the resting state. A gate stands open and shuts behind you. This stands
 * SHUT, blocking the doorway, and sinks out of the way when its plate is
 * stepped on - and stays sunk, because a plate that only holds the wall open
 * while you stand on it is a door nobody travelling alone can walk through.
 *
 * `MazePuzzles` places these only OFF the entrance-to-centre path, so a plate
 * that is never found costs a shortcut and never the maze.
 *
 * ## It carries the SAME interlock as the lift door
 *
 * Its top travels the whole 0.45-5.0 m band, in open corridor, with no sealed
 * shaft to earn the anti-ladder exemption. Closing under a standing player
 * would carry them onto a hedge - Phase 2c measured exactly that at 14.000 m
 * when the invariant was removed from the lift door. `MazeChunks.stepGates`
 * runs both, and its occupancy test is what keeps this honest.
 *
 * ## The plate is not a collider
 *
 * It is carried on this descriptor as a position rather than emitted as one of
 * its own. `districtColliders` output IS the collider set, so a second
 * descriptor would be a second collider per wall for something 8 cm tall that
 * nothing needs to stand on - the trigger is a position test, exactly as the
 * gate's forward-crossing test is.
 *
 * @param {Uint8Array} cells
 * @param {number} x @param {number} z @param {number} level
 * @param {number} dir the direction that crosses the doorway
 * @returns {ColliderDesc[]} one `slideWall`, or none if `dir` is not lateral
 */
export function slidingWallColliders(cells, x, z, level, dir) {
  const w = cellToWorld(x, z, level);
  const half = MAZE.CELL / 2;
  const dx = dir === DIR.E ? 1 : dir === DIR.W ? -1 : 0;
  const dz = dir === DIR.S ? 1 : dir === DIR.N ? -1 : 0;
  if (dx === 0 && dz === 0) return [];

  const openTop = w.y + GATE_OPEN_RISE;
  const closedTop = w.y + MAZE.HEDGE_HEIGHT;
  const hy = (closedTop - w.y) / 2;

  /* Walk BACK from the doorway - against `dir`, deeper into the district the
   * player approaches from - for as long as the corridor runs dead straight.
   * `back` is the direction of travel while walking away from the wall, so it
   * is the one each cell must be open along for the run to continue. */
  const back = dir === DIR.E ? DIR.W : dir === DIR.W ? DIR.E
    : dir === DIR.S ? DIR.N : DIR.S;
  let px = x, pz = z, run = 0;
  for (let i = 0; i < PLATE_MAX_BACK; i++) {
    if (!isOpen(cells, cellIndex(px, pz, level), back)) break;
    px -= dx;
    pz -= dz;
    run++;
  }
  if (run < PLATE_MIN_BACK) return [];
  const p = cellToWorld(px, pz, level);

  return [{
    cx: w.x + dx * half,
    cy: closedTop - hy,                    // RESTS shut, unlike a gate
    cz: w.z + dz * half,
    hx: dx ? 0.3 : MAZE.CORRIDOR / 2,
    hy,
    hz: dz ? 0.3 : MAZE.CORRIDOR / 2,
    kind: 'slideWall',
    dir,
    swept: { y0: w.y, y1: closedTop },
    cell: cellIndex(x, z, level),
    openY: openTop - hy,
    closedY: closedTop - hy,
    /* Where the plate is, in world metres. Its own cell too, so a test can
     * assert the run really is straight and open rather than trusting the
     * walk above. */
    plate: { x: p.x, y: p.y + PLATE_HALF_HEIGHT, z: p.z, cell: cellIndex(px, pz, level) },
  }];
}
