/**
 * THE MAP EDITOR, END TO END.
 *
 *   node site/scripts/map-editor-e2e.mjs [--url http://127.0.0.1:3000] [--world station] [--keep] [--verbose] [--allow-shared-db]
 *   env: MAP_E2E_EMAIL, MAP_E2E_PASSWORD   (an address listed in ADMIN_EMAILS / MARKETPLACE_ADMIN_EMAILS)
 *        MAP_E2E_CODE                       (optional: the current authenticator code, for a 2FA-enabled admin)
 *
 *   The site it drives needs, in site/.env.local or its environment:
 *     POSTGRES_URL   — the report row and the saved version are written there (see below)
 *     HMAC_SECRET    — the save route signs its audit entry and refuses to save without it
 *     ADMIN_EMAILS   — (or MARKETPLACE_ADMIN_EMAILS) listing MAP_E2E_EMAIL; a signed-in
 *                      non-admin reaches the lock banner, not the editor
 *
 * ── Why a browser ────────────────────────────────────────────────────────
 *
 * The site's vitest has no DOM. Every decision in the editor is a pure,
 * tested function, but "an admin can sign in, pick a crate, drag it, read
 * the warning and save" is a claim about a page, and only a page can prove
 * it. This drives real Chrome over the DevTools Protocol against a real
 * `next dev` on a fresh port, through the real sign-in form, the real report
 * route and the real editor. Nothing is mocked.
 *
 * ── A skip is not a pass ─────────────────────────────────────────────────
 *
 * Without credentials there is nothing to measure. The script says so on
 * stderr and exits 2, so a CI step that ran it with no secrets cannot be
 * read as green. (This repository has paid nine times for gates that passed
 * against nothing.)
 *
 * ── It writes to the configured database, and refuses a shared one ───────
 *
 * The report route stores the synthetic layout for `--world` — REPLACING that
 * world's stored objects, bounds, shapes and ground — and Save writes a real
 * overlay version with an audit row, all in whatever POSTGRES_URL the site
 * resolves. A team or production database reached that way by accident keeps
 * the seed until the next admin visit in game. So, before anything is spawned
 * (and after the no-credentials skip, which stays the first check):
 *
 *   - without --url, POSTGRES_URL is read the way the dev server resolves it —
 *     the process environment first (Next never overrides a variable that is
 *     already set), then site/.env.development.local, .env.local,
 *     .env.development, .env, first match wins — and its HOST parsed. A host
 *     that is not loopback (localhost, 127.0.0.1, ::1) refuses with exit 1,
 *     naming the host and the flag, unless --allow-shared-db is passed;
 *   - with --url, the operator chose the server: a note says its database
 *     will be written, and a --url host that is not loopback refuses the same
 *     way. A loopback --url is a server on this machine, most likely started
 *     from this checkout — in EITHER mode: `next dev` loads the development
 *     files, `next start` loads .env.production.local / .env.production
 *     instead, and only .env.local is common to both. So ALL six files
 *     (.env.development.local, .env.production.local, .env.local,
 *     .env.development, .env.production, .env) are scanned, and any one that
 *     defines a POSTGRES_URL on a non-loopback host refuses, naming the file
 *     and the host. A process-environment POSTGRES_URL wins over every file
 *     in both paths: a server started from this shell inherits it, and Next
 *     never overrides a variable that is already set;
 *   - a `${…}` value is Next's env expansion, which this script does not
 *     resolve: it refuses by name, not as "unparseable".
 *
 * Only the host is ever printed: the connection string carries the password.
 * The "seeded layout" step names the host it wrote to when it is known.
 *
 * ── A 2FA account must use --url ─────────────────────────────────────────
 *
 * A TOTP code is accepted for one 30 s step either side of now, and a cold
 * `next dev` can take longer than that to serve /login (the wait here allows
 * 180 s). Starting the server from this script would leave MAP_E2E_CODE dead
 * by the time it is typed. An admin with 2FA enabled runs this with --url
 * against a server that is already up, generating the code just before.
 *
 * ── Zero dependencies, on purpose ────────────────────────────────────────
 *
 * Same reasoning as scripts/hud-viewport-probe.mjs: Node 22 ships a global
 * WebSocket, which is all CDP needs, and a browser-automation library is a
 * second thing to rot. Chromium is Playwright's pinned build if present,
 * else Chrome/Edge.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer as createSocketServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(here, '..');
const root = path.resolve(site, '..');
const outDir = path.join(root, '.probe', 'map-editor-e2e');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const EMAIL = process.env.MAP_E2E_EMAIL;
const PASSWORD = process.env.MAP_E2E_PASSWORD;
if (!EMAIL || !PASSWORD) {
  console.error('SKIPPED (no MAP_E2E_EMAIL/MAP_E2E_PASSWORD) — this is NOT a pass');
  process.exit(2);
}
const CODE = process.env.MAP_E2E_CODE ?? '';

/* ====================================================================== */
/* The database this run would write — refused before anything is spawned */
/* ====================================================================== */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);
const isLoopback = (host) => host != null && LOOPBACK.has(String(host).toLowerCase());

