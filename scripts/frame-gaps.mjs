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
    /* THE WHOLE CRITERION, NOT THE HALF THAT WAS EASY TO DRIVE.
     *
     * This read `keybind,weapon,mount,entry,repeat` while brief 4.1.2 and its
     * acceptance criterion both also name INTERACTIONS and MOVEMENT. A default
     * that silently covers five of seven axes is the failure shape this repo
     * keeps paying for - a gate reporting a pass for ground it never walked. */
    profile: null, events: 'keybind,weapon,mount,interaction,movement,entry,repeat',
    warmWait: 0, awaitReady: true, settleAfterReady: 8000, chainTimeoutMs: 600000, envWarm: false, envWarmSoak: 30000, cacheKeys: false,
    gl: false, listeners: false, frames: false, gate: false,
    layoutSample: false, layoutTimeoutMs: 60000,
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
    else if (a === '--frames') out.frames = true;
    else if (a === '--gate') out.gate = true;
    /* The map editor's ground sampler is admin-only, and this harness has no
     * session. Without the switch every run measures a game in which the
     * sampler never starts - and reads as proof that it costs nothing. */
    else if (a === '--layout-sample') out.layoutSample = true;
    else if (a === '--layout-timeout') out.layoutTimeoutMs = Number(next());
    /* The boot-warm deadline. A default tuned on a machine with a GPU is not a
     * universal constant: the same warm on a shared CI runner with a software
     * rasteriser is several times slower, and a warm that TIMES OUT makes every
     * figure after it a cold one - which the gate correctly fails on and which
     * would then read as a performance regression rather than as too short a
     * fuse. So the fuse is a knob. */
    else if (a === '--settle') out.settleMs = Number(next());
    /* The chain wait had a hardcoded 600000 that NO flag reached - CI passed
     * `--settle 960000`, which raised only the boot deadline, and then died on
     * the chain wait's own ten-minute fuse with nothing to show for it. Same
     * shape as the settle knob's comment above: on swiftshader the chain is
     * slower by an amount nobody has measured yet, and a fuse that cannot be
     * raised turns "slower than my desktop" into a red X. */
    else if (a === '--chain-timeout') out.chainTimeoutMs = Number(next());
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
  --events <list>    subset of keybind,weapon,mount,interaction,movement,entry,repeat
                     (all seven by default). movement WALKS the player for ~9 s
                     per world and reports the metres covered; interaction opens
                     each panel once, last, and reports whether the keyboard
                     came back.
  --gate             compare the run's COUNTERS against the recorded baselines
                     in BASELINES below and exit non-zero on a regression. The
                     clock is printed and never asserted - see the note there.
  --settle <ms>      boot-warm deadline (default 240000). Raise it on a slow or
                     GPU-less machine; a warm that times out makes every figure
                     after it a cold one.
  --chain-timeout <ms>  deadline for the background world chain (default
                     600000). Separate from --settle, which it does NOT
                     inherit; on timeout the run prints which worlds built.
  --warm-wait <ms>   with --cold: idle this long after boot before measuring
  --cold             do NOT wait for the background world chain to finish.
                     What a player who does not wait actually gets.
  --layout-sample    boot with &layout=sample (honoured only beside the dev=1
                     every URL here carries) so the map editor's ground sampler
                     runs on the entry world (admin-only otherwise; a harness has
                     no session). Waited for in its own "layout" phase; summary.json
                     records layoutSampled; with --gate an unfinished sampler fails.
  --layout-timeout <ms>  how long to wait for it (default 60000)
  --profile background|entry|repeat   CPU-sample the background world chain,
                     the first world entry, or one repeated crossing pair, and
                     fold the samples into a self-time table. Use with
                     --serve dev, where names survive.
  --gl               time every WebGL call that can block and charge each frame
                     gap to the driver entry points it was spent inside. Works
                     on the PRODUCTION bundle - a driver entry point keeps its
                     name where a minified JS function does not. Off by default:
                     the criterion is measured without it.
  --frames           break every recorded frame gap into the engine loop's own
                     stages - fixed updaters, frame updaters, the bus flush,
                     and inside the render: scene.updateMatrixWorld, culling,
                     the shadow pass and the draw submission - plus a named
                     row per gameplay subsystem. Property names survive
                     minification, so this reads on the PRODUCTION bundle.
                     Off by default: the criterion is measured without it.
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
    /* A DEAD BROWSER MUST FAIL THIS RUN, NOT HANG IT.
     *
     * `send` parks a promise in `pending` and nothing but a matching reply ever
     * settled it. So when the renderer died - and it does die: a full pass over
     * eighteen worlds WITH movement in each of them exhausted this machine once
     * - the socket closed, every awaited `evalIn` stayed pending forever, and
     * the run sat burning CPU with no browser attached and no output. Measured:
     * twenty minutes of that before it was killed by hand.
     *
     * That is the worst failure mode a gate can have. A CI job would hit its
     * own timeout with nothing written, which reads as flaky infrastructure and
     * gets the job disabled rather than the crash investigated. Rejecting here
     * turns it into one loud error at the point of use, with the count of calls
     * that were in flight when the browser went. */
    const die = (why) => {
      const inflight = this.pending.size;
      this.dead = why;
      for (const { reject } of this.pending.values()) {
        reject(new Error(`the browser went away (${why}); ${inflight} CDP call(s) in flight`));
      }
      this.pending.clear();
    };
    this.ws.addEventListener('close', () => die('socket closed'), { once: true });
    this.ws.addEventListener('error', () => die('socket error'), { once: true });
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
    // Same reasoning as `die` above: a call issued after the socket is already
    // gone must not park a promise nobody will ever settle.
    if (this.dead) return Promise.reject(new Error(`the browser went away (${this.dead})`));
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (err) {
      return Promise.reject(new Error(`CDP send failed: ${err && err.message}`));
    }
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

/**
 * THE FRAME, FROM THE OUTSIDE.
 *
 *   --frames, installed after boot because it needs `window.GAME` and a built
 *   composer. Never on for the gate.
 *
 * The two ledgers before this one drove a station crossing from 1,228 ms of
 * JavaScript to 80, and the frame gap that CARRIES the crossing did not follow
 * it down: with both offending subsystems stubbed out entirely the phase still
 * cost 166.7 ms of which 64 was the crossing. `--gl` charges 1 ms of that to
 * the driver across 2,055 calls, so the residue is neither uploads nor
 * submission. It is CPU work in the frame, and nothing in this script could say
 * WHICH.
 *
 * `--profile` cannot answer it either: on the production bundle the table reads
 * `ya`, `wU`, `mt`, and the profiler inflated a 1,366 ms crossing to 11,450 ms
 * the one time it was pointed at one. What survives minification is PROPERTY
 * names, so this instruments the loop through them:
 *
 *   fixed / frame        the engine's two updater sets, wrapped per member
 *   u:<name>/f:<name>    each gameplay subsystem's own update, by GAME key
 *   busFlush             the deferred event drain
 *   postfx               PostFX.render, and each composer pass by name
 *   r.render             every WebGLRenderer.render, wherever it is called from
 *   r.matrixWorld        `scene.updateMatrixWorld` - the whole graph, per call
 *   r.shadow             `WebGLShadowMap.render`
 *   r.draw / r.shadowDraw  `renderBufferDirect`, split by whether the shadow
 *                        pass is on the stack
 *
 * The rows OVERLAP by construction - `r.matrixWorld` is inside `r.render` is
 * inside `fx.scene` is inside `postfx`, and none of those is inside an updater
 * - and that is the point: culling has no entry point to wrap, so `r.cull*` is
 * read as `r.render - r.matrixWorld - r.shadow - r.draw`. It is the only number
 * in the table that is a subtraction and the only one that can lie: `r.draw`
 * counts the portal previews' draws and `r.render` (main scene only) does not,
 * so on a frame heavy with preview work it under-reports. `x.frustum` is the
 * direct measurement, and it is what the receive-frame finding rests on.
 *
 * The accumulator is drained by the recorder's own rAF callback, which is
 * registered before the bundle is parsed and therefore runs BEFORE the engine
 * loop every frame. So what it drains at frame N is frame N-1's loop, which is
 * exactly the work inside the gap it is closing.
 */

/** One census of the scene graph the renderer walks. --frames only. */
const GRAPH_PROBE = `(() => {
  const S = window.GAME.engine.scene;
  let nodes = 0, meshes = 0, culled = 0, inst = 0, batch = 0, skinned = 0, lights = 0, sprites = 0;
  let instances = 0, noBound = 0;
  S.traverse((o) => {
    nodes++;
    if (o.isLight) lights++;
    if (o.isSprite) sprites++;
    if (!o.isMesh && !o.isLine && !o.isPoints) return;
    meshes++;
    if (o.frustumCulled) culled++;
    if (o.isInstancedMesh) { inst++; instances += o.count; }
    if (o.isBatchedMesh) batch++;
    if (o.isSkinnedMesh) skinned++;
    if (o.geometry && o.geometry.boundingSphere === null) noBound++;
  });
  return JSON.stringify({ nodes, meshes, culled, inst, instances, batch, skinned, lights, sprites, noBound });
})()`;

/**
 * DOES THE BOUND WE HAND THE CULLER STILL CONTAIN THE ONE THREE WOULD COMPUTE?
 *
 * `gfx/SkinBounds.js` gives every character the padded bind-pose sphere its
 * geometry already carries, instead of letting three CPU-skin the body to find
 * one. The risk that buys is the only one worth a gate: a sphere that is too
 * SMALL culls a character that is on screen.
 *
 * So this walks every live `SkinnedMesh` in whatever world is up, computes the
 * sphere three would have computed FOR THE POSE IT IS IN RIGHT NOW, and reports
 * the containment ratio - (distance between centres + the true radius) over the
 * assigned radius. Anything at or under 1 is contained. It is run after the cast
 * has been walking for seconds, not at spawn, because a check at bind pose would
 * pass by construction and prove nothing.
 *
 * three's own method is restored to the mesh afterwards, so nothing downstream
 * sees the probe's value.
 */
