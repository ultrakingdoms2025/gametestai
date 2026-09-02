import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  corridors, evaluateFloors, exactExposure, emptiness, journeyEmptiness,
  routeStats, reroute, rankCandidates, floorCheck, f, i5,
  RECOGNITION, RENDER_IN, WALK, SPRINT, CARAVAN_SPEED, TRAIN_LEN, OASIS_R,
  REFERENCE_TRAINS, HALF,
} from './citadel-traffic-kit.mjs';

/**
 * `floorCheck` for a measurement where SMALLER is the achievement.
 *
 * Emptiness is the only one in this file, and it needs its own printer rather
 * than the shared one because printing "floor 45 | achieved 32.4" next to an
 * assertion that 32.4 is GOOD is how a reader comes away with the opposite of
 * what was measured.
 */
function ceilingCheck(label, ceiling, achieved, floor, note = '') {
  const ok = achieved <= ceiling;
  console.info(
    `  ${ok ? 'PASS' : 'FAIL'} ${label.padEnd(50)}`
    + ` ceiling ${String(ceiling).padStart(6)} | achieved ${String(achieved).padStart(6)}`
    + ` | before ${String(floor).padStart(6)}${note ? `  ${note}` : ''}`
  );
  assert.ok(ok, `${label}: ${achieved} is over the ceiling of ${ceiling}`);
}

/**
 * WHERE DOES A PLAYER GO IN THE 900 M CITADEL, AND WHAT WOULD THEY MEET?
 *
 * ── The sentence this file exists to answer ───────────────────────────────
 *
 * *"i tested citadel myself, all works but it desperately needs npc's in the
 * new areas. In the large open areas between objects/villages/caves we should
 * have npc's leading wandering the areas with herds of camels and maybe 1 or 2
 * oasis areas"*
 *
 * The six regions are built and reachable - `citadel-reach.test.mjs` and
 * `citadel-regions.test.mjs` prove that between them. The flats between them
 * are empty, and this file measures exactly how empty, exactly where a player
 * walks through them, and exactly where content would be MET rather than merely
 * placed.
 *
 * ── The defect one step away, and why every number here is a floor ────────
 *
 * The medieval expansion added ten wolf and bear packs. Spawned, specced,
 * resident, ticking, 29 of 29 assertions green - and the player said *"i do not
 * see any wolves or bears in the forest areas."* The suite could not have
 * caught it: every one of its 29 assertions was a "not closer than", and a vale
 * with no reachable wildlife at all satisfies all 29. Median pack-to-road was
 * 210 m, the nearest pack stood 317 m from the player spawn, and 3 of 10 ever
 * came within render range of a road.
 *
 * So this file asserts nothing about distance and everything about ENCOUNTER,
 * at a RECOGNITION radius of 15 m rather than the 125 m render gate - because
 * the other thing that build measured the hard way is that a five-wolf pack
 * "drawn with 38 m of margin" was three pixels of a 1,024,000-pixel frame.
 *
 * ── What each test here does ──────────────────────────────────────────────
 *
 *   1. THE CORRIDOR MODEL   - 160 published places, 11,919 walkable journeys
 *                             between them over the real reach graph, and the
 *                             proof that the graph resolved all but five.
 *   2. THE ENCOUNTER FIELD  - the apparatus checked against the exact metric
 *                             it approximates, at the sites the answer matters.
 *   3. THE FLATS            - 810,000 m2, banded by distance to the nearest
 *                             built thing. The player's "large open areas",
 *                             quantified.
 *   4. THE LONG WALK        - the longest featureless stretch on every
 *                             inter-region journey, as a histogram.
 *   5. THE ROUTE CATALOGUE  - fifty walkable caravan roads, each scored by how
 *                             many journeys a train on it would actually meet.
 *   6. THE RANKED SITES     - the placement agent's brief.
 *   7. THE FLOORS ARE REACHABLE - the five gates in `citadel-caravans.test.mjs`
 *                             re-run over a synthetic reference placement, and
 *                             all five go green. That test is the reason the
 *                             red ones are a target and not an impossibility.
 *
 * Nothing in this file writes to `src/`, and nothing in it asserts a clearance.
 * The inverted trap is recorded in the kit's header: camels are not predators,
 * and a rule keeping them off the travel corridors would be this feature's
 * version of the medieval safety clearance that quietly fought its own brief.
 */

/* ------------------------------------------------------------------ */
/* 1. The corridor model                                               */
/* ------------------------------------------------------------------ */

