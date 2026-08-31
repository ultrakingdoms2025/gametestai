/**
 * Regression cover for four defects reported against the inventory panel.
 *
 * Each test names the symptom a player reported, because every one of these
 * bugs was invisible to a unit test that only asked whether the model was
 * right: the model WAS right in three of the four, and the defect lived in a
 * CSS collision, a gesture conflict, and a container the weapons could not
 * see. Where the only honest assertion is over source text, this file says so
 * and asserts over source text rather than pretending to drive a browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isItem, itemDef, slotsFor, stackSize } from '../../src/systems/ItemDefs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

/* -- Defect: a moved stack landed as a blank tile -------------------------
 * `hud.css` owned a bare `.flash` for the damage overlay and set opacity 0 on
 * it. `InventoryUI` marked the landing cell `flash`. `.inv-slot` declares no
 * opacity of its own, so the just-moved item was painted invisible until the
 * next redraw - which is why Sort and reopening the panel "fixed" it. */

test('hud.css has no unscoped .flash rule to leak onto other panels', async () => {
  const css = await readFile(path.join(root, 'src/ui/hud.css'), 'utf8');
  // A selector that is exactly `.flash` at the start of a rule, i.e. matching
  // any element anywhere with that class.
  assert.doesNotMatch(
    css,
    /(^|[},])\s*\.flash\s*\{/m,
    'a bare .flash rule matches every panel in the game, not just the HUD overlay',
  );
  assert.match(css, /\.hud > \.flash \{/, 'the damage overlay is scoped to the HUD');
});

test('the inventory landing flash uses a prefixed class name', async () => {
  const js = await readFile(path.join(root, 'src/ui/InventoryUI.js'), 'utf8');
  const css = await readFile(path.join(root, 'src/ui/inventory.css'), 'utf8');
  assert.match(js, /classList\.add\('inv-landed'\)/, 'the landing cell is marked inv-landed');
  assert.doesNotMatch(js, /classList\.add\('flash'\)/, 'never the generic name again');
  assert.match(css, /\.inv-slot\.inv-landed \{/);
});

/* -- Defect: every message about a use was painted behind the panel ------- */

test('the toast layer is not trapped inside the .hud stacking context', async () => {
  const js = await readFile(path.join(root, 'src/ui/HUD.js'), 'utf8');
  const css = await readFile(path.join(root, 'src/ui/hud.css'), 'utf8');
  // `.hud` is positioned, carries a z-index AND animates opacity, so anything
  // inside it can never paint above a panel at a higher z-index.
  assert.match(css, /\.hud \{[^}]*z-index: 10;/s, 'the premise: .hud is a stacking context');
  const build = js.match(/_buildToasts\([^)]*\)\s*\{[\s\S]*?\n {2}\}/)?.[0] ?? '';
  assert.ok(build, 'found _buildToasts');
  assert.match(build, /this\.root\.appendChild\(this\.toastWrap\)/, 'toasts hang off #ui-root');
  assert.doesNotMatch(build, /hud\.appendChild\(this\.toastWrap\)/);
  // And it has to clear the panels it used to hide behind.
  const toasts = css.match(/\n\.toasts \{[\s\S]*?\n\}/)?.[0] ?? '';
  const z = Number(toasts.match(/z-index:\s*(\d+)/)?.[1] ?? 0);
  const invCss = await readFile(path.join(root, 'src/ui/inventory.css'), 'utf8');
  const invZ = Number(invCss.match(/z-index:\s*(\d+)/)?.[1] ?? 0);
  assert.ok(z > invZ, `toasts (${z}) must paint above the inventory panel (${invZ})`);
});

/* -- Defect: hold-to-use lost the press to a native drag ------------------ */

test('a usable cell stops being draggable for the duration of a hold', async () => {
  const js = await readFile(path.join(root, 'src/ui/InventoryUI.js'), 'utf8');
  const begin = js.match(/_beginHold\([^)]*\)\s*\{[\s\S]*?\n {2}\}/)?.[0] ?? '';
  const clear = js.match(/_clearHoldView\(\)\s*\{[\s\S]*?\n {2}\}/)?.[0] ?? '';
  assert.ok(begin && clear, 'found both halves of the hold view');
  assert.match(begin, /cell\.draggable = false/, 'the drag gesture yields to the hold');
  assert.match(clear, /view\.cell\.draggable = true/, 'and is handed back when the press ends');
});

/* -- Defect: an id the catalogue does not define passed every guard ------- */

test('Object.prototype keys are not items', () => {
  for (const key of ['toString', 'valueOf', 'constructor', 'hasOwnProperty']) {
    assert.equal(isItem(key), false, `${key} must not read as an item id`);
    assert.equal(itemDef(key), null, `${key} must have no definition`);
  }
  assert.equal(isItem('medkit'), true, 'a real id still resolves');
  assert.ok(itemDef('medkit'), 'a real id still resolves to a def');
});

