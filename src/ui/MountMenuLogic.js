import { STAT_META, liveryMatches } from '../mounts/Livery.js';

/** Swatch palettes by slot `palette` key. First entry of paint/wheel is the car factory colour. */
export const PALETTES = {
  paint: [
    0x2b3d55, 0x14181f, 0x2c2f36, 0xb9c2cc, 0xe6e9ee,
    0xc21f2f, 0xf27b1f, 0xffd23b, 0x18a86b, 0x1f6fd0,
    0x6a2fd0, 0xff3bd2, 0x00c2b0, 0x9a4433,
    // factory tack/leather/frame for dragon saddle, eagle harness, horse saddle, bicycle frame
    0x6d4522, 0x5a3a24, 0x2f7fd4,
  ],
  wheel: [
    0xb9c2cc, 0x2a2e33, 0x0d0f12, 0xd9dde2, 0xf2f4f6,
    0xc9a24a, 0xe0b23a, 0xc21f2f, 0x1f6fd0, 0x18a86b,
    0xff6a3a, 0x8f2fd0,
    0xb9bfc7, // bicycle factory rims
  ],
  // Every mount's factory colour for a slot must appear in that slot's palette,
  // or a factory mount opens with the custom picker lit. Car: paint[0]/wheel[0];
  // dragon hide 0x2b3a2e; eagle plumage 0x6b4c30; horse coat 0x8a6242.
  natural: [
    0x8a6242, 0x6b4c30, 0x2b3a2e, 0x4a3626, 0x2a1d13, 0x141216, 0xd6b26a,
    0xe6e6ea, 0x9a9aa0, 0x1f6b3a, 0x7a2a1a, 0x3a4a5c, 0xbfe6f2, 0xc98a2b,
  ],
  glow: [
    0xadefff, 0x2fe0ff, 0x3bffd2, 0xa8ff3b, 0xffe14a, 0xffae2b,
    0xff6a3a, 0xff3bd2, 0x8f2fd0, 0x1f6fd0, 0xffffff, 0xff2b2b,
  ],
};

/**
 * One-line effect copy for a stat at a tier.
 *
 * `enabled` defaults to true so every existing caller reads unchanged. A
 * switched-off fitting still states the number it WOULD give rather than
 * printing nothing: the player owns it, and a row that goes blank when the
 * switch flips looks like the upgrade was taken away.
 * @param {string} stat
 * @param {number} tier
 * @param {boolean} [enabled] false when the fitting is switched off
 */
export function statLine(stat, tier, enabled = true) {
  const meta = STAT_META[stat];
  if (!meta) return '';
  const t = Math.max(0, Math.floor(Number(tier) || 0));
  if (t <= 0) return 'Not upgraded — buy at market (B)';
  const effect = `+${meta.perTier * t}% ${meta.unit}`;
  return enabled === false ? `Switched off — ${effect} when on` : effect;
}

/**
 * The whole decision behind one upgrade row's on/off switch, off the DOM.
 *
 * Lives here rather than in the row builder because it is the only part of the
 * switch worth being sure about, and it is three questions that are easy to get
 * subtly wrong at once: is the fitting OWNED (an unbought stat has nothing to
 * switch and the button must do nothing at all), is it currently ON, and what
 * should be handed to `MountManager.setPowerEnabled` when it is pressed.
 *
 * `enabled` is read the way `isPowerEnabled` answers it: anything but an
 * explicit `false` is on, so a manager too old to have the method (or a stub
 * in a test) reads as fully enabled rather than fully off.
 *
 * @param {{tier?:number, enabled?:boolean}} state owned tier, and the switch
 * @returns {{tier:number, owned:boolean, on:boolean, next:boolean|null, label:string}}
 *   `next` is the value to pass to `setPowerEnabled`, or null for "do nothing".
 */
export function fittingSwitch({ tier, enabled } = {}) {
  const t = Math.max(0, Math.floor(Number(tier) || 0));
  const owned = t > 0;
  const on = enabled !== false;
  return {
    tier: t,
    owned,
    // An unowned fitting reads OFF whatever the record says, because that is
    // what the mount is actually doing - nothing.
    on: owned && on,
    next: owned ? !on : null,
    label: owned ? (on ? 'On' : 'Off') : '—',
  };
}

/** Card state for a skin: 'equipped' | 'owned' | 'held' | 'locked'. */
export function skinState({ skin, owned, held, livery }) {
  if (owned && liveryMatches(livery, skin.livery)) return 'equipped';
  if (owned) return 'owned';
  if (held > 0) return 'held';
  return 'locked';
}

export const SKIN_STATE_LABEL = {
  equipped: 'Equipped',
  owned: 'Owned',
  held: 'In inventory — Apply',
  locked: '🔒 Market',
};
