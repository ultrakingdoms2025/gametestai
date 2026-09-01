/**
 * Which marketplace items the map editor may offer for placement, and why the rest are not offered.
 *
 * ── The defect this exists to end ─────────────────────────────────────────────────────────────────
 *
 * The Place list offered the whole catalogue. An admin placed nine mount upgrades on station — Bicycle
 * Speed I–III, Bicycle Acceleration I–III, Hoverboard Speed I–III — saved, entered the world, and the
 * game refused all nine with `unresolved: [{ id, reason: 'item' }]`. The report card printed nine ids
 * beside "not a placeable item", with no item name, and the admin — who had also been fighting the ground
 * grid that week — read it as a Y problem. It was never a Y problem: a mount power is applied to the
 * rider, and at the time nothing in the game could lay one on the ground. For one release this module
 * hid the nine. Now the game CAN lay one down — `grantForPlacement` resolves a `grant_mount_power` row
 * to a grant, `Loot` spawns a pickup that carries it, and collecting it puts a `mountpower` bag item in
 * the player's hands, once per account — and the nine are offered again. (Collecting one used to apply
 * the tier on the spot and write no inventory row at all; `ItemUse._useMountPower` is where the player
 * spends it now, and that is what emits the purchase's own `mount:power:buy` at cost 0.)
 *
 * ── The rule, mirrored from the game ──────────────────────────────────────────────────────────────
 *
 * `grantForPlacement` in `src/systems/MapOverlay.js` resolves a placed item to what a pickup holds, in
 * this order, and `_applyPlace` refuses with `reason: 'item'` when it answers null:
 *
 *   0. `config.effect === 'grant_mount_power'` with a string `config.power` → the GRANT (mount, power,
 *      tier), through the parser a purchase uses (`mountPowerGrantFor` in `Marketplace.js`).
 *   1. `config.effect === 'grant_ammo'` with a string `config.ammo_item`  → that ammo.
 *   2. `config.effect === 'grant_item'` with a string `config.item_id`    → that item.
 *   3. `consumableItemFor(source_key)`: the key, or the key with its trailing `:<world>` stamp cut, is
 *      one of `MARKETPLACE_CONSUMABLE_ITEMS`' fifteen keys (`src/systems/Marketplace.js`) → the mapped
 *      inventory item. The game resolves a consumable by its KEY, not its effect: a `modify_speed`
 *      row under a key the map does not hold is refused, and a row with an empty config under
 *      `spell_velocity_25:station` is not.
 *   4. `ITEMS[source_key]`, again with or without the world stamp → the key is itself an item id.
 *
 * Then `_applyPlace` refuses an item id in `NEVER_PLACEABLE` (`credits` — a balance, not a pickup) or
 * one `ITEMS` does not define, and refuses a mount grant — with the same `item` — when the mount does
 * not SELL the power (`MountManager.sellsPower`: Fire is a dragon's alone).
 *
 * This module mirrors 0, 1, 2, 3 and the `credits` refusal, and the consumable key set, the two
 * effect/field pairs and the mount route are held equal to the game's source text by
 * `mapPlaceableContract.test.ts`, so a key the game adds or drops fails a test here rather than hiding
 * or offering the wrong row. It cannot mirror 4, the `ITEMS` check, or `sellsPower`: the item table and
 * the mount stat table are game source the site does not see. So the verdict here is the editor's, not
 * the game's — a row this offers can still come back `item` if its `item_id` names nothing the game
 * defines or its mount does not sell the power, and the pending row then says so from the report
 * (`rowsWithVerdicts` in `mapEditorState.ts`). The game's `item` reason remains the final word.
 *
 * For a mount row this asks a little MORE than the game's parser does: a `mount` in `MOUNT_IDS` (the game
 * defaults a missing one to the car, and its `sellsPower` answers true for a mount no class declares)
 * and an integer `tier` of 1 to 3 (the game clamps to at least 1 and caps nothing). Every seeded row
 * satisfies both; a row that does not is a hand-authored one, and offering it would place a grant the
 * catalogue never sells - or, for an unknown mount, one that grants to nothing.
 *
 * ── Why hide rather than grey out ─────────────────────────────────────────────────────────────────
 *
 * A greyed row still has to be explained on hover, one row at a time, and the list is 200 long. One
 * line under the list — "N items cannot be placed in a world (cosmetics, heals) — they are granted by
 * purchase" — says it once for all of them, and the admin who wants a cosmetic on a player knows where
 * it is sold.
 */