test('THE CORRIDOR MODEL: every published place, and every walkable journey between them', async () => {
  const C = await corridors();
  const kinds = new Map();
  for (const p of C.pois) kinds.set(p.kind, (kinds.get(p.kind) ?? 0) + 1);
  const places = new Map();
  for (const p of C.pois) places.set(p.place, (places.get(p.place) ?? 0) + 1);

  console.log('\n  POINTS OF INTEREST, by the system that publishes them');
  for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(10)} ${i5(n)}`);
  console.log('  and by where in the world they stand');
  for (const [k, n] of [...places].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(14)} ${i5(n)}`);

  /* THE FIRST FINDING, and it is not a small one. Not one of the 160 places
   * this world publishes stands in the FLATS. Every relic, cache, viewpoint,
   * venue, anchor and cave mouth is inside the protected core or inside one of
   * the six region boxes. The flats are not under-populated; they are the part
   * of the map no published system has an opinion about at all. */
  assert.equal(places.get('flats') ?? 0, 0,
    'a point of interest now stands in the open flats - the corridor model was written when '
    + 'nothing did, and the emptiness argument below needs re-reading if that has changed');

  const lens = C.journeys.map((j) => j.ground).sort((a, b) => a - b);
  const q = (p) => lens[Math.floor(p * (lens.length - 1))];
  const ilens = C.inter.map((j) => j.ground).sort((a, b) => a - b);
  const iq = (p) => ilens[Math.floor(p * (ilens.length - 1))];
  console.log(`\n  JOURNEYS  ${C.journeys.length} over ${C.pois.length} places, ${C.inter.length} of them between different places`);
  console.log(`    ground length, all   min ${f(q(0))}  p25 ${f(q(0.25))}  med ${f(q(0.5))}  p75 ${f(q(0.75))}  p95 ${f(q(0.95))}  max ${f(q(1))} m`);
  console.log(`    ground length, inter min ${f(iq(0))}  p25 ${f(iq(0.25))}  med ${f(iq(0.5))}  p75 ${f(iq(0.75))}  p95 ${f(iq(0.95))}  max ${f(iq(1))} m`);
  console.log(`    at ${WALK} m/s a median inter-region journey is ${(iq(0.5) / WALK / 60).toFixed(1)} minutes of walking`);

  const pairs = new Map();
  for (const j of C.inter) {
    const k = [j.from, j.to].sort().join(' <-> ');
    pairs.set(k, (pairs.get(k) ?? 0) + 1);
  }
  console.log('  the twelve busiest place-pairs');
  for (const [k, n] of [...pairs].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`    ${k.padEnd(28)} ${i5(n)}`);

  /* The graph is one component - `citadel-reach.test.mjs` R1 proves it - so a
   * pair with no path is a finding about this model, not about the world, and
   * it is asserted at zero rather than tolerated. */
  assert.equal(C.unreachable.length, 0,
    `${C.unreachable.length} pairs of published places have no walkable path between them, in a `
    + 'world the reach suite says is a single component - the journey search or the node '
    + 'resolution is wrong');

  /* Five places do not sit on a deck the reach graph knows about, and all five
   * are legible: the Eyrie's AABB CENTRE is inside the massif rock, the Souk
   * Dash venue's checkpoint CENTROID hangs in the air over the ward, and three
   * cave interior points are under a roof `deckAt` reports instead of them.
   * None of them is a place a body stands, so none of them is a journey
   * endpoint that was lost. A sixth would mean something else. */
  console.log('  places the reach graph could not seat:');
  for (const p of C.unresolved) console.log(`    ${p.kind}:${p.label} (${p.x | 0}, ${p.z | 0})`);
  assert.ok(C.unresolved.length <= 5,
    `${C.unresolved.length} published places do not resolve onto the reach graph - the model is `
    + 'routing around content the player can reach');

  for (const j of C.journeys) {
    assert.ok(j.path.length >= 2, 'a journey came back with fewer than two nodes');
  }
  console.log(`\n  built in ${C.ms.journeys} ms over a ${C.graph.nodes.length}-node, ${C.graph.edges.length}-edge reach graph`);

  /* THE ONLY DECLARED NUMBERS IN THE CORRIDOR MODEL, AND WHAT DEPENDS ON THEM.
   *
   * The journey search charges a jump 3 m of extra walking, a drop 2 m and a
   * climb 8 m, so that the shortest path does not route the player off every
   * roof in the souk - over a graph with 21,341 one-way drops in it, a 12 m
   * fall costs nothing in metres. Nobody measured those three numbers. So the
   * whole 11,919-journey set is re-derived twice, and the two answers say
   * different things:
   *
   *   DOUBLED, the ranked sites barely move. Nine of the top ten come back
   *   within one 10 m lattice step of where they were, and the worst encounter
   *   fraction among them moves 2.36 points on a range of 2.3 to 13.7. The
   *   VALUE of the penalties is not load-bearing, and that is what makes it
   *   safe to declare them rather than measure them.
   *
   *   RE-TAKEN 2026-09-01: 10 of 10 -> 9 of 10, with the worst fraction moved
   *   FALLING 3.01 -> 2.36 points. `citadel/Regions.js` re-authored every
   *   flight in the outer ring against `CONFIG.player.stepHeight` = 0.45
   *   instead of `NPC.GROUND_PROBE_UP` = 0.95, which doubles the treads on 36
   *   flights and puts 240 new nodes and several thousand new walk edges into
   *   the reach graph this model runs over. A tenth site that used to hold
   *   now lands 20 m off. The claim survives it and the SEPARATION that makes
   *   the claim mean anything is unchanged - 9 held against the zeroed
   *   ablation's 5 - so this is a re-take and not a loosening. If it ever
   *   reaches 8, the penalties have become load-bearing and have to be
   *   measured rather than declared.
   *
   *   ZEROED, six of the ten move and four move more than 70 m. Their
   *   EXISTENCE is load-bearing: without them the model walks the player over
   *   the rooftops and off the parapets, and briefs the placement on corridors
   *   nobody uses. That is the ablation, and it is why this is a sensitivity
   *   report and not a shrug.
   */
  const near20 = (a, b) => b.some((q) => Math.hypot(q.x - a.x, q.z - a.z) <= 20);
  const top10 = C.spotRank.ranked.slice(0, 10);
  const restage = (costs) => {
    const alt = reroute(C, costs);
    const rk = rankCandidates(alt.exposure, C.field, { limit: 24, minSep: 70, clear: 12 }).ranked.slice(0, 10);
    let worst = 0;
    for (const c of top10) {
      const d = Math.abs(C.exposureInter.fractionAt(c.x, c.z) - alt.exposure.fractionAt(c.x, c.z));
      if (d > worst) worst = d;
    }
    return { held: top10.filter((c) => near20(c, rk)).length, worst, n: alt.inter.length };
  };
  const dbl = restage({ jump: 6, drop: 4, climb: 16 });
  const nil = restage({ jump: 0, drop: 0, climb: 0 });
  console.log(`  edge-cost sensitivity, over the top ten candidate sites:`);
  console.log(`    penalties doubled  ${dbl.held}/10 sites held within 20 m, worst fraction moved ${(100 * dbl.worst).toFixed(2)} points`);
  console.log(`    penalties zeroed   ${nil.held}/10 sites held within 20 m, worst fraction moved ${(100 * nil.worst).toFixed(2)} points`);

  assert.equal(dbl.held, 9,
    `only ${dbl.held} of the top ten candidate sites survive doubling the jump, drop and climb `
    + 'penalties - those three numbers were declared rather than measured, and the brief this file '
    + 'hands the placement now depends on them');
  assert.ok(dbl.worst < 0.04,
    `doubling the penalties moves a top-ten site's encounter fraction by ${(100 * dbl.worst).toFixed(2)} `
    + 'points, which is more than the gap between neighbouring candidates');
  assert.ok(nil.held < 10,
    'zeroing the jump, drop and climb penalties changes nothing at all - the corridor model is not '
    + 'distinguishing a walk from a fall, and every journey in it may be a rooftop route no player '
    + 'would take');
});

