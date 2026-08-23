/**
 * Reports every credit change to the server, so the server can own the balance.
 *
 * ── Why this listens to a bus event instead of editing 22 call sites ───────
 *
 * `POST /api/game/state` used to take a `credits` number from the browser and
 * write it to the account. The balance was whatever the client last said. The
 * replacement is: the client reports WHAT HAPPENED, and the server decides what
 * it was worth.
 *
 * The obvious way to do that is to edit every place that grants credits. There
 * are 22 of them, the design document listed 13, and the failure mode when one
 * is missed is that players silently stop being paid for it -- invisible to
 * everyone except the player, who quits.
 *
 * So this does not edit them. Every credit change in the game already funnels
 * through `Economy.add`/`spend`/`set`, all three of which emit exactly one
 * event, `credits:changed`, from exactly one line (`Economy.js:160` -- verified,
 * it is the only emitter in the tree). Listening there covers every source that
 * exists and every source anyone adds later, without those authors knowing this
 * file exists.
 *
 * ── What is deliberately NOT reported ─────────────────────────────────────
 *
 * `set()` is not gameplay. It is the save file loading, or the account sync
 * writing the server's own answer back into the mirror. Reporting those would
 * either double-count the whole balance or feed the server its own reply.
 *
 * ── Offline, and why the queue is durable ─────────────────────────────────
 *
 * A signed-out player's credits are local, exactly as before -- nothing is
 * queued, because there is no account to attribute it to.
 *
 * For a signed-in player the queue is written to localStorage on every change,
 * because the alternative is that a crash, a lost connection or a closed tab
 * costs the player the last few minutes of earnings. Re-sending is safe: every
 * event carries an idempotency key and the server's UNIQUE constraint pays once.
 * That is what makes `pagehide` workable at all -- `sendBeacon` cannot read a
 * response, so the queue is NOT cleared on the way out; the next boot re-sends
 * it and the duplicates are refused.
 */

/**
 * Only these two operations are gameplay. `set` never is.
 *
 * This filters on the OPERATION, not on the reason tag, and the difference is
 * not academic. `QuestSystem` completes a quest by writing the server's absolute
 * balance with `economy.set(next, 'quest')` -- same tag it uses for a reward
 * `add`. A reporter that blocklisted tags would have to know that 'quest' is
 * sometimes a delta and sometimes a whole balance, and the day it got that wrong
 * it would report a player's entire net worth as freshly earned credits.
 */
const REPORTED_OPS = new Set(['add', 'spend']);

/** Stop growing the queue at some point; a runaway is a bug, not a fortune. */
const MAX_QUEUED = 2000;

/** One request carries at most this many events. */
const BATCH = 100;

const STORE_KEY = 'aether:credit-queue:v1';

export class CreditReporter {
  /**
   * @param {{
   *   bus: import('../core/EventBus.js').EventBus,
   *   economy: import('./Economy.js').Economy,
   *   endpoint?: string,
   *   storage?: Storage|null,
   *   fetch?: typeof fetch,
   *   now?: () => number,
   * }} ctx
   */
  constructor({ bus, economy, endpoint = '/api/game/credits', storage, fetch: fetchImpl, now } = {}) {
    this.bus = bus;
    this.economy = economy;
    this.endpoint = endpoint;
    this._fetch = fetchImpl ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    this._now = now ?? (() => Date.now());
    this._storage = storage === undefined
      ? (typeof localStorage !== 'undefined' ? localStorage : null)
      : storage;

    /** Nothing is queued until an account is known. */
    this.active = false;

    /** @type {Array<{key:string, reason:string, delta:number}>} */
    this._queue = [];
    this._seq = 0;
    this._session = this._newSessionId();
    this._inFlight = false;
    this._timer = null;
    this._dropped = 0;

    this._restore();

    /** @type {Array<() => void>} */
    this._offs = [];
    if (bus) {
      this._offs.push(bus.on('credits:changed', (e) => this._onChanged(e)));
    }
  }

  /**
   * Turn reporting on once the account is known, and flush anything a previous
   * session left behind.
   */
  start() {
    this.active = true;
    if (this._queue.length) this.schedule();
  }