/** One KEY=value from a dotenv file: the first uncommented `key` line, quotes stripped; null when the file or the key is absent. */
function envFileValue(file, key) {
  if (!existsSync(file)) return null;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    if (line.slice(0, eq).trim().replace(/^export\s+/, '') !== key) continue;
    const v = line.slice(eq + 1).trim();
    return /^(["']).*\1$/.test(v) ? v.slice(1, -1) : v;
  }
  return null;
}

/* The dotenv files Next loads, by mode. `next dev` reads DEV_FILES in order,
 * first match wins; `next start` reads .env.production.local, .env.local,
 * .env.production, .env instead — .env.local is common to both, the mode
 * files are not. ALL_FILES is the union, in the order a scan reports them. */
const DEV_FILES = ['.env.development.local', '.env.local', '.env.development', '.env'];
const ALL_FILES = ['.env.development.local', '.env.production.local', '.env.local', '.env.development', '.env.production', '.env'];

/** POSTGRES_URL as `next dev` resolves it, and where it came from. The value is never printed. */
function configuredDatabase() {
  if (process.env.POSTGRES_URL) return { url: process.env.POSTGRES_URL, source: 'the environment' };
  for (const name of DEV_FILES) {
    const url = envFileValue(path.join(site, name), 'POSTGRES_URL');
    if (url) return { url, source: `site/${name}` };
  }
  return { url: null, source: null };
}

/** Every file that defines POSTGRES_URL, in ALL_FILES order — what a server of EITHER mode could be reading. */
function definedDatabases() {
  return ALL_FILES
    .map((name) => ({ url: envFileValue(path.join(site, name), 'POSTGRES_URL'), source: `site/${name}` }))
    .filter((d) => d.url);
}

/** The host of a URL and nothing else of it — the rest of a connection string is the password. */
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^\[(.*)\]$/, '$1') || null;
  } catch {
    return null;
  }
}

/**
 * One connection string's verdict: `{ host, problem }`, `problem` null when the host is
 * loopback, else the line that refuses it. A `${…}` value is Next's env expansion, which
 * this script does not resolve — it is refused by name rather than as "unparseable", so
 * the fix is obvious.
 */
