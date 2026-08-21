import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUDGETS as KIT_BUDGETS,
  BUDGET,
  FALL_DAMAGE_M,
  FALL_LETHAL_M,
  CLIMB_SUSTAIN_M,
  STEP_UP,
  LANDING_MARGIN,
  DT,
  measure,
  padForAnchor,
  padAt,
  footprintGap,
  takeoffFan,
  budgetFor,
  flyArc,
  hayAt,
  boxAt,
  floorCheck,
  f,
  i5,
} from './citadel-reach-kit.mjs';

import {
  REGIONS, TIERS, BUDGETS, jumpSpan, gapFor, LAND_COST, LIP,
} from '../../src/worlds/citadel/Regions.js';
import { CITADEL_LANDFORMS } from '../../src/worlds/terrain/CitadelHeight.js';
import { MAX_DISTRICT_RADIUS, triangleCount, geometryBytes } from '../../src/worlds/citadel/Districts.js';
import {
  SolidField, auditSeal, auditGrounding, auditVacancy, planMine, SEAL_STEP,
} from '../../src/worlds/citadel/Caves.js';

/**
 * THE OUTER RING, MEASURED - six regions, one difficulty curve.
 *
 * ── What this file is for, and what it deliberately is not ────────────────
 *
 * `citadel-reach.test.mjs` asks the world-sized questions: is the jump graph
 * one component, does every haystack catch, is every relic reachable. It says
 * nothing about whether the ring is a PLACE - whether the Undercliff teaches
 * anything, whether the aqueduct is genuinely a leap route rather than a wide
 * walkway, whether the Eyrie is harder than the caravanserai and by how much.
 *
 * That is what a difficulty curve is, and Drop Two's measurement of the old
 * souk is the standing lesson in why it has to be asserted rather than
 * described: the file header had claimed a gradient for months, and the
 * measurement was `pearson(ring, gap) = 0.1485` with a mean gap of 2.01 m
 * against a 4.65 m sprint jump. A curve nobody measured was not a curve.
 *
 * ── Two arithmetics, forced to agree ──────────────────────────────────────
 *
 * `Regions.js` solves every gap from `jumpSpan`, which is the integrator. This
 * file re-measures the SAME gap out of the built collider set with
 * `footprintGap`, and then flies the crossing with `takeoffFan` - a completely
 * different piece of arithmetic, against real geometry, in both directions -
 * and requires the cheaper budget to FAIL. A report that agreed with itself
 * would be worth nothing; the point is that two independent routes to the same
 * number have to arrive at the same world.
 *
 * ── Every assertion is a floor ────────────────────────────────────────────
 *
 * Quoted floor / achieved / ceiling, with the ceiling computed by ablation
 * wherever an ablation exists, so a regression shows up as a number sliding
 * toward its floor rather than a boolean flipping.
 */

/* ================================================================== */
/* One pass, shared                                                    */
/* ================================================================== */

let _ring = null;
/** The ring, resolved once: pads, per-region rows, and the reverse reach. */
function ring() {
  if (_ring) return _ring;
  _ring = (async () => {
    const M = await measure();
    const { world, graph, idx, spawn } = M;

    /** Every published deck, keyed by region, with its pad and graph node. */
    const byRegion = new Map();
    for (const spec of REGIONS) byRegion.set(spec.id, []);
    for (const r of world._roofs) {
      if (!r.region) continue;
      const pad = padForAnchor(idx, r.x, r.z, r.y);
      const node = graph.nodeFor(r.x, r.z, r.y + 0.5);
      byRegion.get(r.region).push({ rec: r, pad, node });
    }

    /* "Can this node get BACK to spawn" for every node at once.
     *
     * The obvious spelling is `graph.reachableFrom(node).seen[spawn]` per deck,
     * which is 153 forward searches over a 17,500-node graph. One search over
     * the REVERSED adjacency answers the same question for every node in the
     * world, and it is the same answer: `b` reaches `a` in the reverse graph
     * exactly when `a` reaches `b` in the forward one. */
    const rev = graph.nodes.map(() => []);
    for (let a = 0; a < graph.adj.length; a++) for (const b of graph.adj[a]) rev[b].push(a);
    const back = new Uint8Array(graph.nodes.length);
    const stack = [spawn];
    back[spawn] = 1;
    while (stack.length) {
      const a = stack.pop();
      for (const b of rev[a]) if (!back[b]) { back[b] = 1; stack.push(b); }
    }

    /* Perimeter drops, per region, straight out of the graph's own sampling. */
    const dropsByRegion = new Map();
    for (const spec of REGIONS) dropsByRegion.set(spec.id, []);
    const nodeRegion = new Map();
    for (const [id, list] of byRegion) for (const d of list) if (d.node !== undefined) nodeRegion.set(d.node, id);
    for (const d of graph.drops) {
      const id = nodeRegion.get(d.from);
      if (id) dropsByRegion.get(id).push(d);
    }

    return { ...M, byRegion, back, dropsByRegion, world, graph, idx };
  })();
  return _ring;
}

/** The next-cheapest budget below `id`, or null for the walk. */
function cheaperThan(id) {
  const order = ['walk', 'sprint', 'leap'];
  const i = order.indexOf(id);
  return i > 0 ? BUDGETS[order[i - 1]] : null;
}

/* ================================================================== */
/* 1. The curve itself                                                 */
/* ================================================================== */

/**
 * FLOOR. The tier table is a curve, and the budget each tier names is REQUIRED.
 *
 * "Requires the leap" is a label until something checks that a sprint jump
 * cannot do it. `jumpSpan` is flown at the cheaper budget over the same rise
 * and has to come up short by a real margin - not by a centimetre, which would
 * be a curve that exists only in double precision.
 */
