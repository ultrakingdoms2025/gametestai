import * as THREE from 'three';
import {
  configureTextures, bakeSurface, makeGradientTexture,
  fbm01, fbm2D, ridgedFbm2D, perlin2D, worley2D, WORLEY, domainWarp2D, WARP,
  hash2D, smoothstep, clamp01, mix, yieldFrame,
} from './Textures.js';

/**
 * The shared PBR material library.
 *
 * Every surface in the game comes from here. Materials are cached and shared -
 * a world asking for `metal.hull` twice gets the same instance, so 900 hull
 * plates cost one material and one shader program.
 *
 * Authoring rules used throughout:
 * - `roughness` and `metalness` scalars are pinned to **1** and the packed ORM
 *   map drives the real values (glTF workflow). Multiplying by 1 keeps the map
 *   authoritative and makes every surface tunable from one texture.
 * - `map`, `normalMap` and the ORM map are non-negotiable. A material with a
 *   flat colour and no normal is a bug, not a style.
 * - UV tiling is left at `repeat = 1` on the base material and each material
 *   publishes `userData.tileMeters` - the world-space size one UV tile is
 *   authored for. Worlds call {@link MaterialLibrary#scaled} (or use the
 *   `'key:repeat'` shorthand in `get`) to get a correctly tiled clone; the
 *   clone shares GPU texture storage, so it is nearly free.
 */

/* Detail budget. Hero surfaces are the ones the player stands on or walks up to. */
const HERO = 512;
const SMALL = 256;

/* ------------------------------------------------------------------ */
/* Surface shaders                                                     */
/*                                                                     */
/* Each function is evaluated once per texel by bakeSurface(). They are */
/* deliberately allocation-free: all noise helpers write to module-level */
/* scratch arrays.                                                      */
/* ------------------------------------------------------------------ */

/** Brushed structural steel: butt-welded plates, panel scoring, scuffed edges. */
function shadeMetalHull(u, v, o) {
  const px = 3;
  const py = 2;
  const row = Math.floor(v * py);
  // Half-plate stagger on alternate rows so seams never form a continuous cross.
  const fu = (u + (row & 1) * (0.5 / px)) * px;
  const fv = v * py;
  const cu = fu - Math.floor(fu);
  const cv = fv - Math.floor(fv);
  const dSeam = Math.min(Math.min(cu, 1 - cu) / px, Math.min(cv, 1 - cv) / py);
  const groove = 1 - smoothstep(0.0015, 0.006, dSeam);
  const bevel = 1 - smoothstep(0.006, 0.026, dSeam);

  // Anisotropic FBM = brushed grain. High frequency across v, low across u.
  const brush = fbm01(u, v, 6, 384, 3, 11, 0.55);
  const micro = perlin2D(u * 32, v * 1024, 32, 1024, 77) * 0.5 + 0.5;
  const mottle = fbm01(u, v, 4, 4, 4, 3);

  // One wandering weld bead per tile - a ruled straight line reads as CAD, not steel.
  const wobble = perlin2D(u * 24, 0.5, 24, 1, 5) * 0.005;
  const weld = 1 - smoothstep(0.004, 0.014, Math.abs(v - 0.5 + wobble));
  const bead = (Math.sin(u * Math.PI * 2 * 110) * 0.5 + 0.5) * weld;

  worley2D(u, v, 5, 5, 21, 1);
  const stain = (1 - smoothstep(0.10, 0.42, WORLEY[0])) * fbm01(u, v, 20, 20, 3, 33);

  const steel = 0.55 + brush * 0.12 + (mottle - 0.5) * 0.07 + (micro - 0.5) * 0.03;
  let r = steel * 0.97;
  let g = steel;
  let b = steel * 1.06;

  const gk = mix(1, 0.5, groove);
  r *= gk; g *= gk; b *= gk;

  const wear = bevel * (0.5 + brush * 0.5) * 0.11;
  r += wear; g += wear; b += wear * 0.95;

  r = mix(r, 0.50 + bead * 0.20, weld * 0.85);
  g = mix(g, 0.48 + bead * 0.17, weld * 0.85);
  b = mix(b, 0.54 + bead * 0.13, weld * 0.85);

  r = mix(r, 0.20, stain * 0.55);
  g = mix(g, 0.17, stain * 0.55);
  b = mix(b, 0.15, stain * 0.55);

  o.r = r; o.g = g; o.b = b;
  o.h = 0.55 - groove * 0.35 + weld * (0.06 + bead * 0.09)
    + (brush - 0.5) * 0.05 + (mottle - 0.5) * 0.05 + (micro - 0.5) * 0.035;
  o.rough = clamp01(0.33 + (1 - brush) * 0.17 + groove * 0.22 + stain * 0.34 - bevel * 0.07);
  o.metal = clamp01(1 - stain * 0.55 - weld * 0.08);
  o.ao = clamp01(1 - groove * 0.55 - stain * 0.2);
}

/** Painted bulkhead panel: riveted borders, chipped paint over bare alloy, settled grime. */
function shadeMetalPanel(u, v, o) {
  const n = 2;
  const fu = u * n;
  const fv = v * n;
  const cu = fu - Math.floor(fu);
  const cv = fv - Math.floor(fv);
  const dU = Math.min(cu, 1 - cu) / n;
  const dV = Math.min(cv, 1 - cv) / n;
  const groove = 1 - smoothstep(0.001, 0.005, Math.min(dU, dV));

  // Rivets march along both seam directions, 16 to a tile edge.
  const alongV = (Math.abs(((v * 16) % 1) - 0.5)) / 16;
  const alongU = (Math.abs(((u * 16) % 1) - 0.5)) / 16;
  const a1 = dU - 0.016;
  const a2 = dV - 0.016;
  const rd = Math.min(Math.sqrt(a1 * a1 + alongV * alongV), Math.sqrt(a2 * a2 + alongU * alongU));
  const rivet = 1 - smoothstep(0.0055, 0.0078, rd);
  const dome = Math.sqrt(Math.max(0, 1 - Math.min(1, rd / 0.0078) ** 2));

  const pid = hash2D(Math.floor(fu), Math.floor(fv), 47);
  const peel = fbm01(u, v, 48, 48, 3, 61, 0.5);
  const dirt = fbm01(u, v, 6, 6, 4, 71);

  // Two crossing scratch sets - a single direction reads as combed hair.
  const s1 = Math.pow(ridgedFbm2D(u, v, 5, 70, 3, 83), 7);
  const s2 = Math.pow(ridgedFbm2D(v, u, 6, 90, 3, 97), 8);
  const scratch = clamp01(s1 * 1.7 + s2 * 1.3);

  let r = 0.42 + pid * 0.07 + (peel - 0.5) * 0.05;
  let g = 0.45 + pid * 0.06 + (peel - 0.5) * 0.05;
  let b = 0.45 + pid * 0.05 + (peel - 0.5) * 0.05;

  const gk = mix(1, 0.62, groove);
  r *= gk; g *= gk; b *= gk;

  const grime = clamp01(dirt * 0.55 + groove * 0.6) * (0.3 + dirt * 0.55);
  r = mix(r, 0.17, grime * 0.5);
  g = mix(g, 0.15, grime * 0.5);
  b = mix(b, 0.13, grime * 0.5);

  r = mix(r, 0.66, scratch);
  g = mix(g, 0.68, scratch);
  b = mix(b, 0.71, scratch);

  const rivetLight = rivet * (dome * 0.12 - 0.03);
  o.r = r + rivetLight; o.g = g + rivetLight; o.b = b + rivetLight * 1.05;
  o.h = 0.5 - groove * 0.3 + rivet * dome * 0.34 + (peel - 0.5) * 0.11 - scratch * 0.07;
  o.rough = clamp01(0.56 + (peel - 0.5) * 0.15 + grime * 0.25 - scratch * 0.3 + groove * 0.1);
  o.metal = clamp01(scratch * 0.9 + rivet * 0.3);
  o.ao = clamp01(1 - groove * 0.5 - grime * 0.25);
}

/** Galvanised diamond-plate grating. Alpha carves out the real perforations. */
function shadeMetalGrate(u, v, o) {
  const n = 7;
  const fu = u * n;
  const fv = v * n;
  const cu = fu - Math.floor(fu) - 0.5;
  const cv = fv - Math.floor(fv) - 0.5;
  const dia = Math.abs(cu) + Math.abs(cv);
  const hole = 1 - smoothstep(0.25, 0.31, dia);
  o.a = 1 - hole;

  const bar = smoothstep(0.29, 0.42, dia);
  const cross = smoothstep(0.60, 0.95, dia);
  const grit = fbm01(u, v, 96, 96, 3, 131);
  const wearN = fbm01(u, v, 5, 5, 3, 141);
  const polish = smoothstep(0.55, 0.9, wearN) * cross;

  const galv = 0.34 + grit * 0.11 + wearN * 0.08 + polish * 0.13;
  o.r = galv; o.g = galv * 1.02; o.b = galv * 1.08;
  o.h = 0.32 + bar * 0.32 + cross * 0.26 + (grit - 0.5) * 0.05;
  o.rough = clamp01(0.52 - polish * 0.24 + (1 - grit) * 0.12);
  o.metal = 0.95;
  o.ao = clamp01(0.5 + bar * 0.5);
}

/** Polished trim / handrail alloy: fine circumferential brushing, hand smudges. */
function shadeMetalTrim(u, v, o) {
  const brush = fbm01(u, v, 4, 512, 3, 211, 0.55);
  const micro = fbm01(u, v, 8, 1024, 2, 217, 0.5);
  const scratch = Math.pow(ridgedFbm2D(u, v, 3, 120, 3, 223), 9);
  const smudge = fbm01(u, v, 7, 7, 3, 229);

  const base = 0.70 + brush * 0.13 + (micro - 0.5) * 0.05 + scratch * 0.10;
  o.r = base * 0.99; o.g = base; o.b = base * 1.03;
  o.h = 0.5 + (brush - 0.5) * 0.05 + (micro - 0.5) * 0.03 - scratch * 0.06;
  o.rough = clamp01(0.15 + (1 - brush) * 0.13 + smudge * 0.11 - scratch * 0.05);
  o.metal = 1;
  o.ao = 1;
}

/** Scuffed steel handrail / skate rail: wax-polished crown, boot scuffs. */
function shadeMetalRail(u, v, o) {
  const brush = fbm01(u, v, 3, 420, 3, 241, 0.55);
  const scuff = Math.pow(ridgedFbm2D(u, v, 2, 90, 3, 247), 5);
  const wax = smoothstep(0.45, 0.85, fbm01(u, v, 3, 12, 3, 251));
  const grime = fbm01(u, v, 14, 14, 3, 257);

  const base = 0.50 + brush * 0.14 + scuff * 0.22;
  let r = base * 0.98;
  let g = base;
  let b = base * 1.04;
  r = mix(r, 0.20, grime * 0.28);
  g = mix(g, 0.19, grime * 0.28);
  b = mix(b, 0.18, grime * 0.28);

  o.r = r; o.g = g; o.b = b;
  o.h = 0.5 + (brush - 0.5) * 0.06 - scuff * 0.04;
  o.rough = clamp01(0.38 - wax * 0.2 - scuff * 0.15 + grime * 0.2);
  o.metal = clamp01(0.95 - grime * 0.2);
  o.ao = clamp01(1 - grime * 0.12);
}

