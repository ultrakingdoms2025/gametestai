import { MOUNT_SKINS_BY_ID } from './Cosmetics.js';
import { skinItemId } from './ItemDefs.js';

/**
 * "Wear a mount skin" - the one path both the F10 menu and the inventory Use
 * button go through. Stateless: every collaborator is passed in, so it is
 * indifferent to construction order in main.js and trivial to test.
 *
 * Owned (burned in) → just re-apply. Otherwise take one copy from the
 * inventory - bag first, then store - unlock it in the ledger, then apply. A
 * skin is only ever consumed on a successful apply.
 *
 * @param {{mounts:any, cosmetics:any, inventory:any}} deps
 * @param {string} skinId
 * @returns {{ok:boolean, reason?:'unknown-skin'|'not-mounted'|'wrong-mount'|'not-owned'|'unavailable', consumed?:boolean}}
 */
export function applyMountSkin({ mounts, cosmetics, inventory }, skinId) {
  const skin = MOUNT_SKINS_BY_ID.get(skinId);
  if (!skin) return { ok: false, reason: 'unknown-skin' };
  if (!mounts?.mounted || !mounts.active) return { ok: false, reason: 'not-mounted' };
  if (mounts.active.id !== skin.mount) return { ok: false, reason: 'wrong-mount' };

  // A no-op ledger (cosmetics missing `unlock`, or mounts missing `setLivery`)
  // must refuse before anything is taken from the bag/store - a purchase must
  // never be consumed with nowhere for it to land.
  if (typeof cosmetics?.unlock !== 'function' || typeof mounts?.setLivery !== 'function') {
    return { ok: false, reason: 'unavailable' };
  }

  if (cosmetics?.has?.(skinId)) {
    mounts.setLivery(skin.mount, skin.livery);
    return { ok: true, consumed: false };
  }

  const itemId = skinItemId(skinId);
  let taken = false;
  if (inventory?.consumeFromBag?.(itemId, 1)) taken = true;
  else if ((inventory?.remove?.(itemId, 1) ?? 0) > 0) taken = true;
  if (!taken) return { ok: false, reason: 'not-owned' };

  cosmetics?.unlock?.(skinId);
  mounts.setLivery(skin.mount, skin.livery);
  return { ok: true, consumed: true };
}
