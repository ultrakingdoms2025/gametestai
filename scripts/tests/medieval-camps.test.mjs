/**
 * THE FAR-BANK GATE.
 *
 * The brief for the camps is one sentence with three loaded words in it:
 * "camps with tents, firepits and spit roasts on the OTHER SIDE of the river
 * NEAR THE ROAD". Each of those is a claim a test can settle and a screenshot
 * cannot:
 *
 *   - "the other side" is not a compass bearing. The river's centreline swings
 *     from z = 50 at Ashlea to z = 126 at Harrowgate, so a camp authored at
 *     "z = 140, which is south" is on the far bank at one x and the vale bank
 *     at another. It is computed per camp, never declared.
 *   - "near the road" has to be near ENOUGH to find and far ENOUGH not to be
 *     in the carriageway.
 *   - a camp on a 25% slope is tents pitched on a hillside, which no one does.
 *
 * And the layout has the same overlap problem a town does, at a smaller scale:
 * a bedroll inside a firepit is invisible in a plan and obvious in a frame.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { medievalHeight, riverZ, riverHalfWidth, WATER_Y } from '../../src/worlds/terrain/MedievalHeight.js';
import { CAMPS, campPieces, piecePosition, bankOf, campGround } from '../../src/worlds/medieval/Camps.js';
import { SETTLEMENTS, settledAt } from '../../src/worlds/medieval/Settlements.js';
import { roadGraph } from '../../src/worlds/medieval/RoadNet.js';
import { standAt } from '../../src/worlds/medieval/Woodland.js';
import { MedievalWorld } from '../../src/worlds/MedievalWorld.js';

const GRAPH = roadGraph();
const slopeAt = (x, z, d = 2.5) => Math.hypot(
  medievalHeight(x + d, z) - medievalHeight(x - d, z),
  medievalHeight(x, z + d) - medievalHeight(x, z - d),
) / (2 * d);

test('there are three camps and they are three different kinds of camp', () => {
  assert.equal(CAMPS.length, 3);
  const kinds = CAMPS.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ['caravan', 'hunters', 'pilgrim']);
  for (const c of CAMPS) {
    assert.ok(c.tents.length >= 3, `${c.id} has ${c.tents.length} shelters`);
    assert.ok(c.fires.length >= 1, `${c.id} has no fire`);
    assert.ok(c.props.length >= 10, `${c.id} has only ${c.props.length} props`);
  }
  /* The vocabularies have to differ or three camps are one camp three times.
   * A caravan has carts and an ox; pilgrims have a wayside cross and staffs;
   * hunters have a pelt rack and a gralloching pole. */
  const kindsOf = (c) => new Set(c.tents.map((t) => t.kind).concat(c.props.map((p) => p.kind)));
  const sets = CAMPS.map(kindsOf);
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const only = [...sets[i]].filter((k) => !sets[j].has(k));
      assert.ok(only.length >= 3,
        `${CAMPS[i].id} and ${CAMPS[j].id} share all but ${only.length} of their props`);
    }
  }
});

test('every camp has a hearth with something cooking on it', () => {
  /* The one thing that makes a fire read as inhabited rather than as a light:
   * something is being cooked. Across the three camps there must be at least
   * one spit and at least one pot, and every fire must have seat logs. */
  let spits = 0;
  let pots = 0;
  for (const c of CAMPS) {
    for (const f of c.fires) {
      assert.equal(f.kind, 'firepit');
      assert.ok(f.r >= 0.8 && f.r <= 1.6, `${c.id}: a ${f.r} m firepit`);
      assert.ok(f.logs >= 3, `${c.id}: nowhere to sit at the fire`);
      if (f.spit) spits++;
      if (f.pot) pots++;
    }
  }
  assert.ok(spits >= 2, `only ${spits} spit roasts across three camps`);
  assert.ok(pots >= 2, `only ${pots} cook pots across three camps`);
  // Bedrolls, firewood and drying laundry - the brief's own list.
  const props = CAMPS.flatMap((c) => c.props.map((p) => p.kind));
  for (const want of ['bedroll', 'woodpile', 'laundry', 'lantern']) {
    assert.ok(props.includes(want), `nothing in any camp is a ${want}`);
  }
  assert.ok(props.filter((k) => k === 'bedroll').length >= 7, 'too few bedrolls to look slept in');
});

