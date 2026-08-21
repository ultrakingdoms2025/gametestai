import { BEASTS, isPredator } from './BeastSpecies.js';

/**
 * Pack coordination for wolves, and the two things a HERD is not.
 *
 * ── The problem a pack solves, and the one it creates ─────────────────────
 * Four wolves that each independently run the "close on the target" behaviour
 * produce four wolves standing in the same spot, taking turns to be pushed out
 * of it by the separation constraint. It reads as a queue, not as a hunt, and
 * every one of them is in front of the player where they can all be killed with
 * the same swing.
 *
 * A pack has to do two things instead:
 *
 *   1. **Surround.** Each wolf holds its own bearing on the target and orbits
 *      it. The bearings are handed out as SLOTS around a ring, so they are
 *      spread by construction rather than by hoping the separation force sorts
 *      it out - and because a slot is stable, a wolf keeps circling the same
 *      way instead of dithering across the target's face.
 *   2. **Take turns.** If all five commit at once the player takes 60 damage in
 *      one beat with nothing to read. A token limits how many may be committed
 *      simultaneously, so the threat arrives one readable lunge at a time from
 *      a direction the player has to keep track of.
 *
 * Shared aggro is the third piece and the cheapest: the first wolf to notice
 * something tells the rest, which is the difference between a pack and four
 * animals that happen to be standing near each other.
 *
 * ── A HERD IS THIS CLASS WITH THE TWO PURSUIT MECHANISMS TAKEN OUT ────────
 * Camels are grouped by the same code path - `NPCManager.spawnBeastGroup`
 * builds one of these for any group above one, whatever the species - so the
 * honest thing to say is exactly which parts carry over and which do not.
 *
 * WHAT CARRIES OVER, unchanged: membership, the re-indexing on `remove` (a herd
 * that has lost a member must not leave a hole either), `firstLiving` (a herd
 * still needs one member to own the clock, and it still must not be a corpse),
 * and `liveCount`.
 *
 * WHAT DOES NOT, and is refused outright for a non-predator species:
 *
 *   - `share`. Shared aggro is what makes four wolves one animal. A herd that
 *     shared a target would be worse than useless: `BeastNPC._roam` re-adopts
 *     `pack.target` the moment a member is idle, so one camel that had been
 *     shot would drag the whole herd into STALK on the player. It returns 0 and
 *     never sets `target`, so `pack.target` on a herd is permanently null and
 *     that re-adopt branch can never fire.
 *   - `requestAttack`. There is no attack. It returns false, which sends
 *     `_stalk` down its `holdRing` branch - itself unreachable for a camel, but
 *     false is the answer that is true rather than the answer that is safe.
 *
 * WHAT IS NOT HERE, AND CANNOT BE. A herd's real behaviour is loose cohesion
 * around a leader, and this class cannot deliver it, because it does not steer
 * anything: every destination in the game is chosen inside `BeastNPC._roam` and
 * `_stalk`, from `this.home` and `this.nav`, and a pack has no channel into
 * either. Writing one would mean either reaching into members' navigation from
 * here - which is what this class was built to avoid - or editing `_roam`.
 *
 * The cohesion that DOES exist comes free from a mechanism that was already
 * there: `spawnBeastGroup` gives every member of a group the SAME `home`, and
 * `_roam` keeps each animal wandering inside `def.territory` of its own home.
 * So a herd is a shared anchor plus a shared radius, and the camel's territory
 * (16 m) is set as a grazing disc rather than as a hunting range for exactly
 * that reason. `herdBearing` below is the one piece of ring machinery worth
 * keeping for it: a stable, spread, NON-ROTATING bearing a caller can use to
 * lay out members around the anchor. The ring's rotation is a hunting
 * behaviour - it is what makes a pack circle - and a herd does not get it.
 *
 * Deliberately free of THREE and of the NPC class: a pack is bookkeeping over
 * a list of members, and keeping it that way is what lets
 * `scripts/tests/beast-pack.test.mjs` drive it with stubs. `BeastSpecies` is
 * the one import, and it is a table.
 */

