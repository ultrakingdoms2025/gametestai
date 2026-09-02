import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PLANETS } from '../../src/worlds/planets/index.js';
import {
  hazardSpec, makeHazardSampler, makeHazardSample,
  WIND_MIN, THIN_AIR_MAX, THIN_AIR_FLOOR, THIN_AIR_DRAIN, MAX_ESCAPE,
} from '../../src/worlds/planets/PlanetHazard.js';
import { liquidHazard } from '../../src/worlds/planets/PlanetLiquid.js';
import { CONFIG } from '../../src/core/Config.js';
import { walkGraph, ALL } from './planet-walk-kit.mjs';

/**
 * HAZARDS THAT BITE.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DEFECT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Volcanic.js` wrote it on the field itself: *"Phase 1 draws it; nothing takes
 * damage from it."* Eight of ten weather blocks were density, drift and colour,
 * and they reached a `Points` shader and stopped - on a planet whose descriptor
 * declares a 24 m radiant band around a lake of lava that kills at 240 dps.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THIS FILE REFUSES TO LET SHIP
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A hazard a player cannot see coming and cannot walk out of is worse than no
 * hazard, and that sentence is only worth writing if something checks it. Every
 * block below is a check on it, against the BUILT world:
 *
 *   3  the escape is measured by flooding each hazard's own footprint on the
 *      real collision height field and taking the distance from every live cell
 *      to the nearest dead one;
 *   4  the worst survivable walk out is integrated at `walkSpeed` against the
 *      real health pool;
 *   5  no landing pad stands in a DAMAGING hazard, because a world that hurts
 *      you for arriving is not a hazard, it is a bug;
 *   6  the tell exists in the built world - the scorch ring is drawn at exactly
 *      the radius the field charges at, not near it.
 *
 * And block 1 checks the thing that would quietly undo all of it: that no
 * planet is named anywhere in `PlanetHazard.js`, so the roster is an output of
 * the descriptors and not a list somebody maintains.
 */

const P = CONFIG.player;

const built = new Map();
async function planetWorld(planet) {
  if (!built.has(planet.id)) built.set(planet.id, await walkGraph(planet));
  return built.get(planet.id);
}

/* ---------------------------------------------------------------------- */
/* 1. The roster is derived, not listed                                    */
/* ---------------------------------------------------------------------- */

test('exactly three planets carry a live hazard, and the selectors say which', () => {
  const live = ALL.filter((p) => hazardSpec(p) !== null).map((p) => `${p.id}:${hazardSpec(p).kind}`);
  assert.deepEqual(live.sort(), ['cathedra:thin_air', 'cinder:heat', 'sirocco:wind']);
  console.log(`   [hazards] live: ${live.join(', ')} - seven planets stay scenery`);
});

test('the heat selector is the descriptor sentence it came from', () => {
  /* `Sallow.js`: "there is no lava on this planet and nothing on it is hot
   * enough to bend the air" - that is the selector, and this proves it selects.
   * Cinder is the only planet declaring `heatShimmer`; three others (Sallow,
   * Shoal, Sirocco) have liquid and none has the field. */
  const declaring = ALL.filter((p) => (p.hazards?.heatShimmer?.nearLiquid ?? 0) > 0);
  assert.deepEqual(declaring.map((p) => p.id), ['cinder']);
  const withLiquid = ALL.filter((p) => p.liquid?.bodies?.length);
  assert.ok(withLiquid.length >= 6, `only ${withLiquid.length} planets have liquid - the selector is not being tested`);
  const lethal = withLiquid.filter((p) => liquidHazard(p.liquid).lethal);
  assert.ok(lethal.length >= 2,
    'only one planet has a lethal liquid - "lethal AND heatShimmer" is no longer two conditions');
  for (const p of lethal) {
    if (p.id === 'cinder') continue;
    assert.equal(hazardSpec(p)?.kind === 'heat', false,
      `${p.id} has lethal liquid and no heatShimmer, and still got a heat band`);
  }
});