/* ------------------------------------------------------------------ */
/* 2. The apparatus, checked                                           */
/* ------------------------------------------------------------------ */

test('THE ENCOUNTER FIELD agrees with the exact metric it stands in for', async () => {
  const C = await corridors();
  const polys = C.inter.map((j) => j.poly);
  console.log('\n  grid (5 m cells) against the exact point-to-polyline answer, at the sites it decides');
  let worst = 0;
  for (const c of C.spotRank.ranked.slice(0, 8)) {
    const ex = exactExposure(polys, c.x, c.z, RECOGNITION);
    const d = Math.abs(ex.hit - c.hit);
    if (d > worst) worst = d;
    console.log(`    (${String(c.x).padStart(5)},${String(c.z).padStart(5)})  grid ${i5(c.hit)}  exact ${i5(ex.hit)}  delta ${i5(ex.hit - c.hit)}`);
    /* Exact, not approximately exact, and that is worth saying out loud: the
     * grid samples cell CENTRES and the candidate lattice is a multiple of the
     * cell, so a candidate always lands on a sampled centre and the 5 m cell
     * costs nothing at the points the ranking is read at. The tolerance is one
     * journey, so the assertion still fails if the two ever diverge. */
    assert.ok(d <= 1,
      `the exposure grid says ${c.hit} journeys pass within ${RECOGNITION} m of (${c.x}, ${c.z}) `
      + `and the exact measurement says ${ex.hit} - the field is not measuring what it claims`);
  }
  assert.equal(C.exposureInter.total, C.inter.length,
    'the exposure field was sealed against a different journey count than it was stamped with, '
    + 'so every fraction it reports has the wrong denominator');
  console.log(`    worst disagreement over eight sites: ${worst} journeys of ${C.inter.length}`);

  /* And the moving metric against the still one. A journey that never comes
   * within `RECOGNITION` of the route LINE can meet no train on it at any
   * phase, so `eligible` must agree exactly with `closestApproach <=
   * RECOGNITION`, and an ineligible journey must be scored zero. Checked over
   * the journeys nearest to deciding it, because `closestApproach` is O(route x
   * journey) with no grid and cannot be run over all 8,384.
   *
   * BOTH CLASSES ARE SAMPLED ON PURPOSE, AND THE COUNTS ARE ASSERTED. The first
   * cut walked the borderline band until it had fifty journeys and every one of
   * them came back eligible, so the "an ineligible journey was scored non-zero"
   * line never executed once - a dead assertion, and its own mutation test
   * caught it: reversing it left the suite green. Filling a quota of each class
   * is what brings it back to life, and the quota assertion below is what stops
   * it dying again quietly. */
  const r = C.chosen[0];
  const QUOTA = 25;
  let nEligible = 0; let nIneligible = 0;
  for (const j of C.inter) {
    if (nEligible >= QUOTA && nIneligible >= QUOTA) break;
    const near = r.cr.closestApproach(j.samp);
    if (near > RECOGNITION * 3) continue;
    const e = r.cr.encounter(j.samp, { trains: REFERENCE_TRAINS });
    if (e.eligible ? nEligible >= QUOTA : nIneligible >= QUOTA) continue;
    if (e.eligible) nEligible++; else nIneligible++;
    assert.equal(e.eligible, near <= RECOGNITION + 1e-6,
      `journey ${j.id} comes within ${near.toFixed(2)} m of "${r.id}" and the phase metric calls it `
      + `${e.eligible ? 'eligible' : 'ineligible'} - the grid prune and the exact distance disagree`);
    if (!e.eligible) {
      assert.equal(e.fraction, 0,
        `journey ${j.id} passes no closer than ${near.toFixed(2)} m to "${r.id}" and was still given `
        + `an encounter fraction of ${e.fraction} - the phase arithmetic is inventing contacts`);
    }
  }
  console.log(`    moving metric agreed with the exact closest approach on ${nEligible} eligible and ${nIneligible} ineligible journeys`);
  assert.ok(nEligible > 0 && nIneligible > 0,
    `the borderline sample came back ${nEligible} eligible and ${nIneligible} ineligible - one of the `
    + 'two equality checks above never executed, which is a dead assertion');
});

