import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { rig, goto, domHarness } from './_flightrig.mjs';
import { SPACE_BODIES } from '../../src/worlds/space/Bodies.js';

domHarness();
const { VIEWS } = await import('../../src/dev/Harness.js');

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
  await goto(r, worldId);
  const rows = [];
  for (const v of VIEWS[worldId] ?? []) {
    if (v.computed) continue;
    const pos = resolve(v, r.physics);
    _from.set(pos[0], pos[1], pos[2]);
    _dir.set(v.look[0] - pos[0], v.look[1] - pos[1], v.look[2] - pos[2]).normalize();
    const want = v.clear ?? (Number.isFinite(v.subject) ? v.subject * SLACK : 4000);
    const hit = r.physics.raycast(_from, _dir, want);
    rows.push({ v, name: v.name, hit: hit ? hit.distance : null });
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

for (const worldId of ['dock', 'cinder']) {
  test(`every ${worldId} framing looks at something inside its own subject distance`, async () => {
    const rows = await probe(worldId);
    const t = table(rows);
    /* The guard first: a probe that stopped finding the world would report
     * every framing as empty and could be made green by deleting the world. */
    assert.ok(rows.length >= 5, `only ${rows.length} framings in "${worldId}"\n  ${t}`);
    const bad = [];
    for (const x of rows) {
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
  let minSep = 180;
  for (let i = 0; i < SPACE_BODIES.length; i++) {
    for (let j = i + 1; j < SPACE_BODIES.length; j++) {
      const a = new THREE.Vector3(...SPACE_BODIES[i].position).normalize();
      const c = new THREE.Vector3(...SPACE_BODIES[j].position).normalize();
      minSep = Math.min(minSep, THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(a.dot(c), -1, 1))));
    }
  }
  assert.ok(minSep > 25,
    `the two closest bodies are ${minSep.toFixed(1)} deg apart in the sky; two framings would show the same thing`);
});

test('every framing declares what it is looking at, and aims somewhere else', () => {
  /* Two ways to write a framing that cannot fail the probes above: leave both
   * `subject` and `clear` off, or put `look` on top of `pos` so the view axis
   * is a zero vector and the ray goes nowhere. Both are caught here rather than
   * silently excused there. */
  const bad = [];
  for (const worldId of ['dock', 'space', 'cinder']) {
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
