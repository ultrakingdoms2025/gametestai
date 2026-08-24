import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { rig, goto, domHarness } from './_flightrig.mjs';
import { SPACE_BODIES } from '../../src/worlds/space/Bodies.js';
import { portalAperture, PORTAL_ENTRY_RADIUS } from '../../src/systems/Portals.js';

domHarness();
const { VIEWS, frameCoverage } = await import('../../src/dev/Harness.js');

/**
 * DOES EVERY HARNESS FRAMING LOOK AT ANYTHING?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS FILE EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `src/dev/Harness.js` is what a visual review is taken through, so a framing
 * that points at empty floor does not produce a bad screenshot - it produces a
 * CONFIDENT WRONG NUMBER, inside a table of numbers that all look equally real.
 *
 * That is not hypothetical. The yard's berths moved out onto the piers and the
 * framings did not follow them. Raycast afterwards against the built world:
 *
 *   kestrel-in   nearest surface 38.4 m   (it claims to be inside a cabin)
 *   dray-hold                    52.2 m   (inside a 6 m hold)
 *   pike-in                      52.4 m   (inside a cabin)
 *   berth-b1                     14.8 m   (the berth is 170 m away)
 *   blast-door                   26.3 m   (a door that had been deleted)
 *
 * Eight of the twenty-five rows of a reported interior-luminance table were
 * measuring the empty shop floor, and `harness-measurement.test.mjs` was green
 * throughout - because it asserts that the harness MEASURES correctly, and
 * nothing asserted that a framing looks AT anything.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THREE KINDS OF FRAMING, AND EACH ONE IS BINDING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   `subject: n`     A ray down the view axis must meet something solid inside
 *                    n metres. Interiors, hulls, walls, decks.
 *   `clear: n`       A ray down the view axis must meet NOTHING for n metres.
 *                    The framings that look down the bay and out of the mouth -
 *                    an aperture that got walled up again is precisely the
 *                    regression these catch, and it is the one the player
 *                    complained about ("It looks overall just like a big dark
 *                    room").
 *   `subject: Infinity`
 *                    The subject is the backdrop. `space` registers no
 *                    colliders at all, and the yard out there is a `Backdrop`
 *                    STRUCTURE re-placed against the camera every frame, so a
 *                    ray in the true frame would find it in the wrong place
 *                    even if it were solid. Those framings are checked on their
 *                    BEARING instead, in the last case below.
 *
 * Physics colliders rather than drawn triangles, deliberately: a framing exists
 * to look at a PLACE, and the yard's places are its floors, hulls, piers and
 * walls, all of which are collided. Drawn-only dressing is not what a framing
 * is aimed at.
 */

/** How much further than its declared subject a framing's first hit may be. */
const SLACK = 1.7;

/** `Harness._vantage` puts the player's feet this far under the camera. */
const EYE_HEIGHT = 1.62;

const _dir = new THREE.Vector3();
const _from = new THREE.Vector3();

/** Resolve a framing to the position it is actually rendered from. */
function resolve(v, physics) {
  if (!v.groundRelative) return v.pos;
  const g = physics.groundHeight(v.pos[0], v.pos[2], v.pos[1] + 400, 900);
  if (g === null || g === undefined || !Number.isFinite(g)) return v.pos;
  return [v.pos[0], g + v.pos[1], v.pos[2]];
}

async function probe(worldId) {
  const r = await rig();
  // `rig()` builds only the three worlds its flying suites need; anything else
  // has to be built before it can be activated.
  if (!r.wm.isBuilt?.(worldId)) await r.wm.build(worldId);
  await goto(r, worldId);
  const rows = [];
  for (const v of VIEWS[worldId] ?? []) {
    if (v.computed) continue;
    const pos = resolve(v, r.physics);
    _from.set(pos[0], pos[1], pos[2]);
    _dir.set(v.look[0] - pos[0], v.look[1] - pos[1], v.look[2] - pos[2]).normalize();
    const want = v.clear ?? (Number.isFinite(v.subject) ? v.subject * SLACK : 4000);
    const hit = r.physics.raycast(_from, _dir, want);
    /* The framing pins the player's FEET an eye-height under the camera; see
     * `Harness._vantage`. That is the body `Portals.fixedUpdate` tests. */
    const feet = [pos[0], pos[1] - EYE_HEIGHT, pos[2]];
    const gates = (r.wm.active?.portalSpecs ?? [])
      .map((spec) => portalAperture(spec, feet))
      .filter((a) => a.wouldCross);
    rows.push({
      v, name: v.name, hit: hit ? hit.distance : null,
      inside: r.physics.containsPoint(_from.clone()),
      gates,
    });
  }
  return rows;
}