test('every camp is on the FAR bank, computed from the channel not the compass', () => {
  for (const c of CAMPS) {
    assert.equal(bankOf(c.x, c.z), 'far', `${c.id} is on the vale's own bank`);
    // Clear of the water by more than the camp's own radius, so no tent is
    // pitched in the flood plain.
    const rd = Math.abs(c.z - riverZ(c.x)) - riverHalfWidth(c.x);
    assert.ok(rd > c.radius, `${c.id} is ${rd.toFixed(1)} m from the channel with a ${c.radius} m camp`);
    assert.ok(medievalHeight(c.x, c.z) > WATER_Y + 1.0, `${c.id} is pitched in the wet`);
  }
});

test('every camp is beside a road - close enough to find, far enough to pass', () => {
  for (const c of CAMPS) {
    const d = GRAPH.distance(c.x, c.z);
    assert.ok(d >= 8, `${c.id} is ${d.toFixed(1)} m from the road centreline - it is IN the road`);
    assert.ok(d <= 22, `${c.id} is ${d.toFixed(1)} m from the nearest road - nobody will find it`);
    assert.ok(GRAPH.connects(34, 18, c.x, c.z, 26),
      `${c.id} is beside a road that goes nowhere`);
  }
});

test('no camp is pitched on a slope you could not sleep on', () => {
  for (const c of CAMPS) {
    let hi = -Infinity;
    let lo = Infinity;
    let worst = 0;
    for (let dz = -9; dz <= 9; dz += 3) {
      for (let dx = -9; dx <= 9; dx += 3) {
        const h = medievalHeight(c.x + dx, c.z + dz);
        if (h > hi) hi = h;
        if (h < lo) lo = h;
        worst = Math.max(worst, slopeAt(c.x + dx, c.z + dz));
      }
    }
    assert.ok(hi - lo < 3.0, `${c.id}'s pitch spans ${(hi - lo).toFixed(2)} m of relief`);
    assert.ok(worst < 0.32, `${c.id} sits on a ${(worst * 100).toFixed(0)}% slope`);
  }
});

test('the hunters camp is at a wood EDGE, not in the middle of a field', () => {
  const h = CAMPS.find((c) => c.kind === 'hunters');
  const s = standAt(h.x, h.z);
  assert.ok(s > 0.12 && s < 0.8, `the hunters camp sits at stand ${s.toFixed(2)}`);
  // ...and closed canopy is within reach of it, or it is not "at a wood".
  let closest = Infinity;
  for (let a = 0; a < 24; a++) {
    for (let r = 5; r <= 70; r += 5) {
      const x = h.x + Math.cos((a / 24) * Math.PI * 2) * r;
      const z = h.z + Math.sin((a / 24) * Math.PI * 2) * r;
      if (standAt(x, z) > 0.9) closest = Math.min(closest, r);
    }
  }
  assert.ok(closest < 60, `the nearest closed canopy is ${closest} m from the hunters camp`);
});

test('nothing inside a camp overlaps anything else inside it', () => {
  /* Every piece is treated as a disc of its own footprint. Crude, and crude is
   * right: the failure being excluded is a bedroll inside a firepit or a cart
   * through a tent, not two crates that touch. */
  /* Structures that are OVERHEAD or open-framed are exempt, and that is not a
   * loophole - it is the point of them. An awning exists to have goods stacked
   * under it, a drying line passes over whatever is beneath it, and a pelt rack
   * is two poles and a bar. Treating them as solid discs would forbid exactly
   * the arrangements that make a camp look worked in. */
  const OVERHEAD = new Set(['awning', 'laundry', 'peltrack', 'gralloch', 'banner', 'tether']);
  const radius = (p) => {
    if (OVERHEAD.has(p.kind)) return 0;
    if (p.kind === 'firepit') return p.r + 0.4;
    if (p.r) return p.r * 0.85;
    if (p.w || p.d) return Math.max(p.w || 0, p.d || 0) * 0.34;
    return 0.7;
  };
  for (const c of CAMPS) {
    const pieces = campPieces(c);
    for (let i = 0; i < pieces.length; i++) {
      for (let j = i + 1; j < pieces.length; j++) {
        const a = pieces[i];
        const b = pieces[j];
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        const need = radius(a) + radius(b);
        assert.ok(d >= need - 0.35,
          `${c.id}: ${a.kind} and ${b.kind} are ${d.toFixed(2)} m apart and need ${need.toFixed(2)}`);
      }
    }
    // ...and everything is inside the camp's declared radius, which is what
    // the beaten earth and the settlement spacing are sized on.
    for (const p of pieces) {
      const d = Math.hypot(p.x - c.x, p.z - c.z);
      assert.ok(d <= c.radius, `${c.id}: a ${p.kind} sits ${d.toFixed(1)} m out, past its ${c.radius} m radius`);
    }
  }
});

