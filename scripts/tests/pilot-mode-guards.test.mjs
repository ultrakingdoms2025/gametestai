import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { rig, goto, settle, DT, domHarness, boardHull, expectedHull, SHIP_ORDER } from './_flightrig.mjs';

domHarness();

const { Relics } = await import('../../src/systems/Relics.js');
const { Loot } = await import('../../src/systems/Loot.js');
const { pickPrompt, pickPromptSlot, promptSlot, venueArticle, PROMPT_SOURCES } = await import('../../src/ui/PromptSlots.js');
const { BERTHS } = await import('../../src/worlds/dock/YardPlan.js');

/**
 * WHAT MUST STAND DOWN WHILE SOMETHING ELSE IS DRIVING THE BODY.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE ECONOMY HOLE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Piloting.board` sets `player.movementOverride` and writes `player.position`
 * from the flight integrator every step, so WHILE PILOTING `player.position`
 * IS THE SHIP. Anything that tests a pickup against it is therefore testing a
 * 22 m hull moving at flight speed.
 *
 * `Mining.update` already stood down for exactly this reason. `Relics.update`
 * and `Loot.fixedUpdate` did not. Measured on three separate launches out of
 * the hangar with no other income:
 *
 *     credits 895 -> 1015,  1068 -> 1188,  1188 -> 1308
 *
 * +120 every time - one relic per take-off - and the first flight also took
 * "+3 Old Crown Coin" and "+1 Aegis Shard" out of a world cache in mid-air.
 * A session reached Relics 9/30 without once looking for one, and the yard's
 * fifteen pier relics are consumed silently in the first few flights. For
 * scale, a complete round trip to Cinder - land, mine, take off, fly home,
 * dock - sells for 53 credits.
 *
 * The condition is `movementOverride && movementOverrideCollide === false`,
 * which is precisely "the body is not being resolved as a capsule in this
 * world". A MOUNT leaves `movementOverrideCollide` true, and a rider picking a
 * relic up is correct - so the guard has to distinguish them, and both cases
 * are driven below.
 */

function fakePlayerAt(x, y, z) {
  return {
    position: new THREE.Vector3(x, y, z),
    camera: null,
    movementOverride: false,
    movementOverrideCollide: true,
  };
}

test('a relic is not collected by a ship flying over it', async () => {
  const bus = { on: () => () => {}, emit() {} };
  const player = fakePlayerAt(0, 0, 0);
  const economy = { credits: 0, add(n) { this.credits += n; } };
  const relics = new Relics({
    scene: new THREE.Group(), bus, physics: null, player, economy,
    inventory: { add() {} }, cosmetics: null, mounts: null, worldManager: null,
  });
  /* One relic, sitting exactly where the player is. Placed directly rather
   * than scattered, because this case is about the pickup test and not about
   * where relics go. */
  relics.sites = [{ pos: new THREE.Vector3(0, 1, 0), taken: false, phase: 0 }];
  relics.mesh = { setMatrixAt() {}, instanceMatrix: {}, count: 0 };
  relics.glow = { setMatrixAt() {}, instanceMatrix: {}, count: 0 };

  /* ON FOOT: it is collected. Without this the case below would pass with the
   * pickup deleted entirely. */
  relics.update(1 / 60);
  assert.equal(relics.sites[0].taken, true, 'a relic underfoot was not collected at all');
  assert.ok(economy.credits > 0, 'a collected relic paid nothing');

  /* IN THE SEAT: it is not. */
  relics.sites = [{ pos: new THREE.Vector3(0, 1, 0), taken: false, phase: 0 }];
  economy.credits = 0;
  player.movementOverride = true;
  player.movementOverrideCollide = false;
  for (let i = 0; i < 30; i++) relics.update(1 / 60);
  assert.equal(relics.sites[0].taken, false,
    'a relic was hoovered up by a ship - `player.position` is the hull while piloting');
  assert.equal(economy.credits, 0, 'the ship was paid for a relic it flew through');

  /* ON A MOUNT: it IS collected. A rider is a body on the ground with a
   * capsule, and the guard must not catch them. */
  relics.sites = [{ pos: new THREE.Vector3(0, 1, 0), taken: false, phase: 0 }];
  player.movementOverride = true;
  player.movementOverrideCollide = true;
  relics.update(1 / 60);
  assert.equal(relics.sites[0].taken, true,
    'a mounted rider cannot pick up relics - the guard is catching the wrong thing');
});

