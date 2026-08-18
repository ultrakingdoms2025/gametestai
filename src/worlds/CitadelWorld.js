import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { sweep, blob } from '../gfx/Organic.js';
import { World } from './World.js';
import { COLLISION_LAYER } from '../physics/Physics.js';
import { genPool } from '../workers/GenPool.js';
import { terrainH, MESA_Y, MESA_R, SHOULDER, HALF } from './terrain/CitadelHeight.js';
import { venueBounds } from '../minigames/RooftopTrial.js';

/**
 * CITADEL - "Sunspire Citadel".
 *
 * A cliff-top fortress town under hard afternoon sun, built to be *climbed*
 * rather than walked. Every other world in this game is a floor plan with
 * scenery on it; this one is a vertical playground, and that single intent
 * drives every decision in the file.
 *
 * ── What "designed for climbing" actually means here ──────────────────────
 *
 * 1. **Vertical faces everywhere, and they are boxes.** The free-climb probe
 *    asks the collision world "is there a near-vertical surface in front of
 *    me", so a world that answers yes has to be made of hard-edged geometry,
 *    not smooth heightfield. Almost every structure here is an oriented box.
 *
 * 2. **Nothing is taller than the stamina allows in one run.** Climb stamina
 *    drains on the wall, so a 45 m tower with no interruption is a wall the
 *    player simply falls off. Every tall silhouette is therefore banded with
 *    ledges - string courses, balconies, roof lips - at 6-9 m intervals, which
 *    are rest points, and which is also why real fortifications look like that.
 *
 * 3. **Roofs form a connected network, and the gaps widen inward.** Both
 *    halves of that sentence used to be aspiration. The souk's spacing is now
 *    solved from a target gap per ring (`SOUK_RINGS`) rather than rolled:
 *    2.98 m mean at the outer ring rising to 6.59 m at the inner, per-ring
 *    scatter of 0.07-0.12 m, and a step up between rings that is under a
 *    sprint jump's 0.878 m apex on the outer three and over a leap's 1.109 m
 *    on the inner two. Outer rings are crossed with a sprint jump, middle
 *    rings need the leap, and the saw-toothed inner two need the leap and then
 *    a mantle. Measured, not asserted: `scripts/tests/citadel-reach.test.mjs`.
 *
 *    The one break in the network is deliberate - the processional corridor
 *    cleared at the gate bearing on every ring - and the network routes around
 *    it. Two rope-bridge spans out to the curtain wall and two short landfall
 *    spans back down into the souk are what make the citadel core and the town
 *    one rooftop network rather than two.
 *
 * 4. **Every fall has an answer.** Haystacks sit under the high traversal lines
 *    so a leap of faith is a route rather than a death, and the roll window
 *    covers everything else. They are placed with `_deckAt`, which asks the
 *    collision world - placed with `_groundAt`, which is terrain and nothing
 *    else, eight of the eleven stood inside the surface they were meant to
 *    catch a body on. Each viewpoint publishes the line it is LAUNCHED along
 *    and the hay goes downrange of that, not on the radial bearing that put the
 *    great tower's hay 12.5 m behind its own jump. The tallest fall off any
 *    deck in the world is 21.40 m against a lethal 40.0 m.
 *
 * ── Layout ────────────────────────────────────────────────────────────────
 *
 *   -Z  cliff edge and the leap-of-faith viewpoint
 *        |
 *   citadel keep + great tower (the high anchor, ~46 m)
 *        |
 *   inner ward, rope bridges between the minarets
 *        |
 *   souk - dense flat-roofed blocks, narrowing alleys
 *        |
 *   curtain wall, gatehouse, and the portal plaza just inside it
 *   +Z
 *
 * Geometry is batched aggressively: everything sharing a material is merged
 * into one mesh per district, because a town of 400 buildings would otherwise
 * be 400 draw calls. Collision is oriented boxes only - a triangle soup would
 * give the climb probe a surface normal per triangle and make ledge detection
 * chatter along every seam.
 */

/* ------------------------------------------------------------------ */
/* Module scratch - never allocate inside a loop or a frame handler.    */
/* ------------------------------------------------------------------ */

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _m1 = new THREE.Matrix4();
const _q1 = new THREE.Quaternion();
const _e1 = new THREE.Euler();
const _color = new THREE.Color();

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Signed angular difference folded into (-pi, pi]. */
const wrapPi = (v) => { const t = ((v + Math.PI) % TAU + TAU) % TAU; return t - Math.PI; };
/** Edge round applied to batched boxes, and the size below which it is skipped. */
const BEVEL = 0.075;
const BEVEL_MIN = 0.55;

/* ------------------------------------------------------------------ */
/* Layout constants shared by more than one builder                    */
/* ------------------------------------------------------------------ */
/** Curtain wall: radius of its centre line, its thickness, its height. */
const WALL_R = 118;
const WALL_T = 2.6;
const WALL_H = 9;
/** Every roof in the souk overhangs its walls by this much on all four sides. */
const SOUK_LIP = 0.7;
/** Radius of the innermost souk ring. The inner ward is a 60 m square. */
const SOUK_R0 = 34;

/**
 * THE SOUK'S DIFFICULTY GRADIENT, AUTHORED.
 *
 * -- Why this table exists -------------------------------------------------
 *
 * The file header has always claimed "the gaps widen as you get closer to the
 * citadel ... that gradient is the difficulty curve". It was not true. The old
 * generator set `count = max(8, round(tau*r / 15))`, which pins tangential
 * CENTRE spacing to 14.8-15.4 m at every ring, and then let three independent
 * random terms decide the gap that actually mattered:
 *
 *   - `w = 8 + rnd()*5` and `d = 8 + rnd()*5`, so a pair of neighbours could
 *     differ by 10 m of footprint;
 *   - `a = ... + (rnd() - 0.5) * 0.06`, which at r = 103 is +/-3.1 m of
 *     tangential slop PER BUILDING, so +/-6 m on a gap;
 *   - `rotY = a` while the building was PLACED at `a`, which rotates the
 *     footprint frame at -2a relative to the ring, so the tangentially
 *     projected width was `|w cos| + |d sin|` and swung with compass bearing.
 *
 * Measured over the built world, the result was a mean tangential deck gap of
 * 2.01 m with a standard deviation of 2.03 m, 34 pairs physically OVERLAPPING,
 * a maximum of 7.99 m, and `pearson(ring, gap) = 0.1485`. Not a gradient: noise.
 *
 * -- What replaced it ------------------------------------------------------
 *
 * Three changes, in the order they matter.
 *
 * 1. **The footprint frame is now radial.** A box at `rotY = t` has its local
 *    +X at world `(cos t, -sin t)` and its local +Z at `(sin t, cos t)`. Set
 *    `t = pi/2 - a` and local +Z lands on `(cos a, sin a)` - straight out along
 *    the radius - so `w` is the building's TANGENTIAL width and `d` is its
 *    RADIAL depth, exactly and at every bearing. Every gap in the ring becomes
 *    a quantity this file can solve for instead of a quantity it discovers.
 *
 * 2. **The angular jitter is gone** and the footprint jitter is +/-0.25 m
 *    rather than +/-2.5 m. Variety comes from height, parapets, domes, awnings
 *    and colour, none of which touch the gap. A town whose difficulty is a
 *    dice roll is not a difficulty curve however pretty the dice are.
 *
 * 3. **`w` is derived from the gap, not the gap from `w`.** For two
 *    neighbours an angular pitch `D` apart on a ring of radius `r`, with roof
 *    lips `wLip` wide tangentially and `dLip` deep radially, the closest points
 *    are the two INNER corners of the facing edges and their separation is
 *
 *        gap = 2 r sin(D/2) - wLip cos(D/2) - dLip sin(D/2)
 *
 *    which inverts to the `w` computed below. Derived, then confirmed against
 *    `footprintGap`'s SAT measurement of the assembled world - the derivation
 *    is only allowed to stand because a probe agreed with it.
 *
 * -- The gradient itself ---------------------------------------------------
 *
 * Ring 0 is innermost. The budgets are the measured ones, and the margins
 * matter: a jump has to land 0.4 m inside the target lip to count, so the
 * usable reach of each budget is its flat distance minus 0.4.
 *
 *   walk    2.607 m flat, 0.878 m apex  ->  crosses up to 2.2 m
 *   sprint  4.647 m flat, 0.878 m apex  ->  crosses up to 4.25 m
 *   leap    7.569 m flat, 1.109 m apex  ->  crosses up to 7.17 m
 *
 * `deck` is the top of the roof lip above `MESA_Y`, and it is authored as
 * carefully as the gap, because a step UP taller than the apex is a wall
 * whatever the gap is:
 *
 *   rings 6,5,4  gaps 3.0-3.85 m, steps inward 0.7 m  ->  sprint clears both
 *   rings 3,2    gaps 5.1-5.7 m, steps inward 1.0 m   ->  the leap is required
 *   rings 1,0    gaps 6.2-6.6 m, steps inward >= 1.4 m and a saw-toothed ring
 *                                                     ->  leap, then a mantle
 *
 * `sawtooth` alternates the deck height of consecutive buildings by +/- that
 * much, which makes the uphill half of every inner-ring crossing a jump into a
 * wall - a grab and a mantle - while the downhill half stays a plain landing.
 * `count` is even on those two rings so the alternation closes on itself.
 */
const SOUK_RINGS = (() => {
  const spec = [
    { count: 12, gapT: 6.60, gapR: 5.4, deck: 14.2, sawtooth: 0.80, depth: 7.0 },
    { count: 18, gapT: 6.20, gapR: 4.8, deck: 12.0, sawtooth: 0.60, depth: 7.0 },
    { count: 22, gapT: 5.70, gapR: 3.9, deck: 10.0, sawtooth: 0, depth: 7.0 },
    { count: 28, gapT: 5.10, gapR: 3.4, deck: 9.0, sawtooth: 0, depth: 7.0 },
    { count: 34, gapT: 3.85, gapR: 2.9, deck: 8.0, sawtooth: 0, depth: 7.0 },
    { count: 40, gapT: 3.50, gapR: 2.4, deck: 7.3, sawtooth: 0, depth: 7.0 },
    { count: 46, gapT: 3.00, gapR: 0, deck: 6.6, sawtooth: 0, depth: 7.0 },
  ];
  let r = SOUK_R0;
  for (let k = 0; k < spec.length; k++) {
    const s = spec[k];
    s.ring = k;
    s.r = r;
    const dLip = s.depth + SOUK_LIP;
    const half = Math.PI / s.count;              // half the angular pitch
    s.w = (2 * r * Math.sin(half) - dLip * Math.sin(half) - s.gapT) / Math.cos(half) - SOUK_LIP;
    const next = spec[k + 1];
    if (next) r += s.gapR + (dLip + next.depth + SOUK_LIP) * 0.5;
  }
  return spec.map((e) => Object.freeze(e));
})();

/** Outer face of the outermost roof lip. Everything past this is the pomerium. */
const SOUK_OUTER_FACE = SOUK_RINGS[SOUK_RINGS.length - 1].r
  + (SOUK_RINGS[SOUK_RINGS.length - 1].depth + SOUK_LIP) * 0.5;
/**
 * The lane the haystacks under the rampart traversal line stand in.
 *
 * Halfway between the outer souk face and the inside of the curtain wall. It
 * used to be a literal 104, which the re-authored souk builds ON TOP of - the
 * hay would have been placed on a roof, which `_deckAt` would happily have
 * agreed with and no assertion in the world would have caught it.
 */
const RAMPART_HAY_R = (SOUK_OUTER_FACE + (WALL_R - WALL_T * 0.5)) * 0.5;

/**
 * The four houses whose interiors are built, keyed by something that survives
 * a layout change.
 *
 * They used to be keyed `${ring}:${i}` - `1:2`, `2:8`, `3:17`, `5:24` - which
 * is an index into a generated array. Change `count`, or change anything
 * upstream of the shared `rnd` stream, and `i` names a different building or
 * no building at all; `_nudgeClear`'s docstring records that this has already
 * happened TWICE, both times leaving NPCs standing inside walls. A bearing is
 * stable under every one of those changes: the nearest surviving building to a
 * compass direction is the same house whatever the ring count is.
 *
 * The bearings are the ones the old indices resolved to, so the four interiors
 * stay roughly where they have always been. None of them is near the
 * processional corridor at +Z (90 deg), which is cleared at every ring.
 */
const ENTERABLE_SITES = Object.freeze([
  Object.freeze({ ring: 1, bearing: 56 * DEG, label: 'Spice Merchants House', flipDoor: true }),
  Object.freeze({ ring: 2, bearing: 151 * DEG, label: 'Scribes Courtyard House', flipDoor: false }),
  Object.freeze({ ring: 3, bearing: 257 * DEG, label: 'Carpet Loom House', flipDoor: false }),
  Object.freeze({ ring: 5, bearing: 305 * DEG, label: 'Dyers Roof House', flipDoor: false }),
]);

/** Half-width of the processional corridor, in radians. Cleared at every ring. */
const CORRIDOR_HALF = 0.26;
/** Bearing of the gate, and so of the corridor. +Z. */
const GATE_BEARING = Math.PI * 0.5;

/* `terrainH` and the mesa constants live in `terrain/CitadelHeight.js` (imported
 * at the top of this file) so the generation worker can sample this ground
 * without importing `three` and the rest of this world. It is still the single
 * source of truth for the shape of the terrain - the visible heightfield, the
 * collision that backs it and every prop placement all read that one function.
 *
 * That mattered enough to be worth the indirection: this slope was previously
 * three separate approximations of itself, they disagreed, and where the
 * collision sat lower than the mesh the player walked *underneath* the visible
 * world across 7% of sampled positions, by as much as 13 m. */

/**
 * Limewash and mudbrick. Sampled from sun-bleached North African towns, where
 * the range is narrow in hue and wide in lightness - which is exactly what
 * stops a procedural town looking either monotone or like a paint chart.
 */
const WASH = [
  0xe8dcc0, 0xdfd0ae, 0xd6c49e, 0xcbb68d, 0xe3d2b2,
  0xd8c8a8, 0xc9b489, 0xecdfc4, 0xd2bd97, 0xdcccA6,
  0xc6ae86, 0xe6d8bb, 0xd9c9a2, 0xcfbb92,
];

/**
 * Metres of world covered by one texture tile, per material family.
 *
 * These are the values each surface was *authored* for - the shared library
 * publishes the same numbers as `userData.tileMeters` - and re-projecting the
 * batched UVs against them is what finally makes the maps visible at the right
 * size. Ashlar courses come out a hand's width tall on a wall and stay that
 * size on a cliff step forty times bigger.
 *
 * The one deliberate departure is plaster, tiled tighter than the library's
 * default: a souk house is rendered mud, and at 3 m the render reads as a
 * poured concrete panel.
 */
const TILE_METRES = (key) => {
  switch (key.split(':')[0]) {
    case 'stone.castle': return 2.4;
    case 'plaster.wall': return 1.8;
    case 'stone.cobble': return 2.0;
    case 'dirt.ground': return 5.0;
    case 'roof.tile': return 1.6;
    case 'thatch.roof': return 1.4;
    case 'wood.beam': return 1.2;
    case 'wood.plank': return 1.5;
    // Banners and awnings carry a printed pattern rather than a material
    // grain; re-projecting them would slide the pattern across the cloth.
    case 'fabric.banner': return 0;
    default: return 0;
  }
};

/** Weathered sandstone, for the cliff the mesa stands on. */
const CLIFF = [0xc0ad86, 0xb6a37c, 0xcab791, 0xac9a73, 0xc4b088, 0xbaa87f];

/** One of `list`, with a small per-pick lightness jitter so no two repeat exactly. */
function pick(rnd, list) {
  const base = list[(rnd() * list.length) | 0];
  const f = 0.9 + rnd() * 0.2;
  const r = Math.min(255, ((base >> 16) & 255) * f) | 0;
  const g = Math.min(255, ((base >> 8) & 255) * f) | 0;
  const b = Math.min(255, (base & 255) * f) | 0;
  return (r << 16) | (g << 8) | b;
}