function table(rows) {
  return rows.map((x) => {
    const want = x.v.clear !== undefined ? `clear ${x.v.clear}` : `subject ${x.v.subject}`;
    return `${x.name.padEnd(20)} ${want.padStart(16)}  first hit `
      + `${x.hit === null ? '   none' : x.hit.toFixed(1).padStart(7)}`;
  }).join('\n  ');
}

/* `sports` is here because it was NOT, and that absence was the whole defect.
 * Not one of its eight framings declared a `subject` or a `clear`, so the loop
 * below skipped every one of them and this file's ray assertion was vacuous on
 * the entire world - for as long as the world has existed. Two of the eight
 * were photographing something else the whole time: `track` was aimed at the
 * car park from 2.32 m under the terrain, and `entrance-portal` stood behind
 * the gateway and teleported the player through it, filing 3.1 M triangles of
 * the STATION as sports'. A world with no declarations is not a world that
 * passes; it is a world nobody looked at. */
for (const worldId of ['dock', 'cinder', 'sports']) {
  test(`every ${worldId} framing looks at something inside its own subject distance`, async () => {
    const rows = await probe(worldId);
    const t = table(rows);
    /* The guard first: a probe that stopped finding the world would report
     * every framing as empty and could be made green by deleting the world. */
    assert.ok(rows.length >= 5, `only ${rows.length} framings in "${worldId}"\n  ${t}`);
    const bad = [];
    for (const x of rows) {
      /* ── THE CAMERA IS NOT ALLOWED TO BE INSIDE SOMETHING ──────────────
       *
       * Everything below asks how FAR the first surface is. That catches a
       * framing that meets nothing and one that meets its subject too late,
       * and it is blind to the opposite failure: a camera buried in the
       * scenery meets a surface almost immediately, which reads as a very
       * close subject and passes.
       *
       * `VIEWS.sports`' `track` was exactly that. It stood at (128, 16, 232)
       * where the ground is 18.32 - 2.32 m INSIDE the hill - and its ray met
       * the inside of that hill at 14.46 m against a subject of 132. Every
       * distance test in this file passed it, and the picture was the inside
       * of a terrain skirt.
       *
       * ── WHY THIS TEST AND NOT A RATIO ─────────────────────────────────
       * The obvious guard is a floor on `hit / subject`, and the data refuses
       * it. Measured across all 38 declaring framings, that ratio runs from
       * 0.05 (`dock/signal-post`, `cinder/rimhold` - both legitimately have a
       * post or a rock in the near field) to 1.55 (`dock/pike-in`). There is
       * no floor that separates them, so a ratio gate would be a threshold
       * invented to fit rather than measured, which is the shape this whole
       * directory exists to refuse.
       *
       * `containsPoint` needs no threshold, and it was measured before it was
       * adopted: across dock, cinder and sports it flags exactly one framing -
       * the buried one - with no false positive on the yard's interiors, the
       * trench at y -0.7, the crane cab, or any ground-relative planet row. */
      if (x.inside) {
        bad.push(`${x.name}: the camera is INSIDE a collider - this framing photographs the inside of whatever it is buried in`);
      }
      /* ── AND IT IS NOT ALLOWED TO STAND INSIDE A GATEWAY ───────────────
       *
       * The worst failure a framing can have is not a bad picture, it is a
       * picture OF SOMEWHERE ELSE filed under this world's name.
       * `Harness._vantage` pins the player at the camera; the pin is a
       * plane-side crossing; `Portals.fixedUpdate` fires `enter`.
       *
       * `VIEWS.sports`' `entrance-portal` stood at (0, 3.5, 170), which is
       * behind a gateway whose normal is (0, 0, -1), with its chest 0.266 m
       * off the disc axis against an aperture of 2.226 m. It photographed the
       * station in a black frame and reported 225 materials and 3.1 M
       * triangles as SPORTS'. Nothing in the numbers said the world had
       * changed, because nothing was looking.
       *
       * The aperture arithmetic comes from `Portals.portalAperture` rather
       * than being copied here: a checker that re-derives the rule is a second
       * copy of it that can be wrong on its own. */
      for (const a of x.gates) {
        bad.push(
          `${x.name}: the camera stands ${Math.abs(a.depth).toFixed(2)} m BEHIND a gateway and `
          + `${a.radius.toFixed(2)} m off its axis, inside the ${PORTAL_ENTRY_RADIUS.toFixed(2)} m entry aperture - `
          + 'pinning the player here walks them through it and photographs the destination'
        );
      }
      if (x.v.clear !== undefined) {
        if (x.hit !== null) {
          bad.push(`${x.name}: declares ${x.v.clear} m of clear air and meets a surface at ${x.hit.toFixed(1)} m`);
        }
        continue;
      }
      if (!Number.isFinite(x.v.subject)) continue;
      if (x.hit === null) {
        bad.push(`${x.name}: nothing solid within ${(x.v.subject * SLACK).toFixed(0)} m down its own view axis`);
      } else if (x.hit > x.v.subject * SLACK) {
        bad.push(`${x.name}: first surface at ${x.hit.toFixed(1)} m against a declared subject of ${x.v.subject} m`);
      }
    }
    assert.deepEqual(bad, [],
      `${bad.length} of ${rows.length} framings in "${worldId}" do not frame what they claim to:\n  `
      + `${bad.join('\n  ')}\n\n  ${t}`);
    /* And the probe has to be finding real geometry, or a world that failed to
     * build would report every `clear` framing green. */
    const solid = rows.filter((x) => x.hit !== null).length;
    assert.ok(solid >= 4,
      `only ${solid} of ${rows.length} framings in "${worldId}" met any geometry at all - the probe is blind\n  ${t}`);
  });
}