const TAU = Math.PI * 2;

/** How fast the whole ring rotates, radians per second. */
const ORBIT_RATE = 0.55;
/**
 * How far a member may be from the one that spotted something and still be
 * told about it. A pack that shares aggro across the whole map is not a pack,
 * it is a global alarm.
 */
export const SHARE_RADIUS = 45;
/**
 * Seconds with nobody confirming the target before the pack forgets it.
 *
 * This is what makes escaping a pack possible. Individual members re-adopt the
 * pack's target whenever they find themselves idle - otherwise a wolf that
 * glanced away would wander off alone - so without a clock on the pack itself
 * that shared target would be permanent and a player could never break away.
 * Longer than one member's own memory, so a pack is more tenacious than a
 * loner, and short enough that breaking line of sight for a few seconds works.
 */
export const PACK_FORGET = 9;

let _nextPackId = 1;

export class BeastPack {
  /** @param {{species?:string, seed?:number}} [ctx] */
  constructor({ species = 'wolf', seed = 1 } = {}) {
    this.id = `pack-${_nextPackId++}`;
    this.species = species;
    /** @type {any[]} */
    this.members = [];
    /** Whatever the pack has collectively decided to hunt. */
    this.target = null;
    /** Seconds since the target was last confirmed by anybody. */
    this.targetAge = 0;
    /** Ring rotation, so the circle is a circling rather than a formation. */
    this.orbit = ((seed >>> 0) % 628) / 100;
    /** Members currently allowed to be committed to an attack. */
    this._committed = new Set();
    /** Which way round the ring the pack orbits; a coin flip per pack. */
    this.orbitSign = (seed >>> 3) & 1 ? 1 : -1;
    /**
     * Does this group hunt?
     *
     * Read once, from the species table, so a caller cannot get it wrong and a
     * spawner does not have to know that a herd is a different thing - it asks
     * for `new BeastPack({ species })` exactly as it always did. Absent means
     * predator, so the wolf's and the bear's rows carry no new field and this
     * is `true` for both of them. @see isPredator
     */
    this.predator = isPredator(BEASTS[species]);
  }

  /** A herd is a pack that neither shares aggro nor hands out attack slots. */
  get isHerd() {
    return !this.predator;
  }

  add(beast) {
    if (this.members.indexOf(beast) >= 0) return;
    this.members.push(beast);
    beast.pack = this;
    beast.packSlot = this.members.length - 1;
  }

  remove(beast) {
    const i = this.members.indexOf(beast);
    if (i < 0) return;
    this.members.splice(i, 1);
    this._committed.delete(beast);
    if (beast.pack === this) beast.pack = null;
    // Re-index, or a pack that has lost its second member leaves a gap in the
    // ring and two survivors circling the same bearing.
    for (let k = 0; k < this.members.length; k++) this.members[k].packSlot = k;
  }

  /**
   * The member that drives the pack's own clock.
   *
   * A pack has no `fixedUpdate` of its own - it is ticked by whichever member
   * calls it first - and that member has to be a LIVING one: a corpse's
   * `fixedUpdate` returns before `_think`, so a pack led by a dead wolf would
   * stop orbiting and stop ageing its target out, permanently.
   */
  firstLiving() {
    for (const m of this.members) if (!m.isDead) return m;
    return null;
  }

  /** Living members. The ring is sized off this, not off the roster. */
  get liveCount() {
    let n = 0;
    for (const m of this.members) if (!m.isDead) n++;
    return n;
  }