test('FLOOR: every tier names the budget its gaps actually require', () => {
  console.log('\n    tier  id       budget  slack  rises                gaps                 cheaper budget max');
  const fills = [];
  for (const t of TIERS) {
    const gaps = t.rises.map((r) => gapFor(t.budget, r, t.slack));
    const ceil = t.rises.map((r) => jumpSpan(t.budget, r) - LAND_COST);
    const cheap = cheaperThan(t.budget.id);
    const cheapMax = t.rises.map((r) => {
      const sp = jumpSpan(cheap ?? BUDGETS.walk, r);
      return Number.isFinite(sp) ? sp - LAND_COST : NaN;
    });
    const fill = gaps.map((g, i) => g / ceil[i]);
    fills.push(Math.max(...fill));
    console.log(`    ${String(t.order).padStart(4)}  ${t.id.padEnd(8)} ${t.budget.id.padEnd(6)} ${t.slack.toFixed(2)}  `
      + `${t.rises.map((r) => r.toFixed(2)).join(' ')}   ${gaps.map((g) => g.toFixed(2)).join(' ')}   `
      + `${cheap ? cheapMax.map((c) => (Number.isFinite(c) ? c.toFixed(2) : ' -- ')).join(' ') : '(nothing cheaper)'}`);

    for (let i = 0; i < gaps.length; i++) {
      assert.ok(gaps[i] > 0.6,
        `${t.id}: rise ${t.rises[i]} leaves a ${gaps[i].toFixed(2)} m gap - that is a stride, not a jump`);
      assert.ok(gaps[i] <= ceil[i] + 1e-9,
        `${t.id}: gap ${gaps[i].toFixed(2)} exceeds what ${t.budget.id} can cross at rise ${t.rises[i]}`);
      if (!cheap) continue;
      assert.ok(!(cheapMax[i] >= gaps[i]),
        `${t.id}: a ${cheap.id} jump crosses ${cheapMax[i].toFixed(2)} m at rise ${t.rises[i]}, `
        + `which covers the authored ${gaps[i].toFixed(2)} m - this tier does not require the ${t.budget.id}`);
      /* And by a margin. 0.35 m is two integrator steps at the leap's speed;
       * anything under that is a curve that exists only in double precision. */
      if (Number.isFinite(cheapMax[i])) {
        assert.ok(gaps[i] - cheapMax[i] >= 0.35,
          `${t.id}: the authored gap beats a ${cheap.id} jump by only ${(gaps[i] - cheapMax[i]).toFixed(3)} m`);
      }
    }
  }

  /* ── The curve, and it is LEXICOGRAPHIC rather than one number ─────────
   *
   * Difficulty here is a pair: which budget a crossing REQUIRES first, and how
   * much of that budget it then spends. Those are not interchangeable, and
   * collapsing them into one scalar is wrong in a way this test found the hard
   * way - tier 3 spends 93.4% of a LEAP where tier 2 spends 96.0% of a SPRINT,
   * and a scalar reads that as the curve going backwards when what actually
   * happened is that the required verb went up a whole step. So the assertion
   * is: the budget rank never falls, and within a run of tiers on the same
   * budget the fraction spent never falls either.
   *
   *   tier 0 walk   74.7%
   *   tier 1 sprint 89.4%   tier 2 sprint 96.0%
   *   tier 3 leap   93.4%   tier 4 leap   96.2%   tier 5 leap 98.2%
   */
  const RANK = ['walk', 'sprint', 'leap'];
  console.log(`    fraction of budget spent, by tier: ${fills.map((v, i) => `${TIERS[i].budget.id} ${(100 * v).toFixed(1)}%`).join('  ')}`);
  for (let i = 1; i < fills.length; i++) {
    const up = RANK.indexOf(TIERS[i].budget.id) - RANK.indexOf(TIERS[i - 1].budget.id);
    assert.ok(up >= 0,
      `tier ${i} requires a ${TIERS[i].budget.id} where tier ${i - 1} required a ${TIERS[i - 1].budget.id} - the curve goes backwards`);
    if (up === 0) {
      assert.ok(fills[i] >= fills[i - 1] - 1e-9,
        `tier ${i} spends ${(100 * fills[i]).toFixed(1)}% of the same budget against tier ${i - 1}'s ${(100 * fills[i - 1]).toFixed(1)}%`);
    }
  }
  assert.equal(RANK.indexOf(TIERS[0].budget.id), 0, 'the easiest tier must be a plain walk jump');
  assert.equal(RANK.indexOf(TIERS[TIERS.length - 1].budget.id), 2, 'the hardest tier must require the leap');
  floorCheck('difficulty curve: budget spent, easiest tier, %', 60, (100 * fills[0]).toFixed(1), 100);
  floorCheck('difficulty curve: budget spent, hardest tier, %', 95, (100 * fills[fills.length - 1]).toFixed(1), 100);

  /* And the integrator the whole table is solved from is the browser's. One
   * step of slack, because `jumpSpan` reports the last step still at height and
   * the landing happens between that step and the next. */
  for (const b of Object.values(BUDGETS)) {
    const span = jumpSpan(b, 0);
    /* One integrator step of slack, and 1 mm on top of it. `jumpSpan` reports
     * the last step the body is still at height on and `flat` is where it
     * lands, so the two are exactly one step apart - 4.6/60 = 0.0767 m at the
     * walk - and the browser's figure is quoted to three decimals. */
    assert.ok(span <= b.flat + 1e-9 && span >= b.flat - b.h * DT - 1e-3,
      `${b.id}: jumpSpan says ${span.toFixed(4)} m against the browser's ${b.flat} m`);
  }
});

/* ================================================================== */
/* 2. Two arithmetics, one world                                       */
/* ================================================================== */

/**
 * FLOOR. Every gap the author solved for is the gap the colliders have.
 *
 * `Regions.js` computes the gap from the trajectory and places the two plots
 * that far apart. This reads the two ROOF LIPS out of `ColumnIndex` and
 * measures between them with SAT. They must agree to a centimetre, and if they
 * do not, the plinth arithmetic or the row layout has drifted from the
 * intention and nothing else in this file means anything.
 */
