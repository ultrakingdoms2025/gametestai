import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

/**
 * CAN A BODY GET THERE? THE CITADEL, MEASURED.
 *
 * The apparatus this file grew - `ColumnIndex`, `deckAt`, `flyArc`,
 * `arcClears`, `takeoffFan`, `ReachGraph` and the movement envelope they are
 * all driven from - now lives in `citadel-reach-kit.mjs` and is re-exported
 * here unchanged, so every existing `from './citadel-reach.test.mjs'` import
 * keeps working. The move happened because the outer ring needed a SECOND
 * measuring file, and importing a `*.test.mjs` re-registers its tests in the
 * importer's run.
 *
 * ── What is measured, and what is asserted ────────────────────────────────
 * Every test here is a FLOOR: a property the world must keep, quoted
 * floor / achieved / ceiling with the ceiling computed by ablation, so a
 * regression shows up as a number sliding toward its floor rather than a
 * boolean flipping.
 *
 * ── Cost ──────────────────────────────────────────────────────────────────
 * One headless world build and one graph pass, shared by every test through
 * `measure()`.
 */
export * from './citadel-reach-kit.mjs';
import {
  BUDGET,
  BUDGETS,
  FALL_DAMAGE_M,
  FALL_LETHAL_M,
  HAY_MAX,
  HAY_MIN,
  MAX_FLIGHT_STEPS,
  ORDER,
  STEP_UP,
  UnionFind,
  WALK_GRADIENT,
  boxAt,
  budgetFor,
  buildCitadel,
  deckAt,
  f,
  floorCheck,
  flyArc,
  freeFlight,
  harness,
  hayAt,
  haystackReport,
  histogram,
  i5,
  isPlank,
  mantled,
  measure,
  padExposure,
  padForAnchor,
  pearson,
  reachFor,
  stats,
} from './citadel-reach-kit.mjs';
import { CONFIG } from '../../src/core/Config.js';

/**
 * FLOOR. Nothing below this line means anything if this test is red.
 *
 * Six numbers, all measured in a live browser, all reproduced by `flyArc`'s
 * step order alone. The closed form gets the two apexes wrong by 5 cm in the
 * same direction and this is the test that would have caught that.
 */
test('FLOOR: the integrator reproduces the six numbers measured in a browser', () => {
  for (const b of BUDGETS) {
    const ff = freeFlight(b);
    console.log(`  ${b.id.padEnd(7)} flat ${ff.flat.toFixed(3)} m (browser ${b.flat})   apex ${ff.apex.toFixed(3)} m (browser ${b.apex})   ${ff.steps} steps`);
    assert.ok(Math.abs(ff.flat - b.flat) < 0.002, `${b.id} flat: got ${ff.flat.toFixed(4)}, browser ${b.flat}`);
    assert.ok(Math.abs(ff.apex - b.apex) < 0.002, `${b.id} apex: got ${ff.apex.toFixed(4)}, browser ${b.apex}`);
  }
  // And the closed form is wrong, which is why this test exists at all.
  assert.ok(Math.abs((6.4 ** 2) / (2 * 22) - 0.878) > 0.04, 'v^2/2g would have been 0.931');
});

/**
 * FLOOR. `deckAt`, on four columns whose answers are hand-checkable.
 *
 * The launch-beam column is the whole headroom clause in one probe: the crown
 * of the great tower is a perfectly good 13.4 m deck, and 5 cm above it sits
 * the beam a leap of faith launches from. A body cannot stand on the crown
 * there, so `deckAt` must answer the beam - and when the beam is excluded by a
 * ceiling it must answer NOTHING, not the crown.
 */
test('FLOOR: deckAt honours headroom, the ceiling, and merged columns', async () => {
  const { idx, physics } = await measure();
  assert.equal(idx.unhandled.length, 0, 'the column index must represent every collider in the world');
  assert.equal(idx.fields.length, 1, 'citadel registers exactly one heightfield');
  console.log(`  colliders ${physics.colliders.length}, boxes ${idx.boxes.length}, heightfields ${idx.fields.length}, unrepresented ${idx.unhandled.length}`);

  /* The inner-ward slab. (0, -25.5) used to be where the great tower's
   * haystack stood and it answered 20.0; Drop Two widened the tower's rest
   * galleries from 12.5 m to 15.4 m so that a step off the crown is caught
   * 5.32 m down instead of falling 47.60 m onto the ward, and that column is
   * now under the top gallery. The ward itself is two metres further out. */
  assert.equal(idx.deckAt(0, -28).y, 20, 'the ward slab top is 20.0');
  assert.ok(Math.abs(idx.deckAt(0, -25.5).y - 62.28) < 1e-9,
    'the great tower gallery now overhangs its own crown, which is what makes the fall survivable');
  // And the leap-of-faith hay stands ON the ward rather than inside it: 2.0 m
  // of thatch on a 20.0 m slab. It used to be recorded at 16.4, four metres
  // under the surface it was meant to catch a body on.
  assert.equal(idx.deckAt(0, 16.3).y, 22, 'the leap-of-faith haystack is thatch standing on the ward');

  // The launch beam. Column is [-50, 67.6] then [67.65, 68.15]: a 5 cm gap.
  const col = idx.column(0, -13);
  assert.equal(col.length, 2);
  assert.ok(Math.abs(col[0].top - 67.6) < 1e-6 && Math.abs(col[1].bot - 67.65) < 1e-6,
    `crown/beam column is ${JSON.stringify(col.map((c) => [c.bot, c.top]))}`);
  assert.ok(Math.abs(idx.deckAt(0, -13).y - 68.15) < 1e-6, 'deckAt under the beam is the beam');
  assert.equal(idx.deckAt(0, -13, { below: 68 }), null,
    'the crown has 0.05 m of headroom under the beam and is not a landing there');

  // The gatehouse arch. Unrestricted this is the lintel; walking, it is the road.
  assert.equal(idx.deckAt(0, 118).y, 28, 'the gatehouse lintel top is 28.0');
  assert.equal(idx.deckAt(0, 118, { below: 16 }).y, 14, 'under the arch the deck is the road at 14.0');
  assert.equal(idx.deckAt(0, 104).y, 14, 'the spawn deck is the mesa at 14.0');

  /* THE CURTAIN WALL IS A CLOSED RING, and it was not.
   *
   * `_buildCurtainWall` rotated every segment by `mid + pi/2` where the world
   * bearing of a box's local +X is `-t`, so the segments lay along
   * `-(mid + pi/2)` - off the tangent by `2*mid + pi`, which is zero only at
   * multiples of pi/2 and a full right angle at pi/4. Swept with `deckAt`, the
   * wall was a rosette: solid stone reaching in to r = 111.8 at some bearings
   * and open mesa AT r = 118 at others, so four of the six rampart haystacks
   * stood on a wall segment that had swung inland and the town was not walled
   * at all.
   *
   * The sweep is 360 samples at 1 degree, which is finer than the 9.0 m
   * segment pitch by an order of magnitude, so a single missing segment cannot
   * hide between two samples. The gate is the one deliberate opening. */
  /* The gate. `_buildCurtainWall` skips the segments whose mid-bearing is
   * within 0.1 rad of +Z, which is two of the forty, and each segment is
   * 0.083 rad wide - so the deliberate opening runs to 0.15 rad either side of
   * the gate and the gatehouse stands in the middle of it. Swept, the last
   * open bearing is at 0.1396 and 0.157 is wall again. */
  const GATE_HALF = 0.15;
  let open = 0;
  let worst = null;
  for (let i = 0; i < 360; i++) {
    const bearing = (i / 360) * Math.PI * 2;
    if (Math.abs(((bearing - Math.PI * 0.5 + Math.PI) % (Math.PI * 2)) - Math.PI) < GATE_HALF) continue;
    const d = idx.deckAt(Math.cos(bearing) * 118, Math.sin(bearing) * 118);
    // The wall walk is 23.0, a merlon 24.5, a wall tower 32.2, the gatehouse 28.
    if (!d || d.y < 22.9) { open++; if (!worst) worst = { bearing, y: d?.y ?? null }; }
  }
  console.log(`  curtain wall swept at 1 deg: ${open} of 360 bearings with no wall on them`);
  assert.equal(open, 0,
    `the curtain wall must be continuous; ${open} bearings are open mesa, first at ${worst && (worst.bearing * 180 / Math.PI).toFixed(0)} deg answering ${worst && worst.y}`);
  /* And no wall MASONRY may lie inside the pomerium, which is the lane the
   * rampart haystacks stand in. The band checked is the wall walk's own,
   * 20 m to 27 m: a rosette segment answered 23.0 here, which is what buried
   * four of the six haystacks on top of a wall that had swung inland.
   *
   * Masonry, not "anything". The two landfall rope bridges descend across this
   * lane by construction - `_buildRopeBridges` ties them to a wall tower at
   * 32.2 and lands them on an outer-souk roof at 20.5, so they cannot cross
   * r = 111.5 anywhere BUT inside a 20-27 band - and a plank ten metres over
   * the lane is not a wall. Measured, they answer 24.64/25.21 at bearing 247
   * and 24.67/25.24 at bearing 67.
   *
   * > This assertion previously read `deckAt(...)` and compared the single top
   * > answer, and it passed only by coincidence. At bearing 67 the
   * > `minaret-perimeter` long span also crosses that same one-degree column,
   * > at 32.30, and `deckAt` returns the HIGHEST interval - so the landfall
   * > planks underneath it were masked and 32.30 sailed over the 27 ceiling.
   * > At bearing 247 the matching `great-tower-perimeter` plank happens to
   * > land at 248 instead, nothing masked the landfall, and the same geometry
   * > read 25.21 and failed. The comment that stood here recorded the masking
   * > plank ("crossing it at 32.3") as though it were the landfall bridge.
   *
   * So the sweep now walks the WHOLE column rather than its top - which is
   * strictly stronger, because a wall segment hiding under a bridge used to be
   * invisible to it - and exempts planks by shape rather than by height, via
   * the same `isPlank` the graph builds its chains with. The exemption is
   * counted and pinned: four plank intervals on two bearings, which is the two
   * landfall spans and nothing else. A third bridge sagging into the lane, or
   * a wall segment swinging inland under one, both move that count. */
  let planksInBand = 0;
  const bridgedBearings = new Set();
  for (let i = 0; i < 360; i++) {
    const bearing = (i / 360) * Math.PI * 2;
    const deg = (bearing * 180 / Math.PI).toFixed(0);
    for (const iv of idx.column(Math.cos(bearing) * 111.5, Math.sin(bearing) * 111.5)) {
      if (iv.top < 20 || iv.top > 27) continue;
      if (isPlank(iv.owner)) { planksInBand++; bridgedBearings.add(deg); continue; }
      assert.fail(`no wall masonry may stand in the pomerium at r = 111.5; bearing ${deg} deg answers ${iv.top}`);
    }
  }
  console.log(`  pomerium at r = 111.5: ${planksInBand} rope-bridge planks in the 20-27 band, on bearings ${[...bridgedBearings].join(', ')}`);
  assert.deepEqual([...bridgedBearings].sort(), ['247', '67'],
    'only the two landfall spans may cross the pomerium in the wall-walk band');
  /* RE-TAKEN 2026-09-01: 4 -> 6. The two landfall spans went 21 planks to 32
   * when the rope bridges were re-authored against the player's 0.45 m step
   * instead of `NPC.GROUND_PROBE_UP` = 0.95 (see `CitadelWorld`'s note on
   * `hang` and `sagAmp`), so three planks per span now fall inside the 20-27 m
   * band rather than two. The BEARINGS are unchanged, which is the half of
   * this pair that says no bridge moved. */
  assert.equal(planksInBand, 6,
    'three planks per landfall span cross the band; a different count is a bridge that moved');
});

