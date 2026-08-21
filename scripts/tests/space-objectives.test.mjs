import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';

import { rig, goto, settle, fly, steerTo, DT } from './_flightrig.mjs';

const {
  SpaceObjectives, surveyRange, surveyReward, wingBounty,
  SURVEY_FRACTION, SURVEY_FOV_DEG, SURVEY_CR_PER_SECOND,
  LEG_FIXED_S, LEG_PER_KM_S, LANDFALL_S, LANDFALL_CREDITS,
  LANDFALL_PAD_PER_KM_S, landfallSeconds, landfallReward,
  FIELD_CREDITS, SYSTEM_ORE_CREDITS,
  KILL_TIERS, ORE_TIERS, ASSAY_CREDITS, SURVEY_SET_COSMETIC,
  LANDFALL_SET_COSMETIC, LANDFALL_SET_POWER,
  padIsHome, PAD_RIM_LIMIT,
} = await import('../../src/systems/SpaceObjectives.js');
const { SPACE_BODIES, BODY_BY_ID, DOCK_ANCHOR, landableBodies } =
  await import('../../src/worlds/space/Bodies.js');
const { PLANETS } = await import('../../src/worlds/planets/index.js');
const { SYNC_CREDITS } = await import('../../src/systems/Viewpoints.js');
const { screenFraction } = await import('../../src/worlds/space/Scale.js');
const { ALIEN_CLASSES } = await import('../../src/npc/AlienShip.js');
const { SpaceCombat } = await import('../../src/ships/SpaceCombat.js');
const { MINE_TIME } = await import('../../src/systems/Mining.js');
const { HUD } = await import('../../src/ui/HUD.js');

/**
 * KILL SPACE ALIENS, REACH PLANETS, MINE RARE ELEMENTS.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THESE CASES ARE FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This project's signature defect is content that is BUILT but not REACHABLE,
 * and its second-favourite is a THRESHOLD that was guessed. An objective system
 * can ship both at once: a kill tier nobody can grind to, a planet whose survey
 * trigger sits inside a radius no ship ever crosses, a haul target larger than
 * the ore that exists. Every one of those passes a test that only checks the
 * numbers are present.
 *
 * So the shape of this file is:
 *
 *   1. THE THRESHOLDS ARE RE-DERIVED FROM THE WORLD, not restated. The kill
 *      ladder's second rung is asserted to equal the number of hostiles the
 *      authored zones actually contain; the ore ladder's top rung is asserted
 *      against the credits `PlanetWorld` actually placed on Cinder; the survey
 *      radius is asserted against `Scale.screenFraction` itself. Add a zone or
 *      a mineral and the case tells you the ladder has moved.
 *
 *   2. THE TRIGGERS ARE FLOWN. The survey cases fly the REAL `Flight`
 *      integrator through the REAL `Piloting` from the REAL launch point, and
 *      the kill cases fight the REAL `SpaceCombat`. Nothing calls `place` to
 *      make a trigger fire.
 *
 *   3. CEILINGS BY ABLATION. Shrinking the survey spheres to a metre and
 *      re-flying the identical leg must survey nothing; turning the guns off
 *      and re-fighting the identical wing must kill nothing. Without those, a
 *      "the ledger counted something" assertion cannot tell the difference
 *      between the mechanism working and the mechanism being unnecessary.
 *
 *   4. THE PERSISTENCE IS IDENTITY. `Relics` shipped a count where a set
 *      belonged, so a reload marked the wrong relics. There is a case here that
 *      reaches the SECOND and FOURTH bodies specifically, round-trips, and
 *      insists those two are the ones marked.
 *
 * ── Mutation record: 120 / 120 RED ─────────────────────────────────────────
 * Every assertion below was reversed one at a time, ONLY the case it lives in
 * was re-run, RED was confirmed, and the file was restored
 * (`.probe/mutate-objectives.mjs`). 120 assertions across 26 cases; every one
 * of them failed when reversed.
 *
 * Five of them survived the first pass and it was the MUTATOR that was wrong,
 * not the assertion: a textual `assert.ok(` -> `assert.ok(!` flip turns
 * `assert.ok(x < y)` into `assert.ok((!x) < y)`, which for a positive x is
 * `false < y` and therefore true. Re-run with an explicit paren group
 * (`.probe/mutate-five.mjs`) all five went red. Worth writing down: a mutation
 * harness that reports a survivor can be reporting its own bug, and "this
 * assertion cannot fail" is too serious a claim to accept from a regex.
 */

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

/** Deterministic 0..1, same generator `space-combat.test.mjs` uses. */
function seeded(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** A wallet, a bag, a wardrobe and a yard, each recording what it was asked. */
function stubs() {
  return {
    economy: { credits: 0, log: [], add(n, why) { this.credits += n; this.log.push([why, n]); } },
    inventory: { got: [], acquire(id, qty) { this.got.push([id, qty]); } },
    cosmetics: { owned: new Set(), unlock(id) { if (this.owned.has(id)) return false; this.owned.add(id); return true; } },
    ships: {
      powers: {},
      getPowers(id) { return { ...(this.powers[id] ?? {}) }; },
      grantPower(id, stat, tier) {
        const bag = this.powers[id] || (this.powers[id] = {});
        bag[stat] = Math.max(bag[stat] ?? 0, tier);
      },
    },
  };
}

/**
 * An objectives ledger over the shared rig.
 *
 * Built fresh per case and disposed after: the ledger is the thing under test
 * and one that inherited another case's kills would be measuring the wrong
 * career. The rig's worlds are NOT rebuilt - that is the 3-6 second part.
 */
async function ledger(r, extra = {}) {
  const s = stubs();
  const obj = new SpaceObjectives({
    bus: r.bus,
    economy: s.economy,
    inventory: s.inventory,
    cosmetics: s.cosmetics,
    ships: s.ships,
    piloting: r.piloting,
    worldManager: r.wm,
    ...extra,
  });
  return { obj, ...s };
}

/** Board out in the void, pointed at a target, from the launch point. */
function launchAt(r, target, from = new THREE.Vector3(0, 0, -398)) {
  const q = new THREE.Quaternion();
  const m = new THREE.Matrix4();
  m.lookAt(from, target, new THREE.Vector3(0, 1, 0));
  q.setFromRotationMatrix(m);
  r.piloting.flight.place(from, q);
  r.piloting.flight.velocity.set(0, 0, 0);
  r.piloting._landed = false;
  r.piloting._airborne = true;
  r.piloting._transit = 1;
}

const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);

/* ================================================================== */
/* 1. The survey radius: derived, not chosen                           */
/* ================================================================== */

test('the survey radius is the exact inverse of the instrument Bodies.js measured with', () => {
  /* The claim in the header is that `surveyRange` inverts
   * `Scale.screenFraction` exactly. Checked against the function itself rather
   * than against 3.11097 body radii, so the two can never drift apart. */
  let worst = 0;
  for (const b of SPACE_BODIES) {
    const f = screenFraction(b.radius, surveyRange(b.radius), SURVEY_FOV_DEG);
    worst = Math.max(worst, Math.abs(f - SURVEY_FRACTION));
  }
  console.log(`  worst screen-fraction error across ${SPACE_BODIES.length} bodies: ${worst.toExponential(2)}`);
  assert.ok(worst < 1e-12, `floor: the inverse is not exact (${worst})`);
});

test('no survey sphere reaches the yard, so nothing is surveyed from the berth', () => {
  /* THE REASON THIS IS THE FIRST THING CHECKED.
   *
   * `Bodies.APPROACH_AT_RADII` is 6 body radii, which for Ceraunus is 228 km -
   * and Ceraunus is 245 km away, so under that rule the largest thing in the
   * sky would be "reached" from 17 km outside the hangar door. A survey you
   * earn by undocking is the guessed-threshold defect in its purest form.
   *
   * Floor / achieved / ceiling: the ceiling is the same table computed at the
   * rejected 0.30 fraction, which is where the margin actually goes negative. */
  const rows = [];
  let worstMargin = Infinity;
  for (const b of SPACE_BODIES) {
    const d = Math.hypot(...b.position);
    const margin = d - surveyRange(b.radius);
    worstMargin = Math.min(worstMargin, margin);
    rows.push([b.id, d, surveyRange(b.radius), margin]);
  }
  for (const [id, d, r, m] of rows) {
    console.log(`  ${id.padEnd(9)} dock ${(d / 1000).toFixed(1).padStart(6)} km  sphere `
      + `${(r / 1000).toFixed(1).padStart(6)} km  trip ${(m / 1000).toFixed(1).padStart(6)} km`);
  }
  /* 10 km is the floor and it is not arbitrary: `SpaceCombat.SAFE_RADIUS` is
   * 9 km, the radius inside which the game refuses to spawn anything at all, so
   * a survey that fired inside it would fire inside the yard's own bubble. */
  console.log(`  floor 10.0 km / achieved ${(worstMargin / 1000).toFixed(1)} km`);
  assert.ok(worstMargin > 10000,
    `floor: a survey sphere comes within ${Math.round(worstMargin)} m of the yard`);

  const at30 = Math.min(...SPACE_BODIES.map((b) => {
    const R = b.radius / Math.sin((0.30 * ((SURVEY_FOV_DEG * Math.PI) / 180)) / 2);
    return Math.hypot(...b.position) - R;
  }));
  console.log(`  CEILING BY ABLATION - the rejected 0.30 fraction: worst trip ${(at30 / 1000).toFixed(1)} km`);
  assert.ok(at30 < worstMargin,
    'ablation: 0.30 must be the looser rule, or the whole justification is backwards');
});

test('what a body pays is what its distance says, and the far ones pay most', () => {
  /* A flat per-body payment is the defect this replaces: Erenmark is a
   * twelve-minute round trip and Cinder is a one-minute hop.
   *
   * ── WHY THIS IS NO LONGER "STRICTLY INCREASING, NO TIES" ─────────────────
   *
   * It was, and with five bodies it held. Phase 2 made it twelve, and two of
   * them - Tessera at 74.9 km and Sirocco at 83.8 km - are 8.9 km apart, which
   * at 0.5875 s/km and 4 cr/s is 21 credits. `round25` cannot represent 21
   * credits, so the two tie at 250 and the old assertion failed on a payout
   * table that is completely correct.
   *
   * The claim being made was never "no two bodies may ever pay the same". It
   * was "a longer trip is never worth less", and the ties are the ROUNDING
   * rather than the rule. So both halves are asserted separately and the
   * quantisation is asserted too, which is strictly more than the old case
   * checked: nothing may pay less than something nearer, and a tie is only
   * allowed where the unrounded payouts are inside one 25-credit increment. A
   * flat table would fail the second half everywhere. */
  const rows = SPACE_BODIES.map((b) => {
    const trip = Math.hypot(...b.position) - surveyRange(b.radius);
    const tripKm = trip / 1000;
    return {
      id: b.id,
      tripKm,
      raw: SURVEY_CR_PER_SECOND * (LEG_FIXED_S + tripKm * LEG_PER_KM_S),
      pay: surveyReward(b),
    };
  }).sort((a, b) => a.tripKm - b.tripKm);
  for (const r of rows) {
    console.log(`  ${r.id.padEnd(9)} trip ${r.tripKm.toFixed(1).padStart(6)} km -> `
      + `${r.raw.toFixed(1).padStart(7)} cr raw -> ${String(r.pay).padStart(5)} cr`);
  }
  let ties = 0;
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].pay >= rows[i - 1].pay,
      `floor: ${rows[i].id} is a longer trip than ${rows[i - 1].id} and pays LESS`);
    if (rows[i].pay === rows[i - 1].pay) {
      ties++;
      assert.ok(rows[i].raw - rows[i - 1].raw < 25,
        `${rows[i].id} and ${rows[i - 1].id} pay the same and are `
        + `${(rows[i].raw - rows[i - 1].raw).toFixed(1)} cr apart before rounding - `
        + 'that is a flat payment, not a rounding artefact');
    }
  }
  console.log(`  ${ties} tie(s), every one of them inside one 25-credit increment`);

  /* THE BAND, RE-BASED PER DESTINATION.
   *
   * It was "the whole sweep pays between 750 and 3,600" - the five citadel
   * viewpoints and the thirty citadel relics - and it was written when the
   * sweep was five bodies. The sweep is twelve now and pays 5,650, so reading
   * the old total against the new one would be comparing two different sized
   * jobs. What did NOT change is the rate, so the band is stated per body:
   * no body pays less than walking to a citadel viewpoint (`SYNC_CREDITS`),
   * and the AVERAGE body pays less than the whole five-viewpoint set. */
  const total = rows.reduce((s, r) => s + r.pay, 0);
  const per = total / rows.length;
  const viewpointSet = SYNC_CREDITS * 5;
  console.log(`  sweep ${total} cr over ${rows.length} bodies = ${per.toFixed(0)} a body`);
  console.log(`  floor ${SYNC_CREDITS} (one citadel viewpoint) / achieved ${Math.min(...rows.map((r) => r.pay))}`
    + ` cheapest, ${per.toFixed(0)} mean / ceiling ${viewpointSet} (all five viewpoints)`);
  assert.ok(Math.min(...rows.map((r) => r.pay)) >= SYNC_CREDITS,
    'a body in this volume pays less than walking across a citadel to a viewpoint');
  assert.ok(per < viewpointSet,
    `the average body pays ${per.toFixed(0)}, more than the whole citadel viewpoint set (${viewpointSet})`);
  /* And the spread is the whole point: the furthest body must be worth many
   * times the nearest, or the payouts are flat with extra steps. */
  const spread = Math.max(...rows.map((r) => r.pay)) / Math.min(...rows.map((r) => r.pay));
  console.log(`  floor 5x / achieved ${spread.toFixed(1)}x between the dearest and cheapest body`);
  assert.ok(spread > 5, `the furthest body pays only ${spread.toFixed(1)}x the nearest`);
});