const SKIN_CONTAIN = `(() => {
  const S = window.GAME.engine.scene;
  const rows = [];
  let n = 0, assigned = 0, worst = 0, worstName = null;
  S.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    n++;
    const mine = o.boundingSphere;
    if (!mine) return;
    assigned++;
    const keep = mine.clone();
    o.boundingSphere = null;
    o.computeBoundingSphere();
    const truth = o.boundingSphere;
    const ratio = truth && truth.radius >= 0
      ? (keep.center.distanceTo(truth.center) + truth.radius) / keep.radius
      : 0;
    o.boundingSphere = keep;
    if (ratio > worst) { worst = ratio; worstName = o.parent && o.parent.parent ? o.parent.parent.name : o.name; }
    rows.push(Math.round(ratio * 1000) / 1000);
  });
  rows.sort((a, b) => b - a);
  return JSON.stringify({
    world: window.GAME.worldManager.active && window.GAME.worldManager.active.id,
    skinned: n, assigned, worst: Math.round(worst * 1000) / 1000, worstName,
    top: rows.slice(0, 8),
  });
})()`;
const FRAME_SHIM = `(() => {
  if (window.__FR) return 'already';
  const G = window.GAME;
  if (!G || !G.engine) return 'no game';
  const E = G.engine, R = E.renderer, S = E.scene;
  const now = performance.now.bind(performance);
  const A = Object.create(null), N = Object.create(null);
  const add = (k, ms) => { A[k] = (A[k] || 0) + ms; N[k] = (N[k] || 0) + 1; };

  const FR = window.__FR = {
    /** Everything since the last drain, or null if nothing ran. */
    take() {
      let has = false;
      for (const k in A) { has = true; break; }
      if (!has) return null;
      const ms = {}, n = {};
      for (const k in A) { ms[k] = Math.round(A[k] * 100) / 100; n[k] = N[k]; }
      for (const k in A) { delete A[k]; delete N[k]; }
      const inf = R && R.info;
      if (inf) { ms['#calls'] = inf.render.calls; ms['#tris'] = inf.render.triangles; }
      return { ms, n };
    },
  };

  const wrap = (obj, key, label) => {
    if (!obj || typeof obj[key] !== 'function') return false;
    const orig = obj[key];
    if (orig.__fr) return false;
    const w = function () {
      const t = now();
      try { return orig.apply(this, arguments); } finally { add(label, now() - t); }
    };
    w.__fr = 1;
    obj[key] = w;
    return true;
  };
  FR.wrap = wrap;

  /* ---- inside the render ---- */
  let inShadow = 0;
  if (R.shadowMap && typeof R.shadowMap.render === 'function') {
    const sh = R.shadowMap.render;
    R.shadowMap.render = function (a, b, c) {
      const t = now(); inShadow++;
      try { return sh.call(this, a, b, c); } finally { inShadow--; add('r.shadow', now() - t); }
    };
  }
  /* An own property over the prototype method, so the scene's traversal is
   * timed and every other Object3D in the tree is untouched. */
  wrap(S, 'updateMatrixWorld', 'r.matrixWorld');
  if (typeof R.renderBufferDirect === 'function') {
    const rbd = R.renderBufferDirect;
    R.renderBufferDirect = function (a, b, c, d, e, f) {
      const t = now();
      try { return rbd.call(this, a, b, c, d, e, f); }
      finally { add(inShadow ? 'r.shadowDraw' : 'r.draw', now() - t); }
    };
  }
  {
    /* Split by the scene handed in. A portal preview parks a whole destination
     * world in its own scene and draws it, and a frame that does that 26 times
     * is a different animal from one that draws the live scene once. */
    const rr = R.render;
    R.render = function (sc, cam) {
      const t = now();
      try { return rr.call(this, sc, cam); }
      finally { add(sc === S ? 'r.render' : 'r.renderAux', now() - t); }
    };
  }
  wrap(R, 'compile', 'r.compile');

  /* ---- the three.js internals culling actually runs through ----
   *
   * projectObject has no entry point to wrap, but the two things it does per
   * candidate do: the frustum test, and the lazily-computed bound the test
   * needs. A bound that is recomputed once per crossing walks every vertex of
   * the geometry it belongs to, and nothing in the gap deltas would show it. */
  const T = window.GAME.THREE;
  if (T) {
    wrap(T.Frustum.prototype, 'intersectsObject', 'x.frustum');
    wrap(T.BufferGeometry.prototype, 'computeBoundingSphere', 'x.geomBound');
    if (T.InstancedMesh) wrap(T.InstancedMesh.prototype, 'computeBoundingSphere', 'x.instBound');
    if (T.BatchedMesh) {
      wrap(T.BatchedMesh.prototype, 'computeBoundingSphere', 'x.batchBound');
      wrap(T.BatchedMesh.prototype, 'onBeforeRender', 'x.batchCull');
    }
    if (T.SkinnedMesh) wrap(T.SkinnedMesh.prototype, 'computeBoundingSphere', 'x.skinBound');
    if (T.Skeleton) wrap(T.Skeleton.prototype, 'update', 'x.skeleton');
    if (T.SkinnedMesh) wrap(T.SkinnedMesh.prototype, 'updateMatrixWorld', 'x.skinMatrix');
  }

  /* ---- the composer ---- */
  const fx = E.postfx;
  if (fx) {
    wrap(fx, 'render', 'postfx');
    const named = [['renderPass', 'fx.scene'], ['gtaoPass', 'fx.gtao'], ['shaftPass', 'fx.shafts'],
      ['bloomPass', 'fx.bloom'], ['gradePass', 'fx.grade'], ['outputPass', 'fx.output'],
      ['smaaPass', 'fx.smaa'], ['filmPass', 'fx.film']];
    for (let i = 0; i < named.length; i++) wrap(fx[named[i][0]], 'render', named[i][1]);
  }
  wrap(E.bus, 'flush', 'busFlush');

  /* ---- the gameplay subsystems, by the key they hang off GAME ---- */
  const SUBS = ['materials', 'player', 'cameraRig', 'piloting', 'spaceCombat', 'avatar', 'mounts',
    'npcManager', 'projectiles', 'loadout', 'portals', 'combat', 'inventory', 'market', 'caches',
    'contracts', 'relics', 'viewpoints', 'interiors', 'mining', 'objectives', 'minigames',
    'questSystem', 'hud', 'physics', 'loot', 'stamina', 'race', 'itemUse', 'waterVolumes',
    'unstuck', 'mapOverlay', 'ships', 'flightHUD', 'mazeMap', 'audio', 'cosmetics', 'economy'];
  for (let i = 0; i < SUBS.length; i++) {
    const o = G[SUBS[i]];
    if (!o) continue;
    wrap(o, 'update', 'u:' + SUBS[i]);
    wrap(o, 'fixedUpdate', 'f:' + SUBS[i]);
  }

  /* The active world is a different object after every crossing, so its own
   * update has to be re-wrapped when it changes rather than once here. */
  let lastWorld = null;
  const ensureWorld = () => {
    const w = G.worldManager && G.worldManager.active;
    if (w && w !== lastWorld) { lastWorld = w; wrap(w, 'update', 'u:world'); }
  };

  /* ---- the two updater sets ----
   *
   * Replaced by a stand-in rather than repopulated with wrappers: the engine's
   * onFrameUpdate hands back a closure that DELETES the function it was given,
   * and a set full of wrappers would leak every one of those. This delegates
   * add/delete/has to the real Set and wraps only on iteration. */
  const timed = (inner, label) => {
    const seen = new WeakMap();
    const wrapFn = (fn) => {
      let f = seen.get(fn);
      if (!f) {
        f = function (a, b) { const t = now(); try { return fn(a, b); } finally { add(label, now() - t); } };
        seen.set(fn, f);
      }
      return f;
    };
    const o = {
      add(fn) { inner.add(fn); return o; },
      delete(fn) { return inner.delete(fn); },
      has(fn) { return inner.has(fn); },
      clear() { return inner.clear(); },
      forEach(cb, t) { inner.forEach(cb, t); },
    };
    Object.defineProperty(o, 'size', { get: () => inner.size });
    o[Symbol.iterator] = function* () {
      ensureWorld();
      for (const fn of inner) yield wrapFn(fn);
    };
    return o;
  };
  E._fixedUpdaters = timed(E._fixedUpdaters, 'fixed');
  E._frameUpdaters = timed(E._frameUpdaters, 'frame');
  ensureWorld();
  return 'installed';
})()`;

/**
 * THE ONLY HONEST "IS THE BACKGROUND CHAIN FINISHED?" SIGNAL.
 *
 * `scheduleBackgroundBuilds` emits `worlds:all-ready` when its queue empties -
 * after the last world's build, its sliced program warm and its gateway preview
 * warm have all resolved. No predicate over `isBuilt` can reproduce that: a
 * world can be built and still be mid-warm, and a world still QUEUED is neither
 * built nor building during the idle gap between two chain steps.
 *
 * Armed at document start and polled for the bus, because `window.GAME` is
 * published by a module that has not been parsed yet when this runs. It records
 * `armed` separately from `ready` so the caller can tell "the chain has not
 * finished" apart from "nobody is listening", which are the same `false` and
 * mean opposite things.
 */
const CHAIN_LATCH = `(() => {
  const S = window.__FG_CHAIN = { armed: false, ready: false, at: null };
  let tries = 0;
  const arm = () => {
    const bus = window.GAME && window.GAME.bus;
    if (!bus || typeof bus.on !== 'function') {
      // ~5 minutes at 50 ms. A boot slower than that has already failed.
      if (tries++ < 6000) setTimeout(arm, 50);
      return;
    }
    S.armed = true;
    bus.on('worlds:all-ready', () => {
      S.ready = true;
      S.at = Math.round(performance.now());
    });
  };
  arm();
})()`;

/**
 * The ground sampler's own completion signal, latched on the page clock.
 *
 * `map-overlay:layout` is emitted by MapOverlay when the current world's grid
 * has been sampled (systems/MapOverlay.js) - `{ world, cells, layers,
 * sampledMs }`. Stamped with `performance.now()` so it sits on the same clock
 * as `__FG.marks`: whether the sampler finished BEFORE the `layout` phase
 * opened is then a comparison of two timestamps, not a guess from how few
 * frames the phase saw. Armed at document start and polled for the bus,
 * exactly as CHAIN_LATCH is and for the same reason; installed only under
 * --layout-sample, so a run without the flag is the run it was.
 */
const LAYOUT_LATCH = `(() => {
  const S = window.__FG_LAYOUT = { armed: false, event: null };
  let tries = 0;
  const arm = () => {
    const bus = window.GAME && window.GAME.bus;
    if (!bus || typeof bus.on !== 'function') {
      if (tries++ < 6000) setTimeout(arm, 50);
      return;
    }
    S.armed = true;
    bus.on('map-overlay:layout', (e) => {
      S.event = { ...e, t: Math.round(performance.now()) };
    });
  };
  arm();
})()`;

/**
 * `Input.js`'s own `TOUCH_LOOK_GAIN`, copied.
 *
 * `applyLook(dx, dy)` takes CSS PIXELS and multiplies by
 * `CONFIG.player.mouseSensitivity * TOUCH_LOOK_GAIN` to reach the radians
 * `Player.update` subtracts from its yaw. The sensitivity is on `CONFIG` and
 * readable from the page; the gain is a module-private constant and is not. If
 * it drifts the sweep is the wrong size and says so - every movement phase
 * records the yaw it ACHIEVED beside the yaw it asked for.
 */
const TOUCH_LOOK_GAIN = 2.6;

/**
 * A look delta, through the input path the game actually ships for it.
 *
 * NOT `mousemove`. That handler returns at `if (!this._locked ...)` and an
 * automated browser holds no pointer lock, so a dispatched mouse move is
 * swallowed whole - which is one of the ways the 24 Aug playthrough survey came
 * back with numbers 150-680x below the maintained instrument's. `applyLook` is
 * the touch-device entry point: explicitly ungated on the lock, feeding the
 * same `state.lookX` accumulator `consumeLook()` drains, with the same bus
 * event. A finger and this call are indistinguishable downstream.
 *
 * @param {number} rad radians of yaw
 */
const LOOK = (rad) => `(() => {
  const I = window.GAME.input;
  const perPx = window.GAME.CONFIG.player.mouseSensitivity * ${TOUCH_LOOK_GAIN};
  I.applyLook(${rad} / perPx, 0);
  return 1;
})()`;

/**
 * Where the player is, and what is on screen.
 *
 * A movement phase that measures a player who never moved is the failure this
 * repository names as worse than no gate at all: it would report a clean 16 ms
 * worst frame for a world it never traversed a metre of. So every movement
 * phase is bracketed with this, and the report carries the DISTANCE - a phase
 * with `moved: 0` is visible as the non-measurement it is rather than as a pass.
 */
