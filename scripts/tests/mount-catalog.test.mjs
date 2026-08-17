import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { MOUNT_STATS } from '../../src/mounts/Livery.js';
import { MOUNT_SKINS_BY_ID } from '../../src/systems/Cosmetics.js';
import { itemDef, skinIdFromItem, SELL_RATE } from '../../src/systems/ItemDefs.js';

/**
 * The marketplace catalog lives in the site (TypeScript) and the things it
 * grants live in the game (JavaScript). Nothing else checks that they agree,
 * and INVENTORY-AUDIT.md records what happens when they drift: rows that
 * "grant" a thing that does not exist. This bundles the TS with esbuild and
 * asserts every mount row against the game's own tables.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let catalogPromise = null;
function loadCatalog() {
  if (!catalogPromise) {
    catalogPromise = build({
      entryPoints: [path.join(root, 'site/lib/marketplaceCatalog.ts')],
      bundle: true, write: false, format: 'esm', platform: 'node', target: 'node22', logLevel: 'silent',
      resolveExtensions: ['.ts', '.js'],
    }).then((r) => import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`));
  }
  return catalogPromise;
}

test('every grant_mount_power row targets a stat the mount actually declares', async () => {
  const { BASE_ITEMS } = await loadCatalog();
  const rows = BASE_ITEMS.filter((r) => r.action_config?.effect === 'grant_mount_power');
  assert.ok(rows.length >= 57, `expected car 9 + 48 new, got ${rows.length}`);
  for (const r of rows) {
    const { mount, power, tier } = r.action_config;
    assert.ok(MOUNT_STATS[mount], `${r.source_key}: unknown mount ${mount}`);
    assert.ok(MOUNT_STATS[mount].includes(power), `${r.source_key}: ${mount} does not sell ${power}`);
    assert.ok([1, 2, 3].includes(tier), `${r.source_key}: tier ${tier}`);
  }
});

test('every skin row grants an item that exists and maps to a catalogued skin', async () => {
  const { BASE_ITEMS } = await loadCatalog();
  const rows = BASE_ITEMS.filter((r) => r.action_config?.effect === 'grant_item' && String(r.action_config.item_id).startsWith('skin_'));
  assert.equal(rows.length, MOUNT_SKINS_BY_ID.size, 'one row per mount skin');
  for (const r of rows) {
    const def = itemDef(r.action_config.item_id);
    assert.ok(def && def.kind === 'skin', `${r.source_key}: no skin item ${r.action_config.item_id}`);
    const skinId = skinIdFromItem(r.action_config.item_id);
    assert.ok(MOUNT_SKINS_BY_ID.has(skinId), `${r.source_key}: unknown skin ${skinId}`);
    assert.equal(r.category, 'mounts');
  }
});

test('source keys are unique and the pre-existing mount keys are still present', async () => {
  const { BASE_ITEMS, MARKETPLACE_ACTIONS } = await loadCatalog();
  const keys = BASE_ITEMS.map((r) => r.source_key);
  assert.equal(new Set(keys).size, keys.length);
  for (const k of ['mount_strength_1', 'mount_strength_2', 'mount_strength_3', 'mount_shield_1', 'mount_power_3', 'cosmetic_car_neon', 'cosmetic_car_azure']) {
    assert.ok(keys.includes(k), k);
  }
  const ids = new Set(MARKETPLACE_ACTIONS.map((a) => a.id));
  for (const r of BASE_ITEMS) assert.ok(ids.has(r.game_action), `${r.source_key} action ${r.game_action}`);
  // Buy must always cost more than sell, or buy->sell->buy prints credits.
  for (const r of BASE_ITEMS) assert.ok(r.cost_buy > r.cost_sell, `${r.source_key}: cost_buy ${r.cost_buy} <= cost_sell ${r.cost_sell}`);

  // Buy->sell->buy must not print credits: a skin's catalog price must stay
  // well above what the game pays back for the bag item it grants.
  const skinRows = BASE_ITEMS.filter((r) => r.action_config?.effect === 'grant_item' && String(r.action_config.item_id).startsWith('skin_'));
  for (const r of skinRows) {
    const def = itemDef(r.action_config.item_id);
    assert.ok(def, `${r.source_key}: no item def for ${r.action_config.item_id}`);
    const sellBack = def.value * SELL_RATE;
    assert.ok(r.cost_buy >= sellBack * 3, `${r.source_key}: cost_buy ${r.cost_buy} < 3x sell-back ${sellBack}`);
    assert.ok(r.game_action === 'mount_skin' || r.game_action === 'cosmetic_vehicle_skin', `${r.source_key}: unexpected game_action ${r.game_action}`);
  }
});
