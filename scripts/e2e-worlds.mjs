/**
 * WORLD BY WORLD — the Phase 12 pass over every world, with real key input.
 *
 *   node scripts/playthrough.mjs --world station --port 7801 &
 *   node scripts/e2e-worlds.mjs --port 7801 --out .probe/e2e/worlds
 *
 * For each registered world it does what a player does on arriving: enters,
 * looks, walks, jumps, swaps a weapon, calls a mount, finds the mini-games and
 * the portals, and leaves. It records the frame gaps around each of those,
 * because Phase 1's acceptance criterion is about the hitch on exactly those
 * five events and it has never been measured.
 *
 * ── Why one process and not nine ─────────────────────────────────────────
 *
 * `HARNESS.goto()` is the same world switch the portals drive, so entering
 * nine worlds in one session tests the thing a player actually does - it also
 * tests REPEATED entry, which the criterion names and which a fresh boot per
 * world would never reach. The cost is that world 1 is a cold shader cache and
 * world 9 is a warm one; every row records its own order so a reader can see
 * that rather than be misled by it.
 *
 * ── What "measured" means here ───────────────────────────────────────────
 *
 * Every number is a `performance.now()` delta between consecutive rAF
 * callbacks, sampled in the page across the action and read back afterwards.
 * Not an average - averages hide the spike this is about. `max` and `over250`
 * are the figures the criterion is written in.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = { port: 7801, out: '.probe/e2e/worlds', worlds: null, shots: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const next = () => argv[++i];
    if (a === '--port') out.port = Number(next());
    else if (a === '--out') out.out = next();
    else if (a === '--worlds') out.worlds = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--no-shots') out.shots = false;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const BASE = `http://127.0.0.1:${args.port}`;

async function cmd(name, payload) {
  const res = await fetch(`${BASE}/${name}`, {
    method: 'POST', body: payload === undefined ? '' : JSON.stringify(payload),
  });
  const t = await res.text();
  try { return JSON.parse(t); } catch { return { raw: t.slice(0, 400), httpStatus: res.status }; }
}
const js = (expr, aw = false) => cmd('js', { expr, await: aw });
const parse = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return v; } };

const dist = (a, b) => (!a || !b) ? null : +Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]).toFixed(2);

/** Arm the rAF gap sampler, run `fn`, and return what the frame loop did. */
async function timed(label, fn) {
  await cmd('gaps', { action: 'arm', label });
  let result = null, error = null;
  try { result = await fn(); } catch (e) { error = String(e.message ?? e); }
  const gaps = await cmd('gaps', { action: 'stop' });
  return { label, gaps, result, error };
}

