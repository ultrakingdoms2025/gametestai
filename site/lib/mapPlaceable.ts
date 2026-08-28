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
 * rider, and nothing in the game can lay one on the ground.
 *
 * ── The rule, mirrored from the game ──────────────────────────────────────────────────────────────
 *
 * `grantForPlacement` in `src/systems/MapOverlay.js` resolves a placed item to the inventory stack a
 * pickup holds, in this order, and `_applyPlace` refuses with `reason: 'item'` when it answers null:
 *
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
 * one `ITEMS` does not define.
 *
 * This module mirrors 1, 2, 3 and the `credits` refusal exactly, and the consumable key set and the
 * two effect/field pairs are held equal to the game's source text by `mapPlaceableContract.test.ts`, so
 * a key the game adds or drops fails a test here rather than hiding or offering the wrong row. It
 * cannot mirror 4 or the `ITEMS` check: the item table is game source the site does not see. So the
 * verdict here is the editor's, not the game's — a row this offers can still come back `item` if its
 * `item_id` names nothing the game defines, and the pending row then says so from the report
 * (`rowsWithVerdicts` in `mapEditorState.ts`). The game's `item` reason remains the final word.
 *
 * ── Why hide rather than grey out ─────────────────────────────────────────────────────────────────
 *
 * A greyed row still has to be explained on hover, one row at a time, and the list is 200 long. One
 * line under the list — "N items cannot be placed in a world (mount powers, cosmetics) — they are
 * granted by purchase" — says it once for all of them, and the admin who wants a mount power on a
 * player knows where it is sold.
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
]);

/** The applier's `NEVER_PLACEABLE` item ids (`src/systems/MapOverlay.js`) — pinned by `mapPlaceableContract.test.ts`. */
export const NEVER_PLACEABLE_ITEM_IDS: ReadonlySet<string> = new Set(['credits']);

/** The reason for everything that has no pickup form and no mapped key: a heal, a config-less row, an effect under an unmapped key. */
export const NOT_A_PICKUP_TEXT = 'not a pickup the game can spawn';

export const MOUNT_POWER_TEXT = 'mount powers are applied to the rider, not placed in a world';
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

/**
 * Null when the game's applier can turn the item into a pickup (routes 1–3 above, and not `credits`);
 * otherwise a short reason in the admin's words. See the header for what this cannot see.
 */
export function placeableReason(item: PlaceableInput): string | null {
  const config = item?.config ?? {};
  const effect = config.effect;
  if (effect === 'grant_ammo' && typeof config.ammo_item === 'string') {
    return NEVER_PLACEABLE_ITEM_IDS.has(config.ammo_item) ? CREDITS_TEXT : null;
  }
  if (effect === 'grant_item' && typeof config.item_id === 'string') {
    return NEVER_PLACEABLE_ITEM_IDS.has(config.item_id) ? CREDITS_TEXT : null;
  }
  if (typeof item?.source_key === 'string' && consumableKeyMapped(item.source_key)) return null;
  if (effect === 'grant_mount_power') return MOUNT_POWER_TEXT;
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

/** The kinds the line under the list names, in the order it names them. An effect outside the table is "other items". */
const HIDDEN_KIND_WORDS: ReadonlyArray<readonly [effect: string, word: string]> = [
  ['grant_mount_power', 'mount powers'],
  ['unlock_cosmetic', 'cosmetics'],
  ['restore_health', 'heals'],
  ['restore_health_full', 'heals'],
];

/**
 * The one line under the Place list: how many rows are hidden and what kinds they are, so nine missing
 * mount rows read as a rule and not as a catalogue that failed to load. Empty when nothing is hidden.
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