/**
 * FLOOR. The takeoff fan must actually reject the lucky pixel.
 *
 * Design §6 says a gap crossable from one point on one bearing is not a route.
 * That is only worth writing down if it changes an answer, so this re-buckets
 * every souk edge with the rule relaxed to one point and one bearing and
 * insists the two histograms differ. A fan that never rejects anything is a fan
 * that is not being applied.
 */
test('FLOOR: the route rule rejects crossings the single-arc test accepts', async () => {
  const { edges, idx } = await measure();
  let softer = 0;
  const sample = [];
  for (const e of edges) {
    if (e.budget === 'trivial') continue;
    const relaxed = budgetFor(e.pa, e.pb, idx, { minPoints: 1, minPairs: 1 });
    if (ORDER.indexOf(relaxed.id) < ORDER.indexOf(e.up)) {
      softer++;
      if (sample.length < 4) sample.push(`ring ${e.ring} ${e.kind} gap ${e.gap.toFixed(2)} dy ${e.dy.toFixed(2)}: ${relaxed.id} -> ${e.up}`);
    }
  }
  console.log(`  souk edges whose budget is harder under the route rule: ${softer} of ${edges.length}`);
  for (const s of sample) console.log(`    ${s}`);
  floorCheck('edges the route rule makes harder', 1, softer, edges.length);
});

/**
 * FLOOR. Every souk roof is a place a body can stand.
 *
 * `padExposure` is the probe that matters: 30% of these roofs carry a dome
 * collider 3 m tall in the middle of the deck, so "is the roof the top of its
 * own column" is false for 57 of them and means nothing. What means something
 * is whether ANY of the roof is open sky. The worst in the world is 0.36 -
 * a third of the deck - and zero would be a roof swallowed by a neighbour.
 */
test('FLOOR: every souk roof resolves to a pad with open sky over part of it', async () => {
  const { world, idx } = await measure();
  const souk = world._roofs.filter((r) => r.ring !== undefined);
  let resolved = 0; let worst = 1;
  for (const r of souk) {
    const pad = padForAnchor(idx, r.x, r.z, r.y);
    if (!pad?.box || Math.abs(pad.y - r.y) > 0.05) continue;
    const e = padExposure(idx, pad);
    if (e > 0) resolved++;
    worst = Math.min(worst, e);
  }
  console.log(`  souk roofs ${souk.length}, standable ${resolved}, worst open-sky share ${worst.toFixed(2)}`);
  floorCheck('souk roofs that are standable decks', 182, resolved, souk.length);
  // Was 191. `SOUK_RINGS` builds 200 and the processional corridor clears 18.
  assert.equal(souk.length, 182, 'the souk builds 182 roofs after the processional corridor is cleared');
});

/**
 * FLOOR + REPORT. The souk gap spectrum, and the two R2 claims settled.
 *
 * The design predicted "gaps of 2.1 m to 7.1 m about a 4.6 m mean with no
 * relationship to ring index". The measurement pass CONFIRMED the second half
 * (pearson r = 0.1485, per-ring spread 1.34 m) and REFUTED the first (the real
 * deck-to-deck mean was 2.01 m, 34 pairs physically overlapped).
 *
 * Drop Two authored the gradient the file header has always claimed, and this
 * test is now the assertion that it exists rather than the record that it does
 * not. Every number below moved deliberately; the pre-Drop-Two value is quoted
 * beside each one.
 *
 * The mechanism is in `SOUK_RINGS`: the footprint frame was turned to radial so
 * `w` is tangential width at every bearing, the +/-0.03 rad of angular jitter
 * (which was +/-3.1 m of slop at the outer ring) was deleted, and `w` is now
 * SOLVED from a target gap rather than rolled. What is left inside a ring is
 * +/-0.25 m of footprint noise, which shows up as a per-ring standard deviation
 * of 0.07 to 0.12 m against per-ring means 3.61 m apart.
 */
