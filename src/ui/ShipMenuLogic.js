import { SHIP_STAT_META, SHIP_BASE_STATS, holdCapacity, isPaidShipSkin } from '../ships/ShipStats.js';
import { liveryMatches } from '../mounts/Livery.js';

/**
 * The ship panel's rules, with no DOM in them.
 *
 * A twin of `ui/MountMenuLogic.js` and separate from `ShipMenu.js` for the same
 * reason: the interesting behaviour of a customiser is the state machine on its
 * cards and the copy on its stat rows, and neither of those needs a browser to
 * be wrong in. Everything here is a pure function over data.
 */

/**
 * Swatch palettes by slot `palette` key.
 *
 * ── EVERY hull's factory colour is a member of its own palette ────────────
 * `mount-menu.test.mjs:15-28` pins that rule for mounts and
 * `ship-customizer.test.mjs` pins it here, because the failure is silent and
 * permanent: a `defaultColor` missing from its palette opens the panel with the
 * CUSTOM PICKER lit instead of a swatch, for every player of that hull, for
 * ever. The three factory colours per slot are the first three entries below
 * and they are `SHIP_TINTS` — kept in that order so a reader can see the rule
 * being obeyed rather than take it on trust.
 */
export const SHIP_PALETTES = {
  shipHull: [
    0xbcc6d2, 0x8d97a4, 0x6f7d8c,             // Kestrel, Dray, Pike — factory
    0xe6e9ee, 0xd9dde2, 0xb9c2cc, 0x9a7b4f,
    0x2c2f36, 0x14181f, 0x2a2e33, 0x2f5d52,
    0x18a86b, 0x1f6fd0, 0xc21f2f, 0x6a2fd0,
  ],
  shipTrim: [
    0xd2762f, 0xc9a13c, 0xc23a2f,             // factory
    0xf27b1f, 0xffd23b, 0xc9a24a, 0xbcd8ff,
    0x0d0f12, 0x14181f, 0xd9dde2, 0xffb347,
    0x18a86b, 0x1f6fd0, 0x8f2fd0,
  ],
  shipGlass: [
    0x2c3f52, 0x35505f, 0x24323f,             // factory
    0x1b2530, 0x3a4a5c, 0x2f4a2a, 0x4a2f3a,
    0x5a4a1f, 0x203a3a, 0x6a6a70,
  ],
  shipGlow: [
    0x4fe3ff, 0xffb347, 0xff6a3a,             // factory
    0xadefff, 0x2fe0ff, 0x3bffd2, 0xa8ff3b,
    0xffe14a, 0xff3bd2, 0x8f2fd0, 0xffffff, 0xff2b2b,
  ],
  shipAccent: [
    0x8996a6, 0x6f7a88, 0xb9c2cc,             // factory
    0x5a3a24, 0x2a2e33, 0x0d0f12, 0xd9dde2,
    0xc9a24a, 0x1f6b3a, 0x7a2a1a, 0x3a4a5c,
  ],
};

/**
 * Where each ship refit actually comes from, in the player's own words.
 *
 * Kept beside the copy that uses it rather than imported from
 * `SpaceObjectives`, because that module pulls the whole campaign in and this
 * one is a pure formatter that `ship-customizer.test.mjs` drives on its own.
 * The test pins these four against `KILL_TIERS`, `ORE_TIERS` and the two set
 * prizes, so a ladder that moves its refit to another rung reddens here.
 */
export const REFIT_SOURCE = Object.freeze({
  fire: 'earned at Sablebane, 27 kills',
  shield: 'earned by breaking every raider wing',
  power: 'earned by surveying every body',
  hold: 'earned at Corecutter, 2,000 CR of ore cut',
});

/**
 * One-line effect copy for a stat at an owned tier.
 *
 * The hull's BASE bias is named as well as the purchased tier, because that is
 * the whole reason the ships are not each other in a different colour — a Dray
 * with two thrust tiers is still slower than a stock Kestrel, and a panel that
 * showed only the purchase would make the two look identical.
 */