/** The least of the frame a hull framing may put its subject across, per axis. */
const FILL_FLOOR = 0.45;

test('a hull framing puts the hull across the frame, not a corner of it', async () => {
  /* ═══════════════════════════════════════════════════════════════════════
   *  THE HOLE THIS CLOSES, AND IT IS THIS FILE'S OWN FAILURE MODE
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Everything above asks "does a ray down the view axis meet something?".
   * That is a test of AIM and it cannot see SIZE, so the `kestrel` framing
   * passed green for three art reviews while rendering a lamp-lit pier with a
   * small dark lump behind a gantry column. Its ray met
   * `hatchleaf:dock_kestrel_hatch` at 17 m against a declared subject of 26,
   * which is a hatch leaf, which is "something".
   *
   * Measured through the live harness at the time, by projecting each hull
   * group's bounding box through the camera the harness actually sets:
   *
   *   kestrel  33.3% of frame width  x  36.9% of height   (fov 74, 19.8 m off)
   *   pike     45.7%                 x  53.3%
   *   dray     63.5%                 x 182.8%             (mast out of shot)
   *
   * A framing that shows 30% ship is the wrong instrument for "does that read
   * as a spacecraft", and it is the instrument three reviews used.
   *
   * ── Why a FLOOR and no ceiling ─────────────────────────────────────────
   * The framing is fitted to the hull's PLAN box; the DRAWN group carries
   * things the plan does not name — the Dray's brow runs 13.6 m out to her
   * apron side against a 6.4 m plan half-beam — so a ceiling would fail on
   * dressing rather than on framing. Cropping the end of a gangway is fine;
   * showing a third of a ship is not.
   *
   * ── Why this cannot be made green by deleting the hulls ────────────────
   * The subject group has to exist and carry triangles, and the count of
   * framings checked is asserted, so a hull that stopped being built fails
   * here rather than passing vacuously. */
  const r = await rig();
  await goto(r, 'dock');
  const group = r.wm.active?.group;
  assert.ok(group, 'the dock world published no group to measure');

  const bboxOf = (name) => {
    let target = null;
    group.traverse((o) => { if (o.name === name) target = o; });
    if (!target) return null;
    target.updateWorldMatrix(true, true);
    const box = new THREE.Box3();
    let meshes = 0;
    target.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      meshes++;
      o.geometry.computeBoundingBox();
      box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
    });
    return meshes ? box : null;
  };

  const rows = [];
  const bad = [];
  for (const v of VIEWS.dock ?? []) {
    if (!v.fills) continue;
    const box = bboxOf(`yard:ship-${v.fills}`);
    assert.ok(box, `no drawn hull group "yard:ship-${v.fills}" to frame`);
    const pts = [];
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) pts.push([x, y, z]);
      }
    }
    const c = frameCoverage(pts, v.pos, v.look, v.fov);
    rows.push(`${v.name.padEnd(10)} ${(c.w * 100).toFixed(1).padStart(6)}% wide  ${(c.h * 100).toFixed(1).padStart(6)}% high`);
    if (!(c.w >= FILL_FLOOR) || !(c.h >= FILL_FLOOR)) {
      bad.push(`${v.name}: the hull covers ${(c.w * 100).toFixed(1)}% x ${(c.h * 100).toFixed(1)}% of the frame, `
        + `under the ${(FILL_FLOOR * 100).toFixed(0)}% floor - this framing photographs the yard, not the ship`);
    }
  }
  assert.equal(rows.length, 3, `${rows.length} hull framings declare \`fills\`; there are three flyable hulls`);
  assert.deepEqual(bad, [], `${bad.join('\n  ')}\n\n  ${rows.join('\n  ')}`);
});