test('FLOOR: the souk gap spectrum is an authored gradient (design §4.2)', async () => {
  const { edges } = await measure();

  for (const kind of ['tangential', 'radial']) {
    for (const excl of [false, true]) {
      const set = edges.filter((e) => e.kind === kind && (!excl || !e.corridor));
      if (excl && set.length === edges.filter((e) => e.kind === kind).length) continue;
      console.log(`\n  -- ${kind}${excl ? ', processional corridor excluded' : ''} (${set.length} edges) --`);
      console.log('  ring |   n |  min |  mean |  max |   sd | trivial  walk sprint  leap  impos | mantle');
      const row = (label, rs) => {
        const s = stats(rs.map((e) => e.gap));
        console.log(`  ${label} |${i5(s.n)} |${f(s.min)} |${f(s.mean, 6)} |${f(s.max)} |${f(s.sd)} |` +
          histogram(rs).map((v) => i5(v) + ' ').join('') + `|${i5(rs.filter(mantled).length)}`);
      };
      for (const r of [...new Set(set.map((e) => e.ring))].sort((a, b) => a - b)) row(` ${String(r).padStart(2)}`, set.filter((e) => e.ring === r));
      row('ALL', set);
      const au = stats(set.map((e) => e.authored));
      console.log(`   authored w x d gap: min ${au.min.toFixed(2)} mean ${au.mean.toFixed(2)} max ${au.max.toFixed(2)}`);
      console.log(`   pearson r(ring, gap) = ${pearson(set.map((e) => e.ring), set.map((e) => e.gap)).toFixed(4)}`);
      const dyS = stats(set.map((e) => Math.abs(e.dy)));
      console.log(`   |dy| between decks: min ${dyS.min.toFixed(2)} mean ${dyS.mean.toFixed(2)} max ${dyS.max.toFixed(2)}`);
    }
  }

  const tan = edges.filter((e) => e.kind === 'tangential');
  const tanNC = tan.filter((e) => !e.corridor);
  const rad = edges.filter((e) => e.kind === 'radial');
  const gTan = stats(tanNC.map((e) => e.gap));
  const gRad = stats(rad.map((e) => e.gap));
  const aTan = stats(tanNC.map((e) => e.authored));

  console.log('\n  all souk edges ' + edges.length);
  console.log('    easier direction  : ' + ORDER.map((b, i) => `${b} ${histogram(edges)[i]}`).join(', '));
  console.log('    harder direction  : ' + ORDER.map((b, i) => `${b} ${histogram(edges, 'hardest')[i]}`).join(', '));
  console.log('    harder + wall grab: ' + ORDER.map((b, i) => `${b} ${histogram(edges, 'hardestWithGrab')[i]}`).join(', '));
  const oneWay = edges.filter((e) => e.hardest === 'impossible' && e.budget !== 'impossible').length;
  console.log(`    one-way (crossable in one direction only): ${oneWay}, of which ${edges.filter(mantled).length} are rescued by a wall grab`);

  /* The ablation ceiling for the histogram: keep the geometry and the drop, drop
   * the obstacles, the landing margin and the fan. Nothing can be easier than
   * this, so it is the ceiling every bucket is checked against. */
  const ablate = (e) => {
    if (e.gap <= 0.6 && Math.abs(e.dy) <= STEP_UP) return 'trivial';
    for (const b of BUDGETS) {
      for (const dy of [e.dy, -e.dy]) {
        if (dy <= b.apex && e.gap <= reachFor(b, Math.min(0, dy))) return b.id;
      }
    }
    return 'impossible';
  };
  const abl = ORDER.map((b) => edges.filter((e) => ablate(e) === b).length);
  console.log('    ABLATION (geometry and drop only, no obstacles, no margin, no fan):');
  console.log('      ' + ORDER.map((b, i) => `${b} ${abl[i]}`).join(', '));

  /* ---- the gradient, which did not exist before this drop ----------- */
  const ringMeans = [0, 1, 2, 3, 4, 5, 6].map((r) => stats(tanNC.filter((e) => e.ring === r).map((e) => e.gap)).mean);
  const ringSds = [0, 1, 2, 3, 4, 5, 6].map((r) => stats(tanNC.filter((e) => e.ring === r).map((e) => e.gap)).sd);
  const spread = Math.max(...ringMeans) - Math.min(...ringMeans);
  const r2 = pearson(tanNC.map((e) => e.ring), tanNC.map((e) => e.gap));
  const rRad = pearson(rad.map((e) => e.ring), rad.map((e) => e.gap));
  console.log(`\n  per-ring tangential means: ${ringMeans.map((v) => v.toFixed(2)).join(', ')}  spread ${spread.toFixed(2)} m, pearson ${r2.toFixed(4)}`);
  console.log(`  per-ring tangential sds:   ${ringSds.map((v) => v.toFixed(3)).join(', ')}`);
  // Was r = 0.1485 with a 1.34 m spread of ring means, which is noise.
  assert.ok(r2 < -0.9, `the tangential gradient must be monotone inward; pearson is ${r2.toFixed(4)} (was +0.1485, no relationship at all)`);
  assert.ok(rRad < -0.9, `the radial gradient must be monotone inward; pearson is ${rRad.toFixed(4)} (was +0.0904)`);
  assert.ok(spread > 3.0, `the spread of per-ring means is the gradient; ${spread.toFixed(2)} m (was 1.34 m)`);
  for (let i = 0; i < 6; i++) {
    assert.ok(ringMeans[i] > ringMeans[i + 1] + 0.3,
      `ring ${i} must be meaningfully wider than ring ${i + 1}: ${ringMeans[i].toFixed(2)} vs ${ringMeans[i + 1].toFixed(2)}`);
  }
  // A designed distribution is one whose within-ring scatter is small compared
  // with its between-ring separation. It was sd 2.03 m on a 1.34 m spread.
  assert.ok(Math.max(...ringSds) < 0.2,
    `within-ring scatter must stay under 0.2 m; worst is ${Math.max(...ringSds).toFixed(3)} (was 2.03 m over the whole souk)`);

  /* ---- the three bands the design asked for ------------------------- */
  console.log(`  tangential (corridor excluded) gap: min ${gTan.min.toFixed(2)} mean ${gTan.mean.toFixed(2)} max ${gTan.max.toFixed(2)} sd ${gTan.sd.toFixed(2)}`);
  console.log(`  authored w x d gap:                 min ${aTan.min.toFixed(2)} mean ${aTan.mean.toFixed(2)} max ${aTan.max.toFixed(2)}`);
  console.log(`  radial gap:                         min ${gRad.min.toFixed(2)} mean ${gRad.mean.toFixed(2)} max ${gRad.max.toFixed(2)}`);
  // Outer three rings: a sprint jump, and never more. Inner four: the leap,
  // and never less. Not one edge in either band falls on the wrong side.
  assert.deepEqual(histogram(tanNC.filter((e) => e.ring >= 4)), [0, 0, 107, 0, 0],
    'rings 6, 5 and 4 are sprint-jump rings, all 107 crossings');
  assert.deepEqual(histogram(tanNC.filter((e) => e.ring <= 3)), [0, 0, 0, 68, 0],
    'rings 3, 2, 1 and 0 require the leap, all 68 crossings');
  assert.ok(gTan.max < 7.17,
    `nothing may exceed the leap's usable reach of 7.17 m; the widest gap is ${gTan.max.toFixed(2)}`);
  assert.ok(gTan.min > 2.2,
    `nothing may be inside a walk jump either, or the outer rings teach nothing; the tightest is ${gTan.min.toFixed(2)}`);

  /* ---- and the mantle, which is the inner rings' whole character ----- */
  const mantleTan = (r) => tanNC.filter((e) => e.ring === r && mantled(e)).length;
  console.log(`  tangential crossings that need a leap AND a mantle, by ring: ${[0, 1, 2, 3, 4, 5, 6].map(mantleTan).join(', ')}`);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(mantleTan), [10, 15, 0, 0, 0, 0, 0],
    'the saw-toothed inner two rings: every tangential crossing is uphill in one direction and needs a grab');
  assert.equal(edges.filter(mantled).length, 57,
    'the wall grab rescues exactly the uphill halves the gradient authored');

  /* ---- the histogram itself, asserted exactly ------------------------ */
  // Was [191, 149, 340]; the re-authored rings build 182 tangential and 140
  // radial edges over 182 roofs.
  assert.deepEqual([tan.length, rad.length, edges.length], [182, 140, 322], 'souk edge counts');
  assert.deepEqual(histogram(edges), [0, 40, 205, 70, 7], 'easier-direction budget histogram');
  assert.deepEqual(histogram(edges, 'hardest'), [0, 0, 148, 110, 64], 'harder-direction budget histogram');
  assert.deepEqual(histogram(edges, 'hardestWithGrab'), [0, 0, 180, 135, 7], 'harder direction once a wall grab is allowed');
  assert.equal(oneWay, 57, 'edges that only work downhill');
  assert.deepEqual(histogram(tanNC), [0, 0, 107, 68, 0], 'tangential, corridor excluded');
  assert.deepEqual(histogram(rad), [0, 40, 98, 2, 0], 'radial');
  assert.equal(tan.filter((e) => e.corridor).length, 7, 'one processional-corridor edge per ring, and it must stay open');
  // The seven impossible edges are the seven corridor edges and nothing else.
  // If that ever stops being true, something has been closed that should not be.
  assert.equal(edges.filter((e) => e.budget === 'impossible' && !e.corridor).length, 0,
    'the only uncrossable edges in the souk are the processional corridor');
  for (let i = 0; i < ORDER.length; i++) {
    const cum = (h) => h.slice(0, i + 1).reduce((a, b) => a + b, 0);
    assert.ok(cum(histogram(edges)) <= cum(abl), `ablation must dominate at ${ORDER[i]}`);
  }
  floorCheck('souk edges crossable at sprint or cheaper', 245, histogram(edges).slice(0, 3).reduce((a, b) => a + b, 0), abl.slice(0, 3).reduce((a, b) => a + b, 0));
  floorCheck('souk edges that need the leap', 70, histogram(edges)[3], edges.length, '(was 14 of 340, by accident)');
  floorCheck('souk edges that need a leap and a mantle', 57, edges.filter(mantled).length, edges.length, '(was 189, also by accident)');
});

/**
 * FLOOR. R1, asked twice, because before Drop Two the two answers disagreed
 * completely and the second one was the design's actual complaint.
 *
 * With climbing, Citadel was always ONE component - every plaster wall in this
 * world has a window course on it, so a body can get anywhere given stamina.
 * Take the walls away and ask the parkour question instead, and the citadel
 * core used to detach entirely: 32 components, and not one minaret, viewpoint
 * or bridge plank on the same rooftop network as the spawn.
 *
 * Drop Two joined them, and the route it joined them by is the one §1.3 always
 * described: out of the souk, across the pomerium on a landfall span, up onto
 * a wall tower, and 100 m back over the town on the perimeter bridge. The two
 * long spans are the ones `_buildRopeBridges` intended and rejected on the next
 * line for eight months; the two short ones are what make them worth having.
 */