/** Deterministic PRNG - a world has to regenerate identically every session. */
function mulberry32(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Geometry accumulator.
 *
 * Collects transformed geometries per material key and merges each bucket into
 * a single mesh. Worlds in this project live or die on draw-call count; the
 * souk alone is ~1400 boxes and would be unshippable one mesh at a time.
 */
class Batch {
  /**
   * @param {{ao?:number, sky?:number, grime?:number, span?:number}} [shade]
   *   Baked vertex shading applied to every geometry added to this batch.
   *   - `ao`     how dark the foot of a surface goes (0..1)
   *   - `sky`    how much a downward-facing surface loses relative to an
   *              upward-facing one - a one-line hemispheric occlusion term
   *   - `grime`  warm-to-cool shift applied with the AO, so the dark end is
   *              dirt rather than simply less light
   *   - `span`   metres over which the AO fades out from the foot
   */
  /**
   * @param {{ao?:number, sky?:number, grime?:number, span?:number}} [shade]
   * @param {(key:string)=>number} [tiles] metres one texture tile covers, per
   *   material key. Returning 0 leaves the geometry's own UVs alone.
   */
  constructor(shade = null, tiles = null) {
    /** @type {Map<string, THREE.BufferGeometry[]>} */
    this.buckets = new Map();
    this._owned = [];
    this.shade = shade;
    this.tiles = tiles;
  }

  /**
   * @param {string} key material key
   * @param {THREE.BufferGeometry} geo consumed - do not reuse after this
   * @param {THREE.Matrix4} matrix world transform
   * @param {number} [tint] optional per-vertex tint
   */
  add(key, geo, matrix, tint = null) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    // Strip anything the merge cannot reconcile: mergeGeometries returns null
    // if two inputs disagree about which attributes exist.
    for (const k of Object.keys(g.attributes)) {
      if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    }
    g.applyMatrix4(matrix);

    /* Re-project the UVs into world space.
     *
     * ── Why every surface in this world was smooth ────────────────────────
     *
     * The materials here have always carried a full PBR set - albedo, normal,
     * roughness, AO. They just could not be seen. A BoxGeometry's UVs run 0..1
     * across each face whatever the face measures, and the material tiles at
     * repeat 1, so a single tile of stone was stretched across an entire 20 m
     * wall while the same tile was crammed onto a 20 cm sill. The detail was
     * present at every scale except the one that would have made it visible,
     * and the town read as clean flat plaster.
     *
     * A shared material cannot fix this with `repeat`, because these boxes are
     * merged into one mesh and every one of them is a different size. The scale
     * has to live in the geometry, so the UVs are recomputed from world
     * position: planar projection onto whichever axis each face points along,
     * divided by the metres one tile is authored for. Texel density then comes
     * out identical on a cliff step and a window sill, which is the whole
     * point.
     */
    const tile = this.tiles?.(key) ?? 0;
    if (tile > 0) {
      const posA = g.attributes.position;
      const nrmA = g.attributes.normal;
      const n = posA.count;
      const uv = new Float32Array(n * 2);
      const inv = 1 / tile;
      for (let i = 0; i < n; i++) {
        const x = posA.getX(i);
        const y = posA.getY(i);
        const z = posA.getZ(i);
        const nx = nrmA ? Math.abs(nrmA.getX(i)) : 0;
        const ny = nrmA ? Math.abs(nrmA.getY(i)) : 1;
        const nz = nrmA ? Math.abs(nrmA.getZ(i)) : 0;
        let u; let v;
        if (ny >= nx && ny >= nz) { u = x; v = z; }        // floors and roofs
        else if (nx >= nz) { u = z; v = y; }               // walls facing X
        else { u = x; v = y; }                             // walls facing Z
        uv[i * 2] = u * inv;
        uv[i * 2 + 1] = v * inv;
      }
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    }
    /* Always written, white when no tint was asked for.
     *
     * Two reasons it cannot be conditional. `mergeGeometries` returns null the
     * moment two inputs disagree about which attributes exist, so one untinted
     * box would silently drop its whole district. And the materials here run
     * with `vertexColors` on, where a *missing* colour attribute reads as zero
     * rather than as one - the geometry would come out black rather than
     * untinted. */
    _color.set(tint === null ? 0xffffff : tint);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);

    /* Baked vertex shading.
     *
     * Everything in this world is a box, and a box lit by one sun is four flat
     * rectangles - the town reads as cardboard no matter how good the material
     * is. Two cheap per-vertex terms fix that for the whole world at once:
     *
     *   AO    darkens the foot of every surface, so buildings sit *in* the
     *         ground instead of resting on top of it, and alleys gain the
     *         contact shadow that no dynamic light will ever draw for 1400
     *         boxes.
     *   Sky   darkens downward-facing faces against upward-facing ones. It is
     *         a one-line hemispheric occlusion term, and it is what separates
     *         the underside of a lintel from its top.
     *
     * Both are free at runtime - they are just the colour attribute that had to
     * be written anyway - and they survive the merge into a single mesh, which
     * a light never could. */
    const sh = this.shade;
    if (!sh) {
      for (let i = 0; i < n; i++) {
        col[i * 3] = _color.r;
        col[i * 3 + 1] = _color.g;
        col[i * 3 + 2] = _color.b;
      }
    } else {
      const posA = g.attributes.position;
      const nrmA = g.attributes.normal;
      const ao = sh.ao ?? 0;
      const sky = sh.sky ?? 0;
      const grime = sh.grime ?? 0;
      const span = sh.span ?? 2.2;
      // Foot of *this* piece, in world space - so a roof lip is shaded from its
      // own underside, not from the ground 20 m below it.
      let minY = Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < n; i++) {
        const y = posA.getY(i);
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      /* Never run the gradient over more than the piece is tall.
       *
       * The span is chosen for walls, and a wall is metres high, so the darkest
       * part of the ramp lands at its foot and the rest is clean. Applied
       * unchanged to something thin - a palm frond is 9 cm thick - the whole
       * piece sits inside the first 4% of the ramp and comes out uniformly at
       * the *bottom* of it. The palms rendered as black silhouettes for exactly
       * this reason. Clamping the span to the piece's own height gives thin work
       * a dark underside and a lit top, which is what was wanted from it. */
      const s = Math.min(span, Math.max(maxY - minY, 0.02));

      for (let i = 0; i < n; i++) {
        const t = clamp01((posA.getY(i) - minY) / s);
        // smoothstep, so the gradient has no visible band where it ends
        const rise = t * t * (3 - 2 * t);
        let f = 1 - ao * (1 - rise);
        if (nrmA) {
          const ny = nrmA.getY(i);
          f *= 1 - sky * (1 - (ny * 0.5 + 0.5));
        }
        // Dirt is cooler as well as darker; scaling blue least would *warm* the
        // shadows, which is the opposite of how a shaded wall photographs.
        const d = (1 - f) * grime;
        col[i * 3] = _color.r * f * (1 - d * 0.15);
        col[i * 3 + 1] = _color.g * f * (1 - d * 0.06);
        col[i * 3 + 2] = _color.b * f;
      }
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    let list = this.buckets.get(key);
    if (!list) this.buckets.set(key, (list = []));
    list.push(g);
  }

  /**
   * Convenience for the overwhelmingly common case: an axis-aligned box.
   *
   * Bevelled, not square. A hard 90-degree edge returns exactly one shade to
   * the camera, so a town built from plain boxes has no edges in it at all -
   * just flat panels meeting at invisible seams, which is what "blocky" really
   * describes. A few centimetres of round on every edge gives each one a
   * highlight on the sunward side and a dark line away from it, and every
   * silhouette in the world stops being a cut-out.
   *
   * Only the pieces big enough for it to read.
   *
   * A bevelled box costs 108 triangles against a plain one's 12, and this world
   * emits something like twelve thousand of them - the window trim alone is
   * nine thousand. Bevelling all of it cost three million triangles and half the
   * frame rate to round the edges of sills a few centimetres across, which
   * nobody can see. Above the threshold it is walls, roofs, towers and cliff
   * steps: the silhouettes the eye actually reads. Below it, trim stays square
   * and free.
   *
   * The radius is clamped against the smallest dimension regardless, because a
   * bevel wider than the piece it is rounding turns the piece inside out.
   */
  box(key, w, h, d, x, y, z, rotY = 0, tint = null) {
    _e1.set(0, rotY, 0);
    _q1.setFromEuler(_e1);
    _v1.set(x, y, z);
    _v2.set(1, 1, 1);
    _m1.compose(_v1, _q1, _v2);
    const min = Math.min(w, h, d);
    const r = Math.min(BEVEL, w * 0.22, h * 0.22, d * 0.22);
    const geo = min >= BEVEL_MIN && r > 0.02
      ? new RoundedBoxGeometry(w, h, d, 1, r)
      : new THREE.BoxGeometry(w, h, d);
    this.add(key, geo, _m1, tint);
  }

  /**
   * Merge every bucket into the group.
   * @param {THREE.Group} group
   * @param {(key:string) => THREE.Material} resolve
   * @param {string} name
   * @param {{cast?:boolean, recv?:boolean}} [opts]
   */
  flush(group, resolve, name, { cast = true, recv = true } = {}) {
    const out = [];
    for (const [key, list] of this.buckets) {
      if (!list.length) continue;
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged) {
        console.warn(`[CitadelWorld] merge failed for "${key}" in ${name}`);
        continue;
      }
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, resolve(key));
      mesh.name = `${name}:${key}`;
      mesh.castShadow = cast;
      mesh.receiveShadow = recv;
      group.add(mesh);
      out.push(mesh);
      this._owned.push(merged);
    }
    this.buckets.clear();
    return out;
  }

  dispose() {
    for (const g of this._owned) g.dispose();
    this._owned.length = 0;
  }
}

