import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as THREE from 'three';

import { CONFIG } from '../../src/core/Config.js';
import { medievalHeight, MARKET } from '../../src/worlds/terrain/MedievalHeight.js';
import {
  MedievalWorld, MARKET_STALLS, KEEPER_STANDOFF, SMITHY, FORGE_COUNTER,
} from '../../src/worlds/MedievalWorld.js';
import { allows, DEFAULT_RULES } from '../../src/worlds/WorldRules.js';
import { Marketplace } from '../../src/systems/Marketplace.js';
import { offlineCatalog, OFFLINE_BASE_ITEMS } from '../../src/systems/MarketplaceOffline.js';
import { ROLE, ROLE_DEFS } from '../../src/npc/NPCRoles.js';

/**
 * ALDERMOOR'S COUNTERS.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS ACTUALLY WRONG
 *
 * Not "the medieval world has no merchants" - it has twenty-four, planned from
 * `medieval/Settlements.js` and streamed by `MedievalResidency`. What it had
 * was a hole in the STOCK and a hole in the SQUARE, and they share a cause.
 *
 * Aldermoor's trade character resolves to `rural`, whose table is
 * `['health', 'tools']`, so every counter a player could reach without leaving
 * the starting village sold the same two of the six categories the catalogue
 * stocks here. `weapons`, `spells`, `mounts` and `cosmetic` were 190 m, 300 m,
 * 370 m and 420 m from the sky-gate respectively - 33 of the world's 48 rows.
 *
 * They were not strictly unbuyable, and the way they were buyable is the worse
 * half of it: `Marketplace._isVendor` falls back to matching `VENDOR_WORDS`
 * against a persona, so the blacksmith, his apprentice and the old man who
 * knows "the price of everything on every stall" all read as traders - each
 * one an UNRESTRICTED shop, because a word match authors no
 * `vendorCategories`, whose picker offered `ships`, a category with no rows in
 * this world at all. Stock reachable through people who are not merchants is
 * this repo's signature defect wearing a disguise.
 *
 * And the square could never have fixed itself. `planSettlement` places its
 * cast through `world._isOpenGround`, which returns false inside the market
 * rect plus two metres - so the population planner is structurally incapable
 * of standing anybody behind Aldermoor's nine trestles. Hand-authored spawns
 * are the only mechanism there is.
 *
 * ---------------------------------------------------------------------------
 * THE ONE THAT MATTERS
 *
 * `DEFAULT_RULES.merchants` is true and the medieval world declares no
 * override, so the world is CONFIGURED to trade. `merchants: true` with an
 * unreachable category is the state this file exists to make impossible to
 * return to: not "three vendors exist" (a thing that was BUILT) but "every
 * category with stock in this world is carried by a counter a player walking
 * out of the sky-gate can reach and open" (a thing a player can DO).
 *
 * So the load-bearing tests here are the last two: the coverage gate, and the
 * flood fill from the player's own spawn pin.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

/* ------------------------------------------------------------------ */
/* The world, built once                                               */
/* ------------------------------------------------------------------ */

/* `_breathe` hands the frame back to the browser between buildings. Under Node
 * there is no frame; a timeout is the same shape and keeps the yield points
 * honest rather than stubbing them out. */
if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
}

let BUILT = null;

/**
 * The whole vale, headless.
 *
 * Physics, materials and textures are stubbed and nothing else is - no step is
 * skipped. It has to be the WHOLE build: `_buildInhabitants` runs last and the
 * colliders every reachability claim below is measured against are pushed by
 * seventeen builders before it. A test that planned from a stand-in world
 * would certify a placement the game never builds, which is the mistake
 * `medieval-wildlife.test.mjs` records at length.
 */
async function world() {
  if (BUILT) return BUILT;
  const colliders = [];
  const w = new MedievalWorld({
    physics: {
      addBox: (x, y, z, hx, hy, hz) => ({ x, y, z, hx, hy, hz, rotY: 0, solid: true }),
      addRotatedBox: (p, h, rotY) =>
        ({ x: p.x, y: p.y, z: p.z, hx: h.x, hy: h.y, hz: h.z, rotY, solid: true }),
    },
  });
  w.track = (c) => { colliders.push(c); return c; };
  w.testColliders = colliders;
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true });
  w._mats = new Proxy({}, { get: () => mat, has: () => true });
  const tex = { map: null, normalMap: null, roughnessMap: null };
  w._tex = new Proxy({}, { get: () => tex, has: () => true });
  await w._buildRoadPaths();
  await w._buildRoads();
  await w._buildCastle();
  await w._buildVillage();
  await w._buildRiverside();
  await w._buildMarket();
  await w._buildTowns();
  await w._buildCamps();
  await w._buildLandmarks();
  await w._buildGateAndSpawns();
  BUILT = w;
  return w;
}