/** Hand-forged wrought iron: hammer facets, pitting, rust blooms at the joints. */
function shadeIron(u, v, o) {
  const hammer = fbm01(u, v, 14, 14, 3, 2001);
  const facet = fbm01(u, v, 5, 5, 2, 2007);
  const grit = fbm01(u, v, 110, 110, 2, 2011);
  worley2D(u, v, 9, 9, 2017, 1);
  const rust = clamp01((1 - smoothstep(0.05, 0.35, WORLEY[0])) * smoothstep(0.32, 0.8, fbm01(u, v, 20, 20, 3, 2023)));

  const base = 0.13 + hammer * 0.11 + facet * 0.06 + (grit - 0.5) * 0.04;
  let r = base;
  let g = base * 0.99;
  let b = base * 1.04;
  r = mix(r, 0.40, rust * 0.9);
  g = mix(g, 0.19, rust * 0.9);
  b = mix(b, 0.08, rust * 0.9);

  o.r = r; o.g = g; o.b = b;
  o.h = 0.5 + (hammer - 0.5) * 0.3 + (facet - 0.5) * 0.15 + (grit - 0.5) * 0.10;
  o.rough = clamp01(0.42 + (1 - hammer) * 0.15 + rust * 0.42);
  o.metal = clamp01(1 - rust * 0.75);
  o.ao = clamp01(1 - rust * 0.12);
}

/** Cast roadway slab: exposed aggregate, saw-cut joints, burnished traffic lanes. */
function shadeConcreteRoad(u, v, o) {
  worley2D(u, v, 56, 56, 313, 1);
  const agg = smoothstep(0.02, 0.26, WORLEY[0]);
  const aggId = WORLEY[2];
  const fine = fbm01(u, v, 90, 90, 2, 317, 0.5);
  const broad = fbm01(u, v, 3, 3, 4, 323);
  const medium = fbm01(u, v, 12, 12, 3, 331);

  const jU = Math.min((u * 2) % 1, 1 - ((u * 2) % 1)) * 0.5;
  const jV = Math.min(v, 1 - v);
  const joint = 1 - smoothstep(0.0015, 0.005, Math.min(jU, jV));

  // Traffic polish is noise-driven rather than a fixed band, so a 30x tiled road
  // never shows the same burnish stripe marching into the distance.
  const polish = smoothstep(0.52, 0.86, fbm01(u, v, 2, 7, 3, 337));
  const damp = smoothstep(0.62, 0.9, fbm01(u, v, 4, 4, 3, 347));

  const grey = 0.45 + broad * 0.12 + medium * 0.06 + (fine - 0.5) * 0.06;
  let r = grey;
  let g = grey * 0.995;
  let b = grey * 0.96;

  const stone = (1 - agg) * (0.4 + aggId * 0.6);
  r = mix(r, 0.32 + aggId * 0.18, stone * 0.55);
  g = mix(g, 0.31 + aggId * 0.16, stone * 0.55);
  b = mix(b, 0.30 + aggId * 0.14, stone * 0.55);

  const jk = mix(1, 0.42, joint);
  r *= jk; g *= jk; b *= jk;

  const pk = mix(1, 0.74, polish);
  r *= pk; g *= pk; b *= pk;

  const dk = mix(1, 0.62, damp * 0.8);
  r *= dk; g *= dk; b *= dk * 1.03;

  o.r = r; o.g = g; o.b = b;
  o.h = 0.5 - joint * 0.4 + (1 - agg) * 0.15 + (medium - 0.5) * 0.09 + (fine - 0.5) * 0.09;
  o.rough = clamp01(0.88 - polish * 0.30 - damp * 0.38 + (fine - 0.5) * 0.1 + joint * 0.05);
  o.metal = 0;
  o.ao = clamp01(1 - joint * 0.55 - (1 - agg) * 0.12);
}

/** Board-formed concrete wall: shutter lines, tie holes, rain streaking, spalls. */
function shadeConcreteWall(u, v, o) {
  const rows = 5;
  const fv = v * rows;
  const rowFrac = fv - Math.floor(fv);
  const board = 1 - smoothstep(0.0, 0.012, Math.min(rowFrac, 1 - rowFrac));

  const cols = 3;
  const tu = Math.abs(((u * cols) % 1) - 0.5) / cols;
  const tv = Math.abs(((v * rows) % 1) - 0.5) / rows;
  const tie = 1 - smoothstep(0.006, 0.011, Math.sqrt(tu * tu + tv * tv));

  const fine = fbm01(u, v, 80, 80, 2, 401);
  const broad = fbm01(u, v, 3, 3, 4, 409);
  worley2D(u, v, 40, 40, 419, 1);
  const pits = 1 - smoothstep(0.0, 0.10, WORLEY[0]);
  // Rain runs downhill: low horizontal frequency, high vertical frequency.
  const streak = Math.pow(fbm01(u, v, 42, 3, 3, 421), 2.2);
  const spall = smoothstep(0.74, 0.96, fbm01(u, v, 18, 18, 3, 431));

  const grey = 0.50 + broad * 0.10 + (fine - 0.5) * 0.05;
  let r = grey;
  let g = grey * 0.995;
  let b = grey * 0.97;

  const bk = mix(1, 0.88, board);
  r *= bk; g *= bk; b *= bk;

  r = mix(r, r * 0.68, streak * 0.55);
  g = mix(g, g * 0.68, streak * 0.55);
  b = mix(b, b * 0.72, streak * 0.55);

  r = mix(r, 0.38, spall * 0.5);
  g = mix(g, 0.37, spall * 0.5);
  b = mix(b, 0.35, spall * 0.5);

  const tk = mix(1, 0.45, tie);
  r *= tk; g *= tk; b *= tk;

  o.r = r; o.g = g; o.b = b;
  o.h = 0.5 - board * 0.12 - tie * 0.4 + (broad - 0.5) * 0.1 + (fine - 0.5) * 0.10 - pits * 0.28 - spall * 0.18;
  o.rough = clamp01(0.9 - streak * 0.12 + (fine - 0.5) * 0.08);
  o.metal = 0;
  o.ao = clamp01(1 - board * 0.25 - tie * 0.5 - pits * 0.2 - spall * 0.15);
}

/** Weathered ashlar: irregular blocks, recessed mortar, lichen, water staining. */
function shadeStoneCastle(u, v, o) {
  const rows = 5;
  const cols = 3;
  const fv = v * rows;
  const row = Math.floor(fv);
  const cv = fv - row;
  const fu = u * cols + (row & 1) * 0.5;
  const col = Math.floor(fu) % cols;
  const cu = fu - Math.floor(fu);

  // Nudge the joint line with noise so no two blocks share an edge profile.
  const wob = perlin2D(u * 24, v * 24, 24, 24, 501) * 0.006;
  const d = Math.min(Math.min(cu, 1 - cu) / cols, Math.min(cv, 1 - cv) / rows) + wob;
  const mortar = 1 - smoothstep(0.004, 0.011, d);
  const chamfer = 1 - smoothstep(0.011, 0.032, d);

  const bid = hash2D(col, row, 511);
  const pit = ridgedFbm2D(u, v, 60, 60, 3, 521);
  const grit = fbm01(u, v, 110, 110, 2, 523);
  const coarse = fbm01(u, v, 14, 14, 3, 527);
  const tool = fbm01(u, v, 8, 90, 2, 529);

  worley2D(u, v, 7, 7, 541, 1);
  const lichen = clamp01((1 - smoothstep(0.05, 0.34, WORLEY[0]))
    * smoothstep(0.35, 0.72, fbm01(u, v, 16, 16, 3, 547)) * (0.55 + mortar * 0.8));
  const stain = Math.pow(fbm01(u, v, 30, 4, 3, 553), 2.0);

  const tone = 0.46 + bid * 0.15 + coarse * 0.08 + (grit - 0.5) * 0.05 + (tool - 0.5) * 0.04;
  let r = tone * (1 - pit * 0.12);
  let g = tone * 0.965 * (1 - pit * 0.12);
  let b = tone * 0.90 * (1 - pit * 0.12);

  r = mix(r, 0.56 + grit * 0.08, mortar);
  g = mix(g, 0.55 + grit * 0.07, mortar);
  b = mix(b, 0.52 + grit * 0.06, mortar);

  r = mix(r, 0.24, lichen * 0.75);
  g = mix(g, 0.32, lichen * 0.80);
  b = mix(b, 0.15, lichen * 0.70);

  r = mix(r, r * 0.60, stain * 0.6);
  g = mix(g, g * 0.62, stain * 0.6);
  b = mix(b, b * 0.66, stain * 0.6);

  o.r = r; o.g = g; o.b = b;
  o.h = 0.6 - mortar * 0.45 - chamfer * 0.07 + (coarse - 0.5) * 0.12 - pit * 0.16 + (grit - 0.5) * 0.09;
  o.rough = clamp01(0.84 + lichen * 0.1 - stain * 0.14 + (grit - 0.5) * 0.08);
  o.metal = 0;
  o.ao = clamp01(1 - mortar * 0.6 - chamfer * 0.18 - lichen * 0.1);
}

/** Cobbled setts: domed crowns worn smooth, packed mud and grit in the joints. */
function shadeStoneCobble(u, v, o) {
  worley2D(u, v, 13, 13, 601, 0.85);
  const f1 = WORLEY[0];
  const f2 = WORLEY[1];
  const id = WORLEY[2];
  const edge = smoothstep(0.0, 0.10, f2 - f1);
  const dome = Math.sqrt(Math.max(0, 1 - Math.min(1, f1 / 0.62) ** 2));

  const grit = fbm01(u, v, 120, 120, 2, 607);
  const speck = fbm01(u, v, 40, 40, 3, 613);
  const mud = clamp01((1 - edge) * (0.6 + fbm01(u, v, 24, 24, 3, 617) * 0.6));
  const worn = smoothstep(0.5, 1.0, dome) * edge;

  const tone = 0.28 + id * 0.24 + speck * 0.08 + (grit - 0.5) * 0.06;
  let r = tone * (0.92 + id * 0.16) + worn * 0.10;
  let g = tone * 0.96 + worn * 0.10;
  let b = tone * (1.02 - id * 0.10) + worn * 0.10;

  r = mix(r, 0.20 + grit * 0.05, mud * 0.85);
  g = mix(g, 0.16 + grit * 0.04, mud * 0.85);
  b = mix(b, 0.12 + grit * 0.03, mud * 0.85);

  o.r = r; o.g = g; o.b = b;
  o.h = 0.25 + dome * 0.55 * edge + (grit - 0.5) * 0.04;
  o.rough = clamp01(0.86 - worn * 0.36 + mud * 0.1);
  o.metal = 0;
  o.ao = clamp01(0.45 + edge * 0.55 - mud * 0.15);
}

