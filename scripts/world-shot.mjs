/**
 * THE ART-PASS EVIDENCE HARNESS.
 *
 *   node scripts/world-shot.mjs --world medieval --out .probe/art-medieval/before
 *   node scripts/world-shot.mjs --world medieval --views village-square,castle-gate
 *   node scripts/world-shot.mjs --world medieval --compare .probe/art-medieval/before
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * Phase 9's method line is "never assess art by reading code - screenshot it",
 * and the Phase 6 pass proved it: three defects (hands bound across the
 * centreline, heads a third too small, a palette that chopped a silhouette
 * into three) were all invisible in source and all obvious in a shot. Phase 9
 * runs nine times, so the shot harness is written once, in `scripts/`, rather
 * than nine times in a `.probe/` directory that dies with its worktree.
 *
 * It is also the BUDGET GATE. Phase 9 is "the one most likely to regress
 * production frame time", so the same run that takes the picture takes the
 * numbers - draw calls, triangles, materials and, above all, **shader program
 * count**, which is the one this project has a documented history of losing.
 * A picture with no number beside it is half the evidence.
 *
 * ── Zero dependencies, deliberately ──────────────────────────────────────
 *
 * Copied in shape from `scripts/hud-viewport-probe.mjs`, which drives real
 * Chrome over CDP with Node 22's global `WebSocket` and adds nothing to
 * `package.json`. A second browser-automation dependency would be a second
 * thing to rot. Vite is started through its JS API for the reason that file
 * records: a git worktree has no `node_modules` of its own, Node will not
 * spawn a `.cmd` without a shell on Windows, and in-process leaves no window
 * where the port is taken but the server is not yet listening.
 *
 * ── What it measures, and the trap it avoids ─────────────────────────────
 *
 * `HARNESS.ready()` is called with `drive: true` (its default) ON PURPOSE. An
 * automated browser holds no pointer lock, `main.js` blocks its whole gameplay
 * update block without one, and every LOD system in the game therefore stops.
 * Figures taken in that state are the LOD-disabled worst case and have misled
 * this repository before. `report.json` records `gameplayDriven` next to every
 * measurement so a run that lost it cannot be read as a run that did not.
 *
 * Triangles are taken from `HARNESS.worldTriangles()`, not `renderer.info`:
 * the deterministic walk of the active world's group reproduces exactly, while
 * `renderer.info.triangles` sums the shadow and GTAO passes and moved 10-13%
 * between loads of an identical framing. Both are recorded; only the first is
 * compared.
 *
 * Output: `<out>/<view>.png` per view, plus `<out>/report.json`.
 * With `--compare <dir>`, a previous report is diffed into the console table
 * and into `<out>/diff.json`, which is the before/after this phase reports.
 */

import { spawn } from 'node:child_process';
import { createServer as createSocketServer } from 'node:net';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
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
    world: 'medieval', views: null, out: null, compare: null, ablate: null,
    subjects: null, dist: 7, rise: 1.6,
    width: 1600, height: 900, settle: 14, keep: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--world') out.world = next();
    else if (a === '--views') out.views = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--out') out.out = next();
    else if (a === '--compare') out.compare = next();
    else if (a === '--width') out.width = Number(next());
    else if (a === '--height') out.height = Number(next());
    else if (a === '--settle') out.settle = Number(next());
    else if (a === '--ablate') out.ablate = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--subject') (out.subjects ??= []).push(next());
    else if (a === '--dist') out.dist = Number(next());
    else if (a === '--rise') out.rise = Number(next());
    else if (a === '--keep') out.keep = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  out.out ??= path.join('.probe', 'world-shot', out.world);
  return out;
}

/* ---------------------------------------------------------------- */
/* Finding a browser - same candidate list as the HUD probe          */
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
/* A CDP client, in about eighty lines                               */
/* ---------------------------------------------------------------- */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
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
/* The in-page measurement                                           */
/* ---------------------------------------------------------------- */

