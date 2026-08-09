/**
 * Where the unkempt growth goes on a hedge, as instance transforms.
 *
 * Pure - no THREE, no DOM - so the placement can be asserted under `node
 * --test` like everything else in this directory, and so `MazeChunks` is left
 * doing nothing but turning numbers into an `InstancedMesh`.
 *
 * ## Foliage is never a collider
 *
 * Section 2 of the spec permits props in the 0.45-5.0 m band ONLY if they are
 * non-collidable, and names foliage as the example. A sprig sits on top of a
 * five-metre hedge, squarely in the band, so if one ever reached the collider
 * descriptor path it would be a ladder over a hedge and THE ANTI-LADDER GATE
 * would be right to fail. These transforms are consumed for meshes and for
 * nothing else; `scripts/tests/maze-foliage.test.mjs` asserts no `foliage`
 * descriptor ever appears in `districtColliders`.
 *
 * ## What it is for
 *
 * The hedge is a box, and the giveaway is its perfectly straight top edge
 * running the length of a corridor. Breaking that line is worth more than any
 * amount of detail on the faces, which is why the sprigs go on the top edge
 * and the upper corners rather than being scattered evenly.
 */
import { MAZE, DIR, hash32, cellIndex, isOpen, cellToWorld } from './MazeTopology.js';
/* The one thing this module needs from the collider side: where a connector
 * breaks through the floor above, so the daylight column can stand in the hole
 * rather than beside it. `MazeShafts.js` imports only `MazeTopology.js`, so
 * this adds no cycle - and taking the bounds from it rather than re-deriving
 * them is what keeps the light and the hole from drifting apart. */
import { connectorHoleBounds } from './MazeShafts.js';

/** Sprigs per hedge segment. Cheap - one instanced draw per district. */
const SPRIGS_PER_HEDGE = 9;

/** How far a sprig may lean past the hedge's own footprint, metres. */
const SPRIG_OVERHANG = 0.22;

/**
 * Instance transforms for one district's foliage.
 *
 * @param {Array<{cx:number,cy:number,cz:number,hx:number,hy:number,hz:number,kind:string}>} descs
 *   the district's collider descriptors - only `hedge` ones grow anything.
 * @param {number} seedish anything stable per district; mixed into the hash so
 *   two districts with identical hedge layouts do not grow identical foliage.
 * @returns {Array<{x:number,y:number,z:number,ry:number,s:number}>}
 */
export function foliageTransforms(descs, seedish = 0) {
  const out = [];
  for (let i = 0; i < descs.length; i++) {
    const d = descs[i];
    if (d.kind !== 'hedge') continue;
    /* Only full-height hedges grow. The guard rails round a stairwell are
     * `hedge`-kinded too and are waist-high furniture, not shrubbery. */
    if (d.hy * 2 < MAZE.HEDGE_HEIGHT - 0.01) continue;

    const top = d.cy + d.hy;
    /* Along the hedge's LONG axis - the straight top edge is the thing being
     * broken up, so the sprigs have to run along it. */
    const alongX = d.hx > d.hz;
    const half = alongX ? d.hx : d.hz;

    for (let s = 0; s < SPRIGS_PER_HEDGE; s++) {
      const h = hash32(seedish, i, s, 0x5b7);
      const t = ((h & 0xffff) / 0x10000) * 2 - 1;              // -1..1 along
      const lean = (((h >>> 16) & 0xff) / 0xff - 0.5) * 2 * SPRIG_OVERHANG;
      const scale = 0.34 + ((h >>> 24) & 0xff) / 0xff * 0.5;
      const ry = ((h >>> 8) & 0xff) / 0xff * Math.PI;
      out.push({
        x: d.cx + (alongX ? t * half * 0.92 : lean),
        y: top - 0.16,
        z: d.cz + (alongX ? lean : t * half * 0.92),
        ry,
        s: scale,
      });
    }
  }
  return out;
}