test('the wind selector is metres per second of moving air, with a real margin', () => {
  const scored = ALL.map((p) => {
    const d = p.hazards?.ashfall?.drift;
    const mag = Array.isArray(d) ? Math.hypot(d[0], d[1]) : 0;
    return { id: p.id, v: (p.hazards?.ashfall?.density ?? 0) * mag };
  }).sort((a, b) => b.v - a.v);
  assert.equal(scored[0].id, 'sirocco');
  assert.ok(scored[0].v >= WIND_MIN, `Sirocco moves ${scored[0].v.toFixed(3)} m/s against a floor of ${WIND_MIN}`);
  assert.ok(scored[1].v < WIND_MIN, `${scored[1].id} at ${scored[1].v.toFixed(3)} m/s is also over the floor`);
  const margin = scored[0].v / scored[1].v;
  assert.ok(margin > 1.5,
    `only ${margin.toFixed(2)}x between the windiest planet and the next - a threshold on a knife edge`);
  /* And the floor is a fraction of the speed it has to be felt against, not a
   * number that looked right. */
  assert.ok(WIND_MIN / P.walkSpeed > 0.10 && WIND_MIN / P.walkSpeed < 0.16,
    `WIND_MIN is ${(WIND_MIN / P.walkSpeed * 100).toFixed(0)}% of walkSpeed - re-derive it`);
  console.log(`   [hazards] wind: ${scored.slice(0, 3).map((s) => `${s.id} ${s.v.toFixed(3)}`).join(', ')}`
    + ` m/s, floor ${WIND_MIN}`);
});

test('the thin-air selector is how much light the sky scatters, with a real margin', () => {
  const withAir = ALL.filter((p) => p.sky?.kind !== 'space' && (p.sky?.sun?.intensity ?? 0) > 0);
  const scored = withAir
    .map((p) => ({ id: p.id, r: (p.sky.ambient?.intensity ?? 0) / p.sky.sun.intensity }))
    .sort((a, b) => a.r - b.r);
  assert.equal(scored[0].id, 'cathedra');
  assert.ok(scored[0].r < THIN_AIR_MAX, `Cathedra scatters ${scored[0].r.toFixed(4)}`);
  assert.ok(scored[1].r >= THIN_AIR_MAX, `${scored[1].id} at ${scored[1].r.toFixed(4)} is also under the ceiling`);
  assert.ok(scored[1].r / scored[0].r > 1.4,
    `only ${(scored[1].r / scored[0].r).toFixed(2)}x between Cathedra and the next thinnest sky`);
  /* The two airless worlds are excluded on purpose: a vacuum has no air to be
   * thin and a stamina drain there would be a suffocation mechanic nobody
   * authored. Tessera's ratio is 0.014, well under the ceiling, and it is
   * refused by the `space` branch rather than by the number. */
  for (const p of ALL) {
    if (p.sky?.kind !== 'space') continue;
    assert.equal(hazardSpec(p), null, `${p.id} is airless and got a hazard`);
  }
  console.log(`   [hazards] thin air: ${scored.slice(0, 3).map((s) => `${s.id} ${s.r.toFixed(4)}`).join(', ')}`
    + `, ceiling ${THIN_AIR_MAX}`);
});

test('no planet is named in PlanetHazard.js', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../src/worlds/planets/PlanetHazard.js', import.meta.url), 'utf8');
  /* Comments name planets constantly and should - the derivations are only
   * checkable if the measurements are written down. What must not exist is a
   * planet id in CODE, which is the `if (planet.id === ...)` the descriptor
   * contract exists to prevent. */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const p of ALL) {
    assert.equal(code.includes(`'${p.id}'`), false, `PlanetHazard.js names "${p.id}" in code`);
  }
});

/* ---------------------------------------------------------------------- */
/* 2. The magnitudes come from the descriptors                             */
/* ---------------------------------------------------------------------- */

test('the heat band is the lava\'s own rate spread over the reach it declares', () => {
  const p = PLANETS.cinder;
  const spec = hazardSpec(p);
  const lq = liquidHazard(p.liquid);
  const expect = (lq.dps * p.hazards.heatShimmer.strength) / p.hazards.heatShimmer.nearLiquid;
  assert.ok(Math.abs(spec.peakDps - expect) < 1e-9);
  assert.equal(spec.reach, p.hazards.heatShimmer.nearLiquid);
  /* Sanity on the number itself, because a magnitude nobody sanity-checked is
   * how a hazard ends up either invisible or instantly fatal. */
  assert.ok(spec.peakDps > 3 && spec.peakDps < 10,
    `${spec.peakDps} dps at the shoreline is outside the band this was designed in`);
  console.log(`   [hazards] cinder heat: ${lq.dps} dps in the lava, ${spec.peakDps.toFixed(2)} dps at the shore, `
    + `zero at ${spec.reach} m`);
});

