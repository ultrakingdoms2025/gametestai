/**
 * BUDGET RE-VERIFICATION: diff two trees' `world-shot` sweeps, world by world.
 *
 *   node scripts/budget-diff.mjs .probe/reverify/base .probe/reverify/main
 *   node scripts/budget-diff.mjs <before> <after> --md out.md
 *   node scripts/budget-diff.mjs <before> <after> --max drawCalls=5% --max worldTriangles=2%
 *
 * ═════════════════════════════════════════════════════════════════════════
 *  WHAT THIS ASSERTS, AND WHAT IT DOES NOT
 * ═════════════════════════════════════════════════════════════════════════
 *
 * READ THIS BEFORE QUOTING A RUN OF THIS SCRIPT AS EVIDENCE.
 *
 * By default it asserts NOTHING about a budget. It is a DIFF VIEWER: it prints
 * what moved, and a clean exit means the comparison was VALID, not that the
 * numbers were acceptable. It used to `return 0` on literally every path,
 * including "no comparable framings" and "the maze seeds differ so nothing here
 * is comparable" - a script named like a gate, wired like a report, whose green
 * exit was quotable as a pass by anybody who did not read it. That is the shape
 * this repository keeps paying for, so it is now spelled out here and in the
 * script's own output.
 *
 * What it now DOES fail on:
 *
 *   1. AN INVALID COMPARISON. A world present on only one side, a world with no
 *      comparable framings, differing maze seeds (two unrelated mazes), or a
 *      `programs(end)` pairing that lands on two DIFFERENT framings. Each of
 *      those is a run that cannot support a conclusion, and it now says so with
 *      exit 1 rather than printing a table.
 *   2. A THRESHOLD YOU ASKED FOR. `--max <axis>=<n>` or `--max <axis>=<n>%`
 *      fails when any framing's delta on that axis exceeds the bound. With no
 *      `--max` there is no budget and the footer says so in as many words.
 *
 * ── Why `programs` is reported and can never be gated ─────────────────────
 *
 * `programs` climbs monotonically WITHIN a run - 241 at the first framing to
 * 441 at the twelfth on unchanged code - because a sweep walks the player into
 * material configurations the boot warm never linked. A per-framing programs
 * delta is therefore a measurement of how far each run had got, not of the
 * world.
 *
 * And the end-of-run figure is no better. `renderer.info.programs.length` is
 * recorded in this project's own notes as UNUSABLE for A/B: station end-of-run
 * measured 512/536 against 580/580 - an apparent reproducible +68 - and a third
 * run gave 536/535. The figure that reproduces to within one is
 * `stats().warm.programs`, the cache at settled boot, which `world-shot` writes
 * to `report.warm.programs`. So that is what this compares and gates; the
 * end-of-run value is printed beside it, labelled, and refused as a threshold.
 *
 * ── The pairing bug this had, which made the programs row a coin flip ─────
 *
 * `lastOf()` took each side's LAST NON-ERROR framing independently. When a
 * framing failed on one side only, the two sides' "last" were two DIFFERENT
 * framings - `zone-canteen-court` against `zone-canteen`, say - and the
 * difference between two unrelated vantages was printed as a delta with no
 * warning of any kind. `[a -> b]` was in the output the whole time and reads as
 * provenance rather than as an error. The pairing is now explicit: the last
 * framing COMMON to both runs, or a hard failure.
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

/* `programs` used to be listed here as an "END_OF_RUN" axis, with the only use
 * of that list being `for (const ax of END_OF_RUN) void ax;`. It is handled
 * explicitly below, beside `programs(warm)`, and the two are reported together
 * because the difference between them is the whole point. @see header */

/**
 * Parse `--max drawCalls=5%` / `--max worldTriangles=800` into a bound.
 *
 * Percent is of the BEFORE value, per framing, so a 5% bound on a world drawing
 * 200 and one drawing 2,000 means what it says in both. Absolute is absolute.
 */
