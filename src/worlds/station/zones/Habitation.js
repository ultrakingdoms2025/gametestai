import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { boxGeo, cylGeo, uvScale, instanced } from '../StationKit.js';
import { buildTower } from '../Tower.js';

/**
 * HAB RING C - where the station's crew actually live.
 *
 * ── The two scales, and why there are two ─────────────────────────────────
 * "Crew sleeping apartments and beds that in turn can be explored inside each
 * cabin" is two different buildings pretending to be one. A tower gives you the
 * silhouette and the seven storeys; it cannot give you forty cabins you can
 * walk into, because forty furnished rooms with doors is more geometry than the
 * rest of the zone put together and the player only ever sees three of them.
 *
 * So the zone is built at both scales and each does the thing it is good at:
 *
 *   the court (r < 112)   five hab stacks, 7 to 9 storeys, fully enterable -
 *                         lift, escalators, floor plates, cabins on every level.
 *                         These are the landmark and the vertical play.
 *   the arcade (r > 112)  the cabin terraces: ninety-odd single-storey pods in
 *                         rows under the roof, every one of them open, every one
 *                         with a bunk you can stand next to. These are the
 *                         *density* - a residential district reads as one
 *                         because there are a hundred front doors, not because
 *                         there are five tall buildings.
 *
 * The pods deliberately have no door leaves. A door on each of ninety pods is
 * ninety more colliders, ninety more pivots and ninety more things for the
 * Interiors prompt to fight over, and it buys nothing: an open doorway with a
 * lit interior behind it reads as somewhere you can go, which is the whole
 * point, and a closed one reads as scenery.
 */

/** Storey height of the hab stacks. Matches Tower.js. */
const FLOOR_H = 3.9;

export function buildHabitation(ctx) {
  const { M, rng, spec } = ctx;
  const accent = spec.accent;

  habStacks(ctx);
  cabinTerraces(ctx);
  commons(ctx);
  population(ctx);

  /* Named residents. Two only - the game caps authored friendlies at eight
   * across all five decks and the other three zones need theirs. */
  ctx.npc(-18, 74, {
    name: 'Yara Bess',
    persona:
      'Deck warden for Hab Ring C, which she runs like a ship and describes like a village. She knows whose recycler is broken, whose shift patterns clash and exactly who has been keeping a cat in a supposedly sealed pod, and she will tell you all of it while walking somewhere else.',
    patrol: [[-18, 74], [4, 96], [-40, 62], [-8, 118]],
  });
  ctx.npc(36, 148, {
    name: 'Petr Oyelaran',
    persona:
      'Night-shift welder three weeks off rotation and visibly unsure what to do with daylight hours. Speaks slowly, laughs at the end of his own sentences, and has strong opinions about which of the galley\'s four soups is a lie.',
    patrol: [[36, 148], [52, 132], [22, 160], [44, 118]],
  });
}

/* ------------------------------------------------------------------ */
/* The hab stacks                                                      */
/* ------------------------------------------------------------------ */

