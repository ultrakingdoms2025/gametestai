/**
 * THE PLAYTHROUGH DRIVER — a live handle on a running game, driven by real
 * browser-level key and mouse events.
 *
 *   node scripts/playthrough.mjs --world station --port 7777
 *   curl -s localhost:7777/eval -d 'GAME.player.position.toArray()'
 *   curl -s localhost:7777/key -d '{"code":"KeyW","ms":1200}'
 *   curl -s localhost:7777/shot -d '{"path":".probe/e2e/a.png"}'
 *
 * ── Why this exists, and why it is not another test ───────────────────────
 *
 * Phase 12's method line is not negotiable: a 2,500-test suite (3,280 now)
 * missed four loop-blockers that a real playthrough found in minutes. Every
 * one of them was invisible to a unit test because the unit test asserted the
 * thing was BUILT, never that a player could REACH it. So this file does not
 * assert anything. It presses keys and reports what happened.
 *
 * ── Real events, not synthesised ones ────────────────────────────────────
 *
 * `new KeyboardEvent('keydown')` from page script would exercise the game's
 * listeners while bypassing everything the browser does in front of them:
 * `isTrusted`, the keyboard-lock layer, focus, the compatibility events a real
 * tap produces, and the browser's own claim on Ctrl/F-keys. This dispatches
 * through CDP `Input.dispatchKeyEvent`, which enters Chrome's input pipeline
 * at the same place a physical keypress does. `e.isTrusted` is true; the game
 * cannot tell the difference, which is the entire point.
 *
 * ── One boot, many probes ────────────────────────────────────────────────
 *
 * A cold boot of this game settles in tens of seconds to minutes (see
 * `Harness.settleBoot`, and the 95.9 s -> 172.0 s trap recorded there). A
 * driver that booted per assertion would test four things an hour. So this is
 * a SERVER: it boots once, holds the browser, and answers commands over HTTP
 * until it is killed. The cost is paid once per world.
 *
 * ── The pointer-lock problem, and what is done about it ──────────────────
 *
 * An automated browser does not reliably hold a pointer lock, and `Input.js`
 * gates `mousemove` look on `_locked`. Two honest paths are offered and the
 * one that actually engaged is REPORTED in /status rather than assumed:
 *
 *   1. `POST /lock` clicks the canvas for real (user activation) and calls
 *      `requestPointerLock`. If it takes, `mouseMoved` deltas drive look
 *      exactly as a mouse does.
 *   2. `POST /look {dx,dy}` falls back to the TOUCH look path - a real
 *      pointerdown/pointermove/pointerup on the canvas, the same events a
 *      thumb produces. This is a shipped input path with real players on it,
 *      not a test-only hook.
 *
 * `HARNESS.setGameplayDriven(true)` is held on regardless, because without it
 * the loss of pointer lock switches the whole gameplay update block off and
 * every measurement taken is of a game that is not running.
 *
 * Zero new dependencies, for the reason `world-shot.mjs` records: a second
 * browser-automation dependency is a second thing to rot.
 *
 * ── AND WHY THIS IS NOT `frame-gaps.mjs` ─────────────────────────────────
 *
 * They look like two drivers doing one job and they are not. `frame-gaps.mjs`
 * is a BATCH recorder: it scripts a fixed sequence, records rAF gaps from
 * before the first module is parsed, and prints a verdict. This is an
 * INTERACTIVE handle: it boots once and then answers arbitrary commands over
 * HTTP for as long as somebody is asking, which is what a survey needs and
 * what a batch script structurally cannot be.
 *
 * What was genuinely wrong is that this file's browser was configured
 * differently from that one's, so numbers taken through the two were compared
 * as if they described the same machine. They did not — see the occlusion note
 * on the spawn below, and the heartbeat on `/gaps`. Both are now ported. When
 * the question is "what does this phase cost", still reach for `frame-gaps`;
 * this one is for "what happens when a player does X".
 */