test('FLOOR: every authored gap is the gap the built world has', async () => {
  const { idx, world } = await ring();
  let worst = 0;
  let n = 0;
  console.log('\n    region        crossings  worst |authored - measured|');
  for (const r of world.regions) {
    let w = 0;
    for (const c of r.crossings) {
      if (!c.a || !c.b) continue;
      const A = boxAt(idx, c.a.x, c.a.z, c.a.y);
      const B = boxAt(idx, c.b.x, c.b.z, c.b.y);
      assert.ok(A, `${r.id}: no collider owns the deck at (${c.a.x.toFixed(1)}, ${c.a.y.toFixed(2)}, ${c.a.z.toFixed(1)})`);
      assert.ok(B, `${r.id}: no collider owns the deck at (${c.b.x.toFixed(1)}, ${c.b.y.toFixed(2)}, ${c.b.z.toFixed(1)})`);
      const measured = footprintGap(A, B);
      const err = Math.abs(measured - c.gap);
      if (err > w) w = err;
      if (err > worst) worst = err;
      n++;
      assert.ok(err < 0.01,
        `${r.id}: authored ${c.gap.toFixed(3)} m, measured ${measured.toFixed(3)} m between the two lips`);
      // And the rise, which is the other half of the pair the gap was solved for.
      assert.ok(Math.abs(Math.abs(c.b.y - c.a.y) - c.rise) < 1e-9,
        `${r.id}: authored rise ${c.rise} against a built ${(c.b.y - c.a.y).toFixed(3)}`);
    }
    console.log(`    ${r.id.padEnd(14)}${i5(r.crossings.length)}      ${w.toFixed(4)} m`);
  }
  floorCheck('authored gaps re-measured off the colliders', n, n, n, `(worst error ${worst.toFixed(4)} m)`);
  assert.ok(n >= 70, `only ${n} authored crossings in the whole ring`);

  /* ── AND THE HEIGHT, which is the half a gap test cannot see ───────────
   *
   * Drop Two's second finding was that 189 of 340 souk edges were one-way
   * because height noise inside a ring exceeded what a jump gains, and its
   * conclusion was explicit: "Author HEIGHT deliberately, not just gaps -
   * re-authoring gaps alone will not produce a gradient."
   *
   * Every assertion above is satisfied perfectly by a ring of flat decks: flat
   * decks have a rise of 0, the gap solved for 0 is the widest the budget has,
   * and the two arithmetics agree to the micron. Caught exactly that way by a
   * mutation - the saw-tooth deleted from `row`, everything still consistent,
   * every gap still right, and a world with no step in it anywhere.
   *
   * So the step spectrum is asserted in its own right: a real share of the
   * ring's crossings must be a STEP as well as a gap, and the steps must be a
   * distribution rather than one repeated value. */
  const rises = [];
  for (const r of world.regions) for (const c of r.crossings) if (c.a && c.b) rises.push(Math.abs(c.b.y - c.a.y));
  const stepped = rises.filter((v) => v > 0.05).length;
  const distinct = new Set(rises.map((v) => v.toFixed(2))).size;
  const hist = [0, 0, 0, 0];
  for (const v of rises) hist[v < 0.05 ? 0 : v < 0.35 ? 1 : v < 0.65 ? 2 : 3]++;
  console.log(`    authored steps: level ${hist[0]}, under 0.35 m ${hist[1]}, 0.35-0.65 m ${hist[2]}, over 0.65 m ${hist[3]}`
    + `  (${distinct} distinct values)`);
  floorCheck('crossings that are a STEP as well as a gap, %', 40,
    ((100 * stepped) / rises.length).toFixed(1), 100,
    '(ceiling 100 = every crossing stepped; 0 = the flat-deck ring a gap test cannot tell from this one)');
  assert.ok(stepped / rises.length >= 0.40,
    `only ${stepped} of ${rises.length} crossings have any step in them - the ring is flat`);
  assert.ok(distinct >= 5,
    `the ring uses only ${distinct} distinct step heights - that is a constant, not a distribution`);
  /* Three, and all three are the Eyrie's: tier 5 is the only tier whose
   * saw-tooth reaches 0.70 m, which is 80% of the sprint jump's 0.878 m apex
   * and the point at which a step stops being something you run over. Floored
   * at 3 rather than at 4 because that IS the number, and a floor written above
   * what the world has is a floor that fails on the day it is written. */
  assert.ok(hist[3] >= 3,
    `only ${hist[3]} crossings step more than 0.65 m - nothing in the ring makes the step matter`);
});

/**
 * FLOOR. Every authored crossing is a ROUTE, both ways, at its named budget.
 *
 * This is where the design's substitution for `worstStep` earns its keep. The
 * gap being right is necessary and nowhere near sufficient: the arc has to
 * clear whatever is in between, land `LANDING_MARGIN` inside the target lip,
 * and do it from at least two distinct takeoff points on at least three
 * (point, bearing) pairs - because a gap crossable from one pixel on one
 * bearing is a fluke, not a route.
 *
 * BOTH DIRECTIONS, and that is the direct answer to Drop Two's other finding:
 * 189 of 340 souk edges were one-way, because height noise inside a ring
 * exceeded what a jump gains. Every rise in the ring is authored and every gap
 * is solved for the uphill half, so there is no one-way edge here by
 * construction - and this is the assertion that makes "by construction" true.
 */
test('FLOOR: every authored crossing is a two-way route at the tier it names', async () => {
  const { idx, world } = await ring();
  const rows = [];
  for (const r of world.regions) {
    const hist = { trivial: 0, walk: 0, sprint: 0, leap: 0, impossible: 0 };
    let oneWay = 0;
    let overBudget = 0;
    let cheaperWorks = 0;
    for (const c of r.crossings) {
      if (!c.a || !c.b) continue;
      const A = padForAnchor(idx, c.a.x, c.a.z, c.a.y);
      const B = padForAnchor(idx, c.b.x, c.b.z, c.b.y);
      const ab = budgetFor(A, B, idx);
      const ba = budgetFor(B, A, idx);
      hist[ab.id]++;
      if (ab.id === 'impossible' || ba.id === 'impossible') oneWay++;
      const rank = (k) => ['trivial', 'walk', 'sprint', 'leap', 'impossible'].indexOf(k);
      if (rank(ab.id) > rank(c.budget) || rank(ba.id) > rank(c.budget)) overBudget++;
      const cheap = cheaperThan(c.budget);
      if (cheap && rank(ab.id) < rank(c.budget) && rank(ba.id) < rank(c.budget)) cheaperWorks++;

      assert.notEqual(ab.id, 'impossible',
        `${r.id}: the crossing at (${c.a.x.toFixed(1)}, ${c.a.z.toFixed(1)}) -> (${c.b.x.toFixed(1)}, ${c.b.z.toFixed(1)}) `
        + `is authored ${c.gap.toFixed(2)} m at a rise of ${c.rise} and no budget crosses it`);
      assert.notEqual(ba.id, 'impossible',
        `${r.id}: the same crossing is ONE-WAY - ${ab.id} out and nothing back`);
      assert.ok(rank(ab.id) <= rank(c.budget) && rank(ba.id) <= rank(c.budget),
        `${r.id}: authored as a ${c.budget} crossing, flown as ${ab.id}/${ba.id}`);
    }
    rows.push({ id: r.id, tier: r.tier, budget: r.budget, hist, oneWay, overBudget, cheaperWorks, n: r.crossings.filter((c) => c.a && c.b).length });
  }
  console.log('\n    region        tier budget  n   trivial walk sprint leap  one-way over-budget cheaper-suffices');
  for (const r of rows) {
    console.log(`    ${r.id.padEnd(14)}${String(r.tier).padStart(3)}  ${r.budget.padEnd(7)}${i5(r.n)}`
      + `${i5(r.hist.trivial)}${i5(r.hist.walk)}${i5(r.hist.sprint)}${i5(r.hist.leap)}`
      + `${i5(r.oneWay)}${i5(r.overBudget)}${i5(r.cheaperWorks)}`);
  }
  const total = rows.reduce((a, r) => a + r.n, 0);
  floorCheck('authored crossings that are two-way routes', total, total - rows.reduce((a, r) => a + r.oneWay, 0), total);
  floorCheck('authored crossings flown at their own budget or cheaper', total,
    total - rows.reduce((a, r) => a + r.overBudget, 0), total);
  /* The ablation on the other side: how many crossings a CHEAPER budget turns
   * out to cover after all. Zero is the claim; anything else means a tier is
   * not the tier it says it is. Kept as a floor rather than an equality so the
   * number is visible when it moves. */
  const cheap = rows.reduce((a, r) => a + r.cheaperWorks, 0);
  floorCheck('crossings a cheaper budget would also cross', 0, cheap, 0,
    '(ceiling 0 = the tier table means what it says)');
  assert.equal(cheap, 0, 'a tier is being crossed by a budget below the one it names');
});

