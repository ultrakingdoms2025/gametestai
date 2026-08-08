/**
 * Collision descriptors for a district - plain numbers, no THREE, no meshes.
 *
 * This separation is a spec requirement, not a style choice. The browser turns
 * these into `physics.addBox` calls *and* into instanced meshes; Node turns the
 * same descriptors into a collision world with no renderer at all, which is
 * what lets the containment, seam and prop-ladder gates run headless in
 * seconds. Derive colliders from built meshes instead and every one of those
 * gates becomes browser-bound.
 *
 * @typedef {{ cx:number, cy:number, cz:number,
 *             hx:number, hy:number, hz:number,
 *             kind:'hedge'|'floor'|'stair',
 *             enclosed?:boolean }} ColliderDesc
 */

import { MAZE, DIR, cellIndex, isOpen } from './MazeTopology.js';

/**
 * Steps per shaft. `LEVEL_HEIGHT / this` must not exceed the 0.45 m auto-step,
 * or the player cannot walk up it - 9.0 / 24 = 0.375 m, comfortably under.
 */
const SHAFT_STEPS = 24;

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

export const FORECOURT_HALF_WIDTH = 9;
/** North (far, closed) wall's z. South edge is the grid boundary at z=0. */
export const FORECOURT_NORTH_Z = -20;
/**
 * Where the portal itself stands - centred, and far enough from every wall
 * (10 m to the north wall, 9 m to each side wall) that the ~4.6 m widest
 * reach of the plinth and its steps cannot touch one.
 */
export const FORECOURT_PORTAL_Z = FORECOURT_NORTH_Z / 2;

/**
 * The walled forecourt outside the maze's north edge, where the return portal
 * stands.
 *
 * `PortalSystem`'s generic plinth (see PLINTH_TIERS in systems/Portals.js) is
 * an octagon of radius ~4.15 m plus front approach steps reaching another
 * ~4.6 m further out - nowhere near small enough to fit inside a single 6 m
 * maze cell with a 4.8 m corridor. `MazeTopology.carveEntranceCorridor` opens
 * a one-cell corridor from the entrance out to the grid's edge; this is the
 * room that corridor opens into - 18 m wide, 20 m deep, walled on three
 * sides, with the fourth (the side facing the corridor) left open.
 *
 * @param {number} entranceX world-space x of the entrance column
 *   (`cellToWorld(ex, ez, level).x`)
 * @param {number} [level]
 * @returns {ColliderDesc[]}
 */
export function forecourtColliders(entranceX, level = 0) {
  const baseY = level * MAZE.LEVEL_HEIGHT;
  const HH = MAZE.HEDGE_HEIGHT / 2;
  const HT = MAZE.HEDGE_THICK / 2;
  /** @type {ColliderDesc[]} */
  const out = [];

  // Floor. Extends half a cell past the grid boundary (z = HALF_CELL) to
  // overlap the entrance district's own floor slab, which overhangs the same
  // amount the other way - the same seam-closing trick `districtColliders`
  // uses at every other district border.
  const southZ = MAZE.CELL / 2;
  out.push({
    cx: entranceX,
    cy: baseY - 0.5,
    cz: (FORECOURT_NORTH_Z + southZ) / 2,
    hx: FORECOURT_HALF_WIDTH,
    hy: 0.5,
    hz: (southZ - FORECOURT_NORTH_Z) / 2,
    kind: 'floor',
  });

  // North (far) wall - closes the room off from open air behind the portal.
  out.push({
    cx: entranceX,
    cy: baseY + HH,
    cz: FORECOURT_NORTH_Z,
    hx: FORECOURT_HALF_WIDTH,
    hy: HH,
    hz: HT,
    kind: 'hedge',
  });

  // West and east walls, running the room's full depth. Left open at z=0: the
  // corridor mouth.
  const wallHalfDepth = (0 - FORECOURT_NORTH_Z) / 2;
  const wallCz = FORECOURT_NORTH_Z / 2;
  for (const sx of [-1, 1]) {
    out.push({
      cx: entranceX + sx * FORECOURT_HALF_WIDTH,
      cy: baseY + HH,
      cz: wallCz,
      hx: HT,
      hy: HH,
      hz: wallHalfDepth,
      kind: 'hedge',
    });
  }

  return out;
}

