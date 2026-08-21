import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { rig, goto } from './_flightrig.mjs';

const { BODIES, STAR_SHELL, VOID_NEAR, VOID_FAR, VOID_REACH } = await import('../../src/worlds/dock/YardPlan.js');
const { SPACE_BODIES, DOCK_ANCHOR } = await import('../../src/worlds/space/Bodies.js');
const { CONFIG } = await import('../../src/core/Config.js');

/**
 * IS THE SKY OVER THE YARD THE SAME SKY AS THE ONE OUTSIDE IT?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DEFECT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The yard hung three INVENTED bodies - EMBER, CALDER and LODESTONE - placed
 * by eye so the volcanic world sat prettily inside the aperture.
 * `space/Bodies.js` has five real ones, in different directions, with
 * different names. Measured from the two tables, outbound = -Z, right = +X:
 *
 *                yard sky (invented)           space sky (one second later)
 *   volcanic     EMBER      20.0 left, 1.8 up   Cinder    13.9 left, 23.6 DOWN
 *   ringed giant CALDER     23.1 RIGHT, 10.4 up Ceraunus  22.6 LEFT, 38.5 up
 *   third body   LODESTONE, a grey moon         Vitrine, an ice planet
 *   -            (nothing)                      Tessera, 72.3 right
 *   star         (absent)                       Erenmark, 139 behind
 *
 * A player who lined the nose up on the red planet above the horizon to port
 * and flew through the mouth found it 25 degrees BELOW the horizon, the ringed
 * giant teleported 46 degrees across the sky, the moon turned into an ice
 * world, a second moon appeared to starboard, a sun appeared behind them, and
 * everything was renamed.
 *
 * The yard's bodies are DERIVED from `SPACE_BODIES` now - the position vector
 * contracted toward the origin by a factor `k` that is also the model scale,
 * which is what makes the angular size come out right - so the two tables
 * cannot disagree. This asserts that they do not, in both the bearing and the
 * size, and that the drawn objects are the same shaders rather than a second
 * set of look-alikes.
 */

const bearing = (p) => new THREE.Vector3(p[0], p[1], p[2]).normalize();
const deg = (a, b) => THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1)));

test('every body over the yard is one of the real ones, by identity', () => {
  assert.equal(BODIES.length, SPACE_BODIES.length,
    `the yard hangs ${BODIES.length} bodies and the volume has ${SPACE_BODIES.length}`);
  const yard = BODIES.map((b) => b.id).sort();
  const real = SPACE_BODIES.map((b) => b.id).sort();
  assert.deepEqual(yard, real, 'the yard sky and the space sky do not name the same bodies');
  for (const b of BODIES) {
    const real2 = SPACE_BODIES.find((x) => x.id === b.id);
    assert.equal(b.name, real2.name, `the yard calls ${b.id} "${b.name}" and the volume calls it "${real2.name}"`);
    assert.equal(b.kind, real2.kind, `${b.id} is a ${b.kind} in the yard and a ${real2.kind} outside it`);
    assert.equal(b.body, real2, `${b.id}'s descriptor is a copy, not the one the shaders read`);
  }
});

test('every body is in the direction it is really in, to a fraction of a degree', () => {
  const rows = [];
  for (const b of BODIES) {
    const real = SPACE_BODIES.find((x) => x.id === b.id);
    const off = deg(bearing([b.x, b.y, b.z]), bearing(real.position));
    /* The angular radius, which is the other half of "it looks the same".
     * Contracting position and radius by the same factor is what makes these
     * equal, so a drift here means somebody has started placing by eye again. */
    const dYard = Math.hypot(b.x, b.y, b.z);
    const dReal = Math.hypot(...real.position);
    const qYard = Math.asin(Math.min(0.999, b.r / dYard));
    const qReal = Math.asin(Math.min(0.999, real.radius / dReal));
    const sizeErr = Math.abs(THREE.MathUtils.radToDeg(qYard - qReal));
    rows.push(`${b.name.padEnd(10)} bearing off ${off.toFixed(3)} deg, `
      + `angular radius ${THREE.MathUtils.radToDeg(qYard).toFixed(2)} vs ${THREE.MathUtils.radToDeg(qReal).toFixed(2)} deg`);
    assert.ok(off < 0.05,
      `${b.name} is ${off.toFixed(2)} deg from where it really is - the yard sky is being placed by hand again`);
    assert.ok(sizeErr < 0.02,
      `${b.name} is drawn at ${THREE.MathUtils.radToDeg(qYard).toFixed(2)} deg across and is really `
      + `${THREE.MathUtils.radToDeg(qReal).toFixed(2)} deg`);
  }
  console.log('  ' + rows.join('\n  '));
  /* AND THE ONE THE PLAYER CARES ABOUT. The volcanic world is BELOW the
   * outbound axis, and that is the layout `space-scale.test.mjs` pins as "out
   * and down (Cinder)" - one of the five directions the player asked for by
   * name. A yard sky that put it above the horizon so it would fit in the
   * aperture was lying about where the player was going. */
  const cinder = BODIES.find((b) => b.id === 'cinder');
  assert.ok(cinder.y < 0, `Cinder is drawn ${cinder.y.toFixed(0)} m above the yard - it is below the outbound axis`);
});

