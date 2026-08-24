/**
 * BUDGET RE-VERIFICATION: diff two trees' `world-shot` sweeps, world by world.
 *
 *   node scripts/budget-diff.mjs .probe/reverify/base .probe/reverify/main
 *   node scripts/budget-diff.mjs <before> <after> --md out.md
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * `world-shot --compare` diffs ONE world's report against ONE other. Phase 9
 * ran nine art branches and every one of them justified its merge with a
 * budget table taken through a harness that was later found to be measuring
 * inside boot's own warm-up, with `rehearse()`'s force-draw still up. Checking
 * whether a regression hid inside that noise means re-measuring EVERY world on
 * both sides of the phase with the fixed instrument and diffing the whole
 * sweep at once, which is what this does.
 *
 * ── The one axis that is not compared per framing ─────────────────────────
 *
 * `programs` climbs monotonically WITHIN a run - 241 at the first framing to
 * 441 at the twelfth on unchanged code - because a sweep walks the player into
 * material configurations the boot warm never linked. A per-framing programs
 * delta is therefore a measurement of how far each run had got, not of the
 * world. Only the LAST framing's value is comparable, and that is the one
 * reported. Every other axis is compared framing by framing.
 *
 * A framing that failed on either side is reported as such and excluded, so a
 * world with one bad framing still yields a table for its other twelve.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** The axes Phase 9's budget tables were written in. */
const AXES = [
  'materials', 'renderables', 'instancedMeshes', 'instances',
  'worldLights', 'worldLightsLit', 'geometries', 'textures',
  'drawCalls', 'worldTriangles', 'npcs', 'unculledMeshes',
];

/** Axes whose value is a property of the RUN, not of the framing. @see header */
const END_OF_RUN = ['programs'];

async function loadSweep(dir) {
  const out = new Map();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = path.join(dir, entry.name, 'report.json');
    if (!existsSync(p)) continue;
    out.set(entry.name, JSON.parse(await readFile(p, 'utf8')));
  }
  return out;
}

/**
 * Was this framing measured on a settled frame, in the world it claims?
 *
 * A row taken with `rehearsalInForce` up counts the whole world as drawn, and
 * a row whose `world` is not the one asked for is a picture of somewhere else.
 * Both were live defects in the instrument these numbers are re-taking.
 */
function suspicion(view, worldId) {
  const bad = [];
  if (view.error) return ['FAILED: ' + view.error.split('\n')[0]];
  if (view.world !== worldId) bad.push(`world=${view.world}`);
  if (view.rehearsalInForce) bad.push(`rehearsalInForce=${view.rehearsalInForce}`);
  if (view.bootWarmRunning) bad.push('bootWarmRunning');
  if (view.gameplayDriven === false) bad.push('gameplayDriven=false');
  return bad;
}

function fmt(n) {
  return typeof n === 'number' ? n.toLocaleString('en-US') : String(n);
}

function delta(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') return null;
  return b - a;
}

function main() {
  const [beforeDir, afterDir, ...rest] = process.argv.slice(2);
  if (!beforeDir || !afterDir) {
    console.error('usage: node scripts/budget-diff.mjs <beforeDir> <afterDir> [--md out.md] [--json out.json]');
    return 1;
  }
  const mdAt = rest.indexOf('--md');
  const jsonAt = rest.indexOf('--json');
  return run(beforeDir, afterDir, mdAt >= 0 ? rest[mdAt + 1] : null, jsonAt >= 0 ? rest[jsonAt + 1] : null);
}

