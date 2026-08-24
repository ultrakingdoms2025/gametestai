import * as THREE from 'three';
import { COLLISION_LAYER } from '../physics/Physics.js';
import { allows } from '../worlds/WorldRules.js';
import { hazeAdditive } from './Loot.js';

/**
 * Hidden relics - the collectible that pays.
 *
 * ── Why this is not just another cache ────────────────────────────────────
 * `Caches` answers "is there a reason to dive and to fly": a handful of
 * destinations, each a visible glowing pickup, restocking on a timer. Relics
 * answer a different question - "is there a reason to look at the *architecture*"
 * - and that changes every design decision:
 *
 *   - **Many, not few.** Thirty per world rather than six. A collectible you
 *     find twice an hour is a destination; one you find every couple of minutes
 *     is a reason to keep your eyes up while you travel.
 *   - **They pay credits directly.** No inventory slot, no carrying decision,
 *     no trip back to a vendor. Picking one up is the whole loop.
 *   - **They never come back.** A restocking collectible is a farm; a finite
 *     one is a map you are gradually completing. The count is the progress bar.
 *   - **They are hidden by *placement*, not by stealth.** Every one sits on a
 *     ledge, a rooftop, a parapet or a beam - somewhere you have to climb to,
 *     which is what ties them to the parkour rather than to a search.
 *
 * ── Finding somewhere to hide one ─────────────────────────────────────────
 * The world publishes `_roofs` and `_towers` if it has them, and those are used
 * first because a hand-placed roof is a better hiding place than anything a
 * random probe will find. Beyond that the search is the same shape as the one
 * in `Caches`: dart at the map, cast down, and keep the hit if it is a flat
 * surface that is meaningfully above its surroundings.
 *
 * ── Rendering ─────────────────────────────────────────────────────────────
 * One InstancedMesh for every relic in the world, plus one for their glows.
 * Thirty separate meshes with thirty separate materials would be thirty draw
 * calls for what is visually a single repeated object.
 */

/**
 * How many to hide per world, on a 400 m world.
 *
 * Scaled by playable area from there, in `_onWorld`. Thirty relics over the
 * medieval valley is one every 5,300 m², which is a find every couple of
 * minutes; the same thirty over the station's five decks is one every 74,000 m²,
 * which is a mechanic the player never notices exists.
 */
const PER_WORLD = 30;
/** The extent `PER_WORLD` and `TRIES` are calibrated against. */
const BASE_EXTENT = 400;
/**
 * Ceiling on the scaled count.
 *
 * This is also the capacity of the two InstancedMeshes below, and that is the
 * reason it exists rather than letting the area scale run free: an instanced
 * mesh is allocated once at construction and silently ignores any instance past
 * its count, so a world that wanted more relics than this would place them,
 * count them, and draw only the first hundred and ten.
 */
const MAX_PER_WORLD = 110;
/** Credits each is worth. */
const VALUE = 120;

/* ── The prizes ─────────────────────────────────────────────────────────────
 *
 * A quest can only pay credits (`QuestSystem._completeQuest`), and until now so
 * could a relic: `_collect` added `VALUE` and one coin, and the thirtieth relic
 * paid exactly what the first one did. Thirty finds across a world is the
 * longest single activity in it, and it ended with a slightly larger number in
 * the corner of the screen.
 *
 * So the set pays in things credits cannot buy back: an item at the halfway
 * mark, and a cosmetic plus a permanent mount power for finishing. All three
 * grants are made through the published contracts (`Inventory.acquire`,
 * `Cosmetics.unlock`, `MountManager.grantPower`), each of which silently
 * refuses an id it does not know - so this file holds no copy of any
 * catalogue and cannot drift out of step with one.
 */
/** Handed over the first time a world is half stripped. */
export const HALFWAY_ITEM = 'speed_boost_50';
export const HALFWAY_ITEM_QTY = 2;
/** Every relic in a world: a marketplace skin, free. */
export const SET_COSMETIC = 'char_jade';
/** ..and a horse that can carry what you have been picking up. */
export const SET_POWER = { mount: 'horse', power: 'strength', tier: 1 };
/** Completion bonus, on top of the last relic's own `VALUE`. */
export const SET_CREDITS = 500;

/** Pickup radius. Generous - you should not have to stand exactly on it. */
const PICKUP_R = 2.0;
/** Minimum separation, so a rooftop never gets two. */
const MIN_APART = 14;
/**
 * How far a stored relic id may be from a live site and still be the same relic.
 *
 * MUST stay below `MIN_APART / 2`. `_tooClose` refuses any site within
 * `MIN_APART` of another in XZ, on BOTH the authored deal and the dart pass, so
 * with a tolerance under half that separation the assignment from stored keys to
 * live sites is provably ONE-TO-ONE: no key can lie within `MATCH_R` of two
 * sites, and no site can be claimed by two keys.
 *
 * This is what makes a position usable as an identity at all. Matching on the
 * quantised STRING would flip the moment a deck drifted across a cell boundary;
 * matching on nearest-within-tolerance absorbs that, and a drift larger than the
 * tolerance drops the relic back to un-found - the generous direction.
 */
export const MATCH_R = 6;
/** How high above its surroundings a spot must be to count as hidden. */
const MIN_PROMINENCE = 2.5;
/** Placement attempts per relic. */
const TRIES = 90;
/** Keep clear of the invisible boundary colliders that fence each world. */
const EDGE_INSET = 22;

const _rv = new THREE.Vector3();
const _rq = new THREE.Quaternion();
const _rs = new THREE.Vector3(1, 1, 1);
const _rm = new THREE.Matrix4();
const _down = new THREE.Vector3(0, -1, 0);
const _up = new THREE.Vector3(0, 1, 0);
/** Refilled by the `markers` getter, which `Minimap` calls every frame. */
const _markerScratch = [];

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
 * Which part of the world an authored anchor belongs to.
 *
 * Read off the tags the world ALREADY puts on its own decks rather than off a
 * position, because a position needs a table of district boxes and a table of
 * district boxes is a second copy of the world's layout living in here. The
 * citadel tags a souk roof with its `ring` and an outer-region deck with its
 * `region`; a world that tags neither has one district called `core` and gets
 * exactly the behaviour this file had before districts existed.
 *
 * The souk splits by RING and not as one lump on purpose: the rings are the
 * world's authored difficulty gradient (design §4.2), so "one relic per ring
 * per round" is the same statement as "the collection walks the gradient".
 * Lumping the souk together and dealing it one anchor a round against six
 * regions would have taken the mesa from 64 relics to 8 - fewer than the 30 it
 * held before the map was ever expanded.
 *
 * @param {{region?:string, ring?:number}} a a published roof or tower
 * @returns {string}
 */