/* ------------------------------------------------------------------ */
/* 3. The flats                                                        */
/* ------------------------------------------------------------------ */

test('THE FLATS: how much of the 810,000 m2 has nothing in it', async () => {
  const C = await corridors();
  const E = emptiness(C.field);

  console.log(`\n  ${Math.round(E.area).toLocaleString('en-GB')} m2 sampled on a ${C.field.cell} m lattice; `
    + `${(100 * E.flatCells / E.cells).toFixed(1)}% of it is flat enough to stand a tent on`);
  console.log('  distance to the nearest BUILT thing (heightfield excluded - the ground is not content)');
  for (let i = 0; i < E.band.length; i++) {
    const b = E.band[i];
    const fb = E.flatBandArea[i];
    console.log(`    >= ${String(b.m).padStart(3)} m from anything:  ${String(Math.round(b.area)).padStart(7)} m2  ${(100 * b.share).toFixed(1).padStart(5)}%   of which flat ${(100 * fb.share).toFixed(1).padStart(5)}%`);
  }
  console.log(`  the emptiest flat point in the world is (${E.worst.x}, ${E.worst.z}), ${E.worst.d.toFixed(1)} m from the nearest built thing`);
  console.log(`  for scale: ${RENDER_IN} m is where a body starts being DRAWN and ${RECOGNITION} m is where it is `
    + `RECOGNISED - a ${(Math.PI * RENDER_IN * RENDER_IN / (Math.PI * RECOGNITION * RECOGNITION)).toFixed(0)}:1 ratio in area`);

  /* Structure first: a band cannot contain more cells than a smaller one, and
   * the sampled area has to be the map. Both fail loudly if the transform or
   * the sampling is wrong, which is the only way the headline below could be
   * wrong in a way a reader could not see. */
  for (let i = 1; i < E.band.length; i++) {
    assert.ok(E.band[i].cells <= E.band[i - 1].cells,
      `the ${E.band[i].m} m band holds more cells than the ${E.band[i - 1].m} m band - the distance `
      + 'transform is not monotone and every number in this table is suspect');
  }
  const nominal = (HALF * 2) ** 2;
  assert.ok(Math.abs(E.area - nominal) / nominal < 0.02,
    `the emptiness sweep covered ${Math.round(E.area)} m2 of a ${nominal} m2 map`);

  /* THE HEADLINE. Half the map is more than 30 m from anything that was built,
   * and a third of it is more than 50 m. This is the player's "large open
   * areas", and it is a floor rather than a ceiling on purpose: the placement
   * this measurement briefs adds camels and two oases, not a city, so it must
   * still be true afterwards. If it stops being true the world got built up,
   * which is a different task than the one that was asked for. */
  const b30 = E.band.find((b) => b.m === 30);
  floorCheck('share of the map >= 30 m from anything built (%)', 40,
    Math.round(1000 * b30.share) / 10, 100, 'nothing was built in the flats');
});