/** The world's authored counters, in `npcSpawns` order. */
async function vendors() {
  const w = await world();
  return (w.npcSpawns ?? []).filter((s) => s.role === 'vendor');
}

/* ------------------------------------------------------------------ */
/* Surface probes - the same shape `medieval-approach` uses            */
/* ------------------------------------------------------------------ */

const STEP = CONFIG.player.stepHeight;

/** True when (x, z) is inside a collider's footprint, honouring its Y rotation. */
function overlaps(c, x, z) {
  const dx = x - c.x;
  const dz = z - c.z;
  const co = Math.cos(c.rotY || 0);
  const si = Math.sin(c.rotY || 0);
  return Math.abs(dx * co - dz * si) <= c.hx && Math.abs(dx * si + dz * co) <= c.hz;
}

/**
 * The surface a walker standing at `fromY` would find at (x, z): terrain, or
 * the top of the highest collider over it whose UNDERSIDE is within a step of
 * where the walker already is. Without that clause a jetty reports its own
 * deck as the ground under it, because the deck really is above and really is
 * solid; you walk under it.
 */
function surfaceAt(near, x, z, fromY) {
  let y = medievalHeight(x, z);
  const head = fromY + STEP;
  for (let i = 0; i < near.length; i++) {
    const c = near[i];
    if (!overlaps(c, x, z)) continue;
    if (c.y - c.hy > head) continue;
    const top = c.y + c.hy;
    if (top > y) y = top;
  }
  return y;
}