async function main() {
  const outDir = path.resolve(root, args.out);
  await mkdir(outDir, { recursive: true });

  // The probe library, re-injected per world: a world switch does not clear
  // `window`, but a reload would, and this costs nothing.
  const lib = await readFile(path.join(root, 'scripts', 'e2e-probe-lib.js'), 'utf8');

  // `ids` is a GETTER on WorldManager, not a method - calling it throws, and a
  // throw here would have been read as "no worlds registered".
  const ids = args.worlds ?? parse(await js('JSON.stringify(window.GAME.worldManager.ids)'));
  console.log(`worlds: ${ids.join(', ')}\n`);

  const rows = [];
  let order = 0;

  for (const world of ids) {
    order++;
    console.log(`\n────────── ${order}. ${world} ──────────`);
    const row = { order, world };

    /* 1. ENTRY. The criterion's "world entry". */
    const entry = await timed(`enter:${world}`, async () => {
      const r = await cmd('goto', { world });
      await cmd('frames', { n: 30 });
      return r;
    });
    row.entry = entry;
    const landed = parse(await js('window.GAME.worldManager.active?.id ?? null'));
    row.landedIn = landed;
    if (landed !== world) {
      row.ENTRY_FAILED = `asked for ${world}, landed in ${landed}`;
      console.log(`  !! ENTRY FAILED: asked ${world}, got ${landed}`);
    }
    console.log(`  entry ${entry.gaps?.max}ms max, over250=${entry.gaps?.over250}, ${entry.result?.ms}ms wall`);

    await cmd('js', { expr: lib });
    await cmd('frames', { n: 10 });

    /* 2. WHERE DID THE PLAYER LAND, AND ARE THEY ALIVE? */
    const state = parse(await js('JSON.stringify(__PROBE__.all())'));
    row.state = state;
    row.spawn = state?.pos;
    row.health = state?.health;
    console.log(`  spawn ${JSON.stringify(state?.pos)} health=${state?.health} blocks=${JSON.stringify(state?.blocks)}`);

    /* Is the spawn point inside solid geometry, or over a void? Both are
     * loop-blockers and neither shows up as an error. */
    row.spawnSanity = parse(await js(`JSON.stringify((() => {
      const G = window.GAME, p = G.player.position;
      const ph = G.physics;
      let inside = null, ground = null;
      try { inside = ph.containsPoint ? ph.containsPoint(p) : null; } catch (e) { inside = 'threw: ' + e.message; }
      try { ground = ph.groundHeight ? +ph.groundHeight(p.x, p.z).toFixed(2) : null; } catch (e) { ground = 'threw: ' + e.message; }
      return { insideCollider: inside, groundBelow: ground, dropToGround: (typeof ground === 'number') ? +(p.y - ground).toFixed(2) : null };
    })())`));
    console.log(`  spawn sanity ${JSON.stringify(row.spawnSanity)}`);

    /* 3. MOVEMENT — the most basic loop-blocker of all. */
    const before = state?.pos;
    await cmd('hold', { codes: ['KeyW'], ms: 1400 });
    await cmd('frames', { n: 8 });
    const afterW = parse(await js('JSON.stringify(window.GAME.player.position.toArray().map(v=>+v.toFixed(2)))'));
    row.walk = { from: before, to: afterW, moved: dist(before, afterW) };
    console.log(`  walk W 1.4s -> ${row.walk.moved}m`);

    /* 4. JUMP. */
    const yBefore = afterW?.[1];
    await cmd('down', { codes: ['Space'] });
    let peak = yBefore ?? 0;
    for (let i = 0; i < 24; i++) {
      await cmd('frames', { n: 2 });
      const p = parse(await js('window.GAME.player.position.y'));
      if (typeof p === 'number' && p > peak) peak = p;
    }
    await cmd('up', { codes: ['Space'] });
    await cmd('frames', { n: 25 });
    row.jump = { from: +(yBefore ?? 0).toFixed(2), peak: +peak.toFixed(2), rise: +(peak - (yBefore ?? 0)).toFixed(2) };
    console.log(`  jump rise ${row.jump.rise}m`);

    /* 5. FIRST WEAPON CHANGE IN THIS WORLD — the criterion names it. */
    row.weaponChange = await timed(`weapon:${world}`, async () => {
      const a = parse(await js('JSON.stringify(__PROBE__.weapons())'));
      await cmd('key', { code: 'Digit2', ms: 90 });
      await cmd('frames', { n: 20 });
      const b = parse(await js('JSON.stringify(__PROBE__.weapons())'));
      await cmd('key', { code: 'Digit1', ms: 90 });
      await cmd('frames', { n: 20 });
      const c = parse(await js('JSON.stringify(__PROBE__.weapons())'));
      return { start: a?.current?.id, after2: b?.current?.id, after1: c?.current?.id, count: a?.count };
    });
    console.log(`  weapon ${JSON.stringify(row.weaponChange.result)} max gap ${row.weaponChange.gaps?.max}ms`);

    /* 6. FIRST MOUNT LAUNCH IN THIS WORLD — the criterion names it too. */
    row.mountLaunch = await timed(`mount:${world}`, async () => {
      const a = parse(await js('JSON.stringify(__PROBE__.mounts())'));
      /* Summon through the game's own API rather than through the wheel: the
       * wheel is an aim-and-release gesture that needs a pointer, and what is
       * being measured here is the COST of the first mount appearing, which is
       * the same work either way. Which path ran is recorded. */
      const r = parse(await js(`JSON.stringify((() => {
        const M = window.GAME.mounts;
        const id = (M._mounts instanceof Map ? [...M._mounts.keys()] : Object.keys(M._mounts ?? {}))[0] ?? null;
        if (!id) return { summoned: null, reason: 'no mounts registered in this world' };
        try {
          const ok = M.summon(id);
          return { summoned: id, via: 'summon()', returned: ok === undefined ? 'undefined' : String(ok) };
        } catch (e) { return { summoned: null, threw: String(e.message ?? e) }; }
      })())`));
      await cmd('frames', { n: 40 });
      const b = parse(await js('JSON.stringify(__PROBE__.mounts())'));
      /* Ride it: hold W and see whether the mounted player moves. */
      const p0 = parse(await js('JSON.stringify(window.GAME.player.position.toArray().map(v=>+v.toFixed(2)))'));
      await cmd('hold', { codes: ['KeyW'], ms: 1200 });
      await cmd('frames', { n: 8 });
      const p1 = parse(await js('JSON.stringify(window.GAME.player.position.toArray().map(v=>+v.toFixed(2)))'));
      /* Dismount with the real F key. */
      await cmd('key', { code: 'KeyF', ms: 120 });
      await cmd('frames', { n: 30 });
      const c = parse(await js('JSON.stringify(__PROBE__.mounts())'));
      return {
        available: a?.available, activeBefore: a?.active,
        summon: r, activeAfter: b?.active,
        rodeDistance: dist(p0, p1),
        activeAfterDismountKey: c?.active,
      };
    });
    console.log(`  mount ${JSON.stringify(row.mountLaunch.result?.summon)} active=${row.mountLaunch.result?.activeAfter} rode=${row.mountLaunch.result?.rodeDistance}m dismounted=${row.mountLaunch.result?.activeAfterDismountKey === null}  max gap ${row.mountLaunch.gaps?.max}ms`);

    /* 7. FIRST KEYBIND USE — the criterion's fifth event. Esc opens the hub. */
    row.firstKeybind = await timed(`keybind:${world}`, async () => {
      await cmd('key', { code: 'Escape', ms: 120 });
      await cmd('frames', { n: 25 });
      const open = parse(await js(`JSON.stringify((() => {
        const el = document.querySelector('.pm-root, .pause-hub, [class^="pm-"]');
        return el ? { cls: el.className, visible: el.offsetParent !== null, text: (el.innerText||'').slice(0,160) } : null;
      })())`));
      await cmd('key', { code: 'Escape', ms: 120 });
      await cmd('frames', { n: 25 });
      return { hub: open };
    });
    console.log(`  Esc hub ${row.firstKeybind.result?.hub ? 'opened' : 'NOT FOUND'} max gap ${row.firstKeybind.gaps?.max}ms`);

    /* 8. WHAT IS THERE TO DO HERE? */
    row.content = parse(await js(`JSON.stringify((() => {
      const P = window.__PROBE__;
      return { minigames: P.minigames(), portals: P.portals(), quests: P.quests(),
               npcs: window.GAME.npcManager?.npcs?.length ?? null };
    })())`));
    const mg = row.content?.minigames;
    console.log(`  content: ${mg?.venueCount ?? '?'} minigames, ${row.content?.portals?.length ?? '?'} portals, ${row.content?.npcs ?? '?'} NPCs, ${row.content?.quests?.questCount ?? '?'} quests`);

    /* 9. A PICTURE, so "it looked wrong" can be checked rather than asserted. */
    if (args.shots) {
      const p = path.join(args.out, `${String(order).padStart(2, '0')}-${world}.png`);
      const s = await cmd('shot', { path: p });
      row.shot = s.path ? path.relative(root, s.path) : null;
    }

    /* 10. Anything the page complained about while all that happened. */
    row.errors = parse(await js('JSON.stringify((window.__HARNESS_ERRORS__||[]).slice(-8))'));
    if (row.errors?.length) console.log(`  ! ${row.errors.length} page errors, last: ${String(row.errors[row.errors.length - 1]).slice(0, 160)}`);

    rows.push(row);
  }

  /* ---- REPEATED ENTRY: the criterion's fifth case ----------------- */
  console.log(`\n────────── repeated entry/exit ──────────`);
  const repeat = [];
  const a = ids[0], b = ids[1] ?? ids[0];
  for (let i = 0; i < 3; i++) {
    repeat.push(await timed(`repeat:${a}->${b} #${i + 1}`, async () => {
      await cmd('goto', { world: b });
      await cmd('frames', { n: 20 });
      await cmd('goto', { world: a });
      await cmd('frames', { n: 20 });
      return { pair: [a, b] };
    }));
    console.log(`  round ${i + 1}: max ${repeat[i].gaps?.max}ms over250=${repeat[i].gaps?.over250}`);
  }

  const report = { at: new Date().toISOString(), worlds: ids, rows, repeatedEntry: repeat };
  const f = path.join(outDir, 'worlds.json');
  await writeFile(f, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nwrote ${path.relative(root, f)}`);

  /* ---- The summary a human reads first ---------------------------- */
  console.log(`\n=== SUMMARY ===`);
  console.log('world            entry(max ms)  walk(m)  jump(m)  weapon      mount        minigames  portals  errors');
  for (const r of rows) {
    console.log(
      `${String(r.world).padEnd(16)} ${String(r.entry?.gaps?.max ?? '?').padStart(12)}  ${String(r.walk?.moved ?? '?').padStart(7)}  ${String(r.jump?.rise ?? '?').padStart(7)}  ${String(r.weaponChange?.result?.after2 ?? '-').padEnd(10)}  ${String(r.mountLaunch?.result?.activeAfter ?? '-').padEnd(11)}  ${String(r.content?.minigames?.venueCount ?? '?').padStart(9)}  ${String(r.content?.portals?.length ?? '?').padStart(7)}  ${String(r.errors?.length ?? 0).padStart(6)}`
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