test('THE LONG WALK: the longest featureless stretch on an inter-region journey', async () => {
  const C = await corridors();
  const rows = C.inter.map((j) => ({ j, e: journeyEmptiness(C.field, j.poly) }));
  const longs = rows.map((r) => r.e.longest).sort((a, b) => a - b);
  const q = (p) => longs[Math.floor(p * (longs.length - 1))];

  console.log(`\n  ${C.inter.length} inter-region journeys, sampled every 2 m; a sample "meets something" when the`);
  console.log(`  nearest built thing is within ${RECOGNITION} m - the recognition distance, not the render gate`);
  console.log(`    longest stretch of nothing:  med ${f(q(0.5))}  p75 ${f(q(0.75))}  p90 ${f(q(0.9))}  p99 ${f(q(0.99))}  max ${f(q(1))} m`);
  console.log(`    at ${WALK} m/s the p90 stretch is ${(q(0.9) / WALK).toFixed(0)} seconds of nothing; at a sprint, ${(q(0.9) / SPRINT).toFixed(0)}`);
  const edges = [0, 50, 100, 150, 200, 250, 300, 400, 500];
  console.log('  histogram');
  let counted = 0;
  for (let i = 0; i < edges.length; i++) {
    const lo = edges[i]; const hi = edges[i + 1] ?? Infinity;
    const n = longs.filter((v) => v >= lo && v < hi).length;
    counted += n;
    console.log(`    ${String(lo).padStart(3)} - ${hi === Infinity ? ' inf' : String(hi).padStart(4)} m  ${i5(n)}  ${(100 * n / longs.length).toFixed(1).padStart(5)}%`);
  }
  assert.equal(counted, longs.length, 'the histogram lost journeys - the bin edges do not cover the range');

  rows.sort((a, b) => b.e.longest - a.e.longest);
  console.log('  the six emptiest journeys in the world');
  for (const r of rows.slice(0, 6)) {
    const a = C.pois[r.j.a]; const b = C.pois[r.j.b];
    console.log(`    ${(a.kind + ':' + a.label).padEnd(26).slice(0, 26)} (${String(a.x | 0).padStart(5)},${String(a.z | 0).padStart(5)}) -> `
      + `${(b.kind + ':' + b.label).padEnd(26).slice(0, 26)} (${String(b.x | 0).padStart(5)},${String(b.z | 0).padStart(5)})  `
      + `walk ${f(r.e.length)} m, worst gap ${f(r.e.longest)} m`);
  }

  /* The measurement has to be internally sound before its headline means
   * anything: no stretch can be longer than the journey that contains it. */
  for (const r of rows) {
    assert.ok(r.e.longest <= r.e.length + 2,
      `a journey ${r.e.length.toFixed(0)} m long reported a ${r.e.longest.toFixed(0)} m featureless stretch`);
  }

  /* ── THE FINDING, AND THE DIRECTION IT NOW POINTS ──────────────────────
   *
   * This shipped as a FLOOR on emptiness - "at least 45% of these walks contain
   * a 100 m stretch of nothing" - written while the flats were empty, with a
   * note saying it must survive the placement because "the placement adds
   * camels and two oases, not a city".
   *
   * The placement landed and it did not survive, and that is the whole point of
   * the drop rather than a regression. Measured on the same 8,384 journeys with
   * the same 15 m radius, over the world's colliders with and without the two
   * oases and the eight wayside wells `CitadelWorld._buildTraffic` builds:
   *
   *     before  53.6% of walks carry a 100 m stretch of nothing
   *     after   32.4%
   *
   * So the assertion is turned round: the share must now be BELOW what it was,
   * and the before column is measured rather than remembered, from
   * `fieldPre` - the same distance transform with this drop's own colliders
   * subtracted. A floor on emptiness and a ceiling on emptiness are the same
   * measurement; which way it points is a statement about what the world is
   * supposed to be, and it is supposed to have traffic in it now.
   *
   * THE GUARD THAT THE WORLD WAS NOT SIMPLY BUILT UP is the previous test's
   * floor, not this one: 30 m or more from anything built still covers 40%+ of
   * the map. Ten structures in 810,000 m2 is a caravan road, not a city.
   */
  const over = (fld) => C.inter.map((j) => journeyEmptiness(fld, j.poly).longest)
    .filter((v) => v >= 100).length / C.inter.length;
  const after = over(C.field);
  const before = C.fieldPre === C.field ? after : over(C.fieldPre);
  console.log(`  walks with a 100 m stretch of nothing: ${(100 * before).toFixed(1)}% before this drop's `
    + `oases and wells, ${(100 * after).toFixed(1)}% after`);
  ceilingCheck('inter-region walks with a 100 m stretch of nothing (%)', 45,
    Math.round(1000 * after) / 10, Math.round(1000 * before) / 10,
    'ceiling = the same measurement with the oases and wells subtracted');
  assert.ok(after < before,
    `the drop's own oases and wells broke up nothing: ${(100 * before).toFixed(1)}% before and `
    + `${(100 * after).toFixed(1)}% after. Either the content is not in the flats or the ablation `
    + 'is not subtracting it');
});