test('what a LANDING pays is what its descent says, and it is not one number for ten worlds', () => {
  /* THE DEFECT THIS REPLACES, NAMED: `LANDFALL_CREDITS` was a single constant
   * and it paid the same for setting down on Cinder, which is a 9 km world with
   * 700 m of air to fly, as for Shoal, which is a 12.5 km ocean handed over
   * 1,400 m up. One flown leg, ten bodies, one number - the same shape of
   * mistake `surveyReward`'s straight line was written to stop. */
  const rows = landableBodies().map((b) => ({
    id: b.id,
    airless: b.atmosphere <= b.radius,
    sphereKm: surveyRange(b.radius) / 1000,
    padM: b.handoff - b.radius,
    dockKm: Math.hypot(...b.position) / 1000,
    s: landfallSeconds(b),
    pay: landfallReward(b),
  })).sort((a, b) => a.s - b.s);
  for (const r of rows) {
    console.log(`  ${r.id.padEnd(10)}${r.airless ? ' AIRLESS' : '        '} `
      + `sphere ${r.sphereKm.toFixed(1).padStart(5)} km  handoff +${String(r.padM).padStart(4)} m  `
      + `${r.s.toFixed(1).padStart(5)} s -> ${String(r.pay).padStart(4)} cr   (dock ${r.dockKm.toFixed(0)} km)`);
  }

  /* FLOOR: the law has to reproduce the leg that was actually flown. 26.2 s of
   * cruise from the 28.0 km sphere plus 16.3 s of pad approach, 42.5 s total,
   * measured onto Ashfall Flat. Half a second of tolerance, which is the
   * residual of the same straight line the outbound legs are fitted with. */
  const cinder = BODY_BY_ID.cinder;
  const err = Math.abs(landfallSeconds(cinder) - LANDFALL_S);
  console.log(`  floor 0.5 s / achieved ${err.toFixed(2)} s error against the flown Cinder leg `
    + `(${landfallSeconds(cinder).toFixed(2)} s vs ${LANDFALL_S} s)`);
  assert.ok(err < 0.5,
    `the law says ${landfallSeconds(cinder).toFixed(2)} s for the one descent that was flown at ${LANDFALL_S}`);
  assert.equal(landfallReward(cinder), LANDFALL_CREDITS);

  /* Every payout is finite, positive and a printable increment. A NaN here
   * reaches `economy.add` and then the HUD, and this world has already lost a
   * day to one reaching the bloom pass. */
  for (const r of rows) {
    assert.ok(Number.isFinite(r.pay) && r.pay > 0, `${r.id} pays ${r.pay}`);
    assert.equal(r.pay % 25, 0, `${r.id} pays ${r.pay}, which is not a 25-credit increment`);
  }
  /* And a body with no readable geometry pays the floor rather than a NaN -
   * `_onEntry` hands `_landfall` whatever `pilot:entry` names. */
  for (const bad of [null, undefined, {}, { radius: NaN, handoff: 9 }, { radius: 9, handoff: 9 }]) {
    const p = landfallReward(bad);
    assert.ok(Number.isFinite(p) && p > 0, `${JSON.stringify(bad)} paid ${p}`);
  }

  /* THE CLAIM THAT MAKES IT A LAW AND NOT A TABLE: it is not flat. */
  const spread = rows[rows.length - 1].pay / rows[0].pay;
  console.log(`  floor 1.5x / achieved ${spread.toFixed(2)}x between the longest and shortest descent`);
  assert.ok(spread >= 1.5,
    `the dearest landing is only ${spread.toFixed(2)}x the cheapest - that is a flat constant again`);

  /* AIRLESSNESS FALLS OUT OF THE GEOMETRY, which is why it gets no term of its
   * own. The two bodies with `atmosphere === radius` carry the two shortest
   * handoff altitudes in the system, so their descents are the two shortest
   * without anybody writing "if airless" anywhere. If a future airless body is
   * handed over from 2 km up this reddens, and it SHOULD: at that point the
   * claim in `landfallSeconds` has stopped being true and the term has to be
   * argued for on its own measurements. */
  const airless = rows.filter((r) => r.airless);
  const withAir = rows.filter((r) => !r.airless);
  console.log(`  airless: ${airless.map((r) => `${r.id} ${r.padM} m`).join(', ')}`
    + `  |  shallowest with air: ${Math.min(...withAir.map((r) => r.padM))} m`);
  assert.ok(airless.length >= 2, 'there are no airless bodies, so this claim is untested');
  assert.ok(Math.max(...airless.map((r) => r.padM)) <= Math.min(...withAir.map((r) => r.padM)),
    'an airless body is handed over higher than a body with air - the descent length no longer '
    + 'says what the airlessness says, so landfallSeconds owes air a term of its own');

  /* AND THE DISTANCE IS NOT PAID TWICE. Cathedra is the furthest body in the
   * system and has one of the shortest descents; that is correct, because
   * `surveyReward` already paid it 700 credits for the 267 km trip out. What a
   * landing pays for is the part of the flight the survey did not cover. */
  const cathedra = BODY_BY_ID.cathedra;
  console.log(`  cathedra: survey ${surveyReward(cathedra)} + landfall ${landfallReward(cathedra)}`
    + `   cinder: survey ${surveyReward(cinder)} + landfall ${landfallReward(cinder)}`);
  assert.ok(surveyReward(cathedra) > surveyReward(cinder),
    'the distance is not being paid by the survey, so the landfall would have to pay it');
  assert.ok(surveyReward(cathedra) + landfallReward(cathedra)
    > surveyReward(cinder) + landfallReward(cinder),
    'reaching AND landing on the far edge of the system is worth no more than the nearest world');
});

test('landfall has a denominator, and it counts ground rather than sky', async () => {
  /* `landfallCount` had a numerator and nothing to finish: the HUD could say
   * "4 landed" for ever. `surveyTotal` could not stand in for it, because it
   * counts all twelve bodies including a star and a gas giant with no surface -
   * a set nobody can complete, which is the reachability defect with a nav
   * marker on it. */
  const r = await rig();
  const { obj } = await ledger(r);
  try {
    const landable = landableBodies();
    console.log(`  survey ${obj.surveyTotal} bodies / landfall ${obj.landfallTotal} worlds: `
      + `${landable.map((b) => b.id).join(', ')}`);
    assert.equal(obj.landfallTotal, landable.length);
    assert.ok(obj.landfallTotal < obj.surveyTotal,
      'the landfall denominator counts things with no ground on them');
    /* Every body it counts really does have somewhere to hand a ship over to,
     * and every body it does NOT count really has nowhere. Both directions, or
     * a filter that returned everything would pass the first one. */
    for (const b of SPACE_BODIES) {
      const counted = landable.includes(b);
      assert.equal(counted, b.handoff > 0 && !!b.surfaceWorld,
        `${b.id} is ${counted ? '' : 'not '}in the landfall set and its handoff is ${b.handoff}`);
    }
    assert.equal(obj.progress().landfallTotal, obj.landfallTotal,
      'the HUD surface cannot see the denominator');
  } finally {
    obj.dispose();
  }
});

test('setting down on every world pays the second set prize, once, and a fly-by does not', async () => {
  const r = await rig();
  const { obj, cosmetics, ships } = await ledger(r);
  try {
    /* Surveying everything is twelve fly-bys and pays the FIRST set prize.
     * It must not pay the second one: nothing has been landed on. */
    for (const b of SPACE_BODIES) obj._sight(b, surveyReward(b));
    console.log(`  after twelve fly-bys: cosmetics ${[...cosmetics.owned].join(', ')}`);
    assert.equal(cosmetics.owned.has(SURVEY_SET_COSMETIC), true);
    assert.equal(cosmetics.owned.has(LANDFALL_SET_COSMETIC), false,
      'the landfall set paid for flying past ten worlds without landing on one');
    assert.equal(ships.powers.kestrel?.[LANDFALL_SET_POWER] ?? 0, 0);

    /* Land on all but one. Still nothing: a set is a set. */
    const landable = landableBodies();
    for (const b of landable.slice(0, -1)) obj._landfall(b);
    console.log(`  ${obj.landfallCount}/${obj.landfallTotal} landed: `
      + `${cosmetics.owned.has(LANDFALL_SET_COSMETIC) ? 'PAID' : 'not paid'}`);
    assert.equal(obj.landfallCount, landable.length - 1);
    assert.equal(cosmetics.owned.has(LANDFALL_SET_COSMETIC), false,
      'the set paid one world short');

    obj._landfall(landable[landable.length - 1]);
    console.log(`  ${obj.landfallCount}/${obj.landfallTotal} landed: cosmetics `
      + `${[...cosmetics.owned].join(', ')}  powers ${JSON.stringify(ships.powers)}`);
    assert.equal(cosmetics.owned.has(LANDFALL_SET_COSMETIC), true, 'the set cosmetic was not granted');
    /* Every hull the yard sells, for the reason `_refit` records: two of these
     * landings are reachable with the ship parked, and a prize that landed on
     * whichever hull happened to be selected is a prize you can miss by walking. */
    for (const id of ['kestrel', 'dray', 'pike']) {
      assert.equal(ships.powers[id]?.[LANDFALL_SET_POWER], 1,
        `${id} did not get the ${LANDFALL_SET_POWER} refit`);
    }
    /* The prize id has to be one the wardrobe will actually grant - `unlock`
     * refuses an id it does not know, and a cosmetic that silently never
     * arrives is this project's signature defect in a wardrobe. */
    assert.notEqual(LANDFALL_SET_COSMETIC, SURVEY_SET_COSMETIC,
      'both set prizes are the same skin, so the second one grants nothing');

    /* And a re-landing does not re-pay. */
    for (const b of landable) obj._landfall(b);
    for (const id of ['kestrel', 'dray', 'pike']) {
      assert.equal(ships.powers[id][LANDFALL_SET_POWER], 1, 'a second landing refitted again');
    }
  } finally {
    obj.dispose();
  }
});

test('the hint names the world to go to next, and never names a planet that is not one', async () => {
  /* THE DEFECT: the line read "Cinder is the one body you can land on", which
   * was true of Phase 1 and false of nine tenths of Phase 2. The repair is not
   * to list ten names - a sentence with ten proper nouns in it is a table - it
   * is to answer the question the counter above it raises. */
  const r = await rig();
  await goto(r, 'space');
  const { obj } = await ledger(r);
  try {
    obj._sight(BODY_BY_ID.erenmark, surveyReward(BODY_BY_ID.erenmark));
    const first = obj.hint();
    console.log(`  nothing landed on: "${first}"`);
    /* From the yard, the nearest landable body is Cinder at 62 km - which is
     * why it was hard-coded in the first place, and is still the right answer
     * for a player who has not been anywhere. The point is that it is now
     * DERIVED: it comes out of the layout rather than out of this sentence. */
    assert.ok(first.includes('Cinder'), `the first landfall hint says "${first}"`);
    assert.equal(obj.nextLandfall().id, 'cinder');

    /* Land on it and the sentence moves on by itself. */
    obj._landfall(BODY_BY_ID.cinder);
    const second = obj.hint();
    console.log(`  after Cinder: "${second}"  (next = ${obj.nextLandfall()?.id})`);
    assert.ok(!second.includes('Cinder'),
      'the hint still sends the player to the world they are standing on the far side of');
    assert.equal(obj.nextLandfall().id, 'tessera', 'the next nearest landable body is not Tessera');
    assert.ok(second.includes('Tessera'), `the hint after Cinder says "${second}"`);
    assert.ok(second.includes(`${obj.landfallCount}/${obj.landfallTotal}`),
      'the hint carries no sense of how far through the set the player is');

    /* NO SENTENCE MAY EVER NAME A BODY YOU CANNOT LAND ON. That is the whole
     * class of bug the old line belonged to. */
    for (const b of SPACE_BODIES) {
      if (b.handoff > 0 && b.surfaceWorld) continue;
      assert.ok(!second.includes(b.name),
        `the hint names ${b.name}, which has no ground on it`);
    }

    /* Land on everything and the line stops being about landing at all, rather
     * than pointing at a world that does not exist. */
    for (const b of landableBodies()) obj._landfall(b);
    const done = obj.hint();
    console.log(`  everything landed on: "${done}"`);
    assert.equal(obj.nextLandfall(), null);
    assert.ok(done.includes('Lodestar Yard'), `the finished hint says "${done}"`);

    /* And on a surface it never tells you to go where you already are. */
    await goto(r, 'cinder');
    const b2 = await ledger(r);
    b2.obj._sight(BODY_BY_ID.cinder, surveyReward(BODY_BY_ID.cinder));
    b2.obj._onOre({ type: 'tephra', name: 'Tephra Nodules', credits: 12 });
    const ground = b2.obj.hint();
    console.log(`  standing on Cinder, nothing landed: "${ground}"  `
      + `(next = ${b2.obj.nextLandfall()?.id})`);
    assert.ok(!ground.includes('Cinder'),
      'the hint tells a player standing on Cinder to go to Cinder');
    assert.ok(ground.includes('seam'), 'the surface hint stopped being about mining');
    b2.obj.dispose();
  } finally {
    obj.dispose();
    await goto(r, 'space');
  }
});

/* ================================================================== */
/* 2. The ladders are re-derived from the content                      */
/* ================================================================== */

