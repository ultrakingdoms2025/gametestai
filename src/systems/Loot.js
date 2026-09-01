import * as THREE from 'three';
import { ITEMS, itemDef, KIND_ACCENT, mountPowerItemId, mountPowerName } from './ItemDefs.js';
import { allows } from '../worlds/WorldRules.js';

/**
 * NPC loot drops and the world pickups they spawn.
 *
 * The pickups are a fixed pool built once at construction and parked hidden in
 * the scene. Nothing here allocates after that: no geometry, no material and no
 * vector is created while the game is running, and a drop is a matter of moving
 * an existing group and turning it on.
 *
 * That was long claimed to make every pickup material present for the boot
 * warmup, and it does not - see `warmAccents`. Building a material is not the
 * same as putting it on a mesh, and only the `ammo` set is ever worn by default,
 * so the first rare drop of a session linked five programs and froze the game
 * for 1.65 s. `warmAccents` is what actually makes the claim true.
 *
 * Deliberately **no lights**. A point light per pickup would look lovely and
 * would also change the scene light count at runtime, which invalidates Three's
 * whole program cache - the exact failure that cost this project a 63 s freeze
 * on first bow draw. The glow is an additive sprite and an emissive core.
 *
 * Overflow rules, per contract: bag first, store as overflow, and if neither
 * can take an item it stays on the ground as a smaller pile.
 */

/* ------------------------------------------------------------------ */
/* Scratch. Each function owns its own - two aliasing bugs from shared  */
/* scratch vectors cost this project days (see Physics.js _rc/_ct).     */
/* ------------------------------------------------------------------ */
const _sp = new THREE.Vector3(); // _spawnAt
const _ck = new THREE.Vector3(); // _collectCheck
const _dl = new THREE.Vector3(); // _dropFor

/* Pool size, and why it went up.
 *
 * 20 slots with 18 concurrent was sized for one 200 m deck where the only
 * persistent pickups were three caches. The station is now five decks and
 * carries well over a hundred authored interior collectibles between the hab
 * stacks, the zones and the crew rooms.
 *
 * The number matters more than it looks, because persistent pickups are exempt
 * from recycling: `_recycleOldest` only ever evicts a non-persistent one, so
 * once the active list is full of caches and interior spots it returns null and
 * *every corpse drop in the game silently stops spawning*. Interiors now streams
 * its spots by proximity (see Interiors.update) so the concurrent count stays
 * low whatever the map size, and this raise is the headroom on top of that: a
 * player standing in a hab stack with eight floors of spots in range, fighting,
 * with two caches nearby, must still have slots left for the drop.
 *
 * A pickup is a handful of instanced quads and a light-less root, so the cost of
 * the extra twelve is trivial next to that failure mode.
 */
const POOL_SIZE = 34;
/** Concurrent pickups. Beyond this the oldest non-persistent one is recycled. */
const MAX_ACTIVE = 30;
/** Seconds a pickup waits to be collected before it fades away. */
const LIFETIME = 150;
/** Walk-over radius, metres. Generous because the player is a fast mover. */
const AUTO_RANGE = 1.7;
/** `E` range, metres. */
const PROMPT_RANGE = 3.2;

/**
 * Credits are always part of a drop; ammo depends on the world.
 *
 * Exported so the rows can be pinned without constructing a `Loot`, whose
 * constructor paints canvas textures and therefore cannot run under Node; see
 * scripts/tests/citadel-economy.test.mjs.
 */