function habStacks(ctx) {
  const { world, B, rng, spec } = ctx;
  const accent = spec.accent;

  /* Five stacks on a 78 m ring, rotated to face the court so every entrance is
   * visible from the middle. An even ring rather than a grid because the court
   * is a circle and a grid in a circle wastes the corners - and because five
   * towers at 72 degrees leaves a clean sightline between each pair out to the
   * dome. */
  const RING = 78;
  const stacks = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + Math.PI * 0.2;
    const lx = Math.sin(a) * RING;
    const lz = Math.cos(a) * RING;
    // 7, 8 or 9 storeys. Seven is the floor the brief asks for; the variation
    // is what stops five identical towers reading as a placed asset.
    const floors = 7 + (i % 3);
    const w = 24, d = 22;

    const p = ctx.P(lx, 0, lz);
    // Face the court: the entrance is local -Z, so the tower's yaw points its
    // front at the zone centre.
    const towerYaw = ctx.yawOf(a + Math.PI);

    const { enterable, roofY, footprint } = buildTower(
      world, B, ctx.group,
      {
        x: p.x, z: p.z, yaw: towerYaw,
        w, d, floors,
        label: `Hab Stack ${String.fromCharCode(67 + i)}`,
        accent,
        body: i % 2 ? 'panelWarm' : 'panel',
        fit: 'hab',
      },
      rng
    );
    ctx.enterables.push(enterable);
    // The zones are outside the collision-soup radius so this is belt and
    // braces here - but a footprint that is only registered in one of the two
    // places a tower can be built is the kind of asymmetry that bites later.
    world._selfCollided.push(footprint);
    stacks.push({ lx, lz, a, floors, roofY, w, d });

    ctx.roof(lx, roofY, lz);
    ctx.mmRect(lx, lz, w, d, a + Math.PI, 'rgba(70,120,110,0.6)', 'rgba(140,255,215,0.55)');

    // A practical at the entrance, so the door is legible from across the court.
    const lp = ctx.P(lx - Math.sin(a) * 14, 6, lz - Math.cos(a) * 14);
    const light = new THREE.PointLight(spec.accentHex, 1500, 46, 2);
    light.position.copy(lp);
    light.castShadow = false;
    ctx.group.add(light);
  }

  /* Skybridges between neighbouring stacks.
   *
   * Deck height comes from the SHORTER of the two towers, at a floor plate that
   * still leaves the bridge's own section under that tower's roof slab. The hub
   * has exactly this bug on record - a bridge landing 1.1 m below the short
   * tower's roof, connecting to no floor at all - and the arithmetic here is
   * the fix from that, reused. */
  for (let i = 0; i < 5; i++) {
    const a = stacks[i], b = stacks[(i + 1) % 5];
    const shorter = Math.min(a.floors, b.floors);
    const floor = Math.max(2, shorter - 3);
    const y = floor * FLOOR_H;
    const mx = (a.lx + b.lx) / 2, mz = (a.lz + b.lz) / 2;
    const len = Math.hypot(b.lx - a.lx, b.lz - a.lz) - a.d;
    if (len < 6) continue;
    const bYaw = Math.atan2(b.lx - a.lx, b.lz - a.lz);

    ctx.put('grate', boxGeo(3.4, 0.4, len, 2), mx, y, mz, bYaw);
    ctx.put('panelDark', boxGeo(4.0, 0.7, len, 2), mx, y - 0.55, mz, bYaw);
    ctx.solid(mx, y - 0.2, mz, 1.7, 0.3, len / 2, bYaw);
    for (const s of [-1.75, 1.75]) {
      const ox = Math.cos(bYaw) * s, oz = -Math.sin(bYaw) * s;
      ctx.put('glassWindow', new THREE.PlaneGeometry(len, 2.0), mx + ox, y + 1.2, mz + oz, bYaw + (s > 0 ? -Math.PI / 2 : Math.PI / 2));
      ctx.put('trim', boxGeo(0.14, 0.14, len, 1), mx + ox, y + 2.3, mz + oz, bYaw);
      ctx.put(accent, boxGeo(0.08, 0.08, len, 1), mx + ox, y + 2.4, mz + oz, bYaw);
      ctx.solid(mx + ox, y + 1.2, mz + oz, 0.12, 1.2, len / 2, bYaw);
    }
    ctx.put('trim', boxGeo(4.2, 0.25, len, 2), mx, y + 2.65, mz, bYaw);
    ctx.mmPath([[a.lx, a.lz], [b.lx, b.lz]], 'rgba(140,255,215,0.35)', 3, false);
    // A bridge is the best vantage in the zone, so it is worth something.
    if (i % 2 === 0) ctx.relic(mx, y + 0.7, mz, 'rare');
  }
}

/* ------------------------------------------------------------------ */
/* The cabin terraces                                                  */
/* ------------------------------------------------------------------ */