/* ================================================================== */
/* 3. Reach, both ways                                                 */
/* ================================================================== */

/**
 * FLOOR. Every region is reachable FROM the mesa and BACK, over real geometry.
 *
 * The non-negotiable from the brief, and the one the medieval expansion shipped
 * four defects against: a test that verifies a thing was BUILT and never that a
 * player can REACH it. Three separate questions, all asserted:
 *
 *   R1       the deck is in the spawn's connected component at all
 *   forward  the DIRECTED walk is possible from spawn, so drops and one-way
 *            jumps count in the direction they actually work
 *   back     the reverse directed walk reaches spawn, which is what makes a
 *            region a place rather than a pit
 */
test('FLOOR: every region deck is reachable from the mesa and back again', async () => {
  const { byRegion, back, reach, uf, main, world } = await ring();
  console.log('\n    region        decks   in R1  forward  back   worst deck (m)');
  let bad = 0;
  for (const spec of REGIONS) {
    const list = byRegion.get(spec.id);
    const unresolved = list.filter((d) => d.node === undefined);
    const inR1 = list.filter((d) => d.node !== undefined && uf.find(d.node) === main).length;
    const fwd = list.filter((d) => d.node !== undefined && reach.seen[d.node]).length;
    const bk = list.filter((d) => d.node !== undefined && back[d.node]).length;
    const hi = Math.max(...list.map((d) => d.rec.y));
    console.log(`    ${spec.id.padEnd(14)}${i5(list.length)}${i5(inR1)}${i5(fwd)}${i5(bk)}    ${hi.toFixed(1)}`);
    assert.deepEqual(unresolved.map((d) => `${d.rec.kind}@${d.rec.y.toFixed(1)}`), [],
      `${spec.id}: published decks that resolve to no node in the reach graph`);
    assert.equal(inR1, list.length, `${spec.id}: ${list.length - inR1} decks outside the spawn's component`);
    assert.equal(fwd, list.length, `${spec.id}: ${list.length - fwd} decks a player cannot get to from spawn`);
    assert.equal(bk, list.length, `${spec.id}: ${list.length - bk} decks a player cannot get back from`);
    if (inR1 !== list.length || fwd !== list.length || bk !== list.length) bad++;
  }
  const total = [...byRegion.values()].reduce((a, l) => a + l.length, 0);
  floorCheck('region decks reachable from spawn AND back', total, total, total);
  assert.equal(bad, 0, 'a region is not two-way reachable');
  assert.ok(total >= 140, `only ${total} decks published across six regions`);

  /* The publication itself, since a region with no decks would satisfy every
   * assertion above vacuously. */
  for (const spec of REGIONS) {
    assert.ok(byRegion.get(spec.id).length >= 12, `${spec.id} publishes only ${byRegion.get(spec.id).length} decks`);
  }
  assert.ok(world.regions.length === REGIONS.length, 'the world stopped reporting a region');
});

/**
 * FLOOR. Every drop off a region deck is survivable, and the deliberate ones
 * are answered by hay.
 *
 * R4 inverted, as the design states it: falling IS the mechanic here, so the
 * assertion is not "no edge drops you" but "no edge drops you somewhere you
 * cannot survive". The Undercliff's whole verb is a 10-13 m drop onto the next
 * bench, which is past `FALL_DAMAGE_M` 7.5 and nowhere near `FALL_LETHAL_M` 40
 * - so each one gets a haystack on the line it is taken from, and this is what
 * proves the hay is where the body lands rather than where a bearing derived
 * from the middle of the map happened to point.
 */
test('FLOOR: no region edge is an unsurvivable fall, and the authored ones are answered', async () => {
  const { dropsByRegion, world } = await ring();
  console.log('\n    region        samples  safe   hay  damage lethal   max fall   authored drops (>7.5 m / with hay)');
  let lethal = 0;
  let maxFall = 0;
  for (const spec of REGIONS) {
    const list = dropsByRegion.get(spec.id);
    let s = 0; let h = 0; let d = 0; let x = 0; let mx = 0;
    for (const p of list) {
      if (p.fall > mx) mx = p.fall;
      if (p.fall > maxFall) maxFall = p.fall;
      if (p.fall <= FALL_DAMAGE_M) s++;
      else if (hayAt(world, p.x, p.z, p.y)) h++;
      else if (p.fall < FALL_LETHAL_M) d++;
      else { x++; lethal++; }
    }
    const authored = world.regions.find((r) => r.id === spec.id).drops;
    const big = authored.filter((a) => a.fall > FALL_DAMAGE_M);
    console.log(`    ${spec.id.padEnd(14)}${i5(list.length)}${i5(s)}${i5(h)}${i5(d)}${i5(x)}    ${mx.toFixed(1).padStart(6)}      ${big.length} / ${big.filter((a) => a.hay).length}`);
    assert.equal(x, 0, `${spec.id}: ${x} perimeter samples are a lethal fall`);
    for (const a of big) {
      assert.ok(a.hay, `${spec.id}: an authored ${a.fall.toFixed(1)} m drop (${a.kind}) has no hay under it`);
      assert.ok(a.fall < FALL_LETHAL_M, `${spec.id}: an authored ${a.fall.toFixed(1)} m drop is lethal`);
    }
  }
  floorCheck('lethal edges anywhere in the ring', 0, lethal, 0, '(ceiling 0 = the property, not a measurement)');
  assert.ok(maxFall < FALL_LETHAL_M,
    `the tallest fall off a region deck is ${maxFall.toFixed(2)} m against a lethal ${FALL_LETHAL_M} m`);
});

/**
 * FLOOR. Every leap of faith the ring offers is FLOWN and lands in its own hay.
 *
 * Design 1.1's defect, region by region. The mesa's version of this test flies
 * the five mesa viewpoints; this flies the ring's, against the same integrator
 * and the same colliders, and additionally requires the haystack to be the top
 * of its own column - a hay standing inside somebody's roof catches nothing and
 * looks identical from the outside.
 */
