import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEVEN_SEGMENT, GLYPH_W, GLYPH_STROKE, GLYPH_GAP,
  digitBars, floorNumeral, INTERIOR_HIDE_R, entranceReach,
} from '../../src/worlds/station/Tower.js';
import { SIGN_COLS, SIGN_ROWS } from '../../src/worlds/station/StationKit.js';
import { pastBand, DEFAULT_BAND } from '../../src/worlds/lod/DistanceLod.js';

/**
 * "Each floor should have a number to let you know what floor you are on."
 *
 * None of the drawing can be reached from Node - `buildTower` needs a world,
 * its materials and its physics - so what is checked here is the arithmetic the
 * drawing is made of, which is the same arrangement `escalatorDeckDrop` and
 * `stringCourseRuns` already use in this suite.
 *
 * Three things are worth asserting and one is worth restating as a defect:
 *
 *   - the glyphs are legible as digits (every digit distinct, none empty);
 *   - no two bars of a glyph share a face, because a coincident pair is exactly
 *     what a whole session has just gone into removing from this world;
 *   - the plate is big enough to sit behind the glyphs it backs;
 *   - the reason this is not a signage-atlas cell, restated independently:
 *     the atlas is full.
 */

/* ------------------------------------------------------------------ */
/* Why not the sign atlas                                              */
/* ------------------------------------------------------------------ */

test('the signage atlas has no free cell, which is why numerals are geometry', () => {
  // The brief said to check capacity before assuming a cell could be added.
  // Reserved roles, transcribed independently from SIGN_ROLE's own listing.
  const RESERVED_ROLES = 44;      // shopFirst 0-11 .. surveyEnquiries 43
  assert.equal(SIGN_COLS * SIGN_ROWS, 44, 'atlas is 4 x 11');
  assert.equal(
    SIGN_COLS * SIGN_ROWS - RESERVED_ROLES, 0,
    'every atlas cell is reserved by role; a floor number cannot borrow one'
  );
});

/* ------------------------------------------------------------------ */
/* The glyphs                                                          */
/* ------------------------------------------------------------------ */

test('every digit lights a distinct, non-empty set of segments', () => {
  const seen = new Map();
  for (let d = 0; d <= 9; d++) {
    const on = SEVEN_SEGMENT[String(d)];
    assert.ok(on && on.length >= 2, `digit ${d} lights ${on?.length ?? 0} segments`);
    for (const c of on) assert.ok('abcdefg'.includes(c), `digit ${d}: unknown segment "${c}"`);
    const key = [...on].sort().join('');
    assert.equal(seen.get(key), undefined, `digits ${seen.get(key)} and ${d} are the same shape`);
    seen.set(key, d);
  }
});

test('digitBars returns one box per lit segment, and scales with cap height', () => {
  for (let d = 0; d <= 9; d++) {
    assert.equal(digitBars(d, 1).length, SEVEN_SEGMENT[String(d)].length);
    const small = digitBars(d, 0.5);
    const big = digitBars(d, 1.0);
    for (let i = 0; i < small.length; i++) {
      assert.ok(Math.abs(small[i].h * 2 - big[i].h) < 1e-9, `digit ${d} bar ${i} height does not scale`);
      assert.ok(Math.abs(small[i].w * 2 - big[i].w) < 1e-9, `digit ${d} bar ${i} width does not scale`);
    }
  }
});

test('digitBars fits inside its own cell', () => {
  const h = 0.6;
  for (let d = 0; d <= 9; d++) {
    for (const b of digitBars(d, h)) {
      assert.ok(Math.abs(b.u) + b.w / 2 <= GLYPH_W * h / 2 + 1e-9, `digit ${d} overflows the cell in u`);
      assert.ok(Math.abs(b.v) + b.h / 2 <= h / 2 + 1e-9, `digit ${d} overflows the cell in v`);
    }
  }
});

/**
 * The defect this guards against, stated as the thing that would be wrong.
 *
 * Two boxes that share a face are the coplanar pair the depth buffer cannot
 * order, and 323 of them were removed from this world in the change immediately
 * before this one. A seven-segment glyph is the easiest place in the world to
 * reintroduce them, because the obvious layout runs every horizontal bar the
 * full cell width and butts it against the verticals.
 */
test('no two bars of a glyph touch, so no glyph can z-fight itself', () => {
  const h = 0.62;
  for (let d = 0; d <= 9; d++) {
    const bars = digitBars(d, h);
    for (let i = 0; i < bars.length; i++) {
      for (let j = i + 1; j < bars.length; j++) {
        const a = bars[i], b = bars[j];
        const du = Math.abs(a.u - b.u) - (a.w + b.w) / 2;
        const dv = Math.abs(a.v - b.v) - (a.h + b.h) / 2;
        // Separated on at least one axis by a real gap, not by exactly zero.
        assert.ok(
          du > 1e-6 || dv > 1e-6,
          `digit ${d}: bars ${i} and ${j} touch or overlap (du=${du.toFixed(6)}, dv=${dv.toFixed(6)})`
        );
      }
    }
  }
});