test('the wind is the ash field\'s own speed and the dunes\' own geometry', () => {
  const p = PLANETS.sirocco;
  const spec = hazardSpec(p);
  const d = p.hazards.ashfall.drift;
  assert.ok(Math.abs(spec.push - p.hazards.ashfall.density * Math.hypot(d[0], d[1])) < 1e-9);
  assert.ok(Math.abs(spec.dirX - d[0] / Math.hypot(d[0], d[1])) < 1e-9);
  const field = p.terrain.landforms.filter((f) => f.kind === 'dunes').reduce((a, b) => (b.amp > a.amp ? b : a));
  assert.equal(spec.shelterDistance, field.wavelength / 4);
  assert.equal(spec.shelterHeight, field.amp / 4);
  /* A push that could stop a walk would be a trap, not weather. */
  assert.ok(spec.push < P.walkSpeed * 0.35,
    `${spec.push.toFixed(2)} m/s against a ${P.walkSpeed} m/s walk - that is a wall, not a wind`);
  console.log(`   [hazards] sirocco wind: ${spec.push.toFixed(2)} m/s on bearing `
    + `${((Math.atan2(spec.dirX, -spec.dirZ) * 180) / Math.PI).toFixed(0)}, shelter ${spec.shelterHeight.toFixed(1)} m `
    + `of relief ${spec.shelterDistance.toFixed(0)} m upwind`);
});

test('the thin-air drain is a fifth of the sprint cost and can never touch health', () => {
  const spec = hazardSpec(PLANETS.cathedra);
  assert.equal(spec.drain, THIN_AIR_DRAIN);
  const ratio = THIN_AIR_DRAIN / P.sprintStaminaDrain;
  assert.ok(ratio > 0.15 && ratio < 0.25,
    `the drain is ${(ratio * 100).toFixed(0)}% of the sprint cost - re-derive it`);
  assert.equal(spec.peak.dps, 0, 'thin air does damage - it must not');
  assert.equal(spec.peak.push, 0);
  /* A held sprint is rationed to pool/drain seconds; the summit shortens it. */
  const flat = P.maxStamina / P.sprintStaminaDrain;
  const high = P.maxStamina / (P.sprintStaminaDrain + THIN_AIR_DRAIN);
  console.log(`   [hazards] cathedra thin air: a held sprint runs ${flat.toFixed(1)} s at the pads and `
    + `${high.toFixed(1)} s on the summits`);
});

/* ---------------------------------------------------------------------- */
/* 3. THE WAY OUT, MEASURED ON THE BUILT TERRAIN                           */
/* ---------------------------------------------------------------------- */

