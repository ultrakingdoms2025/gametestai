import { SHIP_SKINS_BY_ID, isPaidShipSkin, shipSkinItemId } from './ShipStats.js';

/**
 * "Wear a ship livery" — the one path the yard panel and the inventory Use
 * button both go through.
 *
 * A twin of `systems/MountSkins.js`, and stateless for the same reason: every
 * collaborator is passed in, so it is indifferent to construction order in
 * main.js and can be driven headless. The differences from the mount version
 * are the two the domain actually has:
 *
 *  1. **A hull is SELECTED, not ridden.** `applyMountSkin` asks
 *     `mounts.mounted && mounts.active.id === skin.mount`. There is no such
 *     thing for a ship: three of them stand on cradles and the player walks
 *     round them, so the questions are "is this livery for this hull"
 *     (`wrong-ship`) and "is this hull in the world I am standing in"
 *     (`not-here`). Those are DIFFERENT problems with different fixes — take
 *     the other tab, or fly to the yard — so they stay separate reasons all
 *     the way out to the toast.
 *  2. **Half the catalogue is free.** The nine yard schemes shipped free and
 *     stayed free, so they never touch the bag or the ledger at all: they go
 *     straight to `ShipRegistry.applyScheme`, which owns both refusals. Only
 *     the nine commissioned liveries have an item behind them.
 *
 * Everything else is the mount contract verbatim, including the rule the mount
 * file records in its own header and this one obeys line for line: A LIVERY IS
 * ONLY EVER CONSUMED ON A SUCCESSFUL APPLY. Every refusal below happens before
 * `consumeFromBag`, and the two questions asked immediately before it are
 * `applyScheme`'s own two, so the apply that follows the consume cannot come
 * back refused.
 *
 * @param {{ships:any, cosmetics:any, inventory:any}} deps
 * @param {string} shipId hull the panel (or the pilot) is pointed at
 * @param {string} skinId livery id from `SHIP_SKINS`
 * @returns {{ok:boolean,
 *   reason?:'unknown-scheme'|'wrong-ship'|'not-here'|'not-owned'|'unavailable',
 *   consumed?:boolean}}
 */
export function applyShipSkin({ ships, cosmetics, inventory }, shipId, skinId) {
  const skin = SHIP_SKINS_BY_ID.get(skinId);
  if (!skin) return { ok: false, reason: 'unknown-scheme' };

  /* A registry that cannot paint must refuse BEFORE anything is taken —
   * `MountSkins.js:26-28`'s rule, and the failure it names is the one
   * `ShipStats`' own note on `SHIP_SLOTS` records happening for real: a write
   * accepted, stored, emitted, and landing on no object at all. */
  if (typeof ships?.applyScheme !== 'function') return { ok: false, reason: 'unavailable' };

  /* THE NINE FREE SCHEMES, UNCHANGED.
   *
   * No ledger, no bag, no ownership question — straight to the registry, which
   * refuses `wrong-ship` and `not-here` before it mutates anything. Passing
   * these through the paid path "for consistency" would have made a free thing
   * cost a bag item, which is the regression this whole change exists not to
   * commit. `consumed: false` is stated rather than left undefined so a caller
   * can tell "applied, nothing spent" from "applied, a tin used up". */
  if (!isPaidShipSkin(skin)) {
    const res = ships.applyScheme(shipId, skinId);
    return res.ok ? { ok: true, consumed: false } : res;
  }

  /* ---- Paid, from here down ------------------------------------------- */

  /* The registry's own two refusals, asked HERE and in its order, because the
   * bag is about to be charged and `applyScheme` is what would otherwise
   * discover the problem one line too late. `hasHull` is required rather than
   * optional-chained: a registry too old to answer "is this hull here" cannot
   * vouch for the paint landing, and the honest answer to that is to keep the
   * livery, not to spend it on a guess. */
  if (skin.ship !== shipId) return { ok: false, reason: 'wrong-ship' };
  if (typeof ships.hasHull !== 'function') return { ok: false, reason: 'unavailable' };
  if (!ships.hasHull(shipId)) return { ok: false, reason: 'not-here' };

  // A no-op ledger cannot record the unlock, so the item would be destroyed for
  // one session of paint. Same refusal, same reason, same place as the mount's.
  if (typeof cosmetics?.unlock !== 'function') return { ok: false, reason: 'unavailable' };

  // Already burned in: re-apply for nothing, for ever. This is what the player
  // bought.
  if (cosmetics.has?.(skinId)) {
    const res = ships.applyScheme(shipId, skinId);
    return res.ok ? { ok: true, consumed: false } : res;
  }

  // Bag first, then the store — the order `applyMountSkin` uses, so a livery
  // stowed rather than carried still applies instead of reading as unowned.
  const itemId = shipSkinItemId(skinId);
  let taken = false;
  if (inventory?.consumeFromBag?.(itemId, 1)) taken = true;
  else if ((inventory?.remove?.(itemId, 1) ?? 0) > 0) taken = true;
  if (!taken) return { ok: false, reason: 'not-owned' };

  cosmetics.unlock(skinId);
  ships.applyScheme(shipId, skinId);
  return { ok: true, consumed: true };
}