  /** Queue depth — the tests read this, and so does the pagehide path. */
  get pending() {
    return this._queue.length;
  }

  _newSessionId() {
    try {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    } catch { /* fall through */ }
    return `s-${Math.random().toString(36).slice(2)}-${this._now()}`;
  }

  _onChanged(event) {
    if (!this.active) return;
    if (!REPORTED_OPS.has(event?.op)) return;
    const reason = typeof event?.reason === 'string' ? event.reason : 'unknown';

    const delta = Math.trunc(Number(event?.delta));
    if (!Number.isFinite(delta) || delta === 0) return;

    if (this._queue.length >= MAX_QUEUED) {
      this._dropped++;
      return;
    }
    this._queue.push({ key: `${this._session}:${this._seq++}`, reason, delta });
    this._persist();
    this.schedule();
  }

  _persist() {
    if (!this._storage) return;
    try {
      this._storage.setItem(STORE_KEY, JSON.stringify({ v: 1, seq: this._seq, queue: this._queue }));
    } catch { /* a full or disabled store must not break the game */ }
  }

  _restore() {
    if (!this._storage) return;
    try {
      const raw = this._storage.getItem(STORE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.queue)) return;
      // Keys from the previous session are kept exactly as they were: re-sending
      // them is the whole point, and a fresh key would pay twice.
      this._queue = data.queue
        .filter((e) => e && typeof e.key === 'string' && typeof e.reason === 'string')
        .map((e) => ({ key: e.key, reason: e.reason, delta: Math.trunc(Number(e.delta)) || 0 }))
        .filter((e) => e.delta !== 0)
        .slice(0, MAX_QUEUED);
    } catch { /* unreadable queue: better to lose it than to fail the boot */ }
  }

  /** Debounced flush. */
  schedule(ms = 1500) {
    if (!this.active || this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush().catch(() => {});
    }, ms);
    // A pending report must never be the reason a process stays alive. Node
    // offers unref; browsers do not, and do not need it.
    if (typeof this._timer?.unref === 'function') this._timer.unref();
  }

  /**
   * Send a batch and adopt the server's answer.
   *
   * The mirror is only overwritten when the queue has drained. Mid-flush the
   * local number is legitimately AHEAD of the server -- the player has earned
   * things the server has not been told about yet -- and writing the server's
   * balance over it would visibly take credits away and then give them back.
   */
  async flush() {
    if (!this.active || this._inFlight || !this._queue.length || !this._fetch) return false;
    this._inFlight = true;
    const batch = this._queue.slice(0, BATCH);
    try {
      const res = await this._fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: batch }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();

      // Acknowledged: drop exactly these, by key, because the queue may have
      // grown while the request was in flight.
      const sent = new Set(batch.map((e) => e.key));
      this._queue = this._queue.filter((e) => !sent.has(e.key));
      this._persist();

      if (this._queue.length === 0 && typeof body?.balance === 'number') {
        this.economy?.set?.(body.balance, 'server');
      }
      return true;
    } catch (err) {
      // The queue is untouched, so the next attempt re-sends the same keys and
      // the server refuses the ones it already honoured.
      if (typeof console !== 'undefined') {
        console.warn('[credits] report failed:', err?.message ?? err);
      }
      return false;
    } finally {
      this._inFlight = false;
      if (this._queue.length) this.schedule(4000);
    }
  }

  /**
   * Tab close. `sendBeacon` survives teardown where `fetch` does not, but it
   * cannot report success — so the queue is deliberately NOT cleared here. The
   * next boot re-sends it and the server's UNIQUE (player_id, event_key) refuses
   * whatever already landed. Losing a duplicate is free; losing an earning is
   * not.
   */
  beacon() {
    if (!this.active || !this._queue.length) return false;
    try {
      const body = JSON.stringify({ events: this._queue.slice(0, BATCH) });
      const blob = new Blob([body], { type: 'application/json' });
      return navigator?.sendBeacon?.(this.endpoint, blob) ?? false;
    } catch {
      return false;
    }
  }

  dispose() {
    for (const off of this._offs) {
      try { off(); } catch { /* a bus that already cleared its handlers is fine */ }
    }
    this._offs.length = 0;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }
}
