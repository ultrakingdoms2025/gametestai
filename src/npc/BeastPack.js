/**
 * Pack coordination for wolves.
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
 * Deliberately free of THREE and of the NPC class: a pack is bookkeeping over
 * a list of members, and keeping it that way is what lets
 * `scripts/tests/beast-pack.test.mjs` drive it with stubs.
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
   * @param {any} beast
   * @returns {boolean}
   */
  requestAttack(beast) {
    if (this._committed.has(beast)) return true;
    if (this._committed.size >= this.attackSlots) return false;
    this._committed.add(beast);
    return true;
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