test('every live hazard cell is a short walk from a dead one', async () => {
  const STEP = 4;
  for (const planet of ALL) {
    const spec = hazardSpec(planet);
    if (!spec) continue;
    const { world, lava } = await planetWorld(planet);
    const f = world.hazardField;
    assert.ok(f, `${planet.id}: hazardSpec says live and the world published nothing`);
    const field = world._terrainField;
    const out = makeHazardSample();
    const half = planet.half;
    const n = Math.floor((half * 2) / STEP) + 1;
    const live = new Uint8Array(n * n);
    let liveCount = 0;
    for (let j = 0; j < n; j++) {
      const z = -half + j * STEP;
      for (let i = 0; i < n; i++) {
        const x = -half + i * STEP;
        const y = field.sampleHeight(x, z);
        if (!Number.isFinite(y)) continue;
        /* INSIDE THE LIQUID IS NOT THE BAND, and the first draft of this
         * measured it as if it were. `at()` clamps the distance-to-edge at
         * zero, so every column inside a lava body reads full intensity - and
         * the deepest point of the 40 m disc at the foot of the Outlet Gorge
         * came out 64 m from clear air and failed this gate. It was right about
         * the number and wrong about the question: that column is not somewhere
         * a player walks into a heat band, it is the middle of a lake that
         * kills at 240 dps, has a shore barrier round it and is drawn
         * incandescent. The band's escape is measured where the band is - on
         * the ground outside the liquid. */
        if (lava(x, z, y)) continue;
        /* Sampled at head height on the ground, which is where a body is. */
        f.at(x, y + 1.0, z, out);
        if (out.intensity > 0) { live[j * n + i] = 1; liveCount++; }
      }
    }
    assert.ok(liveCount > 0, `${planet.id}: the hazard covers no ground at all`);
    /* Multi-source BFS out of every DEAD cell; the answer for a live cell is
     * how far it is from air. Manhattan on a 4 m lattice, so it over-states the
     * distance rather than under-stating it. */
    const dist = new Int32Array(n * n).fill(-1);
    const q = [];
    for (let k = 0; k < n * n; k++) if (!live[k]) { dist[k] = 0; q.push(k); }
    let head = 0;
    while (head < q.length) {
      const k = q[head++];
      const i = k % n; const j = (k - i) / n;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = i + di; const b = j + dj;
        if (a < 0 || b < 0 || a >= n || b >= n) continue;
        const kk = b * n + a;
        if (dist[kk] >= 0) continue;
        dist[kk] = dist[k] + 1;
        q.push(kk);
      }
    }
    let worst = 0; let at = null;
    for (let k = 0; k < n * n; k++) {
      if (!live[k]) continue;
      const d = dist[k] * STEP;
      if (d > worst) { worst = d; at = k; }
    }
    const ax = -half + (at % n) * STEP;
    const az = -half + ((at - (at % n)) / n) * STEP;
    const cover = ((liveCount / (n * n)) * 100).toFixed(1);
    console.log(`   [hazards] ${planet.id}/${spec.kind}: covers ${cover}% of the map, `
      + `worst walk to clear air ${worst} m (${(worst / P.walkSpeed).toFixed(1)} s)`);

    /* ── LOCAL AND PERVASIVE HAZARDS DO NOT GET THE SAME RULE ────────────
     *
     * The first draft applied the 40 m ceiling to all three and failed on
     * Sirocco at 160 m. That was the gate being wrong rather than the world: a
     * SANDSTORM HAS NO OUTSIDE. Its way out is the lee of a dune and its
     * intensity is a function of what is upwind, so on the open interdune floor
     * the nearest fully sheltered column really can be four dunes away. Writing
     * a 40 m ceiling anyway would have deleted the only weather system on the
     * planet in the name of a safety property it does not need.
     *
     * So the guarantee splits by what the hazard DOES:
     *
     *   damaging   the 40 m ceiling, because a health bar that is going down
     *              needs somewhere to run to and that somewhere has to be
     *              inside one sprint. Cinder's heat band is local by
     *              construction - it hugs four lava bodies over 3.8% of the map
     *              - and measures 16 m.
     *
     *   pervasive  a different promise: it takes no health, and its push can
     *              never stop a body walking out of it in ANY direction. That
     *              is checked at the peak rather than at the ceiling, because
     *              the peak is what a player has to be able to walk against.
     *              0.85 m/s against 4.6 is 19%: you walk upwind slower and you
     *              always walk upwind. */
    if (spec.peak.dps > 0) {
      assert.ok(worst <= MAX_ESCAPE,
        `${planet.id}: the deepest point of the ${spec.kind} hazard is ${worst} m from clear air, at (${ax}, ${az}) `
        + `- the ceiling is ${MAX_ESCAPE} m and a damaging hazard you cannot walk out of is a trap`);
    } else {
      assert.equal(spec.peak.dps, 0);
      assert.ok(spec.peak.push < P.walkSpeed * 0.5,
        `${planet.id}: the ${spec.kind} pushes at ${spec.peak.push.toFixed(2)} m/s against a ${P.walkSpeed} m/s `
        + 'walk - a pervasive hazard has to be one a body can always walk out of');
      /* And the lee has to EXIST. A shelter rule nothing on the map satisfies
       * is a way out on paper. */
      assert.ok(liveCount < n * n * 0.97,
        `${planet.id}: the ${spec.kind} covers ${cover}% of the map - there is nowhere to get out of it`);
    }
  }
});

/* ---------------------------------------------------------------------- */
/* 4. It cannot kill somebody who walks straight out                       */
/* ---------------------------------------------------------------------- */

