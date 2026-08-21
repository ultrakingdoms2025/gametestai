import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { hull, triangles, raycast, triCount, PLAN } from './_hullrig.mjs';
import { slidePocket } from '../../src/worlds/dock/ShipKit.js';

/**
 * DO THESE READ AS SPACECRAFT, AND ARE THE DOORWAYS HOLES?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE TWO COMPLAINTS THIS FILE IS THE ANSWER TO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Verbatim, from a player who walked the built yard:
 *
 *   "spaceships do not look like spaceships, they look like they are made of
 *    square blocks."
 *   "if i open a door a door swings open but the entrance still has the ships
 *    side covering it. the doors should slide open on a spaceship with a
 *    swoosh sound."
 *
 * `dock-hulls.test.mjs` already asks whether the four hulls DIFFER from each
 * other — slenderness, stance, parallel middle body, all off the built
 * geometry — and every one of those tests was green while the player was
 * saying this. Different from each other is not the same property as reading
 * as a machine, and neither is "the plating has a hole in it" the same
 * property as "a body can get through the door".
 *
 * So, two new measurements, and both of them are taken the way the player
 * takes them — by looking, and by walking:
 *
 * 1. **The silhouette, rasterised at the angular size a player actually
 *    gets.** A hull is rendered to a small binary coverage buffer from the
 *    apron, and three numbers are read off it: how much of its bounding box it
 *    fills (a box fills all of it), how many separate runs its scanlines break
 *    into, and how many its columns break into.
 *    The camel work
 *    used the same trick for the same reason — a screenshot cannot fail.
 * 2. **The aperture, probed from OUTSIDE.** `dock-interiors.test.mjs` already
 *    fires rays from just INBOARD of the plating into the room, which is what
 *    found the lining panel that sealed the Kestrel from the inside. Nothing
 *    ever fired the other way, and outside is where the hull's dressing lives:
 *    relief, panel lines, ribs, string courses, bolt rows, knuckle strakes and
 *    the berth stencil all ran straight over the openings. **80 of 81. 73 of
 *    81. 67 of 81.** That is the sentence the player wrote, in numbers.
 *
 * ── This rig does not build `DockWorld` ─────────────────────────────────────
 * `_hullrig.mjs` constructs one `ShipBuild` at the origin and calls the hull
 * builder. Both questions here are properties of a hull alone and coupling
 * them to a 3,000-line world builder means an unrelated edit to the yard turns
 * them red — which is exactly what was happening while this file was written.
 */

const IDS = ['kestrel', 'dray', 'pike', 'bastion'];
const WALKABLE = ['kestrel', 'dray', 'pike'];

/** Doors, and the plan record each one is cut from. */
const DOORWAYS = [
  { id: 'kestrel', key: 'hatch', plane: 'x', door: 'dock_kestrel_hatch' },
  { id: 'dray', key: 'hatch', plane: 'x', door: 'dock_dray_hatch' },
  { id: 'dray', key: 'engineHatch', plane: 'z', door: 'dock_dray_engine' },
  { id: 'pike', key: 'hatch', plane: 'x', door: 'dock_pike_hatch' },
  // No leaf, but it is still a hole a body has to fit through on its knees.
  { id: 'pike', key: 'crouchHatch', plane: 'z', door: null },
];

/* ================================================================== */
/* The aperture probe                                                  */
/* ================================================================== */

/**
 * Where an opening is, in the hull's own frame, from the plan alone.
 *
 * Derived rather than measured, because the question being asked is whether
 * the BUILD agrees with the PLAN: a probe that read the opening off the built
 * geometry would find whatever hole happened to be there and pass.
 */
function apertureOf(H, key, plane) {
  const spec = H[key];
  /* `plane` names the axis the door's NORMAL runs along, so it also names
   * which of the two horizontal coordinates is the FACE the opening is cut in
   * and which is the axis the opening runs along. Getting those the wrong way
   * round is not a subtle failure — it aims the whole probe at a point 3 m
   * away from the door — and it is the same confusion that had the Dray's
   * engine hatch built on the keel line. */
  const w = plane === 'x' ? spec.w : (spec.hw != null ? spec.hw * 2 : spec.w);
  return {
    w,
    h: spec.h,
    /** Where the opening's centre is, along the axis it runs on. */
    c: plane === 'x' ? spec.lz : 0,
    /** Where the face is, on the axis the normal runs on. */
    face: plane === 'x' ? H.lower.hw : (spec.z ?? spec.lz),
    y0: H.deck.y,
  };
}

/**
 * Fire a 9 x 9 fan through an opening and report what stops it.
 *
 * ± 0.85 m either side and no further: that is a body's own approach, and it
 * is short enough that the engine block 1.3 m inside the Dray's engine room is
 * correctly not counted as blocking the door into it. The fan insets 0.08 m
 * from every jamb, so it measures the hole and not its frame.
 */
function apertureBlockage(soup, H, key, plane) {
  const a = apertureOf(H, key, plane);
  const SPAN = 0.85;
  let blocked = 0, total = 0;
  const names = new Map();
  for (let i = 0; i < 9; i++) {
    for (let k = 0; k < 9; k++) {
      const u = -a.w / 2 + 0.08 + (a.w - 0.16) * (i / 8);
      const y = a.y0 + 0.12 + (a.h - 0.24) * (k / 8);
      total++;
      const ox = plane === 'x' ? a.face + SPAN : a.c + u;
      const oz = plane === 'x' ? a.c + u : a.face + SPAN;
      /* Fired inboard along the normal in both cases; `SPAN` is on the side a
       * player approaches from, which for the two transverse doors is the
       * compartment forward of them. */
      const hit = raycast(soup, ox, y, oz,
        plane === 'x' ? -1 : 0, 0, plane === 'x' ? 0 : -1, SPAN * 2);
      if (hit) { blocked++; names.set(hit.name, (names.get(hit.name) ?? 0) + 1); }
    }
  }
  return { blocked, total, names: [...names].sort((p, q) => q[1] - p[1]) };
}