test('FLOOR: every region viewpoint resolves, and every offer lands in its hay', async () => {
  const { idx, world, graph, reach, uf, main } = await ring();
  const vps = world.viewpoints.filter((v) => v.region);
  console.log('\n    viewpoint             region        y     r    offer  outcome    run    fall  to hay  caught');
  let offers = 0;
  let arrived = 0;
  for (const v of vps) {
    const node = graph.nodeFor(v.x, v.z, v.y + 0.5);
    assert.notEqual(node, undefined, `${v.id}: the viewpoint deck is on no node`);
    assert.equal(uf.find(node), main, `${v.id}: the viewpoint is outside the spawn's component`);
    assert.ok(reach.seen[node], `${v.id}: the viewpoint cannot be got to from spawn`);
    assert.ok(v.r >= 2.0, `${v.id}: a ${v.r.toFixed(2)} m platform is one a running body steps over`);
    assert.ok(v.hay && Number.isFinite(v.hay.y), `${v.id}: no resolved haystack`);
    const hd = idx.deckAt(v.hay.x, v.hay.z);
    assert.ok(hd && Math.abs(hd.y - (v.hay.y - 0.4)) < 0.05,
      `${v.id}: the hay must be the top of its own column, not buried in one`);

    if (!v.launch) {
      console.log(`    ${v.id.padEnd(22)}${v.region.padEnd(14)}${f(v.y, 6, 1)}${f(v.r, 6, 2)}   no`);
      continue;
    }
    offers++;
    const r = flyArc(idx, v.launch, Math.cos(v.bearing), Math.sin(v.bearing), BUDGET.leap,
      { maxSteps: 400, maxDrop: 200 });
    const run = Math.hypot(r.x - v.launch.x, r.z - v.launch.z);
    const fall = v.launch.y - r.y;
    const toHay = Math.hypot(r.x - v.hay.x, r.z - v.hay.z);
    const caught = !!hayAt(world, r.x, r.z, r.y);
    if (caught) arrived++;
    console.log(`    ${v.id.padEnd(22)}${v.region.padEnd(14)}${f(v.y, 6, 1)}${f(v.r, 6, 2)}   yes  ${r.outcome.padEnd(8)}${f(run, 7)}${f(fall, 7)}${f(toHay, 7)}   ${caught ? 'YES' : 'no'}`);
    assert.equal(r.outcome, 'land', `${v.id}: a published leap must end on a surface, not ${r.outcome}`);
    assert.ok(caught,
      `${v.id}: the leap lands ${toHay.toFixed(2)} m from its own hay after a ${fall.toFixed(2)} m fall`);
    assert.ok(fall < FALL_LETHAL_M, `${v.id}: the offer is a ${fall.toFixed(1)} m fall`);
  }
  assert.equal(vps.length, 5, 'five regions publish a viewpoint; the aqueduct is a route, not a place');
  floorCheck('region leap-of-faith offers that arrive in their hay', offers, arrived, offers);
  assert.equal(offers, 4, 'four region offers - the Caravan Mast withholds `launch` on a 15 m drop');
});

/* ================================================================== */
/* 4. Extent, relief and where a region is allowed to stand            */
/* ================================================================== */

/**
 * FLOOR. Every region stands inside the support of its own landform.
 *
 * `CITADEL_LANDFORMS` publishes an AABB per landform and the terrain contract
 * is that the shape is EXACTLY zero outside it. A region built outside its own
 * box is a region standing on whatever the broad relief happens to be doing,
 * which is how a terrace ends up with an eleven-metre wall at one end and none
 * at the other - and it is also how a "quarry" ends up not being in the quarry.
 *
 * The aqueduct is the deliberate exception and is asserted as one: it is a
 * SPINE between two landforms and crosses the flats between them, so its box is
 * checked against the protected core and the rim instead.
 */
test('FLOOR: every region stands on its own landform, inside the playfield', async () => {
  const { world } = await ring();
  const byId = new Map(CITADEL_LANDFORMS.map((l) => [l.id, l]));
  console.log('\n    region        landform              extent x           extent z         relief   deck lo..hi');
  for (const r of world.regions) {
    const ex = r.aabb.max.x - r.aabb.min.x;
    const ez = r.aabb.max.z - r.aabb.min.z;
    console.log(`    ${r.id.padEnd(14)}${(r.landform ?? '(spine)').padEnd(22)}`
      + `${f(r.aabb.min.x, 8, 1)}..${f(r.aabb.max.x, 7, 1)} (${ex.toFixed(0)})  `
      + `${f(r.aabb.min.z, 8, 1)}..${f(r.aabb.max.z, 7, 1)} (${ez.toFixed(0)})  `
      + `${f(r.ground.relief, 7, 2)}  ${f(r.deck.min, 7, 1)}..${f(r.deck.max, 6, 1)}`);

    assert.ok(ex > 20 && ez > 20, `${r.id} occupies ${ex.toFixed(0)} x ${ez.toFixed(0)} m - that is not a region`);
    assert.ok(r.aabb.min.x > -450 && r.aabb.max.x < 450 && r.aabb.min.z > -450 && r.aabb.max.z < 450,
      `${r.id} reaches the rim of the playfield`);
    assert.ok(world.contentBounds.min.x <= r.aabb.min.x && world.contentBounds.max.x >= r.aabb.max.x
      && world.contentBounds.min.z <= r.aabb.min.z && world.contentBounds.max.z >= r.aabb.max.z,
      `${r.id} is outside contentBounds - its relics would never be budgeted for`);

    if (!r.landform) {
      /* The spine. Both ends are asserted where they are meant to be: on the
       * mesa outside the curtain wall, and on the monastery shelf. */
      const a = r.built.a;
      const b = r.built.b;
      assert.ok(Math.hypot(a.x, a.z) > 118 && Math.hypot(a.x, a.z) < 145,
        `the aqueduct's mesa abutment is at r = ${Math.hypot(a.x, a.z).toFixed(1)}, outside the wall/mesa band`);
      assert.ok(Math.hypot(b.x + 40, b.z + 326) < 45,
        'the aqueduct does not reach the massif shelf');
      continue;
    }
    const L = byId.get(r.landform);
    assert.ok(L, `${r.id} names a landform "${r.landform}" that does not exist`);
    const pad = 26;                   // hay and stair heads may overhang the support
    assert.ok(r.aabb.min.x >= L.aabb.x0 - pad && r.aabb.max.x <= L.aabb.x1 + pad
      && r.aabb.min.z >= L.aabb.z0 - pad && r.aabb.max.z <= L.aabb.z1 + pad,
      `${r.id} stands outside the support of "${r.landform}"`);
  }

  /* Relief: what the ground under each region actually does, which is the
   * number the plinths have to absorb. Reported, and floored only at the ends -
   * a region on ground with NO relief is a region on a table. */
  const relief = world.regions.map((r) => r.ground.relief);
  floorCheck('regions standing on ground with real relief', 6, relief.filter((v) => v > 1.0).length, 6);
  assert.ok(Math.max(...relief) < 40, 'a region spans more relief than the mesa is tall');
});

/* ================================================================== */
/* 5. The budgets, re-measured with the ring in                        */
/* ================================================================== */

/**
 * FLOOR. Design 5.4's four budgets, measured over the world WITH the ring, and
 * the ring's own share of each quoted separately.
 *
 * `citadel-budgets.test.mjs` owns the whole-world ledger. What this adds is the
 * attribution: how much of each budget the outer ring spent, so the next drop
 * knows what it has left rather than re-deriving it from a total.
 */