function judge(url, source) {
  if (/\$\{/.test(url)) {
    return { host: null, problem: `POSTGRES_URL in ${source} uses \${…} expansion, which this harness does not resolve — set a literal or pass --allow-shared-db.` };
  }
  const host = hostOf(url);
  if (isLoopback(host)) return { host, problem: null };
  return { host, problem: `${source} names a database on ${host ?? 'a host this script cannot parse'}, which is not loopback.` };
}

const refuse = (lines) => {
  console.error(['REFUSED — nothing was started.', ...lines].join('\n'));
  process.exit(1);
};

const WORLD = arg('--world') ?? 'station';
const TARGET = arg('--url') ?? null;
const ALLOW_SHARED = flag('--allow-shared-db');
const configured = configuredDatabase();
/* The host the seed lands on, for the "seeded layout" step: read from the env
 * files without --url, inferred from them for a loopback --url, unknown for
 * a remote one. */
let dbHost = null;
if (!TARGET) {
  /* Exact for the server THIS script starts, which is `next dev`. */
  if (!configured.url) {
    refuse([
      'no POSTGRES_URL in the environment or in site/.env.development.local, .env.local, .env.development or .env:',
      'the dev server would start, but the report route could store nothing.',
    ]);
  }
  const verdict = judge(configured.url, configured.source);
  dbHost = verdict.host;
  if (verdict.problem && !ALLOW_SHARED) {
    refuse([
      verdict.problem,
      `This harness seeds a synthetic layout for "${WORLD}" there (replacing its stored objects, bounds, shapes and ground),`,
      'saves a real overlay version and appends an audit row.',
      `Point POSTGRES_URL at a local database, or pass --allow-shared-db to write to ${dbHost ?? 'it'} anyway.`,
    ]);
  }
} else {
  const targetHost = hostOf(TARGET);
  console.log(`note: the database behind ${TARGET} will be written — a report row for "${WORLD}", an overlay version and an audit row.`);
  if (!isLoopback(targetHost) && !ALLOW_SHARED) {
    refuse([
      `--url ${TARGET} is not a loopback server (host ${targetHost ?? 'unparseable'}); its database is shared with everyone else who uses it.`,
      'Pass --allow-shared-db to write there anyway.',
    ]);
  }
  if (isLoopback(targetHost)) {
    /* A server on this machine is most likely one started from this checkout,
     * in EITHER mode: `next dev` reads the development files, `next start` the
     * production ones, and only .env.local is common to both. So every file
     * that defines POSTGRES_URL is judged, not the one next dev would pick —
     * unless the environment sets it, which a server started from this shell
     * inherits and Next never overrides. */
    const candidates = process.env.POSTGRES_URL
      ? [{ url: process.env.POSTGRES_URL, source: 'the environment' }]
      : definedDatabases();
    const verdicts = candidates.map((c) => judge(c.url, c.source));
    dbHost = verdicts.find((v) => v.host)?.host ?? null;
    const bad = verdicts.filter((v) => v.problem);
    if (bad.length > 0 && !ALLOW_SHARED) {
      refuse([
        `--url ${TARGET} is a server on this machine, which most likely reads this checkout's env files, and:`,
        ...bad.map((v) => `  ${v.problem}`),
        'A server started from this checkout with next dev reads .env.development.local, .env.local, .env.development, .env;',
        'one started with next start reads .env.production.local, .env.local, .env.production, .env. The seed would land there.',
        'Pass --allow-shared-db if that server is known to write elsewhere, or to write there anyway.',
      ]);
    }
  }
}

/* Set when a child process dies or refuses to start, or the devtools socket
 * drops. Every `waitFor` then throws at once instead of polling out its
 * timeout, so the failure reaches cleanup — which kills the other child and
 * writes report.json — rather than an unhandled 'error' event killing this
 * process with next dev orphaned on its port. */
let abortReason = null;
const childFailed = (what) => (e) => {
  if (!abortReason) abortReason = `${what}: ${e instanceof Error ? e.message : `exit code ${e}`}`;
};

/* The browser window and the emulated viewport are the same size, so the
 * page lays out exactly once. */
const VIEWPORT = { width: 1500, height: 1100 };
/* `mapProjection.createView(bounds, w, h, padPx = 24)`: the inset the map is
 * fitted inside. Used only when the page does not expose its view. */
const VIEW_PAD_PX = 24;
/* The drag: `steps` pointer moves of (dx, dy) px each, released at the sum. */
const DRAG = { steps: 8, dx: 8, dy: 4 };
/* The seeded world: ±100 m in both axes, and two named objects on a flat
 * floor at y = 0. The crate sits 0.4 m up: inside the ±0.25/+1.5 m band, so
 * it starts with no ground warning. */
const BOUNDS = { min: { x: -100, y: -5, z: -100 }, max: { x: 100, y: 60, z: 100 } };
const CRATE = { name: 'e2e:crate', position: { x: 10, y: 0.4, z: -20 } };
const POST = { name: 'e2e:post', position: { x: -30, y: 0, z: 40 } };

/* ====================================================================== */
/* The synthetic layout                                                   */
/* ====================================================================== */

/** Int16 → base64, little-endian: `mapLayout.encodeHeights` across the TS boundary (that one uses DataView/btoa so it also runs in the browser; this is Node only). */
function encodeHeightsCm(int16) {
  const buf = Buffer.alloc(int16.length * 2);
  for (let i = 0; i < int16.length; i++) buf.writeInt16LE(int16[i], i * 2);
  return buf.toString('base64');
}

function syntheticReport() {
  const nx = 51;
  const nz = 51;
  const heights = new Int16Array(nx * nz); // every sample 0 cm: a flat floor at y = 0
  return {
    world: WORLD,
    appliedVersion: 0,
    objects: [CRATE, POST],
    applied: [],
    unresolved: [],
    layoutSchema: 1,
    bounds: BOUNDS,
    shapes: [
      { kind: 'rect', x: 0, z: 0, w: 80, d: 60, fill: 0x2a4a66 },
      { kind: 'circle', x: 40, z: -40, r: 8, stroke: '#52e9ff', width: 0.5 },
    ],
    ground: { originX: -100, originZ: -100, step: 4, nx, nz, layers: 1, heightsCm: encodeHeightsCm(heights) },
  };
}

/* ====================================================================== */
/* Browser discovery (scripts/hud-viewport-probe.mjs)                     */
/* ====================================================================== */

function browserCandidates() {
  const home = os.homedir();
  const out = [];
  if (process.env.CHROME_PATH) out.push(process.env.CHROME_PATH);
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const ms = path.join(local, 'ms-playwright');
    if (existsSync(ms)) {
      for (const dir of ['chromium-1223', 'chromium-1217']) {
        out.push(path.join(ms, dir, 'chrome-win64', 'chrome.exe'));
      }
    }
    out.push(path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    out.push(path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    out.push(path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    out.push(path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    out.push(path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  } else if (process.platform === 'darwin') {
    out.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    out.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    out.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium');
    const ms = path.join(home, '.cache', 'ms-playwright');
    if (existsSync(ms)) {
      for (const dir of ['chromium-1223', 'chromium-1217']) {
        out.push(path.join(ms, dir, 'chrome-linux', 'chrome'));
      }
    }
  }
  return out.filter((p) => existsSync(p));
}

/* ====================================================================== */
/* A CDP client, in about fifty lines                                     */
/* ====================================================================== */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.dead = null;
    this.closing = false;
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      }
    });
    /* A Chrome that dies mid-run takes its socket with it. Every call still
     * in flight is rejected and the run is aborted — otherwise an awaited
     * `send` would never settle and `waitFor`, which only reads its deadline
     * between calls, would hang with next dev still on its port. */
    const died = (why) => {
      if (this.dead) return;
      this.dead = why;
      const waiting = [...this.pending.values()];
      this.pending.clear();
      for (const { reject } of waiting) reject(new Error(why));
      if (!this.closing && !abortReason) abortReason = why;
    };
    this.ws.addEventListener('close', () => died('the devtools connection closed (did Chrome die?)'), { once: true });
    this.ws.addEventListener('error', () => died('the devtools connection errored'), { once: true });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error(`cannot reach ${url}`)), { once: true });
    });
    return new CDP(ws);
  }

  send(method, params = {}, sessionId) {
    if (this.dead) return Promise.reject(new Error(this.dead));
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  close() {
    this.closing = true;
    try { this.ws.close(); } catch { /* already gone */ }
  }
}

