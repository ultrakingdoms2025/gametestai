/**
 * THE FRAME-GAP GATE.
 *
 *   node scripts/frame-gaps.mjs --out .probe/gaps/base
 *   node scripts/frame-gaps.mjs --worlds medieval,citadel --out .probe/gaps/x
 *   node scripts/frame-gaps.mjs --serve dev            # NOT the gate; see below
 *
 * ── What it measures ──────────────────────────────────────────────────────
 *
 * Phase 1's acceptance criterion is "in PRODUCTION, no frame gap over 250 ms
 * on first mount launch, first weapon change per world, world entry, first
 * keybind use, or repeated entry/exit. Measured, not felt."
 *
 * A frame gap is the wall-clock distance between two consecutive
 * `requestAnimationFrame` callbacks. That is deliberately not "engine CPU
 * time": a stall inside a driver's `linkProgram`, a synchronous texture
 * upload, or a world build running in an idle callback are all invisible to
 * the engine's own timer and all of them are exactly what the player feels.
 * The recorder is installed with `Page.addScriptToEvaluateOnNewDocument`, so
 * it is running before the first module of the bundle is parsed and the boot
 * is inside its measurement rather than beside it.
 *
 * Every gap over `--floor` (default 24 ms) is kept whole, tagged with the
 * PHASE that was open when it landed, and carries the deltas that explain it:
 * shader programs linked, geometries uploaded, textures uploaded. That triple
 * is the attribution this repository has repeatedly needed and repeatedly
 * had to re-derive - "a 1,275 ms frame that created +8 programs and +219
 * geometries" is the shape of an answer; "the frame was slow" is not.
 *
 * ── Production, and why that word is load-bearing ─────────────────────────
 *
 * `--serve prod` (the default) runs `vite build` and serves `dist/` over a
 * static file server at the site's own `/game/` base. Those are byte-for-byte
 * the hashed assets the live site serves. `--serve dev` runs the Vite dev
 * server instead: unminified, unbundled, hundreds of module requests. It is
 * useful for attribution because the function names survive; its NUMBERS DO
 * NOT SATISFY THE CRITERION and every report this script writes records which
 * one produced it, under `serve`, so a dev number can never be quoted as a
 * production one by accident.
 *
 * ── The noise floor ───────────────────────────────────────────────────────
 *
 * `--repeat n` runs the whole thing n times into `run-1.json`..`run-n.json`
 * and prints the spread. A single run of a frame-gap measurement is a sample
 * of one from a distribution with a long tail, and this repository has
 * mistaken instrument noise for a real delta at least twice. Establish the
 * floor before attributing anything to a change.
 *
 * Output: `<out>/run-<n>.json` per run plus `<out>/summary.json`.
 */

import { spawn } from 'node:child_process';
import { createServer as createSocketServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------------------------------------------------------- */
/* Arguments                                                         */
/* ---------------------------------------------------------------- */

function parseArgs(argv) {
  const out = {
    serve: 'prod', worlds: null, out: null, floor: 24, budget: 250,
    width: 1600, height: 900, repeat: 1, keep: false, help: false,
    entryWorld: 'station', settleMs: 240000, skipBuild: false,
    profile: null, events: 'keybind,weapon,mount,entry,repeat',
    warmWait: 0, awaitReady: true, settleAfterReady: 8000, envWarm: false, envWarmSoak: 30000, cacheKeys: false,
    gl: false, listeners: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--serve') out.serve = next();
    else if (a === '--worlds') out.worlds = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--out') out.out = next();
    else if (a === '--floor') out.floor = Number(next());
    else if (a === '--budget') out.budget = Number(next());
    else if (a === '--width') out.width = Number(next());
    else if (a === '--height') out.height = Number(next());
    else if (a === '--repeat') out.repeat = Number(next());
    else if (a === '--entry') out.entryWorld = next();
    else if (a === '--events') out.events = next();
    else if (a === '--warm-wait') out.warmWait = Number(next());
    else if (a === '--cold') out.awaitReady = false;
    else if (a === '--profile') out.profile = next();
    else if (a === '--env-warm') out.envWarm = true;
    else if (a === '--env-warm-soak') out.envWarmSoak = Number(next());
    else if (a === '--cache-keys') out.cacheKeys = true;
    else if (a === '--gl') out.gl = true;
    else if (a === '--listeners') out.listeners = true;
    else if (a === '--skip-build') out.skipBuild = true;
    else if (a === '--keep') out.keep = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  out.out ??= path.join('.probe', 'frame-gaps');
  return out;
}

const HELP = `frame-gaps - the Phase 1 frame-gap criterion, measured

  --serve prod|dev   prod (default) builds and serves dist/; dev runs Vite.
                     ONLY prod numbers satisfy the criterion.
  --worlds a,b,c     worlds to enter (default: every registered world)
  --entry <id>       world the session boots into (default: station)
  --events <list>    subset of keybind,weapon,mount,entry,repeat
  --warm-wait <ms>   with --cold: idle this long after boot before measuring
  --cold             do NOT wait for the background world chain to finish.
                     What a player who does not wait actually gets.
  --profile background|entry|repeat   CPU-sample the background world chain,
                     the first world entry, or one repeated crossing pair, and
                     fold the samples into a self-time table. Use with
                     --serve dev, where names survive.
  --gl               time every WebGL call that can block and charge each frame
                     gap to the driver entry points it was spent inside. Works
                     on the PRODUCTION bundle - a driver entry point keeps its
                     name where a minified JS function does not. Off by default:
                     the criterion is measured without it.
  --listeners        time every \`world:changed\` listener across the crossings
                     and report each one's total, with the source of the
                     handler. Property names survive minification, so a
                     minified arrow still reads \`(e)=>this._onWorld(...)\`.
  --out <dir>        output directory (default: .probe/frame-gaps)
  --floor <ms>       keep every frame gap at least this long (default 24)
  --budget <ms>      the criterion (default 250)
  --repeat <n>       run n times, and report the spread
  --skip-build       reuse an existing dist/
  --keep             leave the chrome profile behind
`;

/* ---------------------------------------------------------------- */
/* Browser discovery - same candidate list as world-shot / hud probe */
/* ---------------------------------------------------------------- */

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

/* ---------------------------------------------------------------- */
/* CDP                                                               */
/* ---------------------------------------------------------------- */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error(`cannot reach ${url}`)), { once: true });
    });
    return new CDP(ws);
  }

  on(fn) { this.listeners.add(fn); }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

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