test('the worst walk out of a damaging hazard costs less than half the health pool', async () => {
  for (const planet of ALL) {
    const spec = hazardSpec(planet);
    if (!spec || !(spec.peak.dps > 0)) continue;
    const { world } = await planetWorld(planet);
    const f = world.hazardField;
    /* Worst case and then some: start ON the shoreline at peak intensity and
     * walk straight out at `walkSpeed`, integrating the linear falloff. The
     * real integral of `peak * (1 - d/reach)` over `d = 0..reach` at speed v is
     * `peak * reach / (2v)`. */
    const cost = (spec.peak.dps * spec.reach) / (2 * P.walkSpeed);
    assert.ok(cost < P.maxHealth * 0.5,
      `${planet.id}: walking out of the ${spec.kind} band from its hottest point costs ${cost.toFixed(0)} of `
      + `${P.maxHealth} health - that is a hazard that kills a player who did the right thing`);
    /* And it has to cost SOMETHING, or the tell is a lie. */
    assert.ok(cost > 5,
      `${planet.id}: walking out costs ${cost.toFixed(1)} health - a hazard nobody notices is scenery with a `
      + 'shader attached');
    /* Standing still in the worst of it must be survivable long enough to
     * notice, which is what makes the scorch ring a warning rather than an
     * epitaph. */
    const seconds = P.maxHealth / spec.peak.dps;
    assert.ok(seconds > 10,
      `${planet.id}: standing on the shoreline kills in ${seconds.toFixed(1)} s`);
    console.log(`   [hazards] ${planet.id}: walking out of the band costs ${cost.toFixed(0)} health; `
      + `standing in the worst of it kills in ${seconds.toFixed(0)} s`);
  }
});

test('no landing pad stands in a damaging hazard', async () => {
  for (const planet of ALL) {
    const spec = hazardSpec(planet);
    if (!spec) continue;
    const { world } = await planetWorld(planet);
    const out = makeHazardSample();
    for (const site of world.landingSites) {
      const s = world.hazardField.at(site.position.x, site.position.y + 1.0, site.position.z, out);
      assert.equal(s.dps, 0,
        `${planet.id}: pad "${site.id}" takes ${s.dps.toFixed(2)} dps - a world that hurts you for arriving `
        + 'in it is not a hazard, it is a bug');
      /* DAMAGE is the line, and push and stamina are deliberately on the other
       * side of it. The first draft refused a pad in ANY hazard and failed on
       * Sirocco's Pan Head, which is a 118 m apron in the middle of a dune sea
       * on the windiest planet in the system: refusing that is refusing the
       * planet. Neither of the two non-damaging channels can trap anybody -
       * 0.85 m/s of wind against a 4.6 m/s walk is 19%, and stamina gates the
       * sprint and the free-climb and is read by nothing that moves a walking
       * body, by `Unstuck` or by `respawn`. Both are also the first thing a
       * player meets on stepping off the ramp, which is the cheapest tutorial
       * either hazard will ever get. Logged, so a change to either magnitude
       * shows up in the run rather than in a playthrough. */
      const drift = Math.hypot(s.pushX, s.pushZ);
      if (drift > 0) {
        assert.ok(drift < P.walkSpeed * 0.35,
          `${planet.id}: pad "${site.id}" is pushed at ${drift.toFixed(2)} m/s against a ${P.walkSpeed} m/s walk`);
        console.log(`   [hazards] ${planet.id}: pad "${site.id}" stands in ${drift.toFixed(2)} m/s of `
          + `${spec.name} - allowed; that is ${((drift / P.walkSpeed) * 100).toFixed(0)}% of a walk`);
      }
      if (s.stamina > 0) {
        console.log(`   [hazards] ${planet.id}: pad "${site.id}" stands in ${s.stamina.toFixed(2)} stam/s of `
          + `${spec.name} - allowed, because it cannot reduce a hit point`);
      }
    }
  }
});