/** Put every door on a hull at `t` of the way open, as `Interiors` does. */
function poseDoors(h, t) {
  for (const rec of h.build.doors) {
    for (const leaf of rec.leaves) {
      if (leaf.slide) leaf.pivot.position.copy(leaf.closedPos).addScaledVector(leaf.slide, t);
      else leaf.pivot.rotation.y = leaf.closed + (leaf.open - leaf.closed) * t;
      leaf.pivot.updateMatrixWorld(true);
    }
    if (rec.collider) rec.collider.solid = t < 0.05;
  }
  h.group.updateMatrixWorld(true);
}

/* ================================================================== */
/* The silhouette rasteriser                                           */
/* ================================================================== */

/**
 * A BINARY COVERAGE BUFFER OF ONE HULL, SEEN FROM THE APRON.
 *
 * ── Why a rasteriser and not a bounding-box calculation ──────────────────
 * "Is this a spaceship or a box" is a question about the OUTLINE, and an
 * outline is not recoverable from any set of extents. A hull with a needle
 * nose and a hull with a flat bow have identical bounding boxes and read as
 * completely different objects at forty metres. The existing shape test in
 * `dock-hulls` measures per-station half-beams, which is closer, but a station
 * profile still cannot see that a canopy stands proud of a deck or that a
 * nacelle is separated from the fuselage by daylight.
 *
 * So: project every triangle, fill it, and count pixels. Orthographic and
 * hidden-surface-free, because coverage is all that is wanted — no depth
 * buffer, no shading, no allocation per triangle. A 44 m frigate at 128 px
 * across is 0.34 m per pixel, which is finer than the 0.6 m a 1080p frame gives
 * at the distance `VIEWS.dock`'s `bastion-crown` stands at.
 *
 * @param {THREE.Object3D[]} roots
 * @param {THREE.Vector3} eye
 * @param {THREE.Vector3} look
 * @param {number} span world metres across the frame
 * @param {number} N pixels across
 */
function coverage(roots, eye, look, span, N = 128) {
  const soup = triangles(roots);
  const fwd = new THREE.Vector3().subVectors(look, eye).normalize();
  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
  const buf = new Uint8Array(N * N);
  const a = soup.a;
  const px = new Float64Array(6);
  const scale = N / span;
  const rel = new THREE.Vector3();
  for (let i = 0; i < a.length; i += 9) {
    for (let k = 0; k < 3; k++) {
      rel.set(a[i + k * 3] - eye.x, a[i + k * 3 + 1] - eye.y, a[i + k * 3 + 2] - eye.z);
      px[k * 2] = N / 2 + rel.dot(right) * scale;
      px[k * 2 + 1] = N / 2 - rel.dot(up) * scale;
    }
    // Scanline fill of one triangle, clipped to the buffer.
    const x0 = Math.max(0, Math.floor(Math.min(px[0], px[2], px[4])));
    const x1 = Math.min(N - 1, Math.ceil(Math.max(px[0], px[2], px[4])));
    const y0 = Math.max(0, Math.floor(Math.min(px[1], px[3], px[5])));
    const y1 = Math.min(N - 1, Math.ceil(Math.max(px[1], px[3], px[5])));
    if (x1 < x0 || y1 < y0) continue;
    const d = (px[2] - px[0]) * (px[5] - px[1]) - (px[4] - px[0]) * (px[3] - px[1]);
    if (Math.abs(d) < 1e-9) continue;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const qx = x + 0.5, qy = y + 0.5;
        const w0 = ((px[2] - px[0]) * (qy - px[1]) - (qx - px[0]) * (px[3] - px[1])) / d;
        const w1 = ((qx - px[0]) * (px[5] - px[1]) - (px[4] - px[0]) * (qy - px[1])) / d;
        if (w0 < 0 || w1 < 0 || w0 + w1 > 1) continue;
        buf[y * N + x] = 1;
      }
    }
  }
  return { buf, N };
}

/**
 * Three numbers off a coverage buffer, and what each one catches.
 *
 * - **`fill`** — lit pixels over the area of the tight bounding rectangle. A
 *   rectangular slab fills 1.00 by definition. Anything with a nose, a
 *   tapering tail or daylight round its engines fills less, and how much less
 *   is how much shape it has.
 * - **`runs`** — the mean number of separate lit runs on a scanline. A slab
 *   scores exactly 1.00: every row it covers is one unbroken span. Anything
 *   with daylight in it — a nacelle on a pylon, a V-tail, a lattice derrick, a
 *   gap between landing gear legs, a conning tower beside a barbette — puts a
 *   second and third run on some of its rows. This is the number that says
 *   "articulated machine" rather than "smooth blob", which `fill` cannot: a
 *   perfect ellipsoid fills 0.79 of its box and is still one object.
 *
 *   It replaced a perimeter-over-area figure that was measuring elongation
 *   rather than shape — a 20 x 5 m slab scored 1.24 on it — which the ablation
 *   at the end of the silhouette test caught before any floor was set from it.
 * - **`stack`** — the same count taken down COLUMNS instead of across rows. A
 *   slab scores 1.00 here too. What lands in this one is vertical
 *   articulation: landing gear with daylight between the belly and the foot, a
 *   canopy standing over a deck, a mast over a bridge, a boom over a hatch.
 *   `runs` and `stack` are the two axes of the same question and a hull needs
 *   both — the Pike scores 2.70 across and 1.55 down, the Dray 2.00 and 1.83.
 *
 *   A third descriptor sat here first and had to go: the share of the
 *   silhouette lying on rows narrower than 60% of the widest. It reads well on
 *   paper and it FIGHTS the other two — putting landing gear on the Dray moved
 *   her `runs` from 1.69 to 1.81 and her row-width figure from 0.13 to 0.10,
 *   because a pair of legs 8.8 m apart under a 10.4 m hull is a wide row that
 *   happens to be mostly air. A descriptor that goes the wrong way when the
 *   hull is improved is not a descriptor, and `stack` is the honest version of
 *   what it was reaching for.
 */
