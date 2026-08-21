import { test } from 'node:test';
import assert from 'node:assert/strict';

import { domHarness } from './_flightrig.mjs';

domHarness();
const { rig, goto } = await import('./_flightrig.mjs');
const SC = await import('../../src/ships/SpaceCombat.js');

/**
 * BEING SHOT DOWN COSTS SOMETHING, AND SAYS WHAT.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE TWO DEFECTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. **Death was free.** `Piloting._onDied` called `_recoverToBerth`, which
 *    never touched `_hold`. Driven: 1,894 credits of iridite stowed in a Dray
 *    on Cinder, `player:died` emitted, and the run ended at the yard berth
 *    with `{"iridite":{"units":10,"credits":1894}}` intact and the credit
 *    balance unchanged. With a kill counter that only increments, no repair
 *    bill and a self-charging gun, the optimal play for the kill ladder was to
 *    attack recklessly - death was a free instant fast-travel to the one place
 *    you wanted to go anyway.
 *
 *    It also removed the only decision mining has. Ore pays nothing until it
 *    is sold at the yard, so "one more seam or fly home" is THE question, and
 *    it had no wrong answer.
 *
 * 2. **Death was silent.** The entire experience was one `warn` toast -
 *    "Autopilot returned the hull to Lodestar Yard." - which expires. Three
 *    cold sessions ended with the tester standing in the yard not knowing why;
 *    integrity read 100 on the last check before it happened. There was no
 *    death screen, no cause, no damage-direction cue, and no hull alarm on the
 *    way down: 27 points of damage arrived in one engagement with nothing on
 *    screen to say the hull rather than the shield was being opened.
 *
 * Everything below drives the REAL `Piloting` over the REAL `WorldManager` and
 * the REAL `Flight` integrator through `_flightrig.mjs`. Nothing is stubbed
 * that a player touches.
 *
 * MUTATION RECORD is in the block above the last case.
 */

/* ================================================================== */
/* 1. The un-banked hold is what it costs                              */
/* ================================================================== */

test('being shot down empties the un-banked hold, and nothing else', async () => {
  const r = await rig();
  await goto(r, 'space');
  r.piloting.board('dray');

  const before = r.economy.credits;
  const stowed = r.piloting.stow({ type: 'iridite', name: 'Iridite', size: 0.62, credits: 310 });
  assert.equal(stowed.ok, true, 'could not stow a node to lose');
  assert.ok(r.piloting.cargoValue > 0,
    'the hold is empty before the kill, so this case cannot tell a loss from a no-op');
  const value = r.piloting.cargoValue;

  const seen = [];
  const off = r.bus.on('pilot:downed', (e) => seen.push(e));
  r.bus.emit('player:died', { killerId: 'laser' });
  off();

  assert.equal(r.piloting.cargoValue, 0,
    `the hold still holds ${r.piloting.cargoValue} CR after being shot down - death is free`);
  assert.equal(r.piloting.cargoUnits, 0, 'the hold reports units after being shot down');

  /* And it is a LOSS, not a sale. `sellCargo` would have paid the player for
   * the ore they just lost, which is the same defect wearing a bow. */
  assert.equal(r.economy.credits, before,
    `credits moved from ${before} to ${r.economy.credits} on death - the wreck was sold`);

  assert.equal(seen.length, 1, 'nothing published `pilot:downed`');
  assert.equal(seen[0].lostCredits, value,
    `the report says ${seen[0].lostCredits} CR was lost and the hold held ${value}`);
  assert.ok(seen[0].lostUnits > 0, 'the report says no volume was lost');
});

/* ================================================================== */
/* 2. The report carries what happened                                 */
/* ================================================================== */

test('`pilot:downed` names the cause, the hull and the place', async () => {
  const r = await rig();
  await goto(r, 'space');
  r.piloting.board('kestrel');

  const seen = [];
  const off = r.bus.on('pilot:downed', (e) => seen.push(e));
  r.bus.emit('player:died', { killerId: 'laser' });
  off();

  assert.equal(seen.length, 1);
  const e = seen[0];
  assert.equal(e.killer, 'laser',
    'the killer id is dropped, so the card cannot say what shot you down - that id ' +
    'was already in the event log and shown to the player nowhere');
  assert.equal(e.shipId, 'kestrel');
  assert.ok(e.hullName && e.hullName !== 'kestrel',
    `the report names the hull as "${e.hullName}" rather than by its display name`);
  assert.ok(e.place, 'the report does not say where it happened');

  // An empty hold is reported as an empty hold, not as a loss of zero.
  assert.equal(e.lostUnits, 0);
  assert.equal(e.lostCredits, 0);

  // And the recovery still happens: this is a cost, not a soft-lock.
  assert.equal(r.piloting.active, false, 'the player is still flying a dead ship');
});

