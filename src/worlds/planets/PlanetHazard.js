/**
 * HAZARDS THAT BITE: what the weather blocks already say, made into a rule.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DEFECT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Volcanic.js` said it out loud on the field it was describing: *"Phase 1
 * draws it; nothing takes damage from it."* Eight of the ten `hazards` blocks
 * in this directory were density, drift and colour - three numbers that reach a
 * `Points` shader and stop there. A planet's weather was a filter over the
 * frame and nothing else, on every world, including the one whose descriptor
 * declares a 24 m radiant band around a lake of lava at 240 dps.
 *
 * The plumbing already existed one field over. `PlanetWorld` publishes
 * `liquidField` with `lethal`, `dps` and `cause`, `WaterVolumes` installs it and
 * `Swim._burn` charges it against `Player.applyDamage`, so the world→player
 * path for a non-weapon source is a solved problem in this codebase. What was
 * missing was a SECOND field of the same shape for the things that are not
 * liquid.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THREE PLANETS AND NOT TEN, AND WHY NO PLANET IS NAMED HERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `PlanetDescriptor`'s contract is that a tenth planet costs a tenth descriptor
 * and no `if (planet.id === ...)` anywhere downstream. This module keeps that:
 * {@link hazardSpec} is a pure function of the descriptor, and which planets it
 * selects is an OUTPUT, not a list. Today it answers three, because three
 * descriptors already carry the facts a live hazard needs and seven do not:
 *
 *   heat      `hazards.heatShimmer.nearLiquid > 0` AND a lethal liquid to
 *             radiate from. One planet declares `heatShimmer` (Cinder) and
 *             `Sallow.js` explicitly says why it does not: *"there is no lava
 *             on this planet and nothing on it is hot enough to bend the air"*.
 *             That sentence was already the selector; it just had no reader.
 *
 *   wind      `density * |drift| >= WIND_MIN` metres per second of moving air,
 *             AND a `dunes` landform to shelter behind. The product is what the
 *             ash field is already told to do: how much stuff there is, times
 *             how fast it is being carried sideways. Measured across the ten:
 *             Sirocco 0.854, Vitrine 0.436, Sallow 0.297, Cinder 0.228,
 *             Verdigris 0.190, Carnelian 0.155, Cathedra 0.047, Lathe 0.029,
 *             and zero on the two airless ones. {@link WIND_MIN} is 0.60 - 13%
 *             of `walkSpeed` - because below that the push is inside the noise
 *             of the movement controller's own damping, and a force the player
 *             cannot feel is scenery with a cost attached. One planet clears
 *             it, with a 1.96x margin over the next.
 *
 *   thin_air  air that scatters almost nothing: `sky.kind !== 'space'` (there
 *             IS air) and `ambient.intensity / sun.intensity < THIN_AIR_MAX`.
 *             That ratio is a declared optical property of every sky in the
 *             directory and it measures exactly the thing the hazard is about -
 *             how much atmosphere is between the sun and the ground. Measured:
 *             Cathedra 0.035, Carnelian 0.068, Lathe 0.067 (airless), Vitrine
 *             0.100, Verdigris 0.087, Cinder 0.072, Sirocco 0.058, Shoal 0.084,
 *             Sallow 0.107, Tessera 0.014 (vacuum). {@link THIN_AIR_MAX} is
 *             0.05: Cathedra sits at 0.035 and the nearest world with air is
 *             Sirocco at 0.058, a 1.66x margin.
 *
 * The asymmetry is the design. Seven planets stay scenery and their descriptors
 * say so; three bite and their descriptors said so first.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE RULE ABOUT KILLING PEOPLE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A hazard a player cannot see coming and cannot walk out of is worse than no
 * hazard. Every one of the three obeys three constraints, and they are checked
 * by `scripts/tests/planet-hazards.test.mjs` rather than promised here:
 *
 *   1. **There is a tell.** Heat: the ground inside the band is scorched, a
 *      visible ring drawn by `PlanetWorld._buildHeatBand` at exactly the
 *      radius the field uses. Wind: the sand field thickens as you climb into
 *      it and thins in the lee - the same `Points` the descriptor already
 *      draws, driven per frame off the same exposure the push uses. Thin air:
 *      the stamina bar, which is already on screen.
 *   2. **There is a way out, and it is short.** Every point in a live hazard is
 *      within {@link MAX_ESCAPE} metres of a point where the field reads zero,
 *      measured on the built terrain by the test - so the way out is always
 *      inside one held sprint.
 *   3. **It cannot kill from full health before you get there.** Only `heat`
 *      does damage at all, and the test integrates the worst walk out of the
 *      band at `walkSpeed` and requires it to cost less than half the pool.
 *      Wind is a push and thin air is a stamina drain; neither can reduce
 *      health by a single point.
 *
 * And the landing pads: a pad inside a DAMAGING hazard would be a world that
 * hurts a player for arriving in it, so the test refuses one. A pad inside the
 * thin air is allowed and Cathedra has one - The Lantern stands at 82.2 m on a
 * planet whose ground tops out at 87.7 - because a stamina drain cannot trap
 * anybody: it gates the sprint and the climb, never the walk, and `Unstuck` and
 * `respawn` are untouched by it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  NO GEOMETRY IN THIS FILE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Everything here is arithmetic over plain descriptor data plus three
 * measurements the built world hands in. It draws nothing: the visible tells
 * live in `PlanetWorld`, which is where the meshes and the uniforms are.
 *
 * It is not under `PlanetDescriptor`'s no-`three` rule and does not pretend to
 * be - `liquidHazard` is imported from `PlanetLiquid`, which imports `three` -
 * because nothing here crosses `postMessage`. What it does keep is the other
 * half of that discipline: `at()` runs in a fixed-rate step and writes into a
 * caller-owned record, so a reader costs zero allocations a frame.
 */

