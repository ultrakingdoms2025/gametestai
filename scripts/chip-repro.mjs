/* Reproduce the owner's report: prod bundle, real Chrome, a stubbed
 * /api/game/session naming a server — the REAL hydrate path, not the bus
 * shortcut the layout probe uses. Prints the chip's state at intervals. */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const gameDir = path.join(root, 'site', 'public', 'game');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.bin': 'application/octet-stream', '.svg': 'image/svg+xml', '.ktx2': 'image/ktx2' };

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/game/session') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      handle: 'markc', credits: 1234,
      server: { id: 'srv_test', name: 'Ironvale Frontier RP' },
      game_state: null,
    }));
    return;
  }
  if (u.pathname.startsWith('/api/')) { // lore etc: shaped like prod signed-in-ish
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(u.pathname === '/api/lore' ? JSON.stringify({ entries: {}, server_id: 'srv_test' }) : JSON.stringify({}));
    return;
  }
  let p = u.pathname.replace(/^\/game\/?/, '') || 'index.html';
  if (p === '' || p === '/') p = 'index.html';
  const f = path.join(gameDir, p);
  if (!f.startsWith(gameDir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});

await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
const url = `http://127.0.0.1:${port}/game/index.html?dev=1&autostart=1&world=station`;
console.log('serving', url);

const candidates = [
  process.env.CHROME,
  'C\\x3a'.length && 'C:/Users/markc/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean);
const chrome = candidates.find((c) => fs.existsSync(c));
if (!chrome) { console.error('NO BROWSER'); process.exit(1); }

const cdpPort = 9333;
const proc = spawn(chrome, [
  `--remote-debugging-port=${cdpPort}`, '--headless=new', '--window-size=1600,900',
  '--use-angle=swiftshader-webgl', '--no-first-run', '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', url,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(3000);
const list = await fetch(`http://127.0.0.1:${cdpPort}/json`).then((r) => r.json());
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};
await send('Runtime.enable');

const PROBE = `(() => {
  const chip = document.querySelector('.server-chip');
  const mirror = document.querySelector('.pause-server');
  const cs = chip ? getComputedStyle(chip) : null;
  const r = chip ? chip.getBoundingClientRect() : null;
  return JSON.stringify({
    booted: !!window.GAME, hudBuilt: !!chip,
    chipHidden: chip ? chip.hidden : null,
    chipDisplay: cs ? cs.display : null,
    chipRect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
    chipText: chip ? chip.textContent : null,
    mirrorHidden: mirror ? mirror.hidden : null,
    mirrorText: mirror ? mirror.textContent : null,
  });
})()`;

for (let t = 0; t <= 120; t += 10) {
  const s = await evalJs(PROBE);
  console.log(`t=${t}s`, s);
  const o = JSON.parse(s ?? '{}');
  if (o.hudBuilt && o.chipHidden === false && o.chipRect?.w > 0) { console.log('CHIP VISIBLE — cannot reproduce'); break; }
  if (o.hudBuilt && o.chipHidden === true && t >= 60) { console.log('REPRODUCED: hud built, session stub live, chip still hidden'); break; }
  await sleep(10000);
}
await send('Page.enable').catch(() => {});
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) fs.writeFileSync(path.join(root, '.probe', 'chip-repro.png'), Buffer.from(shot.result.data, 'base64'));
console.log('screenshot .probe/chip-repro.png');
proc.kill(); srv.close(); process.exit(0);