function districtOf(a) {
  if (typeof a?.region === 'string' && a.region) return a.region;
  if (Number.isFinite(a?.ring)) return `ring:${a.ring}`;
  return 'core';
}

/**
 * The halo's alpha, as a function of distance from the middle of its quad.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 * `relics:glow` was an untextured `PlaneGeometry` with a flat additive colour
 * on it, which is not a glow, it is a card: a bright square with a hard
 * boundary all the way round, obvious the moment you walked up to one and -
 * with bloom off - reading as dozens of plain white rectangles scattered over
 * the landscape. Nothing was wrong with the blending or the placement. There
 * was simply no falloff anywhere in the material, so every texel of the quad
 * was as bright as the middle and the edge of the quad was the edge of the
 * light.
 *
 * ── The shape ──────────────────────────────────────────────────────────────
 * Smoothstep on the radius with a little gain, so there is a saturated core
 * out to about a quarter of the quad and a long tail from there. Two
 * properties matter and both are asserted in `relic-glow.test.mjs`:
 *
 *   - it reaches EXACTLY zero at d = 1 and stays there, so the quad's own
 *     edge and its corners (d = 1.41) contribute nothing at all. That is what
 *     removes the boundary; a falloff that still had 2% left at the rim would
 *     leave a faint square in bloom, which is the same defect quieter.
 *   - it never increases. A ramp with a bump in it reads as a ring.
 *
 * A function rather than a literal texture so it can be checked without a GPU,
 * and a texture rather than a shader patch so the material stays a stock
 * `MeshBasicMaterial` - see `_build` for why that matters to the program count.
 *
 * @param {number} d distance from the centre in half-widths: 0 at the middle,
 *   1 at the edge of the quad, 1.41 at a corner.
 */
export function glowFalloff(d) {
  const t = Math.max(0, Math.min(1, 1 - d));
  return Math.min(1, 1.35 * t * t * (3 - 2 * t));
}

/** Edge of the halo texture, in texels. Small: it is a smooth ramp. */
/**
 * The authored hue, and the ceiling that stops it saturating to white.
 *
 * `orb-hunt` identified this material as the source of the white orbs that five
 * art branches chased across medieval and citadel, and fixed half of it: the
 * halo carried `fog: false`, so a relic at 800 m drew as bright as one at 8 m.
 * That is now the shared `hazeAdditive` law. It was not enough.
 *
 * What remained is RADIANCE. A 4.42 m additive quad at linear 2.88 sits 1.6-2.2x
 * over the worlds' bloom thresholds (1.30 in medieval, 1.80 in dock), so it
 * clips every channel and answers cream — the relic loses its own colour, which
 * is the thing that says what it is. Fog cannot help inside its near plane, and
 * the vale's is 86 m: the four surviving orbs in `hills-vista` are relics at
 * 57-203 m, where the fog factor is under 3%.
 *
 * THE HUE IS HELD AND ONLY THE LEVEL MOVES. `GLOW_HUE` keeps the authored
 * 1 : 0.59 : 0.22 exactly; `glowColour()` scales all three by one factor so the
 * peak channel lands on `GLOW_CEILING` after `opacity`. Cutting a channel
 * instead would change the colour of a collectible, which is a gameplay signal.
 *
 * `GLOW_CEILING` is 1.6 to match the coincident-sum ceiling `Loot.js` already
 * pins, so the two additive systems in the game answer to one number rather than
 * drifting apart. Computed rather than typed: a constant that is DERIVED cannot
 * be edited past its own invariant, which is what `relic-glow.test.mjs` would
 * otherwise be left to catch after the fact.
 *
 * This is deliberately NOT a distance falloff. `art-loot` refused one for
 * `Loot.js` on the grounds that "recedes like everything else" means the
 * scene's own law and not a second one invented here, and the same holds.
 */
const GLOW_HUE = Object.freeze({ r: 3.2, g: 1.9, b: 0.7 });
const GLOW_OPACITY = 0.9;
const GLOW_CEILING = 1.6;

/**
 * The authored hue scaled so `max(channel) * opacity <= GLOW_CEILING`.
 * @returns {THREE.Color}
 */
function glowColour(opacity = GLOW_OPACITY) {
  const peak = Math.max(GLOW_HUE.r, GLOW_HUE.g, GLOW_HUE.b) * opacity;
  const k = peak > GLOW_CEILING ? GLOW_CEILING / peak : 1;
  return new THREE.Color(GLOW_HUE.r * k, GLOW_HUE.g * k, GLOW_HUE.b * k);
}

const GLOW_TEX = 64;
/**
 * How much wider the halo's QUAD is than the card it replaces.
 *
 * The old card was uniformly bright, so its quad and its halo were the same
 * thing. `glowFalloff` is past half strength by d = 0.6, so at the same quad
 * size the thing a player spots at range would be a little over half as wide
 * as before. 1.7 puts the bright core back where it was and spends the rest on
 * the tail. It costs nothing per frame: the same one instanced draw, the same
 * instance count, a few more fragments each - all of them additive and most of
 * them nearly transparent.
 */
const GLOW_SPREAD = 1.7;

/**
 * Widest the halo's quad ever gets, in metres, and the range it gets there.
 *
 * Both are the old law's own numbers: it read `min(2.6, 0.5 + d * 0.045)`, so
 * it topped out at 2.6 m and reached that at (2.6 - 0.5) / 0.045 = 46.67 m.
 * Beyond 46.67 m nothing below changes anything at all.
 */
const GLOW_MAX = 2.6;
const GLOW_HOLD = 46.67;
/**
 * Narrowest, in metres, also the old law's constant term. The relic itself is
 * an `OctahedronGeometry(0.32)` - 0.64 m across - and a halo has to be wider
 * than the thing it is a halo around, so the quad has a floor and does not
 * follow the range all the way down to nothing.
 */
const GLOW_MIN = 0.5;
/**
 * Metres of quad per metre of range: the APPARENT size the halo holds.
 *
 * 2.6 / 46.67. Multiplied by `GLOW_SPREAD` that is 0.0947 rad, or 5.42
 * degrees across - measured as 99 px in a 1600 px frame at the default 75
 * degree fov, which is exactly what the halo already subtends at 46.67 m.
 */
const GLOW_ARC = GLOW_MAX / GLOW_HOLD;