test('FLOOR: the rooftop network reaches the perimeter and the citadel (design §4.1)', async () => {
  const { world, graph, uf, main, spawn, reach } = await measure();
  const kinds = ['tower', 'minaret', 'viewpoint', 'roof', 'souk', 'plank', 'step'];
  const wj = graph.components(['walk', 'jump']);
  const table = (label, u) => {
    const comps = u.components();
    const root = u.find(spawn);
    const sizes = [...comps.values()].sort((a, b) => b - a);
    console.log(`\n  ${label}`);
    console.log(`    components ${comps.size}, largest ${sizes[0]}, spawn's ${comps.get(root)}, singletons ${sizes.filter((s) => s === 1).length}`);
    const out = {};
    for (const k of kinds) {
      const ns = graph.nodes.filter((n) => n.kind.has(k));
      out[k] = [ns.length, ns.filter((n) => u.find(n.id) === root).length];
      console.log(`      ${k.padEnd(9)} ${i5(out[k][0])} total ${i5(out[k][1])} with spawn`);
    }
    return { comps, root, out };
  };
  const full = table('walk + climb + jump  (R1 as the design states it)', uf);
  const roof = table('walk + jump only     (the rooftop network, no wall climbs)', wj);
  console.log(`\n    forward-directed reachability from spawn (walk, climb, jump, drop): ${reach.count} / ${graph.nodes.length}`);
  for (const v of world.viewpoints) {
    const id = graph.nodeFor(v.x, v.z, v.y + 1);
    console.log(`      ${v.name.padEnd(16)} node ${String(id).padStart(4)}  R1 ${uf.find(id) === main ? 'yes' : 'NO'}   over the roofs ${wj.find(id) === roof.root ? 'yes' : 'NO'}   forward-reachable ${reach.seen[id] ? 'yes' : 'NO'}`);
  }
  const br = graph.bridges();
  console.log(`\n    rope bridges built: ${br.length}`);
  for (const b of br) console.log(`      ${String(b.planks).padStart(3)} planks, span ${b.span.toFixed(1).padStart(6)} m, y ${b.a.y.toFixed(1).padStart(5)} -> ${b.b.y.toFixed(1).padStart(5)}, max radius ${b.maxRadius.toFixed(1)} m`);

  /* ---- R1 with the walls: a floor, and it held before and holds now -- */
  assert.equal(full.comps.size, 1, 'R1: the jump graph is one connected component');
  for (const k of kinds) floorCheck(`R1  ${k} decks joined to spawn`, full.out[k][0], full.out[k][1], full.out[k][0]);
  /* ── Forward reachability is a SHARE now, and the 19 are named ─────────
   *
   * This read `assert.equal(reach.count, graph.nodes.length)` while the world
   * was the mesa, where every terrain dart stands on a plateau, a shoulder or
   * flat sand. The outer ring put 19 of them on the karst massif's own face -
   * bare heightfield at a gradient of 2.44, between the shelf at 29 m and the
   * summit at 55 - and this model refuses to walk anything past `WALK_GRADIENT`
   * 0.678. The game does not: `Physics` grounds a capsule to n.y > 0.64 and
   * `Climb` grips anything past 1.73, so a player free-climbs that face, which
   * is the verb the region was authored for. The probe under-claims, and a
   * reachability proof is allowed to.
   *
   * What is NOT allowed is a DECK nobody can get to, and that is asserted
   * exactly, below and in `citadel-regions.test.mjs`: every published roof,
   * tower, viewpoint, venue checkpoint, relic and cache resolves and is
   * forward-reachable.
   *
   * floor    99.5% of nodes forward-reachable from spawn
   * achieved  99.89% (17,534 of 17,553); every unreachable one is a lattice
   *           dart on the karst face, and none of them is a published deck
   * ceiling   100% - what the mesa alone measured */
  const unreached = graph.nodes.filter((n) => !reach.seen[n.id]);
  const unreachedDecks = unreached.filter((n) => !n.kind.has('lattice') || n.kind.size > 1);
  assert.deepEqual(unreachedDecks.map((n) => `${[...n.kind].join('+')}@${n.pad.y.toFixed(1)}`), [],
    'a published deck is not forward-reachable from spawn');
  floorCheck('R1  nodes forward-reachable from spawn, %', 99.5,
    ((100 * reach.count) / graph.nodes.length).toFixed(2), 100,
    `(${unreached.length} bare-terrain darts on the karst face)`);
  assert.ok(reach.count / graph.nodes.length >= 0.995,
    `only ${reach.count}/${graph.nodes.length} nodes are forward-reachable; floor 99.5%`);

  /* ---- the rooftop network alone: this is what Drop Two moved --------
   *
   * These four are UNDIRECTED counts and the wording says so, because
   * `components` unions a one-way downhill jump as though it were two-way and
   * this world has 57 of those. "Linked to the spawn's rooftop component by
   * walk/jump edges" is the whole claim; it is not "you can walk and jump
   * there from the gate", which over the roofs alone is nobody, because
   * getting onto a roof at all is a climb. The directed statement is the
   * `reach.count` assertion above, which is 100% of the graph with the walls
   * in, and the per-edge directions are pinned exactly by `oneWay` and the
   * `hardest` histograms in the souk-gradient test. */
  // Was: 32 components, minaret 4/0, viewpoint 5/0, plank 88/0, tower 9/5,
  // roof 10/5, souk 191/191.
  assert.equal(roof.comps.size, 9, 'rooftop-only components (was 32)');
  assert.deepEqual(roof.out.minaret, [4, 4], 'every minaret is linked to the souk rooftop component (was 0 of 4)');
  assert.deepEqual(roof.out.viewpoint, [10, 10], 'every viewpoint is linked to it (was 0 of 5)');
  /* RE-TAKEN 2026-09-01: 276 -> 328. Every rope bridge in the world had a
   * worst plank-to-plank step of 0.600 to 0.685 m against a 0.45 m player -
   * the drop ON is free, the step back UP onto the deck at the far end is not.
   * The plank count is now solved from the step and the catenary rather than
   * from the span alone: the two landfalls 21 -> 32 and the great tower's
   * perimeter 74 -> 104, and all eight spans measure 0.450. */
  assert.deepEqual(roof.out.plank, [328, 328], 'every bridge plank is linked to it (was 0 of 88)');
  assert.deepEqual(roof.out.souk, [182, 182], 'the souk is one rooftop component, corridor and all');
  /* 8 of 14, and the six that are not are the wall towers no bridge lands on.
   * Their parapets stand 9.2 m over the wall walk, which is a free climb and
   * not a jump, so they are reachable but not over the roofs - that is the
   * remaining headroom, quoted rather than hidden. The five region towers all
   * join, because every one of them has a flight of steps against it.
   *
   * `roof` is 187 rather than 10 because every deck the outer ring publishes
   * lands in that bucket (a region deck carries no souk `ring`), and 180 of
   * them are on the spawn's rooftop network without a single wall climb. The
   * seven that are not are the Ashfall scar's three fallen floors and four
   * Deepworks platforms at the bottom of the pit, all of which are entered by
   * dropping in and left by a flight of steps - a `climb` edge in this graph's
   * vocabulary, and therefore out of the walk+jump column by construction. */
  assert.deepEqual(roof.out.tower, [14, 8], 'the great tower, two bridged wall towers and five region towers');
  /* RE-TAKEN 2026-09-01: 156 -> 155 of 163. One region deck left the walk+jump
   * column when the ring's flights were re-authored against the player's
   * 0.45 m step: a flight at half the riser is half as tall at every tread, so
   * the tread a deck used to be a plain stride from is now one riser lower and
   * the crossing is a jump rather than a walk. The DIRECTED statement is
   * unchanged - `reach.count` is still 99.5%+ and every ring deck is on the
   * spawn's network at the player's step, asserted in the riser test at the
   * end of this file - and 155 walk-linked decks a body can actually climb to
   * is worth more than 156 it could only jump up. */
  assert.deepEqual(roof.out.roof, [163, 155], 'the ring joins the rooftop network');
  /* 334, not 324: `buildPlinth` publishes the ten treads and thresholds its two
   * cave aprons build (the Quarry Adit's three plus a threshold, the Sunken
   * Hall's five plus a threshold), for the same reason the region staircases
   * are published - a 1.2 m tread is invisible to a 6 m lattice, and an
   * unpublished apron leaves its mouth resolving to no node at all.
   *
   * ── RE-TAKEN 2026-09-01: 334 -> 574, and the cause is a riser ──────────
   * `Regions.stair` and `Regions.helix` were authoring against `STEP_UP`
   * = 0.95, which is `NPC.GROUND_PROBE_UP` and not a player's leg. They now
   * author against `CONFIG.player.stepHeight` = 0.45 with the pitch held, so
   * every flight in the ring has about twice the treads over the same run:
   * 324 region treads become 564 and the ten cave-apron treads are unchanged.
   * See 'FLOOR: every riser in the citadel is inside the PLAYER's step' below
   * for the measurement that forced it. All 574 are still on the network,
   * which is the property this line is actually about. */
  assert.deepEqual(roof.out.step, [574, 574], 'every stair tread is on the rooftop network');

  /* ---- §1.3, made real ---------------------------------------------- */
  assert.equal(br.length, 8, 'four minaret loops, two perimeter spans, two landfall spans');
  assert.equal(graph.planks.length, 328, 'planks in the world (was 88, then 276)');
  const long = br.filter((b) => b.span > 90);
  assert.equal(long.length, 2, 'two spans past the old 90 m rejection, which is why it was raised to 132');
  for (const b of long) {
    assert.ok(Math.abs(b.maxRadius - 118) < 0.5,
      `a perimeter span must actually reach the wall at r = ${118}, got ${b.maxRadius.toFixed(1)}`);
  }
  assert.ok(br.some((b) => Math.abs(b.span - 101.6) < 0.2), 'the great tower has a span at last');
  assert.ok(br.some((b) => Math.abs(b.span - 98.9) < 0.2), 'and the minaret span the comment always promised');

  /* ---- and every span is WALKABLE, measured plank by plank ----------- */
  const wjRoot = roof.root;
  console.log('\n    span                            planks   worst step   ends joined   both ends on the rooftop network');
  for (const b of world.ropeBridges) {
    const ai = graph.nodeFor(b.a.x, b.a.z, b.a.y + 0.5);
    const bi = graph.nodeFor(b.b.x, b.b.z, b.b.y + 0.5);
    const joined = ai !== undefined && bi !== undefined && wj.find(ai) === wj.find(bi);
    const onNet = ai !== undefined && wj.find(ai) === wjRoot && bi !== undefined && wj.find(bi) === wjRoot;
    console.log(`      ${b.id.padEnd(30)} ${String(b.planks).padStart(4)}   ${b.worstStep.toFixed(3).padStart(8)}   ${String(joined).padStart(11)}   ${onNet}`);
    /* The cap is the PLAYER's step, not `STEP_UP`. `STEP_UP` is 0.95 from
     * `NPC.GROUND_PROBE_UP` and every one of these eight spans passed it while
     * carrying a 0.600-0.685 m step nobody could walk. */
    assert.ok(b.worstStep <= CONFIG.player.stepHeight + 1e-9,
      `${b.id}: a ${b.worstStep.toFixed(3)} m step between planks is a climb, not a walk `
      + `(cap ${CONFIG.player.stepHeight})`);
    assert.ok(joined, `${b.id}: the two anchors are not walk-connected, so the span is decoration`);
    assert.ok(onNet, `${b.id}: the span does not join the network the spawn is on`);
  }
  assert.equal(world.ropeBridges.length, 8, 'the world publishes every span it built');
});

/**
 * FLOOR. R3, and it is the defect the design opens with.
 *
 * `_buildDressing` placed every haystack with `_groundAt`, which is
 * `terrainH(hypot(x, z))` - pure terrain, blind to every structure ever built
 * on top of it. Eight of eleven stood under a surface they could not catch
 * anything from, and all five viewpoint stacks were inside the inner-ward slab,
 * invisible, with their colliders buried in another solid.
 *
 * Drop Two adds `_deckAt`, which asks the collision world, and leaves
 * `_groundAt` alone for the reason its own docstring now records: two callers
 * use it as the terrain DATUM a physics cast is compared against, and making it
 * a physics query turns both clearance probes into no-ops.
 *
 * The bearing was wrong as well as the height. `atan2(vp.z, vp.x)` is the
 * direction of the viewpoint from the middle of the world, which has nothing to
 * do with the way a player faces when they jump: the great tower's launch beam
 * points at +Z and the rule offset the hay to -Z, 12.5 m behind the jump. Each
 * viewpoint now publishes its own launch point and bearing.
 */
