/**
 * node .probe/orb-hunt/confirm.mjs --world medieval --view hills-vista
 *
 * The attribution, proved rather than argued:
 *
 *   null pair              two frames, nothing changed
 *   orb census             every bright compact blob in the frame
 *   projection             every relic instance -> screen, matched to an orb
 *   the ablation           hide `relics:glow` alone, then the pair, full-frame diff
 *   the false negatives    why a raycast and a `--ablate` sweep both miss it
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
const thr = Number(arg('thr', 226));
const outDir = path.join(root, '.probe', 'orb-hunt', `confirm-${world}-${view}`);

const session = await boot({ world, outDir });
const { evaluate, shot, close } = session;
const out = { world, view, gl: session.gl, gameplayDriven: session.gameplayDriven };
let code = 0;

const EXTRA = `
window.__ORB.relicReport = function (thr) {
  const G = window.GAME;
  const THREE = G.engine.scene.constructor.prototype.constructor ? null : null;
  const scene = G.engine.scene;
  const cam = G.engine.camera;
  const glow = scene.getObjectByName('relics:glow');
  const body = scene.getObjectByName('relics');
  const W = window.__ORB.w, H = window.__ORB.h;
  const proj = [];
  if (glow) {
    const m = new (glow.instanceMatrix.constructor === Float32Array ? Object : Object)();
    for (let i = 0; i < glow.count; i++) {
      const e = glow.instanceMatrix.array;
      const o = i * 16;
      const wx = e[o + 12], wy = e[o + 13], wz = e[o + 14];
      // world -> clip, by hand: viewProjection = projectionMatrix * matrixWorldInverse
      const v = cam.matrixWorldInverse.elements, p = cam.projectionMatrix.elements;
      const ex = v[0]*wx + v[4]*wy + v[8]*wz + v[12];
      const ey = v[1]*wx + v[5]*wy + v[9]*wz + v[13];
      const ez = v[2]*wx + v[6]*wy + v[10]*wz + v[14];
      const cx = p[0]*ex + p[4]*ey + p[8]*ez + p[12];
      const cy = p[1]*ex + p[5]*ey + p[9]*ez + p[13];
      const cz = p[2]*ex + p[6]*ey + p[10]*ez + p[14];
      const cw = p[3]*ex + p[7]*ey + p[11]*ez + p[15];
      const sx = Math.round((cx / cw * 0.5 + 0.5) * W);
      const sy = Math.round((1 - (cy / cw * 0.5 + 0.5)) * H);
      const dist = Math.hypot(wx - cam.position.x, wy - cam.position.y, wz - cam.position.z);
      // quad width in metres, from the instance basis length
      const qw = Math.hypot(e[o], e[o+1], e[o+2]);
      proj.push({ i, world: [Math.round(wx*10)/10, Math.round(wy*10)/10, Math.round(wz*10)/10],
        screen: [sx, sy], onScreen: cw > 0 && sx >= 0 && sx < W && sy >= 0 && sy < H,
        dist: Math.round(dist*10)/10, quadW: Math.round(qw*100)/100 });
    }
  }
  return {
    hasRelicsSystem: !!G.relics,
    relicsHasGroup: !!(G.relics && G.relics.group),
    relicKeys: G.relics ? Object.keys(G.relics).slice(0, 40) : null,
    glowFound: !!glow, glowParentIsScene: glow ? glow.parent === scene : null,
    glowCount: glow ? glow.count : null, glowCapacity: glow ? glow.instanceMatrix.count : null,
    bodyCount: body ? body.count : null,
    bodyParentIsScene: body ? body.parent === scene : null,
    proj,
  };
};

/** Is either relic mesh reachable from the ACTIVE WORLD GROUP - what --ablate walks? */
window.__ORB.inWorldGroup = function () {
  const G = window.GAME;
  const g = G.worldManager.active && G.worldManager.active.group;
  let glow = false, body = false, mats = new Set();
  if (g) g.traverse((o) => {
    if (o.name === 'relics:glow') glow = true;
    if (o.name === 'relics') body = true;
    const m = o.material; if (!m) return;
    for (const mm of (Array.isArray(m) ? m : [m])) if (mm && mm.name) mats.add(mm.name);
  });
  return { worldGroup: g ? (g.name || g.type) : null, glowInWorldGroup: glow, bodyInWorldGroup: body,
    worldMaterialNames: [...mats].sort(), hasRelicGlowName: mats.has('relic.glow'), count: mats.size };
};

