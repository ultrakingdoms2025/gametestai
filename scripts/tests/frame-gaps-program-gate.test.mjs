import { test } from 'node:test';
import assert from 'node:assert/strict';

import { programGateVerdict } from '../frame-gaps.mjs';

/**
 * THE SHADER-PROGRAM GATE, WATCHED FAILING.
 *
 * `frame-gaps.mjs --gate` compares a run's program counters against a
 * per-platform baseline. It needs Chrome, a built bundle and about a minute,
 * which makes it exactly the kind of gate that gets edited and never re-proven.
 * Worse, until 2026-08-30 the file called `main()` unconditionally, so anything
 * that imported it launched a browser - the counter arithmetic could not be
 * asserted at all, which is the real reason it never had been.
 *
 * Now the comparison is a pure exported function and this file watches it fail.
 *
 * ── The asymmetry these cases exist to pin ────────────────────────────────
 *
 * `dProg` counts programs linked ON ENTRY to a world - the cost paid on the
 * arrival frame - so a fall is the outcome the whole effort is chasing and only
 * a rise is a regression. `warmPrograms` counts what boot linked ahead of that,
 * and A FALL IS THE EXPENSIVE ONE: a builder that quietly stops warming twenty
 * programs reads as an improvement and pays for it on the arrival frame. That
 * direction was ungated until this file existed, and the spec had already
 * named it - "the realistic hazard is a drop".
 */

const BASE = { warmPrograms: 142, dProg: { 'entry:medieval': 2, 'entry:maze': 3 } };

test('a run that matches its baseline passes', () => {
  const v = programGateVerdict(142, { 'entry:medieval': 2, 'entry:maze': 3 }, BASE);
  assert.deepEqual(v.failures, []);
});

test('drift inside the margin is noise, not a regression', () => {
  /* +/-4 on warm, +2 on entry. The margins exist because these counters are
   * measured on real hardware and do move a little between runs. */
  assert.deepEqual(programGateVerdict(146, {}, BASE).failures, [], 'warm +4 allowed');
  assert.deepEqual(programGateVerdict(138, {}, BASE).failures, [], 'warm -4 allowed');
  assert.deepEqual(
    programGateVerdict(142, { 'entry:maze': 5 }, BASE).failures, [], 'entry +2 allowed',
  );
});

test('warming MORE than the baseline fails - boot got slower', () => {
  const v = programGateVerdict(147, {}, BASE);
  assert.equal(v.failures.length, 1);
  assert.match(v.failures[0], /boot warm linked 147 programs against a baseline of 142/);
});

test('warming LESS than the baseline fails - the link cost moved somewhere unwatched', () => {
  /* THE CASE THIS FILE WAS WRITTEN FOR. Before the lower bound existed this
   * returned no failures, and a builder that stopped warming twenty programs
   * would have read as an improvement. */
  const v = programGateVerdict(122, {}, BASE);
  assert.equal(v.failures.length, 1, 'a 20-program drop must fail');
  assert.match(v.failures[0], /linked only 122 programs against a baseline of 142/);
  assert.match(v.failures[0], /not a saving/, 'and it must say why a drop is not good news');
});

test('a world arriving cold fails, and a world arriving warmer does not', () => {
  const cold = programGateVerdict(142, { 'entry:medieval': 9 }, BASE);
  assert.equal(cold.failures.length, 1);
  assert.match(cold.failures[0], /a world that was warm is arriving cold/);

  /* The asymmetry, stated as a case: fewer programs on entry is the goal. */
  const warmer = programGateVerdict(142, { 'entry:medieval': 0 }, BASE);
  assert.deepEqual(warmer.failures, [], 'linking nothing on entry is the outcome, not a fault');
});

test('an unmeasured or unbaselined world is a note, never a silent pass', () => {
  /* Both directions of "the run and the baseline disagree about what exists"
   * have to be SAID. A world in the baseline that the run never entered would
   * otherwise be a gate quietly asserting nothing. */
  const extra = programGateVerdict(142, { 'entry:sports': 30 }, BASE);
  assert.deepEqual(extra.failures, []);
  assert.match(extra.notes.join('\n'), /entry:sports: no dProg baseline/);

  const missing = programGateVerdict(142, {}, BASE);
  assert.match(missing.notes.join('\n'), /entry:medieval is in the baseline and was not measured/);
  assert.match(missing.notes.join('\n'), /entry:maze is in the baseline and was not measured/);
});