function parseMax(rest) {
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== '--max') continue;
    const spec = rest[++i];
    const m = /^([A-Za-z]+)=(-?\d+(?:\.\d+)?)(%?)$/.exec(spec ?? '');
    if (!m) throw new Error(`--max wants <axis>=<n> or <axis>=<n>%, got "${spec}"`);
    if (!AXES.includes(m[1])) {
      throw new Error(`--max axis "${m[1]}" is not one of: ${AXES.join(', ')}`);
    }
    out.push({ axis: m[1], bound: Number(m[2]), pct: m[3] === '%' });
  }
  return out;
}

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
    console.error('usage: node scripts/budget-diff.mjs <beforeDir> <afterDir> [--md out.md] [--json out.json]'
      + '\n                                  [--max <axis>=<n>|<n>%] ...'
      + `\n       axes: ${AXES.join(', ')}`
      + '\n       With no --max this asserts NO budget - see the header.');
    return 1;
  }
  const mdAt = rest.indexOf('--md');
  const jsonAt = rest.indexOf('--json');
  let maxes;
  try {
    maxes = parseMax(rest);
  } catch (e) {
    console.error(String(e.message ?? e));
    return 1;
  }
  return run(beforeDir, afterDir, mdAt >= 0 ? rest[mdAt + 1] : null, jsonAt >= 0 ? rest[jsonAt + 1] : null, maxes);
}