/**
 * A stone band at the base of every hedge.
 *
 * "Five-metre hedges over weathered stone footings" - section 10. It is
 * MESH ONLY and exactly as wide as the hedge above it, which is deliberate on
 * both counts: a proud plinth would need its own colliders, and at roughly two
 * per cell that is tens of thousands of new colliders for decoration. Matching
 * the hedge's own footprint means the hedge collider already covers it and
 * nothing new is registered at all.
 *
 * @returns {Array<{x:number,y:number,z:number,hx:number,hy:number,hz:number}>}
 */
export function footingTransforms(descs) {
  const out = [];
  for (const d of descs) {
    if (d.kind !== 'hedge') continue;
    if (d.hy * 2 < MAZE.HEDGE_HEIGHT - 0.01) continue;
    const base = d.cy - d.hy;
    out.push({
      x: d.cx, y: base + FOOTING_HEIGHT / 2, z: d.cz,
      hx: d.hx * 1.02, hy: FOOTING_HEIGHT / 2, hz: d.hz * 1.02,
    });
  }
  return out;
}

/**
 * How tall the stone band is.
 *
 * Under the auto-step, so that even though it is not collidable the player
 * never sees their capsule pass through something they would have expected to
 * step onto - the visual and the collision agree about what is walkable.
 */
export const FOOTING_HEIGHT = MAZE.STEP_HEIGHT * 0.8;


/* ------------------------------------------------------------------ */
/* Hedge candles                                                       */
/* ------------------------------------------------------------------ */

/**
 * How many candles a district gets.
 *
 * Levels 0 to 2 are roofed by the floor above - that is inherent to stacking
 * four levels 9 m apart - so almost no sun reaches them and the maze read as
 * very dark. Candles are the fix the owner asked for, and they are two things
 * at once:
 *
 *  - a MESH each, emissive, instanced, costing one draw call per district.
 *    These are what you actually see, and there are many.
 *  - a LIGHT on some of them. `LightRig` renders only the nearest twelve point
 *    lights in the whole scene (RIG_BUDGET), so more than a handful per
 *    district buys nothing on screen and still costs the rig a per-frame scan.
 *    So the lights are sparse and the candles are dense.
 */
export const CANDLES_PER_DISTRICT = 70;

/** How many of those also carry a real point light. */
export const LIT_CANDLES_PER_DISTRICT = 24;

/** Candle height above the floor - chest height, on the hedge face. */
const CANDLE_Y = 1.35;

/**
 * Candle placements for one district, in world metres.
 *
 * Set against the hedge faces rather than floating mid-corridor, and derived
 * from the district's own hedge descriptors so they can never end up inside a
 * wall or out in a cell that has none.
 *
 * `lit` marks the ones that get a real light. It is the FIRST few rather than a
 * second hash, so a caller can slice instead of filter and the two lists can
 * never disagree about which candle a light belongs to.
 *
 * @returns {Array<{x:number,y:number,z:number,lit:boolean}>}
 */