/* ------------------------------------------------------------------ */
/* The whole sign                                                      */
/* ------------------------------------------------------------------ */

test('a floor numeral is centred and its plate covers every bar', () => {
  for (let n = 1; n <= 24; n++) {
    const { bars, plate } = floorNumeral(n, 0.6);
    assert.ok(bars.length > 0, `floor ${n} drew nothing`);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const b of bars) {
      u0 = Math.min(u0, b.u - b.w / 2); u1 = Math.max(u1, b.u + b.w / 2);
      v0 = Math.min(v0, b.v - b.h / 2); v1 = Math.max(v1, b.v + b.h / 2);
    }
    assert.ok(plate.w / 2 > u1 && -plate.w / 2 < u0, `floor ${n}: plate is narrower than its glyphs`);
    assert.ok(plate.h / 2 > v1 && -plate.h / 2 < v0, `floor ${n}: plate is shorter than its glyphs`);
    // Centred: the drawn extent is symmetric about zero to within a rounding.
    assert.ok(Math.abs(u0 + u1) < 1e-9, `floor ${n}: glyphs are not centred (${u0}..${u1})`);
  }
});

test('two-digit floors are laid out left to right with a gap, not overlapped', () => {
  const h = 0.6;
  const { bars } = floorNumeral(18, h);   // "1" then "8": disjoint, easy to separate
  assert.equal(bars.length, SEVEN_SEGMENT['1'].length + SEVEN_SEGMENT['8'].length);
  /* There must be a vertical line no bar crosses, with the "1"'s two strokes on
   * one side of it and the "8"'s seven on the other. Stated as a gap rather
   * than as "u < 0" because the number is centred on its ink, so a "1" - which
   * lights only its right-hand strokes - does not sit where its cell does. */
  const sorted = [...bars].sort((a, b) => (a.u - a.w / 2) - (b.u - b.w / 2));
  const leftMax = Math.max(...sorted.slice(0, 2).map((b) => b.u + b.w / 2));
  const rightMin = Math.min(...sorted.slice(2).map((b) => b.u - b.w / 2));
  assert.ok(
    rightMin - leftMax > GLYPH_GAP * h * 0.5,
    `the two glyphs run into each other (gap ${(rightMin - leftMax).toFixed(4)} m)`
  );
});

test('the glyph cell is narrower than it is tall, as digits are', () => {
  assert.ok(GLYPH_W < 1, 'a digit cell wider than it is tall does not read as a digit');
  assert.ok(GLYPH_STROKE * 3 < 1, 'three stroke widths must fit in the cap height');
});

/* ------------------------------------------------------------------ */
/* The interior LOD band                                               */
/* ------------------------------------------------------------------ */

/**
 * The band has to be wide enough that the fit-out is already drawn by the time
 * a player is close enough to see through the door.
 *
 * The failure mode is not subtle and is worth naming: a band tight enough to
 * save the most triangles puts the transition ON the threshold, so the room
 * you are walking into materialises as you cross it.
 */
test('the interior is drawn well before a player reaches the entrance steps', () => {
  for (const d of [22, 24, 26]) {
    const reach = entranceReach(d);
    // `pastBand` promotes at `threshold - band`; that is the distance at which
    // the interior is guaranteed drawn.
    const drawnFrom = INTERIOR_HIDE_R - DEFAULT_BAND;
    assert.ok(
      drawnFrom > reach + 8,
      `d=${d}: interior only draws from ${drawnFrom} m but the steps reach ${reach} m`
    );
  }
});

test('the band has hysteresis, so standing on it cannot strobe', () => {
  // Walking out: hidden only once genuinely past the threshold.
  assert.equal(pastBand(false, INTERIOR_HIDE_R - 0.01, INTERIOR_HIDE_R, DEFAULT_BAND), false);
  assert.equal(pastBand(false, INTERIOR_HIDE_R + 0.01, INTERIOR_HIDE_R, DEFAULT_BAND), true);
  // Walking back in: shown again early, at threshold - band.
  assert.equal(pastBand(true, INTERIOR_HIDE_R - DEFAULT_BAND + 0.01, INTERIOR_HIDE_R, DEFAULT_BAND), true);
  assert.equal(pastBand(true, INTERIOR_HIDE_R - DEFAULT_BAND - 0.01, INTERIOR_HIDE_R, DEFAULT_BAND), false);
});