/* ====================================================================== */
/* Small helpers                                                          */
/* ====================================================================== */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = createSocketServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, { timeout = 45000, every = 150, what = 'condition' } = {}) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    if (abortReason) throw new Error(abortReason);
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { last = e; }
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

/** Kill a process and everything it spawned (`next dev` forks its server). */
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  }
}

/* ====================================================================== */
/* The dev server                                                         */
/* ====================================================================== */

async function startNext() {
  const port = await freePort();
  /* The bin script through `process.execPath`, not `npx`/`next.cmd`: Node
   * refuses to spawn a `.cmd` without a shell on Windows, and a worktree's
   * junctioned node_modules resolves the same file. */
  const bin = path.join(site, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (!existsSync(bin)) throw new Error(`no next binary at ${bin} — run npm install in site/`);
  const child = spawn(process.execPath, [bin, 'dev', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: site,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BROWSER: 'none' },
    detached: process.platform !== 'win32',
  });
  const log = [];
  const keep = (d) => { log.push(String(d)); if (flag('--verbose')) process.stdout.write(d); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.on('error', childFailed('next dev failed to start'));
  child.on('exit', childFailed('next dev exited'));
  const url = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await fetch(`${url}/login`)).ok, { timeout: 180000, every: 500, what: `next dev at ${url}` })
    .catch((e) => { throw new Error(`${e.message}\n--- next dev output ---\n${log.join('').slice(-4000)}`); });
  return { url, child };
}

/* ====================================================================== */
/* Main                                                                   */
/* ====================================================================== */

