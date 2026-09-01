import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { rig, goto, domHarness } from './_flightrig.mjs';
import { SPACE_BODIES } from '../../src/worlds/space/Bodies.js';
import { portalAperture, PORTAL_ENTRY_RADIUS } from '../../src/systems/Portals.js';

domHarness();
const { VIEWS, frameCoverage, ndcOf } = await import('../../src/dev/Harness.js');

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

/**
 * The least of its declared subject distance a framing's first hit may be.
 *
 * ── "HITS SOMETHING" IS NOT "FRAMES ITS SUBJECT", THIRD OCCURRENCE ────────
 * The `subject` assertion below only ever asked whether the first surface is
 * TOO FAR. A framing pressed against whatever is in front of it meets a
 * surface immediately, and that reads as a very close subject and passes. Two
 * live framings were doing exactly that, and both had passed this file for as
 * long as it has existed:
 *
 *   cinder/rimhold      3.0 m against subject 55  ( 5.4%)  70.8 deg down
 *   dock/signal-post    3.4 m against subject 70  ( 4.8%)   yard at 87.25 m
 *
 * `rimhold` is the instructive one. It is `groundRelative`, so its camera sat
 * on 126.59 m of ground - and its look point was at y = 3 ABSOLUTE, which from
 * up there is a 70.8-degree dive into the ash at its own feet. A ground-
 * relative camera with an absolute look point aims at the planet's origin
 * plane from whatever height the terrain happens to be.
 *
 * ── THE THRESHOLD IS FROM THE DATA, AND THE GAP IS WIDE ──────────────────
 * Every declaring framing in dock, cinder and sports, by hit/subject, worst
 * first:
 *
 *   signal-post 4.8%   rimhold 5.4%   |   pad-ashfall 18.3%   kestrel 20.7%
 *   pike 23.7%   bastion-ribs 27.9%   office-door 33.8%   ... up to 155.0%
 *
 * The two broken ones are at 4.8% and 5.4%; the nearest legitimate framing is
 * at 18.3%. That is a factor of 3.4 of clear air, so 12% sits in the middle of
 * a real gap rather than being fitted to the answer.
 *
 * ── AND THIS WAS REFUSED ONCE, WRONGLY ───────────────────────────────────
 * An earlier pass on this file measured the same ratios and refused a floor,
 * on the grounds that they run from 0.05 to 1.55 with no separation. That was
 * reading the wrong question: it lumped this together with "is there something
 * legitimately in the near field", where there is indeed no threshold and
 * `containsPoint` is the right instrument. The question a floor answers is
 * narrower - is the first surface a plausible fraction of the DECLARED
 * subject - and on that question the gap above was always there. `art-planets`
 * was right and the earlier refusal was wrong.
 */
const NEAR_FLOOR = 0.12;

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

/**
 * Worlds the flight rig does not register for itself.
 *
 * `_flightrig.mjs` registers what its flying suites need plus `sports` and
 * `race`, both of which were added for exactly this file and for exactly this
 * reason: "a world nobody can activate is a world whose framings nobody
 * checks". `medieval` and `maze` are the same case, registered here rather
 * than in the rig so nothing else pays for them.
 */
const EXTRA_WORLDS = {
  medieval: () => import('../../src/worlds/MedievalWorld.js').then((m) => m.MedievalWorld),
  maze: () => import('../../src/worlds/MazeWorld.js').then((m) => m.MazeWorld),
};

/**
 * Seeds a VOLATILE world is probed on.
 *
 * `MazeWorld` re-seeds from `Math.random()` on every activation and
 * `WorldManager.build` re-generates a volatile world that is not the live one,
 * so an unpinned probe measures a different maze every run - which is how a
 * gate becomes flaky and then becomes ignored. `MazeWorld.seedOverride` exists
 * for precisely this and is null in every normal boot.
 *
 * Eight rather than one, because a single pinned seed would make the gate
 * deterministic while checking a maze no player will ever see. The declared
 * subjects in `VIEWS.maze` are measured to hold across all eight AND across 30
 * unpinned activations; see the comment on that table.
 */
