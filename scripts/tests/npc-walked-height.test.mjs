import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CARRY_SPEED, STRAND_LIMIT, STANDING_HEADROOM,
  reachableRise, walkedHeight, isStranded, reseatY, pickSurface,
} from '../../src/npc/Grounding.js';

/**
 * The rule that stops a character gaining height it did not climb.
 *
 * ── The defect these pin ─────────────────────────────────────────────────
 * Characters were arriving on the station's ceiling raft - 55 m and 62 m over
 * a deck they had been standing on one fixed step earlier. It was NOT the
 * capsule solver: instrumented over 75 s of a live run, the largest single
 * vertical push `resolveCapsule` gave any of 68 characters was 0.64 m, and
 * every escape carried `hitCount: 0`.
 *
 * It was the surface resolver. `surfaceStack` walks a column from the top of
 * the WORLD downward and used to stop after 10 surfaces. The station hub is
 * roofed by a raft of services rather than a plate, so the walk down the column
 * at (107.7, 10.9) reads: dome 168.47, then 62.00, 61.70, 60.35, 60.25, 60.20,
 * 60.09, 59.65, 59.23, 58.57 - and the DECK, at 0, is the eleventh entry. It
 * was never reached. `resolveSurfaceY` was then asked which of those a
 * character standing on the deck belonged on, and answered 62. The grounding
 * watchdog teleported them there, and once there they read as perfectly
 * healthy - grounded, flush with a surface - so nothing ever brought them back.
 *
 * The fix is in three parts and all three are checked here:
 *   1. the search is anchored near the height being asked about, and the stack
 *      cap is above what these worlds build (`pickSurface` scoring, below);
 *   2. characters remember the height they WALKED to (`walkedHeight`);
 *   3. nothing may re-seat a character above that (`reseatY`), and anything
 *      found above it is put back (`isStranded`).
 *
 * All of it is pure arithmetic over (last walked height, proposed height, one
 * step's reach), which is why it can be checked without a world.
 */

/** The character ground probe's reach - `GROUND_PROBE_UP` in NPC.js. */
const STEP_REACH = 0.95;
/** The fixed step at full simulation rate, and the longest one ever handed out. */
const DT_FULL = 1 / 60;
const DT_MAX = 0.4; // SIM_MAX_STEP

/* ---------------------------------------------------------------- */
/* reachableRise                                                     */
/* ---------------------------------------------------------------- */

test('one step of walking can lift a character by its ground probe reach', () => {
  // With no time passing there is no moving surface to be carried by, so the
  // whole allowance is the step the ground follower can take.
  assert.equal(reachableRise(0, STEP_REACH), STEP_REACH);
});

test('the allowance covers being carried by the fastest moving surface', () => {
  // The station lift runs at 2.6 m/s; CARRY_SPEED is that with margin.
  assert.ok(CARRY_SPEED >= 2.6, `${CARRY_SPEED} m/s does not cover the lift`);
  assert.equal(reachableRise(DT_FULL, STEP_REACH), STEP_REACH + CARRY_SPEED / 60);
  assert.equal(reachableRise(DT_MAX, STEP_REACH), STEP_REACH + CARRY_SPEED * DT_MAX);
});

test('a negative step cannot buy extra allowance', () => {
  assert.equal(reachableRise(-5, STEP_REACH), STEP_REACH);
});

/* ---------------------------------------------------------------- */
/* walkedHeight - the memory                                         */
/* ---------------------------------------------------------------- */

test('falling is always allowed: the memory follows straight down', () => {
  const reach = reachableRise(DT_FULL, STEP_REACH);
  assert.equal(walkedHeight(10, -22, reach), -22);
  assert.equal(walkedHeight(10, 9.999, reach), 9.999);
});

