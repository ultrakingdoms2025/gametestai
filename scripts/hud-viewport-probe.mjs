/**
 * THE HUD LAYOUT GATE.
 *
 *   node scripts/hud-viewport-probe.mjs [--keep] [--allow-missing-browser]
 *
 * ── Why this is a browser and not a test that reads the stylesheet ────────
 *
 * A CSS test that asserts a rule exists proves nothing about layout. The
 * defects this phase was opened for are all *positions*: a 731 px weapon strip
 * centred on a 390 px screen, a 296 px vitals column and a 220 px minimap
 * that both want the same 186 px, a pause card with a 444 px minimum, 30 px
 * rows under a 44 px thumb. Not one of those is visible in a declaration. They
 * are visible in a rectangle, and only a browser produces rectangles.
 *
 * So this drives real Chrome over the DevTools Protocol against a real Vite
 * dev server on a fresh port, at six viewport configurations, and measures
 * `getBoundingClientRect()` on the real HUD built by the real `HUD.js` with the
 * real stylesheets. See `scripts/harness/hud-viewport.js` for what is and is
 * not real about the page it measures.
 *
 * ── Zero dependencies, on purpose ────────────────────────────────────────
 *
 * This repository has three runtime dependencies and no test framework beyond
 * `node:test`. Node 22 ships a global `WebSocket`, which is the whole of what
 * talking to CDP needs, so the gate adds nothing to `package.json` and cannot
 * rot when a browser-automation library changes its API.
 *
 * ── What it checks ───────────────────────────────────────────────────────
 *
 *   1. NO CLIPPING. `html, body { overflow: hidden }`, so a panel that does not
 *      fit does not scroll - it is silently cut off the edge of the screen and
 *      whatever is on it becomes unreachable. Every visible panel and every
 *      interactive element must lie inside the viewport.
 *   2. NO OVERLAP between interactive elements: two buttons in the same place
 *      means one of them cannot be pressed.
 *   3. NO OVERLAP between the readouts a player reads while playing.
 *   4. TOUCH TARGETS >= 44 CSS px in both axes wherever the primary pointer is
 *      coarse.
 *   5. SAFE AREA. With the four `--sa-*` tokens forced to a real device's
 *      insets, nothing may sit inside the border they describe - and 1 to 4
 *      are then re-run on the inset layout, because a notch does not only
 *      steal the edges: it moves everything anchored to one past everything
 *      anchored to a percentage. See the harness note on why those tokens are
 *      the only fakeable part.
 *   6. Everything in `hud-source-checks.mjs` - the four facts that are not
 *      visible in a rectangle at all. Those also run under `npm test`.
 *
 * Screenshots for every case land in `.probe/hud-viewport/`, and a machine
 * readable report in `.probe/hud-viewport/report.json`.
 */

import { spawn } from 'node:child_process';
import { createServer as createSocketServer } from 'node:net';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

/* Shared with `scripts/tests/hud-responsive.test.mjs`, so the four facts a
 * rectangle cannot carry are also checked by `npm test` - which is what CI
 * runs on every push, and this probe is not. See that file for what they are
 * and why each one is unmeasurable in a browser. */
import { hudSourceChecks as sourceChecks } from './hud-source-checks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, '.probe', 'hud-viewport');
const argv = new Set(process.argv.slice(2));

/* ====================================================================== */
/* The cases                                                              */
/* ====================================================================== */

/**
 * Six viewports. 390x844 is an iPhone 14/15; 844x390 is the same phone turned
 * over, which is the one that runs out of HEIGHT rather than width; 768x1024
 * and 1024x768 are an iPad; 1280x800 is the smallest desktop the shipped
 * layout was ever designed for and is therefore the regression arm.
 */
const VIEWPORTS = [
  { id: 'phone-portrait', w: 390, h: 844, dpr: 3, coarse: true },
  { id: 'phone-landscape', w: 844, h: 390, dpr: 3, coarse: true },
  { id: 'tablet-portrait', w: 768, h: 1024, dpr: 2, coarse: true },
  { id: 'tablet-landscape', w: 1024, h: 768, dpr: 2, coarse: true },
  { id: 'desktop', w: 1280, h: 800, dpr: 1, coarse: false },
  { id: 'desktop-wide', w: 1920, h: 1080, dpr: 1, coarse: false },
];

