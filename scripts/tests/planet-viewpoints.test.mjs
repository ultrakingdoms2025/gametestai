import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PLANETS } from '../../src/worlds/planets/index.js';
import {
  definePlanet, VIEWPOINT_R, VIEWPOINT_PAD_CLEARANCE, VIEWPOINT_MIN_SEPARATION, VIEWPOINT_MAX,
} from '../../src/worlds/planets/PlanetDescriptor.js';
import { normaliseViewpoint, REVEAL_R, SYNC_PAD, SYNC_BAND, MAX_TRAVEL_ROWS } from '../../src/systems/Viewpoints.js';
import { CONFIG } from '../../src/core/Config.js';
import { walkGraph, world_, ALL, PITCH, STEP_UP, MAX_RISE, DROP_MAX } from './planet-walk-kit.mjs';

/**
 * PLANET VIEWPOINTS: thirty places on ten worlds, and the proof a body can
 * stand on each of them.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DEFECT THIS ANSWERS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `src/systems/Viewpoints.js` states its contract in one line - a world
 * publishes `[{ id, name, x, y, z, r }]` and gets a map reveal, a fast-travel
 * anchor, credits, coin, a set prize, a minimap marker and a `Charters` column.
 * Two worlds published it. The ten planets - 916 to 1461 lines of descriptor
 * each, with their own minerals, liquid, gravity and weather - published
 * nothing, and `Charters` could count exactly one thing on a planet: its seam
 * total.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DEFECT THIS FILE MUST NOT CREATE, WHICH IS THE HARDER ONE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This repo's signature failure is content that was BUILT and could not be
 * REACHED, passing a green suite that measured the building. A viewpoint is the
 * purest form of it: an id, a name and three numbers will publish, mark the
 * map, appear in the pause hub and never once be asked whether a player could
 * get there.
 *
 * So every assertion below is against the BUILT world - one real `PlanetWorld`
 * per planet, the real `Physics`, the real collision height field - and never
 * against the descriptor's own table. In particular:
 *
 *   - the y is read off the COLLISION field and compared against `groundAt`,
 *     the descriptor's continuous height function, and the two are shown to
 *     disagree, so the choice between them is a measurement rather than a
 *     preference;
 *   - reachability is the 38-degree walk lattice from `planet-walk-kit`, the
 *     same envelope `planet-reach` and `planet-minerals` flood, with NO jump,
 *     NO mantle and NO free-climb. That is a SUFFICIENT condition and a
 *     deliberately pessimistic one: `Player._move`'s own step-up ladder is
 *     measured in its header at 58 degrees, so anything this lattice reaches is
 *     reachable and plenty it refuses is too. Proving a place reachable with a
 *     model I wrote is worth something; proving it UNREACHABLE with one is not,
 *     and nothing here tries to;
 *   - the platform under the published point is checked for standing room
 *     against the same prop-box index the walk lattice uses.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  AND THE GRAVITY MEASUREMENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Gravity spans 1.62 m/s2 on Tessera to 10.10 on Verdigris and it is genuinely
 * wired: `Player.setWorldGravity` scales the jump velocity by `ratio^(1/3)` and
 * the gravity by `ratio`, so the apex goes as `ratio^(-1/3)` and the hang time
 * as `ratio^(-2/3)`. Horizontal speed does not scale at all, so the thing that
 * really moves across the ten worlds is the BROAD JUMP - and block 6 measures
 * it, then measures what it is worth on the real terrain by flooding each
 * planet twice: once walking, and once with ballistic edges at that planet's
 * own carry.
 */

/* ---------------------------------------------------------------------- */
/* The ballistics, re-derived from CONFIG rather than quoted               */
/* ---------------------------------------------------------------------- */

const P = CONFIG.player;
const JUMP_EXP = 1 / 3;

/** Apex, hang time and level broad jump under a planet's own gravity. */
function ballistics(gravity) {
  const raw = gravity / P.gravityReference;
  const ratio = Math.min(4, Math.max(0.01, raw));
  const jv = P.jumpVelocity * Math.pow(ratio, JUMP_EXP);
  const g = -P.gravity * ratio;
  return {
    ratio,
    apex: (jv * jv) / (2 * g),
    hang: (2 * jv) / g,
    walkJump: P.walkSpeed * ((2 * jv) / g),
    sprintJump: P.sprintSpeed * ((2 * jv) / g),
  };
}

/* One built world per planet, shared with the walk kit's cache. */
const built = new Map();
async function planetWorld(planet) {
  if (!built.has(planet.id)) built.set(planet.id, await walkGraph(planet));
  return built.get(planet.id);
}