test('no viewpoint stands in a damaging hazard', async () => {
  /* THIS ONE CAUGHT A SHIPPED DEFECT AND IS HERE BECAUSE IT DID.
   *
   * Cinder's first `far_cone` viewpoint was authored on the crown of the
   * western cone - the one this planet's own map notes call "still alight" -
   * and the vent in its summit pit is a 4.4 m disc of lava with a live 24 m
   * heat band round it. The viewpoint read 1.8 dps. That is worse than a hot
   * place to stand: `Viewpoints.travelTo` is a TELEPORT, so a synchronised
   * anchor inside a damaging field is a menu row that drops the player into
   * damage from anywhere on the planet, with no approach, no tell and no
   * warning. Moved to the west shoulder, 33 m clear of the vent's rim.
   *
   * A viewpoint in the WIND or the THIN AIR is fine and Sirocco's three are all
   * in the wind on purpose - the best views on that planet are its dune crests
   * and a crest is the windiest thing on it. Neither channel can take a hit
   * point. */
  for (const planet of ALL) {
    const spec = hazardSpec(planet);
    if (!spec || !(spec.peak.dps > 0)) continue;
    const { world } = await planetWorld(planet);
    const out = makeHazardSample();
    for (const vp of world.viewpoints) {
      const s = world.hazardField.at(vp.x, vp.y + 1.0, vp.z, out);
      assert.equal(s.dps, 0,
        `${planet.id}/${vp.id} takes ${s.dps.toFixed(2)} dps where it stands - and travelTo teleports the `
        + 'player straight into it');
      /* And the approach to it: the sync disc, not just the sample. */
      for (let a = 0; a < 8; a++) {
        const th = (a / 8) * Math.PI * 2;
        const px = vp.x + Math.cos(th) * (vp.r + 2.5);
        const pz = vp.z + Math.sin(th) * (vp.r + 2.5);
        const py = world._terrainField.sampleHeight(px, pz);
        if (!Number.isFinite(py)) continue;
        assert.equal(world.hazardField.at(px, py + 1.0, pz, out).dps, 0,
          `${planet.id}/${vp.id}: the edge of its own sync disc is in the ${spec.kind}`);
      }
    }
  }
});

/* ---------------------------------------------------------------------- */
/* 5. The tells are in the built world                                     */
/* ---------------------------------------------------------------------- */

test('the scorch ring is drawn at exactly the radius the heat charges at', async () => {
  const planet = PLANETS.cinder;
  const spec = hazardSpec(planet);
  const { world } = await planetWorld(planet);
  const mesh = world.group.getObjectByName(`planet:${planet.id}:scorch`);
  assert.ok(mesh, 'no scorch mesh - the heat band has no tell');
  const pos = mesh.geometry.getAttribute('position');
  const heat = mesh.geometry.getAttribute('aHeat');
  assert.ok(pos.count > 500, `the scorch ring is ${pos.count} vertices - it cannot be following four bodies`);

  const out = makeHazardSample();
  const field = world._terrainField;

  /* (a) THE INNER EDGE IS THE SHORELINE. Every vertex the geometry paints
   * hottest must be somewhere the field charges hardest. */
  let hotChecked = 0;
  for (let i = 0; i < pos.count; i++) {
    if (heat.getX(i) <= 0.99) continue;
    const x = pos.getX(i); const z = pos.getZ(i);
    const y = field.sampleHeight(x, z);
    if (!Number.isFinite(y)) continue;
    const s = world.hazardField.at(x, y + 1.0, z, out);
    assert.ok(s.intensity > 0.9,
      `scorch marked hottest at (${x.toFixed(1)}, ${z.toFixed(1)}) where the field reads ${s.intensity.toFixed(2)}`);
    hotChecked++;
  }
  assert.ok(hotChecked > 100, `only ${hotChecked} shoreline vertices - the ring is not being exercised`);

  /* (b) EACH DISC'S RING RUNS FROM ITS SHORE TO EXACTLY THE REACH. The paint's
   * outer radius is the number the field stops charging at, not a number near
   * it - which is the whole claim the tell makes. */
  for (const b of PLANETS.cinder.liquid.bodies) {
    if (b.shape !== 'disc') continue;
    let lo = Infinity; let hi = 0;
    for (let i = 0; i < pos.count; i++) {
      const d = Math.hypot(pos.getX(i) - b.x, pos.getZ(i) - b.z);
      if (d > b.r + spec.reach + 1) continue;
      if (Math.abs(d - b.r) < 0.01 || Math.abs(d - (b.r + spec.reach)) < 0.01) {
        lo = Math.min(lo, d); hi = Math.max(hi, d);
      }
    }
    assert.ok(Math.abs(lo - b.r) < 0.01 && Math.abs(hi - (b.r + spec.reach)) < 0.01,
      `the ring round the disc at (${b.x}, ${b.z}) runs ${lo.toFixed(2)}..${hi.toFixed(2)} m, not `
      + `${b.r}..${b.r + spec.reach}`);
  }

  /* (c) AND IT COVERS THE FIELD. Every column the band really charges has paint
   * on it. `reach / 2` of tolerance because the geometry is a polygon with four
   * radial rings and the field is a set of exact circles and ribbons - a
   * triangulated ring cannot land a vertex on every column, and half the band's
   * own width is the honest bound on how far it can be from one.
   *
   * The FIRST version of this test asserted the converse - "a vertex painted
   * cold reads cold" - and it failed at (-273.9, -266.9): the outer rim of the
   * ring round one lava body sits inside the band of the body next to it, so
   * the paint there is drawn by the OTHER ring. The assertion was measuring the
   * per-body geometry and calling it coverage. This measures coverage. */
  const { lava } = await planetWorld(planet);
  let cells = 0; let worstGap = 0; let worstAt = null;
  for (let z = -planet.half; z <= planet.half; z += 6) {
    for (let x = -planet.half; x <= planet.half; x += 6) {
      const y = field.sampleHeight(x, z);
      if (!Number.isFinite(y)) continue;
      /* Inside the lake there is no paint and there does not need to be: the
       * lake is drawn incandescent, walled by a shore barrier and killing at
       * 240 dps. The ring paints the BAND, which is the part with no other
       * tell. Same exclusion, same reason, as the escape sweep above. */
      if (lava(x, z, y)) continue;
      const s = world.hazardField.at(x, y + 1.0, z, out);
      if (s.intensity < 0.25) continue;
      cells++;
      let near = Infinity;
      for (let i = 0; i < pos.count; i++) {
        const d = Math.hypot(pos.getX(i) - x, pos.getZ(i) - z);
        if (d < near) near = d;
      }
      if (near > worstGap) { worstGap = near; worstAt = [x, z]; }
    }
  }
  assert.ok(cells > 200, `only ${cells} live columns sampled - the coverage check is not doing anything`);
  assert.ok(worstGap <= spec.reach / 2,
    `a column at (${worstAt}) takes ${(spec.peakDps * 0.25).toFixed(1)}+ dps and the nearest scorch vertex is `
    + `${worstGap.toFixed(1)} m away - the paint does not cover the damage`);

  console.log(`   [hazards] cinder scorch: ${pos.count} vertices, `
    + `${(mesh.geometry.index.count / 3).toLocaleString()} triangles, one draw call, no collider; `
    + `worst paint gap over ${cells} live columns ${worstGap.toFixed(1)} m`);
  assert.equal(world.colliders.some((c) => c === mesh), false);
});

