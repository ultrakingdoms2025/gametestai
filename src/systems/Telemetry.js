/**
 * Telemetry — the client half of the product-KPI layer (brief 5.7).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  HOW TO WIRE THIS IN (the orchestrator's two lines for main.js)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *     import { Telemetry } from './systems/Telemetry.js';
 *     const telemetry = new Telemetry({ bus }); telemetry.start();
 *
 * Anywhere after the bus exists is fine; before the worlds boot is best so
 * `game:started` and the first `world:changed` are caught. Nothing else is
 * required: identity comes from the session cookie on the server side, and
 * the constructor is safe to run signed-out, offline, or in a test.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT IT DOES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Listens to bus events the game ALREADY emits (each name below verified
 * against the tree, not remembered — the world-06 lesson), extracts a few
 * small scalars, buffers them, and flushes a batch to `POST /api/telemetry`
 * every ~30 seconds and on pagehide via `navigator.sendBeacon` (fetch
 * keepalive fallback). One request per flush, never one per event.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT IT REFUSES TO DO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   - Touch balances. `credits:changed` is OBSERVED (op add/spend only,
 *     mirroring CreditReporter's REPORTED_OPS reasoning — `set` is
 *     bookkeeping, and reporting it would count the whole balance as fresh
 *     flow). Nothing here calls Economy, and the server side never joins the
 *     credit ledger. Write-only is the contract.
 *   - Break the game. Every handler and every flush path is wrapped; a
 *     telemetry failure is a dropped event, never an exception in a frame.
 *   - Retry into a storm. A network failure puts the batch back (bounded by
 *     the buffer cap); a server refusal (any non-ok status) DROPS the batch.
 *     Telemetry is lossy by design — there are no idempotency keys, so
 *     "delivered but unacknowledged" must stay impossible: the batch leaves
 *     the buffer only after `res.ok`, or into a beacon on the way out.
 *   - Import anything. The bus is handed in; this file has zero imports, so
 *     it can never entangle main.js (and a test asserts exactly that).
 *
 * Offline (`navigator.onLine === false`) flushes are skipped silently; the
 * buffer keeps the newest BUFFER_CAP events and drops the rest, counted in
 * `dropped` for anyone debugging.
 */

/** Where batches go. The server enforces its own caps; ours stay under them. */
const ENDPOINT = '/api/telemetry';

/** Flush cadence. 30s keeps a session to ~120 requests/hour worst case. */
const FLUSH_MS = 30_000;

/** Buffer ceiling — a runaway emitter is a bug, not a dataset. */
const BUFFER_CAP = 300;

/** Events per request; the server refuses batches over 100. */
const BATCH = 100;

/**
 * bus event → { kind, pick } where `kind` is a name on the SERVER ALLOWLIST
 * (site/lib/telemetry.ts TELEMETRY_KINDS — the two lists must agree; adding
 * an event means editing both) and `pick` extracts ONLY small scalars. Whole
 * payloads are never forwarded: `npc:killed` carries a live NPC object and
 * `world:changed` a whole world — forwarding those would be a 1 KB detail cap
 * violation at best and a serialization loop at worst.
 */