/** A standing body occupies [surface, surface + 1.7]. Anything in that is a wall. */
function headroom(near, x, z, surface) {
  for (let i = 0; i < near.length; i++) {
    const c = near[i];
    if (!overlaps(c, x, z)) continue;
    if (c.y + c.hy > surface + 0.05 && c.y - c.hy < surface + 1.7) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Categories                                                          */
/* ------------------------------------------------------------------ */

/**
 * `ALL_CATEGORIES` is module-private to `Marketplace.js` and is the list that
 * actually gates a vendor's stock - `_readVendorCategories` silently DROPS any
 * name that is not in it, so a typo narrows nothing instead of emptying a shop
 * and would otherwise be invisible from out here. Scraped rather than
 * exported, the same call `citadel-economy.test.mjs` makes on `CACHE_TABLES`.
 */
function marketplaceCategories() {
  const src = read('src/systems/Marketplace.js');
  const m = /const ALL_CATEGORIES = \[([^\]]*)\]/.exec(src);
  assert.ok(m, 'ALL_CATEGORIES moved - this scrape is stale');
  return [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
}

/** Categories with at least one row on sale in a given world. */
function stockedCategories(worldId) {
  const seen = new Set();
  for (const row of offlineCatalog(worldId)) seen.add(String(row.category));
  return seen;
}

/* ------------------------------------------------------------------ */
/* 1. The vale has exactly three authored counters                     */
/* ------------------------------------------------------------------ */

test('Aldermoor authors exactly three counters, and every one is a real vendor spec', async () => {
  const v = await vendors();
  assert.equal(v.length, 3, `expected three authored counters, found ${v.length}`);
  for (const s of v) {
    assert.equal(s.type, 'friendly', `${s.name} is not friendly`);
    assert.equal(s.role, ROLE.VENDOR, `${s.name} does not carry the vendor role`);
    assert.ok(s.name && s.name.trim().length, 'a counter has no name');
    assert.ok(s.persona && s.persona.length > 80,
      `${s.name} has no persona worth speaking from`);
    assert.ok(s.vendorTitle, `${s.name} has no stall title`);
    assert.ok(Array.isArray(s.vendorCategories) && s.vendorCategories.length,
      `${s.name} sells nothing in particular`);
    assert.ok(Array.isArray(s.signLines) && s.signLines.length === 2,
      `${s.name} has no lettered board`);
    assert.equal(s.anchored, true, `${s.name} is not anchored to a counter`);
    assert.ok(Number.isFinite(s.yaw), `${s.name} has no facing`);
    /* A vendor holds a post - `ROLE_DEFS[vendor].stationary` - so a patrol on
     * one is a route that will never be walked and a lie in the world file. */
    assert.equal(s.patrol, undefined, `${s.name} carries a patrol a vendor can never walk`);
  }
  assert.equal(ROLE_DEFS[ROLE.VENDOR].stationary, true,
    'the vendor role stopped being stationary; these three now wander off their counters');
});

/* ------------------------------------------------------------------ */
/* 2. Where they stand is derived from the furniture, not guessed      */
/* ------------------------------------------------------------------ */

test('each counter stands behind a stall the market actually built, facing out', async () => {
  const w = await world();
  const v = await vendors();

  /* The built stalls, found by their own footprint signature rather than by
   * the table: `stall()` pushes `{ x, z, hx: W/2 + 0.6, hz: D/2 + 0.9, r }`
   * for W 3.6 and D 2.4. Reading them off the BUILT world is what makes this
   * a gate on the world the game ships rather than on a constant. */
  const built = w._footprints.filter((f) =>
    Math.abs(f.hx - 2.4) < 1e-6 && Math.abs(f.hz - 2.1) < 1e-6);
  assert.equal(built.length, MARKET_STALLS.length,
    `the market built ${built.length} trestles for a table of ${MARKET_STALLS.length}`);
  for (const [sx, sz, ry] of MARKET_STALLS) {
    assert.ok(built.some((f) => Math.abs(f.x - sx) < 1e-6
      && Math.abs(f.z - sz) < 1e-6 && Math.abs(f.r - ry) < 1e-6),
    `no built trestle at (${sx}, ${sz}) - MARKET_STALLS and _buildMarket have drifted`);
  }

  const atStall = v.filter((s) => s.name !== 'Bram Tallow');
  assert.equal(atStall.length, 2, 'the two trestle counters moved');
  for (const s of atStall) {
    const hit = built.find((f) => {
      const kx = f.x - Math.sin(f.r) * KEEPER_STANDOFF;
      const kz = f.z - Math.cos(f.r) * KEEPER_STANDOFF;
      return Math.hypot(s.position.x - kx, s.position.z - kz) < 1e-6;
    });
    assert.ok(hit, `${s.name} does not stand ${KEEPER_STANDOFF} m behind any built trestle`);
    /* Facing local +Z, which is the customer's side and the side that looks
     * into the square on all nine. Characters face -Z at yaw 0. */
    const fx = -Math.sin(s.yaw);
    const fz = -Math.cos(s.yaw);
    assert.ok(Math.abs(fx - Math.sin(hit.r)) < 1e-6 && Math.abs(fz - Math.cos(hit.r)) < 1e-6,
      `${s.name} has her back to her own customers`);
    /* And the board she stands behind is a board, not a buried one. `stall()`
     * pins every trestle at MARKET.y while the square's ground runs 4.61 to
     * 6.35, so the west end of the south row is sunk into the hill - at
     * (21, 8) the board top is 19 cm BELOW the ground beside it. */
    const board = MARKET.y + 1.0;
    const ground = medievalHeight(s.position.x, s.position.z);
    assert.ok(board - ground > 0.6,
      `${s.name}'s board stands ${(board - ground).toFixed(2)} m over her own feet, `
      + 'which is not a counter');
  }

  const smith = v.find((s) => s.name === 'Bram Tallow');
  assert.ok(smith, 'the forge counter lost its smith');
  assert.ok(Math.hypot(smith.position.x - FORGE_COUNTER.x, smith.position.z - FORGE_COUNTER.z) < 1e-6,
    'the smith is not on the forge counter');
  /* The forge itself, off the built collider set: `_buildMarket` adds a
   * 3.6 x 3.0 block at `SMITHY`. If it moves, so must he. */
  assert.ok(w.testColliders.some((c) => Math.abs(c.x - SMITHY.x) < 1e-6
    && Math.abs(c.z - SMITHY.z) < 1e-6 && Math.abs(c.hx - 1.8) < 1e-6),
  'the smithy forge block moved; FORGE_COUNTER is now an offset from nothing');
});

test('the three positions are finite, distinct and far enough apart to be three shops', async () => {
  const v = await vendors();
  for (const s of v) {
    for (const k of ['x', 'y', 'z']) {
      assert.ok(Number.isFinite(s.position[k]), `${s.name} has a non-finite ${k}`);
    }
    assert.ok(Math.abs(s.position.y - medievalHeight(s.position.x, s.position.z)) < 1e-6,
      `${s.name} is not standing on the vale's own ground`);
  }
  for (let i = 0; i < v.length; i++) {
    for (let j = i + 1; j < v.length; j++) {
      const d = Math.hypot(v[i].position.x - v[j].position.x, v[i].position.z - v[j].position.z);
      /* `planSettlement` keeps its own cast 3.2 m apart and `NPCManager`'s
       * separation sweep skips anchored characters, so two counters closer
       * than that would interpenetrate and `Marketplace._findVendor` - which
       * takes the NEAREST in range - would make one of them unopenable. */
      assert.ok(d > 3.2,
        `${v[i].name} and ${v[j].name} are ${d.toFixed(2)} m apart`);
    }
  }
  const titles = new Set(v.map((s) => s.vendorTitle));
  assert.equal(titles.size, v.length, 'two counters share a title');
  const boards = new Set(v.map((s) => s.signLines.join('|')));
  assert.equal(boards.size, v.length, 'two counters are lettered the same');
});

/* ------------------------------------------------------------------ */
/* 3. What they sell                                                   */
/* ------------------------------------------------------------------ */

test('between them the three counters carry every category with stock in the vale', async () => {
  const v = await vendors();
  const carried = new Set(v.flatMap((s) => s.vendorCategories));
  const stocked = stockedCategories('medieval');
  for (const cat of stocked) {
    assert.ok(carried.has(cat),
      `nothing in Aldermoor sells '${cat}', and the vale stocks `
      + `${offlineCatalog('medieval').filter((r) => r.category === cat).length} rows of it`);
  }
  assert.equal(carried.size, stocked.size,
    `the counters carry [${[...carried].sort()}] against a stocked [${[...stocked].sort()}]`);
  assert.equal(carried.size, 6, 'the vale stopped stocking six categories');
});

test('no counter carries a category whose rows are allowlisted to another world', async () => {
  const v = await vendors();
  const stocked = stockedCategories('medieval');
  for (const s of v) {
    for (const cat of s.vendorCategories) {
      assert.ok(stocked.has(cat),
        `${s.name} advertises '${cat}', which has no rows in this world - `
        + 'the panel would open on an empty category');
    }
  }
  /* The sharp end of it. Every `ships` row carries `worlds: ['dock']`, so a
   * medieval counter that named `ships` would be advertising twelve rows that
   * `buildMarketplaceSeedItems` never seeds here. Asserted against the
   * allowlists themselves rather than against the word 'ships', so a category
   * that becomes dock-only tomorrow fails here too. */
  const elsewhere = new Set();
  for (const row of OFFLINE_BASE_ITEMS) {
    if (row.worlds && !row.worlds.includes('medieval')) elsewhere.add(row.category);
  }
  for (const s of v) {
    for (const cat of s.vendorCategories) {
      if (!elsewhere.has(cat)) continue;
      const here = offlineCatalog('medieval').filter((r) => r.category === cat).length;
      assert.ok(here > 0,
        `${s.name} carries '${cat}', every row of which is allowlisted away from medieval`);
    }
  }
  assert.ok(elsewhere.has('ships'), 'ships stopped being world-restricted; this gate is stale');
});

test('every category a counter names is one the Marketplace will actually honour', async () => {
  const v = await vendors();
  const known = marketplaceCategories();
  const shop = new Marketplace({ ui: false });
  for (const s of v) {
    for (const cat of s.vendorCategories) {
      assert.ok(known.includes(cat),
        `${s.name} names '${cat}', which Marketplace._readVendorCategories drops on the floor`);
    }
    /* Driven through the real reader rather than re-implemented: it lower-cases,
     * de-duplicates and drops unknowns, and a list that came out EMPTY would
     * silently mean "general trader" - the whole catalogue at a herb stall. */
    const resolved = shop._readVendorCategories(s);
    assert.deepEqual(resolved, s.vendorCategories,
      `${s.name}'s stock list does not survive _readVendorCategories`);
  }
  shop.dispose?.();
});

/* ------------------------------------------------------------------ */
/* 4. THE ONE THAT MATTERS                                             */
/* ------------------------------------------------------------------ */

test('the vale is never left configured to trade with nobody behind its counters', async () => {
  const w = await world();
  /* The world declares no rules override, so this reads DEFAULT_RULES. Both
   * halves are asserted: turning merchants off would be a decision, and this
   * gate must fail rather than pass vacuously if somebody makes it. */
  assert.equal(DEFAULT_RULES.merchants, true, 'the default changed');
  assert.equal(allows(w, 'merchants'), true,
    'the medieval world stopped allowing merchants; if that is deliberate, the '
    + 'three counters below are dead weight and this file should go with them');

  const v = await vendors();
  assert.ok(v.length > 0,
    'merchants: true with zero authored vendors - the exact state this file exists to forbid');

  /* And the stronger form, which is the one that actually failed before: not
   * "somebody trades here" but "everything on sale here can be bought here".
   * `Marketplace.refreshCatalog` filters the open window by the standing
   * vendor's `vendorCategories`, so a category no counter names is a category
   * no NPC alive can show you however much stock the API returns. */
  const carried = new Set(v.flatMap((s) => s.vendorCategories));
  const unreachable = [...stockedCategories('medieval')].filter((c) => !carried.has(c));
  assert.deepEqual(unreachable, [],
    `${unreachable.length} categories are stocked in the vale and sold by nobody in it`);
});

/* ------------------------------------------------------------------ */
/* 5. ...and a player can walk to all three and open them              */
/* ------------------------------------------------------------------ */

/**
 * `VENDOR_RANGE`, off `Marketplace.js`, because that is the number that decides
 * whether standing next to a merchant opens anything. Quoted from the source
 * rather than copied, so retuning it retunes this gate.
 */
function vendorRange() {
  const m = /const VENDOR_RANGE = ([\d.]+);/.exec(read('src/systems/Marketplace.js'));
  assert.ok(m, 'VENDOR_RANGE moved - this scrape is stale');
  return Number(m[1]);
}

test('a player who walks out of the sky-gate can reach and open all three', async () => {
  const w = await world();
  const v = await vendors();
  const RANGE = vendorRange();

  /* A flood fill, not a straight line. A straight line from the spawn pin to
   * the market crosses three houses and reports a 4 m step, which says nothing
   * about whether the walk exists - and "the thing was built but nobody can
   * reach it" is precisely the defect this repo keeps shipping. So: every cell
   * a walker can actually get to from the player's own spawn, under the
   * player's own step height, refusing anything it would be standing inside. */
  const X0 = -10; const X1 = 70; const Z0 = -40; const Z1 = 50; const CELL = 0.5;
  const near = w.testColliders.filter((c) => {
    const r = Math.max(c.hx, c.hz) + 1;
    return c.x + r > X0 && c.x - r < X1 && c.z + r > Z0 && c.z - r < Z1;
  });
  const NX = Math.round((X1 - X0) / CELL);
  const NZ = Math.round((Z1 - Z0) / CELL);
  const seen = new Uint8Array(NX * NZ);
  const surf = new Float32Array(NX * NZ);
  const sp = w.playerSpawn;
  assert.ok(sp && Number.isFinite(sp.x), 'the world publishes no player spawn');
  const start = Math.round((sp.x - X0) / CELL) * NZ + Math.round((sp.z - Z0) / CELL);
  seen[start] = 1;
  surf[start] = surfaceAt(near, sp.x, sp.z, medievalHeight(sp.x, sp.z));
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const k = queue[head];
    const i = (k / NZ) | 0;
    const j = k % NZ;
    const cy = surf[k];
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= NX || nj >= NZ) continue;
      const nk = ni * NZ + nj;
      if (seen[nk]) continue;
      const x = X0 + ni * CELL;
      const z = Z0 + nj * CELL;
      const s = surfaceAt(near, x, z, cy);
      if (s - cy > STEP) continue;        // a riser the player cannot climb
      if (cy - s > 3.0) continue;         // a drop the player would not take
      if (!headroom(near, x, z, s)) continue;
      seen[nk] = 1;
      surf[nk] = s;
      queue.push(nk);
    }
  }
  assert.ok(queue.length > 5000,
    `the flood fill only reached ${queue.length} cells; the probe is broken, not the world`);

  for (const s of v) {
    let best = Infinity;
    for (let i = 0; i < NX; i++) {
      for (let j = 0; j < NZ; j++) {
        if (!seen[i * NZ + j]) continue;
        const d = Math.hypot(X0 + i * CELL - s.position.x, Z0 + j * CELL - s.position.z);
        if (d < best) best = d;
      }
    }
    assert.ok(best <= RANGE,
      `${s.name} at (${s.position.x.toFixed(2)}, ${s.position.z.toFixed(2)}): the nearest `
      + `standing spot a player can walk to from the spawn is ${best.toFixed(2)} m away, and `
      + `Marketplace only opens within ${RANGE} m`);
  }
});

