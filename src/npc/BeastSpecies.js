/**
 * Beast statistics: what a wolf, a bear and a camel ARE, as numbers.
 *
 * Two of the three are predators and the design target below is written for
 * them. The camel is the exception and carries its own reasoning on its own
 * row: it is not balanced against the player at all, because it never touches
 * them - see the three locks documented there.
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
 * @property {boolean} [predator]      absent means true, so the two carnivore
 *   rows carry no new field and stay byte-identical. @see isPredator
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
    /**
     * 250, not 160.
     *
     * ── What 160 actually did ─────────────────────────────────────────────
     * `fovDegrees` is the FULL cone, so 160 leaves a 200 degree blind arc -
     * more than half the horizon - and sight is a cone off the BODY's facing,
     * which in ROAM is wherever the last wander leg pointed. Measured headless
     * with a stationary player 18 m away in the open and clear line of sight,
     * over 24 starting bearings: the bear noticed in 17 of them. In the other
     * seven it wandered for ten full seconds without ever looking at the player
     * and drifted away. In play that reads as an animal that only wakes up when
     * you are close enough to touch - and what has woken it at that point is
     * `scent`, not sight, which is why a live capture put acquisition at 4.3 m,
     * inside the 11 m nose radius where facing stops mattering.
     *
     * That undercuts the entire point of a bear. The design line is "poor eyes,
     * famous nose", and the honest expression of poor eyes is the short RANGE
     * above - 26 m against the wolf's 34 - not a narrow arc. A bear's eyes are
     * on the sides of its head; its real horizontal field is around 280
     * degrees, which is WIDER than a wolf's, not less than half of one.
     *
     * 250 leaves a 110 degree blind sector dead astern, so stalking up behind a
     * bear is still a thing that works and `scent` is still what ends it.
     * Re-measured on the same 24 bearings: 24 of 24 at 14 m and at 18 m, 22 of
     * 24 at 22 m, median acquisition inside 7 frames.
     */
    fovDegrees: 250,
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

  /**
   * CAMEL - a dromedary, and the first animal in this table that is not a
   * predator.
   *
   * -- WHY A HERBIVORE IS A ROW AND NOT A CLASS ------------------------------
   * `BeastNPC` and `BeastPack` contain no medieval reference and no wolf
   * reference; this file contained one word ("Predator statistics") at the top
   * of it. Everything the machinery does - body, gait, grounding, capsule, LOD
   * band, respawn, hit capsule, corpse sink - is quadruped, not carnivore. Only
   * ONE part of it is carnivore: the ATTACK branch of `BeastNPC`'s state
   * machine. So the camel is a row, and the whole design problem is making that
   * one branch unreachable from a table this file owns.
   *
   * -- THE THREE INDEPENDENT LOCKS ON THE MAUL -------------------------------
   * `_beginAttack` is reached from exactly one line, in `BeastNPC._stalk`:
   *
   *     wantsToCommit = attackTimer <= 0 && losClear && _spooked <= 0
   *                     && (!pack || pack.requestAttack(this))
   *     if (wantsToCommit && dist <= def.reach + this.radius) this._beginAttack()
   *
   * and each of the three below breaks it on its own. None of them needs a line
   * of `BeastNPC` changed, which is the point: a camel cannot maul the player
   * because of arithmetic, not because of a flag somebody remembered to set.
   *
   *  1. `reach` is -1. `this.radius` IS `def.bodyRadius`, so the test reads
   *     `dist <= -1 + 0.55 = -0.45`, and `dist` is a distance. There is no
   *     position either body can occupy that satisfies it. -1 is not a small
   *     reach; it is the sentinel for an animal that has no strike, and it is
   *     the only one of the three that holds however a spawner arranges packs.
   *     Everything downstream degrades safely: the stalk ring is
   *     `max(def.reach + 1.6, 4.2)`, which clamps to 4.2 m.
   *
   *  2. `fovDegrees` is 0 and `scent` is 0. `BeastNPC.fovCos` is
   *     `cos(fovDegrees * PI / 360)` = 1, and `_canSee` rejects anything whose
   *     bearing dot product is under the cone, so no candidate is ever seen and
   *     `losClear` - which `wantsToCommit` requires - is never set. Read the
   *     pair as what it is: `sight` by `fovDegrees` is the PREY sense, because
   *     `_candidates()` is a list of things to hunt, and a camel's prey sense is
   *     twelve metres of nothing at all. It is also, exactly, the brief:
   *     "otherwise ignore the player".
   *
   *  3. `predator: false`. `BeastPack` reads it and refuses both pursuit
   *     mechanisms - `share`, so a herd never holds a collective target for
   *     `_roam` to re-adopt, and `requestAttack`, so no member is ever granted
   *     an attack slot. @see BeastPack
   *
   * -- AND IT RUNS: `courage` 1.0 --------------------------------------------
   * `onDamaged` flees when `health < maxHealth * courage`. Every other row is
   * under 0.2, which is "flee when you are losing". At 1.0 the test is true the
   * instant any non-fatal blow lands, so being hit at all is what makes a camel
   * run - which is the whole of its temperament. The order inside `onDamaged`
   * matters and works in our favour: `_acquire` may flip the state to STALK,
   * and the courage check immediately after overwrites it with FLEE, in the
   * same call, before `_think` can ever tick a STALK.
   *
   * -- WHY `sight` AND `territory` ARE NOT SIMPLY ZERO -----------------------
   * Because two invariants asserted over the WHOLE species table forbid it, and
   * both are real rules about placement rather than about animals:
   *
   *     territory > 10                                        (beast-combat)
   *     (territory + sight) * TRACK_SHARE + TRACK_MARGIN > territory,
   *         TRACK_SHARE = 0.55, TRACK_MARGIN = 4          (medieval-wildlife)
   *
   * The second says a placement rule must be able to keep an animal off a road
   * it could otherwise wander onto, and it constrains `territory` and `sight`
   * TOGETHER. With `sight` 0 the pair reduces to `territory < 8.89`, which the
   * first forbids. 16 and 12 clear it by 3.4 m and give a herd a sensible
   * grazing disc; the zero that actually matters is the cone.
   *
   * -- THE FIGURES THAT ARE REAL ---------------------------------------------
   * A dromedary stands about 1.85 m at the withers and 2.20 m at the crest of
   * the hump, is roughly 3 m nose to tail root, and weighs half a tonne. The
   * player capsule is 1.75 m, so a camel is a head and a half taller than the
   * person looking at it, which is the one fact the silhouette has to sell.
   * `chargeSpeed` sits where every other row's does: above a walk (4.6) and
   * below a sprint (8.2), so a startled camel leaves a walking player behind
   * and cannot outrun one who commits to the chase.
   *
   * -- THE MAUL FIELDS BELOW ARE THE TABLE'S SHAPE, NOT A DESIGN -------------
   * `telegraph`, `strikeWindow`, `recover`, `knockback`, `knockUp`,
   * `strikeRadius`, `damageSpread`, `viewKick` and `attackDamage` describe a
   * blow this animal cannot throw. They hold the smallest values the table's
   * shared invariants accept, and they are never read - `_beginAttack` is
   * unreachable by (1), and `camel.test.mjs` proves that by exhausting the
   * distance axis rather than by asserting it. Do not tune them; there is
   * nothing on the other end of them to tune.
   */
  camel: {
    id: 'camel',
    name: 'Camel',
    gait: 'camel',
    /** No stalk, no maul, no attack. @see BeastPack and the three locks above. */
    predator: false,
    /* Four sword hits at 65, the same as a bear: a half-tonne animal that dies
     * to two is a prop. It runs long before it gets there. */
    health: 220,
    /* Crest of the hump. `BeastBody`'s camel profile height is this same
     * number, which `beast-body`'s scaling assertion requires, and the head is
     * carried well ABOVE it - the opposite of a bear, whose head hangs below
     * its hump. */
    shoulderHeight: 2.2,
    bodyRadius: 0.55,
    bodyLength: 3.0,
    /* Grazing pace. Slower than a wolf's roam, because a camel that is not
     * frightened is eating. */
    roamSpeed: 1.15,
    /* Unreached: `_stalk` is never ticked. Left plausible rather than zero so
     * that `_poseIntent`'s `stalking` flag - `moveSpeed < stalkSpeed * 1.2` -
     * cannot latch true at a standstill and ask the animator for a crouch.
     * `BeastAnimator` refuses a crouch for a non-predator anyway; this is the
     * belt to that pair of braces. */
    stalkSpeed: 2.4,
    /* The bolt. `_flee` runs at 0.95 of this, so 6.56 m/s. */
    chargeSpeed: 6.9,
    /* The prey sense, and it is off - see lock 2. The RANGE is set by the
     * placement inequality above, not by the animal's eyes. */
    sight: 12,
    fovDegrees: 0,
    scent: 0,
    /* Never landed. @see the note on the maul fields. */
    attackDamage: 1,
    damageSpread: 0,
    telegraph: 0.4,
    strikeWindow: 0.06,
    recover: 0.25,
    attackCooldown: 3,
    /** THE SENTINEL. `dist <= reach + bodyRadius` is `dist <= -0.45`. @see lock 1. */
    reach: -1,
    strikeRadius: 0.1,
    knockback: 3.5,
    knockUp: 0.5,
    /* No bleed at all: nothing bites, so nothing leaves a wound. */
    bleedRate: 0,
    bleedTime: 0,
    viewKick: 0,
    /* A herd, not a pack. `NPCManager.spawnBeastGroup` builds one `BeastPack`
     * for any group above one and gives every member the SAME `home`, which is
     * where the cohesion actually comes from - see the herd note in
     * `BeastPack`. */
    packMin: 3,
    packMax: 7,
    /* The grazing disc. Every member wanders inside this radius of the herd's
     * shared home, so a herd holds a patch of flat rather than dispersing
     * across it. Paired with `sight` by the placement inequality above. */
    territory: 16,
    loseInterest: 16,
    /** 1.0: any blow at all sends it running. @see the courage note above. */
    courage: 1.0,
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
 * Does this species hunt?
 *
 * ABSENT MEANS TRUE, and that is the whole reason the predicate exists rather
 * than a `predator: true` on every row: the wolf and the bear tables have to be
 * byte-identical to what they were before a herbivore was added to this file,
 * and `camel.test.mjs` pins their SHA-256 to prove it. A default that has to be
 * written out is a default that changes the two rows it is written on.
 *
 * Only `BeastPack` consults this today, to refuse the two pursuit mechanisms -
 * shared aggro and the attack token - to a herd. It is not the thing that stops
 * a camel mauling anybody; three separate locks do that, and they are set out
 * on the `camel` row above.
 *
 * @param {BeastDef|null|undefined} def
 * @returns {boolean}
 */
export function isPredator(def) {
  return def?.predator !== false;
}

/**
 * THE HOME LEASH: how far from its `home` a beast will hunt, metres.
 *
 * ── The defect this exists for ─────────────────────────────────────────────
 * Every rule that ended a pursuit was beast-to-TARGET - `loseInterest` and the
 * memory clock - and not one of them mentioned home. `chargeSpeed` 7.6 beats a
 * walking player's 4.6, so `loseInterest` can never fire against somebody who
 * simply keeps walking: measured before this, a player led one wolf 188.1 m
 * from its home - 5.5 territories - in 31.4 seconds, regenerating the whole
 * way, and pacing the slowest orbiter brought all five. The vale's whole cast
 * is inside that radius of somewhere. Edmund Marsh, the vale's quest manager,
 * stands 7.2 m from the player's spawn pin, is anchored, weaponless and not in
 * any respawn queue, and his death takes the quest board with it for the
 * session.
 *
 * ── Why it is `territory + sight` and not a number ─────────────────────────
 * Because that is the radius the world already placed the pack against.
 * `Wildlife.reachFor` is this same function - it delegates to it, so the two
 * cannot drift - and every clearance in the vale is written as `reach + ...`:
 * a pack home is at least `reach + MARGIN` from every civilian and from every
 * wall, and MARGIN is 22 because `FriendlyNPC.homeRadius` is at most 22. Put
 * the leash at `reach` and that arithmetic becomes a guarantee about where an
 * ANIMAL can be rather than about where a spec was written:
 *
 *     every point a civilian can occupy - pin, free-roam disc or patrol leg -
 *     is at least `reach` from every pack home, so no beast on this leash can
 *     ever acquire one.
 *
 * Measured on the shipped placement, minimised over all 108 civilians and all
 * twelve packs: the nearest a wolf's home comes to ground a civilian occupies
 * is 68.26 m against a 68 m leash, and a bear's 53.71 m against 52 m.
 * `medieval-wildlife.test.mjs` asserts both, over the built world.
 *
 * It also costs the encounter nothing, which a smaller leash does: acquisition
 * already happens anywhere inside this radius, so cutting the leash to 1.5
 * territories would have taken the watched share of the road network from 92
 * of 1,298 samples to 19.
 *
 * The rule is written against the TARGET's position rather than the beast's,
 * which is what makes it self-limiting - a beast only ever steers at something
 * inside the disc, so it stays inside the disc - and what gives it hysteresis:
 * step back inside and the pack comes again, with no boundary flicker.
 *
 * @param {BeastDef} def
 * @returns {number}
 */
export function threatRadius(def) {
  const territory = Number.isFinite(def?.territory) ? def.territory : 30;
  const sight = Number.isFinite(def?.sight) ? def.sight : 30;
  return territory + sight;
}

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