export const DROP_TABLES = {
  station: [
    { id: 'bullet', chance: 0.72, min: 20, max: 60 },
    { id: 'fireball_charge', chance: 0.2, min: 1, max: 3 },
    { id: 'arrow', chance: 0.14, min: 5, max: 12 },
    { id: 'alloy_scrap', chance: 0.3, min: 1, max: 3 },
    { id: 'medkit', chance: 0.13, min: 1, max: 1 },
    { id: 'nexus_shard', chance: 0.06, min: 1, max: 1 },
  ],
  medieval: [
    { id: 'arrow', chance: 0.7, min: 8, max: 24 },
    { id: 'bullet', chance: 0.24, min: 15, max: 40 },
    { id: 'relic_coin', chance: 0.32, min: 1, max: 4 },
    { id: 'fireball_charge', chance: 0.14, min: 1, max: 2 },
    { id: 'medkit', chance: 0.12, min: 1, max: 1 },
    { id: 'nexus_shard', chance: 0.05, min: 1, max: 1 },
  ],
  /* Sunspire Citadel. A fortress on a mesa with no foundry and one mule road.
   *
   * It had no row at all, so `_dropFor`'s `?? DROP_TABLES.station` fallback had
   * the garrison of a desert citadel dropping 6 mm caseless and ember cores -
   * in a world whose caches pay in crown coins and broadhead arrows and whose
   * market charges 1.55x for ammunition precisely because none is made here.
   *
   * Every number below is derived from something already in the repo rather
   * than chosen, and each derivation is an assertion in
   * scripts/tests/citadel-economy.test.mjs:
   *
   *   arrow      the ammunition CACHE_TABLES.citadel already pays in, and the
   *              only one. Expected 7.3 shafts a body against the vale's 18.0
   *              units of mixed ammunition, because WORLD_MARKETS pays 1.30
   *              here against the vale's 1.15 - a vendor paying more is the
   *              game saying the place is short of it.
   *   relic_coin the denomination. WORLD_MARKETS discounts a crown coin to
   *              0.50 here, the lowest anywhere one is priced at all and below
   *              the vale's 0.55, so coins must fall more freely here than they
   *              do there (0.44 against 0.32).
   *   medkit     0.10, the lowest of any world (0.12-0.20 elsewhere), because
   *              consumables buy at 1.45 here - the highest of the five.
   *   nexus_shard 0.05, the rarity every other world already gives it
   *              (0.05, 0.06 at the station); a shard is a portal artefact and
   *              belongs to no local economy.
   *
   * No alloy_scrap, matching CACHE_TABLES.citadel: hull plate is a station
   * by-product and there is nothing on this mesa that sheds it. */
  citadel: [
    { id: 'relic_coin', chance: 0.44, min: 2, max: 6 },
    { id: 'arrow', chance: 0.66, min: 6, max: 16 },
    { id: 'nexus_shard', chance: 0.05, min: 1, max: 1 },
    { id: 'medkit', chance: 0.1, min: 1, max: 1 },
  ],
  sports: [
    { id: 'bullet', chance: 0.5, min: 20, max: 50 },
    { id: 'arrow', chance: 0.4, min: 6, max: 18 },
    { id: 'fireball_charge', chance: 0.18, min: 1, max: 2 },
    { id: 'medkit', chance: 0.2, min: 1, max: 2 },
    { id: 'alloy_scrap', chance: 0.2, min: 1, max: 2 },
    { id: 'nexus_shard', chance: 0.05, min: 1, max: 1 },
  ],
  /* Lodestar Yard, and NOTHING IN THE WORLD ROLLS IT TODAY.
   *
   * `DockWorld` sets `rules.hostiles: false` - it is a civilian worksite, and
   * a firefight inside a hangar full of walk-in hulls puts the interior work
   * and the combat work in each other's way for no gain. So this table exists
   * for three reasons, none of which is "the yard drops loot":
   *
   *   1. The rule can flip. When it does, the fallback three lines below is
   *      SILENT, and a security detail in a shipyard would start dropping
   *      6 mm caseless and ember cores out of the Aether Nexus armoury -
   *      which is exactly what a desert citadel's garrison did for a whole
   *      release.
   *   2. `quest-vocab` reads this table to decide whether a `collect` step is
   *      completable. Without a row here it reads the STATION's, and a quest
   *      step asking for `bullet` in the yard would pass validation while
   *      being unobtainable. Two shipped citadel steps did precisely that.
   *   3. It is the honest statement of what this world manufactures, which is
   *      the same list `CACHE_TABLES.dock` pays out and `WORLD_MARKETS.dock`
   *      prices at a discount, and those three have to agree.
   *
   * Every number is derived rather than chosen:
   *   laser_cell    the ammunition the yard makes and the flight drop fires.
   *                 Highest chance and by far the biggest quantity, because
   *                 `WORLD_MARKETS.dock` pays only 0.9 for ammo here - a
   *                 vendor paying LESS is the game saying the place is full
   *                 of it. 14-50 rather than the 10-30 first drafted, and the
   *                 spread is DRIVEN by the law in citadel-economy.test.mjs
   *                 ("what a corpse carries falls as the region's price for
   *                 that kind rises"): at 0.62 x 20 = 12.40 expected units the
   *                 yard carried LESS ammunition than the vale, which pays
   *                 1.15 and carries 18.01 - i.e. the drop table said the yard
   *                 was short of the thing its own market says it is drowning
   *                 in. 0.62 x 32 = 19.84 sits above the vale's 18.01 and
   *                 below the sports ground's 22.57, which is exactly where a
   *                 world paying 0.9 belongs between one paying 1.15 and
   *                 another paying 0.9 with a supply chain behind it. Cells
   *                 come racked in tens, so a wide spread is also what they
   *                 physically are.
   *   hull_plate    the yard's own by-product; vendors pay 0.7.
   *   alloy_scrap   0.48, higher than the station's 0.30, because a yard sheds
   *                 more offcut than a concourse does. Bought at 0.6, the
   *                 lowest price paid for it anywhere.
   *   thruster_coil 0.16 and never more than one: it is a 78 CR component out
   *                 of a drive, not swarf.
   *   medkit        0.18, and driven by the same law. `WORLD_MARKETS.dock`
   *                 pays 0.95 for a consumable against the station's 1.00 and
   *                 the sports ground's 0.70, so the yard has to carry MORE
   *                 medicine than the station (0.13) and LESS than the sports
   *                 ground (0.30). It reads true as well as computing: an
   *                 industrial site with a first-aid point at every berth has
   *                 more trauma kit lying about than a concourse and less than
   *                 a place whose entire business is people hurting
   *                 themselves.
   *   nexus_shard   0.05, the rarity every world gives it. A shard is a portal
   *                 artefact and belongs to no local economy.
   * No `relic_coin` and no `arrow`: nothing on this site has ever produced
   * either, which is the whole point of `WORLD_MARKETS.dock` paying 1.7 for a
   * coin. */
  dock: [
    { id: 'laser_cell', chance: 0.62, min: 14, max: 50 },
    { id: 'hull_plate', chance: 0.4, min: 1, max: 3 },
    { id: 'alloy_scrap', chance: 0.48, min: 2, max: 5 },
    { id: 'thruster_coil', chance: 0.16, min: 1, max: 1 },
    { id: 'medkit', chance: 0.18, min: 1, max: 1 },
    { id: 'nexus_shard', chance: 0.05, min: 1, max: 1 },
  ],
};

/**
 * Ordered so the pickup takes its colour from the rarest thing in it.
 *
 * `mountpower` sits with `skin` at the top because a mount upgrade lying on
 * the ground is the rarest thing a pickup can hold - it is placed by hand in
 * the map editor and by nothing else. It is here rather than only in
 * `KIND_ACCENT` because `_buildPool` builds one material set per entry and
 * `warmAccents` warms every set it finds: a kind that reaches a pickup
 * without an entry here would either fall back to the currency amber (a lie
 * about what is on the floor) or, if `_buildPool` had been keyed on
 * `KIND_ACCENT` instead, link its shaders on first sight - the 1.65 s freeze
 * this file's header records.
 *
 * `shipskin` leads the list, ahead even of `skin`, and it is here for the
 * WARM-UP rather than for the ranking. A ship livery is purchase-only: it is
 * in no drop table, no cache table and no supply want, and
 * `citadel-economy.test.mjs` and `ship-livery-item.test.mjs` both assert that.
 * So in normal play it never reaches a pickup at all - but the map editor can
 * lay any item on the ground, and the cost of NOT having it here is not a
 * wrong colour, it is a shader link on first sight in front of the player.
 * One extra material set at boot against that is not a trade worth thinking
 * about. Ranked first because if one ever IS on the floor beside a medkit, the
 * livery is unambiguously the rarer of the two.
 */