/**
 * Runs inside the page, once per view, after the camera has settled.
 *
 * `programs` is the number this phase is gated on. It is read from
 * `renderer.info.programs.length` - the live cache - rather than from the
 * sampled `engine.stats`, which is resampled about once a second and would
 * hand back the previous view's value to an A/B that flipped something and
 * read straight back. That exact mistake produced self-contradicting tables in
 * this repo before, which is why `Harness.stats()` carries the same warning.
 *
 * `materials` counts DISTINCT material instances reachable from the active
 * world's group, which is the figure Phase 9's budget is about: a new material
 * is a candidate new program, and a shared one is free. `renderables` counts
 * the meshes those materials are spread across, because the ratio between the
 * two is the whole "merged by material vs. spatially partitioned" question -
 * citadel is 48 renderables to 168 draws, sports is 112 materials to 334
 * meshes, and medieval is neither until it is counted.
 */
const MEASURE = `(() => {
  const H = window.HARNESS;
  const G = window.GAME;
  const renderer = G.engine.renderer;
  const world = G.worldManager.active;
  const mats = new Set();
  const matNames = new Map();
  let renderables = 0, instanced = 0, instances = 0, lights = 0, litLights = 0;
  world?.group?.traverse((o) => {
    if (o.isLight) { lights++; if (o.visible && (o.intensity ?? 0) > 0) litLights++; }
    if (!o.isMesh && !o.isPoints && !o.isLine && !o.isSprite) return;
    renderables++;
    if (o.isInstancedMesh) { instanced++; instances += o.count; }
    const m = o.material;
    for (const mm of (Array.isArray(m) ? m : [m])) {
      if (!mm) continue;
      mats.add(mm.uuid);
      const key = mm.name || mm.type;
      matNames.set(key, (matNames.get(key) ?? 0) + 1);
    }
  });
  const stats = H.stats();
  const tri = H.worldTriangles({ breakdown: true, top: 14 });
  return {
    /* WHICH WORLD IS THIS ACTUALLY A PICTURE OF.
     *
     * Not a formality. VIEWS.sports' entrance-portal stands behind the
     * gateway, the harness's own player teleport is a plane-side crossing, and
     * Portals._autoEnter fires - so that row reported 225 materials and 3.1 M
     * triangles as SPORTS'. Every figure below belongs to whatever world this
     * says, and world-shot refuses a row whose world is not the one asked for
     * rather than filing it under the wrong heading. */
    world: world?.id ?? null,
    gameplayDriven: stats.gameplayDriven,
    /* Is the game finished booting? A force-draw makes every geometry figure
     * below the whole world instead of the shot. See Harness.settleBoot. */
    rehearsalInForce: stats.rehearsalInForce,
    bootWarmRunning: stats.bootWarmRunning,
    unculledMeshes: stats.unculledMeshes,
    /* The sun's shadow camera is a 120 m box fitted around the PLAYER, not
     * around the render camera. A framing whose camera is a long way from the
     * player is a framing whose shadow map covers somewhere else, and its
     * shadow cost is a measurement of that other place. */
    cameraToPlayer: stats.cameraToPlayer,
    frameValidity: H.frameValidity(),
    drawCalls: stats.drawCalls,
    rendererTriangles: stats.triangles,
    worldTriangles: tri.triangles,
    byMaterial: tri.byMaterial,
    byName: tri.byName,
    programs: renderer.info.programs ? renderer.info.programs.length : null,
    geometries: renderer.info.memory.geometries,
    textures: renderer.info.memory.textures,
    materials: mats.size,
    materialNames: [...matNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20),
    renderables,
    instancedMeshes: instanced,
    instances,
    worldLights: lights,
    worldLightsLit: litLights,
    npcs: stats.npcs,
    fps: stats.sampled.fps,
    frameMsMedian: stats.sampled.frameMsMedian,
    errors: (H.errors || []).slice(0, 8),
  };
})()`;

/* ---------------------------------------------------------------- */
/* Main                                                              */
/* ---------------------------------------------------------------- */