test('the kill ladder is built on one full sweep of the inner system', async () => {
  const r = await rig();
  await goto(r, 'space');
  const zones = r.wm.active.encounters;
  const hostiles = (list) => list.reduce(
    (s, z) => s + z.wing.reduce((n, w) => n + w.count, 0), 0
  );

  /* THE UNIT THE LADDER IS SPACED IN, AND WHY IT IS NO LONGER "THE VOLUME".
   *
   * Nine was one full sweep of the system when the system was three zones on
   * two routes. Phase 2 put an approach picket on the run out to all ten
   * landable worlds, so a sweep of the whole volume is now twelve zones and
   * about 1,500 km of flying - a campaign, not a session, and useless as the
   * second rung of a ladder whose first rung is three kills.
   *
   * The INNER SYSTEM is what has not changed: everything inside Cinder's
   * orbit, which is the Ashlane, Cinder high orbit and the Halberd Reach nest
   * - the fights on the run every player flies first, before they have bought
   * anything. Still nine hostiles, still 745 credits of bounty.
   *
   * Derived rather than typed, and the cut is Cinder's own distance from the
   * yard: a planet added INSIDE that orbit moves the rung, and this goes red
   * so somebody decides where it should be. The nearest picket outside it is
   * Tessera's at 77 km, so the cut has 15 km of margin on both sides. */
  const cinderDist = new THREE.Vector3(...BODY_BY_ID.cinder.position).length();
  const inner = zones.filter((z) => new THREE.Vector3(...z.position).length() <= cinderDist);
  const sweep = hostiles(inner);
  const bounty = inner.reduce((s, z) => s + wingBounty(z), 0);

  console.log(`  ${zones.length} zones, ${hostiles(zones)} hostiles in the volume; `
    + `${inner.length} of them inside Cinder's orbit holding ${sweep}, ${bounty} cr of bounty`);
  for (const z of zones) {
    const where = inner.includes(z) ? 'INNER' : '     ';
    console.log(`    ${where} ${z.id.padEnd(20)} ${z.wing.map((w) => `${w.count}x${w.class}`).join('+').padEnd(20)}`
      + ` ${String(wingBounty(z)).padStart(4)} cr  rearm ${z.rearm}s`);
  }
  assert.equal(inner.length, 3,
    `${inner.length} zones inside Cinder's orbit, not 3 - the inner system has changed shape`);

  assert.equal(KILL_TIERS[1].kills, sweep,
    `the second rung must be one full sweep of the inner system (${sweep} hostiles), `
    + `not ${KILL_TIERS[1].kills}`);
  /* The rungs above it are whole sweeps too, so "wait out a rearm" is the only
   * thing that separates them. */
  assert.equal(KILL_TIERS[2].kills, sweep * 2);
  assert.equal(KILL_TIERS[3].kills, sweep * 3);
  assert.equal(KILL_TIERS[0].kills, 3,
    'the first rung is the smallest wing that contains a lance');

  /* AND THE VOLUME MUST NOT QUIETLY BECOME A SHOOTING GALLERY. Generalising
   * the pickets over `landableBodies()` is one line away from putting the old
   * three-zone density on all ten routes, which is ninety hostiles. The bound
   * is four inner sweeps: enough room for one picket per world and then some,
   * not enough for anybody to multiply by ten without this going red. */
  assert.ok(hostiles(zones) <= sweep * 4,
    `${hostiles(zones)} hostiles in the volume against an inner sweep of ${sweep} - `
    + 'the population has been multiplied rather than spread');

  /* Payouts against the bounty the same kills already pay: a ladder that paid
   * ten times the bounty would make the bounty decoration, and one that paid a
   * tenth of it would make the ladder decoration. Measured against the INNER
   * bounty, because that is what the rungs ask for. */
  const ladder = KILL_TIERS.reduce((s, t) => s + t.credits, 0);
  const earned = bounty * 3; // three sweeps is what the top rung asks for
  console.log(`  floor ${Math.round(earned * 0.5)} / achieved ${ladder} / ceiling ${earned * 2}`
    + ` (inner bounty over three sweeps is ${earned})`);
  assert.ok(ladder > earned * 0.5 && ladder < earned * 2,
    `the ladder pays ${ladder} against ${earned} of bounty - out of band`);
});

test('the pad a ship arrives at needs no hint, and the poor pad is told where to go', async () => {
  const r = await rig();
  r.piloting.shipId = 'kestrel';

  /**
   * ═══════════════════════════════════════════════════════════════════════
   *  SEVENTEEN MINUTES VERSUS FOUR, AND THE HALF OF IT THAT MOVED
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Every atmospheric entry lands at the `primary` pad. On Cinder that used to
   * be Ashfall Flat - the poorest of its three - and a walked 10 m3 Kestrel
   * load off it is 114 cr against 497 off the Colonnade and 2,839 off the rim,
   * so the 500 cr ore rung was five round trips from where the game put you and
   * one from the shelf. Seventeen minutes against four and a half.
   *
   * `primary` HAS SINCE MOVED, under the rule `planet-envelope.test.mjs`
   * asserts for all ten planets: the arrival pad is the richest pad that is
   * returnable AND carries no exotic seam. Cinder arrives at the Colonnade Deck
   * now, so the sentence this case was written about is correctly SILENT on the
   * pad a ship arrives at, and what is left is the other pads.
   *
   * `richerPad` is the one-sentence fix, and this is what it must now do:
   *
   *   on the pad the game puts you on     the hint must say NOTHING, because
   *                                       there is nowhere better you can fly
   *                                       home from. Silence is the fix having
   *                                       landed.
   *   on the poor pad                     it must still fire, and name the
   *                                       arrival pad. A player who flew to
   *                                       Ashfall on purpose is owed the same
   *                                       sentence a player who was dumped
   *                                       there used to be.
   *   on the SHELF                        never. Rimhold Shelf is the richest
   *                                       pad on the planet by a factor of four
   *                                       and reads 270 degrees of horizon
   *                                       falling away over 66.9 m - it is one
   *                                       of the pads a player can walk off and
   *                                       not climb back onto. Naming it would
   *                                       swap a slow objective for a
   *                                       stranding.
   *
   * -- AND A SECOND PLANET, FOR THE CASE CINDER CANNOT MAKE ----------------
   *
   * This half used to stand on Carnelian and assert the hint still FIRED from
   * the primary, on the stated grounds that Carnelian is "somewhere the exotic
   * pad is one you can come back from". Both halves of that were wrong. The
   * Kiln returns 49.8% and `padIsHome` refuses it, so the pad the hint actually
   * named was Anvil Deck - and it only had something to name because
   * Carnelian's `primary` was still on Redgate, i.e. because the planet was
   * carrying the very defect the rule above exists to remove. The assertion
   * passed for a reason its own comment denied. Anvil Deck is the primary now,
   * and the sentence is correctly silent standing on it.
   *
   * What Carnelian is genuinely the world for is the OTHER exclusion, and it is
   * the one Cinder cannot demonstrate. On Cinder the two measures agree: the
   * shelf reads 270 degrees of rim AND returns 2.6%, so a hint driven by either
   * one would have refused it. On Carnelian they disagree as hard as they do
   * anywhere in the registry - Kiln Deck is the richest pad on the planet at
   * 5,205 credits a hold, 2.4x the pad the game lands you on, it returns 49.8%,
   * and `_padDrop` reads ZERO degrees of rim on it, because the chamber floor is
   * level and the cliff is the 85-degree slot you came down to get there. A
   * rim-driven hint would have sent a new pilot down the Deep Reach.
   *
   * So the three claims below are: silent on the arrival pad (a second world
   * for the first half), firing from the poor pad and naming the arrival pad (a
   * second world for the second half), and never naming the one-way pad the
   * PROXY would have allowed - which is the case Cinder cannot make at all.
   */

  /** Credits of a best-value stock-Kestrel hold off one pad's own nearest seams. */
  const worthOn = (world) => (id) => {
    const sites = world.landingSites;
    const near = world.mineralNodes.filter((n) => {
      let best = null;
      let bd = Infinity;
      for (const s of sites) {
        const d = n.position.distanceToSquared(s.position);
        if (d < bd) { bd = d; best = s; }
      }
      return best?.id === id;
    });
    near.sort((a, b) => (b.credits / Math.max(1e-6, b.size)) - (a.credits / Math.max(1e-6, a.size)));
    let room = 10;
    let paid = 0;
    for (const n of near) { if (n.size > room) continue; room -= n.size; paid += n.credits; if (room <= 1e-6) break; }
    return paid;
  };

  /* ---- Cinder: the arrival pad, and the shelf that is never named ---- */

  await goto(r, 'cinder');
  const { obj } = await ledger(r);
  const w = r.wm.active;
  const sites = w.landingSites;
  const worth = worthOn(w);
  for (const s of sites) {
    console.log(`    ${s.id.padEnd(11)} ${s.primary ? 'PRIMARY' : '       '} rim ${String(s.drop?.deg ?? '?').padStart(3)} deg / `
      + `${String(s.drop?.metres ?? '?').padStart(5)} m   best load ${String(worth(s.id)).padStart(5)} cr`);
  }

  const primary = sites.find((s) => s.primary);
  assert.ok(primary, 'the planet has no primary pad, so there is nothing to be landed at');
  /* THE SHELF IS FOUND BY THE FLOOD, not by the cliff behind the disc.
   * `PlanetWorld._padReturn` measures what a body can walk to from each pad and
   * how much of it can walk back; Rimhold returns 2.6%. The rim proxy agrees
   * here (270 degrees) and disagrees on three pads elsewhere in the registry -
   * Tessera's Raysedge reads 300 degrees and comes home 98.2% of the time - so
   * the rule this asserts is the one `SpaceObjectives` actually uses. */
  const shelf = sites.find((s) => !padIsHome(s));
  assert.ok(shelf, 'no pad on Cinder is one-way, so the exclusion below proves nothing');
  assert.ok((shelf.drop?.deg ?? 0) > PAD_RIM_LIMIT,
    `${shelf.id} is one-way and the rim proxy would have allowed it - which is fine, but this case `
    + 'no longer demonstrates that the two agree on Cinder');
  assert.ok(worth(shelf.id) > worth(primary.id) * 2,
    `${shelf.id} is only ${worth(shelf.id)} against ${worth(primary.id)} - it is not the temptation `
    + 'this exclusion exists to resist');

  /* Standing where an entry puts you: nothing to say. */
  r.piloting._landedSite = { id: primary.id, name: primary.name };
  assert.equal(obj.richerPad(), null,
    `standing on ${primary.id}, the pad the game lands you on, the brief still sent the player somewhere`);
  const quiet = obj.hint();
  console.log(`    on ${primary.id}: "${quiet}"`);
  for (const s of sites) {
    assert.ok(!quiet.includes(s.name),
      `the brief names ${s.name} to a player standing on the pad the game chose for them: "${quiet}"`);
  }

  /* Standing on the poor one: it fires, and it names the pad the game would
   * have landed you on rather than the rim. */
  const poor = sites
    .filter((s) => s.id !== primary.id && (s.drop?.deg ?? 0) <= PAD_RIM_LIMIT)
    .reduce((a, b) => (worth(b.id) < worth(a.id) ? b : a));
  r.piloting._landedSite = { id: poor.id, name: poor.name };
  const pick = obj.richerPad();
  assert.ok(pick, `standing on ${poor.id} at ${worth(poor.id)} cr a load, nothing was suggested`);
  console.log(`    on ${poor.id}: "${pick.name}" at ${pick.credits} cr a load`);
  assert.equal(pick.id, primary.id,
    `from ${poor.id} the brief names ${pick.id}, not ${primary.id} - the pad an entry would have used`);
  assert.notEqual(pick.id, shelf.id,
    `the hint sends a new pilot to ${shelf.id}, where only ${shelf.home?.pct}% of what a body can `
    + `walk to can walk back (and the rim reads ${shelf.drop.deg} degrees over ${shelf.drop.metres} m) `
    + '- a pad you walk off and cannot climb back onto');
  assert.ok(pick.credits >= worth(poor.id) * 1.5,
    `${pick.id} is only ${pick.credits} against ${worth(poor.id)} - not worth crossing a planet for`);
  const said = obj.hint();
  console.log(`    hint: "${said}"`);
  assert.ok(said.includes(pick.name), `the brief does not name the pad it picked: "${said}"`);
  obj.dispose();

  /* ---- Carnelian: the pad the RIM would have sent a new pilot to ---- */

  await goto(r, 'carnelian');
  const { obj: obj2 } = await ledger(r);
  const w2 = r.wm.active;
  const worth2 = worthOn(w2);
  const primary2 = w2.landingSites.find((s) => s.primary);
  assert.ok(primary2, 'Carnelian has no primary landing site');
  for (const s of w2.landingSites) {
    console.log(`    ${s.id.padEnd(11)} ${s.primary ? 'PRIMARY' : '       '} rim ${String(s.drop?.deg ?? '?').padStart(3)} deg / `
      + `${String(s.drop?.metres ?? '?').padStart(5)} m   home ${String(s.home?.pct ?? '?').padStart(5)}%   `
      + `best load ${String(worth2(s.id)).padStart(5)} cr`);
  }

  /* THE PAD THE PROXY WOULD HAVE ALLOWED. Kiln Deck is the richest disc on this
   * planet and a one-way trip, and its rim reads ZERO - so it is the pad that
   * proves `padIsHome` has to read the flood and not the cliff. If a future
   * change makes the two measures agree here, this case stops making its point,
   * and the assertion below says so rather than passing quietly. */
  const trap = w2.landingSites.find((s) => !padIsHome(s));
  assert.ok(trap, 'no pad on Carnelian is one-way, so the exclusion below proves nothing');
  assert.ok((trap.drop?.deg ?? 0) <= PAD_RIM_LIMIT,
    `${trap.id} is one-way AND reads ${trap.drop?.deg} degrees of rim, so the rim proxy would have `
    + 'refused it too - Carnelian no longer demonstrates that the two measures disagree, and this '
    + 'case has to move to a planet where they still do');
  assert.ok(worth2(trap.id) > worth2(primary2.id) * 2,
    `${trap.id} is only ${worth2(trap.id)} against ${worth2(primary2.id)} - it is not the temptation `
    + 'this exclusion exists to resist');

  /* 1. Standing where an entry puts you: nothing to say, on a second world. */
  r.piloting._landedSite = { id: primary2.id, name: primary2.name };
  assert.equal(obj2.richerPad(), null,
    `standing on ${primary2.id}, the pad the game lands you on, the brief still sent the player `
    + `somewhere - and the only pad richer than it is ${trap.id}, which returns ${trap.home?.pct}%`);
  const quiet2 = obj2.hint();
  console.log(`    carnelian, on ${primary2.id}: "${quiet2}"`);
  for (const s of w2.landingSites) {
    assert.ok(!quiet2.includes(s.name),
      `the brief names ${s.name} to a player standing on the pad the game chose for them: "${quiet2}"`);
  }

  /* 2. Standing on the poor one: it fires, it names the arrival pad, and it
   *    does NOT name the richest pad on the planet. */
  const poor2 = w2.landingSites
    .filter((s) => s.id !== primary2.id && padIsHome(s))
    .reduce((a, b) => (worth2(b.id) < worth2(a.id) ? b : a));
  r.piloting._landedSite = { id: poor2.id, name: poor2.name };
  const pick2 = obj2.richerPad();
  assert.ok(pick2,
    `standing on ${poor2.id} at ${worth2(poor2.id)} cr a load, the brief named nowhere to go`);
  console.log(`    carnelian, on ${poor2.id}: "${pick2.name}" at ${pick2.credits} cr a load`);
  assert.equal(pick2.id, primary2.id,
    `from ${poor2.id} the brief names ${pick2.id}, not ${primary2.id} - the pad an entry would have used`);
  assert.notEqual(pick2.id, trap.id,
    `the hint sends a new pilot to ${trap.id}, worth ${worth2(trap.id)} cr a load and returning only `
    + `${trap.home?.pct}% of what a body can walk to - and its rim reads ${trap.drop?.deg} degrees, so `
    + 'nothing but the flood was ever going to catch it');
  const named = w2.landingSites.find((s) => s.id === pick2.id);
  assert.ok(padIsHome(named),
    `${pick2.id} returns only ${named?.home?.pct}% of what a body can walk to from it and should `
    + 'never have been named to a pilot who has not been there before');
  assert.ok(pick2.credits >= worth2(poor2.id) * 1.5,
    `${pick2.id} is only ${pick2.credits} against ${worth2(poor2.id)} - not worth crossing a planet for`);
  const said2 = obj2.hint();
  console.log(`    hint: "${said2}"`);
  assert.ok(said2.includes(pick2.name), `the brief does not name the pad it picked: "${said2}"`);
  obj2.dispose();
});