function shape(cov) {
  const { buf, N } = cov;
  let lit = 0, x0 = N, x1 = -1, y0 = N, y1 = -1;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (!buf[y * N + x]) continue;
      lit++;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (!lit) return { lit: 0, fill: 0, runs: 0, stack: 0, w: 0, h: 0 };
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  /* Runs per scanline. Only rows carrying at least 3 lit pixels are counted:
   * a row with one stray pixel from an antenna tip is not evidence about the
   * shape of the hull, and including it lets a single spike carry the metric. */
  let runRows = 0, runTotal = 0;
  for (let y = y0; y <= y1; y++) {
    let r = 0, litRow = 0, prev = 0;
    for (let x = 0; x < N; x++) {
      const v = buf[y * N + x];
      if (v) { litRow++; if (!prev) r++; }
      prev = v;
    }
    if (litRow >= 3) { runRows++; runTotal += r; }
  }
  /* And the same count down every column. */
  let colCols = 0, colTotal = 0;
  for (let x = x0; x <= x1; x++) {
    let r = 0, litCol = 0, prev = 0;
    for (let y = 0; y < N; y++) {
      const v = buf[y * N + x];
      if (v) { litCol++; if (!prev) r++; }
      prev = v;
    }
    if (litCol >= 3) { colCols++; colTotal += r; }
  }
  return {
    lit, w, h,
    fill: lit / (w * h),
    runs: runRows ? runTotal / runRows : 0,
    stack: colCols ? colTotal / colCols : 0,
  };
}

/** The three framings a player gets: broadside, three-quarter, and head-on. */
function framings(H) {
  const cz = (H.z0 + H.z1) / 2;
  const len = H.z1 - H.z0;
  const d = len * 1.35;
  const eyeY = Math.max(2.4, (H.spine?.y ?? 6) * 0.55);
  const at = new THREE.Vector3(0, (H.spine?.y ?? 6) * 0.45, cz);
  return [
    { name: 'broadside', eye: new THREE.Vector3(d, eyeY, cz), at, span: len * 1.5 },
    { name: 'quarter', eye: new THREE.Vector3(d * 0.72, eyeY * 1.5, cz - d * 0.72), at, span: len * 1.5 },
    { name: 'bow', eye: new THREE.Vector3(d * 0.3, eyeY, cz + d), at, span: len * 1.2 },
  ];
}

/* ================================================================== */
/* Tests                                                               */
/* ================================================================== */

test('every doorway is a hole from OUTSIDE, not just a hole in the plating', async () => {
  /* THE PLAYER'S SECOND SENTENCE, MEASURED.
   *
   * `plated(..., { opening })` cut the hatch out of the skin and six later
   * passes covered it up again. Fired inboard from 0.85 m outside on a 9 x 9
   * fan inset 0.08 m from every jamb, with every leaf OPEN:
   *
   *   kestrel  hatch        80/81 -> 0/81
   *   dray     hatch        73/81 -> 0/81
   *   dray     engineHatch  72/81 -> 0/81
   *   pike     hatch        67/81 -> 0/81
   *   pike     crouchHatch  24/81 -> 0/81
   *
   * The floor is ZERO and it is not a tolerance. A drawn-only obstruction is
   * worse than a solid one, not better: the player walks through it and the
   * world reads as unbuilt. */
  const bad = [];
  for (const d of DOORWAYS) {
    const h = await hull(d.id);
    poseDoors(h, 1);
    const soup = triangles([h.extRoot, h.intRoot, h.group]);
    const r = apertureBlockage(soup, h.plan, d.key, d.plane);
    if (r.blocked) {
      bad.push(`${d.id}.${d.key}: ${r.blocked}/${r.total} of the open aperture is `
        + `blocked by [${r.names.map(([n, c]) => n + ' x' + c).join(', ')}]`);
    }
  }
  assert.deepEqual(bad, [],
    'floor 0, ceiling 0 (the whole aperture). achieved:\n  ' + bad.join('\n  '));
});

test('a shut hatch is a wall, and it is the LEAVES that make it one', async () => {
  /* The other half of the same question, and the one the hinged version got
   * catastrophically wrong.
   *
   * The old leaf was hung at `P(lx, ly, lz - hw)` with its mesh at local `+X`
   * of a pivot yawed `PI/2`, and three.js sends `+X` to `(cos a, 0, -sin a)` —
   * so a SHUT leaf's centre landed at `lz - w`, one full width aft of the hole.
   * Shut, the Kestrel's doorway had a slab bolted up beside it and open air in
   * it. Nothing noticed, because the shut state was only ever asked about
   * through the collider, and the collider was in the right place.
   *
   * So this asks it through the GEOMETRY: with `anim = 0`, the same fan that
   * has to see clean through an open door has to be stopped by every sample —
   * and stopped BY A LEAF, not by whatever else happens to be standing there.
   *
   * Ablation, so the ceiling is real: with the leaf meshes dropped from the
   * soup the same fan must go through, or the assertion above is being carried
   * by the hull rather than by the door. */
  const rows = [];
  for (const d of DOORWAYS) {
    if (!d.door) continue;
    const h = await hull(d.id);
    poseDoors(h, 0);
    const shut = apertureBlockage(triangles([h.extRoot, h.intRoot, h.group]), h.plan, d.key, d.plane);
    const leafHits = shut.names
      .filter(([n]) => n.startsWith('hatchleaf:'))
      .reduce((n, [, c]) => n + c, 0);
    /* The ablation: the leaves removed and nothing else changed. */
    const noLeaves = new THREE.Group();
    for (const child of [...h.group.children]) noLeaves.add(child);
    noLeaves.updateMatrixWorld(true);
    const without = apertureBlockage(triangles([h.extRoot, h.intRoot]), h.plan, d.key, d.plane);
    for (const child of [...noLeaves.children]) h.group.add(child);
    h.group.updateMatrixWorld(true);
    rows.push({ d, shut, leafHits, without });
  }
  const bad = [];
  for (const { d, shut, leafHits, without } of rows) {
    if (shut.blocked !== shut.total) {
      bad.push(`${d.id}.${d.key}: shut, only ${shut.blocked}/${shut.total} of the aperture is `
        + 'covered - a closed door with daylight through it');
    }
    if (leafHits !== shut.total) {
      bad.push(`${d.id}.${d.key}: only ${leafHits}/${shut.total} of the shut aperture is stopped `
        + `by a leaf; the rest is [${shut.names.filter(([n]) => !n.startsWith('hatchleaf:'))
          .map(([n, c]) => n + ' x' + c).join(', ')}]`);
    }
    if (without.blocked !== 0) {
      bad.push(`${d.id}.${d.key}: with the leaves ablated ${without.blocked}/${without.total} is `
        + 'still blocked - the "shut" reading is coming from the hull, not the door');
    }
  }
  assert.deepEqual(bad, [], bad.length + ' door(s) do not cover their own opening:\n  ' + bad.join('\n  '));
});

