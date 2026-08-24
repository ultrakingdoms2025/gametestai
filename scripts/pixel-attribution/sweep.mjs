/**
 * node .probe/orb-hunt/hunt.mjs --world medieval --view hills-vista
 *
 * Stage 1  null pair            two frames, nothing changed
 * Stage 2  orb detection        bright, compact, high local contrast
 * Stage 3  per-leaf ablation    hide every renderable leaf in turn, one render
 *                               each, and record which orb boxes moved
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { boot, root, sleep } from './boot.mjs';

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const world = arg('world', 'medieval');
const view = arg('view', 'hills-vista');
const outDir = path.join(root, '.probe', 'orb-hunt', `${world}-${view}`);
const half = Number(arg('half', 14));

const session = await boot({ world, outDir });
const { evaluate, shot, close } = session;
let code = 0;
try {
  console.log(`view: ${view}`);
  await evaluate(`window.HARNESS.view(${JSON.stringify(view)}, { settle: 14 })`, { awaitPromise: true });
  await sleep(2500);
  await evaluate('window.HARNESS.freezeAll(true); true');
  await sleep(600);

  const payload = await readFile(path.join(root, '.probe', 'orb-hunt', 'payload.js'), 'utf8');
  console.log('payload:', await evaluate(payload));

  await shot('00-frame.png');

  const size = await evaluate('window.__ORB.size()');
  console.log('buffer:', JSON.stringify(size));

  const nul = await evaluate('window.__ORB.nullPair()');
  console.log('NULL PAIR:', JSON.stringify(nul));

  console.log('lum histogram (16 buckets):', JSON.stringify(await evaluate('window.__ORB.hist()')));
  const probes = (arg('probe', '') || '').split(';').filter(Boolean);
  for (const p of probes) {
    const [x, y] = p.split(',').map(Number);
    console.log('  probe', JSON.stringify(await evaluate(`window.__ORB.probeAt(${x},${y})`)));
  }

  let orbs = [];
  for (const t of [246, 242, 238, 234, 230, 226, 222]) {
    const got = await evaluate(`window.__ORB.findOrbs({ lum: ${t} })`);
    console.log(`  threshold ${t}: ${got.length} blobs`);
    if (got.length >= 5 && got.length <= 80) { orbs = got; console.log(`  -> using threshold ${t}`); break; }
    if (got.length > 80) { console.log('  -> stopping, threshold has started catching the sky'); break; }
    orbs = got;
  }
  console.log(`orbs found: ${orbs.length}`);
  for (const o of orbs.slice(0, 40)) {
    console.log(`  #${String(o.id).padStart(2)}  (${String(o.cx).padStart(4)},${String(o.cy).padStart(4)})  area ${String(o.area).padStart(5)}  ${o.spanX}x${o.spanY}  peak ${o.peakLum}  ring ${o.ringLum}  rgb ${o.rgb.join(',')}`);
  }

  const cat = await evaluate('window.__ORB.catalog()');
  console.log(`catalogued leaves: ${cat.n}`);

  console.log('sweeping...');
  const t0 = Date.now();
  const rows = await evaluate(`window.__ORB.sweep(${half})`);
  console.log(`sweep done in ${((Date.now() - t0) / 1000).toFixed(1)}s - ${rows.length} objects moved at least one orb box`);
  rows.sort((a, b) => b.peak - a.peak);
  for (const r of rows.slice(0, 60)) {
    console.log(`  peak ${String(r.peak).padStart(7)}  total ${String(r.total).padStart(8)}  orbs[${r.per.map((p) => p.id).join(',')}]  ${r.meta.type} "${r.meta.name}" mat=${r.meta.mat}  ${r.meta.path.slice(-110)}`);
  }

  await writeFile(path.join(outDir, 'result.json'), JSON.stringify({
    world, view, gl: session.gl, gameplayDriven: session.gameplayDriven,
    size, nullPair: nul, orbs, leaves: cat.n, rows,
  }, null, 2));
  console.log(`\nwrote ${path.join(outDir, 'result.json')}`);
} catch (e) {
  console.error(e.stack ?? String(e));
  console.error('--- page console ---\n' + session.pageLog.slice(-30).join('\n'));
  code = 1;
} finally {
  await close();
}
process.exit(code);