test('FLOOR: the ring fits inside every budget the extent stage set', async () => {
  const { world, physics } = await ring();

  const meshes = [];
  world.group.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const ringMeshes = meshes.filter((m) => m.name.startsWith('region:') || m.name.startsWith('cave:'));
  const tri = (list) => list.reduce((a, m) => a + triangleCount(m.geometry), 0);
  const bytes = (list) => list.reduce((a, m) => a + geometryBytes(m.geometry), 0);

  const worstSphere = Math.max(...ringMeshes.map((m) => m.geometry.boundingSphere?.radius ?? 0));
  const ringCol = world.regions.reduce((a, r) => a + r.colliders, 0);
  const worstSlice = Math.max(...world.regions.map((r) => r.worstSlice));

  const pad = (v, w) => String(v).padStart(w);
  console.log('\n                            draws   triangles       MB   worst sphere');
  console.log(`    region + cave meshes  ${pad(ringMeshes.length, 5)}${pad(tri(ringMeshes), 12)}`
    + `${pad((bytes(ringMeshes) / 1048576).toFixed(2), 9)}   ${worstSphere.toFixed(1)} m`);
  console.log(`    whole world           ${pad(meshes.length, 5)}${pad(tri(meshes), 12)}`
    + `${pad((bytes(meshes) / 1048576).toFixed(2), 9)}`);
  console.log(`    colliders: ring ${ringCol}, world ${physics.colliders.length}; worst region slice ${worstSlice}`);

  /* ── A budget is a CEILING, and `floorCheck` asserts a floor ────────────
   *
   * The two read the same way on the page - budget / achieved / what it was
   * before - and invert in the assertion, which is exactly the mistake this
   * line made first time out: `floorCheck('draw calls', 150, 136, 48)` printed
   * a perfectly sensible row and then failed because 136 is under 150. So the
   * budgets get their own helper, and it asserts the direction they actually
   * have. `was` is the ablation: the figure the extent stage measured with an
   * empty ring, so a regression shows up as a number climbing off it. */
  const budgetCheck = (label, budget, achieved, was) => {
    console.log(`    ${label.padEnd(46)} budget ${String(budget).padStart(7)} | achieved ${String(achieved).padStart(7)} | empty ring ${String(was).padStart(7)}`);
    assert.ok(Number(achieved) <= budget, `${label}: ${achieved} is over the budget of ${budget}`);
  };

  /* 175 and not the 150 this shipped with, and the change is priced in
   * `citadel-budgets.test.mjs` where the same ceiling lives with its reasoning:
   * 150 was borrowed from `medieval-towns.test.mjs:607`, where it bounds five
   * towns at ~177k triangles rather than a whole world, and the caravan drop's
   * two oases and eight wayside wells take the Citadel from 136 to 164 for
   * 56,648 triangles of content in the empty flats. The bound that catches
   * meshes which are NOT carrying content is the triangles-per-draw floor
   * asserted there (1,733 from medieval; the Citadel is at 3,300), not a count.
   */
  budgetCheck('C3  draw calls, whole world', 175, meshes.length, 118);
  budgetCheck('C3  worst ring mesh bounding sphere, m', MAX_DISTRICT_RADIUS, worstSphere.toFixed(1), 126.9);
  budgetCheck('C4  colliders, whole world', 20000, physics.colliders.length, 3102);
  budgetCheck('C5  colliders between two yields, worst region', 250, worstSlice, 139);
  console.log(`    the ring's own share: ${ringMeshes.length} draws, ${tri(ringMeshes)} triangles, `
    + `${(bytes(ringMeshes) / 1048576).toFixed(2)} MB, ${ringCol} colliders`);

  /* The ring is meant to be SPATIALLY separated - six clusters, one batch each -
   * and that is why it costs so few draws. Asserted, because a change that
   * merged them all into one batch would still pass every other line here while
   * quietly turning 20 draw calls into 49. */
  const perRegion = new Map();
  for (const m of ringMeshes) {
    const k = m.name.split(':').slice(0, 2).join(':');
    perRegion.set(k, (perRegion.get(k) ?? 0) + 1);
  }
  console.log(`    meshes per batch: ${[...perRegion.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}`);
  assert.ok(perRegion.size >= 8, 'the ring is no longer merged one region at a time');
  for (const [k, v] of perRegion) assert.ok(v <= 8, `${k} came back as ${v} meshes - it is spanning the map`);
});

/* ================================================================== */
/* 6. The caves                                                        */
/* ================================================================== */

/**
 * FLOOR. Two caves, sited against the finished world, sealed against it, and
 * published as `Interiors` descriptors with their mouths.
 *
 * Everything here is asked of `physics.colliders` and never of the builder.
 * `Caves.js`'s own suite proves the KIT; this proves the SITING, which is the
 * half the kit's header says a caller has to finish - and which the kit's own
 * default anchors fail on this world, because the ring was empty when they were
 * searched and it is not empty now.
 */