/** Sawn deck planking: cathedral grain, knots, staggered gaps, uneven silvering. */
function shadeWoodPlank(u, v, o) {
  const n = 5;
  const fv = v * n;
  const pi = Math.floor(fv);
  const cv = fv - pi;
  const id = hash2D(pi, 7, 701);
  const id2 = hash2D(pi, 13, 709);
  const gap = 1 - smoothstep(0.006, 0.020, Math.min(cv, 1 - cv));

  // Warping a sine across the board width is what makes grain read as timber
  // rather than as stripes - the arcs have to wander.
  const warpN = fbm2D(u, v, 3, 24, 3, 720 + pi) * 0.9;
  const rings = Math.abs(Math.sin((cv * 6.5 + warpN * 1.7 + id * 9) * Math.PI));
  const grain = Math.pow(rings, 0.55);
  const fibre = fbm01(u, v, 6, 260, 2, 730 + pi, 0.55);

  // Sparse knots: a knot in every cell reads as a row of nail heads, so only
  // about a third of the cells actually carry one.
  worley2D(u, v, 3, 2, 740, 1);
  const knotD = WORLEY[0];
  const knot = (WORLEY[2] > 0.62 ? 1 : 0) * (1 - smoothstep(0.09, 0.21, knotD));
  const knotRing = Math.abs(Math.sin(knotD * 26)) * knot;

  const silver = smoothstep(0.45, 0.95, id2);
  const warm = 0.44 + id * 0.14;

  let r = warm * (0.92 + grain * 0.22);
  let g = warm * (0.68 + grain * 0.20);
  let b = warm * (0.42 + grain * 0.16);
  const f = (fibre - 0.5) * 0.06;
  r += f; g += f * 0.9; b += f * 0.7;

  r = mix(r, 0.40 + grain * 0.08, silver * 0.6);
  g = mix(g, 0.38 + grain * 0.08, silver * 0.6);
  b = mix(b, 0.35 + grain * 0.07, silver * 0.6);

  r = mix(r, 0.16 + knotRing * 0.18, knot * 0.9);
  g = mix(g, 0.10 + knotRing * 0.12, knot * 0.9);
  b = mix(b, 0.06 + knotRing * 0.08, knot * 0.9);

  const gk = mix(1, 0.22, gap);
  o.r = r * gk; o.g = g * gk; o.b = b * gk;
  o.h = 0.55 - gap * 0.5 - grain * 0.10 + (fibre - 0.5) * 0.05 - knot * 0.06;
  o.rough = clamp01(0.68 + (1 - grain) * 0.12 + silver * 0.12);
  o.metal = 0;
  o.ao = clamp01(1 - gap * 0.7 - knot * 0.2);
}

/** Hewn structural oak: adze facets, deep grain, splits, soot and iron staining. */
function shadeWoodBeam(u, v, o) {
  const facetN = 7;
  const raw = Math.floor(v * facetN + fbm2D(u, v, 4, 4, 2, 801) * 1.2);
  const facet = ((raw % facetN) + facetN) % facetN;
  const fid = hash2D(0, facet, 807);
  const facetShade = 0.86 + fid * 0.28;

  const warpN = fbm2D(u, v, 2, 18, 3, 811) * 1.1;
  const rings = Math.abs(Math.sin((v * 9 + warpN * 2 + fid * 7) * Math.PI));
  const grain = Math.pow(rings, 0.5);
  const split = Math.pow(ridgedFbm2D(u, v, 3, 40, 3, 817), 8);
  const grime = fbm01(u, v, 9, 9, 3, 823);
  const fibre = fbm01(u, v, 5, 200, 2, 829, 0.55);

  const tone = (0.24 + fid * 0.07 + grain * 0.09 + (fibre - 0.5) * 0.05) * facetShade;
  let r = tone * 1.28;
  let g = tone * 0.92;
  let b = tone * 0.60;

  r = mix(r, 0.07, split * 0.9);
  g = mix(g, 0.05, split * 0.9);
  b = mix(b, 0.03, split * 0.9);

  r = mix(r, 0.13, grime * 0.3);
  g = mix(g, 0.12, grime * 0.3);
  b = mix(b, 0.11, grime * 0.3);

  o.r = r; o.g = g; o.b = b;
  o.h = 0.5 + (facetShade - 1) * 0.6 - grain * 0.12 + (fibre - 0.5) * 0.06 - split * 0.45;
  o.rough = clamp01(0.78 + (1 - grain) * 0.1 + grime * 0.08);
  o.metal = 0;
  o.ao = clamp01(1 - split * 0.6 - grime * 0.15);
}

/** Layered straw thatch: strands run down-slope, each course overhanging the next. */
function shadeThatch(u, v, o) {
  const courses = 7;
  const fv = v * courses;
  const ci = Math.floor(fv);
  const cv = fv - ci;
  const strand = fbm01(u, v, 260, 10, 2, 901 + ci, 0.6);
  const strandFine = fbm01(u, v, 520, 26, 2, 911 + ci, 0.5);
  const clump = fbm01(u, v, 22, 6, 3, 921);
  const lip = 1 - smoothstep(0.0, 0.20, cv);
  const lipEdge = 1 - smoothstep(0.0, 0.05, cv);
  const cid = hash2D(ci, 3, 931);

  const straw = 0.28 + strand * 0.34 + clump * 0.12 + cid * 0.05;
  let r = straw * 1.18;
  let g = straw * 0.92;
  let b = straw * 0.46;

  r = mix(r, 0.34, lip * 0.35);
  g = mix(g, 0.32, lip * 0.35);
  b = mix(b, 0.27, lip * 0.30);

  const shade = mix(1, 0.32, lipEdge);
  o.r = r * shade; o.g = g * shade; o.b = b * shade;
  o.h = 0.32 + strand * 0.36 + strandFine * 0.14 + (1 - cv) * 0.12 - lipEdge * 0.3;
  o.rough = clamp01(0.92 - strand * 0.06);
  o.metal = 0;
  o.ao = clamp01(0.5 + cv * 0.5 - (1 - strand) * 0.15);
}

/** Fired clay pantiles in overlapping courses, with moss in the shaded laps. */
function shadeRoofTile(u, v, o) {
  const cols = 8;
  const rows = 10;
  const fv = v * rows;
  const rw = Math.floor(fv);
  const cv = fv - rw;
  const fu = u * cols + (rw & 1) * 0.5;
  const cl = Math.floor(fu) % cols;
  const cu = fu - Math.floor(fu);

  const id = hash2D(cl, rw, 2401);
  const lap = 1 - smoothstep(0.0, 0.16, cv);
  const curve = Math.sin(cu * Math.PI);
  const edge = 1 - smoothstep(0.0, 0.03, Math.min(cu, 1 - cu));
  const grit = fbm01(u, v, 90, 90, 2, 2407);
  const moss = clamp01(smoothstep(0.55, 0.9, fbm01(u, v, 11, 11, 3, 2411)) * (0.4 + lap * 0.9));

  const clay = 0.26 + id * 0.15 + grit * 0.06 + curve * 0.07;
  let r = clay * 1.55;
  let g = clay * 0.86;
  let b = clay * 0.64;

  r = mix(r, 0.20, moss * 0.7);
  g = mix(g, 0.26, moss * 0.75);
  b = mix(b, 0.14, moss * 0.65);

  const lk = mix(1, 0.42, lap * 0.9);
  o.r = r * lk; o.g = g * lk; o.b = b * lk;
  o.h = 0.35 + curve * 0.35 + (1 - cv) * 0.10 - edge * 0.25 + (grit - 0.5) * 0.04;
  o.rough = clamp01(0.72 + moss * 0.18 + (grit - 0.5) * 0.08);
  o.metal = 0;
  o.ao = clamp01(1 - lap * 0.55 - edge * 0.2);
}

/** Lime-plastered daub infill: trowel sweep, hairline crazing, soot and rain staining. */
function shadePlaster(u, v, o) {
  domainWarp2D(u, v, 4, 0.06, 2301);
  const trowel = fbm01(WARP[0], WARP[1], 7, 7, 4, 2309);
  const fine = fbm01(u, v, 100, 100, 2, 2311);
  const crack = Math.pow(ridgedFbm2D(u, v, 5, 5, 4, 2317), 9);
  const stain = smoothstep(0.5, 0.9, fbm01(u, v, 24, 3, 3, 2321));
  const soot = smoothstep(0.6, 0.95, fbm01(u, v, 3, 3, 3, 2327));

  const base = 0.68 + trowel * 0.13 + (fine - 0.5) * 0.05;
  let r = base;
  let g = base * 0.965;
  let b = base * 0.885;

  r = mix(r, r * 0.55, crack);
  g = mix(g, g * 0.55, crack);
  b = mix(b, b * 0.55, crack);

  r = mix(r, r * 0.72, stain * 0.5);
  g = mix(g, g * 0.72, stain * 0.5);
  b = mix(b, b * 0.70, stain * 0.5);

  r = mix(r, 0.28, soot * 0.35);
  g = mix(g, 0.27, soot * 0.35);
  b = mix(b, 0.26, soot * 0.35);

  o.r = r; o.g = g; o.b = b;
  o.h = 0.5 + (trowel - 0.5) * 0.18 + (fine - 0.5) * 0.11 - crack * 0.45;
  o.rough = clamp01(0.88 + (fine - 0.5) * 0.08);
  o.metal = 0;
  o.ao = clamp01(1 - crack * 0.5);
}

/** Bare earth: broad drifts, pebbles, dried cracks, dusty high ground. */
function shadeDirt(u, v, o) {
  const broad = fbm01(u, v, 2, 2, 4, 1001);
  const mid = fbm01(u, v, 9, 9, 4, 1009);
  const fine = fbm01(u, v, 48, 48, 3, 1013);
  const micro = fbm01(u, v, 160, 160, 2, 1019);
  worley2D(u, v, 34, 34, 1021, 1);
  const pebble = 1 - smoothstep(0.03, 0.13, WORLEY[0]);
  const pebId = WORLEY[2];
  const crack = Math.pow(ridgedFbm2D(u, v, 7, 7, 4, 1031), 8);
  const dry = smoothstep(0.45, 0.85, broad * 0.7 + mid * 0.3);

  const base = 0.19 + mid * 0.13 + fine * 0.07 + (micro - 0.5) * 0.05;
  let r = base * 1.48;
  let g = base * 1.12;
  let b = base * 0.78;

  r = mix(r, r * 1.32 + 0.06, dry);
  g = mix(g, g * 1.28 + 0.05, dry);
  b = mix(b, b * 1.22 + 0.05, dry);

  r = mix(r, 0.32 + pebId * 0.20, pebble * 0.8);
  g = mix(g, 0.29 + pebId * 0.18, pebble * 0.8);
  b = mix(b, 0.26 + pebId * 0.16, pebble * 0.8);

  const ck = mix(1, 0.45, crack);
  o.r = r * ck; o.g = g * ck; o.b = b * ck;
  o.h = 0.45 + mid * 0.25 + fine * 0.14 + pebble * 0.24 - crack * 0.3 + (micro - 0.5) * 0.11;
  o.rough = clamp01(0.94 - dry * 0.04 - pebble * 0.12);
  o.metal = 0;
  o.ao = clamp01(1 - crack * 0.45 - (1 - mid) * 0.12);
}