export function candlePlacements(descs, seedish = 0) {
  const walls = [];
  for (const d of descs) {
    if (d.kind !== 'hedge') continue;
    if (d.hy * 2 < MAZE.HEDGE_HEIGHT - 0.01) continue;
    walls.push(d);
  }
  if (walls.length === 0) return [];

  const out = [];
  const want = Math.min(CANDLES_PER_DISTRICT, walls.length);
  for (let i = 0; i < want; i++) {
    /* Spread across the district's walls rather than clustering: stepping by a
     * hashed stride over the wall list gives an even scatter without sorting
     * or rejection sampling. */
    const h = hash32(seedish, i, 0x0c4);
    /* Stride by a prime through the wall list so the scatter stays even as
     * the count rises - at 26 they were sparse enough that a player could
     * stand in a corridor with only two lights within thirty metres, which is
     * ambient light with extra steps. */
    const w = walls[(i * 31 + (h % 7)) % walls.length];
    const base = w.cy - w.hy;
    /* Offset onto the FACE of the hedge, on the side the corridor is. A hedge
     * is thin on one axis; the candle sits just proud of that face. */
    const thinX = w.hx < w.hz;
    const push = (h & 1) ? 1 : -1;
    out.push({
      x: w.cx + (thinX ? push * (w.hx + 0.12) : ((h >>> 8 & 0xff) / 255 - 0.5) * w.hx * 1.6),
      y: base + CANDLE_Y,
      z: w.cz + (thinX ? ((h >>> 8 & 0xff) / 255 - 0.5) * w.hz * 1.6 : push * (w.hz + 0.12)),
      lit: i < LIT_CANDLES_PER_DISTRICT,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Ivy on the tower shafts                                             */
/* ------------------------------------------------------------------ */

/**
 * Sprigs per shaft wall panel.
 *
 * Section 10 asks for "ivy-clad tower shafts", and a shaft is the one place in
 * this world where the player is enclosed by stone rather than by hedge - four
 * blank panels around a stairwell, which is exactly the surface a five-metre
 * hedge does not give you and exactly where bare geometry reads as unfinished.
 */
/**
 * Strands per shaft wall panel, and leaves per strand.
 *
 * Scattering leaves uniformly over a panel does not read as ivy at any count -
 * tried at 14 and again at 44, and both look like green dice glued to a white
 * tower. Ivy climbs in connected runs from the base and thins as it goes, so
 * it is authored as strands: each roots somewhere along the bottom, wanders
 * sideways as it climbs, and stops at its own height.
 */
const IVY_STRANDS_PER_PANEL = 11;

/**
 * Metres between leaves along a strand, and the ceiling on one strand's count.
 *
 * Spacing rather than a count, because a count spreads itself over whatever
 * height the strand happens to have: 16 leaves over an 8.5 m run puts half a
 * metre of bare stone between 17 cm leaves, which is the spacing of confetti
 * and no arrangement of it reads as a plant. Ivy is a CONTINUOUS run, so what
 * has to be held constant is leaves per metre, and the count follows from how
 * far the strand actually climbed.
 *
 * At 0.16 m with leaves a little wider than that, consecutive leaves overlap
 * and the strand closes into a line.
 */
const IVY_LEAF_SPACING = 0.12;
const IVY_MAX_LEAVES_PER_STRAND = 48;

/**
 * Ivy transforms for one district's shaft walls.
 *
 * Clings to the OUTER face of each panel, spread over its height rather than
 * pooled at the base, because ivy that stops at knee height reads as a hedge
 * clipping rather than as growth up a tower. Returned in the same shape
 * `foliageTransforms` uses so both feed one instanced-sprig builder.
 *
 * MESH ONLY, like every other thing in this file - see the header. A sprig on
 * a shaft wall sits squarely in the 0.45-5.0 m band, and section 2 permits a
 * prop there only if nothing can stand on it.
 *
 * @returns {Array<{x:number,y:number,z:number,ry:number,s:number}>}
 */
export function shaftIvyTransforms(descs, seedish = 0) {
  const out = [];
  for (let i = 0; i < descs.length; i++) {
    const d = descs[i];
    if (d.kind !== 'shaftWall') continue;
    /* Which axis the panel is thin on - that is the face ivy grows on. */
    const thinX = d.hx < d.hz;
    const thin = thinX ? d.hx : d.hz;
    const along = thinX ? d.hz : d.hx;
    const base = d.cy - d.hy;
    const height = d.hy * 1.9;

    for (let st = 0; st < IVY_STRANDS_PER_PANEL; st++) {
      const sh = hash32(seedish, i, st, 0x1de);
      /* Where this strand roots along the panel, and which face it is on. */
      const root = ((sh & 0xffff) / 0x10000) * 2 - 1;
      const side = (sh & 0x10000) ? 1 : -1;
      /* How far up it got. Ivy climbs from the bottom and thins out, so a
       * strand has a length rather than the whole panel having a density -
       * that is the difference between growth and speckle. */
      const reach = 0.25 + ((sh >>> 17) & 0xff) / 0xff * 0.45;
      /* How far this strand climbs, in metres, and therefore how many leaves
       * it takes to cover that at a constant density - see IVY_LEAF_SPACING. */
      const run = reach * height;
      const leaves = Math.max(3, Math.min(IVY_MAX_LEAVES_PER_STRAND,
        Math.round(run / IVY_LEAF_SPACING)));

      for (let l = 0; l < leaves; l++) {
        const h = hash32(seedish, i * 31 + st, l, 0x9c5);
        /* Position along THIS strand, 0 at the root and 1 at its tip. Dividing
         * by a global count instead would leave short strands bunched at the
         * bottom of their own range. */
        const v = l / (leaves - 1);
        /* Wander sideways as it climbs, so the strand is a line rather than a
         * column, and spread leaves either side of that line. */
        const wander = Math.sin((v * 6.2 + (sh & 0xff) / 40)) * 0.09;
        const spread = (((h >>> 8) & 0xff) / 0xff - 0.5) * 0.16;
        const t = root + wander + spread;
        if (t < -1 || t > 1) continue;

        /* Smaller as it climbs, and never uniform - a leaf is wide and tall on
         * the wall and almost nothing through it. */
        const s = 0.12 * (1 - v * 0.4) * (0.75 + ((h >>> 16) & 0xff) / 0xff * 0.5);
        const lift = (((h >>> 24) & 0xff) / 0xff - 0.5) * 0.09;
        out.push({
          x: d.cx + (thinX ? side * (thin + 0.03) : t * along * 0.92),
          y: base + v * run + lift,
          z: d.cz + (thinX ? t * along * 0.92 : side * (thin + 0.03)),
          /* A ROLL about the wall's own normal, not a yaw about Y. Yawing a
           * leaf that has been flattened on world X swings the thin axis round
           * toward Z, and a quarter turn stands it edge-out from the very wall
           * it is meant to be lying on. Rolling about the normal cannot move
           * the thin axis at all, so the leaf stays flat on the stone and the
           * turn only varies it within the plane - which is why this one may
           * take the full circle where a yaw had to be kept to half. */
          axis: thinX ? 'x' : 'z',
          ry: ((h >>> 4) & 0xff) / 0xff * Math.PI * 2,
          s,
          /* Flattened onto the face: thin on the panel's own normal. The two
           * in-plane axes are deliberately UNEQUAL - an equal pair would be a
           * square, and a square looks identical at every roll, throwing away
           * the variation the roll above exists to provide. */
          sx: thinX ? 0.09 : s * 1.9,
          sy: s * 2.6,
          sz: thinX ? s * 1.9 : 0.09,
        });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Daylight down the shafts                                            */
/* ------------------------------------------------------------------ */

/**
 * How wide the column is.
 *
 * Bounded by the HOLE, not by the cell. The first value here was 1.9 m, chosen
 * to sit inside the 6 m cell with clear air to the shaft's wall panels - but a
 * column is only daylight if the opening above it is at least as wide as the
 * column is, and the opening is the connector's own well. The tightest one in
 * the world is a tunnel's: `tunnelExitBounds` is the bounding box of the
 * treads that break through the slab, padded by a capsule radius, and it is
 * 2.0 m across its narrow axis - so 1.0 m is the whole of the room available.
 * A stair or a lift gets the 2.8 m stair well and 0.4 m to spare.
 *
 * One constant for all three, because `MazeChunks` builds ONE instanced
 * cylinder per district and instances share a geometry; a per-column radius
 * would have to be a per-instance scale. Sizing the shared geometry to the
 * tightest opening is what makes every instance honest, and the cost is only
 * that a stair's column is narrower than its well - which is what a shaft of
 * sun through a high opening looks like anyway.
 *
 * It also lands the floor pool exactly where the spec asked: `MazeChunks`
 * draws that disc at `0.62 * WELL_LIGHT_RADIUS`, so at 1.0 m it is 1.21 m2 of
 * daylight against the deferred lighting note's "roughly 1.2 m2".
 *
 * `scripts/tests/maze-well-light.test.mjs` measures both bounds - fits inside
 * the real hole, clears the real wall descriptors - from the geometry rather
 * than from this comment.
 */
export const WELL_LIGHT_RADIUS = 1.0;

/**
 * Where a shaft of daylight falls, per district.
 *
 * Section 10 asks for "drifting pollen in god-rays", and the spec's deferred
 * lighting note asks for roughly 1.2 m² of daylight on each shaft's well
 * floor. Those are the same feature seen from two ends, so they are built as
 * one: a column standing in the shaft, and the bright patch where it lands.
 *
 * ## Why a shaft is the only place this can go
 *
 * Levels 0 to 2 are roofed by the floor above - inherent to stacking four
 * levels 9 m apart - so there is no daylight anywhere on them EXCEPT down the
 * towers, which are the one thing in this world with a hole above it. That
 * makes the column honest rather than decorative, and it makes it useful: a
 * lit tower is visible down a corridor and is the only long-range landmark a
 * player gets on a roofed level.
 *
 * ## Where it stands: the hole, not the cell
 *
 * The column is placed over `connectorHoleBounds` - the very rectangle
 * `districtColliders` punches out of level N+1's floor - and not over the
 * shaft cell's centre. Those are different places. A stair's well is pushed
 * `STAIR_WELL_OFFSET` (0.9 m) into one quadrant of its cell so the corridor
 * through that cell survives, so a cell-centred 1.9 m column spanned
 * -1.9..1.9 m under an opening spanning -0.5..2.3 m: about half its
 * cross-section stood under a metre of solid floor, and the god-rays read as
 * fog in a corridor rather than as light coming down a tower.
 *
 * Dispatching through `connectorHoleBounds` rather than through
 * `stairWellBounds` is what keeps the other two connectors honest as well. A
 * lift shares the stair's well, so it needs nothing special; a TUNNEL does
 * not - it breaks through at `tunnelExitBounds`, which is derived from the
 * treads that actually reach the slab and is nowhere near the stair well.
 * Placing every column on the stair well would have fixed the stair by
 * putting every tunnel's daylight through solid stone, and the same one call
 * that fixes the first avoids the second. That call is also the one the floor
 * itself is cut with, so the light and the hole cannot drift apart - the rule
 * `stairWellBounds`'s own comment sets out.
 *
 * Returned as plain numbers, like everything else here, and consumed as MESH
 * ONLY - a column of light must never become something to stand on.
 *
 * @param {Uint8Array} cells
 * @param {number} dx @param {number} dz @param {number} level
 * @returns {Array<{x:number, y:number, z:number, height:number}>} `x`/`z` are
 *   the centre of the opening the light falls through; `y` is the floor the
 *   column lands on; `height` is how far up it reaches.
 */
export function wellLightColumns(cells, dx, dz, level) {
  const out = [];
  const D = MAZE.DISTRICT;
  for (let lz = 0; lz < D; lz++) {
    for (let lx = 0; lx < D; lx++) {
      const x = dx * D + lx, z = dz * D + lz;
      if (!isOpen(cells, cellIndex(x, z, level), DIR.UP)) continue;
      const w = cellToWorld(x, z, level);
      const hole = connectorHoleBounds(cells, x, z, level);
      /* Up through the hole in the floor above and a little beyond, so the
       * column is cut off by that floor rather than ending in mid-air where
       * the player can see its top. */
      out.push({ x: hole.cx, y: w.y, z: hole.cz, height: MAZE.LEVEL_HEIGHT * 1.05 });
    }
  }
  return out;
}