async function main() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const report = { base: arg('--url') ?? null, world: WORLD, steps: [], screenshots: [] };
  const reportFile = path.join(outDir, 'report.json');

  const chrome = browserCandidates()[0];
  if (!chrome) {
    report.failure = 'NO BROWSER FOUND — this harness measured nothing. Set CHROME_PATH or install Chrome / Chromium.';
    console.error(report.failure);
    await writeFile(reportFile, JSON.stringify(report, null, 2));
    return 1;
  }
  console.log(`browser: ${chrome}`);

  const pageLog = [];
  const userDir = path.join(os.tmpdir(), `an-map-e2e-${process.pid}`);
  let server = null;
  let browser = null;
  let client;
  const step = (name, detail) => { report.steps.push({ name, detail, at: new Date().toISOString() }); console.log(`  ${name}${detail ? ` — ${detail}` : ''}`); };

  /* One exit path for every ending — success, a thrown assertion, Ctrl+C:
   * both children are killed and the report is written. On macOS/Linux
   * `next dev` is its own process group, so a SIGINT to this process alone
   * would not reach it. */
  /* One promise, shared: the second caller (main's finally, after a signal
   * started the first) waits for the SAME cleanup, rather than returning at
   * once and letting its process.exit pre-empt the report write. */
  let cleanupP = null;
  const cleanup = () => (cleanupP ??= (async () => {
    client?.close();
    browser?.kill();
    if (server) killTree(server.child);
    if (!flag('--keep')) await rm(userDir, { recursive: true, force: true }).catch(() => {});
    await writeFile(reportFile, JSON.stringify(report, null, 2));
  })());
  const onSignal = (sig) => {
    /* The reason first: waitFor exits on it at once, and the catch then
     * reports the signal rather than the socket that closing the client is
     * about to drop. */
    abortReason ??= `interrupted by ${sig}`;
    report.failure ??= abortReason;
    console.error(`\n${sig} — cleaning up`);
    cleanup().finally(() => process.exit(130));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  /* Both children are started INSIDE the try: a Chrome that fails to launch
   * (a stale ms-playwright build, a locked --user-data-dir) must still reach
   * cleanup, which kills next dev and writes the report. */
  try {
    if (!report.base) {
      server = await startNext();
      report.base = server.url;
    }
    const base = report.base.replace(/\/$/, '');
    console.log(`site: ${base}`);

    const cdpPort = await freePort();
    browser = spawn(chrome, [
      '--headless=new',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${userDir}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu',
      '--hide-scrollbars', '--mute-audio', '--disable-extensions',
      '--force-device-scale-factor=1',
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      'about:blank',
    ], { stdio: 'ignore' });
    browser.on('error', childFailed('chrome failed to launch'));
    browser.on('exit', childFailed('chrome exited'));

    const version = await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
      return r.ok ? r.json() : null;
    }, { what: `chrome devtools on ${cdpPort}` });
    client = await CDP.connect(version.webSocketDebuggerUrl);
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    const call = (m, p) => client.send(m, p, sessionId);
    await call('Page.enable');
    await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
    client.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.consoleAPICalled') {
        pageLog.push(`${msg.params.type}: ${(msg.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ')}`);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        pageLog.push(`exception: ${d.exception?.description ?? d.text}`);
      }
    });

    /* ---- page helpers ------------------------------------------------ */
    const evaluate = async (expression, awaitPromise = false) => {
      const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
      if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result?.value;
    };
    const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
    const waitForSelector = (sel, what) => waitFor(() => evaluate(`!!${q(sel)}`), { what: what ?? sel });
    const textOf = (sel) => evaluate(`${q(sel)}?.textContent ?? null`);
    const valueOf = (sel) => evaluate(`${q(sel)}?.value ?? null`);
    const rectOf = (sel) => evaluate(`(() => { const r = ${q(sel)}?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, w: r.width, h: r.height } : null; })()`);
    /* A move carries no button of its own — a drag says `buttons: 1` through `extra`. */
    const mouse = (type, x, y, extra = {}) => call('Input.dispatchMouseEvent', {
      type, x: Math.round(x), y: Math.round(y),
      ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }),
      ...extra,
    });
    const clickSel = async (sel) => {
      await evaluate(`${q(sel)}?.scrollIntoView({ block: 'center' })`);
      const r = await rectOf(sel);
      assert(r, `no element for ${sel}`);
      await mouse('mouseMoved', r.x, r.y);
      await mouse('mousePressed', r.x, r.y);
      await mouse('mouseReleased', r.x, r.y);
    };
    /* Text through Chrome's input pipeline (`Input.insertText`), so React's
     * controlled inputs see a real edit, not a property write. A `secret`
     * is checked by length only: the failure text goes to stdout and
     * report.json, and a password must never be in either. */
    const typeInto = async (sel, text, { secret = false } = {}) => {
      await evaluate(`(() => { const el = ${q(sel)}; el.scrollIntoView({ block: 'center' }); el.focus(); el.select(); })()`);
      await call('Input.insertText', { text });
      const got = await valueOf(sel);
      if (secret) {
        assert(typeof got === 'string' && got.length === text.length,
          `typed ${text.length} characters into ${sel} but it reads ${got === null ? 'null' : `${got.length} characters`}`);
      } else {
        assert(got === text, `typed ${JSON.stringify(text)} into ${sel} but it reads ${JSON.stringify(got)}`);
      }
    };
    /* A <select> has no typed path: set through the native setter and fire
     * the change event React listens for. */
    const choose = async (sel, value) => {
      const got = await evaluate(`(() => { const el = ${q(sel)}; const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('change', { bubbles: true })); return el.value; })()`);
      assert(got === value, `could not choose ${value} in ${sel} (options: ${await evaluate(`[...${q(sel)}.options].map(o => o.value).join(', ')`)})`);
    };
    const shot = async (name) => {
      const s = await call('Page.captureScreenshot', { format: 'png' });
      const file = path.join(outDir, `${name}.png`);
      await writeFile(file, Buffer.from(s.data, 'base64'));
      report.screenshots.push(path.relative(root, file));
    };

    /* ---- 1. sign in through the real form ------------------------------ */
    const loginUrl = `${base}/login?callbackUrl=${encodeURIComponent('/admin/map')}`;
    /* `Page.navigate` reports a connection failure in `errorText` — say so
     * now rather than after the selector wait's 45 s. */
    const nav = await call('Page.navigate', { url: loginUrl });
    if (nav.errorText) throw new Error(`cannot load ${loginUrl}: ${nav.errorText}`);
    await waitForSelector('#email', 'the sign-in form');
    await typeInto('#email', EMAIL);
    await typeInto('#password', PASSWORD, { secret: true });
    /* The shot before the code: `#code` is type="text", and the screenshot
     * is evidence that gets cited. */
    await shot('01-login');
    if (CODE) await typeInto('#code', CODE, { secret: true });
    await clickSel('form.auth-form button[type="submit"]');
    /* The locked render has no <h1> — only `.banner > b` — so wait for EITHER
     * the editor or the lock, and let the assert below name the real problem
     * (a signed-in non-admin) instead of a 90 s timeout. */
    await waitFor(async () => {
      const err = await textOf('.auth-error');
      if (err) {
        abortReason = `sign-in refused: ${err}${CODE ? ' (a TOTP code was supplied; it may have expired — use --url against a running server)' : ''}`;
        return false;
      }
      return evaluate(`location.pathname === '/admin/map' && (!!document.querySelector('h1') || document.body.innerText.includes('Map editor locked'))`);
    }, { what: 'the editor (or the lock banner) after sign-in', timeout: 90000 });
    assert(!(await evaluate(`document.body.innerText.includes('Map editor locked')`)),
      `${EMAIL} signed in but is not an admin (ADMIN_EMAILS / MARKETPLACE_ADMIN_EMAILS)`);
    step('signed in', EMAIL);

    /* ---- 2. seed the layout through the real report route ------------- */
    const body = JSON.stringify(syntheticReport());
    const seeded = await evaluate(`fetch('/api/admin/map/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(body)} }).then(async (r) => ({ status: r.status, text: await r.text() }))`, true);
    assert(seeded.status === 200, `report route answered ${seeded.status}: ${seeded.text}`);
    step('seeded layout', `${WORLD}, ${body.length} bytes, db host ${dbHost ?? `unknown (whatever ${TARGET} is configured with)`}`);

    /* `Page.reload` returns before the navigation; the OLD document keeps
     * answering selectors for a moment, so a world with a prior report would
     * show its stale age and `choose()` would fire on a page being torn down.
     * A new document has a new performance.timeOrigin: wait for that first. */
    const t0 = await evaluate('performance.timeOrigin');
    await call('Page.reload');
    await waitFor(async () => (await evaluate('performance.timeOrigin')) !== t0, { what: 'the reloaded document' });
    const worldSel = '[data-e2e="world-select"]';
    await waitForSelector(worldSel, 'the editor');
    if (WORLD !== 'station') {
      /* The panel's first load (station) disables the select while it is in
       * flight, but a change dispatched from script reaches React anyway and
       * the two loads would race. Wait for the first to land, switch, then
       * wait for the switch's own load. */
      await waitFor(() => evaluate(`!${q(worldSel)}.disabled`), { what: 'the initial load to finish before switching world' });
      await choose(worldSel, WORLD);
      await waitFor(() => evaluate(`(() => { const el = ${q(worldSel)}; return el.value === ${JSON.stringify(WORLD)} && !el.disabled; })()`), { what: `the ${WORLD} load to finish` });
      /* Belt and braces against the commit window: the Save label reads
       * `Saved (vN)` only once the switch's load has fully landed. */
      await waitFor(async () => /^Saved \(v\d+\)$/.test((await textOf('[data-e2e="save"]')) ?? ''), { what: 'the Save button to settle after the world switch' });
    }
    await waitFor(async () => (await textOf('[data-e2e="layout-age"]'))?.startsWith('reported'), { what: 'the layout banner to read "reported …"' });
    const age = await textOf('[data-e2e="layout-age"]');
    assert(age === 'reported just now', `banner reads ${JSON.stringify(age)}`);
    assert((await textOf('[data-e2e="layout-banner"]')).includes('2 shapes'), 'banner counts the two seeded shapes');
    await waitFor(() => evaluate(`[...(${q('[data-e2e="object-select"]')}?.options ?? [])].some(o => o.value === 'o:e2e:crate')`), { what: 'the seeded object in the picker' });
    const saveLabel = await waitFor(async () => { const t = await textOf('[data-e2e="save"]'); return /Saved \(v\d+\)/.test(t ?? '') ? t : null; }, { what: 'the Save button to settle on "Saved (vN)"' });
    const versionBefore = Number(/Saved \(v(\d+)\)/.exec(saveLabel ?? '')?.[1] ?? NaN);
    assert(Number.isInteger(versionBefore), `save button reads ${JSON.stringify(saveLabel)}, expected "Saved (vN)"`);
    await shot('02-editor');
    step('editor loaded', `${age}; version ${versionBefore}`);

    /* ---- 3. click the footprint, deselect, then the dropdown ----------- */
    const canvas = await rectOf('[data-e2e="map-canvas"]');
    assert(canvas, 'the map canvas is on the page');
    let view = await evaluate('window.__mapView ?? null');
    if (!view) {
      /* Production strips __mapView. Reproduce createView(BOUNDS, w, h,
       * VIEW_PAD_PX) for an UNTOUCHED view, from the same bounds we seeded.
       * Its clampScale (0.02–400 px/m) is not reproduced: at ~2.4 px/m the
       * clamp is nowhere near. */
      const ex = BOUNDS.max.x - BOUNDS.min.x;
      const ez = BOUNDS.max.z - BOUNDS.min.z;
      const scale = Math.min((canvas.w - 2 * VIEW_PAD_PX) / ex, (canvas.h - 2 * VIEW_PAD_PX) / ez);
      const cx = (BOUNDS.min.x + BOUNDS.max.x) / 2;
      const cz = (BOUNDS.min.z + BOUNDS.max.z) / 2;
      view = { scale, ox: canvas.w / 2 - cx * scale, oy: canvas.h / 2 - cz * scale };
      step('note', 'no window.__mapView (production build) — projecting with createView maths');
    }
    /* World (x, z) → page pixel, the canvas's own convention: sx = ox + x·scale, sy = oy + z·scale. */
    const at = (x, z) => ({ x: canvas.left + view.ox + x * view.scale, y: canvas.top + view.oy + z * view.scale });
    const click = async (p) => {
      await mouse('mouseMoved', p.x, p.y);
      await mouse('mousePressed', p.x, p.y);
      await mouse('mouseReleased', p.x, p.y);
    };
    const crate = at(CRATE.position.x, CRATE.position.z);
    await click(crate);
    await waitFor(async () => (await textOf('[data-e2e="sel-name"]'))?.includes('e2e:crate'), { what: 'a click on the footprint to select e2e:crate' });
    await shot('03-clicked');
    step('clicked', 'e2e:crate selected from the canvas');
    await click(at(-80, 80)); // inside the bounds, nothing there, no item armed → deselect
    await waitFor(async () => (await textOf('[data-e2e="sel-name"]'))?.includes('Nothing selected'), { what: 'a click on empty ground to deselect' });
    await choose('[data-e2e="object-select"]', 'o:e2e:crate');
    await waitFor(async () => (await textOf('[data-e2e="sel-name"]'))?.includes('e2e:crate'), { what: 'the selection panel to show e2e:crate' });
    assert((await valueOf('[data-e2e="sel-x"]')) === '10', 'X shows the reported 10');
    assert((await valueOf('[data-e2e="sel-z"]')) === '-20', 'Z shows the reported -20');
    await shot('04-selected');
    step('selected', 'e2e:crate via the dropdown');

    /* ---- 4. drag on the canvas ----------------------------------------- */
    const sx = crate.x;
    const sy = crate.y;
    const dragPx = { x: DRAG.steps * DRAG.dx, y: DRAG.steps * DRAG.dy };
    await mouse('mouseMoved', sx, sy);
    await mouse('mousePressed', sx, sy);
    for (let i = 1; i <= DRAG.steps; i++) await mouse('mouseMoved', sx + i * DRAG.dx, sy + i * DRAG.dy, { buttons: 1 });
    await mouse('mouseReleased', sx + dragPx.x, sy + dragPx.y);
    await waitFor(() => evaluate(`[...document.querySelectorAll('[data-e2e="pending-row"]')].some(li => li.textContent.includes('e2e:crate'))`), { what: 'a pending row for e2e:crate' });
    const rowText = await evaluate(`[...document.querySelectorAll('[data-e2e="pending-row"]')].find(li => li.textContent.includes('e2e:crate')).textContent`);
    assert(rowText.includes('→ ('), `row reads ${JSON.stringify(rowText)}`);
    const draggedX = Number(await valueOf('[data-e2e="sel-x"]'));
    const expectedX = CRATE.position.x + dragPx.x / view.scale;
    assert(Math.abs(draggedX - expectedX) < 0.5, `drag moved X to ${draggedX}, expected ≈ ${expectedX.toFixed(2)}`);
    await shot('05-dragged');
    step('dragged', `row: ${rowText.trim()}`);

    /* ---- 5. type Y below the floor → underground ----------------------- */
    await typeInto('[data-e2e="sel-y"]', '-3');
    await clickSel('[data-e2e="move-here"]');
    await waitFor(() => evaluate(`(${q('[data-e2e="sel-conflicts"]')}?.textContent ?? '').includes('underground')`), { what: 'an underground warning in the selection panel' });
    const status = await evaluate(`[...document.querySelectorAll('[data-e2e="pending-row"]')].find(li => li.textContent.includes('e2e:crate')).querySelector('[data-e2e="pending-status"]').textContent`);
    assert(status.includes('underground'), `pending row status reads ${JSON.stringify(status)}`);
    /* Not a synchronous assert: Save reads `Checking…` (disabled) until the
     * deferred conflict pass catches up; a warning must leave it ENABLED once it has. */
    await waitFor(() => evaluate(`!${q('[data-e2e="save"]')}.disabled`), { what: 'Save to be enabled — a warning is not an error' });
    await shot('06-underground');
    step('underground warned', status.trim());

    /* ---- 6. fix Y, save, version increments ---------------------------- */
    await typeInto('[data-e2e="sel-y"]', '0.4');
    await clickSel('[data-e2e="move-here"]');
    await waitFor(() => evaluate(`!(${q('[data-e2e="sel-conflicts"]')}?.textContent ?? '').includes('underground')`), { what: 'the warning to clear' });
    await waitFor(() => evaluate(`!${q('[data-e2e="save"]')}.disabled`), { what: 'Save to be enabled after the conflict pass' });
    await clickSel('[data-e2e="save"]');
    /* A refused save (a 400, a missing HMAC_SECRET) puts its reason in the
     * same live region: abort with it, as the sign-in wait does, rather than
     * poll out 60 s. */
    const msg = await waitFor(async () => {
      const m = await textOf('[data-e2e="message"]');
      if (m?.startsWith('Saved version')) return m;
      if (m) { abortReason = `save refused: ${m}`; return false; }
      return null;
    }, { what: 'the save message', timeout: 60000 });
    const savedVersion = Number(/Saved version (\d+)/.exec(msg)[1]);
    assert(savedVersion === versionBefore + 1, `saved version ${savedVersion}, expected ${versionBefore + 1}`);
    await waitFor(async () => (await textOf('[data-e2e="save"]')) === `Saved (v${savedVersion})`, { what: 'the save button to show the new version' });
    assert(await evaluate(`[...document.querySelectorAll('[data-e2e="version-row"]')].some(r => r.textContent.includes('v${savedVersion}'))`), 'the version list shows the new version');
    await shot('07-saved');
    step('saved', msg);
  } catch (e) {
    report.failure ??= abortReason ?? e.message;
    report.pageConsole = pageLog;
    console.error(`\nFAILED: ${report.failure}\n--- page console ---\n${pageLog.join('\n') || '(silent)'}`);
  } finally {
    await cleanup();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  if (report.failure) {
    console.error(`screenshots + report: ${path.relative(root, outDir)}`);
    return 1;
  }
  console.log(`\nMAP EDITOR E2E OK — ${report.steps.length} steps, ${report.screenshots.length} screenshots in ${path.relative(root, outDir)}`);
  return 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