test('a stair riser, a ramp and an escalator are all inside one step', () => {
  const reach = reachableRise(DT_FULL, STEP_REACH);
  // A stair riser on the station's 3.9 m storey grid is 0.1857 m; the tallest
  // thing the ground follower will ever pull a character onto is 0.95.
  for (const riser of [0.1857, 0.45, 0.94]) {
    assert.equal(walkedHeight(4.8, 4.8 + riser, reach), 4.8 + riser, `riser ${riser}`);
  }
  // An escalator at 1.15 m/s up a 30-degree flight climbs 0.575 m/s.
  const escalatorStep = 0.575 * DT_FULL;
  assert.equal(walkedHeight(0.9, 0.9 + escalatorStep, reach), 0.9 + escalatorStep);
  // The lift, at the longest step the simulation ever hands out.
  const liftStep = 2.6 * DT_MAX;
  assert.ok(liftStep <= reachableRise(DT_MAX, STEP_REACH), 'a lift ride outruns the allowance');
  assert.equal(walkedHeight(0.9, 0.9 + liftStep, reachableRise(DT_MAX, STEP_REACH)), 0.9 + liftStep);
});

test('a whole staircase is climbed one step at a time and the memory keeps up', () => {
  const reach = reachableRise(DT_FULL, STEP_REACH);
  // Tower floors sit at 0.9 + 3.9n. Walk from the ground floor to the fourth.
  let walked = 0.9;
  for (let y = 0.9; y <= 0.9 + 3.9 * 4; y += 0.1857) walked = walkedHeight(walked, y, reach);
  assert.ok(walked > 0.9 + 3.9 * 4 - 0.2, `stalled at ${walked}`);
});

test('the memory does NOT follow a jump no step could have made', () => {
  const reach = reachableRise(DT_FULL, STEP_REACH);
  // The measured escapes, exactly: deck -> ceiling raft in one fixed step.
  assert.equal(walkedHeight(0, 62, reach), 0);
  assert.equal(walkedHeight(0, 54.97, reach), 0);
  assert.equal(walkedHeight(0.22, 10.45, reach), 0.22);
  // ...and it is the SAME memory afterwards, so a character that keeps standing
  // up there never launders the height into legitimacy.
  let walked = 0;
  for (let i = 0; i < 600; i++) walked = walkedHeight(walked, 62, reach);
  assert.equal(walked, 0, 'standing on the ceiling made the ceiling legitimate');
});

test('the boundary is exactly the allowance, inclusive', () => {
  const reach = reachableRise(DT_FULL, STEP_REACH);
  assert.equal(walkedHeight(0, reach, reach), reach);
  assert.equal(walkedHeight(0, reach + 1e-9, reach), 0);
});

/* ---------------------------------------------------------------- */
/* isStranded                                                        */
/* ---------------------------------------------------------------- */

test('the strand limit clears the largest step the tracker itself allows', () => {
  // Otherwise a character in a demoted LOD band could be flagged for a climb
  // the memory had just accepted as legitimate.
  assert.ok(
    STRAND_LIMIT > reachableRise(DT_MAX, STEP_REACH),
    `${STRAND_LIMIT} m does not clear a ${reachableRise(DT_MAX, STEP_REACH)} m step`
  );
});

test('legitimate vertical circulation is never stranded', () => {
  // Each of these is a character that walked to where it stands, so its memory
  // equals its height and the excess is zero.
  for (const y of [0, 2.4, 10.005, 0.9, 4.8, 8.7, 12.6, 16.5, 62]) {
    assert.equal(isStranded(y, y), false, `standing at ${y} read as stranded`);
  }
});

test('the measured escapes are all stranded', () => {
  assert.equal(isStranded(0, 62), true);
  assert.equal(isStranded(0, 54.97), true);
  assert.equal(isStranded(0.3, 25.6), true);
  assert.equal(isStranded(0.22, 10.45), true);
  assert.equal(isStranded(0.15, 6.3), true);
});

test('a character on the walkway loop whose memory says the deck IS stranded', () => {
  /* This is the case the rule has to get right rather than merely survive: the
   * walkway is a real place to stand at y = 10, so what separates the promenade
   * from the ceiling is not the height, it is whether the character walked
   * there. One that took the stairs carries a memory of 10 and is fine; one
   * teleported from the deck carries 0 and is not. */
  assert.equal(isStranded(10.005, 10.005), false, 'took the stairs');
  assert.equal(isStranded(0, 10.005), true, 'teleported from the deck');
});

/* ---------------------------------------------------------------- */
/* reseatY - the clamp                                               */
/* ---------------------------------------------------------------- */

test('an ordinary correction passes through untouched', () => {
  // Sunk 0.6 m into the deck; the resolver says the deck is at 0.
  assert.equal(reseatY(0, -0.6, 0), 0);
  // Standing proud of a stale sample on the walkway.
  assert.equal(reseatY(10.005, 10.2, 10.005), 10.005);
});

