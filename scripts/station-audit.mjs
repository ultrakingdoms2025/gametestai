#!/usr/bin/env node
/**
 * Drive a real Chrome at the running dev server, run the station placement
 * audit inside the page, and write the report out.
 *
 * ── Why a real headed browser, and why its own profile ─────────────────────
 * The audit reads `physics` and the built scene graph, and both of those only
 * exist once the world has actually been built by the real engine - there is no
 * headless path to a `StationWorld` (see the note at the top of
 * scripts/tests/station-audit.test.mjs). Headless Chrome will build it, but the
 * game's boot is gated on WebGL and a click, and a *shared* user-data-dir is
 * worse than either: a second Chrome started against a profile that is already
 * open silently hands the URL to the running instance and exits, so the driver
 * connects to a debugging port that belongs to some other window, sees whatever
 * page happened to be open there, and reports an empty world as a clean audit.
 * A fresh temp profile per run is the only way this measures what it launched.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────
 *   node scripts/station-audit.mjs
 *   node scripts/station-audit.mjs --url http://localhost:5180/game/ --out output/x.json
 *   node scripts/station-audit.mjs --selftest      # inject known defects first
 *
 * Exits non-zero when any check reports a finding, or when the self-test fails.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const DEFAULT_URL = 'http://localhost:5180/game/?dev=1&world=station&autostart=1';

/* ------------------------------------------------------------------ */
/* Chrome                                                              */
/* ------------------------------------------------------------------ */

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

function findChrome() {
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
  throw new Error(`no Chrome found; set CHROME_PATH. Tried:\n  ${CHROME_CANDIDATES.join('\n  ')}`);
}

/** An OS-assigned free port, so two runs can never fight over 9222. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Launch headed Chrome on its own profile and return a page CDP session.
 *
 * Headed on purpose: an occluded or headless window can stop delivering
 * animation frames, and every await inside the harness is an animation frame.
 * `CalculateNativeWinOcclusion` is disabled for the same reason - see the note
 * on `Harness.holdAwake`.
 */
async function launchChrome(url, { headless = false } = {}) {
  const exe = findChrome();
  const port = await freePort();
  const profile = await mkdtemp(path.join(tmpdir(), 'station-audit-'));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=CalculateNativeWinOcclusion,Translate',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--window-size=1280,800',
    '--window-position=0,0',
  ];
  if (headless) args.push('--headless=new', '--use-angle=swiftshader');
  /* Started on about:blank and navigated over CDP rather than launched at the
   * URL. Passing the URL on the command line races the debugger: the page
   * target appears, the driver attaches, and then the real navigation tears the
   * execution context down under the first `Runtime.evaluate` - which surfaces
   * as "Execution context was destroyed" from somewhere unrelated. */
  args.push('about:blank');

  const child = spawn(exe, args, { stdio: 'ignore', detached: false });
  /* `child.kill()` alone is not enough on Windows: Chrome's launcher process
   * exits immediately and leaves the renderer and GPU processes holding the
   * profile directory, so the `rm` below then blocks for minutes on a locked
   * file - which looks exactly like a hung audit. Kill the tree, then treat
   * the temp directory as best-effort. */
  const kill = async () => {
    try {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        child.kill('SIGKILL');
      }
    } catch { /* already gone */ }
    await sleep(500);
    try {
      await Promise.race([
        rm(profile, { recursive: true, force: true, maxRetries: 2 }),
        sleep(4000),
      ]);
    } catch { /* a locked profile in the OS temp dir is not worth failing a run over */ }
  };

  // Wait for the debugging endpoint, then for a page target on our URL.
  const deadline = Date.now() + 40000;
  let target = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.startsWith('devtools://'));
      if (target) break;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  if (!target) {
    await kill();
    throw new Error('chrome never exposed a page target');
  }
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const loaded = new Promise((resolve) => {
    cdp.on((msg) => { if (msg.method === 'Page.loadEventFired') resolve(); });
  });
  await cdp.send('Page.navigate', { url });
  await Promise.race([loaded, sleep(60000)]);
  return { cdp, kill, port, profile };
}