/** Meadow grass: three scales of variation so a 400 m field never looks flat. */
function shadeGrass(u, v, o) {
  const patch = fbm01(u, v, 2, 2, 4, 1101);
  const clump = fbm01(u, v, 7, 7, 4, 1109);
  const tuft = fbm01(u, v, 26, 26, 3, 1113);
  // Strongly anisotropic so the normal map reads as blades, not as mush.
  const blade = fbm01(u, v, 90, 300, 2, 1117, 0.55);
  const bladeFine = fbm01(u, v, 190, 640, 2, 1123, 0.5);
  worley2D(u, v, 11, 11, 1129, 1);
  const clumpCell = smoothstep(0.05, 0.4, WORLEY[0]);
  // A metre-scale field needs macro contrast or 400 m of it reads as billiard
  // baize, so the dry/bare masks are deliberately wide and high-contrast.
  const dry = smoothstep(0.44, 0.80, patch * 0.65 + clump * 0.35);
  const bare = smoothstep(0.58, 0.88, 1 - (clump * 0.45 + patch * 0.55));
  const shadowPatch = smoothstep(0.35, 0.75, 1 - patch) * 0.22;

  const lush = (0.085 + clump * 0.11 + tuft * 0.07) * (1 - shadowPatch);
  let r = lush * 1.15 + blade * 0.10;
  let g = lush * 2.20 + blade * 0.16;
  let b = lush * 0.70 + blade * 0.05;

  r = mix(r, 0.44 + blade * 0.16, dry * 0.85);
  g = mix(g, 0.41 + blade * 0.15, dry * 0.85);
  b = mix(b, 0.17 + blade * 0.07, dry * 0.85);

  r = mix(r, 0.25, bare);
  g = mix(g, 0.20, bare);
  b = mix(b, 0.13, bare);

  o.r = r; o.g = g; o.b = b;
  o.h = 0.4 + blade * 0.35 + bladeFine * 0.15 + clump * 0.2 - bare * 0.2;
  o.rough = clamp01(0.88 - dry * 0.04 + bare * 0.06);
  o.metal = 0;
  o.ao = clamp01(0.78 + clumpCell * 0.22 - bare * 0.1);
}

/** Woven banner cloth: over-under weave, slub, dye fade, sun-bleached edges. */
/**
 * Palm frond.
 *
 * A frond is not a leaf, it is a rachis carrying a hundred stiff leaflets at a
 * shallow angle, and the give-away is that the grain runs *across* it in hard
 * parallel lines rather than in the soft veining of a broadleaf. So the noise
 * is extremely anisotropic - almost a comb - with a bright midrib down the
 * centre and the leaflets separating into visible slots toward the edges.
 */
function shadeFrond(u, v, o) {
  // Leaflets: near-vertical stripes, very high frequency across the frond.
  const leaflet = fbm01(u, v, 320, 7, 2, 7101, 0.45);
  const fine = fbm01(u, v, 700, 14, 2, 7109, 0.4);
  // Where leaflets separate and sky shows through as a dark slot.
  const slot = smoothstep(0.58, 0.92, fbm01(u, v, 150, 4, 2, 7117, 0.5));
  // The midrib: a hard bright line down the middle of the tile.
  const rib = 1 - smoothstep(0.0, 0.05, Math.abs(u - 0.5));
  // Age: fronds dry from the tip, so the far end of the tile browns off.
  const dry = smoothstep(0.55, 1.0, v) * fbm01(u, v, 3, 6, 2, 7123);

  const grain = leaflet * 0.62 + fine * 0.38;
  let r = 0.20 + grain * 0.17;
  let g = 0.30 + grain * 0.24;
  let b = 0.12 + grain * 0.10;
  // Dried leaflets go straw, which is most of what stops a palm reading as
  // plastic - a real crown always carries some dead material.
  r = mix(r, 0.46, dry * 0.75); g = mix(g, 0.38, dry * 0.75); b = mix(b, 0.20, dry * 0.75);
  // Midrib is paler and waxier than the blade.
  r = mix(r, 0.42, rib * 0.6); g = mix(g, 0.48, rib * 0.6); b = mix(b, 0.24, rib * 0.6);
  const shade = 1 - slot * 0.55;

  o.r = clamp01(r * shade); o.g = clamp01(g * shade); o.b = clamp01(b * shade);
  o.h = clamp01(grain * 0.5 + rib * 0.5 - slot * 0.4);
  // A leaf cuticle is waxy; the dried parts are not.
  o.rough = clamp01(0.62 - rib * 0.18 + dry * 0.28);
  o.metal = 0;
  o.ao = clamp01(0.84 + grain * 0.16 - slot * 0.3);
}

/**
 * Palm bark: the stub-covered column left behind as old fronds are shed.
 *
 * A date palm's trunk is not smooth - it is a lattice of diamond-shaped leaf
 * bases in staggered rows, and that pattern is the single most recognisable
 * thing about it after the crown. Worley cells on a stretched grid give the
 * diamonds; the vertical fibre on top of them is what stops it reading as
 * reptile skin.
 */
function shadeBarkPalm(u, v, o) {
  // Diamond lattice of shed frond bases, wider than tall.
  worley2D(u, v, 9, 14, 7201, 1);
  const cell = WORLEY[0];
  const seam = smoothstep(0.0, 0.16, cell);
  // Long vertical fibres over the whole thing.
  const fibre = fbm01(u, v, 12, 130, 3, 7211, 0.5);
  const coarse = fbm01(u, v, 3, 5, 3, 7219);

  const base = 0.26 + coarse * 0.16 + fibre * 0.13;
  let r = base * 1.16;
  let g = base * 0.96;
  let b = base * 0.68;
  // Seams between the bases are deep shadow, and they are what carry the form.
  const dark = 1 - (1 - seam) * 0.62;
  r *= dark; g *= dark; b *= dark;

  o.r = clamp01(r); o.g = clamp01(g); o.b = clamp01(b);
  o.h = clamp01(seam * 0.72 + fibre * 0.28);
  o.rough = clamp01(0.90 - fibre * 0.12);
  o.metal = 0;
  o.ao = clamp01(0.66 + seam * 0.34);
}

/**
 * Short animal coat, for the horse.
 *
 * The whole job is anisotropy. Fur is millions of near-parallel hairs, so its
 * normal map has to be stretched hard along the lie of the coat - an isotropic
 * noise gives velvet, or more often mud. Three octaves at increasingly extreme
 * aspect ratios build hair, then guard hair, then the fine grain that only
 * shows in a highlight.
 *
 * The colour work underneath is dappling: real coats are never one value, they
 * carry broad low-frequency variation from the muscle and fat beneath. Without
 * it a horse is a brown balloon whatever the mesh does.
 */
function shadeFur(u, v, o) {
  // Hair, at three scales. The v-frequency dwarfs the u-frequency, which is
  // what makes the grain lie along the body rather than swirl.
  const hair = fbm01(u, v, 14, 220, 3, 5501, 0.55);
  const guard = fbm01(u, v, 7, 90, 2, 5507, 0.6);
  const fine = fbm01(u, v, 30, 460, 2, 5511, 0.5);
  // Dapple and muscle shading, both very low frequency.
  const dapple = fbm01(u, v, 3.5, 3.5, 3, 5519);
  const muscle = fbm01(u, v, 1.6, 1.3, 2, 5527);
  // Whorls, where the coat changes direction. Sparse, and they catch the light.
  worley2D(u, v, 4, 4, 5531, 1);
  const whorl = smoothstep(0.02, 0.30, WORLEY[0]);

  const lift = 0.82 + muscle * 0.30 + dapple * 0.16;
  const grain = hair * 0.5 + guard * 0.32 + fine * 0.18;

  // Warm mid-brown base; the tint on the material carries the actual coat
  // colour, so this stays close to neutral and does the *texture* only.
  let r = (0.52 + grain * 0.34) * lift;
  let g = (0.46 + grain * 0.32) * lift;
  let b = (0.40 + grain * 0.28) * lift;
  // Dust settles on a working animal, mostly low on the body.
  const dust = smoothstep(0.55, 1.0, v) * dapple * 0.22;
  r = mix(r, 0.66, dust); g = mix(g, 0.60, dust); b = mix(b, 0.50, dust);

  o.r = clamp01(r); o.g = clamp01(g); o.b = clamp01(b);
  // Height follows the hair, so the normal map reads as lie-of-coat.
  o.h = grain * 0.7 + whorl * 0.3;
  // Coats are matte, but the guard hairs are glossier - that variation is what
  // makes a flank catch a rim light instead of reading as felt.
  o.rough = clamp01(0.90 - guard * 0.22 - whorl * 0.06);
  o.metal = 0;
  o.ao = clamp01(0.80 + grain * 0.20);
}

/**
 * Feather, for the eagle.
 *
 * A feather is a rachis with barbs running off it at a shallow angle, and the
 * barbs zip together into a continuous vane. So: one hard central shaft, and a
 * strongly anisotropic grain angled away from it. The vane also splits here and
 * there, and those splits are most of what stops a wing reading as a painted
 * board.
 */
function shadeFeather(u, v, o) {
  // Barbs: very high frequency across the vane, low along it.
  const barb = fbm01(u, v, 200, 12, 2, 6101, 0.5);
  const barbFine = fbm01(u, v, 420, 26, 2, 6113, 0.45);
  // Vane splits, sparse and elongated.
  const split = smoothstep(0.62, 0.98, fbm01(u, v, 34, 5, 2, 6121, 0.6));
  // Banding across the feather, as on a real raptor.
  const band = smoothstep(0.35, 0.65, fbm01(u, v, 2, 9, 2, 6131));
  // The rachis itself: a hard ridge down the middle of the tile.
  const shaft = 1 - smoothstep(0.0, 0.045, Math.abs(u - 0.5));

  const grain = barb * 0.62 + barbFine * 0.38;
  let l = 0.40 + grain * 0.30;
  l = mix(l, l * 0.68, band * 0.55);        // darker bars
  l = mix(l, l * 0.45, split * 0.5);        // splits fall into shadow
  l = mix(l, 0.74, shaft * 0.75);           // pale shaft

  o.r = clamp01(l * 1.04);
  o.g = clamp01(l * 0.97);
  o.b = clamp01(l * 0.86);
  o.h = clamp01(grain * 0.45 + shaft * 0.55 - split * 0.35);
  // The shaft is smooth keratin and the vane is not, which is the single
  // biggest tell that this is a feather rather than fabric.
  o.rough = clamp01(0.86 - shaft * 0.42 + split * 0.08);
  o.metal = 0;
  o.ao = clamp01(0.82 + grain * 0.18 - split * 0.22);
}

function shadeFabric(u, v, o) {
  const n = 56;
  const fu = u * n;
  const fv = v * n;
  const iu = Math.floor(fu);
  const iv = Math.floor(fv);
  const over = ((iu + iv) & 1) === 0;
  const cu = fu - iu - 0.5;
  const cv = fv - iv - 0.5;
  const s = over ? cv : cu;
  const thread = Math.sqrt(Math.max(0, 0.25 - s * s)) * 2;

  const slub = fbm01(u, v, 30, 30, 3, 1201);
  const dyeFade = fbm01(u, v, 4, 4, 3, 1207);
  const wearN = smoothstep(0.62, 0.95, fbm01(u, v, 14, 14, 3, 1213));

  const dye = 0.34 + dyeFade * 0.16;
  const sh = 0.55 + thread * 0.55;
  let r = dye * 1.35 * sh;
  let g = dye * 0.30 * sh;
  let b = dye * 0.28 * sh;

  r = mix(r, 0.46, wearN * 0.4);
  g = mix(g, 0.30, wearN * 0.4);
  b = mix(b, 0.27, wearN * 0.4);

  o.r = r; o.g = g; o.b = b;
  o.h = 0.4 + thread * 0.45 + (slub - 0.5) * 0.10;
  o.rough = clamp01(0.80 + (1 - thread) * 0.12);
  o.metal = 0;
  o.ao = clamp01(0.72 + thread * 0.28);
}