async function waitFor(fn, { timeout = 120000, every = 250, what = 'condition' } = {}) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { last = e; }
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

/* ---------------------------------------------------------------- */
/* Serving the PRODUCTION bundle                                     */
/* ---------------------------------------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary',
  '.ktx2': 'image/ktx2', '.bin': 'application/octet-stream',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

/**
 * Serve `dist/` at the site's own `/game/` base.
 *
 * `vite.config.js` sets `base: '/game/'`, so every asset URL inside the built
 * `index.html` is absolute and rooted there. Serving `dist/` at `/` would 404
 * every one of them, and a page that loads nothing measures nothing.
 */
async function serveDist(dir, base) {
  const port = await freePort();
  const prefix = base.endsWith('/') ? base : `${base}/`;
  const server = createHttpServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.startsWith(prefix)) p = p.slice(prefix.length - 1);
      if (p === '/' || p === '') p = '/index.html';
      const file = path.join(dir, p);
      if (!file.startsWith(dir)) { res.writeHead(403).end(); return; }
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { port, close: () => new Promise((r) => server.close(r)) };
}

/* ---------------------------------------------------------------- */
/* The in-page recorder, installed before the bundle is parsed       */
/* ---------------------------------------------------------------- */

/**
 * A WebGL call-timing shim, installed on the prototype before any context
 * exists. Opt-in, because it is not free and the criterion must be measured
 * with the instrument the criterion was written against.
 *
 * ── Why this and not a CPU profile ────────────────────────────────────────
 *
 * A `Profiler.stop()` table on the production bundle reads `pv`, `Bt`, `Hn` -
 * the minifier ate the names, so attribution needs `--serve dev`, and a dev
 * number can never answer a production question. But the interesting work in
 * this project is not JavaScript at all: it is time spent INSIDE a driver
 * entry point, and those keep their names in every build. `bufferData` is
 * `bufferData` in `dist/`.
 *
 * So each wrapped call is timed and charged to its own name, the totals are
 * differenced per rAF gap, and a 14-second frame comes back as a table -
 * "11,900 ms in getProgramParameter over 41 calls, 380 ms in bufferData over
 * 325" - which is an attribution rather than a hint.
 *
 * ── What is wrapped, and what deliberately is not ─────────────────────────
 *
 * Only calls that can plausibly block: link/compile and the queries that WAIT
 * for them, buffer and texture uploads, draws, framebuffer binds and the
 * explicit syncs. `uniform*` and the state setters are thousands per frame and
 * are never the answer; wrapping them would cost more than it could find. Two
 * `performance.now()` per call at roughly 50 ns each, over the ~1,500 wrapped
 * calls a heavy frame makes, is well under a tenth of a millisecond - visible
 * in a 4 ms budget, invisible in a 250 ms one.
 */