async function run(beforeDir, afterDir, mdOut, jsonOut, maxes = []) {
  const before = await loadSweep(beforeDir);
  const after = await loadSweep(afterDir);
  const worlds = [...new Set([...before.keys(), ...after.keys()])].sort();

  const result = { beforeDir, afterDir, worlds: {}, maxes, invalid: [], breaches: [] };
  const lines = [];
  const say = (s = '') => { lines.push(s); console.log(s); };
  /* A COMPARISON THAT CANNOT SUPPORT A CONCLUSION IS A FAILURE, NOT A ROW.
   * Collected rather than thrown so a sweep of seventeen worlds still prints
   * every world's table - the evidence has to survive the verdict, same rule
   * `world-shot` follows for `report.json`. */
  const invalid = (msg) => { result.invalid.push(msg); say(`  !! ${msg}`); };

  for (const w of worlds) {
    const A = before.get(w);
    const B = after.get(w);
    say(`\n## ${w}`);
    if (!A || !B) { invalid(`${w}: MISSING on ${!A ? 'before' : 'after'} - not compared`); continue; }
    if (A.mazeSeed?.active != null || B.mazeSeed?.active != null) {
      const same = A.mazeSeed?.active === B.mazeSeed?.active;
      say(`  maze seed: before ${A.mazeSeed?.active} / after ${B.mazeSeed?.active}${same ? '  (same)' : ''}`);
      /* Two seeds are two unrelated mazes - the measured swing on UNCHANGED
       * code is 90% of world triangles. Nothing below is a delta. */
      if (!same) invalid(`${w}: maze seeds differ (${A.mazeSeed?.active} vs ${B.mazeSeed?.active}) - two unrelated mazes, no row here is a delta`);
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
    if (!usable.length) {
      invalid(`${w}: NO COMPARABLE FRAMINGS - this world was not measured on both sides`);
      result.worlds[w] = rec;
      continue;
    }

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

      /* The only thing in this script that is a gate, and only because a
       * caller asked for it by name. Per FRAMING, not on the roll-up: a world
       * whose worst framing regressed 12% while its best improved 12% has a
       * delta range that straddles zero, and a bound on the range would pass
       * it. `bs` and `ds` are index-aligned with `usable` by construction. */
      for (const m of maxes.filter((x) => x.axis === ax)) {
        for (let i = 0; i < usable.length; i++) {
          const b0 = rec.framings[usable[i]].before[ax];
          const d = rec.framings[usable[i]].delta[ax];
          if (typeof d !== 'number' || typeof b0 !== 'number') continue;
          const limit = m.pct ? Math.abs(b0) * (m.bound / 100) : m.bound;
          if (d > limit) {
            const shown = m.pct ? `${m.bound}% of ${fmt(b0)} = ${limit.toFixed(1)}` : fmt(m.bound);
            result.breaches.push(`${w}/${usable[i]} ${ax}: +${fmt(d)} over the ${shown} bound`);
            say(`    BREACH ${usable[i]} ${ax} +${fmt(d)} > ${shown}`);
          }
        }
      }
    }

    /* ── programs: END OF RUN, PAIRED EXPLICITLY, AND NEVER GATED ──────────
     *
     * The last framing COMMON to both runs. Taking each side's own last
     * non-error framing independently compared two DIFFERENT vantages the
     * moment one side lost a framing, and printed the result as a delta. */
    const commonRun = Object.keys(A.views)
      .filter((n) => B.views[n] && !A.views[n].error && !B.views[n].error);
    const paired = commonRun[commonRun.length - 1] ?? null;
    if (!paired) {
      invalid(`${w}: no framing succeeded on BOTH sides - programs(end) cannot be paired`);
      rec.programs = { view: null, before: null, after: null, delta: null };
    } else {
      const pa = A.views[paired].programs;
      const pb = B.views[paired].programs;
      rec.programs = { view: paired, before: pa, after: pb, delta: (typeof pa === 'number' && typeof pb === 'number') ? pb - pa : null };
      say(`  ${'programs(end)'.padEnd(16)} ${String(pa).padStart(20)} ${String(pb).padStart(20)} `
        + `${(rec.programs.delta > 0 ? '+' : '') + rec.programs.delta}`.padStart(18)
        + `    [both at "${paired}" - NOT a budget, see header]`);
    }
    /* The figure that actually reproduces: the program cache at settled boot.
     * `world-shot` writes it from `HARNESS.stats().warm`. */
    const wa = A.warm ?? null;
    const wb = B.warm ?? null;
    rec.warmPrograms = {
      before: wa?.programs ?? null, after: wb?.programs ?? null,
      settledBefore: wa?.programsSettled ?? null, settledAfter: wb?.programsSettled ?? null,
      delta: (typeof wa?.programs === 'number' && typeof wb?.programs === 'number') ? wb.programs - wa.programs : null,
    };
    if (rec.warmPrograms.before !== null || rec.warmPrograms.after !== null) {
      const d = rec.warmPrograms.delta;
      say(`  ${'programs(warm)'.padEnd(16)} ${String(rec.warmPrograms.before).padStart(20)} ${String(rec.warmPrograms.after).padStart(20)} `
        + `${d === null ? '?' : (d > 0 ? '+' : '') + d}`.padStart(18)
        + (wa?.programsSettled === false || wb?.programsSettled === false
          ? '    ** STILL MOVING when measured - not comparable **' : '    [the reproducible one]'));
      if (wa?.programsSettled === false || wb?.programsSettled === false) {
        invalid(`${w}: the program cache was still growing when a side was measured - programs(warm) is not a delta`);
      }
    }
    rec.framingsCompared = usable.length;
    result.worlds[w] = rec;
  }

  /* ── THE FOOTER SAYS WHAT WAS AND WAS NOT ASSERTED ──────────────────────
   * Because the thing that made this dangerous was never the arithmetic, it
   * was a clean exit with nothing written down about what "clean" meant. */
  say('');
  if (maxes.length) {
    say(`asserted: ${maxes.map((m) => `${m.axis} <= +${m.bound}${m.pct ? '%' : ''}`).join(', ')}`);
  } else {
    say('asserted: NO BUDGET. This run is a diff VIEWER - it says what moved, not whether');
    say('          that is acceptable. Pass --max <axis>=<n> to make it a gate.');
  }
  if (result.invalid.length) {
    say(`INVALID COMPARISON in ${result.invalid.length} place(s):`);
    for (const m of result.invalid) say(`  ${m}`);
  }
  if (result.breaches.length) {
    say(`${result.breaches.length} budget breach(es):`);
    for (const m of result.breaches) say(`  ${m}`);
  }
  if (!result.invalid.length && !result.breaches.length) {
    say(maxes.length
      ? 'comparison valid; every declared bound held.'
      : 'comparison valid. NOTHING ELSE IS CLAIMED.');
  }

  if (jsonOut) await writeFile(jsonOut, JSON.stringify(result, null, 2));
  if (mdOut) await writeFile(mdOut, '```\n' + lines.join('\n') + '\n```\n');
  return (result.invalid.length || result.breaches.length) ? 1 : 0;
}

process.exit(await main());