/** Acrylic-sealed asphalt sports surface: fine aggregate under a satin seal coat. */
function shadeAsphalt(u, v, o) {
  worley2D(u, v, 70, 70, 1301, 1);
  const agg = smoothstep(0.02, 0.22, WORLEY[0]);
  const aggId = WORLEY[2];
  const fine = fbm01(u, v, 130, 130, 2, 1307);
  const broad = fbm01(u, v, 3, 3, 4, 1311);
  const seal = smoothstep(0.4, 0.85, fbm01(u, v, 5, 5, 3, 1319));

  const base = 0.075 + broad * 0.045 + (fine - 0.5) * 0.03;
  let r = base;
  let g = base * 1.03;
  let b = base * 1.14;

  const stone = (1 - agg) * (0.3 + aggId * 0.7);
  r = mix(r, 0.16 + aggId * 0.10, stone * 0.7);
  g = mix(g, 0.16 + aggId * 0.10, stone * 0.7);
  b = mix(b, 0.17 + aggId * 0.09, stone * 0.7);

  o.r = r; o.g = g; o.b = b;
  o.h = 0.5 + (1 - agg) * 0.28 + (fine - 0.5) * 0.13 + (broad - 0.5) * 0.05;
  o.rough = clamp01(0.82 - seal * 0.22 + (fine - 0.5) * 0.08);
  o.metal = 0;
  o.ao = clamp01(1 - (1 - agg) * 0.18);
}

/** Hand-troweled skatepark slab: swirl finish, wax-polished lines, wheel scuffs. */
function shadeSkateConcrete(u, v, o) {
  domainWarp2D(u, v, 3, 0.10, 1401);
  const wu = WARP[0];
  const wv = WARP[1];
  const swirl = fbm01(wu, wv, 6, 6, 3, 1409);
  const fine = fbm01(u, v, 90, 90, 2, 1411);
  const broad = fbm01(u, v, 2, 2, 4, 1417);
  worley2D(u, v, 60, 60, 1423, 1);
  const pinhole = 1 - smoothstep(0.0, 0.06, WORLEY[0]);
  const scuff = Math.pow(ridgedFbm2D(wu, wv, 4, 26, 3, 1429), 4);
  const wax = smoothstep(0.55, 0.9, fbm01(u, v, 3, 9, 3, 1433));

  const grey = 0.50 + broad * 0.10 + (swirl - 0.5) * 0.07 + (fine - 0.5) * 0.04;
  let r = grey;
  let g = grey * 1.005;
  let b = grey * 1.025;

  const sk = mix(1, 0.55, scuff * 0.8);
  r *= sk; g *= sk; b *= sk;
  const wk = mix(1, 0.86, wax * 0.5);
  r *= wk; g *= wk; b *= wk;

  o.r = r; o.g = g; o.b = b;
  o.h = 0.5 + (swirl - 0.5) * 0.08 + (fine - 0.5) * 0.08 - pinhole * 0.3;
  o.rough = clamp01(0.55 - wax * 0.30 - scuff * 0.18 + (fine - 0.5) * 0.08);
  o.metal = 0;
  o.ao = clamp01(1 - pinhole * 0.4);
}

/** Groomed piste: corduroy ridges, wind drift, isolated ice facets that glint. */
function shadeSnow(u, v, o) {
  const wobble = fbm2D(u, v, 4, 4, 2, 1501) * 0.12;
  const cord = Math.sin((v * 34 + wobble) * Math.PI * 2) * 0.5 + 0.5;
  const drift = fbm01(u, v, 3, 3, 4, 1507);
  const grain = fbm01(u, v, 140, 140, 2, 1511);
  const packed = fbm01(u, v, 12, 12, 3, 1517);
  // Sparse near-mirror texels; mipmapping averages them out with distance,
  // which is exactly how real snow glitter behaves.
  const sparkle = hash2D(Math.floor(u * 512), Math.floor(v * 512), 1523) > 0.9965;

  const white = 0.86 + drift * 0.07 + cord * 0.04 + (grain - 0.5) * 0.03;
  o.r = white * 0.985;
  o.g = white * 0.995;
  o.b = Math.min(1, white * 1.02);
  o.h = 0.5 + cord * 0.18 + (drift - 0.5) * 0.12 + (grain - 0.5) * 0.10 + (packed - 0.5) * 0.08;
  o.rough = sparkle ? 0.06 : clamp01(0.62 - packed * 0.12 + (grain - 0.5) * 0.1);
  o.metal = 0;
  o.ao = clamp01(0.88 + cord * 0.12);
}

/** Bound-rubber running track: crumb granules, matte, faintly banded by the laying machine. */
function shadeRubberTrack(u, v, o) {
  worley2D(u, v, 80, 80, 2601, 1);
  const gran = smoothstep(0.0, 0.30, WORLEY[0]);
  const gid = WORLEY[2];
  const fine = fbm01(u, v, 150, 150, 2, 2607);
  const broad = fbm01(u, v, 4, 4, 3, 2611);

  const base = (0.34 + broad * 0.06 + gid * 0.05) * (1 - (1 - gran) * 0.4);
  o.r = base * 1.55;
  o.g = base * 0.60;
  o.b = base * 0.46;
  o.h = 0.4 + (1 - gran) * 0.42 + (fine - 0.5) * 0.15;
  o.rough = clamp01(0.86 + (fine - 0.5) * 0.06);
  o.metal = 0;
  o.ao = clamp01(0.85 + gran * 0.15);
}

/** Modular plastic sport tiles: interlocking grid, drainage perforations, semi-gloss. */
function shadePlasticCourt(u, v, o) {
  const n = 10;
  const fu = u * n;
  const fv = v * n;
  const cu = fu - Math.floor(fu);
  const cv = fv - Math.floor(fv);
  const joint = 1 - smoothstep(0.02, 0.05, Math.min(Math.min(cu, 1 - cu), Math.min(cv, 1 - cv)));

  const p = 5;
  const pu = ((cu * p) % 1) - 0.5;
  const pv = ((cv * p) % 1) - 0.5;
  const hole = 1 - smoothstep(0.16, 0.24, Math.sqrt(pu * pu + pv * pv));

  const id = hash2D(Math.floor(fu), Math.floor(fv), 2501);
  const grain = fbm01(u, v, 140, 140, 2, 2507);
  const scuff = smoothstep(0.6, 0.95, fbm01(u, v, 9, 9, 3, 2511));
  const shade = 1 - joint * 0.25 - hole * 0.4;

  o.r = (0.10 + id * 0.02) * shade + grain * 0.02;
  o.g = (0.34 + id * 0.03) * shade + grain * 0.02;
  o.b = (0.58 + id * 0.03) * shade + grain * 0.02;
  o.h = 0.55 - joint * 0.35 - hole * 0.4 + (grain - 0.5) * 0.05;
  o.rough = clamp01(0.42 + scuff * 0.22 + joint * 0.15 + (grain - 0.5) * 0.08);
  o.metal = 0;
  o.ao = clamp01(1 - joint * 0.4 - hole * 0.35);
}

/** Court / road line paint: thick white acrylic sitting proud of the aggregate. */
function shadePaintWhite(u, v, o) {
  const fine = fbm01(u, v, 120, 120, 2, 2701);
  const broad = fbm01(u, v, 5, 5, 3, 2707);
  const wearN = smoothstep(0.62, 0.95, fbm01(u, v, 16, 16, 3, 2711));
  const grit = fbm01(u, v, 60, 60, 2, 2713);

  const base = 0.80 + broad * 0.08 + (fine - 0.5) * 0.05;
  let r = base;
  let g = base * 0.995;
  let b = base * 0.975;
  r = mix(r, 0.30, wearN * 0.45);
  g = mix(g, 0.29, wearN * 0.45);
  b = mix(b, 0.28, wearN * 0.45);

  o.r = r; o.g = g; o.b = b;
  o.h = 0.5 + (grit - 0.5) * 0.14 - wearN * 0.12;
  o.rough = clamp01(0.62 + wearN * 0.2 + (fine - 0.5) * 0.1);
  o.metal = 0;
  o.ao = 1;
}

/** Diagonal hazard marking chevrons, chipped back to the alloy underneath. */
function shadeHazard(u, v, o) {
  // (u + v) shifts by an integer when either axis wraps, so the stripes tile.
  const s = (u + v) * 6;
  const f = s - Math.floor(s);
  const band = smoothstep(0.46, 0.54, Math.abs(f - 0.5) * 2);
  const wearN = smoothstep(0.45, 0.9, fbm01(u, v, 8, 8, 4, 1901));
  const scratch = Math.pow(ridgedFbm2D(u, v, 5, 60, 3, 1907), 7);
  const grit = fbm01(u, v, 90, 90, 2, 1911);
  const chipped = clamp01(wearN * 0.65 + scratch);

  let r = mix(0.05, 0.88, band);
  let g = mix(0.05, 0.62, band);
  let b = mix(0.05, 0.05, band);
  const metalBase = 0.42 + grit * 0.08;
  r = mix(r, metalBase * 1.02, chipped);
  g = mix(g, metalBase * 1.03, chipped);
  b = mix(b, metalBase * 1.08, chipped);

  o.r = r; o.g = g; o.b = b;
  o.h = 0.5 + (grit - 0.5) * 0.06 - chipped * 0.05 + band * 0.02;
  o.rough = clamp01(0.6 - band * 0.06 + chipped * 0.12);
  o.metal = chipped * 0.9;
  o.ao = 1;
}

/** Frosted LED strip diffuser behind a dark bezel - the backbone of the neon look. */
function shadeEmissiveStrip(u, v, o) {
  const rows = 6;
  const fv = v * rows;
  const cv = fv - Math.floor(fv);
  const bezel = 1 - smoothstep(0.06, 0.15, Math.min(cv, 1 - cv));

  const fu = u * 40;
  const cu = fu - Math.floor(fu) - 0.5;
  const led = 1 - smoothstep(0.16, 0.34, Math.abs(cu));
  const grain = fbm01(u, v, 60, 60, 2, 1801);

  const e = (1 - bezel) * (0.58 + led * 0.42) * (0.92 + grain * 0.16);
  o.er = e; o.eg = e; o.eb = e;

  const dark = 0.03 + bezel * 0.07;
  o.r = dark; o.g = dark; o.b = dark;
  o.h = 0.5 - bezel * 0.35 + led * 0.06;
  o.rough = clamp01(0.28 + bezel * 0.4);
  o.metal = bezel * 0.8;
  o.ao = clamp01(1 - bezel * 0.4);
}