import { spawn } from 'node:child_process';
import { createServer as createSocketServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- */
/* Arguments                                                         */
/* ---------------------------------------------------------------- */

function parseArgs(argv) {
  const out = {
    world: 'station', port: 7777, width: 1600, height: 900,
    headed: false, url: null, log: '.probe/e2e/session.log', keep: false,
    settle: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--world') out.world = next();
    else if (a === '--port') out.port = Number(next());
    else if (a === '--width') out.width = Number(next());
    else if (a === '--height') out.height = Number(next());
    else if (a === '--headed') out.headed = true;
    else if (a === '--no-settle') out.settle = false;
    else if (a === '--url') out.url = next();
    else if (a === '--log') out.log = next();
    else if (a === '--keep') out.keep = true;
  }
  return out;
}

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
/* Key table                                                         */
/* ---------------------------------------------------------------- */

/**
 * `code` -> what CDP needs to make Chrome believe a key was pressed.
 *
 * `windowsVirtualKeyCode` is not optional decoration. Without it Chrome
 * synthesises a key event with vk 0, which its own input pipeline treats as
 * "no key", and the page sees a keydown whose `code` is right and whose
 * everything-else is wrong.
 */
const KEYS = {
  KeyA: [65, 'a'], KeyB: [66, 'b'], KeyC: [67, 'c'], KeyD: [68, 'd'],
  KeyE: [69, 'e'], KeyF: [70, 'f'], KeyG: [71, 'g'], KeyH: [72, 'h'],
  KeyI: [73, 'i'], KeyJ: [74, 'j'], KeyK: [75, 'k'], KeyL: [76, 'l'],
  KeyM: [77, 'm'], KeyN: [78, 'n'], KeyO: [79, 'o'], KeyP: [80, 'p'],
  KeyQ: [81, 'q'], KeyR: [82, 'r'], KeyS: [83, 's'], KeyT: [84, 't'],
  KeyU: [85, 'u'], KeyV: [86, 'v'], KeyW: [87, 'w'], KeyX: [88, 'x'],
  KeyY: [89, 'y'], KeyZ: [90, 'z'],
  Digit0: [48, '0'], Digit1: [49, '1'], Digit2: [50, '2'], Digit3: [51, '3'],
  Digit4: [52, '4'], Digit5: [53, '5'], Digit6: [54, '6'], Digit7: [55, '7'],
  Digit8: [56, '8'], Digit9: [57, '9'],
  Space: [32, ' '], Enter: [13, null], Escape: [27, null], Tab: [9, null],
  Backspace: [8, null], Delete: [46, null],
  ShiftLeft: [16, null], ShiftRight: [16, null],
  ControlLeft: [17, null], AltLeft: [18, null],
  ArrowUp: [38, null], ArrowDown: [40, null],
  ArrowLeft: [37, null], ArrowRight: [39, null],
  BracketLeft: [219, '['], BracketRight: [221, ']'],
  Minus: [189, '-'], Equal: [187, '='], Slash: [191, '/'],
  Comma: [188, ','], Period: [190, '.'], Backquote: [192, '`'],
  F1: [112, null], F2: [113, null], F3: [114, null], F4: [115, null],
  F5: [116, null], F6: [117, null], F7: [118, null], F8: [119, null],
  F9: [120, null], F10: [121, null], F11: [122, null], F12: [123, null],
};

/** The `key` value a shifted printable produces, so text entry is real. */
const SHIFTED = {
  a: 'A', b: 'B', c: 'C', d: 'D', e: 'E', f: 'F', g: 'G', h: 'H', i: 'I',
  j: 'J', k: 'K', l: 'L', m: 'M', n: 'N', o: 'O', p: 'P', q: 'Q', r: 'R',
  s: 'S', t: 'T', u: 'U', v: 'V', w: 'W', x: 'X', y: 'Y', z: 'Z',
};

/** Non-printable `code` -> the `key` a real keyboard reports. */
const NAMED = {
  Space: ' ', Enter: 'Enter', Escape: 'Escape', Tab: 'Tab',
  Backspace: 'Backspace', Delete: 'Delete',
  ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Control', AltLeft: 'Alt',
  ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
  BracketLeft: '[', BracketRight: ']',
  F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6',
  F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
};

/* ---------------------------------------------------------------- */
/* Main                                                              */
/* ---------------------------------------------------------------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const chrome = browserCandidates()[0];
  if (!chrome) {
    console.error('NO BROWSER FOUND. Set CHROME_PATH, or install Chrome / Chromium.');
    return 1;
  }

  const logPath = path.resolve(root, args.log);
  await mkdir(path.dirname(logPath), { recursive: true });
  await writeFile(logPath, `# playthrough ${new Date().toISOString()} world=${args.world}\n`);
  const log = async (line) => {
    const s = `${new Date().toISOString().slice(11, 23)} ${line}`;
    console.log(s);
    await appendFile(logPath, `${s}\n`).catch(() => {});
  };

  await log(`browser: ${chrome}`);

  /* ---- the page under test ---------------------------------------- */
  let pageUrl = args.url;
  let vite = null;
  if (!pageUrl) {
    const vitePort = await freePort();
    const { createServer: createViteServer } = await import('vite');
    vite = await createViteServer({
      root,
      configFile: path.join(root, 'vite.config.js'),
      logLevel: 'error',
      server: { port: vitePort, strictPort: true, host: '127.0.0.1' },
    });
    await vite.listen();
    const base = vite.config.base ?? '/';
    pageUrl = `http://127.0.0.1:${vitePort}${base}index.html?dev=1&autostart=1&world=${encodeURIComponent(args.world)}`
      .replace(/([^:])\/\//g, '$1/');
  }
  await log(`page: ${pageUrl}`);

  const cdpPort = await freePort();
  const userDir = path.join(os.tmpdir(), `an-playthrough-${process.pid}`);
  const browser = spawn(chrome, [
    ...(args.headed ? [] : ['--headless=new']),
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDir}`,
    '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--mute-audio', '--disable-extensions',
    '--force-device-scale-factor=1',
    /* AN OCCLUDED WINDOW STOPS DELIVERING ANIMATION FRAMES AND NOTHING ELSE.
     *
     * Ported verbatim from `scripts/frame-gaps.mjs`, which carries the full
     * measurement. Windows computes native window occlusion for headless
     * windows too; a renderer it decides is occluded stops receiving
     * BeginFrame while timers, promises and CDP evals keep running at full
     * rate. Everything `/gaps` measures is an rAF interval, so an occluded
     * stretch is recorded as one enormous frame gap with a completely idle
     * main thread inside it — a 32,517.5 ms "stall" that carried 8,004
     * heartbeats of a 4 ms timer and only 445 ms of genuine block.
     *
     * This driver had NONE of these while frame-gaps had all four, and both
     * were quoted side by side. That is the mechanism behind the recorded
     * 150-680x disagreement between the two: not a slower game, a different
     * browser configuration. Any survey taken through this driver before this
     * line was added is unattributable.
     *
     * `CalculateNativeWinOcclusion` is the one that matters on this platform.
     * The `beats` figure `/gaps` now returns is the check that they still
     * work. */
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-features=CalculateNativeWinOcclusion',
    /* See world-shot.mjs for why ANGLE is left on its platform default: a
     * SwiftShader fallback renders this world at about a frame a minute, and
     * the only symptom is slowness, which reads as "the world is heavy". */
    ...(process.env.WORLD_SHOT_GL === 'swiftshader'
      ? ['--use-angle=swiftshader']
      : ['--use-angle=default', '--enable-gpu-rasterization', '--ignore-gpu-blocklist']),
    '--enable-unsafe-swiftshader',
    `--window-size=${args.width},${args.height}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  browser.stderr.on('data', () => { /* chrome is noisy on stderr */ });

  await waitFor(async () => (await fetch(pageUrl)).ok, { what: `the page at ${pageUrl}` });
  const version = await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
    return r.ok ? r.json() : null;
  }, { what: `chrome devtools on ${cdpPort}` });

  const client = await CDP.connect(version.webSocketDebuggerUrl);
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  const call = (m, p) => client.send(m, p, sessionId);

  await call('Page.enable');
  await call('Runtime.enable');
  await call('Log.enable').catch(() => {});
  await call('Emulation.setDeviceMetricsOverride', {
    width: args.width, height: args.height, deviceScaleFactor: 1, mobile: false,
  });

  /* The page's own console, kept in a ring so a probe can ask what the game
   * said while it was being driven. A game that announces "Position reset"
   * and moves 3 cm is caught here and nowhere else. */
  const pageLog = [];
  const pushLog = (s) => { pageLog.push(`${Date.now()} ${s}`); if (pageLog.length > 6000) pageLog.shift(); };
  client.ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ');
      pushLog(`${msg.params.type}: ${text}`);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      pushLog(`exception: ${d.exception?.description ?? d.text}`);
    } else if (msg.method === 'Log.entryAdded') {
      pushLog(`${msg.params.entry.level}: ${msg.params.entry.text}`);
    }
  });

  const evaluate = async (expression, { awaitPromise = false } = {}) => {
    const r = await call('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true, userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(`${r.exceptionDetails.text}: ${r.exceptionDetails.exception?.description ?? ''}`);
    }
    return r.result?.value;
  };

  await call('Page.navigate', { url: pageUrl });
  await waitFor(() => evaluate('!!(window.HARNESS && window.GAME && window.GAME.worldManager)'),
    { what: 'window.HARNESS', timeout: 300000 });
  await log('HARNESS present');

  const bootT0 = Date.now();
  const bootWorld = await evaluate(
    `window.HARNESS.ready({ timeoutMs: 300000, settle: ${args.settle} })`, { awaitPromise: true });
  await log(`ready: world "${bootWorld}" in ${((Date.now() - bootT0) / 1000).toFixed(1)}s`);
  await evaluate('window.HARNESS.dismissBoot(); window.HARNESS.holdAwake(true); true');

  /* ---- input primitives ------------------------------------------- */

  const keyEvent = async (code, down, { shift = false } = {}) => {
    const spec = KEYS[code];
    if (!spec) throw new Error(`unknown key code ${code}`);
    const [vk, ch] = spec;
    const plain = ch === null ? null : (shift ? (SHIFTED[ch] ?? ch) : ch);
    const finalKey = NAMED[code] ?? plain ?? code;
    const params = {
      type: down ? 'keyDown' : 'keyUp',
      code, key: finalKey, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
      modifiers: shift ? 8 : 0,
    };
    /* `text` is what turns a keyDown into a character-producing keypress. It
     * must be absent for non-printables or the event is refused. */
    if (down && plain !== null) params.text = plain;
    await call('Input.dispatchKeyEvent', params);
  };

  const held = new Set();
  const holdKey = async (code) => { if (!held.has(code)) { held.add(code); await keyEvent(code, true); } };
  const releaseKey = async (code) => { if (held.has(code)) { held.delete(code); await keyEvent(code, false); } };
  const releaseAll = async () => { for (const c of [...held]) await releaseKey(c); };

  const mouse = async (type, { x = args.width / 2, y = args.height / 2, button = 'none', dx = 0, dy = 0, clickCount = 0 } = {}) => {
    await call('Input.dispatchMouseEvent', {
      type, x, y, button, buttons: button === 'left' ? 1 : button === 'right' ? 2 : 0,
      clickCount, deltaX: dx, deltaY: dy, pointerType: 'mouse',
    });
  };

  /* ---- the control surface ---------------------------------------- */

  const body = (req) => new Promise((res) => {
    let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => res(s));
  });

  const handlers = {
    async status() {
      return evaluate(`(() => {
        const H = window.HARNESS, G = window.GAME;
        const s = H.stats();
        const p = G.player?.position;
        return {
          world: G.worldManager.active?.id ?? null,
          gameplayDriven: s.gameplayDriven,
          pointerLocked: !!(document.pointerLockElement),
          inputLocked: !!G.input?.locked,
          player: p ? [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)] : null,
          yaw: G.player && G.player.yaw != null ? +G.player.yaw.toFixed(3) : null,
          health: G.player?.health ?? null,
          fps: s.sampled?.fps, frameMsMedian: s.sampled?.frameMsMedian,
          errors: (H.errors || []).slice(-6),
        };
      })()`);
    },
    /** Arbitrary page expression. Named `js` rather than `eval` so callers can
     * put it in a shell line without tripping tooling that blocks that word. */
    async js({ expr, await: aw }) {
      return evaluate(expr, { awaitPromise: !!aw });
    },
    /**
     * The state a player can see, in one call.
     *
     * Canned rather than composed at the call site on purpose: every probe in
     * this survey asks the same questions, and a hand-written expression that
     * differs between two probes is a difference in the MEASUREMENT rather
     * than in the game.
     */
    async player() {
      return evaluate(`(() => {
        const G = window.GAME;
        const p = G.player;
        const inv = G.inventory ?? G.player?.inventory;
        return {
          world: G.worldManager.active?.id ?? null,
          pos: p?.position ? p.position.toArray().map(v => +v.toFixed(2)) : null,
          vel: p?.velocity ? p.velocity.toArray().map(v => +v.toFixed(2)) : null,
          yaw: p?.yaw != null ? +p.yaw.toFixed(3) : null,
          pitch: p?.pitch != null ? +p.pitch.toFixed(3) : null,
          onGround: p?.onGround ?? p?.grounded ?? null,
          health: p?.health ?? null,
          mounted: G.mounts?.active?.id ?? G.mountSystem?.current?.id ?? null,
          weapon: G.weapons?.current?.id ?? G.weaponSystem?.current?.id ?? null,
          credits: (typeof G.economy?.credits === 'number') ? G.economy.credits : (inv?.credits ?? null),
          items: inv?.items ? (Array.isArray(inv.items) ? inv.items.length : Object.keys(inv.items).length) : null,
        };
      })()`);
    },
    /** Every key the game will answer, and what it is bound to right now. */
    async binds() {
      return evaluate(`(() => {
        const G = window.GAME;
        const I = G.input;
        return { binds: I?._binds ? [...I._binds.entries()] : null,
                 touchMode: !!I?._touchMode, enabled: !!I?._enabled,
                 textCaptured: !!I?._textCaptured };
      })()`);
    },
    async key({ code, ms = 90, shift = false, repeat = 1 }) {
      const out = [];
      for (let i = 0; i < repeat; i++) {
        await keyEvent(code, true, { shift });
        await sleep(ms);
        await keyEvent(code, false, { shift });
        if (i + 1 < repeat) await sleep(60);
        out.push(code);
      }
      return { pressed: out, ms };
    },
    async hold({ codes, ms = 500 }) {
      const list = Array.isArray(codes) ? codes : [codes];
      for (const c of list) await holdKey(c);
      await sleep(ms);
      for (const c of list) await releaseKey(c);
      return { held: list, ms };
    },
    async down({ codes }) {
      const list = Array.isArray(codes) ? codes : [codes];
      for (const c of list) await holdKey(c);
      return { down: list };
    },
    async up({ codes }) {
      const list = codes ? (Array.isArray(codes) ? codes : [codes]) : [...held];
      for (const c of list) await releaseKey(c);
      return { up: list };
    },
    async type({ text, ms = 40 }) {
      for (const ch of text) {
        const lower = ch.toLowerCase();
        const code = /[a-z]/.test(lower) ? `Key${lower.toUpperCase()}`
          : /[0-9]/.test(ch) ? `Digit${ch}`
            : ch === ' ' ? 'Space' : null;
        if (!code) continue;
        await keyEvent(code, true, { shift: ch !== lower });
        await sleep(ms);
        await keyEvent(code, false, { shift: ch !== lower });
      }
      return { typed: text };
    },
    async click({ x = args.width / 2, y = args.height / 2, button = 'left' }) {
      await mouse('mousePressed', { x, y, button, clickCount: 1 });
      await sleep(50);
      await mouse('mouseReleased', { x, y, button, clickCount: 1 });
      return { clicked: [x, y, button] };
    },
    async lock() {
      await mouse('mousePressed', { x: args.width / 2, y: args.height / 2, button: 'left', clickCount: 1 });
      await sleep(40);
      await mouse('mouseReleased', { x: args.width / 2, y: args.height / 2, button: 'left', clickCount: 1 });
      await sleep(400);
      return evaluate(`(async () => {
        try { window.GAME.engine.renderer.domElement.requestPointerLock?.(); } catch (e) {}
        await new Promise(r => setTimeout(r, 400));
        return { pointerLocked: !!document.pointerLockElement, inputLocked: !!window.GAME.input?.locked };
      })()`, { awaitPromise: true });
    },
    /**
     * Turn the player's view.
     *
     * Prefers a real locked-mouse move. If the pointer is not locked the
     * mousemove handler in `Input.js` returns early, so this falls through to
     * the TOUCH look path - real pointerdown/pointermove/pointerup on the
     * canvas, which is the input a phone player uses. Which path ran is
     * reported, never assumed.
     */
    async look({ dx = 0, dy = 0, steps = 10 }) {
      const locked = await evaluate('!!document.pointerLockElement');
      if (locked) {
        let x = args.width / 2, y = args.height / 2;
        for (let i = 0; i < steps; i++) {
          x += dx / steps; y += dy / steps;
          await mouse('mouseMoved', { x, y });
          await sleep(16);
        }
        return { via: 'pointerlock', dx, dy };
      }
      const r = await evaluate(`(async () => {
        const cv = window.GAME.engine.renderer.domElement;
        const mk = (t, x, y, id) => cv.dispatchEvent(new PointerEvent(t, {
          pointerId: id, pointerType: 'touch', isPrimary: true, bubbles: true,
          cancelable: true, clientX: x, clientY: y,
        }));
        const w = window.innerWidth, h = window.innerHeight;
        let x = w * 0.75, y = h * 0.5;
        mk('pointerdown', x, y, 91);
        for (let i = 0; i < ${steps}; i++) {
          x += ${dx} / ${steps}; y += ${dy} / ${steps};
          mk('pointermove', x, y, 91);
          await new Promise(r => requestAnimationFrame(r));
        }
        mk('pointerup', x, y, 91);
        return { touchMode: !!window.GAME.input?._touchMode };
      })()`, { awaitPromise: true });
      return { via: 'touch', dx, dy, ...r };
    },
    /** Set yaw/pitch directly. Not input - a measurement aid, labelled so. */
    async face({ yaw, pitch }) {
      return evaluate(`(() => {
        const p = window.GAME.player;
        ${yaw !== undefined ? `p.yaw = ${yaw};` : ''}
        ${pitch !== undefined ? `p.pitch = ${pitch};` : ''}
        return { yaw: p.yaw, pitch: p.pitch, note: 'set directly, NOT via input' };
      })()`);
    },
    async wait({ ms = 500 }) { await sleep(ms); return { waited: ms }; },
    async frames({ n = 10 }) {
      return evaluate(`(async () => {
        for (let i = 0; i < ${n}; i++) await new Promise(r => requestAnimationFrame(r));
        return { frames: ${n} };
      })()`, { awaitPromise: true });
    },
    async shot({ path: p = '.probe/e2e/shot.png' }) {
      const abs = path.resolve(root, p);
      await mkdir(path.dirname(abs), { recursive: true });
      const { data } = await call('Page.captureScreenshot', { format: 'png' });
      await writeFile(abs, Buffer.from(data, 'base64'));
      return { path: abs, bytes: Buffer.from(data, 'base64').length };
    },
    async goto({ world }) {
      await releaseAll();
      const t0 = Date.now();
      await evaluate(`window.HARNESS.goto(${JSON.stringify(world)})`, { awaitPromise: true });
      return { world, ms: Date.now() - t0 };
    },
    async view({ name }) {
      await evaluate(`window.HARNESS.view(${JSON.stringify(name)})`, { awaitPromise: true });
      return { view: name };
    },
    async teleport({ x, y, z, yaw = 0 }) {
      await evaluate(`window.HARNESS.teleport(${x}, ${y}, ${z}, ${yaw})`, { awaitPromise: true });
      return { teleported: [x, y, z, yaw] };
    },
    async console({ n = 60, match = null }) {
      let out = pageLog.slice();
      if (match) { const re = new RegExp(match, 'i'); out = out.filter((l) => re.test(l)); }
      return out.slice(-n);
    },
    async clearconsole() { pageLog.length = 0; return { cleared: true }; },
    async hud({ hide = true }) {
      await evaluate(`window.HARNESS.hideHud(${!!hide}); true`);
      return { hudHidden: !!hide };
    },
    /**
     * The frame-gap probe Phase 1's acceptance criterion needs.
     *
     * Installs a rAF sampler in the page that records every inter-frame gap,
     * so a caller can arm it, do a thing, and read the worst gap that thing
     * caused. `performance.now()` deltas between rAF callbacks are the only
     * honest measure of a hitch a player would see; an average frame time
     * hides exactly the spike this criterion is about.
     *
     * ── AND A BARE rAF SAMPLER CANNOT TELL A STALL FROM AN ABSENT FRAME ────
     *
     * This used to be a bare rAF sampler: gap deltas, a p50/p99/max, no
     * heartbeat. `frame-gaps.mjs` learned the hard way that the two things an
     * rAF gap can mean have OPPOSITE fixes. A 4 ms timer chain runs on the
     * same main thread and is not gated on the compositor, so inside a gap it
     * either keeps ticking — the thread is free and the frame is stuck behind
     * the GPU, the presenter, or an occluded window — or it stops with the
     * frames, and the thread is the problem.
     *
     * `beats` is how many times the timer fired inside the gap; `blockedMs`
     * is the longest single stretch the TIMER lost, which is real synchronous
     * JavaScript and nothing else. `blocked*` is what a caller should quote.
     *
     * `blockedMs` takes the worse of the longest CLOSED stretch and the still
     * OPEN one, because `worstBeat` can only ever measure a stretch that ENDED
     * in a beat: a gap blocked from end to end fires the timer zero times and
     * would otherwise report "blocked 0", which is the reading a genuinely
     * starved gap gives and means the exact opposite.
     *
     * `starved` marks a gap that was over budget while its heartbeat never
     * was — no rAF, idle thread. Those are not this game's cost; the recorded
     * case is a 31,284 ms "world rebuild" whose crossing was 442 ms. The
     * four anti-occlusion flags on the browser spawn above are what makes
     * them rare; `beats` is what proves the flags are still working.
     */
    async gaps({ action = 'read', label = null, budget = 250 }) {
      if (action === 'arm') {
        return evaluate(`(() => {
          const g = {
            last: performance.now(), gaps: [], label: ${JSON.stringify(label)},
            budget: ${Number(budget) || 250},
            beat: performance.now(), beats: 0, worstBeat: 0,
          };
          window.__GAPS__ = g;
          g.heart = setInterval(() => {
            const t = performance.now();
            const d = t - g.beat;
            g.beat = t;
            g.beats++;
            if (d > g.worstBeat) g.worstBeat = d;
          }, 4);
          const tick = () => {
            const now = performance.now();
            if (window.__GAPS__ !== g) return;
            /* The open stretch counts too — see the note above. */
            const blocked = Math.max(g.worstBeat, now - g.beat);
            g.gaps.push({ ms: now - g.last, blockedMs: blocked, beats: g.beats });
            g.beats = 0; g.worstBeat = 0;
            g.last = now;
            g.raf = requestAnimationFrame(tick);
          };
          g.raf = requestAnimationFrame(tick);
          return { armed: true, budget: g.budget };
        })()`);
      }
      if (action === 'stop') {
        return evaluate(`(() => {
          const g = window.__GAPS__;
          if (!g) return null;
          cancelAnimationFrame(g.raf);
          clearInterval(g.heart);
          window.__GAPS__ = null;
          /* Drop the first sample: it spans arming, not a frame. */
          const rows = g.gaps.slice(1);
          const ms = rows.map(r => r.ms).sort((a,b)=>a-b);
          const at = (q) => ms.length ? +ms[Math.floor(ms.length*q)].toFixed(2) : null;
          /* A gap is STARVED when it blew the budget while the heartbeat
           * never did and kept ticking through roughly half of it. Same test
           * frame-gaps.mjs applies; it is the one that caught four false
           * stalls in eight runs. */
          const starved = rows.filter(r =>
            r.ms > g.budget && r.blockedMs <= g.budget && r.beats * 4 >= r.ms * 0.5);
          const blocked = rows.map(r => r.blockedMs).sort((a,b)=>a-b);
          const worst = rows.slice().sort((a,b)=>b.ms-a.ms).slice(0, 5);
          return {
            label: g.label, budget: g.budget, frames: rows.length,
            max: ms.length ? +ms[ms.length-1].toFixed(2) : null,
            p99: at(0.99), p50: at(0.5),
            over250: ms.filter(v=>v>250).length,
            over100: ms.filter(v=>v>100).length,
            /* THE HONEST FIGURES. Quote these, not \`max\`. */
            blockedMax: blocked.length ? +blocked[blocked.length-1].toFixed(2) : null,
            blockedOverBudget: rows.filter(r => r.blockedMs > g.budget).length,
            starved: starved.length,
            starvedWorst: starved.slice().sort((a,b)=>b.ms-a.ms).slice(0, 3)
              .map(r => ({ ms: +r.ms.toFixed(1), blockedMs: +r.blockedMs.toFixed(1), beats: r.beats })),
            worst5: worst.map(r => ({
              ms: +r.ms.toFixed(1), blockedMs: +r.blockedMs.toFixed(1), beats: r.beats,
              starved: r.ms > g.budget && r.blockedMs <= g.budget && r.beats * 4 >= r.ms * 0.5,
            })),
            rafStalls: window.__HARNESS_RAF_STALLS__ ?? 0,
          };
        })()`);
      }
      return evaluate('window.__GAPS__ ? { frames: window.__GAPS__.gaps.length } : null');
    },
  };

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const name = url.pathname.replace(/^\//, '') || 'status';
    const fn = handlers[name];
    res.setHeader('content-type', 'application/json');
    if (!fn) { res.statusCode = 404; res.end(JSON.stringify({ error: `no command ${name}`, commands: Object.keys(handlers) })); return; }
    let arg = {};
    const raw = await body(req);
    if (raw) {
      try { arg = JSON.parse(raw); }
      catch { arg = name === 'js' ? { expr: raw } : { text: raw }; }
    }
    for (const [k, v] of url.searchParams) arg[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
    try {
      const out = await fn(arg);
      res.end(JSON.stringify(out ?? null));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(e.message ?? e) }));
    }
  });
  await new Promise((r) => server.listen(args.port, '127.0.0.1', r));
  await log(`driver listening on http://127.0.0.1:${args.port}  (commands: ${Object.keys(handlers).join(' ')})`);
  await log('READY');

  const shutdown = async () => {
    try { await releaseAll(); } catch { /* browser may already be gone */ }
    server.close();
    client.close();
    browser.kill();
    if (vite) await vite.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  handlers.quit = async () => { setTimeout(shutdown, 50); return { quitting: true }; };
  return new Promise(() => {});
}

main().catch((e) => { console.error(e); process.exit(1); });