test('FLOOR: both caves are sited clear, sealed, and published with their mouths', async () => {
  const { world, physics } = await ring();
  const caves = world.caves ?? [];
  assert.equal(caves.length, 2, 'the world stopped planning its caves');
  const field = new SolidField(physics.colliders);

  console.log('\n    cave           built  lift    relief  occupied  blocked  colliders  lights  mouths  leaks / samples   mouths open');
  for (const c of caves) {
    assert.ok(c.built, `cave "${c.id}" was refused: ${c.vacancy.occupied} occupied, ${c.vacancy.mouthBlocked} blocked`);
    assert.equal(c.vacancy.occupied, 0, `cave "${c.id}" is standing in somebody else's geometry`);
    assert.equal(c.vacancy.mouthBlocked, 0, `cave "${c.id}" has a wall in front of a mouth`);

    /* The seal, proved against the FINAL collider set rather than against the
     * builder - the maze's hard-won lesson that emitted is not present, because
     * a later pass can delete the very wall a volume proved itself against. */
    const seal = auditSeal(c.plan, field, SEAL_STEP);
    const ground = auditGrounding(c.plan, field);
    const mouths = [...seal.byMouth.entries()];
    console.log(`    ${c.id.padEnd(15)}${String(c.built).padEnd(7)}${c.lift.toFixed(2).padStart(6)}  `
      + `${(c.profile.hi - c.profile.lo).toFixed(2).padStart(6)}  ${i5(c.vacancy.occupied)}    ${i5(c.vacancy.mouthBlocked)}`
      + `${i5(c.colliders)}${i5(c.lights)}${i5(c.mouths)}    ${seal.leaks.length} / ${seal.samples}`
      + `   ${mouths.map(([k, v]) => `${k} ${v.open}/${v.total}`).join(', ')}`);
    assert.equal(seal.leaks.length, 0,
      `cave "${c.id}" leaks at ${seal.leaks.length} of ${seal.samples} boundary samples`);
    assert.ok(seal.samples > 5000, `cave "${c.id}" was sealed against only ${seal.samples} samples`);
    assert.equal(seal.blockedMouths.length, 0, `cave "${c.id}" has a mouth walled up`);
    /* BOTH halves. A cave with no holes passes "no leaks" perfectly and is
     * unplayable, so the mouths have to be open as well as the walls solid -
     * every declared opening, at every sample across it. */
    for (const [id, m] of mouths) {
      assert.ok(m.total > 0, `cave "${c.id}": mouth "${id}" has no samples across it`);
      assert.equal(m.open, m.total, `cave "${c.id}": mouth "${id}" is open at only ${m.open} of ${m.total} samples`);
    }
    assert.equal(ground.buried, 0, `cave "${c.id}" has ${ground.buried} buried floor columns`);
  }

  /* ── The vacancy probe, proved to have teeth ───────────────────────────
   *
   * Both shipped sites report zero occupied samples, which is what they are
   * meant to report - and it means the probe reading zero proves nothing on its
   * own. Neuter it and the caves build in exactly the same place, so a mutation
   * that deletes it is invisible. The power has to come from a POSITIVE
   * control: the same probe, the same field, a plan put somewhere that is
   * definitively not empty. The Undercliff's top terrace is nine buildings in a
   * row 41 m of arc long, and it is 300 m from either cave.
   *
   * This is the kit's own lesson restated - `Caves.js` records the same control
   * for the same reason, because its M13 mutation was green for the same
   * reason. */
  const occupied = world._roofs.find((r) => r.region === 'undercliff' && r.kind === 'terrace-0');
  assert.ok(occupied, 'the Undercliff no longer has a terrace-0 row to test the probe against');
  const control = auditVacancy(
    planMine({ id: 'control', label: 'control', origin: { x: occupied.x, y: occupied.y - 3, z: occupied.z }, yaw: 0 }),
    field, { step: 1.5, apron: 4.0 }
  );
  console.log(`    vacancy control on the Undercliff terrace: ${control.occupied} occupied of ${control.samples} samples`);
  /* 16 of 579, and the ratio is the geometry rather than a weak probe: the mine
   * plan is a 48 m drive and a nine-plot terrace row is 41 m of ARC, so most of
   * the drive runs out over open bench. What matters is that the count is not
   * zero where the two real sites are zero, and it is not. */
  floorCheck('vacancy probe: occupied samples on known-full ground', 10, control.occupied, control.samples,
    '(the probe reading 0 at the two real sites means nothing without this)');
  assert.ok(control.occupied >= 10,
    `the vacancy probe found only ${control.occupied} occupied samples inside a row of nine buildings - it is not working`);

  /* The publication, which is what the next stage consumes. */
  const enterables = world.enterables ?? [];
  const caveEnt = enterables.filter((e) => e.cave);
  assert.equal(caveEnt.length, 2, 'the cave mouths are not published as enterables');
  for (const e of caveEnt) {
    assert.ok(e.label && e.origin, `${e.cave.id}: an enterable needs a label and an origin`);
    assert.ok(Array.isArray(e.doors), `${e.cave.id}: Interiors reads e.doors`);
    assert.ok(e.collectibleSpots.length >= 2, `${e.cave.id}: no collectible spots`);
    assert.ok(e.cave.mouths.length >= 2, `${e.cave.id}: fewer than two mouths`);
    for (const m of e.cave.mouths) {
      assert.ok(Number.isFinite(m.position.x) && Number.isFinite(m.position.y),
        `${e.cave.id}: mouth "${m.id}" has no position`);
    }
  }
  floorCheck('cave mouths published for the approach gate', 4,
    caveEnt.reduce((a, e) => a + e.cave.mouths.length, 0), 4);
});

/* ================================================================== */
/* 7. What the next stage consumes                                     */
/* ================================================================== */

/**
 * FLOOR. Every publication the brief names, per region, proved to resolve.
 *
 * Not "the field exists" - every published coordinate has to stand on a deck
 * that exists and be on the network the player is on. That is the whole class
 * of defect the medieval expansion shipped four times.
 */
test('FLOOR: the ring publishes anchors, venues and trials that resolve', async () => {
  const { world, idx, graph, uf, main } = await ring();

  /* ---- relic anchors --------------------------------------------------- */
  let off = 0;
  const ringRoofs = world._roofs.filter((r) => r.region);
  for (const r of ringRoofs) {
    const b = boxAt(idx, (r.anchor ?? r).x, (r.anchor ?? r).z, (r.anchor ?? r).y);
    if (!b) off++;
  }
  console.log(`\n    ring anchors: ${ringRoofs.length} decks + ${world._towers.filter((t) => t.region).length} towers, ${off} that no collider owns`);
  assert.equal(off, 0, 'a published ring anchor is not the top of a real collider');
  assert.ok(ringRoofs.every((r) => r.anchor), 'a ring deck stopped publishing its anchor');

  /* ---- stair treads ---------------------------------------------------- */
  const steps = world._steps ?? [];
  let stepOff = 0;
  for (const t of steps) if (!boxAt(idx, t.x, t.z, t.y)) stepOff++;
  console.log(`    stair treads published: ${steps.length}, ${stepOff} that no collider owns`);
  assert.ok(steps.length >= 200, `only ${steps.length} treads published - a flight has gone missing`);
  assert.equal(stepOff, 0, 'a published tread is not the top of a real collider');

  /* ---- the ring's trials ------------------------------------------------ */
  const ringVenues = world.minigameVenues.filter((v) => v.id.startsWith('citadel_undercliff')
    || v.id.startsWith('citadel_aqueduct') || v.id.startsWith('citadel_deepworks'));
  console.log(`    ring trials: ${ringVenues.map((v) => v.id).join(', ')}`);
  assert.equal(ringVenues.length, 3, 'the ring publishes three trials');
  for (const v of ringVenues) {
    const cps = v.config.checkpoints;
    assert.ok(cps.length >= 3, `${v.id}: a route needs checkpoints`);
    assert.equal(v.requires, 'parkour', `${v.id}: a parkour contest needs the parkour rule`);
    assert.ok(v.config.par === undefined, `${v.id}: par times must come from measured route times`);
    assert.ok(v.config.ringRadius < 3, `${v.id}: the marker radius must be authored, not inherited`);
    for (const c of cps) {
      const d = idx.deckAt(c.x, c.z, { below: c.y + 1.2 });
      assert.ok(d && Math.abs(d.y - c.y) <= 0.2,
        `${v.id}: a checkpoint at (${c.x.toFixed(1)}, ${c.y.toFixed(2)}, ${c.z.toFixed(1)}) is not on its own deck`);
      const id = graph.nodeFor(c.x, c.z, c.y + 0.5);
      assert.ok(id !== undefined && uf.find(id) === main,
        `${v.id}: a checkpoint is not on the network the player is on`);
    }
    /* NO ZERO-LENGTH LEG, and this one shipped.
     *
     * `citadel_aqueduct_run` walked its decks backwards in steps of 5 from
     * index 25, which lands ON index 0, and then pushed index 0 again:
     * checkpoints 5 and 6 were both (-16.626, 21.500, -135.500), a 0.00 m leg
     * against 6.9-71.6 m everywhere else. `RaceRings.build` draws two
     * coincident tori at the finish, `RooftopTrial.readRoute` computes both
     * tangents as (0,0) and falls back to facing -Z on a route running +Z, and
     * `_advance`'s `clock <= par.gold * passed / (route.length - 1)` divides by
     * 6 for a five-leg route so the on-pace flag is wrong for the whole run.
     * `cps.length >= 3` cannot see any of it; a floor on the shortest leg can. */
    let shortest = Infinity;
    for (let i = 1; i < cps.length; i++) {
      shortest = Math.min(shortest, Math.hypot(
        cps[i].x - cps[i - 1].x, cps[i].y - cps[i - 1].y, cps[i].z - cps[i - 1].z));
    }
    assert.ok(shortest >= 3.0,
      `${v.id}: its shortest leg is ${shortest.toFixed(2)} m - two checkpoints have collapsed onto `
      + 'one deck and the ring, the tangent and the pace divisor are all wrong');
    /* The disc has to hold the WHOLE route: `MinigameManager` aborts nine
     * seconds after the player leaves it, and none of these runs is that short. */
    let worst = 0;
    for (const c of cps) worst = Math.max(worst, Math.hypot(c.x - v.centre.x, c.z - v.centre.z));
    assert.ok(v.radius >= worst, `${v.id}: the venue disc (${v.radius.toFixed(1)} m) does not cover its own route (${worst.toFixed(1)} m)`);
  }

  /* ---- haystacks under the high lines ----------------------------------- */
  const ringHay = world.haystacks.filter((h) => h.region);
  let caught = 0;
  for (const h of ringHay) {
    const d = idx.deckAt(h.x, h.z);
    if (d && h.y - d.y >= -1.5 && h.y - d.y <= 3.5) caught++;
  }
  console.log(`    ring haystacks: ${ringHay.length}, ${caught} standing on a surface that catches`);
  floorCheck('ring haystacks that catch a falling body', ringHay.length, caught, ringHay.length);
  assert.equal(caught, ringHay.length, 'a ring haystack is not standing on its own surface');
  assert.ok(ringHay.length >= 18, `only ${ringHay.length} haystacks in the ring`);
});