const EVENT_MAP = {
  'game:started': {
    kind: 'session_start',
    pick: () => ({}),
  },
  'world:changed': {
    kind: 'world_enter',
    pick: () => ({}), // the world id rides in the top-level `world` field
  },
  'quests:quest:complete': {
    kind: 'quest_completed',
    pick: (e) => ({
      questId: str(e?.quest?.id ?? e?.engagementId),
      credits: num(e?.credits),
    }),
  },
  'minigame:started': {
    kind: 'minigame_started',
    pick: (e) => ({ gameId: str(e?.gameId), venueId: str(e?.venueId) }),
  },
  'minigame:finished': {
    kind: 'minigame_finished',
    pick: (e) => ({
      gameId: str(e?.gameId),
      venueId: str(e?.venueId),
      won: !!e?.won,
      place: num(e?.place),
      credits: num(e?.credits),
    }),
  },
  'race:finished': {
    kind: 'race_finished',
    pick: (e) => ({
      circuitId: str(e?.circuitId),
      place: num(e?.place),
      dnf: !!e?.dnf,
      credits: num(e?.credits),
      time: num(e?.time),
      difficulty: str(e?.difficulty),
    }),
  },
  'onboarding:step': {
    kind: 'onboarding_step',
    pick: (e) => ({ stepId: str(e?.id), done: num(e?.done), total: num(e?.total) }),
  },
  'market:trade': {
    kind: 'market_trade',
    pick: (e) => ({
      itemId: str(e?.itemId),
      qty: num(e?.qty),
      credits: num(e?.credits),
      tradeKind: str(e?.kind),
    }),
  },
  'npc:killed': {
    kind: 'npc_killed',
    pick: (e) => ({
      weaponId: str(e?.weaponId),
      byPlayer: !!e?.byPlayer,
      npcKind: str(e?.npc?.kind ?? e?.npc?.type),
    }),
  },
  'player:died': {
    kind: 'player_died',
    pick: (e) => ({ byNpc: e?.killerId != null }),
  },
  'player:respawned': {
    kind: 'player_respawned',
    pick: () => ({}),
  },
  'credits:changed': {
    kind: 'credits_delta',
    /* Only gameplay operations, and never the balance. The balance is the
     * server's number echoed back; the FLOW (reason + signed delta) is the
     * measurement brief 5.5 was deferred pending. `set` is a save loading or
     * an account sync — bookkeeping, not economy. */
    pick: (e) => {
      if (e?.op !== 'add' && e?.op !== 'spend') return null; // null = skip event
      const out = { reason: str(e?.reason), delta: num(e?.delta), op: e.op };
      if (typeof e?.itemId === 'string' && e.itemId) out.itemId = str(e.itemId);
      return out;
    },
  },
};

/** Clamp a value into a short string or null — details must stay small. */
function str(v) {
  if (typeof v === 'string' && v) return v.slice(0, 64);
  if (typeof v === 'number' && Number.isFinite(v)) return String(v).slice(0, 64);
  return null;
}