async function run(beforeDir, afterDir, mdOut, jsonOut) {
  const before = await loadSweep(beforeDir);
  const after = await loadSweep(afterDir);
  const worlds = [...new Set([...before.keys(), ...after.keys()])].sort();

  const result = { beforeDir, afterDir, worlds: {} };
  const lines = [];
  const say = (s = '') => { lines.push(s); console.log(s); };

  for (const w of worlds) {
    const A = before.get(w);
    const B = after.get(w);
    say(`\n## ${w}`);
    if (!A || !B) { say(`  MISSING on ${!A ? 'before' : 'after'} - not compared`); continue; }
    if (A.mazeSeed?.active != null || B.mazeSeed?.active != null) {
      say(`  maze seed: before ${A.mazeSeed?.active} / after ${B.mazeSeed?.active}`
        + (A.mazeSeed?.active === B.mazeSeed?.active ? '  (same)' : '  ** DIFFERENT - not comparable **'));
    }
    const rec = { seedBefore: A.mazeSeed?.active ?? null, seedAfter: B.mazeSeed?.active ?? null, framings: {}, axes: {}, programs: {}, skipped: [] };

    const names = [...new Set([...Object.keys(A.views), ...Object.keys(B.views)])];
    const usable = [];
    for (const n of names) {
      const a = A.views[n];
      const b = B.views[n];
      if (!a || !b) { rec.skipped.push(`${n}: only on ${a ? 'before' : 'after'}`); continue; }
      const sa = suspicion(a, w);
      const sb = suspicion(b, w);
      if (sa.length || sb.length) {
        rec.skipped.push(`${n}: before[${sa.join(' ')}] after[${sb.join(' ')}]`);
        continue;
      }
      usable.push(n);
      const d = {};
      for (const ax of AXES) d[ax] = delta(a[ax], b[ax]);
      rec.framings[n] = { before: Object.fromEntries(AXES.map((ax) => [ax, a[ax]])), after: Object.fromEntries(AXES.map((ax) => [ax, b[ax]])), delta: d };
    }
    if (rec.skipped.length) for (const s of rec.skipped) say(`  skipped ${s}`);
    if (!usable.length) { say('  NO COMPARABLE FRAMINGS'); result.worlds[w] = rec; continue; }

    // Per-axis roll-up across framings: the range of before, after and delta.
    say(`  ${'axis'.padEnd(16)} ${'before'.padStart(20)} ${'after'.padStart(20)} ${'delta'.padStart(18)}`);
    for (const ax of AXES) {
      const bs = usable.map((n) => rec.framings[n].before[ax]).filter((v) => typeof v === 'number');
      const as = usable.map((n) => rec.framings[n].after[ax]).filter((v) => typeof v === 'number');
      const ds = usable.map((n) => rec.framings[n].delta[ax]).filter((v) => typeof v === 'number');
      if (!ds.length) continue;
      const rng = (xs) => (Math.min(...xs) === Math.max(...xs) ? fmt(xs[0]) : `${fmt(Math.min(...xs))}..${fmt(Math.max(...xs))}`);
      const dmin = Math.min(...ds);
      const dmax = Math.max(...ds);
      const dstr = dmin === dmax
        ? (dmin === 0 ? '0' : (dmin > 0 ? `+${fmt(dmin)}` : fmt(dmin)))
        : `${dmin > 0 ? '+' : ''}${fmt(dmin)}..${dmax > 0 ? '+' : ''}${fmt(dmax)}`;
      rec.axes[ax] = { before: rng(bs), after: rng(as), deltaMin: dmin, deltaMax: dmax, moved: !(dmin === 0 && dmax === 0) };
      say(`  ${ax.padEnd(16)} ${rng(bs).padStart(20)} ${rng(as).padStart(20)} ${dstr.padStart(18)}`
        + (dmin === 0 && dmax === 0 ? '' : '   <<< MOVED'));
    }

    // programs: end of run only.
    const lastOf = (R) => {
      const ns = Object.keys(R.views).filter((n) => !R.views[n].error);
      const last = ns[ns.length - 1];
      return last ? { view: last, programs: R.views[last].programs } : null;
    };
    const pa = lastOf(A);
    const pb = lastOf(B);
    for (const ax of END_OF_RUN) void ax;
    rec.programs = { before: pa, after: pb, delta: pa && pb ? pb.programs - pa.programs : null };
    say(`  ${'programs(end)'.padEnd(16)} ${String(pa?.programs).padStart(20)} ${String(pb?.programs).padStart(20)} `
      + `${(rec.programs.delta > 0 ? '+' : '') + rec.programs.delta}`.padStart(18)
      + `    [${pa?.view} -> ${pb?.view}]`);
    rec.framingsCompared = usable.length;
    result.worlds[w] = rec;
  }

  if (jsonOut) await writeFile(jsonOut, JSON.stringify(result, null, 2));
  if (mdOut) await writeFile(mdOut, '```\n' + lines.join('\n') + '\n```\n');
  return 0;
}

process.exit(await main());
