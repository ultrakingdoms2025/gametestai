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
 * Two shapes are read, in either quote style, and only at a push site — `unresolved.push({ … reason: … })` is the
 * anchor: the plain `reason: 'word'` (or `reason: "word"`) literal, and the one ternary — `reason: cond ? 'a' : 'b'`
 * — that chooses between two. The anchor is what keeps a COMMENT out: a doc line that says `reason: 'foo'` is not a
 * push and is not read (the fixture below proves it), where an unanchored `reason:` read would pin a phantom reason
 * and fail loud on the game side for a word nothing pushes. A shape this cannot read — a template literal, a
 * variable, a lookup, a reason pushed through anything but `unresolved.push({` — is read as NOTHING. If the site
 * labels that reason too, the set comparison fails loud on the site's extra key; if the site never labelled it, a
 * NEW reason in an unreadable shape passes SILENTLY — the residual blindness of a textual pin, so keep every reason
 * a quoted literal at an `unresolved.push({` site.
 *
 * An absent game file SKIPS, with a message that says so, never passes: a pin that passed on an absent file would
 * be the gate-that-measures-nothing shape this repository has paid for many times over.
 */

const APPLIER = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'systems', 'MapOverlay.js');
const NOT_MERGED = 'game branch not merged here; the pin is inert until both branches are in one tree';

/** Every reason literal the applier can push, from the two shapes it is written in, in either quote style, at a push site. */
function applierReasons(src: string): string[] {
  const found = new Set<string>();
  for (const m of src.matchAll(/unresolved\.push\(\{[^}]*reason: (['"])([a-z-]+)\1/g)) found.add(m[2]);
  for (const m of src.matchAll(/unresolved\.push\(\{[^}]*reason: [^\n]*?\? (['"])([a-z-]+)\1 : (['"])([a-z-]+)\3/g)) {
    found.add(m[2]);
    found.add(m[4]);
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

  it('reads both shapes the game writes a reason in — the plain literal and the ternary — in either quote style, and only at a push site', () => {
    const src = [
      "      // a doc line that says reason: 'foo' (or reason: \"bar\") is not a push and must not be read",
      "      unresolved.push({ id: String(entry.id ?? ''), reason: 'superseded' });",
      "      unresolved.push({ id: String(entry.id ?? ''), reason: version > builtVersion ? 'pending-rebuild' : 'id' });",
      "      unresolved.push({ id: String(entry.id ?? ''), reason: 'name' });",
      "      unresolved.push({ id: String(entry.id ?? ''), reason: 'name' });",
      '      unresolved.push({ id: String(entry.id ?? ""), reason: "www" });',
      '      unresolved.push({ id: String(entry.id ?? ""), reason: pooled ? "pool" : "item" });',
      "      // a comment that says reason `span` in backticks is not a literal",
      "      unresolved.push({ id: String(entry.id ?? ''), reason: `tpl` });",
    ].join('\n');
    // `www`, `pool` and `item` are read from the double-quoted lines; the two comments (`foo`, `bar`, the backticked
    // `span`) and the template literal `tpl` are not — the comment is what the push anchor excludes, the template
    // literal the shape the header says this pin cannot see.
    expect(applierReasons(src)).toEqual(['id', 'item', 'name', 'pending-rebuild', 'pool', 'superseded', 'www']);
  });
});