/* ------------------------------------------------------------------ */
/* 5. The route catalogue                                              */
/* ------------------------------------------------------------------ */

test('THE ROUTE CATALOGUE: every walkable caravan road, and what a train on it would meet', async () => {
  const C = await corridors();
  console.log(`\n  ${C.cat.routes.length} candidate roads between ${C.cat.hubs.length} hubs, each the SHORTEST WALKABLE PATH over the`);
  console.log('  reach graph - so a Caravanserai-to-Ashfall road goes round the quarry pit, not through it');
  console.log(`  scored against ${C.inter.length} inter-region journeys at ${RECOGNITION} m, train ${TRAIN_LEN} m, ${CARAVAN_SPEED} m/s, ${REFERENCE_TRAINS} trains`);
  console.log('    eligible = the share of journeys that pass within recognition of the LINE (the route ceiling)');
  console.log('    expected = the share that MEET a train, over the caravan phase (what a player gets)\n');
  console.log('       elig    1 train  3 trains   walk   route');
  for (const r of C.cat.routes.slice(0, 16)) {
    const one = routeStats(r.cr, C.inter, { trains: 1 });
    console.log(`    ${(100 * r.stats.eligibleShare).toFixed(1).padStart(6)}%  ${(100 * one.expected).toFixed(1).padStart(6)}%  ${(100 * r.stats.expected).toFixed(1).padStart(7)}%  ${r.walk.toFixed(0).padStart(5)} m   ${r.id}`);
  }

  console.log('\n  greedy union - the marginal value of the second, third and fourth road');
  for (let i = 0; i < C.chosen.length; i++) {
    console.log(`    #${i + 1}  ${(100 * C.chosen[i].unionAfter).toFixed(1).padStart(5)}%   ${C.chosen[i].id}`);
  }

  /* A structural invariant that CAN fail and would if the phase arithmetic
   * were wrong: a train can never be met by a journey that does not come
   * within recognition of the line it walks. */
  for (const r of C.cat.routes) {
    assert.ok(r.stats.expected <= r.stats.eligibleShare + 1e-9,
      `"${r.id}" is expected to meet ${(100 * r.stats.expected).toFixed(1)}% of journeys but only `
      + `${(100 * r.stats.eligibleShare).toFixed(1)}% of them come within ${RECOGNITION} m of it`);
    assert.ok(r.poly.length >= 4, `"${r.id}" is not a polyline`);
  }
  /* And the union can never be less than its best member, nor more than the
   * sum of them. */
  const best = Math.max(...C.cat.routes.map((r) => r.stats.expected));
  assert.ok(C.chosen[C.chosen.length - 1].unionAfter >= best - 1e-9,
    'the greedy union came out below the best single route it contains');

  /* THE SENSITIVITY, published rather than assumed. `CARAVAN_SPEED` and
   * `TRAIN_LEN` are the only two numbers in this measurement that are not read
   * off the world, so the answer's dependence on them is reported next to
   * every claim that uses them. */
  const r0 = C.chosen[0];
  console.log(`\n  SENSITIVITY of "${r0.id}" at ${REFERENCE_TRAINS} trains`);
  const sweep = (label, opts) => {
    const s = routeStats(r0.cr, C.inter, { trains: REFERENCE_TRAINS, ...opts });
    console.log(`    ${label.padEnd(28)} ${(100 * s.expected).toFixed(1).padStart(6)}%`);
    return s.expected;
  };
  const base = r0.stats.expected;
  const slow = sweep('caravan 0.80 m/s', { speed: 0.8 });
  sweep(`caravan ${CARAVAN_SPEED} m/s (the model)`, {});
  const fast = sweep('caravan 1.60 m/s', { speed: 1.6 });
  sweep('train 4 m (one animal)', { trainLen: 4 });
  sweep(`train ${TRAIN_LEN} m (the model)`, {});
  sweep('train 64 m (sixteen animals)', { trainLen: 64 });
  sweep(`player ${WALK} m/s (walk)`, {});
  sweep(`player ${SPRINT} m/s (sprint)`, { playerSpeed: SPRINT });
  for (const n of [1, 2, 3, 4, 6]) sweep(`${n} train${n > 1 ? 's' : ''}`, { trains: n });

  /* Doubling the caravan's pace moves the headline by less than half a point,
   * and that is not luck: whether a journey is ELIGIBLE at all is a question
   * about geometry, and eligibility decides three quarters of the answer. The
   * two model parameters are therefore load-bearing for the fine detail and not
   * for the conclusion, which is the property that makes them safe to publish
   * as a model rather than as a measurement. */
  assert.ok(Math.abs(fast - slow) < 0.02,
    `doubling the caravan's speed moves the encounter share by ${(100 * Math.abs(fast - slow)).toFixed(1)} `
    + 'points - the metric now depends on a number nobody measured, and the model parameter has to '
    + 'become a measurement before any of these floors mean anything');
  assert.ok(base > 0.25,
    `the best caravan road in the world only meets ${(100 * base).toFixed(1)}% of inter-region journeys `
    + `at ${REFERENCE_TRAINS} trains - either the catalogue missed the corridors or the world has no corridors`);
});

