/**
 * Shared CDP boot for the orb hunt. Copied in shape from scripts/world-shot.mjs
 * (same flags, same ANGLE path, same gameplayDriven guarantee) so that anything
 * measured here is measured in the same renderer state the art harness uses.
 */
import { spawn } from 'node:child_process';
import { createServer as createSocketServer } from 'node:net';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function browserCandidates() {
  const home = os.homedir();
  const out = [];
  if (process.env.CHROME_PATH) out.push(process.env.CHROME_PATH);
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const ms = path.join(local, 'ms-playwright');
    if (existsSync(ms)) for (const d of ['chromium-1223', 'chromium-1217']) out.push(path.join(ms, d, 'chrome-win64', 'chrome.exe'));
    out.push(path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    out.push(path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    out.push(path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    out.push(path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    out.push(path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  } else if (process.platform === 'darwin') {
    out.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else {
    out.push('/usr/bin/google-chrome', '/usr/bin/chromium');
  }
  return out.filter((p) => existsSync(p));
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
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

  close() { try { this.ws.close(); } catch { /* gone */ } }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = createSocketServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function waitFor(fn, { timeout = 240000, every = 250, what = 'condition' } = {}) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

/**
 * Boot the game in headless Chrome and hand back { evaluate, shot, close }.
 */
export async function boot({ world = 'medieval', width = 1600, height = 900, outDir } = {}) {
  const chrome = browserCandidates()[0];
  if (!chrome) throw new Error('NO BROWSER FOUND - set CHROME_PATH');
  await mkdir(outDir, { recursive: true });

  const vitePort = await freePort();
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    root, configFile: path.join(root, 'vite.config.js'), logLevel: 'error',
    server: { port: vitePort, strictPort: true, host: '127.0.0.1' },
  });
  await vite.listen();
  const base = vite.config.base ?? '/';
  const pageUrl = `http://127.0.0.1:${vitePort}${base}index.html?dev=1&autostart=1&world=${encodeURIComponent(world)}`
    .replace(/([^:])\/\//g, '$1/');

  const cdpPort = await freePort();
  const userDir = path.join(os.tmpdir(), `orb-hunt-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const browser = spawn(chrome, [
    '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDir}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
    '--disable-extensions', '--force-device-scale-factor=1',
    '--use-angle=default', '--enable-gpu-rasterization', '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader', `--window-size=${width},${height}`, 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  browser.stderr.on('data', () => {});

  let client;
  const closeAll = async () => {
    client?.close(); browser.kill(); await vite.close();
    await rm(userDir, { recursive: true, force: true }).catch(() => {});
  };

  try {
    await waitFor(async () => (await fetch(pageUrl)).ok, { what: `dev server ${pageUrl}` });
    const version = await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
      return r.ok ? r.json() : null;
    }, { what: `chrome devtools ${cdpPort}` });

    client = await CDP.connect(version.webSocketDebuggerUrl);
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    const call = (m, p) => client.send(m, p, sessionId);
    await call('Page.enable');
    await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

    const pageLog = [];
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

    const evaluate = async (expression, { awaitPromise = false } = {}) => {
      const r = await call('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, timeout: 900000 });
      if (r.exceptionDetails) {
        throw new Error(`${r.exceptionDetails.text}: ${r.exceptionDetails.exception?.description ?? ''}`);
      }
      return r.result?.value;
    };
    /* JPEG, not PNG. A 1600x900 lossless frame of this game is 1.7 MB and a
     * report wants a dozen of them; at quality 88 the same frame is 140 KB and
     * nothing measured here is measured off the file - every number in a report
     * comes from `gl.readPixels` on the live framebuffer, and the picture is
     * only ever the thing a human looks at. */
    const shot = async (file) => {
      const jpg = file.replace(/\.png$/, '.jpg');
      const s = await call('Page.captureScreenshot', { format: 'jpeg', quality: 88, captureBeyondViewport: false });
      await writeFile(path.join(outDir, jpg), Buffer.from(s.data, 'base64'));
      return path.join(outDir, jpg);
    };

    await call('Page.navigate', { url: pageUrl });
    await waitFor(() => evaluate('!!(window.HARNESS && window.GAME && window.GAME.worldManager)'),
      { what: 'window.HARNESS', timeout: 240000 })
      .catch((e) => { throw new Error(`${e.message}\n--- page console ---\n${pageLog.slice(-40).join('\n')}`); });

    const bootWorld = await evaluate('window.HARNESS.ready({ timeoutMs: 240000 })', { awaitPromise: true });
    if (bootWorld !== world) await evaluate(`window.HARNESS.goto(${JSON.stringify(world)})`, { awaitPromise: true });
    await evaluate('window.HARNESS.dismissBoot(); window.HARNESS.hideHud(true); true');
    const gl = await evaluate(`(() => {
      const g = window.GAME.engine.renderer.getContext();
      const d = g.getExtension('WEBGL_debug_renderer_info');
      return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER);
    })()`);
    console.log(`gl: ${gl}`);
    const driven = await evaluate('window.HARNESS.gameplayDriven');
    console.log(`gameplayDriven: ${driven}`);
    return { evaluate, shot, close: closeAll, pageLog, gl, gameplayDriven: driven, outDir };
  } catch (e) {
    await closeAll();
    throw e;
  }
}