const WHERE = `(() => {
  /* Never throws. An exception here would take the whole run down from inside a
   * CDP eval, and a gate that CRASHES is worse than one that reports: the
   * failure would read as infrastructure and get rerun rather than read. A
   * position of nulls fails the movement invariant loudly instead, which is the
   * same verdict arrived at honestly. */
  try {
    const G = window.GAME, p = G.player, w = G.worldManager.active;
    return JSON.stringify({
      world: w ? w.id : null,
      x: p.position.x, y: p.position.y, z: p.position.z,
      yaw: p.yaw, grounded: !!p.grounded,
      /* WHY a movement phase covered no ground. Without these the gate can say
       * "moved 0 m" and nothing else, which is a defect report with no lead in
       * it - and this instrument produced exactly that for four worlds in a
       * row before they were added. Each one is a different fix: a gameplay
       * block is an overlay nobody closed, "mounted" is a player being carried
       * rather than walking, "textCaptured" is a panel eating the keys, and
       * "dead" is a player who cannot move by the rules. */
      blocks: (G.__dev && G.__dev.gameplayBlocks && G.__dev.gameplayBlocks()) || [],
      mounted: !!(G.mounts && G.mounts.mounted),
      textCaptured: !!(G.input && G.input.textCaptured),
      dead: !!p.dead,
    });
  } catch (err) {
    return JSON.stringify({ world: null, x: null, y: null, z: null, yaw: null, error: String(err && err.message || err) });
  }
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
   * the TIMER lost, which is real synchronous JavaScript and nothing else.
   *
   * ── A GAP WITH beats:0 USED TO REPORT blocked:0 ─────────────────────────
   *
   * worstBeat is only ever written by the timer's own callback, so it can
   * only measure a stretch that ENDED in a beat. A gap the thread was blocked
   * through from end to end fires the timer zero times, leaves worstBeat at
   * its initial 0, and was reported as "blocked 0" - which is the reading a
   * STARVED gap gives and means the exact opposite. Measured on this bundle:
   * "entry:maze 750.1 ms, blocked 0, beats 0, +6 programs, +23 textures", a
   * frame that plainly did six shader links and twenty-three texture uploads.
   *
   * The unmeasured stretch is the one from the last beat to the frame landing,
   * and the "beat" variable holds exactly when that beat was - so the blocked
   * time is
   * the worse of the longest CLOSED stretch and the still-open one. This also
   * fixes the general tail case, where a gap blocks for its last 300 ms and no
   * beat lands to close the stretch out. A genuinely starved gap is unaffected:
   * its heartbeat is still ticking when the frame arrives, so the open stretch
   * is one beat interval wide. */
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
    const gapBeats = beats;
    // See the note on the heartbeat: the open stretch counts too, or a gap the
    // thread never surfaced from reports as the one thing it is not.
    const gapBlocked = Math.max(worstBeat, t - beat);
    beats = 0; worstBeat = 0;
    const p = F.phases[owner] ??= { frames: 0, ms: 0, worst: 0, over: 0, p0: now.p, g0: now.g, x0: now.x };
    p.frames++; p.ms += dt;
    if (dt > p.worst) p.worst = Math.round(dt * 10) / 10;
    if (dt > 250) p.over++;
    const glNow = window.__GL ? window.__GL.snap() : null;
    /* The engine loop stages that ran inside this gap, if --frames. Drained
     * every frame whether the gap is kept or not: the accumulator has to start
     * each frame empty or a 20 ms frame would carry the 200 ms one before it. */
    const parts = window.__FR ? window.__FR.take() : null;
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
        ...(parts ? { parts } : {}),
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

/**
 * `code` -> [virtual key, `KeyboardEvent.key`].
 *
 * BOTH HALVES MATTER, and a missing row is silent. An unknown code used to fall
 * through to `[0, '']`, which still sets `event.code` - so a handler reading
 * `e.code` worked and one reading `e.key` did not. `ChatBox` closes on
 * `e.key === 'Escape'`, so an Escape dispatched from a missing row would open
 * the chat box and never close it, capture the keyboard, and every phase after
 * that would measure a game nobody could type at. The movement and interaction
 * events need eight codes this table did not have.
 */
const VK = {
  Digit1: [49, '1'], Digit2: [50, '2'], Digit3: [51, '3'], Digit4: [52, '4'],
  KeyM: [77, 'm'], KeyE: [69, 'e'], KeyR: [82, 'r'], KeyF: [70, 'f'],
  KeyV: [86, 'v'], KeyW: [87, 'w'], KeyC: [67, 'c'], Space: [32, ' '],
  KeyA: [65, 'a'], KeyS: [83, 's'], KeyD: [68, 'd'],
  KeyI: [73, 'i'], KeyJ: [74, 'j'], KeyT: [84, 't'], KeyB: [66, 'b'],
  ShiftLeft: [16, 'Shift'], Escape: [27, 'Escape'], Enter: [13, 'Enter'],
  ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'],
};

function keyEvents(code) {
  const entry = VK[code];
  if (!entry) {
    /* Loud, not silent. A dispatched key with no virtual key and no `key` is a
     * measurement of nothing, and this script exists because measurements of
     * nothing get quoted as results. */
    throw new Error(`frame-gaps: no VK row for "${code}" - add one, do not dispatch a blank key`);
  }
  const [vk, key] = entry;
  const common = { windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, code, key };
  /* `text` is what a key TYPES. Setting it for Escape or Shift makes Chrome
   * deliver a character event for a key that produces no character, which the
   * chat box would then receive as literal input. */
  const text = key.length === 1 ? key : undefined;
  return [
    { type: text ? 'keyDown' : 'rawKeyDown', ...common, ...(text ? { text } : {}) },
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
    /* AN OCCLUDED WINDOW STOPS DELIVERING ANIMATION FRAMES AND NOTHING ELSE.
     *
     * Windows computes native window occlusion for headless windows too, and a
     * renderer it decides is occluded stops receiving BeginFrame - so
     * `requestAnimationFrame` stops while timers, promises and CDP evals all
     * keep running at full rate. Every gap this script measures is an rAF
     * interval, so an occluded stretch is recorded as one enormous frame gap
     * with an idle main thread inside it.
     *
     * Measured: a 32,517.5 ms gap carrying 8,004 heartbeats of a 4 ms timer -
     * one every 4.06 ms, end to end - and a single 445 ms genuine block inside
     * it. The game's own `dev/Harness.js` watchdog printed "no animation frame
     * for 10000ms - the window is very likely backgrounded or occluded" from
     * inside the same gap. It lands on a different world every run, and one
     * such gap was written into a ledger as "race: 31,284.1 ms, a volatile
     * world rebuilt" - race is not volatile, and its crossing was 442 ms.
     *
     * These four are the standard set; `CalculateNativeWinOcclusion` is the
     * one that matters on this platform. `beats` on every gap is the check
     * that they are still working. */
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-features=CalculateNativeWinOcclusion',
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
    /* `--floor` was documented from the first version of this script and never
     * reached the page: the recorder carried a hard-coded 24 and every run that
     * passed the flag silently got 24 anyway. It is the knob that decides which
     * frames carry a `--frames` breakdown, so it had to start working before any
     * of that could be read. */
    await call('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => { const set = () => { if (window.__FG) window.__FG.floor = ${args.floor};`
        + ` else setTimeout(set, 0); }; set(); })()`,
    });
    await call('Page.addScriptToEvaluateOnNewDocument', { source: CHAIN_LATCH });
    if (args.layoutSample) await call('Page.addScriptToEvaluateOnNewDocument', { source: LAYOUT_LATCH });
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

    /**
     * KEYS HELD DOWN, WHICH IS THE ONLY WAY ANYONE MOVES.
     *
     * `press` is a tap: down, 90 ms, up. Every movement binding in the game is
     * a HELD state - `Input._syncAxes` reads `_keys.has('KeyW')` on each event
     * and the axes stay set until the keyup - so a tap produces about a tenth
     * of a second of walking and measures nothing a player would recognise.
     *
     * The whole set goes down together (W and ShiftLeft are one gesture, not
     * two), the hold is broken into slices so the yaw sweep can be injected
     * between them, and the keyups run in a `finally`: a throw with W still
     * down would leave the player walking through every phase after it.
     *
     * @param {string[]} codes
     * @param {number} ms
     * @param {{ yawPerSec?: number, sliceMs?: number }} [opts] yaw in radians/s
     */
    /* The renderer's own frame counter - increments once per render call, so
     * it is the page's ground truth for "did any frame actually run". */
    const FRAME_NOW = 'window.GAME?.engine?.renderer?.info?.render?.frame ?? 0';

    const hold = async (codes, ms, opts = {}) => {
      const yawPerSec = opts.yawPerSec ?? 0;
      const sliceMs = opts.sliceMs ?? 250;
      /* WALL TIME IS NOT SIMULATED TIME on a starving runner. The enforcing
       * gate's first red (run 32936933304) was `movement:station moved 0 m` -
       * and the same run's watchdog counted five 10 s stretches with no
       * animation frame. The game simulates per frame; a key held for eight
       * wall seconds that happen to sit inside a starvation stretch moves the
       * player exactly nowhere, and whether the hold overlaps a stretch is
       * timing luck - the previous run passed the identical invariant. So a
       * hold can demand a minimum number of RENDERED frames: after the
       * nominal wall time it keeps holding, in slices, until the renderer's
       * frame counter has advanced by `minFrames` or a hard cap of 6x the
       * nominal time is spent. The cap rides through any 10 s stretch with
       * room to spare, so a phase that still measured nothing after it is a
       * page that is genuinely not rendering - which IS worth failing on. */
      const minFrames = opts.minFrames ?? 0;
      const f0 = minFrames ? Number(await evalIn(FRAME_NOW)) : 0;
      for (const code of codes) await call('Input.dispatchKeyEvent', keyEvents(code)[0]);
      let framesDuring = 0;
      try {
        for (let done = 0; done < ms; done += sliceMs) {
          const dt = Math.min(sliceMs, ms - done);
          await sleep(dt);
          if (yawPerSec) await evalIn(LOOK(yawPerSec * (dt / 1000)));
        }
        if (minFrames) {
          const cap = Date.now() + ms * 5; // 6x total, nominal already spent
          framesDuring = Number(await evalIn(FRAME_NOW)) - f0;
          while (framesDuring < minFrames && Date.now() < cap) {
            await sleep(sliceMs);
            if (yawPerSec) await evalIn(LOOK(yawPerSec * (sliceMs / 1000)));
            framesDuring = Number(await evalIn(FRAME_NOW)) - f0;
          }
        }
      } finally {
        for (const code of codes) await call('Input.dispatchKeyEvent', keyEvents(code)[1]);
      }
      return framesDuring;
    };

    /* --- boot -------------------------------------------------------- */
    await mark('boot');
    await waitFor(() => evalIn('!!window.HARNESS'), { timeout: 300000, what: 'window.HARNESS' });
    await evalIn(`window.HARNESS.settleBoot({ timeoutMs: ${args.settleMs} }).then(() => 1)`);
    await evalIn('window.HARNESS.dismissBoot(), window.HARNESS.setGameplayDriven(true), 1');
    out.warm = await evalIn('JSON.stringify(window.HARNESS.stats().warm)').then((s) => JSON.parse(s));
    out.events.boot = await closePhase('boot');
    /* --- layout ------------------------------------------------------ */
    /* Wait for the ground sampler INSIDE the measured window, in a phase of
     * its own: the `layout` row says what its frames cost, every later row
     * says whether it disturbed them. A timeout is recorded, never hidden. */
    if (args.layoutSample) {
      const layoutMarkT = Math.round(Number(await mark('layout')));
      const t0 = Date.now();
      try {
        await waitFor(() => evalIn('window.GAME?.mapOverlay?.layoutSampled === true'),
          { timeout: args.layoutTimeoutMs, every: 500, what: 'the ground sampler to finish the entry world' });
      } catch (err) {
        out.notes.push(`layout sampling did not finish in ${args.layoutTimeoutMs} ms: ${err.message}`);
      }
      out.layoutSampled = await evalIn('window.GAME?.mapOverlay?.layoutSampled === true');
      /* The sampler's own completion event, latched on the page clock by
       * LAYOUT_LATCH: { world, cells, layers, sampledMs, t }. Null when it has
       * not fired, or when the latch never found the bus. */
      out.layoutEvent = JSON.parse(await evalIn('JSON.stringify(window.__FG_LAYOUT?.event ?? null)'));
      /* The world the grid was sampled in. The event names it directly; the
       * overlay's `report.world` is the applied document's, which a stale
       * answer for the world before can overwrite after a portal. */
      out.layoutWorld = out.layoutEvent?.world ?? await evalIn('window.GAME?.mapOverlay?.report?.world ?? null');
      out.layoutWaitMs = Date.now() - t0;
      out.events.layout = await closePhase('layout');
      /* A ROW THAT MEASURED NOTHING MUST SAY SO. The entry world's
       * `world:changed` fires before engine.start(), so on a fast GPU the
       * sampler is done inside `boot`; this phase then spans a few CDP
       * round-trips and its row prints a verdict on no frames. The latch's
       * timestamp and the phase mark are on the same clock, so "finished
       * before the phase opened" is a comparison (an event stamped in the
       * millisecond the phase opened did not happen inside its frames);
       * without the latch, fewer than 30 frames is the floor below which the
       * row cannot have judged anything. */
      const frames = out.events.layout?.frames ?? 0;
      const ev = out.layoutEvent;
      const insideBoot = ev && Number.isFinite(layoutMarkT) ? ev.t <= layoutMarkT : frames < 30;
      if (out.layoutSampled && insideBoot) {
        out.notes.push(`the sampler finished inside boot${ev ? ` (at ${ev.t} ms; the layout phase opened at ${layoutMarkT} ms)` : ''};`
          + ` the layout row measured ${frames} frame(s) and judges nothing - read the boot row`);
      }
      console.log(`layout sampled: ${out.layoutSampled} (${out.layoutWorld}, waited ${out.layoutWaitMs} ms,`
        + ` ${frames} frame(s) in the layout phase${ev ? `, ${ev.cells} cells in ${ev.sampledMs} ms` : ''})`);
    } else {
      out.layoutSampled = false;
    }
    /* AFTER the boot phase closes, and after the composer exists. The boot
     * warm is not what this is aimed at, and instrumenting it would only add
     * wrappers to the one phase that already has an explanation. */
    if (args.frames) {
      out.framesShim = await evalIn(FRAME_SHIM);
      /* How big the graph the culler walks actually is. A per-frame counter
       * would cost more than it could find; this is the same number and it is
       * read once. */
      out.graph = JSON.parse(await evalIn(GRAPH_PROBE));
      console.log('frame instrumentation: ' + out.framesShim);
    }
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
      /* WAIT FOR THE CHAIN TO SAY IT IS DONE, NOT FOR A PREDICATE THAT GUESSES.
       *
       * This used to be `ids.every(id => isVolatile(id) || isBuilt(id))`, which
       * was true the moment the last DURABLE world finished. That was correct
       * only for as long as `scheduleBackgroundBuilds` skipped volatile worlds.
       * It now builds the maze last, and the predicate goes true in the idle
       * gap before that build starts - so the harness would stop waiting, open
       * the first `entry:` phase, and charge the maze's background generation
       * to whichever world happened to be crossed into at the time. That is the
       * exact shape of defect this repository keeps paying for: an instrument
       * measuring something other than what its label says.
       *
       * `worlds:all-ready` is emitted by the chain itself, after the LAST
       * world's build, warm and preview warm have all resolved, and it is
       * emitted in both configurations - so this is strictly more accurate than
       * the predicate was, not merely compatible with the change. `CHAIN_LATCH`
       * arms it at document start, long before the bus exists.
       *
       * The predicate survives as a fallback for the one case the latch cannot
       * cover - the arming script never ran - and the run records which of the
       * two ended the wait, so a report can never silently be the weaker one. */
      const latchArmed = await evalIn('window.__FG_CHAIN.armed === true')
        .catch(() => false);
      out.chainSignal = latchArmed ? 'worlds:all-ready' : 'built-predicate (LATCH MISSING)';
      if (!latchArmed) {
        console.warn('[frame-gaps] worlds:all-ready latch not armed; falling back to the '
          + 'built-predicate, which cannot see a volatile world still building.');
      }
      try {
        await waitFor(() => evalIn(
          latchArmed
            ? 'window.__FG_CHAIN.ready === true'
            : 'window.GAME.worldManager.ids.every((id) => window.GAME.worldManager.isVolatile(id)'
              + ' || window.GAME.worldManager.isBuilt(id))',
        ), { timeout: args.chainTimeoutMs, every: 1000, what: 'the background world chain to finish' });
      } catch (err) {
        /* A timeout that says only "timed out" forces the next person to
         * guess. The maiden CI run did exactly that: fifteen minutes of
         * silence, then this error, and no way to tell four-worlds-in from
         * hung-at-boot. Snapshot how far the chain got BEFORE rethrowing, so
         * a timeout is a measurement - "built 11/18, 96 programs, stuck after
         * medieval" - and the fix (a longer fuse, or a genuine hang) can be
         * chosen from evidence. Best-effort: if the page is gone this must
         * not mask the original error. */
        try {
          const progress = JSON.parse(await evalIn(
            'JSON.stringify({'
            + ' built: window.GAME.worldManager.ids.filter((id) => window.GAME.worldManager.isBuilt(id)),'
            + ' unbuilt: window.GAME.worldManager.ids.filter((id) => !window.GAME.worldManager.isBuilt(id)'
            + '   && !window.GAME.worldManager.isVolatile(id)),'
            + ' volatile: window.GAME.worldManager.ids.filter((id) => window.GAME.worldManager.isVolatile(id)),'
            + ' programs: window.GAME.engine.renderer.info.programs.length,'
            + ' latch: window.__FG_CHAIN ?? null })'
          ));
          out.chainTimeoutProgress = progress;
          console.error(
            `[frame-gaps] chain timed out after ${args.chainTimeoutMs} ms with `
            + `${progress.built.length}/${progress.built.length + progress.unbuilt.length} `
            + `non-volatile worlds built, ${progress.programs} programs.\n`
            + `  built:   ${progress.built.join(', ') || '(none)'}\n`
            + `  unbuilt: ${progress.unbuilt.join(', ') || '(none)'}`
          );
        } catch { /* the page is gone; the original timeout is the story */ }
        throw err;
      }
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

    /* --- MOVEMENT ------------------------------------------------------
     *
     * Brief 4.1.2 and its acceptance criterion both name MOVEMENT, and until
     * this block existed nothing in this script moved the player a single
     * metre. The only evidence the axis ever had was a 24 Aug playthrough
     * survey taken with a bare rAF sampler - no heartbeat, so it could not tell
     * a block from an occluded window, and none of the four Chrome flags above,
     * so it was measuring occluded windows constantly. It reported sports entry
     * at 40.5 ms where this instrument reports 6,583-7,250. Nothing it said
     * about movement is worth anything either.
     *
     * What a traversal costs that a standing frame does not: terrain and world
     * LOD swaps, district streaming, culling as the frustum sweeps onto
     * geometry that was behind the player, physics against colliders the
     * broadphase had not touched, and the NPC manager waking characters by
     * distance. None of that is exercised by pressing a key and standing still.
     *
     * Eight seconds, walk then sprint, under a constant yaw sweep so the
     * frustum keeps meeting new geometry rather than settling; then two jumps.
     * One direction of sweep only, and under 2*PI in total, so `yawTurned` is
     * unambiguous rather than a wrapped difference.
     *
     * @param {string} label the phase name
     */
    const measureMovement = async (label) => {
      /* CLEAR THE BOARD FIRST - AND CHECK THAT IT CLEARED. Movement runs
       * after the per-world mount event, which opens the mount wheel; any
       * overlay still up owns the keyboard and W does nothing. But Escape is
       * a TOGGLE: with nothing open it OPENS the pause hub, so a
       * fire-and-forget Escape can create the exact blockage it was sent to
       * clear. Press, then read `blocks` back, and press again if the board
       * is still (or newly) owned - recording how many it took, so a reader
       * of the event can see the difference between "one close" and "the
       * first press opened the hub". */
      let escapes = 0;
      for (; escapes < 3; escapes++) {
        const state = JSON.parse(await evalIn(WHERE));
        if (!state.blocks) break;
        await press('Escape');
        await sleep(350);
      }
      const from = JSON.parse(await evalIn(WHERE));
      await mark(label);
      const walkFrames = await hold(['KeyW'], 4000, { yawPerSec: 0.5, minFrames: 60 });
      const sprintFrames = await hold(['KeyW', 'ShiftLeft'], 4000, { yawPerSec: 0.5, minFrames: 60 });
      await press('Space'); await sleep(500);
      await press('Space'); await sleep(900);
      const phase = await closePhase(label);
      const to = JSON.parse(await evalIn(WHERE));
      if (!phase) return null;
      return {
        ...phase,
        from, to,
        /* THE NUMBER THAT SAYS THIS PHASE MEASURED ANYTHING.
         * A player wedged against a wall, dead, frozen by a stuck overlay or
         * standing in a world whose input never reached them produces a
         * beautiful 16.8 ms worst frame over eight seconds. `moved` is how the
         * reader tells that apart from a genuinely smooth traversal, and the
         * table prints it. */
        moved: from.x == null || to.x == null
          ? -1  // the probe could not read a position; the gate fails on this
          : Math.round(Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) * 10) / 10,
        /* How many frames actually RENDERED during each hold, and how many
         * Escapes the board-clear took. `moved: 0` with `walkFrames: 2` is a
         * starved page; `moved: 0` with `walkFrames: 200` is a player the
         * input genuinely never reached - different bugs, and without these
         * two numbers the gate's failure line cannot tell them apart. */
        walkFrames, sprintFrames, escapes,
        yawAsked: 4,
        yawTurned: from.yaw == null || to.yaw == null
          ? null : Math.round(Math.abs(to.yaw - from.yaw) * 100) / 100,
        /* Gateways need `KeyE` to cross (`Portals.js`), so walking into one is
         * not supposed to move the player between worlds. If it ever does, the
         * phase measured a crossing under a movement label. */
        worldChanged: from.world !== to.world,
        /* Lifted out of `to` so a reader of the events object does not have to
         * know `to` exists to find out why `moved` is zero. */
        blocks: to.blocks, mounted: to.mounted, textCaptured: to.textCaptured, dead: to.dead,
      };
    };

    if (wants.has('movement')) {
      out.events[`movement:${args.entryWorld}`] = await measureMovement(`movement:${args.entryWorld}`);
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
          /* `fogType` read `s.fog.type`, and three's Fog and FogExp2 define no
           * `type` at all - only `isFog` / `isFogExp2` and an empty `name`. So
           * it was `undefined`, `JSON.stringify` dropped the key, and every
           * report this script has ever written recorded which KIND of fog a
           * crossing arrived under by omitting it. `fogExp2` is in three's
           * program cache key and is the single most expensive entry in it on
           * this bundle, so this is exactly the field a reader needs. */
          + ' fog: !!s.fog, fogType: s.fog ? (s.fog.isFogExp2 ? "FogExp2" : "Fog") : null,'
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
            /* TOTAL, exactly as \`applyEnvironment\` is. This mirrored the old
             * partial \`if (env.envMap !== undefined)\` until 2026-09-02, and a
             * harness that models the applier has to move when the applier
             * does: under the partial form a world publishing no probe was
             * warmed against whatever map the DEPARTURE world left on the
             * scene, while the arrival cleared it - so this experiment would
             * have compiled the wrong key set and still reported a saving.
             * All eighteen worlds publish a probe today, so the two forms
             * agree in practice and no number here moves; it is written this
             * way so it stays true the day one stops. */
            sc.environment = env.envMap ?? null;
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
        /* THE CROSSING, BESIDE THE GAP IT IS BLAMED FOR.
         *
         * `--events repeat` has always recorded `WorldManager.activationCost`
         * either side of a crossing pair; `entry` never did, so every first
         * entry in the §7 table was a bare gap with no statement of what the
         * crossing itself cost. That is how race's 31 s came to be written
         * down as "a volatile world rebuilt": nothing in the report said the
         * crossing was 46 ms. It is the same field, read the same way, one
         * line after the phase closes. */
        const cost = await evalIn('JSON.stringify(window.GAME.worldManager.activationCost ?? null)');
        out.events[label] = {
          ...phase, builtBefore: pre.built, key: { pre, post },
          cost: [cost ? JSON.parse(cost) : null],
        };
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
        /* Movement is per WORLD or it is nothing. Every cost a traversal has
         * that a standing frame does not - terrain LOD, district streaming,
         * culling onto unseen geometry, colliders the broadphase has not met -
         * belongs to the world being walked through, and eight seconds of
         * walking around the station says nothing about the maze. Last in the
         * per-world block so a mount left summoned cannot carry the player
         * through it at mount speed. */
        if (wants.has('movement')) {
          out.events[`movement:${id}`] = await measureMovement(`movement:${id}`);
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
        /* The upload triple per LISTENER, not per gap.
         *
         * Once a crossing's JavaScript is gone its frame gap does not go with
         * it, and what is left is uploads. The gate reports dProg/dGeom/dTex
         * against the gap, which cannot say which subsystem made them. */
        const R = window.GAME.engine && window.GAME.engine.renderer;
        for (const fn of set) {
          const row = { ms: 0, calls: 0, tex: 0, geom: 0, prog: 0, src: String(fn).replace(/\\s+/g, ' ').slice(0, 140) };
          rows.push(row);
          wrapped.add((payload) => {
            const t0 = R ? R.info.memory.textures : 0;
            const g0 = R ? R.info.memory.geometries : 0;
            const p0 = R ? R.info.programs.length : 0;
            const t = performance.now();
            try {
              return fn(payload);
            } finally {
              row.ms += performance.now() - t;
              row.calls++;
              if (R) {
                row.tex += R.info.memory.textures - t0;
                row.geom += R.info.memory.geometries - g0;
                row.prog += R.info.programs.length - p0;
              }
            }
          });
        }
        bus._handlers.set('world:changed', wrapped);
        window.__LISTENERS = rows;
        return rows.length;
      })()`);
    }

    /* --- repeated entry/exit ------------------------------------------
     *
     * READ `repeat:0` CAREFULLY WHEN `entry` IS NOT IN `--events`.
     *
     * With `--events repeat` alone, the destination has never been entered in
     * this session, so `repeat:0`'s first crossing is a FIRST ENTRY wearing a
     * repeat's label: measured on the production bundle it builds medieval's
     * whole cast from scratch - `npcs 455-487 ms` - and links 7-8 programs,
     * which is 565-600 ms of crossing inside an 820-1,300 ms gap. `repeat:1`
     * and `repeat:2` in the same runs are 100 ms.
     *
     * That cost is real and it is what the `entry` line of the criterion is
     * for. It is not what the `repeat` line is about, and charging it to a
     * repeat is the instrument answering a different question from the one on
     * the label. Run `--events entry,repeat` and all three are true repeats. */
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

    /* --- INTERACTIONS ---------------------------------------------------
     *
     * The other axis brief 4.1.2 names and this script never had. An
     * interaction is not a keybind: `keybind:KeyV` measures the input path,
     * where this measures what the input path OPENS. Two of these panels are
     * their own lazily-imported chunks - `InventoryUI` and `MarketplaceUI` are
     * separate files in `dist/assets` - so a first open is a network fetch, a
     * module parse, a DOM build and a stylesheet, none of which the boot warm
     * touches and none of which any other event here has ever crossed.
     *
     * LAST, deliberately. A panel that fails to close owns the keyboard
     * (`Input._textCaptured` gates every key handler in the game), and if that
     * happened before the entry loop every world crossing after it would be
     * measured through a stuck overlay. Running it after everything else means
     * the worst case costs this block and nothing else, and `stuck` below says
     * so out loud instead of leaving it to be inferred.
     *
     * FIRST USE IS THE POINT, so the order matters: anything already opened by
     * an earlier event is not a first use here. `mount` presses KeyM, which is
     * the mount wheel - so `interaction:wheel` is a first use only when
     * `--events` leaves `mount` out, and its row reads `+0 programs` when it is
     * not. That is visible in the table rather than hidden by it. */
    if (wants.has('interaction')) {
      /* Each row: the key that opens the surface, and the key that closes it.
       * Every one of these is a REAL window-level `keydown` handler in the
       * shipping game - `main.js:2674` for KeyI, `QuestBoard.js:66` for KeyJ,
       * `ChatBox.js` for KeyT, the map/wheel owner for KeyM - so all of it is
       * driven by dispatched OS-shaped key events and nothing here reaches
       * into a panel's own API. */
      const surfaces = [
        { id: 'inventory', open: 'KeyI', close: 'KeyI', settle: 1200 },
        { id: 'quests', open: 'KeyJ', close: 'Escape', settle: 1200 },
        { id: 'wheel', open: 'KeyM', close: 'Escape', settle: 900 },
        /* KeyE is the world's own interact. Standing where the harness leaves
         * the player there may be nothing in range, and that is still worth
         * measuring: the first press is what builds the prompt slots and wakes
         * the interaction scan, and the criterion says "first keybind use" for
         * exactly this reason. */
        { id: 'interact', open: 'KeyE', close: null, settle: 900 },
        /* Chat last of the last: it is the one surface that captures TEXT, so
         * it is the one whose failure to close is unrecoverable for everything
         * after it. Nothing after it needs the keyboard. */
        { id: 'chat', open: 'KeyT', close: 'Escape', settle: 1200 },
      ];
      for (const s of surfaces) {
        const label = `interaction:${s.id}`;
        await mark(label);
        await press(s.open);
        await sleep(s.settle);
        /* THE 600 MS WALL SLEEP WAS THE MOVEMENT BUG'S SIBLING. A close that
         * releases the text capture on its NEXT FRAME is correct game code -
         * and on a runner that starves rAF in 10 s stretches, "600 ms after
         * Escape" can land entirely inside a stretch where that frame never
         * ran. CI run 18:56 26 Aug flagged chat as "left the keyboard
         * captured" on a tree that had passed the same gate twice; the same
         * run's boot took 54 s and its movement hold starved for 15 s. So the
         * check polls: released is an instant pass, and "still captured" is
         * only believed once at least 30 frames have actually RENDERED since
         * the close - at which point the game had every chance to let go and
         * genuinely did not. */
        let stuck = false;
        let stuckFrames = 0;
        if (s.close) {
          await press(s.close);
          const f0 = Number(await evalIn(FRAME_NOW));
          /* 20 s, not 8: the observed starvation stretches are 10 s, and a cap
           * that cannot ride one out re-creates the timing-luck failure this
           * poll exists to remove. Reaching the cap with under 30 frames means
           * the page is genuinely not rendering, which is its own failure. */
          const cap = Date.now() + 20000;
          for (;;) {
            await sleep(250);
            stuck = await evalIn('!!(window.GAME.input && window.GAME.input.textCaptured)');
            stuckFrames = Number(await evalIn(FRAME_NOW)) - f0;
            if (!stuck) break;
            if (stuckFrames >= 30 || Date.now() >= cap) break;
          }
        } else {
          stuck = await evalIn('!!(window.GAME.input && window.GAME.input.textCaptured)');
        }
        const phase = await closePhase(label);
        if (phase) {
          /* Did the keyboard come back? `textCaptured` is what every key
           * handler in the game checks first, so a true here means every
           * measurement after this point is measuring a game nobody can type
           * at. Recorded per surface rather than once at the end so the reader
           * knows WHICH one kept it - and `stuckFrames` says whether the game
           * was ever given a frame in which to release it. */
          phase.stuck = stuck;
          phase.stuckFrames = stuckFrames;
          out.events[label] = phase;
        }
      }
      /* One last look, whatever the rows said. A `--events interaction` run
       * that ends with the keyboard captured has told the truth about its own
       * numbers and nothing about anyone else's. */
      out.keyboardCaptured = await evalIn('!!(window.GAME.input && window.GAME.input.textCaptured)');
    }

    /* --- THE SUBSYSTEM AUTOPSY -----------------------------------------
     *
     * The listener table above says one closure spends nearly all of the
     * fan-out, and five separate systems register the identical shape
     * `({id, world}) => this._onWorld(id, world)`. Minification keeps the
     * member name and throws the identity away, so the table cannot say WHICH.
     *
     * These call the same rebuilds again by name, on the live world, and time
     * each one. Every entry is idempotent by construction - each resets its own
     * list before repopulating it, which is exactly what it does on a normal
     * crossing - so this measures a real second crossing rather than a
     * half-state. It runs after the last repeat and before `done`, so nothing
     * the gate reports is measured through it. */
    if (args.listeners) {
      out.autopsy = JSON.parse(await evalIn(`(() => {
        const G = window.GAME, w = G.worldManager.active, id = w && w.id;
        const out = {};
        /* Time, and the GPU-object deltas beside it.
         *
         * Once the JavaScript in a crossing is gone the gap does not go with
         * it, and the difference is uploads: the gate reports dProg/dGeom/dTex
         * per gap and says nothing about WHICH subsystem created them. Same
         * triple, per named rebuild. */
        const R = G.engine && G.engine.renderer;
        const info = () => (R ? {
          t: R.info.memory.textures, g: R.info.memory.geometries, p: R.info.programs.length,
        } : { t: 0, g: 0, p: 0 });
        const time = (name, fn) => {
          const a = info();
          const t = performance.now();
          try { fn(); } catch (err) { out[name + ':error'] = String(err && err.message || err); }
          out[name] = Math.round((performance.now() - t) * 10) / 10;
          const b = info();
          if (b.t !== a.t || b.g !== a.g || b.p !== a.p) {
            out[name + ':uploads'] = 'tex ' + (b.t - a.t) + ' geom ' + (b.g - a.g) + ' prog ' + (b.p - a.p);
          }
        };
        /* THE 811 ms, SPLIT AT ITS OWN BOUNDARY.
         *
         * Caches._onWorld darts at the content box and probes each candidate
         * two ways: Physics.groundHeight, which is this repository's own
         * broadphase raycast, and _hasVisibleFloor, which is a THREE.Raycaster
         * against the whole render tree. Those live on opposite sides of a
         * file boundary and have completely different fixes, so the number is
         * worth nothing until it is split.
         *
         * Both are wrapped as OWN properties over the prototype methods and
         * deleted afterwards, so the instrumentation cannot outlive the
         * measurement. */
        const P = G.physics;
        const C = G.caches;
        let rayMs = 0, rayN = 0, visMs = 0, visN = 0;
        const rawRay = P.raycast;
        const rawVis = C && C._hasVisibleFloor;
        P.raycast = function (...a) {
          const t = performance.now();
          try { return rawRay.apply(this, a); } finally { rayMs += performance.now() - t; rayN++; }
        };
        if (rawVis) {
          C._hasVisibleFloor = function (...a) {
            const t = performance.now();
            try { return rawVis.apply(this, a); } finally { visMs += performance.now() - t; visN++; }
          };
        }
        /* WHAT THE VISIBLE-FLOOR PROBE IS ACTUALLY HANDED.
         *
         * _hasVisibleFloor narrows the render tree to the leaves whose world
         * box overlaps its eight-metre segment. Whether that is worth anything
         * depends entirely on the SHAPE of the world group, which no static
         * read of the source can tell you: a district merged into one mesh
         * whose box spans the map is a candidate for every probe no matter how
         * the index is built. So record, per probe, how many leaves survived
         * the filter and how many triangles they carry. */
        const probes = [];
        if (rawVis && C._visibleNear) {
          const rawNear = C._visibleNear;
          C._visibleNear = function (...a) {
            const list = rawNear.apply(this, a);
            let tris = 0;
            for (const o of list) {
              const g = o.geometry;
              const n = g ? (g.index ? g.index.count : (g.attributes.position?.count ?? 0)) / 3 : 0;
              tris += n * (o.isInstancedMesh ? o.count : 1);
            }
            probes.push({ n: list.length, tris: Math.round(tris) });
            return list;
          };
        }
        time('caches._onWorld', () => C && C._onWorld(id, w));
        if (rawVis && C._visibleNear) delete C._visibleNear;
        if (probes.length) {
          out.visProbeCandidates = probes.map((p) => p.n);
          out.visProbeTriangles = probes.map((p) => p.tris);
        }
        /* The index itself, built once more so its shape can be reported. */
        if (C && C._indexVisible && w.group) {
          const t = performance.now();
          C._indexVisible(w.group);
          out.visIndexMs = Math.round((performance.now() - t) * 10) / 10;
          out.visLeaves = C._vis.leaves.length;
          out.visAlways = C._vis.always.length;
          out.visWide = C._vis.wide.length;
          out.visEntries = C._vis.entLeaf.length;
          out.visCells = C._vis.cells.size;
          out.visStats = C._vis.stats;
          /* WHAT IS STILL WIDE, AND WHY. A leaf that keeps its exact box is
           * fine; an object whose per-instance filing collapsed into one box
           * the size of the map is the failure this whole index is about, and
           * from the outside the two look identical in a candidate count. */
          out.visWidest = C._vis.wide
            .map((w) => {
              const o = C._vis.leaves[w.li];
              const g = o.geometry;
              return [
                (o.name || o.type) + (o.isInstancedMesh ? ' x' + o.count : ''),
                Math.round(w.maxX - w.minX), Math.round(w.maxY - w.minY), Math.round(w.maxZ - w.minZ),
                g && g.boundingSphere ? Math.round(g.boundingSphere.radius * 10) / 10 : null,
              ];
            })
            .sort((a, b) => (b[1] * b[3]) - (a[1] * a[3]))
            .slice(0, 8);
          let allTris = 0, alwaysTris = 0, biggest = [];
          const tri = (o) => {
            const g = o.geometry;
            const n = g ? (g.index ? g.index.count : (g.attributes.position?.count ?? 0)) / 3 : 0;
            return Math.round(n * (o.isInstancedMesh ? o.count : 1));
          };
          for (const o of C._vis.leaves) { const t2 = tri(o); allTris += t2; biggest.push([o.name || o.type, t2]); }
          for (const o of C._vis.always) { const t2 = tri(o); alwaysTris += t2; allTris += t2; biggest.push([(o.name || o.type) + ' [always]', t2]); }
          for (const w of C._vis.wide) { const o2 = C._vis.leaves[w.li]; const t2 = tri(o2); allTris += t2; biggest.push([(o2.name || o2.type) + " [wide]", t2]); }
          biggest.sort((x, y) => y[1] - x[1]);
          out.visTriangles = allTris;
          out.visAlwaysTriangles = alwaysTris;
          out.visBiggest = biggest.slice(0, 10);
          C._vis = null;
          C._visOut = null;
        }
        /* The render-tree raycast calls no physics, so the two are disjoint
         * and rayMs here is the physics half whole. */
        out.physicsRaycastMs = Math.round(rayMs * 10) / 10;
        out.physicsRaycastCalls = rayN;
        out.hasVisibleFloorMs = Math.round(visMs * 10) / 10;
        out.hasVisibleFloorCalls = visN;
        delete P.raycast;
        if (rawVis) delete C._hasVisibleFloor;
        time('relics._onWorld', () => G.relics && G.relics._onWorld(id, w));
        time('waterVolumes.rebuildFromWorld', () => G.waterVolumes && G.waterVolumes.rebuildFromWorld(w, true));
        /* --- WOULD A RETAINED CHARACTER GEOMETRY CACHE EVER HIT? -----------
         *
         * CharacterAssets.geoCache disposes on last release, so leaving a
         * world frees the whole cast and re-entering welds every body again.
         * The fix proposed for that is a bounded cache of released-but-unfreed
         * keys - and a cache is worth exactly nothing unless the keys the
         * SECOND visit asks for are the keys the first visit built.
         *
         * spawnForWorld below clears the live cast (which disposes every key
         * it held) and builds a new one, which is what a re-entry does. So:
         * snapshot the live key set first, record every acquire during the
         * rebuild, and the overlap IS the hit rate a retained cache would get.
         * geoBuildMs is the time inside the make() closures - the lofting,
         * welding and merging a hit would skip. */
        const A = G.npcManager && G.npcManager.assets;
        const acquired = [];
        let before = null, makeMs = 0, makes = 0;
        if (A && A.geoCache) {
          before = new Set(A.geoCache.keys());
          const rawAcq = A.acquireGeometry;
          A.acquireGeometry = function (key, make) {
            acquired.push(key);
            return rawAcq.call(this, key, () => {
              const t = performance.now();
              try { return make(); } finally { makeMs += performance.now() - t; makes++; }
            });
          };
        }
        time('npcManager.spawnForWorld', () => G.npcManager && G.npcManager.spawnForWorld(w));
        if (A && A.geoCache) {
          delete A.acquireGeometry;
          const uniq = new Set(acquired);
          let hit = 0;
          for (const k of uniq) if (before.has(k)) hit++;
          let bytes = 0;
          for (const g of A.geoCache.values()) {
            for (const n in g.attributes) bytes += g.attributes[n].array.byteLength;
            if (g.index) bytes += g.index.array.byteLength;
          }
          out.geoKeysInPreviousCast = before.size;
          out.geoAcquires = acquired.length;
          out.geoDistinctKeys = uniq.size;
          out.geoKeysAlsoInPreviousCast = hit;
          out.geoBuiltFromScratch = makes;
          out.geoBuildMs = Math.round(makeMs * 10) / 10;
          out.geoLiveEntries = A.geoCache.size;
          out.geoLiveMB = Math.round(bytes / 1048576 * 100) / 100;
        }
        time('loot._onWorld', () => G.loot && G.loot._onWorld && G.loot._onWorld(id, w));
        out.world = id;
        return JSON.stringify(out);
      })()`));
    }

    /* --- THE ABLATION, ON THE SHIPPING BUNDLE ---------------------------
     *
     * The autopsy above says two subsystems are 97% of a crossing. That is
     * arithmetic until the crossing is measured WITHOUT them, so this stubs
     * both out and crosses once more.
     *
     * _hasVisibleFloor is replaced by the answer it gives for a real deck,
     * so the dart budget, the physics probes and the placement rules all
     * still run - only the render-tree raycast is gone. spawnForWorld is
     * skipped outright, which removes MORE than a warm character-geometry
     * cache would, so the number below is a floor for the crossing rather
     * than a prediction of what fixing the cache would leave.
     *
     * Both stubs are own properties over prototype methods and are deleted
     * afterwards. Nothing the gate reports is measured through them: this
     * runs after the last repeat has been closed.
     */
    if (args.listeners) {
      const other = worlds.find((w) => w !== args.entryWorld) ?? 'medieval';
      await evalIn(`(() => {
        const G = window.GAME;
        if (G.caches) G.caches._hasVisibleFloor = () => true;
        if (G.npcManager) G.npcManager.spawnForWorld = () => {};
        return 1;
      })()`);
      /* MARKED, so the ablated crossing gets a GAP and not only a step total.
       *
       * Once the crossing's JavaScript is 8% of what it was, its `total` stops
       * being the interesting number: the frame that carries a crossing is
       * ~150 ms longer than the crossing, in every measurement, before and
       * after. Stubbing the two subsystems and reading only `activationCost`
       * cannot tell whether that ~150 ms belongs to them or to the frame. A
       * phase around it can. */
      await mark('ablated');
      await evalIn(`window.HARNESS.goto(${JSON.stringify(other)}).then(() => 1)`);
      await sleep(900);
      await evalIn(`window.HARNESS.goto(${JSON.stringify(args.entryWorld)}).then(() => 1)`);
      out.ablated = JSON.parse(await evalIn('JSON.stringify(window.GAME.worldManager.activationCost ?? null)'));
      await sleep(600);
      out.events.ablated = await closePhase('ablated');
      await evalIn(`(() => {
        const G = window.GAME;
        if (G.caches) delete G.caches._hasVisibleFloor;
        if (G.npcManager) delete G.npcManager.spawnForWorld;
        return 1;
      })()`);
    }
    if (args.frames) {
      /* MARKED, and that is not tidiness. The check itself calls
       * `computeBoundingSphere` on every character - the expensive path, on
       * purpose - and a phase left open would charge those hundreds of
       * milliseconds to whichever criterion phase happened to be last. The gate
       * has already closed its books by here; this keeps the GAP LIST honest
       * too. */
      await mark('skincheck');
      out.skinBounds = [];
      const other = worlds.find((w) => w !== args.entryWorld) ?? 'medieval';
      for (const id of [args.entryWorld, other]) {
        await evalIn(`window.HARNESS.goto(${JSON.stringify(id)}).then(() => 1)`);
        /* Seconds of real gameplay first. A containment check taken at spawn
         * compares a bind-pose sphere against a bind pose. */
        await sleep(6000);
        out.skinBounds.push(JSON.parse(await evalIn(SKIN_CONTAIN)));
      }
      out.events.skincheck = await closePhase('skincheck');
    }

    /* --- THE FIX, TAKEN BACK OUT ---------------------------------------
     *
     * `gfx/SkinBounds.js` hands every character the bind-pose sphere its
     * geometry already carries, so `Frustum.intersectsObject` never calls
     * `SkinnedMesh.computeBoundingSphere` - which CPU-skins the whole body.
     * This puts three's lazy path back and crosses three more times.
     *
     * The hook is `SkinnedMesh.bind`, because it is the last thing
     * `HumanoidFactory` does to a body and nulling the sphere there leaves the
     * character in exactly the state it shipped in before the fix. Nothing the
     * gate reports is measured through it: it runs after the last repeat has
     * been closed, and it is undone afterwards.
     */
    if (args.frames) {
      const other = worlds.find((w) => w !== args.entryWorld) ?? 'medieval';
      out.unboundPatch = await evalIn(`(() => {
        const proto = window.GAME.THREE.SkinnedMesh.prototype;
        if (proto.__unbound) return 'already';
        const orig = proto.bind;
        proto.__unboundOrig = orig;
        proto.__unbound = 1;
        proto.bind = function (skeleton, bindMatrix) {
          const r = orig.call(this, skeleton, bindMatrix);
          this.boundingSphere = null;
          return r;
        };
        return 'patched';
      })()`);
      for (let i = 0; i < 3; i++) {
        const label = `unbound:${i}`;
        await mark(label);
        await evalIn(`window.HARNESS.goto(${JSON.stringify(other)}).then(() => 1)`);
        await sleep(900);
        await evalIn(`window.HARNESS.goto(${JSON.stringify(args.entryWorld)}).then(() => 1)`);
        await sleep(900);
        out.events[label] = await closePhase(label);
      }
      await evalIn(`(() => {
        const proto = window.GAME.THREE.SkinnedMesh.prototype;
        if (proto.__unboundOrig) proto.bind = proto.__unboundOrig;
        delete proto.__unboundOrig; delete proto.__unbound;
        return 1;
      })()`);
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
    /* The game's own watchdog. `dev/Harness.js` counts every await of an
     * animation frame that waited 10 s without one and says the window is
     * probably occluded. It has been there the whole time and this script has
     * never read it; a run that reports a multi-second gap AND a non-zero
     * count here is reporting the compositor, not the game. */
    out.rafStalls = await evalIn('window.__HARNESS_RAF_STALLS__ ?? 0');
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

/**
 * WAS THE THREAD BUSY, OR WAS THE FRAME JUST NOT COMING?
 *
 * `blockedMs` is the longest stretch the 4 ms heartbeat lost inside a gap, and
 * that timer is on the same main thread and is NOT gated on the compositor. So
 * a gap whose heartbeat kept ticking is a gap in which no JavaScript ran: the
 * frame simply never arrived. That is a real freeze for a player, but it is
 * not a cost anything in `src/` can be changed to remove, and reading one as
 * though it were has already put "race: 31,284.1 ms, a volatile world rebuilt"
 * into a ledger about a world that is not volatile.
 *
 * Both halves are printed. A starved gap still counts against the budget - the
 * screen was frozen - but it is labelled, so it can never be attributed to the
 * phase's own work by someone reading the table alone.
 */
function isStarved(g, budget) {
  return g.ms > budget && g.blockedMs <= budget && g.beats * 4 >= g.ms * 0.5;
}

function summarise(run, budget) {
  const rows = [];
  /* The worst GAP per phase, so the summary can say how much of the phase's
   * worst number was the main thread. The recorder keeps only the scalar. */
  const worstGap = new Map();
  for (const g of run.gaps ?? []) {
    const cur = worstGap.get(g.phase);
    if (!cur || g.ms > cur.ms) worstGap.set(g.phase, g);
  }
  for (const [name, p] of Object.entries(run.events)) {
    if (!p) continue;
    const g = worstGap.get(name) ?? null;
    rows.push({
      event: name, worst: p.worst ?? 0, over: p.over ?? 0, frames: p.frames ?? 0,
      dPrograms: p.dPrograms ?? 0, dGeometries: p.dGeometries ?? 0, dTextures: p.dTextures ?? 0,
      blocked: g ? g.blockedMs : null,
      starved: g ? isStarved(g, budget) : false,
      pass: (p.worst ?? 0) <= budget,
      /* WHAT THE PHASE ACTUALLY DID, carried into the table beside its verdict.
       * A movement phase that covered no ground and an interaction phase that
       * ate the keyboard both produce beautiful numbers, and a reader skimming
       * a `pass` column has no way to tell. `moved` and `stuck` are printed on
       * the same line as the verdict so the answer cannot be quoted without
       * them. */
      moved: typeof p.moved === 'number' ? p.moved : null,
      /* A traversal on a MOUNT is a different measurement from one on foot -
       * different speed, different collider, different animation set - and
       * `mount:<world>` runs immediately before this and does not always manage
       * to dismount. Measured: `movement:race` covered 99 m mounted where every
       * world on foot covered 10-28. Reported rather than corrected: the row is
       * still a real traversal of a real world. */
      mounted: p.mounted === true,
      stuck: p.stuck === true,
    });
  }
  return rows;
}

function printTable(rows, budget) {
  const w = Math.max(...rows.map((r) => r.event.length), 10);
  /* `frames` is how many frames the verdict rests on. A `0` beside `pass`
   * is a row that judged nothing, and a reader must be able to see that. */
  console.log(`\n${'event'.padEnd(w)}  ${'worst ms'.padStart(9)} ${'blocked'.padStart(8)} ${'>250'.padStart(5)} ${'frames'.padStart(6)} ${'dProg'.padStart(6)} ${'dGeom'.padStart(6)} ${'dTex'.padStart(5)}  verdict`);
  console.log('-'.repeat(w + 61));
  for (const r of rows) {
    console.log(
      `${r.event.padEnd(w)}  ${String(r.worst).padStart(9)} ${String(r.blocked ?? '-').padStart(8)} ${String(r.over).padStart(5)} ${String(r.frames).padStart(6)} `
      + `${String(r.dPrograms).padStart(6)} ${String(r.dGeometries).padStart(6)} ${String(r.dTextures).padStart(5)}  `
      + (r.pass ? 'pass' : `FAIL (>${budget})`)
      + (r.starved ? '  STARVED - no rAF, main thread idle; not this phase\'s work' : '')
      + (r.moved != null
        ? `  moved ${r.moved} m${r.moved < 1
          ? ' - THE PLAYER DID NOT MOVE AT ALL; the input never reached them and this row measured nothing'
          : r.moved < 3 ? ' - barely moved; a hemmed-in spawn, read this row as a standing frame' : ''}`
        : '')
      + (r.mounted ? '  MOUNTED - this is a mount being ridden, not a player walking' : '')
      + (r.stuck ? '  KEYBOARD STILL CAPTURED - every row after this one is suspect' : ''),
    );
  }
}

/**
 * What each crossing cost, step by step.
 *
 * The gate reports the worst rAF gap, which is the number the criterion is
 * written in and which says nothing about what to do next. This is the same
 * block of time broken into the steps WorldManager names, off the same run.
 */
function printCrossings(run) {
  const rows = [];
  for (const [name, ev] of Object.entries(run.events)) {
    for (const c of ev?.cost ?? []) if (c) rows.push([name, c]);
  }
  if (!rows.length) return;
  const steps = ['changing', 'teardown', 'physicsClear', 'physicsAdd', 'sceneIn',
    'portals', 'arrival', 'npcs', 'changed', 'total'];
  console.log(`\ncrossing        into        colliders  ${steps.map((s) => s.padStart(8)).join(' ')}`);
  for (const [name, c] of rows) {
    console.log(
      `${name.padEnd(15)} ${String(c.world).padEnd(11)} ${String(c.colliders).padStart(9)}  `
      + steps.map((s) => String(c[s] ?? '-').padStart(8)).join(' '),
    );
  }
}

/**
 * Who spent the world:changed fan-out, and what each named rebuild costs.
 * Present only with --listeners.
 */
/* THE TAIL OF A THREE PROGRAM CACHE KEY, IN ORDER.
 *
 * `WebGLPrograms.getProgramCacheKey` joins an array with commas. Its HEAD is
 * variable - `shaderID`, or a `customVertexShaderID`/`customFragmentShaderID`
 * pair, followed by every `defines` name and value - so nothing can be located
 * by counting from the front. Its TAIL is fixed at 52 entries for every
 * non-raw material: the 48 `getProgramCacheKeyParameters` pushes, the two
 * `getProgramCacheKeyBooleans` bitmasks, `renderer.outputColorSpace`, and
 * `customProgramCacheKey`. Counting backwards therefore names a field exactly.
 *
 * Copied from three 0.185.1. If it drifts, `--cache-keys` mislabels fields and
 * says nothing false about how MANY differ, which is the load-bearing half.
 */
const KEY_TAIL = [
  'precision', 'outputColorSpace', 'envMapMode', 'envMapCubeUVHeight', 'mapUv', 'alphaMapUv',
  'lightMapUv', 'aoMapUv', 'bumpMapUv', 'normalMapUv', 'displacementMapUv', 'emissiveMapUv',
  'metalnessMapUv', 'roughnessMapUv', 'anisotropyMapUv', 'clearcoatMapUv', 'clearcoatNormalMapUv',
  'clearcoatRoughnessMapUv', 'iridescenceMapUv', 'iridescenceThicknessMapUv', 'sheenColorMapUv',
  'sheenRoughnessMapUv', 'specularMapUv', 'specularColorMapUv', 'specularIntensityMapUv',
  'transmissionMapUv', 'thicknessMapUv', 'combine', 'fogExp2', 'sizeAttenuation',
  'morphTargetsCount', 'morphAttributeCount', 'numDirLights', 'numPointLights', 'numSpotLights',
  'numSpotLightMaps', 'numHemiLights', 'numRectAreaLights', 'numDirLightShadows',
  'numPointLightShadows', 'numSpotLightShadows', 'numSpotLightShadowsWithMaps', 'numLightProbes',
  'shadowMapType', 'toneMapping', 'numClippingPlanes', 'numClipIntersection', 'depthPacking',
  'bools:instancing..vertexNormals', 'bools:fog..hasPositionAttribute',
  'renderer.outputColorSpace', 'customProgramCacheKey',
];

/** Name the field at `i` in a key of `n` fields. */
function keyFieldName(i, n) {
  const t = i - (n - KEY_TAIL.length);
  if (t >= 0 && t < KEY_TAIL.length) return KEY_TAIL[t];
  if (i === 0) return 'shaderID|customVertexShaderID';
  if (i === 1) return 'customFragmentShaderID|define';
  return `head[${i}]`;
}

/**
 * WHICH PROGRAMS AN ARRIVAL LINKED, AND WHAT MADE THEM NOVEL. --cache-keys.
 *
 * A count of linked programs says a crossing is expensive; it never says what
 * to change. This takes each cache key that did not exist before the crossing,
 * finds the nearest key that did, and prints the fields that differ. One
 * predecessor did this by hand and it named the whole finding in a line -
 * `customVertexShaderID 60 -> 92, every other field equal` is a shader stage
 * evicted and rebuilt, `fogExp2 0 -> 1` is a warm keyed to the wrong scene,
 * and "no near neighbour" is a material the warm never reached at all.
 */
function printCacheKeys(run) {
  const rows = Object.entries(run.events)
    .filter(([, ev]) => ev?.newCacheKeys?.length);
  if (!rows.length) return;
  console.log('\nprograms linked by the arrival (--cache-keys), against the nearest key that existed');
  for (const [name, ev] of rows) {
    console.log(`\n  ${name}  +${ev.newCacheKeys.length} programs`);
    for (const key of ev.newCacheKeys) {
      const a = key.split(',');
      let best = null;
      for (const old of ev.oldCacheKeys ?? []) {
        const b = old.split(',');
        if (b.length !== a.length) continue;
        const diff = [];
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff.push(i);
        if (!best || diff.length < best.diff.length) best = { b, diff };
      }
      if (!best) {
        console.log(`      no near neighbour (${a.length} fields, head ${a.slice(0, 2).join()})`);
        continue;
      }
      const shown = best.diff.slice(0, 4).map(
        (i) => `${keyFieldName(i, a.length)} ${best.b[i]} -> ${a[i]}`,
      ).join('; ');
      console.log(`      ${best.diff.length} field${best.diff.length === 1 ? '' : 's'} differ: ${shown}`
        + (best.diff.length > 4 ? ' ...' : ''));
    }
  }
}

function printListeners(run) {
  if (run.listeners?.length) {
    console.log('\nworld:changed listeners, ms over every crossing in this run');
    for (const l of run.listeners.slice(0, 8)) {
      const up = (l.tex || l.geom || l.prog)
        ? ` [tex ${l.tex} geom ${l.geom} prog ${l.prog}]` : '';
      console.log(`${String(l.ms).padStart(9)}  x${l.calls}${up}  ${l.src.slice(0, 84)}`);
    }
  }
  if (run.ablated) {
    console.log(`\nthe same crossing into "${run.ablated.world}" with the two stubbed out:`
      + ` total ${run.ablated.total} ms (npcs ${run.ablated.npcs}, changed ${run.ablated.changed},`
      + ` physicsAdd ${run.ablated.physicsAdd})`);
  }
  for (const b of run.skinBounds ?? []) {
    console.log(`\nskinned bounds in "${b.world}": ${b.assigned}/${b.skinned} carry an assigned sphere,`
      + ` worst containment ratio ${b.worst} (${b.worst <= 1 ? 'contained' : 'NOT CONTAINED'})`
      + ` on ${b.worstName ?? '?'}; top ${JSON.stringify(b.top)}`);
  }
  if (run.autopsy) {
    console.log(`\nrebuilt again by name on the live "${run.autopsy.world}":`);
    for (const [k, v] of Object.entries(run.autopsy)) {
      if (k === 'world') continue;
      const s = (v && typeof v === 'object') ? JSON.stringify(v) : String(v);
      console.log(`${s.length > 9 ? s : s.padStart(9)}  ${k}`);
    }
  }
}

/**
 * WHAT THE FRAME ITSELF SPENT. Present only with --frames.
 *
 * One row per kept gap, worst first, and under it the engine loop stages that
 * ran inside it. The rows nest, so they are printed in nesting order and the
 * culling line is the subtraction `r.render - r.matrixWorld - r.shadow -
 * r.draw`: three.js has no entry point for `projectObject` and this is the
 * only honest way to size it from outside.
 *
 * `acct` is the gap MINUS the engine loop's own three top-level stages
 * (fixed, frame, busFlush, postfx). Whatever is left ran outside the loop -
 * a world build in an idle callback, a CDP eval, or the compositor simply not
 * scheduling - and a large one is the instrument telling you it is looking in
 * the wrong place.
 *
 * READ `beats` BEFORE `outside-loop`. The 4 ms heartbeat is on the same main
 * thread and is NOT gated on the compositor, so `beats` counts the times that
 * thread was free INSIDE the gap. A gap whose `beats` is roughly `ms / 4` had
 * an idle main thread from end to end: no JavaScript ran in it, and no amount
 * of reading `outside-loop` as "a build" or "a rebuild" can make it one.
 * `outside-loop` cannot tell those apart - it is a subtraction, so a frame
 * that never arrived and a frame spent in a foreign task look identical in it.
 * A previous ledger read a 31 s `outside-loop` on race's entry as "a volatile
 * world rebuilt"; `beats` on the same record said the thread was idle for the
 * whole 31 s, and race is not volatile.
 */
function printFrames(run, opts = {}) {
  const want = opts.phases ?? null;
  const top = opts.top ?? 6;
  const gaps = (run.gaps ?? [])
    .filter((g) => g.parts && (!want || want.some((w) => String(g.phase).startsWith(w))))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, top);
  if (!gaps.length) return;
  const TOP = ['fixed', 'frame', 'busFlush', 'postfx'];
  const ORDER = ['fixed', 'frame', 'busFlush', 'postfx', 'fx.scene', 'r.render', 'r.matrixWorld',
    'r.cull*', 'r.shadow', 'r.shadowDraw', 'r.draw', 'fx.gtao', 'fx.shafts', 'fx.bloom',
    'fx.grade', 'fx.output', 'fx.smaa', 'fx.film', 'r.compile'];
  console.log('\nthe frames themselves (--frames), worst gaps first');
  for (const g of gaps) {
    const ms = { ...g.parts.ms };
    const n = { ...g.parts.n };
    ms['r.cull*'] = Math.round(((ms['r.render'] ?? 0) - (ms['r.matrixWorld'] ?? 0)
      - (ms['r.shadow'] ?? 0) - (ms['r.draw'] ?? 0)) * 100) / 100;
    const acct = TOP.reduce((a, k) => a + (ms[k] ?? 0), 0);
    console.log(
      `\n  ${g.ms} ms  phase ${g.phase}  dProg ${g.dPrograms} dGeom ${g.dGeometries} dTex ${g.dTextures}`
      + `  blocked ${g.blockedMs} beats ${g.beats}  loop ${Math.round(acct * 10) / 10}`
      + `  outside-loop ${Math.round((g.ms - acct) * 10) / 10}`
      + `  [${ms['#calls'] ?? '-'} calls, ${ms['#tris'] ?? '-'} tris]`,
    );
    const seen = new Set();
    const line = (k) => {
      if (seen.has(k) || ms[k] == null) return;
      seen.add(k);
      if (k !== 'r.cull*' && !(ms[k] >= 0.5)) return;
      console.log(`    ${String(ms[k]).padStart(9)}  x${n[k] ?? '-'}  ${k}`);
    };
    for (const k of ORDER) line(k);
    const rest = Object.keys(ms)
      .filter((k) => !seen.has(k) && !k.startsWith('#') && ms[k] >= 0.5)
      .sort((a, b) => ms[b] - ms[a]);
    for (const k of rest.slice(0, 12)) line(k);
  }
}
/* ---------------------------------------------------------------- */
/* Main                                                              */
/* ---------------------------------------------------------------- */

/* ---------------------------------------------------------------- */
/* THE GATE                                                          */
/* ---------------------------------------------------------------- */

/**
 * WHY THIS GATE DOES NOT ASSERT THE CLOCK.
 *
 * The hardest-won rule in this repository is that a gate measuring something
 * the game does not do is worse than no gate, because it gets believed and then
 * it gets disabled. A CI gate on frame-gap MILLISECONDS would be exactly that:
 *
 *  - An occluded headless window stops delivering animation frames and nothing
 *    else, and is recorded as one enormous frame gap with an idle main thread.
 *    The four Chrome flags above suppress it on this platform; the flags are a
 *    mitigation, not a proof, and `isStarved` exists precisely because it still
 *    happens. Two of the twelve rows in the two baseline runs taken for this
 *    change came back STARVED - race at 2,750 ms and dock at 617 ms - on a
 *    machine with the flags in force. A millisecond gate would have failed on
 *    both, twice, in a workstream that changed neither.
 *  - A shared CI runner is a noisier machine than this one by a wide margin,
 *    and it has no GPU: the SwiftShader software rasteriser's absolute times
 *    have no relationship to a player's.
 *  - Six worlds are over budget TODAY. A clock gate would fail on every push
 *    from the first one, which is a gate that has already been switched off.
 *
 * So the gate asserts the two things that ARE trustworthy across machines:
 *
 *  A. INVARIANTS - did this run measure the game at all, and is the property
 *     each fix bought still in place. No baseline needed, no platform
 *     dependence, and this half gates from the first push. `builtBefore` is the
 *     direct guard on the maze change: put a volatile filter back into
 *     `scheduleBackgroundBuilds` and `entry:maze` reports `builtBefore: false`
 *     and this fails, without anyone having to trust a millisecond.
 *  B. COUNTERS - `dProg` per event and `warm.programs`, against a baseline
 *     recorded for the same platform. Programs are created by three.js from a
 *     cache key, not by the driver, so the count is a property of the SCENE and
 *     travels between machines far better than any time does. The margin is
 *     there for the handful that legitimately move by one.
 *
 * The clock is printed in full either way. It is evidence; it is not a verdict.
 *
 * Add a platform by running `--gate` on it once and pasting the block it
 * prints. Until that block exists the counter half PASSES with a notice and the
 * invariant half still gates - a gate that fails on numbers it has never seen
 * would flake on its first run, which is the same disease by another route.
 */
const BASELINES = {
  /* Recorded 2026-08-25 on Windows 11 / ANGLE-D3D11, production bundle,
   * `--events entry`, worst of the runs taken for that day's change set - the
   * maze background build and the `arrivalKeyOf` fog-key fix both in place.
   *
   * `entry:sports` is 23 and not 45 BECAUSE of that second fix, and it is the
   * one row here worth watching: 23 is not a good number, it is the number
   * that is left after the persistent set stopped being warmed under the wrong
   * fog. Lowering it is the open work; a run that reports 45 again means
   * `arrivalKeyOf` has stopped telling FogExp2 apart from Fog. */
  'win32-angle': {
    recorded: '2026-08-25',
    warmPrograms: 143,
    dProg: {
      'entry:dock': 0,
      'entry:citadel': 0,
      'entry:race': 0,
      'entry:medieval': 2,
      'entry:maze': 3,
      'entry:sports': 23,
    },
  },

  /* Recorded 2026-08-26 from the cold gate's FIRST green run on the GitHub
   * runner (run 32928309409) as 111, and CORRECTED 2026-08-28 to 142. The 111
   * was true of the boot that existed then: a cold run linked only the
   * programs the entry world needed, and the chain would have linked the rest.
   * b9c774e / b0fcd45 (the non-blocking boot warm) began linking the full
   * program set during boot on every platform, so from run 33015236617
   * onward this runner read 142 in every cold gate - the same number the RTX
   * cold base reads (.probe/gaps/stage2-base, 142 x3) - and the gate was red
   * for two days on a baseline that described a boot the game no longer had.
   * The other facts stand: COLD, so no entry events and an empty dProg - the
   * counter this platform actually gates is warmPrograms; the same runs'
   * watchdog counted 5-6 ten-second no-rAF stretches, so this runner starves
   * too - one more reason the clock is printed and never asserted here. */
  'linux-swiftshader': {
    recorded: '2026-08-28',
    warmPrograms: 142,
    dProg: {},
  },
};

/**
 * How far a counter may drift before it is a regression rather than noise.
 *
 * ── warmPrograms is gated in BOTH directions; dProg only upward ───────────
 *
 * They look symmetrical and are not. `dProg` counts programs linked ON ENTRY
 * to a world - the cost paid on the arrival frame - so a fall is the outcome
 * everything here is trying to produce and only a rise is a regression.
 *
 * `warmPrograms` counts what boot linked AHEAD of that. A rise costs boot time
 * and is worth catching. A FALL IS THE EXPENSIVE ONE and was not gated at all
 * until 2026-08-30: a builder that quietly stops warming twenty programs reads
 * as an improvement here, and pays for it on the arrival frame, where this
 * project has lost the number twice before. The spec's own words for it are
 * "the realistic hazard is a drop".
 *
 * The two are not redundant either. A drop in warm with no matching rise in
 * dProg is the worst case of all - the programs are not being linked at boot
 * AND not on entry, which means they are being linked mid-play, in a frame
 * nothing measures.
 */
const GATE_MARGIN = { dProg: 2, warmPrograms: 4 };

/**
 * Compare one run's shader-program counters against a platform baseline.
 *
 * Exported and pure so it can be asserted without a browser. The gate itself
 * needs Chrome, a built bundle and about a minute, which is exactly the sort
 * of gate that gets changed and never re-proven - and this repository's rule
 * is that a gate nobody has watched fail is not yet a gate. The arithmetic is
 * here; `scripts/tests/frame-gaps-program-gate.test.mjs` watches it fail.
 *
 * @param {number} warm programs linked during boot warm
 * @param {Record<string, number>} dProg programs linked on entry, per world
 * @param {{warmPrograms: number, dProg: Record<string, number>}} base
 * @param {string} key platform key, for the messages
 */
export function programGateVerdict(warm, dProg, base, key = 'this platform') {
  const failures = [], notes = [];
  if (warm > base.warmPrograms + GATE_MARGIN.warmPrograms) {
    failures.push(`boot warm linked ${warm} programs against a baseline of ${base.warmPrograms}`
      + ` (+${GATE_MARGIN.warmPrograms} allowed)`);
  }
  /* The lower bound. See GATE_MARGIN: a fall here is not an improvement, it is
   * the link cost moving somewhere nothing is watching. */
  if (warm < base.warmPrograms - GATE_MARGIN.warmPrograms) {
    failures.push(`boot warm linked only ${warm} programs against a baseline of ${base.warmPrograms}`
      + ` (-${GATE_MARGIN.warmPrograms} allowed) - something stopped being warmed at boot.`
      + ` That is not a saving: those programs are linked on the arrival frame instead, or worse,`
      + ` mid-play. If it is deliberate, re-take the baseline and say what stopped warming.`);
  }
  for (const [name, got] of Object.entries(dProg)) {
    const want = base.dProg[name];
    if (want == null) { notes.push(`${name}: no dProg baseline for "${key}"; not asserted.`); continue; }
    if (got > want + GATE_MARGIN.dProg) {
      failures.push(`${name} linked ${got} programs on entry against a baseline of ${want}`
        + ` (+${GATE_MARGIN.dProg} allowed) - a world that was warm is arriving cold`);
    }
  }
  for (const name of Object.keys(base.dProg)) {
    if (!(name in dProg)) notes.push(`${name} is in the baseline and was not measured by this run.`);
  }
  return { failures, notes };
}

/**
 * Metres a movement phase must cover before it is allowed to mean anything.
 *
 * ONE METRE, AND THE NUMBER IS ARGUED RATHER THAN PICKED. What this invariant
 * guards is not "was the traversal a good one" - it is "did the input reach the
 * player at all", which is the failure that produces a flawless 16.8 ms worst
 * frame over eight seconds of nothing. It was set at 3 first, and the very
 * first full run failed on `movement:station` at 2.7 m: no gameplay block, not
 * mounted, no captured keyboard, not dead, from (-31, 0, 5) to (-29, 0, 5). The
 * keys arrived and physics moved the player; the station's spawn is simply
 * hemmed in, and 229 degrees of yaw sweep did not find a way out of it.
 *
 * A gate that fails every run on a world's level design is a gate that gets
 * switched off, and it would have been switched off for the wrong reason: the
 * instrument was working. So the threshold sits where the two cases genuinely
 * separate - zero means the input never landed, non-zero means it did - and the
 * printed table still flags anything under 3 m as the thin traversal it is.
 */
const GATE_MIN_MOVE = 1;

/**
 * Which recorded baseline applies here. The renderer matters as much as the OS:
 * a SwiftShader run and an ANGLE run differ in capability reporting, and
 * capabilities are in the program cache key.
 */
function platformKey() {
  const gl = process.env.FRAME_GAPS_GL === 'swiftshader' ? 'swiftshader' : 'angle';
  return `${process.platform}-${gl}`;
}

/**
 * @param {object} run one `runOnce` result
 * @param {object} args
 * @returns {{ failures: string[], notes: string[], block: object }}
 */
function gateRun(run, args) {
  const failures = [];
  /* What the run noted on its way - a sampler that timed out, a layout row
   * that measured nothing - is printed under the verdict too. A reader of
   * the GATE block alone would otherwise never see it. */
  const notes = [...(run.notes ?? [])];

  /* ---- A. invariants ------------------------------------------------- */
  if (args.awaitReady === false) {
    /* A COLD RUN IS A MODE, NOT A VIOLATION. Measured 2026-08-26: under
     * swiftshader the 18-world background chain built 3 of 17 non-volatile
     * worlds in 40 minutes (~13 min/world - the full chain is HOURS), so a
     * gate that awaits it can never go green on a GPU-less CI runner, and a
     * gate that can never go green gets deleted. `--cold --gate` therefore
     * gates only what needs no chain - boot warm, keybind/weapon/mount,
     * movement, interaction, page errors, counters - and REFUSES to gate
     * entry events, whose builtBefore invariant is meaningless without the
     * chain. Chain-dependent gating stays a local / workflow_dispatch run. */
    notes.push('COLD RUN: the background chain was not awaited; entry events are '
      + 'excluded from gating and world-entry regressions are NOT covered by this run');
    const entries = Object.keys(run.events ?? {}).filter((n) => n.startsWith('entry:'));
    if (entries.length) {
      failures.push(`a cold gate cannot judge entry events, but was given: ${entries.join(', ')}`
        + ' - drop entry/repeat from --events, or drop --cold');
    }
  } else if (run.chainSignal !== 'worlds:all-ready') {
    failures.push(`the background chain was awaited on "${run.chainSignal}" rather than the`
      + ' worlds:all-ready event, so nothing below is known to have been measured after it');
  }
  if (!run.warm || !(run.warm.programs > 0)) {
    failures.push(`boot warm linked ${run.warm?.programs ?? 'no'} programs - the warm did not run`);
  }
  if (run.warm?.timedOut) failures.push('the boot warm TIMED OUT; every figure below is a cold one');
  if (run.pageErrors?.length) {
    failures.push(`${run.pageErrors.length} uncaught page error(s), first: ${run.pageErrors[0]}`);
  }
  if (args.layoutSample && run.layoutSampled !== true) {
    failures.push('the ground sampler never finished on the entry world, so its per-frame cost was'
      + ' not inside the measured window - raise --layout-timeout, or find what stalled it');
  } else if (args.layoutSample && run.layoutWorld !== args.entryWorld) {
    failures.push(`the ground sampler finished on "${run.layoutWorld}", not the entry world`
      + ` "${args.entryWorld}" - the layout row measured some other world's grid`);
  }
  for (const [name, ev] of Object.entries(run.events)) {
    if (!ev) continue;
    if (name.startsWith('entry:') && ev.builtBefore === false) {
      failures.push(`${name} was NOT built when the player entered it - the background chain`
        + ' either skipped this world or had not reached it, and its entry cost is a build');
    }
    if (name.startsWith('movement:')) {
      if (!(ev.moved >= GATE_MIN_MOVE)) {
        const frames = (ev.walkFrames ?? 0) + (ev.sprintFrames ?? 0);
        const why = ev.walkFrames == null
          ? '' // an old report without the counters; say only what is known
          : frames < 30
            ? ` after only ${frames} rendered frame(s) across both holds - the page starved`
              + ' through the extended hold, so the runner, not the game, is the suspect'
            : ` across ${frames} rendered frames and ${ev.escapes ?? '?'} board-clearing`
              + ' Escape(s) - the input genuinely never reached the player';
        failures.push(`${name} moved ${ev.moved} m - the player did not traverse anything,`
          + ` so this phase measured a standing frame under a movement label${why}`);
      }
      if (ev.worldChanged) failures.push(`${name} changed world mid-traversal; it measured a crossing`);
    }
    if (name.startsWith('interaction:') && ev.stuck) {
      failures.push(`${name} left the keyboard captured`
        + (ev.stuckFrames != null
          ? ` across ${ev.stuckFrames} rendered frame(s) after the close`
            + (ev.stuckFrames < 30 ? ' - the runner starved before the game could release it' : '')
          : '')
        + '; every event after it is suspect');
    }
  }

  /* ---- B. counters, against this platform's baseline ------------------ */
  const key = platformKey();
  const base = BASELINES[key];
  const dProg = {};
  for (const [name, ev] of Object.entries(run.events)) {
    if (ev && name.startsWith('entry:')) dProg[name] = ev.dPrograms ?? 0;
  }
  const block = { [key]: { recorded: new Date().toISOString().slice(0, 10), warmPrograms: run.warm?.programs ?? null, dProg } };

  if (!base) {
    notes.push(`no baseline recorded for "${key}"; the counter half of the gate did not run.`);
    notes.push(`paste this into BASELINES in ${path.relative(root, fileURLToPath(import.meta.url))}:`);
    notes.push(JSON.stringify(block, null, 2));
  } else {
    const p = programGateVerdict(run.warm?.programs ?? 0, dProg, base, key);
    failures.push(...p.failures);
    notes.push(...p.notes);
  }

  /* ---- C. the clock, reported and never asserted ---------------------- */
  const rows = summarise(run, args.budget);
  const over = rows.filter((r) => !r.pass);
  const starved = over.filter((r) => r.starved);
  notes.push(`clock (not asserted): ${over.length} row(s) over ${args.budget} ms,`
    + ` of which ${starved.length} STARVED${starved.length ? ` (${starved.map((r) => r.event).join(', ')})` : ''}.`);
  if (run.rafStalls) {
    notes.push(`the page's own watchdog counted ${run.rafStalls} stretch(es) of 10 s with no`
      + ' animation frame; this run was measured through an occluded window.');
  }
  return { failures, notes, block };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return 0; }
  /* `Number(undefined)` is NaN and a NaN deadline is an instant timeout: a
   * `--layout-timeout` left without a value would report the sampler as never
   * finishing, and the gate would fail the game for the flag's typo. */
  if (!(Number.isFinite(args.layoutTimeoutMs) && args.layoutTimeoutMs > 0)) {
    console.error(`--layout-timeout needs a positive number of milliseconds, got "${args.layoutTimeoutMs}"`);
    return 1;
  }
  if (!browserCandidates()[0]) {
    console.error('NO BROWSER FOUND - this harness measured nothing. Set CHROME_PATH.');
    return 1;
  }

  const outDir = path.resolve(root, args.out);
  await mkdir(outDir, { recursive: true });

  let stop = async () => {};
  let pageUrl;
  /* `quality=high` pins the renderer tier the baselines were recorded at:
   * tier detection now reads the GPU string, and a CI runner on SwiftShader
   * would otherwise be measured at `low` - no MSAA, no GTAO, a different
   * program set - against a `warmPrograms` baseline taken at `high`.
   *
   * `prefetch=all` restores the eager background chain, and ONLY when this
   * run waits for it: `worlds:all-ready` is the chain's own signal and world
   * entry is measured after it. `--cold` gets the game's real default - lazy,
   * by-proximity preparation (systems/WorldPrefetch.js) - because "what a
   * player who does not wait actually gets" is now that. */
  const qs = `?dev=1&autostart=1&quality=high&world=${encodeURIComponent(args.entryWorld)}`
    + (args.awaitReady ? '&prefetch=all' : '')
    + (args.layoutSample ? '&layout=sample' : '');

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
  /** @type {Array<{run:number, failures:string[], notes:string[]}>} */
  const gated = [];
  try {
    await waitFor(async () => (await fetch(pageUrl)).ok, { what: `the server at ${pageUrl}` });
    for (let i = 1; i <= args.repeat; i++) {
      console.log(`\n=== run ${i}/${args.repeat} ===`);
      const run = await runOnce(args, pageUrl, i);
      await writeFile(path.join(outDir, `run-${i}.json`), JSON.stringify(run, null, 2));
      const rows = summarise(run, args.budget);
      printTable(rows, args.budget);
      if (run.rafStalls) {
        console.log(`\n!! the page's own watchdog counted ${run.rafStalls} stretch(es) of 10 s with no`
          + ' animation frame. Every STARVED row above is that, and no row is safe to attribute'
          + " to the phase's own work until it reads zero.");
      }
      printCrossings(run);
      printListeners(run);
      printCacheKeys(run);
      if (args.frames) printFrames(run, { phases: ["repeat", "ablated", "entry", "unbound"], top: 10 });
      if (args.gate) gated.push({ run: i, ...gateRun(run, args) });
      runs.push({
        run: i, rows, warm: run.warm,
        layoutSampled: run.layoutSampled === true, layoutWaitMs: run.layoutWaitMs ?? null,
        layoutWorld: run.layoutWorld ?? null, layoutEvent: run.layoutEvent ?? null, notes: run.notes ?? [],
      });
    }
  } finally {
    await stop();
  }

  const summary = {
    serve: args.serve, budget: args.budget, at: new Date().toISOString(), runs,
    /* True only when EVERY run finished sampling, and there was at least one:
     * `[].every()` is true, and `--repeat 0` must not read as a pass. A run
     * that lost the sampler must not be readable as one in which it cost
     * nothing. */
    layoutSampled: args.layoutSample && runs.length > 0 && runs.every((r) => r.layoutSampled === true),
    ...(args.gate ? { gate: gated, platform: platformKey() } : {}),
  };
  await writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\nwrote ${path.join(outDir, 'summary.json')}`);

  if (!args.gate) return 0;
  /* One verdict over every run. A repeat that passes once and fails once has
   * found something, and reporting the last run's answer would hide it. */
  console.log(`\n=== GATE (${platformKey()}) ===`);
  let failed = 0;
  for (const g of gated) {
    for (const n of g.notes) console.log(`  note  run ${g.run}: ${n}`);
    for (const f of g.failures) { failed++; console.log(`  FAIL  run ${g.run}: ${f}`); }
  }
  if (failed) {
    console.log(`\n${failed} gate failure(s). The clock was NOT asserted - see the note on BASELINES.`);
    return 1;
  }
  console.log('\ngate passed. Counters and invariants only; the clock above is evidence, not a verdict.');
  return 0;
}

/* Run only when invoked as a script.
 *
 * This used to be an unconditional call, which made the file unimportable:
 * anything that wanted the gate arithmetic got a browser launch instead. That
 * is why the counter half of this gate had never been unit-tested - not
 * because nobody wanted to, but because importing it started Chrome.
 */
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
}