const GL_SHIM = `(() => {
  const NAMES = [
    'linkProgram', 'compileShader', 'shaderSource', 'attachShader',
    'getProgramParameter', 'getProgramInfoLog', 'getShaderParameter',
    'getShaderInfoLog', 'useProgram', 'createProgram', 'deleteProgram',
    'bufferData', 'bufferSubData', 'bindVertexArray', 'createVertexArray',
    'vertexAttribPointer', 'texImage2D', 'texImage3D', 'texSubImage2D',
    'texStorage2D', 'compressedTexImage2D', 'generateMipmap',
    'drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced',
    'bindFramebuffer', 'framebufferTexture2D', 'blitFramebuffer',
    'checkFramebufferStatus', 'renderbufferStorageMultisample',
    'readPixels', 'finish', 'flush', 'clientWaitSync', 'fenceSync', 'getError',
  ];
  const T = window.__GL = { ms: {}, n: {} };
  const now = performance.now.bind(performance);
  for (const proto of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
    if (!proto) continue;
    for (const name of NAMES) {
      const orig = proto.prototype[name];
      if (typeof orig !== 'function') continue;
      T.ms[name] = 0; T.n[name] = 0;
      proto.prototype[name] = function (...args) {
        const t0 = now();
        try { return orig.apply(this, args); }
        finally { T.ms[name] += now() - t0; T.n[name]++; }
      };
    }
  }
  /** Everything since \`prev\`, as a sorted table, milliseconds rounded. */
  T.since = (prev) => {
    const rows = [];
    for (const k in T.ms) {
      const ms = T.ms[k] - (prev.ms[k] ?? 0);
      const n = T.n[k] - (prev.n[k] ?? 0);
      if (ms >= 1 || n > 0) rows.push([k, Math.round(ms), n]);
    }
    return rows.sort((a, b) => b[1] - a[1]);
  };
  T.snap = () => ({ ms: { ...T.ms }, n: { ...T.n } });
})()`;

const RECORDER = `(() => {
  if (window.__FG) return;
  const F = window.__FG = {
    phase: 'load', phaseStart: 0, gaps: [], phases: {}, marks: [], errors: [],
    log: [], floor: 24,
    mark(name) {
      const t = performance.now();
      F.marks.push({ name, t: Math.round(t) });
      F.phase = name; F.phaseStart = t;
      F.phases[name] ??= { frames: 0, ms: 0, worst: 0, over: 0, p0: null, g0: null, x0: null };
      const i = F.info();
      const p = F.phases[name];
      if (p.p0 == null) { p.p0 = i.p; p.g0 = i.g; p.x0 = i.x; }
      /* Kept beside the phase rather than on it: a snapshot is ~70 numbers and
       * every phase is serialised into the report. */
      if (window.__GL && !F.gl0[name]) F.gl0[name] = window.__GL.snap();
      return t;
    },
    /** Per-phase GL baselines, by phase name. Empty without --gl. */
    gl0: {},
    info() {
      const n = window.GAME?.engine?.renderer?.info;
      return { p: n?.programs?.length ?? -1, g: n?.memory?.geometries ?? -1, x: n?.memory?.textures ?? -1 };
    },
    /** Everything since a phase opened, so a caller can close its own books. */
    close(name) {
      const p = F.phases[name];
      if (!p) return null;
      const i = F.info();
      p.dPrograms = i.p - p.p0; p.dGeometries = i.g - p.g0; p.dTextures = i.x - p.x0;
      if (window.__GL && F.gl0[name]) p.gl = window.__GL.since(F.gl0[name]).slice(0, 12);
      return p;
    },
  };
  /* IS THE MAIN THREAD BLOCKED, OR IS THE FRAME JUST NOT COMING?
   *
   * The two are indistinguishable in an rAF gap and they have opposite fixes.
   * A 4 ms timer chain runs on the same main thread but is NOT gated on the
   * compositor, so during a gap it either keeps ticking - the thread is free
   * and the frame is stuck behind the GPU or the presenter - or it stops with
   * the frames, and the thread is the problem. "beats" on a gap is how many
   * times the timer fired inside it; "blockedMs" is the longest single stretch
   * the TIMER lost, which is real synchronous JavaScript and nothing else. */
  let beat = performance.now();
  let beats = 0;
  let worstBeat = 0;
  setInterval(() => {
    const t = performance.now();
    const d = t - beat;
    beat = t;
    beats++;
    if (d > worstBeat) worstBeat = d;
  }, 4);

  let last = performance.now();
  let prev = F.info();
  /* The GL shim's totals as of the last frame. Present only with --gl; the
   * gate's own runs carry no gl field at all, so a number measured with the
   * shim can never be quoted as one measured without it. */
  let prevGl = window.__GL ? window.__GL.snap() : null;
  /* THE PHASE A GAP BELONGS TO IS THE ONE OPEN WHEN IT STARTED.
   *
   * Not the one open when the frame finally lands. A driver stall blocks the
   * main thread, so every task queued behind it - INCLUDING the CDP eval that
   * opens the next phase - runs the instant it lets go, and runs BEFORE the
   * animation frame does. Attributing by the landing phase therefore charges
   * every long stall to whatever the harness asked for next, which is exactly
   * backwards and would have this script reporting a background world build as
   * the cost of pressing a key. */
  let lastPhase = F.phase;
  function tick(t) {
    const dt = t - last;
    last = t;
    const now = F.info();
    const owner = lastPhase;
    lastPhase = F.phase;
    const gapBeats = beats; const gapBlocked = worstBeat;
    beats = 0; worstBeat = 0;
    const p = F.phases[owner] ??= { frames: 0, ms: 0, worst: 0, over: 0, p0: now.p, g0: now.g, x0: now.x };
    p.frames++; p.ms += dt;
    if (dt > p.worst) p.worst = Math.round(dt * 10) / 10;
    if (dt > 250) p.over++;
    const glNow = window.__GL ? window.__GL.snap() : null;
    if (dt >= F.floor) {
      F.gaps.push({
        at: Math.round(t), ms: Math.round(dt * 10) / 10, phase: owner,
        dPrograms: now.p - prev.p, dGeometries: now.g - prev.g, dTextures: now.x - prev.x,
        programs: now.p,
        /* How much of the gap was synchronous JavaScript. The rest is a frame
         * that did not arrive while the thread had nothing to do. */
        blockedMs: Math.round(gapBlocked), beats: gapBeats,
        hidden: document.hidden,
        /* Which driver entry points the gap was spent inside, if --gl. Only
         * rows worth a millisecond survive, most gaps carry two or three. */
        ...(glNow ? { gl: window.__GL.since(prevGl).filter((r) => r[1] >= 1).slice(0, 8) } : {}),
      });
      if (F.gaps.length > 8000) F.gaps.splice(0, 2000);
    }
    prevGl = glNow;
    prev = now;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  window.addEventListener('error', (e) => F.errors.push(String(e.message)));
  /* The game's own boot log, on the same clock as the gaps. Its
   * \`[World] built "x" in Nms\` and \`[warm] "x" precompiled\` lines are the
   * only thing that says WHICH world a background stall belonged to. */
  for (const level of ['info', 'log', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...a) => {
      try {
        const s = a.map((v) => (typeof v === 'string' ? v : '')).join(' ');
        if (s.startsWith('[')) F.log.push({ t: Math.round(performance.now()), level, text: s.slice(0, 300) });
      } catch { /* logging must never break the page */ }
      orig(...a);
    };
  }
})()`;

