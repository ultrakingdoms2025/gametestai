# Mount Customizer (F10) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-mount customisation menu on F10 (colour slots with Matt/Gloss finish, marketplace skins that are consumed from the bag and burned in, and a read-only view of purchased stat tiers) for all six mounts, with the stat tiers actually working on every mount.

**Architecture:** Generalise the car-only livery pattern: `MountManager` keeps `_liveries[mountId]`, every mount class declares `static CUSTOM_SLOTS`/`static STATS` and implements `applyCustomization`/`applyPowers`; a shared `src/mounts/Livery.js` does the tint/finish maths. Skins are `kind:'skin'` bag items (catalog `grant_item`) that a stateless `src/systems/MountSkins.js` consumes and unlocks in the existing `Cosmetics` ledger. `src/ui/MountMenu.js` is a structural clone of `CharacterMenu` rendered generically from the active mount's slots/stats. Spec: `docs/superpowers/specs/2026-08-17-mount-customizer-design.md`.

**Tech Stack:** Vanilla JS ES modules + Three.js 0.185 (game, `src/`), `node --test` headless tests in `scripts/tests/*.test.mjs`, Next.js/TS catalog in `site/lib/marketplaceCatalog.ts` (vitest + tsc), esbuild (added as a root devDependency in Task 19 — Vite 8 is rolldown-based and does not bring it) to bundle the TS catalog inside a root test.

**Conventions for every task**
- Run tests with `node --test scripts/tests/<file>.test.mjs` (single file) or `npm test` (all).
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Never rename an existing marketplace `source_key`.
- No new `THREE.Material` allocation at menu-edit time; clone at build, tint at runtime.
- Headless mount construction (used by the tests) works with this stub, copied from `scripts/tests/race-pace.test.mjs:97-108` (drop the `export`s when pasting into a test file):

```js
import * as THREE from 'three';
const matCache = new Map();
export const materials = {
  has: () => true,
  get: (k) => { if (!matCache.has(k)) matCache.set(k, new THREE.MeshStandardMaterial()); return matCache.get(k); },
  register: (k, m) => matCache.set(k, m),
  tinted: (k) => materials.get(k),
};
export const bus = { on() {}, off() {}, emit() {} };
export const scene = new THREE.Scene();
export const ctx = { scene, engine: null, physics: { groundHeight: () => 0, resolveCapsule: (p) => p, sphereCast: () => null, raycast: () => null, colliders: [] }, bus, materials, camera: null };
```

---

## Chunk 1: Data model + car migration