/** The `MARKETPLACE_CONSUMABLE_ITEMS` keys of `src/systems/Marketplace.js` — pinned by `mapPlaceableContract.test.ts`. */
export const CONSUMABLE_SOURCE_KEYS: ReadonlySet<string> = new Set([
  'spell_velocity_25',
  'spell_velocity_50',
  'spell_velocity_75',
  'spell_velocity_100',
  'spell_loot_grab_30',
  'spell_portal_ping_30',
  'spell_stasis_5s',
  'spell_stasis_10s',
  'spell_stasis_30s',
  'spell_stasis_60s',
  'shield_5s',
  'firepower_boost_25',
  'firepower_boost_50',
  'firepower_boost_75',
  'firepower_boost_100',
  /* The stamina draughts and the damage wards. These are mapped in the game's
   * `MARKETPLACE_CONSUMABLE_ITEMS` exactly as the ladders above are, so a
   * placement whose source_key is one of them resolves to a real pickup and
   * the map editor must offer it. `mapPlaceableContract.test.ts` compares this
   * set against the game's mapping key for key, which is what caught the drift
   * the moment the two families landed. */
  'stamina_slowdown_25',
  'stamina_slowdown_50',
  'stamina_slowdown_75',
  'stamina_slowdown_100',
  'ward_20',
  'ward_35',
  'ward_50',
]);

/** The applier's `NEVER_PLACEABLE` item ids (`src/systems/MapOverlay.js`) — pinned by `mapPlaceableContract.test.ts`. */
export const NEVER_PLACEABLE_ITEM_IDS: ReadonlySet<string> = new Set(['credits']);

/** The reason for everything that has no pickup form and no mapped key: a heal, a config-less row, an effect under an unmapped key. */
export const NOT_A_PICKUP_TEXT = 'not a pickup the game can spawn';

/**
 * The mounts a grant may name: the keys of `MOUNT_STATS` in `src/mounts/Livery.js`, pinned by
 * `mapPlaceableContract.test.ts`. The game's `sellsPower` is LENIENT for a mount no class declares - it
 * answers true - so this set, not the game, is what keeps a `unicorn` row from reaching the applier and
 * being granted to nothing.
 */
export const MOUNT_IDS: ReadonlySet<string> = new Set(['dragon', 'eagle', 'horse', 'hoverboard', 'bicycle', 'car']);

/** A `grant_mount_power` row this will not offer: the game would parse it, but not into any grant the catalogue sells. */
export const MOUNT_POWER_TEXT = 'a mount upgrade must name one of the six mounts, its power and a tier of 1 to 3';
export const COSMETIC_TEXT = 'cosmetics unlock in the wardrobe; they cannot lie on the ground';
export const CREDITS_TEXT = 'credits are a balance, not a pickup';

/** The shape the rule reads: what a catalogue row or a place entry's `item` carries, loosely typed because the API's `action_config` is `Record<string, unknown>`. */
export interface PlaceableInput {
  source_key?: string | null;
  config?: Record<string, unknown> | null;
}

/** `consumableItemFor`'s probe: the exact key first (a real key may contain a colon), then the key with its trailing `:<world>` cut. Own-property semantics via the Set. */
function consumableKeyMapped(key: string): boolean {
  if (CONSUMABLE_SOURCE_KEYS.has(key)) return true;
  const cut = key.lastIndexOf(':');
  return cut > 0 && CONSUMABLE_SOURCE_KEYS.has(key.slice(0, cut));
}

