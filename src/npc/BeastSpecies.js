/**
 * Predator statistics: what a wolf and a bear ARE, as numbers.
 *
 * ── The design target ─────────────────────────────────────────────────────
 * "Genuine threat, survivable." Every figure below is chosen against that one
 * sentence and against the player it is fighting, whose numbers are fixed and
 * are the only reference that matters:
 *
 *     health 100, regen 8/s after 6 s of not being hit   (CONFIG.player)
 *     walk 4.6 m/s, sprint 8.2 m/s                       (CONFIG.player)
 *     sword 65 per hit at 2.6 m                          (WEAPON_STATS.sword)
 *     horse 8.4 m/s cruise, 15.5 m/s gallop              (Horse.js)
 *
 * From which:
 *
 *  - **Nothing outruns a sprinting player.** The wolf tops out at 7.6 and the
 *    bear at 6.4, both under 8.2. Fleeing is therefore always *available* -
 *    but sprinting costs stamina and a wolf does not, so it is a decision
 *    rather than a free out. On a mount it is not even close, which is the
 *    brief's "outrun them on a mount".
 *  - **A lone wolf is two sword hits.** 80 health against 65 damage. It gets
 *    perhaps one bite in on the way, for 12 + 9 bleed, so the exchange costs a
 *    fifth of the player's health and is plainly winnable.
 *  - **A bear is four sword hits and cannot be traded with.** 260 health, and
 *    26 + 20 bleed per swipe on a 2.4 s cycle: standing still and swinging
 *    costs the player about 92 health for four swings. That is a win only if
 *    every swipe is dodged, which is the "survivable" half of the brief - and
 *    an unarmed player simply loses, which is the "genuine threat" half.
 *  - **A pack is the wolf's real weapon.** One wolf is easy; four circling and
 *    biting from behind is 48 damage a cycle if they all connect, which is why
 *    the pack AI staggers its attacks (see `BeastPack`) - the threat has to be
 *    readable one beast at a time.
 *
 * Damage is paid for with telegraph, exactly as `NPCWeapons` pays for it: the
 * bear's 26-point swipe takes 0.8 s of visible rearing, the wolf's 12-point
 * bite 0.45 s of crouch-and-lunge. The player who reads the wind-up and steps
 * out of the arc takes nothing at all - the maul is a real contact volume, not
 * a hitscan, so stepping out genuinely works.
 *
 * No THREE, no DOM: this is a table, and `scripts/tests/beast-balance.test.mjs`
 * holds the relationships above against it.
 */

/**
 * @typedef {object} BeastDef
 * @property {string} id
 * @property {string} name             shown by the HUD and the kill feed
 * @property {string} gait             key into `BeastGait.GAITS`
 * @property {number} health
 * @property {number} shoulderHeight   metres, used as the capsule height
 * @property {number} bodyRadius       capsule radius; also the separation space
 * @property {number} bodyLength       nose to tail root, for the hit bounds
 * @property {number} roamSpeed        wandering its territory
 * @property {number} stalkSpeed       closing while it has not committed
 * @property {number} chargeSpeed      committed pursuit
 * @property {number} sight            metres it can notice a target at
 * @property {number} fovDegrees       full cone width
 * @property {number} scent            metres inside which facing stops mattering
 * @property {number} attackDamage     per landed blow, before spread
 * @property {number} damageSpread     fractional jitter, +/- of `attackDamage`
 * @property {number} telegraph        seconds of visible wind-up
 * @property {number} strikeWindow     seconds the contact volume is live
 * @property {number} recover          seconds of commitment after the blow
 * @property {number} attackCooldown   seconds between attacks
 * @property {number} reach            metres from the chest to the tip of the blow
 * @property {number} strikeRadius     radius of the swept contact volume
 * @property {number} knockback        horizontal impulse, m/s
 * @property {number} knockUp          vertical impulse, m/s
 * @property {number} bleedRate        health per second of the bleed it leaves
 * @property {number} bleedTime        seconds the bleed lasts
 * @property {number} viewKick         radians of camera pitch on a landed blow
 * @property {number} packMin          smallest group a world spawns
 * @property {number} packMax          largest
 * @property {number} territory        metres it roams from home
 * @property {number} loseInterest     metres past which it gives up a chase
 * @property {number} courage          0..1; below this fraction of health it flees
 */