test('the ash field breathes with the hazard on the two planets that have no other tell', async () => {
  for (const key of ['sirocco', 'cathedra']) {
    const planet = PLANETS[key];
    const { world } = await planetWorld(planet);
    assert.ok(world._ash, `${key}: no ash field to drive`);
    const cam = { position: { x: 0, y: 0, z: 0 }, getWorldPosition: null };
    const base = world._ash.uniforms.uOpacity.value;

    const spec = hazardSpec(planet);
    const field = world._terrainField;
    /* Two real columns: the most exposed ground the hazard knows about and the
     * least, sampled off the built terrain, driven through the world's own
     * per-frame path rather than through a re-implementation of it. */
    const out = makeHazardSample();
    let hot = null; let cold = null;
    for (let z = -planet.half + 20; z < planet.half - 20; z += 20) {
      for (let x = -planet.half + 20; x < planet.half - 20; x += 20) {
        const y = field.sampleHeight(x, z);
        if (!Number.isFinite(y)) continue;
        const s = world.hazardField.at(x, y + 1.0, z, out);
        if (!hot || s.intensity > hot.i) hot = { x, y, z, i: s.intensity };
        if (!cold || s.intensity < cold.i) cold = { x, y, z, i: s.intensity };
      }
    }
    assert.ok(hot.i > 0.5, `${key}: the strongest point of the ${spec.kind} reads ${hot.i.toFixed(2)}`);
    assert.equal(cold.i, 0, `${key}: nowhere on the map is clear of the ${spec.kind}`);

    const drive = (p) => {
      cam.getWorldPosition = (v) => { v.set(p.x, p.y + 1.0, p.z); return v; };
      world.engine = { ...world.engine, camera: cam };
      world._ashBase = null;
      world._ash.uniforms.uOpacity.value = base;
      world._breatheAsh();
      return world._ash.uniforms.uOpacity.value;
    };
    const inIt = drive(hot);
    const outOfIt = drive(cold);
    assert.notEqual(inIt, outOfIt,
      `${key}: the ash field looks identical inside and outside the ${spec.kind} - there is no tell`);
    const ratio = Math.max(inIt, outOfIt) / Math.min(inIt, outOfIt);
    assert.ok(ratio > 1.4,
      `${key}: only ${ratio.toFixed(2)}x of density between the worst of the ${spec.kind} and clear air`);
    world._ash.uniforms.uOpacity.value = base;
    world._ashBase = null;
    console.log(`   [hazards] ${key}: ash opacity ${outOfIt.toFixed(3)} clear -> ${inIt.toFixed(3)} in the `
      + `${spec.kind} (${ratio.toFixed(2)}x)`);
  }
});