test('the hatches SLIDE, and they slide far enough to clear their own hole', async () => {
  /* "the doors should slide open on a spaceship". A leaf slides when it
   * carries a travel vector and translates along it; the old ones carried a
   * rotation and swung. Both halves are asserted, because a `slide` field that
   * nothing moves is a swinging door with a new property on it.
   *
   * The travel floor is half the clear width — a bi-parting pair each has to
   * cross its own half of the opening — and it is checked against the leaf's
   * measured world displacement rather than against the number that was
   * written down. */
  const bad = [];
  for (const d of DOORWAYS) {
    if (!d.door) continue;
    const h = await hull(d.id);
    const rec = h.build.doors.find((x) => x.id === d.door);
    assert.ok(rec, `${d.door} was never built`);
    const a = apertureOf(h.plan, d.key, d.plane);
    assert.equal(rec.leaves.length, 2, `${d.door} is not a bi-parting pair`);
    for (const leaf of rec.leaves) {
      if (!leaf.slide) { bad.push(`${d.door}: a leaf still swings`); continue; }
      poseDoors(h, 0);
      const shutAt = leaf.pivot.position.clone();
      poseDoors(h, 1);
      const openAt = leaf.pivot.position.clone();
      const moved = openAt.distanceTo(shutAt);
      const floor = a.w / 2;
      if (moved < floor - 1e-6) {
        bad.push(`${d.door}: a leaf travels ${moved.toFixed(2)} m against a floor of `
          + `${floor.toFixed(2)} m (half the ${a.w.toFixed(2)} m opening)`);
      }
      /* And it slides ALONG the opening rather than away from the hull: the
       * travel has to be perpendicular to the door's own normal. */
      const alongY = Math.abs(leaf.slide.y);
      if (alongY > 1e-6) bad.push(`${d.door}: a leaf's travel has a ${alongY.toFixed(3)} m vertical component`);
    }
    /* And the pocket the leaves run into is declared, so nothing is dressed
     * onto it. One number, `slidePocket`, used by the hatch and by the hull. */
    if (d.plane === 'x') {
      const clear = h.build.clearOfAperture(Math.sign(a.face) || 1,
        a.c - slidePocket(a.w) + 0.05, a.c + slidePocket(a.w) - 0.05,
        a.y0 + 0.1, a.y0 + a.h - 0.1);
      if (clear) bad.push(`${d.door}: the pocket is not declared as an aperture`);
    }
  }
  assert.deepEqual(bad, [], bad.join('\n  '));
});

test('a body walks through every hatch when it is open, and into it when it is shut', async () => {
  /* THE VERB, DRIVEN AGAINST THE REAL SOLVER.
   *
   * Rays are about what can be SEEN through. This is about what can be walked
   * through, and it uses `Physics.resolveCapsule` — the same call
   * `Player._move` makes, at the same radius and height — rather than a
   * re-derivation of it. The capsule is stepped across the threshold on a
   * 0.1 m pitch and a step counts as passed when the solver applies no push
   * that moves it more than 0.02 m.
   *
   * Both directions, because a door that opens is not the same claim as a door
   * that is shut: with `anim = 0` the collider is solid and at least one step
   * in the middle of the run has to be refused, or the shut door is a
   * decoration. That ablation is what stops this test passing on a hull with
   * no door in it at all. */
  const RADIUS = 0.35, HEIGHT = 1.75;
  const bad = [];
  for (const d of DOORWAYS) {
    if (!d.door) continue;
    const h = await hull(d.id);
    const a = apertureOf(h.plan, d.key, d.plane);
    const pos = new THREE.Vector3();
    /* THREE LANES, NOT ONE, AND THAT IS THE WHOLE VALUE OF THIS TEST.
     *
     * A centreline walk cannot tell a door from a bollard. The Dray's engine
     * hatch was built with `plane: 'x'` against a transverse bulkhead, which
     * gave it a collider 0.12 m thick in X and 1.20 m long in Z — edge-on in
     * its own doorway — and a capsule walking the centreline still met it,
     * because a 0.35 m radius reaches 0.35 m either side of a needle. What it
     * did NOT do was seal a 1.20 m opening: a body two thirds of a metre off
     * the centre walked straight through the shut door. So every lane the
     * opening is wide enough to hold has to be refused when it is shut, and
     * every one has to be clear when it is open. */
    const lanes = [];
    for (let u = -a.w / 2 + RADIUS + 0.05; u <= a.w / 2 - RADIUS - 0.04; u += 0.35) lanes.push(+u.toFixed(3));
    if (!lanes.length) lanes.push(0);
    const walk = (u) => {
      const refused = [];
      for (let t = -0.7; t <= 0.7001; t += 0.1) {
        if (d.plane === 'x') pos.set(a.face - 0.11 + t, a.y0 + 0.02, a.c + u);
        else pos.set(a.c + u, a.y0 + 0.02, a.face - 0.11 + t);
        const before = pos.clone();
        h.physics.resolveCapsule(pos, RADIUS, HEIGHT);
        const moved = Math.hypot(pos.x - before.x, pos.z - before.z);
        if (moved > 0.02) refused.push(+t.toFixed(2));
      }
      return refused;
    };
    poseDoors(h, 1);
    const openRefused = lanes.map(walk);
    poseDoors(h, 0);
    const shutRefused = lanes.map(walk);
    lanes.forEach((u, i2) => {
      if (openRefused[i2].length) {
        bad.push(`${d.door}: OPEN, lane ${u} m off centre is pushed at `
          + `t=[${openRefused[i2].join(', ')}] - the doorway is not walkable`);
      }
      if (!shutRefused[i2].length) {
        bad.push(`${d.door}: SHUT, lane ${u} m off centre crosses the threshold untouched `
          + '- the closed door does not fill its own opening');
      }
    });
  }
  assert.deepEqual(bad, [], bad.join('\n  '));
});