  /**
   * Tell the pack what one of its members has found.
   *
   * Returns the number of members that adopted the target, which is what the
   * test asserts on: silence would make "did the pack hear me" unanswerable.
   *
   * @param {any} target
   * @param {any} from the member that spotted it
   * @param {number} [radius]
   * @returns {number}
   */
  share(target, from, radius = SHARE_RADIUS) {
    if (!target) return 0;
    /* A herd does not pass word along, and crucially does not RECORD the
     * target either - `BeastNPC._roam` re-adopts `pack.target` whenever a
     * member is idle, so a stored target here would pull the whole herd onto
     * whoever shot one of them, several seconds after the fact. @see the herd
     * note at the top of this file. */
    if (!this.predator) return 0;
    this.target = target;
    this.targetAge = 0;
    const r2 = radius * radius;
    let told = 0;
    for (const m of this.members) {
      if (m.isDead) continue;
      // The spotter already has it - it is the one calling. Counting it would
      // make "did the word travel" unanswerable for a pack of one.
      if (m === from) continue;
      if (from && distSq(m.position, from.position) > r2) continue;
      if (m.adoptPackTarget?.(target)) told++;
    }
    return told;
  }

  /** Forget the target, and release everybody's commitment with it. */
  clearTarget() {
    this.target = null;
    this.targetAge = 0;
    this._committed.clear();
  }

  /**
   * How many members may be mid-attack at once.
   *
   * One for a trio, two for a five - so a bigger pack IS more dangerous, but
   * the danger scales slower than the head count and the player always has a
   * beat between blows.
   */
  get attackSlots() {
    return Math.max(1, Math.floor(this.liveCount / 3));
  }

  /**
   * Ask to commit to an attack. Idempotent for a member that already holds a
   * slot, so a beast can call it every step of its own wind-up.
   *
   * ── WHY IT IS NOT SIMPLY FIRST COME, FIRST SERVED ──────────────────────
   * It was, and a pack of three to five has exactly ONE slot, so the whole
   * pack's ability to land a blow was pinned on whichever member happened to
   * ask first that frame - whether or not that member could get anywhere near
   * the target. Measured on the Ashlea plank bridge, which is 2.6 m wide:
   * three wolves on the deck with the player, two of them 0.16 m and 1.51 m
   * away with clear line of sight, the slot held by the third at 8.65 m which
   * was braked to 1.38 m/s by the river either side of the planks and jammed
   * behind the other two. Thirty seconds, no telegraph, no bite. Handing the
   * slot to the nearest member instead produced two mauls in fifteen.
   *
   * So a holder that is a whole lunge FURTHER from the target than the asker
   * gives it up. Three properties make that safe:
   *
   *   - a member mid-sequence is never interrupted. The telegraph is the entire
   *     fairness deal for a 26-point swipe, and a wind-up that could be
   *     cancelled by a neighbour's arithmetic would not be one;
   *   - the margin is a lunge - `def.reach`, so it scales with the animal -
   *     which is the hysteresis. Two members within a lunge of each other do
   *     not swap, so the slot cannot thrash between them frame to frame;
   *   - and it degrades to the old rule for anything that does not publish a
   *     `targetDistance`, because a NaN comparison is false. `beast-pack`'s
   *     stubs are exactly that, and they still measure what they always did.
   *
   * @param {any} beast
   * @returns {boolean}
   */
  requestAttack(beast) {
    // There is no attack to be granted a slot in. @see the herd note above.
    if (!this.predator) return false;
    if (this._committed.has(beast)) return true;
    if (this._committed.size < this.attackSlots) {
      this._committed.add(beast);
      return true;
    }
    /* Every slot is held. Find the holder least able to use it. */
    let worst = null;
    for (const m of this._committed) {
      if (m.isDead) { this._committed.delete(m); continue; }
      if (m.attackPhase && m.attackPhase !== 'none') continue;
      if (!worst || m.targetDistance > worst.targetDistance) worst = m;
    }
    if (this._committed.size < this.attackSlots) {
      this._committed.add(beast);
      return true;
    }
    const lunge = beast?.def?.reach ?? 2;
    if (worst && worst.targetDistance - beast.targetDistance >= lunge) {
      this._committed.delete(worst);
      this._committed.add(beast);
      return true;
    }
    return false;
  }