/* ---------------------------------------------------------------------- */
/* 6. The sampler itself                                                   */
/* ---------------------------------------------------------------------- */

test('the sampler allocates nothing and answers zero off the field', () => {
  const spec = hazardSpec(PLANETS.cinder);
  const s = makeHazardSampler(spec, {
    groundAt: () => 0, liquidSurfaceAt: () => 0, minY: 0, maxY: 100,
  });
  const out = makeHazardSample();
  const same = s.at(0, 0, 0, out);
  assert.equal(same, out, 'the sampler returned a new object - that is 60 allocations a second');
  /* Far from any body: zero, and every channel cleared rather than left over
   * from the last call. A stale `pushX` is the shape of bug a shared record
   * invites, so it is checked rather than assumed. */
  out.pushX = 9; out.dps = 9; out.stamina = 9; out.intensity = 9;
  s.at(1e5, 0, 1e5, out);
  assert.deepEqual(out, { intensity: 0, dps: 0, pushX: 0, pushZ: 0, stamina: 0 });
});

test('the heat band stops above the plume and the thin air starts where the relief says', () => {
  const cinder = hazardSpec(PLANETS.cinder);
  const sh = makeHazardSampler(cinder, { groundAt: () => 0, minY: 0, maxY: 100 });
  const body = cinder.bodies.find((b) => b.shape === 'disc');
  const out = makeHazardSample();
  /* On the shore, at the surface: hot. The same column `rise` metres higher:
   * nothing, because a body on the rim is looking at the lake rather than
   * standing in it. */
  const x = body.x + body.r + 1;
  assert.ok(sh.at(x, body.y, body.z, out).dps > 0);
  assert.equal(sh.at(x, body.y + cinder.rise + 1, body.z, out).dps, 0);

  const cath = hazardSpec(PLANETS.cathedra);
  const st = makeHazardSampler(cath, { groundAt: () => 0, minY: -16.3, maxY: 87.7 });
  const floor = -16.3 + THIN_AIR_FLOOR * (87.7 - -16.3);
  assert.equal(st.at(0, floor - 1, 0, out).stamina, 0);
  assert.ok(Math.abs(st.at(0, 87.7, 0, out).stamina - THIN_AIR_DRAIN) < 1e-9);
  assert.ok(Math.abs(st.at(0, (floor + 87.7) / 2, 0, out).stamina - THIN_AIR_DRAIN / 2) < 1e-6);
  console.log(`   [hazards] cathedra: thin air starts at ${floor.toFixed(1)} m and is full at 87.7 m`);
});

test('the wind lets go in the lee of a dune', () => {
  const spec = hazardSpec(PLANETS.sirocco);
  const out = makeHazardSample();
  /* Flat ground: full push. Ground that rises `shelterHeight` upwind: none.
   * The upwind sample is at `-dir * shelterDistance`, so the mock puts the
   * dune exactly there. */
  const flat = makeHazardSampler(spec, { groundAt: () => 10, minY: 0, maxY: 90 });
  assert.ok(Math.abs(Math.hypot(...[flat.at(0, 11, 0, out).pushX, out.pushZ]) - spec.push) < 1e-9);

  const ux = -spec.dirX * spec.shelterDistance;
  const uz = -spec.dirZ * spec.shelterDistance;
  const lee = makeHazardSampler(spec, {
    groundAt: (x, z) => (Math.hypot(x - ux, z - uz) < 1 ? 10 + spec.shelterHeight : 10),
    minY: 0, maxY: 90,
  });
  assert.equal(lee.at(0, 11, 0, out).pushX, 0, 'the dune upwind did not shelter anything');
  assert.equal(out.intensity, 0);
});