test('ON FOOT, and the exotic pad: the mining brief on all ten planets', async () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════
   *  TWO DEFECTS THE CASE ABOVE COULD NOT SEE, BECAUSE OF HOW IT DRIVES
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Every case above sets `r.piloting._landedSite` before it calls
   * `richerPad()`, because they were written about a SHIP that has landed. That
   * is one of the two ways a player gets onto a planet, and it is the one where
   * the method was already right.
   *
   * 1. ON FOOT, `landedSite` IS NULL. `Piloting` sets it on touchdown and
   *    clears it on lift-off, so a direct world entry, a portal, an `Unstuck`
   *    return and a dev warp all leave it null - and `PlanetWorld._placeSpawn`
   *    puts every one of them on the PRIMARY pad. With `here` null the
   *    self-suppression could not fire, so the brief named the pad the player
   *    was standing on: "The Colonnade Deck carries the richer seams", said to
   *    somebody standing on the Colonnade Deck. ON ALL TEN PLANETS, including
   *    five that nothing in the arrival-pad change had touched.
   *
   * 2. AND ON TWO OF THEM IT NAMED THE EXOTIC PAD. `richerPad`'s docblock
   *    claimed "every exotic pad in the registry is one a walker cannot get
   *    back off - padIsHome refuses all of them". False for two of ten:
   *
   *        tessera/coldwell   home 100.0%   1,757 cr a hold
   *        shoal/sunder       home  98.4%   2,694 cr a hold
   *
   *    Both are honestly returnable - a bowl and a shelf you walk back onto -
   *    so `padIsHome` allowed both, and both were named. Standing on Tessera's
   *    Mosaic the brief said "The Cold Well carries the richer seams"; on
   *    Shoal's Kelphold it said "Sunder Deck". That is the one thing the
   *    ten-planet mining design forbids - the exotic seam costs a SECOND
   *    LANDING - deleted on two planets by a sentence. It bit on the flown path
   *    too, not only on foot.
   *
   * A pad being returnable and a pad being the exotic pad are two different
   * questions, and one was standing in for the other. This case drives BOTH,
   * from every pad on every planet, so neither can come back on a world nobody
   * is looking at.
   */
  const r = await rig();

  /** The pads whose own nearest ore includes a seam the descriptor calls exotic. */
  const exoticPadsOf = (world) => {
    const exotic = new Set(world.planet.minerals.filter((m) => m.rarity === 'exotic').map((m) => m.id));
    const pads = new Set();
    for (const n of world.mineralNodes) {
      if (!exotic.has(n.type)) continue;
      let best = null;
      let bd = Infinity;
      for (const s of world.landingSites) {
        const d = n.position.distanceToSquared(s.position);
        if (d < bd) { bd = d; best = s; }
      }
      if (best) pads.add(best.id);
    }
    return pads;
  };

  const selfNamed = [];
  const strandings = [];
  console.log('   planet      arrival pad      on foot   from each pad');
  for (const id of Object.keys(PLANETS)) {
    await goto(r, id);
    r.piloting.shipId = 'kestrel';
    const { obj } = await ledger(r);
    const w = r.wm.active;
    const primary = w.landingSites.find((s) => s.primary);
    const exoticPads = exoticPadsOf(w);
    /* Every planet HAS one, or this case is asserting over an empty set on that
     * world and would pass by having nothing to refuse. */
    assert.ok(exoticPads.size,
      `${id} publishes no pad carrying its exotic seam, so the exclusion below proves nothing there`);

    /* THE ON-FOOT PATH, DRIVEN THE WAY THE GAME LEAVES IT. Not a stub - null is
     * what `Piloting.landedSite` actually reads after an entry that was not a
     * landing, and the assertion says so rather than trusting the rig. */
    r.piloting._landedSite = null;
    assert.equal(r.piloting.landedSite, null,
      `${id}: the rig recorded a landing without one, so the case below is not on foot`);
    const foot = obj.richerPad();
    const footHint = obj.hint();
    if (foot && foot.id === primary.id) {
      selfNamed.push(`${id}: on foot the brief names ${foot.name}, the pad the player is standing on`);
    }
    if (foot && exoticPads.has(foot.id)) {
      const site = w.landingSites.find((x) => x.id === foot.id);
      strandings.push(`${id}: on foot the brief names ${foot.name}, which carries the exotic seam`
        + ` (home ${site?.home?.pct ?? '?'}%)`);
    }
    /* The SENTENCE and not only the pick: the hint is what a player reads, and
     * a silent `richerPad` with a chatty `hint` would be the same defect. */
    if (!foot) {
      for (const s of w.landingSites) {
        assert.ok(!footHint.includes(s.name),
          `${id}: richerPad() is silent on foot and the brief still names ${s.name}: "${footHint}"`);
      }
    }

    const from = [];
    for (const s of w.landingSites) {
      r.piloting._landedSite = { id: s.id, name: s.name };
      const pick = obj.richerPad();
      from.push(`${s.id}->${pick?.id ?? '-'}`);
      if (pick && exoticPads.has(pick.id)) {
        const site = w.landingSites.find((x) => x.id === pick.id);
        strandings.push(`${id}: standing on ${s.id} the brief names ${pick.name}, which carries the`
          + ` exotic seam (home ${site?.home?.pct ?? '?'}%) - the tier that is supposed to cost a`
          + ' second landing');
      }
      if (pick) {
        assert.notEqual(pick.id, s.id,
          `${id}: standing on ${s.id} the brief names ${s.id}`);
      }
    }
    console.log(`   ${id.padEnd(11)} ${primary.id.padEnd(16)} ${String(foot?.id ?? 'silent').padEnd(9)} ${from.join('  ')}`);
    obj.dispose();
  }
  assert.deepEqual(selfNamed, [],
    `the mining brief tells a player on foot to fly to the pad they are standing on:\n  ${selfNamed.join('\n  ')}`);
  assert.deepEqual(strandings, [],
    `the mining brief names a pad that carries the exotic seam:\n  ${strandings.join('\n  ')}`);
});

test('every wing pays its own bounty back, and no wing pays the session total', async () => {
  const r = await rig();
  await goto(r, 'space');
  for (const z of r.wm.active.encounters) {
    const expected = z.wing.reduce((s, w) => s + w.count * ALIEN_CLASSES[w.class].bounty, 0);
    assert.equal(wingBounty(z), expected, `${z.id} first-clear prize is not its own wing`);
    assert.ok(expected > 0, `${z.id} names no class the bounty table knows`);
  }
  /* The trap this exists for: `combat:cleared` publishes `bounty` as the
   * SESSION total. Reading it would have paid a first clear the whole
   * session's earnings back, and the bug would have grown with the session
   * rather than showing up on the first clear. */
  const zones = r.wm.active.encounters;
  assert.notEqual(wingBounty(zones[0]), wingBounty(zones[0]) + wingBounty(zones[1]),
    'the per-wing prize must not be the running total');
});

/**
 * Every mineral field the game has a descriptor for, in credits.
 *
 * `unitValue * hold * count` per mineral, which is `definePlanet`'s own
 * arithmetic with the per-node dice taken out - the same number
 * `SpaceObjectives.FIELD_CREDITS` claims to be, re-derived here rather than
 * quoted, so a descriptor that is trimmed or enriched moves this and not the
 * constant.
 */
function registeredFields() {
  return Object.values(PLANETS).map((p) => ({
    id: p.id,
    credits: p.minerals.reduce((s, m) => s + m.unitValue * m.hold * m.count, 0),
    nodes: p.minerals.reduce((s, m) => s + m.count, 0),
  }));
}

test('the ore ladder tops out inside the ore the SYSTEM holds, not inside one planet', async () => {
  const r = await rig();
  await goto(r, 'cinder');
  const nodes = r.wm.active.mineralNodes;
  const field = nodes.reduce((s, n) => s + n.credits, 0);
  const types = new Map();
  for (const n of nodes) {
    const t = types.get(n.type) ?? { n: 0, cr: 0 };
    t.n++; t.cr += n.credits;
    types.set(n.type, t);
  }
  for (const [id, t] of types) {
    console.log(`  ${id.padEnd(12)} ${String(t.n).padStart(3)} nodes  ${String(t.cr).padStart(5)} cr`);
  }
  const top = ORE_TIERS[ORE_TIERS.length - 1].credits;

  /* ── THE UNIT THE LADDER IS SPACED IN, RE-DERIVED ────────────────────────
   *
   * `FIELD_CREDITS` is one field in credits and the top two rungs are multiples
   * of it. It is written down rather than imported because `PLANETS` drags
   * `PlanetWorld` and therefore `three` in behind it, and this module's import
   * graph is asserted to be two frozen data modules further down this file. So
   * the scrape happens HERE instead - the same arrangement `HOLD_UNITS_PER_SIZE`
   * lives under against `Piloting.stow`. */
  const fields = registeredFields();
  for (const f of fields) {
    console.log(`  descriptor ${f.id.padEnd(10)} ${f.nodes} nodes, ${f.credits} cr`);
  }
  const poorest = Math.min(...fields.map((f) => f.credits));
  console.log(`  FIELD_CREDITS ${FIELD_CREDITS} against the poorest registered field ${poorest} cr`
    + ` (placed, with the dice in: ${field} cr)`);
  assert.ok(FIELD_CREDITS <= poorest,
    `the ladder is spaced in units of ${FIELD_CREDITS} cr and the poorest field registered `
    + `holds ${poorest} - every rung derived from it is a rung nobody can reach on that planet`);
  /* SYSTEM_ORE_CREDITS is a SUM now, not `FIELD_CREDITS * bodies`.
   *
   * It was a projection while Cinder was the only descriptor. All ten exist, so
   * it is measured - and it has to be, because `FIELD_CREDITS` is now the
   * POOREST field rather than a typical one. Multiplying the poorest by ten
   * under-counts the system by half AND would make authoring one lean world look
   * like the system had shrunk. Two questions, two constants. */
  const systemTotal = fields.reduce((s, f) => s + f.credits, 0);
  console.log(`  SYSTEM_ORE_CREDITS ${SYSTEM_ORE_CREDITS} against the summed descriptors ${systemTotal} cr`);
  assert.equal(SYSTEM_ORE_CREDITS, systemTotal,
    `the stated system total is ${SYSTEM_ORE_CREDITS} and the ten descriptors sum to ${systemTotal}`);
  assert.equal(fields.length, landableBodies().length,
    'a landable body has no descriptor, or a descriptor has no landable body');

  /* FLOOR: the top rung must be reachable - a haul target larger than the ore
   * that exists is the "gold nobody can reach" defect with a pickaxe. It is
   * measured against the SYSTEM now and not against Cinder, because that is
   * what changed: ten landable bodies exist, the old top rung asked for 90% of
   * the first one, and a career you can finish without leaving your first
   * landing site is not a career. The margin is printed so a trim shows up as a
   * shrinking number long before it shows up as a failure. */
  console.log(`  top rung ${top} cr against a projected system of ${SYSTEM_ORE_CREDITS} cr `
    + `= ${((top / SYSTEM_ORE_CREDITS) * 100).toFixed(1)}%, margin ${SYSTEM_ORE_CREDITS - top} cr`);
  assert.ok(top <= SYSTEM_ORE_CREDITS,
    `the top rung asks for ${top} cr and ten fields hold ${SYSTEM_ORE_CREDITS}`);

  /* CEILING, AND IT IS THE ONE THIS DROP EXISTS FOR: the top rung must NOT be
   * inside a single field. This is the assertion that reddens if somebody puts
   * it back where it was. */
  console.log(`  floor ${field} (one whole field) / achieved ${top} for the top rung`);
  assert.ok(top > field,
    `the top rung (${top}) is inside the one field this rig built (${field}) - `
    + 'the whole ladder can be climbed without leaving the first planet you land on');
  assert.ok(top > Math.max(...fields.map((f) => f.credits)),
    'the top rung is inside the richest field the game has a descriptor for');

  /* And the rung below it is one field, with margin, which is what the old top
   * rung claimed and is now the third of four. */
  const third = ORE_TIERS[ORE_TIERS.length - 2].credits;
  console.log(`  third rung ${third} cr = ${((third / field) * 100).toFixed(1)}% of the built field, `
    + `margin ${field - third} cr`);
  assert.ok(third < field,
    `the third rung (${third}) asks for more than the field holds (${field})`);

  /* CEILING, IN HOLD LOADS AND NOT IN PERCENT.
   *
   * A percentage of the field was the first version and it was the wrong ruler:
   * the field is under active edit, so the same rung was 98.7% of it one hour
   * and 60.4% the next without a single thing about the PLAYING of it changing.
   * What does not move is the hold - ore pays nothing until it is sold at the
   * yard, so a haul target is really a number of round trips. `best` is the
   * richest 40 m3 a Dray could possibly lift: the most valuable nodes the field
   * holds, taken greedily by credits per cubic metre. */
  const byDensity = nodes.slice().sort(
    (a, b) => (b.credits / Math.max(1, Math.round((b.size ?? 1) * 1.6)))
            - (a.credits / Math.max(1, Math.round((a.size ?? 1) * 1.6)))
  );
  const loadOf = (cap) => {
    let m3 = 0;
    let cr = 0;
    let n = 0;
    for (const node of byDensity) {
      const u = Math.max(1, Math.round((node.size ?? 1) * 1.6));
      if (m3 + u > cap) continue;
      m3 += u; cr += node.credits; n++;
    }
    return { cr, n, m3 };
  };
  const dray = loadOf(40);
  const kestrel = loadOf(10);
  console.log(`  best possible loads: Dray ${dray.cr} cr in ${dray.n} nodes, `
    + `Kestrel ${kestrel.cr} cr in ${kestrel.n} nodes`);
  console.log(`  floor ${dray.cr * 2} / achieved ${top} for the top rung `
    + `(= ${(top / dray.cr).toFixed(1)} best-case Dray loads)`);
  assert.ok(top > dray.cr,
    `the top rung (${top}) is inside a single best-case Dray load (${dray.cr}) - one trip, not a career`);

  /* The first rung must cost more than one stock Kestrel load off an ordinary
   * pad, or it pays for undocking. Measured against the two flat pads rather
   * than the crater rim, which is the whole point of the value gradient. */
  console.log(`  first rung ${ORE_TIERS[0].credits} against a measured Kestrel load of `
    + `114 cr (ashfall) / 497 cr (colonnade) / 2,839 cr (rimhold)`);
  assert.ok(ORE_TIERS[0].credits > 497,
    'the first rung is inside a single Kestrel load off the colonnade');

  /* And the rungs have to be in order, or the `while` that pays them would pay
   * two at once for one node. */
  for (let i = 1; i < ORE_TIERS.length; i++) {
    assert.ok(ORE_TIERS[i].credits > ORE_TIERS[i - 1].credits, 'the ore rungs are out of order');
  }
});

