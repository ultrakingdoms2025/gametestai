/**
 * Who lives in Aldermoor Vale, derived from the settlement table.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A LIST OF PEOPLE
 *
 * `MedievalWorld._buildInhabitants` authors twelve named villagers and ten
 * bandit patrols at hand-written coordinates. That was right for a 400 m vale
 * with one village in it. It is wrong for a 900 m one with fourteen settlements
 * in it, and it is wrong in a way that gets worse rather than better: every new
 * place added to `Settlements.js` arrives EMPTY, and stays empty until somebody
 * remembers to come back to a nine-thousand-line world file and type twelve
 * more personas at coordinates they measured off a map.
 *
 * So nothing here names a place or a coordinate. Every function takes the
 * settlement table as an argument and asks it questions:
 *
 *   - how big is this place            -> `radius`
 *   - what sort of place is it         -> `kind`
 *   - where do its people actually live -> `ground`, the beaten-earth features
 *   - what does it trade in            -> the LANDFORM it stands on, or the
 *                                         reach of river it stands beside
 *
 * A settlement added to the table after this file was written gets a merchant,
 * a watch and a street full of people the moment it appears, without this file
 * being touched. That property is pinned by test with a settlement that does
 * not exist (`population-generic.test.mjs`), because a table-driven populator
 * that has only ever been run against the table it was written for is
 * indistinguishable from a hard-coded one.
 *
 * ---------------------------------------------------------------------------
 * KINDS IT HAS NEVER HEARD OF
 *
 * The table's `kind` is prose, not an enum: today it holds `village`, `hamlet`,
 * `castle`, `church`, `mill` and `ruin`, and the expansion adds a stilt fishing
 * village, a hill mining town, a monastery, a palisade fort and a crossroads
 * market town. Whatever words those arrive under, they must not fall off the
 * end of a `switch`.
 *
 * Resolution is therefore three-stage and always terminates:
 *
 *   1. exact match on the normalised kind,
 *   2. SUBSTRING match against every known kind, longest first - which is what
 *      catches `mining town`, `fishing village`, `market town`, `frontier
 *      fort`, `stilt hamlet` and anything else built out of a known noun,
 *   3. the default profile, scaled by `radius`.
 *
 * Stage 3 is the one that matters. A place whose kind is a word nobody
 * anticipated still gets people, still gets a merchant, and still gets a watch
 * proportional to how big it is. The failure mode of a populator is a silent
 * empty town, so there is no path through this file that produces one.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT WILL NOT DO
 *
 * It never places a second person on top of one a world has already authored.
 * `planPopulation` is handed the positions of everybody `_buildInhabitants`
 * wrote by hand, counts how many of them fall inside each settlement's radius,
 * and spends only the REMAINDER of that settlement's quota. Aldermoor already
 * has twelve residents and therefore gets almost nobody new; a town the
 * expansion adds with none gets its whole quota. The same arithmetic is what
 * makes this safe to merge with a branch that hand-authors a cast for one of
 * the new towns: those people simply count against the quota.
 *
 * Nothing in this file may import `three` or touch the DOM - same rule as
 * `Settlements.js`, and for the same reason: the interesting failures here are
 * arithmetic, and arithmetic should be testable without a renderer.
 */

import {
  HALF, WATER_Y, LANDFORMS, RIVER_FEATURES, riverZ, riverHalfWidth,
} from '../terrain/MedievalHeight.js';
import { SETTLEMENTS } from './Settlements.js';

/* ------------------------------------------------------------------ */
/* Determinism                                                         */
/* ------------------------------------------------------------------ */

/**
 * FNV-1a. The same hash `NPCManager._hashSeed` uses, reproduced rather than
 * imported because that one lives behind `three` and this file may not.
 * @param {string} str
 */