test('nobody is standing inside geometry or on top of a prop', async () => {
  const w = await world();
  const v = await vendors();
  const near = w.testColliders;
  for (const s of v) {
    const g = medievalHeight(s.position.x, s.position.z);
    const surface = surfaceAt(near, s.position.x, s.position.z, g);
    assert.ok(surface - g < 1e-6,
      `${s.name} is standing ${(surface - g).toFixed(2)} m up on something, not on the ground`);
    assert.ok(headroom(near, s.position.x, s.position.z, g),
      `${s.name} is inside a collider`);
    /* The market square is paved and level enough to stand a stall on. A
     * counter on a slope reads as a counter sliding downhill. */
    let worst = 0;
    for (const [dx, dz] of [[0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6]]) {
      worst = Math.max(worst, Math.abs(medievalHeight(s.position.x + dx, s.position.z + dz) - g));
    }
    assert.ok(worst < 0.2,
      `the ground under ${s.name} falls ${worst.toFixed(2)} m within a stride`);
  }
});

/* ------------------------------------------------------------------ */
/* 6. ...and the counter is the shop that opens, not a passing villager */
/* ------------------------------------------------------------------ */

/**
 * A stand-in crowd for `Marketplace._findVendor`, which reads only
 * `position`, `isDead`, `name`, `persona`, `role` and `vendorCategories`.
 */