/** The five states the interface is ever in while a player is looking at it. */
const SCENES = ['play', 'touch', 'pause', 'chat', 'help'];

/**
 * The notch, per orientation.
 *
 * These are an iPhone 14 Pro's own numbers, and they are per-orientation
 * BECAUSE THAT IS HOW DEVICES REPORT THEM: a phone stands the island and the
 * home bar top and bottom in portrait, and moves them to the two long edges
 * when it is turned over. No device reports a large inset on all four edges at
 * once, and an earlier version of this check that forced 44 px on all four was
 * not a stricter test - it was a different, imaginary device, and it was about
 * to cost a landscape tablet its discoveries panel to satisfy a screen that
 * does not exist.
 *
 * Between the two orientations every edge is exercised, which is the point.
 * An iPad's insets are ~20 px on every edge, so a layout that survives these
 * survives that.
 */
const SAFE_AREA = {
  portrait: { t: 59, r: 0, b: 34, l: 0 },
  landscape: { t: 0, r: 59, b: 21, l: 59 },
};

/* ====================================================================== */
/* Finding a browser                                                      */
/* ====================================================================== */

function browserCandidates() {
  const home = os.homedir();
  const out = [];
  if (process.env.CHROME_PATH) out.push(process.env.CHROME_PATH);
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    /* Playwright's cache first: it is the browser this machine actually has,
     * and its version is pinned rather than whatever Chrome auto-updated to. */
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
/* A CDP client, in about eighty lines                                    */
/* ====================================================================== */

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
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { last = e; }
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

/* ====================================================================== */
/* The in-page measurement                                                */
/* ====================================================================== */

/**
 * Runs inside the page. Returns every rectangle the assertions need.
 *
 * Written as a string rather than a function reference because it is evaluated
 * by the browser, not by Node - `Runtime.evaluate` takes source.
 */
const MEASURE = `(() => {
  const vw = window.innerWidth, vh = window.innerHeight;

  /* The panels a player reads or presses. Anything not on this list is either
   * a full-bleed effect layer (veil, vignette, wipe) or a child of something
   * that IS on it. */
  const NAMED = [
    '.vitals', '.credits', '.health', '.stamina', '.questtrack', '.collect',
    '.objectives', '.charter', '.minimap', '.killfeed', '.ammo', '.wstrip',
    '.helpchip', '.mount', '.chat', '.debug', '.toasts', '.prompt', '.stuck',
    '.cammode', '.pause-in', '.help-card', '.pm-root', '.touch-primary',
    '.touch-left', '.touch-tray',
  ];

  /* Exactly the selector \`hud.css\` uses to opt elements back into pointer
   * events, so this set is what a finger can actually hit - not a guess. */
  const INTERACTIVE = '#ui-root button, #ui-root input, #ui-root textarea, #ui-root .interactive';

  /**
   * The rectangle a player can actually see and touch.
   *
   * NOT just \`getBoundingClientRect()\`. The pause hub's list is a scroll
   * container: seventeen items lay out past the bottom of a 390 px screen and
   * their raw rects say so, but the eight below the fold are not on screen,
   * are not pressable, and cannot collide with anything. Reporting them as
   * clipped off the viewport is a gate inventing failures - and, worse,
   * hiding the one real one among them.
   *
   * So the rect is intersected with every clipping ancestor on the way up. An
   * empty intersection means invisible; a partial one is what is left, which
   * is also the correct box for both the overlap and the 44 px checks.
   */
  function clippedRect(el) {
    let r = el.getBoundingClientRect();
    let n = el.parentElement;
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return null;
      if (parseFloat(cs.opacity) < 0.02) return null;
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        const c = n.getBoundingClientRect();
        const left = Math.max(r.left, c.left), top = Math.max(r.top, c.top);
        const right = Math.min(r.right, c.right), bottom = Math.min(r.bottom, c.bottom);
        if (right - left <= 0.5 || bottom - top <= 0.5) return null;
        r = { left, top, right, bottom, width: right - left, height: bottom - top };
      }
      n = n.parentElement;
    }
    const own = getComputedStyle(el);
    if (own.display === 'none' || own.visibility === 'hidden') return null;
    if (parseFloat(own.opacity) < 0.02) return null;
    return r.width > 0.5 && r.height > 0.5 ? r : null;
  }

  const visible = (el) => clippedRect(el) !== null;

  const box = (el, name) => {
    const r = clippedRect(el);
    const own = el.getBoundingClientRect();
    return {
      name,
      left: +r.left.toFixed(2), top: +r.top.toFixed(2),
      right: +r.right.toFixed(2), bottom: +r.bottom.toFixed(2),
      width: +r.width.toFixed(2), height: +r.height.toFixed(2),
      /* The control's OWN size, before any scroll container trimmed it. The
       * 44 px minimum is a question about the control, not about how much of
       * it happens to be scrolled into view: a hub row half-way over the fold
       * is 44 px tall and the player scrolls one flick to reach all of it. */
      ownW: +own.width.toFixed(2), ownH: +own.height.toFixed(2),
    };
  };

  const named = [];
  for (const sel of NAMED) {
    document.querySelectorAll(sel).forEach((el, i) => {
      if (visible(el)) named.push(box(el, i ? sel + '[' + i + ']' : sel));
    });
  }

  const hits = [...document.querySelectorAll(INTERACTIVE)].filter(visible);
  const interactive = hits.map((el, i) => {
    const label = (el.className || el.tagName).toString().trim().split(/\\s+/).slice(0, 2).join('.');
    const b = box(el, '.' + label + '#' + i);
    /* A panel that opts itself into pointer events and then holds its own
     * buttons is not two controls fighting for one place: .chat is
     * .interactive and contains .chat-send. Nesting is recorded here so the
     * overlap assertion can tell containment from collision. */
    b.nested = hits.map((o, j) => (j !== i && (el.contains(o) || o.contains(el)) ? j : -1))
      .filter((j) => j >= 0);
    return b;
  });

  return {
    vw, vh,
    coarse: matchMedia('(pointer: coarse)').matches,
    named, interactive,
    scroll: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
  };
})()`;

/* ====================================================================== */
/* Assertions                                                             */
/* ====================================================================== */

const EPS = 0.75;

/** Elements deliberately allowed to reach an edge or to sit under each other. */
const OVERLAP_EXEMPT = [
  /* The look pad is the whole screen by design; it is not in the interactive
   * selector, but the tray sits ON the touch cluster while it is open and the
   * cluster is what raised it. */
  ['.touch-btn.touch-more', '.touch-tray'],
];

function overlaps(a, b) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > EPS && h > EPS ? { w: +w.toFixed(1), h: +h.toFixed(1) } : null;
}

