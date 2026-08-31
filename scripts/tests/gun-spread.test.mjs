import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { rig, goto, settle, DT } from './_flightrig.mjs';

const { SpaceCombat, GUN, CONVERGE, MAX_SPAN, FAN_BOLTS, FAN_PITCH } =
  await import('../../src/ships/SpaceCombat.js');
const { ItemUseSystem } = await import('../../src/systems/ItemUse.js');
const { ActiveEffects, EFFECT_KINDS } = await import('../../src/systems/ActiveEffects.js');
const { ITEMS, PACKS, WORLD_MARKETS, KIND_ACCENT, buyMultiplier, setMarketWorld } =
  await import('../../src/systems/ItemDefs.js');
const { DROP_TABLES } = await import('../../src/systems/Loot.js');
const { SHIP_CLASSES } = await import('../../src/ships/ShipStats.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFile(path.join(root, rel), 'utf8');

/**
 * WIDE DISPERSAL: WHAT A LASER CELL BUYS.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The player's sentence was "ship's gun should not be ammo based. applying
 * inventory items would be to increase fire width to capture more enemies per
 * shot", and it is two claims that have to be held apart:
 *
 *   THE GUN IS NEVER AMMO-GATED. `SpaceCombat.GUN` is a capacitor and stays
 *   one. The first case below is the one that would catch a future drop
 *   quietly reintroducing a magazine, and it is deliberately the first thing
 *   in the file.
 *
 *   A CELL BUYS WIDTH, AND BUYS IT FOR NOTHING. Thirty seconds of an
 *   eight-bolt fan whose middle two bolts ARE the stock gun's convergent pair,
 *   so single-target damage on a craft sitting on the crosshair is never worse
 *   than the unmodified weapon at any range. The whole of that is geometric,
 *   so the cases that measure it FLY THE REAL GUN and read the real bolts out
 *   of the real pool. Nothing here asserts that `_playerGun` "was called with"
 *   anything; the claims are about where eight bolts actually are at 275 m and
 *   how many of them reach a target on the pip, which are the only claims
 *   worth making about a spread weapon and the only ones a stub cannot fake.
 *
 * THE INVARIANT CASE IS THE POINT OF THE FILE. An earlier build of this fan
 * walked the core pair outward with everything else and was x0.5 against a
 * single craft past 120 m. It was rejected on a product argument that no
 * amount of comment could answer: a cell is a kill-ladder reward, so a player
 * spends their first one straight out of a dogfight and would meet a gun that
 * had got worse. `the fan never lands fewer bolts on an on-pip target than the
 * stock gun` below is what stops anyone re-widening the core.
 *
 * The refusal cases matter as much as the effect. A cell used on foot has to
 * be REFUSED AND KEPT: this repository's recorded failure mode is the unit
 * destroyed for nothing, and `ItemUse` names it three times in its own
 * comments. The guard is asked before `consumeFromBag`, and the case below is
 * what stops that ordering being quietly reversed.
 */

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

/** A `SpaceCombat` with no world under it. Enough for the timed state. */
function bareCombat(engine, piloting = null) {
  return new SpaceCombat({
    scene: null,
    camera: null,
    bus: null,
    input: null,
    player: null,
    worldManager: { active: null },
    piloting,
    engine,
  });
}

/** A bag that counts what it hands out, so "consumed exactly once" is checkable. */
function fakeBag(stock = {}) {
  const bag = new Map(Object.entries(stock));
  return {
    takes: [],
    bagCount(id) { return bag.get(id) ?? 0; },
    consumeFromBag(id, n) {
      const have = bag.get(id) ?? 0;
      if (have < n) return false;
      bag.set(id, have - n);
      this.takes.push([id, n]);
      return true;
    },
  };
}

function fakeBus() {
  const events = [];
  return {
    events,
    emit(type, payload) { events.push({ type, payload }); },
    on() { return () => {}; },
    of(type) { return events.filter((e) => e.type === type); },
  };
}

/** A `SpaceCombat` stand-in that records what the use path asked it. */
function fakeGun({ flying = true } = {}) {
  return {
    calls: [],
    flying,
    canWidenGuns() { return this.flying; },
    setGunSpread(duration, bolts) { this.calls.push([duration, bolts]); return true; },
  };
}

/* ================================================================== */
/* 1. The gun is a capacitor, and nothing here changes that            */
/* ================================================================== */

test('the ship gun is still capacitor-fed and reads no item, no bag and no ammunition', async () => {
  const src = await read('src/ships/SpaceCombat.js');

  /* The capacitor itself, unchanged. If a future drop wants a magazine it has
   * to delete these four fields, and deleting them fails here rather than in
   * a player's session 60 km from the yard. */
  assert.equal(GUN.capacity, 100);
  assert.equal(GUN.cost, 9);
  assert.equal(GUN.regen, 30);
  assert.equal(GUN.regenDelay, 0);

  /* And the file still has no route to the bag. `setGunSpread` takes two
   * numbers; it does not take an inventory, and `SpaceCombat` has never held
   * one. A `consumeFromBag` anywhere in this file would mean the gun had
   * started spending something to fire. */
  assert.equal(src.includes('consumeFromBag'), false, 'the ship gun is spending items to fire');
  assert.equal(src.includes('bagCount'), false, 'the ship gun is reading the bag');
  assert.equal(src.includes('this.inventory'), false, 'SpaceCombat has grown an inventory reference');

  /* And `setGunSpread` is the only way in: two numbers, no collaborator. There
   * is no shape a bag could arrive in. */
  assert.match(src, /setGunSpread\(duration, bolts = FAN_BOLTS\)/);
});

test('a wider shot costs the capacitor exactly what a narrow one does', () => {
  /* Stated as a case rather than left to a comment because it is a design
   * decision a later "balance pass" would find tempting to reverse. A fan
   * that also drained faster would cut the rate of fire as well, so the
   * player would pay twice for one effect - and the effect is already priced:
   * a cell is what buys it. The capacitor is not. */
  const engine = { simElapsed: 0 };
  const combat = bareCombat(engine);
  const before = combat.gunCharge;
  combat.setGunSpread(30);
  assert.equal(combat.gunCharge, before, 'widening the guns drained the capacitor');
});

/* ================================================================== */
/* 2. The timed state, on the play clock                               */
/* ================================================================== */

test('the fan runs on engine.simElapsed and not on wall time', async () => {
  /* WHY THIS IS A CASE AND NOT A COMMENT. The inventory sheet a cell is used
   * FROM raises `inventory:open`, which blocks gameplay, which stops
   * `simElapsed`. A deadline dated off wall time would burn a slice of the
   * player's thirty seconds while they were still looking at the bag - and
   * the HUD chip counts down on `simElapsed`, so the two would disagree on
   * screen. `Combat._buffNow` is the shape this copies. */
  const src = await read('src/ships/SpaceCombat.js');
  assert.match(src, /_buffNow\(\)\s*\{\s*return this\.engine\?\.simElapsed \?\? 0;/);

  const engine = { simElapsed: 100 };
  const combat = bareCombat(engine);
  assert.equal(combat.setGunSpread(30), true);
  assert.equal(combat.spreadBolts, FAN_BOLTS);

  /* Thirty seconds of real frames pass with gameplay blocked. `simElapsed`
   * does not move, so neither does the deadline. */
  for (let i = 0; i < 1800; i++) combat.update(DT);
  assert.equal(combat.spreadBolts, FAN_BOLTS, 'the fan expired while the game was paused');

  engine.simElapsed = 129.9;
  combat.update(DT);
  assert.equal(combat.spreadBolts, FAN_BOLTS, 'expired a tenth of a second early');

  engine.simElapsed = 130;
  combat.update(DT);
  assert.equal(combat.spreadBolts, 0, 'the fan outlived its deadline');
});

test('a second cell extends the fan rather than replacing it, and a wider fan wins', () => {
  const engine = { simElapsed: 0 };
  const combat = bareCombat(engine);

  combat.setGunSpread(30, 8);
  engine.simElapsed = 20;
  combat.setGunSpread(30, 6);

  /* `Math.max` on BOTH fields, which is what `Combat.boostPlayerDamage` does
   * and what `ActiveEffects.start` assumes when it raises one chip per kind
   * and moves its deadline forward. A replace would have cut ten seconds off
   * and narrowed the fan for the privilege. */
  assert.equal(combat._spreadUntil, 50);
  assert.equal(combat.spreadBolts, 8, 'the narrower second charge shrank the fan');

  engine.simElapsed = 49.9;
  combat.update(DT);
  assert.equal(combat.spreadBolts, 8);
  engine.simElapsed = 50;
  combat.update(DT);
  assert.equal(combat.spreadBolts, 0);
});

test('setGunSpread refuses what is not an effect, and refusing changes nothing', () => {
  const engine = { simElapsed: 0 };
  const combat = bareCombat(engine);

  for (const bad of [0, -5, NaN, Infinity, -Infinity, null, undefined, '30']) {
    assert.equal(combat.setGunSpread(bad), false, `accepted a duration of ${String(bad)}`);
  }
  /* Two bolts IS the gun the player already has, and anything under it is a
   * nerf, so neither is a fan. A refusal at this line is what stops a future
   * caller shipping an "effect" that quietly narrows the weapon. */
  for (const bad of [3, 2, 1, 0, -8, NaN, 'eight']) {
    assert.equal(combat.setGunSpread(30, bad), false, `accepted a fan of ${String(bad)} bolts`);
  }
  assert.equal(combat.spreadBolts, 0);
  assert.equal(combat._spreadUntil, 0, 'a refusal still moved the deadline');
});

test('an odd bolt count is snapped up to even, because the fan is a pair plus rings', () => {
  /* The fan is the stock convergent pair with `(bolts - 2) / 2` rings hung
   * either side of it, so an odd count has nowhere to put the spare bolt
   * except ON THE AXIS - and a bolt on the axis is a third permanent hit on a
   * target sitting on the pip, which is a flat x1.5 single-target damage buff
   * nobody asked for. Snapping up rather than down keeps `setGunSpread` from
   * ever quietly handing back less than it was asked for. */
  const engine = { simElapsed: 0 };
  const combat = bareCombat(engine);
  assert.equal(combat.setGunSpread(30, 7), true);
  assert.equal(combat.spreadBolts, 8);
  assert.equal(combat.spreadBolts % 2, 0);
  assert.equal(FAN_BOLTS % 2, 0, 'the published fan is odd, so it has a bolt on the axis');
});

/* ================================================================== */
/* 3. Who may widen a gun                                              */
/* ================================================================== */

test('canWidenGuns asks the same question _playerGun does, and answers no on foot', async () => {
  const engine = { simElapsed: 0 };
  const piloting = { active: false, _travelling: false, landed: false, shipId: null, flight: {} };
  const wm = { active: { id: 'dock' } };
  const combat = new SpaceCombat({
    scene: null, camera: null, bus: null, input: null, player: null,
    worldManager: wm, piloting, engine,
  });

  assert.equal(combat.canWidenGuns(), false, 'on foot, in the yard');

  piloting.active = true;
  piloting.shipId = 'kestrel';
  assert.equal(combat.canWidenGuns(), false, 'flying, but in a world the gun never fires in');

  wm.active = { id: 'space' };
  assert.equal(combat.canWidenGuns(), true, 'flying in the void, guns live');

  /* Every one of the ways `_playable` says no. They are asserted here rather
   * than trusted because the whole value of sharing the predicate is that
   * "can I widen the guns" and "is there a gun running" cannot drift. */
  piloting.landed = true;
  assert.equal(combat.canWidenGuns(), false, 'landed on a planet');
  piloting.landed = false;
  piloting._travelling = true;
  assert.equal(combat.canWidenGuns(), false, 'mid-seam');
  piloting._travelling = false;
  piloting.shipId = null;
  assert.equal(combat.canWidenGuns(), false, 'active with no hull');

  /* And it really is the same predicate rather than a second copy of it. */
  const src = await read('src/ships/SpaceCombat.js');
  const fn = src.match(/canWidenGuns\(\)\s*\{[\s\S]*?\n {2}\}/)?.[0] ?? '';
  assert.ok(fn, 'found canWidenGuns');
  assert.match(fn, /this\._playable\(\)/, 'canWidenGuns has grown its own idea of flying');
});

/* ================================================================== */
/* 4. The use path: refused and KEPT, or spent exactly once            */
/* ================================================================== */

function useSystem({ gun, effects = null } = {}) {
  const bus = fakeBus();
  const inventory = fakeBag({ laser_cell: 40 });
  const sys = new ItemUseSystem({
    bus,
    player: { health: 100, maxHealth: 100 },
    inventory,
    spaceCombat: gun,
    effects,
  });
  return { sys, bus, inventory };
}

test('a cell used on foot is refused, KEPT, and says what to do instead', () => {
  const gun = fakeGun({ flying: false });
  const { sys, bus, inventory } = useSystem({ gun });

  const res = sys.use('laser_cell');
  assert.equal(res.ok, false);

  /* THE POINT OF THE WHOLE GUARD. `_canApply` runs before `consumeFromBag`,
   * so the refusal costs the player nothing. A guard placed after the consume
   * would leave this at 39 and be invisible in every other assertion. */
  assert.equal(inventory.bagCount('laser_cell'), 40, 'the cell was destroyed for nothing');
  assert.deepEqual(inventory.takes, []);
  assert.deepEqual(gun.calls, [], 'the gun was asked to widen while nobody was flying it');

  /* Actionable, in the voice `_useSkin` set: it names the thing to do and it
   * says the item survived. "Cannot use that right now" is true and useless. */
  const toasts = bus.of('hud:notify');
  assert.equal(toasts.length, 1, `${toasts.length} toasts for one refusal`);
  assert.match(toasts[0].payload.text, /launch|ship/i);
  assert.match(toasts[0].payload.text, /kept/i);
  assert.equal(toasts[0].payload.tone, 'warn');

  /* And a distinct reason code, so main.js's generic `unavailable` branch does
   * not stack "Cannot use that right now" underneath the useful message. */
  assert.equal(res.reason, 'not-flying');
  assert.notEqual(res.reason, 'unavailable');
});

test('an unwired SpaceCombat refuses the use rather than eating the cell', () => {
  /* Same contract every optional collaborator in `ItemUse` has: a missing
   * system makes `_canApply` answer false, which refuses BEFORE the consume.
   * Worth its own case because `spaceCombat` is assigned after construction in
   * main.js - the window where it is null is real. */
  const { sys, inventory } = useSystem({ gun: null });
  assert.equal(sys.use('laser_cell').ok, false);
  assert.equal(inventory.bagCount('laser_cell'), 40);
});

test('a cell used in flight is spent exactly once and raises one WIDE chip', () => {
  const bus = fakeBus();
  const clock = { t: 0 };
  const effects = new ActiveEffects({ bus, clock: () => clock.t });
  const gun = fakeGun({ flying: true });
  const inventory = fakeBag({ laser_cell: 40 });
  const sys = new ItemUseSystem({
    bus, player: { health: 100, maxHealth: 100 }, inventory, spaceCombat: gun, effects,
  });

  const res = sys.use('laser_cell');
  assert.equal(res.ok, true);

  // Exactly one unit, exactly once.
  assert.deepEqual(inventory.takes, [['laser_cell', 1]]);
  assert.equal(inventory.bagCount('laser_cell'), 39);

  // And the gun was asked for the published fan, once.
  assert.deepEqual(gun.calls, [[30, 8]]);
  assert.equal(gun.calls[0][1], FAN_BOLTS,
    'the item hands out a different fan from the one SpaceCombat sizes its arc for');

  // One chip, of the kind the registry knows, counting the same 30 seconds.
  const chips = effects.list();
  assert.equal(chips.length, 1);
  assert.equal(chips[0].kind, 'gunSpread');
  assert.equal(chips[0].tag, EFFECT_KINDS.gunSpread.tag);
  assert.equal(chips[0].duration, 30);
  assert.equal(chips[0].endsAt, 30);
  assert.equal(chips[0].label, ITEMS.laser_cell.name, 'the chip does not name the item used');

  // And a toast that says what happened, not that something happened.
  const toast = bus.of('hud:notify').at(-1);
  assert.match(toast.payload.text, /8/);
  assert.match(toast.payload.text, /30s/);
  assert.equal(toast.payload.tone, 'info');

  clock.t = 30;
  effects.update();
  assert.equal(effects.list().length, 0, 'the chip outlived the effect');
});

test('a second cell in flight extends one chip rather than raising a second', () => {
  const bus = fakeBus();
  const clock = { t: 0 };
  const effects = new ActiveEffects({ bus, clock: () => clock.t });
  const gun = fakeGun({ flying: true });
  const inventory = fakeBag({ laser_cell: 40 });
  const sys = new ItemUseSystem({
    bus, player: { health: 100, maxHealth: 100 }, inventory, spaceCombat: gun, effects,
  });

  sys.use('laser_cell');
  clock.t = 10;
  sys.use('laser_cell');

  assert.equal(effects.list().length, 1, 'two chips for one gun');
  assert.equal(effects.list()[0].endsAt, 40);
  assert.equal(inventory.bagCount('laser_cell'), 38, 'both cells were spent');
});

test('the ledger is optional: without one the cell still widens the gun', () => {
  /* The contract `ItemUse` states for `effects` in its own constructor: a
   * missing ledger costs the player a chip, never the use. */
  const gun = fakeGun({ flying: true });
  const { sys, inventory } = useSystem({ gun, effects: null });
  assert.equal(sys.use('laser_cell').ok, true);
  assert.equal(inventory.bagCount('laser_cell'), 39);
  assert.deepEqual(gun.calls, [[30, 8]]);
});

/* ================================================================== */
/* 5. THE GUN, FLOWN                                                   */
/* ================================================================== */

/**
 * One shot from the real gun, with the real ship, and where its bolts go.
 *
 * `_playerGun` is driven through `fixedUpdate`, so this holds the trigger for
 * exactly one step: `GUN.interval` is 0.20 s against a 1/60 s step, so a
 * second shot cannot land inside the window, and a bolt lives
 * `GUN.range / GUN.speed` = 0.44 s, so every bolt of the shot is still in the
 * pool when it is read.
 */
function fireOnce(r, combat) {
  r.input.state.fire = true;
  r.piloting.fixedUpdate(DT, 0);
  combat.fixedUpdate(DT, 0);
  r.input.state.fire = false;

  const f = r.piloting.flight;
  const pos = f.position.clone();
  const fwd = f.forward(new THREE.Vector3());
  const right = f.right(new THREE.Vector3());
  const b = combat._b;
  const bolts = [];
  for (let i = 0; i < b.active.length; i++) {
    if (b.active[i] !== 1 || b.side[i] !== 0) continue;
    bolts.push({
      origin: new THREE.Vector3(b.px[i], b.py[i], b.pz[i]),
      dir: new THREE.Vector3(b.vx[i], b.vy[i], b.vz[i]).normalize(),
    });
  }
  /* Off-axis error at range `d`, exactly: walk the bolt until its component
   * along the nose line is `d`, then read its component across it. This is the
   * `off(d, t)` the `FAN_BOLTS` table is written in, MEASURED off the bolts
   * the game actually spawned rather than re-derived from the formula the
   * code uses - which would only be the code agreeing with itself. */
  const offAxisAt = (d) => bolts.map(({ origin, dir }) => {
    const rel = origin.clone().sub(pos);
    const s = (d - rel.dot(fwd)) / dir.dot(fwd);
    return rel.dot(right) + dir.dot(right) * s;
  }).sort((a, c) => a - c);

  return { bolts, offAxisAt };
}

/** Drop every bolt in flight, so the next shot is read on its own. */
function clearBolts(combat) {
  const b = combat._b;
  for (let i = 0; i < b.active.length; i++) b.active[i] = 0;
  combat._boltCount = 0;
  combat._fireCool = 0;
  combat.gunCharge = GUN.capacity;
}

/**
 * A real `SpaceCombat` over the shared flight rig, with a clock we drive.
 *
 * The hull is PLACED 30 km out before a shot is asked for, and that is not
 * decoration. Boarding puts the Kestrel on its cradle at the yard, and the
 * first `piloting.fixedUpdate` from there raises `_travelling` - at which
 * point `_playable()` is false and `_playerGun` returns before it ever reads
 * the trigger. Measured, when this case first reported zero bolts from a gun
 * that fires two. `space-combat.test.mjs` places every one of its cases for
 * the same reason and 30 km is its figure, well outside `SAFE_RADIUS`.
 */
async function flownGun() {
  const r = await rig();
  if (!('fire' in r.input.state)) r.input.state.fire = false;
  await goto(r, 'space');
  const engine = { simElapsed: 0 };
  const combat = new SpaceCombat({
    scene: r.scene, camera: r.camera, bus: r.bus, input: r.input, player: r.player,
    worldManager: r.wm, piloting: r.piloting, ships: r.ships, economy: r.economy, engine,
  });
  r.piloting.board('kestrel', { silent: true });

  const at = new THREE.Vector3(0, 0, -30000);
  const q = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().lookAt(at, new THREE.Vector3(0, 0, -31000), new THREE.Vector3(0, 1, 0)),
  );
  r.piloting.flight.place(at, q);
  r.piloting.flight.velocity.set(0, 0, 0);
  r.piloting._landed = false;
  r.piloting._airborne = true;
  await settle(2);
  assert.equal(combat._playable(), true, 'the rig is not flying, so nothing below measures a gun');
  return { r, combat, engine };
}

function teardown(r, combat) {
  combat.standDown('test');
  combat.dispose();
  if (r.piloting.active) r.piloting.disembark({ silent: true, force: true });
  r.piloting.interdicted = false;
  r.input.state.fire = false;
}

test('the stock gun fires a converging PAIR, the fan fires eight, and it reverts', async () => {
  const { r, combat, engine } = await flownGun();
  try {
    /* ---- stock ---------------------------------------------------- */
    clearBolts(combat);
    const stock = fireOnce(r, combat);
    assert.equal(stock.bolts.length, 2, 'the gun that has always fired two bolts fired something else');

    /* The pair's own guarantee, unchanged: both bolts inside `MAX_SPAN` of the
     * nose line at every range in the envelope, which is what makes a skiff on
     * the crosshair a hit. See the Dray note in `_playerGun`. */
    for (const d of [110, 275, 700]) {
      for (const off of stock.offAxisAt(d)) {
        assert.ok(Math.abs(off) <= MAX_SPAN + 1e-6,
          `a stock bolt is ${off.toFixed(2)} m off the axis at ${d} m`);
      }
    }

    /* ---- fan ------------------------------------------------------ */
    clearBolts(combat);
    assert.equal(combat.setGunSpread(30, FAN_BOLTS), true);
    const wide = fireOnce(r, combat);
    assert.equal(wide.bolts.length, FAN_BOLTS,
      `wide dispersal laid down ${wide.bolts.length} bolts, not ${FAN_BOLTS}`);
    assert.ok(wide.bolts.length > stock.bolts.length, 'the fan is no wider than the pair');

    /* ---- and back -------------------------------------------------- */
    engine.simElapsed = 30;
    combat.update(DT);
    clearBolts(combat);
    const after = fireOnce(r, combat);
    assert.equal(after.bolts.length, 2, 'the gun kept the fan after its thirty seconds were up');
  } finally {
    teardown(r, combat);
  }
});

test('the fan is the arc FAN_BOLTS claims: a stock core, gapless at the median', async () => {
  const { r, combat } = await flownGun();

  /* The hull's own muzzle span, which is the one term that varies - a Kestrel
   * is 14 m, so 3.08, against `MAX_SPAN` for every other hull. */
  const span = Math.min(SHIP_CLASSES.kestrel.length * 0.22, MAX_SPAN);
  /** Off-axis position of ring `k` on the `+1` side at range `d`. */
  const ring = (d, k) => span * (1 - d / CONVERGE) + k * FAN_PITCH * (d / CONVERGE);
  /** A skiff's hit sphere, `ALIEN_CLASSES.skiff.radius`. */
  const HIT = 4.2;
  const RINGS = (FAN_BOLTS - 2) / 2;

  try {
    clearBolts(combat);
    combat.setGunSpread(30, FAN_BOLTS);
    const { offAxisAt } = fireOnce(r, combat);

    for (const d of [110, 275, 380, 700]) {
      const off = offAxisAt(d);
      assert.equal(off.length, FAN_BOLTS);

      /* Symmetric about the nose line, ring by ring, and where the table says.
       *
       * MAGNITUDES, because past `CONVERGE` the core pair has CROSSED - at
       * 700 m `ring(d, 0)` is -2.59, meaning the bolt from the left muzzle is
       * 2.59 m to the RIGHT of the axis. That is convergence doing exactly
       * what it is for and the table records it; comparing signed values here
       * would fail on the geometry working. */
      for (let k = 0; k <= RINGS; k++) {
        const want = Math.abs(ring(d, k));
        const lo = off[RINGS - k];
        const hi = off[RINGS + 1 + k];
        assert.ok(Math.abs(hi - want) < 0.05,
          `ring ${k} at ${d} m is ${hi.toFixed(2)} m off axis, not the ${want.toFixed(2)} m claimed`);
        assert.ok(Math.abs(lo + want) < 0.05, `ring ${k} is lopsided at ${d} m`);
      }
    }

    /* THE CORE PAIR IS THE STOCK GUN, BOLT FOR BOLT. The two innermost bolts
     * sit at `+-span * (1 - d/CONVERGE)` - the formula the Dray note derives
     * for the unmodified weapon, with nothing added - which is why the
     * invariant case below can hold at all. */
    for (const d of [110, 275, 700]) {
      const off = offAxisAt(d);
      const core = [off[RINGS], off[RINGS + 1]];
      for (const c of core) {
        assert.ok(Math.abs(Math.abs(c) - Math.abs(span * (1 - d / CONVERGE))) < 0.02,
          `a core bolt is ${c.toFixed(2)} m off axis at ${d} m - the pair has been widened`);
        assert.ok(Math.abs(c) <= MAX_SPAN + 1e-6,
          `a core bolt is outside MAX_SPAN at ${d} m`);
      }
    }

    /* GAPLESS AT THE RANGE THE FIGHT IS FOUGHT AT, which is the whole reason
     * `FAN_PITCH` is 11 and not larger. Two bolts more than a hit sphere apart
     * leave a hole a skiff can sit in; at 275 m - the median of the envelope
     * the `CONVERGE` note is written against - the ring step is 7.96 m against
     * an 8.4 m sphere, so there is nowhere in the fifty metres the fan covers
     * for a craft to be missed. */
    const near = offAxisAt(275);
    for (let i = 1; i < near.length; i++) {
      const gap = near[i] - near[i - 1];
      assert.ok(gap <= 2 * HIT,
        `a ${gap.toFixed(2)} m gap at 275 m is wider than a ${2 * HIT} m skiff - the fan has a hole in it`);
    }

    /* AND WIDE ENOUGH TO BE WORTH TURNING ON. `AlienShip._intercept` carries
     * the only measurement in the repository of how far apart a wing actually
     * flies: mean 452-504 m, CLOSEST 21-33 m over seven seconds of run-in. The
     * band a second craft can be caught in is `+-(widest + HIT)`, and a fan
     * narrower than that closest approach catches one craft however many bolts
     * it has, which would make the item a lie. */
    const band = near[near.length - 1] + HIT;
    assert.ok(band >= 21,
      `a +-${band.toFixed(1)} m band at 275 m cannot reach the 21-33 m a wing closes to`);
  } finally {
    teardown(r, combat);
  }
});

test('the fan never lands fewer bolts on an on-pip target than the stock gun', async () => {
  /* THE INVARIANT, AND THE REASON THIS FILE EXISTS IN ITS CURRENT SHAPE.
   *
   * An earlier build fanned the core pair outward along with everything else.
   * It kept a bolt exactly on the axis, so the crosshair stayed true, but past
   * 120 m a craft sitting on the pip took ONE bolt where the stock gun lands
   * two - half damage, bought with an item the game hands out 20 and 40 at a
   * time immediately after a dogfight. A player would meet that as a bug.
   *
   * So this measures BOTH guns through the same code path at the same ranges
   * and compares the counts. It is written as `>=` and not as an equality on
   * purpose: inside about 50 m the first ring is still within a hit sphere of
   * the axis and the fan is x2.0, which is allowed. What is not allowed, ever,
   * is a range where the fan lands fewer. Re-widen the core and this fails. */
  const { r, combat } = await flownGun();
  const HIT = 4.2;
  const RANGES = [110, 150, 200, 275, 340, 380, 450, 550, 700];
  const onPip = (offAxisAt, d) => offAxisAt(d).filter((o) => Math.abs(o) <= HIT).length;

  try {
    clearBolts(combat);
    const stock = fireOnce(r, combat);
    assert.equal(stock.bolts.length, 2, 'premise: the unmodified gun fires the pair');

    clearBolts(combat);
    combat.setGunSpread(30, FAN_BOLTS);
    const wide = fireOnce(r, combat);
    assert.equal(wide.bolts.length, FAN_BOLTS, 'premise: the fan is up');

    const rows = [];
    for (const d of RANGES) {
      const was = onPip(stock.offAxisAt, d);
      const now = onPip(wide.offAxisAt, d);
      rows.push(`${String(d).padStart(3)} m  stock ${was}  wide ${now}  x${(now / was).toFixed(1)}`);
      assert.equal(was, 2, `the stock gun landed ${was} bolts at ${d} m, so the comparison is void`);
      assert.ok(now >= was,
        `WIDE DISPERSAL IS A DOWNGRADE AT ${d} m: ${now} bolts on an on-pip target against `
        + `the stock gun's ${was}. The core pair has been widened - see FAN_BOLTS.`);
    }
    console.log('     single target on the pip, stock vs wide:\n       ' + rows.join('\n       '));

    /* The two bands, named. The floor is x1.0 and there is nothing below it;
     * the x2.0 band is inside `BREAK_RANGE` (130 m), which is nearer than a
     * hostile willingly comes, so in practice the fan is x1.0 on one target
     * and every scrap of what it buys is lateral. */
    assert.equal(onPip(wide.offAxisAt, 40), 4, 'the first ring no longer reaches in close');
    assert.equal(onPip(wide.offAxisAt, 110), 2);
    assert.equal(onPip(wide.offAxisAt, 700), 2);
  } finally {
    teardown(r, combat);
  }
});

/* ================================================================== */
/* 6. What the kind change did, and did not, break                     */
/* ================================================================== */

test('laser_cell is a consumable, and the bag will therefore offer it a Use', async () => {
  assert.equal(ITEMS.laser_cell.kind, 'consumable');

  /* The reason for the change, asserted against the gate itself rather than
   * quoted from it. An item with an effect and no way to reach it is the
   * defect `ItemDefs` records under `ferrobasalt` and `planet-minerals`
   * checks for on the Cinder ores. */
  const ui = await read('src/ui/InventoryUI.js');
  const hasUse = ui.match(/_hasUse\(def\)\s*\{[\s\S]*?\n {2}\}/)?.[0] ?? '';
  assert.ok(hasUse, 'found _hasUse');
  assert.match(hasUse, /'consumable'/, 'the hold-to-use ring no longer covers consumables');

  // And it really does resolve to an effect the ledger knows how to draw.
  const sys = new ItemUseSystem({});
  const effect = sys._effectFor('laser_cell');
  assert.equal(effect.type, 'gunSpread');
  assert.ok(effect.type in EFFECT_KINDS, 'the effect has no chip');
  assert.equal(effect.duration, 30);
  assert.equal(effect.bolts, FAN_BOLTS);
  assert.equal(effect.bolts, 8, 'the published fan size moved and the item desc may now be wrong');
});

test('the kind census moved by exactly one item, from ammo to consumable', () => {
  /* Pinned rather than derived. A prior audit counted ammo 4, consumable 18,
   * trinket 51; moving `laser_cell` is a deliberate one-item change, and this
   * is what makes a SECOND, accidental one visible in a diff.
   *
   * ── consumable 19 -> 22: THE THREE BAG EXPANSION RIGS ────────────────────
   * `bag_expand_5`, `_10` and `_15` were added to `ITEMS` as `consumable`,
   * which is not a taste call: `InventoryUI._hasUse` draws the hold-to-use ring
   * for `consumable`, `skin` and `mountpower` only, and a rig is used from the
   * bag by that ring. Any other kind would have been an effect with no way to
   * reach it - the failure `laser_cell` is in this file for. Three deliberate
   * additions, counted here so a fourth accidental one is still visible.
   *
   * ── consumable 22 -> 30: THREE NEW FAMILIES, EIGHT NEW ROWS ─────────────
   * Four stamina draughts (`stamina_draught_25/50/75/100`), three damage-
   * reduction wards (`ward_20/35/50`) and one ship shield recharge cell
   * (`shield_cell`). Every one of them is `consumable` for the same reason
   * `laser_cell` moved and the bag rigs arrived that way: `InventoryUI._hasUse`
   * draws the hold-to-use ring for `consumable`, `skin` and `mountpower` ONLY,
   * so any other kind would be an effect with no way to reach it - the exact
   * failure this whole file exists for.
   *
   * The count is the point. `shield_cell` in particular could plausibly have
   * been authored as `trinket` (it is ship freight, like `hull_plate` and
   * `thruster_coil` beside it on the shelf) and that would have shipped an item
   * with a `SpaceCombat.chargeShield` behind it and no ring to press. The
   * census is what makes that visible in a diff instead of in play.
   *
   * The bucket totals are what this case protects, not any one item, so it is
   * updated by adding the eight rather than by re-deriving the whole map. */
  const census = {};
  for (const def of Object.values(ITEMS)) census[def.kind] = (census[def.kind] ?? 0) + 1;
  assert.deepEqual(census, {
    currency: 1, ammo: 3, consumable: 30, trinket: 51, skin: 20, mountpower: 57,
  });

  /* The three that are still ammunition all feed a weapon that really does
   * spend them, which is the distinction the cell failed and the reason it
   * moved. */
  const ammo = Object.values(ITEMS).filter((d) => d.kind === 'ammo').map((d) => d.id).sort();
  assert.deepEqual(ammo, ['arrow', 'bullet', 'fireball_charge']);

  // And the new kind has a colour, or a pickup holding one falls back to amber.
  assert.ok(KIND_ACCENT[ITEMS.laser_cell.kind], 'the new kind has no accent colour');
});

test('the cell keeps its older sinks and its price through the relabelling', async () => {
  /* THE SINKS the `ItemDefs` note names. Both predate this change and neither
   * reads `kind` - but the note claims them, and a note that claims a dead
   * sink is how `laser_cell` got into trouble the first two times. */
  const tf = await read('src/minigames/TestFire.js');
  assert.match(tf, /bagCount\('laser_cell'\)/, 'the Test-Fire Butts no longer read the cell rack');
  assert.match(tf, /consumeFromBag\('laser_cell', cost\)/, 'the butts no longer burn cells');

  assert.ok(PACKS.some((p) => p.id === 'pack_laser_cell' && p.itemId === 'laser_cell'),
    "the Fitter's rack is gone");
  assert.equal(WORLD_MARKETS.dock.itemSell.pack_laser_cell, 0.75, 'the rack lost its regional price');

  /* THE PAYOUT DID NOT MOVE. Without the `itemBuy` pin the kind change alone
   * would have shifted the yard from `buy.ammo` (0.9) to `buy.consumable`
   * (0.95) - a balance change hidden inside a relabelling, and one nobody
   * would ever find in a diff of `ItemDefs`. */
  try {
    setMarketWorld('dock');
    assert.equal(WORLD_MARKETS.dock.buy.ammo, 0.9, 'premise: 0.9 is what ammo paid');
    assert.notEqual(WORLD_MARKETS.dock.buy.consumable, 0.9,
      'premise: the consumable rate differs, or the pin below proves nothing');
    assert.equal(buyMultiplier('laser_cell'), 0.9,
      "the yard's payout for a cell moved when the kind did");
  } finally {
    setMarketWorld(null);
  }

  /* AND IT IS STILL REACHABLE BY COLLECTING. `quest-content.test.mjs` fails an
   * item that exists in no table anywhere, and the yard's drop table is where
   * this one has always lived. */
  assert.ok(DROP_TABLES.dock.some((e) => e.id === 'laser_cell'), 'the yard stopped dropping cells');
});