/** Holographic signage plate: scanlines, drifting data blocks, additive glow. */
function shadeHolo(u, v, o) {
  const scan = 0.55 + 0.45 * Math.sin(v * Math.PI * 2 * 90);
  const flow = fbm01(u, v, 6, 3, 3, 2201);
  const blocks = hash2D(Math.floor(u * 24), Math.floor(v * 40), 2207);
  const glyph = blocks > 0.72 ? 1 : 0;
  const e = (0.22 + glyph * 0.55 + flow * 0.25) * scan;

  o.er = e * 0.30; o.eg = e * 0.95; o.eb = e;
  o.r = 0.02; o.g = 0.05; o.b = 0.06;
  o.a = clamp01(0.10 + e * 0.8);
  o.h = 0.5;
  o.rough = 0.2;
  o.metal = 0;
  o.ao = 1;
}

/** Optically flat glass; only cleaning smears, dust and dried droplets survive. */
function shadeGlass(u, v, o) {
  const smear = fbm01(u, v, 6, 3, 3, 1701);
  const dust = fbm01(u, v, 120, 120, 2, 1707);
  worley2D(u, v, 9, 9, 1711, 1);
  const droplet = 1 - smoothstep(0.02, 0.09, WORLEY[0]);

  // Near-white, but not *flat* white: dirt films tint what passes through.
  const clean = 1 - dust * 0.05 - droplet * 0.09 - (1 - smear) * 0.03;
  o.r = clean; o.g = clean * 0.998; o.b = clean * 0.994;
  o.h = 0.5 + (smear - 0.5) * 0.05 + droplet * 0.15 + (dust - 0.5) * 0.02;
  o.rough = clamp01(0.03 + smear * 0.08 + droplet * 0.15 + dust * 0.03);
  o.metal = 0;
  o.ao = 1;
}

/** Pool surface ripple: two decorrelated wave scales, scrolled apart at runtime. */
function shadeWater(u, v, o) {
  domainWarp2D(u, v, 4, 0.05, 1601);
  const r1 = fbm01(WARP[0], WARP[1], 8, 8, 4, 1607, 0.55);
  const r2 = fbm01(u, v, 18, 18, 3, 1613, 0.5);
  const ripple = r1 * 0.65 + r2 * 0.35;

  // Albedo stays near white so the material's `color` owns the tint; the map
  // only carries the slight scatter difference between crest and trough.
  const shade = 0.94 + ripple * 0.06;
  o.r = shade * 0.97; o.g = shade * 0.995; o.b = shade;
  o.h = ripple;
  o.rough = clamp01(0.04 + (ripple - 0.5) * 0.06);
  o.metal = 0;
  o.ao = 1;
}

/** Galvanised chain-link: two crossing wire families, everything else cut away. */
function shadeChainLink(u, v, o) {
  const n = 8;
  const a = (u + v) * n;
  const b2 = (u - v) * n;
  const fa = a - Math.floor(a);
  const fb = b2 - Math.floor(b2);
  const d = Math.min(Math.min(fa, 1 - fa), Math.min(fb, 1 - fb)) / n;
  const w = 0.011;
  o.a = 1 - smoothstep(w * 0.72, w, d);

  const round = Math.sqrt(Math.max(0, 1 - Math.min(1, d / w) ** 2));
  const grit = fbm01(u, v, 140, 140, 2, 2801);
  const base = 0.44 + round * 0.20 + (grit - 0.5) * 0.06;
  o.r = base * 0.99; o.g = base; o.b = base * 1.05;
  o.h = 0.35 + round * 0.5;
  o.rough = clamp01(0.42 - round * 0.12 + (grit - 0.5) * 0.1);
  o.metal = 0.9;
  o.ao = clamp01(0.6 + round * 0.4);
}

/** Braided sport net cord on a square grid, alpha-cut between the strands. */
function shadeNet(u, v, o) {
  const n = 18;
  const fu = u * n - Math.floor(u * n);
  const fv = v * n - Math.floor(v * n);
  const d = Math.min(Math.min(fu, 1 - fu), Math.min(fv, 1 - fv)) / n;
  const w = 0.007;
  o.a = 1 - smoothstep(w * 0.7, w, d);

  const round = Math.sqrt(Math.max(0, 1 - Math.min(1, d / w) ** 2));
  // Braid: a fine twist running along the cord so it is not a smooth tube.
  const twist = 0.5 + 0.5 * Math.sin((u + v) * n * 26);
  const fibre = fbm01(u, v, 220, 220, 2, 2901);
  const base = 0.70 + round * 0.16 + twist * 0.06 + (fibre - 0.5) * 0.08;

  o.r = base; o.g = base * 0.99; o.b = base * 0.94;
  o.h = 0.3 + round * 0.5 + twist * 0.12;
  o.rough = clamp01(0.80 + (fibre - 0.5) * 0.12);
  o.metal = 0;
  o.ao = clamp01(0.55 + round * 0.45);
}

/* ------------------------------------------------------------------ */
/* Recipes                                                             */
/*                                                                     */
/* key -> builder. Kept as a table so get() can build a single material */
/* lazily if a world asks for one before/without warmup().              */
/* ------------------------------------------------------------------ */