function exempt(a, b) {
  return OVERLAP_EXEMPT.some(([x, y]) => (a.name.startsWith(x) && b.name.startsWith(y))
    || (a.name.startsWith(y) && b.name.startsWith(x)));
}

/** The pairs the roadmap names, plus the ones that share an edge. */
const READOUT_PAIRS = [
  ['.vitals', '.minimap'],
  ['.vitals', '.ammo'],
  ['.vitals', '.wstrip'],
  ['.minimap', '.ammo'],
  ['.minimap', '.toasts'],
  ['.killfeed', '.ammo'],
  ['.helpchip', '.ammo'],
  ['.helpchip', '.wstrip'],
  ['.ammo', '.wstrip'],
  ['.mount', '.wstrip'],
  ['.chat', '.wstrip'],
  ['.chat', '.ammo'],
  ['.debug', '.minimap'],
  ['.debug', '.wstrip'],
  /* A readout under a thumb cluster is worse than a readout that is missing:
   * the button takes every tap that lands on it, so the panel is unreadable
   * AND the control under it behaves in a way the player cannot see. This is
   * the same failure Phase 5a found from the other side, when the weapon
   * strip was taking the taps meant for the fire button. */
  ['.ammo', '.touch-primary'],
  ['.ammo', '.touch-left'],
  ['.mount', '.touch-primary'],
  ['.mount', '.touch-left'],
  ['.prompt', '.touch-primary'],
  ['.prompt', '.touch-left'],
  ['.killfeed', '.touch-primary'],
  ['.helpchip', '.touch-left'],
  ['.wstrip', '.touch-primary'],
  ['.wstrip', '.touch-left'],
  /* The right-hand column, in the order it stacks below 1024 px. */
  ['.minimap', '.killfeed'],
  ['.ammo', '.killfeed'],
  ['.ammo', '.toasts'],
  ['.killfeed', '.toasts'],
];