const VOLATILE_SEEDS = [11, 101, 1009, 7919, 60013, 99991, 424243, 1000003];

/** Citadel has its own build kit; everything else comes off the flight rig. */
let _citadel = null;
const _registered = new Set();
async function worldRig(worldId, seed = null) {
  if (worldId !== 'citadel') {
    const r = await rig();
    const extra = EXTRA_WORLDS[worldId];
    let Cls = null;
    if (extra) {
      Cls = await extra();
      if (!_registered.has(worldId)) { r.wm.register(Cls); _registered.add(worldId); }
    }
    /* A volatile world has to be OFF the live slot before `build` will
     * regenerate it - `WorldManager.build` guards the rebuild with
     * `this._active !== world`, deliberately, so that a re-activation of the
     * live world cannot clear the group the live physics world is serving.
     * Without the hop through `dock` every seed after the first would silently
     * measure the maze the first one built. */
    if (seed !== null) {
      if (Cls) Cls.seedOverride = seed;
      if (r.wm.active?.id === worldId) await goto(r, 'dock');
    }
    // `rig()` builds only the three worlds its flying suites need; anything
    // else has to be built before it can be activated.
    if (!r.wm.isBuilt?.(worldId)) await r.wm.build(worldId);
    await goto(r, worldId);
    return r;
  }
  /* `buildCitadel` rather than the flight rig, because that is the apparatus
   * six other citadel suites already build this world with, and a second way
   * to build a world is a second world to keep in step. */
  if (!_citadel) {
    const { buildCitadel } = await import('./citadel-reach-kit.mjs');
    const { world, physics } = await buildCitadel();
    _citadel = { physics, wm: { active: world, isBuilt: () => true } };
  }
  return _citadel;
}