/* ================================================================== */
/* 3. The alarm that was not there                                     */
/* ================================================================== */

/**
 * MUTATION RECORD for this file: 9 of 9 red.
 *
 * Six assertion reversals, plus three edits to the code under test:
 *   1. the hold-clearing block in `Piloting._onDied` deleted (the original
 *      defect, reproduced)                            -> case 1 red
 *   2. `sellCargo()` used instead of clearing the hold -> case 1 red
 *   3. `_hullAlarm` made a no-op                       -> case 3 red
 *
 * The alarm is driven against the real `SpaceCombat.fixedUpdate` rather than
 * by calling `_hullAlarm` directly, because the thing being claimed is that it
 * runs at all - a private method that works and is never called is the defect
 * this whole drop is about.
 */
test('the hull raises a banner before it fails, and clears it when it recovers', async () => {
  const r = await rig();
  await goto(r, 'space');
  r.piloting.board('kestrel');

  const combat = new SC.SpaceCombat({
    scene: r.scene, bus: r.bus, player: r.player, piloting: r.piloting,
    worldManager: r.wm, camera: r.camera, input: r.input, physics: r.physics,
    ships: r.ships, economy: r.economy,
  });

  /* Off the cradle. `SpaceCombat._playable` refuses while `landed`, and
   * `board` in the yard puts the hull on its berth - so an alarm case driven
   * from a parked ship measures a system that is deliberately switched off.
   * Same two fields `space-combat.test.mjs:placeShip` writes, for the same
   * reason. */
  r.piloting._landed = false;
  r.piloting._airborne = true;
  assert.equal(combat._playable(), true,
    'the combat system is not live, so nothing below is being exercised at all');

  const step = () => { for (let i = 0; i < 4; i++) combat.fixedUpdate(1 / 60, i / 60); };

  // Healthy: silence. Not "a banner nobody looks at".
  r.player.health = 100;
  step();
  assert.equal(combat.report({}).warn, 0,
    'a full hull raises the damage banner, so the banner means nothing');

  // Damaged.
  r.player.health = Math.round(SC.HULL_WARN_FRAC * 100) - 2;
  step();
  let rep = combat.report({});
  assert.ok(rep.warn > 0, `no banner at ${r.player.health}% hull`);
  assert.match(rep.warnText, /damaged/i,
    `the banner at ${r.player.health}% reads "${rep.warnText}"`);

  // Critical: a different rung, so the pilot can tell which way it is going.
  r.player.health = Math.round(SC.HULL_CRIT_FRAC * 100) - 2;
  step();
  rep = combat.report({});
  assert.ok(rep.warn > 0, `no banner at ${r.player.health}% hull`);
  assert.match(rep.warnText, /CRITICAL/,
    `the banner at ${r.player.health}% reads "${rep.warnText}" - the same words as ` +
    'the merely-damaged rung, so the trend is invisible');

  // Repaired: it goes away.
  r.player.health = 100;
  step();
  assert.equal(combat.report({}).warn, 0,
    'the hull banner survives a full repair, so it becomes wallpaper');

  /* FLOOR / ACHIEVED / CEILING on the warning WINDOW. The claim is that the
   * banner appears with enough hull left to act on it, not on the frame you
   * die. A Kestrel takes 16 damage per lance bolt after mitigation, so the
   * floor is "more than one bolt of warning". */
  const bolts = Math.floor((SC.HULL_WARN_FRAC - 0) * 100 / 16);
  assert.ok(bolts >= 3,
    `the damaged rung fires at ${Math.round(SC.HULL_WARN_FRAC * 100)}% hull, which is ` +
    `${bolts} bolts of warning - not enough to break off on`);
  assert.ok(SC.HULL_CRIT_FRAC < SC.HULL_WARN_FRAC,
    'the critical rung is not below the damaged one');

  combat.dispose?.();
});
