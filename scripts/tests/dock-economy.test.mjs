import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build as esbuild } from 'esbuild';

import { PACKS, WORLD_MARKETS, itemDef } from '../../src/systems/ItemDefs.js';
import { ItemUseSystem } from '../../src/systems/ItemUse.js';
import { Viewpoints } from '../../src/systems/Viewpoints.js';
import { DOCK_QUESTS } from '../../admin/lib/quests/dock.mjs';
import { LORE_ORDER, DEFAULT_LORE } from '../../src/content/Lore.js';

/**
 * THE YARD'S ECONOMY, END TO END — AND THE LORE MIRRORS THAT GO WITH IT.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THIS FILE IS FOR THAT `dock-registration` IS NOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `dock-registration.test.mjs` asks whether a ROW EXISTS. That is the right
 * question for the fourteen silent tables, and it is not the question that
 * catches the defect this file exists for, which is one step further along:
 *
 *   **an item that is registered, priced, catalogued and named by a quest,
 *   and that no counter in the world will show you.**
 *
 * Registration is nine steps and the ninth is REACH. `Marketplace.refreshCatalog`
 * filters the open window by the standing vendor's `vendorCategories`, and
 * `_findVendor` only sees NPCs within `VENDOR_RANGE = 7` m. So a catalogue row
 * in a category no counter carries is an item nobody can buy, a `purchase`
 * step naming it can never complete, and `scripts/quest-vocab.mjs` will PASS
 * that step — its purchase vocabulary is `ITEMS` plus `PACKS`, which is what
 * the game knows how to sell, not what this world actually stocks.
 *
 * The recorded instance is exact: a purchase step once named a vendor 19.7 m
 * away against a range of 7.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  AND THE MIRRORS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The yard's lore is written in FIVE places — `src/content/Lore.js`,
 * `admin/lib/db.ts`, `site/lib/lore.ts`, `site/lib/worlds.ts` and the admin
 * dashboard's own ordering — and nothing at all compares them. A scope that
 * exists in the game and not on the site is a marketing page describing a
 * Nexus of six worlds to a player standing in the seventh, which is the same
 * failure as `buildLorePersona`'s hardcoded canonical-facts sentence and just
 * as invisible.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

/** `Marketplace.VENDOR_RANGE`, scraped so a change to it fails this file. */
const VENDOR_RANGE = (() => {
  const m = /const VENDOR_RANGE = ([\d.]+)/.exec(read('src/systems/Marketplace.js'));
  assert.ok(m, 'VENDOR_RANGE scrape failed — a dead scrape must not read as a pass');
  return Number(m[1]);
})();

/** `ALL_CATEGORIES`, the game's own mirror of the site list. */
const ALL_CATEGORIES = (() => {
  const m = /const ALL_CATEGORIES = \[([^\]]*)\]/.exec(read('src/systems/Marketplace.js'));
  assert.ok(m, 'ALL_CATEGORIES scrape failed');
  return [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
})();

/**
 * `site/lib/lore.ts` imports `@vercel/postgres` for the ONE query in it, and
 * that package is a site dependency this repo's node_modules does not carry.
 * Stubbed rather than skipped: the thing under test is `FALLBACK_LORE`, which
 * is a plain const, and refusing to read it because a sibling export needs a
 * database is how a mirror goes unchecked.
 */
const stubServerDeps = {
  name: 'stub-server-deps',
  setup(b) {
    b.onResolve({ filter: /^@vercel\/postgres$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export const sql = () => { throw new Error("no database in a unit test"); };',
      loader: 'js',
    }));
  },
};