test('every space bearing framing actually has its body in shot', async () => {
  /* The bearing rows are aimed at planets 60-640 km away that `Backdrop` draws
   * as camera-relative proxies, so the only thing that can be checked is the
   * DIRECTION - and it is the only thing that matters, because a framing that
   * is a degree off centre still shows the planet and one that is 40 degrees
   * off shows empty sky. That is exactly the failure the old `VIEWS.space`
   * had: its four framings described a 60 m platform and a 1,400 m starfield
   * shell, neither of which exists.
   *
   * Half the vertical fov is the bound, so the body has to be inside the
   * SHORTER axis of the frame rather than merely somewhere on screen.
   */
  const rows = [];
  const bad = [];
  for (const b of SPACE_BODIES) {
    const v = (VIEWS.space ?? []).find((x) => x.name === `bearing-${b.id}`);
    assert.ok(v, `no bearing framing for "${b.id}" - a body was added and the harness never saw it`);
    const axis = new THREE.Vector3(v.look[0] - v.pos[0], v.look[1] - v.pos[1], v.look[2] - v.pos[2]).normalize();
    const toBody = new THREE.Vector3(b.position[0] - v.pos[0], b.position[1] - v.pos[1], b.position[2] - v.pos[2]).normalize();
    const off = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(axis.dot(toBody), -1, 1)));
    const bound = v.fov / 2;
    rows.push(`${b.name.padEnd(10)} ${off.toFixed(2).padStart(6)} deg off axis (half-fov ${bound})`);
    if (!(off < bound)) bad.push(`${b.name}: ${off.toFixed(1)} deg off the framing's own axis, half-fov is ${bound}`);
  }
  assert.deepEqual(bad, [], `${bad.join('\n  ')}\n\n  ${rows.join('\n  ')}`);
  /* A framing aimed straight down its body's bearing scores 0. That makes the
   * case above unfalsifiable on its own, so this pins the OTHER half: the five
   * bodies are in five genuinely different directions, which is the property
   * the player asked for by name and the reason there are five framings rather
   * than one. */
  /* A SATELLITE IS EXEMPT FROM ITS OWN PRIMARY, and nothing else is.
   *
   * A moon sits close to the planet it orbits because that is what a moon is,
   * and the framing that shows Lathe with Ceraunus and its rings behind it is
   * the framing you want - it is the reason to fly out there at all. So a body
   * that declares `orbits` is exempt from that one pair.
   *
   * It is NOT exempt from everything else, and the pair still has to be
   * separable: a satellite that sat on top of its primary would be a body you
   * could never frame alone. Hence the floor below rather than a skip. */
  const primaryOf = new Map(SPACE_BODIES.filter((b) => b.orbits).map((b) => [b.id, b.orbits]));
  const isSatellitePair = (a, b) => primaryOf.get(a.id) === b.id || primaryOf.get(b.id) === a.id;

  let minSep = 180;
  let minPair = '';
  let minMoonSep = 180;
  for (let i = 0; i < SPACE_BODIES.length; i++) {
    for (let j = i + 1; j < SPACE_BODIES.length; j++) {
      const A = SPACE_BODIES[i];
      const B = SPACE_BODIES[j];
      const a = new THREE.Vector3(...A.position).normalize();
      const c = new THREE.Vector3(...B.position).normalize();
      const d = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(a.dot(c), -1, 1)));
      if (isSatellitePair(A, B)) { minMoonSep = Math.min(minMoonSep, d); continue; }
      if (d < minSep) { minSep = d; minPair = `${A.name}/${B.name}`; }
    }
  }
  assert.ok(minSep > 25,
    `the two closest bodies are ${minSep.toFixed(1)} deg apart in the sky (${minPair}); two framings would show the same thing`);

  /* And the exemption is not a hole: a declared satellite must still be far
   * enough from its primary to be framed on its own. 8 degrees at the game's
   * 75-degree FOV is a tenth of the screen height apart, which is the least
   * that reads as two objects rather than one. */
  for (const b of SPACE_BODIES) {
    if (!b.orbits) continue;
    const p = SPACE_BODIES.find((x) => x.id === b.orbits);
    assert.ok(p, `${b.name} declares it orbits "${b.orbits}", which is not a body`);
    const a = new THREE.Vector3(...b.position).normalize();
    const c = new THREE.Vector3(...p.position).normalize();
    const d = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(a.dot(c), -1, 1)));
    assert.ok(d > 8, `${b.name} is only ${d.toFixed(1)} deg from ${p.name}; it can never be framed alone`);
  }
});

