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
    gl: false, listeners: false, frames: false,
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
    /* `--floor` was documented from the first version of this script and never
     * reached the page: the recorder carried a hard-coded 24 and every run that
     * passed the flag silently got 24 anyway. It is the knob that decides which
     * frames carry a `--frames` breakdown, so it had to start working before any
     * of that could be read. */
    await call('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => { const set = () => { if (window.__FG) window.__FG.floor = ${args.floor};`
        + ` else setTimeout(set, 0); }; set(); })()`,
    });
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
      printCrossings(run);
      printListeners(run);
      printCacheKeys(run);
      if (args.frames) printFrames(run, { phases: ["repeat", "ablated", "entry", "unbound"], top: 10 });
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