const ACCENT_PRIORITY = ['shipskin', 'skin', 'mountpower', 'trinket', 'consumable', 'ammo', 'currency'];

/* ------------------------------------------------------------------ */
/* What a pickup holds, and what collecting one does                    */
/*                                                                      */
/* Module functions rather than methods because `Loot`'s constructor    */
/* paints canvas textures and cannot be built under Node; the tests in  */
/* scripts/tests/loot-grant.test.mjs reach these directly, and the      */
/* methods below are one-line delegates.                                */
/*                                                                      */
/* A contents entry is `{ itemId, qty }` - stock for the bag - or, for  */
/* a mount upgrade the map editor laid down, `{ grant, qty: 1 }` where   */
/* `grant` is `{ effect:'grant_mount_power', mount, power, tier, name }` */
/* (MapOverlay.grantForPlacement). A grant IS stock: it resolves to a    */
/* `mountpower` bag item and goes through the same `acquire` everything  */
/* else does. It did not always - see `collectEntry` for the defect that */
/* cost, and for why the entry keeps its grant shape all the same.       */
/* ------------------------------------------------------------------ */

/**
 * What a grant is called: the catalogue's own name when the placement
 * carried one, else mount + stat + tier the way the shop spells its rows
 * (`Bicycle Speed III` - the stat label from `STAT_META`, since `power`'s
 * shop name is Speed and `strength`'s is Acceleration).
 *
 * The fallback is `ItemDefs.mountPowerName`, which is also what NAMES the bag
 * item this pickup now yields. It used to be a second copy of the same three
 * lines here, and a second copy is how the ground and the bag come to disagree
 * about what one upgrade is called.
 *
 * @param {{mount?:string, power?:string, tier?:number, name?:string}} grant
 */
export function grantLabel(grant) {
  if (typeof grant?.name === 'string' && grant.name.trim()) return grant.name;
  return mountPowerName(grant?.mount, grant?.power, grant?.tier);
}

/**
 * The accent kind one entry reads as: an item's catalogue kind, and for a
 * grant the kind of the item that grant now yields.
 *
 * It used to read `consumable` for a grant, which was true when collecting one
 * applied a power on the spot. It no longer does - a grant lands in the bag as
 * a `mountpower` row - and a pickup painted the consumable green while holding
 * an upgrade would be teaching the player the wrong colour for the one pickup
 * that is only ever placed by hand.
 */
function kindOf(entry) {
  return entry?.grant ? 'mountpower' : ITEMS[entry?.itemId]?.kind;
}

/** The strongest accent among the contents, in `ACCENT_PRIORITY` order; currency when nothing matches. */
export function accentFor(contents) {
  for (const kind of ACCENT_PRIORITY) {
    for (const c of contents) {
      if (kindOf(c) === kind) return kind;
    }
  }
  return 'currency';
}

/** The HUD label for a pickup: `60 RND · Bicycle Speed III`. A grant carries no count. */
export function labelFor(contents) {
  const parts = [];
  for (const c of contents) {
    if (c.grant) {
      parts.push(grantLabel(c.grant));
      continue;
    }
    const def = itemDef(c.itemId);
    parts.push(`${c.qty} ${def?.short ?? c.itemId}`);
  }
  return parts.join(' · ');
}

/**
 * Collect ONE contents entry. Answers whether anything was taken and what,
 * if anything, stays on the ground.
 *
 * `loot:collected` is the canonical pickup event - QuestSystem advances
 * collect steps straight from it (_onCollect). Emitting quest:activity here
 * as well made every real pickup count TWICE, because QuestSystem subscribes
 * to both. Measured in-game: one pickup, +2 progress.
 *
 * -- A GRANT LANDS IN THE BAG. It does not apply itself. -------------
 *
 * This branch used to emit `mount:power:buy` here and return `taken: true`
 * without ever calling `inventory.acquire`. The player's report was exact:
 * "it shows I picked them up, but the inventory does not show them so I
 * cannot use them". The flourish, the toast and the tier were all real; the
 * row was not, and the pickup was the only thing in the game that took an
 * upgrade straight past the bag.
 *
 * So a grant is now stock like everything else: it resolves to its
 * `mountpower` bag item (`ItemDefs.mountPowerItemId`) and goes through the
 * SAME `acquire` the item branch below uses, with the same consequences - a
 * full bag leaves it on the ground, and `taken` is false when nothing was
 * accepted. `mount:power:buy` moved to `ItemUse._useMountPower`, which is
 * where the player now decides to spend it.
 *
 * `loot:collected` keeps `itemId: null` and carries the `grant`. That is not
 * a leftover: `HUD.js` returns early on a null `itemId` precisely so a grant
 * names itself through the `hud:notify` below, and an id of
 * `mountpower_bicycle_power_3` would reach `ITEM_LABELS`, miss, and toast the
 * raw id beside a perfectly good name. QuestSystem reads the same event and
 * has never matched on a grant.
 *
 * @param {{itemId?:string, grant?:object, qty:number}} entry
 * @param {{bus?:object, economy?:object, inventory?:object, fromCache:boolean, pickup:object|null}} deps
 * @returns {{taken:boolean, left:{itemId:string, qty:number}|{grant:object, qty:number}|null}}
 */
