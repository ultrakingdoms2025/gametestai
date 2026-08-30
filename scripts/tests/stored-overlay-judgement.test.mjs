import { test } from 'node:test';
import assert from 'node:assert/strict';

import { judgeOverlays } from '../lib/judge-overlays.mjs';

/**
 * THE TWO CODES, WATCHED FIRING.
 *
 * Phase 7's per-release gate asks for "zero `stale-name` and zero
 * `out-of-bounds` over the stored document". Both are properties of rows in a
 * database, so the check itself is `scripts/check-stored-overlays.mjs`, a
 * read-only release step run by a human with credentials - `npm test` has none.
 *
 * That would leave its judgement unproven, and "point it at production and hope
 * a bad row turns up" is not a proof. Run against production today it reports
 * 1 document, 9 entries, 0 name-targeted, both codes zero - which is the right
 * answer and demonstrates nothing at all about whether it can say anything
 * else. So the judgement is a pure module, and this file makes it say the
 * other things.
 */

const KNOWN = new Set(['skyline:panel', 'dressing:hazard', 'monument:trim']);

test('a document that targets only live names is clean', () => {
  const v = judgeOverlays([{
    world_id: 'station', version: 4, entries: [
      { name: 'skyline:panel', to: { x: 1, y: 2, z: 3 } },
      { name: 'monument:trim' },
    ],
  }], KNOWN);
  assert.deepEqual(v.problems, []);
  assert.equal(v.staleName, 0);
  assert.equal(v.targeted, 2);
});

test('an entry targeting a retired name is stale-name, and is named', () => {
  /* THE C1 HAZARD. A Phase 7 release that renames without an alias table
   * leaves rows that report applied and apply to nothing - and because
   * stale-name is only a WARNING in the site's conflict pass, the document
   * still saves green. */
  const v = judgeOverlays([{
    world_id: 'station', version: 7, entries: [{ name: 'skyline:panelWarm' }],
  }], KNOWN);
  assert.equal(v.staleName, 1);
  assert.match(v.problems[0], /STALE-NAME station v7 -> "skyline:panelWarm" is not in the catalogue/);
});

test('a non-finite position is out-of-bounds, and is named', () => {
  /* THE C7 HAZARD, and the expensive one: out-of-bounds is the only
   * error-level conflict and hasErrors refuses the WHOLE document, so one bad
   * row 400s an admin on a row they never touched. */
  const v = judgeOverlays([{
    world_id: 'station', version: 2, entries: [{ position: { x: 0, y: NaN, z: 12 } }],
  }], KNOWN);
  assert.equal(v.outOfBounds, 1);
  assert.match(v.problems[0], /OUT-OF-BOUNDS station v2/);
});

test('a targeted entry in a world with no pin is UNJUDGED, never a silent pass', () => {
  /* Only the station has a catalogue pin in this tree. A world nobody is
   * checking must not read as a world with no problems - which is the shape of
   * half the defects this whole effort has turned up, including a canary that
   * had been matching owner strings that stopped existing. */
  const v = judgeOverlays([{
    world_id: 'medieval', version: 1, entries: [{ name: 'anything-at-all' }],
  }], KNOWN);
  assert.equal(v.staleName, 0, 'it must not be counted as stale - nothing knows whether it is');
  assert.equal(v.unjudged, 1);
  assert.match(v.problems[0], /UNJUDGED\s+medieval targets "anything-at-all"/);
});

test('an entry with no target and no position is counted and judged clean', () => {
  /* Every stored entry in production today is a `place`, which carries no
   * target name. They must still be counted, so the report can say how much of
   * the document was looked at. */
  const v = judgeOverlays([{
    world_id: 'station', version: 9, entries: [{ item: 'crate' }, { item: 'barrel' }],
  }], KNOWN);
  assert.equal(v.entries, 2);
  assert.equal(v.targeted, 0);
  assert.deepEqual(v.problems, []);
});

test('a malformed entries column does not throw', () => {
  /* The column is JSONB and nothing constrains its shape. A release step that
   * crashed on one odd row would report nothing about all the others. */
  assert.doesNotThrow(() => judgeOverlays([
    { world_id: 'station', version: 1, entries: null },
    { world_id: 'station', version: 2, entries: 'not an array' },
    { world_id: 'station', version: 3, entries: [null, undefined] },
  ], KNOWN));
});