/** Every published viewpoint on every planet, with its world. */
async function everyViewpoint() {
  const rows = [];
  for (const planet of ALL) {
    const { world } = await planetWorld(planet);
    for (const vp of world.viewpoints) rows.push({ planet, world, vp });
  }
  return rows;
}

/* ---------------------------------------------------------------------- */
/* 1. The contract                                                         */
/* ---------------------------------------------------------------------- */

test('every planet publishes viewpoints the Viewpoints system accepts', async () => {
  let total = 0;
  for (const planet of ALL) {
    const { world } = await planetWorld(planet);
    assert.ok(Array.isArray(world.viewpoints), `${planet.id}: no viewpoints array`);
    assert.ok(world.viewpoints.length >= 3,
      `${planet.id} publishes ${world.viewpoints.length} viewpoints - the whole point of this drop is that a `
      + 'planet offers something to walk to, and one is not a set');
    for (let i = 0; i < world.viewpoints.length; i++) {
      const norm = normaliseViewpoint(world.viewpoints[i], i);
      /* THE REAL CONSUMER, not a re-implementation of it. `normaliseViewpoint`
       * returns null for a missing id or a non-finite x/y/z and it does it
       * SILENTLY - a viewpoint that fails it is simply absent from the game
       * with no error anywhere, which is the failure this line exists to make
       * loud. */
      assert.ok(norm, `${planet.id}/${world.viewpoints[i]?.id}: Viewpoints.normaliseViewpoint rejected it`);
      assert.equal(norm.id, world.viewpoints[i].id);
      assert.ok(norm.r >= 3, `${planet.id}/${norm.id}: r ${norm.r}`);
      assert.equal(norm.launch, null,
        `${planet.id}/${norm.id} published a leap of faith - a wilderness has no haystack under anything`);
    }
    total += world.viewpoints.length;
  }
  assert.equal(total, 30, `expected 30 planet viewpoints, got ${total}`);
});

test('the pause hub can travel to every viewpoint a planet publishes', async () => {
  /* `main.js` splices `hubItems()` in ONCE at boot with no argument, so
   * `MAX_TRAVEL_ROWS` is the hard ceiling on anchors per world: an eleventh
   * viewpoint would synchronise, pay its prize, reveal its district and then
   * have nowhere in the menu to be travelled to. `VIEWPOINT_MAX` is this
   * project's second copy of that number and nothing in either module compares
   * them - the same arrangement `HOLD_UNITS_PER_SIZE` lives under. */
  assert.equal(VIEWPOINT_MAX, MAX_TRAVEL_ROWS,
    `PlanetDescriptor.VIEWPOINT_MAX is ${VIEWPOINT_MAX} and Viewpoints.MAX_TRAVEL_ROWS is ${MAX_TRAVEL_ROWS}`);
  for (const planet of ALL) {
    assert.ok(planet.viewpoints.length <= MAX_TRAVEL_ROWS,
      `${planet.id} publishes ${planet.viewpoints.length} viewpoints against ${MAX_TRAVEL_ROWS} travel rows`);
  }
});

test('the descriptor default radius is the one Viewpoints falls back to', () => {
  /* `Viewpoints.DEFAULT_R` is module-private, so it is scraped rather than
   * imported. A descriptor default that drifted from it would mean the platform
   * a test measures and the platform the game syncs on are different sizes. */
  const src = readFileSync(new URL('../../src/systems/Viewpoints.js', import.meta.url), 'utf8');
  const m = src.match(/const DEFAULT_R = (\d+(?:\.\d+)?);/);
  assert.ok(m, 'Viewpoints.js no longer declares DEFAULT_R - update this scrape');
  assert.equal(Number(m[1]), VIEWPOINT_R,
    `Viewpoints.DEFAULT_R is ${m[1]} and PlanetDescriptor.VIEWPOINT_R is ${VIEWPOINT_R}`);
});

/* ---------------------------------------------------------------------- */
/* 2. The height is MEASURED, and the two answers differ                   */
/* ---------------------------------------------------------------------- */