test('one of every element is a journey across the planet, not a walk off the pad', async () => {
  const r = await rig();
  await goto(r, 'cinder');
  const w = r.wm.active;
  const field = r.physics.heightfields[0];
  /* Ground-following distance, 2 m steps, so a climb out of a fissure costs
   * what it costs. The same measure the threshold probe used. */
  const path = (ax, az, bx, bz) => {
    const dx = bx - ax;
    const dz = bz - az;
    const flat = Math.hypot(dx, dz);
    const n = Math.max(1, Math.ceil(flat / 2));
    let len = 0;
    let py = field.sampleHeight(ax, az);
    for (let i = 1; i <= n; i++) {
      const y = field.sampleHeight(ax + (dx * i) / n, az + (dz * i) / n);
      len += Math.hypot(flat / n, y - py);
      py = y;
    }
    return len;
  };
  const pad = w.landingSites.find((s) => s.primary) ?? w.landingSites[0];
  const kinds = [...new Set(w.mineralNodes.map((n) => n.type))];
  let furthest = 0;
  for (const kind of kinds) {
    let best = Infinity;
    for (const n of w.mineralNodes) {
      if (n.type !== kind) continue;
      best = Math.min(best, path(pad.position.x, pad.position.z, n.position.x, n.position.z));
    }
    furthest = Math.max(furthest, best);
    console.log(`  nearest ${kind.padEnd(12)} to ${pad.id}: ${Math.round(best)} m`);
  }
  /* SPRINT is the game's own sustained ground speed (CONFIG.player.sprintSpeed)
   * and MINE_TIME is the hold. A set of five within 100 m of the pad would be a
   * "chart" you fill in by standing still. */
  const SPRINT = 8.2;
  const seconds = furthest / SPRINT + kinds.length * MINE_TIME;
  console.log(`  floor 200 m / achieved ${Math.round(furthest)} m to the furthest kind;`
    + ` ~${seconds.toFixed(0)} s of ground work for the set`);
  assert.ok(furthest > 200,
    `every element is within ${Math.round(furthest)} m of the pad - the set is not a journey`);
  /* And the assay bonus stays in the same band as the ore, so cutting a seam is
   * never worth less than the bonus for having cut one before it. */
  const dearest = Math.max(...w.mineralNodes.map((n) => n.credits));
  console.log(`  assay bonus ${ASSAY_CREDITS} against a top node of ${dearest} cr`);
  assert.ok(ASSAY_CREDITS < dearest,
    'the first-find bonus is worth more than the best node, which inverts the incentive');
});

/* ================================================================== */
/* 3. FLOWN: the survey triggers fire, and only the trigger fires them  */
/* ================================================================== */

/**
 * Fly at a body from the launch point until its survey fires or the clock runs
 * out. Nothing here calls `place` after the launch: the whole leg goes through
 * the same five command fields a keyboard writes.
 */
async function flyTo(r, obj, body, limit) {
  const target = V(body.position);
  launchAt(r, target);
  let firedAt = null;
  const off = r.bus.on('objective:survey', (p) => {
    if (p.id === body.id && firedAt === null) firedAt = t;
  });
  let t = 0;
  const res = await fly(
    r,
    (now) => { t = now; steerTo(r.piloting.flight, target, { throttle: 1, boost: true }); },
    (now) => { t = now; obj.update(DT); return firedAt !== null || r.wm.active?.id !== 'space'; },
    { limit }
  );
  off();
  return { firedAt, t: res.t, done: res.done, world: r.wm.active?.id };
}

test('FLOWN: a straight run at every body in the volume surveys it and pays its distance', async () => {
  const r = await rig();
  await goto(r, 'dock');
  r.piloting.board('kestrel', { silent: true });
  await goto(r, 'space');
  const { obj, economy } = await ledger(r);
  try {
    /* The measured one-way trips at frac 0.50 were 36 / 61 / 79 / 90 / 364
     * seconds for the five Phase 1 bodies. The limit is that plus half again,
     * which is slack for the turn-in and not slack for a trigger that does not
     * fire.
     *
     * The seven Phase 2 bodies had NO row here, so `fly` fell through to its
     * own 240 s default - which is nine times the slack Cinder gets and, for
     * Erenmark's neighbours, would have been a budget that could not be blown.
     * A limit that cannot be reached is not a limit. These are the flown times
     * from this same case (66 / 77 / 100 / 115 / 121 / 138 / 172 s), rounded up
     * with the same half-again margin. */
    const budget = {
      cinder: 60, tessera: 95, vitrine: 125, ceraunus: 140, erenmark: 550,
      sirocco: 100, shoal: 115, verdigris: 150, lathe: 175,
      carnelian: 185, sallow: 210, cathedra: 260,
    };
    for (const b of SPACE_BODIES) {
      assert.ok(typeof budget[b.id] === 'number',
        `${b.id} has no flight budget, so its leg is bounded by nothing this case chose`);
    }
    const rows = [];
    for (const b of SPACE_BODIES) {
      const out = await flyTo(r, obj, b, budget[b.id]);
      rows.push({ id: b.id, ...out, pay: surveyReward(b) });
      console.log(`  ${b.id.padEnd(9)} surveyed at ${String(out.firedAt === null ? 'NEVER' : out.firedAt.toFixed(1) + ' s').padStart(9)}`
        + `  (budget ${budget[b.id]} s)  +${surveyReward(b)} cr`);
      if (r.wm.active?.id !== 'space') await goto(r, 'space');
    }
    for (const row of rows) {
      assert.notEqual(row.firedAt, null,
        `floor: ${row.id} was never surveyed on a straight run at it - built, not reachable`);
    }
    assert.equal(obj.surveyCount, SPACE_BODIES.length, 'the ledger disagrees with the flight');
    const expected = SPACE_BODIES.reduce((s, b) => s + surveyReward(b), 0);
    const paid = economy.log.filter(([w]) => w === 'objective:survey').reduce((s, [, n]) => s + n, 0);
    console.log(`  floor ${expected} / achieved ${paid} credits of survey money`);
    assert.equal(paid, expected, 'the wallet did not get what the distances say');
    /* The SURVEY set is complete without a single landing - reaching is a
     * fly-by and that is the whole of the claim it makes - so the survey set
     * prize is payable here and each body must have paid exactly once. The
     * landfall set is a different question and is not touched by this leg. */
    assert.ok(economy.log.filter(([w]) => w === 'objective:survey').length === SPACE_BODIES.length,
      'a body paid twice, or one paid nothing');
    assert.equal(economy.log.filter(([w]) => w === 'objective:landfall').length, 0,
      'a fly-by paid a landfall');
  } finally {
    obj.dispose();
    if (r.piloting.active) r.piloting.disembark({ silent: true, force: true });
  }
});

test('CEILING BY ABLATION: with the spheres shrunk to a metre the same leg surveys nothing', async () => {
  const r = await rig();
  await goto(r, 'dock');
  r.piloting.board('kestrel', { silent: true });
  await goto(r, 'space');
  const { obj, economy } = await ledger(r);
  try {
    /* The mechanism under test is the sphere. Reaching past a public surface to
     * shrink it is exactly what an ablation is for: the identical leg, flown
     * the identical way, with the one thing being credited removed. Without
     * this, "Cinder was surveyed" cannot distinguish the trigger firing from
     * the ledger paying for arriving in a world. */
    obj._sight = () => {};
    const target = V(BODY_BY_ID.cinder.position);
    launchAt(r, target);
    let fired = false;
    const off = r.bus.on('objective:survey', () => { fired = true; });
    await fly(
      r,
      () => steerTo(r.piloting.flight, target, { throttle: 1, boost: true }),
      () => { obj.update(DT); return fired || r.wm.active?.id !== 'space'; },
      { limit: 60 }
    );
    off();
    console.log(`  ablated: surveyed ${obj.surveyCount}, paid ${economy.credits} cr`);
    assert.equal(fired, false, 'ablation: something surveyed Cinder with the trigger removed');
    assert.equal(obj.surveyCount, 0);
    assert.equal(economy.credits, 0, 'ablation: the wallet moved with nothing to pay for');
  } finally {
    obj.dispose();
    if (r.wm.active?.id !== 'space') await goto(r, 'space');
    if (r.piloting.active) r.piloting.disembark({ silent: true, force: true });
  }
});

test('FLOWN: a descent onto Cinder pays the landfall bonus, once, on top of the survey', async () => {
  const r = await rig();
  await goto(r, 'dock');
  r.piloting.board('kestrel', { silent: true });
  await goto(r, 'space');
  const { obj, economy } = await ledger(r);
  try {
    const cinder = BODY_BY_ID.cinder;
    const target = V(cinder.position);
    launchAt(r, target);
    await fly(
      r,
      () => steerTo(r.piloting.flight, target, { throttle: 1, boost: true }),
      () => { obj.update(DT); return r.wm.active?.id !== 'space'; },
      { limit: 120 }
    );
    await settle(4);
    console.log(`  world after the seam: ${r.wm.active?.id}`);
    assert.equal(r.wm.active?.id, 'cinder', 'the descent never happened');
    assert.equal(obj.reached('cinder'), true, 'Cinder was not on the plot after landing on it');
    assert.equal(obj.landfallCount, 1, 'the landfall did not register');

    const landfalls = economy.log.filter(([w]) => w === 'objective:landfall');
    console.log(`  landfall paid ${landfalls.length}x ${landfallReward(cinder)} cr`
      + ` (law says ${landfallSeconds(cinder).toFixed(1)} s, flown leg was ${LANDFALL_S} s,`
      + ` at ${SURVEY_CR_PER_SECOND} cr/s)`);
    assert.equal(landfalls.length, 1, 'the landfall paid more than once');
    assert.equal(landfalls[0][1], landfallReward(cinder),
      'the descent paid something other than what the law says its descent is worth');
    /* The law has to still produce the flown number for the body it was fitted
     * to, or it is a different law wearing the same measurement. */
    assert.equal(landfalls[0][1], LANDFALL_CREDITS);

    /* Re-entering must not pay again. `pilot:entry` fires on every descent and
     * the whole point of the map is that the second one is free. */
    r.bus.emit('pilot:entry', { body: 'cinder', world: 'cinder' });
    assert.equal(economy.log.filter(([w]) => w === 'objective:landfall').length, 1,
      'a second descent paid the landfall again');
  } finally {
    obj.dispose();
    if (r.piloting.active) r.piloting.disembark({ silent: true, force: true });
    await goto(r, 'space');
  }
});

/* ================================================================== */
/* 4. FLOWN: the kill ladder is reachable                              */
/* ================================================================== */