/* ------------------------------------------------------------------ */
/* A very small CDP client - global WebSocket, no dependencies         */
/* ------------------------------------------------------------------ */

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const listeners = [];

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve: ok, reject: no } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) no(new Error(`${msg.error.message} (${msg.error.code})`));
        else ok(msg.result);
        return;
      }
      for (const fn of listeners) fn(msg);
    });
    ws.addEventListener('error', (e) => reject(new Error(`cdp socket error: ${e.message ?? e}`)));
    ws.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          const mid = ++id;
          return new Promise((ok, no) => {
            pending.set(mid, { resolve: ok, reject: no });
            ws.send(JSON.stringify({ id: mid, method, params }));
          });
        },
        on(fn) { listeners.push(fn); },
        close() { try { ws.close(); } catch { /* already closed */ } },
      });
    });
  });
}

/**
 * Evaluate an expression in the page and return its value.
 *
 * Everything crossing this boundary is JSON: the audit report is megabytes of
 * plain objects, and `returnByValue` on a live object graph is both slower and
 * lossier than stringifying once inside the page.
 */
async function evaluate(cdp, expression, { timeoutMs = 600000 } = {}) {
  const r = await Promise.race([
    cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true,
      timeout: timeoutMs,
    }),
    sleep(timeoutMs).then(() => { throw new Error(`evaluate timed out after ${timeoutMs}ms`); }),
  ]);
  if (r.exceptionDetails) {
    const e = r.exceptionDetails;
    throw new Error(`page threw: ${e.exception?.description ?? e.text}`);
  }
  return r.result?.value;
}

/* ------------------------------------------------------------------ */
/* Reporting                                                           */
/* ------------------------------------------------------------------ */

function pad(s, n) { return String(s).padEnd(n); }
function padL(s, n) { return String(s).padStart(n); }