test('nothing in the sky is drawn beyond the far plane', () => {
  /* THE STARFIELD WAS ENTIRELY INVISIBLE AND NOBODY NOTICED.
   *
   * `CONFIG.render.far` is 2000 and the shell was 2200, so every point on it
   * was between 1,940 and 2,460 m from the player: the whole field sat behind
   * the far plane and NOT ONE STAR OF IT WAS EVER DRAWN, in a world whose own
   * source calls the field "4,200 points on a 2,200 m shell". It is arithmetic
   * rather than a screenshot, which is why it survived three visual reviews
   * that all reported seeing stars - they were seeing the bodies.
   */
  /* `VOID_REACH` is the plan's own statement of how far a player can get from
   * the origin in this world - the corner of the floor plus the piers - and
   * every clearance below is measured against it. */
  const reach = VOID_REACH;
  assert.ok(reach > 200 && reach < DOCK_ANCHOR.radius,
    `VOID_REACH is ${reach} m; the yard is 214 m across to its furthest pier head and `
    + `${DOCK_ANCHOR.radius} m in bounding radius`);
  assert.ok(STAR_SHELL + reach < CONFIG.render.far,
    `the starfield shell is at ${STAR_SHELL} m and the far plane is ${CONFIG.render.far} m - `
    + 'the stars are clipped and the bay has no sky');
  for (const b of BODIES) {
    const d = Math.hypot(b.x, b.y, b.z);
    /* Ring systems and coronas are drawn several radii wide, so the whole
     * extent has to be inside the plane, not just the centre. */
    const extent = b.r * Math.max(b.body.ring ? b.body.ring.outer : 1,
      b.body.kind === 'star' ? (b.body.look.coronaScale ?? 3) * 0.5 : 1);
    assert.ok(d + extent + reach < CONFIG.render.far,
      `${b.name} reaches ${(d + extent).toFixed(0)} m out against a ${CONFIG.render.far} m far plane`);
    assert.ok(d >= VOID_NEAR - 1 && d <= VOID_FAR + 1,
      `${b.name} sits at ${d.toFixed(0)} m, outside the ${VOID_NEAR}..${VOID_FAR} m shell band`);
  }
  /* The shells are ranked by TRUE distance, so the painter order the yard
   * draws them in is the order they really are in. */
  const ranked = [...BODIES].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i].trueRange > ranked[i - 1].trueRange,
      `${ranked[i].name} ranks behind ${ranked[i - 1].name} and is nearer`);
    assert.ok(Math.hypot(ranked[i].x, ranked[i].y, ranked[i].z)
      > Math.hypot(ranked[i - 1].x, ranked[i - 1].y, ranked[i - 1].z),
      `${ranked[i].name} is further away and is drawn on a nearer shell`);
  }
});

test('the yard draws the bodies with the space shaders, not with painted canvases', async () => {
  /* The mottle these replaced was 1,100 hard-edged AXIS-ALIGNED RECTANGLES,
   * 6-28 x 4-16 px on a 512 x 256 map. Ember is 165 m at 1,257 m from the
   * apron - about 15 degrees across, roughly one map texel per screen pixel -
   * so those rectangles rendered as visible blocks and the volcanic planet the
   * player was promised was a quilted beach ball. The same file's caldera pass
   * already used a radial gradient and looked fine; the mottle loop was the
   * only offender, and it is gone with the canvases.
   */
  const r = await rig();
  await goto(r, 'dock');
  const world = r.wm.active;
  const surfaces = [];
  world.group.traverse((o) => { if (o.isMesh && /:surface$/.test(o.name)) surfaces.push(o); });
  assert.equal(surfaces.length, BODIES.length,
    `${surfaces.length} body surfaces drawn in the yard for ${BODIES.length} bodies`);
  for (const m of surfaces) {
    assert.ok(m.material.isShaderMaterial,
      `${m.name} is a ${m.material.type} - the yard is painting its own planets again`);
    assert.ok(m.material.uniforms?.uStarDir,
      `${m.name} has no star direction - it cannot have a terminator`);
    assert.ok(!m.material.map, `${m.name} carries a texture map - the canvas mottle is back`);
  }
  /* The star's light comes from the star. A body lit from a direction the
   * volume does not agree with is the same defect as one in the wrong place. */
  const star = surfaces[0].material.uniforms.uStarDir.value;
  const { STAR_DIRECTION } = await import('../../src/worlds/space/Bodies.js');
  assert.ok(bearing([star.x, star.y, star.z]).dot(bearing(STAR_DIRECTION)) > 0.999,
    'the yard lights its sky from a different direction than the volume does');
  /* And there is a starfield, drawn behind all of it. */
  let stars = null;
  world.group.traverse((o) => { if (o.isPoints) stars = o; });
  assert.ok(stars, 'no starfield in the yard at all');
  assert.ok(stars.renderOrder < Math.min(...surfaces.map((m) => m.renderOrder)),
    'the starfield paints over the planets');
});