import { polyDist } from './Placement.js';
import { liquidHazard } from './PlanetLiquid.js';

/* ---- selectors -------------------------------------------------------- */

/**
 * Metres per second of moving air below which a wind is not worth simulating.
 *
 * 0.60 m/s is 13% of `CONFIG.player.walkSpeed` (4.6). The movement controller
 * damps toward a wish velocity at `acceleration / friction`; a lateral bias
 * under an eighth of the walk speed is inside that convergence and reads as
 * drift rather than as weather. Pinned against `walkSpeed` by the test.
 */
export const WIND_MIN = 0.60;

/**
 * The largest `ambient / sun` ratio that still counts as thin air.
 *
 * Ambient light in these skies is the atmosphere scattering the sun; the ratio
 * is therefore a declared measure of how much atmosphere there is. 0.05 with
 * Cathedra at 0.0349 and the next world with air at 0.0580.
 */
export const THIN_AIR_MAX = 0.05;

/**
 * Fraction of a world's own vertical relief that counts as "the summits".
 *
 * The thin-air drain ramps from zero at `minY + THIN_AIR_FLOOR * relief` to
 * full at `maxY`. A fraction rather than an absolute height, because the datum
 * has to be the planet's own: Cathedra runs -16.3 to 87.7 and Tessera -50.7 to
 * 45.9, and a metre count would mean something different on each. 0.75 puts the
 * line on Cathedra at 61.7 m - above all three of its pads but one, below all
 * three of its viewpoints but one, and 26 m of ramp between the line and the
 * highest ground there is.
 */
export const THIN_AIR_FLOOR = 0.75;

/**
 * Full-strength thin-air stamina drain, points per second.
 *
 * `CONFIG.player.sprintStaminaDrain` is 15 and the pool is 100, so a held
 * sprint is rationed to 6.7 s. 3.0 is a fifth of that: on the very top of
 * Cathedra a sprint is rationed to 5.6 s instead, and standing still stops
 * refilling. It gates the sprint and the free-climb and NOTHING else - stamina
 * is not health, `Player` never reads it for walking, and no path in `Stamina`
 * can reduce a hit point. That is why this is the hazard the one planet with a
 * pad inside its own weather is allowed to have. Pinned against
 * `sprintStaminaDrain` by the test.
 */
export const THIN_AIR_DRAIN = 3.0;

/**
 * The longest walk out of any live hazard cell, metres.
 *
 * Asserted against the BUILT terrain by `planet-hazards.test.mjs`, which floods
 * the hazard's own footprint and measures the distance from every live cell to
 * the nearest dead one. 40 m is under nine seconds at `walkSpeed` and under
 * five at a sprint, and it is the number that makes "there is a way out" a
 * measurement instead of an intention.
 */
export const MAX_ESCAPE = 40;

