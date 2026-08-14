/**
 * THE TRODDEN-GROUND GATE.
 *
 * `_settled(x, z)` is the single authority for beaten earth: the macro albedo
 * painter lays packed mud where it is high, the road setts read it, and the
 * grass scatter refuses to seed where it is above 0.34. It used to be thirty
 * lines of hand-written geometry inside `MedievalWorld`, opening with a
 * hard-coded rejection box:
 *
 *     if (x < -126 || x > 122 || z < -106 || z > 96) return 0;
 *
 * It now derives from the settlement table in `medieval/Settlements.js`. This
 * file exists because that rewrite is the highest-risk change in the whole
 * expansion: the old function fails by returning ZERO, which on a painted
 * ground plane is indistinguishable from open pasture. A rewrite that was
 * subtly wrong would not throw, would not look broken in a screenshot, and
 * would silently move the ground type under twenty-five houses.
 *
 * So the old implementation is reproduced below, verbatim, and the two are
 * compared on a dense grid. The claim being proved has two halves:
 *
 *   1. WHEREVER THE OLD REJECT BOX DID NOT FIRE, the two agree to the bit.
 *      That is the whole of the vale's settled ground as it was authored.
 *   2. WHERE IT DID FIRE, the new one is a strict SUPERSET - it never removes
 *      trodden ground, it only restores ground the box was clipping.
 *
 * The second half is a deliberate, measured deviation and not a regression;
 * see the test that enumerates it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MARKET, CASTLE, rectDist, smoothstep,
} from '../../src/worlds/terrain/MedievalHeight.js';
import {
  PLOTS, EXTRA_YARDS, SETTLEMENTS, GROUND_BOUNDS, settledAt, settlementAt,
} from '../../src/worlds/medieval/Settlements.js';

/** The 400m vale's `_settled`, character for character. */
function settledOld(x, z) {
  if (x < -126 || x > 122 || z < -106 || z > 96) return 0;
  const md = rectDist(x - MARKET.x, z - MARKET.z, MARKET.hx + 3, MARKET.hz + 3);
  let w = 1 - smoothstep(0, 8, md);
  for (let i = 0; i < PLOTS.length; i++) {
    const p = PLOTS[i];
    const r = Math.max(p[3], p[4]) * 0.5 + 3.2;
    const d = Math.hypot(x - p[0], z - p[1]) - r;
    const t = 1 - smoothstep(0, 6.5, Math.max(0, d));
    if (t > w) w = t;
    if (w >= 1) return 1;
  }
  for (let i = 0; i < EXTRA_YARDS.length; i++) {
    const e = EXTRA_YARDS[i];
    const d = Math.hypot(x - e.x, z - e.z) - (Math.max(e.w, e.d) * 0.5 + 3.0);
    const t = 1 - smoothstep(0, 6, Math.max(0, d));
    if (t > w) w = t;
  }
  const cd = rectDist(x - CASTLE.x, z - CASTLE.z, CASTLE.hx - 2, CASTLE.hz - 2);
  const t = 1 - smoothstep(0, 9, Math.max(0, cd));
  return t > w ? t : w;
}

/** True when the old cheap reject would have short-circuited to zero. */
const oldBoxRejects = (x, z) => x < -126 || x > 122 || z < -106 || z > 96;

/** 0.25m grid over the OLD 400m playfield: 1,600 x 1,600 = 2.56M samples. */
const OLD_HALF = 200;
const STEP = 0.25;

test('inside the old reject box the rewrite is bit-identical, over 2.56M samples', () => {
  let checked = 0;
  let nonZero = 0;
  let worst = 0;
  for (let z = -OLD_HALF; z < OLD_HALF; z += STEP) {
    for (let x = -OLD_HALF; x < OLD_HALF; x += STEP) {
      if (oldBoxRejects(x, z)) continue;
      const a = settledOld(x, z);
      const b = settledAt(x, z);
      const d = Math.abs(a - b);
      if (d > worst) worst = d;
      if (d !== 0) {
        assert.fail(`settled disagrees at (${x}, ${z}): old ${a}, new ${b}`);
      }
      if (a > 0) nonZero++;
      checked++;
    }
  }
  assert.equal(worst, 0);
  // A test that compared two functions over ground neither of them touches
  // would pass on any pair of implementations. This is the coverage claim.
  // The old box covered 248 x 202 m of the 400 x 400 m playfield, i.e. 31.3%.
  assert.ok(checked > 750000, `only ${checked} samples fell inside the old box`);
  assert.ok(nonZero > 40000, `only ${nonZero} samples were settled at all`);
});