test('a world cache is not hoovered up by a ship flying through it', async () => {
  const bus = { on: () => () => {}, emit() {} };
  const player = fakePlayerAt(0, 0, 0);
  const inventory = {
    taken: 0,
    acquire(id, qty) { this.taken += qty ?? 1; return { ok: true, taken: qty ?? 1 }; },
    add(id, qty) { this.taken += qty ?? 1; return true; },
    room() { return 99; },
  };
  const loot = new Loot({
    scene: new THREE.Group(), bus, player, inventory,
    economy: { add() {} }, npcManager: null, physics: null, worldManager: null,
    engine: { onFrameUpdate: () => () => {} },
  });

  const drop = () => {
    loot.clear?.();
    loot.spawn(new THREE.Vector3(0, 0, 0), [{ itemId: 'relic_coin', qty: 1 }],
      { persistent: true, snap: false });
  };

  /* ON FOOT: the magnet takes it. */
  drop();
  for (let i = 0; i < 20; i++) loot.fixedUpdate(1 / 60, i / 60);
  assert.ok(inventory.taken > 0, 'a cache underfoot was not collected at all - the probe is blind');

  /* IN THE SEAT: it is left alone. */
  inventory.taken = 0;
  drop();
  player.movementOverride = true;
  player.movementOverrideCollide = false;
  for (let i = 0; i < 60; i++) loot.fixedUpdate(1 / 60, i / 60);
  assert.equal(inventory.taken, 0,
    'a ship collected a world cache in mid-air - `player.position` is the hull while piloting');
});

test('the board prompt and the mining prompt do not clear each other', async () => {
  /* THE RULE, driven as a rule. `pickPrompt` is a pure function precisely so
   * that this can be asserted without a DOM, because the failure it fixes is
   * invisible in any screenshot: the line is simply blank. */
  const BOARD = 'Board the Kestrel';
  const SEAM = 'Hold to cut the Sulfur Crust';
  assert.equal(pickPrompt({ board: BOARD, mining: null }), BOARD);
  assert.equal(pickPrompt({ board: BOARD, mining: SEAM }),
    SEAM, 'the seam you walked to must win over the ship you flew in on');
  /* The whole bug in one line: mining clears its slot and the board prompt is
   * still there. */
  assert.equal(pickPrompt({ board: BOARD, mining: null }), BOARD);
  assert.equal(pickPrompt({ board: null, mining: null }), null);

  /* `pickPromptSlot` is the same rule and has to agree with it, because the
   * HUD reads the SLOT (to pick the keycap letter) and then the text. Two
   * answers to one question is how the chip ends up saying F over a sentence
   * about a seam. */
  assert.equal(pickPromptSlot({ board: BOARD, mining: SEAM }), 'mining');
  assert.equal(pickPromptSlot({ board: BOARD, mining: null }), 'board');
  assert.equal(pickPromptSlot({ board: null, mining: null }), null);
  /* A publisher written before slots existed lands in `board`, which is what
   * every pre-existing publisher meant. */
  assert.equal(promptSlot(undefined), 'board');
  assert.equal(promptSlot('mining'), 'mining');
  assert.deepEqual([...PROMPT_SOURCES], ['mining', 'board']);
});

/**
 * TWO THINGS THE PROMPT LINE SAID THAT WERE NOT TRUE.
 *
 * 1. **Mining said `[E]` and mining is a HOLD.** `Mining.update` accumulates
 *    `this._hold += dt` and fires at `MINE_TIME` (0.85 s), and the prompt was
 *    `[E] Work the Iridite · 252 cr` - the identical shape every TAP prompt in
 *    the game uses. Driven cold, the tester tapped E at an iridite seam,
 *    nothing happened, and nothing on screen said why. That is the rarest
 *    element in the game behind an unteachable verb.
 *
 * 2. **"Start the The Test-Fire Butts".** Two places composed
 *    `${verb} the ${label}` and `DockWorld` authors one venue as
 *    'The Test-Fire Butts', which is its name. The article rule lives in
 *    `PromptSlots` now, once, because it had two call sites.
 *
 * MUTATION RECORD for these two cases: 6 of 6 red - four assertion reversals,
 * plus `venueArticle` forced to `'the '` and `MINE_TIME` prompt text reverted
 * to `[E] Work the ...`.
 */