/**
 * The nearest-object-to-ray search, done PER INSTANCE and by hand.
 *
 * No Raycaster: the question "is there geometry on this axis" is a
 * perpendicular distance, and doing it directly means the answer cannot be an
 * artefact of a bounding sphere, a material side, a stale cache or a layer mask.
 * Every renderable leaf in the scene contributes its own world origin AND, for
 * an InstancedMesh, every one of its live instance origins.
 */
window.__ORB.nearestToRay = function (x, y) {
  const G = window.GAME;
  const cam = G.engine.camera;
  const W = window.__ORB.w, H = window.__ORB.h;
  const ndcx = (x / W) * 2 - 1, ndcy = -((y / H) * 2 - 1);
  // unproject two points on the ray using the inverse view-projection
  const pi = cam.projectionMatrixInverse.elements, mw = cam.matrixWorld.elements;
  function unproj(nx, ny, nz) {
    const cx = pi[0]*nx + pi[4]*ny + pi[8]*nz + pi[12];
    const cy = pi[1]*nx + pi[5]*ny + pi[9]*nz + pi[13];
    const cz = pi[2]*nx + pi[6]*ny + pi[10]*nz + pi[14];
    const cw = pi[3]*nx + pi[7]*ny + pi[11]*nz + pi[15];
    const ex = cx/cw, ey = cy/cw, ez = cz/cw;
    return [ mw[0]*ex + mw[4]*ey + mw[8]*ez + mw[12],
             mw[1]*ex + mw[5]*ey + mw[9]*ez + mw[13],
             mw[2]*ex + mw[6]*ey + mw[10]*ez + mw[14] ];
  }
  const o = [cam.position.x, cam.position.y, cam.position.z];
  const f = unproj(ndcx, ndcy, 0.5);
  let dx = f[0]-o[0], dy = f[1]-o[1], dz = f[2]-o[2];
  const len = Math.hypot(dx, dy, dz); dx/=len; dy/=len; dz/=len;
  const cands = [];
  function consider(label, wx, wy, wz, extra) {
    const vx = wx-o[0], vy = wy-o[1], vz = wz-o[2];
    const t = vx*dx + vy*dy + vz*dz;
    if (t <= 0) return;
    const px = o[0]+dx*t, py = o[1]+dy*t, pz = o[2]+dz*t;
    const perp = Math.hypot(wx-px, wy-py, wz-pz);
    cands.push({ label, perp: Math.round(perp*100)/100, along: Math.round(t*10)/10, extra });
  }
  G.engine.scene.traverse((ob) => {
    if (ob.isLight) return;
    if (!(ob.isMesh || ob.isPoints || ob.isSprite || ob.isLine)) return;
    ob.updateWorldMatrix(true, false);
    const e = ob.matrixWorld.elements;
    const nm = ob.name || ob.type;
    if (ob.isInstancedMesh) {
      const a = ob.instanceMatrix.array;
      for (let i = 0; i < ob.count; i++) {
        const q = i*16;
        // instance matrix is in the mesh's local space; the mesh sits at identity here
        const lx = a[q+12], ly = a[q+13], lz = a[q+14];
        const wx = e[0]*lx + e[4]*ly + e[8]*lz + e[12];
        const wy = e[1]*lx + e[5]*ly + e[9]*lz + e[13];
        const wz = e[2]*lx + e[6]*ly + e[10]*lz + e[14];
        consider(nm + '#' + i, wx, wy, wz, 'instance');
      }
    } else {
      consider(nm, e[12], e[13], e[14], ob.type);
    }
  });
  /* Ranked by ANGLE off the axis, not by metres off the axis.
   *
   * This is the whole difference between a search that finds the source and
   * one that does not. Metres put the player's own viewmodel - 10 cm from the
   * lens and 5 cm off the ray - ahead of everything in the world; a relic 150 m
   * out and 1.4 screen pixels off the ray is 0.22 m off it, and loses. Angle is
   * the quantity a screen pixel actually measures. */
  cands.forEach((c) => { c.mrad = Math.round((c.perp / c.along) * 1e5) / 100; });
  const byMetres = cands.slice().sort((a, b) => a.perp - b.perp).slice(0, 4);
  cands.sort((a, b) => a.mrad - b.mrad);
  return { pixel: [x, y], origin: o.map((v) => Math.round(v*10)/10),
    dir: [Math.round(dx*1000)/1000, Math.round(dy*1000)/1000, Math.round(dz*1000)/1000],
    byAngle: cands.slice(0, 4), byMetres };
};