function prepDynamicGeo(geo, key, tint = 0xffffff) {
  const tile = TILE_METRES(key) || 0;
  if (tile > 0) {
    const posA = geo.attributes.position;
    const nrmA = geo.attributes.normal;
    const uv = new Float32Array(posA.count * 2);
    const inv = 1 / tile;
    for (let i = 0; i < posA.count; i++) {
      const x = posA.getX(i);
      const y = posA.getY(i);
      const z = posA.getZ(i);
      const nx = nrmA ? Math.abs(nrmA.getX(i)) : 0;
      const ny = nrmA ? Math.abs(nrmA.getY(i)) : 1;
      const nz = nrmA ? Math.abs(nrmA.getZ(i)) : 0;
      let u; let v;
      if (ny >= nx && ny >= nz) { u = x; v = z; }
      else if (nx >= nz) { u = z; v = y; }
      else { u = x; v = y; }
      uv[i * 2] = u * inv;
      uv[i * 2 + 1] = v * inv;
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  _color.set(tint);
  const col = new Float32Array(geo.attributes.position.count * 3);
  for (let i = 0; i < geo.attributes.position.count; i++) {
    col[i * 3] = _color.r;
    col[i * 3 + 1] = _color.g;
    col[i * 3 + 2] = _color.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

export class CitadelWorld extends World {
  static id = 'citadel';
  static displayName = 'Sunspire Citadel';

  constructor(ctx) {
    super(ctx);
    this.rnd = mulberry32(0x5175ce);

    /** Roof platforms, so relics and rope bridges can be placed on real surfaces. */
    this._roofs = [];
    /** Tower tops: the anchors for rope bridges and the best relic sites. */
    this._towers = [];
    /** Haystack positions - the landing sites that make a leap of faith survivable. */
    this.haystacks = [];
    /**
     * Viewpoints: high, isolated, and worth the climb.
     *
     * Each entry carries more than a label, and every field has a consumer:
     *   `id`               stable key for save data and the map reveal
     *   `x, y, z`, `r`     the platform, and how big it is
     *   `launch`           the exact point a leap of faith leaves from
     *   `bearing`          the direction it leaves on - NOT the radial bearing
     *   `hay`              the haystack that answers it, resolved during the
     *                      build to `{x, y, z, r}` on a real surface
     */
    this.viewpoints = [];
    /** Rope-bridge spans, published so nothing has to re-derive the generator. */
    this.ropeBridges = [];
    /** Trial venues; see `_publishVenues`. */
    this.minigameVenues = [];

    this._owned = [];
    this._time = 0;
    this._banners = [];

    this._configureEnvironment();
  }

  /* ================================================================== */
  /* Environment                                                         */
  /* ================================================================== */

  _configureEnvironment() {
    const env = this.environment;
    // Late afternoon, raking hard across the stone. A low sun is what gives a
    // climbing world its readability: every ledge casts a line.
    env.background = new THREE.Color(0x9fb8d4);
    env.fogColor = new THREE.Color(0xc9c0a8);
    env.fogNear = 90;
    env.fogFar = 520;
    env.exposure = 1.0;
    /* Shadow colour is the whole difficulty of a desert scene.
     *
     * The first pass used a cool blue-grey ambient, which is what daylight
     * physically is - and over red-brown ground it rendered every shadow
     * *purple*. Real sun-baked stone bounces a great deal of warm light back
     * into its own shade, so the fill here is warm and the sky term carries the
     * cool. Shadows land brown rather than violet, and the town stops looking
     * like it is lit through a bruise. */
    env.ambientColor = new THREE.Color(0xa8977f);
    env.ambientIntensity = 0.7;
    env.skyColor = new THREE.Color(0xa8c6e6);
    env.groundColor = new THREE.Color(0xc9a173);   // hot sand bouncing upward
    env.hemiIntensity = 1.15;
    env.sunColor = new THREE.Color(0xffddA6);
    env.sunIntensity = 5.9;
    env.sunDirection = new THREE.Vector3(0.55, 0.42, 0.72).normalize();
    env.envMapIntensity = 1.0;
    env.bloom = { strength: 0.42, radius: 0.5, threshold: 0.92 };
    env.envMap = this.materials?.getEnvMap?.('daylight') ?? undefined;
  }

  /* ================================================================== */
  /* Build                                                               */
  /* ================================================================== */

  async build(onProgress) {
    const report = onProgress ?? (() => {});

    await report(0.02, 'Hanging the sky');
    this._buildSky();

    await report(0.06, 'Raising the mesa');
    await this._buildTerrain();

    await report(0.2, 'Laying the curtain wall');
    this._buildCurtainWall();

    await report(0.4, 'Building the souk');
    this._buildSouk();

    await report(0.62, 'Raising the citadel');
    this._buildCitadel();

    await report(0.76, 'Stringing the rope bridges');
    this._buildRopeBridges();

    await report(0.86, 'Scattering the hay');
    this._buildDressing();

    await report(0.94, 'Opening the gate');
    this._fillSpawns();

    this.group.matrixAutoUpdate = false;
    this.group.updateMatrixWorld(true);
    this.group.visible = this.active;
    await report(1, 'Citadel ready');
  }

  /**
   * A shared-library material, re-tinted for this world.
   *
   * Two things are going on and both are necessary.
   *
   * The library's stone is a cold northern grey, which is right for a keep in
   * the rain and wrong for a citadel baking on a mesa - dropped in unchanged
   * the whole town photographs blue. Each key therefore gets a warm base
   * colour, which costs nothing because a tint is a uniform.
   *
   * And `vertexColors` has to be switched on, or the per-building variation
   * every `Batch.box` call writes is silently discarded: the attribute is in
   * the geometry, the shader never reads it, and four hundred houses come out
   * identical. That was the first version of this world.
   *
   * Cloning is what makes both possible without touching the shared instance
   * the other three worlds are drawn with. Clones share texture storage, so the
   * only real cost is one extra shader program per key.
   */
  /**
   * @param {string} key
   * @param {{vertexColors?:boolean}} [opts] pass `vertexColors: false` for
   *   geometry that carries no colour attribute - notably the instanced trees.
   *   A material with `vertexColors` on and nothing to read renders black,
   *   which is the same trap the batched geometry hit early on.
   */
  _mat(key, opts = {}) {
    const vc = opts.vertexColors !== false;
    this._matCache ??= new Map();
    const cacheKey = vc ? key : `${key}|novc`;
    const hit = this._matCache.get(cacheKey);
    if (hit) return hit;

    const base = this.materials.get(key);
    const m = base.clone();
    m.name = `citadel.${key}`;
    m.vertexColors = vc;
    // Sun-bleached limestone and mudbrick, per surface family.
    /* These multiply the per-box vertex colour, so they have to stay near white.
     *
     * Both ends of this were authored as if they were the only one: `Batch.box`
     * callers pass the actual colour they want the piece to be, and these were
     * written as colours too. Two mid-tones multiplied give a third much darker
     * than either - wood.beam at 0xb9946a against a 0x8a6a45 trunk resolved to
     * 0x3e2712, which is why the palms and every beam in the world came out
     * nearly black. Their job is a warm shift, not a colour. */
    const TINT = {
      'stone.castle': 0xf4ecd8,
      'plaster.wall': 0xf6ecd6,
      'stone.cobble': 0xe8ddc2,
      'wood.beam': 0xf0e2cc,
      'wood.plank': 0xf2e4cc,
      'roof.tile': 0xeae2d0,
      'thatch.roof': 0xffe9a8,
      'fabric.banner': 0xffffff,
      'dirt.ground': 0xe0cda3,
      // Date palm, not meadow: the library's grass is a temperate green and a
      // desert frond is grey-olive. Same material, one tint apart.
      'grass.field': 0xdce8c0,
    };
    const t = TINT[key.split(':')[0]];
    if (t !== undefined) m.color = new THREE.Color(t);
    this._matCache.set(cacheKey, m);
    this._owned.push(m);
    return m;
  }

  /* ------------------------------------------------------------------ */
  /* Sky                                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Gradient dome.
   *
   * `environment.background` alone is a single flat colour, which reads as a
   * void behind a skyline rather than as air - and this world is looked *out*
   * from more than any other, because half of it is spent on a rooftop. A dome
   * costs one draw call and gives the horizon a haze band for the town to sit
   * against.
   *
   * Unlit, unfogged and drawn behind everything: it is a backdrop, not a
   * surface, and it must never receive the sun or it will band.
   */
  _buildSky() {
    /* Painted equirectangular, not a 1-D ramp.
     *
     * A vertical gradient is the same in every direction, which means the sky
     * has no *place* in it: turn on the spot and nothing changes, and the top
     * third of a world played on rooftops is dead pixels. A sphere's UVs are
     * already equirectangular, so a 2-D canvas costs exactly the same one draw
     * call and buys a sun, its glow, and cloud banding that gives the eye
     * something to measure the horizon against. */
    const W = 1024;
    const H = 512;
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const c = cv.getContext('2d');

    const grd = c.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0.0, '#2e63ab');   // zenith
    grd.addColorStop(0.34, '#6fa0cf');
    grd.addColorStop(0.60, '#a8c4d8');
    grd.addColorStop(0.76, '#dbcfb2');  // haze
    grd.addColorStop(1.0, '#e8d6b0');   // dust at the horizon
    c.fillStyle = grd;
    c.fillRect(0, 0, W, H);

    /* The sun, placed where the light actually comes from.
     *
     * `sunDirection` is authored once in `_configureEnvironment`; deriving the
     * disc from it means the glow in the sky and the shadows on the ground can
     * never disagree, which is the sort of mismatch that reads as "wrong"
     * without a player being able to say why. */
    const sd = this.environment.sunDirection;
    const su = ((Math.atan2(-sd.x, -sd.z) / TAU) + 0.75) % 1;
    const sv = clamp01(0.5 - Math.asin(clamp01(sd.y)) / Math.PI);
    const sx = su * W;
    const sy = sv * H;
    // Wrapped: a glow near the seam has to be painted on both sides of it.
    for (const ox of [-W, 0, W]) {
      const glow = c.createRadialGradient(sx + ox, sy, 0, sx + ox, sy, W * 0.30);
      glow.addColorStop(0.00, 'rgba(255,247,225,0.95)');
      glow.addColorStop(0.06, 'rgba(255,236,190,0.55)');
      glow.addColorStop(0.22, 'rgba(255,224,170,0.20)');
      glow.addColorStop(1.00, 'rgba(255,220,165,0)');
      c.fillStyle = glow;
      c.fillRect(sx + ox - W * 0.3, sy - W * 0.3, W * 0.6, W * 0.6);
      const disc = c.createRadialGradient(sx + ox, sy, 0, sx + ox, sy, W * 0.017);
      disc.addColorStop(0, 'rgba(255,253,246,1)');
      disc.addColorStop(1, 'rgba(255,246,222,0)');
      c.fillStyle = disc;
      c.fillRect(sx + ox - W * 0.02, sy - W * 0.02, W * 0.04, W * 0.04);
    }

    /* Cloud banding.
     *
     * Stretched ellipses, squashed harder the nearer the horizon so they
     * foreshorten the way real cloud decks do, and drawn from the world's own
     * PRNG so the sky is identical every session like everything else here. */
    const rnd = this.rnd;
    c.globalCompositeOperation = 'source-over';
    /* A deck between roughly 40 degrees of elevation and the horizon.
     *
     * The band matters as much as the clouds do. On an equirectangular map the
     * rows near v = 0 are the *pole*, where the whole width of the canvas
     * collapses to a point - a cloud painted up there wraps into a hard streak
     * across the zenith, which is exactly what the first attempt produced. Held
     * to the middle of the map it stays a cloud, and dividing the horizontal
     * radius by sin(pi t) undoes what is left of the compression so they read as
     * round overhead and foreshortened toward the horizon, like a real deck. */
    /* Sparse, and spread over a wide band.
     *
     * Once the gradients actually painted, the first honest render was solid
     * overcast: 120 clouds inside a 0.22-wide band overlap into one continuous
     * ring around the sky, which reads as a lid rather than as weather. Fewer,
     * smaller, fainter, and spread nearly twice as far vertically leaves the
     * gaps that make the rest of them look like individual clouds. */
    for (let i = 0; i < 30; i++) {
      // Biased toward the top of the band, not the bottom: an exponent below 1
      // pushes the distribution *up* the range, which piled every cloud into the
      // horizon fade below and made the deck invisible.
      const t = 0.20 + Math.pow(rnd(), 1.5) * 0.26;
      const y = t * H;
      const x = rnd() * W;
      const stretch = 1 / Math.max(0.55, Math.sin(Math.PI * t));
      const rx = (20 + rnd() * 54) * stretch;
      const ry = rx * (0.15 + rnd() * 0.12) / stretch;
      // Faded out near the horizon so the deck meets the haze instead of
      // stopping at a line, but strong enough overhead to actually be weather.
      const a = (0.16 + rnd() * 0.26) * (1 - clamp01((t - 0.38) / 0.08));
      if (a <= 0.005) continue;
      /* Shadowed base first, lit body offset slightly above it.
       *
       * A cloud painted as one soft blob is a smudge; what makes it read as a
       * solid object with weight is a darker underside under a top that catches
       * the sun. Two passes, and the offset between them is the whole trick.
       *
       * Each gradient is built *inside* the transform it is painted under. A
       * canvas gradient lives in user space at fill time, so one created in page
       * coordinates and then filled after `translate`/`scale` has its centre
       * dragged somewhere else entirely and the shape comes out filled with the
       * transparent tail - which is why the first two attempts at this painted a
       * sky with no clouds in it at all. */
      const puff = (cx, cy, stops) => {
        for (const ox of [-W, 0, W]) {
          c.save();
          c.translate(cx + ox, cy);
          c.scale(1, ry / rx);
          const g2 = c.createRadialGradient(0, 0, 0, 0, 0, rx);
          for (const [at, col] of stops) g2.addColorStop(at, col);
          c.fillStyle = g2;
          c.beginPath();
          c.arc(0, 0, rx, 0, TAU);
          c.fill();
          c.restore();
        }
      };

      puff(x, y + ry * 0.55, [
        [0.0, `rgba(146,154,170,${a * 0.5})`],
        [0.6, `rgba(160,168,182,${a * 0.2})`],
        [1.0, 'rgba(160,168,182,0)'],
      ]);
      puff(x, y - ry * 0.35, [
        [0.00, `rgba(255,254,251,${a})`],
        [0.42, `rgba(251,247,240,${a * 0.72})`],
        [0.78, `rgba(246,241,232,${a * 0.26})`],
        [1.00, 'rgba(244,238,228,0)'],
      ]);
    }

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    tex.needsUpdate = true;

    // More segments than a plain ramp needed: the sun disc is a small feature
    // on a big sphere and a coarse mesh gives it visibly polygonal edges.
    const geo = new THREE.SphereGeometry(900, 48, 32);
    const mat = new THREE.MeshBasicMaterial({
      map: tex, side: THREE.BackSide, fog: false, depthWrite: false,
    });
    const dome = new THREE.Mesh(geo, mat);
    dome.name = 'citadel:sky';
    dome.frustumCulled = false;
    dome.renderOrder = -100;
    dome.castShadow = false;
    dome.receiveShadow = false;
    this.group.add(dome);
    this._owned.push(geo, mat, tex);

    // With a dome in place the clear colour only shows through the horizon
    // haze, so match it rather than fighting it.
    this.environment.background = null;
  }

  /* ------------------------------------------------------------------ */
  /* Terrain                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * The mesa.
   *
   * A flat top with a hard rim, not a smooth hill - the rim *is* the cliff the
   * eagle launches from and the leap of faith drops down. Built as a
   * heightfield mesh for looks and a ring of oriented boxes for collision,
   * because a triangle-soup cliff would give the climb probe a different normal
   * on every triangle and make the grip chatter all the way up.
   */
  async _buildTerrain() {
    const seg = 96;
    const rnd = this.rnd;

    /* Sampled on a worker, as an explicit grid rather than a `PlaneGeometry`.
     *
     * `PlaneGeometry` splits each quad along the 01->10 diagonal; the collision
     * heightfield below interpolates along 00->11. Those two describe subtly
     * different surfaces, and this world exists in its current form precisely
     * because three different approximations of one slope were allowed to
     * disagree - the player ended up walking *underneath* the visible ground
     * over 7% of the map. Generating the grid from the shared height field means
     * the mesh and the collider are the same triangles, not two descriptions of
     * the same idea.
     *
     * The UVs the job produces are `PlaneGeometry`'s, so the ground material
     * tiles exactly as it did. */
    const N = seg + 1;
    const stepXZ = (HALF * 2) / seg;
    const terrain = await genPool.run('terrain', {
      field: 'citadel',
      originX: -HALF,
      originZ: -HALF,
      size: HALF * 2,
      seg,
      uv: 'unit',
      normals: true,
    });
    const heights = terrain.heights;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(terrain.positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(terrain.uvs, 2));
    geo.setAttribute('normal', new THREE.BufferAttribute(terrain.normals, 3));
    geo.setIndex(new THREE.BufferAttribute(terrain.indices, 1));
    geo.computeBoundingSphere();
    this._owned.push(geo);

    // Its own material, not a `_mat` clone: the heightfield carries no colour
    // attribute, and a vertexColors material without one renders black.
    const groundMat = this.materials.get('dirt.ground:60').clone();
    groundMat.name = 'citadel.terrain';
    groundMat.color = new THREE.Color(0xe3d0a6);
    this._owned.push(groundMat);
    const ground = new THREE.Mesh(geo, groundMat);
    ground.name = 'citadel:terrain';
    ground.receiveShadow = true;
    ground.castShadow = false;
    this.group.add(ground);

    /* ---- collision that can never sit below the mesh ------------------- *
     *
     * The rule for every collider below: its top is the height of the *highest*
     * point of the mesh it covers. Then the player is always standing on or a
     * little above what they can see, and never inside or underneath it. A
     * collider that splits the difference looks better on paper and puts the
     * camera under the world at the top of the slope.
     *
     * The plateau used to be a single square slab of half-extent MESA_R + 4.
     * The mesa is a *circle* of radius MESA_R, so the slab's corners projected
     * invisible floor out to r = 192 at full mesa height, while the mesh there
     * had already fallen to the desert - and the reverse gap, mesh above
     * collision, opened all the way round the shoulder. */
    /* The mesa top and its shoulder, as the same heightfield the mesh draws.
     *
     * This replaces 40 pie-slice slabs plus 768 concentric ring boxes. The rings
     * were a staircase: each was pinned to the height of its inner edge - the
     * highest ground it spanned - which is the safe direction to round in, but
     * across a 14 m fall in 16 rings it left risers of nearly 0.9 m all the way
     * down the slope. Sharing the mesh's samples removes both the staircase and
     * the 808 colliders, and makes "collision can never sit below the mesh" true
     * by construction rather than by rounding upward.
     *
     * The cliff ring, the dunes and every structure keep their box colliders:
     * boxes give the climb probe one consistent normal per face, which is what
     * stops grip chattering on the way up. */
    this.track(
      this.physics.addHeightfield({
        heights,
        nx: N,
        nz: N,
        originX: -HALF,
        originZ: -HALF,
        stepX: stepXZ,
        stepZ: stepXZ,
      })
    );

    /* The cliff ring: boxes stepped down the shoulder. Also the world's biggest
     * climbable face - the whole point of putting the town on a mesa. */
    // Long span: a cliff step is metres tall, so the gradient has to run the
    // whole height or it reads as a painted stripe near the base.
    const B = new Batch({ ao: 0.42, sky: 0.3, grime: 0.5, span: 9 }, TILE_METRES);
    const steps = 7;
    for (let s = 0; s < steps; s++) {
      // Read from the shared height function, so the visible rock and the
      // collision rings underneath it step down together instead of each
      // following its own curve.
      const rIn = MESA_R + (s / steps) * SHOULDER;
      const rOut = MESA_R + ((s + 1) / steps) * SHOULDER;
      const y = terrainH(rIn);
      const h = y - terrainH(rOut);
      if (h < 0.25) continue;
      const n = 72;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU;
        const jitter = 1 + (rnd() - 0.5) * 0.05;
        const px = Math.cos(a) * rIn * jitter;
        const pz = Math.sin(a) * rIn * jitter;
        const w = (TAU * rIn) / n * 1.3;
        const d = (rOut - rIn) * 1.15;
        B.box('stone.castle', w, h * 1.9, d, px, y - h * 0.45, pz, a + Math.PI / 2,
          pick(rnd, CLIFF));
        this.track(this.physics.addRotatedBox(
          _v1.set(px, y - h * 0.45, pz),
          _v2.set(w * 0.5, h * 0.95, d * 0.5),
          a + Math.PI / 2
        ));
      }
    }

    /* Dunes, as geometry rather than as noise in the heightfield.
     *
     * The mesh used to carry a sine-based dune field that nothing collided
     * with, so the desert's crests were solid to the eye and empty to the
     * player. Built as real boxes they get real colliders, and the flat mesh
     * underneath them is a floor that agrees with itself. */
    /* Low and wide, in three shallow tiers.
     *
     * The first pass built these nearly 6 m tall in two steps, which in a desert
     * you cross on horseback is not scenery, it is a wall - the test horse
     * spawned against one and could not move at all. Each tier is now a step
     * about half a metre high, which a rider goes over without noticing and
     * which still breaks up a flat plain when the light rakes across it. */
    for (let i = 0; i < 70; i++) {
      const a = rnd() * TAU;
      const r = MESA_R + SHOULDER + 10 + rnd() * 92;
      const px = Math.cos(a) * r;
      const pz = Math.sin(a) * r;
      if (Math.abs(px) > HALF - 10 || Math.abs(pz) > HALF - 10) continue;
      const dw = 20 + rnd() * 34;
      const dd = 10 + rnd() * 16;
      const step = 0.42 + rnd() * 0.3;
      const da = rnd() * TAU;
      for (let k = 0; k < 3; k++) {
        const shrink = 1 - k * 0.28;
        B.box('dirt.ground', dw * shrink, step, dd * shrink,
          px, step * (k + 0.5), pz, da, k === 2 ? 0xf0dfb6 : 0xe8d5aa);
        this.track(this.physics.addRotatedBox(
          _v1.set(px, step * (k + 0.5), pz),
          _v2.set(dw * shrink * 0.5, step * 0.5, dd * shrink * 0.5), da
        ));
      }
    }

    B.flush(this.group, (k) => this._mat(k), 'cliff', { cast: true, recv: true });
    B.dispose();

    // Desert floor collider, its top exactly on the mesh's desert level.
    this.track(this.physics.addBox(0, -6, 0, HALF * 1.6, 6, HALF * 1.6));

    this.bounds = new THREE.Box3(
      new THREE.Vector3(-HALF, -10, -HALF),
      new THREE.Vector3(HALF, 90, HALF)
    );
  }

  /* ------------------------------------------------------------------ */
  /* Curtain wall                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Curtain wall with walkable battlements and corner towers.
   *
   * The rampart walk is the town's first traversal line: it circles the whole
   * souk at 9 m, so a player who climbs the gatehouse can run the entire
   * perimeter without touching the ground. The merlons are real boxes rather
   * than a texture, because they are the handholds on the way up.
   */
  _buildCurtainWall() {
    const B = new Batch({ ao: 0.4, sky: 0.34, grime: 0.55, span: 5 }, TILE_METRES);
    // Module constants: the souk's outer radius and the rampart haystack lane
    // are both derived from them, so a second copy here would be a second copy
    // that could drift.
    const R = WALL_R;
    const segs = 40;
    const top = MESA_Y + WALL_H;

    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * TAU;
      const a1 = ((i + 1) / segs) * TAU;
      const mid = (a0 + a1) * 0.5;
      // Leave the gate open on the +Z side, where the approach road arrives.
      if (Math.abs(((mid - GATE_BEARING + Math.PI) % TAU) - Math.PI) < 0.1) continue;

      const px = Math.cos(mid) * R;
      const pz = Math.sin(mid) * R;
      const len = (TAU * R) / segs * 1.06;
      /* THE SIGN, and it was wrong for the whole life of this world.
       *
       * `Matrix4.makeRotationY(t)` puts the local +X axis at world
       * `(cos t, -sin t)`, so the WORLD BEARING of local +X is `-t`, not `+t`.
       * A segment rotated `mid + pi/2` therefore lies along bearing
       * `-(mid + pi/2)`, which differs from the tangent by `2*mid + pi` - zero
       * only where `mid` is a multiple of pi/2. Everywhere else the segment is
       * turned off the ring, and at mid = pi/4 it is turned by a right angle
       * and lies RADIALLY.
       *
       * Measured with `deckAt` on a radial sweep, the curtain wall was a
       * rosette: solid stone reaching in to r = 111.8 at some bearings and open
       * mesa at r = 118 at others. The town was not walled. The merlon
       * positions two lines down were computed off the true tangent
       * `(cos(mid + pi/2), sin(mid + pi/2))` all along, so the blocks and the
       * wall they stand on disagreed with each other, which is the tell.
       *
       * `pi/2 - mid` is the rotation that puts local +Z on the radius and
       * local +X on the tangent, and it is the same expression `_buildSouk`
       * uses for the same reason. */
      const wallRot = Math.PI / 2 - mid;

      B.box('stone.castle', len, WALL_H, WALL_T, px, MESA_Y + WALL_H * 0.5, pz, wallRot, 0xc4b494);
      this.track(this.physics.addRotatedBox(
        _v1.set(px, MESA_Y + WALL_H * 0.5, pz),
        _v2.set(len * 0.5, WALL_H * 0.5, WALL_T * 0.5),
        wallRot
      ));

      // Merlons: alternating blocks along the parapet.
      const merlons = 5;
      for (let m = 0; m < merlons; m++) {
        if (m % 2) continue;
        const t = (m + 0.5) / merlons - 0.5;
        const mx = px + Math.cos(mid + Math.PI / 2) * len * t;
        const mz = pz + Math.sin(mid + Math.PI / 2) * len * t;
        B.box('stone.castle', len / merlons * 0.86, 1.5, WALL_T * 0.55,
          mx, top + 0.75, mz, wallRot, 0xbfae8c);
        this.track(this.physics.addRotatedBox(
          _v1.set(mx, top + 0.75, mz),
          _v2.set(len / merlons * 0.43, 0.75, WALL_T * 0.28),
          wallRot
        ));
      }
    }

    // Corner towers - taller, and each one a rest ledge on a long climb.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU + 0.39;
      const px = Math.cos(a) * R;
      const pz = Math.sin(a) * R;
      const h = 17;
      const w = 8.5;
      B.box('stone.castle', w, h, w, px, MESA_Y + h * 0.5, pz, a, 0xcbbb99);
      this.track(this.physics.addRotatedBox(
        _v1.set(px, MESA_Y + h * 0.5, pz), _v2.set(w * 0.5, h * 0.5, w * 0.5), a
      ));
      // String course at mid height: the rest ledge.
      B.box('stone.castle', w + 1.1, 0.5, w + 1.1, px, MESA_Y + h * 0.55, pz, a, 0xb2a084);
      this.track(this.physics.addRotatedBox(
        _v1.set(px, MESA_Y + h * 0.55, pz), _v2.set((w + 1.1) * 0.5, 0.25, (w + 1.1) * 0.5), a
      ));
      // Parapet ring on top.
      B.box('stone.castle', w + 1.4, 1.2, w + 1.4, px, MESA_Y + h + 0.6, pz, a, 0xc0b08e);
      this.track(this.physics.addRotatedBox(
        _v1.set(px, MESA_Y + h + 0.6, pz), _v2.set((w + 1.4) * 0.5, 0.6, (w + 1.4) * 0.5), a
      ));

      // `wall: true` so `_buildRopeBridges` can name these rather than
      // finding them by a height predicate. The old `find(t => !t.minaret &&
      // t.y < MESA_Y + 34)` matched whichever wall tower happened to be pushed
      // first, which is a layout detail wearing the costume of a choice.
      this._towers.push({ x: px, y: MESA_Y + h + 1.2, z: pz, r: w * 0.5, wall: true });
      this._roofs.push({ x: px, y: MESA_Y + h + 1.2, z: pz, w, d: w });
    }

    /* Gatehouse. Two flanking blocks and a lintel: the arch the player walks in
     * under, and the first climb the game offers - low, wide, forgiving. */
    const gz = R;
    for (const sx of [-6.5, 6.5]) {
      B.box('stone.castle', 7, 14, 9, sx, MESA_Y + 7, gz, 0, 0xcdbd9b);
      this.track(this.physics.addBox(sx, MESA_Y + 7, gz, 3.5, 7, 4.5));
      B.box('stone.castle', 8.2, 0.6, 10.2, sx, MESA_Y + 8.4, gz, 0, 0xb4a286);
      this.track(this.physics.addBox(sx, MESA_Y + 8.4, gz, 4.1, 0.3, 5.1));
    }
    B.box('stone.castle', 20, 3.2, 9, 0, MESA_Y + 12.4, gz, 0, 0xc8b896);
    this.track(this.physics.addBox(0, MESA_Y + 12.4, gz, 10, 1.6, 4.5));
    this._roofs.push({ x: 0, y: MESA_Y + 14, z: gz, w: 20, d: 9 });

    B.flush(this.group, (k) => this._mat(k), 'wall');
    B.dispose();
  }

  /* ------------------------------------------------------------------ */
  /* Souk                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * The lower town: flat-roofed blocks in a rough radial grid.
   *
   * Heights climb toward the citadel, and roof gaps widen with them. That is
   * the whole difficulty curve expressed as geometry: near the gate a player
   * can stroll between roofs, and by the inner ward they are committing to
   * running leaps. Every block gets a door lintel and a window course, which
   * exist to be gripped rather than looked at.
   */
  _buildSouk() {
    // The strongest of the set. The souk is where the player spends most of
    // their time at eye level, and alley contact shadow is most of what sells
    // a town built entirely from boxes.
    const B = new Batch({ ao: 0.46, sky: 0.34, grime: 0.65, span: 3.4 }, TILE_METRES);
    const rnd = this.rnd;

    /* Resolve the four authored interiors BEFORE anything is placed.
     *
     * `ENTERABLE_SITES` names a ring and a compass bearing; this turns each
     * into the index of the nearest surviving building on that ring, at the
     * counts this build is actually using. That is the whole re-key: the
     * authored data no longer contains an index, so changing `count` moves the
     * interior a couple of metres round the ring instead of moving it onto a
     * different house or losing it entirely. */
    const enterableAt = new Map();
    for (const site of ENTERABLE_SITES) {
      const spec = SOUK_RINGS[site.ring];
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < spec.count; i++) {
        const a = (i / spec.count) * TAU + site.ring * 0.31;
        if (this._inCorridor(a)) continue;
        const d = Math.abs(wrapPi(a - site.bearing));
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best >= 0) enterableAt.set(`${site.ring}:${best}`, site);
    }

    for (const spec of SOUK_RINGS) {
      const ring = spec.ring;
      const r = spec.r;
      const count = spec.count;
      for (let i = 0; i < count; i++) {
        /* No angular jitter. It used to be `+ (rnd() - 0.5) * 0.06`, which is
         * +/-3.1 m of tangential slop per building at the outer ring - twice
         * the whole difference between a sprint jump and a leap - and it was
         * the single largest term in the old gap distribution. */
        const a = (i / count) * TAU + ring * 0.31;
        /* Keep the whole gate approach clear, at every ring.
         *
         * The first version only cleared the inner four, and the outer two
         * closed the corridor back up right where the player arrives - so the
         * spawn probe found a rooftop and dropped them onto it, staring at a
         * wall, in a world whose entire first impression is meant to be the
         * town rising toward the tower. A processional route has to be
         * processional the whole way in.
         *
         * It is also the one break in the roof network that is DELIBERATE.
         * Connectivity routes around it; it does not get closed to buy a
         * component. */
        if (this._inCorridor(a)) continue;

        const px = Math.cos(a) * r;
        const pz = Math.sin(a) * r;
        /* The footprint frame, and the reason the whole ring is solvable.
         *
         * `rotY = rot` puts the box's local +X on `(cos rot, -sin rot)` and its
         * local +Z on `(sin rot, cos rot)`; at `rot = pi/2 - a` that is the
         * ring TANGENT and the RADIUS respectively. So `w` is tangential width
         * and `d` is radial depth at every bearing, which is what lets
         * `SOUK_RINGS` solve `w` from a target gap. The old code passed `a`
         * itself, rotating the footprint frame at -2a relative to the ring. */
        const rot = Math.PI * 0.5 - a;
        const w = spec.w + (rnd() - 0.5) * 0.5;
        const d = spec.depth + (rnd() - 0.5) * 0.5;
        /* Deck height: the ring's authored value, saw-toothed on the inner two
         * rings, plus a little noise. The noise is +/-0.12 m and not the old
         * +/-1.75 m, because a step taller than a jump's apex is a wall and the
         * apexes are 0.878 m and 1.109 m - there is no room in that budget for
         * a metre of dice. */
        const deck = spec.deck
          + (spec.sawtooth ? (i % 2 ? -spec.sawtooth : spec.sawtooth) : 0)
          + (rnd() - 0.5) * 0.24;
        const h = deck - 0.55;                 // the roof lip is 0.55 m thick
        const y0 = MESA_Y;
        /* Per-building colour, drawn from a real palette.
         *
         * The first version subtracted a small random amount from the *red*
         * channel only, which varies four hundred houses across a range narrower
         * than the eye can see - the town came out one flat sheet of mustard.
         * A hand-picked set of limewash and mudbrick tones, varied a little in
         * lightness per building, is what makes a skyline read as a place where
         * people paint their own houses. */
        const tint = pick(rnd, WASH);
        const site = enterableAt.get(`${ring}:${i}`);
        const enterable = !!site;
        const wallT = 0.42;
        const doorHW = 0.86;
        const doorH = 2.45;
        const roomCeil = Math.min(h - 0.45, 3.65);

        if (!enterable) {
          B.box('plaster.wall', w, h, d, px, y0 + h * 0.5, pz, rot, tint);
          this.track(this.physics.addRotatedBox(
            _v1.set(px, y0 + h * 0.5, pz), _v2.set(w * 0.5, h * 0.5, d * 0.5), rot
          ));
        } else {
          // Flipped houses build their whole local frame rotated 180 deg so
          // the doorway lands on the clear alley face; the w x d footprint is
          // symmetric under that rotation so nothing else moves.
          const da = site.flipDoor ? rot + Math.PI : rot;
          const hw = w * 0.5;
          const hd = d * 0.5;
          const M = new THREE.Matrix4().makeRotationY(da).setPosition(px, y0, pz);
          const rcol = (lx, cy, lz, hx, hy, hz) => {
            _v1.set(lx, cy, lz).applyMatrix4(M);
            return this.track(this.physics.addRotatedBox(_v1, _v2.set(hx, hy, hz), da));
          };
          const segW = Math.max(0.7, hw - doorHW);
          // Hollow ground-floor shell with a real doorway in the +Z alley face.
          B.box('plaster.wall', w, h, wallT, px + Math.sin(da) * (-hd + wallT * 0.5),
            y0 + h * 0.5, pz + Math.cos(da) * (-hd + wallT * 0.5), da, tint);
          rcol(0, h * 0.5, -hd + wallT * 0.5, hw, h * 0.5, wallT * 0.5 + 0.04);
          for (const sgn of [-1, 1]) {
            const wx = px + Math.cos(da) * sgn * (hw - wallT * 0.5);
            const wz = pz - Math.sin(da) * sgn * (hw - wallT * 0.5);
            B.box('plaster.wall', wallT, h, d - wallT * 2, wx, y0 + h * 0.5, wz, da, tint);
            rcol(sgn * (hw - wallT * 0.5), h * 0.5, 0, wallT * 0.5 + 0.04, h * 0.5, hd);
            B.box('plaster.wall', segW, h, wallT,
              px + Math.cos(da) * sgn * (doorHW + segW * 0.5) + Math.sin(da) * (hd - wallT * 0.5),
              y0 + h * 0.5,
              pz - Math.sin(da) * sgn * (doorHW + segW * 0.5) + Math.cos(da) * (hd - wallT * 0.5),
              da, tint);
            rcol(sgn * (doorHW + segW * 0.5), h * 0.5, hd - wallT * 0.5,
              segW * 0.5, h * 0.5, wallT * 0.5 + 0.04);
          }
          B.box('plaster.wall', doorHW * 2, h - doorH, wallT,
            px + Math.sin(da) * (hd - wallT * 0.5),
            y0 + doorH + (h - doorH) * 0.5,
            pz + Math.cos(da) * (hd - wallT * 0.5), da, tint);
          rcol(0, doorH + (h - doorH) * 0.5, hd - wallT * 0.5,
            doorHW, (h - doorH) * 0.5, wallT * 0.5 + 0.04);

          // Interior floor/ceiling and simple market furnishings.
          B.box('stone.cobble', w - 0.25, 0.16, d - 0.25, px, y0 + 0.08, pz, da, 0xd3c09a);
          rcol(0, 0.04, 0, hw - 0.12, 0.08, hd - 0.12);
          B.box('wood.plank', w - 0.2, 0.16, d - 0.2, px, y0 + roomCeil, pz, da, 0x8a6a44);
          rcol(0, roomCeil, 0, hw - 0.05, 0.1, hd - 0.05);
          B.box('wood.plank', 1.8, 0.16, 1.05,
            px + Math.cos(da) * -1.2 + Math.sin(da) * -0.8, y0 + 0.82,
            pz - Math.sin(da) * -1.2 + Math.cos(da) * -0.8, da + 0.08, 0x8c6840);
          rcol(-1.2, 0.75, -0.8, 1.0, 0.45, 0.65);
          for (const [lx, lz] of [[1.55, -0.7], [1.9, 0.65], [-1.7, 1.0]]) {
            B.box('wood.beam', 0.65, 0.55, 0.65,
              px + Math.cos(da) * lx + Math.sin(da) * lz, y0 + 0.28,
              pz - Math.sin(da) * lx + Math.cos(da) * lz, da, 0x6d5334);
            rcol(lx, 0.32, lz, 0.36, 0.32, 0.36);
          }

          const leafW = doorHW * 2 - 0.08;
          const leafGeo = prepDynamicGeo(new THREE.BoxGeometry(leafW, doorH - 0.12, 0.1), 'wood.plank', 0x6b4a2e);
          leafGeo.translate(leafW * 0.5, 0, 0);
          const leaf = new THREE.Mesh(leafGeo, this._mat('wood.plank'));
          leaf.castShadow = leaf.receiveShadow = true;
          this._owned.push(leafGeo);
          const pivot = new THREE.Group();
          _v1.set(-doorHW + 0.02, doorH * 0.5, hd - wallT * 0.5).applyMatrix4(M);
          pivot.position.copy(_v1);
          pivot.rotation.y = da;
          pivot.add(leaf);
          for (const by of [-0.52, 0.52]) {
            const bandGeo = prepDynamicGeo(new THREE.BoxGeometry(leafW * 0.88, 0.12, 0.06), 'wood.beam', 0x33251a);
            bandGeo.translate(leafW * 0.5, by, 0.08);
            const band = new THREE.Mesh(bandGeo, this._mat('wood.beam'));
            pivot.add(band);
            this._owned.push(bandGeo);
          }
          this.group.add(pivot);
          _v1.set(0, doorH * 0.5, hd - wallT * 0.5).applyMatrix4(M);
          const doorCol = this.track(this.physics.addRotatedBox(_v1, _v2.set(doorHW, doorH * 0.5, 0.13), da));
          const dpos = new THREE.Vector3(0, 1.2, hd).applyMatrix4(M);
          const lootPos = new THREE.Vector3(1.55, 0.72, -0.7).applyMatrix4(M);
          if (!Array.isArray(this.enterables)) this.enterables = [];
          const n = this.enterables.length;
          this.enterables.push({
            label: site.label,
            origin: new THREE.Vector3(px, y0, pz),
            doors: [{
              id: `citadel_souk_${n}`,
              leaves: [{ pivot, closed: da, open: da - Math.PI * 0.58 }],
              collider: doorCol,
              position: dpos,
              open: false,
              anim: 0,
            }],
            collectibleSpots: [{ position: lootPos, tier: 'common' }],
          });
        }

        // Roof lip - the ledge you actually mantle onto, and the footprint
        // every gap in `SOUK_RINGS` is measured between.
        B.box('stone.castle', w + SOUK_LIP, 0.55, d + SOUK_LIP, px, y0 + h + 0.27, pz, rot, 0xbfae8a);
        this.track(this.physics.addRotatedBox(
          _v1.set(px, y0 + h + 0.27, pz),
          _v2.set((w + SOUK_LIP) * 0.5, 0.28, (d + SOUK_LIP) * 0.5), rot
        ));
        this._roofs.push({ x: px, y: y0 + h + 0.55, z: pz, w, d, ring });

        /* Window course. Two bands of shallow boxes proud of the wall: the
         * handholds that make a plaster face climbable instead of blank. They
         * are colliders, which is the whole point - a decal would look the same
         * and grip nothing. Narrower than the roof lip, so they never become
         * the thing a jump is measured against. */
        const bands = h > 9 ? 2 : 1;
        for (let bnd = 0; bnd < bands; bnd++) {
          const by = y0 + h * (bnd === 0 ? 0.42 : 0.74);
          B.box('wood.beam', w + 0.5, 0.34, d + 0.5, px, by, pz, rot, 0x6d5334);
          this.track(this.physics.addRotatedBox(
            _v1.set(px, by, pz), _v2.set((w + 0.5) * 0.5, 0.17, (d + 0.5) * 0.5), rot
          ));
        }

        /* Openings.
         *
         * Faked rather than cut: there is no CSG here, so each opening is a
         * near-black panel set a hand's width into the wall face, with a lintel
         * over it and a sill under it. The panel is what the eye reads as depth
         * and the sill is what catches the sun, and together they turn a blank
         * rectangle into a wall of a building. At any distance past a couple of
         * metres it is indistinguishable from a real recess, and it costs three
         * boxes instead of a boolean operation per house.
         *
         * The sills are colliders. Everything on this world's facades is: the
         * whole point of the citadel is that a wall is a route, so a detail the
         * player can see and not grab would be a lie. */
        /* Face directions, derived rather than guessed.
         *
         * A box at `rotY = rot` has its local +Z pointing along world
         * (sin rot, cos rot) and its local +X along (cos rot, -sin rot).
         * Offsetting by the radius instead of by the local axis puts every
         * detail out in the open air beside its own wall - that is what was
         * wrong with the parapets and awnings below, and it is the difference
         * between a facade and a cloud of loose boxes. With the radial frame,
         * `fa = 0` is the face that looks straight out down the hill. */
        const faces = [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5];
        for (const fa of faces) {
          const wa = rot + fa;
          const nx = Math.sin(wa);
          const nz = Math.cos(wa);
          const tx = Math.cos(wa);     // tangent, for spacing bays along the face
          const tz = -Math.sin(wa);
          // Depth of the wall we are punching into, and its width.
          const onZ = fa === 0 || Math.abs(fa - Math.PI) < 1e-6;
          const half = (onZ ? d : w) * 0.5;
          const along = (onZ ? w : d) * 0.5;
          const rows = h > 9 ? 2 : 1;
          for (let row = 0; row < rows; row++) {
            const wy = y0 + h * (rows === 1 ? 0.58 : row === 0 ? 0.36 : 0.68);
            // The blocks are wide and shallow now, so the threshold that
            // decides a two-bay face sits between the two: 4.2 m of half-width
            // puts two windows on every street frontage and one on the ends.
            const cols = along > 4.2 ? 2 : 1;
            for (let cidx = 0; cidx < cols; cidx++) {
              if (rnd() < 0.22) continue;                 // not every bay
              const off = cols === 1 ? 0 : (cidx - 0.5) * along * 0.95;
              const ox = px + nx * half + tx * off;
              const oz = pz + nz * half + tz * off;
              const ww = 1.05 + rnd() * 0.45;
              const wh = 1.35 + rnd() * 0.5;
              // Recess: pushed 0.16 in, so the wall itself shades it.
              B.box('stone.castle', ww, wh, 0.1, ox - nx * 0.16, wy, oz - nz * 0.16, wa, 0x2b2119);
              // Lintel above, sill below - both proud, both grabbable.
              B.box('wood.beam', ww + 0.34, 0.2, 0.24, ox + nx * 0.05, wy + wh * 0.5 + 0.1, oz + nz * 0.05, wa, 0x6a4f31);
              B.box('stone.castle', ww + 0.42, 0.16, 0.3, ox + nx * 0.07, wy - wh * 0.5 - 0.08, oz + nz * 0.07, wa, 0xcdbb95);
              this.track(this.physics.addRotatedBox(
                _v1.set(ox + nx * 0.07, wy - wh * 0.5 - 0.08, oz + nz * 0.07),
                _v2.set((ww + 0.42) * 0.5, 0.08, 0.15), wa
              ));
            }
          }

          // A doorway on the alley-facing side only, so the ground floor is not
          // ringed with four front doors. `fa === 0` is the outward radial
          // face: every house in the souk fronts onto the street below it.
          if (fa === 0) {
            const hasDecorDoor = rnd() < 0.75;
            if (!enterable && hasDecorDoor) {
            const dw = 1.25;
            const dh = 2.3;
            B.box('stone.castle', dw, dh, 0.12, px + nx * (half - 0.14), y0 + dh * 0.5, pz + nz * (half - 0.14), wa, 0x241c15);
            B.box('wood.beam', dw + 0.4, 0.26, 0.28, px + nx * (half + 0.05), y0 + dh + 0.13, pz + nz * (half + 0.05), wa, 0x6a4f31);
            }
          }
        }

        /* Parapet stubs on some roofs, so the skyline is not a flat plane.
         * Offset along the building's own +Z, for the reason set out above -
         * this one used to displace on z only, which slid the parapet clean off
         * the roof of every building on a diagonal. Seated ON the roof plane:
         * the earlier +0.55 lift left a visible air gap under every one.
         *
         * Visual only - no collider. A parapet that stood up as a solid on the
         * deck would be a wall across the middle of every landing. */
        if (rnd() < 0.45) {
          const ph = 0.9 + rnd() * 0.6;
          B.box('plaster.wall', w * 0.9, ph, 0.5,
            px + Math.sin(rot) * d * 0.45, y0 + h + ph * 0.5 - 0.02,
            pz + Math.cos(rot) * d * 0.45, rot, tint);
        }

        /* An awning over the street, and its posts: cover, and a mid-height
         * perch. It projects 1.8 m rather than the old 3.2, because the ring
         * streets are now an authored width - 3.1 m at the outer rings - and a
         * 3.2 m awning would have grown straight through the next ring's wall. */
        if (rnd() < 0.3) {
          const ax = px + Math.sin(rot) * (d * 0.5 + 0.9);
          const az = pz + Math.cos(rot) * (d * 0.5 + 0.9);
          B.box('fabric.banner', w * 0.8, 0.12, 1.8, ax, y0 + 3.4, az, rot, 0xc2543a);
          this.track(this.physics.addRotatedBox(
            _v1.set(ax, y0 + 3.4, az), _v2.set(w * 0.4, 0.06, 0.9), rot
          ));
          // Posts under the outer corners - without them the fabric slab
          // reads as a plank floating in the alley.
          const pox = px + Math.sin(rot) * (d * 0.5 + 1.7);
          const poz = pz + Math.cos(rot) * (d * 0.5 + 1.7);
          for (const sgn of [-1, 1]) {
            B.box('wood.beam', 0.16, 3.34, 0.16,
              pox + Math.cos(rot) * sgn * (w * 0.35),
              y0 + 1.67,
              poz - Math.sin(rot) * sgn * (w * 0.35), rot, 0x6a4f31);
          }
        }

        /* A cornice under the roof lip, and a domed roof on a few blocks.
         *
         * Every silhouette in the town was a rectangle with a flat top, and a
         * skyline of nothing but rectangles is most of what reads as blocky
         * however well the faces are shaded. The cornice puts a horizontal
         * shadow line under every roof, and the domes break the ridge line with
         * the one shape in the world that has no edges at all. */
        B.box('stone.castle', w + 1.15, 0.28, d + 1.15, px, y0 + h - 0.32, pz, rot,
          0xd6c6a0);

        if (rnd() < 0.3) {
          const dr = Math.min(w, d) * 0.42;
          const dome = new THREE.SphereGeometry(dr, 14, 8, 0, TAU, 0, Math.PI * 0.52);
          _e1.set(0, rot, 0);
          _q1.setFromEuler(_e1);
          // Centre sits just above the roof plane so the dome's rim (slightly
          // below its centre) tucks into the slab - the old +0.55 lift left
          // every dome hovering over its own building.
          _v1.set(px, y0 + h + 0.12, pz);
          _v2.set(1, 0.82, 1);
          _m1.compose(_v1, _q1, _v2);
          B.add('plaster.wall', dome, _m1, 0xe4d6b4);
          this.track(this.physics.addBox(px, y0 + h + 0.12 + dr * 0.32, pz,
            dr * 0.72, dr * 0.32, dr * 0.72));
          // Finial, so the dome terminates rather than just stopping.
          B.box('wood.beam', 0.16, 0.5, 0.16, px, y0 + h + 0.12 + dr * 0.82 + 0.25, pz, rot, 0x8a6a3a);
        }
      }
    }

    B.flush(this.group, (k) => this._mat(k), 'souk');
    B.dispose();

    /* A standing spot per roof, resolved once the whole souk is standing.
     *
     * It cannot be done as each roof is pushed: the dome that would block the
     * centre is built LATER IN THE SAME ITERATION, so a probe taken at push
     * time reads the bare deck and answers the centre for every roof. This
     * pass runs after every collider in the souk exists.
     *
     * `x/y/z` are left exactly where they were - they are the footprint centre
     * and the datum every gap in this world is measured between, and moving
     * them would move the rope-bridge landfall anchors and the trial routes
     * with them. `anchor` is the separate question "where on this roof can a
     * body stand", and it is what `Relics` consumes. Without it 8 of the 30
     * citadel relics were sealed inside a dome. */
    for (const r of this._roofs) r.anchor = this._deckSpot(r);
  }

  /**
   * Is this bearing inside the processional corridor?
   *
   * The corridor is the one deliberate break in the roof network: every ring
   * deletes the buildings within `CORRIDOR_HALF` of the gate bearing, which at
   * the outer ring is a 53 m radial gap. It exists so the player arrives on a
   * street that runs the whole way in, and it is not to be closed to buy a
   * connected component - the network routes around the other side.
   */
  _inCorridor(a) {
    return Math.abs(wrapPi(a - GATE_BEARING)) < CORRIDOR_HALF;
  }

  /* ------------------------------------------------------------------ */
  /* Citadel                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * The keep, the great tower and four minarets.
   *
   * The great tower is the world's high anchor at 46 m, and it is banded every
   * 7 m for exactly the reason set out in the file header: a continuous 46 m
   * face is not a climb, it is a stamina failure with a long fall attached.
   */
  _buildCitadel() {
    const B = new Batch({ ao: 0.38, sky: 0.32, grime: 0.45, span: 7 }, TILE_METRES);
    const cy = MESA_Y;

    // Raised inner ward, so the citadel reads as above the town it commands.
    const wardR = 30;
    const wardH = 6;
    B.box('stone.castle', wardR * 2, wardH, wardR * 2, 0, cy + wardH * 0.5, 0, 0, 0xc7b791);
    this.track(this.physics.addBox(0, cy + wardH * 0.5, 0, wardR, wardH * 0.5, wardR));
    const wardTop = cy + wardH;

    /* Stair up from the souk. The ward has to be reachable on foot as well as
     * by climbing - a vertical world that *requires* the vertical mechanic to
     * see its centrepiece is a world that locks out anyone still learning it. */
    for (let s = 0; s < 10; s++) {
      const sy = cy + (s + 0.5) * (wardH / 10);
      const sz = wardR + 6 - s * 0.7;
      B.box('stone.cobble', 9, wardH / 10, 1.6, 0, sy, sz, 0, 0xb6a68a);
      this.track(this.physics.addBox(0, sy, sz, 4.5, wardH / 20, 0.8));
    }

    // Keep.
    const kw = 26;
    const kh = 20;
    B.box('stone.castle', kw, kh, kw * 0.8, 0, wardTop + kh * 0.5, -4, 0, 0xd0c096);
    this.track(this.physics.addBox(0, wardTop + kh * 0.5, -4, kw * 0.5, kh * 0.5, kw * 0.4));
    for (const ly of [0.34, 0.68]) {
      const by = wardTop + kh * ly;
      B.box('stone.castle', kw + 1.2, 0.6, kw * 0.8 + 1.2, 0, by, -4, 0, 0xb5a483);
      this.track(this.physics.addBox(0, by, -4, (kw + 1.2) * 0.5, 0.3, (kw * 0.8 + 1.2) * 0.5));
    }
    B.box('stone.castle', kw + 2, 1.4, kw * 0.8 + 2, 0, wardTop + kh + 0.7, -4, 0, 0xc3b28f);
    this.track(this.physics.addBox(0, wardTop + kh + 0.7, -4, (kw + 2) * 0.5, 0.7, (kw * 0.8 + 2) * 0.5));
    this._roofs.push({ x: 0, y: wardTop + kh + 1.4, z: -4, w: kw, d: kw * 0.8 });

    /* Great tower. The high anchor and the leap-of-faith platform. */
    const tw = 11;
    const th = 46;
    const tx = 0;
    const tz = -18;
    B.box('stone.castle', tw, th, tw, tx, wardTop + th * 0.5, tz, 0, 0xd6c69c);
    this.track(this.physics.addBox(tx, wardTop + th * 0.5, tz, tw * 0.5, th * 0.5, tw * 0.5));
    /* Rest ledges every 7 m. Load-bearing for the climb, not decoration - and
     * since Drop Two, load-bearing for the *fall* as well.
     *
     * They used to be `tw + 1.5` = 12.5 m across against a `tw + 2.4` = 13.4 m
     * crown, so the crown overhung its own galleries by 0.45 m. Measured, that
     * one number was the whole of R4's failure: a body stepping off the crown
     * cleared every ledge on the tower and hit the inner ward 47.60 m below,
     * which is past `LETHAL_SPEED`. All 25 unsurvivable roof-edge samples in
     * the world were this edge.
     *
     * `LEDGE_OUT` is now 2.2 m rather than 0.75, which puts the gallery 1.0 m
     * PROUD of the crown: the drop off the crown is caught by the top gallery
     * 5.32 m down, and 5.32 is inside the 7.5 m at which fall damage begins. It
     * is also what a machicolated tower actually looks like - the fighting
     * gallery is meant to overhang the wall it defends - so the fix reads as
     * architecture rather than as a safety rail.
     *
     * The clearance is checked against the probe, not by eye: the fall sampler
     * steps 0.45 m off the crown edge, i.e. 6.7 + 0.45 = 7.15 m from the axis,
     * and the gallery half-extent is 7.60 m. 0.45 m of margin. */
    const LEDGE_OUT = 2.2;
    for (let y = 7; y < th; y += 7) {
      B.box('stone.castle', tw + LEDGE_OUT * 2, 0.55, tw + LEDGE_OUT * 2, tx, wardTop + y, tz, 0, 0xb9a887);
      this.track(this.physics.addBox(tx, wardTop + y, tz,
        tw * 0.5 + LEDGE_OUT, 0.28, tw * 0.5 + LEDGE_OUT));
    }
    // Crown and the jutting beam a leap of faith launches from.
    B.box('stone.castle', tw + 2.4, 1.6, tw + 2.4, tx, wardTop + th + 0.8, tz, 0, 0xcabb96);
    this.track(this.physics.addBox(tx, wardTop + th + 0.8, tz, (tw + 2.4) * 0.5, 0.8, (tw + 2.4) * 0.5));
    const beamHalf = 3.5;
    // 0.3 m in from the very tip: a launch point published exactly on a
    // collider's boundary is a coin toss between the beam and the air.
    const beamTipZ = tz + 5 + beamHalf - 0.3;
    const beamTopY = wardTop + th + 2.15;
    B.box('wood.beam', 1.1, 0.5, beamHalf * 2, tx, wardTop + th + 1.9, tz + 5, 0, 0x5d462c);
    this.track(this.physics.addBox(tx, wardTop + th + 1.9, tz + 5, 0.55, 0.25, beamHalf));

    const towerTopY = wardTop + th + 1.6;
    this._towers.push({ x: tx, y: towerTopY, z: tz, r: tw * 0.5, great: true });
    /* The beam points at +Z, toward the keep and the ward beyond it - and the
     * haystack rule used to offset *radially outward*, which for a tower at
     * (0, -18) is -Z. The hay landed 12.5 m behind the jump, on the wrong side
     * of the tower entirely. Every viewpoint now publishes the line it is
     * launched along, and the hay is placed on that line rather than on a
     * bearing derived from where the tower happens to stand.
     *
     * `run` is not a guess. Driven through the real integrator: a leap leaves
     * the beam at 11.64 m/s horizontal and 7.168 m/s up, clears the keep roof
     * (26.75 m down, and the arc is still at y 55.4 when it crosses the keep's
     * far parapet), and comes down on the ward 48.15 m below after 28.53 m.
     * Launched from the beam's root instead of its tip it falls 5.8 m short of
     * the keep's far edge and lands ON the keep roof, 26.75 m - damage, not
     * death. So the survivable band for a leap from anywhere along the beam is
     * z 13.6 to 19.0, and the hay sits in the middle of it with a radius that
     * covers the whole band. */
    this.viewpoints.push({
      id: 'great-tower',
      name: 'The Great Tower',
      x: tx, y: towerTopY, z: tz,
      r: (tw + 2.4) * 0.5,
      launch: { x: tx, y: beamTopY, z: beamTipZ },
      bearing: Math.PI * 0.5,
      hay: { run: 26.1, r: 3.6 },
    });

    /* Minarets: four thin towers, the rope-bridge anchors. Thin is the point -
     * they are the hardest free-climbs in the world because there is no wide
     * face to rest on, only the balcony rings. */
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + Math.PI * 0.25;
      const px = Math.cos(a) * 21;
      const pz = Math.sin(a) * 21;
      const mh = 30;
      const mw = 4.4;
      B.box('plaster.wall', mw, mh, mw, px, wardTop + mh * 0.5, pz, a, 0xe0d2ae);
      this.track(this.physics.addRotatedBox(
        _v1.set(px, wardTop + mh * 0.5, pz), _v2.set(mw * 0.5, mh * 0.5, mw * 0.5), a
      ));
      // Balcony rings.
      for (const by of [11, 21]) {
        B.box('wood.beam', mw + 2.2, 0.4, mw + 2.2, px, wardTop + by, pz, a, 0x6a5133);
        this.track(this.physics.addRotatedBox(
          _v1.set(px, wardTop + by, pz), _v2.set((mw + 2.2) * 0.5, 0.2, (mw + 2.2) * 0.5), a
        ));
      }
      // Gallery under the cap - the ring a muezzin would stand on, and the last
      // rest before the top of the hardest climb in the world.
      B.box('stone.castle', mw + 2.6, 0.5, mw + 2.6, px, wardTop + mh - 0.25, pz, a, 0xd8c8a2);
      this.track(this.physics.addRotatedBox(
        _v1.set(px, wardTop + mh - 0.25, pz), _v2.set((mw + 2.6) * 0.5, 0.25, (mw + 2.6) * 0.5), a
      ));
      /* An onion dome instead of a flat slab.
       *
       * A minaret capped with a box is a chimney. This is the world's most
       * distant readable silhouette - four of them stand above everything but
       * the great tower - so it is worth the one sphere each. */
      const capR = mw * 0.92;
      const cap = new THREE.SphereGeometry(capR, 16, 10, 0, TAU, 0, Math.PI * 0.58);
      _e1.set(0, a, 0);
      _q1.setFromEuler(_e1);
      _v1.set(px, wardTop + mh + 0.1, pz);
      _v2.set(1, 1.5, 1);      // stretched tall: an onion, not a hemisphere
      _m1.compose(_v1, _q1, _v2);
      B.add('roof.tile', cap, _m1, 0xbcc8d4);
      B.box('wood.beam', 0.22, 1.5, 0.22, px, wardTop + mh + capR * 1.5 + 0.6, pz, a, 0x8a6a3a);
      this.track(this.physics.addRotatedBox(
        _v1.set(px, wardTop + mh + 0.6, pz), _v2.set(capR * 0.7, 0.9, capR * 0.7), a
      ));
      this._towers.push({ x: px, y: wardTop + mh + 1.5, z: pz, r: mw * 0.5, minaret: true });
      /* Tangential, not radial. Offsetting the hay radially outward from a
       * minaret at r = 21 puts it at r = 28.6, which is under the inner souk
       * ring's roof overhang - measured, three of the four landed on a souk
       * roof 9 to 12 m over the ward. Along the ring instead, 8 m out, every
       * one of them stands on open ward: the keep occupies x +/-14 and z -15.4
       * to +7.4 and the great tower x +/-6.7, and these four clear both.
       *
       * A minaret is not the leap-of-faith platform - the drop to the ward is
       * 31.5 m, which is damage rather than death - so this hay is the answer
       * to a missed balcony rather than to a committed jump. That is why the
       * run is 8 m and not the 23.9 m a leap from up here would carry.
       *
       * AND THAT IS WHY THERE IS NO `launch` HERE.
       *
       * `Viewpoints.normaliseViewpoint` treats `launch` + `hay` published
       * together as the declaration "this viewpoint HAS a leap of faith", and
       * raises "Leap of faith - hay 29 m below" the moment a body stands
       * within LEAP_R = 3.0 m of the launch point. The minaret launch point
       * WAS the platform centre, so syncing a minaret always raised the offer.
       * Flown through the real integrator from that point on the published
       * bearing, against the built colliders, not one of the four arrives:
       *
       *   minaret-1  leap   lands (-2.44, 18.20, 32.14)  run 24.45  16.45 m
       *                     from its hay, 40.7 m/s into the souk
       *   minaret-2  leap   BLOCKED by the ward wall at (-30.49, 25.06, -0.79)
       *   minaret-3  leap   lands on the great tower's rest gallery at y 48.28
       *   minaret-4  leap   BLOCKED by the ward wall at (30.63, 24.48, 0.93)
       *
       * A sprint jump instead runs 16.40 m off all four and lands on the ward
       * at y 20.0 - a 31.5 m fall at 38.5 m/s against SAFE_SPEED 18, still
       * 8.40 m from the hay. Only a standing walk jump (2.61 m, still on the
       * platform) or a plain step-off reaches it, which is the "missed
       * balcony" this hay was placed for.
       *
       * Withholding `launch` is the whole fix: `normaliseViewpoint`'s `paired`
       * gate drops BOTH fields, so there is no prompt. The hay is still built -
       * `_buildDressing` falls back to the viewpoint's own point, which for a
       * minaret is the identical coordinate - and syncing, revealing and fast
       * travel are untouched, because none of them reads `launch`. */
      this.viewpoints.push({
        id: `minaret-${i + 1}`,
        name: `Minaret ${i + 1}`,
        x: px, y: wardTop + mh + 1.5, z: pz,
        r: (mw + 2.6) * 0.5,
        bearing: a + Math.PI * 0.5,
        hay: { run: 8.0, r: 3.2 },
      });
    }

    B.flush(this.group, (k) => this._mat(k), 'citadel');
    B.dispose();
  }

  /* ------------------------------------------------------------------ */
  /* Rope bridges                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Plank bridges strung between the minarets and the great tower.
   *
   * Each plank is its own collider. That is more colliders than a single long
   * box would be, but a bridge you can fall *between* is a bridge the player
   * reads as real, and the broadphase grid makes the cost of a few hundred
   * small boxes negligible.
   */
  _buildRopeBridges() {
    // Planks and ropes are seen from above and below in equal measure, so the
    // sky term carries this one and the ground-contact AO is nearly off.
    const B = new Batch({ ao: 0.12, sky: 0.4, grime: 0.2, span: 1.2 }, TILE_METRES);
    const minarets = this._towers.filter((t) => t.minaret);
    const walls = this._towers.filter((t) => t.wall);
    const great = this._towers.find((t) => t.great);
    if (minarets.length < 2) return;

    const links = [];
    for (let i = 0; i < minarets.length; i++) {
      links.push({ a: minarets[i], b: minarets[(i + 1) % minarets.length], id: `minaret-loop-${i}` });
    }

    /* And out to the perimeter, which is what this function has always said it
     * did and never once managed.
     *
     * The old code was three lines: find a non-minaret tower under 48 m, link
     * it to `minarets[0]`, then `if (span < 6 || span > 90) continue`. The span
     * is 99.0 m. It was rejected silently on the very next line, every build,
     * since the day it was written - so four 29.7 m loops shipped, all of them
     * inside r = 21, and the "network reaches the perimeter" comment described
     * a bridge that did not exist. The 46 m great tower had none at all.
     *
     * Three things had to change to make the intent real:
     *
     *  1. the limit. 90 -> 132, which is the diagonal of this mesa and so the
     *     longest span the world can physically want;
     *  2. the anchor pick. `find` returned whichever wall tower was pushed
     *     first; each perimeter span now names the bearing it wants to leave on
     *     and takes the wall tower nearest to it;
     *  3. **the height interpolation, which was the real bug.** `y0 = min(a.y,
     *     b.y) - 0.6` then `py = y0 + (b.y - a.y) * t` starts the deck at the
     *     LOWER anchor's height and then applies the full difference again. For
     *     the four minaret loops `a.y === b.y` so it is correct by accident;
     *     for a minaret at 51.5 m running out to a wall tower at 32.2 m it puts
     *     the first plank 19.9 m below the minaret it is tied to and the last
     *     one 19.3 m below the tower. Every unequal span this function could
     *     ever have built would have been a bridge to nowhere with a 20 m drop
     *     at each end. It lerps between the two anchors now.
     *
     * Walkability is not asserted here, it is measured: `citadel-reach`
     * detects the planks by their collider shape and walks the chain, and the
     * per-plank step is what has to stay under `NPC.GROUND_PROBE_UP` = 0.95 m.
     * The great-tower span is the steep one - 35.4 m of descent over 101.6 m of
     * span, plus the catenary - and it comes out at 0.63 m per plank.
     */
    const perimeter = [
      { from: minarets[0], out: Math.PI * 0.25, id: 'minaret-perimeter' },
      { from: great, out: -Math.PI * 0.62, id: 'great-tower-perimeter' },
    ];
    for (const spec of perimeter) {
      if (!spec.from || !walls.length) continue;
      let best = null;
      let bestD = Infinity;
      for (const t of walls) {
        const d = Math.abs(wrapPi(Math.atan2(t.z - spec.from.z, t.x - spec.from.x) - spec.out));
        if (d < bestD) { bestD = d; best = t; }
      }
      if (!best) continue;
      links.push({ a: spec.from, b: best, id: spec.id });

      /* Landfall: the same wall tower, back down into the outer souk.
       *
       * Reaching the perimeter is only half of what "so the network reaches
       * the perimeter" means. Measured with only the long span in place, the
       * citadel core and its bridges formed their own 166-node island: the
       * minarets could see the wall and the wall could see the minarets, and
       * neither could see the town. A 15 m span from the tower down onto the
       * nearest outer-ring roof is what makes the whole thing one network, and
       * it is also the route the design wants a player to find - run the souk
       * out to the wall, take the ramparts, and cross the sky to the citadel.
       *
       * Anchored on the roof's own edge rather than its centre, or the last
       * few planks hang in the air over somebody's roof. */
      let roof = null;
      let roofD = Infinity;
      const outerRing = SOUK_RINGS.length - 1;
      for (const r of this._roofs) {
        if (r.ring !== outerRing) continue;
        const d = Math.hypot(r.x - best.x, r.z - best.z);
        if (d < roofD) { roofD = d; roof = r; }
      }
      if (!roof) continue;
      const toTower = Math.atan2(best.z - roof.z, best.x - roof.x);
      const edge = Math.min(roof.w, roof.d) * 0.5 - 0.4;
      links.push({
        a: best,
        b: { x: roof.x + Math.cos(toTower) * edge, y: roof.y, z: roof.z + Math.sin(toTower) * edge },
        id: `${spec.id}-landfall`,
      });
    }

    // Published so the trials, the minimap and the viewpoint prompts can all
    // read the same spans rather than each recomputing the generator.
    this.ropeBridges.length = 0;

    for (const { a, b, id } of links) {
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const span = Math.hypot(dx, dz);
      if (span < 6 || span > 132) continue;
      const dirY = Math.atan2(dz, dx);
      /* THE SIGN AGAIN, and this is the second time in this file.
       *
       * `dirY` is the WORLD BEARING of the span and is what the lateral rail
       * offsets below are measured on. It is NOT the rotation that puts a box
       * along it: `makeRotationY(t)` (and `Batch.box`, which composes the same
       * Euler) puts local +X at world `(cos t, -sin t)`, so the world bearing
       * of local +X is `-t`. Passing `dirY` turns every plank by `2*dirY` off
       * its own span.
       *
       * The four minaret loops run at bearings 180/-90/0/90, where `2*dirY` is
       * a multiple of pi and a box is symmetric under it - so this was correct
       * by accident for the whole life of the loops and only became visible on
       * the long spans this drop adds. Measured off the collider matrices, the
       * skew was 36.0 deg on minaret-perimeter and 53.1 deg on
       * great-tower-perimeter, and a 2.2 m walkway laid herringbone develops
       * saw-tooth voids at both rails: sampling plank coverage every 5 cm at
       * lateral +-1.0 m found a longest hole of 0.90 m and 1.15 m on those two
       * spans against the authored 0.25 m plank gap on the centreline. Wide
       * enough to drop a body that drifts to the rail. */
      const rotY = -dirY;
      /* Plank count is bounded by the STEP as well as by the span. 1.4 m of
       * span per plank is right for a level bridge; on the landfall span it
       * would be 11.6 m of descent over eleven planks, a 1.05 m drop each,
       * which is over `NPC.GROUND_PROBE_UP` = 0.95 m and so is not a walk at
       * all. Capping the rise at 0.6 m per plank leaves room for the catenary
       * on top of it - the sag contributes another 0.15 m at the ends. */
      const steps = Math.max(6, Math.round(span / 1.4), Math.ceil(Math.abs(b.y - a.y) / 0.6));
      // Both ends hang 0.6 m under the deck they are tied to, and the walk
      // between them is a straight lerp with the catenary taken off it.
      const ay = a.y - 0.6;
      const by = b.y - 0.6;

      let worstStep = 0;
      let prevY = a.y;
      let mid = null;
      const midStep = Math.round(steps / 2);
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px = a.x + dx * t;
        const pz = a.z + dz * t;
        // Catenary sag - a taut bridge reads as a girder, a sagging one as rope.
        const sag = Math.sin(t * Math.PI) * Math.min(3.4, span * 0.055);
        const py = ay + (by - ay) * t - sag;
        worstStep = Math.max(worstStep, Math.abs(py - prevY));
        prevY = py;
        // The lowest point of the catenary, published rather than re-derived:
        // a trial checkpoint on a rope bridge has to sit on a plank that
        // exists, and `(a.y + b.y)/2 - sag` is arithmetic, not a plank.
        if (s === midStep) mid = { x: px, y: py, z: pz };
        B.box('wood.plank', 1.15, 0.13, 2.2, px, py, pz, rotY, 0x74583a);
        this.track(this.physics.addRotatedBox(
          _v1.set(px, py, pz), _v2.set(0.6, 0.09, 1.1), rotY
        ));
        // Hand ropes either side, as thin rails. The OFFSET is a world-space
        // displacement and so is measured on `dirY`; the rail's own rotation
        // is `rotY`, for the reason recorded above.
        if (s % 2 === 0) {
          for (const side of [-1, 1]) {
            const ox = Math.cos(dirY + Math.PI / 2) * 1.05 * side;
            const oz = Math.sin(dirY + Math.PI / 2) * 1.05 * side;
            B.box('wood.beam', 1.3, 0.08, 0.08, px + ox, py + 0.95, pz + oz, rotY, 0x4f3d28);
          }
        }
      }
      worstStep = Math.max(worstStep, Math.abs(b.y - prevY));
      this.ropeBridges.push({
        id, span, planks: steps + 1, worstStep, mid,
        a: { x: a.x, y: a.y, z: a.z }, b: { x: b.x, y: b.y, z: b.z },
      });
    }

    B.flush(this.group, (k) => this._mat(k), 'bridges', { cast: true, recv: false });
    B.dispose();
  }

  /* ------------------------------------------------------------------ */
  /* Dressing                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Haystacks, market stalls and banners.
   *
   * The haystacks are the important part and they are placed by rule, not by
   * eye: one under every viewpoint, so a leap of faith always has an answer.
   * `Player` reads `world.haystacks` to know a fall is survivable.
   */
  _buildDressing() {
    const B = new Batch({ ao: 0.44, sky: 0.3, grime: 0.6, span: 1.8 }, TILE_METRES);
    const rnd = this.rnd;

    /* One haystack per viewpoint, on the line that viewpoint is LAUNCHED along
     * and standing on a surface that exists.
     *
     * Both halves of that sentence are repairs. The height came from
     * `_groundAt`, which is terrain and nothing else, so all five viewpoint
     * haystacks were recorded at y 16.4 while the inner ward they stand on is
     * solid from y 14 to y 20: the thatch was invisible, its collider was
     * inside another solid, and `Parkour._softLandingAt` - which compares the
     * body's y against the hay's recorded y - could never credit any of them.
     * Three of eleven caught anything. `_deckAt` asks the collision world
     * instead, and its docstring says why `_groundAt` was not simply replaced.
     *
     * The bearing came from `atan2(vp.z, vp.x)`, the direction of the viewpoint
     * from the middle of the world, which has nothing to do with which way the
     * player is facing when they jump. Each viewpoint now publishes its own
     * `launch` point and `bearing`; see `_buildCitadel` for how each was
     * derived and what it was measured against. */
    for (const vp of this.viewpoints) {
      const spec = vp.hay;
      /* `launch ?? vp`: a viewpoint that publishes no launch point still gets
       * its haystack, laid on its own bearing from its own centre. The four
       * minarets are that case and their launch point WAS their centre, so the
       * hay lands on the identical coordinate it always did - see the comment
       * over the minaret `viewpoints.push` for why the field went away. */
      const origin = vp.launch ?? vp;
      const hx = origin.x + Math.cos(vp.bearing) * spec.run;
      const hz = origin.z + Math.sin(vp.bearing) * spec.run;
      const hy = this._deckAt(hx, hz);
      const bw = spec.r * 1.625;                 // the thatch pile around the catch radius
      B.box('thatch.roof', bw, 2.4, bw, hx, hy + 1.2, hz, rnd() * 0.4, 0xd8bd6e);
      this.track(this.physics.addBox(hx, hy + 1.0, hz, bw * 0.5, 1.0, bw * 0.5));
      const hay = { x: hx, y: hy + 2.4, z: hz, r: spec.r };
      this.haystacks.push(hay);
      vp.hay = hay;                              // resolved, for anything downstream
    }

    /* A few more in the pomerium - the open lane the souk leaves between its
     * outer ring and the curtain wall - under the rampart traversal line.
     *
     * `RAMPART_HAY_R` sits in that lane by construction: the souk's outer roof
     * face is at RING_R[6] + (dLip)/2 and the wall's inner face at 118 - 1.3,
     * and this radius is the middle of what is left. It was 104 m, which the
     * re-authored souk now builds on top of. */
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + 0.7;
      const hx = Math.cos(a) * RAMPART_HAY_R;
      const hz = Math.sin(a) * RAMPART_HAY_R;
      const hy = this._deckAt(hx, hz);
      B.box('thatch.roof', 4.6, 2.2, 4.6, hx, hy + 1.1, hz, rnd() * 0.5, 0xd2b768);
      this.track(this.physics.addBox(hx, hy + 0.95, hz, 2.3, 0.95, 2.3));
      this.haystacks.push({ x: hx, y: hy + 2.2, z: hz, r: 2.9 });
    }

    // Market stalls in the plaza, and crates that make good first steps.
    for (let i = 0; i < 34; i++) {
      const a = rnd() * TAU;
      const r = 40 + rnd() * 62;
      const px = Math.cos(a) * r;
      const pz = Math.sin(a) * r;
      const py = MESA_Y;
      const w = 1.6 + rnd() * 1.2;
      B.box('wood.plank', w, 1.0, w, px, py + 0.5, pz, rnd() * TAU, 0x7d5f3c);
      this.track(this.physics.addBox(px, py + 0.5, pz, w * 0.5, 0.5, w * 0.5));
      if (rnd() < 0.5) {
        const ca = rnd() * TAU;
        B.box('fabric.banner', w + 1.4, 0.1, w + 1.4, px, py + 2.5, pz, ca,
          rnd() < 0.5 ? 0xb8452f : 0x2f6ba8);
        // Corner posts, or the canopy is a carpet hovering over the crate.
        const ph = (w + 1.4) * 0.5 - 0.18;
        const ps = Math.sin(ca), pc = Math.cos(ca);
        for (const [ux, uz] of [[-ph, -ph], [ph, -ph], [-ph, ph], [ph, ph]]) {
          B.box('wood.beam', 0.14, 2.5, 0.14,
            px + pc * ux + ps * uz, py + 1.25, pz - ps * ux + pc * uz, ca, 0x6a4f31);
        }
      }
    }

    B.flush(this.group, (k) => this._mat(k), 'dressing');
    B.dispose();

    this._buildTrees();
    this._buildProps();

    /* Banners on the keep - the one animated thing in the world, so the town
     * does not read as a still life. Kept to a handful of separate meshes
     * because they need their own per-frame transform. */
    const banner = this._mat('fabric.banner');
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      const geo = new THREE.PlaneGeometry(2.2, 5.4, 1, 6);
      this._owned.push(geo);
      const m = new THREE.Mesh(geo, banner);
      m.position.set(Math.cos(a) * 14, MESA_Y + 24, Math.sin(a) * 14 - 4);
      m.rotation.y = a + Math.PI / 2;
      m.castShadow = true;
      m.name = 'citadel:banner';
      this.group.add(m);
      this._banners.push({ mesh: m, phase: i * 1.7, geo });
    }
  }

  /**
   * A spot on the mesa that is not inside a building.
   *
   * Rejection sampling against the roof list, which already records every
   * block's footprint. Returns null rather than a bad spot, so a caller that
   * cannot be placed simply is not - a palm growing through a wall is worse
   * than one palm fewer.
   *
   * @returns {{x:number, z:number}|null}
   */
  _openSpot(rnd, rMin, rMax, pad = 3.2) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const a = rnd() * TAU;
      const r = rMin + rnd() * (rMax - rMin);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      let ok = true;
      for (const b of this._roofs) {
        const dx = x - b.x;
        const dz = z - b.z;
        const keep = Math.max(b.w, b.d) * 0.5 + pad;
        if (dx * dx + dz * dz < keep * keep) { ok = false; break; }
      }
      if (!ok) continue;

      /* And then ask the collision world, which knows about everything the roof
       * list does not: the curtain wall, the keep, the minarets, the gate
       * towers, the rope bridges. Checking footprints alone put palms inside the
       * curtain wall, because a wall is not a roof and never appears in that
       * list. A downward cast from head height finds anything solid standing on
       * this spot regardless of which builder made it. */
      const g = this._groundAt(x, z);
      const hit = this.physics.groundHeight(x, z, g + 14, 22);
      if (hit !== null && hit > g + 0.6) continue;

      return { x, z };
    }
    return null;
  }

  /**
   * Palms, stalls, pottery and carts.
   *
   * The town was structurally finished long before it was *inhabited*: from the
   * wall the plaza read as a hundred metres of empty brown, because everything
   * built so far is either a wall to climb or a roof to land on. None of this
   * is climbing furniture - it exists so the ground has something on it at the
   * scale a person occupies, which is the difference between a level and a
   * place. Batched into the same handful of draw calls as everything else.
   */
  /**
   * Date palms and cypresses, instanced.
   *
   * ── Why these were rebuilt ────────────────────────────────────────────────
   *
   * The first version was boxes: a stack of cuboid drums for the trunk and flat
   * slabs for the fronds, merged into the props batch and flat-tinted. It read
   * as a broken umbrella on a post, and it was the last thing in this world
   * still made of literal boxes.
   *
   * ── The two things that make a palm a palm ────────────────────────────────
   *
   * 1. **The crown is a fountain, not a disc.** Fronds leave the head at every
   *    angle from near-vertical to hanging below the horizontal, and each one
   *    *arcs* rather than sloping. A ring of straight blades at one pitch is
   *    the single most common way a procedural palm goes wrong.
   * 2. **The trunk is a lattice, not a cylinder.** What is left after old
   *    fronds are shed is a column of diamond-shaped stubs, which the bark
   *    surface carries, over a trunk that leans and bows rather than standing
   *    plumb.
   *
   * Instanced: two draw calls per species regardless of how many are planted,
   * because a desert town wants a lot of them and they are all the same tree.
   */
  _buildTrees() {
    const rnd = this.rnd;

    /* ---- one palm, built once ---- */
    const trunkSecs = [];
    const H = 6.4;
    for (let i = 0; i <= 9; i++) {
      const t = i / 9;
      // Bows away from vertical as it rises, the way a palm carries its head
      // slightly off centre. Straight trunks look like scaffolding poles.
      trunkSecs.push({
        x: Math.sin(t * 1.5) * 0.34 * t,
        y: t * H,
        z: Math.cos(t * 2.1) * 0.16 * t,
        // Slight swell at the base and just under the crown, as a real one has.
        rx: 0.30 - t * 0.11 + Math.exp(-t * 9) * 0.10,
        ry: 0.30 - t * 0.11 + Math.exp(-t * 9) * 0.10,
      });
    }
    const palmTrunk = sweep(trunkSecs, 12, { capStart: false });
    const crownX = trunkSecs[9].x;
    const crownY = trunkSecs[9].y;
    const crownZ = trunkSecs[9].z;

    const fronds = [];
    const NF = 22;
    for (let f = 0; f < NF; f++) {
      const fa = (f / NF) * TAU + rnd() * 0.16;
      /* Pitch runs from nearly upright on the newest fronds to below the
       * horizontal on the oldest, which is what gives the crown its fountain
       * shape. Alternating rather than sequential so the two extremes are never
       * adjacent - a crown sorted by age reads as a shuttlecock. */
      const age = (f % 2 === 0 ? f / NF : 1 - f / NF);
      const pitch = 0.95 - age * 1.75;          // +0.95 rad up .. -0.80 rad down
      const len = 3.6 + rnd() * 1.1;
      const segs = 8;
      /* One continuous sweep along the whole frond, not a chain of separate
       * ones.
       *
       * Built segment-by-segment as independent sweeps, each piece capped its
       * own ends and carried its own frame, so a frond rendered as six detached
       * paddle-shaped leaves hanging in a row - which is exactly how the first
       * crown looked. Collecting the stations first and sweeping once gives a
       * single surface with a continuous normal along its length, which is what
       * a frond is. */
      const stations = [];
      let px = crownX;
      let py = crownY;
      let pz = crownZ;
      let ang = pitch;
      for (let s = 0; s <= segs; s++) {
        const t = s / segs;
        // Narrow and long: a date frond is a spine carrying leaflets, and the
        // leaflet detail is in the surface rather than in the silhouette.
        // Widest a third of the way out, tapering to a point.
        const w = (0.10 + Math.sin(Math.pow(t, 0.8) * Math.PI) * 0.15) * (1 - t * 0.55);
        stations.push({ x: px, y: py, z: pz, rx: Math.max(0.012, w), ry: 0.016 });
        if (s === segs) break;
        const segLen = len / segs;
        // Curvature accumulates along the frond, so it arcs over instead of
        // running straight out - the arc is most of the silhouette.
        ang -= (0.13 + age * 0.085);
        px += Math.cos(fa) * Math.cos(ang) * segLen;
        py += Math.sin(ang) * segLen;
        pz += Math.sin(fa) * Math.cos(ang) * segLen;
      }
      fronds.push(sweep(stations, 4, { capStart: false }));
    }
    // Date clusters hanging under the crown.
    for (let d = 0; d < 3; d++) {
      const da = (d / 3) * TAU + 0.4;
      fronds.push(blob(0.26, 0.34, 0.26,
        crownX + Math.cos(da) * 0.42, crownY - 0.42, crownZ + Math.sin(da) * 0.42, 8));
    }
    const palmCrown = mergeGeometries(fronds.map(g => g.index ? g.toNonIndexed() : g), false);
    for (const g of fronds) g.dispose();

    /* ---- one cypress ---- */
    const cypTrunk = sweep([
      { y: 0, z: 0, rx: 0.16, ry: 0.16 },
      { y: 1.6, z: 0, rx: 0.11, ry: 0.11 },
      { y: 3.4, z: 0, rx: 0.07, ry: 0.07 },
    ], 8, { capStart: false });
    // A flame, not a cone: cypresses are widest a third up and taper to a point.
    const cypSecs = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const r = Math.sin(Math.pow(t, 0.55) * Math.PI * 0.92) * 0.92;
      cypSecs.push({ y: 0.6 + t * 6.6, z: 0, rx: Math.max(0.03, r), ry: Math.max(0.03, r) });
    }
    const cypCrown = sweep(cypSecs, 12);

    /* ---- plant them ---- */
    const specs = [
      { trunk: palmTrunk, crown: palmCrown, bark: 'bark.palm', leaf: 'foliage.frond',
        count: 46, rMin: 28, rMax: 124, pad: 4.2, scale: [0.82, 1.25] },
      { trunk: cypTrunk, crown: cypCrown, bark: 'wood.beam', leaf: 'foliage.frond',
        count: 22, rMin: 34, rMax: 118, pad: 3.4, scale: [0.75, 1.15] },
    ];
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();

    for (const sp of specs) {
      const placed = [];
      for (let i = 0; i < sp.count; i++) {
        const s = this._openSpot(rnd, sp.rMin, sp.rMax, sp.pad);
        if (!s) continue;
        const k = sp.scale[0] + rnd() * (sp.scale[1] - sp.scale[0]);
        placed.push({ x: s.x, y: this._groundAt(s.x, s.z), z: s.z, k, yaw: rnd() * TAU });
      }
      if (!placed.length) continue;

      const barkMesh = new THREE.InstancedMesh(
        sp.trunk, this._mat(sp.bark, { vertexColors: false }), placed.length);
      const leafMesh = new THREE.InstancedMesh(
        sp.crown, this._mat(sp.leaf, { vertexColors: false }), placed.length);
      barkMesh.name = `citadel:tree.trunk`;
      leafMesh.name = `citadel:tree.crown`;
      barkMesh.castShadow = true;
      barkMesh.receiveShadow = true;
      leafMesh.castShadow = true;
      // Crowns do not receive: self-shadowing a mass of thin fronds costs a
      // shadow lookup per frond and returns acne, not shade.
      leafMesh.receiveShadow = false;
      for (let i = 0; i < placed.length; i++) {
        const p = placed[i];
        e.set(0, p.yaw, 0);
        q.setFromEuler(e);
        pos.set(p.x, p.y, p.z);
        scl.setScalar(p.k);
        m4.compose(pos, q, scl);
        barkMesh.setMatrixAt(i, m4);
        leafMesh.setMatrixAt(i, m4);
        // A trunk collider, so a palm is something you can take cover behind
        // rather than walk through.
        this.track(this.physics.addBox(p.x, p.y + 1.6 * p.k, p.z, 0.26 * p.k, 1.6 * p.k, 0.26 * p.k));
      }
      barkMesh.instanceMatrix.needsUpdate = true;
      leafMesh.instanceMatrix.needsUpdate = true;
      this.group.add(barkMesh, leafMesh);
      this._owned.push(sp.trunk, sp.crown);
    }
  }

  _buildProps() {
    const B = new Batch({ ao: 0.4, sky: 0.34, grime: 0.5, span: 2.2 }, TILE_METRES);
    const rnd = this.rnd;

    /* Trees moved out to _buildTrees.
     *
     * They were boxes merged into this prop batch. They are instanced now,
     * with real bark and frond surfaces, and neither the geometry nor the
     * material has any business being built alongside the crates. */

    /* ---- market stalls ---- */
    for (let i = 0; i < 22; i++) {
      const s = this._openSpot(rnd, 34, 108, 4.6);
      if (!s) continue;
      const gy = this._groundAt(s.x, s.z);
      const a = rnd() * TAU;
      const sw = 3.2 + rnd() * 1.4;
      const sd = 2.4 + rnd() * 0.9;
      const ph = 2.5;
      const cs = Math.cos(a);
      const sn = Math.sin(a);
      // Four posts at the corners, in the stall's own frame.
      for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const lx = ox * sw * 0.5;
        const lz = oz * sd * 0.5;
        const wx = s.x + cs * lx + sn * lz;
        const wz = s.z - sn * lx + cs * lz;
        B.box('wood.beam', 0.16, ph, 0.16, wx, gy + ph * 0.5, wz, a, 0x7a5a38);
      }
      /* Striped canopy: alternating bands, because a market awning is the one
       * place in a sand-coloured town where saturated colour belongs, and it is
       * what the eye picks the plaza out by from the rooftops. */
      const bands = 5;
      const c1 = rnd() < 0.5 ? 0xc4472e : 0x2f6ba8;
      const c2 = 0xe8dcc0;
      for (let b = 0; b < bands; b++) {
        const lz = (b / (bands - 1) - 0.5) * sd;
        const wx = s.x + sn * lz;
        const wz = s.z + cs * lz;
        B.box('fabric.banner', sw + 0.7, 0.09, sd / bands, wx, gy + ph + 0.12, wz, a, b % 2 ? c1 : c2);
      }
      this.track(this.physics.addRotatedBox(
        _v1.set(s.x, gy + ph + 0.12, s.z), _v2.set((sw + 0.7) * 0.5, 0.06, sd * 0.5), a
      ));
      // Counter and the goods on it.
      B.box('wood.plank', sw, 0.9, sd * 0.5, s.x, gy + 0.45, s.z, a, 0x8a6842);
      this.track(this.physics.addRotatedBox(
        _v1.set(s.x, gy + 0.45, s.z), _v2.set(sw * 0.5, 0.45, sd * 0.25), a
      ));
      for (let g = 0; g < 3; g++) {
        const lx = (g / 2 - 0.5) * sw * 0.7;
        B.box('fabric.banner', 0.5, 0.32, 0.5, s.x + cs * lx, gy + 1.06, s.z - sn * lx,
          rnd() * TAU, pick(rnd, [0xb8452f, 0xc98a2a, 0x6d8a3a, 0x8a4a7a]));
      }
    }

    /* ---- pottery and sacks against the walls ---- */
    for (let i = 0; i < 40; i++) {
      const s = this._openSpot(rnd, 28, 124, 2.4);
      if (!s) continue;
      const gy = this._groundAt(s.x, s.z);
      const n = 2 + ((rnd() * 3) | 0);
      for (let k = 0; k < n; k++) {
        const ox = (rnd() - 0.5) * 1.8;
        const oz = (rnd() - 0.5) * 1.8;
        const ph = 0.5 + rnd() * 0.5;
        const pw = 0.36 + rnd() * 0.26;
        B.box('roof.tile', pw, ph, pw, s.x + ox, gy + ph * 0.5, s.z + oz, rnd() * TAU,
          pick(rnd, [0x9a6a44, 0xb08050, 0x8a5a3a, 0xc09468]));
      }
    }

    /* ---- carts ---- */
    for (let i = 0; i < 9; i++) {
      const s = this._openSpot(rnd, 38, 112, 5);
      if (!s) continue;
      const gy = this._groundAt(s.x, s.z);
      const a = rnd() * TAU;
      const cs = Math.cos(a);
      const sn = Math.sin(a);
      B.box('wood.plank', 2.8, 0.5, 1.6, s.x, gy + 0.95, s.z, a, 0x7d5f3c);
      this.track(this.physics.addRotatedBox(
        _v1.set(s.x, gy + 0.95, s.z), _v2.set(1.4, 0.25, 0.8), a
      ));
      // Sideboards, so it is a cart and not a plank on legs.
      for (const oz of [-1, 1]) {
        B.box('wood.plank', 2.8, 0.5, 0.12, s.x + sn * oz * 0.8, gy + 1.4, s.z + cs * oz * 0.8, a, 0x6d5133);
      }
      // Wheels, and the shafts a horse would sit between.
      for (const ox of [-1, 1]) {
        const wx = s.x + cs * ox * 0.95;
        const wz = s.z - sn * ox * 0.95;
        for (const oz of [-1, 1]) {
          B.box('wood.beam', 0.14, 1.2, 1.2, wx + sn * oz * 0.86, gy + 0.6, wz + cs * oz * 0.86, a, 0x5d462c);
        }
      }
      B.box('wood.beam', 2.2, 0.12, 0.12, s.x + cs * 2.4, gy + 0.8, s.z - sn * 2.4, a, 0x6d5133);
    }

    B.flush(this.group, (k) => this._mat(k), 'props');
    B.dispose();
  }

  /** Plateau-aware ground height, without a raycast. */
  _groundAt(x, z) {
    return terrainH(Math.hypot(x, z));
  }

  /**
   * The surface a falling body actually lands on: terrain PLUS everything
   * built on top of it.
   *
   * ── Why this is a second method and not a better `_groundAt` ─────────────
   *
   * `_groundAt` is `terrainH(hypot(x, z))` and it has to stay that way. Nine
   * call sites read it, and two of them - `_openSpot` and `_nudgeClear` - use
   * it as the *terrain datum* a physics cast is compared against:
   *
   *     const g = this._groundAt(x, z);
   *     const hit = this.physics.groundHeight(x, z, g + 12, 20);
   *     return hit !== null && hit > g + 0.6;      // is something standing here
   *
   * Make `_groundAt` a physics query and `g === hit` on every clear column, so
   * `hit > g + 0.6` can never fire and both clearance probes silently become
   * no-ops. That reintroduces the embedded-in-a-wall defect `_nudgeClear`'s own
   * docstring exists to record. `_nudgeClear` is on the path of every NPC
   * spawn, the player spawn and every portal, so the failure would be the whole
   * cast standing in masonry with a roof over their heads - which is exactly
   * what the audit found the last two times this world's PRNG stream moved.
   *
   * So: terrain-only stays terrain-only, and anything that wants the REAL deck
   * asks for it by name. `physics.groundHeight` already exists and is already
   * called during this very build, so there is no ordering problem - the only
   * requirement is that the thing being stood on has been built first, which
   * for `_buildDressing` (last but for the spawns) is everything.
   *
   * @param {number} x
   * @param {number} z
   * @param {number} [from] height the downward cast starts at
   * @param {number} [dist] how far it may travel
   * @returns {number} the top of the highest solid over this column, or the
   *   terrain height where the cast finds nothing at all.
   */
  _deckAt(x, z, from = 400, dist = 900) {
    const g = this._groundAt(x, z);
    const hit = this.physics.groundHeight(x, z, from, dist);
    return hit === null || hit < g ? g : hit;
  }

  /**
   * A standing spot on a souk roof, moved off whatever is standing in the
   * middle of it.
   *
   * 30% of souk blocks carry a dome, and a dome is a collider standing proud
   * of the deck at its own centre - `dr*0.72 x dr*0.32 x dr*0.72` about
   * `(r.x, r.z)`, where `dr = min(w, d) * 0.42`. Anything that takes a roof's
   * published centre as a place to PUT something therefore puts it inside a
   * solid for three roofs in ten. Measured on the built world, that was 8 of
   * the 30 citadel relic sites sealed inside a dome, invisible from the deck
   * and 2.49-2.62 m from the nearest place a body can stand against a 2.00 m
   * pickup radius - not collectable at all without mantling the dome.
   *
   * Asked of the collision world rather than of the dome probability: try the
   * centre, then four offsets along the building's own axes, and take the
   * first that answers with the roof's own height. Both axes matter. The
   * tangential half-width is `w/2 - 1.6` against a dome half-extent of
   * `min(w,d)*0.42*0.72 = 2.12 m`, so a ring whose solved `w` falls under
   * 7.44 m fails BOTH tangential probes - and the radial half-extent is
   * 3.85 m, so a radial probe would still clear. An earlier version of this
   * block wrote four tuples but left `oz` at zero in every one of them, which
   * made both `sin(rot)*oz` and `cos(rot)*oz` dead and left only the two
   * tangential candidates its own comment did not describe.
   *
   * `_deckAt` is the same probe the haystacks use.
   *
   * @param {{x:number,y:number,z:number,w:number,d:number}|null} r
   * @returns {{x:number,y:number,z:number}|null}
   */
  _deckSpot(r) {
    if (!r) return null;
    const rot = Math.PI * 0.5 - Math.atan2(r.z, r.x);
    const ux = Math.cos(rot);
    const uz = -Math.sin(rot);              // the building's local +X
    const out = r.w * 0.5 - 1.6;            // tangential
    const rOut = r.d * 0.5 - 1.6;           // radial
    for (const [ox, oz] of [[0, 0], [out, 0], [-out, 0], [0, rOut], [0, -rOut]]) {
      const x = r.x + ux * ox + Math.sin(rot) * oz;
      const z = r.z + uz * ox + Math.cos(rot) * oz;
      if (Math.abs(this._deckAt(x, z) - r.y) < 0.06) return { x, y: r.y, z };
    }
    return { x: r.x, y: r.y, z: r.z };
  }

  /* ------------------------------------------------------------------ */
  /* Spawns, portals, minimap                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Move a hand-placed point off whatever it landed inside.
   *
   * Every spawn in this world is authored as a literal coordinate - "the keeper
   * stands at 6, 92" - but the souk around those coordinates is generated, and
   * a generated town moves whenever anything upstream of its PRNG changes. It
   * has, twice. The result was NPCs standing inside houses: the audit found
   * Rafiq the Keeper and a sentinel embedded in walls, patrolling on the spot
   * with a roof three metres over their heads.
   *
   * Rather than re-authoring the coordinates against the current layout - which
   * would only survive until the next change - the intent is kept and the point
   * is pushed to the nearest clear ground. A spiral, so a blocked spawn ends up
   * a couple of metres away in the street rather than somewhere unrelated.
   *
   * @param {THREE.Vector3} pos mutated in place
   * @param {number} [pad] clearance wanted around the point
   */
  _nudgeClear(pos, pad = 1.6) {
    const blocked = (x, z) => {
      for (const b of this._roofs) {
        const dx = x - b.x;
        const dz = z - b.z;
        const keep = Math.max(b.w, b.d) * 0.5 + pad;
        if (dx * dx + dz * dz < keep * keep) return true;
      }
      // And anything else solid standing here - walls, towers, the keep.
      const g = this._groundAt(x, z);
      const hit = this.physics.groundHeight(x, z, g + 12, 20);
      return hit !== null && hit > g + 0.6;
    };
    if (!blocked(pos.x, pos.z)) return pos;
    // Golden-angle spiral: even coverage, and it never revisits a direction.
    for (let i = 1; i <= 96; i++) {
      const a = i * 2.399963;
      const r = 1.2 + i * 0.28;
      const x = pos.x + Math.cos(a) * r;
      const z = pos.z + Math.sin(a) * r;
      if (Math.hypot(x, z) > MESA_R - 4) continue;   // stay on the plateau
      if (!blocked(x, z)) {
        pos.x = x;
        pos.z = z;
        pos.y = this._groundAt(x, z) + 0.2;
        return pos;
      }
    }
    return pos;
  }

  _fillSpawns() {
    /* Just inside the gate, facing the citadel.
     *
     * Yaw 0, not PI: characters look down -Z at yaw 0, and the town is at -Z
     * from here. Facing PI put the player's back to the entire world and their
     * nose against the return portal, which is the exact opposite of the
     * establishing shot this spawn exists to frame - the souk stepping up ring
     * by ring to the great tower. */
    this.playerSpawn.set(0, MESA_Y + 0.3, 104);
    this.playerSpawnYaw = 0;

    this.portalSpecs.push({
      position: new THREE.Vector3(0, MESA_Y + 0.3, 112),
      rotationY: Math.PI,
      target: 'station',
      label: 'Aether Station',
      accent: 0x4de3ff,
    });

    /**
     * A named civilian. `extra` is anything `NPCManager.spawnForWorld` reads
     * off a spawn descriptor - `role`, `vendorCategories`, `vendorTitle`,
     * `signLines`, `isQuestManager` - so a counter in the citadel is authored
     * here rather than being a second kind of thing somewhere else. Copied in
     * shape from `StationWorld._fillSpawns`, which is where the convention is.
     *
     * These four carried a name and a persona and nothing else, and the cost
     * was not cosmetic. With no `role`, the only route into a citadel shop was
     * `Marketplace._isVendor`'s VENDOR_WORDS regex, which matches Hafsa's
     * "cloth stall" and misses Rafiq's archive and Bashir's stable entirely -
     * two of the three counters on the mesa could not be opened at all, and
     * `WORLD_MARKETS.citadel`'s price table had nowhere to be quoted.
     */
    const F = (name, persona, x, z, extra) => ({
      position: new THREE.Vector3(x, MESA_Y + 0.2, z),
      type: 'friendly',
      name,
      persona,
      ...extra,
    });
    /* Between them the three counters stock all six marketplace categories.
     * That is deliberate rather than tidy: there is exactly one portal off this
     * mesa, so a category nobody stocks is a category the player cannot buy in
     * this world. Split by trade, on the medieval `TRADE` pattern - an archive
     * keeps physic and ink, a dye yard keeps cloth and the tools of the dyeing,
     * and the horse lines under the wall keep the garrison's tack and its
     * spare arms on the same racks. */
    this.npcSpawns.push(
      F('Rafiq the Keeper', 'Keeper of the citadel archive; speaks in riddles about the old order.', 6, 92, {
        role: 'vendor',
        vendorCategories: ['health', 'spells'],
        vendorTitle: 'Archive & Physic',
        signLines: ['ARCHIVE & PHYSIC', 'SUNSPIRE CITADEL'],
      }),
      F('Hafsa the Dyer', 'Runs the cloth stall by the gate; knows every roof in the souk.', -12, 84, {
        role: 'vendor',
        vendorCategories: ['cosmetic', 'tools'],
        vendorTitle: 'Cloth & Colour',
        signLines: ['CLOTH & COLOUR', 'SUNSPIRE CITADEL'],
      }),
      F('Bashir the Ostler', 'Tends the horses below the wall; gruff, fond of his animals.', 20, 96, {
        role: 'vendor',
        vendorCategories: ['mounts', 'weapons'],
        vendorTitle: 'Harness & Arms',
        signLines: ['HARNESS & ARMS', 'SUNSPIRE CITADEL'],
      }),
      /* Yusra is deliberately NOT a counter and NOT a quest desk, and both
       * halves of that were measured rather than chosen.
       *
       * She is a `talk` target in three shipped quests (Q33, Q36, Q40), and
       * `HUD.js` emits `interact` rather than `talk` for a quest manager - so
       * flagging her `isQuestManager` breaks all three, which
       * scripts/tests/quest-content.test.mjs says out loud. The world already
       * has a desk: `NPCManager._spawnQuestManagers` plants Aldric Storne at
       * (8, 14.3, 88), four metres from Rafiq.
       *
       * The role is `wanderer` - which is what `spawnForWorld` was already
       * giving all four of these characters by default - and it is written
       * down rather than left implicit because it is now load-bearing: the
       * other three have been given posts, so Yusra is the only NPC in the
       * citadel carrying the role at all, and Q31 step 2 is `talk:"wanderer"`.
       */
      F('Yusra the Falconer', 'Flies the eagles from the great tower; watches everything.', -4, 40, {
        role: 'wanderer',
      }),
    );
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      this.npcSpawns.push({
        position: new THREE.Vector3(Math.cos(a) * 62, MESA_Y + 0.2, Math.sin(a) * 62),
        type: 'hostile',
      });
    }

    /* Every spawn, hand-placed or generated, gets pushed clear of the town.
     *
     * Done in one pass at the end rather than at each site so nothing can be
     * added later and quietly skip it - which is exactly how the hostile ring
     * came to be laid down on a fixed radius of 62 m straight through whatever
     * the souk had generated there. */
    for (const s of this.npcSpawns) this._nudgeClear(s.position, 1.8);
    this._nudgeClear(this.playerSpawn, 2.2);
    for (const p of this.portalSpecs) this._nudgeClear(p.position, 2.6);

    /* Minimap. The plateau, the wall ring and the citadel - enough to orient by
     * without drawing four hundred houses. */
    this.minimapShapes.push(
      { kind: 'circle', x: 0, z: 0, r: MESA_R + 20, fill: 0x2a2418 },
      { kind: 'circle', x: 0, z: 0, r: MESA_R, fill: 0x4a412c },
      { kind: 'circle', x: 0, z: 0, r: 118, stroke: 0xc8b68e, width: 3 },
      { kind: 'circle', x: 0, z: 0, r: 30, fill: 0x6b5f42 },
      { kind: 'rect', x: 0, z: -18, w: 12, d: 12, fill: 0xd6c69c },
      { kind: 'rect', x: 0, z: 118, w: 22, d: 10, fill: 0xc8b68e }
    );
    for (const t of this._towers) {
      this.minimapShapes.push({ kind: 'circle', x: t.x, z: t.z, r: 3.2, fill: 0xbfae8a });
    }

    this._publishVenues();
  }

  /**
   * The souk roof on `ring` whose bearing is closest to `bearing`.
   *
   * Checkpoints are taken from the built world rather than recomputed from
   * `SOUK_RINGS`, so a route point is always the exact centre of a deck that
   * exists - including the +/-0.12 m of height noise. A trial whose checkpoint
   * floats 0.12 m inside a roof is a trial the swept validator never fires.
   *
   * @param {number} ring
   * @param {number} bearing
   * @returns {{x:number,y:number,z:number,w:number,d:number,ring:number}|null}
   */
  _roofNear(ring, bearing) {
    let best = null;
    let bestD = Infinity;
    for (const r of this._roofs) {
      if (r.ring !== ring) continue;
      const d = Math.abs(wrapPi(Math.atan2(r.z, r.x) - bearing));
      if (d < bestD) { bestD = d; best = r; }
    }
    return best;
  }

  /**
   * Rooftop trial venues, published in the shape `MinigameManager._readVenue`
   * reads (`:480-512`).
   *
   * ── What is published and what is deliberately NOT ────────────────────────
   *
   * `kind: 'rooftop'` has no factory registered yet, and `MinigameManager.arm`
   * treats that as "a published slot, not an error" - the venue is inert until
   * the game module lands, which is exactly how the tennis court and the ski
   * slope shipped. So these three descriptors can go in now and light up when
   * the trial module registers `rooftop`.
   *
   * `config.checkpoints` are read out of the ASSEMBLED world by `_roofNear`,
   * not recomputed from the ring table, because the deck heights carry a small
   * per-building noise term and a checkpoint that misses its deck by 12 cm is
   * a checkpoint the swept validator never crosses.
   *
   * `config.ringRadius` is 2.6 m and it is here because the only in-world
   * waypoint marker that exists, `RaceRings`, hard-codes `DRAGON_RACE
   * .ringRadius` = 5.2 m. A 5.2 m torus is wider than most of these roofs. The
   * marker has to take the radius from the venue.
   *
   * There are NO bronze/silver/gold times. Those have to come from measured
   * route times and nothing in this file has run a route; `config.routeLength`
   * is the summed 3D length of the checkpoint chain, which IS measured, and is
   * the honest input to deriving them. Publishing a guessed par time would be
   * the fourth number in this project to be computed instead of driven.
   */
  _publishVenues() {
    this.minigameVenues.length = 0;
    // A checkpoint at a roof's centre is a checkpoint inside a dome for three
    // roofs in ten, and a ring the player cannot pass through is not a
    // checkpoint. `_deckSpot` is the shared answer; `_roofs[].anchor` carries
    // the same answer to everything else that puts something on a roof.
    const P = (r) => this._deckSpot(r);
    const outer = SOUK_RINGS.length - 1;

    /* The dash stays on the two outer rings, where every tangential gap is
     * 2.83-3.68 m and a sprint jump clears 4.25: it is the ring that teaches.
     * The ascent crosses every ring inward, which by construction is the whole
     * gradient - sprint, sprint, sprint, leap, leap, leap-and-mantle. */
    const dash = [];
    for (let k = 0; k < 9; k++) {
      const b = GATE_BEARING - 0.5 - (k / 8) * (TAU - 1.4);
      dash.push(P(this._roofNear(k % 2 ? outer - 1 : outer, b)));
    }
    const ascent = [];
    for (let ring = outer; ring >= 0; ring--) {
      ascent.push(P(this._roofNear(ring, GATE_BEARING + 0.85 + (outer - ring) * 0.18)));
    }
    const skyline = [];
    const great = this._towers.find((t) => t.great);
    const span = this.ropeBridges.find((b) => b.id === 'great-tower-perimeter');
    const land = this.ropeBridges.find((b) => b.id === 'great-tower-perimeter-landfall');
    if (great && span && land) {
      skyline.push({ x: great.x, y: great.y, z: great.z });
      skyline.push(span.mid);                      // a real plank, not a midpoint
      skyline.push({ x: span.b.x, y: span.b.y, z: span.b.z });
      skyline.push({ x: land.b.x, y: land.b.y, z: land.b.z });
    }

    const clean = (pts) => pts.filter(Boolean);
    const length = (pts) => {
      let sum = 0;
      for (let i = 1; i < pts.length; i++) {
        sum += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y, pts[i].z - pts[i - 1].z);
      }
      return sum;
    };
    const venue = (id, kind, label, pts, reward, note, rival) => {
      const checkpoints = clean(pts);
      if (checkpoints.length < 3) return;
      /* The disc has to hold the WHOLE ROUTE, not the start line.
       *
       * `MinigameManager.fixedUpdate` calls `abort('left')` LEAVE_GRACE_S = 9 s
       * after the player leaves this disc. A start-line-sized disc therefore
       * abandons every contest that lasts longer than nine seconds, which is
       * all of them: measured on this world, the dash reaches 198.4 m from
       * checkpoint 0, the ascent 96.4 m, and the skyline swings 47.1 m of Dy.
       * Gold on the dash is 91.8 s, so no trial in this world could ever be
       * finished. `venueBounds` is exported by `RooftopTrial` for exactly this
       * and returns the numbers below; `SportsWorld` records the same
       * requirement twice in comments, over the ski slope and over the track.
       *
       * The START LINE does not move with it: `createRooftopTrial` refuses to
       * build unless the player is within START_RADIUS = 12 m of checkpoint 0,
       * which is the same split the ski run uses - a wide venue with a
       * module-enforced gate on where the run begins. */
      const b = venueBounds(checkpoints);
      this.minigameVenues.push({
        id,
        kind,
        label,
        centre: new THREE.Vector3(b.centre.x, b.centre.y, b.centre.z),
        radius: b.radius,
        yTolerance: b.yTolerance,
        reward,
        rival,
        // A world with parkour switched off cannot host a parkour contest.
        requires: 'parkour',
        config: { note, checkpoints, ringRadius: 2.6, routeLength: length(checkpoints) },
      });
    };

    /* Each trial names its rival, the way `SportsWorld` names all four of its
     * own: `RooftopTrial` falls back to "the pacesetter" when a venue does not,
     * and three ghosts all called the pacesetter is a rival nobody remembers
     * losing to. Souk runners, so they belong to the roofs they run on. */
    venue('citadel_souk_dash', 'rooftop', 'Souk Rooftop Dash', dash, 10,
      'Rings 6 and 5 only: every crossing on this route is inside a sprint jump.',
      { name: 'Nadira the Swift' });
    venue('citadel_ascent', 'rooftop', 'The Long Ascent', ascent, 14,
      'One roof per ring, gate to ward. Crosses the whole authored gradient.',
      { name: 'Idris Roof-Runner' });
    venue('citadel_skyline', 'rooftop', 'The Skyline', skyline, 18,
      'Great tower, the long span, the wall, and back down into the souk.',
      { name: 'Zeynab of the Spans' });
  }

  /* ------------------------------------------------------------------ */
  /* Frame                                                               */
  /* ------------------------------------------------------------------ */

  update(dt) {
    this._time += dt;
    // Banners only - everything else in this world is static, and it should be:
    // a climbing surface that moves is a climbing surface that betrays you.
    for (const b of this._banners) {
      b.mesh.rotation.z = Math.sin(this._time * 1.6 + b.phase) * 0.09;
    }
  }

  dispose() {
    for (const g of this._owned) g.dispose?.();
    this._owned.length = 0;
    this._banners.length = 0;
    this._roofs.length = 0;
    this._towers.length = 0;
    this.haystacks.length = 0;
    this.viewpoints.length = 0;
    this.ropeBridges.length = 0;
    this.minigameVenues.length = 0;
    this._matCache?.clear();
    super.dispose();
  }
}

export default CitadelWorld;