export function collectEntry(entry, { bus, economy, inventory, fromCache, pickup }) {
  if (entry.grant) {
    const g = entry.grant;
    const itemId = mountPowerItemId(g.mount, g.power, Math.max(1, Math.floor(Number(g.tier) || 1)));
    const res = inventory?.acquire(itemId, 1) ?? { taken: 0, dropped: 1 };
    if (res.taken > 0) {
      bus?.emit('loot:collected', { itemId: null, grant: g, qty: res.taken, fromCache, pickup });
      bus?.emit('hud:notify', {
        text: `+${grantLabel(g)}${res.toStore > 0 ? ' (store)' : ''}`,
        tone: 'info',
      });
    }
    /* The remainder keeps its GRANT shape, not the item id it resolved to.
     * `_collect` writes what comes back straight into `pickup.contents`, and
     * `labelFor`/`accentFor` read `contents[].grant`: hand back an `{itemId}`
     * here and a refused upgrade would sit on the floor relabelled as a
     * one-of-something with the wrong colour, and `MapOverlay._sweepOwned` -
     * which looks for `contents[0].grant` - would stop recognising it. */
    return { taken: res.taken > 0, left: res.taken > 0 ? null : { grant: g, qty: 1 } };
  }
  if (entry.itemId === 'credits') {
    economy?.add(entry.qty, 'loot');
    bus?.emit('loot:collected', { itemId: 'credits', qty: entry.qty, fromCache, pickup });
    return { taken: true, left: null };
  }
  const res = inventory?.acquire(entry.itemId, entry.qty) ?? { taken: 0, dropped: entry.qty };
  if (res.taken > 0) {
    bus?.emit('loot:collected', { itemId: entry.itemId, qty: res.taken, fromCache, pickup });
    bus?.emit('hud:notify', {
      text: `+${res.taken} ${itemDef(entry.itemId)?.name ?? entry.itemId}${res.toStore > 0 ? ' (store)' : ''}`,
      tone: 'info',
    });
  }
  return { taken: res.taken > 0, left: res.dropped > 0 ? { itemId: entry.itemId, qty: res.dropped } : null };
}

/* ------------------------------------------------------------------ */
/* Procedural textures (built once, shared by every pickup)            */
/* ------------------------------------------------------------------ */

function makeHaloTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 62);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.18, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.52, 'rgba(255,255,255,0.14)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Vertical fade for the marker beam - bright at the base, gone at the top. */
function makeBeamTexture() {
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 128, 0, 0);
  grad.addColorStop(0, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.3)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 8, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ------------------------------------------------------------------ */
/* Aerial perspective for the ADDITIVE layers                          */
/* ------------------------------------------------------------------ */

/**
 * `fog: true` on its own would make a pickup at range WORSE, not better.
 *
 * Three's stock `<fog_fragment>` is `mix( colour, fogColor, fogFactor )`.
 * That is right for a surface, which is being *veiled* by haze. It is wrong
 * for an additive layer, which is being *added* to whatever is behind it: a
 * fully fogged additive card would add `fogColor` at full strength, so the
 * ring, the halo and the beam would paint a hard dot of pure haze colour over
 * the sky - a brighter dot at 800 m than at 8 m. Turning the flag on and
 * walking away is the trap here.
 *
 * Emitted light is SWALLOWED by haze, not tinted by it, so the additive
 * layers multiply toward zero instead. This is not a new idea in this
 * repository: `systems/Projectiles.js` and `systems/VFX.js` both carry
 * `#ifdef ADDITIVE_BLEND col *= 1.0 - fogFactor;` in their own particle
 * shaders, with the same one-line reason. Those two own their shaders
 * outright; these three are stock Three materials, so the same rule arrives
 * as a chunk replacement.
 *
 * The chunk sits after `<tonemapping_fragment>` and `<colorspace_fragment>`
 * in both `meshbasic` and `sprite`, so the multiply lands on the encoded
 * value. That is deliberate and left alone: it attenuates the emitted light
 * by `(1 - fogFactor) ^ 2.4` in linear terms, i.e. slightly faster than the
 * haze veils a surface, which is the right side to err on for the things
 * that were punching through it.
 *
 * WORLDS WITH NO FOG ARE UNCHANGED. `USE_FOG` needs `scene.fog` as well as
 * `material.fog`, and `main.js applyEnvironment` leaves `scene.fog = null`
 * wherever `environment.fogFar` is 0 (the station interior, the maze). A
 * world with no aerial perspective has none for a pickup to match, and this
 * compiles out to nothing there.
 */