const HELP = `world-shot - screenshots and the render budget for one world

  --world <id>       world to enter (default: medieval)
  --views a,b,c      subset of HARNESS.viewNames(world); default is all of them
  --out <dir>        output directory (default: .probe/world-shot/<world>)
  --compare <dir>    diff this run's report.json against a previous one
  --ablate a,b       hide every mesh drawn with these material NAMES, then shoot.
                     The A/B that tells you which system owns a pixel: shoot
                     once normally, once with a system switched off, and the
                     difference is the answer. Reading the source is not.
                     The hiding is HELD against anything that re-shows it, and
                     every framing reports how many drawn triangles the
                     ablation actually removed FROM THAT FRAMING. A run in
                     which no framing lost anything FAILS: the system was never
                     in shot, so "nothing changed" is not a result about it.
  --subject "name=<js>"  frame a live object instead of a fixed vantage. The
                     expression runs in the page and returns {x,y,z} - e.g.
                     "wolf=GAME.npcManager.npcs.find(n=>n.species==='wolf').position".
                     The named views are all landscape framings; a character or
                     a beast has to be photographed where it happens to be
                     standing, and it moves, so it cannot be a fixed vantage.
  --dist <m>         subject framing: camera distance, default 7
  --rise <m>         subject framing: camera height above the subject, default 1.6
  --width/--height   viewport, default 1600x900
  --settle <frames>  frames to settle at each view before the shot (default 14)
  --keep             leave the chrome profile directory behind
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return 0; }

  const chrome = browserCandidates()[0];
  if (!chrome) {
    console.error('NO BROWSER FOUND - this harness measured nothing.\nSet CHROME_PATH, or install Chrome / Chromium.');
    return 1;
  }
  console.log(`browser: ${chrome}`);

  const outDir = path.resolve(root, args.out);
  await mkdir(outDir, { recursive: true });

  const vitePort = await freePort();
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    root,
    configFile: path.join(root, 'vite.config.js'),
    logLevel: 'error',
    server: { port: vitePort, strictPort: true, host: '127.0.0.1' },
  });
  await vite.listen();
  const viteBase = vite.config.base ?? '/';
  const pageUrl = `http://127.0.0.1:${vitePort}${viteBase}index.html?dev=1&autostart=1&world=${encodeURIComponent(args.world)}`
    .replace(/([^:])\/\//g, '$1/');

  const cdpPort = await freePort();
  const userDir = path.join(os.tmpdir(), `an-world-shot-${process.pid}`);
  const browser = spawn(chrome, [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDir}`,
    '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--mute-audio', '--disable-extensions',
    '--force-device-scale-factor=1',
    /* ---- THE FLAG THAT DECIDES WHETHER THIS FINISHES ------------------
     *
     * Headless Chrome will happily hand WebGL a SwiftShader context, and it
     * renders correctly - it just renders a 1.3 M-triangle world with a GTAO
     * prepass at something like a frame a minute. Measured: forcing
     * `--use-angle=swiftshader` on this machine burned 15 minutes of CPU on
     * the medieval boot and had not reached the first view. That is not a slow
     * harness, it is a harness nobody will run, and a screenshot gate nobody
     * runs is the same as no gate.
     *
     * So ANGLE is left on its platform default (D3D11 on Windows, the real
     * GPU) and headless is asked to keep the GPU rather than fall back.
     * `--enable-unsafe-swiftshader` stays as the LAST resort: on a machine
     * with no usable GPU, recent Chrome refuses a software GL context to
     * WebGL unless it is set, and the failure mode is a black canvas rather
     * than an error - the worst possible shape for a harness whose whole
     * product is a picture. Slow beats blank; blank beats nothing at all.
     * Override with WORLD_SHOT_GL=swiftshader when a run must be reproducible
     * across machines rather than fast. */
    ...(process.env.WORLD_SHOT_GL === 'swiftshader'
      ? ['--use-angle=swiftshader']
      : ['--use-angle=default', '--enable-gpu-rasterization', '--ignore-gpu-blocklist']),
    '--enable-unsafe-swiftshader',
    `--window-size=${args.width},${args.height}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  browser.stderr.on('data', () => { /* chrome is noisy on stderr */ });

  const report = {
    world: args.world, browser: chrome, url: pageUrl,
    viewport: { width: args.width, height: args.height },
    at: new Date().toISOString(),
    views: {},
  };
  let client;
  let code = 0;

  try {
    await waitFor(async () => (await fetch(pageUrl)).ok, { what: `the dev server at ${pageUrl}` });
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

    const pageLog = [];
    client.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ');
        pageLog.push(`${msg.params.type}: ${text}`);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        pageLog.push(`exception: ${d.exception?.description ?? d.text}`);
      }
    });
    const evaluate = async (expression, { awaitPromise = false } = {}) => {
      const r = await call('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
      if (r.exceptionDetails) {
        throw new Error(`${r.exceptionDetails.text}: ${r.exceptionDetails.exception?.description ?? ''}`);
      }
      return r.result?.value;
    };

    await call('Page.navigate', { url: pageUrl });
    await waitFor(() => evaluate('!!(window.HARNESS && window.GAME && window.GAME.worldManager)'),
      { what: 'window.HARNESS', timeout: 240000 })
      .catch((e) => { throw new Error(`${e.message}\n--- page console ---\n${pageLog.slice(-40).join('\n') || '(silent)'}`); });

    const bootWorld = await evaluate('window.HARNESS.ready({ timeoutMs: 240000 })', { awaitPromise: true });
    console.log(`ready: world "${bootWorld}"`);
    if (bootWorld !== args.world) {
      console.log(`goto: ${args.world}`);
      await evaluate(`window.HARNESS.goto(${JSON.stringify(args.world)})`, { awaitPromise: true });
    }
    /* The HUD is not the subject and its panels sit over the corners the art
     * lives in. `dismissBoot` is separate: `autostart=1` clicks through the
     * gate, but a run that lost that race would otherwise photograph a splash
     * screen and report it as a world. */
    await evaluate('window.HARNESS.dismissBoot(); window.HARNESS.hideHud(true); true');
    /* Which GL is actually behind the canvas, recorded next to every number.
     * Not a curiosity: a run that silently fell back to SwiftShader takes
     * fifteen minutes to reach its first view and its frame times mean
     * nothing, and the only symptom is that it is slow - which reads as "the
     * world is heavy", the exact wrong conclusion for a budget gate. */
    report.renderer = await evaluate(`(() => {
      const gl = window.GAME.engine.renderer.getContext();
      const d = gl.getExtension('WEBGL_debug_renderer_info');
      return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    })()`);
    console.log(`gl: ${report.renderer}`);
    if (/swiftshader|software/i.test(report.renderer ?? '')) {
      console.warn('WARNING: software GL - frame times from this run are not comparable to a real device.');
    }

    const driven = await evaluate('window.HARNESS.gameplayDriven');
    if (!driven) {
      console.warn('WARNING: gameplay is NOT driven - every figure below is the LOD-disabled worst case.');
    }
    report.gameplayDriven = driven;

    /* The boot warm, and whether this run waited it out.
     *
     * `HARNESS.ready()` used to return as soon as the world was activated,
     * which `boot()` does BEFORE the shader warm. Measured headless on sports:
     * `ready()` at 95.9 s, `[boot] playable` at 172.0 s, background program
     * warm still linking at 250 s - so every framing below used to be taken
     * during the boot. Recorded next to the numbers because the two things it
     * changes are the two things this harness reports: `rehearse()` holds the
     * whole world force-drawn (783,008 triangles over 334 objects with none
     * culled, against a settled 768,782 over 225 with 109 culled) and the
     * background warm moves `programs` by hundreds. @see src/dev/Harness.js */
    report.warm = await evaluate('window.HARNESS.stats().warm');
    if (report.warm && report.warm.programsSettled === false) {
      console.warn('WARNING: the shader program cache was still growing when measuring started - `programs` below is a moving number.');
    }

    if (args.ablate?.length) {
      /* THE ABLATION IS NO LONGER A HIT COUNT.
       *
       * It used to be: traverse, match the material name, `visible = false`,
       * print how many meshes were touched. That reported "2 mesh(es) hidden"
       * on a run where `rehearse()`'s `forceDrawable` restore put both of them
       * straight back, and the table that followed was of an unablated world.
       * Four Phase 9 branches cite an ablation taken that way as evidence.
       *
       * `HARNESS.ablate` HOLDS the hiding against anything that re-shows it,
       * and `HARNESS.ablationCheck()` is asked at every framing for the one
       * number that makes an ablation evidence at all: how many triangles the
       * hidden meshes would be drawing in THIS frame. A framing that loses
       * nothing proves nothing about the system, and a RUN that loses nothing
       * anywhere is not an experiment - it fails below rather than printing a
       * table of unchanged numbers. @see src/dev/Harness.js `ablate` */
      const abl = await evaluate(`window.HARNESS.ablate(${JSON.stringify(args.ablate)})`);
      report.ablated = args.ablate;
      report.ablation = abl;
      report.ablatedMeshes = abl.meshes;
      console.log(`ablated: ${args.ablate.join(', ')} - ${abl.meshes} mesh(es) held hidden`);
      if (abl.missing.length) {
        throw new Error(
          `--ablate matched no material named ${abl.missing.map((n) => `"${n}"`).join(', ')} in "${args.world}".\n`
          + 'Material names are the merge labels; run without --ablate and read `materialNames` out of report.json.'
        );
      }
      if (!abl.meshes) throw new Error(`--ablate matched no material in "${args.world}" - check the name`);
    }

    const all = await evaluate(`window.HARNESS.viewNames(${JSON.stringify(args.world)})`);
    /* `--views none` is not a typo guard hole: a subject run photographs a
     * beast and nothing else, and paying four minutes for seven landscape
     * framings it will not look at is how a harness stops being run. */
    const views = args.views?.length === 1 && args.views[0] === 'none' ? [] : (args.views ?? all);
    const unknown = views.filter((v) => !all.includes(v));
    if (unknown.length) {
      throw new Error(`no such view(s) in "${args.world}": ${unknown.join(', ')} (have: ${all.join(', ')})`);
    }
    console.log(`views: ${views.join(', ')}`);

    /* ── ONE FRAMING MUST NOT COST THE RUN ITS REPORT ────────────────────
     *
     * `VIEWS.maze`'s `lift-car` is computed, and 40% of maze seeds have no
     * resident lift at the entrance for it to find - so `view()` throws at
     * framing 4 of 5, the throw escaped to the outer catch, and `report.json`
     * was never written. Four framings' worth of measurements were thrown away
     * to report one framing's failure.
     *
     * So a framing that fails is now RECORDED as failed and the run carries
     * on. The failures are re-raised at the end, after the report is on disk:
     * the run still fails - loudly, with every framing's error in the console
     * and in `report.json` - and the evidence survives it. */
    const viewErrors = [];
    const ablationSeen = [];
    for (const view of views) {
      try {
        const placed = await evaluate(`window.HARNESS.view(${JSON.stringify(view)}, { settle: ${args.settle} })`, { awaitPromise: true });
        /* Settle in wall-clock too: the world's own LOD bands, the residency
         * systems and the grass all step on their own schedules, and a shot
         * taken the frame the camera arrives catches them mid-band. */
        await sleep(1500);
        const m = await evaluate(MEASURE);
        /* `keepPlayer` framings (the maze's `above-entrance`, its `tower-top`)
         * deliberately leave the player elsewhere, so only the framings that
         * asked for the player are held to standing where the camera is. */
        m.expectPlayerAtCamera = placed?.playerMoved === true;
        report.views[view] = m;
        const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        await writeFile(path.join(outDir, `${view}.png`), Buffer.from(shot.data, 'base64'));
        console.log(
          `  ${view.padEnd(18)} draws ${String(m.drawCalls).padStart(5)}  `
          + `tris ${String(m.worldTriangles).padStart(9)}  mats ${String(m.materials).padStart(4)}  `
          + `progs ${String(m.programs).padStart(4)}  meshes ${String(m.renderables).padStart(5)}`
        );
        checkFrame(view, m, args, viewErrors);
        if (args.ablate?.length) {
          const chk = await evaluate('window.HARNESS.ablationCheck()');
          m.ablation = chk;
          ablationSeen.push({ view, ...chk });
          checkAblation(view, chk, viewErrors);
          console.log(
            `  ${''.padEnd(18)} ablation removes ${String(chk.removedTriangles).padStart(8)} tris from this framing`
            + (chk.reasserted ? `  (re-hidden ${chk.reasserted}x - something keeps re-showing it)` : '')
          );
        }
      } catch (e) {
        const msg = e.message ?? String(e);
        viewErrors.push(`${view}: ${msg}`);
        report.views[view] = { error: msg };
        console.error(`  ${view.padEnd(18)} FAILED: ${msg}`);
        /* A framing that entered a gateway leaves the run standing in another
         * world, and every framing after it would photograph that one. Go back
         * before the next row rather than filing five more under the wrong
         * heading. */
        const now = await evaluate('window.GAME.worldManager.active?.id ?? null').catch(() => null);
        if (now && now !== args.world) {
          console.error(`  ${''.padEnd(18)} ... the active world is now "${now}" - returning to "${args.world}"`);
          await evaluate(`window.HARNESS.goto(${JSON.stringify(args.world)})`, { awaitPromise: true }).catch(() => {});
        }
      }
    }

    /* ---- subject framings -------------------------------------------
     *
     * `HARNESS.look` rather than `HARNESS.view`: the preset views are
     * landscape vantages chosen once and written into the harness, and no
     * preset can point at something that walks. A beast is wherever its pack
     * happened to wander, so the framing has to be computed from the subject
     * at shot time or the picture is of an empty field.
     *
     * Three headings each. A quadruped read from one angle is the angle that
     * happened to work; the profile, the three-quarter and the front are three
     * different silhouettes and an art pass has to see all of them - the Phase
     * 6 head-scale defect was invisible in profile and unmissable head-on. */
    for (const spec of args.subjects ?? []) {
      const eq = spec.indexOf('=');
      const name = eq > 0 ? spec.slice(0, eq) : 'subject';
      const expr = eq > 0 ? spec.slice(eq + 1) : spec;
      let at = await evaluate(`(() => { const p = (${expr}); return p ? {x:p.x, y:p.y, z:p.z} : null; })()`);
      if (!at) { console.warn(`  ${name}: no subject - expression returned null`); continue; }

      /* Walk the PLAYER to the subject before photographing it, and only then
       * re-read where it is.
       *
       * Both halves are load-bearing. NPC and beast detail is banded on
       * distance to the player, so a camera flown to a subject 300 m from the
       * player photographs the lowest LOD in the game and reports it as the
       * art. And the subject is alive: by the time the player arrives a wolf
       * has noticed them and moved, so the position read a second ago frames
       * empty grass. Then freeze, so three headings are three headings of the
       * same pose rather than of three different moments. */
      await evaluate(`window.HARNESS.look([${at.x + args.dist},${at.y + args.rise},${at.z}], [${at.x},${at.y},${at.z}], 45, { settle: 8 })`,
        { awaitPromise: true });
      /* Five seconds, not one. A world that streams its cast on a residency
       * timer does not produce the subject on the frame the player arrives,
       * and the failure is silent: the expression falls back to whatever it
       * fell back to the first time and the shot is of an empty field. */
      await sleep(5000);
      at = await evaluate(`(() => { const p = (${expr}); return p ? {x:p.x, y:p.y, z:p.z} : null; })()`) ?? at;
      await evaluate('window.HARNESS.freezeAll(true); true');

      /* ── THE PLAYER COMES TO EVERY HEADING, NOT JUST THE FIRST ──────────
       *
       * These three used to pass `movePlayer: false`, and only the `profile`
       * heading happened to coincide with the vantage the player had been
       * walked to - so two of every three subject rows were taken with the
       * player standing somewhere else. Two things are wrong with that and
       * both are in this harness's own docstrings already:
       *
       *  - the sun's shadow camera is a 120 m box fitted around the PLAYER, so
       *    those two rows report the shadow cost of the ground the player is
       *    on rather than of the subject in shot (`_vantage`'s own header);
       *  - anything a world places against the player - and `space` places its
       *    1,920 m sky dome and every `Backdrop` body against the CAMERA,
       *    measured, but nothing guarantees the next world will - is then
       *    de-centred by the whole stand-off.
       *
       * `freezeAll(true)` is already in force, so moving the player is one
       * teleport with the engine paused: it cannot disturb the pose the three
       * headings are of. `pinPlayer` drops the mannequin and keeps its shadow
       * (`avatar.harnessShadowOnly`), so the body does not walk into the shot.
       * `frameValidity()` and the `cameraToPlayer` check below then hold the
       * result rather than trusting this comment. */
      for (const [tag, angle] of [['profile', Math.PI / 2], ['three-quarter', Math.PI * 0.78], ['front', Math.PI]]) {
        const cx = at.x + Math.sin(angle) * args.dist;
        const cz = at.z + Math.cos(angle) * args.dist;
        await evaluate(
          `window.HARNESS.look([${cx},${at.y + args.rise},${cz}], [${at.x},${at.y + 0.5},${at.z}], 45, `
          + `{ settle: ${args.settle} })`,
          { awaitPromise: true }
        );
        await sleep(900);
        const m = await evaluate(MEASURE);
        m.expectPlayerAtCamera = true;
        const key = `${name}-${tag}`;
        report.views[key] = { ...m, subjectAt: at };
        const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        await writeFile(path.join(outDir, `${key}.png`), Buffer.from(shot.data, 'base64'));
        console.log(`  ${key.padEnd(24)} at ${at.x.toFixed(1)},${at.y.toFixed(1)},${at.z.toFixed(1)}  draws ${m.drawCalls}  tris ${m.worldTriangles}`);
        checkFrame(key, m, args, viewErrors);
      }
      await evaluate('window.HARNESS.freezeAll(false); true');
    }

    /* ---- the ablation's verdict, and it is a verdict ------------------
     *
     * An ablation that removed no drawn triangles from ANY framing is not a
     * negative result, it is a failed experiment: the system was never in
     * shot, so "the numbers did not move" says nothing whatever about it.
     * That is exactly what happened when `--ablate sports.grass.field` moved a
     * crop's mean luma by 0.00 - and what was reported was the 0.00.
     *
     * The per-framing figure is in each row, so a reviewer can also see WHICH
     * framings the ablation was an experiment in and which it was not. */
    if (args.ablate?.length && ablationSeen.length) {
      const best = Math.max(...ablationSeen.map((r) => r.removedTriangles ?? 0));
      const touched = ablationSeen.filter((r) => (r.removedTriangles ?? 0) > 0).map((r) => r.view);
      report.ablationVerdict = { best, framingsTouched: touched, framingsMeasured: ablationSeen.length };
      const reasserted = ablationSeen.reduce((n, r) => n + (r.reasserted ?? 0), 0);
      if (reasserted) {
        report.ablationVerdict.reasserted = reasserted;
        console.warn(
          `WARNING: something re-showed the ablated meshes ${reasserted} time(s) and the harness overruled it. `
          + 'The pictures are right; the world is fighting the ablation.'
        );
      }
      if (best === 0) {
        viewErrors.push(
          `--ablate ${args.ablate.join(',')}: removed 0 drawn triangles from every one of the `
          + `${ablationSeen.length} framing(s) measured. Nothing in this run is evidence about that system - `
          + 'it was never in shot. Pick a framing that sees it, or a material that is drawn.'
        );
      } else {
        console.log(`ablation removed up to ${best} triangles, in ${touched.length}/${ablationSeen.length} framings: ${touched.join(', ')}`);
      }
    }

    report.viewErrors = viewErrors;
    report.pageLog = pageLog.slice(-60);
    await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`\nwrote ${path.join(outDir, 'report.json')}`);

    if (args.compare) {
      const prev = JSON.parse(await readFile(path.resolve(root, args.compare, 'report.json'), 'utf8'));
      const diff = compare(prev, report);
      await writeFile(path.join(outDir, 'diff.json'), JSON.stringify(diff, null, 2));
      printDiff(diff);
    }

    /* Last, and only after the evidence is on disk. A run that fails still has
     * to leave its measurements behind - the alternative is what `lift-car`
     * did to the maze, which was to throw away four good framings in order to
     * report the fifth one's failure. */
    if (viewErrors.length) {
      throw new Error(
        `${viewErrors.length} framing(s) in "${args.world}" did not measure what they claim to:\n  `
        + viewErrors.join('\n  ')
      );
    }
  } catch (e) {
    console.error(e.stack ?? String(e));
    code = 1;
  } finally {
    client?.close();
    browser.kill();
    await vite.close();
    if (!args.keep) await rm(userDir, { recursive: true, force: true }).catch(() => {});
  }
  return code;
}