export function shipStatLine(shipId, stat, tier) {
  const meta = SHIP_STAT_META[stat];
  if (!meta) return '';
  const t = Math.max(0, Math.floor(Number(tier) || 0));
  const base = SHIP_BASE_STATS[shipId]?.[stat] ?? 0;
  if (stat === 'hold') {
    const cap = holdCapacity(shipId, t);
    if (cap <= 0) return 'No hold at all — that is what an interceptor is';
    return t > 0 ? `${cap} m3 of hold (+${meta.perTier * t}% over stock)` : `${cap} m3 of hold`;
  }
  /* NAMES THE THING THAT ACTUALLY GRANTS IT.
   *
   * This line said "upgrade at the Fitting Shop", and the Fitting Shop has
   * never sold a ship stat in any code path, wired or unwired.
   * `SpaceObjectives._refit` is the ONLY caller of `ShipRegistry.grantPower`
   * anywhere in `src/` - grep `ships.grantPower` returns nothing else - and
   * `Marketplace._mountPowerGrant` reads `this.mounts?.getPowers?.()`, which
   * is the MOUNT registry, so no catalogue row can grant a ship tier even when
   * the API is up. So the panel was directing the player at a counter that
   * cannot serve them, for the one progression the campaign has.
   *
   * There are exactly four ship refits and each is a named rung: Sablebane
   * (27 kills) pays firepower, the completed wing set pays shields, the
   * completed survey pays thrust and Corecutter (2,000 CR of ore cut) pays
   * hold. Those are the words on the OBJECTIVES panel, so the player can find
   * the row this sentence is talking about. */
  if (t <= 0) return base > 0 ? `Stock ${meta.label.toLowerCase()} — ${REFIT_SOURCE[stat] ?? 'earned in the field'}` : 'Not fitted';
  return `+${meta.perTier * t}% ${meta.unit}`;
}

/**
 * Card state for a livery card.
 *
 * ── This used to be two states, and the note said two was honest ──────────
 * It said: "a mount skin is a purchasable cosmetic with an owned/held/locked
 * ladder behind it, and a yard scheme is paint the Paint & Rope counter
 * stencils for nothing. A 'locked' state here would be a card that can never
 * be unlocked, which is this project's signature defect rendered as a UI
 * element." That was exactly right for a catalogue in which nothing could be
 * bought. It is now half right, because half the catalogue can be.
 *
 * So the ladder is per-card, not per-panel, and it forks on the ONE fact that
 * decides it — `isPaidShipSkin`:
 *
 *   free   'applied' | 'available'                        (unchanged, for ever)
 *   paid   'applied' | 'owned' | 'held' | 'locked'        (the mount ladder)
 *
 * A free card can NEVER reach 'locked'. That is the guarantee the old note was
 * protecting and it is worth more now than it was then: the nine schemes
 * players already have must not acquire a padlock because nine others turned
 * up beside them wearing one.
 *
 * 'applied' for a paid livery additionally requires ownership, the way
 * `MountMenuLogic.skinState` requires it for 'equipped'. Hand-mixing the five
 * slots to a paid livery's exact colours is reachable — the pickers are right
 * there — and a card that lit up "on the hull" for someone who never bought it
 * would be telling them they own something they do not.
 *
 * @param {{scheme:object, livery:object, owned?:boolean, held?:number}} ctx
 * @returns {'applied'|'available'|'owned'|'held'|'locked'}
 */
export function schemeState({ scheme, livery, owned = false, held = 0 }) {
  const worn = liveryMatches(livery, scheme.livery);
  if (!isPaidShipSkin(scheme)) return worn ? 'applied' : 'available';
  if (owned) return worn ? 'applied' : 'owned';
  return held > 0 ? 'held' : 'locked';
}

/**
 * The tag on each card. Every one of them is what the click DOES, not what the
 * card is, because the tag is the only affordance on a row that is otherwise a
 * name and three or five dots.
 *
 * `locked` names the counter and the world, because the yard is the only place
 * in the Nexus with a `ships` counter and a player reading this in Aldermoor
 * Vale needs to know that before they go looking for a shop.
 */
export const SCHEME_STATE_LABEL = {
  applied: 'On the hull',
  available: 'Paint it',
  owned: 'Wear it',
  held: 'In your bag',
  locked: 'Yard shop',
};

/**
 * The two blocks the panel draws, in order, with the heading each gets.
 *
 * Split HERE rather than in `ShipMenu.js` so the rule "free first, paid second,
 * and a hull with none of one kind shows no empty heading" is a pure function a
 * headless test can drive - which is the same argument that put `schemeState`
 * and `shipStatLine` in this file rather than in the DOM one.
 *
 * The headings are load-bearing, not decoration. They are what makes a
 * `locked` card legible as "not bought yet" rather than "broken": a card
 * saying YARD SHOP under a heading that says the yard commissions these reads
 * as a price tag, and the same card sitting in an undifferentiated list of
 * eighteen reads as a bug.
 *
 * @param {ReadonlyArray<object>} schemes every livery for one hull
 * @returns {Array<{key:'free'|'paid', title:string, note:string, schemes:object[]}>}
 */
export function schemeSections(schemes) {
  const free = schemes.filter((s) => !isPaidShipSkin(s));
  const paid = schemes.filter(isPaidShipSkin);
  const out = [];
  if (free.length) {
    out.push({
      key: 'free',
      title: 'Yard schemes',
      note: 'Stencilled at the Paint and Rope counter. Yours already, all of them.',
      schemes: free,
    });
  }
  if (paid.length) {
    out.push({
      key: 'paid',
      title: 'Commissioned liveries',
      note: 'Ordered, not stencilled. Bought at the yard shop, then yours for good.',
      schemes: paid,
    });
  }
  return out;
}