function assertCase(m, vp, scene) {
  const fails = [];
  const all = [...m.named, ...m.interactive];

  /* 1. Nothing clipped. */
  for (const b of all) {
    if (b.left < -EPS || b.right > m.vw + EPS) {
      fails.push(`${b.name} is off the side: ${b.left}..${b.right} of ${m.vw}`);
    }
    if (b.top < -EPS || b.bottom > m.vh + EPS) {
      fails.push(`${b.name} is off the top/bottom: ${b.top}..${b.bottom} of ${m.vh}`);
    }
  }

  /* 2. No two interactive elements in the same place. */
  for (let i = 0; i < m.interactive.length; i++) {
    for (let j = i + 1; j < m.interactive.length; j++) {
      const a = m.interactive[i]; const b = m.interactive[j];
      if (a.nested?.includes(j) || exempt(a, b)) continue;
      const o = overlaps(a, b);
      if (o) fails.push(`${a.name} and ${b.name} overlap by ${o.w}x${o.h}px — one cannot be pressed`);
    }
  }

  /* 3. The readouts a player reads while playing. */
  const by = new Map(m.named.map((b) => [b.name, b]));
  for (const [x, y] of READOUT_PAIRS) {
    const a = by.get(x); const b = by.get(y);
    if (!a || !b) continue;
    const o = overlaps(a, b);
    if (o) fails.push(`${x} and ${y} overlap by ${o.w}x${o.h}px`);
  }

  /* 4. Touch targets. */
  if (vp.coarse) {
    if (!m.coarse) fails.push('the page does not report a coarse pointer — the emulation is not taking');
    for (const b of m.interactive) {
      if (b.ownW < 44 - EPS || b.ownH < 44 - EPS) {
        fails.push(`${b.name} is ${b.ownW}x${b.ownH}px, under the 44px touch minimum`);
      }
    }
  }

  return fails.map((f) => `[${vp.id}/${scene}] ${f}`);
}

/* ====================================================================== */
/* Source-level checks that a headless browser cannot make                */
/* ====================================================================== */



/* ====================================================================== */
/* Main                                                                   */
/* ====================================================================== */