/**
 * Rows of open crew pods under the arcade roof.
 *
 * Each pod is a three-walled box with a lit interior, a bunk, a locker and a
 * desk. They are laid out in concentric arcs facing a shared access walkway, so
 * standing on the walkway you see a terrace of front doors receding round the
 * curve - which is the read a residential district needs and which five towers
 * cannot give you.
 */
function cabinTerraces(ctx) {
  const { rng, spec } = ctx;
  const accent = spec.accent;

  const POD_W = 5.6, POD_D = 6.4, POD_H = 3.4;
  const T = 0.25;

  // Three arcs. The inner two face outward, the outer faces in, so each pair
  // shares a walkway rather than each row needing its own.
  const ARCS = [
    { r: 126, face: 1, count: 34 },
    { r: 152, face: -1, count: 41 },
    { r: 178, face: 1, count: 48 },
  ];

  const bunkEntries = [];
  const lockerEntries = [];
  let pods = 0;

  for (const arc of ARCS) {
    for (let i = 0; i < arc.count; i++) {
      const a = (i / arc.count) * Math.PI * 2;
      const lx = Math.sin(a) * arc.r;
      const lz = Math.cos(a) * arc.r;
      // Leave the arrival plaza and the link mouth alone.
      if (lz > 140 && Math.abs(lx) < 30) continue;
      if (!ctx.onDeck(lx, lz, 8)) continue;

      // Pod-local yaw: the doorway (local -Z) faces along `face`.
      const yaw = arc.face > 0 ? a + Math.PI : a;
      pods++;

      /* Everything below is authored in the POD's own frame - origin at its
       * centre, doorway on -Z - and `podLocal` does the one transform into zone
       * coordinates. Placing even one part directly with `ctx.box` puts it at
       * the zone centre instead of at the pod, which is a mistake that is
       * invisible until ninety pod walls pile up on the same square metre. */
      podLocal(ctx, lx, lz, yaw, (put, sol) => {
        // Back wall and two flanks. The front is the doorway.
        put('panel', boxGeo(POD_W, POD_H, T, 2), 0, POD_H / 2, POD_D / 2);
        sol(0, POD_H / 2, POD_D / 2, POD_W / 2, POD_H / 2, T / 2);
        for (const s of [-1, 1]) {
          put('panelDark', boxGeo(T, POD_H, POD_D, 2), s * (POD_W / 2), POD_H / 2, 0);
          sol(s * (POD_W / 2), POD_H / 2, 0, T / 2, POD_H / 2, POD_D / 2);
        }
        // Roof and a lit reveal over the door.
        put('panelDark', boxGeo(POD_W + 0.4, 0.3, POD_D + 0.4, 2), 0, POD_H + 0.15, 0);
        sol(0, POD_H + 0.15, 0, (POD_W + 0.4) / 2, 0.15, (POD_D + 0.4) / 2);
        put('panelDark', boxGeo(POD_W, POD_H - 2.4, T, 2), 0, 2.4 + (POD_H - 2.4) / 2, -POD_D / 2);
        sol(0, 2.4 + (POD_H - 2.4) / 2, -POD_D / 2, POD_W / 2, (POD_H - 2.4) / 2, T / 2);
        put(accent, boxGeo(POD_W - 1.4, 0.1, 0.16, 1), 0, 2.5, -POD_D / 2 - 0.16);
        // Floor plate, so the pod reads as a threshold rather than as deck.
        put('grate', boxGeo(POD_W - 0.4, 0.1, POD_D - 0.4, 1.5), 0, 0.06, 0);
        // Bunk, locker, desk, and the light that makes the inside visible from
        // the walkway - an unlit interior behind a doorway reads as a wall.
        put('panelWarm', boxGeo(2.0, 0.42, 0.16, 1), -POD_W / 2 + 1.2, 1.5, 0.4);
        put('emDim', boxGeo(POD_W - 1.6, 0.1, 0.3, 1), 0, POD_H - 0.35, 0.6);
        put('holo', boxGeo(0.8, 0.5, 0.04, 1), POD_W / 2 - 0.9, 1.6, POD_D / 2 - 0.2);
      });

      // Bunk and locker are the two things every pod has, so they are instanced.
      const bp = ctx.P(lx, 0, lz);
      const wy = ctx.yawOf(yaw);
      const off = (ox, oz) => ({
        x: bp.x + ox * Math.cos(wy) + oz * Math.sin(wy),
        z: bp.z - ox * Math.sin(wy) + oz * Math.cos(wy),
      });
      const bunk = off(-POD_W / 2 + 1.1, 0.6);
      bunkEntries.push([bunk.x, 0.35, bunk.z, 0, wy, 0, 1, 1, 1]);
      ctx.world._solidRot(bunk.x, 0.35, bunk.z, 1.0, 0.35, 2.0, wy);
      const locker = off(POD_W / 2 - 0.8, POD_D / 2 - 1.0);
      lockerEntries.push([locker.x, 1.0, locker.z, 0, wy, 0, 1, 1, 1]);
      ctx.world._solidRot(locker.x, 1.0, locker.z, 0.5, 1.0, 0.35, wy);

      ctx.contact(lx, lz, POD_W + 3);
      if (i % 9 === 0) ctx.relic(lx, 0.8, lz, i % 27 === 0 ? 'rare' : 'common');
      if (i % 6 === 0) ctx.roof(lx, POD_H + 0.3, lz);
    }

    // The shared walkway in front of each arc.
    const wr = arc.r - arc.face * (POD_D / 2 + 3.2);
    const ring = new THREE.RingGeometry(wr - 2.6, wr + 2.6, 96, 1);
    uvScale(ring, 30, 1);
    ring.rotateX(Math.PI / 2);
    ctx.put('plazaOnDeck', ring, 0, 0.07, 0);
  }

  if (bunkEntries.length) {
    ctx.group.add(instanced(bunkGeo(), ctx.M.panelWarm, bunkEntries, { cast: true, recv: true }));
    ctx.group.add(instanced(lockerGeo(), ctx.M.panelDark, lockerEntries, { cast: true, recv: true }));
  }

  ctx.mmCircle(0, 0, 178, 'rgba(50,90,80,0.25)', 'rgba(120,220,190,0.35)');
  ctx.sign(28, 9, 2.3, 0, 8.5, 118, 0, { twoSided: true, accent });
  void pods;
}