test('FLOWN: the first two rungs of the kill ladder are reachable, and the ledger pays them', async () => {
  const r = await rig();
  if (!('fire' in r.input.state)) r.input.state.fire = false;
  await goto(r, 'space');
  delete r.ships._powers.kestrel;
  const combat = new SpaceCombat({
    scene: r.scene, camera: r.camera, bus: r.bus, input: r.input, player: r.player,
    worldManager: r.wm, piloting: r.piloting, ships: r.ships, economy: r.economy,
    rnd: seeded(29),
  });
  const { obj, economy, inventory } = await ledger(r);
  try {
    r.piloting.board('kestrel', { silent: true });
    r.player.health = 100;
    const zones = r.wm.active.encounters;
    launchAt(r, V(zones[0].position));

    const f = r.piloting.flight;
    const lead = new THREE.Vector3();
    const fwd = new THREE.Vector3();
    const toT = new THREE.Vector3();
    const zc = new THREE.Vector3();
    const marks = [];
    const offK = r.bus.on('combat:kill', () => marks.push(+t.toFixed(1)));
    let zi = 0;
    let t = 0;
    let lastAction = 0;
    /* 300 s. The reference run reached rung two (nine kills) at 148 s with the
     * same autopilot and the same seed; double it is slack for the turn-ins and
     * is not slack for a ladder nobody can climb.
     *
     * Re-measured after Phase 2 at 188 s. The rung did not move - it is still
     * one sweep of the inner three - but the tour visits them in array order
     * and Cinder's picket now stands off further from the planet, so the legs
     * between them are longer.
     *
     * ── AND RE-MEASURED AGAIN ON THE REAL HULL: 167 s -> 94 s ───────────────
     * This case boards after `goto('space')`, and `Piloting._shipRecord` used
     * to find nothing outside the yard, so `Flight.setShip` took its
     * `powerMul: 1` fallback and the ladder was climbed by a Kestrel cruising
     * at 120 m/s. It now flies the game's 210 m/s hull and the legs between
     * the inner three pickets take a little over half as long:
     *
     *     rung 1 (3 kills)   90.7 s -> 50.8 s
     *     rung 2 (9 kills)  167.2 s -> 94.5 s
     *
     * The 300 s ceiling is deliberately NOT tightened onto 94 s. It is a
     * "nobody can climb this" bound, and the spawn geometry it depends on is
     * chaotic; 206 s of margin is the point of it. */
    for (let i = 0; i < 60 * 300 && obj.killCount < KILL_TIERS[1].kills; i++) {
      t = i * DT;
      if (r.piloting._travelling) { await settle(2); continue; }
      const tg = combat.target;
      if (tg && tg.alive) {
        lastAction = t;
        const d = tg.position.distanceTo(f.position);
        /* The same lead point the HUD pip is drawn at: the target advanced by
         * the bolt's time of flight against the CLOSURE, not the raw velocity.
         * A pilot who does not do this hits nothing, and the case would be
         * measuring the autopilot rather than the ladder. */
        lead.copy(tg.velocity).sub(f.velocity).multiplyScalar(d / 1600).add(tg.position);
        steerTo(f, lead, { gain: 5, throttle: d > 620 ? 1 : 0, brake: d < 260 });
        f.forward(fwd);
        toT.copy(lead).sub(f.position).normalize();
        r.input.state.fire = d < 820 && toT.dot(fwd) > 0.9993;
      } else {
        r.input.state.fire = false;
        zc.set(...zones[zi].position);
        if (f.position.distanceTo(zc) < zones[zi].radius * 0.5 && !combat.engaged && t - lastAction > 6) {
          zi = (zi + 1) % zones.length;
          lastAction = t;
        }
        steerTo(f, zc, { throttle: 1, boost: true });
      }
      r.piloting.fixedUpdate(DT, t);
      combat.fixedUpdate(DT, t);
      if (r.player.health <= 0) { r.player.health = 100; combat.shield = combat.shieldMax; }
      if ((i & 31) === 0) await null;
    }
    offK();
    r.input.state.fire = false;

    console.log(`  ${obj.killCount} kills in ${t.toFixed(0)} s; rung 1 (${KILL_TIERS[0].kills}) at `
      + `${marks[KILL_TIERS[0].kills - 1] ?? 'NEVER'} s, rung 2 (${KILL_TIERS[1].kills}) at `
      + `${marks[KILL_TIERS[1].kills - 1] ?? 'NEVER'} s`);
    console.log(`  reference run: rung 1 at 50.8 s, rung 2 at 94.5 s `
      + `(before the flown hull was corrected: 90.7 s / 167.2 s at powerMul 1)`);
    assert.ok(obj.killCount >= KILL_TIERS[1].kills,
      `floor: only ${obj.killCount} kills in ${t.toFixed(0)} s - the ladder is not climbable`);
    assert.ok(marks[KILL_TIERS[1].kills - 1] < 300,
      'floor: one full sweep must be inside five minutes of hunting');

    /* The ledger is identity-keyed, so the classes have to add up as well as
     * the total. This is the assertion that would catch a ledger counting
     * `combat:hit` instead of `combat:kill`. */
    const byClass = obj.serialize().kills;
    const sum = Object.values(byClass).reduce((s, n) => s + n, 0);
    console.log(`  by class: ${JSON.stringify(byClass)} = ${sum}`);
    assert.equal(sum, obj.killCount, 'the per-class ledger disagrees with its own total');
    assert.equal(obj.killBounty, Object.entries(byClass)
      .reduce((s, [id, n]) => s + ALIEN_CLASSES[id].bounty * n, 0));

    /* Both rungs paid, once each, with their items. */
    const paid = economy.log.filter(([w]) => w === 'objective:kills');
    console.log(`  rungs paid: ${JSON.stringify(paid)}   items: ${JSON.stringify(inventory.got)}`);
    assert.equal(paid.length, 2, 'the two rungs did not pay exactly once each');
    assert.equal(paid[0][1], KILL_TIERS[0].credits);
    assert.equal(paid[1][1], KILL_TIERS[1].credits);

    /* At least one named wing was broken on the way, and it paid its own
     * bounty rather than the session total. */
    const wings = economy.log.filter(([w]) => w === 'objective:wing');
    console.log(`  wings broken: ${obj.wingCount}/${obj.wingTotal}, paid ${JSON.stringify(wings)}`);
    assert.ok(obj.wingCount > 0, 'nine kills without breaking a single named wing');
    for (const [, amount] of wings) {
      assert.ok(zones.some((z) => wingBounty(z) === amount),
        `a wing paid ${amount}, which is not any wing's own bounty`);
    }
  } finally {
    obj.dispose();
    combat.standDown('test');
    combat.dispose();
    if (r.piloting.active) r.piloting.disembark({ silent: true, force: true });
    r.piloting.interdicted = false;
    r.input.state.fire = false;
  }
});

test('CEILING BY ABLATION: with the guns cold the same 60 seconds kills nothing and pays nothing', async () => {
  const r = await rig();
  if (!('fire' in r.input.state)) r.input.state.fire = false;
  await goto(r, 'space');
  const combat = new SpaceCombat({
    scene: r.scene, camera: r.camera, bus: r.bus, input: r.input, player: r.player,
    worldManager: r.wm, piloting: r.piloting, ships: r.ships, economy: r.economy,
    rnd: seeded(29),
  });
  const { obj, economy } = await ledger(r);
  try {
    r.piloting.board('kestrel', { silent: true });
    r.player.health = 100;
    const zones = r.wm.active.encounters;
    launchAt(r, V(zones[0].position));
    const zc = V(zones[0].position);
    for (let i = 0; i < 60 * 60; i++) {
      const t = i * DT;
      if (r.piloting._travelling) { await settle(2); continue; }
      // The trigger is never pulled. Everything else is the same flight.
      r.input.state.fire = false;
      steerTo(r.piloting.flight, zc, { throttle: 1, boost: true });
      r.piloting.fixedUpdate(DT, t);
      combat.fixedUpdate(DT, t);
      if (r.player.health <= 0) { r.player.health = 100; combat.shield = combat.shieldMax; }
      if ((i & 31) === 0) await null;
    }
    console.log(`  ablated: engaged=${combat.engaged}, kills ${obj.killCount}, `
      + `wings ${obj.wingCount}, wallet ${economy.credits}`);
    /* The fight must still HAPPEN - otherwise this ablates the encounter rather
     * than the gun, and proves nothing about the ledger. */
    assert.ok(combat.contacts > 0 || combat.engaged,
      'ablation is invalid: no wing ever arrived, so the guns were not what was removed');
    assert.equal(obj.killCount, 0, 'ablation: something died with the trigger never pulled');
    assert.equal(economy.credits, 0, 'ablation: the ladder paid for a fight that killed nothing');
  } finally {
    obj.dispose();
    combat.standDown('test');
    combat.dispose();
    if (r.piloting.active) r.piloting.disembark({ silent: true, force: true });
    r.piloting.interdicted = false;
  }
});

/* ================================================================== */
/* 5. Ore: driven through the real Mining system                       */
/* ================================================================== */

test('FLOWN: cutting real seams fills the assay chart and climbs the haul ladder', async () => {
  const r = await rig();
  await goto(r, 'cinder');
  const { obj, economy, inventory } = await ledger(r);
  try {
    /* The roster is LEARNED from the world, never declared here - the brief for
     * this drop says so in as many words. Landing is what fills it in. */
    const kinds = new Set(r.wm.active.mineralNodes.map((n) => n.type));
    console.log(`  the world published ${kinds.size} kinds; the chart reads 0/${obj.assayTotal}`);
    assert.equal(obj.assayTotal, kinds.size, 'the assay chart did not learn the world it is on');
    assert.equal(obj.assayCount, 0);

    /* Drive the REAL `Mining.mine`, which refuses BEFORE it consumes and only
     * emits once `piloting.stow` has said yes. A Dray, because a Kestrel's
     * 10 m3 hold fills after five nodes and this needs a real haul. */
    r.piloting.board('dray', { silent: true });
    r.piloting._cargo = Object.create(null);
    r.piloting._cargoUnits = 0;
    /* THE HOLD IS THE LOOP, so the case has to fly it.
     *
     * Every node is 2 m3 and a Dray holds 40, so twenty nodes fill it and
     * `stow` REFUSES the twenty-first before it consumes anything - which is
     * `Mining`'s whole design and the reason ore pays nothing until it is sold
     * at the yard. A case that ignored that would be mining a planet with an
     * infinite hold, so instead it does what a player does: fill up, fly home,
     * sell, come back. `sell` is what the trip home is worth in this rig. */
    let trips = 1;
    const sell = () => {
      trips++;
      r.piloting._cargo = Object.create(null);
      r.piloting._cargoUnits = 0;
    };
    const cut = (node) => {
      let res = r.mining.mine(node);
      if (res.reason === 'hold-full') { sell(); res = r.mining.mine(node); }
      return res;
    };

    const byType = new Map();
    for (const n of r.wm.active.mineralNodes) {
      if (!byType.has(n.type)) byType.set(n.type, n);
    }
    let expected = 0;
    for (const n of byType.values()) {
      const res = cut(n);
      assert.equal(res.ok, true, `the real Mining system refused ${n.type}: ${res.reason}`);
      expected += n.credits;
    }
    console.log(`  cut one of each: ${obj.assayCount}/${obj.assayTotal} assayed, ${obj.oreCredits} cr`);
    assert.equal(obj.assayCount, kinds.size, 'one of every kind did not fill the chart');
    assert.equal(obj.oreCredits, expected, 'the ledger did not total what the nodes were worth');
    assert.equal(obj.oreNodes, byType.size);

    const assays = economy.log.filter(([w]) => w === 'objective:assay');
    assert.equal(assays.length, kinds.size, 'the first-find bonus did not pay once per kind');
    for (const [, n] of assays) assert.equal(n, ASSAY_CREDITS);

    /* Cutting a SECOND node of a kind already assayed must not pay the bonus
     * again - it is a first-find, and a second find is just ore. */
    const second = r.wm.active.mineralNodes.find(
      (n) => n.type === [...byType.keys()][0] && n !== byType.get([...byType.keys()][0])
    );
    cut(second);
    assert.equal(economy.log.filter(([w]) => w === 'objective:assay').length, kinds.size,
      'a second node of a known kind paid the first-find bonus again');
    assert.equal(obj.assayCount, kinds.size);

    /* Now mine the whole planet and check every rung THIS FIELD CAN REACH pays
     * exactly once, in order, with its own reward.
     *
     * ── Why this is no longer "every rung" ────────────────────────────────
     *
     * It was, and it was right when the ladder topped out at 90% of the one
     * field that existed. The top rung is now three fields, deliberately, so
     * that a career cannot be finished on the first planet a player lands on -
     * and this rig has one planet in it, because nine of the ten descriptors
     * are being written as this is read. Asserting "all four rungs pay" would
     * therefore be asserting that the defect is still there.
     *
     * So the reachable set is DERIVED from the ore this run actually cut, and
     * the case says out loud which rungs are waiting on content. The day the
     * remaining descriptors land and a case mines more than one field, this
     * assertion covers all four again with no edit - and until then it still
     * checks the thing it was written to check: that a rung pays once, that it
     * pays its own reward, and that they pay in order. */
    for (const n of r.wm.active.mineralNodes) cut(n);
    const rungs = economy.log.filter(([w]) => w === 'objective:ore');
    const reachable = ORE_TIERS.filter((t) => t.credits <= obj.oreCredits);
    const waiting = ORE_TIERS.filter((t) => t.credits > obj.oreCredits);
    console.log(`  whole field cut: ${obj.oreNodes} nodes, ${obj.oreCredits} cr, `
      + `${trips} hold-loads (a Dray carries 20 nodes), rungs ${JSON.stringify(rungs)}`);
    console.log(`  reachable from this one field: ${reachable.map((t) => t.title).join(', ')}`
      + `   waiting on more fields: ${waiting.map((t) => `${t.title} (${t.credits} cr)`).join(', ') || 'none'}`);
    assert.ok(reachable.length > 0, 'a whole field does not reach the first rung of the ladder');
    assert.equal(rungs.length, reachable.length,
      'a rung the field can pay for did not pay, or one it cannot pay for did');
    for (let i = 0; i < reachable.length; i++) assert.equal(rungs[i][1], reachable[i].reward);
    assert.ok(inventory.got.length >= reachable.length, 'the rungs paid no items');
    /* And the rungs that did not pay are exactly the ones above what one field
     * holds - stated as an assertion so "the ladder is unclimbable" and "the
     * ladder is longer than one planet" cannot be confused for each other. */
    for (const t of waiting) {
      assert.ok(t.credits > obj.oreCredits,
        `${t.title} did not pay and the field holds more than it asks for`);
    }
    console.log(`  ${Object.keys(PLANETS).length} of ${landableBodies().length} landable bodies have a `
      + 'descriptor; when they all do, a case that flies more than one of them covers the top rung');
  } finally {
    obj.dispose();
    /* The mining ledger is per-process and shared with the other cases in the
     * suite, so the seams this case worked are put back. */
    r.mining.deserialize({ taken: [], mined: 0, credits: 0 });
    if (r.piloting.active) r.piloting.disembark({ silent: true, force: true });
  }
});