test('every published y is the collision height field, not the descriptor height function', async () => {
  let worst = 0;
  let worstAt = '';
  for (const { planet, world, vp } of await everyViewpoint()) {
    const field = world._terrainField;
    assert.ok(field, `${planet.id}: no terrain collision field kept`);
    const collision = field.sampleHeight(vp.x, vp.z);
    assert.ok(Number.isFinite(collision), `${planet.id}/${vp.id}: no collision ground`);
    assert.ok(Math.abs(vp.y - collision) < 1e-9,
      `${planet.id}/${vp.id}: published y ${vp.y} is not the collision sample ${collision}`);
    const continuous = world.groundAt(vp.x, vp.z);
    const gap = Math.abs(continuous - collision);
    if (gap > worst) { worst = gap; worstAt = `${planet.id}/${vp.id}`; }
  }
  /* THE REASON THE RULE EXISTS, MEASURED RATHER THAN ASSERTED.
   *
   * `groundAt` re-evaluates the continuous height field; `sampleHeight`
   * interpolates the two triangles the collider was built from and the player's
   * capsule is resolved against. They agree at the grid nodes and nowhere else,
   * and on a crater rim - which is where most of these thirty stand - the sag
   * between two samples is the curvature of the rim.
   *
   * If this ever reads zero the two functions have become the same function and
   * the rule in `PlanetDescriptor` about refusing an authored `y` has lost its
   * reason; that is worth knowing, so it fails rather than passing quietly. */
  assert.ok(worst > 0.01,
    `groundAt and the collision field now agree everywhere (worst ${worst} m) - re-derive why y is measured`);
  console.log(`   [viewpoints] worst groundAt-vs-collision disagreement ${worst.toFixed(3)} m at ${worstAt}`);
});

/* ---------------------------------------------------------------------- */
/* 3. Not a pad, not a pile-up, not underwater                             */
/* ---------------------------------------------------------------------- */

test('no viewpoint is on or beside a landing pad', async () => {
  for (const { planet, world, vp } of await everyViewpoint()) {
    for (const site of world.landingSites) {
      const gap = Math.hypot(site.position.x - vp.x, site.position.z - vp.z) - site.radius;
      assert.ok(gap >= VIEWPOINT_PAD_CLEARANCE,
        `${planet.id}/${vp.id} stands ${gap.toFixed(1)} m off pad "${site.id}" - a viewpoint you land on pays a `
        + "climb's prize for stepping off a ramp");
    }
  }
});

test('viewpoints do not share a district', async () => {
  /* `VIEWPOINT_MIN_SEPARATION` is justified against `REVEAL_R` in the
   * descriptor, so the two are pinned together here rather than left as a pair
   * of numbers that happen to look right. */
  assert.ok(VIEWPOINT_MIN_SEPARATION > REVEAL_R,
    `separation ${VIEWPOINT_MIN_SEPARATION} m is inside one reveal disc of ${REVEAL_R} m`);
  for (const planet of ALL) {
    const { world } = await planetWorld(planet);
    for (let i = 0; i < world.viewpoints.length; i++) {
      for (let j = i + 1; j < world.viewpoints.length; j++) {
        const a = world.viewpoints[i];
        const b = world.viewpoints[j];
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        assert.ok(d >= VIEWPOINT_MIN_SEPARATION,
          `${planet.id}: ${a.id} and ${b.id} are ${d.toFixed(1)} m apart`);
      }
    }
  }
});

test('no viewpoint is under its planet\'s own liquid', async () => {
  /* `definePlanet` can only refuse a RIBBON: Shoal's sea is one disc containing
   * the whole playfield with a 75 m cone standing out of it, and a horizontal
   * test condemns the cone. This is the three-dimensional half, against the
   * measured ground and the liquid's own surface. */
  let checked = 0;
  for (const { planet, world, vp } of await everyViewpoint()) {
    const field = world.liquidField;
    if (!field) continue;
    checked++;
    const surf = field.surfaceAt(vp.x, vp.z);
    if (!Number.isFinite(surf)) continue;
    assert.ok(vp.y >= surf,
      `${planet.id}/${vp.id} is ${(surf - vp.y).toFixed(1)} m under the ${field.name}`);
  }
  assert.ok(checked >= 15, `only ${checked} viewpoints sit on liquid worlds - the case is not being exercised`);
});

/* ---------------------------------------------------------------------- */
/* 4. There is standing room                                               */
/* ---------------------------------------------------------------------- */