function crowd(...rows) {
  return {
    friendlies: rows.map((r) => ({
      name: r.name, persona: r.persona ?? '', role: r.role ?? undefined,
      vendorCategories: r.cats ?? undefined, isDead: false,
      position: { x: r.x, z: r.z, y: 0, distanceToSquared: (p) => (r.x - p.x) ** 2 + (r.z - p.z) ** 2 },
    })),
  };
}

test('an authored counter outranks a passer-by whose persona merely sounds like trade', async () => {
  const w = await world();
  const smith = w.npcSpawns.find((s) => s.name === 'Bram Tallow');
  const boy = w.npcSpawns.find((s) => s.name === 'Rook Danby');
  assert.ok(smith && boy, 'the smithy lost one of its two');

  /* MEASURED IN THE GAME, not invented. `VENDOR_WORDS` in `Marketplace.js`
   * matches `smith`, and Rook Danby's persona is "Bram Tallow's apprentice at
   * the smithy" - so a seventeen-year-old with no stock list read as a trader,
   * stood 5.4 m from the Forge & Armoury counter, and nearest-wins opened HIM.
   * Driving the real game: the panel said "Rook Danby", offered all 48 rows
   * because a word match authors no restriction, and its category picker
   * included `ships`, which has no rows in this world at all. The counter
   * behind him could not be opened from the anvil. */
  const shop = new Marketplace({ ui: false });
  shop.npcManager = crowd(
    { name: boy.name, persona: boy.persona, x: boy.position.x, z: boy.position.z },
    { name: smith.name, persona: smith.persona, role: 'vendor',
      cats: smith.vendorCategories, x: smith.position.x, z: smith.position.z },
  );
  assert.ok(shop._isVendor(shop.npcManager.friendlies[0]),
    'Rook stopped word-matching; this gate no longer reproduces what it was written for');
  assert.equal(shop._isAuthoredVendor(shop.npcManager.friendlies[0]), false,
    'a word match must not read as an authored counter');

  /* EVERYWHERE, not one lucky spot. The live run stood at (47.6, 19.2) - the
   * capsule solver slides a player off the forge block, so where a customer
   * ACTUALLY ends up is not a coordinate a test can name - so the claim under
   * test is the general one: anywhere around the smithy where both are within
   * `VENDOR_RANGE`, the counter is what opens. `contested` counts the spots
   * where the apprentice is strictly nearer, because a run in which he never
   * was would pass this vacuously. */
  const RANGE = vendorRange();
  let contested = 0;
  let both = 0;
  for (let x = SMITHY.x - 8; x <= SMITHY.x + 8; x += 0.5) {
    for (let z = SMITHY.z - 8; z <= SMITHY.z + 8; z += 0.5) {
      const dBoy = Math.hypot(boy.position.x - x, boy.position.z - z);
      const dSmith = Math.hypot(smith.position.x - x, smith.position.z - z);
      if (dBoy > RANGE || dSmith > RANGE) continue;
      both++;
      if (dBoy < dSmith) contested++;
      shop.player = { position: { x, y: 0, z } };
      assert.equal(shop._findVendor()?.name, smith.name,
        `at (${x.toFixed(1)}, ${z.toFixed(1)}) a word match opened in front of the counter`);
    }
  }
  assert.ok(both > 100, `only ${both} spots can see both; the two have moved apart`);
  assert.ok(contested > 20,
    `the apprentice was nearer at only ${contested} of ${both} spots; this gate has stopped `
    + 'testing the tie-break it was written for');

  /* And the bound is still the bound: rank orders only characters the player
   * could already have opened. An authored counter out of range must not be
   * dragged in over a word match that is standing right there. */
  const far = new Marketplace({ ui: false });
  far.npcManager = crowd(
    { name: 'Goodman Alder', persona: 'tells a stranger the price of everything on every stall', x: 1, z: 0 },
    { name: 'Bram Tallow', role: 'vendor', cats: ['weapons'], x: 40, z: 0 },
  );
  far.player = { position: { x: 0, y: 0, z: 0 } };
  assert.equal(far._findVendor()?.name, 'Goodman Alder',
    'an out-of-range counter was opened from 40 m away');
  shop.dispose?.();
  far.dispose?.();
});

