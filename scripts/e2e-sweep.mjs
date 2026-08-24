/**
 * THE PHASE 12 SWEEP — one identical battery of real-input probes, per world.
 *
 *   node scripts/playthrough.mjs --world station --port 7801 &
 *   node scripts/e2e-sweep.mjs --port 7801 --world station --out .probe/e2e/station
 *
 * ── What this is, and what it deliberately is not ────────────────────────
 *
 * It is not a test suite. It never asserts. It presses the keys a player
 * presses, records what the game did, and writes both to a report - because
 * the failure this phase exists to catch is precisely the one an assertion
 * cannot see: a control that answers, a state that updates, a HUD that says
 * the right words, and a player who is nonetheless stuck.
 *
 * Every probe therefore records a BEFORE and an AFTER of the same shape, so
 * "the key did nothing" and "the key did something wrong" are different rows
 * rather than the same silence. A probe that cannot run says so; it does not
 * pass by omission.
 *
 * ── Why one battery for every world ──────────────────────────────────────
 *
 * Nine worlds shipped from nine branches this week. A per-world script would
 * measure nine different things and could not answer "is movement worse in
 * citadel than in station", which is the only question a survey of the
 * finished whole is for. The battery is fixed; only the world changes.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = { port: 7801, world: 'station', out: null, only: null, shots: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const next = () => argv[++i];
    if (a === '--port') out.port = Number(next());
    else if (a === '--world') out.world = next();
    else if (a === '--out') out.out = next();
    else if (a === '--only') out.only = next().split(',');
    else if (a === '--no-shots') out.shots = false;
  }
  out.out ??= path.join('.probe', 'e2e', out.world);
  return out;
}

const args = parseArgs(process.argv.slice(2));
const BASE = `http://127.0.0.1:${args.port}`;

async function cmd(name, payload) {
  const res = await fetch(`${BASE}/${name}`, {
    method: 'POST',
    body: payload === undefined ? '' : JSON.stringify(payload),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text, status: res.status }; }
}

const js = (expr, aw = false) => cmd('js', { expr, await: aw });
const player = () => cmd('player');

/** Straight-line distance between two [x,y,z], or null if either is missing. */
function dist(a, b) {
  if (!a || !b) return null;
  return +Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]).toFixed(3);
}

const results = [];
let shotN = 0;

async function shot(tag) {
  if (!args.shots) return null;
  const p = path.join(args.out, `${String(++shotN).padStart(2, '0')}-${tag}.png`);
  const r = await cmd('shot', { path: p });
  return r.path ? path.relative(root, r.path) : null;
}

/**
 * Run one probe.
 *
 * `fn` gets `{before}` and returns whatever it observed. Everything is wrapped
 * so one exploding probe does not end the sweep - a world where `M` throws is
 * a finding, not a reason to stop measuring the other twenty keys.
 */
async function probe(name, note, fn) {
  if (args.only && !args.only.includes(name)) return;
  const before = await player();
  let observed = null, error = null;
  const t0 = Date.now();
  try { observed = await fn({ before }); }
  catch (e) { error = String(e.message ?? e); }
  const after = await player();
  const row = {
    probe: name, note,
    ms: Date.now() - t0,
    before, after,
    moved: dist(before.pos, after.pos),
    yawDelta: (before.yaw != null && after.yaw != null) ? +(after.yaw - before.yaw).toFixed(3) : null,
    observed, error,
  };
  results.push(row);
  const m = row.moved == null ? '   -  ' : `${String(row.moved).padStart(6)}m`;
  console.log(`${name.padEnd(26)} ${m}  ${error ? `ERROR ${error}` : JSON.stringify(observed ?? {}).slice(0, 150)}`);
  return row;
}

/* ---------------------------------------------------------------- */

