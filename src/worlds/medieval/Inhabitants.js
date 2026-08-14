import * as THREE from 'three';

import { planPopulation } from './Population.js';
import { planBeasts } from './Wildlife.js';
import { planRelicSites, planForestCaches, reachableFrom } from './Treasures.js';
import { MedievalResidency } from './Residency.js';
import { beastDef } from '../../npc/BeastSpecies.js';
import { SETTLEMENTS } from './Settlements.js';

/**
 * The one place `MedievalWorld` and the population planners meet.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL, AND WHY IT IS SHAPED LIKE THIS
 *
 * `MedievalWorld.js` is nine and a half thousand lines and is being edited by
 * more than one person at a time. Every line added to it is a merge conflict
 * somebody has to resolve by hand, and the lines most likely to conflict are
 * the ones inside `_buildInhabitants` - which is precisely where a naive
 * version of this work would have put four hundred of them.
 *
 * So the world's whole share of this feature is:
 *
 *     import { applyMedievalPopulation } from './medieval/Inhabitants.js';
 *     ...
 *     applyMedievalPopulation(this);              // end of _buildInhabitants
 *     ...
 *     this._population?.update(x, z, dt);         // in update()
 *
 * Three lines. Everything else - the settlement quotas, the trade tables, the
 * personas, the predator clearances, the treasure spread, the streaming - is
 * here or in the four pure modules beside it.
 *
 * The pure modules take a world only through callbacks (`height`, `open`,
 * `roadDist`), which is what lets the whole thing be tested without a renderer.
 * This file is the ONLY one that knows `MedievalWorld` exists, and the only one
 * in the set that imports `three`.
 *
 * ---------------------------------------------------------------------------
 * ORDER
 *
 * Called at the very end of `_buildInhabitants`, which is itself the last thing
 * `_buildGateAndSpawns` does - so by the time this runs the roads, footprints,
 * paving and enterables are all built and can be asked questions. It reads
 * `world.npcSpawns` as it finds it, which means anything a world author has
 * hand-written there counts against the quota rather than doubling it. That is
 * the property that makes this safe to merge with a branch adding a hand-
 * written cast to a new town.
 */

/* ------------------------------------------------------------------ */
/* Budgets                                                             */
/* ------------------------------------------------------------------ */

/**
 * Hostiles. Unchanged from the engine default of 10, and deliberately.
 *
 * The vale authors exactly ten bandit patrols, so raising the budget would buy
 * nothing, and hostiles cannot stream: `NPCManager.spawnOne` hard-returns null
 * for `type: 'hostile'` and its docstring explains why (no respawn bookkeeping,
 * no weapon deal). The danger the expansion adds is wildlife, which does have a
 * post-spawn entry point.
 */
export const HOSTILE_BUDGET = 10;

/**
 * Civilians spawned at world activation, before anything streams.
 *
 * LOWER than the engine default of 30, which looks backwards for a world that
 * is five times bigger and is the whole budget decision in one number.
 *
 * `spawnForWorld` spends this on 12 hand-authored residents, one lorekeeper and
 * a hub crowd, and every one of them is PERMANENT - they exist while the player
 * is 600 m away at Blackmarch, paying the O(n2) separation sweep, the O(n)
 * LOD pass, a 6 Hz animator tick each and a share of the grounding watchdog's
 * period, for a plaza nobody is standing in. At the default the crowd filler
 * alone holds seventeen of those slots.
 *
 * 22 leaves nine for the crowd - enough that the market square still reads as a
 * market square from the gateway, which is the shot it was tuned for - and
 * hands the rest of `maxNPCs` to the streamer, which spends it where the player
 * actually is. Same local density, a third of the global cost, and it scales to
 * fourteen settlements instead of one.
 */
export const FRIENDLY_BUDGET = 22;

/**
 * Beasts spawned from `npcSpawns` at activation: none.
 *
 * Every pack streams. A beast is 22 meshes and 15 shadow casters against a
 * humanoid's 2, and `BeastNPC._sense` builds a candidate list of the player
 * plus every live friendly on a 0.18 s timer - so a permanent wolf on the far
 * side of the map costs real work to be invisible. `MedievalResidency` caps
 * itself at 8 live bodies, comfortably under `NPCManager`'s own ceiling of 14.
 */
export const BEAST_BUDGET = 0;

/** Roster sizes. These are SPECS, which cost an object each. */
export const ROSTER = {
  /* Enough for fourteen settlements at full quota plus travellers. Sized
   * against the plan, not guessed: the nine shipped settlements ask for 43 and
   * the five the expansion adds ask for roughly another 44. */
  residents: 120,
  travellers: 8,
  /* Twelve pack sites. At a wolf's 3-5 that is up to ~46 animals authored
   * across 810,000 m2, of which at most 8 are ever alive. */
  beasts: 12,
};

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

/** A world-space vector on the world's own ground. */
function at(world, x, z, dy = 0) {
  return new THREE.Vector3(x, world._height(x, z) + dy, z);
}

/** Turn a planner record into an `npcSpawns`-shaped spec. */
function toSpec(world, r) {
  const spec = {
    position: at(world, r.x, r.z),
    type: 'friendly',
    name: r.name,
    persona: r.persona,
    role: r.role,
    yaw: r.yaw,
  };
  if (r.patrol?.length) spec.patrol = r.patrol.map((p) => at(world, p.x, p.z));
  if (r.vendorCategories) spec.vendorCategories = r.vendorCategories;
  if (r.vendorTitle) spec.vendorTitle = r.vendorTitle;
  if (r.signLines) spec.signLines = r.signLines;
  if (r.isQuestManager) spec.isQuestManager = true;
  spec.settlement = r.settlement ?? null;
  return spec;
}