/**
 * Centre of a cell's floor, in world metres.
 * Cell 0,0 sits at the origin; the grid extends into +x/+z.
 */
export function cellToWorld(x, z, level) {
  return {
    x: x * MAZE.CELL,
    y: level * MAZE.LEVEL_HEIGHT,
    z: z * MAZE.CELL,
  };
}

/**
 * A staircase from `level` to `level + 1`, inside the cell that carries the
 * UP link.
 *
 * The steps spiral around the cell's edge (one and a half turns) so a 6 m
 * cell can climb 9 m without any single rise exceeding the auto-step. Tread
 * half-extents (0.9 m, widened from 0.75 m in fix round 2 - Finding 5 found
 * the narrowest strip a climbing capsule could rely on between consecutive
 * treads was only 0.616 m against its own 0.70 m diameter, no headroom if
 * tread size or capsule radius ever moved) are kept under the 1.1 m ceiling
 * `overlappingShaftCells` needs at the spiral radius actually used here
 * (`r` below, 1.90 m) - `MAZE.CELL / 2 - r` = 3.0 - 1.9 = 1.1 m, the most a
 * tread can reach outward from its own centre before its footprint crosses
 * this cell's own boundary into a neighbour. (Fix round 3, Finding 2: this
 * comment used to say "2.4 m", the generic half-corridor figure Task 3's
 * own Trap 1 quotes for a tread centred on the CELL - it does not apply
 * here, where every tread sits offset by `r` from the cell centre. The real
 * ceiling is 1.1 m, and 0.9 m leaves 0.2 m of margin, not 1.5 m.)
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
export function shaftColliders(cells, x, z, level) {
  const idx = cellIndex(x, z, level);
  if (!isOpen(cells, idx, DIR.UP)) return [];

  const w = cellToWorld(x, z, level);
  const out = [];
  const rise = MAZE.LEVEL_HEIGHT / SHAFT_STEPS;
  const r = MAZE.CORRIDOR / 2 - 0.5;
  const treadHalf = 0.9;

  for (let i = 0; i < SHAFT_STEPS; i++) {
    const a = (i / SHAFT_STEPS) * Math.PI * 2 * 1.5; // one and a half turns
    const top = w.y + (i + 1) * rise;
    const bottom = w.y + i * rise;
    out.push({
      cx: w.x + Math.cos(a) * r,
      cy: (bottom + top) / 2,
      cz: w.z + Math.sin(a) * r,
      hx: treadHalf, hy: (top - bottom) / 2, hz: treadHalf,
      kind: 'stair',
      enclosed: true,
    });
  }

  /* Walls. See this function's own comment for the per-side reasoning and
   * for why H stops at LEVEL_HEIGHT rather than LEVEL_HEIGHT + HEDGE_HEIGHT. */
  const H = MAZE.LEVEL_HEIGHT;
  const half = MAZE.CELL / 2;
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
      kind: 'hedge',
    });
  }

  return out;
}

/**
 * Every collider for one district.
 *
 * A hedge is emitted on a cell's north and west sides only, plus on the south
 * and east sides of a cell that sits on the GLOBAL grid's far edge (`z`/`x` ===
 * `MAZE.CELLS - 1`), where no neighbouring cell exists to own that face.
 * Emitting all four sides per cell would double every interior wall - two
 * coincident colliders in the same place, each answering every query. The
 * south/east fallback used to key on the *district's* last row and column
 * instead, which was wrong: every internal district seam is also a district's
 * last row or column from one side, so that version emitted a duplicate hedge
 * at every seam. Keying on the grid's edge instead of the district's edge is
 * what keeps this to one hedge per interior wall.
 *
 * @param {Uint8Array} cells
 * @param {number} dx
 * @param {number} dz
 * @param {number} level
 * @returns {ColliderDesc[]}
 */