  /** Give the slot back. Safe to call when the beast never held one. */
  releaseAttack(beast) {
    this._committed.delete(beast);
  }

  /** True while `beast` holds an attack slot. */
  isCommitted(beast) {
    return this._committed.has(beast);
  }

  /**
   * The bearing this member should hold on the target, in radians.
   *
   * Slots are spread evenly around the ring and the whole ring turns, so five
   * wolves are five bearings apart AND all of them are moving - which is what
   * makes a pack feel like it is working the player rather than posing around
   * them. Dead members keep their slot number but are skipped when sizing the
   * ring, so killing one closes the circle instead of leaving a hole.
   */
  slotAngle(beast) {
    const live = Math.max(1, this.liveCount);
    let rank = 0;
    for (const m of this.members) {
      if (m === beast) break;
      if (!m.isDead) rank++;
    }
    return this.orbit + (rank / live) * TAU;
  }

  /**
   * The animal a herd is arranged around.
   *
   * `firstLiving` by another name, and deliberately so: a herd's leader is not
   * a role anything grants, it is just whichever member is still alive and
   * first in the roster, exactly as the pack's clock-owner is. Naming it
   * separately is worth one line because "the leader" is what a caller laying
   * out a herd is actually looking for, and because a herd that quietly used
   * `firstLiving` would read as borrowing the pack's clock rather than as
   * having a leader.
   *
   * @returns {any|null}
   */
  leader() {
    return this.firstLiving();
  }

  /**
   * A stable, spread, NON-ROTATING bearing for one member of a herd.
   *
   * `slotAngle` above is the hunting version and differs in the two ways that
   * matter: it adds `this.orbit`, which turns, and it ranks over LIVING members
   * so the circle closes when one dies. Both are right for a pack working a
   * target and both are wrong for a herd. A herd does not circle anything - the
   * rotation is what makes a pack read as working you - and it does not close
   * ranks when one of its number is shot; the survivors stay where they were
   * grazing and the gap is the point.
   *
   * So this ranks over the ROSTER and adds nothing. Same member, same bearing,
   * for the life of the herd.
   *
   * What a caller does with it: `spawnBeastGroup` already gives every member of
   * a group the same `home`, which is the whole of the herd's cohesion (see the
   * note at the top of this file). This is for laying the bodies out around
   * that anchor at spawn, or for anything else that wants a spread direction
   * per member without allocating - it returns a number, so it is safe to call
   * from a loop or a frame handler.
   *
   * Accepts a member or a plain index, because the useful moment to ask is
   * during spawning, before the bodies exist to be passed in.
   *
   * @param {any|number} beastOrIndex
   * @param {number} [count] roster size, when an index is passed
   * @returns {number} radians
   */
  herdBearing(beastOrIndex, count = this.members.length) {
    const n = Math.max(1, typeof beastOrIndex === 'number' ? count : this.members.length);
    let rank = typeof beastOrIndex === 'number'
      ? beastOrIndex
      : this.members.indexOf(beastOrIndex);
    if (!(rank >= 0)) rank = 0;
    return ((rank % n) / n) * TAU;
  }

  /**
   * @param {number} dt
   */
  update(dt) {
    this.orbit = (this.orbit + this.orbitSign * ORBIT_RATE * dt) % TAU;
    this.targetAge += dt;
    if (this.target && (this.target.isDead || this.targetAge > PACK_FORGET)) this.clearTarget();
    // A member that died mid-wind-up must not hold its slot forever.
    for (const m of this._committed) {
      if (m.isDead) this._committed.delete(m);
    }
  }
}

function distSq(a, b) {
  if (!a || !b) return Infinity;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

export { TAU as PACK_TAU };
