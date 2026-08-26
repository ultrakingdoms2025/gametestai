import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Telemetry } from '../../src/systems/Telemetry.js';
import { TELEMETRY_KINDS, isValidSessionId } from './telemetry';

/**
 * The client reporter, tested from the site suite because the repo's file
 * ownership puts exactly one new file in src/ and its tests belong with the
 * server they talk to — the two halves share a vocabulary, and this file is
 * where that agreement is enforced.
 *
 * No browser: everything the class touches is injected (bus, fetch,
 * navigator, window, clock). What CANNOT be verified here and stays
 * unverified: a real browser actually delivering `sendBeacon` payloads
 * during a real tab close.
 */

const SRC_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'src', 'systems', 'Telemetry.js'
);

/** The smallest bus that satisfies Telemetry. */
function makeBus() {
  const handlers = new Map<string, Set<(p?: unknown) => void>>();
  return {
    subscribed: [] as string[],
    on(name: string, fn: (p?: unknown) => void) {
      this.subscribed.push(name);
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(fn);
      return () => handlers.get(name)?.delete(fn);
    },
    emit(name: string, payload?: unknown) {
      for (const fn of handlers.get(name) ?? []) fn(payload);
    },
  };
}

type FetchCall = { url: string; init: { method?: string; body?: string; keepalive?: boolean } };

function makeFetch(respond: () => Promise<{ ok: boolean }> = async () => ({ ok: true })) {
  const calls: FetchCall[] = [];
  const fn = (url: string, init?: object) => {
    calls.push({ url, init: (init ?? {}) as FetchCall['init'] });
    return respond();
  };
  return { calls, fn };
}

function make(over: Record<string, unknown> = {}) {
  const bus = makeBus();
  const { calls, fn } = makeFetch();
  const t = new Telemetry({ bus, fetch: fn, nav: {}, win: null, ...over });
  return { bus, calls, t };
}

/* ── Source contract: the file must stay untangled from the game ───────── */

describe('Telemetry.js source contract', () => {
  const source = readFileSync(SRC_PATH, 'utf8');
  // The contract is about CODE. The header comment legitimately quotes the
  // two wiring lines for main.js (including `import ... from`), so comments
  // are stripped before asserting.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('imports nothing — the bus contract is its entire dependency surface', () => {
    // Zero import statements of any form; the bus is handed in.
    expect(code).not.toMatch(/^\s*import[\s{]/m);
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/from\s+['"]\.\.?\//);
  });

  it('never touches main.js or the economy', () => {
    expect(code).not.toMatch(/main\.js/i);
    // Observing `credits:changed` on the bus is the design; CALLING the
    // economy would break the write-only rule.
    expect(code).not.toMatch(/economy\.(add|spend|set)/i);
  });

  it('has the pagehide beacon path the flush interval cannot cover', () => {
    expect(code).toContain("'pagehide'");
    expect(code).toContain('sendBeacon');
    expect(code).toContain('keepalive');
  });
});

/* ── Vocabulary: client and server must agree ──────────────────────────── */

describe('Telemetry vocabulary', () => {
  it('every kind the client can emit is on the server allowlist', () => {
    const { bus, t } = make();
    // Fire every subscribed bus event with a plausible payload…
    for (const name of [...new Set(bus.subscribed)]) {
      bus.emit(name, {
        id: 'x', gameId: 'g', venueId: 'v', itemId: 'i', circuitId: 'c',
        credits: 5, delta: 5, qty: 1, place: 1, done: 1, total: 5,
        op: 'add', reason: 'kill', kind: 'buy', won: true, weaponId: 'sword',
      });
    }
    // …and every buffered kind must be a name the server accepts.
    expect(t.pending).toBeGreaterThan(0);
    const kinds = (t as unknown as { _buffer: Array<{ kind: string }> })._buffer.map((e) => e.kind);
    for (const k of kinds) {
      expect(TELEMETRY_KINDS).toContain(k as (typeof TELEMETRY_KINDS)[number]);
    }
  });

  it('subscribes to the real emitters, verified against the tree by grep', () => {
    const { bus } = make();
    expect(new Set(bus.subscribed)).toEqual(new Set([
      'game:started',
      'world:changed',
      'quests:quest:complete',
      'minigame:started',
      'minigame:finished',
      'race:finished',
      'onboarding:step',
      'market:trade',
      'npc:killed',
      'player:died',
      'player:respawned',
      'credits:changed',
    ]));
  });

  it('mints a session id the server-side validator accepts', () => {
    const { t } = make();
    expect(isValidSessionId(t.sessionId)).toBe(true);
  });
});

/* ── Buffering ─────────────────────────────────────────────────────────── */