test('a prototype key can never poison the slot arithmetic with NaN', () => {
  // This is the actual damage: `slotsFor` fed `Math.ceil(qty / undefined)`
  // into `bagUsed`, and the panel's grid-padding loop stops dead on a NaN.
  for (const key of ['toString', 'valueOf', 'constructor']) {
    assert.ok(Number.isFinite(stackSize(key)), `stackSize(${key}) must be a number`);
    assert.ok(Number.isFinite(slotsFor(key, 5)), `slotsFor(${key}) must be a number`);
  }
});

test('the placement guard and the inventory both use the own-property check', async () => {
  const overlay = await readFile(path.join(root, 'src/systems/MapOverlay.js'), 'utf8');
  const inv = await readFile(path.join(root, 'src/systems/Inventory.js'), 'utf8');
  assert.match(overlay, /!isItem\(grant\.itemId\)/, 'MapOverlay refuses non-items by own key');
  assert.doesNotMatch(overlay, /!ITEMS\[grant\.itemId\]/, 'and not by a prototype-inheriting read');
  const known = inv.match(/_known\(id\)\s*\{[\s\S]*?\n {2}\}/)?.[0] ?? '';
  assert.ok(known, 'found _known');
  assert.match(known, /isItem\(id\)/, 'Inventory._known asks the same question');
  assert.doesNotMatch(known, /ITEMS\[/);
});

/* -- Defect: "I see bullets I can not use them" ---------------------------
 * Weapons can only see the bag. Acquisition is bag-first with STORE overflow,
 * and a fresh game seeds 120 bullets straight into the store, so a player
 * could own rounds the rifle refused to fire. */

test('WEAPON_STATS states a resupply target for every weapon that eats ammunition', async () => {
  const { WEAPON_STATS } = await import('../../src/systems/WeaponStats.js');
  for (const [id, s] of Object.entries(WEAPON_STATS)) {
    if (!s.ammoItem) continue;
    assert.ok(
      Number.isFinite(s.resupplyTarget) && s.resupplyTarget > 0,
      `${id} must state resupplyTarget rather than deriving it from a magazine it may not have`,
    );
  }
  // The specific regression: the fireball has no magazine, so the old
  // `magazine * 6` derivation fell to a `?? 20` default and asked for 120.
  assert.equal(WEAPON_STATS.fireball.magazine, undefined, 'premise: no magazine');
  assert.ok(WEAPON_STATS.fireball.resupplyTarget <= 40, 'and is no longer sized as if it had one');
});

test('Loadout draws ammunition from the store only at the moment of need', async () => {
  const { Loadout } = await import('../../src/player/Loadout.js');
  const proto = Loadout.prototype;
  assert.equal(typeof proto._restockFor, 'function', 'the restock exists');
  assert.equal(typeof proto._restockOnDemand, 'function');
  assert.equal(
    typeof proto._lowWaterFor, 'undefined',
    'the low-water sweep is gone: it could not tell ammo that was SPENT from ammo the player deliberately put away, so it silently undid every deposit on the frame after the panel closed',
  );

  const moved = [];
  const emitted = [];
  const makeCtx = (bag, store) => ({
    bus: { emit: (name, payload) => emitted.push([name, payload]) },
    _brokers: [{ id: 'machinegun', item: 'bullet', spendOnFire: false }],
    _inv: () => ({
      count: () => store,
      bagRoomFor: () => 60,
      moveToBag: (id, qty) => { moved.push([id, qty]); return qty; },
    }),
    _bagCount: () => bag,
  });

  // Empty bag, stocked store: fill toward the working load, capped by bag room.
  proto._restockFor.call(makeCtx(0, 300), { id: 'machinegun', item: 'bullet' });
  assert.deepEqual(moved, [['bullet', 60]], 'capped by bag room');
  assert.equal(emitted[0][0], 'loadout:restocked');

  // Already at the working load: nothing to do, so nothing moves.
  moved.length = 0;
  proto._restockFor.call(makeCtx(240, 300), { id: 'machinegun', item: 'bullet' });
  assert.deepEqual(moved, [], 'a bag already at resupplyTarget is left alone');

  // An empty store cannot be drawn from.
  moved.length = 0;
  proto._restockFor.call(makeCtx(0, 0), { id: 'machinegun', item: 'bullet' });
  assert.deepEqual(moved, [], 'nothing in the depot, nothing moved');
});

test('the restock is asked for only from a fire attempt or a reload', async () => {
  // THE REGRESSION THIS GUARDS. The first version swept every broker once a
  // frame on a low-water mark. `loadout.update` is inside `if (!uiPaused)`, so
  // it could not run while the panel was open - which was taken as proof it
  // could never fight the player, and was wrong: it ran on the first frame
  // after the panel CLOSED. Depositing 180 rounds and 30 arrows to free bag
  // slots gave them straight back, in MORE slots than they left from.
  const js = await readFile(path.join(root, 'src/player/Loadout.js'), 'utf8');
  const sync = js.match(/_syncAmmo\(\)\s*\{[\s\S]*?\n {2}\}/)?.[0] ?? '';
  assert.ok(sync, 'found _syncAmmo');
  assert.doesNotMatch(sync, /_restockFor|_topUpFromStore|_restockOnDemand/,
    'the per-frame mirror must not restock: that is what undid deliberate deposits');

  const canFire = js.match(/_canFire\(weapon\)\s*\{[\s\S]*?\n {2}\}/)?.[0] ?? '';
  assert.match(canFire, /_restockFor\(b\)/, 'a trigger pull on an empty weapon asks for rounds');

  const update = js.slice(js.indexOf('const wantsFire'), js.indexOf('const wantsFire') + 1400);
  assert.match(update, /_restockOnDemand\(active\)/, 'so does a reload');
});

test('a spend-on-fire weapon may not fire without the whole cost in the bag', async () => {
  const js = await readFile(path.join(root, 'src/player/Loadout.js'), 'utf8');
  const canFire = js.match(/_canFire\(weapon\)\s*\{[\s\S]*?\n {2}\}/)?.[0] ?? '';
  assert.ok(canFire, 'found _canFire');
  assert.match(canFire, /ammoPerShot/, 'the guard reads the per-shot cost');
  assert.doesNotMatch(
    canFire,
    /_bagCount\(b\.item\) > 0/,
    'a bare > 0 lets a multi-unit shot fire free, because consumeFromBag is atomic',
  );
});

/* -- Defect: the HUD ammo panel read 0 Ember Cores with ten in the bag -----
 * Three independent breakages stacked. `FireballWeapon.get reserve()` returns
 * a literal 0 because a fireball has no reserve, and the row preferred
 * `reserve` and only fell through on null - so 0 won. The fireball exposes no
 * `ammoItem`, so the inventory fallback had nothing to look up. And
 * `this._inventory` came from `HUD.attach()`, which was never called, or from
 * `window.GAME`, which exists only under `?dev=1` - so for a real player it
 * was null and NO weapon could have counted its bag. */

test('the HUD ammo row asks the bag, not the weapon, for the reserve', async () => {
  const js = await readFile(path.join(root, 'src/ui/HUD.js'), 'utf8');
  const row = js.match(/_updateBagRow\(w\)\s*\{[\s\S]*?\n {2}\}/)?.[0] ?? '';
  assert.ok(row, 'found _updateBagRow');
  assert.match(row, /ammoItemFor\(w\?\.id\)/, 'the ammo item comes from WeaponStats, not the weapon');
  assert.match(js, /import \{ ammoItemFor \} from '\.\.\/systems\/WeaponStats\.js'/);
  // The bag must be consulted BEFORE reserve, or a weapon reporting a literal
  // 0 (the fireball) shadows a bag that has rounds in it.
  const bagAt = row.indexOf('bagCount');
  const reserveAt = row.indexOf('w?.reserve');
  assert.ok(bagAt > -1 && reserveAt > -1, 'both paths present');
  assert.ok(bagAt < reserveAt, 'the bag is the authority and must be asked first');
});

test('HUD.attach is actually called, so the HUD works without ?dev=1', async () => {
  const main = await readFile(path.join(root, 'src/main.js'), 'utf8');
  assert.match(
    main,
    /hud\.attach\(\{[^}]*inventory[^}]*\}\)/,
    'the HUD is handed its systems explicitly; window.GAME only exists under ?dev=1, so a HUD that polls it is dead for every real player',
  );
  const call = main.match(/hud\.attach\(\{[^}]*\}\)/)?.[0] ?? '';
  assert.ok(call, 'found the attach call');
  for (const sys of ['loadout', 'mounts', 'unstuck', 'economy', 'stamina', 'inventory']) {
    assert.ok(call.includes(sys), `${sys} is attached, not left to window.GAME`);
  }
});

test('the HUD names Ember Cores the way the catalogue and the player do', async () => {
  const js = await readFile(path.join(root, 'src/ui/HUD.js'), 'utf8');
  const { itemDef } = await import('../../src/systems/ItemDefs.js');
  assert.equal(itemDef('fireball_charge').name, 'Ember Cores', 'premise: the catalogue name');
  assert.match(js, /fireball_charge: 'ember cores'/, 'and the ammo panel agrees');
});