/* ---------------------------------------------------------------- */
/* What makes a row worth printing                                   */
/* ---------------------------------------------------------------- */

/** How far a framing's camera may sit from the player before the shadow map is about somewhere else. */
const SHADOW_BOX_SLACK = 8;

/**
 * Refuse a measurement that is about something other than what was asked for.
 *
 * Every check here is a row that WAS printed, in a table where every other
 * number was real, and read as evidence:
 *
 *   `world`            `VIEWS.sports`' `entrance-portal` stands behind the
 *                      gateway and the harness's own player teleport crosses
 *                      it, so `Portals._autoEnter` fired: 225 materials and
 *                      3.1 M triangles of STATION were filed under sports.
 *   `rehearsalInForce` boot's shader warm still had the world force-drawn,
 *                      so nothing was culled and the figure was the whole
 *                      world rather than the shot.
 *   `cameraToPlayer`   the sun's shadow camera is a 120 m box on the PLAYER.
 *                      A camera left behind measures the shadow cost of the
 *                      slab the player is standing on, not of the shot.
 *   `frameValidity`    a camera-relative backdrop that got left behind. The
 *                      numbers do not move and the picture is broken.
 */
function checkFrame(view, m, args, errors) {
  if (m.world && m.world !== args.world) {
    errors.push(`${view}: photographed world "${m.world}", not "${args.world}" - this framing left the world it claims to measure`);
  }
  if (m.rehearsalInForce) {
    errors.push(`${view}: ${m.rehearsalInForce} force-draw(s) were up - every geometry figure in this row is the whole world, not the shot`);
  }
  if (m.frameValidity && m.frameValidity.ok === false) {
    errors.push(`${view}: ${m.frameValidity.problems.join('; ')}`);
  }
  if (m.expectPlayerAtCamera && m.cameraToPlayer !== null && m.cameraToPlayer > SHADOW_BOX_SLACK) {
    errors.push(`${view}: the player is ${m.cameraToPlayer} m from the camera - the sun's shadow box is over there, not here`);
  }
}