/** @type {Record<string, BeastDef>} */
export const BEASTS = {
  /**
   * WOLF - low, lean and fast, and only dangerous in company.
   *
   * 80 health is deliberately under two sword hits' worth of margin: the point
   * of a wolf is that the player can always kill the one in front of them, and
   * the fight is about the three that are not in front of them.
   */
  wolf: {
    id: 'wolf',
    name: 'Wolf',
    gait: 'wolf',
    health: 80,
    shoulderHeight: 0.85,
    bodyRadius: 0.42,
    bodyLength: 1.5,
    roamSpeed: 1.6,
    stalkSpeed: 2.9,
    chargeSpeed: 7.6,
    sight: 34,
    fovDegrees: 190,
    /* Inside this, it has your scent and facing stops mattering. A predator
     * that can be walked up to from behind and simply never notices is worse
     * than one that notices too easily - the player reads it as broken rather
     * than as stealth, because nothing in this game teaches them that a wolf
     * has a blind spot. */
    scent: 9,
    attackDamage: 12,
    damageSpread: 0.25,
    telegraph: 0.45,
    strikeWindow: 0.14,
    recover: 0.3,
    attackCooldown: 1.6,
    reach: 2.0,
    strikeRadius: 0.55,
    knockback: 4.5,
    knockUp: 1.6,
    bleedRate: 3,
    bleedTime: 3,
    viewKick: 0.10,
    packMin: 3,
    packMax: 5,
    territory: 34,
    loseInterest: 46,
    courage: 0.18,
  },

  /**
   * BEAR - solo, slow, tanky, and hits like a falling tree.
   *
   * 260 health against a 65-point sword is four clean hits, which at the
   * sword's cadence is longer than the bear's attack cycle - so the player
   * cannot simply out-trade it and has to use the ground. The knockback is
   * twice the wolf's and doubles as the escape valve: being thrown four metres
   * back is what buys the sprint away.
   */
  bear: {
    id: 'bear',
    name: 'Bear',
    gait: 'bear',
    health: 260,
    shoulderHeight: 1.4,
    bodyRadius: 0.62,
    bodyLength: 2.1,
    roamSpeed: 1.1,
    stalkSpeed: 2.2,
    chargeSpeed: 6.4,
    // Poor eyes, famous nose: a bear sees less far than a wolf and smells you
    // from further away.
    sight: 26,
    fovDegrees: 160,
    scent: 11,
    attackDamage: 26,
    damageSpread: 0.2,
    telegraph: 0.8,
    strikeWindow: 0.18,
    recover: 0.45,
    attackCooldown: 2.4,
    reach: 2.6,
    strikeRadius: 0.75,
    knockback: 9,
    knockUp: 3.2,
    bleedRate: 5,
    bleedTime: 4,
    viewKick: 0.22,
    packMin: 1,
    packMax: 1,
    territory: 26,
    loseInterest: 34,
    courage: 0.0,
  },
};

/**
 * Look a species up, falling back to the wolf.
 *
 * A world that names a species this module has never heard of gets a wolf and
 * a console warning rather than a crash: a mis-typed spawn should cost the
 * author a look at the log, not a black screen.
 *
 * @param {string} id
 * @returns {BeastDef}
 */
export function beastDef(id) {
  const def = BEASTS[id];
  if (def) return def;
  if (id) console.warn(`[Beast] unknown species "${id}" - falling back to wolf`);
  return BEASTS.wolf;
}

/** Every species id a world may author. */
export const BEAST_IDS = Object.keys(BEASTS);

/**
 * Roll one blow's damage.
 * @param {BeastDef} def
 * @param {() => number} rnd 0..1
 */
export function rollBeastDamage(def, rnd) {
  const jitter = (rnd() * 2 - 1) * def.damageSpread;
  return Math.max(1, def.attackDamage * (1 + jitter));
}

/**
 * How many beasts a `count`-less spawn spec should produce.
 * Packs are rolled inside the species' own band so a world author can write
 * `{ type: 'beast', species: 'wolf' }` and get a pack rather than a loner.
 *
 * @param {BeastDef} def
 * @param {() => number} rnd
 */
export function rollPackSize(def, rnd) {
  const span = def.packMax - def.packMin;
  return def.packMin + (span > 0 ? Math.floor(rnd() * (span + 1)) : 0);
}