> **Do not push to `main` until Chunk 4 (Task 17) has landed** — the repo deploys from `main` on every push, and between Task 2 and Task 17 the car livery has no UI (F2's Vehicle section is removed in Task 2; F10 arrives in Task 16/17). All commits in Chunks 1–4 are local.
>
> Spec deviation, deliberate: spec §4.2 asks for `static DISPLAY_NAME`; every mount already carries an instance `displayName` (`Car.js:757`, `Dragon.js:649`, …) and the menu reads that instead. No new static is added.
>
> Spec deviation, deliberate: spec §3.1 gives Matt roughness 0.85; shipped 1.0 because on the ORM-baked library materials roughness is a *multiplier* over the bake (factory 1.0), so 0.85 would make Matt glossier than factory. See `FINISH_PROPS` in `Livery.js`.

### Task 1: `src/mounts/Livery.js` — shared tint/finish helper (pure, no THREE import)

**Files:**
- Create: `src/mounts/Livery.js`
- Test: `scripts/tests/mount-liveries.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/mount-liveries.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  FINISH_PROPS, MOUNT_STATS, normColor, applyLivery, liveryMatches,
} from '../../src/mounts/Livery.js';

/**
 * The livery helper is the one place colour and finish are written onto a
 * mount's materials, so it is checked headlessly: a factory restore that
 * forgot roughness would ship a permanently glossy horse without any test
 * noticing in play.
 */

const SLOTS = [
  { id: 'body', label: 'Body', finish: true, defaultColor: 0x112233, palette: 'paint' },
  { id: 'glow', label: 'Glow', finish: false, defaultColor: 0x00ffff, palette: 'glow' },
];

function fresh() {
  const body = new THREE.MeshStandardMaterial({ color: 0x112233, roughness: 0.5, metalness: 0.2 });
  body.envMapIntensity = 0.8;
  const skirt = new THREE.MeshStandardMaterial({ color: 0x445566, roughness: 0.5, metalness: 0.2 });
  const glow = new THREE.MeshBasicMaterial({ color: 0x00ffff });
  const lit = new THREE.MeshStandardMaterial({ color: 0x00ffff, emissive: 0x00ffff });
  return { body, skirt, glow, lit, mats: { body: [body, { mat: skirt, mix: 0.5 }], glow: [glow, { mat: lit, emissive: true }] } };
}

test('normColor accepts numbers and #hex strings', () => {
  assert.equal(normColor(0xff0000), 0xff0000);
  assert.equal(normColor('#00ff00'), 0x00ff00);
  assert.equal(normColor('0000ff'), 0x0000ff);
  assert.equal(normColor('nope'), null);
  assert.equal(normColor(null), null);
});

test('applyLivery tints, mixes, sets emissive, and applies a finish', () => {
  const f = fresh();
  applyLivery({ body: { color: 0xff0000, finish: 'matt' }, glow: { color: 0xff00ff } }, SLOTS, f.mats);
  assert.equal(f.body.color.getHex(), 0xff0000);
  assert.equal(f.body.roughness, FINISH_PROPS.matt.roughness);
  assert.equal(f.body.metalness, FINISH_PROPS.matt.metalness);
  assert.equal(f.body.envMapIntensity, FINISH_PROPS.matt.envMapIntensity);
  // 50% mix from factory 0x445566 toward 0xff0000. Three's ColorManagement is
  // on, so setHex() lands in linear space and lerp() blends linear values -
  // build the expectation the same way rather than hand-computing an sRGB midpoint.
  const exp = new THREE.Color(0x445566).lerp(new THREE.Color(0xff0000), 0.5);
  assert.equal(f.skirt.color.getHex(), exp.getHex());
  assert.equal(f.glow.color.getHex(), 0xff00ff);
  assert.equal(f.lit.emissive.getHex(), 0xff00ff);
});

test('applyLivery with an empty livery restores factory colour and finish', () => {
  const f = fresh();
  applyLivery({ body: { color: 0xff0000, finish: 'gloss' } }, SLOTS, f.mats);
  applyLivery({}, SLOTS, f.mats);
  assert.equal(f.body.color.getHex(), 0x112233);
  assert.equal(f.body.roughness, 0.5);
  assert.equal(f.body.metalness, 0.2);
  assert.equal(f.body.envMapIntensity, 0.8);
  assert.equal(f.skirt.color.getHex(), 0x445566);
});

test('a slot with finish:false ignores a finish request', () => {
  const f = fresh();
  applyLivery({ glow: { color: 0x123456, finish: 'matt' } }, SLOTS, f.mats);
  const stock = new THREE.MeshStandardMaterial();
  assert.equal(f.lit.roughness, stock.roughness);
  assert.equal(f.lit.metalness, stock.metalness);
  assert.equal(f.lit.envMapIntensity, stock.envMapIntensity);
});

test('liveryMatches compares colour, and finish only when the skin sets one', () => {
  const skin = { body: { color: 0xff0000, finish: 'gloss' }, glow: { color: 0x00ff00 } };
  assert.equal(liveryMatches({ body: { color: 0xff0000, finish: 'gloss' }, glow: { color: 0x00ff00, finish: 'matt' } }, skin), true);
  assert.equal(liveryMatches({ body: { color: 0xff0000 }, glow: { color: 0x00ff00 } }, skin), false);
  assert.equal(liveryMatches({ body: { color: 0xff0001, finish: 'gloss' }, glow: { color: 0x00ff00 } }, skin), false);
  assert.equal(liveryMatches({}, skin), false);
});

test('MOUNT_STATS lists the ladder for all six mounts, fire only on the dragon', () => {
  for (const id of ['car', 'dragon', 'eagle', 'horse', 'hoverboard', 'bicycle']) {
    assert.ok(Array.isArray(MOUNT_STATS[id]), id);
    for (const s of ['power', 'strength', 'shield']) assert.ok(MOUNT_STATS[id].includes(s), `${id} ${s}`);
    assert.equal(MOUNT_STATS[id].includes('fire'), id === 'dragon', `${id} fire`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/tests/mount-liveries.test.mjs`
Expected: FAIL — `Cannot find module '.../src/mounts/Livery.js'`

- [ ] **Step 3: Write the module**

Create `src/mounts/Livery.js`:

```js
/**
 * Livery maths shared by every mount.
 *
 * A livery is `{ [slotId]: { color?: number, finish?: 'matt'|'gloss' } }`.
 * Each mount declares its slots (`static CUSTOM_SLOTS`) and, once built, a
 * `_slotMats` map from slot id to the *cloned* materials that slot tints. This
 * module writes colour + finish onto those materials and can put them back to
 * factory, which it remembers on the material itself (`userData.factory`) the
 * first time it touches one - so "Reset to factory" needs no per-mount code.
 *
 * Finish is roughness / metalness / envMapIntensity only. No clearcoat, no
 * define changes: those relink the shader program mid-frame, and a program
 * link during play is exactly the stall the station work spent weeks removing.
 *
 * Deliberately imports nothing from three so the site-side catalog test can
 * import `MOUNT_STATS` without a renderer.
 */

/**
 * Uniform-only material presets for the two plain finishes.
 *
 * On the library's ORM-baked materials `roughness`/`metalness` are *multipliers*
 * over the baked maps (factory 1.0 / 1.0), so Matt keeps roughness at 1.0 -
 * never glossier than factory - and strips the metallic bake; Gloss scales the
 * bake down hard. On scalar `_mat` clones (Eagle tack 0.6, Bicycle frame 0.32)
 * the same numbers read as plain matt / gloss.
 */
export const FINISH_PROPS = {
  matt: { roughness: 1.0, metalness: 0.05, envMapIntensity: 0.6 },
  gloss: { roughness: 0.22, metalness: 0.35, envMapIntensity: 1.0 },
};
export const FINISHES = Object.keys(FINISH_PROPS);

/**
 * The stat ladder each mount sells. Kept here (pure data) rather than only on
 * the classes so the marketplace catalog test can check every
 * `grant_mount_power` row without instantiating a mount.
 */
export const MOUNT_STATS = {
  car: ['power', 'strength', 'shield'],
  dragon: ['power', 'strength', 'shield', 'fire'],
  eagle: ['power', 'strength', 'shield'],
  horse: ['power', 'strength', 'shield'],
  hoverboard: ['power', 'strength', 'shield'],
  bicycle: ['power', 'strength', 'shield'],
};

/** Per-tier effect, matching Car/Dragon.applyPowers. `unit` is UI copy. */
export const STAT_META = {
  power: { label: 'Speed', perTier: 12, unit: 'top speed' },
  strength: { label: 'Acceleration', perTier: 10, unit: 'acceleration' },
  shield: { label: 'Armour', perTier: 10, unit: 'less damage while riding' },
  fire: { label: 'Fire', perTier: 15, unit: 'fireball damage while riding' },
};

/**
 * 0xRRGGBB from a number or a '#rrggbb' / 'rrggbb' string; null if unusable.
 * @param {number|string|null|undefined} c
 * @returns {number|null}
 */
export function normColor(c) {
  if (typeof c === 'number' && Number.isFinite(c)) return c & 0xffffff;
  if (typeof c === 'string') {
    const s = c.trim().replace(/^#/, '');
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
    return parseInt(s, 16);
  }
  return null;
}

/** Remember a material's factory look once, so it can be restored later. */
function factoryOf(m) {
  if (!m.userData) m.userData = {};
  if (!m.userData.factory) {
    m.userData.factory = {
      color: m.color ? m.color.getHex() : null,
      emissive: m.emissive ? m.emissive.getHex() : null,
      roughness: m.roughness,
      metalness: m.metalness,
      envMapIntensity: m.envMapIntensity,
    };
  }
  return m.userData.factory;
}

/**
 * Write a livery onto a mount's cloned materials.
 * @param {Object<string,{color?:number,finish?:string}>|null|undefined} livery
 * @param {Array<{id:string,finish:boolean}>} slots
 * Entries are a material, or `{ mat, mix?, emissive?, finish? }`: `mix` lerps
 * from factory toward the chosen colour (0..1), `emissive:true` also writes
 * `.emissive`, `finish:false` opts a material out of the slot's finish (e.g. a
 * wing membrane that takes 30% of the hide colour but must stay matt).
 * @param {Object<string, Array<any|{mat:any,mix?:number,emissive?:boolean,finish?:boolean}>>} slotMats
 */
export function applyLivery(livery, slots, slotMats) {
  const l = livery || {};
  for (const slot of slots) {
    const entries = slotMats?.[slot.id];
    if (!entries) continue;
    const want = l[slot.id] || {};
    const color = normColor(want.color);
    const finish = slot.finish && FINISH_PROPS[want.finish] ? FINISH_PROPS[want.finish] : null;
    for (const entry of entries) {
      const m = entry?.mat ?? entry;
      if (!m) continue;
      const mix = typeof entry?.mix === 'number' ? entry.mix : 1;
      const emissive = entry?.emissive === true;
      const takesFinish = slot.finish && entry?.finish !== false;
      const fac = factoryOf(m);
      if (m.color) {
        if (color == null || fac.color == null) { if (fac.color != null) m.color.setHex(fac.color); }
        else if (mix >= 1) m.color.setHex(color);
        else m.color.setHex(fac.color).lerp(m.color.clone().setHex(color), mix);
      }
      if (emissive && m.emissive) {
        m.emissive.setHex(color == null ? (fac.emissive ?? 0) : color);
      }
      if (takesFinish && 'roughness' in m) {
        const p = finish || fac;
        if (p.roughness != null) m.roughness = p.roughness;
        if (p.metalness != null) m.metalness = p.metalness;
        if (p.envMapIntensity != null) m.envMapIntensity = p.envMapIntensity;
      }
      m.needsUpdate = false; // uniforms only - never force a recompile
    }
  }
}

/**
 * True when `livery` shows `skinLivery`: every skin slot's colour matches, and
 * its finish matches where the skin specifies one.
 */
export function liveryMatches(livery, skinLivery) {
  if (!skinLivery) return false;
  const l = livery || {};
  for (const slot in skinLivery) {
    const want = skinLivery[slot];
    const have = l[slot];
    if (!have || normColor(have.color) !== normColor(want.color)) return false;
    if (want.finish && have.finish !== want.finish) return false;
  }
  return true;
}

/** Deep copy of a livery, keeping only well-formed slot entries. */
export function cloneLivery(livery) {
  const out = {};
  if (!livery || typeof livery !== 'object') return out;
  for (const slot in livery) {
    const v = livery[slot];
    if (!v || typeof v !== 'object') continue;
    const e = {};
    const c = normColor(v.color);
    if (c != null) e.color = c;
    if (FINISH_PROPS[v.finish]) e.finish = v.finish;
    if (Object.keys(e).length) out[slot] = e;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/tests/mount-liveries.test.mjs`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mounts/Livery.js scripts/tests/mount-liveries.test.mjs
git commit -m "Mounts: shared livery tint/finish helper and stat ladder table

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 2: `MountManager` per-mount liveries with legacy migration

**Files:**
- Modify: `src/mounts/MountManager.js:1-12` (imports), `:242-254` (fields), `:597-620` (`_create`), `:626-641` (livery API), `:673-681` (`_applyPowers`), `:1628-1651` (serialize/deserialize)
- Test: `scripts/tests/mount-liveries.test.mjs`

- [ ] **Step 1: Add failing tests**

Append to `scripts/tests/mount-liveries.test.mjs` (add the headless stub from "Conventions" at the top of the file first — `materials`, `bus`, `scene`, `ctx`):

```js
import { MountManager } from '../../src/mounts/MountManager.js';

const stubPlayer = { position: new THREE.Vector3(), stamina: null };
function manager() {
  const emitted = [];
  const mbus = { on() {}, off() {}, emit: (n, p) => emitted.push([n, p]) };
  const mgr = new MountManager({
    scene: new THREE.Scene(), engine: null, physics: { groundHeight: () => 0, resolveCapsule: (p) => p, sphereCast: () => null, colliders: [] },
    bus: mbus, materials, camera: null, player: stubPlayer, cameraRig: null, avatar: null, npcManager: null, worldManager: null,
  });
  return { mgr, emitted };
}

test('setLivery is per mount, normalises colours, and emits mount:livery with the mount id', () => {
  const { mgr, emitted } = manager();
  mgr.setLivery('horse', { coat: { color: '#ff0000', finish: 'matt' } });
  mgr.setLivery('car', { paint: { color: 0x00ff00 } });
  assert.deepEqual(mgr.getLivery('horse'), { coat: { color: 0xff0000, finish: 'matt' } });
  assert.deepEqual(mgr.getLivery('car'), { paint: { color: 0x00ff00 } });
  assert.deepEqual(mgr.getLivery('dragon'), {});
  const ev = emitted.filter(([n]) => n === 'mount:livery');
  assert.equal(ev.length, 2);
  assert.equal(ev[0][1].mountId, 'horse');
  assert.deepEqual(ev[0][1].livery, { coat: { color: 0xff0000, finish: 'matt' } });
  // getLivery is a copy
  mgr.getLivery('horse').coat.color = 1;
  assert.equal(mgr.getLivery('horse').coat.color, 0xff0000);
});

test('setLivery with finish:null clears the finish; resetLivery clears the mount', () => {
  const { mgr } = manager();
  mgr.setLivery('bicycle', { frame: { color: 0x123456, finish: 'gloss' } });
  mgr.setLivery('bicycle', { frame: { finish: null } });
  assert.deepEqual(mgr.getLivery('bicycle'), { frame: { color: 0x123456 } });
  mgr.resetLivery('bicycle');
  assert.deepEqual(mgr.getLivery('bicycle'), {});
});

test('serialize writes liveries and deserialize round-trips them', () => {
  const { mgr } = manager();
  mgr.setLivery('eagle', { plumage: { color: 0xabcdef }, harness: { color: 0x010203, finish: 'gloss' } });
  const snap = JSON.parse(JSON.stringify(mgr.serialize()));
  assert.ok(snap.liveries, 'liveries key');
  assert.equal('livery' in snap, false, 'legacy livery key is gone');
  const { mgr: m2 } = manager();
  m2.deserialize(snap);
  assert.deepEqual(m2.getLivery('eagle'), { plumage: { color: 0xabcdef }, harness: { color: 0x010203, finish: 'gloss' } });
});

test('a legacy flat car livery migrates into liveries.car', () => {
  const { mgr } = manager();
  mgr.deserialize({ unlocked: ['car'], livery: { paint: 0xc21f2f, wheel: 0xe0b23a }, powers: {} });
  assert.deepEqual(mgr.getLivery('car'), { paint: { color: 0xc21f2f }, wheel: { color: 0xe0b23a } });
});

test('deserialize still returns undefined (SaveGame relies on the falsy fall-through)', () => {
  const { mgr } = manager();
  assert.equal(mgr.deserialize({ unlocked: ['car'] }), undefined);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test scripts/tests/mount-liveries.test.mjs`
Expected: FAIL — `setLivery` signature mismatch (`TypeError` or deepEqual failure).

- [ ] **Step 3: Implement in `MountManager.js`**

Add import after `flightCeilingAt`:

```js
import { normColor, cloneLivery, FINISH_PROPS } from './Livery.js';
```

Replace the `_livery` field block (`:242-247`) with:

```js
    /**
     * Per-mount liveries: `{ [mountId]: { [slotId]: { color?:number, finish?:'matt'|'gloss' } } }`.
     * Applied to a mount on create and re-applied by `setLivery`; persisted via
     * serialize. Slots are declared by each mount class (`static CUSTOM_SLOTS`).
     * @type {Object<string, Object<string, {color?:number, finish?:string}>>}
     */
    this._liveries = {};
```

In `_create()` replace `if (id === 'car') mount.applyCustomization?.(this._livery);` with:

```js
      mount.applyCustomization?.(this._liveries[id]);
```

Replace `setLivery`/`getLivery` (`:626-641`) with:

```js
  /**
   * Merge a livery patch into one mount and apply it live if that mount exists.
   * `patch` is `{ [slotId]: { color?, finish? } }`; `finish: null` clears the
   * finish. Colours may be numbers or '#rrggbb'.
   * @param {string} mountId
   * @param {Object<string,{color?:number|string, finish?:string|null}>} patch
   */
  setLivery(mountId, patch = {}) {
    if (!mountId || !patch || typeof patch !== 'object') return;
    const cur = this._liveries[mountId] || (this._liveries[mountId] = {});
    for (const slot in patch) {
      const p = patch[slot];
      if (!p || typeof p !== 'object') continue;
      const s = cur[slot] || (cur[slot] = {});
      const c = normColor(p.color);
      if (c != null) s.color = c;
      if (p.finish === null) delete s.finish;
      else if (FINISH_PROPS[p.finish]) s.finish = p.finish;
      if (!Object.keys(s).length) delete cur[slot];
    }
    this._mounts.get(mountId)?.applyCustomization?.(cur);
    this.bus?.emit?.('mount:livery', { mountId, livery: cloneLivery(cur) });
  }

  /** Current livery for one mount (deep copy; `{}` when untouched). */
  getLivery(mountId) {
    return cloneLivery(this._liveries[mountId]);
  }

  /** Back to factory colours and finish for one mount. */
  resetLivery(mountId) {
    if (!mountId) return;
    delete this._liveries[mountId];
    this._mounts.get(mountId)?.applyCustomization?.({});
    this.bus?.emit?.('mount:livery', { mountId, livery: {} });
  }
```

In `_applyPowers` add `fire`:

```js
    mount.applyPowers({
      strength: bag.strength || 0,
      shield: bag.shield || 0,
      power: bag.power || 0,
      fire: bag.fire || 0,
    });
```

In `serialize()` replace `livery: { ...this._livery },` with:

```js
      liveries: Object.fromEntries(Object.keys(this._liveries).map((id) => [id, cloneLivery(this._liveries[id])])),
```

In `deserialize()` replace the `if (data.livery && ...)` block with:

```js
    if (data.liveries && typeof data.liveries === 'object') {
      for (const mid in data.liveries) {
        const l = cloneLivery(data.liveries[mid]);
        if (!Object.keys(l).length) continue;
        this._liveries[mid] = l;
        this._mounts.get(mid)?.applyCustomization?.(l);
      }
    } else if (data.livery && typeof data.livery === 'object') {
      // Pre-F10 saves carried a flat car-only `{paint, wheel}`.
      const car = {};
      const paint = normColor(data.livery.paint);
      const wheel = normColor(data.livery.wheel);
      if (paint != null) car.paint = { color: paint };
      if (wheel != null) car.wheel = { color: wheel };
      if (Object.keys(car).length) {
        this._liveries.car = car;
        this._mounts.get('car')?.applyCustomization?.(car);
      }
    }
```

Update the JSDoc on `grantPower` to `@param {'strength'|'shield'|'power'|'fire'} power`.

- [ ] **Step 3b: Remove the car livery section from F2 (`src/ui/CharacterMenu.js`)** — its `setLivery({paint})`/`getLivery()` calls no longer match the new signature, so it goes now rather than half-working until Task 17:

- `:11` → `import { CHARACTER_SKINS } from '../systems/Cosmetics.js';`
- Delete `CAR_PAINT_COLORS` and `CAR_WHEEL_COLORS` (`:95-107`) — they move to `MountMenuLogic.PALETTES` in Task 16.
- Constructor (`:163-185`): drop `mounts` from the destructure and the `this.mounts = mounts ?? null;` line; delete the `_livery` object and the `_liveryPending` / `_liveryRaf` fields (and their comments).
- Delete the whole `/* Vehicle livery ... */ if (this.mounts?.setLivery) { ... }` block (`:394-410`).
- Delete `_liverySwatches`, `_setLivery`, `_liveryPick` (`:522-575`).
- `_skinCards(skins, kind)` (`:584-633`) → `_skinCards(skins)`: `const colors = [skin.preset?.topColor, skin.preset?.legColor, skin.preset?.accentColor];`; the click handler becomes just `this._set({ ...skin.preset });` after the ownership guard; the syncer's `active` is `owned && this._cfg.topColor === skin.preset.topColor && this._cfg.legColor === skin.preset.legColor && this._cfg.accentColor === skin.preset.accentColor`. Update its JSDoc: `@param {Array<{id:string,name:string,blurb:string,preset:object}>} skins` and drop the `kind` param.
- The `_section('Signature skins', ...)` call at `:388` becomes `this._skinCards(CHARACTER_SKINS)`.
- `main.js:232` → `const characterMenu = new CharacterMenu({ root: uiRoot, bus, input, avatar, player, cosmetics });` and change its comment's "F2. Edits the avatar live" paragraph to end with "F2 is character-only; mounts are customised from F10."

`grep -n "livery\|Livery\|mounts" src/ui/CharacterMenu.js` must return nothing.

- [ ] **Step 4: Run tests**

Run: `node --test scripts/tests/mount-liveries.test.mjs` → PASS. Then `npm test && npm run build` → all green (`race-pace` still passes: Car still has `applyPowers`).

- [ ] **Step 5: Commit**

```bash
git add src/mounts/MountManager.js src/ui/CharacterMenu.js src/main.js scripts/tests/mount-liveries.test.mjs
git commit -m "MountManager: per-mount liveries with legacy car migration; F2 is character-only

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 3: Car adopts `CUSTOM_SLOTS` + nested livery

**Files:**
- Modify: `src/mounts/Car.js:1-10` (import), class head (`static` fields), `:845-854` (`_buildModel` materials), `:1897-1909` (`applyCustomization`)
- Test: `scripts/tests/mount-liveries.test.mjs`

- [ ] **Step 1: Add failing test**

Append to `scripts/tests/mount-liveries.test.mjs`:

```js
import { Car } from '../../src/mounts/Car.js';

test('Car declares slots/stats and tints its cloned paint and wheel materials', () => {
  assert.deepEqual(Car.CUSTOM_SLOTS.map((s) => s.id), ['paint', 'wheel']);
  assert.equal(Car.STATS, MOUNT_STATS.car);
  const car = new Car(ctx);
  car.applyCustomization({ paint: { color: 0xff3bd2, finish: 'matt' }, wheel: { color: 0x2fe0ff } });
  assert.equal(car._slotMats.paint[0].color.getHex(), 0xff3bd2);
  assert.equal(car._slotMats.paint[0].roughness, FINISH_PROPS.matt.roughness);
  assert.equal(car._slotMats.paint[0].metalness, FINISH_PROPS.matt.metalness);
  assert.equal(car._slotMats.wheel[0].color.getHex(), 0x2fe0ff);
  car.applyCustomization({});
  assert.equal(car._slotMats.paint[0].roughness, car._slotMats.paint[0].userData.factory.roughness);
  car.dispose();
});
```

- [ ] **Step 2: Run to verify failure**

Expected: FAIL — `Car.CUSTOM_SLOTS` undefined.

- [ ] **Step 3: Implement**

In `Car.js` add the import next to the other imports:

```js
import { applyLivery, MOUNT_STATS } from './Livery.js';
```

Add static declarations immediately after `export class Car {`:

```js
  /** Colour slots the F10 menu offers. `defaultColor` = factory swatch. */
  static CUSTOM_SLOTS = [
    { id: 'paint', label: 'Body paint', finish: true, defaultColor: 0x2b3d55, palette: 'paint' },
    { id: 'wheel', label: 'Wheels', finish: true, defaultColor: 0xb9c2cc, palette: 'wheel' },
  ];
  static STATS = MOUNT_STATS.car;
```

In `_buildModel()` after `this._wheelMat = M.get('mount.alloy').clone();` add:

```js
    this._slotMats = { paint: [this._paintMat], wheel: [this._wheelMat] };
```

and change `if (this._livery) this.applyCustomization(this._livery);` to `this.applyCustomization(this._livery);` (keep it after `_slotMats` is set).

Replace `applyCustomization` (`:1897-1909`) with:

```js
  /**
   * Apply a livery `{ paint?:{color,finish}, wheel?:{color,finish} }` to this
   * car's *cloned* paint and alloy, so the shared library and the AI grid keep
   * their factory colours. Missing slots restore factory. Safe before build.
   */
  applyCustomization(livery) {
    this._livery = livery && typeof livery === 'object' ? livery : {};
    if (!this._slotMats) return;
    applyLivery(this._livery, Car.CUSTOM_SLOTS, this._slotMats);
  }
```

The constructor does not initialise `_livery` today (only `:854` and `:1904-1908` touch it): add `this._livery = null; this._slotMats = null;` immediately before `this._buildModel();` at `:814`.

- [ ] **Step 4: Run tests**

Run: `node --test scripts/tests/mount-liveries.test.mjs && node --test scripts/tests/race-pace.test.mjs` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mounts/Car.js scripts/tests/mount-liveries.test.mjs
git commit -m "Car: CUSTOM_SLOTS and nested livery via the shared helper

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 4: `Cosmetics` — `MOUNT_SKINS` replaces `VEHICLE_SKINS`

**Files:**
- Modify: `src/systems/Cosmetics.js:1-104`
- (CharacterMenu already stopped importing `VEHICLE_SKINS` in Task 2)
- Test: `scripts/tests/mount-liveries.test.mjs`

- [ ] **Step 1: Add failing test**

```js
import { MOUNT_SKINS, MOUNT_SKINS_BY_ID, skinsForMount, Cosmetics } from '../../src/systems/Cosmetics.js';

test('MOUNT_SKINS: 20 skins, 5 car ids preserved, 3 per other mount, unique ids', () => {
  assert.equal(MOUNT_SKINS.length, 20);
  for (const id of ['car_neon', 'car_inferno', 'car_phantom', 'car_toxic', 'car_azure']) {
    assert.equal(MOUNT_SKINS_BY_ID.get(id)?.mount, 'car', id);
  }
  for (const m of ['dragon', 'eagle', 'horse', 'hoverboard', 'bicycle']) assert.equal(skinsForMount(m).length, 3, m);
  assert.equal(new Set(MOUNT_SKINS.map((s) => s.id)).size, 20);
  for (const s of MOUNT_SKINS) {
    assert.ok(s.name && s.blurb && s.livery && typeof s.livery === 'object', s.id);
    for (const slot in s.livery) assert.equal(typeof s.livery[slot].color, 'number', `${s.id}.${slot}`);
  }
});

test('Cosmetics.unlock accepts every mount skin id', () => {
  const c = new Cosmetics({ bus: null });
  for (const s of MOUNT_SKINS) assert.equal(c.unlock(s.id), true, s.id);
});
```

- [ ] **Step 2: Run** → FAIL — `MOUNT_SKINS` is not exported.

- [ ] **Step 3: Implement**

In `Cosmetics.js`, replace the whole `VEHICLE_SKINS` block **and** the three lookup lines after it (`:61-103`) with:

```js
/**
 * Mount skins: presets over each mount's `CUSTOM_SLOTS` (see the mount class).
 * `livery` maps onto `MountManager.setLivery(mount, livery)`. The five car ids
 * predate F10 and are kept verbatim so old ledgers stay valid.
 * @type {Array<{id:string,mount:string,name:string,blurb:string,livery:Object<string,{color:number,finish?:'matt'|'gloss'}>}>}
 */
export const MOUNT_SKINS = [
  // Car (legacy ids)
  { id: 'car_neon', mount: 'car', name: 'Neon Circuit', blurb: 'Magenta body, cyan rims.', livery: { paint: { color: 0xff3bd2, finish: 'gloss' }, wheel: { color: 0x2fe0ff, finish: 'gloss' } } },
  { id: 'car_inferno', mount: 'car', name: 'Inferno', blurb: 'Race red with gold alloys.', livery: { paint: { color: 0xc21f2f, finish: 'gloss' }, wheel: { color: 0xe0b23a, finish: 'gloss' } } },
  { id: 'car_phantom', mount: 'car', name: 'Phantom', blurb: 'Stealth black, chalk-white wheels.', livery: { paint: { color: 0x0d0f12, finish: 'matt' }, wheel: { color: 0xf2f4f6, finish: 'gloss' } } },
  { id: 'car_toxic', mount: 'car', name: 'Toxic Surge', blurb: 'Venom green over black rims.', livery: { paint: { color: 0x18a86b, finish: 'gloss' }, wheel: { color: 0x0d0f12, finish: 'matt' } } },
  { id: 'car_azure', mount: 'car', name: 'Azure Bolt', blurb: 'Electric blue, silver alloys.', livery: { paint: { color: 0x1f6fd0, finish: 'gloss' }, wheel: { color: 0xd9dde2, finish: 'gloss' } } },
  // Dragon
  { id: 'dragon_obsidian', mount: 'dragon', name: 'Obsidian Ember', blurb: 'Black glass hide, blood-red tack.', livery: { hide: { color: 0x14161c, finish: 'gloss' }, saddle: { color: 0xc21f2f, finish: 'gloss' } } },
  { id: 'dragon_verdant', mount: 'dragon', name: 'Verdant Wyrm', blurb: 'Forest scale, worn tan leather.', livery: { hide: { color: 0x1f6b3a, finish: 'matt' }, saddle: { color: 0x8a6a42, finish: 'matt' } } },
  { id: 'dragon_frost', mount: 'dragon', name: 'Frostscale', blurb: 'Glacier hide, deep-blue harness.', livery: { hide: { color: 0xbfe6f2, finish: 'gloss' }, saddle: { color: 0x1f6fd0, finish: 'gloss' } } },
  // Eagle
  { id: 'eagle_golden', mount: 'eagle', name: 'Golden Talon', blurb: 'Burnished gold plumage, black harness.', livery: { plumage: { color: 0xc98a2b }, harness: { color: 0x2c2f36, finish: 'gloss' } } },
  { id: 'eagle_storm', mount: 'eagle', name: 'Storm Crest', blurb: 'Slate-blue feathers, silver straps.', livery: { plumage: { color: 0x3a4a5c }, harness: { color: 0xd9dde2, finish: 'gloss' } } },
  { id: 'eagle_ember', mount: 'eagle', name: 'Ember Wing', blurb: 'Scorched russet, gold harness.', livery: { plumage: { color: 0x7a2a1a }, harness: { color: 0xffd23b, finish: 'gloss' } } },
  // Horse
  { id: 'horse_midnight', mount: 'horse', name: 'Midnight Charger', blurb: 'Coal-black coat, white leather.', livery: { coat: { color: 0x141216 }, saddle: { color: 0xd9dde2, finish: 'gloss' } } },
  { id: 'horse_palomino', mount: 'horse', name: 'Palomino', blurb: 'Golden coat, oiled brown tack.', livery: { coat: { color: 0xd6b26a }, saddle: { color: 0x6b4e35, finish: 'matt' } } },
  { id: 'horse_royal', mount: 'horse', name: 'Royal Grey', blurb: 'Dapple white, violet saddle.', livery: { coat: { color: 0xe6e6ea }, saddle: { color: 0x6a2fd0, finish: 'gloss' } } },
  // Hoverboard
  { id: 'hover_neon', mount: 'hoverboard', name: 'Neon Drift', blurb: 'Gloss black deck, magenta underglow.', livery: { deck: { color: 0x14181f, finish: 'gloss' }, glow: { color: 0xff3bd2 } } },
  { id: 'hover_toxic', mount: 'hoverboard', name: 'Toxic Rail', blurb: 'Matt green deck, acid glow.', livery: { deck: { color: 0x18a86b, finish: 'matt' }, glow: { color: 0xa8ff3b } } },
  { id: 'hover_solar', mount: 'hoverboard', name: 'Solar Flare', blurb: 'Orange gloss deck, gold glow.', livery: { deck: { color: 0xf27b1f, finish: 'gloss' }, glow: { color: 0xffe14a } } },
  // Bicycle
  { id: 'bike_chrome', mount: 'bicycle', name: 'Chrome Courier', blurb: 'Polished frame, bright rims.', livery: { frame: { color: 0xd9dde2, finish: 'gloss' }, rims: { color: 0xb9c2cc, finish: 'gloss' } } },
  { id: 'bike_racing', mount: 'bicycle', name: 'Racing Red', blurb: 'Race red frame, black rims.', livery: { frame: { color: 0xc21f2f, finish: 'gloss' }, rims: { color: 0x0d0f12, finish: 'matt' } } },
  { id: 'bike_forest', mount: 'bicycle', name: 'Forest Ranger', blurb: 'Matt green frame, brass rims.', livery: { frame: { color: 0x2f4a2a, finish: 'matt' }, rims: { color: 0xc9a24a, finish: 'gloss' } } },
];

/** Fast lookups by id, so the customizer and market can resolve a skin cheaply. */
export const CHARACTER_SKINS_BY_ID = new Map(CHARACTER_SKINS.map((s) => [s.id, s]));
export const MOUNT_SKINS_BY_ID = new Map(MOUNT_SKINS.map((s) => [s.id, s]));

/** Skins for one mount id, in catalog order. */
export function skinsForMount(mountId) {
  return MOUNT_SKINS.filter((s) => s.mount === mountId);
}

/** Every id the catalog is allowed to grant. Guards against typos in seed data. */
const KNOWN_SKIN_IDS = new Set([...CHARACTER_SKINS_BY_ID.keys(), ...MOUNT_SKINS_BY_ID.keys()]);
```

Update the header comment: replace "a vehicle skin is a car livery (paint/wheel)" with "a mount skin is a livery over that mount's colour slots (F10)", and `{@link VEHICLE_SKINS}` at `:7` with `{@link MOUNT_SKINS}`. `CharacterMenu` no longer imports `VEHICLE_SKINS` (removed in Task 2 Step 3b); `grep -rn VEHICLE_SKINS src` must return nothing after this step.

- [ ] **Step 4: Run** `npm test && npm run build` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/systems/Cosmetics.js scripts/tests/mount-liveries.test.mjs
git commit -m "Cosmetics: MOUNT_SKINS for all six mounts (legacy car ids kept)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Chunk 2: Per-mount slots + powers, Armour and Fire made real

### Task 5: Dragon — cloned hide/membrane/leather/tack, slots, fire tier

**Files:**
- Modify: `src/mounts/Dragon.js` (import; class head; `:676-680` fields; `:718-722` `_buildModel` materials; `:1294-1296` `_buildHarness`; end of `_buildModel`; `:2295-2313` `_emitBreath`; `:2470-2479` `applyPowers`; `dispose()`)
- Test: `scripts/tests/mount-powers.test.mjs` (new)

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/mount-powers.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Car } from '../../src/mounts/Car.js';
import { Dragon } from '../../src/mounts/Dragon.js';
import { Eagle } from '../../src/mounts/Eagle.js';
import { Horse } from '../../src/mounts/Horse.js';
import { Hoverboard } from '../../src/mounts/Hoverboard.js';
import { Bicycle } from '../../src/mounts/Bicycle.js';
import { MOUNT_STATS, FINISH_PROPS } from '../../src/mounts/Livery.js';

/**
 * Every mount must expose the same customisation surface, and a bought tier
 * must move the number it claims to move. Checked headlessly: a Speed III that
 * only changed the target but left a hard clamp in place is invisible in play
 * for minutes and shows up here in a second.
 */

const matCache = new Map();
const materials = {
  has: () => true,
  get: (k) => { if (!matCache.has(k)) matCache.set(k, new THREE.MeshStandardMaterial()); return matCache.get(k); },
  register: (k, m) => matCache.set(k, m),
  tinted: (k) => materials.get(k),
};
const bus = { on() {}, off() {}, emit() {} };
const scene = new THREE.Scene();
// raycast: Horse/Bicycle probe the ground ahead once moving (Horse.js:798, Bicycle.js:904).
const physics = { groundHeight: () => 0, resolveCapsule: (p) => p, sphereCast: () => null, raycast: () => null, colliders: [] };
const stamina = { drain() {}, exhausted: false };
const player = { position: new THREE.Vector3(), stamina };
const ctx = { scene, engine: null, physics, bus, materials, camera: null, player };

const CLASSES = { car: Car, dragon: Dragon, eagle: Eagle, horse: Horse, hoverboard: Hoverboard, bicycle: Bicycle };

test('every mount declares CUSTOM_SLOTS, STATS, applyCustomization, applyPowers, shieldTier', () => {
  for (const [id, C] of Object.entries(CLASSES)) {
    assert.ok(Array.isArray(C.CUSTOM_SLOTS) && C.CUSTOM_SLOTS.length >= 2, `${id} slots`);
    for (const s of C.CUSTOM_SLOTS) {
      assert.ok(s.id && s.label && typeof s.finish === 'boolean' && typeof s.defaultColor === 'number' && s.palette, `${id}.${s.id}`);
    }
    assert.equal(C.STATS, MOUNT_STATS[id], `${id} STATS`);
    const m = new C(ctx);
    assert.equal(typeof m.applyCustomization, 'function', `${id} applyCustomization`);
    assert.equal(typeof m.applyPowers, 'function', `${id} applyPowers`);
    assert.ok(m._slotMats && C.CUSTOM_SLOTS.every((s) => Array.isArray(m._slotMats[s.id]) && m._slotMats[s.id].length), `${id} _slotMats covers every slot`);
    m.applyPowers({ shield: 2 });
    assert.equal(m.shieldTier, 2, `${id} shieldTier`);
    m.dispose?.();
  }
});

test('applyCustomization tints the first material of every slot and restores on {}', () => {
  for (const [id, C] of Object.entries(CLASSES)) {
    const m = new C(ctx);
    const livery = {};
    for (const s of C.CUSTOM_SLOTS) livery[s.id] = { color: 0x123456, finish: s.finish ? 'matt' : undefined };
    m.applyCustomization(livery);
    for (const s of C.CUSTOM_SLOTS) {
      const first = m._slotMats[s.id][0];
      const mat = first.mat ?? first;
      const target = first.emissive ? mat.emissive : mat.color;
      assert.equal(target.getHex(), 0x123456, `${id}.${s.id} colour`);
      if (s.finish && 'roughness' in mat) {
        assert.equal(mat.roughness, FINISH_PROPS.matt.roughness, `${id}.${s.id} matt roughness`);
        assert.equal(mat.metalness, FINISH_PROPS.matt.metalness, `${id}.${s.id} matt metalness`);
        assert.equal(mat.envMapIntensity, FINISH_PROPS.matt.envMapIntensity, `${id}.${s.id} matt env`);
      }
    }
    m.applyCustomization({});
    for (const s of C.CUSTOM_SLOTS) {
      const first = m._slotMats[s.id][0];
      const mat = first.mat ?? first;
      const fac = mat.userData.factory;
      assert.equal((first.emissive ? mat.emissive : mat.color).getHex(), first.emissive ? fac.emissive : fac.color, `${id}.${s.id} factory colour`);
    }
    m.dispose?.();
  }
});

test('every catalogued skin only names slots its mount actually has', async () => {
  const { MOUNT_SKINS } = await import('../../src/systems/Cosmetics.js');
  for (const s of MOUNT_SKINS) {
    const C = CLASSES[s.mount];
    assert.ok(C, `${s.id}: unknown mount ${s.mount}`);
    for (const k in s.livery) {
      assert.ok(C.CUSTOM_SLOTS.some((sl) => sl.id === k), `${s.id}: slot ${k} is not on ${s.mount} (${C.CUSTOM_SLOTS.map((x) => x.id).join(',')})`);
    }
  }
});

test('Dragon has a fire tier and exposes it', () => {
  const d = new Dragon(ctx);
  assert.ok(Dragon.STATS.includes('fire'));
  assert.equal(d.fireTier, 0);
  d.applyPowers({ fire: 3 });
  assert.equal(d.fireTier, 3);
  d.dispose();
});

/**
 * Speed III must *reach* the mount: drive each one flat out for a while at
 * tier 0 and tier 3 and compare terminal speeds. Thresholds are loose on
 * purpose (drag-limited mounts scale a little under the nominal 1.36) but a
 * tier that only touched a clamp the mount never hits reads ~1.0 and fails.
 * If a mount's sim needs a different control to run flat out, fix the RUN
 * table below - never the threshold.
 */
const STEP = 1 / 60;
const RUN = {
  car: { seconds: 12, spawnY: 0, ctrl: (m) => ({ throttle: 1, strafe: 0, up: 0, boost: true, yaw: m.heading, pitch: 0 }) },
  horse: { seconds: 12, spawnY: 0, ctrl: (m) => ({ throttle: 1, strafe: 0, up: 0, boost: true, yaw: m.heading, pitch: 0 }) },
  hoverboard: { seconds: 12, spawnY: 0, ctrl: (m) => ({ throttle: 1, strafe: 0, up: 0, boost: true, yaw: m.heading, pitch: 0 }) },
  bicycle: { seconds: 20, spawnY: 0, ctrl: (m) => ({ throttle: 1, strafe: 0, up: 0, boost: true, yaw: m.heading, pitch: 0 }) },
  // Level flight, beating: steady speed is set by thrust vs v^2 drag. (Eagle.spawn ignores
  // position.y and places the bird at ground + 6.5; altitude does not enter its speed model.)
  eagle: { seconds: 15, spawnY: 250, ctrl: (m) => ({ throttle: 0, strafe: 0, up: 0, boost: true, yaw: m.heading, pitch: 0 }) },
  dragon: { seconds: 15, spawnY: 30, flying: true, ctrl: (m) => ({ throttle: 1, strafe: 0, up: 1, boost: true, yaw: m.heading, pitch: 0 }) },
};

function terminalSpeed(id, C, tier) {
  const spec = RUN[id];
  const m = new C(ctx);
  m.applyPowers({ power: tier });
  m.spawn(new THREE.Vector3(0, spec.spawnY, 0), 0);
  if (spec.flying) { m.state = 'flying'; m.position.y = spec.spawnY; m._groundY = 0; }
  m.onMount?.();
  const steps = Math.round(spec.seconds / STEP);
  for (let i = 0; i < steps; i++) m.fixedUpdate(STEP, i * STEP, spec.ctrl(m));
  const v = Math.abs(m.speed);
  m.dispose?.();
  return v;
}

test('a purchased Speed III reaches every mount (terminal speed rises 15-50%)', () => {
  for (const [id, C] of Object.entries(CLASSES)) {
    const stock = terminalSpeed(id, C, 0);
    const tuned = terminalSpeed(id, C, 3);
    assert.ok(stock > 3, `${id}: stock terminal speed ${stock.toFixed(2)} - the run table does not drive this mount`);
    const ratio = tuned / stock;
    assert.ok(ratio > 1.15 && ratio < 1.5, `${id}: Speed III gave ${stock.toFixed(2)} -> ${tuned.toFixed(2)} m/s (x${ratio.toFixed(2)})`);
  }
});
```

- [ ] **Step 2: Run** `node --test scripts/tests/mount-powers.test.mjs` → FAIL at `dragon slots`. (It keeps failing for later mounts until Tasks 6–9 land — expected. Car and Dragon already pass the reach test; if the eagle/horse/hoverboard/bicycle rows of `RUN` need a different control to move at all, fix the row, not the threshold.)

- [ ] **Step 3: Implement Dragon**

Import: `import { applyLivery, MOUNT_STATS } from './Livery.js';`

Class head, after `export class Dragon {`:

```js
  static CUSTOM_SLOTS = [
    { id: 'hide', label: 'Hide', finish: true, defaultColor: 0x2b3a2e, palette: 'natural' },
    { id: 'saddle', label: 'Saddle & tack', finish: true, defaultColor: 0x5a3a24, palette: 'paint' },
  ];
  static STATS = MOUNT_STATS.dragon;
```

`defaultColor` is only the swatch highlight / hex-picker seed for an untouched slot; factory *restore* reads the material's own `userData.factory`, so it need not match exactly. `dragon.hide` / `dragon.leather` are ORM-baked with `color: 0xffffff` (the tone lives in the bake shader — "deep basalt green-black" hide, dark leather), so the hexes above are picked by eye. Note for skins: `.color` multiplies the bake, so light presets over the near-black hide (e.g. Frostscale) read as a deep tint rather than pastel — intended.

Fields (`:676-680`): after `this._shieldTier = 0;` add `this._fireTier = 0;`, and before `this._buildModel();` (`:700`) add `this._livery = null; this._slotMats = null;`.

`_buildModel()` (`:718-722`): replace the four `M.get(...)` lines with:

```js
    // Cloned per dragon so a livery cannot repaint the shared library (and the
    // NPC/AI dragons that use it). Clones share maps: no new textures.
    this._hideMat = M.get('dragon.hide').clone();
    this._membraneMat = M.get('dragon.membrane').clone();
    const hide = this._hideMat;
    const belly = M.get('dragon.belly');
    const horn = M.get('dragon.horn');
    const membrane = this._membraneMat;
```

`_buildHarness(M)` (`:1294-1296`):

```js
  _buildHarness(M) {
    this._leatherMat = M.get('dragon.leather').clone();
    this._tackMat = M.get('dragon.tack').clone();
    const leatherMat = this._leatherMat;
    const tackMat = this._tackMat;
```

At the end of `_buildModel()` (after `_buildHarness` at `:908` and the rest of the build) add:

```js
    this._slotMats = {
      // Membrane takes 30% of the hide colour and no finish (spec §3.1).
      hide: [this._hideMat, { mat: this._membraneMat, mix: 0.3, finish: false }],
      saddle: [this._leatherMat, this._tackMat],
    };
    this.applyCustomization(this._livery);
```

Add next to `applyPowers` (and extend its JSDoc `@param` to `{strength?:number, shield?:number, power?:number, fire?:number}`):

```js
  /** Livery `{ hide?, saddle? }` over the cloned hide/membrane and leather/tack. */
  applyCustomization(livery) {
    this._livery = livery && typeof livery === 'object' ? livery : {};
    if (!this._slotMats) return;
    applyLivery(this._livery, Dragon.CUSTOM_SLOTS, this._slotMats);
  }
```

Change `applyPowers` to:

```js
  applyPowers({ strength = 0, shield = 0, power = 0, fire = 0 } = {}) {
    this._powerMul = 1 + Math.max(0, power) * 0.12;   // +12% flight speed / tier
    this._accelMul = 1 + Math.max(0, strength) * 0.10; // +10% throttle bite / tier
    this._shieldTier = Math.max(0, shield);
    this._fireTier = Math.max(0, fire);
  }

  /** Purchased Fire tier: Combat scales the rider's fireballs by it. */
  get fireTier() {
    return this._fireTier;
  }
```

`_emitBreath` (`:2295`): the eighth spawn argument (`0.22 + Math.random() * 0.2`) is the ember size — multiply it by `(1 + 0.1 * this._fireTier)`; and `const n = this._roar > 0.05 ? 3 : 1;` → `const n = (this._roar > 0.05 ? 3 : 1) + (this._fireTier > 0 && this._roar > 0.05 ? 1 : 0);`.

`dispose()`: add `this._hideMat?.dispose(); this._membraneMat?.dispose(); this._leatherMat?.dispose(); this._tackMat?.dispose();`.

- [ ] **Step 4: Run** `node --test scripts/tests/mount-powers.test.mjs` — the Dragon-only test passes; loop tests still fail on eagle (expected). `node --test scripts/tests/race-pace.test.mjs scripts/tests/race-dragon-line.test.mjs` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mounts/Dragon.js scripts/tests/mount-powers.test.mjs
git commit -m "Dragon: cloned hide/tack livery slots and Fire tier

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 6: Eagle — plumage/harness slots, powers

**Files:**
- Modify: `src/mounts/Eagle.js` (import; class head; ctor fields before `:122`; `_build` `:165-169`; `:495` stamina; `:532` drag; `:534` thrust; `:542` clamp; new methods)

- [ ] **Step 1:** Run `node --test scripts/tests/mount-powers.test.mjs` → FAIL at `eagle slots`.

- [ ] **Step 2: Implement**

Import: `import { applyLivery, MOUNT_STATS } from './Livery.js';`

Class head:

```js
  static CUSTOM_SLOTS = [
    { id: 'plumage', label: 'Plumage', finish: false, defaultColor: 0x6b4c30, palette: 'natural' },
    { id: 'harness', label: 'Harness', finish: true, defaultColor: 0x6d4522, palette: 'paint' },
  ];
  static STATS = MOUNT_STATS.eagle;
```

Constructor, before `this._build();` (`:122`):

```js
    /** Purchased-power multipliers, 1 == stock (see MountManager.grantPower). */
    this._powerMul = 1;
    this._accelMul = 1;
    this._staminaMul = 1;
    this._shieldTier = 0;
    this._livery = null;
    this._slotMats = null;
```

`_build()` after `const tackMat = ...` (`:169`): `this._slotMats = { plumage: [body, flight], harness: [tackMat] };` and at the very end of `_build()`: `this.applyCustomization(this._livery);`.

Speed sites. **The eagle's top speed is set by its v² drag, not the clamp**: full dive + full beat settles at √((0.65·17 + 9)/0.012) ≈ 41 m/s, already under `MAX_SPEED = 46`, so scaling only the clamp would make Speed tiers a no-op. Terminal velocity scales linearly with `_powerMul` when the drag coefficient is divided by `_powerMul²`:
- `:495` → `stam.drain(BEAT_STAMINA * this._staminaMul * dt, 'eagle');`
- `:532` (`this.speed -= (0.012 * this.speed * this.speed) * dt;`) → `this.speed -= (0.012 / (this._powerMul * this._powerMul)) * this.speed * this.speed * dt;`
- `:534` → `if (this._beat > 0.01) this.speed += this._beat * 9 * this._accelMul * dt;`
- `:542` → `this.speed = clamp(this.speed, 4.5, MAX_SPEED * this._powerMul);`

Methods (before `dispose()`):

```js
  applyCustomization(livery) {
    this._livery = livery && typeof livery === 'object' ? livery : {};
    if (!this._slotMats) return;
    applyLivery(this._livery, Eagle.CUSTOM_SLOTS, this._slotMats);
  }

  /** Same ladder as Car: +12% top speed, +10% thrust (and cheaper beats), shield stored. */
  applyPowers({ strength = 0, shield = 0, power = 0 } = {}) {
    this._powerMul = 1 + Math.max(0, power) * 0.12;
    this._accelMul = 1 + Math.max(0, strength) * 0.10;
    this._staminaMul = Math.max(0.5, 1 - Math.max(0, strength) * 0.08);
    this._shieldTier = Math.max(0, shield);
  }

  get shieldTier() {
    return this._shieldTier;
  }
```

- [ ] **Step 3: Run** — powers test now fails at `horse`; `npm test` otherwise green.

- [ ] **Step 4: Commit**

```bash
git add src/mounts/Eagle.js
git commit -m "Eagle: plumage/harness livery slots and power tiers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 7: Horse — coat/saddle slots, powers

**Files:**
- Modify: `src/mounts/Horse.js` (import; class head; ctor fields before `:194`; `_build` `:257-261`; `:701-707` speed; new methods)

- [ ] **Step 1: Implement**

Import + statics:

```js
  static CUSTOM_SLOTS = [
    { id: 'coat', label: 'Coat', finish: false, defaultColor: 0x8a6242, palette: 'natural' },
    { id: 'saddle', label: 'Saddle & tack', finish: true, defaultColor: 0x6d4522, palette: 'paint' },
  ];
  static STATS = MOUNT_STATS.horse;
```

Ctor fields before `this._build();`: `this._powerMul = 1; this._accelMul = 1; this._shieldTier = 0; this._livery = null; this._slotMats = null;`.

`_build()` after `const metal = ...` (`:261`): `this._slotMats = { coat: [coat], saddle: [tack] };` and `this.applyCustomization(this._livery);` at the end of `_build()`.

Speed (`:701-707`):

```js
    if (throttle > 0.05) target = (gallop ? GALLOP_SPEED : CRUISE_SPEED * throttle) * this._powerMul;
    else if (throttle < -0.05) target = CRUISE_SPEED * 0.28 * throttle;  // rein back

    const rate = target > this.speed ? ACCEL * this._accelMul : BRAKE;
    this.speed = damp(this.speed, target, rate * 0.35, dt);
    if (Math.abs(this.speed) < 0.05) this.speed = 0;
    this.speed = clamp(this.speed, -4, MAX_SPEED * this._powerMul);
```

Methods (before `dispose()`):

```js
  applyCustomization(livery) {
    this._livery = livery && typeof livery === 'object' ? livery : {};
    if (!this._slotMats) return;
    applyLivery(this._livery, Horse.CUSTOM_SLOTS, this._slotMats);
  }

  /** Same ladder as Car: +12% top speed and +10% acceleration per tier; shield stored. */
  applyPowers({ strength = 0, shield = 0, power = 0 } = {}) {
    this._powerMul = 1 + Math.max(0, power) * 0.12;
    this._accelMul = 1 + Math.max(0, strength) * 0.10;
    this._shieldTier = Math.max(0, shield);
  }

  get shieldTier() {
    return this._shieldTier;
  }
```

- [ ] **Step 2: Run** — powers test now fails at `hoverboard`. Commit.

```bash
git add src/mounts/Horse.js
git commit -m "Horse: coat/saddle livery slots and power tiers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 8: Hoverboard — deck/glow slots, powers

**Files:**
- Modify: `src/mounts/Hoverboard.js` (import; class head; ctor fields before `:703`; `:728-731` materials; after `:802`; `:998-1002` speed; `:1174` emitter tint; new methods; `dispose()` `:1351`)

- [ ] **Step 1: Implement**

Statics:

```js
  static CUSTOM_SLOTS = [
    { id: 'deck', label: 'Deck', finish: true, defaultColor: 0x2c2f36, palette: 'paint' },
    { id: 'glow', label: 'Underglow', finish: false, defaultColor: 0x7ff2ff, palette: 'glow' },
  ];
  static STATS = MOUNT_STATS.hoverboard;
```

(Set `deck.defaultColor` to the `mount.grip` library colour — read `ensureMaterials` at `:462-476`.)

Ctor fields before `_buildModel()`: `_powerMul/_accelMul/_shieldTier/_livery/_slotMats` as Horse, plus `this._glowBase = new THREE.Color(0x7ff2ff);`.

`_buildModel()` (`:728-731`) → clones:

```js
    this._gripMat = M.get('mount.grip').clone();
    this._carbonMat = M.get('mount.carbon').clone();
    this._trimMat = M.get('emissive.cyan').clone();
    const gripMat = this._gripMat;
    const carbonMat = this._carbonMat;
    const alloyMat = M.get('mount.alloy');
    const trimMat = this._trimMat;
```

After `this._glow = new THREE.Mesh(this._geo.glow, this._glowMat);` (`:802`) add:

```js
    this._slotMats = {
      deck: [this._gripMat, this._carbonMat],
      glow: [{ mat: this._trimMat, emissive: true }, this._flareMat, this._glowMat],
    };
    this.applyCustomization(this._livery);
```

Speed (`:998-1002`):

```js
    if (throttle > 0) targetSpeed = THREE.MathUtils.lerp(CRUISE_SPEED, BOOST_SPEED, this._boost) * this._powerMul;
    else if (throttle < 0) targetSpeed = -REVERSE_SPEED;
    const accel = throttle === 0 ? 3.4 : targetSpeed > this.speed ? (9.5 + this._boost * 7) * this._accelMul : 12;
```

Emitter tint (`:1174`): replace `this._emitterMat.color.setRGB(0.42 + this._boost * 0.55, 0.86, 1);` with `this._emitterMat.color.copy(this._glowBase).lerp(_WHITE, this._boost * 0.35);` and add `const _WHITE = new THREE.Color(0xffffff);` with the module constants.

Methods:

```js
  applyCustomization(livery) {
    this._livery = livery && typeof livery === 'object' ? livery : {};
    if (!this._slotMats) return;
    applyLivery(this._livery, Hoverboard.CUSTOM_SLOTS, this._slotMats);
    // The emitter is re-tinted every frame from this base (see the update loop).
    this._glowBase.setHex(normColor(this._livery.glow?.color) ?? 0x7ff2ff);
  }

  applyPowers({ strength = 0, shield = 0, power = 0 } = {}) {
    this._powerMul = 1 + Math.max(0, power) * 0.12;
    this._accelMul = 1 + Math.max(0, strength) * 0.10;
    this._shieldTier = Math.max(0, shield);
  }

  get shieldTier() {
    return this._shieldTier;
  }
```

(import `normColor` alongside `applyLivery, MOUNT_STATS`.)

`dispose()`: add `this._gripMat.dispose(); this._carbonMat.dispose(); this._trimMat.dispose();`.

- [ ] **Step 2: Run** — powers test now fails at `bicycle`. Commit.

```bash
git add src/mounts/Hoverboard.js
git commit -m "Hoverboard: deck/underglow livery slots and power tiers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 9: Bicycle — frame/rims slots, powers

**Files:**
- Modify: `src/mounts/Bicycle.js` (import; class head; ctor before `:322`; `_build` `:364-367`; `:795-817` speed; new methods)

- [ ] **Step 1: Implement**

Statics:

```js
  static CUSTOM_SLOTS = [
    { id: 'frame', label: 'Frame', finish: true, defaultColor: 0x2f7fd4, palette: 'paint' },
    { id: 'rims', label: 'Rims & metalwork', finish: true, defaultColor: 0xb9bfc7, palette: 'wheel' },
  ];
  static STATS = MOUNT_STATS.bicycle;
```

Ctor fields as Horse; `_build()` after `const trim = ...`: `this._slotMats = { frame: [paint], rims: [alloy] };` and `this.applyCustomization(this._livery);` at the end of `_build()`.

Speed:
- `:795` `const top = (sprint ? SPRINT_SPEED : CRUISE_SPEED) * this._powerMul;`
- `:801` `drive = throttle * PEDAL_ACCEL * this._accelMul * head * (sprint ? 1.55 : 1);`
- `:814` (`const drag = (ROLL_DRAG + AIR_DRAG * this.speed * this.speed) * dt;`) → `const drag = (ROLL_DRAG + (AIR_DRAG / (this._powerMul * this._powerMul)) * this.speed * this.speed) * dt;` — like the eagle, the bike's top speed is drag-limited; scaling `top` alone yields only ~+15% at tier III (measured 8.64 → 9.97), so the air-drag term scales too (→ ~×1.36 at 60 Hz).
- `:817` `this.speed = clamp(this.speed, -REVERSE_SPEED, MAX_SPEED * this._powerMul);`

Methods: copy Horse's three (`applyCustomization` with `Bicycle.CUSTOM_SLOTS`, `applyPowers`, `get shieldTier`).

- [ ] **Step 2: Run** `node --test scripts/tests/mount-powers.test.mjs` → all PASS; `npm test` → PASS.

- [ ] **Step 3: Commit**

```bash
git add src/mounts/Bicycle.js
git commit -m "Bicycle: frame/rims livery slots and power tiers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 10: Armour actually reduces rider damage; Dragon Fire scales fireballs

**Files:**
- Modify: `src/player/Player.js` (constructor field; `:1246-1250` `applyDamage`)
- Modify: `src/systems/Combat.js` (`:138-160` ctor field; `:425` multiplier; new getter)
- Modify: `src/main.js` (after `const mounts = ...` at `:195`)
- Test: `scripts/tests/mount-powers.test.mjs`

- [ ] **Step 1: Add failing tests**

```js
import { Player } from '../../src/player/Player.js';
import { CombatSystem } from '../../src/systems/Combat.js';

test('a mounted rider with Armour tiers takes 10% less damage per tier', () => {
  const p = Object.create(Player.prototype);
  Object.assign(p, { _dead: false, _elapsed: 10, _invulnUntil: 0, _health: 100, _maxHealth: 100, _lastDamageAt: 0, _regenCarry: 0, bus: { emit() {} }, _die() {} });
  p.mounts = { mounted: true, active: { id: 'horse', shieldTier: 2 } };
  assert.equal(p.applyDamage(50), 40);
  p.mounts = { mounted: false, active: null };
  assert.equal(p.applyDamage(50), 50);
});

test('Combat.mountFireMul is 1 unless riding a dragon with Fire tiers', () => {
  const c = Object.create(CombatSystem.prototype);
  c.mounts = null;
  assert.equal(c.mountFireMul, 1);
  c.mounts = { mounted: true, active: { id: 'car', fireTier: 3 } };
  assert.equal(c.mountFireMul, 1);
  c.mounts = { mounted: true, active: { id: 'dragon', fireTier: 2 } };
  assert.ok(Math.abs(c.mountFireMul - 1.3) < 1e-9);
});
```

(`Player` and `CombatSystem` are the verified export names.)

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

`Player.js` constructor: `/** Set by main.js once MountManager exists; Armour tiers read through it. */ this.mounts = null;`. In `applyDamage`, after the invulnerability check:

```js
    // Purchased Armour on the mount being ridden: -10% per tier.
    const shield = this.mounts?.mounted ? Math.max(0, Number(this.mounts.active?.shieldTier) || 0) : 0;
    if (shield > 0) amount *= Math.max(0.1, 1 - 0.10 * shield);
```

`Combat.js`: constructor `this.mounts = null;` (same comment). Add:

```js
  /** Dragon Fire tiers: +15% fireball damage per tier while riding the dragon. */
  get mountFireMul() {
    const m = this.mounts;
    if (!m?.mounted || m.active?.id !== 'dragon') return 1;
    return 1 + 0.15 * Math.max(0, Number(m.active.fireTier) || 0);
  }
```

`:425` after `if (byPlayer) amount *= this._playerDamageMul;` add `if (byPlayer && weaponId === 'fireball') amount *= this.mountFireMul;`.

`main.js` right after `const mounts = new MountManager(...)`:

```js
// Late injection: Player and Combat are built before the mounts exist, and both
// read purchased mount tiers (Armour, Dragon Fire) through this reference.
player.mounts = mounts;
combat.mounts = mounts;
```

- [ ] **Step 4: Run** `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/player/Player.js src/systems/Combat.js src/main.js scripts/tests/mount-powers.test.mjs
git commit -m "Mount Armour reduces rider damage; Dragon Fire scales fireballs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 11: HUD FIR pip

**Files:**
- Modify: `src/ui/HUD.js:50` (`POWER_LABELS`), `:2009` (loop), `src/ui/hud.css:3828` (add `.mount-pip.fire`)

- [ ] **Step 1: Implement**

`HUD.js:50`: `const POWER_LABELS = { power: 'PWR ', strength: 'STR ', shield: 'SHD ', fire: 'FIR ' };`
`HUD.js:2009`: `for (const key of ['power', 'strength', 'shield', 'fire']) {`
`hud.css` after `.mount-pip.power {...}`:

```css
.mount-pip.fire {
  color: #ffe6d6;
  background: rgba(255, 106, 58, 0.18);
  border-color: rgba(255, 106, 58, 0.55);
  text-shadow: 0 0 8px rgba(255, 106, 58, 0.6);
}
```

- [ ] **Step 2:** `npm run build` → PASS. Commit.

```bash
git add src/ui/HUD.js src/ui/hud.css
git commit -m "HUD: FIR pip for the dragon's Fire tier

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Chunk 3: Skin items, `applyMountSkin`, ItemUse/InventoryUI, Marketplace guard

### Task 12: `ItemDefs` — `kind:'skin'` items generated from `MOUNT_SKINS`

**Files:**
- Modify: `src/systems/ItemDefs.js` (`:14-22` kinds/accents; after the `ITEMS` literal; `itemIconSVG`; `ICONS`)
- Test: `scripts/tests/mount-liveries.test.mjs`

- [ ] **Step 1: Failing test**

```js
import { itemDef, skinItemId, skinIdFromItem, itemIconSVG, KIND_ACCENT } from '../../src/systems/ItemDefs.js';

test('every mount skin has a stack-1 kind:skin item and the id helpers round-trip', () => {
  assert.ok(KIND_ACCENT.skin);
  for (const s of MOUNT_SKINS) {
    const iid = skinItemId(s.id);
    assert.equal(iid, `skin_${s.id}`);
    const def = itemDef(iid);
    assert.ok(def, iid);
    assert.equal(def.kind, 'skin');
    assert.equal(def.stack, 1);
    assert.equal(skinIdFromItem(iid), s.id);
    assert.ok(itemIconSVG(iid).includes('<svg'));
  }
  assert.equal(skinIdFromItem('medkit'), null);
  assert.equal(skinIdFromItem('skin_not_a_skin'), null);
});
```

- [ ] **Step 2: Run** → FAIL (`skinItemId` not exported).

- [ ] **Step 3: Implement**

Top of `ItemDefs.js`: `import { MOUNT_SKINS } from './Cosmetics.js';` (no cycle: Cosmetics imports nothing from ItemDefs).

`:14`: `/** @typedef {'ammo'|'consumable'|'trinket'|'currency'|'skin'} ItemKind */`; `KIND_ACCENT`: add `skin: '#ff9ad5',`.

Immediately after the `ITEMS` literal closes:

```js
/** Bag item id for a mount skin id. */
export function skinItemId(skinId) {
  return `skin_${skinId}`;
}

/** Skin id for a bag item id, or null if the item is not a skin. */
export function skinIdFromItem(itemId) {
  if (typeof itemId !== 'string' || !itemId.startsWith('skin_')) return null;
  const def = ITEMS[itemId];
  return def && def.kind === 'skin' ? def.skinId : null;
}

/*
 * One bag item per mount skin. Bought at a merchant (`grant_item`), it sits in
 * the bag until applied from the Mount menu (F10) or the inventory Use button,
 * which consumes it and burns the skin into the Cosmetics ledger.
 */
for (const skin of MOUNT_SKINS) {
  const colors = Object.values(skin.livery).map((v) => v.color).filter((c) => typeof c === 'number');
  ITEMS[skinItemId(skin.id)] = {
    id: skinItemId(skin.id),
    name: `${skin.name} Skin`,
    short: 'SKN',
    stack: 1,
    icon: 'skin',
    value: 200,
    kind: 'skin',
    skinId: skin.id,
    colors,
    desc: `${skin.blurb} Apply to your ${skin.mount} from the Mount menu (F10) while riding; one use.`,
  };
}
```

Also: extend the `ITEMS` JSDoc record type with `skinId?:string, colors?:number[]`; extend the `ICONS` JSDoc (`:529`) to `(g:string, a:string, def?:object) => string`; add `skin: 8` to `KIND_ORDER` in `src/systems/Inventory.js:581` (sorts before the trailing default); add `.inv-slot.kind-skin { box-shadow: inset 0 -2px 0 rgba(255, 154, 213, 0.45); }` next to the other `kind-*` rules in `src/ui/inventory.css:501-504` (same shape as its siblings - nothing there reads a `--accent` variable); add `'skin'` to `ACCENT_PRIORITY` in `src/systems/Loot.js:94` so a dropped skin pickup gets its own accent.

`itemIconSVG`: `const body = ICONS[key]?.(g, accent, ITEMS[id]) ?? ICONS.unknown(g, accent);` and add to `ICONS` before `unknown`:

```js
  skin: (g, a, def) => {
    const [c1 = 0x888888, c2 = c1] = def?.colors ?? [];
    const hex = (c) => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;
    return `
    <rect x="5" y="5" width="22" height="22" rx="4" fill="${hex(c1)}" stroke="${a}" stroke-width="1"/>
    <path d="M27 5 L27 27 L5 27 z" fill="${hex(c2)}" opacity="0.95"/>
    <path d="M9 22 q7 -9 14 -12" stroke="#ffffff" stroke-width="1.2" fill="none" opacity="0.55"/>`;
  },
```

- [ ] **Step 4:** `npm test` → PASS. Commit.

```bash
git add src/systems/ItemDefs.js src/systems/Inventory.js src/systems/Loot.js src/ui/inventory.css scripts/tests/mount-liveries.test.mjs
git commit -m "ItemDefs: kind:'skin' bag items generated from MOUNT_SKINS

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 13: `src/systems/MountSkins.js` — `applyMountSkin`

**Files:**
- Create: `src/systems/MountSkins.js`
- Test: `scripts/tests/mount-liveries.test.mjs`

- [ ] **Step 1: Failing tests**

```js
import { applyMountSkin } from '../../src/systems/MountSkins.js';

function skinDeps({ mounted = 'dragon', owned = [], bag = {}, store = {} } = {}) {
  const liveries = {};
  const unlocked = new Set(owned);
  const mounts = {
    get mounted() { return !!mounted; },
    get active() { return mounted ? { id: mounted } : null; },
    setLivery: (id, patch) => { liveries[id] = { ...(liveries[id] || {}), ...patch }; },
  };
  const cosmetics = { has: (id) => unlocked.has(id), unlock: (id) => { if (unlocked.has(id)) return false; unlocked.add(id); return true; } };
  const inventory = {
    bagCount: (id) => bag[id] ?? 0,
    count: (id) => store[id] ?? 0,
    totalCount: (id) => (bag[id] ?? 0) + (store[id] ?? 0),
    consumeFromBag: (id, n) => { if ((bag[id] ?? 0) < n) return false; bag[id] -= n; return true; },
    remove: (id, n) => { const k = Math.min(n, store[id] ?? 0); store[id] = (store[id] ?? 0) - k; return k; },
  };
  return { deps: { mounts, cosmetics, inventory, bus: { emit() {} } }, liveries, unlocked, bag, store };
}

test('applyMountSkin: unknown / not mounted / wrong mount refuse and consume nothing', () => {
  assert.equal(applyMountSkin(skinDeps().deps, 'nope').reason, 'unknown-skin');
  assert.equal(applyMountSkin(skinDeps({ mounted: null }).deps, 'dragon_frost').reason, 'not-mounted');
  const s = skinDeps({ mounted: 'horse', bag: { skin_dragon_frost: 1 } });
  assert.equal(applyMountSkin(s.deps, 'dragon_frost').reason, 'wrong-mount');
  assert.equal(s.bag.skin_dragon_frost, 1);
});

test('applyMountSkin: owned applies without touching the inventory', () => {
  const s = skinDeps({ owned: ['dragon_frost'], bag: { skin_dragon_frost: 1 } });
  assert.deepEqual(applyMountSkin(s.deps, 'dragon_frost'), { ok: true, consumed: false });
  assert.equal(s.bag.skin_dragon_frost, 1);
  assert.equal(s.liveries.dragon.hide.color, 0xbfe6f2);
});

test('applyMountSkin: in bag consumes exactly one, unlocks, applies', () => {
  const s = skinDeps({ bag: { skin_dragon_frost: 2 } });
  assert.deepEqual(applyMountSkin(s.deps, 'dragon_frost'), { ok: true, consumed: true });
  assert.equal(s.bag.skin_dragon_frost, 1);
  assert.ok(s.unlocked.has('dragon_frost'));
  assert.equal(s.liveries.dragon.saddle.color, 0x1f6fd0);
});

test('applyMountSkin: only in store consumes one from the store', () => {
  const s = skinDeps({ store: { skin_dragon_frost: 1 } });
  assert.deepEqual(applyMountSkin(s.deps, 'dragon_frost'), { ok: true, consumed: true });
  assert.equal(s.store.skin_dragon_frost, 0);
  assert.ok(s.unlocked.has('dragon_frost'));
});

test('applyMountSkin: neither owned nor held refuses with not-owned', () => {
  const s = skinDeps();
  assert.equal(applyMountSkin(s.deps, 'dragon_frost').reason, 'not-owned');
  assert.equal(s.unlocked.size, 0);
});
```

- [ ] **Step 2: Run** → FAIL (module missing).

- [ ] **Step 3: Implement** `src/systems/MountSkins.js`:

```js
import { MOUNT_SKINS_BY_ID } from './Cosmetics.js';
import { skinItemId } from './ItemDefs.js';

/**
 * "Wear a mount skin" - the one path both the F10 menu and the inventory Use
 * button go through. Stateless: every collaborator is passed in, so it is
 * indifferent to construction order in main.js and trivial to test.
 *
 * Owned (burned in) → just re-apply. Otherwise take one copy from the
 * inventory - bag first, then store - unlock it in the ledger, then apply. A
 * skin is only ever consumed on a successful apply.
 *
 * @param {{mounts:any, cosmetics:any, inventory:any, bus?:any}} deps
 * @param {string} skinId
 * @returns {{ok:boolean, reason?:'unknown-skin'|'not-mounted'|'wrong-mount'|'not-owned', consumed?:boolean}}
 */
export function applyMountSkin({ mounts, cosmetics, inventory }, skinId) {
  const skin = MOUNT_SKINS_BY_ID.get(skinId);
  if (!skin) return { ok: false, reason: 'unknown-skin' };
  if (!mounts?.mounted || !mounts.active) return { ok: false, reason: 'not-mounted' };
  if (mounts.active.id !== skin.mount) return { ok: false, reason: 'wrong-mount' };

  if (cosmetics?.has?.(skinId)) {
    mounts.setLivery(skin.mount, skin.livery);
    return { ok: true, consumed: false };
  }

  const itemId = skinItemId(skinId);
  let taken = false;
  if (inventory?.consumeFromBag?.(itemId, 1)) taken = true;
  else if ((inventory?.remove?.(itemId, 1) ?? 0) > 0) taken = true;
  if (!taken) return { ok: false, reason: 'not-owned' };

  cosmetics?.unlock?.(skinId);
  mounts.setLivery(skin.mount, skin.livery);
  return { ok: true, consumed: true };
}
```

- [ ] **Step 4:** `npm test` → PASS. Commit.

```bash
git add src/systems/MountSkins.js scripts/tests/mount-liveries.test.mjs
git commit -m "MountSkins: applyMountSkin consumes a bag/store copy and burns it in

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 14: `ItemUse` skin branch + `InventoryUI` Use button for skins

**Files:**
- Modify: `src/systems/ItemUse.js:1-36`
- Modify: `src/ui/InventoryUI.js:331`
- Modify: `src/main.js:211-217` (construct `Cosmetics` before `ItemUseSystem`; pass `mounts, cosmetics`)

- [ ] **Step 1: Failing test**

```js
import { ItemUseSystem } from '../../src/systems/ItemUse.js';

test('ItemUse routes skin items through applyMountSkin and never the generic consume', () => {
  const s = skinDeps({ bag: { skin_dragon_frost: 1 } });
  const notes = [];
  const iu = new ItemUseSystem({ bus: { emit: (n, p) => notes.push([n, p]) }, player: {}, inventory: s.deps.inventory, mounts: s.deps.mounts, cosmetics: s.deps.cosmetics });
  assert.equal(iu.use('skin_dragon_frost').ok, true);
  assert.equal(s.bag.skin_dragon_frost, 0);
  assert.ok(notes.some(([n, p]) => n === 'inventory:item-used' && p.itemId === 'skin_dragon_frost'));
  const s2 = skinDeps({ mounted: null, bag: { skin_dragon_frost: 1 } });
  const notes2 = [];
  const iu2 = new ItemUseSystem({ bus: { emit: (n, p) => notes2.push([n, p]) }, player: {}, inventory: s2.deps.inventory, mounts: s2.deps.mounts, cosmetics: s2.deps.cosmetics });
  assert.equal(iu2.use('skin_dragon_frost').ok, false);
  assert.equal(s2.bag.skin_dragon_frost, 1);
  assert.ok(notes2.some(([n, p]) => n === 'hud:notify' && /F10/.test(p.text)));
});
```

- [ ] **Step 2: Run** → FAIL (`use` returns `unsupported`).

- [ ] **Step 3: Implement**

`ItemUse.js` imports: `import { itemDef, skinIdFromItem } from './ItemDefs.js'; import { applyMountSkin } from './MountSkins.js'; import { MOUNT_SKINS_BY_ID } from './Cosmetics.js';`. Constructor gains `mounts, cosmetics` → `this.mounts = mounts ?? null; this.cosmetics = cosmetics ?? null;`.

In `use()`, after the `unavailable` guard and before `_effectFor`:

```js
    // Mount skins are not effects: they are consumed by applyMountSkin only on
    // a successful apply, so they must never reach the generic consume below.
    if (itemDef(itemId)?.kind === 'skin') return this._useSkin(itemId);
```

Method:

```js
  _useSkin(itemId) {
    const skinId = skinIdFromItem(itemId);
    const skin = skinId ? MOUNT_SKINS_BY_ID.get(skinId) : null;
    if (!skin) return { ok: false, reason: 'unsupported' };
    const res = applyMountSkin({ mounts: this.mounts, cosmetics: this.cosmetics, inventory: this.inventory, bus: this.bus }, skinId);
    if (!res.ok) {
      const text = res.reason === 'not-mounted' || res.reason === 'wrong-mount'
        ? `Mount your ${skin.mount} and press F10 to apply this skin`
        : 'This skin cannot be applied right now';
      this.bus?.emit('hud:notify', { text, tone: 'warn' });
      return { ok: false, reason: res.reason };
    }
    this.bus?.emit('inventory:item-used', { itemId, effect: 'skin', amount: 1 });
    this.bus?.emit('hud:notify', { text: `${skin.name} applied to your ${skin.mount}`, tone: 'info' });
    return { ok: true, consumed: res.consumed };
  }
```

`InventoryUI.js:331`: `const usable = !!def && inBag && (def.kind === 'consumable' || def.kind === 'skin');`

`main.js`: move `const cosmetics = new Cosmetics({ bus });` (with its comment) above the `itemUse` line; `new ItemUseSystem({ bus, player, inventory, loot, portals, npcManager, combat, mounts, cosmetics })`. Reword the Cosmetics comment: "worn from the F2 (character) or F10 (mount) menu".

- [ ] **Step 4:** `npm test && npm run build` → PASS. Commit.

```bash
git add src/systems/ItemUse.js src/ui/InventoryUI.js src/main.js scripts/tests/mount-liveries.test.mjs
git commit -m "Inventory Use applies mount skins via applyMountSkin

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 15: `Marketplace.preview` refuses a held/unlocked skin; UI strings branch by kind

**Files:**
- Modify: `src/systems/Marketplace.js:396-406` (grant branch), `:414-418` (buy early return)
- Modify: `src/ui/MarketplaceUI.js:379`, `:441`
- Test: `scripts/tests/mount-liveries.test.mjs`

- [ ] **Step 1: Failing test**

```js
import { Marketplace } from '../../src/systems/Marketplace.js';

test('Marketplace.preview refuses a skin item that is already unlocked or already held', () => {
  const held = { skin_bike_chrome: 0 };
  const inventory = { roomFor: () => 30, totalCount: (id) => held[id] ?? 0, count: () => 0, bagCount: () => 0 };
  const cosmetics = { has: (id) => id === 'bike_racing' };
  const m = Object.create(Marketplace.prototype);
  // `credits` is a prototype getter over economy.credits, so this is enough.
  Object.assign(m, { economy: { credits: 9999 }, inventory, cosmetics, mounts: null, bus: null });
  const row = (item) => ({ id: 'x', source_key: 'skin_x', quantity: null, cost_buy: 100, action_config: { effect: 'grant_item', item_id: item } });
  assert.equal(m.preview(row('skin_bike_chrome')).ok, true);
  held.skin_bike_chrome = 1;
  const p = m.preview(row('skin_bike_chrome'));
  assert.equal(p.ok, false); assert.equal(p.reason, 'owned'); assert.equal(p.skin, true);
  const q = m.preview(row('skin_bike_racing'));
  assert.equal(q.ok, false); assert.equal(q.reason, 'owned'); assert.equal(q.skin, true);
  assert.equal(m.preview(row('medkit')).ok, true);
});
```

- [ ] **Step 2: Run** → FAIL (held skin previews `ok:true`).

- [ ] **Step 3: Implement**

`Marketplace.js:1` already imports from `./ItemDefs.js` — add `skinIdFromItem` to that import. In `preview`, after `if (!grant) return ...unsupported`:

```js
    // A mount skin is one-per-player: refuse when it is burned in already or a
    // copy is still sitting in the bag/store, so nobody buys a second one.
    const skinId = skinIdFromItem(grant.itemId);
    if (skinId && (this.cosmetics?.has?.(skinId) || (this.inventory.totalCount?.(grant.itemId) ?? 0) > 0)) {
      return { ok: false, reason: 'owned', skin: true, stock, grant, cost };
    }
```

`buy()`: `if (!preview.ok) return { ok: false, reason: preview.reason ?? 'unavailable', skin: preview.skin === true };`

`MarketplaceUI.js:379`: `: owned ? (preview.skin ? 'You already have this skin — apply it from the Mount menu (F10) while riding' : 'Already unlocked — equip it in the Character menu (F2)')`
`MarketplaceUI.js:441`: `res.reason === 'owned' ? (res.skin ? 'You already have this skin — apply it from the Mount menu (F10) while riding' : 'You already own this skin — equip it in the Character menu (F2)') :`
`MarketplaceUI.js:363-369` (`grantLabel`): a refused skin would fall to "1 item per buy" beside an Owned button; add a first branch `preview.skin && preview.reason === 'owned' ? 'Owned' :`. Also add `mount_skin: ['🎨', '#ff8a5c']` to `ACTION_ART` in the same file so skin rows do not fall back to the generic mount icon.

- [ ] **Step 4:** `npm test` → PASS. Commit.

```bash
git add src/systems/Marketplace.js src/ui/MarketplaceUI.js scripts/tests/mount-liveries.test.mjs
git commit -m "Marketplace: one copy per mount skin; F10 hints for skin items

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Chunk 4: The F10 Mount Menu, F2 cleanup, wiring

### Task 16: `src/ui/MountMenuLogic.js`, `src/ui/MountMenu.js`, `mount-menu.css`

**Files:**
- Create: `src/ui/mount-menu.css` (derived from `character.css`), `src/ui/MountMenuLogic.js`, `src/ui/MountMenu.js`
- Test: `scripts/tests/mount-menu.test.mjs` (pure-logic checks; DOM is not available headlessly)

- [ ] **Step 1: Generate the stylesheet**

```bash
# Order matters: the body-class rewrite must run BEFORE the generic `.ch-` one,
# or `body.ch-menu-open` becomes `body.mm-menu-open` and never matches.
sed -e 's/ch-menu-open/mm-open/g' -e 's/\.ch-/.mm-/g' -e 's/--ch-/--mm-/g' src/ui/character.css > src/ui/mount-menu.css
grep -n "body.mm-open .pause" src/ui/mount-menu.css   # must print one line
```

Then rewrite the header comment block at the top of `mount-menu.css` to: `/* Mount menu (F10) - derived from character.css; keep the two in step. */`.

Append to `src/ui/mount-menu.css`:

```css
/* ---- Mount menu extras: upgrade pips and the "in inventory" card state ---- */
.mm-stat { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; align-items: center; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
.mm-stat:last-child { border-bottom: 0; }
.mm-stat-l { font-weight: 700; letter-spacing: 0.06em; }
.mm-stat-fx { grid-column: 1 / -1; font-size: 11px; opacity: 0.75; }
.mm-pips { display: inline-flex; gap: 4px; }
.mm-pip { width: 18px; height: 8px; border: 1px solid rgba(255,255,255,0.28); background: rgba(255,255,255,0.06); }
.mm-pip.on { background: var(--mm-accent, #52e9ff); border-color: var(--mm-accent, #52e9ff); box-shadow: 0 0 8px rgba(82,233,255,0.5); }
.mm-skincard.held .mm-skinlock { color: #b6ff5a; }
.mm-finish { margin-top: 6px; }
```

- [ ] **Step 2: Failing test for the pure helpers** — create `scripts/tests/mount-menu.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PALETTES, statLine, skinState } from '../../src/ui/MountMenuLogic.js';

test('every palette the mounts reference exists and is non-empty', () => {
  for (const k of ['paint', 'wheel', 'natural', 'glow']) assert.ok(PALETTES[k]?.length >= 6, k);
});

test('statLine reads the tier ladder', () => {
  assert.equal(statLine('power', 0), 'Not upgraded — buy at market (B)');
  assert.equal(statLine('power', 2), '+24% top speed');
  assert.equal(statLine('fire', 3), '+45% fireball damage while riding');
});

test('skinState: equipped > owned > held > locked', () => {
  const skin = { id: 'bike_racing', livery: { frame: { color: 0xc21f2f, finish: 'gloss' }, rims: { color: 0x0d0f12, finish: 'matt' } } };
  const eq = { frame: { color: 0xc21f2f, finish: 'gloss' }, rims: { color: 0x0d0f12, finish: 'matt' } };
  assert.equal(skinState({ skin, owned: true, held: 0, livery: eq }), 'equipped');
  assert.equal(skinState({ skin, owned: true, held: 0, livery: {} }), 'owned');
  assert.equal(skinState({ skin, owned: false, held: 1, livery: eq }), 'held');
  assert.equal(skinState({ skin, owned: false, held: 0, livery: {} }), 'locked');
});
```

- [ ] **Step 3: Run** → FAIL (module missing).

- [ ] **Step 4: Create `src/ui/MountMenuLogic.js`**

```js
import { STAT_META, liveryMatches } from '../mounts/Livery.js';

/** Swatch palettes by slot `palette` key. First entry of paint/wheel is the car factory colour. */
export const PALETTES = {
  paint: [
    0x2b3d55, 0x14181f, 0x2c2f36, 0xb9c2cc, 0xe6e9ee,
    0xc21f2f, 0xf27b1f, 0xffd23b, 0x18a86b, 0x1f6fd0,
    0x6a2fd0, 0xff3bd2, 0x00c2b0, 0x9a4433,
    // factory tack/leather/frame for dragon saddle, eagle harness, horse saddle, bicycle frame
    0x6d4522, 0x5a3a24, 0x2f7fd4,
  ],
  wheel: [
    0xb9c2cc, 0x2a2e33, 0x0d0f12, 0xd9dde2, 0xf2f4f6,
    0xc9a24a, 0xe0b23a, 0xc21f2f, 0x1f6fd0, 0x18a86b,
    0xff6a3a, 0x8f2fd0,
    0xb9bfc7, // bicycle factory rims
  ],
  // Every mount's factory colour for a slot must appear in that slot's palette,
  // or a factory mount opens with the custom picker lit. Car: paint[0]/wheel[0];
  // dragon hide 0x2b3a2e; eagle plumage 0x6b4c30; horse coat 0x8a6242.
  natural: [
    0x8a6242, 0x6b4c30, 0x2b3a2e, 0x4a3626, 0x2a1d13, 0x141216, 0xd6b26a,
    0xe6e6ea, 0x9a9aa0, 0x1f6b3a, 0x7a2a1a, 0x3a4a5c, 0xbfe6f2, 0xc98a2b,
  ],
  glow: [
    0x7ff2ff, 0x2fe0ff, 0x3bffd2, 0xa8ff3b, 0xffe14a, 0xffae2b,
    0xff6a3a, 0xff3bd2, 0x8f2fd0, 0x1f6fd0, 0xffffff, 0xff2b2b,
  ],
};

/** One-line effect copy for a stat at a tier. */
export function statLine(stat, tier) {
  const meta = STAT_META[stat];
  if (!meta) return '';
  const t = Math.max(0, Math.floor(Number(tier) || 0));
  if (t <= 0) return 'Not upgraded — buy at market (B)';
  return `+${meta.perTier * t}% ${meta.unit}`;
}

/** Card state for a skin: 'equipped' | 'owned' | 'held' | 'locked'. */
export function skinState({ skin, owned, held, livery }) {
  if (owned && liveryMatches(livery, skin.livery)) return 'equipped';
  if (owned) return 'owned';
  if (held > 0) return 'held';
  return 'locked';
}

export const SKIN_STATE_LABEL = {
  equipped: 'Equipped',
  owned: 'Owned',
  held: 'In inventory — Apply',
  locked: '🔒 Market',
};
```

- [ ] **Step 5: Create `src/ui/MountMenu.js`**

```js
import './mount-menu.css';
import { skinsForMount } from '../systems/Cosmetics.js';
import { skinItemId } from '../systems/ItemDefs.js';
import { applyMountSkin } from '../systems/MountSkins.js';
import { STAT_META } from '../mounts/Livery.js';
import { PALETTES, statLine, skinState, SKIN_STATE_LABEL } from './MountMenuLogic.js';

/**
 * F10 - the mount panel.
 *
 * A structural twin of `CharacterMenu` (right-side drawer over the live third-
 * person view, capture-phase F10/Escape, text capture + pointer release while
 * open) but rendered *generically*: it reads the ridden mount's
 * `CUSTOM_SLOTS` / `STATS` and the skins catalogued for it, so a seventh mount
 * needs no menu code. It only opens while mounted. Mounting forces third person,
 * but `V` can flip back to first while riding, so the drawer forces third
 * person for the preview and restores the rider's choice on close, like F2.
 *
 * Skins: owned → apply; a copy in the bag/store → apply and consume (burned in
 * from then on); neither → point at the market. Upgrades are read-only pips.
 */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
const hexStr = (v) => `#${(v & 0xffffff).toString(16).padStart(6, '0')}`;
/** 6 bits a channel, like F2: material caches never evict. */
const quantise = (v) => v & 0xfcfcfc;

export class MountMenu {
  /**
   * @param {{ root:HTMLElement, bus?:any, input?:any, mounts:any, cosmetics?:any, inventory?:any, player?:any }} ctx
   */
  constructor({ root, bus, input, mounts, cosmetics, inventory, player }) {
    this.bus = bus ?? null;
    this.input = input ?? null;
    this.mounts = mounts;
    this.cosmetics = cosmetics ?? null;
    this.inventory = inventory ?? null;
    this.player = player ?? null;

    this._open = false;
    this._hadLock = false;
    this._prevCameraMode = null;
    this._mountId = null;
    this._slots = [];
    this._stats = [];
    /** @type {Array<() => void>} */
    this._syncers = [];
    this._liveryCache = null;
    this._pending = null;
    this._pendingRaf = 0;

    this.el = this._buildShell();
    root.appendChild(this.el);

    this._offs = [];
    if (bus) {
      const resync = () => { if (this._open) this._sync(); };
      this._offs.push(bus.on('mount:livery', resync));
      this._offs.push(bus.on('mount:powers', resync));
      this._offs.push(bus.on('cosmetic:unlocked', resync));
      this._offs.push(bus.on('inventory:changed', resync));
      // A forced dismount (world change, portal) has already restored the rider's
      // pre-mount camera; do not overwrite it with the riding mode we saved.
      this._offs.push(bus.on('mount:dismounted', () => { this._prevCameraMode = null; this.close(); }));
    }
    this._onKey = (e) => this._key(e);
    window.addEventListener('keydown', this._onKey, true);
  }

  get isOpen() { return this._open; }

  /* ---------------------------------------------------------------- */
  /* Build                                                             */
  /* ---------------------------------------------------------------- */

  _buildShell() {
    const wrap = el('div', 'mm-root');
    const panel = el('aside', 'mm-panel interactive');
    const head = el('header', 'mm-head');
    const titles = el('div', 'mm-titles');
    this._kicker = el('div', 'mm-kicker', 'Mount');
    this._title = el('div', 'mm-title', 'MOUNT');
    titles.append(this._kicker, this._title);
    const close = el('button', 'mm-x');
    close.type = 'button';
    close.append(el('b', null, 'F10'), el('span', null, 'close'));
    close.addEventListener('click', () => this.close());
    head.append(titles, close);

    this._body = el('div', 'mm-body');

    const foot = el('footer', 'mm-foot');
    const reset = el('button', 'mm-btn ghost', 'Reset to factory');
    reset.type = 'button';
    reset.addEventListener('click', () => { if (this._mountId) this.mounts.resetLivery?.(this._mountId); });
    const hint = el('div', 'mm-hint');
    hint.innerHTML = 'Changes apply to the mount at once. <b>F5</b> saves them with the game.';
    foot.append(reset, hint);

    panel.append(head, this._body, foot);
    wrap.appendChild(panel);
    // A click inside the drawer must not re-lock the pointer or reach the world.
    panel.addEventListener('mousedown', (e) => e.stopPropagation());
    return wrap;
  }

  /** (Re)build the body for the mount being ridden. */
  _buildFor(mount) {
    this._mountId = mount.id;
    const C = mount.constructor;
    this._slots = Array.isArray(C.CUSTOM_SLOTS) ? C.CUSTOM_SLOTS : [];
    this._stats = Array.isArray(C.STATS) ? C.STATS : [];
    this._syncers = [];
    this._body.textContent = '';
    this._title.textContent = mount.displayName || mount.id.toUpperCase();

    for (const slot of this._slots) {
      this._body.appendChild(this._section(slot.label, `mm-slot mm-slot-${slot.id}`, (host, sec) => {
        host.appendChild(this._swatches(slot));
        if (slot.finish) host.appendChild(this._finishChips(slot));
        this._syncers.push(() => {
          const f = this._slotFinish(slot);
          sec.dataset.value = `${hexStr(this._slotColor(slot))}${f ? ` · ${f}` : ''}`;
        });
      }));
    }

    const skins = skinsForMount(mount.id);
    if (skins.length) {
      this._body.appendChild(this._section('Signature skins', 'mm-skins', (host) => {
        host.appendChild(this._skinCards(skins));
      }));
    }

    if (this._stats.length) {
      this._body.appendChild(this._section('Upgrades', 'mm-upgrades', (host) => {
        for (const stat of this._stats) host.appendChild(this._statRow(stat));
      }));
    }
    this._sync();
  }

  _section(title, cls, fill) {
    const sec = el('section', `mm-sec ${cls}`);
    const h = el('h3', 'mm-sec-t');
    h.append(el('span', null, title));
    sec.appendChild(h);
    const host = el('div', 'mm-sec-b');
    sec.appendChild(host);
    fill(host, sec);
    return sec;
  }

  /** Livery snapshot for the ridden mount; cached for the duration of one `_sync()`. */
  _livery() {
    if (this._liveryCache) return this._liveryCache;
    return this.mounts.getLivery?.(this._mountId) ?? {};
  }
  _slotColor(slot) { const c = this._livery()[slot.id]?.color; return typeof c === 'number' ? c : slot.defaultColor; }
  _slotFinish(slot) { return this._livery()[slot.id]?.finish ?? null; }

  _swatches(slot) {
    const colors = PALETTES[slot.palette] ?? PALETTES.paint;
    const row = el('div', 'mm-sws');
    for (const c of colors) {
      const b = el('button', 'mm-sw');
      b.type = 'button';
      b.style.setProperty('--c', hexStr(c));
      b.title = hexStr(c);
      b.addEventListener('click', () => this._setSlot(slot.id, { color: c }));
      row.appendChild(b);
      this._syncers.push(() => b.classList.toggle('on', this._slotColor(slot) === c));
    }
    const label = el('label', 'mm-pick');
    const input = el('input');
    input.type = 'color';
    input.setAttribute('aria-label', `Custom ${slot.label} colour`);
    input.addEventListener('input', () =>
      this._pick(slot.id, quantise(Number.parseInt(input.value.slice(1), 16) || 0)));
    label.append(input, el('i'));
    label.title = 'Custom colour';
    row.appendChild(label);
    this._syncers.push(() => {
      const hex = hexStr(this._slotColor(slot));
      if (document.activeElement !== input) input.value = hex;
      label.style.setProperty('--c', hex);
      label.classList.toggle('on', !colors.includes(this._slotColor(slot)));
    });
    return row;
  }

  _finishChips(slot) {
    const row = el('div', 'mm-chips mm-finish');
    for (const f of ['matt', 'gloss']) {
      const b = el('button', 'mm-chip', f === 'matt' ? 'Matt' : 'Gloss');
      b.type = 'button';
      b.addEventListener('click', () => this._setSlot(slot.id, { finish: this._slotFinish(slot) === f ? null : f }));
      row.appendChild(b);
      this._syncers.push(() => b.classList.toggle('on', this._slotFinish(slot) === f));
    }
    return row;
  }

  _skinCards(skins) {
    const grid = el('div', 'mm-skingrid');
    for (const skin of skins) {
      const card = el('button', 'mm-skincard');
      card.type = 'button';
      const dots = el('span', 'mm-skindots');
      for (const slot in skin.livery) {
        const dot = el('i', 'mm-skindot');
        dot.style.background = hexStr(skin.livery[slot].color);
        dots.appendChild(dot);
      }
      const text = el('span', 'mm-skintext');
      text.append(el('b', null, skin.name), el('small', null, skin.blurb));
      const lock = el('span', 'mm-skinlock');
      card.append(dots, text, lock);
      grid.appendChild(card);

      card.addEventListener('click', () => {
        const state = this._skinState(skin);
        if (state === 'locked') {
          this.bus?.emit('hud:notify', { text: `Buy the ${skin.name} skin at the market (B).`, tone: 'warn' });
          return;
        }
        const res = applyMountSkin({ mounts: this.mounts, cosmetics: this.cosmetics, inventory: this.inventory, bus: this.bus }, skin.id);
        if (!res.ok) this.bus?.emit('hud:notify', { text: 'That skin could not be applied.', tone: 'warn' });
        else if (res.consumed) this.bus?.emit('hud:notify', { text: `${skin.name} applied — it is yours to keep now.`, tone: 'info' });
        this._sync();
      });

      this._syncers.push(() => {
        const state = this._skinState(skin);
        card.classList.toggle('locked', state === 'locked');
        card.classList.toggle('held', state === 'held');
        card.classList.toggle('on', state === 'equipped');
        lock.textContent = SKIN_STATE_LABEL[state];
      });
    }
    return grid;
  }

  _skinState(skin) {
    return skinState({
      skin,
      owned: !!this.cosmetics?.has?.(skin.id),
      held: this.inventory?.totalCount?.(skinItemId(skin.id)) ?? 0,
      livery: this._livery(),
    });
  }

  _statRow(stat) {
    const meta = STAT_META[stat] ?? { label: stat };
    const row = el('div', `mm-stat mm-stat-${stat}`);
    const label = el('span', 'mm-stat-l', meta.label);
    const pips = el('span', 'mm-pips');
    const pipEls = [1, 2, 3].map((t) => { const p = el('i', 'mm-pip'); p.title = `${meta.label} ${'I'.repeat(t)}`; pips.appendChild(p); return p; });
    const fx = el('span', 'mm-stat-fx');
    row.append(label, pips, fx);
    this._syncers.push(() => {
      const tier = Math.floor(Number(this.mounts.getPowers?.(this._mountId)?.[stat]) || 0);
      pipEls.forEach((p, i) => p.classList.toggle('on', i < tier));
      fx.textContent = statLine(stat, tier);
    });
    return row;
  }

  /* ---------------------------------------------------------------- */
  /* State                                                             */
  /* ---------------------------------------------------------------- */

  _setSlot(slotId, patch) {
    if (!this._mountId) return;
    this.mounts.setLivery?.(this._mountId, { [slotId]: patch });
    this._sync();
  }

  /** Coalesced colour-picker write: one uniform write per frame. */
  _pick(slotId, color) {
    this._pending = { ...(this._pending ?? {}), [slotId]: { color } };
    if (this._pendingRaf) return;
    this._pendingRaf = requestAnimationFrame(() => {
      this._pendingRaf = 0;
      const patch = this._pending;
      this._pending = null;
      if (patch && this._mountId) { this.mounts.setLivery?.(this._mountId, patch); this._sync(); }
    });
  }

  _sync() {
    // One deep copy per sync, not one per swatch/chip/card.
    this._liveryCache = this._mountId ? (this.mounts.getLivery?.(this._mountId) ?? {}) : {};
    try { for (const fn of this._syncers) fn(); } finally { this._liveryCache = null; }
  }

  /* ---------------------------------------------------------------- */
  /* Open / close                                                      */
  /* ---------------------------------------------------------------- */

  open() {
    if (this._open) return;
    const mount = this.mounts?.mounted ? this.mounts.active : null;
    if (!mount) {
      this.bus?.emit('hud:notify', { text: 'Mount up first (M) to customise it', tone: 'warn' });
      return;
    }
    this._open = true;
    this._buildFor(mount);
    this._hadLock = !!this.input?.locked;
    this.input?.setTextCapture?.(true);
    this.input?.exitLock?.();
    document.body.classList.add('mm-open');
    // Third person is the preview; remember what the rider had so closing
    // puts them back rather than in a mode they did not choose.
    const rig = this.player?.cameraRig ?? null;
    this._prevCameraMode = rig?.mode ?? null;
    rig?.setMode?.('third');
    this.el.classList.add('open');
    this.bus?.emit('mount:menu:open', { mountId: mount.id });
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this.el.classList.remove('open');
    document.body.classList.remove('mm-open');
    const rig = this.player?.cameraRig ?? null;
    if (rig && this._prevCameraMode && this._prevCameraMode !== rig.mode) rig.setMode?.(this._prevCameraMode);
    this._prevCameraMode = null;
    this.input?.setTextCapture?.(false);
    if (this._hadLock) {
      // Browsers reject a lock request that follows an Escape-driven exit too
      // closely, and an uncaught rejection surfaces as a console error mid-game.
      setTimeout(() => {
        try {
          const p = this.input?.canvas?.requestPointerLock?.();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch { /* the pause overlay is the fallback */ }
      }, 140);
    }
    this.bus?.emit('mount:menu:close', {});
  }

  toggle() { if (this._open) this.close(); else this.open(); }

  _key(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.code === 'F10') {
      // F10 is the browser's menu-bar key: claim it before the browser does.
      e.preventDefault();
      e.stopPropagation();
      if (!this._open && this.input?.textCaptured) return;
      this.toggle();
      return;
    }
    if (e.code === 'Escape' && this._open) {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  }

  update() {}

  dispose() {
    this.close();
    window.removeEventListener('keydown', this._onKey, true);
    for (const off of this._offs) { try { off(); } catch { /* cleared bus */ } }
    this._offs.length = 0;
    if (this._pendingRaf) cancelAnimationFrame(this._pendingRaf);
    this._pendingRaf = 0;
    this.el?.remove();
  }
}
```

- [ ] **Step 6: Run** `node --test scripts/tests/mount-menu.test.mjs` → PASS; `npm run build` → PASS (CSS import resolves).

- [ ] **Step 7: Commit**

```bash
git add src/ui/MountMenu.js src/ui/MountMenuLogic.js src/ui/mount-menu.css scripts/tests/mount-menu.test.mjs
git commit -m "MountMenu: F10 drawer rendered from the ridden mount's slots, skins and tiers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 17: Wire F10 into `main.js`

(The F2 car-section removal already happened in Task 2 Step 3b.)

**Files:**
- Modify: `src/main.js` (new MountMenu construction after `:232`; `:438` GAME bundle; `:1450` update; `:1510-1511` gating)
- Modify: `src/ui/HUD.js:1226-1231` (overlay counter)

- [ ] **Step 1: main.js**

- Directly after the `characterMenu` construction:

```js
// F10. Customises the mount being ridden (colour slots, skins, upgrade tiers);
// generic over each mount's CUSTOM_SLOTS/STATS. Refuses to open on foot.
const mountMenu = new MountMenu({ root: uiRoot, bus, input, mounts, cosmetics, inventory, player });
```

  with `import { MountMenu } from './ui/MountMenu.js';` next to the `CharacterMenu` import.
- `:438` add `mountMenu,` after `characterMenu` in the `window.GAME` bundle.
- `:1450` add `mountMenu.update?.(dt);` after `characterMenu.update?.(dt);`.
- After `:1511`:

```js
bus.on('mount:menu:open', () => setGameplayBlocked('mount-menu', true));
bus.on('mount:menu:close', () => setGameplayBlocked('mount-menu', false));
```

- [ ] **Step 1b: HUD overlay counter** — `src/ui/HUD.js:1226-1231` registers `character:open/close`, `inventory:open/close`, `keybinds:open/close` with `_overlayOpen`/`_overlayClose` (suppresses the pause overlay while a drawer is up, hides the objective tracker, relocks on close). Add, in the same block:

```js
    this._on('mount:menu:open', () => _overlayOpen());
    this._on('mount:menu:close', () => _overlayClose());
```

(match the exact call shape used by the neighbouring `character:open/close` lines).

- [ ] **Step 2: Verify** `npm run build && npm test` → PASS. `grep -rn "VEHICLE_SKINS\|_liverySwatches\|CAR_PAINT_COLORS" src` → no hits.

- [ ] **Step 3: Commit**

```bash
git add src/main.js src/ui/HUD.js
git commit -m "F10 mount menu wired into main, HUD overlay and gameplay gating

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Chunk 5: Catalog rows, catalog test, discoverability, smoke

### Task 18: Marketplace catalog — 48 upgrade rows, 15 skin rows, car liveries → `grant_item`

**Files:**
- Modify: `site/lib/marketplaceCatalog.ts` (`MARKETPLACE_ACTIONS` `:9-244`; car livery rows `:668-744`; `BASE_ITEMS`; types)
- Test: `site/lib/marketplaceCatalog.test.ts` (new, vitest)

- [ ] **Step 1: Failing vitest** — create `site/lib/marketplaceCatalog.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BASE_ITEMS, MARKETPLACE_ACTIONS, buildMarketplaceSeedItems } from './marketplaceCatalog';

describe('mount customizer catalog rows', () => {
  it('sells Speed/Acceleration/Armour I-III for the five non-car mounts and Fire I-III for the dragon', () => {
    const rows = BASE_ITEMS.filter((r) => r.action_config.effect === 'grant_mount_power');
    for (const mount of ['dragon', 'eagle', 'horse', 'hoverboard', 'bicycle']) {
      for (const power of ['power', 'strength', 'shield']) {
        for (const tier of [1, 2, 3]) {
          expect(rows.some((r) => r.action_config.mount === mount && r.action_config.power === power && r.action_config.tier === tier), `${mount} ${power} ${tier}`).toBe(true);
        }
      }
    }
    for (const tier of [1, 2, 3]) expect(rows.some((r) => r.action_config.mount === 'dragon' && r.action_config.power === 'fire' && r.action_config.tier === tier)).toBe(true);
    expect(rows.filter((r) => r.action_config.mount !== 'car').length).toBe(48);
  });

  it('every game_action id resolves in MARKETPLACE_ACTIONS (the seed normaliser rejects unknown ids)', () => {
    const ids = new Set<string>(MARKETPLACE_ACTIONS.map((a) => a.id));
    for (const r of BASE_ITEMS) expect(ids.has(r.game_action), r.source_key).toBe(true);
  });

  it('skins are grant_item rows: 5 car liveries converted, 15 new, all category mounts, no worlds limit', () => {
    const skins = BASE_ITEMS.filter((r) => r.action_config.effect === 'grant_item' && String(r.action_config.item_id).startsWith('skin_'));
    expect(skins.length).toBe(20);
    for (const key of ['cosmetic_car_neon', 'cosmetic_car_inferno', 'cosmetic_car_phantom', 'cosmetic_car_toxic', 'cosmetic_car_azure']) {
      const r = skins.find((s) => s.source_key === key);
      expect(r, key).toBeTruthy();
      expect(r!.action_config.item_id).toBe(`skin_${key.replace('cosmetic_', '')}`);
    }
    for (const s of skins) {
      expect(s.category).toBe('mounts');
      expect(s.worlds).toBeUndefined();
    }
    expect(BASE_ITEMS.some((r) => r.action_config.effect === 'unlock_cosmetic' && r.action_config.kind === 'vehicle')).toBe(false);
  });

  it('source keys are unique and none of the pre-existing keys disappeared', () => {
    const keys = BASE_ITEMS.map((r) => r.source_key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of ['mount_strength_1', 'mount_shield_3', 'mount_power_2', 'cosmetic_car_neon', 'pack_medkit']) expect(keys).toContain(k);
    expect(buildMarketplaceSeedItems().length).toBeGreaterThan(170);
  });
});
```

- [ ] **Step 2: Precondition + run.** `site/node_modules` is stale on the dev machine (`vitest`, `three`, `@types/three` declared but not installed, so `tsc` already reports ~40 unrelated errors). First:

```bash
cd site && npm ci && npx tsc --noEmit -p tsconfig.json   # must be clean BEFORE this task's edits
```

Then `npx vitest run lib/marketplaceCatalog.test.ts` → FAIL (`BASE_ITEMS` not exported).

- [ ] **Step 3: Implement** in `marketplaceCatalog.ts`

(a) Above `MARKETPLACE_ACTIONS`, add the upgrade generators:

```ts
/* ---- Mount upgrades: shown in the F10 menu, applied by MountManager.grantPower ---- */

const UPGRADE_MOUNTS = [
  { id: 'dragon', label: 'Dragon', powers: ['power', 'strength', 'shield', 'fire'] },
  { id: 'eagle', label: 'Eagle', powers: ['power', 'strength', 'shield'] },
  { id: 'horse', label: 'Horse', powers: ['power', 'strength', 'shield'] },
  { id: 'hoverboard', label: 'Hoverboard', powers: ['power', 'strength', 'shield'] },
  { id: 'bicycle', label: 'Bicycle', powers: ['power', 'strength', 'shield'] },
] as const;

const POWER_META = {
  power: { name: 'Speed', blurb: 'top speed', color: '#b6ff5a', base: 300 },
  strength: { name: 'Acceleration', blurb: 'acceleration', color: '#ff8a5c', base: 260 },
  shield: { name: 'Armour', blurb: 'damage protection while riding', color: '#52e9ff', base: 280 },
  fire: { name: 'Fire', blurb: 'fireball damage while riding', color: '#ff6a3a', base: 340 },
} as const;

const TIER_ROMAN = ['I', 'II', 'III'] as const;
const TIER_MUL = [1, 2, 3.15] as const;
type UpgradeMountId = (typeof UPGRADE_MOUNTS)[number]['id'];
type UpgradePowerId = keyof typeof POWER_META;
// Template type over 5x4x3 = 60 ids; 12 (e.g. mount_eagle_fire_1) are never
// generated - harmless, normalizeAction() checks the runtime array, not the type.
export type MountUpgradeActionId = `mount_${UpgradeMountId}_${UpgradePowerId}_${1 | 2 | 3}`;

const MOUNT_UPGRADE_ACTIONS: ReadonlyArray<{ id: MountUpgradeActionId; label: string; description: string; effect: 'grant_mount_power' }> =
  UPGRADE_MOUNTS.flatMap((m) => m.powers.flatMap((p) => ([1, 2, 3] as const).map((tier) => ({
    id: `mount_${m.id}_${p}_${tier}` as MountUpgradeActionId,
    label: `${m.label} ${POWER_META[p].name} ${TIER_ROMAN[tier - 1]}`,
    description: `Permanently raises your ${m.label.toLowerCase()} ${POWER_META[p].blurb} (tier ${tier}).`,
    effect: 'grant_mount_power' as const,
  }))));
```

(b) In `MARKETPLACE_ACTIONS`: change the `cosmetic_vehicle_skin` entry to `description: 'Grants a car skin item; apply it from the Mount menu (F10) while driving.', effect: 'grant_item'`; add `{ id: 'mount_skin', label: 'Mount skin', description: 'Grants a mount skin item; apply it from the Mount menu (F10) while riding.', effect: 'grant_item' },`; and end the literal with `...MOUNT_UPGRADE_ACTIONS,` before `] as const;`.

(c) `export const BASE_ITEMS: readonly BaseSeedRow[] = [` (was module-private and untyped). The explicit element type is what lets the vitest file read `r.action_config.mount` etc. — as a bare `as const` tuple, `action_config` is a union of ~38 literal shapes and TS refuses those property reads (7 × TS2339, which would also break `next build`). `BaseSeedRow` is declared in (e) below; it must sit above `BASE_ITEMS`. With this annotation the `(item as { worlds?: ... }).worlds` cast in `buildMarketplaceSeedItems` becomes plain `item.worlds` — simplify it and update its stale "vehicle liveries only sell at the circuit merchant" comment to "Optional per-item world allowlist (currently unused; kept for future world-specific stock)."

(d) The five car livery rows (`:668-744`): `action_config: { effect: 'grant_item', item_id: 'skin_car_<x>' }`; description tail "Equip in the F2 Vehicle customizer." → "Apply from the Mount menu (F10) while driving; one use, then yours to keep."; **delete** the `worlds: ['race'] as const,` line. Keep `source_key`, `game_action`, prices, `sort_order`.

(e) Above `BASE_ITEMS` add the row generators, and end `BASE_ITEMS` with `...MOUNT_SKIN_ROWS, ...MOUNT_UPGRADE_ROWS,` before `] as const;`:

```ts
type PricingKind = 'ammo' | 'consumable' | 'fixed';
type BaseSeedRow = {
  source_key: string; name: string; description: string; category: MarketplaceCategory;
  image_label: string; image_color: string; game_action: MarketplaceActionId;
  action_config: Record<string, unknown>; quantity: number | null; cost_buy: number; cost_sell: number;
  pricing_kind: PricingKind; sort_order: number; worlds?: readonly MarketplaceWorld[];
};

const MOUNT_SKIN_DEFS = [
  { key: 'dragon_obsidian', name: 'Obsidian Ember Hide', desc: 'Dragon skin — black glass hide, blood-red tack.', color: '#14161c', cost: 520 },
  { key: 'dragon_verdant', name: 'Verdant Wyrm Hide', desc: 'Dragon skin — forest scale, worn tan leather.', color: '#1f6b3a', cost: 480 },
  { key: 'dragon_frost', name: 'Frostscale Hide', desc: 'Dragon skin — glacier hide, deep-blue harness.', color: '#bfe6f2', cost: 560 },
  { key: 'eagle_golden', name: 'Golden Talon Plumage', desc: 'Eagle skin — burnished gold plumage, black harness.', color: '#c98a2b', cost: 460 },
  { key: 'eagle_storm', name: 'Storm Crest Plumage', desc: 'Eagle skin — slate-blue feathers, silver straps.', color: '#3a4a5c', cost: 440 },
  { key: 'eagle_ember', name: 'Ember Wing Plumage', desc: 'Eagle skin — scorched russet, gold harness.', color: '#7a2a1a', cost: 480 },
  { key: 'horse_midnight', name: 'Midnight Charger Coat', desc: 'Horse skin — coal-black coat, white leather.', color: '#141216', cost: 420 },
  { key: 'horse_palomino', name: 'Palomino Coat', desc: 'Horse skin — golden coat, oiled brown tack.', color: '#d6b26a', cost: 400 },
  { key: 'horse_royal', name: 'Royal Grey Coat', desc: 'Horse skin — dapple white, violet saddle.', color: '#e6e6ea', cost: 460 },
  { key: 'hover_neon', name: 'Neon Drift Deck', desc: 'Hoverboard skin — gloss black deck, magenta underglow.', color: '#ff3bd2', cost: 440 },
  { key: 'hover_toxic', name: 'Toxic Rail Deck', desc: 'Hoverboard skin — matt green deck, acid glow.', color: '#a8ff3b', cost: 420 },
  { key: 'hover_solar', name: 'Solar Flare Deck', desc: 'Hoverboard skin — orange gloss deck, gold glow.', color: '#f27b1f', cost: 460 },
  { key: 'bike_chrome', name: 'Chrome Courier Frame', desc: 'Bicycle skin — polished frame, bright rims.', color: '#d9dde2', cost: 360 },
  { key: 'bike_racing', name: 'Racing Red Frame', desc: 'Bicycle skin — race red frame, black rims.', color: '#c21f2f', cost: 380 },
  { key: 'bike_forest', name: 'Forest Ranger Frame', desc: 'Bicycle skin — matt green frame, brass rims.', color: '#2f4a2a', cost: 360 },
] as const;

const MOUNT_SKIN_ROWS: readonly BaseSeedRow[] = MOUNT_SKIN_DEFS.map((s, i) => ({
  source_key: `skin_${s.key}`,
  name: s.name,
  description: `${s.desc} Apply from the Mount menu (F10) while riding; one use, then yours to keep.`,
  category: 'mounts',
  image_label: s.name.split(' ')[0].toUpperCase(),
  image_color: s.color,
  game_action: 'mount_skin',
  action_config: { effect: 'grant_item', item_id: `skin_${s.key}` },
  quantity: null,
  cost_buy: s.cost,
  cost_sell: Math.round(s.cost * 0.4),
  pricing_kind: 'fixed',
  sort_order: 450 + i,
}));

const MOUNT_UPGRADE_ROWS: readonly BaseSeedRow[] = UPGRADE_MOUNTS.flatMap((m, mi) => m.powers.flatMap((p, pi) => ([1, 2, 3] as const).map((tier) => ({
  source_key: `mount_${m.id}_${p}_${tier}`,
  name: `${m.label} ${POWER_META[p].name} ${TIER_ROMAN[tier - 1]}`,
  description: `${m.label} upgrade: ${POWER_META[p].blurb} tier ${tier}. Permanent, replaces a lower tier. See your tiers in the Mount menu (F10).`,
  category: 'mounts',
  image_label: `${POWER_META[p].name.slice(0, 3).toUpperCase()} ${TIER_ROMAN[tier - 1]}`,
  image_color: POWER_META[p].color,
  game_action: `mount_${m.id}_${p}_${tier}` as MountUpgradeActionId,
  action_config: { effect: 'grant_mount_power', mount: m.id, power: p, tier },
  quantity: null,
  cost_buy: Math.round(POWER_META[p].base * TIER_MUL[tier - 1]),
  cost_sell: Math.round(POWER_META[p].base * TIER_MUL[tier - 1] * 0.4),
  pricing_kind: 'fixed',
  sort_order: 330 + mi * 12 + pi * 3 + (tier - 1),
}))));
```

Remove the now-duplicate `type PricingKind = ...` line further down (`:883`) so it is declared once. `MarketplaceActionId` is declared after `MARKETPLACE_ACTIONS` and before `BASE_ITEMS`; place `BaseSeedRow` and the two generated arrays **after** the `MarketplaceActionId` type and **before** `BASE_ITEMS`.

- [ ] **Step 4: Type-check + test**

```bash
cd site && npx tsc --noEmit -p tsconfig.json && npx vitest run lib/marketplaceCatalog.test.ts
```
Expected: no type errors; 4 tests PASS (verified against a scratch copy: 57 `grant_mount_power` rows, 20 skin rows, all action ids resolve, 505 seed rows). (The test reads `s.worlds` directly - valid because `BASE_ITEMS` is typed `readonly BaseSeedRow[]`.)

- [ ] **Step 5: Commit**

```bash
git add site/lib/marketplaceCatalog.ts site/lib/marketplaceCatalog.test.ts
git commit -m "Marketplace catalog: mount upgrades for all mounts, mount skins as bag items

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 19: Root catalog drift test (`mount-catalog.test.mjs`)

**Files:**
- Modify: `package.json`, `package-lock.json` (add `esbuild` devDependency)
- Create: `scripts/tests/mount-catalog.test.mjs`

- [ ] **Step 0: Add esbuild as a real root devDependency.** It is present in `node_modules` today only as an extraneous transitive of `vercel`; a clean `npm ci` would not have it and `npm test` would fail wholesale.

```bash
npm i -D esbuild@^0.27.0
node -e "console.log(require('esbuild').version)"   # prints 0.27.x
```

- [ ] **Step 1: Write the test** (bundles the TS catalog with esbuild so it can be imported headlessly; the bundle is built once and cached):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { MOUNT_STATS } from '../../src/mounts/Livery.js';
import { MOUNT_SKINS_BY_ID } from '../../src/systems/Cosmetics.js';
import { itemDef, skinIdFromItem } from '../../src/systems/ItemDefs.js';

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
});
```

- [ ] **Step 2: Run** `node --test scripts/tests/mount-catalog.test.mjs` → PASS.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json scripts/tests/mount-catalog.test.mjs
git commit -m "Test: marketplace mount rows agree with the game's stat and skin tables

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 20: Discoverability — F1, F6, HUD hints, Input reserved keys, NPC chat

**Files:**
- Modify: `src/ui/HelpMenu.js:107`, `src/ui/KeybindMenu.js:44,166`, `src/ui/HUD.js:934,1399`, `src/core/Input.js:436`, `src/ai/ChatClient.js:360`, `site/app/api/chat/route.ts:114`

- [ ] **Step 1: Edits**

- `HelpMenu.js` after `['F2', 'Customise your character'],` add `['F10', 'Customise your mount — while riding'],`.
- `KeybindMenu.js` after `{ key: 'F2', label: 'Customise character' },` add `{ key: 'F10', label: 'Customise mount — while riding' },`; in the note change `F1–F9` to `F1–F10`.
- `HUD.js:934` → `el('div', 'pause-hint', 'F3 diagnostics · T opens comms · F1 controls · F10 mount')`.
- `HUD.js:1399` after `['F2', 'Customise character'],` add `['F10', 'Customise mount'],`.
- `Input.js:436` → `if (['Escape', 'F1', 'F2', 'F3', 'F4', 'F5', 'F9', 'F10', 'Tab'].includes(code)) {`.
- `ChatClient.js:360` → `return 'Change your own look first — F2 opens that. F10 does the same for whatever you are riding.';`
- `site/app/api/chat/route.ts:114` (the NPC system prompt's control list enumerates F1–F9): add `F10 = customise the mount you are riding` in the same style.

- [ ] **Step 2: Verify** `npm run build && npm test` → PASS. `grep -rn "F2 Vehicle\|Character menu (F2)" src site/lib` — only the character-skin strings should remain.

- [ ] **Step 3: Commit**

```bash
git add src/ui/HelpMenu.js src/ui/KeybindMenu.js src/ui/HUD.js src/core/Input.js src/ai/ChatClient.js site/app/api/chat/route.ts
git commit -m "F10 in help, keybinds, boot/pause hints, reserved keys and NPC chat

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 21: Browser smoke (Playwright MCP, or `npm run dev` + manual)

- [ ] **Step 1: Start the dev server** (`npm run dev`, note the port) and open `http://localhost:<port>/?dev=1`.
- [ ] **Step 2: For each of the six mounts:** `M` → pick the mount → `F10` → drawer opens titled with the mount → click a swatch (colour changes live) → click Matt then Gloss (surface changes) → Escape → `F` to dismount → summon again → colours persist.
- [ ] **Step 3: On foot:** `F10` → HUD toast "Mount up first (M) to customise it"; drawer does not open. In Firefox confirm F10 does not focus the menu bar.
- [ ] **Step 4: Persistence:** `F5` save; reload; `Shift+F9` load → liveries return. No console errors.
- [ ] **Step 5: Skins:** in dev, `GAME.economy.add(5000,'dev')`; walk to a merchant, `B`, buy a bicycle skin → toast "Bought"; try buying it again → "You already have this skin — apply it from the Mount menu (F10) while riding"; `I` → the skin shows a **Use** button; on foot press Use → toast "Mount your bicycle and press F10…" and the item stays; mount the bicycle → `F10` → card reads "In inventory — Apply" → click → card flips to "Equipped", bag copy gone; dismount/resummon → still equipped; pick another colour → card reads "Owned".
- [ ] **Step 6: Upgrades:** `GAME.mounts.grantPower('horse','power',2)` → HUD pip `PWR 2` while riding, F10 Upgrades row shows 2 pips + "+24% top speed"; `grantPower('dragon','fire',1)` → HUD `FIR 1`.
- [ ] **Step 7:** `F1`, `F6`, and the boot hint card list F10; `F2` no longer shows a Vehicle section.
- [ ] **Step 8:** Note anything broken as a follow-up task and fix before finishing.

### Task 22: Docs

- [ ] **Step 1:** Update the spec's status line to `Implemented 2026-08-17`, and amend spec §4.5's "one `MARKETPLACE_ACTIONS` id per row … ~68 new ids" to match what shipped: one id per **upgrade** row (48) plus one shared `mount_skin` action for the 15 new skins and the existing shared `cosmetic_vehicle_skin` for the 5 car rows — the same convention `cosmetic_char_skin` already uses. Add a paragraph to `CONTRACTS-V3.md` under the MOUNTS ownership block: `MountManager` owns `_liveries` (per mount) and `_powers`; `MountSkins.applyMountSkin` is the only path that consumes a skin item; `MountMenu` (F10) is generic over `CUSTOM_SLOTS`/`STATS`; `Livery.js` owns the tint/finish maths and `MOUNT_STATS`.
- [ ] **Step 2:** `npm test && npm run build && (cd site && npx tsc --noEmit -p tsconfig.json && npx vitest run)` → all green.
- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-08-17-mount-customizer-design.md CONTRACTS-V3.md
git commit -m "Docs: mount customizer shipped; contracts note for liveries/skins/F10

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