function printSummary(report) {
  const meta = report.meta ?? {};
  console.log('');
  console.log('AETHER NEXUS - station placement audit');
  console.log('='.repeat(78));
  console.log(`world ${meta.world}   audit ${meta.version}   ${meta.elapsedMs} ms`);
  console.log(
    `drawn meshes ${meta.drawnMeshes}   colliders ${meta.colliders}   ` +
    `audited props ${meta.auditedProps}`
  );
  console.log('');
  console.log(`${pad('CHECK', 22)}${padL('EXAMINED', 10)}${padL('FINDINGS', 10)}  BY VERDICT`);
  console.log('-'.repeat(78));
  for (const c of report.checks ?? []) {
    const verdicts = Object.entries(c.summary ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    console.log(`${pad(c.name, 22)}${padL(c.examined, 10)}${padL(c.findingCount ?? c.findings.length, 10)}  ${verdicts}`);
    const groups = Object.entries(c.byGroup ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (groups.length) console.log(`${' '.repeat(22)}${padL('', 20)}  by group: ${groups.map(([g, n]) => `${g}=${n}`).join(' ')}`);
  }
  console.log('');
  const skipRows = [];
  for (const c of report.checks ?? []) {
    for (const [reason, n] of Object.entries(c.skipped ?? {})) skipRows.push([c.name, reason, n]);
  }
  if (skipRows.length) {
    console.log('SKIPPED (counted, never silent)');
    console.log('-'.repeat(78));
    for (const [check, reason, n] of skipRows) {
      console.log(`  ${pad(check, 20)} ${pad(reason, 42)} ${padL(n, 8)}`);
    }
    console.log('');
  }
  const worst = report.worst ?? [];
  if (worst.length) {
    console.log('10 WORST FINDINGS (by magnitude)');
    console.log('-'.repeat(78));
    for (const w of worst) {
      console.log(`  ${pad(w.check, 12)} ${pad(w.verdict, 14)} ${padL(w.magnitude.toFixed(3), 9)}  ${w.what}`);
    }
    console.log('');
  }
  if (report.pageErrors?.length) {
    console.log(`PAGE ERRORS (${report.pageErrors.length})`);
    console.log('-'.repeat(78));
    for (const e of report.pageErrors.slice(0, 10)) console.log(`  ${String(e).slice(0, 200)}`);
    console.log('');
  }
}

function printSelfTest(st) {
  console.log('');
  console.log('SELF-TEST - injected defects the instrument must find');
  console.log('='.repeat(78));
  for (const c of st.cases) {
    const mark = c.pass ? 'PASS' : 'FAIL';
    console.log(`  [${mark}] ${pad(c.name, 34)} ${c.detail}`);
  }
  console.log('-'.repeat(78));
  console.log(`  SELF-TEST ${st.pass ? 'PASSED' : 'FAILED'} - ${st.cases.filter((c) => c.pass).length}/${st.cases.length} cases`);
  if (!st.pass) {
    console.log('  The instrument is NOT trustworthy. Every number below is suspect.');
  }
  console.log('');
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = { url: DEFAULT_URL, out: path.join(REPO, 'output', 'station-audit.json'), selftest: false, headless: false, keepOpen: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--out') out.out = path.resolve(argv[++i]);
    else if (a === '--selftest') out.selftest = true;
    else if (a === '--headless') out.headless = true;
    else if (a === '--keep-open') out.keepOpen = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument "${a}"`);
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('usage: node scripts/station-audit.mjs [--url URL] [--out FILE] [--selftest] [--headless]');
    return 0;
  }

  console.log(`[audit] launching chrome at ${opts.url}`);
  const { cdp, kill } = await launchChrome(opts.url, { headless: opts.headless });
  let exitCode = 0;
  try {
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    // The boot gate wants a click; the harness can simply remove it.
    console.log('[audit] waiting for the harness...');
    await evaluate(cdp, `(async () => {
      const t0 = Date.now();
      while (!window.HARNESS) {
        if (Date.now() - t0 > 120000) throw new Error('window.HARNESS never appeared');
        await new Promise((r) => setTimeout(r, 200));
      }
      window.HARNESS.dismissBoot();
      return true;
    })()`);

    const worldId = await evaluate(cdp, `window.HARNESS.ready({ timeoutMs: 180000 })`);
    console.log(`[audit] world "${worldId}" is up`);
    if (worldId !== 'station') {
      await evaluate(cdp, `window.HARNESS.goto('station')`);
    }
    await evaluate(cdp, `(async () => {
      window.HARNESS.setGameplayDriven(true);
      window.HARNESS.freezeAll(true);
      window.HARNESS.hideHud(true);
      return true;
    })()`);

    let selfTest = null;
    if (opts.selftest) {
      console.log('[audit] injecting synthetic defects and self-testing...');
      selfTest = JSON.parse(await evaluate(cdp, `(async () => {
        const m = await import('/game/src/dev/StationAuditSelfTest.js');
        return JSON.stringify(await m.runSelfTest(window.GAME));
      })()`));
      printSelfTest(selfTest);
      if (!selfTest.pass) exitCode = 2;
    }

    console.log('[audit] running the audit...');
    const json = await evaluate(cdp, `(async () => JSON.stringify(await window.HARNESS.auditStation()))()`);
    const report = JSON.parse(json);
    report.pageErrors = await evaluate(cdp, `window.HARNESS.errors.slice(0, 200)`);
    if (selfTest) report.selfTest = selfTest;

    await mkdir(path.dirname(opts.out), { recursive: true });
    await writeFile(opts.out, JSON.stringify(report, null, 2));
    printSummary(report);
    console.log(`[audit] full report -> ${opts.out}`);

    if (report.error) {
      console.error(`[audit] the audit refused: ${report.error}`);
      exitCode = 3;
    } else {
      const total = (report.checks ?? []).reduce((n, c) => n + (c.findingCount ?? c.findings.length), 0);
      if (total > 0) {
        console.log(`[audit] ${total} findings across ${report.checks.length} checks - exiting non-zero`);
        exitCode = exitCode || 1;
      }
    }
  } finally {
    if (!opts.keepOpen) await kill();
    cdp.close();
  }
  return exitCode;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('station-audit.mjs')) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(`[audit] ${err.stack ?? err}`);
    process.exit(4);
  });
}

export { launchChrome, connect, evaluate, parseArgs, printSummary };