test('a correction may never promote a character to a height it did not climb', () => {
  // The resolver asking for the ceiling raft is refused outright...
  assert.equal(reseatY(0, 0, 62), null);
  assert.equal(reseatY(0.22, 0.22, 10.45), null);
  // ...and a character that IS up there is brought back to what it walked to.
  assert.equal(reseatY(0, 62, 62), 0);
  assert.equal(reseatY(0.22, 10.45, 10.45), 0.22);
});

test('a column with no floor at all leaves a healthy character alone', () => {
  assert.equal(reseatY(0, 0, null), null);
  assert.equal(reseatY(0, -3, null), null);
  // But a stranded one still comes down.
  assert.equal(reseatY(0, 62, null), 0);
});

test('the clamp allows a lift back onto the floor above, within the limit', () => {
  // A character buried under a deck: the floor it belongs on is above it, and
  // that is exactly what the watchdog exists to fix.
  assert.equal(reseatY(0.9, -1.4, 0.9), 0.9);
  // Two storeys up is not a correction, it is a relocation.
  assert.equal(reseatY(0.9, 0.9, 0.9 + 3.9 * 2), null);
});

/* ---------------------------------------------------------------- */
/* pickSurface - what the resolver does with a column                */
/* ---------------------------------------------------------------- */

/** The measured column at (107.7, 10.9): dome, nine ceiling members, the deck. */
const HUB_COLUMN = [168.47, 62.0, 61.7, 60.35, 60.25, 60.2, 60.09, 59.65, 59.23, 58.57, 0];

/** Turn a list of heights into the stack shape `surfaceStack` returns. */
const asStack = (ys, normalY = 1) =>
  ys.map((y, i) => ({
    y,
    normalY,
    walkable: normalY >= 0.55,
    headroom: i === 0 ? Infinity : ys[i - 1] - y,
  }));

test('the old truncation really did put a deck-walker on the ceiling', () => {
  // The suite has to be able to fail, so this is the defect reproduced: score
  // the same column with the deck missing, which is what a cap of 10 produced.
  const truncated = asStack(HUB_COLUMN.slice(0, 10));
  assert.equal(pickSurface(truncated, 0), 62, 'this is the bug, and it should reproduce');
});

test('with the deck in the stack, a deck-walker is left on the deck', () => {
  assert.equal(pickSurface(asStack(HUB_COLUMN), 0), 0);
});

test('the ceiling raft is only ever chosen by somebody actually up there', () => {
  assert.equal(pickSurface(asStack(HUB_COLUMN), 62), 62);
});

test('the anchored window a resolver now searches contains only the deck', () => {
  /* `resolveSurfaceY` starts its walk 12 m above the hint. From a hint of 0 on
   * the station deck that window reaches 12 m - well short of the 58.57 m
   * underside of the raft - so the raft cannot be a candidate at all, whatever
   * the stack cap is. That 46 m of clear air is the margin the fix runs on. */
  const SEARCH_ABOVE = 12;
  const inWindow = HUB_COLUMN.filter((y) => y <= 0 + SEARCH_ABOVE);
  assert.deepEqual(inWindow, [0]);
  assert.ok(
    Math.min(...HUB_COLUMN.filter((y) => y > 1)) - SEARCH_ABOVE > 40,
    'the raft is close enough to the deck for the anchored window to reach it'
  );
});

test('a crawlspace loses to a real floor even when it is nearer', () => {
  // Unchanged behaviour, pinned because the scoring moved into its own function.
  const stack = asStack([20, 6.0, 5.2, 0]);
  // 5.2 has 0.8 m of headroom - a crawlspace - so 6.0 wins despite being further
  // from a hint of 5.
  assert.ok(STANDING_HEADROOM > 0.8);
  assert.equal(pickSurface(stack, 5), 6.0);
});

test('an empty column resolves to nothing rather than to zero', () => {
  assert.equal(pickSurface([], 0), null);
});

test('a column of nothing but steep roofs still beats falling forever', () => {
  const stack = asStack([30, 12, 4], 0.2);
  assert.equal(pickSurface(stack, 5), 4);
});