/** Finite number or null. */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export class Telemetry {
  /**
   * @param {{
   *   bus: { on(name: string, fn: Function): Function },
   *   endpoint?: string,
   *   flushMs?: number,
   *   fetch?: (url: string, init?: object) => Promise<{ ok?: boolean }>,
   *   nav?: { sendBeacon?: Function, onLine?: boolean }|null,
   *   win?: { addEventListener?: Function, removeEventListener?: Function }|null,
   *   now?: () => number,
   * }} ctx everything injectable, so tests need no browser.
   */
  constructor({ bus, endpoint = ENDPOINT, flushMs = FLUSH_MS, fetch: fetchImpl, nav, win, now } = {}) {
    this.bus = bus ?? null;
    this.endpoint = endpoint;
    this.flushMs = flushMs;
    this._now = now ?? (() => Date.now());
    this._fetch = fetchImpl ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    this._nav = nav !== undefined ? nav : (typeof navigator !== 'undefined' ? navigator : null);
    this._win = win !== undefined ? win : (typeof window !== 'undefined' ? window : null);

    /** One id per boot; the server groups a session's events by it. */
    this.sessionId = this._newSessionId();

    /** @type {Array<{kind:string, world:string|null, detail:object, client_ts:number}>} */
    this._buffer = [];
    this.dropped = 0;
    this._world = null;
    this._timer = null;
    this._inFlight = false;
    this._offs = [];

    if (this.bus) {
      for (const [name, spec] of Object.entries(EVENT_MAP)) {
        try {
          const off = this.bus.on(name, (payload) => this._record(name, spec, payload));
          if (typeof off === 'function') this._offs.push(off);
        } catch { /* one bad subscription must not take the rest down */ }
      }
    }
  }

  /** Buffer depth — tests and debugging read this. */
  get pending() {
    return this._buffer.length;
  }

  /**
   * Arm the flush interval and the pagehide beacon. Separate from the
   * constructor so a test can drive `flush()` by hand without timers.
   */
  start() {
    if (!this._timer && this.flushMs > 0) {
      this._timer = setInterval(() => {
        this.flush().catch(() => {});
      }, this.flushMs);
      // Never the reason a process stays alive (Node offers unref; browsers
      // neither have nor need it).
      if (typeof this._timer?.unref === 'function') this._timer.unref();
    }
    if (this._win && typeof this._win.addEventListener === 'function') {
      this._onPagehide = () => this.beacon();
      try {
        this._win.addEventListener('pagehide', this._onPagehide);
      } catch { /* telemetry must never break the boot */ }
    }
    return this;
  }

  /** Detach everything. Mostly for tests; the game never stops reporting. */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._win && this._onPagehide && typeof this._win.removeEventListener === 'function') {
      try { this._win.removeEventListener('pagehide', this._onPagehide); } catch { /* noop */ }
    }
    for (const off of this._offs) {
      try { off(); } catch { /* noop */ }
    }
    this._offs = [];
  }

  _newSessionId() {
    try {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    } catch { /* fall through */ }
    // Same shape the server's session-id check accepts: [A-Za-z0-9:_-]{8,64}.
    return `s-${Math.random().toString(36).slice(2)}-${this._now()}`;
  }

  _record(name, spec, payload) {
    try {
      // World tracking rides on the same subscription that reports the entry.
      if (name === 'world:changed') {
        const id = typeof payload?.id === 'string' ? payload.id : null;
        if (id) this._world = id.slice(0, 64);
      }
      const detail = spec.pick(payload);
      if (detail === null) return; // the picker declined (e.g. a credits `set`)
      if (this._buffer.length >= BUFFER_CAP) {
        this.dropped++;
        return;
      }
      // Strip nulls so the wire stays small and the detail cap stays distant.
      const clean = {};
      for (const [k, v] of Object.entries(detail)) {
        if (v !== null && v !== undefined) clean[k] = v;
      }
      this._buffer.push({
        kind: spec.kind,
        world: this._world,
        detail: clean,
        client_ts: this._now(),
      });
    } catch {
      /* a malformed payload is a dropped event, never a frame error */
    }
  }

  _body(events) {
    return JSON.stringify({ session_id: this.sessionId, events });
  }

  /**
   * Send one batch. Network failure → put it back (bounded); server refusal
   * → drop it (no keys, no dedup, so re-sending a maybe-landed batch is the
   * one thing this file must never do — and a refusal re-sent is refused
   * again anyway).
   */
  async flush() {
    if (this._inFlight || !this._buffer.length || !this._fetch) return false;
    if (this._nav && this._nav.onLine === false) return false; // offline: hold
    this._inFlight = true;
    const batch = this._buffer.splice(0, BATCH);
    try {
      let ok = false;
      try {
        const res = await this._fetch(this.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: this._body(batch),
          keepalive: true,
        });
        ok = !!res?.ok;
        if (!ok) return false; // refused: dropped, deliberately
      } catch {
        // Network trouble: the batch goes back to the front, capped.
        const room = Math.max(0, BUFFER_CAP - this._buffer.length);
        if (room < batch.length) this.dropped += batch.length - room;
        this._buffer.unshift(...batch.slice(0, room));
        return false;
      }
      return ok;
    } finally {
      this._inFlight = false;
    }
  }

  /**
   * The pagehide path. `sendBeacon` is the only delivery a closing tab
   * honours; it cannot report an answer, so the batch is simply gone from
   * the buffer either way — lossy, and fine: the alternative is a duplicate
   * on next boot, and telemetry has no dedup by design.
   */
  beacon() {
    try {
      if (!this._buffer.length) return false;
      const batch = this._buffer.splice(0, BATCH);
      const body = this._body(batch);
      if (this._nav && typeof this._nav.sendBeacon === 'function') {
        try {
          // A bare string posts as text/plain, which the route reads fine —
          // it parses from text — but Blob keeps the content type honest.
          const payload = typeof Blob !== 'undefined'
            ? new Blob([body], { type: 'application/json' })
            : body;
          return this._nav.sendBeacon(this.endpoint, payload);
        } catch { /* fall through to fetch */ }
      }
      if (this._fetch) {
        this._fetch(this.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: true,
        }).catch(() => {});
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }
}