/** Cast a ray from the camera through a screen pixel and list what it meets. */
window.__ORB.rayThrough = function (x, y) {
  const G = window.GAME;
  const cam = G.engine.camera;
  const W = window.__ORB.w, H = window.__ORB.h;
  const ndc = { x: (x / W) * 2 - 1, y: -((y / H) * 2 - 1) };
  const RC = window.__ORB.Raycaster;
  if (!RC) return { pixel: [x, y], note: 'no Raycaster handle' };
  const rc = new RC();
  rc.setFromCamera(ndc, cam);
  rc.far = 4000;
  const hits = rc.intersectObjects(G.engine.scene.children, true);
  const glow = G.engine.scene.getObjectByName('relics:glow');
  const body = G.engine.scene.getObjectByName('relics');
  const solo = glow ? rc.intersectObject(glow, false) : [];
  const soloBody = body ? rc.intersectObject(body, false) : [];
  return {
    pixel: [x, y],
    hits: hits.slice(0, 6).map((h) => ({ d: Math.round(h.distance*10)/10, name: h.object.name || h.object.type,
      mat: (Array.isArray(h.object.material) ? h.object.material[0] : h.object.material)?.name ?? null })),
    glowDirectHits: solo.length,
    bodyDirectHits: soloBody.length,
    glowBoundingSphere: glow && glow.boundingSphere
      ? { c: [Math.round(glow.boundingSphere.center.x), Math.round(glow.boundingSphere.center.y), Math.round(glow.boundingSphere.center.z)], r: Math.round(glow.boundingSphere.radius*10)/10 }
      : null,
    glowMaterialSide: glow ? glow.material.side : null,
  };
};

/** Full-frame diff between the last two grabs. */
window.__ORB.frameDiff = function () {
  const A = window.__ORB.a, B = window.__ORB.b, W = window.__ORB.w, H = window.__ORB.h;
  const L = (r,g,b) => r*0.2126 + g*0.7152 + b*0.0722;
  let over2 = 0, over6 = 0, over40 = 0, peak = 0, at = null, sum = 0;
  for (let i = 0; i < A.length; i += 4) {
    const d = Math.abs(L(A[i],A[i+1],A[i+2]) - L(B[i],B[i+1],B[i+2]));
    if (d > 2) over2++;
    if (d > 6) over6++;
    if (d > 40) over40++;
    sum += d;
    if (d > peak) { peak = d; const p = i / 4; at = [p % W, H - 1 - ((p / W) | 0)]; }
  }
  return { pixelsOver2: over2, pixelsOver6: over6, pixelsOver40: over40,
    peakDeltaLum: Math.round(peak*10)/10, peakAt: at, sumDeltaLum: Math.round(sum) };
};

