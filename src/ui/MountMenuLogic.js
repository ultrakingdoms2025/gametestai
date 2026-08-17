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

/** One-line effect copy for a stat at a tier. */
export function statLine(stat, tier) {
  const meta = STAT_META[stat];
  if (!meta) return '';
  const t = Math.max(0, Math.floor(Number(tier) || 0));
  if (t <= 0) return 'Not upgraded — buy at market (B)';
  return `+${meta.perTier * t}% ${meta.unit}`;
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
