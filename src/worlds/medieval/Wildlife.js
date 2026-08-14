/**
 * Where the predators live, and - more importantly - where they do not.
 *
 * ---------------------------------------------------------------------------
 * THE DESIGN CLAIM THIS FILE HAS TO MAKE TRUE
 *
 * The deep forest should be genuinely dangerous and the roads should be
 * comparatively safe. That is a claim about DISTANCE, not about atmosphere, and
 * it can only be true if the arithmetic below is right, because a wolf does not
 * respect a mood - it respects `def.territory` and `def.sight`.
 *
 * A pack is placed at a HOME, roams `territory` metres from it (`BeastNPC`
 * `_wanderNear`, and `strayed` pulls it back), and acquires anything it can see
 * within `sight`. So the furthest a pack can be a threat from its home is
 *
 *     reach = territory + sight
 *
 * which is 68 m for a wolf and 56 m for a bear. Every clearance in this file is
 * expressed against `reach` plus a margin rather than against a number somebody
 * liked the look of, so retuning a species' territory moves the packs rather
 * than silently putting one within scenting distance of a market square.
 *
 * The clearances, in the order they reject:
 *
 *   settlement   `radius + reach + MARGIN` from every settlement centre. The
 *                radius is the settlement's OWN, so a market town keeps a
 *                bigger cordon than a parish church, and a settlement added to
 *                the table later gets a cordon without this file being touched.
 *   people       `reach + MARGIN` from every authored friendly spawn. This is
 *                the one that keeps a pack away from a lone questmaster,
 *                lorekeeper or roadside traveller who is nowhere near a
 *                settlement centre and would otherwise be eaten on sight.
 *   road         `reach * ROAD_SHARE + MARGIN` from any road. Deliberately
 *                less than the full reach: a road that no animal can ever be
 *                seen from is not a safe road, it is a road in a different
 *                world. What the margin buys is that a pack cannot be sitting
 *                ON the verge - the player has to leave the metalled surface to
 *                find one, and can retreat to it.
 *   water        clear of the channel and above the flood line, because a wolf
 *                cannot swim and `_auditWater` would spend its life dragging
 *                one out of the river.
 *   ground       inside the playfield, on woodland, on a walkable slope.
 *
 * ---------------------------------------------------------------------------
 * WOODLAND IS THE SAME MASK THE TREES USE
 *
 * `MedievalWorld._buildNature` picks conifers and birch - the closed-canopy
 * species - where `fbm2(x * 0.0062, z * 0.0062, 3) > 0.16`. That threshold is
 * reproduced here as `DEEP_WOOD` and is the ONLY definition of "forest" either
 * file has, so a pack cannot end up in a field that merely looked wooded on a
 * different noise field. The mask is a pure function of position, which is what
 * lets the test assert every planned home is in real woodland without building
 * a single tree.
 *
 * Nothing in this file may import `three`.
 */

import { fbm2, riverZ, riverHalfWidth, medievalHeight, HALF, WATER_Y } from '../terrain/MedievalHeight.js';
import { SETTLEMENTS } from './Settlements.js';
import { streamFor } from './Population.js';

/** The woodland mask, exactly as `_buildNature` computes it. */
export function woodlandAt(x, z) {
  return fbm2(x * 0.0062, z * 0.0062, 3);
}

/**
 * Closed canopy. `_buildNature` uses this same number to switch from scattered
 * broadleaf to pine and birch, i.e. it is the line between "trees in a field"
 * and "forest".
 */
export const DEEP_WOOD = 0.16;

/** Clearance margin on top of a species' own reach, metres. */
export const MARGIN = 22;

/**
 * How much of a predator's reach has to fit between it and the nearest road.
 *
 * Less than 1 on purpose - see the header. At 0.55 a wolf may be 59 m from a
 * road, which is far enough that it cannot see a traveller on it (sight 34) and
 * close enough that a player who steps twenty metres into the trees is in its
 * country.
 */
export const ROAD_SHARE = 0.55;

/**
 * Species written as a table rather than read from `BeastSpecies.js`.
 *
 * `BeastSpecies.js` is the authority on what an animal IS and this file must
 * not be a second copy of it - but it is also a module this one is allowed to
 * import, and it is imported: `reachFor` takes the def. What is written here is
 * only the DENSITY decision, which is a world-authoring choice and not a
 * property of the animal: how many of each the vale should hold, and in what
 * ratio.
 */
export const WILDLIFE_MIX = [
  /* Wolves outnumber bears three to one, and a wolf site is a PACK of three to
   * five - so most of the danger in the woods is the encounter the species was
   * designed around (see the note in `BeastSpecies.wolf`: the fight is about
   * the three that are not in front of you). */
  { species: 'wolf', weight: 3 },
  { species: 'bear', weight: 1 },
];

/** How far from its home a beast can still be a threat. */
export function reachFor(def) {
  const territory = Number.isFinite(def?.territory) ? def.territory : 30;
  const sight = Number.isFinite(def?.sight) ? def.sight : 30;
  return territory + sight;
}