const RECIPES = {
  /* --- station / industrial ------------------------------------- */
  'metal.hull': (lib) => lib._standard(HERO, shadeMetalHull, {
    normalStrength: 2.2, tileMeters: 4, envMapIntensity: 1.15,
  }),
  'metal.panel': (lib) => lib._standard(HERO, shadeMetalPanel, {
    normalStrength: 2.0, tileMeters: 3, envMapIntensity: 1.0,
  }),
  'metal.grate': (lib) => lib._standard(SMALL, shadeMetalGrate, {
    normalStrength: 1.8, tileMeters: 1.2, alpha: true, alphaTest: 0.42,
    side: THREE.DoubleSide, envMapIntensity: 1.1,
  }),
  'metal.trim': (lib) => lib._physical(SMALL, shadeMetalTrim, {
    normalStrength: 1.1, tileMeters: 1.5, envMapIntensity: 1.4,
    clearcoat: 0.6, clearcoatRoughness: 0.12,
  }),
  'metal.rail': (lib) => lib._physical(SMALL, shadeMetalRail, {
    normalStrength: 1.3, tileMeters: 2, envMapIntensity: 1.3,
    clearcoat: 0.35, clearcoatRoughness: 0.25,
  }),
  'metal.iron': (lib) => lib._standard(SMALL, shadeIron, {
    normalStrength: 2.4, tileMeters: 1.2, envMapIntensity: 0.9,
  }),
  'hazard.stripe': (lib) => lib._standard(SMALL, shadeHazard, {
    normalStrength: 1.7, tileMeters: 2, envMapIntensity: 0.9,
  }),

  /* --- concrete -------------------------------------------------- */
  'concrete.road': (lib) => lib._standard(HERO, shadeConcreteRoad, {
    normalStrength: 3.0, tileMeters: 6, envMapIntensity: 0.8,
  }),
  'concrete.wall': (lib) => lib._standard(HERO, shadeConcreteWall, {
    normalStrength: 2.6, tileMeters: 4, envMapIntensity: 0.75,
  }),
  'concrete.skatepark': (lib) => lib._standard(HERO, shadeSkateConcrete, {
    normalStrength: 2.0, tileMeters: 5, envMapIntensity: 0.9,
  }),

  /* --- glass ----------------------------------------------------- */
  'glass.tinted': (lib) => {
    const s = lib._bake(SMALL, shadeGlass, { normalStrength: 0.35, name: 'glass.tinted' });
    const m = new THREE.MeshPhysicalMaterial({
      color: 0x8fb6c4,
      map: s.map,
      normalMap: s.normalMap,
      roughnessMap: s.ormMap,
      roughness: 1,
      metalness: 0,
      transmission: 0.92,
      thickness: 0.35,
      ior: 1.5,
      attenuationColor: new THREE.Color(0x2f5a66),
      attenuationDistance: 1.6,
      clearcoat: 1,
      clearcoatRoughness: 0.03,
      envMapIntensity: 1.6,
      normalScale: new THREE.Vector2(0.25, 0.25),
      side: THREE.DoubleSide,
    });
    m.userData.tileMeters = 3;
    return { material: m, surface: s };
  },
  'glass.window': (lib) => {
    // Cheap glass: no transmission pass, just a very reflective transparent
    // surface. Stations have hundreds of windows; transmission would not survive.
    const s = lib._bake(SMALL, shadeGlass, { normalStrength: 0.35, name: 'glass.window' });
    const m = new THREE.MeshPhysicalMaterial({
      color: 0xaecad6,
      map: s.map,
      normalMap: s.normalMap,
      roughnessMap: s.ormMap,
      roughness: 1,
      metalness: 0,
      transparent: true,
      opacity: 0.28,
      clearcoat: 1,
      clearcoatRoughness: 0.04,
      ior: 1.5,
      specularIntensity: 1,
      envMapIntensity: 2.2,
      normalScale: new THREE.Vector2(0.2, 0.2),
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    m.userData.tileMeters = 3;
    return { material: m, surface: s };
  },

  /* --- emissive -------------------------------------------------- */
  'emissive.cyan': (lib) => lib._emissive(0x0affff, 4.2, 'emissive.cyan'),
  'emissive.magenta': (lib) => lib._emissive(0xff2fd0, 3.8, 'emissive.magenta'),
  'emissive.amber': (lib) => lib._emissive(0xffa022, 4.0, 'emissive.amber'),
  'emissive.white': (lib) => lib._emissive(0xdcf0ff, 4.6, 'emissive.white'),
  'emissive.green': (lib) => lib._emissive(0x4dff88, 3.6, 'emissive.green'),
  'emissive.red': (lib) => lib._emissive(0xff2b2b, 3.4, 'emissive.red'),

  'holo.panel': (lib) => {
    const s = lib._bake(SMALL, shadeHolo, {
      normalStrength: 0.2, emissive: true, name: 'holo.panel',
    });
    // Additive blending means the black albedo contributes nothing and only the
    // emissive survives - exactly how a projected hologram should composite.
    const m = new THREE.MeshStandardMaterial({
      color: 0x000000,
      emissive: 0xffffff,
      emissiveMap: s.emissiveMap,
      emissiveIntensity: 3.2,
      roughness: 0.4,
      metalness: 0,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    m.userData.tileMeters = 2;
    // A slow vertical crawl sells it as a live display rather than a decal.
    lib._animate((dt, t) => {
      s.emissiveMap.offset.y = (t * 0.06) % 1;
      m.emissiveIntensity = 3.2 + Math.sin(t * 2.3) * 0.25;
    });
    return { material: m, surface: s };
  },

  /* --- medieval -------------------------------------------------- */
  'stone.castle': (lib) => lib._standard(HERO, shadeStoneCastle, {
    normalStrength: 2.6, tileMeters: 4, envMapIntensity: 0.7,
  }),
  'stone.cobble': (lib) => lib._standard(HERO, shadeStoneCobble, {
    normalStrength: 1.7, tileMeters: 3, envMapIntensity: 0.7,
  }),
  'wood.plank': (lib) => lib._standard(HERO, shadeWoodPlank, {
    normalStrength: 2.0, tileMeters: 2.5, envMapIntensity: 0.7,
  }),
  'wood.beam': (lib) => lib._standard(SMALL, shadeWoodBeam, {
    normalStrength: 2.0, tileMeters: 2, envMapIntensity: 0.6,
  }),
  'thatch.roof': (lib) => lib._standard(HERO, shadeThatch, {
    normalStrength: 2.0, tileMeters: 3, envMapIntensity: 0.5,
  }),
  'roof.tile': (lib) => lib._standard(SMALL, shadeRoofTile, {
    normalStrength: 1.6, tileMeters: 3, envMapIntensity: 0.7,
  }),
  'plaster.wall': (lib) => lib._standard(SMALL, shadePlaster, {
    normalStrength: 2.4, tileMeters: 3, envMapIntensity: 0.6,
  }),
  'dirt.ground': (lib) => lib._standard(HERO, shadeDirt, {
    normalStrength: 2.6, tileMeters: 5, envMapIntensity: 0.6,
  }),
  'grass.field': (lib) => lib._standard(HERO, shadeGrass, {
    normalStrength: 2.4, tileMeters: 4, envMapIntensity: 0.6,
  }),
  /* Foliage. Double-sided, because a frond seen from underneath is the normal
   * case for anything the player walks beneath, and a single-sided leaf simply
   * vanishes there. */
  'foliage.frond': (lib) => lib._standard(HERO, shadeFrond, {
    normalStrength: 2.0, tileMeters: 1.2, envMapIntensity: 0.7, side: THREE.DoubleSide,
  }),
  'bark.palm': (lib) => lib._standard(SMALL, shadeBarkPalm, {
    normalStrength: 3.0, tileMeters: 1.6, envMapIntensity: 0.5,
  }),
  /* Creature surfaces. Tiled far finer than architecture - a horse is two
   * metres of animal, so a tile authored for three metres of wall would put one
   * hair across its whole flank. */
  'hide.fur': (lib) => lib._standard(HERO, shadeFur, {
    normalStrength: 2.8, tileMeters: 0.55, envMapIntensity: 0.45,
  }),
  'hide.feather': (lib) => lib._standard(HERO, shadeFeather, {
    normalStrength: 2.2, tileMeters: 0.32, envMapIntensity: 0.5,
  }),
  'fabric.banner': (lib) => {
    const s = lib._bake(SMALL, shadeFabric, { normalStrength: 1.6, name: 'fabric.banner' });
    const m = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: s.map,
      normalMap: s.normalMap,
      roughnessMap: s.ormMap,
      aoMap: s.ormMap,
      roughness: 1,
      metalness: 0,
      sheen: 1,
      sheenRoughness: 0.55,
      sheenColor: new THREE.Color(0xff9a86),
      envMapIntensity: 0.6,
      side: THREE.DoubleSide,
    });
    m.userData.tileMeters = 1.6;
    return { material: m, surface: s };
  },

  /* --- sports ---------------------------------------------------- */
  'asphalt.court': (lib) => lib._standard(HERO, shadeAsphalt, {
    normalStrength: 2.6, tileMeters: 5, envMapIntensity: 0.7,
  }),
  'plastic.court': (lib) => lib._physical(SMALL, shadePlasticCourt, {
    normalStrength: 1.6, tileMeters: 3, envMapIntensity: 1.0,
    clearcoat: 0.5, clearcoatRoughness: 0.35,
  }),
  'rubber.track': (lib) => lib._standard(SMALL, shadeRubberTrack, {
    normalStrength: 2.6, tileMeters: 2.5, envMapIntensity: 0.5,
  }),
  'paint.white': (lib) => lib._standard(SMALL, shadePaintWhite, {
    normalStrength: 1.8, tileMeters: 2, envMapIntensity: 0.6,
  }),
  'snow.piste': (lib) => {
    const s = lib._bake(HERO, shadeSnow, { normalStrength: 2.0, name: 'snow.piste' });
    const m = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: s.map,
      normalMap: s.normalMap,
      roughnessMap: s.ormMap,
      aoMap: s.ormMap,
      roughness: 1,
      metalness: 0,
      // Sheen fakes the forward-scattering rolloff that makes snow read as snow
      // and not as white plastic; full subsurface is not worth the cost here.
      sheen: 0.8,
      sheenRoughness: 0.85,
      sheenColor: new THREE.Color(0xc8dcff),
      specularIntensity: 0.6,
      envMapIntensity: 1.1,
    });
    m.userData.tileMeters = 6;
    return { material: m, surface: s };
  },
  'water.pool': (lib) => {
    const s = lib._bake(SMALL, shadeWater, { normalStrength: 1.7, name: 'water.pool' });
    // A second normal layer scrolling the other way is what stops pool water
    // from looking like a single sliding sheet.
    const normalB = s.normalMap.clone();
    normalB.repeat.set(2.3, 2.3);
    normalB.needsUpdate = true;
    lib._textures.add(normalB);

    const m = new THREE.MeshPhysicalMaterial({
      color: 0x2f9fc4,
      map: s.map,
      normalMap: s.normalMap,
      normalScale: new THREE.Vector2(0.55, 0.55),
      clearcoat: 1,
      clearcoatRoughness: 0.06,
      clearcoatNormalMap: normalB,
      clearcoatNormalScale: new THREE.Vector2(0.35, 0.35),
      roughnessMap: s.ormMap,
      roughness: 1,
      metalness: 0,
      transmission: 0.85,
      thickness: 1.4,
      ior: 1.333,
      attenuationColor: new THREE.Color(0x1a7f9a),
      attenuationDistance: 3.5,
      envMapIntensity: 1.4,
      side: THREE.DoubleSide,
    });
    m.userData.tileMeters = 4;
    lib._animate((dt, t) => {
      s.normalMap.offset.set((t * 0.021) % 1, (t * 0.034) % 1);
      normalB.offset.set((-t * 0.028) % 1, (t * 0.017) % 1);
    });
    return { material: m, surface: s };
  },
  'fence.chain': (lib) => lib._standard(SMALL, shadeChainLink, {
    normalStrength: 1.4, tileMeters: 2, alpha: true, alphaTest: 0.4,
    side: THREE.DoubleSide, envMapIntensity: 1.1,
  }),
  'net.mesh': (lib) => lib._standard(SMALL, shadeNet, {
    normalStrength: 1.2, tileMeters: 1.2, alpha: true, alphaTest: 0.35,
    side: THREE.DoubleSide, envMapIntensity: 0.6,
  }),
};

/* ------------------------------------------------------------------ */
/* Environment moods                                                   */
/* ------------------------------------------------------------------ */

const ENV_MOODS = {
  space: {
    sky: [[0, 0x04050b], [0.42, 0x080b16], [0.66, 0x171038], [1, 0x010206]],
    ground: 0x14181f,
    groundBoost: 0.5,
    sun: [3.2, 3.4, 4.0],
    sunPos: [-70, 45, -60],
    accents: [
      { color: [0.0, 2.4, 3.0], pos: [-60, 8, 40], size: [40, 3, 1] },
      { color: [2.6, 0.3, 2.2], pos: [55, -6, 45], size: [30, 2, 1] },
      { color: [3.0, 1.5, 0.25], pos: [10, 26, -70], size: [24, 2, 1] },
      { color: [1.3, 0.75, 0.45], pos: [78, 18, -50], size: [26, 26, 26], sphere: true },
    ],
  },
  daylight: {
    sky: [[0, 0xc8cec4], [0.28, 0x9fb9d8], [0.62, 0x6a9ada], [1, 0x2c66bc]],
    ground: 0x6a6247,
    groundBoost: 0.9,
    sun: [10.0, 8.6, 6.6],
    sunPos: [-60, 55, -50],
    accents: [],
  },
  alpine: {
    sky: [[0, 0xdfe9f6], [0.3, 0xa9c9ef], [0.66, 0x6ea2e2], [1, 0x2258b4]],
    ground: 0xe6eefb,
    groundBoost: 1.7,
    sun: [12.0, 11.4, 10.4],
    sunPos: [40, 70, -40],
    accents: [],
  },
};

/* ------------------------------------------------------------------ */
/* Library                                                             */
/* ------------------------------------------------------------------ */

export class MaterialLibrary {
  /**
   * @param {THREE.WebGLRenderer} renderer used for anisotropy limits and PMREM baking
   */
  constructor(renderer) {
    this.renderer = renderer;
    configureTextures(renderer);

    /** @type {Map<string, THREE.Material>} */
    this._materials = new Map();
    /** @type {Set<THREE.Texture>} */
    this._textures = new Set();
    /** @type {Map<string, THREE.Texture>} */
    this._envMaps = new Map();
    /** @type {THREE.WebGLRenderTarget[]} */
    this._envTargets = [];
    this._pmrem = null;

    /** Per-frame material animators. Closures, so update() allocates nothing. */
    this._animated = [];
    this._time = 0;
    this._warned = new Set();
    this.ready = false;
  }

  /* ---------------- public API ---------------- */

  /**
   * Generate every material and environment map, yielding between bakes so the
   * loading bar keeps animating instead of the tab locking up.
   * @param {(progress:number, label:string)=>void} [onProgress]
   */
  async warmup(onProgress) {
    const keys = Object.keys(RECIPES);
    const total = keys.length + ENV_MOODS_KEYS.length;
    let done = 0;

    for (const key of keys) {
      this.get(key);
      done++;
      onProgress?.(done / total, `Baking ${key}`);
      // One yield per surface: bakes run 20-150 ms, which is exactly the
      // granularity a progress bar needs to look alive.
      await yieldFrame();
    }

    for (const mood of ENV_MOODS_KEYS) {
      this.getEnvMap(mood);
      done++;
      onProgress?.(done / total, `Prefiltering ${mood} reflections`);
      await yieldFrame();
    }

    /* No shader precompile here any more.
     *
     * This used to build a throwaway scene of one cube per recipe and compile
     * it, which sounds like a free head start and was in fact pure waste: that
     * scene had one directional light and no point lights, while the real scene
     * never has fewer than the full slot set from gfx/LightRig.js. Light counts
     * are part of Three's program cache key, so not one of those ~46 programs
     * could ever be reused - they were compiled, counted and abandoned.
     *
     * The single `prewarm()` in main.js compiles the same materials against the
     * lighting they are actually drawn with, and now runs *behind the title
     * card* rather than in front of it. Anything that costs time here is time
     * the player spends looking at a progress bar instead of a menu. */
    this.ready = true;
    onProgress?.(1, 'Materials ready');
  }

  /**
   * Fetch a shared material.
   *
   * Supports a `'key:repeat'` or `'key:repeatX,repeatY'` shorthand that returns
   * a cached clone with the given UV tiling - the clone shares GPU texture
   * storage, so tiling variants are effectively free.
   *
   * @param {string} key
   * @returns {THREE.Material}
   */
  get(key) {
    const cached = this._materials.get(key);
    if (cached) return cached;

    const colon = key.indexOf(':');
    if (colon > 0) {
      const base = key.slice(0, colon);
      const parts = key.slice(colon + 1).split(',');
      const rx = parseFloat(parts[0]);
      const ry = parts.length > 1 ? parseFloat(parts[1]) : rx;
      if (Number.isFinite(rx) && Number.isFinite(ry) && this.has(base)) {
        return this.scaled(base, rx, ry, key);
      }
    }

    const recipe = RECIPES[key];
    if (!recipe) return this._fallback(key);

    const built = recipe(this);
    const material = built.material ?? built;
    material.name = key;
    this._materials.set(key, material);
    return material;
  }