describe('Telemetry buffering', () => {
  it('stamps the current world onto later events', () => {
    const { bus, t } = make();
    bus.emit('world:changed', { id: 'lodestar' });
    bus.emit('npc:killed', { weaponId: 'bow', byPlayer: true });
    const buf = (t as unknown as { _buffer: Array<{ kind: string; world: string | null }> })._buffer;
    expect(buf[0].world).toBe('lodestar'); // the entry itself carries the new world
    expect(buf[1].world).toBe('lodestar');
  });

  it("observes credits add/spend and skips `set` — bookkeeping is not economy", () => {
    const { bus, t } = make();
    bus.emit('credits:changed', { credits: 100, delta: 5, reason: 'kill', op: 'add' });
    bus.emit('credits:changed', { credits: 500, delta: 500, reason: 'quest', op: 'set' });
    bus.emit('credits:changed', { credits: 50, delta: -50, reason: 'market', op: 'spend', itemId: 'sword_upgrade' });
    const buf = (t as unknown as { _buffer: Array<{ kind: string; detail: Record<string, unknown> }> })._buffer;
    expect(buf).toHaveLength(2); // the `set` never entered the buffer
    expect(buf[0].detail).toEqual({ reason: 'kill', delta: 5, op: 'add' });
    // Never the balance — the flow is the measurement, the balance is the
    // server's own number.
    expect(buf[0].detail).not.toHaveProperty('credits');
    expect(buf[1].detail).toEqual({ reason: 'market', delta: -50, op: 'spend', itemId: 'sword_upgrade' });
  });

  it('caps the buffer and counts the drops instead of growing forever', () => {
    const { bus, t } = make();
    for (let i = 0; i < 350; i++) bus.emit('npc:killed', { weaponId: 'sword' });
    expect(t.pending).toBe(300); // BUFFER_CAP in src/systems/Telemetry.js
    expect(t.dropped).toBe(50);
  });

  it('a handler fed hostile payloads drops the event, never throws', () => {
    const { bus, t } = make();
    const evil = {} as Record<string, unknown>;
    Object.defineProperty(evil, 'gameId', { get() { throw new Error('boom'); } });
    expect(() => bus.emit('minigame:started', evil)).not.toThrow();
    expect(() => bus.emit('minigame:started', undefined)).not.toThrow();
    expect(t.pending).toBe(1); // the undefined payload still yields a bare event
  });
});

/* ── Flushing ──────────────────────────────────────────────────────────── */

describe('Telemetry flush', () => {
  it('sends one batch per flush with the session id and drains on 2xx', async () => {
    const { bus, calls, t } = make();
    bus.emit('game:started');
    bus.emit('world:changed', { id: 'station' });
    expect(await t.flush()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/telemetry');
    const body = JSON.parse(calls[0].init.body!);
    expect(body.session_id).toBe(t.sessionId);
    expect(body.events).toHaveLength(2);
    expect(body.events[0]).toMatchObject({ kind: 'session_start' });
    expect(typeof body.events[0].client_ts).toBe('number');
    expect(t.pending).toBe(0);
  });

  it('puts the batch back on network failure (bounded), drops it on refusal', async () => {
    // Network trouble: batch restored for the next tick.
    const failing = makeFetch(async () => { throw new Error('offline-ish'); });
    const bus1 = makeBus();
    const t1 = new Telemetry({ bus: bus1, fetch: failing.fn, nav: {}, win: null });
    bus1.emit('game:started');
    expect(await t1.flush()).toBe(false);
    expect(t1.pending).toBe(1);

    // Server refusal (rate limit, bad deploy — anything non-ok): dropped,
    // because re-sending a refused batch is a storm, not a delivery.
    const refusing = makeFetch(async () => ({ ok: false }));
    const bus2 = makeBus();
    const t2 = new Telemetry({ bus: bus2, fetch: refusing.fn, nav: {}, win: null });
    bus2.emit('game:started');
    expect(await t2.flush()).toBe(false);
    expect(t2.pending).toBe(0);
  });

  it('holds the buffer while offline instead of burning requests', async () => {
    const { calls, fn } = makeFetch();
    const bus = makeBus();
    const t = new Telemetry({ bus, fetch: fn, nav: { onLine: false }, win: null });
    bus.emit('game:started');
    expect(await t.flush()).toBe(false);
    expect(calls).toHaveLength(0);
    expect(t.pending).toBe(1);
  });
});

/* ── The way out: pagehide ─────────────────────────────────────────────── */

describe('Telemetry pagehide beacon', () => {
  it('start() arms a pagehide listener that beacons the buffer', () => {
    const beacons: Array<{ url: string }> = [];
    const listeners = new Map<string, () => void>();
    const win = {
      addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
      removeEventListener: () => {},
    };
    const nav = { sendBeacon: (url: string) => { beacons.push({ url }); return true; } };
    const bus = makeBus();
    const t = new Telemetry({ bus, fetch: makeFetch().fn, nav, win, flushMs: 0 });
    t.start();
    expect(listeners.has('pagehide')).toBe(true);

    bus.emit('game:started');
    listeners.get('pagehide')!();
    expect(beacons).toHaveLength(1);
    expect(beacons[0].url).toBe('/api/telemetry');
    expect(t.pending).toBe(0); // lossy by design: gone from the buffer either way
    t.stop();
  });

  it('falls back to fetch keepalive when sendBeacon does not exist', () => {
    const { calls, fn } = makeFetch();
    const bus = makeBus();
    const t = new Telemetry({ bus, fetch: fn, nav: {}, win: null });
    bus.emit('game:started');
    expect(t.beacon()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].init.keepalive).toBe(true);
    const body = JSON.parse(calls[0].init.body!);
    expect(body.session_id).toBe(t.sessionId);
  });

  it('beacons nothing when the buffer is empty', () => {
    const beacons: string[] = [];
    const nav = { sendBeacon: (url: string) => { beacons.push(url); return true; } };
    const bus = makeBus();
    const t = new Telemetry({ bus, fetch: makeFetch().fn, nav, win: null });
    expect(t.beacon()).toBe(false);
    expect(beacons).toHaveLength(0);
  });
});
