/**
 * The maul: a real contact volume, and the arithmetic behind it.
 *
 * ── Why this is not a hitscan ─────────────────────────────────────────────
 * Every melee attack in the game today is a hitscan with a short range - see
 * `NPCWeapons`, where a blade is "an ordinary weapon with a 2.5 m reach" and
 * `HostileNPC._fire` casts a ray at the player's centre of mass. That works for
 * a swordsman because a sword is a line, and it is exactly wrong for a maul:
 * a ray from a bear's chest to the player's navel connects whatever the player
 * did, so the only defence against it is to already be out of range when the
 * timer fires. There is nothing to dodge.
 *
 * A predator that "physically mauls" you has to be able to MISS. So the strike
 * is a volume swept through the world during a short window, tested against the
 * target's own capsule on every fixed step of that window:
 *
 *      ┌── the beast's chest ────────────────────────────┐
 *      │                                                  ╲
 *      │   segment A ───────────────────────────────────►  ╲ tip, swung
 *      │   (origin → origin + forward·reach, rotated       ╱  through `arc`
 *      │    through the arc as the window elapses)        ╱   over the window
 *      └─────────────────────────────────────────────────╯
 *              radius `strikeRadius` around that segment
 *
 * Capsule against capsule is "is the distance between two segments less than
 * the sum of the radii", which is one closest-approach solve and no allocation.
 * Because the test runs every step of the window and the beast keeps moving,
 * the volume really is swept: a player who steps aside during the wind-up is
 * outside it when it opens, and a player who steps aside DURING it is clipped
 * by the leading edge and then free. That is the dodge.
 *
 * ── The arc ───────────────────────────────────────────────────────────────
 * A wolf's bite is a lunge: the volume runs straight out along the muzzle and
 * barely swings (`arc` ≈ 0.16 rad). A bear's swipe is a paw travelling sideways
 * across the front of its body, so its volume rotates through most of a radian
 * over the window. Same code, one number apart, and the two attacks read
 * completely differently because the ground they cover is a different shape.
 *
 * Pure arithmetic, no THREE and no DOM, so `scripts/tests/beast-maul.test.mjs`
 * can hold the hit AND the miss without building a world.
 */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Squared distance between segment (a0→a1) and segment (b0→b1).
 *
 * The standard clamped closest-approach solve (Ericson, *Real-Time Collision
 * Detection*, §5.1.9), written against loose {x,y,z} records so it can be
 * driven from a test with plain objects and from the game with Vector3s.
 *
 * @param {{x:number,y:number,z:number}} a0
 * @param {{x:number,y:number,z:number}} a1
 * @param {{x:number,y:number,z:number}} b0
 * @param {{x:number,y:number,z:number}} b1
 * @returns {number}
 */
export function segmentDistanceSq(a0, a1, b0, b1) {
  const dax = a1.x - a0.x, day = a1.y - a0.y, daz = a1.z - a0.z;
  const dbx = b1.x - b0.x, dby = b1.y - b0.y, dbz = b1.z - b0.z;
  const rx = a0.x - b0.x, ry = a0.y - b0.y, rz = a0.z - b0.z;

  const A = dax * dax + day * day + daz * daz;
  const E = dbx * dbx + dby * dby + dbz * dbz;
  const F = dbx * rx + dby * ry + dbz * rz;

  let s;
  let t;
  const EPS = 1e-9;

  if (A <= EPS && E <= EPS) {
    return rx * rx + ry * ry + rz * rz;      // both degenerate: point to point
  }
  if (A <= EPS) {
    s = 0;
    t = clamp01(F / E);
  } else {
    const C = dax * rx + day * ry + daz * rz;
    if (E <= EPS) {
      t = 0;
      s = clamp01(-C / A);
    } else {
      const B = dax * dbx + day * dby + daz * dbz;
      const denom = A * E - B * B;
      s = denom > EPS ? clamp01((B * F - C * E) / denom) : 0;
      t = (B * s + F) / E;
      if (t < 0) {
        t = 0;
        s = clamp01(-C / A);
      } else if (t > 1) {
        t = 1;
        s = clamp01((B - C) / A);
      }
    }
  }

  const cx = a0.x + dax * s - (b0.x + dbx * t);
  const cy = a0.y + day * s - (b0.y + dby * t);
  const cz = a0.z + daz * s - (b0.z + dbz * t);
  return cx * cx + cy * cy + cz * cz;
}