test('every viewpoint has a standable platform under the sync band', async () => {
  for (const { planet, world, vp } of await everyViewpoint()) {
    const field = world._terrainField;
    /* The point itself must be walkable ground: measured over the collision
     * field's own cell so the gradient is the one the capsule solver meets. */
    const cell = world.cell;
    const gx = field.sampleHeight(vp.x + cell, vp.z);
    const gnx = field.sampleHeight(vp.x - cell, vp.z);
    const gz = field.sampleHeight(vp.x, vp.z + cell);
    const gnz = field.sampleHeight(vp.x, vp.z - cell);
    assert.ok([gx, gnx, gz, gnz].every(Number.isFinite), `${planet.id}/${vp.id}: ground runs off the field`);
    const grade = Math.hypot((gx - gnx) / (2 * cell), (gz - gnz) / (2 * cell));
    const deg = (Math.atan(grade) * 180) / Math.PI;
    assert.ok(deg <= 30,
      `${planet.id}/${vp.id} stands on ${deg.toFixed(1)} degrees - the sync platform is a slide`);

    /* And the platform has to have somewhere to stand ON it.
     *
     * `Viewpoints.update` syncs inside `r + SYNC_PAD` horizontally AND within
     * `SYNC_BAND` vertically, so what actually decides whether a place is
     * standable-and-synchronising is the radius out to which BOTH still hold.
     * The measurement below walks that radius out in 0.5 m steps and stops at
     * the first ring where any of twelve bearings has left the band.
     *
     * A summit is allowed to be a summit - Shoal's Kelphold cone falls away at
     * 31 degrees and its full 10.5 m reach is nowhere near level - but a spike
     * whose only synchronising point is the published sample would be a prize
     * you can walk over without collecting, so the disc has to be walkable
     * ground you can stand anywhere in. 3 m is a capsule diameter and a half
     * either side of the centre, i.e. you cannot miss it. */
    const reach = vp.r + SYNC_PAD;
    let band = 0;
    for (let rr = 0.5; rr <= reach; rr += 0.5) {
      let allIn = true;
      for (let a = 0; a < 12 && allIn; a++) {
        const th = (a / 12) * Math.PI * 2;
        const h = field.sampleHeight(vp.x + Math.cos(th) * rr, vp.z + Math.sin(th) * rr);
        if (!Number.isFinite(h) || Math.abs(h - vp.y) > SYNC_BAND) allIn = false;
      }
      if (!allIn) break;
      band = rr;
    }
    assert.ok(band >= 3,
      `${planet.id}/${vp.id}: the synchronising disc is only ${band.toFixed(1)} m across - that is a spike, `
      + 'not a platform');
  }
});

test('no viewpoint is inside a prop', async () => {
  for (const planet of ALL) {
    const { world, blocked, lava } = await planetWorld(planet);
    for (const vp of world.viewpoints) {
      assert.equal(blocked(vp.x, vp.z, vp.y), false,
        `${planet.id}/${vp.id} is inside a solid prop box`);
      assert.equal(lava(vp.x, vp.z, vp.y), false,
        `${planet.id}/${vp.id} is inside a liquid body`);
    }
  }
});

/* ---------------------------------------------------------------------- */
/* 5. A PLAYER CAN WALK THERE                                              */
/* ---------------------------------------------------------------------- */

test('every viewpoint is walk-reachable from a landing pad, with no jump at all', async () => {
  const report = [];
  for (const planet of ALL) {
    const { world, L } = await planetWorld(planet);
    const best = new Map();
    for (const site of world.landingSites) {
      L.from(site.position.x, site.position.z);
      for (const vp of world.viewpoints) {
        const d = L.to(vp.x, vp.z);
        const cur = best.get(vp.id);
        if (!cur || d < cur.d) best.set(vp.id, { d, pad: site.id });
      }
    }
    for (const vp of world.viewpoints) {
      const r = best.get(vp.id);
      assert.ok(r && r.d < Infinity,
        `${planet.id}/${vp.id} at (${vp.x}, ${vp.z}) cannot be walked to from ANY landing pad - `
        + 'this is the "built but not reachable" defect with a fast-travel marker on it');
      /* And it has to be a WALK, not a step off the ramp. The pad-clearance
       * rule is a straight line; this is the route. */
      assert.ok(r.d >= VIEWPOINT_PAD_CLEARANCE,
        `${planet.id}/${vp.id} is ${r.d.toFixed(0)} m of walking from pad "${r.pad}"`);
      report.push({ planet: planet.id, id: vp.id, y: vp.y, d: r.d, pad: r.pad });
    }
  }
  const worst = report.reduce((a, b) => (b.d > a.d ? b : a));
  const least = report.reduce((a, b) => (b.d < a.d ? b : a));
  console.log(`   [viewpoints] walk distances: shortest ${least.d.toFixed(0)} m (${least.planet}/${least.id}), `
    + `longest ${worst.d.toFixed(0)} m (${worst.planet}/${worst.id})`);
});