  /** @param {string} key @returns {boolean} */
  has(key) {
    return this._materials.has(key) || Object.prototype.hasOwnProperty.call(RECIPES, key);
  }

  /**
   * Publish a material under a key so other systems can share it.
   * @param {string} key
   * @param {THREE.Material} material
   */
  register(key, material) {
    if (!material) return material;
    material.name = material.name || key;
    this._materials.set(key, material);
    this._collectTextures(material);
    return material;
  }

  /** @returns {string[]} every key this library can produce. */
  get keys() {
    const set = new Set(Object.keys(RECIPES));
    for (const k of this._materials.keys()) set.add(k);
    return [...set];
  }

  /**
   * A clone of a library material with independent UV tiling. Texture clones
   * share their `Source`, so the GPU upload is shared with the original.
   *
   * @param {string} key
   * @param {number} repeatX
   * @param {number} [repeatY=repeatX]
   * @param {string} [cacheKey]
   * @returns {THREE.Material}
   */
  scaled(key, repeatX, repeatY = repeatX, cacheKey) {
    const id = cacheKey ?? `${key}:${repeatX},${repeatY}`;
    const cached = this._materials.get(id);
    if (cached) return cached;

    const base = this.get(key);
    const m = base.clone();
    m.name = id;
    for (const slot of MAP_SLOTS) {
      const tex = base[slot];
      if (!tex) continue;
      const c = tex.clone();
      c.repeat.set(repeatX, repeatY);
      c.needsUpdate = true;
      this._textures.add(c);
      m[slot] = c;
    }
    m.userData = { ...base.userData };
    this._materials.set(id, m);
    return m;
  }

  /**
   * Convert a real-world surface size into the `repeat` a material wants,
   * using the material's authored `userData.tileMeters`.
   * @param {string} key
   * @param {number} meters
   * @returns {number}
   */
  uvScaleFor(key, meters) {
    const tile = this.get(key).userData?.tileMeters ?? 2;
    return Math.max(0.01, meters / tile);
  }

  /**
   * A colour-tinted clone that shares all textures with the original.
   * @param {string} key
   * @param {number} color
   * @param {string} [cacheKey]
   */
  tinted(key, color, cacheKey) {
    const id = cacheKey ?? `${key}#${color.toString(16)}`;
    const cached = this._materials.get(id);
    if (cached) return cached;
    const m = this.get(key).clone();
    m.color = new THREE.Color(color);
    m.name = id;
    this._materials.set(id, m);
    return m;
  }

  /**
   * Prefiltered environment map for a world mood, built by PMREM-ing a
   * procedurally lit scene. Without this, every metal in the game reflects
   * nothing and reads as flat grey plastic.
   *
   * @param {'space'|'daylight'|'alpine'} mood
   * @returns {THREE.Texture}
   */
  getEnvMap(mood = 'daylight') {
    const key = ENV_MOODS[mood] ? mood : 'daylight';
    const cached = this._envMaps.get(key);
    if (cached) return cached;
    const tex = this._generateEnvMap(key);
    this._envMaps.set(key, tex);
    return tex;
  }

  /**
   * Tick animated materials (water scroll, emissive pulse, holo crawl).
   * **main.js must call this once per rendered frame.**
   * @param {number} dt seconds
   */
  update(dt) {
    this._time += dt;
    const t = this._time;
    const list = this._animated;
    for (let i = 0; i < list.length; i++) list[i](dt, t);
  }

  /** Release every material, texture and render target this library owns. */
  dispose() {
    for (const m of this._materials.values()) m.dispose?.();
    this._materials.clear();
    for (const t of this._textures) t.dispose?.();
    this._textures.clear();
    for (const rt of this._envTargets) rt.dispose?.();
    this._envTargets.length = 0;
    this._envMaps.clear();
    this._pmrem?.dispose?.();
    this._pmrem = null;
    this._animated.length = 0;
  }

  /* ---------------- internals ---------------- */

  /** Bake a surface and take ownership of its textures. */
  _bake(size, shade, opts) {
    const s = bakeSurface(size, shade, opts);
    for (const t of s.textures) this._textures.add(t);
    return s;
  }

  /** Register a per-frame animator closure. */
  _animate(fn) {
    this._animated.push(fn);
  }

  /**
   * The standard build path: bake, then wire the ORM map into all three of
   * `aoMap`/`roughnessMap`/`metalnessMap` with the scalars pinned to 1 so the
   * texture is authoritative.
   */
  _standard(size, shade, opts = {}) {
    return this._buildSurfaceMaterial(THREE.MeshStandardMaterial, size, shade, opts);
  }

  /** Same as {@link _standard} but as a MeshPhysicalMaterial with a clearcoat. */
  _physical(size, shade, opts = {}) {
    return this._buildSurfaceMaterial(THREE.MeshPhysicalMaterial, size, shade, {
      clearcoat: 0.4,
      clearcoatRoughness: 0.2,
      ...opts,
    });
  }

  _buildSurfaceMaterial(Ctor, size, shade, opts) {
    const s = this._bake(size, shade, {
      normalStrength: opts.normalStrength ?? 1,
      alpha: !!opts.alpha,
      name: opts.name ?? 'surface',
    });
    const params = {
      color: opts.color ?? 0xffffff,
      map: s.map,
      normalMap: s.normalMap,
      roughnessMap: s.ormMap,
      metalnessMap: s.ormMap,
      aoMap: s.ormMap,
      roughness: 1,
      metalness: 1,
      aoMapIntensity: opts.aoMapIntensity ?? 1,
      envMapIntensity: opts.envMapIntensity ?? 1,
      normalScale: new THREE.Vector2(opts.normalScale ?? 1, opts.normalScale ?? 1),
      side: opts.side ?? THREE.FrontSide,
      dithering: true,
    };
    if (Ctor === THREE.MeshPhysicalMaterial) {
      params.clearcoat = opts.clearcoat ?? 0.4;
      params.clearcoatRoughness = opts.clearcoatRoughness ?? 0.2;
    }
    const m = new Ctor(params);
    if (opts.alphaTest) {
      m.alphaTest = opts.alphaTest;
      // Cut-out geometry must cast the same silhouette it renders.
      m.shadowSide = THREE.DoubleSide;
    }
    m.userData.tileMeters = opts.tileMeters ?? 2;
    return { material: m, surface: s };
  }

  /**
   * Emissive strip material. All six colours share one baked surface set, so
   * the extra hues cost a material each and nothing more.
   */
  _emissive(color, intensity, name) {
    if (!this._emissiveSurface) {
      this._emissiveSurface = this._bake(SMALL, shadeEmissiveStrip, {
        normalStrength: 1.2, emissive: true, name: 'emissive',
      });
    }
    const s = this._emissiveSurface;
    const m = new THREE.MeshStandardMaterial({
      color: 0x101318,
      map: s.map,
      normalMap: s.normalMap,
      roughnessMap: s.ormMap,
      metalnessMap: s.ormMap,
      aoMap: s.ormMap,
      roughness: 1,
      metalness: 1,
      emissive: new THREE.Color(color),
      emissiveMap: s.emissiveMap,
      emissiveIntensity: intensity,
      envMapIntensity: 0.6,
      dithering: true,
    });
    m.userData.tileMeters = 2;
    // A shallow, slow pulse. Enough to keep bloom breathing, not enough to
    // read as a broken light.
    const phase = (name.length * 1.7) % 6.283;
    this._animate((dt, t) => {
      m.emissiveIntensity = intensity * (1 + Math.sin(t * 1.15 + phase) * 0.06);
    });
    return { material: m, surface: s };
  }

  /** Neutral stand-in so a typo in a world never black-screens the game. */
  _fallback(key) {
    if (!this._warned.has(key)) {
      this._warned.add(key);
      console.warn(`[Materials] unknown key "${key}" - using metal.panel as a stand-in`);
    }
    const m = this.get('metal.panel');
    this._materials.set(key, m);
    return m;
  }

  _collectTextures(material) {
    for (const slot of MAP_SLOTS) {
      const t = material[slot];
      if (t) this._textures.add(t);
    }
  }

  _generateEnvMap(mood) {
    const def = ENV_MOODS[mood];
    if (!this._pmrem) this._pmrem = new THREE.PMREMGenerator(this.renderer);

    const scene = new THREE.Scene();
    const temp = [];

    const skyTex = makeGradientTexture({ size: 256, stops: def.sky, direction: 'vertical', noise: 0.004 });
    const skyGeo = new THREE.SphereGeometry(150, 32, 20);
    const skyMat = new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, toneMapped: false, fog: false });
    scene.add(new THREE.Mesh(skyGeo, skyMat));
    temp.push(skyGeo, skyMat, skyTex);

    // A ground disc supplies the bounce light. Without it every metal in the
    // scene has a black lower hemisphere and looks like it is floating in void.
    const groundGeo = new THREE.CircleGeometry(400, 24);
    const groundCol = new THREE.Color(def.ground).multiplyScalar(def.groundBoost);
    const groundMat = new THREE.MeshBasicMaterial({ color: groundCol, side: THREE.DoubleSide, toneMapped: false, fog: false });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -12;
    scene.add(ground);
    temp.push(groundGeo, groundMat);

    // The sun disc is what puts a specular highlight on every polished surface.
    const sunGeo = new THREE.SphereGeometry(9, 16, 12);
    const sunMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(def.sun[0], def.sun[1], def.sun[2]), toneMapped: false, fog: false,
    });
    const sunMesh = new THREE.Mesh(sunGeo, sunMat);
    sunMesh.position.set(def.sunPos[0], def.sunPos[1], def.sunPos[2]);
    scene.add(sunMesh);
    temp.push(sunGeo, sunMat);

    for (const a of def.accents) {
      const geo = a.sphere
        ? new THREE.SphereGeometry(a.size[0] * 0.5, 16, 12)
        : new THREE.BoxGeometry(a.size[0], a.size[1], a.size[2]);
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(a.color[0], a.color[1], a.color[2]), toneMapped: false, fog: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(a.pos[0], a.pos[1], a.pos[2]);
      mesh.lookAt(0, 0, 0);
      scene.add(mesh);
      temp.push(geo, mat);
    }

    const rt = this._pmrem.fromScene(scene, 0.22, 1, 500, { size: 256 });
    this._envTargets.push(rt);
    rt.texture.name = `env.${mood}`;

    for (const d of temp) d.dispose?.();
    scene.clear();
    return rt.texture;
  }

}

/** Texture slots a material may own; used for cloning and disposal. */
const MAP_SLOTS = [
  'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap',
  'alphaMap', 'bumpMap', 'displacementMap', 'clearcoatNormalMap',
  'clearcoatRoughnessMap', 'sheenColorMap', 'sheenRoughnessMap', 'transmissionMap',
  'thicknessMap', 'specularIntensityMap', 'lightMap',
];

const ENV_MOODS_KEYS = Object.keys(ENV_MOODS);

export default MaterialLibrary;