/**
 * Populate the vale, stock it and stream it.
 *
 * Mutates `world`:
 *   `hostileBudget` / `friendlyBudget` / `beastBudget`  - see above
 *   `_roofs`        relic sites, consumed by `Relics._onWorld`
 *   `enterables`    gains the doorless woodland caches, streamed by `Interiors`
 *   `_population`   the residency, also pushed onto `_owned` so `dispose` runs
 *   `populationSummary`  what it did, for the harness and the headless gates
 *
 * @param {import('../MedievalWorld.js').MedievalWorld} world
 * @returns {object} the summary
 */
export function applyMedievalPopulation(world) {
  const height = (x, z) => world._height(x, z);

  /* Everything already in `npcSpawns` is somebody the world author placed by
   * hand. Counted, never moved, and subtracted from the quota of whatever
   * settlement it stands in. */
  const existing = (world.npcSpawns ?? [])
    .filter((s) => s.type !== 'hostile' && s.type !== 'beast' && s.position)
    .map((s) => ({ x: s.position.x, z: s.position.z }));

  /* Standing room, asked of the world rather than re-derived: `_isOpenGround`
   * already knows about the castle, the market, the river, the road network and
   * every building footprint, and it is the same test the vegetation scatter
   * passes - so a civilian stands exactly where the world was already willing
   * to grow a bush. */
  const open = (x, z) => world._isOpenGround(x, z, 0.6);
  /* Travellers are the exception: they belong ON the verge, and
   * `_isOpenGround` rejects anything within 2.2 m of a road edge. They still
   * have to clear buildings, water and the playfield. */
  const openVerge = (x, z) => world._inPlayfield(x, z, 4)
    && world._height(x, z) > 1.5
    && !world._inFootprint(x, z, 0.8);

  const plan = planPopulation({
    settlements: SETTLEMENTS,
    existing,
    height,
    open,
    openTraveller: openVerge,
    roads: world._roadPaths ?? [],
    budget: ROSTER.residents,
    travellerBudget: ROSTER.travellers,
  });

  /* Predators. Handed the FULL civilian roster, not just the authored twelve,
   * so a pack cannot be planted on top of a merchant the streamer will bring
   * into existence the moment the player walks over the hill. */
  const people = [
    ...existing,
    ...plan.residents.map((r) => ({ x: r.x, z: r.z })),
    ...plan.travellers.map((r) => ({ x: r.x, z: r.z })),
  ];
  const beastSites = planBeasts({
    beastDef,
    count: ROSTER.beasts,
    height,
    people,
    settlements: SETTLEMENTS,
    roadDist: (x, z) => world._roadDist(x, z),
    slope: (x, z) => world._slope(x, z),
  });

  /* ---- budgets ---------------------------------------------------- */
  world.hostileBudget = HOSTILE_BUDGET;
  world.friendlyBudget = FRIENDLY_BUDGET;
  world.beastBudget = BEAST_BUDGET;

  /* ---- collectables ------------------------------------------------ */
  const reach = reachableFrom(world.playerSpawn.x, world.playerSpawn.z, { height });
  const relics = planRelicSites({ height, settlements: SETTLEMENTS, reach });
  const caches = planForestCaches({ height, settlements: SETTLEMENTS, reach });

  /* `Relics` reads `_roofs` verbatim and lifts each by 0.55 m - it does no
   * grounding of its own, which is why every `y` here is the world's own
   * height function and not a guess. */
  world._roofs = relics.map((r) => ({ x: r.x, y: r.y, z: r.z }));
  if (!Array.isArray(world.enterables)) world.enterables = [];
  for (const c of caches) {
    world.enterables.push({
      label: c.label,
      origin: new THREE.Vector3(c.x, c.y, c.z),
      doors: [],
      collectibleSpots: [{ position: new THREE.Vector3(c.x, c.y, c.z), tier: c.tier }],
    });
  }

  /* ---- streaming --------------------------------------------------- */
  const residency = new MedievalResidency({
    npcManager: () => (world.active ? world.ctx?.npcManager ?? null : null),
    people: [...plan.residents, ...plan.travellers].map((r) => toSpec(world, r)),
    beasts: beastSites.map((b) => ({
      position: at(world, b.x, b.z),
      species: b.species,
      territory: b.territory,
    })),
  });
  world._population = residency;
  if (Array.isArray(world._owned)) world._owned.push(residency);

  const summary = {
    settlements: plan.perSettlement,
    residents: plan.residents.length,
    travellers: plan.travellers.length,
    authored: existing.length,
    beastSites: beastSites.length,
    beastReasons: beastSites.reasons,
    relics: relics.length,
    forestCaches: caches.length,
    reachable: reach.reached / reach.cells,
    budgets: {
      hostile: HOSTILE_BUDGET, friendly: FRIENDLY_BUDGET, beast: BEAST_BUDGET,
      maxLive: residency.maxLive, maxLiveBeasts: residency.maxLiveBeasts,
    },
  };
  world.populationSummary = summary;
  return summary;
}