test('a hatch announces itself so something can make a noise about it', async () => {
  /* "with a swoosh sound". The sound is not made here and it is not made in
   * `Interiors` either — `AudioDirector`'s header states the rule: nothing
   * else in the codebase imports the audio layer, systems announce and the
   * director decides. What a hull owes is the announcement, and the field that
   * tells the director this is a shutter rather than a hinge. */
  for (const d of DOORWAYS) {
    if (!d.door) continue;
    const h = await hull(d.id);
    const rec = h.build.doors.find((x) => x.id === d.door);
    assert.equal(rec.sound, 'slide',
      `${d.door} does not publish a voice, so it opens in silence`);
    assert.ok(rec.size > 0.5 && rec.size < 4,
      `${d.door} publishes size ${rec.size} - the mechanism scales the sound and this is nonsense`);
  }

  /* AND THE OTHER END OF THE WIRE.
   *
   * A `sound` field nothing reads is a field, not a sound. `AudioDirector` is
   * built here for real and its `interior:door` handler is fired with each of
   * the two voices, so the chain hull -> door record -> `Interiors` event ->
   * director -> recipe is proven rather than assumed. The two `Sfx` methods are
   * swapped for spies because the assertion is about ROUTING; what they sound
   * like is not a thing a test can hold an opinion about.
   *
   * The 'hinge' half matters as much as the 'slide' half: adding a voice to
   * four ship hatches must not give every plank door in the medieval world a
   * pneumatic compressor, and the default is what stops it. */
  const { AudioDirector } = await import('../../src/audio/AudioDirector.js');
  const handlers = new Map();
  const bus = { on: (t, f) => { if (!handlers.has(t)) handlers.set(t, []); handlers.get(t).push(f); return () => {}; }, emit() {} };
  const director = new AudioDirector({ bus });
  let called = null;
  director.sfx.doorSlide = (at, o) => { called = ['slide', o]; };
  director.sfx.doorHinge = (at, o) => { called = ['hinge', o]; };
  const fire = (e) => handlers.get('interior:door').forEach((f) => f(e));
  assert.ok(handlers.has('interior:door'),
    'AudioDirector does not listen for interior:door - the hatches open in silence');
  fire({ id: 'x', open: true, position: null, sound: 'slide', size: 2.73 });
  assert.deepEqual(called, ['slide', { open: true, size: 2.73 }],
    'a ship hatch does not reach Sfx.doorSlide, or loses the size the recipe is pitched from');
  fire({ id: 'y', open: false, position: null });
  assert.deepEqual(called, ['hinge', { open: false }],
    'a door with no declared voice does not fall back to the hinge - every door in the game '
    + 'just became a pressure door');
});

