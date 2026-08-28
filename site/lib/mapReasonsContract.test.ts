import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPLIER_REASON_TEXT } from './mapEditorState';

/**
 * THE REASONS CONTRACT, PINNED ACROSS THE GAME/SITE BOUNDARY.
 *
 * `src/systems/MapOverlay.js` (the game) pushes `{ id, reason }` for every entry it could not apply, and
 * `lib/mapEditorState.ts` (the site) turns each reason into words on the report card. Nothing imports across
 * that boundary — the game is plain ES modules, the site is TypeScript — so nothing but a test can notice when
 * one side grows a reason the other does not know. That is exactly what happened once: the applier reached ten
 * reasons while the card labelled five, and the other five printed raw (`item`, `no-loot`, `pool`…) beside an
 * id, for weeks, with every unit test green. `unresolvedText`'s own test could not catch it: its list of
 * reasons was typed by hand from the same memory that typed the labels. This reads the game file TEXTUALLY, as
 * `mapLayoutContract.test.ts` reads `GroundSampler.js`, and holds the two sets equal — both directions, so a
 * reason the game DROPS is noticed too, rather than living on as a label nothing can reach.
 *
 * Two shapes are read: the plain `reason: 'word'` literal, and the one ternary — `reason: cond ? 'a' : 'b'` —
 * that chooses between two. A third shape the game may grow (a variable, a lookup) would be read as NOTHING,
 * and the set comparison would then fail on the site's extra key, which is the loud failure wanted: a reason
 * this test cannot read is a reason it cannot pin.
 *
 * An absent game file SKIPS, with a message that says so, never passes: a pin that passed on an absent file would
 * be the gate-that-measures-nothing shape this repository has paid for many times over.
 */

const APPLIER = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'systems', 'MapOverlay.js');
const NOT_MERGED = 'game branch not merged here; the pin is inert until both branches are in one tree';

/** Every reason literal the applier can push, from the two shapes it is written in. */
function applierReasons(src: string): string[] {
  const found = new Set<string>();
  for (const m of src.matchAll(/reason: '([a-z-]+)'/g)) found.add(m[1]);
  for (const m of src.matchAll(/reason: [^\n]*?\? '([a-z-]+)' : '([a-z-]+)'/g)) {
    found.add(m[1]);
    found.add(m[2]);
  }
  return [...found].sort();
}

describe('the reasons contract between MapOverlay.js and mapEditorState.ts', () => {
  it('the reasons the applier can push are exactly the keys of APPLIER_REASON_TEXT', (ctx) => {
    if (!existsSync(APPLIER)) return ctx.skip(NOT_MERGED);
    const game = applierReasons(readFileSync(APPLIER, 'utf8'));
    expect(game, 'MapOverlay.js holds no reason literal to pin').not.toHaveLength(0);
    expect(game).toEqual([...APPLIER_REASON_TEXT.keys()].sort());
  });

  it('reads both shapes the game writes a reason in — the plain literal and the ternary', () => {
    const src = [
      "      unresolved.push({ id: String(entry.id ?? ''), reason: 'superseded' });",
      "      unresolved.push({ id: String(entry.id ?? ''), reason: version > builtVersion ? 'pending-rebuild' : 'id' });",
      "      unresolved.push({ id: String(entry.id ?? ''), reason: 'name' });",
      "      unresolved.push({ id: String(entry.id ?? ''), reason: 'name' });",
      "      // a comment that says reason `span` in backticks is not a literal",
    ].join('\n');
    expect(applierReasons(src)).toEqual(['id', 'name', 'pending-rebuild', 'superseded']);
  });
});