/**
 * How wide the halo's quad is, in metres, for a relic `d` metres from the eye.
 *
 * ── The defect ────────────────────────────────────────────────────────────
 * The law was `min(2.6, 0.5 + d * 0.045) * GLOW_SPREAD`, and the `+` is the
 * bug. `d * 0.045` alone is an apparent-size law - a quad that grows in step
 * with its range holds the same number of pixels - but ADDING it to 0.5 leaves
 * a fixed 0.85 m of quad that does not, so the halo's screen size ran away as
 * the player approached. Quad width in a 1600 px frame at 75 deg fov: 99 px at
 * 46.67 m, 124 px at 20 m, 174 px at 9.4 m, 523 px at 2 m.
 *
 * That is what two relics on adjacent Caravanserai roofs look like: the pair
 * in `output/cv-caravan-desert.jpeg` stand 8.2 m and 9.6 m from the camera and
 * measure 110 px and 101 px across at half power, each with a 60 px flat top
 * where {@link glowFalloff}'s clamped core is at full HDR radiance. Nothing is
 * wrong with the colour, the blending or the bloom: this is the same quad as
 * the warm points that read correctly on the souk roofs in
 * `output/citadel-baseline-town.jpeg` - fourteen of them clear luminance 235
 * there - and the only difference between them is range.
 *
 * ── The law ───────────────────────────────────────────────────────────────
 * A clamp instead of an offset. Between 8.97 m (where the floor lets go) and
 * 46.67 m (where the ceiling takes over) the halo holds 5.42 degrees, which is
 * the size it already had at 46.67 m; outside that band it is a fixed 0.85 m
 * near and a fixed 4.42 m far, both unchanged from before. It is never WIDER
 * than the old law at any range, which is the property that makes this a
 * reduction and not a re-author, and `relic-glow.test.mjs` floors all of it.
 *
 * @param {number} d metres from the camera to the relic
 * @returns {number} the quad's width in metres, `GLOW_SPREAD` included
 */
export function glowScale(d) {
  return Math.min(GLOW_MAX, Math.max(GLOW_MIN, d * GLOW_ARC)) * GLOW_SPREAD;
}

/**
 * The halo texture: white, with `glowFalloff` in its alpha.
 *
 * A `DataTexture` rather than a canvas one because this file is imported by
 * tests under Node, where there is no `document` to make a canvas with, and
 * because a 64 px ramp written by hand is smaller than the code that would
 * draw it. White RGB throughout: the colour is the material's, in HDR, and
 * multiplying it by a ramp as well would darken the core toward the tail
 * instead of just thinning it.
 */
/**
 * The identity of a relic site: its position on the ground plane, quantised.
 *
 * XZ only, and deliberately. `_tooClose` separates sites in XZ alone, so two
 * relics can never share a column and `y` adds nothing to uniqueness - while
 * including it would break every id the first time a deck height was tweaked.
 *
 * Half-metre resolution: far inside the `MIN_APART / sqrt(2)` = 9.9 m cell size
 * at which a grid could first hold two sites, so the quantisation itself can
 * never collide.
 */
function idOf(pos) {
  const q = (n) => Math.round(Number(n) * 2) / 2;
  return `${q(pos.x)}:${q(pos.z)}`;
}

/** Decode an id back to the point it was minted from. Null if malformed. */
function pointOfId(id) {
  if (typeof id !== 'string') return null;
  const i = id.indexOf(':');
  if (i <= 0) return null;
  const x = Number(id.slice(0, i));
  const z = Number(id.slice(i + 1));
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  return { x, z };
}