/* ---------------------------------------------------------------------- */
/* 6. THE GRAVITY SPREAD, MEASURED ON THE BUILT TERRAIN                    */
/* ---------------------------------------------------------------------- */

test('the gravity spread reaches the player as a 3.4x broad jump', () => {
  const t = ballistics(PLANETS.tessera.gravity);
  const v = ballistics(PLANETS.verdigris.gravity);
  const base = ballistics(P.gravityReference);
  /* The arithmetic, re-derived here so a change to `JUMP_EXP` or to the config
   * fails this rather than silently re-tuning ten worlds. */
  assert.ok(Math.abs(t.apex - 1.697) < 0.01, `Tessera apex ${t.apex}`);
  assert.ok(Math.abs(v.apex - 0.922) < 0.01, `Verdigris apex ${v.apex}`);
  assert.ok(Math.abs(base.apex - 0.931) < 0.01, `reference apex ${base.apex}`);
  const spanApex = t.apex / v.apex;
  const spanJump = t.sprintJump / v.sprintJump;
  /* Apex goes as `ratio^(-1/3)`, so a 6.2x gravity span is only 1.84x of
   * height - but hang time goes as `ratio^(-2/3)` and horizontal speed does not
   * scale at all, so the BROAD JUMP moves 3.4x. That, not the apex, is the
   * number that can be authored against. */
  assert.ok(Math.abs(spanApex - 1.84) < 0.02, `apex span ${spanApex}`);
  assert.ok(Math.abs(spanJump - 3.39) < 0.03, `broad-jump span ${spanJump}`);
  console.log(`   [viewpoints] Tessera 1.62 m/s2: apex ${t.apex.toFixed(2)} m, hang ${t.hang.toFixed(2)} s, `
    + `sprint jump ${t.sprintJump.toFixed(1)} m`);
  console.log(`   [viewpoints] Verdigris 10.10 m/s2: apex ${v.apex.toFixed(2)} m, hang ${v.hang.toFixed(2)} s, `
    + `sprint jump ${v.sprintJump.toFixed(1)} m`);
});

/**
 * A lattice with BALLISTIC edges at one planet's own carry.
 *
 * The walk lattice in `planet-walk-kit` has four-neighbour edges only. This
 * adds one more kind: from any standable cell to any standable cell within
 * `range`, if the landing is no more than `apex` above the take-off and the
 * straight line between them clears the terrain by `CLEAR`. That is a
 * deliberately crude model of a running jump and it is used for exactly one
 * thing - measuring how much SHORTER the route gets - never to certify that
 * anything is reachable. Block 5 does the certifying, on foot, with no jump.
 */
function jumpFlood({ ground, ok, n, half, range, apex }) {
  const at = (i, j) => j * n + i;
  const dist = new Float64Array(n * n).fill(Infinity);
  const y = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const g = ground(-half + i * PITCH, -half + j * PITCH);
      y[at(i, j)] = Number.isFinite(g) ? g : NaN;
    }
  }
  const span = Math.max(1, Math.floor(range / PITCH));
  const CLEAR = 0.6;
  const hops = [];
  for (let dj = -span; dj <= span; dj++) {
    for (let di = -span; di <= span; di++) {
      const d = Math.hypot(di, dj) * PITCH;
      if (d > range || d < PITCH * 1.5) continue;
      hops.push([di, dj, d]);
    }
  }
  return {
    from(x, z) {
      dist.fill(Infinity);
      const q = [];
      const i0 = Math.round((x + half) / PITCH);
      const j0 = Math.round((z + half) / PITCH);
      for (let dj = -2; dj <= 2; dj++) {
        for (let di = -2; di <= 2; di++) {
          const a = i0 + di; const b = j0 + dj;
          if (a < 0 || b < 0 || a >= n || b >= n || !ok[at(a, b)]) continue;
          dist[at(a, b)] = 0;
          q.push(at(a, b));
        }
      }
      let head = 0;
      while (head < q.length) {
        const k = q[head++];
        const i = k % n; const j = (k - i) / n;
        const here = y[k]; const d0 = dist[k];
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const a = i + dx; const b = j + dz;
          if (a < 0 || b < 0 || a >= n || b >= n) continue;
          const kk = at(a, b);
          if (!ok[kk]) continue;
          const dh = y[kk] - here;
          if (dh > 0 && dh > MAX_RISE && dh > STEP_UP) continue;
          if (dh < -DROP_MAX) continue;
          const step = Math.hypot(PITCH, dh);
          if (d0 + step < dist[kk] - 1e-6) { dist[kk] = d0 + step; q.push(kk); }
        }
        for (const [di, dj, d] of hops) {
          const a = i + di; const b = j + dj;
          if (a < 0 || b < 0 || a >= n || b >= n) continue;
          const kk = at(a, b);
          if (!ok[kk]) continue;
          const dh = y[kk] - here;
          if (dh > apex) continue;
          /* The arc has to clear what is between. Sampled at the lattice pitch:
           * a parabola from `here` through the apex to `y[kk]`, and the ground
           * must be under it everywhere. */
          let clears = true;
          const steps = Math.max(2, Math.round(d / PITCH));
          for (let s = 1; s < steps; s++) {
            const t = s / steps;
            const gx = (-half + i * PITCH) + di * PITCH * t;
            const gz = (-half + j * PITCH) + dj * PITCH * t;
            const arc = here + 4 * apex * t * (1 - t) + dh * t;
            const g = ground(gx, gz);
            if (Number.isFinite(g) && g > arc - CLEAR) { clears = false; break; }
          }
          if (!clears) continue;
          if (d0 + d < dist[kk] - 1e-6) { dist[kk] = d0 + d; q.push(kk); }
        }
      }
      return this;
    },
    to(x, z) {
      const i0 = Math.round((x + half) / PITCH);
      const j0 = Math.round((z + half) / PITCH);
      let best = Infinity;
      for (let dj = -2; dj <= 2; dj++) {
        for (let di = -2; di <= 2; di++) {
          const a = i0 + di; const b = j0 + dj;
          if (a < 0 || b < 0 || a >= n || b >= n) continue;
          const d = dist[at(a, b)];
          if (d < best) best = d;
        }
      }
      return best;
    },
  };
}