/** A bunk: base, mattress, pillow and a folded blanket. */
function bunkGeo() {
  const parts = [
    boxGeo(2.0, 0.5, 4.0, 1.5),
    boxGeo(1.86, 0.22, 3.8, 1.5).translate(0, 0.36, 0),
    boxGeo(1.5, 0.16, 0.7, 1).translate(0, 0.55, -1.4),
    boxGeo(1.86, 0.1, 1.2, 1).translate(0, 0.52, 1.1),
  ];
  return mergeGeometries(parts, false);
}

/** A locker: body, door split, handle. */
function lockerGeo() {
  const parts = [
    boxGeo(1.0, 2.0, 0.7, 1.5),
    boxGeo(0.06, 1.8, 0.06, 1).translate(0, 0, -0.36),
    boxGeo(0.28, 0.06, 0.08, 1).translate(0.28, -0.2, -0.38),
  ];
  return mergeGeometries(parts, false);
}

/** Run a callback with `put`/`solid` already offset into a pod's own frame. */
function podLocal(ctx, lx, lz, yaw, fn) {
  const put = (key, geo, px, py, pz, extra = 0) => {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return ctx.put(key, geo, lx + px * c + pz * s, py, lz - px * s + pz * c, yaw + extra);
  };
  const sol = (px, py, pz, hx, hy, hz) => {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return ctx.solid(lx + px * c + pz * s, py, lz - px * s + pz * c, hx, hy, hz, yaw);
  };
  fn(put, sol);
}