const ADDITIVE_FOG_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  gl_FragColor.rgb *= 1.0 - fogFactor;
#endif
`;

/**
 * ONE function object for every additive loot material, and it has to be one.
 *
 * `Material.customProgramCacheKey()` returns `onBeforeCompile.toString()` by
 * default, so a patch declared inside the per-kind loop would hand fifteen
 * identically-shaped-but-distinct closures to the program cache. Three
 * hashes the *text*, so those fifteen would in fact still collide - but the
 * explicit key below says so rather than relying on it, which is the same
 * argument `worlds/planets/PlanetLiquid.js` makes where it sets one.
 */
function swallowInHaze(shader) {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <fog_fragment>',
    ADDITIVE_FOG_FRAGMENT
  );
}
/**
 * ONE key string for the whole game, not one per system.
 *
 * It used to read `loot.additive-fog.v1`. `systems/Relics.js` now carries the
 * same law on its halo (see `hazeAdditive` below), and a key that names the
 * system rather than the law would have handed the program cache two tokens
 * for one patch the moment a second caller appeared.
 */
const ADDITIVE_FOG_KEY = () => 'additive-fog.v1';

/**
 * Give one additive layer the scene's own aerial perspective.
 *
 * EXPORTED, and that is the point: `systems/Relics.js` needs exactly this law
 * on its halo, and the guarantee the loot test already makes - one patch
 * function object and one cache key, so the program cache cannot split - is
 * only worth anything if it holds ACROSS the systems that use it, not within
 * each of them. A second copy of these six lines somewhere else would be a
 * second function object, a second key and a silent second program.
 *
 * @param {THREE.Material} mat an ADDITIVELY blended material
 */
export function hazeAdditive(mat) {
  mat.fog = true;
  mat.onBeforeCompile = swallowInHaze;
  mat.customProgramCacheKey = ADDITIVE_FOG_KEY;
  return mat;
}

export class Loot {
  /**
   * @param {{ scene:THREE.Scene, engine?:any, physics?:any, bus?:any, materials?:any,
   *           input?:any, player?:any, inventory?:any, economy?:any, npcManager?:any }} ctx
   */
  constructor({ scene, engine, physics, bus, materials, input, player, inventory, economy, npcManager } = {}) {
    this.scene = scene;
    this.engine = engine ?? null;
    this.physics = physics ?? null;
    this.bus = bus ?? null;
    this.materials = materials ?? null;
    this.input = input ?? null;
    this.player = player ?? null;
    this.inventory = inventory ?? null;
    this.economy = economy ?? null;
    this.npcManager = npcManager ?? null;

    this.group = new THREE.Group();
    this.group.name = 'loot';
    this.scene?.add(this.group);

    this._pool = [];
    this._active = [];
    this._fullNotifyT = 0;
    this._eLatch = false;
    this._worldId = 'station';
    /** Active world, tracked for capability rules. @see ../worlds/WorldRules.js */
    this._world = null;
    this._magnetUntil = 0;
    this._magnetRange = AUTO_RANGE;

    this._buildPool();

    /** @type {Array<() => void>} */
    this._offs = [];
    if (bus) {
      this._offs.push(bus.on('npc:killed', (e) => this._onNPCKilled(e)));
      this._offs.push(
        bus.on('world:changed', (e) => {
          this._worldId = e?.id ?? this._worldId;
          this._world = e?.world ?? null;
          this.clear();
        })
      );
    }
  }

  /** Live pickups. @returns {Array<object>} */
  get pickups() {
    return this._active;
  }

  /* ====================================================================== */
  /* Pool                                                                   */
  /* ====================================================================== */

  _buildPool() {
    // One geometry set and one material per accent, shared by the whole pool.
    this._coreGeo = new THREE.OctahedronGeometry(0.17, 0);
    this._ringGeo = new THREE.TorusGeometry(0.3, 0.018, 6, 24);
    this._beamGeo = new THREE.CylinderGeometry(0.11, 0.16, 1.5, 10, 1, true);
    this._haloTex = makeHaloTexture();
    this._beamTex = makeBeamTexture();

    /** @type {Record<string, {core:THREE.Material, ring:THREE.Material, halo:THREE.SpriteMaterial, beam:THREE.Material}>} */
    this._mats = {};
    for (const kind of ACCENT_PRIORITY) {
      const col = new THREE.Color(KIND_ACCENT[kind] ?? '#52e9ff');
      /* ---- WHY THESE NUMBERS ARE NOT THE ONES THIS SHIPPED WITH -------
       *
       * Four world art branches photographed a *violet* trinket as a pure
       * white blob and each declined to fix a system shared by nine worlds.
       * Measured on a controlled ladder - one accent, one backdrop, eight
       * marks on eight bearings from one vantage - the pixel at the centre of
       * a `trinket` read `rgb(252,211,249)`, saturation 0.16, with red hard
       * against 255 at three of the marks. The kind colour is a gameplay signal
       * (cyan is ammo, violet is a trinket, amber is money) and it was being
       * clipped away at the one range where the player can act on it.
       *
       * The cause is stacking, not any single layer. The renderer is
       * ACESFilmic (`core/Engine.js`) and ACES desaturates as it compresses,
       * so four coincident layers - emissive 2.6 plus additive 0.75 + 0.85 +
       * 0.35 - put ~3.5x the accent's linear radiance through a curve that
       * answers with white. Bloom then spread that white onto the ground
       * around it: every world's threshold is scene-referred (medieval 1.30,
       * dock 2.40) and 3.5 clears all of them by a mile.
       *
       * So the totals come down to land the composite BELOW the ceiling with
       * its hue intact, rather than any one layer being "too bright":
       *
       *   core  emissiveIntensity 2.6  -> 1.1   albedo x0.35 -> x0.5
       *   ring  opacity           0.75 -> 0.5
       *   halo  opacity           0.85 -> 0.4
       *   beam  opacity           0.35 -> 0.25
       *
       * The core keeps the largest share because it is the thing with a
       * silhouette, and the halo gives up the most because it is the layer
       * that sat exactly on top of the core and did the clipping. The albedo
       * goes UP to compensate: with less emissive, more of the octahedron's
       * read has to come from its lit facets, and that is the half of it that
       * carries a highlight and a shape. */
      const core = new THREE.MeshStandardMaterial({
        color: col.clone().multiplyScalar(0.5),
        emissive: col,
        emissiveIntensity: 1.1,
        metalness: 0.4,
        roughness: 0.3,
        flatShading: true,
      });
      core.name = `loot.core.${kind}`;
      /* The core needs nothing doing about fog: `MeshStandardMaterial`
       * defaults `fog` to true and always has, so it was already receding
       * with the rest of the scene. Only the three additive layers below were
       * opted out, and they are the ones that reach 300 m. */
      const ring = hazeAdditive(new THREE.MeshBasicMaterial({
        color: col,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }));
      ring.name = `loot.ring.${kind}`;
      const halo = hazeAdditive(new THREE.SpriteMaterial({
        map: this._haloTex,
        color: col,
        transparent: true,
        opacity: 0.4,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
      }));
      halo.name = `loot.halo.${kind}`;
      const beam = hazeAdditive(new THREE.MeshBasicMaterial({
        map: this._beamTex,
        color: col,
        transparent: true,
        opacity: 0.25,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }));
      beam.name = `loot.beam.${kind}`;
      this._mats[kind] = { core, ring, halo, beam };
    }
    this.materials?.register?.('loot.core.ammo', this._mats.ammo.core);

    for (let i = 0; i < POOL_SIZE; i++) this._pool.push(this._makePickup(i));
  }

  _makePickup(index) {
    const root = new THREE.Group();
    root.name = `loot.pickup.${index}`;
    root.visible = false;
    root.matrixAutoUpdate = true;

    const core = new THREE.Mesh(this._coreGeo, this._mats.ammo.core);
    core.castShadow = false;
    core.receiveShadow = false;
    core.position.y = 0.55;

    const ring = new THREE.Mesh(this._ringGeo, this._mats.ammo.ring);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.55;
    ring.renderOrder = 3;

    const halo = new THREE.Sprite(this._mats.ammo.halo);
    halo.scale.setScalar(0.95);
    halo.position.y = 0.55;
    halo.renderOrder = 4;

    const beam = new THREE.Mesh(this._beamGeo, this._mats.ammo.beam);
    beam.position.y = 0.75;
    beam.renderOrder = 2;

    root.add(beam, ring, core, halo);
    this.group.add(root);

    return {
      index,
      root,
      core,
      ring,
      halo,
      beam,
      /** @type {Array<{itemId:string, qty:number}>} */
      contents: [],
      active: false,
      baseY: 0,
      phase: 0,
      age: 0,
      born: 0,
      dying: 0,
      accent: 'ammo',
      label: '',
    };
  }

  /* ====================================================================== */
  /* Drops                                                                  */
  /* ====================================================================== */

  _onNPCKilled(event) {
    if (!event || event.byPlayer !== true || !event.npc) return;
    /* A HERBIVORE CARRIES NO ARROWS.
     *
     * `BeastNPC` files every animal as `type: 'hostile'`, which is right for
     * the respawn queue and wrong for a drop table: the citadel's is the
     * GARRISON's - crown coins, broadhead arrows, medkits, a nexus shard - and
     * a camel carrying six to sixteen arrows is not a near miss, it is a
     * different kind of thing. The Sunspire camels are `predator: false`, have
     * 220 HP, cannot fight back by three independent locks and respawn 22 s
     * after they are killed, so without this any wayside well is a coin and
     * arrow farm against an animal that cannot run out. Predators are
     * untouched: a wolf in the vale still drops what it always did. */
    if (event.npc.isBeast && event.npc.def?.predator === false) return;
    this._dropFor(event.npc);
  }

  /** Roll the table for this world and spawn the pickup at the body. */
  _dropFor(npc) {
    // The maze wants no pickups.
    if (!allows(this._world, 'loot')) return;
    const table = DROP_TABLES[this._worldId] ?? DROP_TABLES.station;
    const contents = [];

    // Credits are guaranteed; they are the reason a pickup is always worth
    // walking to even when the ammo roll comes up empty.
    contents.push({ itemId: 'credits', qty: 4 + Math.floor(Math.random() * 11) });

    let rolls = 0;
    for (const entry of table) {
      if (Math.random() > entry.chance) continue;
      const qty = entry.min + Math.floor(Math.random() * (entry.max - entry.min + 1));
      if (qty <= 0) continue;
      contents.push({ itemId: entry.id, qty });
      if (++rolls >= 3) break; // three item types is plenty to read at a glance
    }

    _dl.copy(npc.position ?? _dl.set(0, 0, 0));
    // Nudge the pile off the corpse so it is not buried in the collapse pose.
    const a = Math.random() * Math.PI * 2;
    _dl.x += Math.cos(a) * 0.45;
    _dl.z += Math.sin(a) * 0.45;
    this.spawn(_dl, contents);
  }

  /**
   * Spawn a pickup. Public so a world event or a debug command can drop one.
   *
   * @param {THREE.Vector3} position roughly where it should land (feet height)
   * @param {Array<{itemId?:string, grant?:object, qty:number}>} contents stock
   *   entries, or a mount-upgrade `grant` (see `collectEntry`)
   * @param {{persistent?:boolean, snap?:boolean, tag?:string}} [opts]
   *   `persistent` exempts the pickup from the fade timer and from recycling -
   *   world caches are a feature of the map, not litter from a firefight, and
   *   must still be there when the player comes back for them. `snap:false`
   *   keeps an authored height exactly as given, which is what a cache on a
   *   riverbed or a rooftop ledge needs.
   * @returns {object|null} the pooled pickup, or null if the pool is exhausted
   */
  spawn(position, contents, opts = {}) {
    if (!contents?.length) return null;
    const p =
      this._active.length >= MAX_ACTIVE
        ? this._recycleOldest()
        : this._pool.find((x) => !x.active) ?? this._recycleOldest();
    if (!p) return null;

    _sp.copy(position);
    let y = _sp.y;
    if (opts.snap !== false) {
      // Snap to the surface so a pickup never floats or sinks into a ramp.
      const g = this.physics?.groundHeight?.(_sp.x, _sp.z, _sp.y + 1.6, 6);
      if (g !== null && g !== undefined) y = g;
    }
    p.persistent = !!opts.persistent;
    p.tag = opts.tag ?? null;
    // Seconds after spawn before auto-collect is allowed. Used for player-dropped
    // items so they are not immediately re-picked up while the player stands on them.
    p.collectDelay = opts.collectDelay ?? 0;

    p.contents = contents.map((c) => (c.grant ? { grant: c.grant, qty: c.qty } : { itemId: c.itemId, qty: c.qty }));
    p.active = true;
    p.age = 0;
    p.dying = 0;
    p.born = 0.001;
    p.phase = Math.random() * Math.PI * 2;
    p.baseY = y;
    p.accent = this._accentFor(p.contents);
    p.label = this._labelFor(p.contents);
    this._applyAccent(p);

    p.root.position.set(_sp.x, y, _sp.z);
    p.root.scale.setScalar(0.01);
    p.root.visible = true;
    this._active.push(p);

    this.bus?.emit('loot:dropped', { position: p.root.position, contents: p.contents });
    return p;
  }

  /** Free the longest-standing pickup so a fresh drop always gets a slot. */
  _recycleOldest() {
    // Never evict a cache to make room for a corpse drop: the caches are the
    // only pickups the player may have travelled a long way to reach.
    const evictable = this._active.filter((p) => !p.persistent);
    if (evictable.length === 0) return null;
    let oldest = evictable[0];
    for (const p of evictable) if (p.age > oldest.age) oldest = p;
    this._release(oldest);
    const i = this._active.indexOf(oldest);
    if (i >= 0) this._active.splice(i, 1);
    return oldest;
  }

  _accentFor(contents) {
    return accentFor(contents);
  }

  _labelFor(contents) {
    return labelFor(contents);
  }

  _applyAccent(p) {
    const m = this._mats[p.accent] ?? this._mats.ammo;
    p.core.material = m.core;
    p.ring.material = m.ring;
    p.halo.material = m.halo;
    p.beam.material = m.beam;
  }

  /**
   * Show one idle pickup of every accent, for the boot-time shader warm.
   *
   * ── Why this exists, and why "build the materials" was not enough ────────
   * The pool builds one material set per accent up front, but every pickup in
   * the pool is *made* wearing the `ammo` set - `_applyAccent` only swaps the
   * others in when a drop of that kind actually spawns. `renderer.compile()`
   * collects materials by walking `object.material`, so it has never once seen
   * `loot.beam.trinket`; the first rare drop the player ever walks past linked
   * it on the spot. Measured cold: 5 programs, 1.65 s, in one frame.
   *
   * Five, not four, for four meshes. `loot.beam.*` is transparent *and*
   * `DoubleSide`, and three renders that combination in two passes - once with
   * `side = BackSide`, once with `FrontSide` - which are two different program
   * cache keys off one material. Nothing about the material graph reveals that;
   * only drawing it does. `renderer.compile()` reproduces the same two-pass
   * split (`prepareMaterial`), so a compile with the accents *attached* is
   * enough to issue both links - but the driver defers the link check to first
   * use, so they must also be drawn. Hence: attach, show, and let the caller
   * render frames.
   *
   * Nothing here touches `_active`, emits `loot:dropped`, or gives the player
   * anything. These are pool entries posed for the camera and then put back.
   *
   * @param {THREE.Vector3} position Centre to lay them out around.
   * @returns {() => void} Restore. Always call it.
   */
  warmAccents(position) {
    const kinds = Object.keys(this._mats);
    /** @type {Array<{p:object, accent:string, visible:boolean, scale:number, x:number, y:number, z:number}>} */
    const touched = [];
    kinds.forEach((kind, i) => {
      // Never borrow a pickup that is actually in the world: a cache or a
      // player-dropped item must not blink into a different colour and back.
      const p = this._pool[i];
      if (!p || p.active) return;
      touched.push({
        p,
        accent: p.accent,
        visible: p.root.visible,
        scale: p.root.scale.x,
        x: p.root.position.x, y: p.root.position.y, z: p.root.position.z,
      });
      p.accent = kind;
      this._applyAccent(p);
      // Spread them so none is hidden inside another, and stand them next to
      // the player so the shadow and post chains reach them too.
      p.root.position.set(position.x + 1.1 * (i - kinds.length / 2), position.y, position.z + 2.5);
      p.root.scale.setScalar(1);
      p.root.visible = true;
    });
    return () => {
      for (const t of touched) {
        t.p.accent = t.accent;
        this._applyAccent(t.p);
        t.p.root.visible = t.visible;
        t.p.root.scale.setScalar(t.scale);
        t.p.root.position.set(t.x, t.y, t.z);
      }
    };
  }

  /* ====================================================================== */
  /* Frame                                                                  */
  /* ====================================================================== */

  /**
   * Animation and collection. Driven from the fixed step (main.js runs loot
   * between projectiles and unstuck); everything is a function of `elapsed`
   * rather than an integration, so being called from the frame loop as well
   * is harmless.
   *
   * @param {number} dt
   * @param {number} elapsed
   */
  fixedUpdate(dt, elapsed) {
    if (this._fullNotifyT > 0) this._fullNotifyT -= dt;
    /* `_buffNow()`, NOT the `elapsed` argument. The argument is wall time and
     * the deadline is play time; they are the same number until the first time
     * a panel is opened and different for ever afterwards. Everything below
     * still uses `elapsed`, because a pickup bobbing on a sine wave is an
     * animation and animations run on the wall clock. @see _buffNow */
    if (this._buffNow() >= this._magnetUntil) this._magnetRange = AUTO_RANGE;

    /* NOT WHILE SOMETHING ELSE IS DRIVING THE BODY. See the same guard, with
     * the measurements, in `./Relics.js`: `player.position` is the SHIP while
     * `Piloting` holds the body, so both the magnet and the [E] pickup were
     * being served by a 22 m hull crossing the yard at flight speed. Driven, a
     * single climb out of the hangar took "+3 Old Crown Coin" and "+1 Aegis
     * Shard" out of a world cache in mid-air.
     *
     * A MOUNT still collects, which is right: `movementOverrideCollide` is left
     * true for a rider, and only `Piloting.board` clears it.
     * @see ./Relics.js, ./Mining.js, ../ships/Piloting.js `_takeBody` */
    const player = (this.player?.movementOverride && this.player?.movementOverrideCollide === false)
      ? null : this.player;
    const pressedE = this._consumeInteract();

    for (let i = this._active.length - 1; i >= 0; i--) {
      const p = this._active[i];
      p.age += dt;

      // Spawn pop, then the resting bob.
      if (p.born > 0) {
        p.born = Math.min(1, p.born + dt * 3.4);
        const s = 1 - (1 - p.born) * (1 - p.born);
        p.root.scale.setScalar(0.35 + s * 0.65);
        if (p.born >= 1) p.born = 0;
      }
      if (p.dying > 0) {
        p.dying -= dt * 3.2;
        const k = Math.max(0, p.dying);
        // Collect flourish: flare outward while shrinking to nothing. Scale
        // only - the materials are shared by the whole pool, so fading one
        // material's opacity would fade every other pickup with it.
        p.root.scale.setScalar(k * (1 + (1 - k) * 1.1));
        if (p.dying <= 0) {
          this._release(p);
          this._active.splice(i, 1);
        }
        continue;
      }

      const bob = Math.sin(elapsed * 1.9 + p.phase) * 0.075;
      p.root.position.y = p.baseY + bob;
      p.core.rotation.y = elapsed * 1.15 + p.phase;
      p.core.rotation.x = Math.sin(elapsed * 0.7 + p.phase) * 0.25;
      p.ring.rotation.z = -elapsed * 0.8 + p.phase;
      const pulse = 0.92 + Math.sin(elapsed * 3.1 + p.phase) * 0.1;
      p.halo.scale.setScalar(pulse);

      // World caches are part of the map, not battlefield litter: they wait.
      if (!p.persistent && p.age > LIFETIME) {
        p.dying = 1;
        continue;
      }

      if (!player) continue;
      // Honour a per-pickup grace period so player-dropped items are not
      // immediately re-collected while the player stands on them.
      if (p.age < (p.collectDelay ?? 0)) continue;
      _ck.copy(p.root.position);
      _ck.y = p.baseY;
      const d2 = _ck.distanceToSquared(player.position);
      const autoRange = this._magnetRange;
      if (d2 <= autoRange * autoRange || (pressedE && d2 <= PROMPT_RANGE * PROMPT_RANGE)) {
        this._collect(p);
      }
    }
  }

  /**
   * `E` is shared with talking and portals, so it is read once per frame and
   * latched: a fixed step can run several times per rendered frame, and without
   * the latch one keypress would try to collect several times.
   */
  _consumeInteract() {
    const down = this.input?.pressed?.('KeyE') ?? false;
    if (down && !this._eLatch) {
      this._eLatch = true;
      return true;
    }
    if (!down) this._eLatch = false;
    return false;
  }

  /** Optional frame tick; the animation is time-absolute so this is a no-op. */
  update() {}

  /**
   * THE BUFF CLOCK: seconds of gameplay, from the engine.
   *
   * A Vacuum Rune is bought for "30 seconds", used from inside the bag, and
   * the bag is a panel that stops gameplay - so on `engine.elapsed` the rune
   * spent part of its life on a screen where there is no loose salvage to
   * pull. `simElapsed` stops when play does. It is also the clock the HUD
   * chip counts down on, so the two cannot disagree.
   *
   * @returns {number} seconds
   */
  _buffNow() {
    return this.engine?.simElapsed ?? 0;
  }

  setMagnet(duration, range = 5.5) {
    if (!(duration > 0)) return false;
    this._magnetRange = Math.max(this._magnetRange, range);
    this._magnetUntil = Math.max(this._magnetUntil, this._buffNow() + duration);
    return true;
  }

  /* ====================================================================== */
  /* Collection                                                             */
  /* ====================================================================== */

  _collect(p) {
    const left = [];
    let took = 0;
    // Survey contracts key off this: recovering a world cache is a different
    // event from stripping a corpse, even though both arrive as pickups.
    const fromCache = typeof p.tag === 'string' && p.tag.startsWith('cache:');

    const deps = { bus: this.bus, economy: this.economy, inventory: this.inventory, fromCache, pickup: p };
    for (const entry of p.contents) {
      // The per-entry rules (credits, stock, a mount-upgrade grant) and the
      // events they emit live in `collectEntry`, at module level.
      const res = collectEntry(entry, deps);
      if (res.taken) took++;
      if (res.left) left.push(res.left);
    }

    if (left.length === 0) {
      p.dying = 1;
      return;
    }

    // Something did not fit. Keep the remainder on the ground rather than
    // deleting it, and say so - once every few seconds, not once per frame.
    p.contents = left;
    p.accent = this._accentFor(left);
    p.label = this._labelFor(left);
    this._applyAccent(p);
    if (took === 0 && this._fullNotifyT <= 0) {
      this._fullNotifyT = 3;
      this.bus?.emit('hud:notify', { text: 'Inventory full — pickup left on the ground', tone: 'warn' });
    }
  }

  /**
   * Take a pickup off the map without collecting it.
   *
   * For streamed spawners - `Interiors` puts an authored collectible in the
   * world when the player is near enough to see it and takes it away again
   * when they leave, so a map with two hundred authored spots still only ever
   * holds a handful of live pickups. Deliberately silent: no `loot:collected`,
   * so nothing downstream thinks the player picked it up.
   */
  despawn(p) {
    if (!p?.active) return false;
    const i = this._active.indexOf(p);
    if (i >= 0) this._active.splice(i, 1);
    this._release(p);
    return true;
  }

  _release(p) {
    p.active = false;
    p.contents.length = 0;
    p.root.visible = false;
    p.dying = 0;
    p.born = 0;
    p.root.scale.setScalar(1);
  }

  /** Remove every live pickup, e.g. on a world change. */
  clear() {
    for (const p of this._active) this._release(p);
    this._active.length = 0;
  }

  dispose() {
    this.clear();
    for (const off of this._offs) {
      try {
        off();
      } catch {
        /* a bus that already cleared its handlers is not an error */
      }
    }
    this._offs.length = 0;
    this.group.removeFromParent();
    this._coreGeo.dispose();
    this._ringGeo.dispose();
    this._beamGeo.dispose();
    this._haloTex.dispose();
    this._beamTex.dispose();
    for (const kind in this._mats) {
      const m = this._mats[kind];
      m.core.dispose();
      m.ring.dispose();
      m.halo.dispose();
      m.beam.dispose();
    }
  }
}