test('Interiors drives a real hatch: it emits, it slides, and it unseals', async () => {
  /* THE MIDDLE OF THE WIRE, DRIVEN RATHER THAN REIMPLEMENTED.
   *
   * Everything above this either poses the leaves itself (`poseDoors`) or fires
   * the director's handler by hand, and both of those are copies of code that
   * lives in `Interiors`. A copy proves the copy. So this builds the real
   * `Interiors`, hands it a real hull's real door record, stands a player at
   * the threshold, presses E, and watches what actually happens:
   *
   *   - the prompt appears (the medieval winding house is why: a door published
   *     at its sill was never offered at all),
   *   - the bus carries `interior:door` with this door's own voice,
   *   - the leaves TRANSLATE rather than rotate, and end up a leaf-width apart,
   *   - the collider stops being solid.
   *
   * `Interiors` is given the minimum context it reads and a world with
   * `_autoInteriors` unset, so `_ensureRollout` returns immediately and nothing
   * generic is built on top. */
  const { Interiors } = await import('../../src/systems/Interiors.js');
  const h = await hull('kestrel');
  const rec = h.build.doors.find((d) => d.id === 'dock_kestrel_hatch');
  const H = h.plan;

  const events = [];
  const listeners = new Map();
  const bus = {
    on: (t, f) => { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(f); return () => {}; },
    emit: (t, e) => { events.push([t, e]); (listeners.get(t) ?? []).forEach((f) => f(e)); },
  };
  /* The player stands ON THE RAMP HEAD, derived from the plan — not at
   * `rec.position`, which is the very thing being tested. Standing the body
   * wherever the door says it is makes the prompt assertion circular: a hatch
   * published 4 m up in the air would take the player with it and still pass,
   * which is exactly the medieval winding-house defect this check exists for.
   * The rig builds at the origin with yaw 0, so local is world. */
  const player = { position: new THREE.Vector3(H.lower.hw + 0.7, H.deck.y, H.hatch.lz) };
  let pressed = false;
  const io = new Interiors({
    bus, player, physics: h.physics, loot: null,
    input: { pressed: () => pressed }, worldManager: null,
  });
  bus.emit('world:changed', {
    id: 'dock',
    world: { rules: {}, enterables: [{ label: 'ship-kestrel', doors: [rec], lifts: [], spots: [] }] },
  });

  const shutAt = rec.leaves.map((l) => l.pivot.position.clone());
  const shutRot = rec.leaves.map((l) => l.pivot.rotation.y);

  /* One frame with nothing pressed: the prompt has to be offered, or the rest
   * of this test is measuring a door the player can never reach. */
  io.update(0.016);
  assert.equal(io._promptText, 'Open door',
    `no prompt at the threshold - the player is ${player.position.distanceTo(rec.position).toFixed(2)} m `
    + 'from the door and Interiors offers one within 3.0 m horizontally and 2.6 m vertically');

  pressed = true;
  io.update(0.016);
  pressed = false;
  const emitted = events.filter(([t]) => t === 'interior:door').map(([, e]) => e);
  assert.equal(emitted.length, 1, 'working the hatch raised no interior:door event');
  assert.equal(emitted[0].sound, 'slide', 'the event carries the wrong voice');
  assert.equal(emitted[0].open, true, 'the event says the door shut when it opened');

  // Run the animation out at the rate `Interiors` uses (dt * 3.2).
  for (let i = 0; i < 60 && rec.anim < 1; i++) io.update(0.033);
  assert.equal(rec.anim, 1, `the door stalled at anim ${rec.anim.toFixed(2)}`);

  rec.leaves.forEach((l, i) => {
    const moved = l.pivot.position.distanceTo(shutAt[i]);
    assert.ok(moved > H.hatch.w / 2 - 1e-6,
      `leaf ${i} travelled ${moved.toFixed(2)} m under the real driver, against `
      + `${(H.hatch.w / 2).toFixed(2)} m of opening to clear`);
    assert.equal(l.pivot.rotation.y, shutRot[i],
      `leaf ${i} ROTATED. It is a slider; the hinge path is still being taken`);
  });
  assert.equal(rec.collider.solid, false, 'an open hatch is still a solid wall');

  // And back, because a door that only opens is half a door.
  pressed = true; io.update(0.016); pressed = false;
  for (let i = 0; i < 60 && rec.anim > 0; i++) io.update(0.033);
  assert.equal(rec.anim, 0, `the door stalled shutting at anim ${rec.anim.toFixed(2)}`);
  rec.leaves.forEach((l, i) => {
    assert.ok(l.pivot.position.distanceTo(shutAt[i]) < 1e-6,
      `leaf ${i} did not come back to its shut position`);
  });
  assert.equal(rec.collider.solid, true, 'a shut hatch is not solid again');
  assert.equal(events.filter(([t]) => t === 'interior:door').length, 2,
    'closing the hatch made no sound');
});

test('no hull is a slab: the silhouette is measured, at the size a player sees', async () => {
  /* THE PLAYER'S FIRST SENTENCE, MEASURED.
   *
   * Three descriptors off a 128 px coverage buffer, in three framings each.
   * Every floor below is set under the WORST of the four hulls on this build,
   * with the margin written next to it, so the number that fails first is the
   * one that regressed.
   *
   * Measured, worst framing per hull:
   *
   *   hull     view       fill   runs   stack
   *   kestrel  broadside  0.42   1.75   1.41
   *   kestrel  quarter    0.42   1.89   1.63
   *   kestrel  bow        0.44   2.00   1.86
   *   dray     broadside  0.47   2.00   1.43
   *   dray     quarter    0.49   1.81   1.92
   *   dray     bow        0.41   2.10   1.83
   *   pike     broadside  0.31   2.70   1.41
   *   pike     quarter    0.40   2.16   1.55
   *   pike     bow        0.43   2.86   1.82
   *   bastion  broadside  0.37   4.23   1.30
   *   bastion  quarter    0.37   4.52   1.58
   *   bastion  bow        0.56   2.27   1.45
   *
   * The floors are set under the worst row of each column, with the margin
   * written at the assertion. `stack` was set BY a hull failing it: the Kestrel
   * scored 1.18 broadside — every feature that makes her a courier is
   * outboard, and outboard is invisible in profile — and she was given a
   * dorsal mast and boom rather than the floor being lowered to suit her. The
   * Dray's landing gear moved her from 1.33/1.79/1.65 to 1.43/1.92/1.83 and
   * was NOT forced by a floor; she was passing all three and still read as a
   * barge with a crane on it, which is worth knowing about these numbers:
   * clearing them is necessary and it is not sufficient.
   *
   * A rectangular slab scores fill 1.00, runs 1.00 and stack 1.00 by
   * construction; the ablation at the top of this test proves those three
   * numbers rather than assuming them, so the floors mean something.
   */
  const rows = [];
  for (const id of IDS) {
    const h = await hull(id);
    poseDoors(h, 0);
    const roots = [h.extRoot, h.group];
    for (const f of framings(h.plan)) {
      const s = shape(coverage(roots, f.eye, f.at, f.span));
      rows.push({ id, view: f.name, ...s });
    }
  }
  const table = rows.map((r) => `${r.id.padEnd(8)} ${r.view.padEnd(10)} `
    + `lit ${String(r.lit).padStart(5)} fill ${r.fill.toFixed(2)} `
    + `runs ${r.runs.toFixed(2)} stack ${r.stack.toFixed(2)}`).join('\n  ');

  /* THE CEILING FIRST, BY ABLATION, because a floor with no known worst case
   * is a floor nobody can read. A 20 x 6 x 5 m box through the same rasteriser
   * at the same size has to sit at the extreme of all three descriptors, and
   * this is the assertion that caught the first version of the third one
   * measuring elongation instead of shape. */
  const box = new THREE.Mesh(new THREE.BoxGeometry(6, 5, 20));
  box.updateMatrixWorld(true);
  const bs = shape(coverage([box], new THREE.Vector3(30, 2.5, 0), new THREE.Vector3(0, 2.5, 0), 30));
  assert.ok(bs.fill > 0.98, `a plain box fills ${bs.fill.toFixed(2)}, not ~1.00 - the metric is wrong`);
  assert.ok(bs.runs < 1.02, `a plain box scores runs ${bs.runs.toFixed(2)}, not 1.00 - the metric is wrong`);
  assert.ok(bs.stack < 1.02, `a plain box scores stack ${bs.stack.toFixed(2)}, not 1.00 - the metric is wrong`);

  const bad = [];
  for (const r of rows) {
    if (r.lit < 400) bad.push(`${r.id}/${r.view}: only ${r.lit} px lit - the framing found nothing`);
    if (r.fill > 0.62) {
      bad.push(`${r.id}/${r.view}: fills ${r.fill.toFixed(2)} of its own bounding box `
        + '(ceiling 0.62, a slab is 1.00) - that is a slab');
    }
    if (r.runs < 1.30) {
      bad.push(`${r.id}/${r.view}: ${r.runs.toFixed(2)} lit runs per scanline `
        + '(floor 1.30, a slab is 1.00) - nothing stands off the body with daylight round it');
    }
    if (r.stack < 1.24) {
      bad.push(`${r.id}/${r.view}: ${r.stack.toFixed(2)} lit runs per column `
        + '(floor 1.24, a slab is 1.00) - nothing stands over or under the body');
    }
  }
  assert.deepEqual(bad, [], bad.length + ' framings read as a box:\n  ' + table + '\n\n  ' + bad.join('\n  '));
});