/* ------------------------------------------------------------------ */
/* 6. The ranked sites - the placement agent's brief                   */
/* ------------------------------------------------------------------ */

test('THE RANKED SITES: where a caravan road or an oasis would actually be met', async () => {
  const C = await corridors();

  console.log(`\n  OASIS SITES, restricted to the OPEN FLATS, >= 24 m clear of anything built, >= 90 m apart.`);
  console.log(`  Scored as a herd spread over ${OASIS_R} m and met at ${RECOGNITION} m, so the encounter radius is ${RECOGNITION + OASIS_R} m.`);
  console.log(`       site            share of ${C.inter.length} inter-region journeys    clear   place`);
  for (const c of C.oasisRank.ranked.slice(0, 12)) {
    console.log(`    (${String(c.x).padStart(5)},${String(c.z).padStart(5)})   ${(100 * c.fraction).toFixed(1).padStart(6)}%   ${i5(c.hit)} journeys   ${c.clearance.toFixed(0).padStart(4)} m   ${C.place.at(c.x, c.z)}`);
  }
  console.log('  the same ranking with the flats restriction LIFTED, for the price of honouring the brief:');
  for (const c of C.oasisAnywhere.ranked.slice(0, 3)) {
    console.log(`    (${String(c.x).padStart(5)},${String(c.z).padStart(5)})   ${(100 * c.fraction).toFixed(1).padStart(6)}%   ${C.place.at(c.x, c.z)}`);
  }

  console.log(`\n  STANDING-HERD SITES, at the bare ${RECOGNITION} m recognition radius - a drover's camp, a single herd`);
  for (const c of C.spotRank.ranked.slice(0, 10)) {
    console.log(`    (${String(c.x).padStart(5)},${String(c.z).padStart(5)})   ${(100 * c.fraction).toFixed(1).padStart(6)}%   clear ${c.clearance.toFixed(0).padStart(4)} m   ${C.place.at(c.x, c.z)}`);
  }

  console.log('\n  THE REFERENCE PLACEMENT the floors were calibrated on');
  for (const r of C.referencePlacement.routes) console.log(`    road   ${r.trains} trains x ${r.animals} animals   ${r.id}`);
  for (const o of C.referencePlacement.oases) console.log(`    oasis  ${o.herd} camels, r ${o.r} m   (${o.x}, ${o.z})`);
  const animals = C.referencePlacement.routes.reduce((a, r) => a + r.trains * r.animals, 0)
    + C.referencePlacement.oases.reduce((a, o) => a + o.herd, 0);
  console.log(`    ${animals} animals in a ${HALF * 2} m world`);

  /* Every ranked site has to be somewhere a body could stand and something
   * could be built, or the ranking is a list of places the placement cannot
   * use. Both properties are what `rankCandidates` filters on, so this is the
   * filter checked from the outside rather than trusted. */
  for (const c of C.oasisRank.ranked) {
    assert.equal(C.place.at(c.x, c.z), 'flats',
      `oasis candidate (${c.x}, ${c.z}) is not in the open flats`);
    assert.ok(c.clearance >= 24,
      `oasis candidate (${c.x}, ${c.z}) is ${c.clearance.toFixed(1)} m from something built`);
    assert.ok(c.hit > 0, `oasis candidate (${c.x}, ${c.z}) is on nobody's route`);
  }
  for (let i = 1; i < C.oasisRank.ranked.length; i++) {
    assert.ok(C.oasisRank.ranked[i].hit <= C.oasisRank.ranked[i - 1].hit, 'the oasis ranking is not sorted');
    for (let j = 0; j < i; j++) {
      const d = Math.hypot(C.oasisRank.ranked[i].x - C.oasisRank.ranked[j].x, C.oasisRank.ranked[i].z - C.oasisRank.ranked[j].z);
      assert.ok(d >= 90, `two ranked oasis sites are ${d.toFixed(0)} m apart - they are one site`);
    }
  }

  /* THE NUMBER THE PLACEMENT AGENT MOST NEEDS. The best single point in the
   * whole world is met by one inter-region journey in six. That is not a defect
   * in the ranking; it is the shape of a 900 m map with six destinations, and
   * it is why the brief needs MOVING content as well as an oasis: a train that
   * walks 400 m of corridor is met by half again as many journeys as the best
   * fixed point on it. */
  const bestSpot = C.spotRank.ranked[0];
  floorCheck('best single STATIC site, inter-region journeys met (%)', 8,
    Math.round(1000 * bestSpot.fraction) / 10, 100,
    `at (${bestSpot.x}, ${bestSpot.z}); the best ROAD reaches ${(100 * C.chosen[0].stats.expected).toFixed(1)}%`);
});