async function probe(worldId, seed = null) {
  const r = await worldRig(worldId, seed);
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
/* ── AND `citadel`, WHICH HAD FIVE UNDECLARED FRAMINGS ──────────────────────
 *
 * Same hole as sports, half as wide: `gate-approach`, `gate-spawn`,
 * `ward-centre`, `minaret-bridge` and `desert-overview` declared neither a
 * subject nor a clear distance, so the loop skipped five of this world's
 * twelve rows. All five now declare the distance their centre ray actually
 * travels, measured against the built world:
 *
 *   gate-approach    155.69 m   gate-spawn        98.74 m
 *   ward-centre       24.48 m   minaret-bridge    59.72 m
 *   desert-overview  244.06 m
 *
 * ── WHAT WAS MEASURED AND REFUSED ────────────────────────────────────────
 * `gate-spawn` is 44.4% obscured across the central half of its frame, mostly
 * by a palm crown 2.9 m from the lens, and it passes every distance test here
 * because its centre ray does reach the citadel's stone at 98.7 m. "Hits
 * something" is not "frames its subject", and closing that gap was tried.
 *
 * It cannot be closed with a threshold, and the numbers say so. Central-half
 * obstruction inside a third of the declared subject distance, all twelve
 * citadel framings, worst first:
 *
 *   gate-approach 88.1%   souk-alley 85.0%   gate-spawn 44.4%
 *   souk-roofs    23.8%   eyrie-summit 14.4% undercliff-terrace 10.0%
 *   caravanserai-mast 5.6%  ashfall-ward 5.6%
 *   ward-centre / minaret-bridge / desert-overview / deepworks-rim  0.0%
 *
 * The two framings ABOVE `gate-spawn` are both correct. `gate-approach` looks
 * through the gate arch, so the curtain wall fills the frame around it by
 * design; `souk-alley` is an alley, and walls close on both sides is what an
 * alley is. Near-field coverage and minimum-blocker-distance were tried too
 * and separate no better - `souk-alley` has 37.8% of its frame inside 3 m.
 *
 * So there is no threshold in this data that flags the bad framing without
 * flagging two good ones, and none is invented here. What the measurement
 * DID establish is that the obstruction is a palm three metres in front of
 * the player's spawn, which is a defect in `CitadelWorld`, not in the framing
 * - and it is recorded on the framing itself in `src/dev/Harness.js`.
 */
/* ═══════════════════════════════════════════════════════════════════════════
 *  "THE FIRST HIT IS NEAR THE POINT THE FRAMING NAMES" - MEASURED, REFUSED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `art-race` withdrew a seventh framing rather than ship it. `aurora-loop` met
 * something at 25.21 m against a declared subject of 28 - 90%, comfortably
 * inside the near floor below, and it would pass this file today - but the hit
 * point was 9.0 m from the point the framing names. There is a committed
 * photograph of exactly that failure mode (`after-post-face.png`: a framing
 * computed to look into a marshal post's observation slot, photographing a
 * conifer standing in front of it), so the question is a fair one: should a
 * framing have to meet its subject NEAR the point it aims at?
 *
 * It was measured across every declaring framing in every world this file can
 * build - dock, cinder, sports, citadel and race, 56 rows - as
 * |first hit - distance to the look point|. To flag `aurora-loop` the ceiling
 * would have to sit under 9.0 m. Rows already ABOVE 9.0 m, worst first:
 *
 *   citadel/gate-approach  136.66 m   cinder/aerial          131.05 m
 *   cinder/ashfall-outward  73.72     dock/gantry-crossing    58.71
 *   cinder/pad-ashfall      37.57     dock/signal-post        37.15
 *   dock/gantry-port        34.00     dock/crane-cab          32.98
 *   citadel/minaret-bridge  27.92     cinder/lava-shore       25.91
 *   dock/yard-wide          23.91     dock/mouth-from-space   22.82
 *   citadel/gate-spawn      20.64     cinder/colonnade        18.63
 *   dock/pier-one           15.33     dock/pike               14.75
 *   citadel/ward-centre     14.14     dock/kestrel            13.51
 *   sports/bowl-interior    12.57     sports/skatepark-wide   10.36
 *   dock/bastion-ribs        9.59
 *
 * TWENTY-ONE correct framings, to catch one bad one. And they are correct for
 * a reason the check cannot see: `gate-approach` aims at the gate arch 19 m
 * away and looks THROUGH it at the citadel 155.7 m beyond, which is the shot;
 * `signal-post` was deliberately raised so its ray would clear a near blocker
 * and reach the yard at 83 m past a look point at 45.8 m; `cinder/aerial`
 * aims down a bearing at a planet's far relief. Naming a near aim point and
 * photographing what is behind it is not a defect, it is how you frame through
 * something.
 *
 * The relative form separates no better. |hit - named| / named on the same 56
 * rows runs from 0% to 718%, with `dock/pike-in` - a correct cabin interior -
 * at 147% and `citadel/minaret-bridge` at 88%.
 *
 * So no threshold is adopted, and this is the second time that answer has been
 * reached on this file's central question by measurement rather than by taste
 * (see the `gate-spawn` obstruction note below). What DOES separate, with no
 * threshold at all, is asking the world what the framing is supposed to
 * contain: `a hull framing puts the hull across the frame` does it for the
 * yard's ships off `YardPlan.BERTHS`, and `the start-grid framing has the
 * start grid in it` does it for the circuit off `world.startGrid`. That is the
 * instrument this question actually wanted, and it is derived rather than
 * chosen.
 */
/* ═══════════════════════════════════════════════════════════════════════════
 *  THE LIST IS DERIVED, AND IT USED TO BE TYPED - THIRD OCCURRENCE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This loop read `['dock', 'cinder', 'sports', 'citadel', 'race']`, and the
 * declaration test at the foot of this file read a second hand-typed list.
 * Neither contained `station`, `medieval` or `maze`. Between them those three
 * declare THIRTY-ONE framings, and every one of them was exempt from both
 * assertions in this file for as long as the tables have existed - which is
 * verbatim the defect this file's own comment records for `sports`, and then
 * again for `citadel`.
 *
 * A hand-typed list is not a list, it is a snapshot of one. `Object.keys(VIEWS)`
 * cannot go stale: a world added to the table is a world probed here on the
 * commit that adds it.
 *
 * What the first run of the derived list found, and none of it was theoretical:
 *
 *   station/portal-medieval   stands inside TWO gateway apertures
 *   station/portal-sports     stands inside TWO gateway apertures
 *   maze/forecourt            stands inside the station gateway's aperture
 *   + 28 framings declaring neither a subject nor a clear distance
 *
 * All three portal framings are fixed in `src/dev/Harness.js`, and all 31 now
 * declare a distance measured against the built world.
 *
 * ── AND `space` IS EXEMPT, BY NAME AND WITH A REASON ────────────────────────
 * `space` registers NO colliders at all - there is nothing to walk on out
 * there, and everything visible is a `Backdrop` proxy re-placed against the
 * camera every frame, so a ray fired in the true frame would find it in the
 * wrong place even if it were solid. Every `VIEWS.space` row declares
 * `subject: Infinity` to say exactly that, and the bearings they DO have to
 * get right are asserted in their own test below. An exemption named here with
 * its reason is a different thing from a world that fell off a typed list. */
const NO_COLLIDERS = new Set(['space']);

/** Which worlds re-generate per activation, so a single probe proves nothing. */
const VOLATILE_SEEDS_FOR = { maze: VOLATILE_SEEDS };

for (const worldId of Object.keys(VIEWS).filter((id) => !NO_COLLIDERS.has(id))) {
  test(`every ${worldId} framing looks at something inside its own subject distance`, async () => {
    /* A volatile world is probed on every pinned seed; everything else once. */
    for (const seed of VOLATILE_SEEDS_FOR[worldId] ?? [null]) await probeOnce(worldId, seed);
  });
}

async function probeOnce(worldId, seed) {
  {
    const rows = await probe(worldId, seed);
    const t = table(rows) + (seed === null ? '' : `\n  (seed ${seed})`);
    /* THE GUARD FIRST, AND IT IS DERIVED RATHER THAN A CONSTANT.
     *
     * A probe that stopped finding the world would report every framing as
     * empty, and could be made green by deleting the world - so the count is
     * checked against what the table declares. It used to be a flat `>= 5`,
     * which is a number chosen for the five worlds that were on the typed
     * list; `maze` authors three rows and three `computed` ones, so a flat 5
     * would have failed a correct world. The floor of three stops the derived
     * form being satisfiable by emptying the table. */
    const declared = (VIEWS[worldId] ?? []).filter((v) => !v.computed).length;
    assert.equal(rows.length, declared,
      `probed ${rows.length} of ${declared} declaring framings in "${worldId}"\n  ${t}`);
    assert.ok(declared >= 3, `only ${declared} authored framings in "${worldId}"\n  ${t}`);
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
      } else if (x.hit < x.v.subject * NEAR_FLOOR) {
        /* The other end of the same assertion. See NEAR_FLOOR. */
        bad.push(
          `${x.name}: first surface at ${x.hit.toFixed(1)} m is only `
          + `${((x.hit / x.v.subject) * 100).toFixed(1)}% of its declared ${x.v.subject} m subject - `
          + 'this framing is pressed against something, and what it photographs is that'
        );
      }
    }
    assert.deepEqual(bad, [],
      `${bad.length} of ${rows.length} framings in "${worldId}" do not frame what they claim to:\n  `
      + `${bad.join('\n  ')}\n\n  ${t}`);
    /* And the probe has to be finding real geometry, or a world that failed to
     * build would report every `clear` framing green. Capped at the row count
     * for the same reason the count guard above is derived. */
    const solid = rows.filter((x) => x.hit !== null).length;
    const floor = Math.min(4, rows.length);
    assert.ok(solid >= floor,
      `only ${solid} of ${rows.length} framings in "${worldId}" met any geometry at all - the probe is blind\n  ${t}`);
  }
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