test('the hulls stay inside their triangle budget', async () => {
  /* One number per hull, printed on failure, so a shape change that quietly
   * doubles a hull is visible in the diff of this comment rather than in a
   * frame time three weeks later.
   *
   * Measured on this build, exterior including the loose door leaves, and
   * interior:
   *
   *   kestrel   9,608 + 468
   *   dray     22,570 + 848
   *   pike     12,720 + 756
   *   bastion  31,928 + 0     (no interior: she is a hulk)
   *
   * The rebuilt doors were CHEAPER than the hinged ones, because cutting the
   * apertures out of relief, panel lines, ribs, courses and bolt rows removes
   * more geometry than two leaves and a surround add: the Kestrel went from
   * 11,020 to 9,608 and the Dray from 24,702 to 22,570.
   *
   * The ceiling is 38,000 exterior per hull — the Bastion is the one that
   * matters and she has 19% of head — and 95,000 for the four together with
   * their interiors against a measured 78,898. */
  const rows = [];
  let total = 0;
  for (const id of IDS) {
    const h = await hull(id);
    const ext = triCount(h.extRoot) + triCount(h.group);
    const int = triCount(h.intRoot);
    rows.push({ id, ext, int });
    total += ext + int;
  }
  const table = rows.map((r) => `${r.id.padEnd(8)} exterior ${String(r.ext).padStart(6)} `
    + `interior ${String(r.int).padStart(6)}`).join('\n  ');
  for (const r of rows) {
    assert.ok(r.ext <= 38000,
      `${r.id} draws ${r.ext} exterior triangles against a ceiling of 38000\n  ` + table);
  }
  assert.ok(total <= 95000, `the four hulls draw ${total} triangles against 95000\n  ` + table);
});

test('every hull declares the apertures its own plan says it has', async () => {
  /* The guard on the mechanism rather than on its result.
   *
   * `flankAperture` declares the keep-out at the top of a builder and
   * `ShipBuild.hatch` declares it again at the bottom; both derive the span
   * from `slidePocket` and the plan's own `hatch` record. If a future hull
   * cuts an opening and forgets the declaration, every dressing pass goes back
   * to running over it — and the aperture probe would catch that only if the
   * dice happened to land something there. This catches it directly. */
  for (const id of WALKABLE) {
    const h = await hull(id);
    const H = PLAN.HULLS[id];
    const c = H.hatch.lz;
    const p = slidePocket(H.hatch.w);
    const side = 1;   // the rig always boards to starboard
    assert.ok(!h.build.clearOfAperture(side, c - 0.05, c + 0.05, H.deck.y + 0.2, H.deck.y + H.hatch.h - 0.2),
      `${id}: the boarding opening at z ${c} is not declared as an aperture`);
    assert.ok(!h.build.clearOfAperture(side, c + p - 0.15, c + p - 0.05, H.deck.y + 0.2, H.deck.y + H.hatch.h - 0.2),
      `${id}: the forward pocket is not declared - a leaf slides over live plating`);
    assert.ok(!h.build.clearOfAperture(side, c - p + 0.05, c - p + 0.15, H.deck.y + 0.2, H.deck.y + H.hatch.h - 0.2),
      `${id}: the aft pocket is not declared - a leaf slides over live plating`);
    /* And it is a LOCAL keep-out, not a hull-wide one: a hull whose whole
     * flank was declared would pass every check above and lose all its
     * dressing. */
    assert.ok(h.build.clearOfAperture(side, c + p + 0.6, c + p + 1.0, H.deck.y + 0.2, H.deck.y + 1.0),
      `${id}: the aperture reaches more than 0.6 m past its own pocket`);
  }
});

/* ================================================================== */
/* 3. Is the skin made of axis-aligned boxes?                          */
/* ================================================================== */