/** Finite number or the fallback. */
function fin(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * What hazard, if any, this descriptor's own numbers describe.
 *
 * Pure, plain data, no world required - so a test can assert the whole roster
 * across the registry without building a single planet, and so the three
 * derivations above can be checked against the descriptors rather than against
 * this file's opinion of them.
 *
 * @param {object} planet a frozen descriptor from `definePlanet`
 * @returns {object|null} the spec, or null for a planet whose weather is paint
 */
export function hazardSpec(planet) {
  if (!planet) return null;
  const h = planet.hazards ?? {};
  const sky = planet.sky ?? {};

  /* ---- heat: a radiant band round a lethal liquid --------------------- */
  const near = fin(h.heatShimmer?.nearLiquid, 0);
  if (near > 0 && planet.liquid?.bodies?.length) {
    const lq = liquidHazard(planet.liquid);
    if (lq.lethal && lq.dps > 0) {
      const strength = clamp01(fin(h.heatShimmer?.strength, 1));
      /* THE ONE NUMBER, AND IT IS A QUOTIENT OF THREE DECLARED ONES.
       *
       * `dps` is what the lava does to a body IN it; `strength` is how strongly
       * the descriptor says the air over it shimmers; `nearLiquid` is how far
       * that reaches. Spreading the immersion rate over the band it radiates
       * across gives 240 * 0.5 / 24 = 5.0 dps at the shoreline, falling
       * linearly to nothing at 24 m.
       *
       * Sanity, because a hazard's magnitude is the whole question: at the
       * water's edge that is a fifth of a hit point per frame and 5% of the
       * pool per second. Standing on the shore to cut the rheniite seam for ten
       * seconds costs 50 of 100 health and walking four metres back halves the
       * rate. Being IN it still costs 240. The band says "this is close
       * enough"; the lava says "this is fatal", and the two do not have to
       * shout the same thing. */
      const peakDps = (lq.dps * strength) / near;
      return Object.freeze({
        id: 'heat',
        kind: 'heat',
        name: `radiant heat off the ${lq.kind}`,
        cause: 'heat',
        /** Metres from a body's edge the band reaches. */
        reach: near,
        /** Damage per second at the shoreline. */
        peakDps,
        /** Nothing above this height over the liquid plane. Buoyant, so it is
         *  the same reach upward as sideways rather than a second constant. */
        rise: near,
        bodies: planet.liquid.bodies,
        peak: Object.freeze({ dps: peakDps, push: 0, stamina: 0 }),
      });
    }
  }

  /* ---- wind: moving air with somewhere to hide from it ---------------- */
  const drift = Array.isArray(h.ashfall?.drift) ? h.ashfall.drift : null;
  const density = fin(h.ashfall?.density, 0);
  const speed = drift ? density * Math.hypot(fin(drift[0]), fin(drift[1])) : 0;
  const dunes = (planet.terrain?.landforms ?? []).filter((f) => f.kind === 'dunes');
  if (speed >= WIND_MIN && dunes.length) {
    const mag = Math.hypot(fin(drift[0]), fin(drift[1])) || 1;
    /* The BIGGEST dune field sets the shelter geometry, because it is the one
     * whose lee is deep enough to stand in. A quarter of a wavelength upwind is
     * where the back of the dune in front of you is, and a quarter of its
     * amplitude is how much of it has to be over your head before you are out
     * of the wind - both read off the landform rather than chosen. */
    const field = dunes.reduce((a, b) => (fin(b.amp) > fin(a.amp) ? b : a));
    return Object.freeze({
      id: 'wind',
      kind: 'wind',
      name: 'blown sand',
      cause: 'wind',
      /** Unit vector the air moves along, straight off `ashfall.drift`. */
      dirX: fin(drift[0]) / mag,
      dirZ: fin(drift[1]) / mag,
      /** Metres per second of push at full exposure. */
      push: speed,
      shelterDistance: Math.max(4, fin(field.wavelength, 60) / 4),
      shelterHeight: Math.max(0.5, fin(field.amp, 8) / 4),
      peak: Object.freeze({ dps: 0, push: speed, stamina: 0 }),
    });
  }

  /* ---- thin air: a sky that scatters nothing -------------------------- */
  const sun = fin(sky.sun?.intensity, 0);
  const amb = fin(sky.ambient?.intensity, 0);
  if (sky.kind !== 'space' && sun > 0 && amb / sun < THIN_AIR_MAX) {
    return Object.freeze({
      id: 'thin_air',
      kind: 'thin_air',
      name: 'thin cold air',
      cause: 'altitude',
      /** Fraction of the world's own relief the drain starts at. */
      floorFraction: THIN_AIR_FLOOR,
      drain: THIN_AIR_DRAIN,
      peak: Object.freeze({ dps: 0, push: 0, stamina: THIN_AIR_DRAIN }),
    });
  }

  return null;
}

/**
 * A reusable sample record. `PlanetWorld` keeps one and passes it in, because
 * `hazardField.at` runs in a fixed-rate step and a fresh object there is sixty
 * allocations a second per reader.
 */
export function makeHazardSample() {
  return { intensity: 0, dps: 0, pushX: 0, pushZ: 0, stamina: 0 };
}

function zero(out) {
  out.intensity = 0; out.dps = 0; out.pushX = 0; out.pushZ = 0; out.stamina = 0;
  return out;
}

/**
 * Turn a spec into the sampler the world publishes.
 *
 * @param {object} spec from {@link hazardSpec}
 * @param {{groundAt:(x:number,z:number)=>number|null,
 *          liquidSurfaceAt?:(x:number,z:number)=>number,
 *          minY:number, maxY:number}} ctx the BUILT world's own measurements -
 *          `groundAt` must be the collision height field, not the descriptor's
 *          height function, for the same reason a viewpoint's y is.
 * @returns {{at:(x:number,y:number,z:number,out:object)=>object}|null}
 */
export function makeHazardSampler(spec, ctx) {
  if (!spec || !ctx) return null;

  if (spec.kind === 'heat') {
    const bodies = spec.bodies;
    const surfaceAt = ctx.liquidSurfaceAt;
    return {
      at(x, y, z, out) {
        zero(out);
        let best = Infinity;
        let plane = -Infinity;
        for (let i = 0; i < bodies.length; i++) {
          const b = bodies[i];
          let d; let py;
          if (b.shape === 'disc') {
            d = Math.hypot(x - b.x, z - b.z) - b.r;
            py = b.y;
          } else {
            d = polyDist(x, z, b.pts) - b.width * 0.5;
            py = Math.max(b.y0, b.y1);
          }
          if (d < 0) d = 0;
          if (d < best) { best = d; plane = py; }
        }
        if (!(best < spec.reach)) return out;
        /* Above the plume, nothing. A body on the caldera rim 30 m over the
         * lake is looking at it, not standing in it. */
        if (y > plane + spec.rise) return out;
        out.intensity = 1 - best / spec.reach;
        out.dps = out.intensity * spec.peakDps;
        return out;
      },
      /** Only used by the tests and the console line. */
      surfaceAt,
    };
  }

  if (spec.kind === 'wind') {
    const g = ctx.groundAt;
    const sx = -spec.dirX * spec.shelterDistance;
    const sz = -spec.dirZ * spec.shelterDistance;
    return {
      at(x, y, z, out) {
        zero(out);
        const here = g(x, z);
        if (here === null || !Number.isFinite(here)) return out;
        /* IN THE LEE. Sample the ground a quarter-wavelength upwind: if it
         * stands `shelterHeight` over you, the dune in front is taking the
         * wind and you are behind it. That is the way out, it is one dune
         * away, and it is the same move a body actually makes in a sandstorm. */
        const up = g(x + sx, z + sz);
        const rise = up === null || !Number.isFinite(up) ? 0 : up - here;
        const exposure = clamp01(1 - rise / spec.shelterHeight);
        if (exposure <= 0) return out;
        out.intensity = exposure;
        out.pushX = spec.dirX * spec.push * exposure;
        out.pushZ = spec.dirZ * spec.push * exposure;
        return out;
      },
    };
  }

  if (spec.kind === 'thin_air') {
    const relief = ctx.maxY - ctx.minY;
    const floor = ctx.minY + spec.floorFraction * relief;
    const span = Math.max(1e-3, ctx.maxY - floor);
    return {
      at(x, y, z, out) {
        zero(out);
        /* The BODY's height, not the ground's. It is the air that is thin, so
         * a player on a ledge and a player standing on the ground under it
         * breathe the same air - and this is the one of the three that a
         * flying, falling or climbing body is in as much as a walking one. */
        const t = clamp01((y - floor) / span);
        if (t <= 0) return out;
        out.intensity = t;
        out.stamina = t * spec.drain;
        return out;
      },
      floor,
    };
  }

  return null;
}