/* ================================================================== */
/* 8. The floorplan the player navigates by                            */
/* ================================================================== */

/**
 * FLOOR. Every region is on the minimap, and every tower has a dot.
 *
 * ── The defect ────────────────────────────────────────────────────────────
 * `minimapShapes` was published from `_fillSpawns`, which runs BEFORE
 * `_buildRegions`. Measured on the built world: 19 shapes, furthest extent
 * 152.0 m, ZERO past r = 200 on a `bounds` of +-450 - the baked plan covered
 * 9.0% of the playfield and the whole outer ring was blank canvas - and the
 * tower loop emitted 13 dots for the 18 towers the world ends up with, missing
 * precisely the five ring landmarks.
 *
 * Nothing caught it. `minimapShapes` was referenced by no test in
 * `scripts/tests/` at all, and `Minimap._bakePlan` reads it through an
 * `Array.isArray` guard, so an empty ring rasterises as background.
 *
 * ── The floor, and its ablation ───────────────────────────────────────────
 * Coverage is asserted against `contentBounds`, which is the union of the
 * protected core and every region's own measured AABB - i.e. against the same
 * box `Relics` and `Caches` budget from, so the plan and the content cannot
 * drift apart. Ceiling: publishing from `_fillSpawns` again, which covers
 * 152.0 m of a 436.3 m box and draws 13 of 18 towers.
 */
test('FLOOR: the minimap floorplan covers the content, and every tower is on it', async () => {
  const { world } = await ring();
  const shapes = world.minimapShapes ?? [];
  assert.ok(shapes.length > 0, 'the world publishes no minimap shapes at all');

  /* The union of what is drawn, in world metres. */
  const u = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
  for (const s of shapes) {
    let x0; let x1; let z0; let z1;
    if (s.kind === 'circle') {
      x0 = s.x - s.r; x1 = s.x + s.r; z0 = s.z - s.r; z1 = s.z + s.r;
    } else if (s.kind === 'rect') {
      x0 = s.x - s.w * 0.5; x1 = s.x + s.w * 0.5; z0 = s.z - s.d * 0.5; z1 = s.z + s.d * 0.5;
    } else continue;
    u.x0 = Math.min(u.x0, x0); u.x1 = Math.max(u.x1, x1);
    u.z0 = Math.min(u.z0, z0); u.z1 = Math.max(u.z1, z1);
  }
  const c = world.contentBounds;
  console.log(`\n    minimap shapes ${shapes.length}, union x [${u.x0.toFixed(0)}, ${u.x1.toFixed(0)}]`
    + ` z [${u.z0.toFixed(0)}, ${u.z1.toFixed(0)}]`);
  console.log(`    contentBounds  x [${c.min.x.toFixed(0)}, ${c.max.x.toFixed(0)}]`
    + ` z [${c.min.z.toFixed(0)}, ${c.max.z.toFixed(0)}]`);
  const slack = 1.0;
  assert.ok(u.x0 <= c.min.x + slack && u.x1 >= c.max.x - slack
    && u.z0 <= c.min.z + slack && u.z1 >= c.max.z - slack,
    `the baked floorplan covers x [${u.x0.toFixed(0)}, ${u.x1.toFixed(0)}] z [${u.z0.toFixed(0)}, `
    + `${u.z1.toFixed(0)}] of a content box x [${c.min.x.toFixed(0)}, ${c.max.x.toFixed(0)}] `
    + `z [${c.min.z.toFixed(0)}, ${c.max.z.toFixed(0)}] - part of the world is blank canvas`);

  /* Every region individually, not just the union: one region left out is
   * invisible to a bounding box that the other five already fill. */
  for (const r of world.regions ?? []) {
    const a = r.aabb;
    const hit = shapes.some((s) => s.kind === 'rect'
      && s.x - s.w * 0.5 <= a.min.x + slack && s.x + s.w * 0.5 >= a.max.x - slack
      && s.z - s.d * 0.5 <= a.min.z + slack && s.z + s.d * 0.5 >= a.max.z - slack);
    assert.ok(hit, `region "${r.id}" has no outline on the minimap`);
  }

  /* And the dots. Every tower the world publishes, ring landmarks included. */
  let dotted = 0;
  for (const t of world._towers) {
    if (shapes.some((s) => s.kind === 'circle' && Math.abs(s.x - t.x) < 0.01
      && Math.abs(s.z - t.z) < 0.01)) dotted++;
  }
  floorCheck('towers with a minimap dot', world._towers.length, dotted, world._towers.length,
    '(publishing from _fillSpawns again gives 13)');
  assert.equal(dotted, world._towers.length,
    `${dotted} of ${world._towers.length} towers have a dot - the loop is running before the ring again`);
});