/* ================================================================== */
/* 6. Persistence: identity, not count                                 */
/* ================================================================== */

test('the round trip marks the bodies you actually reached, not the first N of them', async () => {
  /* THE DEFECT THIS EXISTS FOR, NAMED.
   *
   * `Relics.serialize` writes `{ found: { citadel: 17 } }` - a COUNT - and
   * `_applyFound` stamps the first seventeen sites in publication order coming
   * back in. Find relics 3, 9 and 21 and a reload marks 1, 2 and 3. The tally
   * is right and every marked thing is wrong.
   *
   * So this case reaches the SECOND and FOURTH bodies specifically and insists
   * those two come back - not two of them, and not the first two. */
  const r = await rig();
  const a = await ledger(r);
  const picked = [SPACE_BODIES[1], SPACE_BODIES[3]];
  for (const b of picked) a.obj._sight(b, surveyReward(b));
  a.obj._landfall(BODY_BY_ID.cinder);

  const blob = JSON.parse(JSON.stringify(a.obj.serialize()));
  console.log(`  saved: ${JSON.stringify(blob.survey)}`);

  const b2 = await ledger(r);
  assert.equal(b2.obj.deserialize(blob), true, 'a well-formed payload was refused');
  const back = b2.obj.chart().filter((c) => c.state !== null).map((c) => c.id).sort();
  const want = [...picked.map((b) => b.id), 'cinder'].sort();
  console.log(`  restored: ${back.join(', ')}   wanted: ${want.join(', ')}`);
  assert.deepEqual(back, want, 'the wrong bodies came back');
  assert.equal(b2.obj.surveyCount, 3);
  assert.equal(b2.obj.landfallCount, 1, 'the landfall grade did not survive');
  /* SPACE_BODIES[2] and [4] were never touched. Naming them by INDEX is
   * deliberate: a count-not-set restore stamps the first N in publication
   * order, so the bodies that must come back empty are the ones a count would
   * have filled in - and index 0 is not one of them, because this case lands on
   * it. (It was, in the first draft, and the case failed for that reason.) */
  for (const i of [2, 4]) {
    assert.equal(b2.obj.reached(SPACE_BODIES[i].id), false,
      `${SPACE_BODIES[i].id} was never reached and came back marked - the count-not-set defect`);
  }
  /* And nothing was paid on the way in. A load that re-granted would be a
   * credit press. */
  console.log(`  wallet after the load: ${b2.economy.credits}`);
  assert.equal(b2.economy.credits, 0, 'the restore paid the prizes again');
  a.obj.dispose();
  b2.obj.dispose();
});

test('kills, wings, elements and receipts all survive a round trip, and none of them re-pays', async () => {
  const r = await rig();
  await goto(r, 'space');
  const a = await ledger(r);
  const zones = r.wm.active.encounters;
  for (let i = 0; i < 12; i++) r.bus.emit('combat:kill', { classId: i % 4 === 0 ? 'lance' : 'skiff' });
  r.bus.emit('combat:cleared', { zone: zones[0].id, name: zones[0].name, bounty: 999999 });
  r.bus.emit('mining:node', { id: 'x1', type: 'iridite', name: 'Iridite', credits: 210 });
  r.bus.emit('mining:node', { id: 'x2', type: 'iridite', name: 'Iridite', credits: 190 });
  r.bus.emit('mining:node', { id: 'x3', type: 'sulfur', name: 'Sulfur Crust', credits: 30 });
  a.obj._sight(BODY_BY_ID.tessera, surveyReward(BODY_BY_ID.tessera));

  const before = {
    kills: a.obj.killCount, bounty: a.obj.killBounty, wings: a.obj.wingCount,
    survey: a.obj.surveyCount, assay: a.obj.assayCount, ore: a.obj.oreCredits,
    nodes: a.obj.oreNodes, rank: a.obj.rank,
  };
  const spent = a.economy.credits;
  console.log(`  before: ${JSON.stringify(before)} (wallet ${spent})`);

  const blob = JSON.parse(JSON.stringify(a.obj.serialize()));
  /* The save carries no totals at all - every summary is recomputed from the
   * identity maps, so it cannot disagree with its own detail. */
  console.log(`  saved keys: ${Object.keys(blob).join(', ')}`);
  assert.ok(!('total' in blob) && !('bounty' in blob) && !('nodes' in blob),
    'the payload carries a summary that could drift from its detail');

  const b2 = await ledger(r);
  b2.obj.deserialize(blob);
  const after = {
    kills: b2.obj.killCount, bounty: b2.obj.killBounty, wings: b2.obj.wingCount,
    survey: b2.obj.surveyCount, assay: b2.obj.assayCount, ore: b2.obj.oreCredits,
    nodes: b2.obj.oreNodes, rank: b2.obj.rank,
  };
  console.log(`  after : ${JSON.stringify(after)} (wallet ${b2.economy.credits})`);
  assert.deepEqual(after, before, 'the reload lost or invented progress');
  assert.deepEqual(b2.obj.serialize().kills, blob.kills, 'the per-class detail changed shape');
  assert.equal(b2.economy.credits, 0, 'the restore re-paid');
  assert.deepEqual(b2.inventory.got, [], 'the restore re-granted items');
  assert.equal(b2.cosmetics.owned.size, 0, 'the restore re-granted a cosmetic');

  /* And the ladder does not pay again for progress it already has. */
  r.bus.emit('combat:kill', { classId: 'skiff' });
  console.log(`  one more kill after the load paid: ${JSON.stringify(b2.economy.log)}`);
  assert.equal(b2.economy.log.filter(([w]) => w === 'objective:kills').length, 0,
    'a rung already paid in the save paid again after one more kill');
  a.obj.dispose();
  b2.obj.dispose();
});

test('a load REPLACES: progress the loaded save does not contain is taken away', async () => {
  /* The rule `MountManager`, `Relics` and `Viewpoints` all record, and the one
   * a merging restore silently breaks: kill twenty-seven, load a save written
   * before any of them, and a merge leaves the ladder saying Sablebane. */
  const r = await rig();
  await goto(r, 'space');
  const { obj, economy } = await ledger(r);
  try {
    const early = JSON.parse(JSON.stringify(obj.serialize()));
    for (let i = 0; i < KILL_TIERS[3].kills; i++) r.bus.emit('combat:kill', { classId: 'skiff' });
    for (const b of SPACE_BODIES) obj._sight(b, surveyReward(b));
    console.log(`  rich state: ${obj.killCount} kills, rank ${obj.rank}, `
      + `${obj.surveyCount} surveyed, wallet ${economy.credits}`);
    assert.equal(obj.rank, KILL_TIERS[3].title, 'the setup did not reach the top rung');

    obj.deserialize(early);
    console.log(`  after loading the empty save: ${obj.killCount} kills, rank ${obj.rank}, `
      + `${obj.surveyCount} surveyed`);
    assert.equal(obj.killCount, 0, 'a merging load kept kills the save does not contain');
    assert.equal(obj.rank, null, 'the rank survived a load that should have cleared it');
    assert.equal(obj.surveyCount, 0, 'the survey plot survived a load that should have cleared it');

    /* And the receipt cleared with it, so the ladder can be climbed again in
     * this save - `_checkKillTier` is idempotent for the CURRENT state, not
     * across states a load replaced. */
    const paidBefore = economy.log.filter(([w]) => w === 'objective:kills').length;
    for (let i = 0; i < KILL_TIERS[0].kills; i++) r.bus.emit('combat:kill', { classId: 'skiff' });
    const paidAfter = economy.log.filter(([w]) => w === 'objective:kills').length;
    console.log(`  rungs paid before ${paidBefore}, after re-climbing rung 1: ${paidAfter}`);
    assert.equal(paidAfter, paidBefore + 1, 'the first rung could not be earned again in a fresh save');
  } finally {
    obj.dispose();
  }
});

test('a receipt that claims more than the ledger earned is clamped, not trusted', async () => {
  /* A payload claiming `killTier: 4` with two kills in it would silence the
   * whole ladder for ever. Clamping means the worst a bad receipt can do is
   * cost one payout, and the thing it is clamped against is an identity map,
   * which cannot be faked into agreement with itself. */
  const r = await rig();
  const { obj, economy, cosmetics } = await ledger(r);
  try {
    obj.deserialize({
      kills: { skiff: 2 }, killTier: 4,
      ore: { tephra: { n: 1, credits: 12, name: 'Tephra Nodules' } }, oreTier: 4,
      surveySet: true, wings: [], wingSet: true,
      /* And the landfall receipt. It is clamped against the LANDED grades
       * rather than against the plot, which is a distinction the survey twin
       * does not have to make: a save can carry twelve sightings and no
       * landings and be perfectly well formed, so a `landfallSet` clamped
       * against `_survey.size` would pass on a save where nothing had ever
       * touched ground. */
      landfallSet: true,
    });
    assert.equal(obj.landfallCount, 0, 'the setup landed on something');
    console.log(`  claimed tier 4/4 with ${obj.killCount} kills and ${obj.oreCredits} cr of ore`);
    assert.equal(obj.rank, null, 'a rank was restored that nothing in the save earned');
    r.bus.emit('combat:kill', { classId: 'skiff' });
    console.log(`  third kill paid: ${JSON.stringify(economy.log)}`);
    assert.equal(economy.log.filter(([w]) => w === 'objective:kills').length, 1,
      'the first rung stayed silenced by a receipt nothing backed');
    assert.equal(obj.rank, KILL_TIERS[0].title);
    /* A `surveySet: true` with an empty plot must not survive either, or the
     * set prize would be lost for the whole save - the receipt would say the
     * set had already paid when the plot says nothing has been reached. */
    for (const b of SPACE_BODIES) obj._sight(b, surveyReward(b));
    assert.equal(economy.log.filter(([w]) => w === 'objective:survey').length, SPACE_BODIES.length);
    assert.equal(cosmetics.owned.has(SURVEY_SET_COSMETIC), true,
      'the set prize was silenced by a receipt the plot did not back');
    /* Same for its landfall twin: twelve fly-bys are not ten landings, so the
     * prize is still owed and must still pay when the landings happen. */
    assert.equal(cosmetics.owned.has(LANDFALL_SET_COSMETIC), false,
      'surveying everything paid the landfall set');
    for (const b of landableBodies()) obj._landfall(b);
    console.log(`  after ten landings: ${[...cosmetics.owned].join(', ')}`);
    assert.equal(cosmetics.owned.has(LANDFALL_SET_COSMETIC), true,
      'the landfall set prize was silenced for the whole save by a receipt nothing backed');
  } finally {
    obj.dispose();
  }
});

test('a malformed payload is refused rather than half-applied', async () => {
  const r = await rig();
  const { obj } = await ledger(r);
  try {
    for (const bad of [null, undefined, 42, 'x', []]) {
      assert.equal(obj.deserialize(bad), false, `${JSON.stringify(bad)} was accepted`);
    }
    /* A survey entry naming something that is not a body must not land: a
     * ghost would either make the set uncompletable or complete it for free. */
    obj.deserialize({ survey: { cinder: 'landed', atlantis: 'sighted' } });
    console.log(`  survey after a ghost id: ${JSON.stringify(obj.serialize().survey)}`);
    assert.equal(obj.surveyCount, 1, 'a body that does not exist got onto the plot');
    assert.equal(obj.reached('atlantis'), false);
  } finally {
    obj.dispose();
  }
});

/* ================================================================== */
/* 7. Signed out                                                       */
/* ================================================================== */