test('a camp piece rotates with its camp', () => {
  // `piecePosition` is the only place the camp yaw is applied, so if it is
  // wrong every prop in every camp is mirrored and nothing says so.
  const c = { x: 100, z: 200, yaw: Math.PI / 2 };
  const p = piecePosition(c, { dx: 4, dz: 0 });
  assert.ok(Math.abs(p.x - 100) < 1e-9);
  assert.ok(Math.abs(p.z - 204) < 1e-9);
  const q = piecePosition(c, { dx: 0, dz: 3 });
  assert.ok(Math.abs(q.x - 97) < 1e-9);
  assert.ok(Math.abs(q.z - 200) < 1e-9);
});

test('every camp is registered, so its ground is trodden rather than mown', () => {
  const byId = new Map(SETTLEMENTS.map((s) => [s.id, s]));
  for (const c of CAMPS) {
    const s = byId.get(c.id);
    assert.ok(s, `${c.id} is built but not registered - it will stand in long grass`);
    assert.equal(s.kind, 'camp');
    assert.ok(settledAt(c.x, c.z) > 0.6, `${c.id}'s hearth is on unbroken pasture`);
    // The feather has to reach past the outermost tent peg, and stop.
    const g = campGround(c)[0];
    assert.ok(g.r + g.feather >= c.radius, `${c.id}'s beaten earth stops inside its own camp`);
    assert.equal(settledAt(c.x + c.radius + 24, c.z), 0);
  }
});

test('_buildCamps builds three merged districts, cheaply', async () => {
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  }
  const colliders = [];
  const w = new MedievalWorld({
    physics: {
      addBox: (x, y, z, hx, hy, hz) => ({ x, y, z, hx, hy, hz, rotY: 0, solid: true }),
      addRotatedBox: (p, h, rotY) =>
        ({ x: p.x, y: p.y, z: p.z, hx: h.x, hy: h.y, hz: h.z, rotY, solid: true }),
    },
  });
  w.track = (c) => { colliders.push(c); return c; };
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true });
  w._mats = new Proxy({}, { get: () => mat, has: () => true });
  w._buildCamps();

  let draws = 0;
  let triangles = 0;
  let worstSphere = 0;
  w.group.traverse((o) => {
    if (!o.isMesh) return;
    draws++;
    const g = o.geometry;
    triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
    if (g.boundingSphere) worstSphere = Math.max(worstSphere, g.boundingSphere.radius);
  });
  assert.ok(draws > 0 && draws <= 40, `the camps cost ${draws} draw calls`);
  assert.ok(triangles > 3000 && triangles < 20000, `the camps draw ${Math.round(triangles)} triangles`);
  /* A camp is a small object a long way from anything else, so its district
   * must be small: at a 20 m sphere the frustum rejects it from almost
   * everywhere, which is most of the reason it is affordable at all. */
  assert.ok(worstSphere < 26, `a camp district has a ${worstSphere.toFixed(0)} m bounding sphere`);
  // A fire that does not smoke, glow and light is a picture of a fire.
  assert.equal(w._smokeOrigins.length / 3, CAMPS.length);
  assert.ok(w._glows.length >= CAMPS.length);
  assert.ok(colliders.length >= CAMPS.length * 4, `only ${colliders.length} camp colliders`);
});