test('FLOOR: all eleven haystacks catch a falling body (design §4.1)', async () => {
  const { world, hay } = await measure();
  console.log('    # | kind      |      x |      z | recorded |  deck T |  h.y-T | catches');
  for (const h of hay) {
    console.log(`   ${String(h.i).padStart(2)} | ${(h.viewpoint ? 'viewpoint' : 'rampart').padEnd(9)} |${f(h.x, 7, 1)} |${f(h.z, 7, 1)} |${f(h.recorded, 9)} |${f(h.deck, 8)} |${f(h.delta, 7)} | ${h.catches ? 'YES' : 'no'}`);
  }
  const catching = hay.filter((h) => h.catches).length;
  /* The ablation: drop the height constraint and keep only "does this hay
   * stand over a surface at all", which is the one thing placement cannot fix
   * afterwards. A hay over a real deck can always be given a catching height;
   * a hay over nothing cannot. (This line used to read
   * `h.deck !== null && 2.4 >= HAY_MIN && 2.4 <= HAY_MAX` - the same count,
   * but written as a comparison of two literals that evaluates the same way
   * against every world there is.) */
  const ceiling = hay.filter((h) => h.deck !== null).length;
  floorCheck('haystacks that catch a falling body', 33, catching, ceiling, '(was 3 of 11)');
  assert.equal(catching, 33, 'every haystack works');
  assert.equal(hay.length, 33,
    'eleven on the mesa and twenty-two in the outer ring - a region that stopped laying hay under its drops');
  assert.equal(hay.filter((h) => h.viewpoint && h.catches).length, 10,
    'including every viewpoint stack - the five mesa ones used to be inside the inner-ward slab');
  for (const h of hay) {
    assert.ok(h.deck !== null, `haystack ${h.i} stands over nothing at all`);
    /* There used to be an `assert.equal(h.catches, h.delta >= HAY_MIN &&
     * h.delta <= HAY_MAX)` here, restating `haystackReport`'s own definition of
     * `catches` back at it with the `T !== null` half already proved by the
     * line above. Both sides were the same expression, so no world - and no
     * mutation of one - could ever separate them. Deleted; `catching === 11`
     * above already pins the behaviour, and the interval's direction is pinned
     * by the delta band below, which a flipped interval would break. */
    // A hay standing proud on its own surface IS the top of its own column, so
    // the delta is the 0.3-0.4 m between the thatch and its recorded catch
    // height. Anything else means it is buried in something again.
    assert.ok(h.delta > 0 && h.delta < 0.5, `haystack ${h.i} is not standing on its own surface: h.y - T = ${h.delta.toFixed(2)}`);
  }
  assert.equal(world.haystacks.length, 33);

  /* The bearing repair, asserted rather than described. The great tower's hay
   * has to be on the +Z side of the tower, downrange of the beam, not on the
   * -Z side the radial rule put it on. */
  const gt = world.viewpoints.find((v) => v.id === 'great-tower');
  assert.ok(gt, 'the great tower publishes a viewpoint record');
  assert.ok(gt.hay.z > gt.z + 20, `the leap-of-faith hay must be downrange of the beam: hay z ${gt.hay.z.toFixed(1)} vs tower z ${gt.z}`);
  assert.ok(Math.abs(gt.hay.z - 16.3) < 0.01 && Math.abs(gt.hay.x) < 1e-6, 'and it is where the integrator says a leap comes down');
  /* Driven, not derived: a leap leaves the beam top at 68.15 and the ward is
   * 48.15 m below it, which the real stepper crosses in 28.53 m of run. From
   * the beam's root the keep roof gets in the way first at 22.32 m, which is a
   * 26.75 m fall - damage, not death. The hay covers the band between. */
  const drop = gt.launch.y - 20;
  /* 240 steps, not the shared 120. `MAX_FLIGHT_STEPS` is 2 s, which is the
   * right budget for a rooftop gap and is 0.4 s short of a 48 m fall - asked
   * with the default cap this returns 23.29 m and would have placed the hay
   * five metres short. The cap is a property of the probe, not of the body. */
  const run = reachFor(BUDGET.leap, -drop, 240);
  assert.ok(Math.abs(run - 28.53) < 0.02,
    `the run this hay is placed at must be the one the integrator produces: ${run.toFixed(2)}`);
  const land = gt.launch.z + run;
  assert.ok(Math.abs(land - gt.hay.z) <= gt.hay.r + 0.6,
    `a leap from the beam tip lands at z ${land.toFixed(2)} and the hay must catch it`);
});

/**
 * FLOOR. R4 inverted: falling is the mechanic, so the question is not whether
 * an edge drops you but whether the drop has an answer.
 *
 * Every deck perimeter, sampled every 1.5 m and stepped 0.45 m off the edge.
 * Twenty-five of those samples used to be a 47.60 m fall from the great tower's
 * crown onto the inner ward, past `LETHAL_SPEED` 42 m/s, and every single
 * unsurvivable sample in the world was that one edge - the crown overhung its
 * own rest galleries by 0.45 m, so a body stepping off cleared all six of them.
 *
 * The galleries are 2.2 m proud of the shaft now rather than 0.75, which puts
 * them 1.0 m outside the crown: the drop off the crown is caught 5.32 m down,
 * inside the 7.5 m at which fall damage begins at all. The tallest fall left in
 * Citadel is 21.40 m.
 */
test('FLOOR: no roof edge in the world is an unsurvivable fall (design §4.1)', async () => {
  const { falls } = await measure();
  const v = (k) => falls.filter((r) => r.verdict === k).length;
  const s = stats(falls.map((r) => r.fall));
  console.log(`    perimeter samples off real decks: ${falls.length}`);
  console.log(`      safe (<= ${FALL_DAMAGE_M} m)   ${i5(v('safe'))}`);
  console.log(`      caught by hay      ${i5(v('hay'))}`);
  console.log(`      damage             ${i5(v('damage'))}`);
  console.log(`      LETHAL (>= ${FALL_LETHAL_M} m) ${i5(v('lethal'))}`);
  console.log(`      landing unresolved ${i5(falls.filter((r) => r.to === undefined).length)}`);
  console.log(`      fall height: min ${s.min.toFixed(2)} mean ${s.mean.toFixed(2)} max ${s.max.toFixed(2)}`);

  /* 13,408 samples against 6,150 before the ring: 348 stair treads, 179 region
   * decks and 26 aqueduct spans all have perimeters, and every one of them is
   * an edge a body can walk off. The share that is SAFE went up rather than
   * down - 67.6% against 46.6% - because most of what the ring added is a
   * terrace step or a stair tread with two metres under it. */
  /* 12,795, not 12,817. `_buildDressing`'s crate loop now withholds a crate
   * whose dart landed inside a building - one of the 34 was standing over the
   * Spice Merchants House's own collectible spot - and two crates fewer is
   * twenty-two perimeter samples fewer. The dart itself and every random it
   * draws are unchanged, so nothing else in the world moved.
   *
   * ── RE-TAKEN 2026-09-01: 12,795 -> 13,307, +512, all of them treads ─────
   * The ring's flights were re-authored against the player's 0.45 m step
   * instead of the NPC's 0.95 (see the `roof.out.step` re-take above), so 240
   * more treads exist and every tread has a perimeter. Safe 8,643 -> 9,138
   * and damage 4,117 -> 4,132; hay and LETHAL are unmoved, and the tallest
   * fall in the world is unchanged at 27.15 m. 497 of the 512 new samples
   * land in the SAFE band, which is what a shallower flight means: the drop
   * off the side of a 0.45 m tread is half the drop off a 0.82 m one. */
  assert.equal(falls.length, 13307, 'roof-edge samples (was 6150 with the mesa alone)');
  assert.equal(v('lethal'), 0, 'no roof edge is a silent death (was 25, all of them the great tower crown)');
  assert.equal(v('safe'), 9140);
  assert.equal(v('hay'), 35);
  assert.equal(v('damage'), 4132);
  assert.ok(s.max < FALL_LETHAL_M,
    `the tallest fall off any deck must be survivable: ${s.max.toFixed(2)} m against a lethal ${FALL_LETHAL_M} m`);
  // Nothing lands anywhere it cannot get back from - that half of R4 held
  // before this drop and still holds.
  const stuck = falls.filter((r) => r.to !== undefined && !r.back).length;
  assert.equal(stuck, 0, 'a resolved landing is always back in the main component');
  floorCheck('roof-edge samples with a survivable outcome', falls.length, falls.length - v('lethal'), falls.length,
    '(was 6675 of 6700 before Drop Two)');
});

/**
 * FLOOR. R6 and R7: an objective nobody can reach is not content.
 *
 * `Relics._onWorld` and `Caches._onWorld` are the real placers, called here
 * rather than modelled, so these are the exact sites the game will hide. They
 * read `world._towers` and `world._roofs` before they dart at random, which is
 * why the re-authored souk has to keep publishing both.
 *
 * The rooftop-only column is the one with room in it. It was 26 of 30 before
 * this drop, fell to 23 when the citadel core detached from the souk, and the
 * two landfall spans took it back to 26 - the four that are left are the wall
 * towers no bridge lands on, whose parapets stand 9.2 m over the wall walk.
 */