/**
 * A face counts as axis-aligned when its normal is within this of +/-X, +/-Y
 * or +/-Z. 0.0026 rad is 0.15 degrees: tight enough that a deliberate 1-degree
 * rake reads as shaped, loose enough that float error in a flat plate does not.
 */
const AXIS_EPS = 0.0026;

/**
 * Every drawn triangle whose OUTWARD normal escapes the hull, with its area
 * and whether it is axis-aligned.
 *
 * The "escapes" test is what makes this measure the thing the player is
 * complaining about. A `cbox` has six faces and five of them are usually
 * buried in the next box along; counting all of them measures how the hull was
 * ASSEMBLED, which nobody can see. Counting only the faces a ray can leave
 * from measures the SKIN.
 *
 * The ray is fired from 0.02 m off the centroid along the normal, out to 60 m,
 * against the hull's own soup - so a face inside a sealed volume, inside a
 * compartment, or under the deck is excluded, and a face on the outside is
 * kept even when something else stands off it.
 */
function skin(soup, plan) {
  const a = soup.a;
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  const n = new THREE.Vector3(), c = new THREE.Vector3();
  let area = 0, axis = 0, underAxis = 0;
  for (let i = 0; i + 8 < a.length; i += 9) {
    A.set(a[i], a[i + 1], a[i + 2]);
    B.set(a[i + 3], a[i + 4], a[i + 5]);
    C.set(a[i + 6], a[i + 7], a[i + 8]);
    e1.subVectors(B, A); e2.subVectors(C, A); n.crossVectors(e1, e2);
    const ar = n.length() / 2;
    if (!(ar > 1e-6)) continue;
    n.multiplyScalar(1 / (2 * ar));
    c.copy(A).add(B).add(C).multiplyScalar(1 / 3).addScaledVector(n, 0.02);
    if (raycast(soup, c.x, c.y, c.z, n.x, n.y, n.z, 60)) continue;
    area += ar;
    const ax = Math.max(Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)) >= Math.cos(AXIS_EPS);
    if (!ax) continue;
    axis += ar;
    // The underside: a downward face below the keel line.
    if (n.y < -0.9 && c.y < plan.lower.y0) underAxis += ar;
  }
  return { area, axis, underAxis, frac: axis / area, under: underAxis / area };
}

test('no hull is a box: the visible skin is mostly not axis-aligned plate', async () => {
  /* THE PLAYER'S HEADLINE COMPLAINT, AS A NUMBER.
   *
   * Verbatim: "spaceships do not look like spaceships, they look like they are
   * made of square blocks." Every other test in this file was green while that
   * was being said, because "the silhouette is not a rectangle" and "the
   * surface is not a stack of plates" are different properties: a hull can
   * clear the fill/runs/stack floors above by bolting OUTBOARD props - a mast,
   * a boom, landing gear - onto a box without touching the box.
   *
   * So this measures the skin itself. Measured before the underbody was
   * lofted, and after:
   *
   *              axis-aligned skin      of which, the flat underside
   *              box belly -> keel      box belly -> keel
   *   kestrel      65.1%    52.7%        15.0%    3.6%
   *   dray         80.4%    63.8%        19.5%    3.8%
   *   pike         77.5%    67.4%        15.0%    4.7%
   *
   * The ceilings below are set just above what the lofted hulls achieve, so
   * reverting any one belly to the single `cbox` it used to be goes red -
   * which is the ablation, and it was run.
   *
   * The residue is NOT slack and the numbers say where it is. On the Kestrel
   * the two largest survivors are the midbody flanks (16.7% of the skin) and
   * the weather decks (8.4%), and neither is free: `sec`'s own note records
   * that a room's half-beam IS the flank minus `SKIN`, so a tumblehome between
   * the sole and the deckhead eats the compartment behind it, and a deck is
   * walked on by `dock-reach`. Getting past that needs the three hulls
   * re-beamed wider than their rooms, which moves every climb band, both ramp
   * heads and the berth clearances with it. That is a piece of work, not a
   * tweak, and it is not hidden by this test - it is the reason the ceilings
   * are where they are rather than at the alien skiff's 22.7%.
   */
  const CEIL = { kestrel: 0.58, dray: 0.70, pike: 0.72 };
  const rows = [];
  for (const id of WALKABLE) {
    const h = await hull(id);
    const s = skin(triangles([h.extRoot, h.group]), PLAN.HULLS[id]);
    rows.push(`${id.padEnd(8)} skin ${s.area.toFixed(0).padStart(5)} m2  `
      + `axis ${(s.frac * 100).toFixed(1)}% (ceiling ${(CEIL[id] * 100).toFixed(0)}%)  `
      + `flat underside ${(s.under * 100).toFixed(1)}%`);
  }
  const table = rows.join('\n  ');
  for (const id of WALKABLE) {
    const h = await hull(id);
    const s = skin(triangles([h.extRoot, h.group]), PLAN.HULLS[id]);
    assert.ok(s.frac <= CEIL[id],
      `${id}: ${(s.frac * 100).toFixed(1)}% of its visible skin is axis-aligned plate, `
      + `against a ceiling of ${(CEIL[id] * 100).toFixed(0)}%\n  ` + table);
    /* The underside on its own, because it is the one large flat these hulls
     * were free to shape and the one that regresses in a single line. A box
     * belly reads 15-19.5%. */
    assert.ok(s.under <= 0.06,
      `${id}: ${(s.under * 100).toFixed(1)}% of its visible skin is a flat, level underside `
      + `against a ceiling of 6% - the belly is a box again\n  ` + table);
    /* And the probe has to still be finding a hull. A soup that stopped
     * escaping would report 0% and pass everything above. */
    assert.ok(s.area > 150, `${id}: only ${s.area.toFixed(0)} m2 of skin found - the probe is blind\n  ` + table);
  }
});
