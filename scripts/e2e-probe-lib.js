/**
 * PAGE-SIDE PROBE LIBRARY for the Phase 12 survey.
 *
 * Injected into the running game by `e2e-sweep.mjs` / by hand through the
 * playthrough driver's `/js`. It reads the state a player can see, through
 * the accessors the game actually has.
 *
 * ── Why this is a file and not a string in the sweep ─────────────────────
 *
 * The first pass of the sweep guessed at the object model - `GAME.weapons`,
 * `GAME.weaponSystem`, `w.current.id` - and every one of those guesses read
 * back `null`. A null from a wrong accessor and a null from a broken system
 * are the same character on screen, and a survey that cannot tell them apart
 * reports the game as broken when the probe was. So every path below was
 * read out of `window.GAME` in the live page first (`GAME.loadout._weapons`,
 * `GAME.mounts._active`, `GAME.questSystem.worldQuests`, ...) and the file
 * exists so the same accessors are used in every world.
 *
 * Everything is defensive: a world with no ships must report "no ships", not
 * throw and lose the other twenty readings in the same call.
 */
window.__PROBE__ = {
  /** Weapons: what is held, what is available, and whether it can fire. */
  weapons() {
    const L = window.GAME.loadout;
    if (!L) return null;
    const list = (L._weapons ?? []).map((w) => ({
      id: w?.id ?? w?.name ?? null,
      ammo: w?.ammo ?? null,
      reserve: w?.reserve ?? null,
      magazine: w?.magazine ?? w?.magSize ?? null,
    }));
    return {
      index: L._index ?? null,
      count: list.length,
      current: list[L._index ?? -1] ?? null,
      firing: !!L._firing,
      enabled: L._enabled !== false,
      list,
    };
  },

  /** Mounts: what is unlocked, what is ridden, what powers it has. */
  mounts() {
    const M = window.GAME.mounts;
    if (!M) return null;
    const ids = (M._mounts instanceof Map)
      ? [...M._mounts.keys()]
      : Object.keys(M._mounts ?? {});
    const unlocked = (M._unlocked instanceof Set)
      ? [...M._unlocked]
      : (Array.isArray(M._unlocked) ? M._unlocked : Object.keys(M._unlocked ?? {}));
    /* `active`, `mounted` and `unlocked` are GETTERS on the prototype, not own
     * properties - `Object.keys(GAME.mounts)` does not list them and the first
     * version of this probe read `_active` and reported `null` for a mount the
     * player was sitting on. The live object is also circular (Engine ->
     * PostFX -> Engine), so only scalars are pulled off it. */
    const a = M.active;
    return {
      active: a ? (a.id ?? a.kind ?? a.type ?? 'unnamed') : null,
      mounted: !!M.mounted,
      available: ids,
      unlocked,
      powers: typeof M.getPowers === 'function'
        ? (() => { try { const p = M.getPowers(a?.id ?? ids[0]); return Array.isArray(p) ? p : Object.keys(p ?? {}); } catch { return null; } })()
        : null,
    };
  },

  /** Quests: what the board holds, and how the server answered. */
  quests() {
    const Q = window.GAME.questSystem;
    if (!Q) return null;
    const wq = Q.worldQuests;
    const quests = (wq instanceof Map) ? [...wq.values()] : (Array.isArray(wq) ? wq : Object.values(wq ?? {}));
    const eng = Q.engagements;
    const engagements = (eng instanceof Map) ? [...eng.entries()] : Object.entries(eng ?? {});
    return {
      worldId: Q._worldId ?? null,
      playerId: Q._playerId ?? null,
      questCount: quests.length,
      offlineLogged: !!Q._questsOfflineLogged,
      pending: Q._pending ? (Q._pending.size ?? Q._pending.length ?? null) : null,
      quests: quests.slice(0, 12).map((q) => ({
        id: q?.id ?? null,
        title: q?.title ?? q?.name ?? null,
        steps: (q?.steps ?? []).length,
        verbs: [...new Set((q?.steps ?? []).map((s) => s?.verb ?? s?.type))],
        repeatable: q?.repeatable ?? null,
        reward: q?.reward ?? q?.rewardCredits ?? null,
      })),
      engagements: engagements.slice(0, 12),
    };
  },

  /** Mini-games: the venues in this world, which one is near, and its state. */
  minigames() {
    const M = window.GAME.minigames;
    if (!M) return null;
    const v = M._venues;
    const venues = (v instanceof Map) ? [...v.values()] : (Array.isArray(v) ? v : Object.values(v ?? {}));
    const p = window.GAME.player?.position;
    return {
      worldId: M._worldId ?? null,
      venueCount: venues.length,
      state: M.state ?? null,
      near: M._near?.id ?? M._near?.kind ?? (M._near ? 'unnamed' : null),
      running: M._game ? (M._game.id ?? M._game.kind ?? 'running') : null,
      result: M.result ?? null,
      prompt: M._promptText ?? null,
      factories: (M._factories instanceof Map) ? [...M._factories.keys()] : Object.keys(M._factories ?? {}),
      venues: venues.map((x) => {
        const q = x?.position ?? x?.pos ?? x?.anchor;
        return {
          id: x?.id ?? null, kind: x?.kind ?? x?.game ?? null,
          pos: q ? [+(q.x ?? 0).toFixed(1), +(q.y ?? 0).toFixed(1), +(q.z ?? 0).toFixed(1)] : null,
          distFromPlayer: (q && p) ? +Math.hypot(q.x - p.x, q.z - p.z).toFixed(1) : null,
          radius: x?.radius ?? x?.r ?? null,
        };
      }),
    };
  },

  /** The economy, and what the server-authority reporter has queued. */
  economy() {
    const E = window.GAME.economy;
    const R = window.GAME.creditReporter;
    return {
      credits: E?._credits ?? null,
      earned: E?._earned ?? null,
      spent: E?._spent ?? null,
      kills: E?._kills ?? null,
      awarded: (E?._awarded instanceof Set) ? E._awarded.size : null,
      reporter: R ? {
        keys: Object.keys(R),
        queued: R._queue ? (R._queue.length ?? R._queue.size ?? null) : null,
        report: typeof R.report === 'function' ? 'fn' : null,
      } : null,
    };
  },

  /** Portals: where they go, and how far the player is from each. */
  portals() {
    const P = window.GAME.portals;
    if (!P) return null;
    const list = P.list ?? P.portals ?? P._portals ?? [];
    const arr = (list instanceof Map) ? [...list.values()] : (Array.isArray(list) ? list : Object.values(list));
    const p = window.GAME.player?.position;
    return arr.map((x) => {
      const q = x?.position ?? x?.mesh?.position ?? x?.group?.position;
      return {
        to: x?.to ?? x?.target ?? x?.world ?? x?.destination ?? null,
        id: x?.id ?? null,
        pos: q ? [+q.x.toFixed(1), +q.y.toFixed(1), +q.z.toFixed(1)] : null,
        dist: (q && p) ? +Math.hypot(q.x - p.x, q.z - p.z).toFixed(1) : null,
      };
    });
  },

  /** Everything the HUD is currently telling the player, as text. */
  hud() {
    const out = {};
    const grab = (sel, name) => {
      const el = document.querySelector(sel);
      if (el) out[name] = { visible: el.offsetParent !== null, text: (el.innerText || '').trim().slice(0, 300) };
    };
    grab('.qb-panel', 'questBoard');
    grab('.inv-panel', 'inventory');
    grab('.mm-panel', 'mountMenu');
    grab('.sm-panel', 'shipMenu');
    grab('.ch-panel', 'characterMenu');
    grab('.br-panel', 'bugReport');
    grab('.rc-sheet', 'raceSheet');
    grab('.minimap', 'minimap');
    out.prompt = (document.querySelector('[class*="prompt"]')?.innerText || '').trim().slice(0, 200) || null;
    out.toast = [...document.querySelectorAll('[class*="toast"], [class*="banner"], [class*="notice"]')]
      .filter((e) => e.offsetParent !== null)
      .map((e) => (e.innerText || '').trim().slice(0, 160)).filter(Boolean);
    return out;
  },

  /** Every visible top-level overlay, by class, so "did a menu open" is real. */
  overlays() {
    return [...document.querySelectorAll('body > * , #ui-root > *, .hud > *')]
      .filter((e) => e.offsetParent !== null && e.getBoundingClientRect().width > 120)
      .map((e) => ({
        cls: (typeof e.className === 'string' ? e.className : '').split(/\s+/).filter(Boolean).slice(0, 2).join('.'),
        w: Math.round(e.getBoundingClientRect().width),
        h: Math.round(e.getBoundingClientRect().height),
        text: (e.innerText || '').trim().slice(0, 80),
      }))
      .filter((e) => e.cls);
  },

  /** Progression surfaces that are not quests: objectives, relics, viewpoints. */
  progression() {
    const G = window.GAME;
    const size = (x) => x == null ? null
      : (x instanceof Map || x instanceof Set) ? x.size
        : Array.isArray(x) ? x.length : (typeof x === 'object' ? Object.keys(x).length : x);
    return {
      objectives: G.objectives ? {
        keys: Object.keys(G.objectives).slice(0, 20),
        tiers: size(G.objectives._tiers ?? G.objectives.tiers),
        done: size(G.objectives._done ?? G.objectives.completed),
      } : null,
      relics: G.relics ? { found: size(G.relics._found ?? G.relics.found), total: size(G.relics._all ?? G.relics.all) } : null,
      viewpoints: G.viewpoints ? { found: size(G.viewpoints._found ?? G.viewpoints.found), total: size(G.viewpoints._all ?? G.viewpoints.all) } : null,
      charters: G.charters ? { keys: Object.keys(G.charters).slice(0, 20) } : null,
      retention: G.retention ? { keys: Object.keys(G.retention).slice(0, 20) } : null,
      onboarding: G.onboarding ? { done: G.onboarding._done ?? null } : null,
      inventory: G.inventory ? {
        items: size(G.inventory.items ?? G.inventory._items),
        credits: G.inventory.credits ?? null,
      } : null,
    };
  },

  /** One call, everything. What a probe takes before and after an action. */
  all() {
    const G = window.GAME;
    const p = G.player?.position;
    const out = {
      world: G.worldManager.active?.id ?? null,
      pos: p ? p.toArray().map((v) => +v.toFixed(2)) : null,
      yaw: G.player?.yaw != null ? +G.player.yaw.toFixed(3) : null,
      health: G.player?.health ?? null,
      blocks: G.__dev?.gameplayBlocks?.() ?? null,
    };
    for (const k of ['weapons', 'mounts', 'quests', 'minigames', 'economy', 'progression']) {
      try { out[k] = this[k](); } catch (e) { out[k] = { probeError: String(e.message ?? e) }; }
    }
    return out;
  },
};
'__PROBE__ installed';