/** Rebuild the walk kit's standing mask so the jump flood shares its rules. */
function standMask({ ground, blocked, lava, half }) {
  const n = Math.floor((half * 2) / PITCH) + 1;
  const at = (i, j) => j * n + i;
  const ok = new Uint8Array(n * n);
  const MAX_SLOPE_TAN = Math.tan((38 * Math.PI) / 180);
  for (let j = 0; j < n; j++) {
    const z = -half + j * PITCH;
    for (let i = 0; i < n; i++) {
      const x = -half + i * PITCH;
      const g = ground(x, z);
      if (!Number.isFinite(g)) continue;
      if (lava(x, z, g)) continue;
      if (blocked(x, z, g)) continue;
      const gx = ground(x + PITCH * 0.5, z); const gnx = ground(x - PITCH * 0.5, z);
      const gz = ground(x, z + PITCH * 0.5); const gnz = ground(x, z - PITCH * 0.5);
      if (![gx, gnx, gz, gnz].every(Number.isFinite)) continue;
      if (Math.hypot((gx - gnx) / PITCH, (gz - gnz) / PITCH) > MAX_SLOPE_TAN) continue;
      ok[at(i, j)] = 1;
    }
  }
  return { ok, n };
}

test('what a planet\'s own gravity buys over the game\'s baseline gravity', async () => {
  /* THE PAYOFF, MEASURED - AND THE FIRST DRAFT OF THIS MEASURED AN ARTEFACT.
   *
   * The obvious comparison is "walk route vs jump route", and it is WRONG. The
   * walk lattice is four-connected, so its distances carry the usual Manhattan
   * inflation; ANY diagonal edge shortens a route by up to 29% whatever it
   * costs to make it. Run that way, Verdigris' 4.7 m carry "saved 27%" against
   * Tessera's 15.9 m "26%", and the conclusion would have been that gravity
   * does nothing - measured, plausible, and entirely a property of the graph.
   *
   * So both floods use the SAME connectivity and differ in exactly one number:
   * the carry. The baseline is the carry at `CONFIG.player.gravityReference` -
   * 9.81 m/s2, the gravity every hand-built world in the game is authored
   * against - and the question is what THIS planet's gravity buys over it. That
   * is the honest question anyway: a planet is a departure from a baseline, not
   * from an inability to jump.
   *
   * Flooded from the primary pad only. Three floods a planet over a 351x351
   * lattice with ballistic clearance sampling is the expensive part of this
   * file, and the arrival pad is the route a player actually takes. */
  const baseline = ballistics(P.gravityReference);
  const rows = [];
  for (const key of ['tessera', 'lathe', 'cinder', 'verdigris']) {
    const planet = PLANETS[key];
    const { world, blocked, lava } = await planetWorld(planet);
    const field = world._terrainField;
    const ground = (x, z) => field.sampleHeight(x, z);
    const b = ballistics(planet.gravity);
    const { ok, n } = standMask({ ground, blocked, lava, half: planet.half });
    const site = world.landingSites.find((s) => s.primary) ?? world.landingSites[0];
    const B = jumpFlood({ ground, ok, n, half: planet.half, range: baseline.sprintJump, apex: baseline.apex })
      .from(site.position.x, site.position.z);
    const J = jumpFlood({ ground, ok, n, half: planet.half, range: b.sprintJump, apex: b.apex })
      .from(site.position.x, site.position.z);
    for (const vp of world.viewpoints) {
      const base = B.to(vp.x, vp.z);
      const here = J.to(vp.x, vp.z);
      if (!(base < Infinity)) continue;
      rows.push({
        id: `${key}/${vp.id}`, key, base, here, saved: base - here, carry: b.sprintJump,
      });
    }
  }
  for (const r of rows) {
    console.log(`   [gravity] ${r.id.padEnd(26)} carry ${r.carry.toFixed(1).padStart(5)} m  `
      + `baseline ${r.base.toFixed(0).padStart(4)} m  own-g ${r.here.toFixed(0).padStart(4)} m  `
      + `saved ${r.saved.toFixed(0).padStart(4)} m (${((r.saved / r.base) * 100).toFixed(0)}%)`);
  }
  const frac = (k) => {
    const of = rows.filter((r) => r.key === k);
    return of.length ? Math.max(...of.map((r) => r.saved / r.base)) : 0;
  };
  const light = Math.max(frac('tessera'), frac('lathe'));
  const heavy = Math.max(frac('verdigris'), frac('cinder'));

  /* ── WHAT THIS ACTUALLY MEASURED, WHICH IS SMALLER THAN IT SOUNDS ──────
   *
   * The brief this was authored against expected a tower you can climb on
   * Tessera and cannot on Verdigris. That is not what the built terrain does,
   * and writing the threshold at the number I wanted rather than the number I
   * measured would be the exact failure this repo keeps recording - a gate that
   * measures something the game does not do.
   *
   * Measured, from the primary pad, over the shipped viewpoints:
   *   Tessera  15.9 m carry   2-9% shorter routes than the baseline carry
   *   Lathe    14.3 m carry   2-3%
   *   Cinder    5.3 m carry   0.0%
   *   Verdigris 4.7 m carry   0.0%
   * and a separate sweep of REACHABLE AREA from the primary pad found the low
   * gravity opens 0.1% more ground on Tessera and 0.0% everywhere else.
   *
   * The reason is structural and worth writing down so nobody re-measures it:
   * a planet is a heightfield. Its standable ground is everything under 38
   * degrees and `Player._move`'s own step-up ladder is measured at 58 in its
   * header, `Climb` mantles a 1.0-2.4 m ledge on any world, and `FreeClimb`
   * takes anything past 60 degrees. Between "walkable" and "climbable" there is
   * almost no band left for a jump to be the deciding verb, and the gaps that
   * DO exist - Verdigris' 46 m Green Cut, the 40 m inner wall of Lathe's
   * Shepherd, the 24 m rim of Sallow's Throat - are far outside 15.9 m as well
   * as 4.7. Gravity on these worlds is a route modifier of a few percent and a
   * feel, not a gate.
   *
   * So the assertions are at the measurement with margin. They still fail on
   * everything worth failing on: a `JUMP_EXP` change that flattens the spread,
   * a descriptor whose gravity stops being published, and any edit that moves a
   * light-world viewpoint onto ground where the leap does nothing at all. */
  assert.ok(light > 0.02,
    `the best low-gravity shortcut saves only ${(light * 100).toFixed(1)}% over the baseline carry - the leap is `
    + 'not doing anything on Tessera or Lathe, so the gravity claim on those two is decoration');
  assert.ok(heavy < 0.005,
    `a heavy world saved ${(heavy * 100).toFixed(1)}% over the baseline carry - its gravity is not the reason `
    + 'its routes are what they are');
  assert.ok(light > heavy * 5 || (heavy === 0 && light > 0),
    `light ${(light * 100).toFixed(1)}% against heavy ${(heavy * 100).toFixed(1)}% - not a spread`);
});