/* ------------------------------------------------------------------ */
/* Communal                                                            */
/* ------------------------------------------------------------------ */

function commons(ctx) {
  const { rng, spec } = ctx;
  const accent = spec.accent;

  /* A garden in the middle of the court, under the dome. Planting is the one
   * thing a residential deck in vacuum would actually fight for, and it gives
   * the court a centre that is not another building. */
  const ring = new THREE.CircleGeometry(30, 64);
  ring.rotateX(-Math.PI / 2);
  uvScale(ring, 6, 6);
  ctx.put('plazaOnDeck', ring, 0, 0.11, 0);
  for (let i = 0; i < 22; i++) {
    const a = (i / 22) * Math.PI * 2;
    const rr = 12 + (i % 3) * 7;
    const lx = Math.cos(a) * rr, lz = Math.sin(a) * rr;
    ctx.put('panelDark', cylGeo(2.2, 2.5, 1.1, 12, 3), lx, 0.55, lz);
    ctx.solid(lx, 0.55, lz, 2.3, 0.55, 2.3);
    ctx.put('foliage', new THREE.SphereGeometry(1.9 + rng() * 0.6, 10, 8), lx, 2.0, lz);
    if (i % 4 === 0) {
      ctx.put('trim', cylGeo(0.12, 0.12, 4.2, 6, 2), lx + 3.0, 2.1, lz);
      ctx.put('emWhite', cylGeo(0.34, 0.34, 0.3, 8, 1), lx + 3.0, 4.3, lz);
    }
  }
  // Benches round the garden, which is where the seated actors go.
  const benches = [];
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + 0.2;
    const lx = Math.cos(a) * 34, lz = Math.sin(a) * 34;
    ctx.put('panelWarm', boxGeo(3.2, 0.4, 0.9, 2), lx, 0.48, lz, -a);
    ctx.put('trimDark', boxGeo(3.2, 0.7, 0.16, 1), lx, 0.9, lz - 0.0, -a);
    ctx.solid(lx, 0.34, lz, 1.6, 0.34, 0.45, -a);
    ctx.contact(lx, lz, 5);
    benches.push({ lx, lz, a });
  }
  ctx._benches = benches;

  /* The laundry and the rec lounge, under the arcade either side of the
   * entrance - the two rooms a residential deck needs that a pod does not
   * have space for. */
  for (const [side, label] of [[-1, 'laundry'], [1, 'lounge']]) {
    const lx = side * 58, lz = 132;
    const W = 22, D = 16, H = 5.2;
    ctx.box('panel', W, H, 0.3, lx, H / 2, lz + D / 2);
    ctx.solid(lx, H / 2, lz + D / 2, W / 2, H / 2, 0.15);
    for (const s of [-1, 1]) {
      ctx.box('panelDark', 0.3, H, D, lx + s * (W / 2), H / 2, lz);
      ctx.solid(lx + s * (W / 2), H / 2, lz, 0.15, H / 2, D / 2);
    }
    ctx.box('panelDark', W + 0.6, 0.4, D + 0.6, lx, H + 0.2, lz);
    ctx.solid(lx, H + 0.2, lz, (W + 0.6) / 2, 0.2, (D + 0.6) / 2);
    // Front wall with a wide opening.
    for (const s of [-1, 1]) {
      ctx.box('panel', 6, H, 0.3, lx + s * 8, H / 2, lz - D / 2);
      ctx.solid(lx + s * 8, H / 2, lz - D / 2, 3, H / 2, 0.15);
    }
    ctx.box('panel', 10, H - 3.2, 0.3, lx, 3.2 + (H - 3.2) / 2, lz - D / 2);
    ctx.solid(lx, 3.2 + (H - 3.2) / 2, lz - D / 2, 5, (H - 3.2) / 2, 0.15);
    ctx.put(accent, boxGeo(9, 0.14, 0.2, 1), lx, 3.3, lz - D / 2 - 0.2);
    ctx.put('grate', boxGeo(W - 0.8, 0.1, D - 0.8, 2), lx, 0.06, lz);

    if (label === 'laundry') {
      for (let i = 0; i < 8; i++) {
        const dx = -8 + (i % 4) * 5.2, dz = i < 4 ? 5 : -1;
        ctx.put('shell', boxGeo(2.2, 2.0, 1.8, 1.5), lx + dx, 1.0, lz + dz);
        ctx.put('glassWindow', new THREE.PlaneGeometry(1.1, 1.1), lx + dx, 1.3, lz + dz - 0.92, Math.PI);
        ctx.solid(lx + dx, 1.0, lz + dz, 1.1, 1.0, 0.9);
      }
      ctx.relic(lx - 9.5, 2.3, lz + 6.5, 'rare');
    } else {
      for (let i = 0; i < 5; i++) {
        const dx = -8 + i * 4;
        ctx.put('panelWarm', boxGeo(3.0, 0.45, 1.6, 1.5), lx + dx, 0.5, lz + 4);
        ctx.put('trimDark', boxGeo(3.0, 0.8, 0.2, 1), lx + dx, 1.0, lz + 4.8);
        ctx.solid(lx + dx, 0.4, lz + 4, 1.5, 0.4, 0.8);
      }
      ctx.put('holo', boxGeo(7, 3.4, 0.06, 1), lx, 2.6, lz + D / 2 - 0.4);
      ctx.relic(lx + 9.2, 0.8, lz + 6.2, 'common');
    }
    ctx.mmRect(lx, lz, W, D, 0, 'rgba(80,120,110,0.5)', 'rgba(150,240,210,0.45)');
    ctx.contact(lx, lz, Math.max(W, D) + 4);
  }
}