export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < (str?.length ?? 0); i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic 0..1 stream from a string key. */
export function streamFor(key) {
  let s = hashString(key) || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* Social profiles                                                     */
/* ------------------------------------------------------------------ */

/**
 * @typedef {object} Profile
 * @property {number} people    villagers/locals at the reference size
 * @property {number} guards    armed watch at the reference size
 * @property {number} vendors   merchants - at least one wherever anyone trades
 * @property {boolean} quest    does a questmaster belong here
 * @property {boolean} lore     is there something here worth being told about
 * @property {string} trade     default trade character (see `TRADE`)
 * @property {string} folk      what a plain resident of this place is called
 */

/**
 * The reference size. A settlement's quota scales with `radius / REFERENCE`,
 * so Aldermoor (108 m) is a busier village than a 40 m one without either
 * number being written down twice.
 */
export const REFERENCE_RADIUS = 70;

/** @type {Record<string, Profile>} */
export const PROFILES = {
  town:      { people: 6, guards: 2, vendors: 3, quest: true,  lore: true,  trade: 'market',   folk: 'townsfolk' },
  village:   { people: 5, guards: 1, vendors: 2, quest: true,  lore: false, trade: 'rural',    folk: 'villager' },
  hamlet:    { people: 3, guards: 1, vendors: 1, quest: false, lore: false, trade: 'rural',    folk: 'villager' },
  castle:    { people: 2, guards: 4, vendors: 1, quest: true,  lore: true,  trade: 'garrison', folk: 'servant' },
  fort:      { people: 1, guards: 4, vendors: 1, quest: true,  lore: true,  trade: 'garrison', folk: 'soldier' },
  monastery: { people: 3, guards: 0, vendors: 1, quest: true,  lore: true,  trade: 'monastic', folk: 'brother' },
  church:    { people: 1, guards: 0, vendors: 0, quest: false, lore: true,  trade: 'monastic', folk: 'parishioner' },
  mine:      { people: 4, guards: 1, vendors: 1, quest: true,  lore: false, trade: 'mine',     folk: 'miner' },
  mill:      { people: 1, guards: 0, vendors: 1, quest: false, lore: false, trade: 'rural',    folk: 'miller' },
  farm:      { people: 2, guards: 0, vendors: 1, quest: false, lore: false, trade: 'rural',    folk: 'farmhand' },
  camp:      { people: 2, guards: 1, vendors: 1, quest: false, lore: false, trade: 'rural',    folk: 'drover' },
  ruin:      { people: 0, guards: 0, vendors: 0, quest: false, lore: true,  trade: 'rural',    folk: 'wanderer' },
};

/**
 * The profile a kind nobody anticipated falls back to.
 *
 * Deliberately a real, populated place rather than an empty one. The whole
 * point of the fallback is that the failure mode of this file must never be a
 * silent ghost town, so an unrecognised kind gets a merchant, a watchman and a
 * street's worth of people - the wrong FLAVOUR is a cosmetic complaint, an
 * empty town is a hole in the world.
 */
export const DEFAULT_PROFILE = PROFILES.village;

/**
 * Words that mean a kind we do know, for the substring pass.
 *
 * Only entries whose meaning is not already carried by a known kind's own
 * spelling appear here: `mining town` needs no alias because it contains
 * `town`, but `abbey` shares no substring with `monastery`.
 */
export const KIND_ALIASES = {
  abbey: 'monastery', priory: 'monastery', minster: 'monastery', friary: 'monastery',
  chapel: 'church', shrine: 'church', parish: 'church',
  hold: 'fort', keep: 'castle', garrison: 'fort', outpost: 'fort',
  stronghold: 'fort', bastion: 'fort', palisade: 'fort', watchtower: 'ruin',
  city: 'town', borough: 'town', market: 'town', crossroads: 'town',
  mining: 'mine', quarry: 'mine', colliery: 'mine', delve: 'mine',
  thorp: 'hamlet', steading: 'hamlet', croft: 'farm', grange: 'farm',
  wharf: 'village', staithe: 'village', ferry: 'village',
  tower: 'ruin', barrow: 'ruin', henge: 'ruin', circle: 'ruin',
  lodge: 'camp', encampment: 'camp', bivouac: 'camp',
};

/** Lower-case, letters and digits only - `"St Ceolwine's Abbey"` -> `stceolwinesabbey`. */
export function normaliseKind(kind) {
  return String(kind ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Longest known kind first, so `town` never wins a match `monastery` should
 * have had. Computed once - the list is a module constant.
 */
const KIND_KEYS = [...Object.keys(PROFILES), ...Object.keys(KIND_ALIASES)]
  .sort((a, b) => b.length - a.length);

/**
 * Which profile a settlement's `kind` resolves to, and how it got there.
 *
 * `via` is returned because a populator that quietly falls back is a populator
 * whose fallbacks are never noticed: the test asserts on it, and the world's
 * summary reports it.
 *
 * @param {string} kind
 * @returns {{ key:string, profile:Profile, via:'exact'|'alias'|'substring'|'default' }}
 */
export function resolveKind(kind) {
  const n = normaliseKind(kind);
  if (PROFILES[n]) return { key: n, profile: PROFILES[n], via: 'exact' };
  if (KIND_ALIASES[n]) {
    const key = KIND_ALIASES[n];
    return { key, profile: PROFILES[key], via: 'alias' };
  }
  for (const word of KIND_KEYS) {
    if (!n.includes(word)) continue;
    const key = PROFILES[word] ? word : KIND_ALIASES[word];
    if (PROFILES[key]) return { key, profile: PROFILES[key], via: 'substring' };
  }
  return { key: 'village', profile: DEFAULT_PROFILE, via: 'default' };
}

/* ------------------------------------------------------------------ */
/* What a place trades in                                              */
/* ------------------------------------------------------------------ */

/**
 * Stock, sign and patter per trade character.
 *
 * `categories` are `Marketplace`'s (`cosmetic weapons tools health spells
 * mounts`); a stall that names none is a general trader, which is what every
 * existing medieval vendor is. Naming them is the point of the exercise: a
 * fishing village that sells plate armour is the sort of detail that makes a
 * world read as generated rather than built.
 */
export const TRADE = {
  market: {
    title: 'Market Goods', categories: ['tools', 'health', 'cosmetic', 'weapons'],
    sign: 'MARKET', sells: 'cloth, salt, iron and whatever the last cart brought in',
    gripe: 'the toll the crossroads levies on every wheel that turns through it',
  },
  rural: {
    title: 'Provisions', categories: ['health', 'tools'],
    sign: 'PROVISIONS', sells: 'bread, rope, tallow and cures of doubtful pedigree',
    gripe: 'the price of a sack of flour since the mill changed hands',
  },
  mine: {
    title: 'Ore & Tackle', categories: ['tools', 'weapons'],
    sign: 'ORE & TACKLE', sells: 'picks, lamp oil, cut ore and props for a bad roof',
    gripe: 'a seam running thin and a shaft that groans in the wet',
  },
  fishing: {
    title: 'Fish & Cordage', categories: ['health', 'tools'],
    sign: 'FISH & LINE', sells: 'smoked eel, netting, pitch and cord by the fathom',
    gripe: 'the water coming up over the walkboards twice a season now',
  },
  monastic: {
    title: 'Physic & Ink', categories: ['health', 'spells'],
    sign: 'PHYSIC', sells: 'tinctures, copied psalters, beeswax and blessed water',
    gripe: 'pilgrims who want a miracle and will not pay for a candle',
  },
  garrison: {
    title: 'Arms & Harness', categories: ['weapons', 'tools'],
    sign: 'ARMS', sells: 'mail rings, spear ferrules, whetstones and hard bread',
    gripe: 'a levy that arrives late and short every single quarter',
  },
  ford: {
    title: 'Wayfarer\'s Stall', categories: ['health', 'tools', 'mounts'],
    sign: 'WAYFARERS', sells: 'dry boots, feed, lantern wick and river news',
    gripe: 'travellers who try the crossing in spate and expect to be fished out',
  },
};

/** Trade character implied by the shape of ground a settlement stands on. */
const LANDFORM_TRADE = {
  escarpment: 'mine',     // a scarp is where a seam comes to the surface
  bluff: 'garrison',      // you put a fort on a bluff to watch what is below it
  combe: 'monastic',      // a sheltered fold is where a house of religion goes
  basin: 'market',        // roads meet on flat ground
};

/** Trade character implied by the reach of river a settlement stands beside. */
const RIVER_TRADE = { pool: 'fishing', braid: 'fishing', ford: 'ford', gorge: 'mine' };

/** True when `p` is inside the landform's published support box. */
function inAabb(a, x, z) {
  return x >= a.x0 && x <= a.x1 && z >= a.z0 && z <= a.z1;
}

/**
 * What this place trades in, derived rather than declared.
 *
 * The order is the order of confidence, and it is the whole reason a fishing
 * village and a mining town end up selling different things without either of
 * them being named in this file:
 *
 *   1. the table said so outright (`settlement.trade`), which is the hook a
 *      later phase can use for a place whose character none of this catches;
 *   2. it stands on a LANDFORM, and `LANDFORMS` already publishes what shape
 *      of ground each one is - a scarp is a mine, a bluff is a garrison, a
 *      combe is a monastery, a basin is a market;
 *   3. it stands on a named REACH of river, and `RIVER_FEATURES` already
 *      publishes what sort - a pool and a braid are fishing water, a ford is a
 *      crossing with a stall on it;
 *   4. failing all of that, whatever its kind implies.
 *
 * Steps 2 and 3 are why this works across a merge. The five settlements the
 * expansion adds are not in this file, but the ground they stand on is already
 * in `MedievalHeight.js` and says what it is.
 *
 * @param {{id?:string, kind?:string, trade?:string, centre:{x:number,z:number}}} s
 * @returns {{ id:string, def:object, via:string }}
 */
export function tradeFor(s, {
  landforms = LANDFORMS, riverFeatures = RIVER_FEATURES,
} = {}) {
  const pick = (id, via) => ({ id: TRADE[id] ? id : 'rural', def: TRADE[id] ?? TRADE.rural, via });
  if (s.trade && TRADE[s.trade]) return pick(s.trade, 'declared');

  const { x, z } = s.centre;
  for (const lf of landforms) {
    if (!lf.aabb || !inAabb(lf.aabb, x, z)) continue;
    const id = LANDFORM_TRADE[lf.kind];
    if (id) return pick(id, `landform:${lf.id}`);
  }
  /* Near enough to the channel to live off it. `len` is the reach's own
   * half-length, so this asks "is the settlement beside THIS reach" rather
   * than inventing a radius. The 120 m band across the channel is generous on
   * purpose: a stilt village sits back from the deepest water, not in it. */
  const bank = Math.abs(z - riverZ(x));
  if (bank < riverHalfWidth(x) + 120) {
    for (const f of riverFeatures) {
      if (Math.abs(x - f.x) > f.len + 70) continue;
      const id = RIVER_TRADE[f.kind];
      if (id) return pick(id, `river:${f.id}`);
    }
  }
  return pick(resolveKind(s.kind).profile.trade, 'kind');
}

/* ------------------------------------------------------------------ */
/* Names                                                               */
/* ------------------------------------------------------------------ */

/**
 * Period given names and bynames, in the register `ROLE_CAST.medieval`
 * already uses (Adela, Corwin, Hedric, Ulla, Marda, Aldous, Saewyn).
 *
 * A pool rather than a written cast because the cast has to cover fourteen
 * settlements and grow with the table; the personas below carry the character,
 * and a name's whole job is to be a name.
 */
const GIVEN = [
  'Alwin', 'Bryda', 'Cuthwin', 'Doryt', 'Edric', 'Frael', 'Gerith', 'Hilde',
  'Ivo', 'Jenkyn', 'Kentigern', 'Leofa', 'Maud', 'Nesta', 'Oswic', 'Perrin',
  'Quenild', 'Roswitha', 'Sewal', 'Thurstan', 'Ulfric', 'Verca', 'Wulfrun',
  'Ymma', 'Aldith', 'Bertrand', 'Cwenburh', 'Dunstan', 'Elswith', 'Fulke',
  'Godgifu', 'Hamo', 'Isolde', 'Joscelin', 'Kenric', 'Lettice', 'Milburga',
  'Nicholas', 'Osbert', 'Petronilla', 'Ranulf', 'Sibb', 'Tibbald', 'Ursel',
];
const BYNAME = [
  'Ashfoot', 'Barleycorn', 'Coldwell', 'Dryholt', 'Elmshaw', 'Fenwright',
  'Grimsby', 'Hollowbeck', 'Ilberd', 'Kettleby', 'Longstone', 'Marchfield',
  'Netherby', 'Oakhanger', 'Pikestaff', 'Quarrel', 'Redsill', 'Stanbrook',
  'Thornbury', 'Underhill', 'Wexcombe', 'Yarrow', 'Bellwright', 'Cordwain',
  'Draywell', 'Farthing', 'Gatesend', 'Hazelrigg', 'Lambhithe', 'Millward',
];

/** Honorific by role and trade, so a monk is Brother and a serjeant is not. */
function titleFor(role, trade, seed) {
  if (role === 'guard') return trade === 'garrison' ? (seed % 2 ? 'Serjeant' : 'Watchman') : 'Watchman';
  if (role === 'vendor') return trade === 'monastic' ? 'Infirmarer' : (seed % 3 === 0 ? 'Pedlar' : 'Merchant');
  if (role === 'lorekeeper') return trade === 'monastic' ? 'Brother' : 'Keeper';
  if (role === 'quest_manager') return 'Reeve';
  if (trade === 'monastic') return seed % 2 ? 'Brother' : 'Sister';
  if (trade === 'mine') return seed % 2 ? 'Hewer' : 'Goodwife';
  if (trade === 'fishing') return seed % 2 ? 'Fisher' : 'Netwright';
  return seed % 2 ? 'Goodman' : 'Goodwife';
}

/**
 * A name for one member of one settlement's cast.
 *
 * Deterministic in `(settlementId, index)` and nothing else, so the same seed
 * produces the same person in the same doorway. The two pools are coprime in
 * length (44 and 30), so walking a settlement's cast never repeats a full name
 * before it has run out of budget.
 */
function nameFor(settlementId, index, role, trade) {
  const h = hashString(`${settlementId}:${index}`);
  const given = GIVEN[h % GIVEN.length];
  const byname = BYNAME[(h >>> 7) % BYNAME.length];
  const title = titleFor(role, trade, (h >>> 3) & 0xff);
  return `${title} ${given} ${byname}`;
}

/* ------------------------------------------------------------------ */
/* Personas                                                            */
/* ------------------------------------------------------------------ */

/**
 * Build a persona for the chat model.
 *
 * Written to the same recipe as the hand-authored `ROLE_CAST.medieval` block:
 * state the job, an opinion and a grievance. The job comes from the role, the
 * opinion from the settlement's name and trade, and the grievance from the
 * trade's own `gripe` - which is why a Grimscar miner complains about a seam
 * and a Reedwater fisher complains about the water rising, without either town
 * appearing in this file.
 */
function personaFor({ role, place, trade, kindKey, folk }) {
  const t = TRADE[trade] ?? TRADE.rural;
  const where = `at ${place}`;
  switch (role) {
    case 'vendor':
      return `Keeps the stall ${where}, selling ${t.sells}. Prices everything twice - once for `
        + `neighbours and once for strangers - and will talk your ear off about ${t.gripe}. `
        + 'Buys anything you are willing to part with, and says so before you ask.';
    case 'guard':
      return `Stands the watch ${where}. Unhurried, hard to surprise, and civil to anyone who `
        + 'keeps their hands where they can be seen. Warns every traveller about the deep woods '
        + `after dark, and grumbles about ${t.gripe}.`;
    case 'quest_manager':
      return `The reeve ${where}: keeps the tally-sticks, settles disputes, and hands out the `
        + 'work nobody local wants to do. Formal, exact, and quietly delighted to have a '
        + `stranger to send somewhere unpleasant. Preoccupied with ${t.gripe}.`;
    case 'lorekeeper':
      return `Knows the history of ${place} and tells it whether or not it was asked for - who `
        + 'raised the stones, who burned what, and which of the old names the maps got wrong. '
        + 'Courteous, long-winded, and completely certain about details nobody can check.';
    case 'wanderer':
      return `A traveller on the road ${where}, carrying goods and gossip between the vale's `
        + 'settlements. Cheerful about the walking, sour about the roads, and full of news '
        + `about ${t.gripe} that is at least a fortnight out of date.`;
    default:
      return `A ${folk} of ${place}, out on the street ${kindKey === 'ruin' ? 'where nobody sensible goes' : 'for the day'}. `
        + `Proud of the place, rude about the next one over, and firmly of the opinion that ${t.gripe} `
        + 'is somebody else\'s fault. Happy to gossip with anyone who stands still long enough.';
  }
}

/* ------------------------------------------------------------------ */
/* Quotas                                                              */
/* ------------------------------------------------------------------ */

/**
 * How many of each role a settlement wants, before anything already authored
 * there is subtracted.
 *
 * Scaling is by radius against `REFERENCE_RADIUS` and is clamped: a 16 m parish
 * church must not round its one parishioner away, and a 110 m arc of hamlets
 * must not be given a city's worth of people. Vendors are floored at one
 * wherever the profile trades at all - a settlement the player can walk to and
 * cannot buy anything in is a settlement that has no reason to exist.
 *
 * @param {object} s a settlement table row
 * @returns {{ kindKey:string, via:string, trade:object, scale:number,
 *             people:number, guards:number, vendors:number,
 *             quest:boolean, lore:boolean, total:number }}
 */
export function quotaFor(s, opts = {}) {
  const { profile, key, via } = resolveKind(s.kind);
  const trade = tradeFor(s, opts);
  const radius = Number.isFinite(s.radius) ? Math.max(0, s.radius) : REFERENCE_RADIUS;
  const scale = Math.min(1.8, Math.max(0.45, radius / REFERENCE_RADIUS));
  const grow = (n) => (n <= 0 ? 0 : Math.max(1, Math.round(n * scale)));

  const people = grow(profile.people);
  const guards = grow(profile.guards);
  const vendors = profile.vendors > 0 ? Math.max(1, Math.round(profile.vendors * scale)) : 0;
  return {
    kindKey: key, via, trade, scale, radius,
    people, guards, vendors,
    quest: profile.quest, lore: profile.lore,
    folk: profile.folk,
    total: people + guards + vendors + (profile.quest ? 1 : 0) + (profile.lore ? 1 : 0),
  };
}

/* ------------------------------------------------------------------ */
/* Where they stand                                                    */
/* ------------------------------------------------------------------ */

/**
 * Candidate standing spots for a settlement, nearest-to-a-building first.
 *
 * A settlement's `ground` features ARE its inhabited places: every one is a
 * yard around a house, a market apron or a castle bailey, which is precisely
 * where a person would be. Walking them in order and ringing each one puts the
 * cast among the buildings rather than in a circle in a field - and it works
 * for a settlement added later without this function knowing anything about it,
 * because the yards come with the settlement.
 *
 * A settlement with no ground features - the churches, the windmill, the ruined
 * watchtower - falls back to rings about its centre, which is the best anyone
 * can do with a named point and a radius.
 *
 * @param {object} s
 * @param {() => number} rnd
 * @param {number} want how many spots are needed; the generator makes more
 * @returns {Array<{x:number,z:number}>}
 */
export function candidateSpots(s, rnd, want) {
  const out = [];
  const feats = Array.isArray(s.ground) ? s.ground : [];
  /* Three rings per feature at 1.35x, 1.9x and 2.6x its own radius: outside
   * the building's footprint, inside its yard, and out on the lane. */
  const RINGS = [1.35, 1.9, 2.6];
  for (const ring of RINGS) {
    for (const f of feats) {
      const r = (f.shape === 'rect' ? Math.max(f.hx, f.hz) : f.r) * ring;
      const a = rnd() * Math.PI * 2;
      const step = Math.PI * 2 / 3;
      for (let k = 0; k < 3; k++) {
        out.push({ x: f.x + Math.cos(a + k * step) * r, z: f.z + Math.sin(a + k * step) * r });
      }
    }
    if (out.length >= want * 4) break;
  }
  /* Always add centre rings, and not only as a fallback: a settlement whose
   * ground features are all at one end (the keep approach's arc) would
   * otherwise leave its own named centre deserted. */
  const radius = Number.isFinite(s.radius) ? s.radius : REFERENCE_RADIUS;
  const rings = Math.max(2, Math.ceil(want / 5));
  for (let ri = 0; ri < rings; ri++) {
    const r = radius * (0.18 + 0.22 * ri);
    const n = 6 + ri * 2;
    const a0 = rnd() * Math.PI * 2;
    for (let k = 0; k < n; k++) {
      const a = a0 + (k / n) * Math.PI * 2;
      out.push({ x: s.centre.x + Math.cos(a) * r, z: s.centre.z + Math.sin(a) * r });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The plan                                                            */
/* ------------------------------------------------------------------ */

/**
 * Default acceptance test for a standing spot.
 *
 * Deliberately weak: it knows about the playfield rim, the water line and the
 * channel, all of which are pure functions of position, and nothing about
 * buildings or roads - because those live on a built world and this module has
 * to work without one. `MedievalWorld` passes a stronger `open` that also
 * rejects footprints and paving; the test suite passes this one.
 */
export function defaultOpen(x, z, height) {
  if (!(x > -HALF + 6 && x < HALF - 6 && z > -HALF + 6 && z < HALF - 6)) return false;
  if (height(x, z) < WATER_Y + 0.6) return false;
  if (Math.abs(z - riverZ(x)) < riverHalfWidth(x) + 3) return false;
  return true;
}

/**
 * The roles handed out, in order, for one settlement.
 *
 * Vendors first so a settlement that loses the tail of its quota to a budget
 * still has somewhere to trade; the questmaster and the keeper next because
 * they are the reason to walk there at all; the watch and the townsfolk last
 * because they are the part that is allowed to be thin.
 */
function roleOrder(q) {
  const out = [];
  for (let i = 0; i < q.vendors; i++) out.push('vendor');
  if (q.quest) out.push('quest_manager');
  if (q.lore) out.push('lorekeeper');
  for (let i = 0; i < q.guards; i++) out.push('guard');
  for (let i = 0; i < q.people; i++) out.push(i % 3 === 2 ? 'wanderer' : 'loiterer');
  return out;
}

/**
 * Plan one settlement's cast.
 *
 * @param {object} s a settlement table row
 * @param {object} ctx
 * @param {(x:number,z:number)=>number} ctx.height
 * @param {(x:number,z:number)=>boolean} ctx.open
 * @param {number} [ctx.already] people a world already authored inside this
 *        settlement's radius; subtracted from the quota
 * @param {number} [ctx.budget] hard cap on how many this call may produce
 * @returns {Array<object>} spawn records with PLAIN `{x, y, z}` positions
 */
export function planSettlement(s, ctx) {
  const { height, open, already = 0, budget = Infinity, opts } = ctx;
  const q = quotaFor(s, opts);
  const rnd = streamFor(`pop:${s.id}`);
  const roles = roleOrder(q);
  /* Already-authored people count against the quota, and they count from the
   * BACK of the role order: a village with twelve hand-written residents keeps
   * its merchant and loses its filler, not the other way round. */
  const want = Math.max(0, Math.min(roles.length - already, budget));
  if (want <= 0) return [];

  const spots = candidateSpots(s, rnd, want);
  const out = [];
  const placed = [];
  const MIN_APART = 3.2;

  for (let i = 0; i < spots.length && out.length < want; i++) {
    const p = spots[i];
    if (!open(p.x, p.z)) continue;
    let clash = false;
    for (const o of placed) {
      if ((o.x - p.x) ** 2 + (o.z - p.z) ** 2 < MIN_APART * MIN_APART) { clash = true; break; }
    }
    if (clash) continue;

    const idx = out.length;
    const role = roles[idx];
    const y = height(p.x, p.z);
    const name = nameFor(s.id, idx, role, q.trade.id);
    const rec = {
      x: p.x, y, z: p.z,
      type: 'friendly',
      settlement: s.id,
      kindKey: q.kindKey,
      role,
      name,
      persona: personaFor({
        role, place: s.displayName ?? s.id, trade: q.trade.id,
        kindKey: q.kindKey, folk: q.folk,
      }),
      // Face roughly toward the settlement centre; characters face -Z at yaw 0.
      yaw: Math.atan2(-(s.centre.x - p.x), -(s.centre.z - p.z)),
    };
    if (role === 'vendor') {
      rec.vendorTitle = q.trade.def.title;
      rec.vendorCategories = q.trade.def.categories.slice();
      rec.signLines = [q.trade.def.sign, String(s.displayName ?? s.id).toUpperCase()];
    }
    if (role === 'quest_manager') {
      rec.isQuestManager = true;
      rec.signLines = ['REEVE', String(s.displayName ?? s.id).toUpperCase()];
    }
    if (role === 'lorekeeper') {
      rec.signLines = ['KEEPER', String(s.displayName ?? s.id).toUpperCase()];
    }
    /* A short patrol for the people who are allowed to move. Kept inside the
     * settlement and re-tested against `open`, so nobody's route walks them
     * into the river they were carefully not spawned in. */
    if (role === 'wanderer' || role === 'loiterer') {
      const legs = [{ x: p.x, y, z: p.z }];
      for (let k = 0; k < 3; k++) {
        const a = rnd() * Math.PI * 2;
        const r = role === 'wanderer' ? 8 + rnd() * 14 : 2.5 + rnd() * 3.5;
        const nx = p.x + Math.cos(a) * r;
        const nz = p.z + Math.sin(a) * r;
        if (open(nx, nz)) legs.push({ x: nx, y: height(nx, nz), z: nz });
      }
      if (legs.length > 1) rec.patrol = legs;
    }
    out.push(rec);
    placed.push(p);
  }
  return out;
}

/**
 * Travellers walking the roads between settlements.
 *
 * Placed on the road network rather than beside it, because the road IS the
 * reason they read as travellers: a wanderer standing in a field is a villager
 * who got lost. Each one is given the road's own polyline as a patrol, cropped
 * to a stretch they can plausibly walk, so they actually go somewhere - and the
 * roads run between towns, so a player following one meets people.
 *
 * @param {Array<{key:string,width:number,pts:Array<[number,number]>}>} roads
 * @param {object} ctx same shape as `planSettlement`'s
 */
export function planTravellers(roads, ctx) {
  const { height, open, budget = 0 } = ctx;
  if (budget <= 0 || !roads?.length) return [];
  /* Longest roads first: an arterial between two towns is worth a traveller,
   * a nine-metre village lane is not. Length is measured, not taken on trust,
   * because a road table added to later will not have sorted itself. */
  const scored = roads
    .map((r) => {
      let len = 0;
      for (let i = 1; i < r.pts.length; i++) {
        len += Math.hypot(r.pts[i][0] - r.pts[i - 1][0], r.pts[i][1] - r.pts[i - 1][1]);
      }
      return { r, len };
    })
    .filter((e) => e.len > 40 && e.r.minimap !== false)
    .sort((a, b) => b.len - a.len);
  if (!scored.length) return [];

  const out = [];
  const rnd = streamFor('pop:travellers');
  for (let i = 0; i < budget * 3 && out.length < budget; i++) {
    const { r } = scored[i % scored.length];
    const n = r.pts.length;
    // Start somewhere in the middle third, so the patrol has road either side.
    const at = Math.max(1, Math.min(n - 2, Math.floor((0.2 + rnd() * 0.6) * n)));
    const [x, z] = r.pts[at];
    // Two metres off the centreline: on the verge, not in the cart ruts.
    const px = r.pts[Math.min(n - 1, at + 1)];
    const tx = px[0] - x;
    const tz = px[1] - z;
    const tl = Math.hypot(tx, tz) || 1;
    const side = rnd() < 0.5 ? 1 : -1;
    const ox = x + (-tz / tl) * side * (r.width * 0.5 + 1.4);
    const oz = z + (tx / tl) * side * (r.width * 0.5 + 1.4);
    if (!open(ox, oz)) continue;
    if (out.some((o) => (o.x - ox) ** 2 + (o.z - oz) ** 2 < 900)) continue;

    const patrol = [];
    for (let k = Math.max(0, at - 6); k <= Math.min(n - 1, at + 6); k += 3) {
      const [qx, qz] = r.pts[k];
      if (open(qx, qz)) patrol.push({ x: qx, y: height(qx, qz), z: qz });
    }
    const idx = out.length;
    out.push({
      x: ox, y: height(ox, oz), z: oz,
      type: 'friendly',
      settlement: null,
      road: r.key,
      role: 'wanderer',
      kindKey: 'road',
      name: nameFor('road', idx, 'wanderer', 'market'),
      persona: personaFor({
        role: 'wanderer', place: 'the vale road', trade: 'market',
        kindKey: 'road', folk: 'carter',
      }),
      yaw: Math.atan2(-tx, -tz),
      patrol: patrol.length > 1 ? patrol : undefined,
    });
  }
  return out;
}

/**
 * Plan the whole vale's civilian population.
 *
 * @param {object} ctx
 * @param {Array<object>} [ctx.settlements] defaults to the shipped table
 * @param {Array<{x:number,z:number}>} [ctx.existing] already-authored friendlies
 * @param {(x:number,z:number)=>number} ctx.height
 * @param {(x:number,z:number)=>boolean} [ctx.open]
 * @param {Array<object>} [ctx.roads]
 * @param {number} [ctx.budget] cap on residents
 * @param {number} [ctx.travellerBudget] cap on road travellers
 * @returns {{ residents:Array<object>, travellers:Array<object>,
 *             perSettlement:Array<object> }}
 */
export function planPopulation({
  settlements = SETTLEMENTS,
  existing = [],
  height,
  open,
  /* Travellers belong ON the verge, and the standing-room test a resident uses
   * refuses anything within a couple of metres of a road edge - which is every
   * point on a road. A separate predicate rather than a flag, because the
   * caller is the only thing that knows what "beside a road but not in a
   * building" means for its world. */
  openTraveller,
  roads = [],
  budget = Infinity,
  travellerBudget = 0,
  opts,
} = {}) {
  const isOpen = open ?? ((x, z) => defaultOpen(x, z, height));
  const isVerge = openTraveller ?? isOpen;
  /* Biggest places first. When a budget binds it must bind on the parish
   * church with one parishioner in it, not on the market town - and
   * `SETTLEMENTS` is in the order it was written, which is not that order. */
  const order = [...settlements].sort(
    (a, b) => (b.radius ?? 0) - (a.radius ?? 0) || String(a.id).localeCompare(String(b.id))
  );

  const residents = [];
  const perSettlement = [];
  let left = budget;
  for (const s of order) {
    if (!s?.centre) continue;
    let already = 0;
    const r2 = (s.radius ?? REFERENCE_RADIUS) ** 2;
    for (const e of existing) {
      if ((e.x - s.centre.x) ** 2 + (e.z - s.centre.z) ** 2 <= r2) already++;
    }
    const made = planSettlement(s, { height, open: isOpen, already, budget: left, opts });
    residents.push(...made);
    left -= made.length;
    const q = quotaFor(s, opts);
    perSettlement.push({
      id: s.id, kind: s.kind, kindKey: q.kindKey, via: q.via,
      trade: q.trade.id, tradeVia: q.trade.via,
      quota: q.total, already, placed: made.length,
      vendors: made.filter((m) => m.role === 'vendor').length,
    });
    if (left <= 0) break;
  }

  const travellers = planTravellers(roads, {
    height, open: isVerge, budget: Math.min(travellerBudget, Math.max(0, left)),
  });
  return { residents, travellers, perSettlement };
}