test('the rewrite never REMOVES trodden ground, anywhere on the old playfield', () => {
  /* The dangerous direction. Grass refuses to seed above 0.34 settle and the
   * macro painter lays mud from it, so a value that dropped would put lawn
   * back inside a village square - the exact defect `_settled` was written to
   * fix in the first place. */
  for (let z = -OLD_HALF; z < OLD_HALF; z += STEP) {
    for (let x = -OLD_HALF; x < OLD_HALF; x += STEP) {
      const a = settledOld(x, z);
      if (a === 0) continue;
      const b = settledAt(x, z);
      assert.ok(b >= a, `settled DROPPED at (${x}, ${z}): ${a} -> ${b}`);
    }
  }
});

test('the ONLY differences are the yards the old reject box was suppressing', () => {
  /* THIS IS THE DEVIATION, stated precisely rather than hidden.
   *
   * The old box was measured off the settlements that existed when it was
   * written, and it was already wrong. The ten-plot castle-approach hamlet arc
   * was added later and sits entirely outside it - every one of those houses
   * was standing on unbroken lawn, with no yard, no desire line and grass
   * growing to the doorstep, because `_settled` returned 0 before it ever
   * looked at them. The water mill's yard was cut off at z = 96 for the same
   * reason. That is ~5,900 m2, 3.7% of the old playfield, and NOTHING would
   * have reported it: a hard-coded reject fails by returning zero, which on a
   * painted ground plane is indistinguishable from meadow.
   *
   * Deriving the bounds per settlement restores it. That is a visible change
   * to the 400m vale and it is the intended one - "any settlement added later
   * automatically gets beaten-earth ground" is the whole point of the table.
   *
   * Every differing sample must satisfy all three of:
   *   - the old box rejected it (so old == 0),
   *   - the new value is positive,
   *   - it lies inside the support of a real ground feature.
   */
  let diff = 0;
  let maxNew = 0;
  const owners = new Set();
  for (let z = -OLD_HALF; z < OLD_HALF; z += STEP) {
    for (let x = -OLD_HALF; x < OLD_HALF; x += STEP) {
      const a = settledOld(x, z);
      const b = settledAt(x, z);
      if (a === b) continue;
      diff++;
      assert.ok(oldBoxRejects(x, z),
        `a difference at (${x}, ${z}) that the old reject box does NOT explain`);
      assert.equal(a, 0);
      assert.ok(b > 0);
      if (b > maxNew) maxNew = b;
      // Attribute it to a settlement, so an unexplained one cannot hide.
      let found = null;
      for (const s of SETTLEMENTS) {
        for (const f of s.ground) {
          const d = f.shape === 'rect'
            ? rectDist(x - f.x, z - f.z, f.hx, f.hz)
            : Math.hypot(x - f.x, z - f.z) - f.r;
          if (d < f.feather) found = s.id;
        }
      }
      assert.ok(found, `no settlement owns the restored ground at (${x}, ${z})`);
      owners.add(found);
    }
  }
  assert.ok(diff > 0, 'the reject box suppressed nothing - this test is not testing anything');
  /* Pinned, so the scope of the deviation cannot grow unnoticed: 3.7% of the
   * old playfield, and every square metre of it belongs to one of exactly two
   * settlements. Aldermoor itself, the keep, the market and the churches are
   * untouched. */
  const total = ((OLD_HALF * 2) / STEP) ** 2;
  const pct = (diff / total) * 100;
  assert.ok(pct > 3.4 && pct < 4.0,
    `${pct.toFixed(3)}% of the old playfield changed - expected ~3.7%`);
  assert.deepEqual([...owners].sort(), ['aldern-mill', 'keep-approach']);
  assert.ok(maxNew > 0.9, 'the suppressed yards were only being grazed, not blanked');
});

/* ------------------------------------------------------------------ */
/* The table itself                                                    */
/* ------------------------------------------------------------------ */