/* ---------------------------------------------------------------------- */
/* 7. The validator has teeth - every rule proven able to fail             */
/* ---------------------------------------------------------------------- */

/** Cinder, with its viewpoint list swapped for `list`. */
function mutant(list) {
  const src = PLANETS.cinder;
  return () => definePlanet({
    id: 'mutant', name: 'Mutant',
    half: src.half, seg: src.seg, gravity: src.gravity,
    terrain: src.terrain,
    palette: src.palette,
    liquid: src.liquid,
    minerals: src.minerals.map((m) => ({ ...m, credits: undefined, hold: undefined })),
    landing: src.landing.map((s) => ({ ...s })),
    viewpoints: list,
  });
}

const GOOD = { id: 'ok_one', name: 'Ok One', x: -320, z: -27.24, terrain: 'outcrop', place: 'somewhere' };

test('definePlanet accepts the shape the planets actually use', () => {
  assert.doesNotThrow(mutant([GOOD]));
});

test('definePlanet refuses a viewpoint on a pad', () => {
  const pad = PLANETS.cinder.landing[0];
  assert.throws(mutant([{ ...GOOD, x: pad.x + pad.r + 1, z: pad.z }]), /off the rim of landing site/);
});

test('definePlanet refuses two viewpoints in one district', () => {
  assert.throws(mutant([GOOD, { ...GOOD, id: 'ok_two', x: GOOD.x + 20 }]), /reveal one district twice/);
});

