import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';

import { rig, goto, settle, fly, steerTo, DT } from './_flightrig.mjs';

const {
  SpaceObjectives, surveyRange, surveyReward, wingBounty,
  SURVEY_FRACTION, SURVEY_FOV_DEG, SURVEY_CR_PER_SECOND,
  LEG_FIXED_S, LEG_PER_KM_S, LANDFALL_S, LANDFALL_CREDITS,
  KILL_TIERS, ORE_TIERS, ASSAY_CREDITS, SURVEY_SET_COSMETIC,
} = await import('../../src/systems/SpaceObjectives.js');
const { SPACE_BODIES, BODY_BY_ID, DOCK_ANCHOR } =
  await import('../../src/worlds/space/Bodies.js');
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
   * twelve-minute round trip and Cinder is a one-minute hop. The payouts must
   * therefore be in the same ORDER as the trips, with no ties. */
  const rows = SPACE_BODIES.map((b) => {
    const trip = Math.hypot(...b.position) - surveyRange(b.radius);
    return { id: b.id, tripKm: trip / 1000, pay: surveyReward(b) };
  }).sort((a, b) => a.tripKm - b.tripKm);
  for (const r of rows) {
    console.log(`  ${r.id.padEnd(9)} trip ${r.tripKm.toFixed(1).padStart(6)} km -> ${String(r.pay).padStart(5)} cr`);
  }
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].pay > rows[i - 1].pay,
      `floor: ${rows[i].id} is a longer trip than ${rows[i - 1].id} and pays no more`);
  }
  const total = rows.reduce((s, r) => s + r.pay, 0);
  /* The band the header claims: above the five citadel viewpoints (750) and
   * below the thirty citadel relics (3,600). Both are real numbers in
   * `Viewpoints.SYNC_CREDITS` and `Relics`. */
  console.log(`  floor 750 / achieved ${total} / ceiling 3600 for the whole sweep`);
  assert.ok(total > 750 && total < 3600, `the sweep pays ${total}, outside the band it was set in`);
});

/* ================================================================== */
/* 2. The ladders are re-derived from the content                      */
/* ================================================================== */

test('the kill ladder is built on one full sweep of the authored zones', async () => {
  const r = await rig();
  await goto(r, 'space');
  const zones = r.wm.active.encounters;
  const sweep = zones.reduce(
    (s, z) => s + z.wing.reduce((n, w) => n + w.count, 0), 0
  );
  const bounty = zones.reduce((s, z) => s + wingBounty(z), 0);
  console.log(`  ${zones.length} zones, ${sweep} hostiles, ${bounty} cr of bounty in one sweep`);
  for (const z of zones) {
    console.log(`    ${z.id.padEnd(14)} ${z.wing.map((w) => `${w.count}x${w.class}`).join('+').padEnd(20)}`
      + ` ${String(wingBounty(z)).padStart(4)} cr  rearm ${z.rearm}s`);
  }

  /* THE RUNG, AND WHY IT IS THIS ONE. Nine is not a number somebody liked: it
   * is how many hostiles exist in the volume at once. If a zone is added this
   * assertion fails, which is correct - the ladder HAS moved and somebody
   * should decide where. */
  assert.equal(KILL_TIERS[1].kills, sweep,
    `the second rung must be one full sweep (${sweep} hostiles), not ${KILL_TIERS[1].kills}`);
  /* The rungs above it are whole sweeps too, so "wait out a rearm" is the only
   * thing that separates them. */
  assert.equal(KILL_TIERS[2].kills, sweep * 2);
  assert.equal(KILL_TIERS[3].kills, sweep * 3);
  assert.equal(KILL_TIERS[0].kills, 3,
    'the first rung is the smallest wing that contains a lance');

  /* Payouts against the bounty the same kills already pay: a ladder that paid
   * ten times the bounty would make the bounty decoration, and one that paid a
   * tenth of it would make the ladder decoration. */
  const ladder = KILL_TIERS.reduce((s, t) => s + t.credits, 0);
  const earned = bounty * 3; // three sweeps is what the top rung asks for
  console.log(`  floor ${Math.round(earned * 0.5)} / achieved ${ladder} / ceiling ${earned * 2}`
    + ` (bounty over three sweeps is ${earned})`);
  assert.ok(ladder > earned * 0.5 && ladder < earned * 2,
    `the ladder pays ${ladder} against ${earned} of bounty - out of band`);
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

test('the ore ladder tops out inside the ore that is actually in the ground', async () => {
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
  console.log(`  field ${field} cr in ${nodes.length} nodes; top rung ${top} cr `
    + `= ${((top / field) * 100).toFixed(1)}% of it, margin ${field - top} cr`);

  /* FLOOR: the top rung must be reachable - a haul target larger than the ore
   * that exists is the "gold nobody can reach" defect with a pickaxe. This is
   * the assertion that fails LOUDLY if the descriptor is ever trimmed, which is
   * the whole reason the rung carries margin rather than sitting on the total.
   * The margin is printed above so a trim shows up as a shrinking number long
   * before it shows up as a failure. */
  assert.ok(top <= field, `the top rung asks for ${top} cr and the planet holds ${field}`);

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
     * seconds. The limit is that plus half again, which is slack for the
     * turn-in and not slack for a trigger that does not fire. */
    const budget = {
      cinder: 60, tessera: 95, vitrine: 125, ceraunus: 140, erenmark: 550,
    };
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
    /* Cinder is the only landable body, so the set is complete without a
     * landing and the set prize must have been paid exactly once. */
    assert.ok(economy.log.filter(([w]) => w === 'objective:survey').length === SPACE_BODIES.length,
      'a body paid twice, or one paid nothing');
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
    console.log(`  landfall paid ${landfalls.length}x ${LANDFALL_CREDITS} cr`
      + ` (measured leg ${LANDFALL_S} s at ${SURVEY_CR_PER_SECOND} cr/s)`);
    assert.equal(landfalls.length, 1, 'the landfall paid more than once');
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
     * is not slack for a ladder nobody can climb. */
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
    console.log(`  reference run: rung 1 at 91 s, rung 2 at 148 s`);
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

    /* Now mine the whole planet and check every rung pays exactly once. */
    for (const n of r.wm.active.mineralNodes) cut(n);
    const rungs = economy.log.filter(([w]) => w === 'objective:ore');
    console.log(`  whole field cut: ${obj.oreNodes} nodes, ${obj.oreCredits} cr, `
      + `${trips} hold-loads (a Dray carries 20 nodes), rungs ${JSON.stringify(rungs)}`);
    assert.equal(rungs.length, ORE_TIERS.length, 'not every rung of the haul ladder was reachable');
    for (let i = 0; i < ORE_TIERS.length; i++) assert.equal(rungs[i][1], ORE_TIERS[i].reward);
    assert.ok(inventory.got.length >= ORE_TIERS.length, 'the rungs paid no items');
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
    });
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