function makeGlowTexture() {
  const n = GLOW_TEX;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = ((x + 0.5) / n) * 2 - 1;
      const dy = ((y + 0.5) / n) * 2 - 1;
      const i = (y * n + x) * 4;
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
      data[i + 3] = Math.round(glowFalloff(Math.hypot(dx, dy)) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.name = 'relic.glow.falloff';
  /* Mipmaps and a linear filter are not optional here: a relic is spotted at
   * a hundred metres, where this quad is a few pixels across, and a nearest
   * sampled ramp at that size twinkles as the camera moves. */
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class Relics {
  /**
   * @param {{scene:THREE.Scene, bus:any, physics:any, player:any,
   *          economy:any, inventory?:any, cosmetics?:any, mounts?:any,
   *          worldManager:any}} ctx
   */
  constructor({ scene, bus, physics, player, economy, inventory, cosmetics, mounts, worldManager } = {}) {
    this.scene = scene;
    this.bus = bus ?? null;
    this.physics = physics ?? null;
    this.player = player ?? null;
    this.economy = economy ?? null;
    this.inventory = inventory ?? null;
    /** Wardrobe, for the set prize. Optional - the loop works without one. */
    this.cosmetics = cosmetics ?? null;
    /** Mount authority, for the set prize. Also optional. */
    this.mounts = mounts ?? null;
    this.worldManager = worldManager ?? null;

    /** @type {Array<{pos:THREE.Vector3, taken:boolean, phase:number}>} */
    this.sites = [];
    this._worldId = null;
    this._time = 0;
    /**
     * Legacy per-world tally, kept for saves written before the identity ledger
     * existed and for worlds this session has not entered yet. Once a world has
     * ids in `_foundIds`, that world's entry here is superseded and removed.
     * @type {Map<string, number>}
     */
    this._found = new Map();
    /**
     * WHICH relics, per world - the authority.
     *
     * A count was the original design and it was defensible for one device: the
     * number and the money round-trip exactly, and only which N of the N is
     * wrong. It stopped being defensible the moment progress had to merge across
     * devices, because a count CANNOT merge. Find {1,3,7} on a phone and {2,4}
     * on a PC and the union is five relics; the maximum of the counts is three,
     * and two relics are destroyed silently.
     * @type {Map<string, Set<string>>}
     */
    this._foundIds = new Map();
    /**
     * Milestones already paid, keyed `worldId:half` / `worldId:set`.
     *
     * Separate from `_found` because the two answer different questions. A
     * count can be reached twice - walk out of the world at 15 of 30 and back
     * in, and `_onWorld` re-marks 15 sites taken - but a prize is paid once.
     */
    this._paid = new Set();

    this._build();

    this._offs = [];
    if (this.bus) {
      this._offs.push(this.bus.on('world:changed', ({ id, world }) => this._onWorld(id, world)));
    }
  }

  /** Relics still hidden in the active world. */
  get remaining() {
    return this.sites.reduce((n, s) => n + (s.taken ? 0 : 1), 0);
  }

  /** Total placed in the active world. */
  get total() {
    return this.sites.length;
  }

  /**
   * Positions for the minimap: the ones still out there.
   *
   * (The old docstring said "only the ones already found", which the code has
   * never done and which would have been the wrong list anyway - a marker on a
   * relic you have already picked up is a marker with nothing under it. The
   * code was right and the sentence was wrong.)
   *
   * Which of these a player actually SEES is not decided here: `Minimap` asks
   * `Viewpoints.reveals(x, z)` first, so in a world with viewpoints a relic
   * appears only once the district it sits in has been climbed. A relic marked
   * on the map from the first frame is not hidden, and hidden is the whole
   * mechanic - see this file's header.
   */
  get markers() {
    /* Module-level scratch, refilled. `Minimap.update` reads this getter every
     * frame it draws and `Minimap.update` is called from `HUD.update` every
     * frame, so building a fresh array here was thirty pushes and one array of
     * garbage per frame in the one world that has relics. House rule is no
     * allocation in a frame path.
     *
     * The array is LIVE and shared: read it, do not keep it. The only two
     * callers are the minimap draw, which iterates it immediately, and the
     * tests, which do the same. */
    _markerScratch.length = 0;
    for (const s of this.sites) if (!s.taken) _markerScratch.push(s.pos);
    return _markerScratch;
  }

  /** How many have been found in the active world. */
  get found() {
    return this.total - this.remaining;
  }

  /* ------------------------------------------------------------------ */
  /* Persistence                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * The tally, per world.
   *
   * `Relics._found` was absent from `SaveGame._snapshot` altogether, so thirty
   * relics worth 3,600 CR reset to thirty on every single reload - the one
   * collectible in the game that is explicitly finite was in fact infinite, and
   * the "count is the progress bar" claim in this file's header was false.
   *
   * Both shapes are written. `foundIds` is the authority - the set of relic
   * identities recovered in each world. `found` is the legacy count, DERIVED
   * from that set so the two can never disagree, and kept so a build from before
   * this drop still reads a save written after it.
   *
   * This file used to argue against ids: "storing ids would imply a stability
   * the placement does not have". That objection is answered by an invariant the
   * file already enforces - see `MATCH_R`. Sites are never within `MIN_APART` of
   * each other, so a position IS an identity, provided it is matched with a
   * tolerance rather than by string equality.
   *
   * @returns {{found:Object<string,number>, foundIds:Object<string,string[]>, paid:string[]}}
   */
  serialize() {
    const found = {};
    const foundIds = {};
    for (const [worldId, ids] of this._foundIds) {
      if (!worldId || !ids || ids.size === 0) continue;
      foundIds[worldId] = [...ids].sort();
      found[worldId] = ids.size;
    }
    /* A world this session never entered still holds only a legacy count, and
     * dropping it here would delete its progress on the very next write. */
    for (const [worldId, n] of this._found) {
      if (worldId && n > 0 && found[worldId] == null) found[worldId] = n;
    }
    return { found, foundIds, paid: [...this._paid] };
  }

  /**
   * Restore the tally. Never pays a prize: the milestone list rides along in
   * `paid` precisely so a load cannot re-grant a cosmetic.
   *
   * REPLACE, not merge. A load has to be able to take progress AWAY: sync
   * nothing, collect thirty relics in the citadel, then load a save written
   * before any of that, and a merging restore left all thirty marked taken and
   * the milestone cosmetics still paid - the player kept progress the save they
   * loaded does not contain. `MountManager.deserialize` writes the same rule
   * down for the same reason ("replace semantics per mount id"). The clear is
   * total rather than per world id, because a world missing from the payload is
   * a world with nothing found in it, which is exactly what `serialize` does
   * with a zero tally.
   *
   * Contrast `Relics.merge`, which must NEVER take progress away. The two rules
   * are opposites on purpose: a load restores a moment, a merge reconciles two
   * devices. They stay separate entry points for that reason.
   *
   * @param {{found?:Object<string,number>, foundIds?:Object<string,string[]>,
   *          paid?:string[]}|null} data
   * @returns {boolean} true when a well-formed payload was applied
   */
  deserialize(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    this._found.clear();
    this._foundIds.clear();
    this._paid.clear();
    const ids = data.foundIds;
    if (ids && typeof ids === 'object' && !Array.isArray(ids)) {
      for (const worldId of Object.keys(ids)) {
        if (!Array.isArray(ids[worldId])) continue;
        const set = new Set();
        for (const key of ids[worldId]) if (typeof key === 'string' && key) set.add(key);
        if (set.size) this._foundIds.set(worldId, set);
      }
    }
    const found = data.found;
    if (found && typeof found === 'object' && !Array.isArray(found)) {
      for (const worldId of Object.keys(found)) {
        // Ids win: the count is the same progress, expressed worse.
        if (this._foundIds.has(worldId)) continue;
        const n = Math.max(0, Math.floor(Number(found[worldId])));
        if (Number.isFinite(n) && n > 0) this._found.set(worldId, n);
      }
    }
    if (Array.isArray(data.paid)) {
      for (const key of data.paid) if (typeof key === 'string' && key) this._paid.add(key);
    }
    /* A load can land while a world is already active - `SaveGame.load` only
     * rebuilds the world when the save names a different one - so the restored
     * tally has to be stamped onto the sites that are already standing. */
    this._applyFound();
    this._announce();
    return true;
  }

  /**
   * Mark the first N sites of the active world taken, from `_found`.
   *
   * ── THE LIMITATION THIS USED TO CARRY, and how it was answered ────────────
   *
   * This method stored a COUNT and marked the first N sites in generation order
   * - not the N the player actually picked up. Within one session those coincide;
   * across a reload they do not, because `sites` is regenerated by a seeded
   * shuffle, a district deal and a dart pass, and generation order has no
   * relationship to pickup order. Collect the four relics on the wall towers,
   * reload, and the four the generator happened to emit first were gone instead.
   *
   * It was documented and accepted, on the grounds that "there are no stable ids
   * to store": placement is `mulberry32(hashString('relic:' + worldId))` over
   * `world._roofs` and `world._towers`, so changing `PER_WORLD`, the bounds or
   * the authored roof list renumbers every site, and a stored INDEX set would
   * mark the wrong sites after any content change - the same defect with a
   * longer fuse.
   *
   * That reasoning is right about indices and wrong about identity. The file
   * already enforces an invariant strong enough to make a POSITION an id:
   * `_tooClose` keeps every site at least `MIN_APART` from every other in XZ, on
   * both placement paths. So a quantised position collides with nothing, and
   * matching it to the nearest live site within `MATCH_R < MIN_APART / 2` is
   * one-to-one by construction. Content change degrades gracefully rather than
   * corruptly: an id that matches nothing leaves that relic re-findable, instead
   * of silently marking a different one.
   *
   * What forced the change was the merge. A count cannot be unioned across two
   * devices without destroying whichever finds are rarer, and no amount of care
   * elsewhere recovers them. See `Relics.merge`.
   */
  _applyFound() {
    const ids = this._foundIds.get(this._worldId);
    if (ids && ids.size) { this._applyIds(ids); return; }

    /* Legacy path: a save written before the identity ledger. Reproduce the old
     * behaviour exactly - mark the first N in generation order - and then
     * UPGRADE, so the next write carries ids and this branch is never taken for
     * this world again. The upgrade is no more wrong than the restore already
     * was; it simply stops being wrong from here on. */
    const already = this._found.get(this._worldId) ?? 0;
    for (let i = 0; i < this.sites.length; i++) this.sites[i].taken = i < already;
    if (already > 0 && this.sites.length) this._upgradeLegacy();
  }

  /**
   * Claim each stored id's NEAREST live site, within `MATCH_R`.
   *
   * One-to-one by construction: sites are at least `MIN_APART` apart and
   * `MATCH_R < MIN_APART / 2`, so no key is in range of two sites, and a site
   * already claimed is skipped. A key that matches nothing - the relic moved, or
   * the world's content changed under it - simply goes un-restored, which puts
   * that relic back on the map rather than marking the wrong one.
   */
  _applyIds(ids) {
    for (const site of this.sites) site.taken = false;
    const r2 = MATCH_R * MATCH_R;
    for (const key of ids) {
      const p = pointOfId(key);
      if (!p) continue;
      let best = -1;
      let bestD = r2;
      for (let i = 0; i < this.sites.length; i++) {
        const site = this.sites[i];
        if (site.taken) continue;
        const dx = site.pos.x - p.x;
        const dz = site.pos.z - p.z;
        const d = dx * dx + dz * dz;
        if (d <= bestD) { bestD = d; best = i; }
      }
      if (best >= 0) this.sites[best].taken = true;
    }
  }

  /** Mint ids for whatever a legacy count marked, and retire the count. */
  _upgradeLegacy() {
    const set = new Set();
    for (const site of this.sites) if (site.taken) set.add(idOf(site.pos));
    if (!set.size) return;
    this._foundIds.set(this._worldId, set);
    this._found.delete(this._worldId);
  }

  /** Record one recovered relic against the active world. */
  _noteFound(site) {
    if (!this._worldId) return;
    let set = this._foundIds.get(this._worldId);
    if (!set) {
      /* First pickup in a world still on a legacy count: carry the sites that
       * count already marked, or its progress would be thrown away. */
      set = new Set();
      for (const s of this.sites) if (s.taken && s !== site) set.add(idOf(s.pos));
      this._foundIds.set(this._worldId, set);
      this._found.delete(this._worldId);
    }
    set.add(idOf(site.pos));
  }

  /**
   * Stamp the ledger onto a world that has just come up, and settle any
   * milestone it already satisfies.
   *
   * `_payMilestones` used to run only from `_collect`, which was correct while a
   * world could only be completed by picking something up. A merge breaks that:
   * device A holds relics 1-15, device B holds 16-30, the union completes the
   * world, and there is no next pickup to trigger the prize. `_claim` keeps this
   * idempotent, so re-entering a finished world still pays nothing.
   * `Viewpoints` records hitting the same case and settling it on world entry.
   */
  _enterWorldLedger() {
    this._applyFound();
    this._payMilestones();
  }

  /**
   * Reconcile two saved relic ledgers. Union, never subtraction.
   *
   * The opposite rule to `deserialize`, and the reason this is a separate entry
   * point. Commutative and idempotent, so it does not matter which device synced
   * first and a replayed payload changes nothing - which is precisely why no
   * device clock is consulted anywhere in here. Clocks disagree; sets do not.
   *
   * @returns {{found:Object<string,number>, foundIds:Object<string,string[]>, paid:string[]}}
   */
  static merge(a, b) {
    const sides = [a, b].filter((s) => s && typeof s === 'object' && !Array.isArray(s));
    const ids = new Map();
    for (const side of sides) {
      const fi = side.foundIds;
      if (!fi || typeof fi !== 'object' || Array.isArray(fi)) continue;
      for (const worldId of Object.keys(fi)) {
        if (!Array.isArray(fi[worldId])) continue;
        if (!ids.has(worldId)) ids.set(worldId, new Set());
        const set = ids.get(worldId);
        for (const key of fi[worldId]) if (typeof key === 'string' && key) set.add(key);
      }
    }

    const found = {};
    const foundIds = {};
    for (const [worldId, set] of ids) {
      if (!set.size) continue;
      foundIds[worldId] = [...set].sort();
      found[worldId] = set.size;
    }

    /* A world with no ids on EITHER side is still on a legacy count, and the
     * larger of the two is the best available answer for it. */
    for (const side of sides) {
      const fc = side.found;
      if (!fc || typeof fc !== 'object' || Array.isArray(fc)) continue;
      for (const worldId of Object.keys(fc)) {
        if (ids.has(worldId)) continue;
        const n = Math.max(0, Math.floor(Number(fc[worldId])) || 0);
        if (n > 0) found[worldId] = Math.max(found[worldId] ?? 0, n);
      }
    }

    const paid = new Set();
    for (const side of sides) {
      if (!Array.isArray(side.paid)) continue;
      for (const key of side.paid) if (typeof key === 'string' && key) paid.add(key);
    }

    return { found, foundIds, paid: [...paid].sort() };
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */

  _build() {
    /* The relic itself: an octahedron, which reads as "cut gem" at any size and
     * needs no texture to do it. */
    const geo = new THREE.OctahedronGeometry(0.32, 0);
    const mat = new THREE.MeshStandardMaterial({
      name: 'relic.body',
      color: new THREE.Color(0xffd98a),
      emissive: new THREE.Color(0xff9c2e),
      emissiveIntensity: 1.5,
      metalness: 0.85,
      roughness: 0.28,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_PER_WORLD);
    this.mesh.name = 'relics';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.scene.add(this.mesh);

    /* Halo: an additive billboard, authored in HDR for the same reason the
     * arrow tracer is - a relic on a sunlit parapet has to out-contrast the
     * stone behind it or it is invisible at the range you spot it from.
     *
     * The falloff is a `map`, and that choice is the cheap one on purpose. The
     * alternative was an `onBeforeCompile` patch computing the ramp from `vUv`,
     * which would have made this the only `MeshBasicMaterial` in the game with
     * a custom program cache key, for a ramp that is four instructions and
     * eight bytes of texture per texel. As a stock material with a map it is
     * still ONE draw call for every relic in the world, still one material, and
     * the program it compiles is a variant three already builds for every other
     * mapped basic material in the scene.
     *
     * ── `hazeAdditive`: the orbs ───────────────────────────────────────────
     * This material carried `fog: false` until now, and that is what five art
     * branches photographed and none could name. A relic 630 m across
     * Aldermoor Vale was drawn at exactly the strength of one at 50 m, in a
     * valley whose every other surface is on a `Fog(86, 880)` ramp - and
     * because `glowScale` clamps the quad at 4.42 m for everything past
     * 46.67 m, what reached the film was a hard cream dot of constant size and
     * constant brightness sitting on top of graded haze. Measured in
     * `medieval/hills-vista`: hiding this one mesh took the frame from 8 hard
     * orbs to 0, and in `citadel/tower-top` from 19 to 0, against a null floor
     * of 0.0. `docs/superpowers/specs/2026-08-23-orb-hunt-design.md` has the
     * frames and the numbers.
     *
     * `fog: true` ALONE would make it worse rather than better, which is the
     * trap `hazeAdditive` exists to route around: three's stock
     * `<fog_fragment>` MIXES toward `fogColor`, so a fully fogged additive
     * quad would add haze colour at full strength and paint a brighter dot at
     * 880 m than at 88 m. Emitted light is swallowed by haze, not tinted by
     * it, so the shared patch multiplies by `1 - fogFactor` instead. It is the
     * same law `systems/Loot.js`, `systems/Projectiles.js` and `systems/VFX.js`
     * already carry, imported rather than copied so the program cache sees one
     * patch function and one key across all of them.
     *
     * Note this lands on a LINEAR value here, not an encoded one: the scene
     * renders into the composer's HalfFloat target, and three forces
     * `NoToneMapping` and a linear output colour space for every material
     * whenever the render target is not null. So the attenuation is exactly
     * `1 - fogFactor` rather than the `(1 - fogFactor) ^ 2.4` the same chunk
     * gives on a direct-to-canvas draw.
     *
     * `toneMapped: false` is left exactly as it was, and it is worth writing
     * down that it currently does NOTHING on the shipped path for the reason
     * just given - three ignores `material.toneMapped` when rendering to a
     * render target. It only bites on the fallback where `PostFX` is disabled
     * and the scene is drawn straight to the canvas, where it would clip this
     * HDR colour to a flat white square. That is a real latent defect and a
     * separate argument from this one, so it is reported rather than changed
     * here. */
    const gGeo = new THREE.PlaneGeometry(1, 1);
    const gTex = makeGlowTexture();
    const gMat = hazeAdditive(new THREE.MeshBasicMaterial({
      name: 'relic.glow',
      color: glowColour(GLOW_OPACITY),
      map: gTex,
      transparent: true,
      opacity: GLOW_OPACITY,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }));
    this.glow = new THREE.InstancedMesh(gGeo, gMat, MAX_PER_WORLD);
    this.glow.name = 'relics:glow';
    this.glow.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.glow.frustumCulled = false;
    this.glow.renderOrder = 7;
    this.glow.count = 0;
    this.scene.add(this.glow);

    this._disposables = [geo, mat, gGeo, gMat, gTex];
  }

  /* ------------------------------------------------------------------ */
  /* Placement                                                           */
  /* ------------------------------------------------------------------ */

  _onWorld(id, world) {
    this._worldId = id ?? null;
    this.sites.length = 0;
    this.mesh.count = 0;
    this.glow.count = 0;
    /* Announce the EMPTY world before either early return, not only the worlds
     * that get relics.
     *
     * `relics:changed` had no listener before this drop, so returning without
     * one was harmless. It has one now: `HUD._setDiscoveries` keeps `_relicTotal`
     * from the last announcement, so a player who found 12 of 30 in the citadel
     * and portalled into the maze (`MazeWorld` sets `relics: false`) kept
     * reading "Relics 12/30" in a world that has none, until they walked back
     * into a world that does. `Viewpoints._onWorld` already announces on every
     * path for the same reason. */
    this._announce();
    // No relics: the only collectible is the stack at the centre.
    if (!allows(world, 'relics')) return;
    if (!world || !this.physics) return;

    const rnd = mulberry32(hashString(`relic:${id}`));
    /**
     * `contentBounds` if the world publishes one, `bounds` otherwise.
     *
     * The budget below is an AREA law, and it is only a sane law while the
     * published box is the area a relic can actually be hidden in. The Citadel
     * broke that assumption: its playfield went 400 m -> 900 m while its town
     * stayed exactly where it was, so `bounds` said 5.06x the area and this
     * function asked for 110 relics and 330 darts. The extra darts land in open
     * desert, where `MIN_PROMINENCE` 2.5 is unreachable by construction - flat
     * sand is never 2.5 m above the flat sand around it - so the honest reading
     * of that world is "a 400 m world with a lot of scenery round it", which is
     * what `contentBounds` says.
     *
     * Deliberately not a Citadel special case in here. Every world that grows a
     * decorative surround has the same problem, and the one that has it now is
     * the one that publishes the box.
     */
    const b = world.contentBounds ?? world.bounds;
    const minX = (b?.min?.x ?? -180) + EDGE_INSET;
    const maxX = (b?.max?.x ?? 180) - EDGE_INSET;
    const minZ = (b?.min?.z ?? -180) + EDGE_INSET;
    const maxZ = (b?.max?.z ?? 180) - EDGE_INSET;

    /* Budget by area, not by a constant.
     *
     * Both numbers below were tuned against a 400 m world and neither survives
     * a bigger one. The count is the obvious half; the dart budget is the half
     * that bites hardest, because `TRIES` is a *total*, not per relic, and the
     * probability that a dart lands somewhere prominent falls with area. Ninety
     * darts into the station's box would have placed a handful and then given
     * up, and the log line would have said so to nobody.
     */
    const extent = Math.max(maxX - minX, maxZ - minZ, 1);
    const areaScale = Math.min(MAX_PER_WORLD / PER_WORLD, (extent / BASE_EXTENT) ** 2);
    const want = Math.round(PER_WORLD * Math.max(1, areaScale));
    const tries = Math.round(TRIES * Math.max(1, areaScale));

    /* Authored surfaces first. A world that publishes its roofs and towers -
     * the citadel does - knows better than any random probe where a relic
     * belongs, and using them means the citadel's relics sit on the skyline
     * rather than wherever a dart happened to land. */
    const authored = [];
    for (const t of world._towers ?? []) {
      authored.push({ x: t.x, y: t.y, z: t.z, district: districtOf(t) });
    }
    /* `anchor`, not the centre, where the world publishes one.
     *
     * A roof's `x/z` is its FOOTPRINT centre, and 30% of the citadel's souk
     * blocks stand a dome on exactly that point. Taking the centre put 8 of
     * these 30 relics inside an opaque hemisphere: nothing to see from the
     * deck, and the nearest a body could stand was 2.49-2.62 m against
     * PICKUP_R = 2.0, so they could not be collected at all. `CitadelWorld`
     * resolves `anchor` against its real colliders once the souk is built;
     * a world that publishes no anchor is unchanged. */
    for (const r of world._roofs ?? []) {
      const a = r.anchor ?? r;
      authored.push({ x: a.x, y: a.y, z: a.z, district: districtOf(r) });
    }
    // Shuffle deterministically so the same subset is not used every time.
    for (let i = authored.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [authored[i], authored[j]] = [authored[j], authored[i]];
    }

    /* ── ONE ANCHOR TO EACH DISTRICT, THEN ROUND AGAIN ────────────────────
     *
     * The old loop walked the shuffled list straight through and took the
     * first `want` anchors far enough apart, which spends the budget in
     * proportion to how many DECKS a district happens to have. That was
     * invisible while the only world publishing anchors was 264 m across and
     * one place. It stopped being invisible the moment the citadel grew six
     * outer regions: measured on the built world, the straight walk put 64 of
     * the 109 relics inside the old mesa - 59% of the collection in 12% of the
     * map - and left the Eyrie, thirteen decks up a karst face and the longest
     * climb in the game, holding THREE.
     *
     * Dealing one anchor to each district per round fixes the STARVATION
     * without naming a single world. A district is whatever the world already
     * tags its own decks with ({@link districtOf}); a bucket that runs out
     * stops being dealt to and the others absorb the remainder; and a world
     * that tags nothing has exactly one bucket and byte-identical behaviour to
     * before.
     *
     * ── WHAT IT DOES NOT FIX, stated because it reads as if it does ───────
     *
     * It does not move the mesa/ring RATIO, and nobody should read the
     * paragraph above as a claim that it does. `districtOf` splits the mesa
     * into eight buckets (`core` plus `ring:0..6`) against the ring's six, so
     * the mesa is dealt 8/14 of the budget by construction - almost exactly
     * what the straight walk already spent there. Measured on the built world,
     * same seed, same anchor list, same `MIN_APART`:
     *
     *                    mesa   ring
     *   straight walk      64     45
     *   round-robin        63     46
     *
     * ONE relic. What actually moved is the shape inside those totals: the
     * Eyrie 3 -> 6, `ring:1` 3 -> 8, `ring:0` 4 -> 8, and `ring:6` 15 -> 8.
     * The spread across the fourteen buckets went from 3..15 to 6..8, which is
     * the property this deal delivers and the property the test floors.
     *
     * Cycling over seven buckets instead - the six regions plus one composite
     * mesa - WOULD move the ratio, to about 16 mesa and 93 ring, and it is
     * deliberately not done: 16 is below the 30 the mesa held before the map
     * was ever expanded, and the souk's rings are the world's authored
     * difficulty gradient, so "one relic per ring per round" is the same
     * statement as "the collection walks the gradient". Changing that is an
     * authoring decision with a number attached, not a bug fix.
     *
     * The floors AND the ceiling are per district in
     * `citadel-objectives.test.mjs`, which is what stops a later re-author
     * quietly starving one again or handing one fifteen.
     */
    const buckets = new Map();
    for (const a of authored) {
      const list = buckets.get(a.district);
      if (list) list.push(a);
      else buckets.set(a.district, [a]);
    }
    /* Insertion order is the SHUFFLED order, so which district is dealt first
     * is itself seeded rather than alphabetical - a fixed order would always
     * hand the odd anchor to the same district when `want` does not divide. */
    const order = [...buckets.values()];
    const perDistrict = new Map();
    while (this.sites.length < want) {
      let dealt = 0;
      for (const list of order) {
        if (this.sites.length >= want) break;
        // The first anchor in this district that is not on top of another.
        while (list.length) {
          const a = list.shift();
          if (this._tooClose(a.x, a.z)) continue;
          this.sites.push({ pos: new THREE.Vector3(a.x, a.y + 0.55, a.z), taken: false, phase: rnd() * 6.283 });
          perDistrict.set(a.district, (perDistrict.get(a.district) ?? 0) + 1);
          dealt++;
          break;
        }
      }
      // Every bucket empty, or every anchor left is too close to a site.
      if (dealt === 0) break;
    }
    const fromAuthored = this.sites.length;

    // Then probe for anything else prominent enough to be worth a climb.
    for (let t = 0; t < tries && this.sites.length < want; t++) {
      const x = minX + rnd() * (maxX - minX);
      const z = minZ + rnd() * (maxZ - minZ);
      _rv.set(x, 400, z);
      const hit = this.physics.raycast(_rv, _down, 800, COLLISION_LAYER.WORLD);
      if (!hit) continue;
      if (Math.abs(hit.normal?.y ?? 1) < 0.7) continue;
      const y = hit.point.y;
      if (this._tooClose(x, z)) continue;

      // Prominence: meaningfully above what is around it, or it is just a spot
      // on the floor and finding it is not an achievement.
      let low = Infinity;
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        const ry = this.physics.groundHeight(x + Math.cos(a) * 4, z + Math.sin(a) * 4, y + 1, 200);
        low = Math.min(low, ry === null ? -Infinity : ry);
      }
      if (y - low < MIN_PROMINENCE) continue;

      this.sites.push({ pos: new THREE.Vector3(x, y + 0.55, z), taken: false, phase: rnd() * 6.283 });
    }

    /**
     * Where the sites came from, for the floor that has to exist.
     *
     * `MIN_PROMINENCE` 2.5 measured at r = 4 m is an ARCHITECTURAL test: it
     * asks whether a point stands proud of the ground beside it, and flat sand
     * never does. The dart loop therefore cannot place anything at all in the
     * 700 m of desert this world grew - and a world whose authored list ran
     * short would not fail loudly. It would place nine, log "9/9 hidden", and
     * the number on the HUD would be the count it MANAGED rather than the count
     * it wanted. That is a defect this project has already shipped once.
     *
     * So the split is recorded rather than inferred, and
     * `citadel-objectives.test.mjs` floors `darted` at zero and `placed`
     * against `want`. A report is the only thing that can tell "the world
     * published enough places" apart from "the search got lucky".
     *
     * @type {{want:number, placed:number, authored:number, darted:number,
     *   candidates:number, districts:Object<string,number>}}
     */
    this.placement = {
      want,
      placed: this.sites.length,
      authored: fromAuthored,
      darted: this.sites.length - fromAuthored,
      candidates: authored.length,
      districts: Object.fromEntries([...perDistrict.entries()].sort((a, b) => b[1] - a[1])),
    };

    // Stamp the ledger onto the freshly generated sites so a returning player
    // does not re-collect a world they have already stripped, and settle any
    // milestone a merged ledger already satisfies.
    this._enterWorldLedger();

    if (this.sites.length) {
      console.info(`[Relics] "${id}": ${this.remaining}/${this.sites.length} hidden`
        + ` (${fromAuthored} authored, ${this.sites.length - fromAuthored} darted,`
        + ` ${perDistrict.size} districts)`);
    }
    this._announce();
  }

  _tooClose(x, z) {
    const r2 = MIN_APART * MIN_APART;
    for (const s of this.sites) {
      const dx = s.pos.x - x;
      const dz = s.pos.z - z;
      if (dx * dx + dz * dz < r2) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* Frame                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Spin, bob, and check for a pickup.
   * @param {number} dt
   */
  update(dt) {
    if (!this.sites.length) return;
    this._time += dt;
    const t = this._time;
    const cam = this.player?.camera ?? null;
    /* NOT WHILE SOMETHING ELSE IS DRIVING THE BODY.
     *
     * `player.position` IS THE SHIP while `Piloting` holds the body, so a relic
     * pickup test against it is a 22 m hull sweeping the yard at 200 m/s.
     * Measured on three separate launches out of the hangar with no other
     * income: credits 895->1015, 1068->1188, 1188->1308 - +120 every time, one
     * relic per take-off, and the session reached Relics 9/30 without the
     * player ever looking for one. The yard's fifteen pier relics are eaten
     * silently in the first few flights, and a complete round trip to Cinder -
     * land, mine, take off, fly home, dock - sells for 53.
     *
     * `movementOverrideCollide === false` is the exact condition: it means the
     * body is not being resolved as a capsule in this world, which is what
     * `Piloting.board` sets and what a mount does NOT (a rider still collides,
     * and a rider picking a relic up is correct). `Mining.update` stands down
     * for the same reason off `piloting.active`; this file has no reference to
     * that mode and does not need one to answer the same question.
     * @see ../ships/Piloting.js `_takeBody`, ./Loot.js, ./Mining.js */
    const driven = !!this.player?.movementOverride && this.player?.movementOverrideCollide === false;
    const p = driven ? null : this.player?.position;

    let n = 0;
    let g = 0;
    for (const s of this.sites) {
      if (s.taken) continue;
      const bob = Math.sin(t * 1.6 + s.phase) * 0.16;
      _rv.set(s.pos.x, s.pos.y + bob, s.pos.z);

      // `_up`, not a fresh Vector3: this is inside the per-site loop of a frame
      // handler, so it built one throwaway vector per relic per frame.
      _rq.setFromAxisAngle(_up, t * 1.1 + s.phase);
      _rs.setScalar(1);
      _rm.compose(_rv, _rq, _rs);
      this.mesh.setMatrixAt(n++, _rm);

      if (cam) {
        /* Camera-facing, and sized by {@link glowScale} - which is a whole
         * function because the sizing is where this halo's one visual defect
         * lived, and a law that has to be argued about wants to be checkable
         * without a GPU.
         *
         * `GLOW_SPREAD` is what pays for the falloff. The card used to be
         * bright to its own edge, so the quad's width WAS the halo's width;
         * with a ramp on it the visible core is about half that, and a relic
         * would have gone quieter at exactly the range it exists to be seen
         * from. The quad grows, the core stays about the size it always was,
         * and what is new is the soft tail around it. */
        const d = _rv.distanceTo(cam.position);
        const gs = glowScale(d);
        _rm.copy(cam.matrixWorld);
        _rm.setPosition(_rv);
        _rm.scale(_rs.set(gs, gs, gs));
        this.glow.setMatrixAt(g++, _rm);
      }

      if (p && !s.taken) {
        const dx = p.x - s.pos.x;
        const dy = p.y + 1.0 - s.pos.y;
        const dz = p.z - s.pos.z;
        if (dx * dx + dy * dy + dz * dz < PICKUP_R * PICKUP_R) this._collect(s);
      }
    }
    this.mesh.count = n;
    this.glow.count = g;
    if (n > 0) this.mesh.instanceMatrix.needsUpdate = true;
    if (g > 0) this.glow.instanceMatrix.needsUpdate = true;
  }

  _collect(site) {
    site.taken = true;
    this._noteFound(site);
    this.economy?.add?.(VALUE, 'relic');
    // Also add a relic_coin to the store so it shows up in the inventory panel.
    this.inventory?.add?.('relic_coin', 1);
    const left = this.remaining;
    const total = this.total;
    this.bus?.emit('relic:found', {
      value: VALUE,
      remaining: left,
      total,
      // The count is the progress bar, so hand the listener the filled part of
      // it rather than making every consumer subtract.
      found: total - left,
      worldId: this._worldId,
      position: { x: site.pos.x, y: site.pos.y, z: site.pos.z },
    });
    this.bus?.emit('hud:notify', {
      text: left > 0
        ? `Relic recovered — +${VALUE} CR (${left} left)`
        : `Relic recovered — +${VALUE} CR. That was the last one.`,
      tone: 'good',
    });
    this._payMilestones();
    this._announce();
  }

  /**
   * Halfway and the full set, once each per world.
   *
   * Ordered halfway-then-set and NOT else-if: a one-relic world (or a debug
   * build with `PER_WORLD` at 1) crosses both on the same pickup, and paying
   * only one of them would make the smaller world quietly cheaper.
   */
  _payMilestones() {
    const total = this.total;
    if (!this._worldId || total <= 0) return;
    const found = total - this.remaining;

    if (found >= Math.ceil(total / 2) && this._claim('half')) {
      const got = this.inventory?.acquire?.(HALFWAY_ITEM, HALFWAY_ITEM_QTY);
      this.bus?.emit('relics:milestone', {
        worldId: this._worldId, milestone: 'half', found, total, item: HALFWAY_ITEM,
        qty: got?.taken ?? 0,
      });
      this.bus?.emit('hud:notify', {
        text: `Half the relics recovered — ${HALFWAY_ITEM_QTY} Rushline Glyphs`,
        tone: 'good',
      });
    }

    if (found >= total && this._claim('set')) {
      this.economy?.add?.(SET_CREDITS, 'relic-set');
      const gotSkin = this.cosmetics?.unlock?.(SET_COSMETIC) === true;
      this.mounts?.grantPower?.(SET_POWER.mount, SET_POWER.power, SET_POWER.tier);
      this.bus?.emit('relics:milestone', {
        worldId: this._worldId, milestone: 'set', found, total,
        credits: SET_CREDITS, cosmetic: SET_COSMETIC, power: { ...SET_POWER },
      });
      this.bus?.emit('hud:notify', {
        text: gotSkin
          ? `Every relic recovered — +${SET_CREDITS} CR, Jade Sovereign unlocked`
          : `Every relic recovered — +${SET_CREDITS} CR, your horse is stronger`,
        tone: 'good',
      });
    }
  }

  /** Claim a one-time milestone for the active world. @returns {boolean} */
  _claim(milestone) {
    const key = `${this._worldId}:${milestone}`;
    if (this._paid.has(key)) return false;
    this._paid.add(key);
    return true;
  }

  _announce() {
    const total = this.total;
    const remaining = this.remaining;
    this.bus?.emit('relics:changed', {
      worldId: this._worldId, remaining, total, found: total - remaining,
    });
  }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
    this.mesh?.removeFromParent();
    this.glow?.removeFromParent();
    for (const d of this._disposables) d?.dispose?.();
    this.sites.length = 0;
  }
}

export default Relics;