/**
 * Do two capsules overlap?
 * @returns {boolean}
 */
export function capsulesOverlap(a0, a1, ra, b0, b1, rb) {
  const r = ra + rb;
  return segmentDistanceSq(a0, a1, b0, b1) <= r * r;
}

/**
 * Build the strike volume for one instant of the window.
 *
 * @param {{x:number,y:number,z:number}} origin the mouth / shoulder point
 * @param {number} yaw the beast's facing (game convention: forward is -Z at 0)
 * @param {number} reach metres from `origin` to the tip
 * @param {number} arc radians the tip sweeps across the window, total
 * @param {number} u 0..1 progress through the strike window
 * @param {{x:number,y:number,z:number}} outTip written with the tip position
 * @param {number} [drop] metres the tip falls over the window (a paw comes down)
 * @returns {{x:number,y:number,z:number}} `outTip`
 */
export function strikeTip(origin, yaw, reach, arc, u, outTip, drop = 0) {
  // Half the arc leads, half trails, so the middle of the window is dead ahead
  // and the volume is centred on where the beast is looking.
  const a = yaw + arc * (0.5 - u);
  outTip.x = origin.x - Math.sin(a) * reach;
  outTip.y = origin.y - drop * u;
  outTip.z = origin.z - Math.cos(a) * reach;
  return outTip;
}

/**
 * Vertical capsule for a character standing at `feet`.
 *
 * @param {{x:number,y:number,z:number}} feet
 * @param {number} height
 * @param {number} radius
 * @param {{x:number,y:number,z:number}} outA bottom cap centre
 * @param {{x:number,y:number,z:number}} outB top cap centre
 */
export function standingCapsule(feet, height, radius, outA, outB) {
  outA.x = feet.x; outA.z = feet.z;
  outA.y = feet.y + radius;
  outB.x = feet.x; outB.z = feet.z;
  outB.y = feet.y + Math.max(radius + 0.05, height - radius);
}

/**
 * The whole test, in one call: does the strike volume at progress `u` reach the
 * target standing at `feet`?
 *
 * Kept as one function so the game and the tests cannot drift apart on what
 * "landed" means.
 *
 * @param {object} q
 * @param {{x:number,y:number,z:number}} q.origin strike origin (the mouth)
 * @param {number} q.yaw beast facing
 * @param {number} q.reach
 * @param {number} q.arc
 * @param {number} q.strikeRadius
 * @param {number} q.u 0..1 through the window
 * @param {number} [q.drop]
 * @param {{x:number,y:number,z:number}} q.feet target feet
 * @param {number} q.height target capsule height
 * @param {number} q.radius target capsule radius
 * @param {object} [scratch] three {x,y,z} records reused across calls
 * @returns {boolean}
 */
export function strikeHits(q, scratch = MAUL_SCRATCH) {
  const tip = strikeTip(q.origin, q.yaw, q.reach, q.arc, q.u, scratch.tip, q.drop ?? 0);
  standingCapsule(q.feet, q.height, q.radius, scratch.a, scratch.b);
  return capsulesOverlap(q.origin, tip, q.strikeRadius, scratch.a, scratch.b, q.radius);
}

/** Reused records so the strike test never allocates in the fixed step. */
export const MAUL_SCRATCH = {
  tip: { x: 0, y: 0, z: 0 },
  a: { x: 0, y: 0, z: 0 },
  b: { x: 0, y: 0, z: 0 },
};

/**
 * Arc width per species. A bite goes where the nose points; a swipe travels.
 *
 * Not in `BeastSpecies` because it is a property of the *volume*, and keeping
 * it beside the code that sweeps it is what stops the two drifting apart.
 */
export const STRIKE_ARC = {
  wolf: 0.16,
  bear: 0.95,
};

/** How far the tip falls through the window - a paw coming down, in metres. */
export const STRIKE_DROP = {
  wolf: 0.10,
  bear: 0.55,
};
