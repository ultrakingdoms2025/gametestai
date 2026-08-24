/**
 * node .probe/orb-hunt/verify.mjs --world medieval --view hills-vista
 *
 * The fix, in pixels. For each framing:
 *   null pair                two frames, nothing changed
 *   orb census               bright compact blobs with local contrast
 *   per-relic readout        every projected relic instance: distance, and the
 *                            peak luminance of the pixels it owns
 *   the near-field check     a relic inside the fog's near plane must NOT have
 *                            moved, or the fix has cost the affordance
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { boot, root, sleep } from './boot.mjs';

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const world = arg('world', 'medieval');
const views = arg('view', 'hills-vista').split(',');
const tag = arg('tag', 'after');
const thr = Number(arg('thr', 226));
const outDir = path.join(root, '.probe', 'orb-hunt', `verify-${world}`);

const EXTRA = `
/** Every projected relic, with the brightest pixel in the box it owns. */
window.__ORB.relicPixels = function () {
  const G = window.GAME;
  const cam = G.engine.camera;
  const glow = G.engine.scene.getObjectByName('relics:glow');
  const W = window.__ORB.w, H = window.__ORB.h;
  const px = window.__ORB.a;
  const L = (r,g,b) => r*0.2126 + g*0.7152 + b*0.0722;
  const idx = (x, y) => (((H - 1 - y) * W) + x) * 4;
  const out = [];
  if (!glow) return out;
  const e = glow.instanceMatrix.array;
  const v = cam.matrixWorldInverse.elements, p = cam.projectionMatrix.elements;
  for (let i = 0; i < glow.count; i++) {
    const o = i * 16;
    const wx = e[o + 12], wy = e[o + 13], wz = e[o + 14];
    const ex = v[0]*wx + v[4]*wy + v[8]*wz + v[12];
    const ey = v[1]*wx + v[5]*wy + v[9]*wz + v[13];
    const ez = v[2]*wx + v[6]*wy + v[10]*wz + v[14];
    const cx = p[0]*ex + p[4]*ey + p[8]*ez + p[12];
    const cy = p[1]*ex + p[5]*ey + p[9]*ez + p[13];
    const cw = p[3]*ex + p[7]*ey + p[11]*ez + p[15];
    if (cw <= 0) continue;
    const sx = Math.round((cx / cw * 0.5 + 0.5) * W);
    const sy = Math.round((1 - (cy / cw * 0.5 + 0.5)) * H);
    if (sx < 6 || sy < 6 || sx >= W - 6 || sy >= H - 6) continue;
    let peak = 0, prgb = null;
    for (let y = sy - 5; y <= sy + 5; y++) {
      for (let x = sx - 5; x <= sx + 5; x++) {
        const q = idx(x, y);
        const l = L(px[q], px[q+1], px[q+2]);
        if (l > peak) { peak = l; prgb = [px[q], px[q+1], px[q+2]]; }
      }
    }
    const dist = Math.hypot(wx - cam.position.x, wy - cam.position.y, wz - cam.position.z);
    out.push({ i, dist: Math.round(dist*10)/10, screen: [sx, sy],
      peakLum: Math.round(peak*10)/10, rgb: prgb });
  }
  out.sort((a, b) => a.dist - b.dist);
  return out;
};
/** The scene's own fog, so the report can say where the ramp starts. */
window.__ORB.sceneFog = function () {
  const f = window.GAME.engine.scene.fog;
  if (!f) return null;
  return { type: f.type, near: f.near ?? null, far: f.far ?? null,
    density: f.density ?? null, color: f.color.getHexString() };
};
'ok';
`;

const session = await boot({ world, outDir });
const { evaluate, shot, close } = session;
const out = { world, tag, gl: session.gl, gameplayDriven: session.gameplayDriven, views: {} };
let code = 0;
try {
  await evaluate(await readFile(path.join(root, '.probe', 'orb-hunt', 'payload.js'), 'utf8'));
  await evaluate(EXTRA);

  for (const v of views) {
    console.log(`\n${'='.repeat(70)}\n${world} / ${v}   [${tag}]\n${'='.repeat(70)}`);
    const V = out.views[v] = {};
    await evaluate('window.HARNESS.freezeAll(false); true');
    await evaluate(`window.HARNESS.view(${JSON.stringify(v)}, { settle: 14 })`, { awaitPromise: true });
    await sleep(2500);
    await evaluate('window.HARNESS.freezeAll(true); true');
    await sleep(600);
    await evaluate('window.__ORB.size()');

    V.fog = await evaluate('window.__ORB.sceneFog()');
    console.log('scene fog:', JSON.stringify(V.fog));

    V.nullPair = await evaluate('window.__ORB.nullPair()');
    console.log('NULL PAIR:', JSON.stringify(V.nullPair));

    V.orbs = await evaluate(`window.__ORB.findOrbs({ lum: ${thr} })`);
    console.log(`ORBS (lum>=${thr}, local contrast >=22): ${V.orbs.length}`);
    for (const o of V.orbs.slice(0, 12)) {
      console.log(`   @(${String(o.cx).padStart(4)},${String(o.cy).padStart(3)}) area ${String(o.area).padStart(5)} peak ${o.peakLum} rgb ${o.rgb.join(',')}`);
    }

    await evaluate('window.__ORB.shoot(window.__ORB.a)');
    V.relics = await evaluate('window.__ORB.relicPixels()');
    console.log(`\nprojected relics, nearest first (${V.relics.length} on screen)`);
    for (const r of V.relics) {
      console.log(`   #${String(r.i).padStart(3)}  ${String(r.dist).padStart(7)} m  peak ${String(r.peakLum).padStart(6)}  rgb ${r.rgb ? r.rgb.join(',') : '-'}`);
    }
    await shot(`${v}-${tag}.png`);
  }
  await writeFile(path.join(outDir, `${tag}.json`), JSON.stringify(out, null, 2));
  console.log(`\nwrote ${path.join(outDir, `${tag}.json`)}`);
} catch (e) {
  console.error(e.stack ?? String(e));
  console.error('--- page console ---\n' + session.pageLog.slice(-25).join('\n'));
  code = 1;
} finally {
  await close();
}
process.exit(code);