let bundled = null;
function ts(rel) {
  bundled ??= new Map();
  if (!bundled.has(rel)) {
    bundled.set(rel, esbuild({
      entryPoints: [path.join(ROOT, rel)],
      bundle: true, write: false, format: 'esm', platform: 'node', target: 'node22',
      logLevel: 'silent', resolveExtensions: ['.ts', '.tsx', '.js'],
      plugins: [stubServerDeps],
    }).then((r) => import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`)));
  }
  return bundled.get(rel);
}

/**
 * `Marketplace._purchaseGrant`, called on a bare object rather than on an
 * instance.
 *
 * The method reads only its argument, and CONSTRUCTING a `Marketplace` binds a
 * keyboard listener to `window` — which in this process is `globalThis` and has
 * no `addEventListener`, so the constructor's async keybinding pass throws
 * after the test has already passed. Borrowing the prototype method keeps the
 * real resolver (this is the step whose failure mode is a perfect-looking row
 * that grants null) without booting a shop.
 */
async function purchaseGrant() {
  const { Marketplace } = await import('../../src/systems/Marketplace.js');
  const fn = Marketplace.prototype._purchaseGrant;
  assert.equal(typeof fn, 'function', '_purchaseGrant is gone: the resolver this test drives no longer exists');
  return (row) => fn.call({}, row);
}

/* ------------------------------------------------------------------ */
/* A world, built without a browser                                    */
/* ------------------------------------------------------------------ */

let _built = null;
async function built() {
  if (_built) return _built;
  const THREE = await import('three');
  class Img {
    constructor(a, b, c) {
      if (typeof a === 'number') { this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4); }
      else { this.data = a; this.width = b; this.height = c ?? 1; }
    }
  }
  const gradient = { addColorStop() {} };
  const context2d = (canvas) => new Proxy({
    canvas,
    createImageData: (w, h) => new Img(Math.max(1, w | 0), Math.max(1, (h ?? w) | 0)),
    getImageData: (x, y, w, h) => new Img(Math.max(1, w | 0), Math.max(1, h | 0)),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createConicGradient: () => gradient,
    createPattern: () => null,
    measureText: () => ({ width: 8 }),
    getLineDash: () => [],
  }, { get: (o, k) => (k in o ? o[k] : () => undefined), set: () => true });
  globalThis.ImageData ??= Img;
  globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(Date.now()), 0);
  globalThis.document ??= {
    createElement(tag) { const c = { width: 1, height: 1, style: {}, tagName: tag }; c.getContext = () => context2d(c); return c; },
    createElementNS(_ns, tag) { return this.createElement(tag); },
  };
  globalThis.window ??= globalThis;
  globalThis.OffscreenCanvas ??= class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return context2d(this); } };
  const dead = () => ({ texture: null, dispose() {} });
  THREE.PMREMGenerator.prototype.fromEquirectangular = dead;
  THREE.PMREMGenerator.prototype.fromScene = dead;
  THREE.PMREMGenerator.prototype.compileEquirectangularShader = () => {};

  const { Physics } = await import('../../src/physics/Physics.js');
  const { DockWorld } = await import('../../src/worlds/DockWorld.js');
  const physics = new Physics();
  const world = new DockWorld({
    physics,
    scene: new THREE.Scene(),
    bus: { on: () => () => {}, emit() {} },
    engine: {
      renderer: {
        capabilities: { getMaxAnisotropy: () => 4, isWebGL2: true },
        initTexture() {}, getContext: () => ({}),
        getRenderTarget: () => null, setRenderTarget() {}, render() {}, clear() {},
      },
      onFrameUpdate: () => () => {}, onResize: () => () => {},
    },
    materials: { get: () => new THREE.MeshStandardMaterial(), dispose() {} },
  });
  world.physics = physics;
  await world.build(() => {});
  _built = { world, physics };
  return _built;
}

/**
 * Which worlds publish `viewpoints` at all, read off their own source.
 *
 * `Viewpoints` arms off `world.viewpoints` and a world that publishes none
 * answers `reveals() === true` for every column — so a chart there has nothing
 * to mark and `canChart()` refuses the use. Scraped rather than imported
 * because importing seven worlds means building seven worlds.
 */
function worldsPublishingViewpoints() {
  const dir = path.join(ROOT, 'src/worlds');
  const out = new Set();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    const src = readFileSync(path.join(dir, f), 'utf8');
    const id = /static\s+id\s*=\s*'([^']+)'/.exec(src)?.[1];
    if (!id) continue;
    if (/\bthis\.viewpoints\.push\(|\bthis\.viewpoints\s*=\s*\[\s*\{/.test(src)) out.add(id);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The yard's counters, read out of the world's own source             */
/* ------------------------------------------------------------------ */

/**
 * Every vendor `DockWorld._publish` authors, with its stock restriction.
 *
 * Scraped rather than built, because what is being asserted is the AUTHORED
 * descriptor — `NPCManager` copies `vendorCategories` off it verbatim — and a
 * built world would answer with `npcSpawns`, which is the same data one step
 * further from the thing a reader would edit.
 */
function dockVendors() {
  const src = read('src/worlds/DockWorld.js');
  const out = [];
  for (const m of src.matchAll(/name: '([^']+)',\s*\n\s*vendorTitle: '([^']+)',\s*\n\s*vendorCategories: \[([^\]]*)\]/g)) {
    out.push({
      name: m[1],
      title: m[2],
      categories: [...m[3].matchAll(/'([a-z]+)'/g)].map((x) => x[1]),
    });
  }
  return out;
}

test('the vendor scrape still works — a dead scrape must not read as a pass', () => {
  const v = dockVendors();
  assert.ok(v.length >= 3, `found ${v.length} counters in DockWorld, expected at least three`);
  assert.ok(v.some((x) => x.name === 'Ivo Marek'), 'the Chandler is not in the scrape');
  assert.ok(v.some((x) => x.name === 'Suri Vane'), 'the Fitter is not in the scrape');
  assert.ok(VENDOR_RANGE > 0 && VENDOR_RANGE < 20, `VENDOR_RANGE scraped as ${VENDOR_RANGE}`);
});

/* ================================================================== */
/* 1. Every yard row grants something that exists                      */
/* ================================================================== */

test('every catalogue row stocked in the yard grants an item the game actually has', async () => {
  const { buildMarketplaceSeedItems } = await ts('site/lib/marketplaceCatalog.ts');
  const rows = buildMarketplaceSeedItems().filter((r) => r.world_name === 'dock');
  assert.ok(rows.length > 40, `the yard's catalogue is only ${rows.length} rows`);

  let granted = 0;
  for (const r of rows) {
    const cfg = r.action_config ?? {};
    let id = null;
    if (cfg.effect === 'grant_ammo') id = cfg.ammo_item;
    else if (cfg.effect === 'grant_item') id = cfg.item_id;
    if (!id) continue;                       // powers and cosmetics grant no bag row
    granted++;
    assert.ok(itemDef(id), `${r.source_key} grants "${id}", which is in no ITEMS row: the purchase would return unsupported`);
  }
  assert.ok(granted > 20, `only ${granted} rows in the yard grant a bag item`);

  /* ..and the four yard rows resolve through the REAL grant path. A row can
   * be perfectly formed and still resolve to null — that is the whole shape of
   * the `MARKETPLACE_CONSUMABLE_ITEMS` defect — so these are called, not read. */
  const grantOf = await purchaseGrant();
  const expected = {
    'pack_laser_cell': { itemId: 'laser_cell', qty: 40 },
    'part_hull_plate': { itemId: 'hull_plate', qty: 1 },
    'part_thruster_coil': { itemId: 'thruster_coil', qty: 1 },
    'pack_nav_chart': { itemId: 'nav_chart', qty: 1 },
  };
  for (const [key, want] of Object.entries(expected)) {
    const r = rows.find((x) => x.source_key === `${key}:dock`);
    assert.ok(r, `${key} is not seeded into the yard at all`);
    assert.deepEqual(grantOf(r), want,
      `${key} resolves to no bag grant: the purchase returns unsupported and the player is charged nothing, ever`);
  }
});

test('no row in the yard can be bought and sold back for a profit', async () => {
  const { buildMarketplaceSeedItems } = await ts('site/lib/marketplaceCatalog.ts');
  for (const r of buildMarketplaceSeedItems()) {
    assert.ok(r.cost_buy > r.cost_sell,
      `${r.source_key}: buy ${r.cost_buy} <= sell ${r.cost_sell} — a credit press`);
  }
});

/* ================================================================== */
/* 2. REACH: every purchase step is stocked by a counter in this world */
/* ================================================================== */

test('every purchase step in the arc names something a yard counter actually stocks', async () => {
  const { buildMarketplaceSeedItems } = await ts('site/lib/marketplaceCatalog.ts');
  const rows = buildMarketplaceSeedItems().filter((r) => r.world_name === 'dock');
  const vendors = dockVendors();

  /* What each counter can show, resolved the way `refreshCatalog` resolves it:
   * a row is offered when its category is in the standing vendor's list. */
  const stockedBy = new Map();
  for (const v of vendors) {
    stockedBy.set(v.name, rows.filter((r) => v.categories.includes(r.category)));
  }

  /* `market:trade` carries `itemId: item.source_key`, and `_matchesStepTarget`
   * matches whole token runs. So a step target is satisfiable when its tokens
   * are a contiguous run inside some stocked row's key. */
  const tokens = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').split('_').filter(Boolean);
  const runIn = (a, b) => {
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    for (let i = 0; i + short.length <= long.length; i++) {
      if (short.every((t, j) => long[i + j] === t)) return true;
    }
    return false;
  };

  const TRADE_KINDS = new Set(['buy', 'sell']);
  const report = [];
  let checked = 0;
  for (const q of DOCK_QUESTS) {
    for (const s of q.steps) {
      if (s.type !== 'purchase') continue;
      checked++;
      // `sell` is not category-gated at all: `Marketplace.sellables` reads the
      // player's own bag, so any counter takes it.
      if (TRADE_KINDS.has(s.target)) { report.push(`${q.n}.${s.order} ${s.target} (any counter)`); continue; }

      const want = tokens(s.target);
      const sellers = vendors.filter((v) =>
        stockedBy.get(v.name).some((r) => runIn(want, tokens(r.source_key))));
      assert.ok(sellers.length > 0,
        `quest ${q.n} step ${s.order} says "buy ${s.target}" and NO counter in Lodestar Yard stocks it — `
        + `the categories on offer are ${JSON.stringify([...new Set(vendors.flatMap((v) => v.categories))])}`);
      report.push(`${q.n}.${s.order} ${s.target} <- ${sellers.map((v) => v.name).join(', ')}`);
    }
  }
  assert.ok(checked >= 5, `only ${checked} purchase steps were checked; the arc has more than that`);
  console.log(`  purchase steps, and who serves them:\n    ${report.join('\n    ')}`);
});

test('a body can stand within VENDOR_RANGE of every counter, on real ground', async () => {
  const { physics, world } = await built();
  const THREE = await import('three');
  const PLAN = await import('../../src/worlds/dock/YardPlan.js');
  const COLLISION_LAYER = (await import('../../src/physics/Physics.js')).COLLISION_LAYER;

  /* THE ASSERTION, STATED AS THE DEFECT IT CATCHES.
   *
   * `Marketplace._findVendor` measures from the PLAYER to the NPC and takes
   * nothing beyond `VENDOR_RANGE`. So a counter is only a shop if a body can
   * stand inside that circle — and "inside that circle" is not the same as
   * "near the counter", because the counter itself is solid and so is the tool
   * wall behind it. This probes the REAL colliders for standable deck.
   *
   * A first version of this test measured the gap to the painted keel strip
   * instead and reported 8.6 m against a range of 7 — a FALSE red, because the
   * whole assembly floor is walkable and the keel line is paint. The proxy was
   * wrong; the probe is the measurement. */
  const spawns = (world.npcSpawns ?? []).filter((s) => s.role === 'vendor');
  assert.ok(spawns.length >= 3, `${spawns.length} vendor spawns published`);

  const down = new THREE.Vector3(0, -1, 0);
  const from = new THREE.Vector3();
  const report = [];
  for (const s of spawns) {
    let bestD = Infinity;
    for (let a = 0; a < 32; a++) {
      for (let r = 1.0; r <= VENDOR_RANGE - 0.2; r += 0.4) {
        const x = s.position.x + Math.cos((a / 32) * Math.PI * 2) * r;
        const z = s.position.z + Math.sin((a / 32) * Math.PI * 2) * r;
        // Standable: deck within half a metre of y 0 under the feet...
        from.set(x, PLAN.DECK_Y + 1.2, z);
        const floor = physics.raycast(from, down, 2.0, COLLISION_LAYER.WORLD);
        if (!floor || Math.abs(PLAN.DECK_Y + 1.2 - floor.distance - PLAN.DECK_Y) > 0.5) continue;
        // ...and 1.75 m of capsule above it, so it is not under the counter.
        const head = physics.raycast(
          new THREE.Vector3(x, PLAN.DECK_Y + 0.1, z), new THREE.Vector3(0, 1, 0), 2.2, COLLISION_LAYER.WORLD);
        if (head && head.distance < 1.75) continue;
        bestD = Math.min(bestD, r);
      }
    }
    assert.ok(bestD < VENDOR_RANGE,
      `nobody can stand within ${VENDOR_RANGE} m of ${s.name}: the nearest standable deck is `
      + `${Number.isFinite(bestD) ? bestD.toFixed(1) : 'nowhere'} — this is the recorded 19.7 m defect`);
    report.push(`${s.name} ${bestD.toFixed(1)}m`);
  }
  console.log(`  nearest standable ground per counter (range ${VENDOR_RANGE} m): ${report.join(' · ')}`);

  // ..and they must not be so close together that one place to stand is three
  // shops at once, which would make `vendorCategories` decorative.
  const zs = PLAN.COUNTERS.map((c) => c.z).sort((a, b) => a - b);
  for (let i = 1; i < zs.length; i++) {
    assert.ok(zs[i] - zs[i - 1] > VENDOR_RANGE,
      `counters at z ${zs[i - 1]} and ${zs[i]} are ${(zs[i] - zs[i - 1]).toFixed(1)} m apart, `
      + `inside VENDOR_RANGE ${VENDOR_RANGE}: _findVendor would pick one of them arbitrarily`);
  }
});

test("the 'ships' category is carried by a counter, or it is a tab that is always empty", async () => {
  const { buildMarketplaceSeedItems, MARKETPLACE_CATEGORIES } = await ts('site/lib/marketplaceCatalog.ts');
  assert.ok(MARKETPLACE_CATEGORIES.includes('ships'));
  assert.ok(ALL_CATEGORIES.includes('ships'),
    "the game's ALL_CATEGORIES has no 'ships': _readVendorCategories would DROP it and the Fitting Shop "
    + 'would become a general trader stocking the whole catalogue');

  const rows = buildMarketplaceSeedItems().filter((r) => r.world_name === 'dock' && r.category === 'ships');
  assert.ok(rows.length >= 2, `${rows.length} ship rows in the yard`);
  const carriers = dockVendors().filter((v) => v.categories.includes('ships'));
  assert.equal(carriers.length, 1, `${carriers.length} counters carry 'ships'`);

  // And nowhere else in the Nexus, because nowhere else has a counter for it.
  const { BASE_ITEMS } = await ts('site/lib/marketplaceCatalog.ts');
  for (const r of BASE_ITEMS) {
    if (r.category !== 'ships') continue;
    assert.deepEqual([...(r.worlds ?? [])], ['dock'],
      `${r.source_key} is a ships row seeded outside the yard, where no counter carries the category`);
  }
});

/* ================================================================== */
/* 3. `nav_chart`: the whole nine-step chain, link by link             */
/* ================================================================== */

test('nav_chart is a real item with a real effect, and every link of its chain holds', async () => {
  // 1. ITEMS.
  const def = itemDef('nav_chart');
  assert.ok(def, 'no ITEMS row');
  assert.equal(def.kind, 'consumable');
  assert.ok(def.stack >= 1);

  // 2/3/4. ItemUse: an effect, a guard, an application.
  const marked = [];
  const vp = {
    canChart: () => true,
    chartNearest: () => { marked.push('called'); return { id: 'crane-cab', name: 'The Crane Cab' }; },
  };
  const bag = {
    n: 1,
    consumeFromBag(id, q) { if (id !== 'nav_chart' || this.n < q) return false; this.n -= q; return true; },
  };
  const use = new ItemUseSystem({ bus: { emit() {} }, player: {}, inventory: bag, viewpoints: vp });
  const res = use.use('nav_chart');
  assert.ok(res.ok, `use() refused: ${res.reason}`);
  assert.equal(marked.length, 1, 'the chart was consumed and nothing was charted');
  assert.equal(bag.n, 0, 'the chart was applied and not consumed');

  // ..and the guard, which is the half that matters: with nothing left to
  // chart, the item must be REFUSED rather than eaten.
  const bag2 = { n: 1, consumeFromBag() { this.n--; return true; } };
  const use2 = new ItemUseSystem({
    bus: { emit() {} }, player: {}, inventory: bag2,
    viewpoints: { canChart: () => false, chartNearest: () => null },
  });
  const res2 = use2.use('nav_chart');
  assert.equal(res2.ok, false, 'a chart with nothing to mark was accepted');
  assert.equal(bag2.n, 1, 'a REFUSED chart was still consumed — the unit was destroyed for nothing');

  // ..and with the system absent entirely (an unwired build), same answer.
  const bag3 = { n: 1, consumeFromBag() { this.n--; return true; } };
  const res3 = new ItemUseSystem({ bus: { emit() {} }, player: {}, inventory: bag3 }).use('nav_chart');
  assert.equal(res3.ok, false);
  assert.equal(bag3.n, 1, 'an unwired Viewpoints ate the chart');

  // 5/6. A catalogue row, with a registered action id.
  const { BASE_ITEMS, MARKETPLACE_ACTIONS } = await ts('site/lib/marketplaceCatalog.ts');
  const row = BASE_ITEMS.find((r) => r.source_key === 'pack_nav_chart');
  assert.ok(row, 'no BASE_ITEMS row: the item exists and nobody sells it');
  assert.ok(MARKETPLACE_ACTIONS.some((a) => a.id === row.game_action),
    `game_action ${row.game_action} is in no MARKETPLACE_ACTIONS row: the seed normaliser rejects it`);
  assert.equal(row.action_config.item_id, 'nav_chart');

  /* 7. The grant path, driven through the REAL `Marketplace._purchaseGrant`
   * rather than asserted off the source. This is the step whose recorded
   * failure is a prettier `source_key` resolving to nothing in
   * `MARKETPLACE_CONSUMABLE_ITEMS` and every purchase returning `unsupported`
   * (Marketplace.js:605-613) — and the shape of that failure is that the row
   * looks perfect and the grant is null. Only calling it proves otherwise. */
  const grant = (await purchaseGrant())({ source_key: 'pack_nav_chart:dock', action_config: row.action_config });
  assert.deepEqual(grant, { itemId: 'nav_chart', qty: 1 },
    'the chart resolves to no bag grant: the purchase returns unsupported and takes nothing');

  // 8. A counter that carries `tools`.
  assert.equal(row.category, 'tools');
  assert.ok(dockVendors().some((v) => v.categories.includes('tools')),
    'nothing in the yard carries tools, so the chart is unbuyable here');
});

test('the chart is sold only where a viewpoint exists to chart', async () => {
  const { BASE_ITEMS } = await ts('site/lib/marketplaceCatalog.ts');
  const row = BASE_ITEMS.find((r) => r.source_key === 'pack_nav_chart');
  const allowed = [...(row.worlds ?? [])];
  assert.ok(allowed.length > 0, 'the chart is seeded into every world, including four with no viewpoints at all');

  /* Which worlds publish viewpoints, read off their own source. `Viewpoints`
   * arms off `world.viewpoints` and answers `reveals() === true` for a world
   * that publishes none — so in such a world the chart's effect is not merely
   * small, it is nothing, and `canChart()` refuses the use. A row there is a
   * purchase the player pays for and cannot spend. */
  const worldsWithViewpoints = worldsPublishingViewpoints();
  assert.ok(worldsWithViewpoints.size >= 2,
    `only ${worldsWithViewpoints.size} worlds were found publishing viewpoints; the scrape is dead`);
  for (const w of allowed) {
    assert.ok(worldsWithViewpoints.has(w),
      `the chart is sold in "${w}", which publishes no viewpoints: canChart() refuses and the purchase is unspendable`);
  }
});

/* ================================================================== */
/* 4. Charting is not a cheap synchronisation                          */
/* ================================================================== */

function chartRig() {
  const world = {
    viewpoints: [
      { id: 'a', name: 'A', x: 0, y: 0, z: 0, r: 3 },
      { id: 'b', name: 'B', x: 100, y: 0, z: 0, r: 3 },
    ],
  };
  const paid = { credits: 0, items: 0 };
  const handlers = new Map();
  const bus = {
    on(n, f) { handlers.set(n, f); return () => handlers.delete(n); },
    emit() {},
    fire(n, p) { handlers.get(n)?.(p); },
  };
  const vp = new Viewpoints({
    bus,
    player: { position: { x: 0, y: 0, z: 0 } },
    economy: { add: (n) => { paid.credits += n; } },
    inventory: { acquire: () => { paid.items++; } },
  });
  bus.fire('world:changed', { id: 'dock', world });
  return { vp, paid };
}

test('a chart marks the nearest district, pays nothing, and leaves the climb worth making', () => {
  const { vp, paid } = chartRig();
  assert.equal(vp.reveals(2, 0), false, 'the map was already open before anything was charted');

  const got = vp.chartNearest();
  assert.equal(got.id, 'a', 'the chart marked something other than the nearest viewpoint');
  assert.equal(vp.reveals(2, 0), true, 'a charted district is not revealed on the map');
  assert.equal(paid.credits, 0, 'reading a chart paid credits');
  assert.equal(paid.items, 0, 'reading a chart paid a coin');
  assert.equal(vp.isSynced('a'), false, 'a chart SYNCHRONISED the viewpoint');
  assert.equal(vp.anchors.length, 0, 'a chart granted a fast-travel anchor');

  // A second chart takes the next one, and a third has nothing left to take.
  assert.equal(vp.chartNearest().id, 'b');
  assert.equal(vp.canChart(), false);
  assert.equal(vp.chartNearest(), null, 'a third chart marked something twice');
});

test('charts round-trip through the save, and a load REPLACES them rather than merging', () => {
  const a = chartRig();
  a.vp.chartNearest();
  const saved = a.vp.serialize();
  assert.deepEqual(saved.charts, { dock: ['a'] });

  const b = chartRig();
  assert.equal(b.vp.deserialize(saved), true);
  assert.equal(b.vp.reveals(2, 0), true, 'a loaded chart did not restore its district');

  /* The REPLACE rule, which `_synced` already keeps and which matters more for
   * a chart: it is a CONSUMED item, so a load of an earlier save must take the
   * district back with the credits that bought it. */
  const c = chartRig();
  c.vp.chartNearest();
  c.vp.chartNearest();
  c.vp.deserialize({ worlds: {}, sets: [], charts: {} });
  assert.equal(c.vp.reveals(2, 0), false, 'a load kept a district the save does not contain');
  assert.equal(c.vp.canChart(), true);
});

/* ================================================================== */
/* 5. The laser cell has a sink, and the yard prices what it makes     */
/* ================================================================== */

test('laser_cell is buyable AND spendable in this drop — never a rack with nothing to fire it at', async () => {
  const { BASE_ITEMS } = await ts('site/lib/marketplaceCatalog.ts');
  const rack = BASE_ITEMS.find((r) => r.source_key === 'pack_laser_cell');
  assert.ok(rack, 'the cell rack is in no catalogue row');
  assert.equal(rack.action_config.ammo_item, 'laser_cell');
  assert.ok(dockVendors().some((v) => v.categories.includes(rack.category)),
    `no counter in the yard carries ${rack.category}`);

  // The pack id and the regional price adjustment must name the same rack.
  assert.ok(PACKS.some((p) => p.id === 'pack_laser_cell' && p.itemId === 'laser_cell'),
    'WORLD_MARKETS.dock.itemSell names a pack that is in no PACKS row');

  /* And the sink. Without it the cell is a purchase whose entire effect is in
   * a drop that does not exist — the `Dragon.js:2499` complaint, one worse. */
  const plan = await import('../../src/worlds/dock/YardPlan.js');
  assert.ok(plan.BUTTS_CELL_COST > 0);
  const tf = read('src/minigames/TestFire.js');
  assert.match(tf, /bagCount\('laser_cell'\)/, 'the butts do not read the cell rack');
  assert.match(tf, /consumeFromBag\('laser_cell', cost\)/, 'the butts do not burn the cells they charge for');
});

test('the yard pays for what it cannot make and shrugs at what it can', () => {
  const m = WORLD_MARKETS.dock;
  assert.ok(m, 'no WORLD_MARKETS row');
  // The stated economy, as numbers: plate and coil are swept off the floor
  // here, and a crown coin is a curiosity somebody carried through a gateway.
  assert.ok(m.itemBuy.hull_plate < 1, `the yard pays ${m.itemBuy.hull_plate} for plate it makes by the ton`);
  assert.ok(m.itemBuy.thruster_coil < 1);
  assert.ok(m.itemBuy.relic_coin > 1.4, `the yard pays only ${m.itemBuy.relic_coin} for the one thing it cannot make`);
  assert.ok(m.itemBuy.alloy_scrap < m.itemBuy.hull_plate,
    'scrap must be the worst thing to sell here — that is the lesson quest 53 charges 40 credits for');
});

/* ================================================================== */
/* 6. The lore mirrors                                                 */
/* ================================================================== */

test('every lore scope the game ships exists in every mirror that enumerates scopes', async () => {
  const scopes = Object.keys(DEFAULT_LORE);
  assert.ok(scopes.includes('dock') && scopes.includes('space'));
  for (const s of scopes) {
    assert.ok(LORE_ORDER.includes(s), `DEFAULT_LORE.${s} is not in LORE_ORDER: the admin page cannot list it`);
  }

  // The admin seed.
  const db = read('admin/lib/db.ts');
  for (const s of scopes) {
    if (s === 'overall') continue;
    assert.match(db, new RegExp(`scope: '${s}'`),
      `admin DEFAULT_LORE_ROWS has no ${s} row: the dashboard cannot edit it and the API serves the bundled default forever`);
  }

  // The admin dashboard's own ordering.
  const page = read('admin/app/dashboard/lore/page.tsx');
  for (const s of scopes) {
    assert.ok(page.includes(`'${s}'`), `the admin lore page's LORE_ORDER is missing ${s}`);
  }

  // The site's SQL ordering: a scope missing from the CASE lands in the
  // ELSE 99 bucket, which is a silent alphabetical dump rather than an error.
  const siteLore = read('site/lib/lore.ts');
  for (const s of scopes) {
    if (s === 'overall') continue;
    assert.ok(new RegExp(`WHEN '${s}' THEN \\d`).test(siteLore),
      `site/lib/lore.ts orders no '${s}' scope`);
  }
});

test('the site knows about the yard, and says the same things about it as the game', async () => {
  const { WORLDS } = await ts('site/lib/worlds.ts');
  const { FALLBACK_LORE } = await ts('site/lib/lore.ts');
  const { painters } = await ts('site/lib/painters.ts');

  const dock = WORLDS.find((w) => w.id === 'dock');
  assert.ok(dock, 'the marketing site still ships a Nexus with no shipyard in it');
  assert.equal(dock.name, DEFAULT_LORE.dock.title, 'the site and the game disagree about the yard\'s name');
  assert.equal(dock.loreScope, 'dock');

  /* The accent is not a taste decision on the site: it is the colour
   * `StationWorld` gives gateway six, so the card and the door match. */
  const station = read('src/worlds/StationWorld.js');
  const m = /target: 'dock'[^}]*accent: (0x[0-9a-fA-F]{6})/.exec(station);
  assert.ok(m, 'the gateway-six accent scrape failed');
  assert.equal(dock.accent.toLowerCase(), `#${m[1].slice(2).toLowerCase()}`,
    'the site card and the station gateway are different colours');

  // Every world on the site resolves a painter, or its card renders blank.
  for (const w of WORLDS) {
    assert.equal(typeof painters[w.painterKey], 'function',
      `world "${w.id}" names painter "${w.painterKey}", which does not exist`);
  }
  // ..and every world has fallback prose, or `getLore` returns undefined for it.
  for (const w of WORLDS) {
    assert.ok(FALLBACK_LORE[w.id]?.body, `FALLBACK_LORE has no body for "${w.id}"`);
  }
  assert.equal(FALLBACK_LORE.dock.sign_label, DEFAULT_LORE.dock.sign_label);
});

test('the yard painter draws without throwing — a card that renders blank is the site\'s version of an unreachable room', async () => {
  const { painters } = await ts('site/lib/painters.ts');
  const calls = [];
  const gradient = { addColorStop() {} };
  const ctx = new Proxy({
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    measureText: () => ({ width: 8 }),
  }, {
    get(o, k) {
      if (k in o) return o[k];
      return (...a) => { calls.push(String(k)); void a; };
    },
    set() { return true; },
  });
  let seed = 1;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  painters.yard(ctx, 640, 400, rnd);
  assert.ok(calls.length > 40, `the yard painter made only ${calls.length} drawing calls`);
  assert.ok(calls.includes('fillRect') && calls.includes('fill') && calls.includes('stroke'),
    'the yard plate is a flat fill and nothing else');
  assert.ok(calls.includes('fillText'), 'the countdown board is not drawn, and it is the world\'s whole premise');
});