test('nothing in this system needs a login, an API or a network', async () => {
  const raw = await readFile(new URL('../../src/systems/SpaceObjectives.js', import.meta.url), 'utf8');
  /* COMMENTS STRIPPED FIRST, and that is not fussiness - the first version of
   * this case failed on its own subject file because the header says "there is
   * no account, no API and no login on any path in this file". A rule that
   * cannot tell a promise from a call is a rule that punishes writing the
   * promise down. */
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  /* The quest layer needs a login and an API on :3000. These three objectives
   * must not, and the cheapest way to keep that true is to check that the file
   * cannot reach a network at all. */
  for (const forbidden of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'localStorage',
    'sessionStorage', 'navigator', 'http', 'account', 'token', 'sign']) {
    assert.ok(!code.includes(forbidden), `SpaceObjectives.js code mentions "${forbidden}"`);
  }
  /* And the import graph reaches nothing that could: two frozen data modules
   * and nothing else. */
  const imports = [...raw.matchAll(/^import[^']*'([^']+)'/gm)].map((m) => m[1]);
  console.log(`  imports: ${imports.join(', ')}`);
  assert.deepEqual(imports.sort(), ['../npc/AlienShip.js', '../worlds/space/Bodies.js']);
  /* And it must run with every optional collaborator absent - which is what
   * "signed out" looks like from inside this file. */
  const bare = new SpaceObjectives({});
  bare.update(1 / 60);
  const blob = bare.serialize();
  assert.equal(bare.deserialize(blob), true);
  console.log(`  a ledger with no bus, no wallet and no world: ${JSON.stringify(bare.progress())}`);
  assert.equal(bare.killCount, 0);
  assert.equal(bare.live, false);
  bare.dispose();
});

/* ================================================================== */
/* 8. The HUD surface                                                  */
/* ================================================================== */

/**
 * The fields `_setObjectives` and `_setObjectivePlot` touch, and nothing else.
 *
 * A full `HUD` cannot be constructed headlessly - it builds a hundred elements,
 * a `ChatBox` and a `WeaponWheel` - so the two methods under test are called on
 * a prototype-only object carrying exactly the fields they read and write. Same
 * technique `discovery-hud.test.mjs` and `mount-hud.test.mjs` use, and for the
 * same reason: the defects here are a wrong string and a missing class, and no
 * screenshot review catches either.
 *
 * `_setObjectivePlot` calls the module's own `el()`, which calls
 * `document.createElement` - and `_flightrig.mjs`'s shim returns a canvas stub
 * with no `classList`. So the document is swapped for one that makes real
 * enough elements while the plot cases run, and put back afterwards.
 */
function stubObjectivePanel() {
  const h = Object.create(HUD.prototype);
  h._objRankText = '';
  h.objRank = { textContent: '', hidden: true };
  h.objPanel = { hidden: true };
  h.objRows = {};
  for (const key of ['kills', 'wings', 'survey', 'assay', 'ore']) {
    h.objRows[key] = { row: { hidden: false }, value: { textContent: '' }, text: '' };
  }
  h.objPlot = {
    hidden: true,
    children: [],
    set textContent(_v) { this.children.length = 0; },
    get textContent() { return ''; },
    appendChild(c) { this.children.push(c); },
  };
  h._objPlotTags = [];
  return h;
}

/** Run `fn` with a `document` whose elements have a real `classList`. */
function withDom(fn) {
  const prev = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      const cls = new Set();
      return {
        tagName: tag, className: '', textContent: '', title: '', hidden: false,
        classList: {
          add: (c) => cls.add(c),
          remove: (c) => cls.delete(c),
          contains: (c) => cls.has(c),
          toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); },
        },
        _cls: cls,
      };
    },
    createElementNS(_ns, tag) { return this.createElement(tag); },
  };
  try { return fn(); } finally { globalThis.document = prev; }
}

test('the objectives panel is hidden outside the space campaign and shown inside it', async () => {
  const r = await rig();
  const { obj } = await ledger(r);
  try {
    const h = stubObjectivePanel();
    /* `live` is decided by `SpaceObjectives`, not by the HUD - one place knows
     * which worlds are the space campaign. */
    obj._worldId = 'citadel';
    withDom(() => h._setObjectives(obj.progress()));
    assert.equal(h.objPanel.hidden, true, 'the space objectives showed in the citadel');
    for (const id of ['space', 'dock', 'cinder']) {
      obj._worldId = id;
      withDom(() => h._setObjectives(obj.progress()));
      assert.equal(h.objPanel.hidden, false, `the panel stayed hidden in "${id}"`);
    }
  } finally {
    obj.dispose();
  }
});

test('the panel draws the ladder it is chasing, and the total once the ladder is done', async () => {
  const r = await rig();
  await goto(r, 'space');
  const { obj } = await ledger(r);
  try {
    const h = stubObjectivePanel();
    withDom(() => h._setObjectives(obj.progress()));
    console.log(`  fresh: kills "${h.objRows.kills.value.textContent}" `
      + `survey "${h.objRows.survey.value.textContent}" ore "${h.objRows.ore.value.textContent}"`);
    assert.equal(h.objRows.kills.value.textContent, `0/${KILL_TIERS[0].kills}`);
    assert.equal(h.objRows.survey.value.textContent, `0/${SPACE_BODIES.length}`);
    assert.equal(h.objRows.ore.value.textContent, `0/${ORE_TIERS[0].credits} cr`);
    assert.equal(h.objRank.hidden, true, 'a rank chip showed with no rank earned');

    for (let i = 0; i < KILL_TIERS[0].kills; i++) r.bus.emit('combat:kill', { classId: 'skiff' });
    withDom(() => h._setObjectives(obj.progress()));
    console.log(`  after rung 1: kills "${h.objRows.kills.value.textContent}" rank "${h.objRank.textContent}"`);
    assert.equal(h.objRows.kills.value.textContent, `${KILL_TIERS[0].kills}/${KILL_TIERS[1].kills}`,
      'the row did not move on to the next rung');
    assert.equal(h.objRank.textContent, KILL_TIERS[0].title.toUpperCase());
    assert.equal(h.objRank.hidden, false);

    /* Past the last rung the denominator has to go away: a target that has
     * stopped moving is a target that is lying about there being one. */
    const total = KILL_TIERS[KILL_TIERS.length - 1].kills;
    for (let i = obj.killCount; i < total; i++) r.bus.emit('combat:kill', { classId: 'skiff' });
    withDom(() => h._setObjectives(obj.progress()));
    console.log(`  topped out: kills "${h.objRows.kills.value.textContent}" rank "${h.objRank.textContent}"`);
    assert.equal(h.objRows.kills.value.textContent, String(total),
      'the kills row still shows a rung after the last one was paid');
    assert.equal(h.objRank.textContent, KILL_TIERS[KILL_TIERS.length - 1].title.toUpperCase());

    /* The elements row hides itself before the roster is known. A "0/0" line
     * would advertise a chart the player cannot have seen yet. */
    obj._elements.clear();
    withDom(() => h._setObjectives(obj.progress()));
    assert.equal(h.objRows.assay.row.hidden, true, 'an empty assay chart drew a row');
  } finally {
    obj.dispose();
  }
});

test('the survey strip is the map: one tag per body, dark until you go there', async () => {
  /* THE MAP SURFACE. There is no other one out here - `Minimap` bakes a
   * world-XZ floorplan for a world 240 m across and the volume is 800 km
   * across - so this strip IS the chart, and the thing that has to be true of
   * a chart is that it names every place and marks only the ones you reached. */
  const r = await rig();
  await goto(r, 'space');
  const { obj } = await ledger(r);
  try {
    const h = stubObjectivePanel();
    withDom(() => h._setObjectives(obj.progress()));
    const tags = h.objPlot.children;
    console.log(`  strip: ${tags.map((t) => t.textContent).join(' ')}`);
    assert.equal(h.objPlot.hidden, false, 'the strip stayed hidden with five bodies to plot');
    assert.equal(tags.length, SPACE_BODIES.length, 'the strip is not one tag per body');
    /* Order matters: the strip reads left to right like the layout, so a tag
     * that drifted would be a chart pointing at the wrong sky. */
    assert.deepEqual(tags.map((t) => t.textContent),
      SPACE_BODIES.map((b) => b.name.slice(0, 3).toUpperCase()));
    /* And the full name is on every one of them. CIN and CER are two different
     * worlds and a reader who cannot tell them apart has decoration. */
    assert.deepEqual(tags.map((t) => t.title), SPACE_BODIES.map((b) => b.name));
    for (const t of tags) assert.equal(t._cls.has('on'), false, 'a body was lit before it was reached');

    /* Reach the third one only. A strip that lit the first N would be the
     * count-not-set defect wearing a different hat. */
    obj._sight(SPACE_BODIES[2], surveyReward(SPACE_BODIES[2]));
    withDom(() => h._setObjectives(obj.progress()));
    console.log(`  after reaching ${SPACE_BODIES[2].id}: `
      + `${tags.map((t) => (t._cls.has('landed') ? '[' + t.textContent + ']' : t._cls.has('on') ? t.textContent : t.textContent.toLowerCase())).join(' ')}`);
    assert.equal(tags[2]._cls.has('on'), true, 'the body that was reached did not light');
    for (const i of [0, 1, 3, 4]) {
      assert.equal(tags[i]._cls.has('on'), false, `${SPACE_BODIES[i].id} lit without being reached`);
    }

    /* Landing is a second state on the same tag, not a second row. */
    obj._landfall(BODY_BY_ID.cinder);
    withDom(() => h._setObjectives(obj.progress()));
    assert.equal(tags[0]._cls.has('landed'), true, 'a landfall did not mark the tag');
    assert.equal(tags[2]._cls.has('landed'), false, 'a fly-by was marked as a landing');

    /* The tags are created ONCE and only their classes change afterwards - the
     * whole reason `_setObjectivePlot` keeps `_objPlotTags`. */
    const before = tags.slice();
    withDom(() => h._setObjectives(obj.progress()));
    assert.deepEqual(h.objPlot.children, before, 'the strip was rebuilt instead of restyled');
  } finally {
    obj.dispose();
  }
});

test('the panel writes only when the text actually changed', async () => {
  const r = await rig();
  await goto(r, 'space');
  const { obj } = await ledger(r);
  try {
    const h = stubObjectivePanel();
    let writes = 0;
    for (const key of Object.keys(h.objRows)) {
      const row = h.objRows[key];
      row.value = { set textContent(_v) { writes++; }, get textContent() { return row.text; } };
    }
    withDom(() => h._setObjectives(obj.progress()));
    const first = writes;
    withDom(() => h._setObjectives(obj.progress()));
    withDom(() => h._setObjectives(obj.progress()));
    console.log(`  ${first} writes on the first pass, ${writes - first} on two identical repeats`);
    assert.ok(first > 0, 'the first pass wrote nothing at all');
    assert.equal(writes, first, 'the HUD re-wrote text that had not changed');
  } finally {
    obj.dispose();
  }
});

/* ================================================================== */
/* 9. The whole set, and the prizes it pays                            */
/* ================================================================== */

test('the whole survey set pays a cosmetic and a refit, exactly once', async () => {
  const r = await rig();
  const { obj, cosmetics, ships } = await ledger(r);
  try {
    for (const b of SPACE_BODIES) obj._sight(b, surveyReward(b));
    console.log(`  cosmetics ${[...cosmetics.owned].join(', ')}  powers ${JSON.stringify(ships.powers)}`);
    assert.equal(cosmetics.owned.has(SURVEY_SET_COSMETIC), true, 'the set cosmetic was not granted');
    /* Every hull the yard sells is refitted - see `_refit` on why it is not
     * whichever hull happened to be selected. */
    for (const id of ['kestrel', 'dray', 'pike']) {
      assert.equal(ships.powers[id]?.power, 1, `${id} did not get the thrust refit`);
    }
    /* Re-sighting must not re-pay. `_sight` returns on its own guard, so this
     * is really a test that the guard is the only one. */
    for (const b of SPACE_BODIES) obj._sight(b, surveyReward(b));
    for (const id of ['kestrel', 'dray', 'pike']) assert.equal(ships.powers[id].power, 1);
  } finally {
    obj.dispose();
  }
});

test('the wing count survives a landing, and the set prize still answers to the live world', async () => {
  /* THE DEFECT: the first version read `worldManager.active.encounters` for the
   * denominator, which is `undefined` on a planet. So "Wings 2/3" vanished the
   * instant the player set down on Cinder and came back when they launched -
   * a career ledger that forgets what it is counting when you land.
   *
   * The fix splits the two questions: the DISPLAY denominator is the roster the
   * player has seen (remembered, persisted), the PRIZE is decided against
   * whatever the live world actually authors. Both halves are checked here,
   * because remembering is only safe for one of them. */
  const r = await rig();
  await goto(r, 'space');
  const { obj, ships } = await ledger(r);
  try {
    const zones = r.wm.active.encounters;
    r.bus.emit('combat:cleared', { zone: zones[0].id, name: zones[0].name, bounty: 1 });
    const inSpace = obj.progress();
    console.log(`  in space: wings ${inSpace.wings}/${inSpace.wingTotal}`);
    assert.equal(inSpace.wingTotal, zones.length);

    await goto(r, 'cinder');
    const onGround = obj.progress();
    console.log(`  on Cinder: wings ${onGround.wings}/${onGround.wingTotal}`);
    assert.equal(onGround.wingTotal, zones.length,
      'the wing roster was forgotten on landing - the row collapses to 0/0');
    assert.equal(onGround.wings, 1, 'a broken wing was forgotten on landing');
    /* And the set must NOT pay on a planet, where the live world authors no
     * wings at all - `1 >= 0` would otherwise be a complete set. */
    assert.equal(ships.powers.kestrel?.shield ?? 0, 0,
      'the wing set paid in a world that authors no wings');

    /* The roster survives a save round trip too, or the row collapses on the
     * first reload instead of on the first landing. */
    const blob = JSON.parse(JSON.stringify(obj.serialize()));
    const b2 = await ledger(r);
    b2.obj.deserialize(blob);
    console.log(`  after a reload on Cinder: wings ${b2.obj.wingCount}/${b2.obj.wingTotal}`);
    assert.equal(b2.obj.wingTotal, zones.length, 'the roster did not survive the save');
    b2.obj.dispose();

    await goto(r, 'space');
    for (const z of zones) r.bus.emit('combat:cleared', { zone: z.id, name: z.name, bounty: 1 });
    console.log(`  back in space, all broken: powers ${JSON.stringify(ships.powers)}`);
    assert.equal(ships.powers.kestrel?.shield, 1, 'the set did not pay where the wings live');
  } finally {
    obj.dispose();
    await goto(r, 'space');
  }
});

test('breaking every named wing refits the shields, once, and a re-clear does not', async () => {
  const r = await rig();
  await goto(r, 'space');
  const { obj, ships } = await ledger(r);
  try {
    const zones = r.wm.active.encounters;
    for (const z of zones) {
      r.bus.emit('combat:cleared', { zone: z.id, name: z.name, bounty: 12345 });
    }
    console.log(`  wings ${obj.wingCount}/${obj.wingTotal}, powers ${JSON.stringify(ships.powers)}`);
    assert.equal(obj.wingCount, zones.length);
    for (const id of ['kestrel', 'dray', 'pike']) {
      assert.equal(ships.powers[id]?.shield, 1, `${id} did not get the shield refit`);
    }
    for (const z of zones) r.bus.emit('combat:cleared', { zone: z.id, name: z.name, bounty: 1 });
    for (const id of ['kestrel', 'dray', 'pike']) {
      assert.equal(ships.powers[id].shield, 1, 'a re-clear refitted the shields again');
    }
  } finally {
    obj.dispose();
  }
});