export function districtColliders(cells, dx, dz, level) {
  const D = MAZE.DISTRICT;
  const x0 = dx * D;
  const z0 = dz * D;
  const baseY = level * MAZE.LEVEL_HEIGHT;
  /** @type {ColliderDesc[]} */
  const out = [];

  /* Fix round 2, Finding 1: a shaft's stairs climb into this district's OWN
   * floor slab unless it has a hole where the shaft lands. The district
   * graph allows at most one UP edge per (dx,dz,level) node (see
   * buildDistrictGraph - each node has at most one "up" neighbour), and
   * carveDistrict places at most one vertical doorway per open edge, so at
   * most one cell in this whole district can carry DIR.UP at level-1
   * landing here. Scanning for it costs one pass over the district's own
   * cells at the level below - cheap, and simpler than threading district
   * coordinates into a per-cell "is this a shaft landing" query. */
  let hole = null;
  if (level > 0) {
    for (let lz = 0; lz < D && !hole; lz++) {
      for (let lx = 0; lx < D; lx++) {
        const hx = x0 + lx, hz = z0 + lz;
        if (isOpen(cells, cellIndex(hx, hz, level - 1), DIR.UP)) { hole = { x: hx, z: hz }; break; }
      }
    }
  }

  /* One floor slab per district, extended half a cell past every border so it
   * overlaps its neighbours. A chunk boundary must never be a hole to fall
   * through, and an overlap is the cheapest possible guarantee of that -
   * EXCEPT the one deliberate hole above a shaft landing, which must let a
   * climbing capsule through while still supporting a pedestrian walking
   * level `level` everywhere else. The shaft's own walls (emitted at
   * level-1, but physically spanning up through this level's height - see
   * `shaftColliders`) are what stop that pedestrian from ever reaching the
   * hole sideways: at this level's height they are sealed on every side
   * (`ENTRY_SEAL_FROM` sits at ~3.57m, well below `LEVEL_HEIGHT` 9m), so the
   * hole is only ever reachable by climbing up through it, never by walking
   * into it. */
  const half = (D * MAZE.CELL + MAZE.CELL) / 2;
  const originX = x0 * MAZE.CELL;
  const originZ = z0 * MAZE.CELL;
  const centerX = originX + (D - 1) * MAZE.CELL / 2;
  const centerZ = originZ + (D - 1) * MAZE.CELL / 2;
  const floorX0 = centerX - half, floorX1 = centerX + half;
  const floorZ0 = centerZ - half, floorZ1 = centerZ + half;

  const pushFloorRect = (fx0, fx1, fz0, fz1) => {
    out.push({
      cx: (fx0 + fx1) / 2,
      cy: baseY - 0.5,
      cz: (fz0 + fz1) / 2,
      hx: (fx1 - fx0) / 2,
      hy: 0.5,
      hz: (fz1 - fz0) / 2,
      kind: 'floor',
    });
  };

  if (!hole) {
    pushFloorRect(floorX0, floorX1, floorZ0, floorZ1);
  } else {
    // Tile the district floor as four rectangles around the hole - west and
    // east strips run the full Z span; north and south strips fill the
    // remaining middle column only. Together with the hole itself (left
    // empty) this covers the district's full floor footprint exactly once:
    // no overlap, no gap, anywhere except the hole. The hole is sized to
    // exactly the shaft cell's own footprint (MAZE.CELL, matching the
    // boundary shaftColliders' walls already stand on), never larger - a
    // bigger hole would open a real gap beyond where those walls protect it.
    const hw = cellToWorld(hole.x, hole.z, level);
    const hHalf = MAZE.CELL / 2;
    const hx0 = hw.x - hHalf, hx1 = hw.x + hHalf;
    const hz0 = hw.z - hHalf, hz1 = hw.z + hHalf;
    pushFloorRect(floorX0, hx0, floorZ0, floorZ1); // west
    pushFloorRect(hx1, floorX1, floorZ0, floorZ1); // east
    pushFloorRect(hx0, hx1, floorZ0, hz0); // north (middle column)
    pushFloorRect(hx0, hx1, hz1, floorZ1); // south (middle column)
  }

  const HH = MAZE.HEDGE_HEIGHT / 2;
  const HT = MAZE.HEDGE_THICK / 2;
  const HALF_CELL = MAZE.CELL / 2;

  /** Wall spanning a full cell edge, thickness across the passage direction. */
  const pushHedge = (cx, cz, axis) => {
    out.push({
      cx,
      cy: baseY + HH,
      cz,
      hx: axis === 'x' ? HT : HALF_CELL,
      hy: HH,
      hz: axis === 'x' ? HALF_CELL : HT,
      kind: 'hedge',
    });
  };

  for (let lz = 0; lz < D; lz++) {
    for (let lx = 0; lx < D; lx++) {
      const x = x0 + lx;
      const z = z0 + lz;
      const idx = cellIndex(x, z, level);
      const w = cellToWorld(x, z, level);

      // North face (-z). Owned by this cell.
      if (!isOpen(cells, idx, DIR.N)) pushHedge(w.x, w.z - HALF_CELL, 'z');
      // West face (-x). Owned by this cell.
      if (!isOpen(cells, idx, DIR.W)) pushHedge(w.x - HALF_CELL, w.z, 'x');
      // South and east only on the global grid's far edges, where no adjacent cell
      // exists to own them. Using global grid coordinates (z, x not lz, lx) prevents
      // duplicate emission at district seams, where both adjacent districts would
      // otherwise emit hedges at the same position.
      if (z === MAZE.CELLS - 1 && !isOpen(cells, idx, DIR.S)) pushHedge(w.x, w.z + HALF_CELL, 'z');
      if (x === MAZE.CELLS - 1 && !isOpen(cells, idx, DIR.E)) pushHedge(w.x + HALF_CELL, w.z, 'x');

      // A cell carrying the UP link becomes a shaft: steps plus its own full
      // enclosure, emitted regardless of which side of the district (x,z)
      // falls on - shaftColliders walls all four of ITS OWN sides itself, so
      // (unlike the N/W-owned hedges above) a shaft's enclosure never depends
      // on a neighbouring district's output.
      if (isOpen(cells, idx, DIR.UP)) {
        for (const d of shaftColliders(cells, x, z, level)) out.push(d);
      }
    }
  }

  return out;
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
function requiredWallTop(descs, shaft) {
  const half = MAZE.CELL / 2;
  const EPS = 1e-6;
  const cap = shaft.floorY + MAZE.LEVEL_HEIGHT;
  let highest = -Infinity;
  for (const d of descs) {
    if (!d.enclosed) continue;
    // Only surfaces that actually sit inside this shaft's footprint count -
    // an enclosed descriptor belonging to a neighbouring shaft must not raise
    // this one's bar.
    if (d.cx - d.hx > shaft.cx + half - EPS || d.cx + d.hx < shaft.cx - half + EPS) continue;
    if (d.cz - d.hz > shaft.cz + half - EPS || d.cz + d.hz < shaft.cz - half + EPS) continue;
    const top = d.cy + d.hy;
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
  const half = MAZE.CELL / 2;
  const need = requiredWallTop(descs, shaft);
  const lowerBound = shaft.floorY + ENTRY_SEAL_FROM;
  const EPS = 1e-6;
  const sides = [
    { axis: 'x', at: shaft.cx - half },
    { axis: 'x', at: shaft.cx + half },
    { axis: 'z', at: shaft.cz - half },
    { axis: 'z', at: shaft.cz + half },
  ];

  for (const side of sides) {
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
        if (d.cz - d.hz > shaft.cz - half + EPS || d.cz + d.hz < shaft.cz + half - EPS) continue;
      } else {
        if (d.cz - d.hz > side.at + EPS || d.cz + d.hz < side.at - EPS) continue;
        if (d.cx - d.hx > shaft.cx - half + EPS || d.cx + d.hx < shaft.cx + half - EPS) continue;
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
    if (!covered) return false;
  }
  return true;
}