test('every existing settlement is in the table, with a name and a place', () => {
  const byId = new Map(SETTLEMENTS.map((s) => [s.id, s]));
  assert.deepEqual([...byId.keys()].sort(), [
    'aldermoor', 'aldern-mill', 'aldermoor-keep', 'keep-approach',
    'south-parish', 'st-aldern', 'watchtower', 'west-parish', 'windmill',
  ].sort());
  for (const s of SETTLEMENTS) {
    assert.equal(typeof s.displayName, 'string');
    assert.ok(s.displayName.length > 2, `${s.id} has no display name`);
    assert.ok(Number.isFinite(s.centre.x) && Number.isFinite(s.centre.z), `${s.id} has no centre`);
    assert.ok(s.radius > 0, `${s.id} has no radius`);
    assert.ok(['village', 'hamlet', 'castle', 'church', 'mill', 'ruin'].includes(s.kind),
      `${s.id} has an unknown kind "${s.kind}"`);
    assert.ok(Array.isArray(s.ground), `${s.id} has no ground array`);
  }
});

test('plot membership partitions PLOTS - no house belongs to two places or none', () => {
  const seen = new Array(PLOTS.length).fill(0);
  for (const s of SETTLEMENTS) {
    if (!s.plots) continue;
    const [a, b] = s.plots;
    for (let i = a; i < b; i++) seen[i]++;
  }
  assert.deepEqual(seen, new Array(PLOTS.length).fill(1),
    'PLOTS is not exactly partitioned by the settlements that claim ranges of it');
});

test('a settlement radius reaches past the outer edge of its own ground', () => {
  /* The radius is what a later phase will space new settlements against. A
   * radius that stops short of a house's own beaten earth would let the next
   * village be dropped straight on top of an existing yard, so it has to cover
   * the feature's EXTENT, not just its centre. */
  for (const s of SETTLEMENTS) {
    for (const f of s.ground) {
      const reach = f.shape === 'rect'
        ? Math.hypot(f.hx + f.feather, f.hz + f.feather)
        : f.r + f.feather;
      const d = Math.hypot(f.x - s.centre.x, f.z - s.centre.z) + reach;
      assert.ok(d <= s.radius,
        `${s.id}: ground at (${f.x}, ${f.z}) reaches ${d.toFixed(1)}m, radius is ${s.radius}`);
    }
  }
});

test('the derived ground bounds actually contain all the ground', () => {
  /* This is the cheap reject `settledAt` opens with. If it were too tight it
   * would clip a yard exactly the way the old literal box did, and nothing
   * would say so - the function would just return 0. */
  for (const s of SETTLEMENTS) {
    if (!s.ground.length) {
      assert.equal(s.groundBounds, null, `${s.id} has bounds but no ground`);
      continue;
    }
    const b = s.groundBounds;
    for (const f of s.ground) {
      const hx = (f.shape === 'rect' ? f.hx : f.r) + f.feather;
      const hz = (f.shape === 'rect' ? f.hz : f.r) + f.feather;
      assert.ok(f.x - hx >= b.minX && f.x + hx <= b.maxX, `${s.id} bounds clip a feature in x`);
      assert.ok(f.z - hz >= b.minZ && f.z + hz <= b.maxZ, `${s.id} bounds clip a feature in z`);
      assert.ok(f.x - hx >= GROUND_BOUNDS.minX && f.x + hx <= GROUND_BOUNDS.maxX);
      assert.ok(f.z - hz >= GROUND_BOUNDS.minZ && f.z + hz <= GROUND_BOUNDS.maxZ);
    }
  }
  // ...and nothing outside them is settled, over the whole 900m vale.
  for (let z = -450; z <= 450; z += 1.5) {
    for (let x = -450; x <= 450; x += 1.5) {
      const outside = x < GROUND_BOUNDS.minX || x > GROUND_BOUNDS.maxX
        || z < GROUND_BOUNDS.minZ || z > GROUND_BOUNDS.maxZ;
      if (outside) assert.equal(settledAt(x, z), 0);
    }
  }
});

test('settledAt returns a clean 0..1 everywhere in the 900m vale', () => {
  for (let z = -450; z <= 450; z += 1.7) {
    for (let x = -450; x <= 450; x += 1.7) {
      const v = settledAt(x, z);
      assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `settled ${v} at (${x}, ${z})`);
    }
  }
});

test('settlementAt names the place you are standing in', () => {
  assert.equal(settlementAt(MARKET.x, MARKET.z)?.id, 'aldermoor');
  assert.equal(settlementAt(CASTLE.x, CASTLE.z)?.id, 'aldermoor-keep');
  assert.equal(settlementAt(160, -20)?.id, 'watchtower');
  assert.equal(settlementAt(-88, -150)?.id, 'windmill');
  // Open pasture in the newly-added ground belongs to nobody.
  assert.equal(settlementAt(400, 400), null);
  assert.equal(settlementAt(-430, 300), null);
});
