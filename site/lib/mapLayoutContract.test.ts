import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAYOUT_SCHEMA, MAX_LAYERS } from './mapLayout';

/**
 * THE LAYOUT CONTRACT, PINNED ACROSS THE GAME/SITE BOUNDARY.
 *
 * `src/systems/GroundSampler.js` (the game) emits a grid under `LAYOUT_SCHEMA` with up to `MAX_LAYERS`
 * surfaces per cell; `lib/mapLayout.ts` (the site) decodes it under the same two numbers. Nothing imports
 * across that boundary — the game is plain ES modules, the site is TypeScript — so nothing but a test can
 * notice when one side moves and the other does not. The failure that would follow is exactly the one the
 * report route now names: every layout report answered `kept-prior` with `layoutSchema 2 is not 1`, and
 * no map for anyone. This reads the game file TEXTUALLY, as `scripts/tests/map-overlay-layout.test.mjs`
 * reads `main.js`, and compares the literals.
 *
 * ── Why it may skip, and why the skip is loud ─────────────────────────────
 *
 * Stage 1 was built on two branches: the game's sampler on `map-editor-game`, the site's editor on
 * `map-editor-stage1`. In a checkout of the site branch alone the game file is not there — not renamed,
 * not moved: absent — and a pin that passed on an absent file would be the gate-that-measures-nothing
 * shape this repository has paid for nine times. So an absent file SKIPS, with a message that says so,
 * never passes. The moment both branches are in one tree the skip disappears and the pin is live.
 */

const SAMPLER = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'systems', 'GroundSampler.js');
const NOT_MERGED = 'game branch not merged here; the pin is inert until both branches are in one tree';

describe('the layout contract between GroundSampler.js and mapLayout.ts', () => {
  it('agrees on LAYOUT_SCHEMA and the layer count', (ctx) => {
    if (!existsSync(SAMPLER)) return ctx.skip(NOT_MERGED);
    const src = readFileSync(SAMPLER, 'utf8');
    const schema = /^export const LAYOUT_SCHEMA = (\d+);/m.exec(src);
    const layers = /^export const MAX_LAYERS = (\d+);/m.exec(src);
    expect(schema, 'GroundSampler.js exports no LAYOUT_SCHEMA literal to pin').not.toBeNull();
    expect(layers, 'GroundSampler.js exports no MAX_LAYERS literal to pin').not.toBeNull();
    expect(Number(schema![1])).toBe(LAYOUT_SCHEMA);
    expect(Number(layers![1])).toBe(MAX_LAYERS);
  });
});