/* ---------------------------------------------------------------- */
/* Key events                                                        */
/* ---------------------------------------------------------------- */

const VK = {
  Digit1: [49, '1'], Digit2: [50, '2'], Digit3: [51, '3'], Digit4: [52, '4'],
  KeyM: [77, 'm'], KeyE: [69, 'e'], KeyR: [82, 'r'], KeyF: [70, 'f'],
  KeyV: [86, 'v'], KeyW: [87, 'w'], KeyC: [67, 'c'], Space: [32, ' '],
};

function keyEvents(code) {
  const [vk, key] = VK[code] ?? [0, ''];
  const common = { windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, code, key };
  return [
    { type: 'keyDown', ...common, text: key },
    { type: 'keyUp', ...common },
  ];
}

/* ---------------------------------------------------------------- */
/* One run                                                           */
/* ---------------------------------------------------------------- */

async function runOnce(args, pageUrl, runIndex) {
  const chrome = browserCandidates()[0];
  const cdpPort = await freePort();
  const userDir = path.join(os.tmpdir(), `an-frame-gaps-${process.pid}-${runIndex}`);
  const browser = spawn(chrome, [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDir}`,
    '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--mute-audio', '--disable-extensions',
    '--force-device-scale-factor=1',
    ...(process.env.FRAME_GAPS_GL === 'swiftshader'
      ? ['--use-angle=swiftshader']
      : ['--use-angle=default', '--enable-gpu-rasterization', '--ignore-gpu-blocklist']),
    '--enable-unsafe-swiftshader',
    `--window-size=${args.width},${args.height}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  browser.stderr.on('data', () => { /* chrome is noisy */ });

  const out = {
    run: runIndex, serve: args.serve, url: pageUrl, browser: chrome,
    at: new Date().toISOString(), budget: args.budget,
    console: [], events: {}, gaps: [], phases: {}, marks: [], notes: [],
  };
  let client;
  try {
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
    await call('Emulation.setDeviceMetricsOverride', {
      width: args.width, height: args.height, deviceScaleFactor: 1, mobile: false,
    });
    client.on((msg) => {
      if (msg.method !== 'Runtime.consoleAPICalled') return;
      const text = (msg.params.args ?? [])
        .map((a) => a.value ?? a.description ?? '').join(' ');
      if (/^\[(boot|prewarm|rehearse|warm|recover|portal)/.test(text) || msg.params.type === 'error') {
        out.console.push({ t: Math.round(msg.params.timestamp), type: msg.params.type, text: text.slice(0, 400) });
      }
    });

    // The shim first: it patches the context prototype, and it has to be in
    // place before the page can create a context, not merely before the
    // recorder's first frame.
    if (args.gl) await call('Page.addScriptToEvaluateOnNewDocument', { source: GL_SHIM });
    await call('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER });
    await call('Page.navigate', { url: pageUrl });

    const evalIn = async (expr, awaitPromise = true) => {
      const r = await call('Runtime.evaluate', {
        expression: expr, awaitPromise, returnByValue: true,
        allowUnsafeEvalBlockedByCSP: true,
      });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      }
      return r.result.value;
    };
    const mark = (name) => evalIn(`window.__FG.mark(${JSON.stringify(name)})`);
    const closePhase = (name) => evalIn(`JSON.stringify(window.__FG.close(${JSON.stringify(name)}))`)
      .then((s) => (s ? JSON.parse(s) : null));

    const press = async (code, gapMs = 90) => {
      for (const ev of keyEvents(code)) {
        await call('Input.dispatchKeyEvent', ev);
        await sleep(gapMs);
      }
    };

    /* --- boot -------------------------------------------------------- */
    await mark('boot');
    await waitFor(() => evalIn('!!window.HARNESS'), { timeout: 300000, what: 'window.HARNESS' });
    await evalIn(`window.HARNESS.settleBoot({ timeoutMs: ${args.settleMs} }).then(() => 1)`);
    await evalIn('window.HARNESS.dismissBoot(), window.HARNESS.setGameplayDriven(true), 1');
    out.warm = await evalIn('JSON.stringify(window.HARNESS.stats().warm)').then((s) => JSON.parse(s));
    out.events.boot = await closePhase('boot');
    out.cacheKeysAfterBoot = args.cacheKeys
      ? JSON.parse(await evalIn('JSON.stringify(window.GAME.engine.renderer.info.programs.map((p) => p.cacheKey))'))
      : null;

    /* --- CPU attribution --------------------------------------------------
     *
     * `--profile background` samples the CPU while the background world chain
     * runs, and folds the samples into a self-time table. It answers the one
     * question the gap deltas cannot: a gap with dPrograms=0, dGeometries=0
     * and dTextures=0 is CPU work that never touched the GPU, and this says
     * WHOSE. Run it with `--serve dev`, where the function names survive; the
     * production bundle is minified and its table reads as `pv`, `Bt`, `Hn`. */
    const profileOn = async () => {
      if (!args.profile) return;
      await call('Profiler.enable');
      await call('Profiler.setSamplingInterval', { interval: 1000 });
      await call('Profiler.start');
    };
    const profileOff = async (label) => {
      if (!args.profile) return;
      const { profile } = await call('Profiler.stop');
      out.profile = { label, serve: args.serve, top: foldProfile(profile) };
    };

    /* --- the background chain --------------------------------------------
     *
     * `settleBoot` returns when the ENTRY world is warm. Every other world is
     * still to be generated, and `scheduleBackgroundBuilds` does that inside
     * the player's frames. Measured on this bundle, that chain alone spends 26
     * s of dead main thread across 85 s, in blocks of 8.1, 6.2 and 5.8 s, with
     * nobody touching a key. Any event measured inside that window is measuring
     * the chain, so this waits it out and says how long it took - and `--cold`
     * skips the wait deliberately, because what the chain does to a player who
     * does not wait is a result too. */
    if (args.awaitReady) {
      await mark('background-chain');
      if (args.profile === 'background') await profileOn();
      const t0 = Date.now();
      await waitFor(() => evalIn(
        'window.GAME.worldManager.ids.every((id) => window.GAME.worldManager.isVolatile(id)'
        + ' || window.GAME.worldManager.isBuilt(id))',
      ), { timeout: 600000, every: 1000, what: 'every world to be built' });
      await sleep(args.settleAfterReady);
      if (args.profile === 'background') await profileOff('background-chain');
      out.events.backgroundChain = await closePhase('background-chain');
      /* WHICH STAGE BUILT WHICH PROGRAMS.
       *
       * The boot warm and the background chain build against different scene
       * state, and only one of the two can be the state a real frame renders
       * in. Snapshotting the cache-key set at the end of each says which
       * signatures each stage is responsible for, and a signature no live
       * frame ever asks for is warm time and GPU memory spent on nothing. */
      out.cacheKeysAfterChain = args.cacheKeys
        ? JSON.parse(await evalIn('JSON.stringify(window.GAME.engine.renderer.info.programs.map((p) => p.cacheKey))'))
        : null;
      out.backgroundChainMs = Date.now() - t0;
      console.log(`background chain finished after ${Math.round(out.backgroundChainMs / 1000)}s`);
    } else if (args.warmWait > 0) {
      await mark('warm-wait');
      await sleep(args.warmWait);
      out.events.warmWait = await closePhase('warm-wait');
    }

    await mark('idle-baseline');
    await sleep(3000);
    out.events.idleBaseline = await closePhase('idle-baseline');

    const wants = new Set(args.events.split(',').map((s) => s.trim()));
    const worlds = args.worlds
      ?? await evalIn('JSON.stringify(window.GAME.worldManager.ids)').then((s) => JSON.parse(s));
    out.worlds = worlds;

    /* --- first keybind use ------------------------------------------- */
    if (wants.has('keybind')) {
      for (const code of ['KeyV', 'KeyR', 'KeyC']) {
        await mark(`keybind:${code}`);
        await press(code);
        await sleep(700);
        out.events[`keybind:${code}`] = await closePhase(`keybind:${code}`);
      }
    }

    /* --- first weapon change ----------------------------------------- */
    if (wants.has('weapon')) {
      await mark('weapon:first');
      await press('Digit2');
      await sleep(1200);
      out.events['weapon:first'] = await closePhase('weapon:first');
      await mark('weapon:rest');
      for (const c of ['Digit3', 'Digit4', 'Digit1']) { await press(c); await sleep(600); }
      out.events['weapon:rest'] = await closePhase('weapon:rest');
    }

    /* --- first mount launch ------------------------------------------ */
    if (wants.has('mount')) {
      await mark('mount:first');
      await press('KeyM');          // open the wheel
      await sleep(250);
      await press('Digit1');        // summon the first mount
      await sleep(2500);
      out.events['mount:first'] = await closePhase('mount:first');
      await mark('mount:dismount');
      await press('KeyF');
      await sleep(1200);
      out.events['mount:dismount'] = await closePhase('mount:dismount');
    }

    /* --- world entry -------------------------------------------------- */
    if (wants.has('entry')) {
      for (const id of worlds) {
        if (id === args.entryWorld) continue;
        const label = `entry:${id}`;
        /* THE PROGRAM CACHE KEY, BEFORE AND AFTER.
         *
         * Three folds `envMap`, `envMapMode`, `envMapCubeUVHeight` and `fog`
         * into every program's cache key. `applyEnvironment` writes all of
         * them on arrival, so a warm taken in the departure world builds
         * programs under one key and the arrival frame asks for another. This
         * records the key's ingredients either side of the crossing, so a
         * table of arrival costs can be read against what actually changed. */
        const KEY = '(() => { const s = window.GAME.engine.scene, e = s.environment;'
          + ' return JSON.stringify({ envMap: !!e, envUuid: e ? e.uuid : null,'
          + ' envHeight: e && e.image ? e.image.height : null, envMapping: e ? e.mapping : null,'
          + ' fog: !!s.fog, fogType: s.fog ? s.fog.type : null,'
          + ' programs: window.GAME.engine.renderer.info.programs.length }); })()';
        const KEYS = 'JSON.stringify(window.GAME.engine.renderer.info.programs.map((p) => p.cacheKey))';
        const pre = JSON.parse(await evalIn(KEY));
        const keysBefore = args.cacheKeys ? JSON.parse(await evalIn(KEYS)) : null;
        pre.built = await evalIn(`!!window.GAME.worldManager.isBuilt(${JSON.stringify(id)})`);
        /* --- THE EXPERIMENT -------------------------------------------
         *
         * `warmWorld` precompiles a destination against the LIVE scene, which
         * is the world the player is standing in. Three folds `scene.fog` and
         * `scene.environment` into its program cache key, and `applyEnvironment`
         * changes both on arrival - so the programs the warm built are keyed to
         * the departure world and the arrival frame asks for a different set.
         *
         * This applies the destination's own fog and environment for the
         * duration of one synchronous compile, restores them, and reports what
         * that compile cost and how many programs it created. If the arrival
         * gap collapses by that amount, the attribution is proved rather than
         * argued. */
        if (args.envWarm) {
          out.events[`envwarm:${id}`] = JSON.parse(await evalIn(`(() => {
            const G = window.GAME, r = G.engine.renderer, sc = G.engine.scene;
            const w = G.worldManager.getWorld(${JSON.stringify(id)});
            if (!w || !w.group) return JSON.stringify({ skipped: 'not built' });
            const env = w.environment;
            const oldFog = sc.fog, oldEnv = sc.environment;
            /* The scene state the ARRIVAL will have, not the one the warm
             * happens to run under. \`_fog\` is the exponential fog a world may
             * install for itself; everything else gets the linear one
             * applyEnvironment authors from fogNear/fogFar. */
            if (w._fog) sc.fog = w._fog;
            else if (env.fogFar > 0) sc.fog = new G.THREE.Fog(env.fogColor.getHex(), env.fogNear, env.fogFar);
            else sc.fog = null;
            if (env.envMap !== undefined) sc.environment = env.envMap;
            const p0 = r.info.programs.length;
            const t0 = performance.now();
            try {
              G.lightRig.claim(w.group);
              r.compile(w.group, G.engine.camera, sc);
              /* The persistent half: the avatar, the viewmodels, the mounts,
               * the gateways and every NPC are drawn on the arrival frame too,
               * and they are keyed on the same fog and environment. */
              r.compile(sc, G.engine.camera, sc);
            } finally { sc.fog = oldFog; sc.environment = oldEnv; }
            return JSON.stringify({
              ms: Math.round(performance.now() - t0),
              dPrograms: r.info.programs.length - p0,
              usedWorldFog: !!w._fog, envHeight: env.envMap && env.envMap.image ? env.envMap.image.height : null,
            });
          })()`));
          /* Issuing the link is not resolving it: three reads LINK_STATUS on
           * first use, and that read is the stall. The background chain issues
           * these a minute before the player arrives, so the experiment has to
           * give the driver the same head start or it measures nothing. */
          await sleep(args.envWarmSoak);
        }

        await mark(label);
        const profiling = args.profile === 'entry' && !out.profile;
        if (profiling) await profileOn();
        await evalIn(`window.HARNESS.goto(${JSON.stringify(id)}).then(() => 1)`);
        await sleep(2500);
        if (profiling) await profileOff(label);
        const phase = await closePhase(label);
        const post = JSON.parse(await evalIn(KEY));
        out.events[label] = { ...phase, builtBefore: pre.built, key: { pre, post } };
        if (args.cacheKeys) {
          const after = JSON.parse(await evalIn(KEYS));
          const had = new Set(keysBefore);
          out.events[label].newCacheKeys = after.filter((k) => !had.has(k));
          out.events[label].oldCacheKeys = keysBefore;
        }

        // First weapon change and first mount launch IN THIS WORLD - the
        // criterion says "per world", so it is measured per world.
        if (wants.has('weapon')) {
          await mark(`weapon:${id}`);
          await press('Digit2'); await sleep(500); await press('Digit1');
          await sleep(900);
          out.events[`weapon:${id}`] = await closePhase(`weapon:${id}`);
        }
        if (wants.has('mount')) {
          await mark(`mount:${id}`);
          await press('KeyM'); await sleep(250); await press('Digit1');
          await sleep(2200);
          await press('KeyF'); await sleep(600);
          out.events[`mount:${id}`] = await closePhase(`mount:${id}`);
        }
      }
    }

    /* --- WHICH LISTENER? ------------------------------------------------
     *
     * `WorldManager.activationCost.changed` is the whole `world:changed`
     * fan-out in one number, and the fan-out is a Set of anonymous closures
     * registered from a dozen modules. This wraps each of them in a timer.
     *
     * A minified arrow keeps its PROPERTY names - esbuild mangles locals, not
     * members - so `({id:e,world:t})=>this._onWorld(e,t)` survives intact and
     * says which subsystem the closure belongs to without a source map.
     *
     * Off by default and never on for the gate: it adds a wrapper frame per
     * listener per crossing, and it defeats `bus.off` for the session. */
    if (args.listeners) {
      await evalIn(`(() => {
        const bus = window.GAME.bus;
        const set = bus._handlers.get('world:changed');
        if (!set) return 0;
        const rows = [];
        const wrapped = new Set();
        for (const fn of set) {
          const row = { ms: 0, calls: 0, src: String(fn).replace(/\s+/g, ' ').slice(0, 140) };
          rows.push(row);
          wrapped.add((payload) => {
            const t = performance.now();
            try { return fn(payload); } finally { row.ms += performance.now() - t; row.calls++; }
          });
        }
        bus._handlers.set('world:changed', wrapped);
        window.__LISTENERS = rows;
        return rows.length;
      })()`);
    }

    /* --- repeated entry/exit ------------------------------------------ */
    if (wants.has('repeat')) {
      const a = args.entryWorld;
      const b = worlds.find((w) => w !== a) ?? 'medieval';
      for (let i = 0; i < 3; i++) {
        const label = `repeat:${i}`;
        await mark(label);
        /* `--profile repeat` samples the SECOND crossing pair, not the first.
         * The first re-entry into a world still pays whatever one-time cost
         * the world's own activation carries; the criterion is about the
         * repeat, and the repeat is what iteration 1 onward measures. */
        const profiling = args.profile === 'repeat' && i === 1;
        if (profiling) await profileOn();
        await evalIn(`window.HARNESS.goto(${JSON.stringify(b)}).then(() => 1)`);
        /* `WorldManager.activationCost` - the crossing broken into its named
         * steps, written by the world manager itself. String labels, so this
         * is readable on the minified bundle where a CPU profile is not. */
        const costTo = await evalIn('JSON.stringify(window.GAME.worldManager.activationCost ?? null)');
        await sleep(900);
        await evalIn(`window.HARNESS.goto(${JSON.stringify(a)}).then(() => 1)`);
        const costBack = await evalIn('JSON.stringify(window.GAME.worldManager.activationCost ?? null)');
        await sleep(900);
        if (profiling) await profileOff(label);
        out.events[label] = await closePhase(label);
        if (out.events[label]) {
          out.events[label].cost = [JSON.parse(costTo), JSON.parse(costBack)];
        }
      }
    }

    if (args.listeners) {
      out.listeners = JSON.parse(await evalIn('JSON.stringify(window.__LISTENERS ?? [])'))
        .filter((r) => r.calls > 0)
        .map((r) => ({ ...r, ms: Math.round(r.ms * 10) / 10 }))
        .sort((x, y) => y.ms - x.ms);
    }

    await mark('done');
    await sleep(500);

    const dump = await evalIn(
      'JSON.stringify({ gaps: window.__FG.gaps, phases: window.__FG.phases, '
      + 'marks: window.__FG.marks, errors: window.__FG.errors, log: window.__FG.log })',
    );
    const parsed = JSON.parse(dump);
    out.gaps = parsed.gaps;
    out.phases = parsed.phases;
    out.marks = parsed.marks;
    out.pageErrors = parsed.errors;
    out.log = parsed.log;
    out.stats = await evalIn('JSON.stringify(window.HARNESS.stats())').then((s) => JSON.parse(s));
  } finally {
    client?.close();
    browser.kill();
  }
  return out;
}

/* ---------------------------------------------------------------- */
/* Reporting                                                         */
/* ---------------------------------------------------------------- */

/**
 * A `Profiler.stop()` result, folded into self time per function.
 *
 * Self time, not total: the question is which code is ON the stack when the
 * clock ticks, and a total-time table answers "which call chain contains the
 * work", which for a build that is one deep call is always the same answer.
 */
function foldProfile(profile, top = 30) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const deltas = profile.timeDeltas ?? [];
  profile.samples.forEach((id, i) => {
    const n = byId.get(id);
    if (!n) return;
    const f = n.callFrame;
    const key = `${f.functionName || '(anonymous)'}  ${(f.url || '').split('/').pop()}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (deltas[i] ?? 0) / 1000);
  });
  return [...self.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, top)
    .map(([fn, ms]) => ({ fn, ms: Math.round(ms) }));
}

function summarise(run, budget) {
  const rows = [];
  for (const [name, p] of Object.entries(run.events)) {
    if (!p) continue;
    rows.push({
      event: name, worst: p.worst ?? 0, over: p.over ?? 0, frames: p.frames ?? 0,
      dPrograms: p.dPrograms ?? 0, dGeometries: p.dGeometries ?? 0, dTextures: p.dTextures ?? 0,
      pass: (p.worst ?? 0) <= budget,
    });
  }
  return rows;
}

function printTable(rows, budget) {
  const w = Math.max(...rows.map((r) => r.event.length), 10);
  console.log(`\n${'event'.padEnd(w)}  ${'worst ms'.padStart(9)} ${'>250'.padStart(5)} ${'dProg'.padStart(6)} ${'dGeom'.padStart(6)} ${'dTex'.padStart(5)}  verdict`);
  console.log('-'.repeat(w + 45));
  for (const r of rows) {
    console.log(
      `${r.event.padEnd(w)}  ${String(r.worst).padStart(9)} ${String(r.over).padStart(5)} `
      + `${String(r.dPrograms).padStart(6)} ${String(r.dGeometries).padStart(6)} ${String(r.dTextures).padStart(5)}  `
      + (r.pass ? 'pass' : `FAIL (>${budget})`),
    );
  }
}

/* ---------------------------------------------------------------- */
/* Main                                                              */
/* ---------------------------------------------------------------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return 0; }
  if (!browserCandidates()[0]) {
    console.error('NO BROWSER FOUND - this harness measured nothing. Set CHROME_PATH.');
    return 1;
  }

  const outDir = path.resolve(root, args.out);
  await mkdir(outDir, { recursive: true });

  let stop = async () => {};
  let pageUrl;
  const qs = `?dev=1&autostart=1&world=${encodeURIComponent(args.entryWorld)}`;

  if (args.serve === 'dev') {
    console.warn('!! --serve dev: these numbers DO NOT satisfy the production criterion.');
    const vitePort = await freePort();
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      root, configFile: path.join(root, 'vite.config.js'), logLevel: 'error',
      server: { port: vitePort, strictPort: true, host: '127.0.0.1' },
    });
    await vite.listen();
    pageUrl = `http://127.0.0.1:${vitePort}${vite.config.base}index.html${qs}`.replace(/([^:])\/\//g, '$1/');
    stop = () => vite.close();
  } else {
    if (!args.skipBuild) {
      console.log('building the production bundle...');
      const { build } = await import('vite');
      await build({ root, configFile: path.join(root, 'vite.config.js'), logLevel: 'error' });
    }
    const dist = path.join(root, 'dist');
    if (!existsSync(path.join(dist, 'index.html'))) {
      console.error(`no built bundle at ${dist} - drop --skip-build`);
      return 1;
    }
    const server = await serveDist(dist, '/game/');
    pageUrl = `http://127.0.0.1:${server.port}/game/index.html${qs}`;
    stop = server.close;
  }

  console.log(`serve=${args.serve}  url=${pageUrl}`);
  const runs = [];
  try {
    await waitFor(async () => (await fetch(pageUrl)).ok, { what: `the server at ${pageUrl}` });
    for (let i = 1; i <= args.repeat; i++) {
      console.log(`\n=== run ${i}/${args.repeat} ===`);
      const run = await runOnce(args, pageUrl, i);
      await writeFile(path.join(outDir, `run-${i}.json`), JSON.stringify(run, null, 2));
      const rows = summarise(run, args.budget);
      printTable(rows, args.budget);
      runs.push({ run: i, rows, warm: run.warm });
    }
  } finally {
    await stop();
  }

  const summary = { serve: args.serve, budget: args.budget, at: new Date().toISOString(), runs };
  await writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\nwrote ${path.join(outDir, 'summary.json')}`);
  return 0;
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