test('the mining prompt teaches a hold, and no venue is offered as "the The"', async () => {
  const r = await rig();
  await goto(r, 'cinder');
  const seen = [];
  const off = r.bus.on('pilot:prompt', (e) => { if (e?.source === 'mining') seen.push(e); });
  try {
    r.mining._setPrompt('Hold to cut the Iridite  ·  252 cr');
    assert.equal(seen.length, 1, 'Mining does not publish on the prompt channel');
    assert.equal(seen[0].key, 'E',
      'the mining prompt carries no keycap letter, so the HUD cannot draw the chip - ' +
      'which is how it ended up as plain white text next to a proper chip');
    assert.doesNotMatch(seen[0].text, /^\[/,
      `the mining prompt is "${seen[0].text}" - a bracketed key is the shape every TAP ` +
      'prompt uses, and cutting is a hold');
    assert.match(seen[0].text, /hold/i,
      `the mining prompt is "${seen[0].text}" and never says it is a hold`);
  } finally {
    off?.();
  }

  /* The article rule, as a rule. Both spellings of the failure and the case
   * that must NOT change - a venue genuinely called "Theatre" keeps its. */
  assert.equal(venueArticle('The Test-Fire Butts'), '',
    'a venue whose name starts with "The" is offered as "Start the The ..."');
  assert.equal(venueArticle('the Ashlane Picket'), '');
  assert.equal(venueArticle('Test-Fire Butts'), 'the ');
  assert.equal(venueArticle('Theatre'), 'the ',
    'the article rule ate the leading "The" of a word that merely begins with it');
  assert.equal(venueArticle(null), 'the ');
});

test('walking from a seam back to the ship gets the board prompt back', async () => {
  /* THE SAME RULE, DRIVEN THROUGH THE REAL PUBLISHERS.
   *
   * `pickPrompt` is only worth anything if both publishers actually tag their
   * events, and the way that regresses is somebody adding a third publisher
   * that does not. So this walks the reviewer's exact sequence - near the hull,
   * over to the node, back to the hull - through the real `Piloting` and the
   * real `Mining`, records the channel, and merges it the way the HUD does.
   */
  const r = await rig();
  await goto(r, 'dock');
  const slots = { board: null, mining: null };
  const off = r.bus.on('pilot:prompt', (e) => { slots[promptSlot(e?.source)] = e?.text ?? null; });
  try {
    const b = BERTHS.find((x) => x.id === 'kestrel');
    /* Stand at the apron: `boardableAt` answers within 12 m of it. */
    r.player.position.set(b.apron.x, b.cradleTop, b.apron.z);
    r.piloting.update(DT, 0);
    assert.ok(pickPrompt(slots)?.includes('Board'),
      `no board prompt at the apron; channel is ${JSON.stringify(slots)}`);

    /* Now the REAL `Mining` publishes on the channel and then clears itself,
     * which is exactly what it does when you walk onto a seam and off it
     * again. Driven through `Mining._setPrompt` rather than through a
     * hand-written bus event, because the thing being tested is whether
     * `Mining` tags what it sends. */
    r.mining._setPrompt('Hold to cut the Sulfur Crust  ·  29 cr');
    assert.equal(pickPrompt(slots), 'Hold to cut the Sulfur Crust  ·  29 cr');
    r.mining._setPrompt(null);

    /* Still standing at the ship, and `Piloting` has NOT re-emitted, because
     * the boardable hull has not changed. The prompt has to still be there. */
    r.piloting.update(DT, DT);
    assert.equal(r.piloting.boardableAt(), 'kestrel', 'the rig is not standing at a boardable hull');
    assert.ok(pickPrompt(slots)?.includes('Board'),
      'the board prompt was cleared by the mining prompt and never came back');
  } finally {
    off?.();
    await settle();
  }
});

/* ====================================================================== */
/*  THE RIG MUST FLY THE SHIP THE GAME FLIES                              */
/* ====================================================================== */

/**
 * THE GUARD THE OTHER SEVEN SUITES ARE ONLY AS GOOD AS.
 *
 * `space-combat`, `space-objectives`, `piloting-return` and `piloting-loop`
 * all measure ranges, closing speeds and leg times by flying a hull. Every one
 * of those numbers is worth nothing if the hull is not the game's.
 *
 * It was not. `Piloting._shipRecord` looked in two world-scoped places -
 * `worldManager.active.ships`, which only `DockWorld` publishes, and
 * `ShipRegistry.hulls()`, which `_adopt` empties on every `world:changed` - so
 * a board anywhere but inside the yard fell through to `Flight.setShip`'s
 * `powerMul: 1` branch and the flown Kestrel cruised at 120 m/s instead of
 * 210. Slower than the skiffs shooting at it. Nothing said so, because a bare
 * `{ powerMul: 1 }` snapshot is exactly the shape `setShip`'s own throw is
 * documented to exempt.
 *
 * This is the case that would have caught it, and it is deliberately the
 * WHOLE matrix rather than one hull in one world: three hulls x four tiers x
 * three worlds, boarded through the real `Piloting.board` and checked against
 * `ShipStats` restated from the data.
 *
 * ── AND IT IS NOT THE SAME CHECK THE RIG ALREADY RUNS ─────────────────────
 * `_flightrig` asserts on every board, but only against the tier bag the
 * registry happens to be holding. This one SETS the tier through the real
 * `grantPower` purchase path first, so it also pins that a purchased tier
 * reaches the integrator - which is the `Dragon.js` failure `Ship.js:107-118`
 * is written against - and it pins the tiers in a world where the hull object
 * does not exist, which is where the hole was.
 */
test('every hull, at every tier, in every world, flies the stats ShipStats declares', async () => {
  const r = await rig();
  const rows = [];
  try {
    for (const world of ['dock', 'space', 'cinder']) {
      await goto(r, world);
      for (const id of SHIP_ORDER) {
        for (let tier = 0; tier <= 3; tier++) {
          const want = expectedHull(id, { power: tier });
          const f = boardHull(r, id, { tiers: { power: tier } });

          /* NOT `assert.equal(f.powerMul, want.powerMul)` alone: a NaN would
           * fail that too, but so would a legitimate float wobble, and the
           * house rule about non-finite values reaching the bloom pass is
           * worth its own line. */
          for (const [name, got] of [['powerMul', f.powerMul], ['accelMul', f.accelMul],
            ['cruiseTop', f.cruiseTop], ['boostTop', f.boostTop]]) {
            assert.ok(Number.isFinite(got), `${world}/${id}+${tier}: ${name} is ${got}`);
          }
          assert.ok(Math.abs(f.powerMul - want.powerMul) < 1e-9,
            `${world}/${id}+${tier}: powerMul ${f.powerMul} against ShipStats' ${want.powerMul}`);
          assert.ok(Math.abs(f.cruiseTop - want.cruiseTop) < 1e-9,
            `${world}/${id}+${tier}: cruise top ${f.cruiseTop.toFixed(1)} against ${want.cruiseTop.toFixed(1)}`);
          assert.equal(r.piloting.cargoCapacity, want.hold,
            `${world}/${id}+${tier}: hold ${r.piloting.cargoCapacity} against ${want.hold}`);

          /* THE FLOOR THAT MAKES THE THREE LINES ABOVE MEAN SOMETHING. The
           * defect this case exists for produced powerMul EXACTLY 1 and a
           * 120 m/s cruise for every hull in the yard, so a matrix in which
           * nothing beats the slowest ship is the defect, whatever else
           * agrees. Every hull the yard sells is faster than that. */
          assert.ok(f.cruiseTop > 120 + 1e-9,
            `${world}/${id}+${tier} cruises at ${f.cruiseTop.toFixed(1)} m/s - `
            + 'that is the powerMul-1 fallback, not a hull');

          if (world === 'space') rows.push(`${id}+${tier} ${f.cruiseTop.toFixed(1)}`);
        }
      }
      if (r.piloting.active) r.piloting.disembark({ silent: true, force: true });
    }
    /* THE SPREAD IS THE OTHER HALF: twelve identical numbers would satisfy
     * every equality above if `ShipStats` itself went flat. */
    console.log(`    cruise top by hull and thrust tier, boarded in the VOID: ${rows.join('  ')}`);
    const speeds = rows.map((x) => Number(x.split(' ')[1]));
    assert.ok(Math.max(...speeds) / Math.min(...speeds) > 1.9,
      `the twelve hull/tier pairs span only x${(Math.max(...speeds) / Math.min(...speeds)).toFixed(2)}`);
  } finally {
    for (const id of SHIP_ORDER) delete r.ships._powers[id];
    if (r.piloting.active) r.piloting.disembark({ silent: true, force: true });
    await goto(r, 'dock');
    await settle();
  }
});