/** A mount upgrade the catalogue could sell: one of the game's mounts, a named power, and a tier of I, II or III. */
function wellFormedMountPower(config: Record<string, unknown>): boolean {
  const tier = config.tier;
  return (
    typeof config.mount === 'string' && MOUNT_IDS.has(config.mount) &&
    typeof config.power === 'string' && config.power !== '' &&
    typeof tier === 'number' && Number.isInteger(tier) && tier >= 1 && tier <= 3
  );
}

/**
 * Null when the game's applier can turn the item into a pickup (routes 0–3 above, and not `credits`);
 * otherwise a short reason in the admin's words. See the header for what this cannot see.
 */
export function placeableReason(item: PlaceableInput): string | null {
  const config = item?.config ?? {};
  const effect = config.effect;
  if (effect === 'grant_mount_power') return wellFormedMountPower(config) ? null : MOUNT_POWER_TEXT;
  if (effect === 'grant_ammo' && typeof config.ammo_item === 'string') {
    return NEVER_PLACEABLE_ITEM_IDS.has(config.ammo_item) ? CREDITS_TEXT : null;
  }
  if (effect === 'grant_item' && typeof config.item_id === 'string') {
    return NEVER_PLACEABLE_ITEM_IDS.has(config.item_id) ? CREDITS_TEXT : null;
  }
  if (typeof item?.source_key === 'string' && consumableKeyMapped(item.source_key)) return null;
  if (effect === 'unlock_cosmetic') return COSMETIC_TEXT;
  return NOT_A_PICKUP_TEXT;
}

export interface HiddenItem<T> {
  item: T;
  reason: string;
}

/** The catalogue rows the Place list offers, in their order and by identity, and the rows it hides with their reasons. */
export function partitionPlaceable<T extends { source_key: string | null; action_config: Record<string, unknown> }>(
  items: readonly T[]
): { placeable: T[]; hidden: HiddenItem<T>[] } {
  const placeable: T[] = [];
  const hidden: HiddenItem<T>[] = [];
  for (const item of items) {
    const reason = placeableReason({ source_key: item.source_key, config: item.action_config });
    if (reason === null) placeable.push(item);
    else hidden.push({ item, reason });
  }
  return { placeable, hidden };
}

/**
 * The kinds the line under the list names, in the order it names them. An effect outside the table is
 * "other items" - which is where a malformed mount row lands, since a well-formed one is offered.
 */
const HIDDEN_KIND_WORDS: ReadonlyArray<readonly [effect: string, word: string]> = [
  ['unlock_cosmetic', 'cosmetics'],
  ['restore_health', 'heals'],
  ['restore_health_full', 'heals'],
];

/**
 * The one line under the Place list: how many rows are hidden and what kinds they are, so a short list
 * reads as a rule and not as a catalogue that failed to load. Empty when nothing is hidden.
 */
export function hiddenItemsText(hidden: ReadonlyArray<HiddenItem<{ action_config: Record<string, unknown> }>>): string {
  if (!hidden.length) return '';
  const effects = new Set(hidden.map((h) => String(h.item.action_config?.effect ?? '')));
  const kinds: string[] = [];
  for (const [effect, word] of HIDDEN_KIND_WORDS) {
    if (effects.has(effect) && !kinds.includes(word)) kinds.push(word);
  }
  const named = new Set(HIDDEN_KIND_WORDS.map(([effect]) => effect));
  if ([...effects].some((e) => !named.has(e))) kinds.push('other items');
  const n = hidden.length;
  return n === 1
    ? `1 item cannot be placed in a world (${kinds.join(', ')}) — it is granted by purchase`
    : `${n} items cannot be placed in a world (${kinds.join(', ')}) — they are granted by purchase`;
}