/* ------------------------------------------------------------------ */
/* Population                                                          */
/* ------------------------------------------------------------------ */

function population(ctx) {
  const { rng } = ctx;
  let n = 0;
  const add = (lx, ly, lz, o) => {
    if (!ctx.onDeck(lx, lz, 3)) return;
    ctx.actor(lx, ly, lz, { phase: rng() * 6.283, ...o });
    n++;
  };

  // Residents on the garden benches - talking in pairs, which is what a bench
  // outside a block of flats is for.
  for (const b of ctx._benches ?? []) {
    const seats = 1 + Math.floor(rng() * 2);
    for (let i = 0; i < seats; i++) {
      const off = (i - (seats - 1) / 2) * 1.1;
      add(
        b.lx + Math.cos(-b.a) * off, 0, b.lz - Math.sin(-b.a) * off,
        { activity: rng() > 0.45 ? 'talk' : 'sit', amount: 0.68, localYaw: -b.a + Math.PI / 2 }
      );
    }
  }

  // People standing in their own doorways and on the walkways. Spread over the
  // three terrace arcs so the density falls off outward the way it should.
  for (const [r, count] of [[126, 22], [152, 26], [178, 28]]) {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + rng() * 0.1;
      const rr = r - 4.6 + rng() * 9;
      const lx = Math.sin(a) * rr, lz = Math.cos(a) * rr;
      if (lz > 140 && Math.abs(lx) < 32) continue;
      const roll = rng();
      add(lx, 0, lz, {
        activity: roll < 0.34 ? 'stand' : roll < 0.6 ? 'talk' : roll < 0.82 ? 'walk' : 'carry',
        localYaw: a + (rng() - 0.5),
        speed: 0.8 + rng() * 0.5,
      });
    }
  }

  // Crossing the court, and a few on the skybridge decks.
  for (let i = 0; i < 26; i++) {
    const a = rng() * Math.PI * 2;
    const rr = 36 + rng() * 66;
    add(Math.sin(a) * rr, 0, Math.cos(a) * rr, {
      activity: rng() > 0.3 ? 'walk' : 'talk',
      localYaw: rng() * Math.PI * 2,
      speed: 0.9 + rng() * 0.4,
    });
  }

  void n;
}