test('every framing declares what it is looking at, and aims somewhere else', () => {
  /* Two ways to write a framing that cannot fail the probes above: leave both
   * `subject` and `clear` off, or put `look` on top of `pos` so the view axis
   * is a zero vector and the ray goes nowhere. Both are caught here rather than
   * silently excused there. */
  const bad = [];
  for (const worldId of ['dock', 'space', 'cinder', 'sports']) {
    for (const v of VIEWS[worldId] ?? []) {
      if (v.computed) continue;
      const declared = v.clear !== undefined || v.subject !== undefined;
      if (!declared) bad.push(`${worldId}/${v.name}: declares neither a subject distance nor a clear distance`);
      if (v.subject !== undefined && !(v.subject > 0)) bad.push(`${worldId}/${v.name}: subject ${v.subject} is not a positive distance`);
      if (v.clear !== undefined && !(v.clear > 0 && Number.isFinite(v.clear))) bad.push(`${worldId}/${v.name}: clear ${v.clear} is not a finite positive distance`);
      const d = Math.hypot(v.look[0] - v.pos[0], v.look[1] - v.pos[1], v.look[2] - v.pos[2]);
      if (!(d > 0.5)) bad.push(`${worldId}/${v.name}: look point is ${d.toFixed(2)} m from the camera`);
    }
  }
  assert.deepEqual(bad, [], bad.join('\n  '));
});

test('the hull framings are derived from the berths, not typed', () => {
  /* The mechanism, not the result. `DOCK_HULL_VIEWS` is generated from
   * `YardPlan.BERTHS`, which is what stops this table going stale the next time
   * a berth moves - and the way that guarantee gets lost is somebody pasting
   * the generated numbers back in as literals. So: every flyable hull has both
   * of its framings, and the rows that framed the pre-pier layout are gone. */
  const names = new Set((VIEWS.dock ?? []).map((v) => v.name));
  for (const id of ['kestrel', 'dray', 'pike']) {
    assert.ok(names.has(id), `no "${id}" framing in VIEWS.dock`);
    assert.ok(names.has(`${id}-in`), `no "${id}-in" framing in VIEWS.dock`);
  }
  assert.ok(!names.has('blast-door'), 'VIEWS.dock still frames the deleted blast door');
  assert.ok(!names.has('berth-b1'), 'VIEWS.dock still carries the pre-pier berth framings');
  assert.ok((VIEWS.cinder ?? []).length >= 5,
    'VIEWS.cinder is missing or thin - the first landable planet has no framings');
});