/* ------------------------------------------------------------------ */
/* 7. The floors are reachable                                         */
/* ------------------------------------------------------------------ */

test('THE FLOORS ARE REACHABLE: the reference placement turns all five green', async () => {
  const C = await corridors();

  /* WHY THIS TEST IS THE MOST IMPORTANT ONE IN THE FILE.
   *
   * `citadel-caravans.test.mjs` is red, and a red gate proves only that
   * something is missing. What it cannot prove on its own is that the gate is
   * PASSABLE - and an unpassable floor is worse than no floor, because it
   * teaches the next author to delete it. The medieval build shipped exactly
   * that mistake from the other side: a ceiling of 10% on watched road samples
   * against a rule that capped the number at 3.4% no matter what anybody built.
   * Nobody could have failed it and nobody noticed for the whole build.
   *
   * So the five floors are computed HERE too, by the same `evaluateFloors` over
   * the same arithmetic, against a synthetic placement of 64 animals sited at
   * the top of the ranked lists above. All five go green with room. That fixes
   * their meaning: red in the other file means the content is not there, and
   * nothing else. */
  const rows = evaluateFloors(C.referencePlacement, {
    inter: C.inter, spawnJourneys: C.spawnJourneys, field: C.field, ceilings: C.ceilings,
  });
  console.log('\n  the five gates, over the reference placement');
  for (const r of rows) floorCheck(r.label, r.floor, r.achieved, r.ceiling, r.note);

  const s = rows[0].score;
  console.log(`\n  and what that placement feels like: ${(100 * s.anyShare).toFixed(1)}% of inter-region journeys meet a camel,`);
  console.log(`  ${(100 * s.reliable).toFixed(1)}% of them at better than even odds, ${s.camelsMet.toFixed(1)} animals met on an average crossing`);

  /* The floors are set BETWEEN what a lesser placement can do and what the
   * reference does, and that spacing is the whole design. Asserted, so that
   * raising a floor past its own reference fails here rather than in the gate.
   */
  for (const r of rows) {
    assert.ok(r.achieved > r.floor,
      `the reference placement only reaches ${r.achieved} against a floor of ${r.floor} for "${r.label}" - `
      + 'the floor has been set at or above the placement it was calibrated on, and the gate is no '
      + 'longer known to be passable');
    assert.ok(r.ceiling >= r.achieved,
      `"${r.label}" reports an ablation ceiling of ${r.ceiling} below its achieved ${r.achieved}`);
  }

  /* And the negative control: an EMPTY PLACEMENT must fail all five. If an
   * empty world could pass one of the encounter gates, that gate is measuring
   * something other than encounter - which is precisely the medieval defect,
   * restated as a test.
   *
   * MEASURED AGAINST `fieldPre`, WHICH IS THE HALF THAT MAKES IT A CONTROL.
   * Four of the five gates read only declared animals and do not care what the
   * world is made of; `shortWalkShare` reads BUILT GEOMETRY, and the placement
   * this file briefed builds two oases and eight wells - so on the world as it
   * now stands an empty placement clears that gate on masonry, with not one
   * camel anywhere. `fieldPre` is the same distance transform with this drop's
   * own colliders subtracted (`world.traffic.colliders`), which is the world
   * this control was written about and the only field on which "nothing placed"
   * means nothing. */
  const nothing = evaluateFloors({ routes: [], oases: [] }, {
    inter: C.inter, spawnJourneys: C.spawnJourneys, field: C.fieldPre, ceilings: C.ceilings,
  });
  console.log('\n  the same five gates over an EMPTY world - the negative control');
  for (const r of nothing) console.log(`    ${r.label.padEnd(52)} floor ${String(r.floor).padStart(6)} | achieved ${String(r.achieved).padStart(6)}`);
  const passed = nothing.filter((r) => r.achieved >= r.floor);
  assert.equal(passed.length, 0,
    `${passed.map((r) => r.key).join(', ')} pass on a world with no camels in it - that gate cannot `
    + 'detect absence, which is exactly the defect these floors exist to prevent');
});