/**
 * Everything a candidate home has to clear, as one predicate.
 *
 * Returns the NAME of the first rule that rejected, or null when the spot is
 * good. A string rather than a boolean because the test asserts on the reasons
 * and the world's summary reports them: "no site found" is a bug report with no
 * information in it.
 *
 * @param {number} x
 * @param {number} z
 * @param {number} reach
 * @param {object} ctx
 * @returns {string|null}
 */
export function rejectHome(x, z, reach, ctx) {
  const {
    settlements = SETTLEMENTS,
    people = [],
    height = medievalHeight,
    roadDist = null,
    slope = null,
    inset = 30,
  } = ctx ?? {};

  if (!(x > -HALF + inset && x < HALF - inset && z > -HALF + inset && z < HALF - inset)) return 'playfield';

  const y = height(x, z);
  if (y < WATER_Y + 1.2) return 'water';
  if (Math.abs(z - riverZ(x)) < riverHalfWidth(x) + 14) return 'channel';

  /* The people rules are tested BEFORE the woodland mask even though the mask
   * is cheaper and rejects more darts, and the reason is diagnosis rather than
   * speed. `planBeasts` reports which rule turned each dart away; a barren map
   * has to be able to say "every wood is inside somebody's cordon", and it
   * cannot say that if the cordon test never runs. The cost is a dozen squared
   * distances on a few hundred darts. */
  for (const s of settlements) {
    if (!s?.centre) continue;
    const clear = (s.radius ?? 0) + reach + MARGIN;
    if ((x - s.centre.x) ** 2 + (z - s.centre.z) ** 2 < clear * clear) return `settlement:${s.id}`;
  }
  const peopleClear = reach + MARGIN;
  for (const p of people) {
    if ((x - p.x) ** 2 + (z - p.z) ** 2 < peopleClear * peopleClear) return 'people';
  }
  if (roadDist) {
    const clear = reach * ROAD_SHARE + MARGIN;
    if (roadDist(x, z) < clear) return 'road';
  }

  if (woodlandAt(x, z) <= DEEP_WOOD) return 'woodland';
  if (slope && slope(x, z) > 0.55) return 'slope';
  return null;
}

/**
 * Plan the vale's predator sites.
 *
 * Returns HOMES, not animals: one record is one pack, which is the unit
 * `NPCManager.spawnBeastGroup` and `Residency` both think in, and the unit the
 * design is expressed in ("a pack lives in the north woods").
 *
 * Sites are darted rather than laid out, because the woodland mask is noise and
 * there is no closed form for "inside it". The dart stream is seeded off a
 * fixed string, so the same map always grows the same wolves - determinism here
 * is not a nicety, it is what makes the placement testable at all.
 *
 * @param {object} ctx
 * @param {(id:string)=>object} ctx.beastDef  usually `BeastSpecies.beastDef`
 * @param {number} [ctx.count] how many sites to plan
 * @param {Array<{x:number,z:number}>} [ctx.people] authored friendly positions
 * @param {(x:number,z:number)=>number} [ctx.roadDist]
 * @returns {Array<{x:number,y:number,z:number,species:string,territory:number,
 *                  reach:number,wood:number}>}
 */
export function planBeasts(ctx = {}) {
  const {
    beastDef,
    count = 12,
    height = medievalHeight,
    tries = 20000,
    minApart = 90,
  } = ctx;
  if (typeof beastDef !== 'function') throw new TypeError('planBeasts needs ctx.beastDef');

  /* The mix expanded into a repeating deal, so the ratio in `WILDLIFE_MIX` is
   * what the map actually gets rather than what a per-dart coin flip converges
   * to - at twelve sites a 3:1 coin flip lands on 12:0 often enough to matter.
   * Interleaved rather than blocked (wolf wolf wolf bear ...), so a `count`
   * that is cut short by a budget still carries both species. */
  const template = [];
  for (const m of WILDLIFE_MIX) for (let i = 0; i < m.weight; i++) template.push(m.species);
  const deal = [];
  for (let i = 0; i < count; i++) deal.push(template[i % template.length]);

  const rnd = streamFor('medieval:wildlife');
  const out = [];
  const reasons = Object.create(null);
  for (let t = 0; t < tries && out.length < count; t++) {
    const species = deal[out.length];
    const def = beastDef(species);
    const reach = reachFor(def);
    const x = (rnd() - 0.5) * 2 * HALF;
    const z = (rnd() - 0.5) * 2 * HALF;

    const why = rejectHome(x, z, reach, ctx);
    if (why) { reasons[why] = (reasons[why] ?? 0) + 1; continue; }
    /* Packs spread out from each other as well as from people. Two wolf packs
     * sharing a wood is four to ten wolves converging on one player, which is
     * not the encounter either pack was tuned for. */
    let clash = false;
    for (const o of out) {
      if ((o.x - x) ** 2 + (o.z - z) ** 2 < minApart * minApart) { clash = true; break; }
    }
    if (clash) { reasons.apart = (reasons.apart ?? 0) + 1; continue; }

    out.push({
      x, y: height(x, z), z,
      species,
      territory: def.territory,
      reach,
      wood: woodlandAt(x, z),
    });
  }
  out.reasons = reasons;
  return out;
}