test('FLOOR: every relic and cache site is in the reachable component', async () => {
  const { graph, sites, uf, main, spawn, reach } = await measure();
  const wj = graph.components(['walk', 'jump']);
  const wjRoot = wj.find(spawn);
  const place = (s) => {
    const id = graph.nodeFor(s.x, s.z, s.y + 0.5);
    return {
      id,
      main: id !== undefined && uf.find(id) === main,
      roof: id !== undefined && wj.find(id) === wjRoot,
      reach: id !== undefined && !!reach.seen[id],
    };
  };
  const rp = sites.relics.map(place);
  const cp = sites.caches.map(place);
  const elevated = sites.relics.filter((s) => s.y > 14 + 3).length;
  console.log(`    relics ${sites.relics.length}: ${rp.filter((p) => p.main).length} in R1, ${rp.filter((p) => p.roof).length} on the rooftop-only network, ${rp.filter((p) => p.reach).length} forward-reachable, ${rp.filter((p) => p.id === undefined).length} unresolved`);
  console.log(`    relics more than 3 m above the mesa deck (R7): ${elevated}`);
  for (let i = 0; i < sites.caches.length; i++) {
    const s = sites.caches[i];
    console.log(`      cache ${s.kind} (${s.x.toFixed(1)}, ${s.y.toFixed(1)}, ${s.z.toFixed(1)})  R1 ${cp[i].main}  rooftop ${cp[i].roof}`);
  }
  /* 109 and 9, both driven by `contentBounds` growing with the ring - see
   * `citadel-budgets.test.mjs` for the area law. What matters here is that the
   * larger budget is still satisfied entirely from AUTHORED anchors: `Relics`
   * consults `_roofs` and `_towers` before it darts, and the ring publishes 188
   * more decks than the mesa did, so the dart loop never runs and no relic can
   * land in open sand. That is the property the count is standing in for. */
  assert.equal(sites.relics.length, 109, 'the relic budget the content box asks for');
  assert.equal(sites.caches.length, 9, 'nine high caches, no water so no sunken ones');
  floorCheck('R6  relic sites in the reachable component', 109, rp.filter((p) => p.main).length, 109);
  floorCheck('R6  relic sites forward-reachable from spawn', 109, rp.filter((p) => p.reach).length, 109);
  floorCheck('R6  cache sites in the reachable component', 9, cp.filter((p) => p.main).length, 9);
  floorCheck('R7  relic sites genuinely elevated', 100, elevated, 109);
  floorCheck('R6b relic sites on the rooftop-only network', 95, rp.filter((p) => p.roof).length, 109,
    '(ceiling = every relic reachable over the roofs)');
  assert.equal(rp.filter((p) => p.main).length, 109, 'R6: every relic is in the reachable component');
  assert.equal(cp.filter((p) => p.main).length, 9, 'R6: every cache is in the reachable component');
});

/**
 * FLOOR. What the rest of Drop Two consumes, proved to exist and to be true.
 *
 * Three publications, and each of them is a promise to another agent:
 *
 *   `world.minigameVenues`  the trial venues, in the shape
 *                           `MinigameManager._readVenue` (`:480-512`) reads.
 *                           `kind: 'rooftop'` has no factory yet, which that
 *                           file treats as "a published slot, not an error".
 *   `world._roofs` / `_towers`  the authored relic sites `Relics._onWorld`
 *                           (`:329-345`) consults before it darts at random.
 *   `world.viewpoints`      now carrying `launch`, `bearing` and the resolved
 *                           `hay`, which is what makes a leap-of-faith prompt
 *                           possible at all.
 *
 * The assertion that matters is not that the fields exist - it is that every
 * published coordinate stands on a deck that exists and is on the network the
 * player is on. A venue whose start line is 12 cm inside a roof is a venue the
 * swept checkpoint validator never fires, and this is the whole class of defect
 * the medieval expansion shipped four times.
 */
test('FLOOR: the world publishes venues, relic anchors and viewpoints that resolve', async () => {
  const { world, idx, graph, spawn } = await measure();
  const wj = graph.components(['walk', 'jump']);
  const wjRoot = wj.find(spawn);

  /* ---- trial venues -------------------------------------------------- */
  assert.ok(Array.isArray(world.minigameVenues) && world.minigameVenues.length === 7,
    'seven rooftop trial venues are published: three on the mesa, four in the ring');
  for (const v of world.minigameVenues) {
    const cps = v.config.checkpoints;
    let offDeck = 0;
    let offNet = 0;
    for (const c of cps) {
      const d = idx.deckAt(c.x, c.z, { below: c.y + 1.2 });
      if (!d || Math.abs(d.y - c.y) > 0.2) offDeck++;
      const id = graph.nodeFor(c.x, c.z, c.y + 0.5);
      if (id === undefined || wj.find(id) !== wjRoot) offNet++;
    }
    console.log(`    ${v.id.padEnd(20)} ${String(cps.length).padStart(2)} checkpoints, ${v.config.routeLength.toFixed(1).padStart(6)} m of route, ${offDeck} off their deck, ${offNet} off the rooftop network`);
    // The shape `MinigameManager._readVenue` insists on.
    assert.ok(typeof v.id === 'string' && v.id, `${v.id}: id`);
    assert.ok(typeof v.kind === 'string' && v.kind, `${v.id}: kind`);
    assert.ok(Number.isFinite(v.centre.x) && Number.isFinite(v.centre.z), `${v.id}: centre`);
    assert.ok(Number.isFinite(v.radius) && v.radius > 0, `${v.id}: radius`);
    assert.ok(Number.isFinite(v.yTolerance) && Number.isFinite(v.reward), `${v.id}: tolerance and reward`);
    assert.equal(v.requires, 'parkour', `${v.id}: a parkour contest needs the parkour rule`);
    assert.ok(cps.length >= 3, `${v.id}: a route needs checkpoints`);
    assert.equal(offDeck, 0, `${v.id}: every checkpoint must stand on the deck it names`);
    assert.equal(offNet, 0, `${v.id}: every checkpoint must be on the network the player is on`);
    // The dragon race's 5.2 m torus is wider than most of these roofs.
    assert.ok(v.config.ringRadius < 3, `${v.id}: the checkpoint marker radius must be authored, not inherited`);
    // No guessed medal times. `routeLength` is measured; par is not this
    // file's to invent, and inventing it is how three spec numbers went wrong.
    assert.ok(v.config.par === undefined, `${v.id}: par times must come from measured route times`);
  }
  /* Four regions, not six. Ashfall and the Eyrie carry no trial and the reason
   * is measured: `minigame-rooftop-times.test.mjs` links two decks in its route
   * graph only within 26 m, Ashfall's ranges stand 28 m apart across a 9 m scar
   * and the Eyrie's three cloister ranges are 66 m apart round a peak. Neither
   * region is a rooftop RUN. */
  assert.deepEqual(world.minigameVenues.map((v) => v.id).sort(),
    ['citadel_aqueduct_run', 'citadel_ascent', 'citadel_deepworks_plunge',
      'citadel_serai_circuit', 'citadel_skyline', 'citadel_souk_dash',
      'citadel_undercliff_run']);

  /* ---- authored relic anchors ---------------------------------------- */
  let anchorsOff = 0;
  for (const a of [...world._roofs, ...world._towers]) {
    const b = boxAt(idx, a.x, a.z, a.y);
    if (!b) anchorsOff++;
  }
  console.log(`    authored anchors: ${world._roofs.length} roofs + ${world._towers.length} towers, ${anchorsOff} that no collider owns`);
  assert.equal(anchorsOff, 0, 'every published anchor is the top of a real collider');
  assert.equal(world._roofs.filter((r) => r.ring !== undefined).length, 182, 'souk roofs published');
  /* The souk's own publication, unchanged, is the mesa bit-identity check that
   * a height digest cannot make: the ring builds on its own PRNG and after
   * everything that reads `this.rnd`, so one more or one fewer souk roof here
   * means the town moved. */
  assert.equal(world._roofs.filter((r) => r.region === undefined).length, 192,
    'the mesa publishes 192 decks - the ring has disturbed the souk');
  assert.equal(world._towers.length, 18,
    'eight wall towers, the great tower, four minarets and five region towers');

  /* ---- viewpoints ----------------------------------------------------- */
  assert.equal(world.viewpoints.length, 10);
  for (const v of world.viewpoints) {
    console.log(`    ${v.id.padEnd(12)} deck ${v.y.toFixed(1).padStart(5)}  launch ${v.launch ? `(${v.launch.x.toFixed(1)}, ${v.launch.y.toFixed(1)}, ${v.launch.z.toFixed(1)})` : '        none        '}  bearing ${((v.bearing * 180) / Math.PI).toFixed(0).padStart(4)} deg  hay (${v.hay.x.toFixed(1)}, ${v.hay.y.toFixed(1)}, ${v.hay.z.toFixed(1)}) r ${v.hay.r}`);
    assert.ok(typeof v.id === 'string' && v.id, 'a viewpoint needs a stable id');
    assert.ok(Number.isFinite(v.bearing), 'and a bearing to lay its haystack on');
    assert.ok(v.hay && Number.isFinite(v.hay.y), 'and a resolved haystack');
    const h = idx.deckAt(v.hay.x, v.hay.z);
    assert.ok(h && Math.abs(h.y - (v.hay.y - 0.4)) < 0.05, `${v.id}: the hay must be the top of its own column`);
    // A launch point is optional - see the leap-of-faith test below for why
    // four of the five withhold it - but a published one is a real surface.
    if (v.launch) {
      const d = idx.deckAt(v.launch.x, v.launch.z);
      assert.ok(d && Math.abs(d.y - v.launch.y) < 0.05, `${v.id}: the launch point must be a deck, got ${d?.y}`);
    }
    // The bearing is NOT the radial one - that was the bug.
    if (v.id === 'great-tower') {
      assert.notEqual(Math.round(v.bearing * 100), Math.round(Math.atan2(v.z, v.x) * 100),
        'the great tower launches along its beam, not along its radius');
    }
  }
});