async function main() {
  const chrome = browserCandidates()[0];
  if (!chrome) {
    const msg = 'NO BROWSER FOUND — this gate measured nothing.\n'
      + 'Set CHROME_PATH, or install Chrome / Chromium.';
    if (argv.has('--allow-missing-browser')) { console.warn(msg); return 0; }
    console.error(msg);
    return 1;
  }
  console.log(`browser: ${chrome}`);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  /* ---- the dev server, on a port nothing else is holding ---------------
   * A stale server on a remembered port has previously made correct work in
   * this repository look broken. The port is taken from the OS every run. */
  const vitePort = await freePort();
  /* Vite's JS API rather than a spawned CLI: Node refuses to spawn a `.cmd`
   * without a shell on Windows, a git worktree has no `node_modules` of its
   * own (resolution walks up to the checkout's), and in-process means there is
   * no window in which the port is taken but the server is not yet listening. */
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    root,
    configFile: path.join(root, 'vite.config.js'),
    logLevel: 'error',
    server: { port: vitePort, strictPort: true, host: '127.0.0.1' },
  });
  await vite.listen();

  /* `vite.config.js` sets `base: '/game/'`, so the dev server does NOT serve
   * the tree at the root. Read the resolved base rather than assuming either
   * value - a harness URL that 404s presents as a silent timeout. */
  const viteBase = vite.config.base ?? '/';
  const base = `http://127.0.0.1:${vitePort}`;
  const harnessUrl = `${base}${viteBase}scripts/harness/hud-viewport.html`.replace(/([^:])\/\//g, '$1/');

  const cdpPort = await freePort();
  const userDir = path.join(os.tmpdir(), `an-hud-probe-${process.pid}`);
  const browser = spawn(chrome, [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--hide-scrollbars', '--mute-audio', '--disable-extensions',
    '--force-device-scale-factor=1',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  browser.stderr.on('data', () => { /* chrome is noisy on stderr; ignore */ });

  const failures = [];
  const report = { browser: chrome, base: harnessUrl, cases: [] };
  let client;

  try {
    await waitFor(async () => (await fetch(harnessUrl)).ok,
      { what: `the harness page at ${harnessUrl}` });

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

    /* The page's console, kept for the current case only. A harness that fails
     * to boot is otherwise a bare timeout with nothing to read. */
    let pageLog = [];
    client.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args ?? [])
          .map((a) => a.value ?? a.description ?? a.type).join(' ');
        pageLog.push(`${msg.params.type}: ${text}`);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        pageLog.push(`exception: ${d.exception?.description ?? d.text}`);
      }
    });
    const withLog = (e) => new Error(`${e.message}\n--- page console ---\n${pageLog.join('\n') || '(silent)'}`);

    for (const vp of VIEWPORTS) {
      await call('Emulation.setDeviceMetricsOverride', {
        width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.coarse,
        screenWidth: vp.w, screenHeight: vp.h,
      });
      /* `pointer: coarse` follows the emulated media, not the device metrics.
       * Chrome honours arbitrary feature names here; the assertion above reads
       * `matchMedia` back out of the page so a version that stops honouring it
       * fails loudly instead of quietly grading a desktop layout. */
      await call('Emulation.setEmulatedMedia', {
        features: vp.coarse
          ? [{ name: 'pointer', value: 'coarse' }, { name: 'any-pointer', value: 'coarse' },
            { name: 'hover', value: 'none' }, { name: 'any-hover', value: 'none' }]
          : [{ name: 'pointer', value: 'fine' }, { name: 'any-pointer', value: 'fine' },
            { name: 'hover', value: 'hover' }, { name: 'any-hover', value: 'hover' }],
      });
      /* `maxTouchPoints` must be 1..16 even when the flag is off - CDP rejects
       * 0 outright rather than reading it as "none". */
      await call('Emulation.setTouchEmulationEnabled', {
        enabled: vp.coarse, maxTouchPoints: 5,
      });

      /* The touch layer is raised by `input:touchmode` and by nothing else, so
       * a fine-pointer desktop never has it on screen. Grading a scene the
       * game cannot enter is exactly the shape of gate this project keeps
       * paying for. */
      for (const scene of SCENES.filter((s) => s !== 'touch' || vp.coarse)) {
        /* A fresh document per case. The HUD latches state - `_goLive`,
         * `_onboardDone`, the toast queue - and a case that inherited the
         * previous one's would be measuring history. */
        pageLog = [];
        await call('Page.navigate', { url: harnessUrl });
        await waitFor(async () => {
          const r = await call('Runtime.evaluate', {
            expression: "document.documentElement.dataset.harness === 'ready'",
            returnByValue: true,
          });
          return r.result?.value === true;
        }, { what: `the harness at ${vp.id}/${scene}`, timeout: 60000 })
          .catch((e) => { throw withLog(e); });

        await call('Runtime.evaluate', {
          expression: `window.__harness.scene(${JSON.stringify(scene)})`,
          awaitPromise: true, returnByValue: true,
        });
        /* One frame for the class-driven transitions to settle. */
        await sleep(120);

        const res = await call('Runtime.evaluate', { expression: MEASURE, returnByValue: true });
        if (res.exceptionDetails) {
          throw new Error(`measurement threw at ${vp.id}/${scene}: ${res.exceptionDetails.text}`);
        }
        const m = res.result.value;
        const caseFails = assertCase(m, vp, scene);

        /* ---- safe area ------------------------------------------------
         *
         * A notch is a rectangle you may not draw in, so that is what is
         * asserted: force all four insets to a real length and every panel,
         * every button and every readout must be INSIDE the remaining box.
         *
         * Not "did it move by 44 px", which was the first version of this
         * check and was wrong: a panel that is anchored to the top does not
         * move its bottom edge, and a two-column stack whose anchor changes
         * with the breakpoint would need the assertion to know the design.
         * The inset rectangle needs to know nothing. */
        if (vp.coarse) {
          const inset = SAFE_AREA[vp.h > vp.w ? 'portrait' : 'landscape'];
          await call('Runtime.evaluate', {
            expression: `window.__harness.setSafeArea(${JSON.stringify(inset)})`,
            returnByValue: true,
          });
          await sleep(60);
          const after = (await call('Runtime.evaluate', { expression: MEASURE, returnByValue: true }))
            .result.value;
          for (const b of [...after.named, ...after.interactive]) {
            const out = [];
            if (b.left < inset.l - EPS) out.push(`${(inset.l - b.left).toFixed(1)}px into the left`);
            if (b.top < inset.t - EPS) out.push(`${(inset.t - b.top).toFixed(1)}px into the top`);
            if (b.right > after.vw - inset.r + EPS) out.push(`${(b.right - after.vw + inset.r).toFixed(1)}px into the right`);
            if (b.bottom > after.vh - inset.b + EPS) out.push(`${(b.bottom - after.vh + inset.b).toFixed(1)}px into the bottom`);
            if (out.length) {
              caseFails.push(`[${vp.id}/${scene}] ${b.name} sits under the safe area: ${out.join(', ')}`);
            }
          }
          /* And every other assertion again, on the inset layout.
           *
           * A notch does not only steal the edges - it moves everything that
           * is anchored to one, past everything that is anchored to a
           * PERCENTAGE. The interaction prompt sits at 27% of the height and
           * the thumb cluster sits 1rem above the home bar: with no inset
           * they clear each other by 13 px, and with a real one the cluster
           * comes up 34 px and lands on the prompt. Checking only the inset
           * rectangle would have called that layout clean. */
          caseFails.push(...assertCase(after, vp, `${scene}+safe-area`));
          await call('Runtime.evaluate', {
            expression: 'window.__harness.setSafeArea(null)', returnByValue: true,
          });
        }

        const shot = await call('Page.captureScreenshot', { format: 'png' });
        await writeFile(path.join(outDir, `${vp.id}-${scene}.png`), Buffer.from(shot.data, 'base64'));

        report.cases.push({
          viewport: vp.id, scene, vw: m.vw, vh: m.vh, coarse: m.coarse,
          named: m.named, interactive: m.interactive, failures: caseFails,
        });
        failures.push(...caseFails);
        process.stdout.write(caseFails.length ? 'x' : '.');
      }
    }
    process.stdout.write('\n');

    const src = await sourceChecks();
    report.source = src;
    failures.push(...src.map((f) => `[source] ${f}`));
  } finally {
    client?.close();
    browser.kill();
    await vite.close().catch(() => {});
    if (!argv.has('--keep')) await rm(userDir, { recursive: true, force: true }).catch(() => {});
  }

  report.failures = failures;
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

  if (failures.length) {
    console.error(`\n${failures.length} layout failures:\n`);
    for (const f of failures) console.error(`  ${f}`);
    console.error(`\nscreenshots + report: ${path.relative(root, outDir)}`);
    return 1;
  }
  console.log(`\nHUD layout OK across ${VIEWPORTS.length} viewports x ${SCENES.length} scenes.`);
  console.log(`screenshots: ${path.relative(root, outDir)}`);
  return 0;
}

process.exitCode = await main();