/** Refuse an ablation that is no longer in force, or that never was. */
function checkAblation(view, chk, errors) {
  if (!chk.active) { errors.push(`${view}: the ablation is not in force any more`); return; }
  if (chk.stillDrawn.length) {
    errors.push(
      `${view}: the ablation is NOT holding - ${chk.stillDrawn.map((b) => `${b.key} still draws ${b.triangles} triangles across ${b.objects} object(s)`).join('; ')}`
    );
  }
  if (chk.detachedMeshes) {
    errors.push(`${view}: ${chk.detachedMeshes} ablated mesh(es) are no longer under the active world group - the world was rebuilt and this ablation is of the old one`);
  }
  if (chk.worldChanged) {
    errors.push(`${view}: the world is "${chk.world}" now and the ablation was applied in a different one - it is not in force here`);
  }
}

const KEYS = ['drawCalls', 'worldTriangles', 'materials', 'programs', 'renderables', 'instancedMeshes', 'worldLights'];

function compare(before, after) {
  const rows = [];
  for (const view of Object.keys(after.views)) {
    const b = before.views[view];
    const a = after.views[view];
    if (!b) { rows.push({ view, note: 'new view - no before' }); continue; }
    const row = { view };
    for (const k of KEYS) row[k] = { before: b[k], after: a[k], delta: (a[k] ?? 0) - (b[k] ?? 0) };
    rows.push(row);
  }
  return { world: after.world, before: before.at, after: after.at, rows };
}

function printDiff(diff) {
  console.log(`\nbefore/after - ${diff.world}`);
  for (const row of diff.rows) {
    if (row.note) { console.log(`  ${row.view}: ${row.note}`); continue; }
    console.log(`  ${row.view}`);
    for (const k of KEYS) {
      const c = row[k];
      const sign = c.delta > 0 ? '+' : '';
      console.log(`    ${k.padEnd(16)} ${String(c.before).padStart(9)} -> ${String(c.after).padStart(9)}  ${sign}${c.delta}`);
    }
  }
}

/* The refusal rules are exported and the run is gated on being the entry
 * point, so `scripts/tests/harness-ablation.test.mjs` can drive them directly.
 * A rule that decides whether a measurement is publishable is itself a thing
 * that can be wrong, and the only way to find out is to test it - which is not
 * possible if importing this file boots Chrome. */
export { checkFrame, checkAblation, SHADOW_BOX_SLACK };

const entry = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entry && entry === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(await main());
}