/**
 * FLOOR. The dev harness's citadel framings, measured against the world they
 * claim to frame.
 *
 * §6 of the design makes `Harness.VIEWS` the mandatory pre-browser instrument,
 * and its own comment block says every framing "was checked against the world
 * as actually built". It was - against the PREVIOUS build. This drop re-sited
 * the souk (outer ring 109 -> 103.0, deck heights with it) and two framings
 * quietly stopped framing anything: `souk-alley` stood at r = 112, which is
 * open pomerium now, with its view ray hitting the town's outer face at 12.3 m
 * of a claimed 28.4; and `souk-roofs` stood at y 25.80 over a ring-5 deck that
 * had dropped from 24.21 to 21.31, floating 4.49 m above it.
 *
 * A stale framing is a screenshot of the wrong thing, and the whole point of
 * the harness is that a critique compares art direction rather than whatever
 * happened to be on screen. So the framings are pinned here, where the build
 * already exists, rather than being re-derived by hand after every re-author.
 */
test('FLOOR: every citadel harness framing still frames its own subject', async () => {
  const { idx, physics } = await measure();
  const { VIEWS } = await import('../../src/dev/Harness.js');
  const views = VIEWS.citadel.filter((v) => Array.isArray(v.pos));
  assert.ok(views.length >= 6, `only ${views.length} positioned citadel framings - the list collapsed`);

  const _p = new THREE.Vector3();
  const _d = new THREE.Vector3();
  const claims = views.filter((v) => Number.isFinite(v.clear));
  assert.ok(claims.length >= 2, 'no citadel framing states a sightline any more - the `clear` field went away');
  let held = 0;
  console.log('    framing           camera            deck   eye above   solid   first hit / view length   claims');
  for (const v of views) {
    const [x, y, z] = v.pos;
    const d = idx.deckAt(x, z);
    const above = d ? y - d.y : NaN;
    const inSolid = physics.containsPoint?.(_p.set(x, y, z)) === true;
    _d.set(v.look[0] - x, v.look[1] - y, v.look[2] - z);
    const len = _d.length();
    _d.normalize();
    const hit = physics.raycast(_p.set(x, y, z), _d, len, undefined);
    const reach = hit ? hit.distance : len;
    if (Number.isFinite(v.clear) && reach >= v.clear) held++;
    console.log(`    ${v.name.padEnd(16)} (${f(x, 7, 1)},${f(y, 6, 1)},${f(z, 7, 1)})${f(d?.y ?? NaN, 8)}${f(above, 12)}   ${inSolid ? 'YES' : ' no'}   ${f(reach, 7, 1)} / ${len.toFixed(1)}   ${Number.isFinite(v.clear) ? `>= ${v.clear.toFixed(1)} m` : '-'}`);

    assert.equal(inSolid, false, `${v.name}: the camera is inside a collider`);
    /* A grounded camera stands on something. 0.2 m is a step, 3.5 m is a
     * first-floor balcony; 4.49 m over its own roof - which is what
     * `souk-roofs` had after the souk was re-authored - is a camera hanging in
     * the air over the subject it names. Below the deck is worse: it is a
     * camera inside the building.
     *
     * `aerial: true` is the two framings that MEAN to hang in the air - the
     * bridge view 42 m over the ward and the desert overview 74 m over the
     * shoulder. The flag is on the data rather than inferred from the height,
     * because inferring it would make the rule say "a camera is grounded when
     * it is near the ground", which is not a rule. */
    if (!v.aerial) {
      assert.ok(above >= 0.2 && above <= 3.5,
        `${v.name}: the camera stands ${above.toFixed(2)} m over the deck at (${x}, ${z}) `
        + `(deck ${d?.y?.toFixed(2)}) - it no longer stands on what it says it stands on`);
    }
    /* ..and where a framing CLAIMS a sightline, the claim is checked.
     *
     * `clear` is that claim moved out of the prose and into the data, because
     * a metre count in a comment is a number nobody can fail. It is not a
     * blanket "the ray must reach its target": `gate-spawn` deliberately lets
     * the keep occlude the tower below y 43 and `ward-centre` looks across the
     * keep facade, so both stop well short by design and neither states a
     * distance. The two that do state one are the two that went stale:
     * `souk-alley` promised 28 m of unbroken street and delivered 12.3 once
     * the souk's outer ring moved in to r = 103, and `souk-roofs` promised the
     * tower's own face. */
    if (Number.isFinite(v.clear)) {
      assert.ok(reach >= v.clear,
        `${v.name}: claims ${v.clear.toFixed(1)} m of clear line of sight and the ray is stopped at `
        + `${reach.toFixed(1)} m - this framing is photographing whatever got in the way`);
    }
  }
  floorCheck('citadel framings whose stated sightline holds', claims.length, held, claims.length);
});

/**
 * FLOOR. ARRIVAL, not placement - the assertion the rest of this file's
 * haystack coverage was missing.
 *
 * `Viewpoints.normaliseViewpoint` treats `launch` + `hay` published together as
 * "this viewpoint HAS a leap of faith" and raises the prompt inside LEAP_R
 * 3.0 m of the launch point. So the world's decision to publish `launch` IS an
 * offer to a player standing there, and the only honest test of an offer is to
 * fly it and see where the body lands.
 *
 * Everything before this asserted the hay was PLACED well - on a real deck, on
 * the launch bearing, downrange of the beam. All of that was true of the four
 * minarets too, and none of the four arrived: measured through the real
 * integrator against the built colliders, minaret 1 landed 16.45 m from its own
 * hay at 40.7 m/s, minarets 2 and 4 hit the ward wall, and minaret 3 landed on
 * the great tower's rest gallery. That is design §1.1's defect at a new height,
 * and a placement test cannot see it.
 *
 * So: every offer is flown, and every viewpoint that does NOT offer is asserted
 * to publish nothing a prompt could attach to.
 */
test('FLOOR: every leap-of-faith offer lands in its own haystack (design §1.1)', async () => {
  const { world, idx } = await measure();
  // Imported here rather than at module scope for the reason `buildCitadel` is:
  // nothing under `src/` may be loaded before `harness()` has run.
  const { normaliseViewpoint } = await import('../../src/systems/Viewpoints.js');
  /* 900 steps, not the shared 120. The drop is 46 m and `MAX_FLIGHT_STEPS` is
   * 2 s of flight; the cap is a property of the probe. */
  const CAP = 900;
  const offers = world.viewpoints.filter((v) => v.launch);
  let arrived = 0;
  console.log('    viewpoint    offer   outcome                   landing         run    fall   to hay   caught');
  for (const v of world.viewpoints) {
    if (!v.launch) {
      console.log(`    ${v.id.padEnd(12)} no      -`);
      // No prompt can attach: `normaliseViewpoint` drops BOTH halves of the
      // pair, which is the mechanism the world relies on.
      const n = normaliseViewpoint(v, 0);
      assert.equal(n.launch, null, `${v.id}: publishes no launch, so it must normalise to none`);
      assert.equal(n.hay, null, `${v.id}: the pair is dropped together or the prompt has half a line`);
      continue;
    }
    const r = flyArc(idx, v.launch, Math.cos(v.bearing), Math.sin(v.bearing), BUDGET.leap, { maxSteps: CAP });
    const run = Math.hypot(r.x - v.launch.x, r.z - v.launch.z);
    const fall = v.launch.y - r.y;
    const toHay = Math.hypot(r.x - v.hay.x, r.z - v.hay.z);
    const caught = hayAt(world, r.x, r.z, r.y) !== null;
    if (caught) arrived++;
    console.log(`    ${v.id.padEnd(12)} yes     ${r.outcome.padEnd(8)} (${f(r.x, 7, 2)},${f(r.y, 7, 2)},${f(r.z, 7, 2)})${f(run, 8)}${f(fall, 8)}${f(toHay, 9)}   ${caught ? 'YES' : 'no'}`);
    assert.equal(r.outcome, 'land', `${v.id}: a published leap must end on a surface, not ${r.outcome}`);
    assert.ok(caught,
      `${v.id}: the leap lands at (${r.x.toFixed(2)}, ${r.y.toFixed(2)}, ${r.z.toFixed(2)}), `
      + `${toHay.toFixed(2)} m from its own hay after a ${fall.toFixed(2)} m fall - `
      + 'either the run is wrong or this viewpoint must stop publishing `launch`');
  }
  floorCheck('leap-of-faith offers that arrive in their hay', offers.length, arrived, offers.length);
  /* The count itself, pinned. A world that quietly stopped offering the leap
   * would satisfy every assertion above vacuously. */
  /* Five: the great tower, and one per region that has somewhere to fall to.
   * The four minarets still withhold `launch` (a minaret drop is 31.5 m onto
   * the ward and not one of the four arrives), and so does the Caravan Mast -
   * its 15.0 m drop into the pan is damage rather than death, and a
   * leap-of-faith prompt on a fall the player survives anyway is the minaret
   * mistake in a different costume. */
  assert.equal(offers.length, 5,
    'the great tower and four regions offer the leap; the minarets and the mast do not');
});



/* ================================================================== */
/* The player's own step                                               */
/* ================================================================== */