/** Hide named scene-root objects, render, and diff against the baseline. */
window.__ORB.ablateNamed = function (names) {
  const scene = window.GAME.engine.scene;
  const objs = names.map((n) => scene.getObjectByName(n)).filter(Boolean);
  window.__ORB.size();
  window.__ORB.shoot(window.__ORB.a);
  for (const o of objs) o.visible = false;
  window.__ORB.shoot(window.__ORB.b);
  const diff = window.__ORB.frameDiff();
  const orbSample = window.__ORB.orbs ? window.__ORB.sampleOrbs(window.__ORB.a, window.__ORB.b, 14) : null;
  return { hidden: objs.map((o) => o.name), diff, orbSample };
};
window.__ORB.restoreNamed = function (names) {
  const scene = window.GAME.engine.scene;
  for (const n of names) { const o = scene.getObjectByName(n); if (o) o.visible = true; }
  window.__ORB.shoot(window.__ORB.a);
  return true;
};
'ok';
`;

try {
  await evaluate(await readFile(path.join(root, '.probe', 'orb-hunt', 'payload.js'), 'utf8'));
  // three's Raycaster, borrowed off an object that already holds one
  await evaluate(`(() => {
    const G = window.GAME;
    const cands = [G.caches && G.caches._ray, G.loot && G.loot._ray, G.physics && G.physics._ray,
                   G.relics && G.relics._ray, G.viewpoints && G.viewpoints._ray];
    for (const c of cands) if (c && c.constructor && c.constructor.name === 'Raycaster') { window.__ORB.Raycaster = c.constructor; return true; }
    return false;
  })()`);
  await evaluate(EXTRA);

  out.views = {};
  for (const v of view.split(',')) {
    console.log(`\n${'='.repeat(72)}\n${world} / ${v}\n${'='.repeat(72)}`);
    const V = out.views[v] = {};
    await evaluate('window.HARNESS.freezeAll(false); true');
    await evaluate(`window.HARNESS.view(${JSON.stringify(v)}, { settle: 14 })`, { awaitPromise: true });
    await sleep(2500);
    await evaluate('window.HARNESS.freezeAll(true); true');
    await sleep(600);
    await evaluate('window.__ORB.size()');

    V.nullPair = await evaluate('window.__ORB.nullPair()');
    console.log('NULL PAIR (whole frame):', JSON.stringify(V.nullPair));

    V.orbs = await evaluate(`window.__ORB.findOrbs({ lum: ${thr} })`);
    console.log(`orbs detected (lum>=${thr}, local contrast >=22): ${V.orbs.length}`);

    V.relics = await evaluate('window.__ORB.relicReport()');
    console.log(`relics system present=${V.relics.hasRelicsSystem}  has a .group=${V.relics.relicsHasGroup}`);
    console.log(`relics:glow parentIsScene=${V.relics.glowParentIsScene} count=${V.relics.glowCount}/${V.relics.glowCapacity}`);
    console.log(`relics      parentIsScene=${V.relics.bodyParentIsScene} count=${V.relics.bodyCount}`);
    console.log(`relic instances projecting inside the frame: ${V.relics.proj.filter((p) => p.onScreen).length} of ${V.relics.proj.length}`);

    V.worldGroup = await evaluate('window.__ORB.inWorldGroup()');
    console.log(`world-group material names: ${V.worldGroup.count}; contains "relic.glow"? ${V.worldGroup.hasRelicGlowName}; glow in world group? ${V.worldGroup.glowInWorldGroup}`);

    V.match = V.orbs.map((o) => {
      let best = null, bd = 1e9;
      for (const p of V.relics.proj) {
        const d = Math.hypot(p.screen[0] - o.cx, p.screen[1] - o.cy);
        if (d < bd) { bd = d; best = p; }
      }
      return { orb: o.id, at: [o.cx, o.cy], rgb: o.rgb, peakLum: o.peakLum, area: o.area,
        nearestRelic: best ? best.i : null, screenDist: Math.round(bd * 10) / 10,
        relicDist: best ? best.dist : null, quadW: best ? best.quadW : null };
    });
    console.log('\norb -> nearest projected relic instance');
    for (const m of V.match) {
      console.log(`  orb ${String(m.orb).padStart(2)} @(${String(m.at[0]).padStart(4)},${String(m.at[1]).padStart(3)}) rgb ${m.rgb.join(',').padEnd(11)} peak ${String(m.peakLum).padStart(5)}  -> relic #${m.nearestRelic}  ${String(m.screenDist).padStart(5)} px off,  ${String(m.relicDist).padStart(6)} m out,  quad ${m.quadW} m`);
    }
    const off = V.match.map((m) => m.screenDist);
    if (off.length) console.log(`  worst screen-space miss over ${off.length} orbs: ${Math.max(...off)} px`);

    await shot(`${v}-01-relics-on.png`);

    V.nullFrameDiff = await evaluate('window.__ORB.size(); window.__ORB.shoot(window.__ORB.a); window.__ORB.shoot(window.__ORB.b); window.__ORB.frameDiff()');
    console.log('\nNULL full-frame diff (nothing changed):', JSON.stringify(V.nullFrameDiff));

    V.ablateGlow = await evaluate(`window.__ORB.ablateNamed(['relics:glow'])`);
    console.log(`ABLATE relics:glow          -> ${JSON.stringify(V.ablateGlow.diff)}`);
    V.glowBlobs = await evaluate('window.__ORB.diffBlobs(20)');
    console.log(`  footprints removed (connected components of dLum>20): ${V.glowBlobs.length}`);
    await shot(`${v}-02-glow-off.png`);
    await evaluate(`window.__ORB.restoreNamed(['relics:glow'])`);

    V.ablateBoth = await evaluate(`window.__ORB.ablateNamed(['relics:glow','relics'])`);
    console.log(`ABLATE relics:glow + relics -> ${JSON.stringify(V.ablateBoth.diff)}`);
    V.bothBlobs = await evaluate('window.__ORB.diffBlobs(20)');
    console.log(`  footprints removed: ${V.bothBlobs.length}`);
    await shot(`${v}-03-relics-off.png`);

    V.orbsAfter = await evaluate(`window.__ORB.findOrbs({ lum: ${thr} })`);
    console.log(`orbs remaining with both relic meshes hidden: ${V.orbsAfter.length}  (was ${V.orbs.length})`);
    await evaluate(`window.__ORB.restoreNamed(['relics:glow','relics'])`);

    console.log('\nnearest scene object to the ray through each orb, per instance');
    V.nearest = [];
    for (const m of V.match.slice(0, 5)) {
      const r = await evaluate(`window.__ORB.nearestToRay(${m.at[0]}, ${m.at[1]})`);
      V.nearest.push(r);
      console.log(`  @(${m.at[0]},${m.at[1]})`);
      console.log(`     by ANGLE : ` + r.byAngle.map((c) => `${c.label} ${c.mrad}mrad (${c.perp}m @${c.along}m)`).join('  |  '));
      console.log(`     by METRES: ` + r.byMetres.map((c) => `${c.label} ${c.perp}m @${c.along}m`).join('  |  '));
    }

    if (await evaluate('!!window.__ORB.Raycaster')) {
      V.rays = [];
      for (const m of V.match.slice(0, 4)) {
        const r = await evaluate(`window.__ORB.rayThrough(${m.at[0]}, ${m.at[1]})`);
        V.rays.push(r);
        console.log(`  raycast @(${m.at[0]},${m.at[1]}) -> ${r.hits.map((h) => `${h.name}@${h.d}`).join(' | ') || '(nothing)'}`);
        console.log(`     direct hits on relics:glow=${r.glowDirectHits}  on relics=${r.bodyDirectHits}  glow.boundingSphere=${JSON.stringify(r.glowBoundingSphere)}`);
      }
    }
  }

  await writeFile(path.join(outDir, 'confirm.json'), JSON.stringify(out, null, 2));
  console.log(`\nwrote ${path.join(outDir, 'confirm.json')}`);
} catch (e) {
  console.error(e.stack ?? String(e));
  console.error('--- page console ---\n' + session.pageLog.slice(-30).join('\n'));
  code = 1;
} finally {
  await close();
}
process.exit(code);