test('two authored counters in range still resolve by distance', () => {
  const shop = new Marketplace({ ui: false });
  shop.npcManager = crowd(
    { name: 'Near', role: 'vendor', cats: ['health'], x: 2, z: 0 },
    { name: 'Far', role: 'vendor', cats: ['tools'], x: 5, z: 0 },
  );
  shop.player = { position: { x: 0, y: 0, z: 0 } };
  assert.equal(shop._findVendor()?.name, 'Near', 'rank swallowed the distance test');
  /* ...and the order the crowd happens to be in must not decide it, which is
   * the bug a rank-first loop invites: the FIRST authored counter found used
   * to win outright. */
  shop.npcManager.friendlies.reverse();
  assert.equal(shop._findVendor()?.name, 'Near', 'the answer depends on crowd order');
  shop.dispose?.();
});

/* ------------------------------------------------------------------ */
/* 7. The counters cost the planner one watchman, not its reeve        */
/* ------------------------------------------------------------------ */

test('hand-authoring three counters does not empty Aldermoor', async () => {
  const w = await world();
  const summary = w.populationSummary;
  assert.ok(summary, 'the world published no population summary');
  const ald = summary.settlements.find((s) => s.id === 'aldermoor');
  assert.ok(ald, 'Aldermoor fell out of the settlement plan');
  /* `planSettlement` subtracts hand-authored civilians from the quota and
   * truncates from the BACK of `roleOrder`, which is
   * [vendors..., quest_manager, lorekeeper, guards..., people...]. So each
   * counter added costs the village its LAST planned role, and the number of
   * them is the difference between "one fewer watchman" and "no reeve".
   *
   * Two of the three counters are people Aldermoor already had - Bram Tallow
   * the blacksmith and Wilda Sorrel the herb-seller - so only one new body was
   * added and the village keeps its three planned pedlars and its reeve. */
  assert.ok(ald.placed >= 4,
    `Aldermoor placed only ${ald.placed} of its quota; at 3 it loses its reeve`);
  assert.ok(ald.vendors >= 1,
    'the planner stopped giving Aldermoor a pedlar of its own');
  assert.ok(summary.residents > 80,
    `the vale planned only ${summary.residents} residents; the authored cast has eaten the quota`);
});