/**
 * FLOOR. THE RULER WAS THE WRONG BODY, AND EVERY FLIGHT IN THE RING FAILED IT.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT WAS WRONG
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `STEP_UP` = 0.95 is quoted, in this file and in `citadel/Regions.js`, from
 * `NPC.GROUND_PROBE_UP` - how far a wandering NPC's ground-follower absorbs
 * before it re-plants its feet. It is not what a player's legs do.
 * `Player._move` takes a tread only when
 *
 *     treadY <= prev.y + CONFIG.player.stepHeight + 0.01
 *
 * and `CONFIG.player.stepHeight` is 0.45. Everything this suite flooded, and
 * everything `Regions.stair` authored, used 0.95 - so the ring could and did
 * build flights whose risers were nearly twice what a player can climb, and
 * the graph linked them with plain walk edges and reported the world
 * connected.
 *
 * Measured on the built ring before the repair: 36 flights, every one of them,
 * risers 0.679 to 0.810 m. All of them also under `Climb.MIN_RISE_GROUND`
 * = 1.0, so no mantle was offered either: the only way up any staircase in the
 * outer ring was to jump every tread. That is the ward stair's defect
 * (0.600 m, fixed in `CitadelWorld`) six regions wide, and this file was green
 * throughout because its own flood quoted the same 0.95.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT IS ASSERTED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. EVERY AUTHORED FLIGHT. `region.stairs[].rise` is the riser the builder
 *    actually laid, not the one it was asked for, so the helix - whose riser
 *    is discovered from the rock rather than solved - is measured on the same
 *    footing as the straight flights.
 *
 * 2. THE FLOOD, RE-RUN AT THE PLAYER'S STEP. Every `walk` edge in the graph is
 *    re-tested with `PLAYER_STEP` where `walkClear` uses `STEP_UP`, and the
 *    surviving edges plus climb and jump are unioned and flooded from the
 *    spawn. The SLOPE half of the rule is untouched: ground-to-ground is held
 *    to `WALK_GRADIENT` at both limits, because a slope is not a step and
 *    conflating them is a mistake this file has already made once and written
 *    up. Only the STEP branch tightens.
 *
 * 3. AND THE TWO THINGS A FLIGHT EXISTS FOR: every published tread and every
 *    deck the ring publishes is on the spawn's network AT THE PLAYER'S STEP.
 *    That is the assertion the 0.95 flood could not make.
 *
 * The kit's `STEP_UP` is left alone deliberately. It is the right number for
 * what it names - an NPC ground probe - and three other suites read it; the
 * player's step is a second ruler, not a correction to that one.
 */
const PLAYER_STEP = CONFIG.player.stepHeight;

/** `walkClear` with a limit passed in rather than quoted from a constant. */
function walkClearAt(idx, a, b, limit) {
  const dx = b.x - a.x; const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  const n = Math.max(1, Math.ceil(len / 1.0));
  const step = len / n;
  let y = a.y;
  let wasGround = !a.box && !a.owner;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const d = idx.deckAt(a.x + dx * t, a.z + dz * t, { below: y + limit + 1e-6 });
    if (!d) return false;
    const onGround = !d.owner;
    const lim = (wasGround && onGround) ? WALK_GRADIENT * step : limit;
    if (Math.abs(d.y - y) > lim) return false;
    y = d.y;
    wasGround = onGround;
  }
  return Math.abs(y - b.y) <= limit;
}

/** `walkRise` with the same limit substituted. */
function walkRiseAt(a, b, limit) {
  if (a.box || b.box || a.owner || b.owner) return limit;
  return Math.max(limit, WALK_GRADIENT * Math.hypot(b.x - a.x, b.z - a.z));
}

/** Union walk edges that survive `limit`, plus every climb and jump. */
function unionAt(graph, idx, limit) {
  const uf = new UnionFind(graph.nodes.length);
  let kept = 0; let cut = 0;
  for (const e of graph.edges) {
    if (e.kind === 'drop') continue;
    if (e.kind === 'walk') {
      const a = graph.nodes[e.a].pad; const b = graph.nodes[e.b].pad;
      if (Math.abs(a.y - b.y) > walkRiseAt(a, b, limit) || !walkClearAt(idx, a, b, limit)) { cut++; continue; }
      kept++;
    }
    uf.union(e.a, e.b);
  }
  return { uf, kept, cut };
}

/** Flood from the spawn at `limit`, and say what is left off by kind. */
function floodAt(graph, idx, spawn, limit) {
  const { uf, kept, cut } = unionAt(graph, idx, limit);
  const root = uf.find(spawn);
  const off = new Map();
  let inMain = 0;
  for (const n of graph.nodes) {
    if (uf.find(n.id) === root) { inMain++; continue; }
    for (const k of n.kind) off.set(k, (off.get(k) ?? 0) + 1);
  }
  return { uf, root, kept, cut, inMain, off };
}

test("FLOOR: every riser in the ring is inside the PLAYER's step, and the network survives it", async () => {
  const { world, idx, graph, spawn } = await measure();

  /* ---- 1. what the ring AUTHORS ---------------------------------------- */
  const flights = [];
  for (const r of world.regions ?? []) {
    for (const st of r.stairs ?? []) flights.push({ region: r.id, ...st });
  }
  /* A floor, not a count: the ring builds 35 straight flights and one helix,
   * and a change that stopped building stairs would otherwise pass this test
   * by having nothing left to measure. */
  assert.ok(flights.length >= 36,
    `only ${flights.length} flights published - this gate is measuring nothing`);
  const st = stats(flights.map((fl) => Math.abs(fl.rise)));
  console.log(`\n    ${flights.length} flights, ${flights.reduce((a, b) => a + b.steps, 0)} treads; `
    + `riser min ${st.min.toFixed(3)} mean ${st.mean.toFixed(3)} max ${st.max.toFixed(3)} `
    + `against a player step of ${PLAYER_STEP}`);
  const over = flights.filter((fl) => Math.abs(fl.rise) > PLAYER_STEP + 1e-9)
    .map((fl) => `${fl.region} ${fl.helix ? 'helix' : 'stair'} ${Math.abs(fl.rise).toFixed(3)} m`);
  assert.deepEqual(over, [],
    'a flight in the outer ring has a riser a player cannot step, and cannot mantle either - '
    + 'anything under Climb.MIN_RISE_GROUND = 1.0 m is refused. It is a flight of jumps.');

  /* ---- 2. the flood, at both rulers ------------------------------------ */
  const npc = floodAt(graph, idx, spawn, STEP_UP);
  const you = floodAt(graph, idx, spawn, PLAYER_STEP);
  const line = (name, r) => console.log(`    ${name.padEnd(22)} walk edges kept ${String(r.kept).padStart(6)} `
    + `cut ${String(r.cut).padStart(5)}   spawn component ${r.inMain}/${graph.nodes.length} `
    + `(${((100 * r.inMain) / graph.nodes.length).toFixed(2)}%)   off: `
    + `${[...r.off].map(([k, v]) => `${k}=${v}`).join(' ') || '(none)'}`);
  line(`NPC probe ${STEP_UP}`, npc);
  line(`player step ${PLAYER_STEP}`, you);

  /* A floor, and the same 99.5% `reach.count` is held to above. The point of
   * quoting it here is that it SURVIVES the tighter ruler. */
  assert.ok(you.inMain / graph.nodes.length >= 0.995,
    `only ${you.inMain}/${graph.nodes.length} nodes are on the spawn's network at the player's `
    + `step of ${PLAYER_STEP}; floor 99.5%`);

  /* ---- 3. and the two things a flight exists for ------------------------ */
  const count = (r) => {
    let treads = 0; let treadsOff = 0; let decks = 0; let decksOff = 0;
    const root = r.uf.find(spawn);
    for (const t of world._steps ?? []) {
      const id = graph.nodeFor(t.x, t.z, t.y + 0.5);
      if (id === undefined) continue;
      treads++;
      if (r.uf.find(id) !== root) treadsOff++;
    }
    for (const d of world._roofs ?? []) {
      if (!d.region) continue;
      const id = graph.nodeFor(d.x, d.z, d.y + 0.5);
      if (id === undefined) continue;
      decks++;
      if (r.uf.find(id) !== root) decksOff++;
    }
    return { treads, treadsOff, decks, decksOff };
  };
  const cNpc = count(npc);
  const cYou = count(you);
  console.log(`    treads resolved ${cYou.treads}, off the spawn network: ${cNpc.treadsOff} at ${STEP_UP} `
    + `and ${cYou.treadsOff} at ${PLAYER_STEP};  ring decks ${cYou.decks}, off: ${cNpc.decksOff} / ${cYou.decksOff}`);
  assert.ok(cYou.treads >= 500, `only ${cYou.treads} treads resolved to a node - the ring stopped publishing them`);
  assert.ok(cYou.decks >= 150, `only ${cYou.decks} ring decks resolved`);

  /* THE CLAIM, and it is a comparison rather than a zero.
   *
   * Tightening the step from the NPC's 0.95 to the player's 0.45 must not cost
   * a single tread or a single ring deck. It does not: both rulers leave the
   * same seven treads off the undirected walk+climb+jump component and no deck
   * at all, so the whole 0.40 m of difference is absorbed by the re-authored
   * flights rather than paid for by the player.
   *
   * The seven are pinned rather than fixed and they are NOT this pass's
   * subject: six are the aqueduct's high flight at y 29.4-32.1 and one is an
   * undercliff tread at y 30.76, and they read the same at both limits, so
   * they were never about the riser. They are entered by a `drop` edge, which
   * `components` does not union in either direction. */
  assert.equal(cYou.treadsOff, cNpc.treadsOff,
    `${cYou.treadsOff} treads are off the network at the player's step against ${cNpc.treadsOff} at `
    + `the NPC probe - a flight the ring builds is walkable only by something that is not the player`);
  assert.equal(cYou.decksOff, cNpc.decksOff,
    "a ring deck falls off the network when the ruler becomes the player's step");
  assert.equal(cYou.treadsOff, 7, 'the seven drop-entered treads, pinned; the number may fall, never rise');
  assert.equal(cYou.decksOff, 0, 'every ring deck is on the network the player is on');
});
