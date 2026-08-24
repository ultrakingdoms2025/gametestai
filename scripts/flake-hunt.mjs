/**
 * Run the suite N times on an unchanged tree and report every test that fails
 * in any run.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * During the Phase 12 survey the suite was run three times against a tree
 * whose only changes were new scripts and new documents. Two of those runs
 * reported 3279/3279; one reported **3263 pass, 2 fail**, and the failing
 * names were lost because that run's output had been piped through `tail`.
 *
 * A suite that fails twice in a thousand for no reason is not a small thing
 * when it is the merge gate: it teaches everyone who sees a red run to run it
 * again rather than read it, which is exactly how a real failure gets waved
 * through. So the question "which tests are they" is worth answering
 * precisely rather than leaving as an impression.
 *
 *   node scripts/flake-hunt.mjs --runs 3
 */

import { spawn } from 'node:child_process';
import { writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { runs: 3, out: '.probe/flake' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--runs') out.runs = Number(argv[++i]);
    else if (argv[i] === '--out') out.out = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

/**
 * The exact file list `npm test` runs.
 *
 * `package.json` says `node --test scripts/tests/*.test.mjs`, and that glob is
 * expanded by the SHELL. Spawning without a shell and passing the directory
 * instead is not the same command: it reported `not ok 1 - scripts\tests` four
 * times out of four and zero tests passed, which reads exactly like a suite
 * that is failing rather than a runner that was never given any files.
 */
async function suiteFiles() {
  const dir = path.join(root, 'scripts', 'tests');
  const names = await readdir(dir);
  return names.filter((n) => n.endsWith('.test.mjs')).map((n) => path.join('scripts', 'tests', n));
}

function runSuite(files) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--test', ...files], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { out += c; });
    p.on('close', (code) => resolve({ code, out }));
  });
}

/**
 * TAP "not ok" lines, plus the name of the test each belongs to.
 *
 * Node's runner nests, so a failing leaf produces a `not ok` for itself AND
 * for every suite above it. Only the deepest one names the actual test, so the
 * raw lines are kept rather than deduplicated into something tidier and less
 * true.
 */
function failures(tap) {
  return tap.split(/\r?\n/)
    .filter((l) => /^\s*not ok /.test(l))
    .map((l) => l.trim());
}

async function main() {
  const outDir = path.resolve(root, args.out);
  await mkdir(outDir, { recursive: true });
  const rows = [];
  const files = await suiteFiles();
  console.log(`suite: ${files.length} test files\n`);

  for (let i = 1; i <= args.runs; i++) {
    process.stdout.write(`run ${i}/${args.runs} … `);
    const { code, out } = await runSuite(files);
    const pass = /^# pass (\d+)/m.exec(out)?.[1] ?? '?';
    const fail = /^# fail (\d+)/m.exec(out)?.[1] ?? '?';
    const f = failures(out);
    rows.push({ run: i, exitCode: code, pass: Number(pass), fail: Number(fail), failures: f });
    console.log(`pass ${pass}, fail ${fail}, exit ${code}`);
    for (const line of f.slice(0, 8)) console.log(`    ${line}`);
    await writeFile(path.join(outDir, `run-${i}.tap`), out);
  }

  const everFailed = new Set();
  for (const r of rows) for (const f of r.failures) everFailed.add(f.replace(/^not ok \d+ - /, ''));

  console.log('\n=== SUMMARY ===');
  console.log(`runs: ${rows.length}`);
  console.log(`pass counts: ${rows.map((r) => r.pass).join(', ')}`);
  console.log(`fail counts: ${rows.map((r) => r.fail).join(', ')}`);
  console.log(`deterministic: ${new Set(rows.map((r) => r.fail)).size === 1 ? 'YES' : 'NO'}`);
  if (everFailed.size) {
    console.log('\ntests that failed in at least one run:');
    for (const n of everFailed) console.log(`  - ${n}`);
  }
  await writeFile(path.join(outDir, 'summary.json'), `${JSON.stringify({ at: new Date().toISOString(), rows }, null, 2)}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