test('the start-grid framing has the start grid in it', async () => {
  /* ═══════════════════════════════════════════════════════════════════════
   *  THE CHECK THAT SEPARATES WHERE NO THRESHOLD DID
   * ═══════════════════════════════════════════════════════════════════════
   *
   * `start-grid` was handed up at (30, 3.2, 224) looking at (30, 1.6, 150)
   * with 40 m of clear air declared. Its centre ray IS clear for 45.75 m, so
   * every distance assertion above passed it. Two things were wrong with it
   * and neither is a distance:
   *
   *   34.4% of the frame was a 1.50 x 9.60 x 1.50 lighting mast at (31.07,
   *         4.83, 223.98) - 1.07 m from the camera in plan, first met at
   *         0.40 m - with 17.0% of the frame inside HALF A METRE
   *   18 of the world's 20 published grid slots were out of shot, because the
   *         camera stood 21 m the wrong side of the start line and looked
   *         ACROSS the circuit rather than down the grid
   *
   * The near-field half of that has no threshold: `citadel/souk-alley` puts
   * 37.8% of its frame inside 3 m and is correct, because it is an alley. The
   * grid half needs none - `RaceWorld` PUBLISHES `startGrid`, so the question
   * "is the start grid in the start-grid framing" is answerable off the
   * world's own contract, exactly as `a hull framing puts the hull across the
   * frame` answers it off `YardPlan.BERTHS`.
   *
   * Twenty slots and all twenty are asserted, so this cannot be satisfied by
   * catching a corner of the grid, and it cannot be made green by deleting the
   * grid: the count is asserted first. */
  const r = await rig();
  if (!r.wm.isBuilt?.('race')) await r.wm.build('race');
  await goto(r, 'race');
  const grid = r.wm.active?.startGrid ?? [];
  assert.ok(grid.length >= 20, `RaceWorld published ${grid.length} grid slots; a circuit has 20`);

  const v = (VIEWS.race ?? []).find((x) => x.name === 'start-grid');
  assert.ok(v, 'no "start-grid" framing in VIEWS.race');

  /* A slot is a car's worth of tarmac, so the point checked is the car's
   * middle rather than the paint - a framing that clipped every roof off
   * would otherwise read as fine. */
  const pts = grid.map((g) => [g.x, g.y + 0.6, g.z]);
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    /* `ndcOf` rather than arithmetic written here: a checker that re-derives
     * the projection is a second copy of it that can be wrong on its own, and
     * this is the same function `Harness.view` frames through. */
    const [x, y, z] = ndcOf(pts[i], v.pos, v.look, v.fov);
    if (!(z > 0 && Math.abs(x) <= 1 && Math.abs(y) <= 1)) {
      out.push(`slot ${i} at (${pts[i][0].toFixed(1)}, ${pts[i][2].toFixed(1)}) is `
        + (z <= 0 ? 'BEHIND the camera' : `outside the frame at ndc (${x.toFixed(2)}, ${y.toFixed(2)})`));
    }
  }
  assert.deepEqual(out, [],
    `${out.length} of ${pts.length} start-grid slots are not in the "start-grid" framing:\n  ${out.join('\n  ')}`);
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
  /* DERIVED, for the reason at the head of the ray-probe loop above: this list
   * was typed too, and it omitted `station`, `medieval` and `maze` - the three
   * worlds that between them held all 28 undeclared framings this assertion
   * exists to catch. A test that names its own subjects can only ever be as
   * complete as the day somebody last remembered to extend it.
   *
   * Nothing is exempt here. Unlike the ray probe, this needs no world built -
   * it reads the table - so `space` is in, and its `subject: Infinity` rows
   * declare, which is the point. */
  const bad = [];
  const worlds = Object.keys(VIEWS);
  assert.ok(worlds.length >= 9, `VIEWS declares only ${worlds.length} worlds`);
  for (const worldId of worlds) {
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