async function main() {
  await mkdir(path.resolve(root, args.out), { recursive: true });
  console.log(`\n=== SWEEP: ${args.world} ===\n`);

  await cmd('clearconsole');
  const status0 = await cmd('status');
  console.log(`world=${status0.world} driven=${status0.gameplayDriven} fps=${status0.fps}\n`);

  const spawn = (await player()).pos;
  await shot('spawn');

  /* ---- 1. Can the player move at all, in every direction? --------- */
  for (const [key, label] of [['KeyW', 'forward'], ['KeyS', 'back'], ['KeyA', 'left'], ['KeyD', 'right']]) {
    await probe(`move-${label}`, `hold ${key} 1200ms`, async () => {
      await cmd('hold', { codes: [key], ms: 1200 });
      await cmd('frames', { n: 6 });
      return { key };
    });
  }

  /* ---- 2. Jump, sprint, crouch --------------------------------- */
  await probe('jump', 'tap Space, sample peak height', async ({ before }) => {
    const y0 = before.pos?.[1];
    await cmd('down', { codes: ['Space'] });
    let peak = y0;
    for (let i = 0; i < 30; i++) {
      await cmd('frames', { n: 2 });
      const p = await player();
      if (p.pos && p.pos[1] > peak) peak = p.pos[1];
    }
    await cmd('up', { codes: ['Space'] });
    await cmd('frames', { n: 20 });
    return { y0: +(y0 ?? 0).toFixed(2), peak: +(peak ?? 0).toFixed(2), rise: +((peak ?? 0) - (y0 ?? 0)).toFixed(2) };
  });

  await probe('sprint', 'W alone vs W+Shift over equal time', async () => {
    const a0 = (await player()).pos;
    await cmd('hold', { codes: ['KeyW'], ms: 1000 });
    const a1 = (await player()).pos;
    await cmd('hold', { codes: ['KeyW', 'ShiftLeft'], ms: 1000 });
    const a2 = (await player()).pos;
    const walk = dist(a0, a1), run = dist(a1, a2);
    return { walk, run, ratio: walk ? +(run / walk).toFixed(2) : null };
  });

  await probe('crouch', 'hold C, read eye height', async () => {
    const h0 = await js('window.GAME.engine.camera.position.y');
    await cmd('down', { codes: ['KeyC'] });
    await cmd('frames', { n: 20 });
    const h1 = await js('window.GAME.engine.camera.position.y');
    await cmd('up', { codes: ['KeyC'] });
    await cmd('frames', { n: 20 });
    const h2 = await js('window.GAME.engine.camera.position.y');
    return {
      standing: +(h0 ?? 0).toFixed(2), crouched: +(h1 ?? 0).toFixed(2),
      restored: +(h2 ?? 0).toFixed(2), drop: +((h0 ?? 0) - (h1 ?? 0)).toFixed(2),
    };
  });

  /* ---- 3. Camera ------------------------------------------------ */
  await probe('camera-toggle', 'tap V twice', async () => {
    const read = () => js(`(() => {
      const G = window.GAME;
      return G.cameraMode ?? G.player?.cameraMode ?? G.camera?.mode ??
        (G.thirdPerson != null ? (G.thirdPerson ? 'third' : 'first') : null);
    })()`);
    const a = await read();
    await cmd('key', { code: 'KeyV', ms: 90 });
    await cmd('frames', { n: 12 });
    const b = await read();
    await cmd('key', { code: 'KeyV', ms: 90 });
    await cmd('frames', { n: 12 });
    const c = await read();
    return { start: a, afterFirst: b, afterSecond: c, toggled: a !== b, restored: a === c };
  });

  /* ---- 4. Weapons ---------------------------------------------- */
  await probe('weapon-cycle', 'digits 1-5, then read the equipped weapon each time', async () => {
    const read = () => js(`(() => {
      const G = window.GAME;
      const w = G.weapons ?? G.weaponSystem ?? G.player?.weapons;
      return w?.current?.id ?? w?.current?.name ?? w?.currentId ?? w?.active?.id ?? null;
    })()`);
    const seen = [];
    for (const d of ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5']) {
      await cmd('key', { code: d, ms: 80 });
      await cmd('frames', { n: 8 });
      seen.push([d, await read()]);
    }
    return { seen, distinct: new Set(seen.map((s) => s[1]).filter(Boolean)).size };
  });

  await probe('weapon-fire', 'left mouse down 600ms; does ammo or a projectile move?', async () => {
    const read = () => js(`(() => {
      const G = window.GAME;
      const w = G.weapons ?? G.weaponSystem;
      return {
        ammo: w?.current?.ammo ?? w?.ammo ?? null,
        shots: w?.shotsFired ?? null,
        projectiles: G.projectiles?.length ?? G.bullets?.length ?? null,
      };
    })()`);
    const a = await read();
    await cmd('js', { expr: `(() => { window.GAME.input.state.fire = true; return 1; })()` });
    await cmd('frames', { n: 30 });
    const mid = await read();
    await cmd('js', { expr: `(() => { window.GAME.input.state.fire = false; return 1; })()` });
    await cmd('frames', { n: 10 });
    return { before: a, during: mid, note: 'fire set on input.state - the canvas mousedown path needs pointer lock' };
  });

  await probe('reload', 'tap R', async () => {
    await cmd('key', { code: 'KeyR', ms: 90 });
    await cmd('frames', { n: 20 });
    return await cmd('console', { n: 4, match: 'reload' });
  });

  /* ---- 5. Interact / mount / map / menus ------------------------ */
  await probe('interact-E', 'tap E where the player stands', async () => {
    await cmd('clearconsole');
    await cmd('key', { code: 'KeyE', ms: 120 });
    await cmd('frames', { n: 20 });
    return { console: await cmd('console', { n: 6 }) };
  });

  await probe('mount-wheel-M', 'tap M, read whether an overlay opened', async () => {
    const overlays = () => js(`(() => {
      const vis = [...document.querySelectorAll('body *')]
        .filter(e => e.className && typeof e.className === 'string'
          && /menu|wheel|overlay|panel|modal|map/i.test(e.className)
          && e.offsetParent !== null && e.getBoundingClientRect().width > 80)
        .map(e => e.className.split(/\\s+/)[0]);
      return [...new Set(vis)];
    })()`);
    const a = await overlays();
    await cmd('key', { code: 'KeyM', ms: 120 });
    await cmd('frames', { n: 25 });
    const b = await overlays();
    const opened = b.filter((x) => !a.includes(x));
    await cmd('key', { code: 'KeyM', ms: 120 });
    await cmd('frames', { n: 25 });
    const c = await overlays();
    return { before: a, after: b, opened, closedAgain: c.length === a.length };
  });

  await probe('pause-menu-Esc', 'tap Escape, read the hub, tap again to close', async () => {
    const hub = () => js(`(() => {
      const el = document.querySelector('.pause-hub, .pause-menu, [class*="pause"]');
      return el ? { cls: el.className, visible: el.offsetParent !== null,
                    text: (el.innerText||'').slice(0,220) } : null;
    })()`);
    const a = await hub();
    await cmd('key', { code: 'Escape', ms: 120 });
    await cmd('frames', { n: 25 });
    const b = await hub();
    await shot('pause-menu');
    await cmd('key', { code: 'Escape', ms: 120 });
    await cmd('frames', { n: 25 });
    const c = await hub();
    return { before: a, opened: b, afterClose: c };
  });

  await probe('inventory-I', 'tap I', async () => {
    const inv = () => js(`(() => {
      const el = document.querySelector('[class*="inventory"]');
      return el ? { visible: el.offsetParent !== null, text: (el.innerText||'').slice(0,200) } : null;
    })()`);
    const a = await inv();
    await cmd('key', { code: 'KeyI', ms: 120 });
    await cmd('frames', { n: 25 });
    const b = await inv();
    await cmd('key', { code: 'KeyI', ms: 120 });
    await cmd('frames', { n: 20 });
    return { before: a, after: b };
  });

  /* ---- 6. What the world actually contains --------------------- */
  await probe('world-contents', 'NPCs, portals, pickups, minigames, quest markers', async () => {
    return js(`(() => {
      const G = window.GAME;
      const w = G.worldManager.active;
      const near = (arr, r = 40) => {
        if (!arr) return null;
        const p = G.player.position;
        let n = 0;
        for (const o of arr) {
          const q = o?.position ?? o?.pos ?? o?.mesh?.position;
          if (!q) continue;
          if (Math.hypot(q.x - p.x, q.z - p.z) < r) n++;
        }
        return n;
      };
      const npcs = G.npcManager?.npcs ?? [];
      return {
        world: w?.id,
        npcTotal: npcs.length,
        npcWithin40m: near(npcs),
        portals: (G.portals?.list ?? G.portals?.portals ?? w?.portals ?? []).length ?? null,
        pickups: (G.pickups?.items ?? w?.pickups ?? []).length ?? null,
        minigames: G.minigames ? Object.keys(G.minigames.venues ?? G.minigames).length : null,
        colliderCount: G.physics?.colliders?.length ?? null,
      };
    })()`);
  });

  await probe('nearest-npc-talk', 'walk to the nearest NPC and press E', async () => {
    const info = await js(`(() => {
      const G = window.GAME;
      const p = G.player.position;
      const npcs = G.npcManager?.npcs ?? [];
      let best = null, bd = 1e9;
      for (const n of npcs) {
        const q = n.position ?? n.mesh?.position;
        if (!q) continue;
        const d = Math.hypot(q.x - p.x, q.z - p.z);
        if (d < bd) { bd = d; best = { id: n.id ?? n.name ?? n.species, x: +q.x.toFixed(2), y: +q.y.toFixed(2), z: +q.z.toFixed(2), d: +d.toFixed(2) }; }
      }
      return best;
    })()`);
    if (!info) return { npc: null, note: 'no NPC in this world' };
    /* Teleport to 2 m short of them, then press E for real. Teleport is
     * labelled as such: walking 200 m with W is a different probe, and this
     * one is about whether the interact key opens a conversation. */
    await cmd('teleport', { x: info.x + 2, y: info.y + 1, z: info.z, yaw: 0 });
    await cmd('frames', { n: 20 });
    await cmd('clearconsole');
    await cmd('key', { code: 'KeyE', ms: 150 });
    await cmd('frames', { n: 40 });
    const chat = await js(`(() => {
      const el = document.querySelector('[class*="chat"], [class*="dialog"], [class*="npc"]');
      return el ? { visible: el.offsetParent !== null, text: (el.innerText||'').slice(0,300) } : null;
    })()`);
    await shot('npc-talk');
    return { npc: info, chat, console: await cmd('console', { n: 6 }) };
  });

  /* ---- 7. Errors the page raised while all of that happened ----- */
  const errors = await js('(window.__HARNESS_ERRORS__ || []).slice(0, 30)');
  const consoleTail = await cmd('console', { n: 40, match: 'error|warn|exception|fail' });

  await shot('final');

  const report = {
    world: args.world,
    at: new Date().toISOString(),
    spawn,
    status: status0,
    probes: results,
    pageErrors: errors,
    consoleProblems: consoleTail,
  };
  const outFile = path.resolve(root, args.out, 'sweep.json');
  await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nwrote ${path.relative(root, outFile)}`);
  console.log(`page errors: ${errors.length}`);
  for (const e of errors.slice(0, 8)) console.log(`  ! ${String(e).slice(0, 200)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