test('definePlanet refuses an authored y', () => {
  assert.throws(mutant([{ ...GOOD, y: 30 }]), /is DERIVED/);
});

test('definePlanet refuses a viewpoint in a liquid ribbon', () => {
  /* Cinder's Rift is a ribbon of lava. Its first point, exactly. */
  const rib = PLANETS.cinder.liquid.bodies.find((b) => b.shape === 'ribbon');
  assert.ok(rib, 'Cinder no longer has a lava ribbon - pick another planet for this case');
  assert.throws(mutant([{ ...GOOD, x: rib.pts[0][0], z: rib.pts[0][1] }]), /drowning/);
});

test('definePlanet refuses a viewpoint off the edge of the height field', () => {
  assert.throws(mutant([{ ...GOOD, x: PLANETS.cinder.half - 2, z: 0 }]), /playfield edge/);
});

test('definePlanet refuses a duplicate id, a missing place and an unknown terrain', () => {
  assert.throws(mutant([GOOD, { ...GOOD, x: 200, z: 300 }]), /is not unique/);
  assert.throws(mutant([{ ...GOOD, place: undefined }]), /must name the feature/);
  assert.throws(mutant([{ ...GOOD, terrain: 'summit' }]), /terrain "summit" unknown/);
});

test('definePlanet refuses more viewpoints than the pause hub can travel to', () => {
  const many = [];
  for (let i = 0; i < VIEWPOINT_MAX + 1; i++) {
    many.push({ ...GOOD, id: `v${i}`, x: -320 + i * 200, z: -27 });
  }
  assert.throws(mutant(many), /travel rows/);
});

test('PlanetWorld drops a viewpoint whose ground is under the liquid, and says so', async () => {
  /* The build-time half of the drowning rule, exercised on the world rather
   * than asserted about it: Shoal's sea covers the whole playfield, so a
   * viewpoint on the sea bed publishes a finite y and a finite liquid surface
   * above it. `_publishViewpoints` must drop it.
   *
   * Reached by calling the real method against a doctored descriptor on the
   * real built world, because there is no other way to make a planet author a
   * drowned viewpoint - `definePlanet` cannot catch this one and the shipped
   * descriptors do not contain it. */
  const { world } = await world_(PLANETS.shoal);
  const real = world.planet;
  const drowned = { id: 'drowned', name: 'Drowned', x: 0, z: -300, r: 6, terrain: 'shore', place: 'the sea bed', climb: '' };
  const surf = world.liquidField.surfaceAt(drowned.x, drowned.z);
  const bed = world._terrainField.sampleHeight(drowned.x, drowned.z);
  assert.ok(Number.isFinite(surf) && bed < surf,
    `(0, -300) is not under Shoal's sea (bed ${bed}, surface ${surf}) - pick another column`);

  const warned = [];
  const realWarn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    world.planet = { ...real, viewpoints: [...real.viewpoints, drowned] };
    world._publishViewpoints();
    assert.equal(world.viewpoints.length, real.viewpoints.length,
      'the drowned viewpoint was published');
    assert.ok(warned.some((w) => w.includes('drowned') && w.includes('under')),
      `no warning names the dropped viewpoint: ${JSON.stringify(warned)}`);
  } finally {
    console.warn = realWarn;
    world.planet = real;
    world._publishViewpoints();
  }
  assert.equal(world.viewpoints.length, real.viewpoints.length);
});
