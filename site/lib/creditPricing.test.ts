import { describe, it, expect } from 'vitest';
import {
  priceEvent,
  capFor,
  CREDIT_EVENT_KINDS,
  DECLARED_KINDS,
  type CreditEvent,
} from './creditPricing';

/**
 * What an event is worth, decided here and never by the caller.
 *
 * The hole this closes: `POST /api/game/state` accepted `credits` from the
 * browser and wrote it straight to `players.credit_balance`. The replacement
 * accepts *events* — the client says what happened, the server says what it is
 * worth. Every test below exists to keep that direction of travel.
 *
 * The server cannot verify that a kill happened; it has no simulation. What it
 * can do is price the claim, bound how often it is honoured, and refuse
 * anything it does not recognise. These tests pin all three.
 */

const ev = (kind: string, detail?: unknown): CreditEvent =>
  ({ kind, detail } as unknown as CreditEvent);

describe('priceEvent — the client never sets the amount', () => {
  it('prices a kill from the server table', () => {
    expect(priceEvent(ev('kill'))).toBe(5);
  });

  it('ignores any amount the caller tries to supply', () => {
    // The type forbids it; a hand-rolled request body does not.
    const hostile = { kind: 'kill', detail: 'station', delta: 999999, credits: 999999 };
    expect(priceEvent(hostile as unknown as CreditEvent)).toBe(5);
  });

  it('prices the two-valued kinds by their reason tag', () => {
    // One kind, two constants in the game, told apart by the tag the client
    // reported. Both numbers are pinned to source by creditReasons.test.ts.
    expect(priceEvent(ev('relic', 'relic'))).toBe(120);
    expect(priceEvent(ev('relic', 'relic-set'))).toBe(500);
    expect(priceEvent(ev('maze', 'maze-centre'))).toBe(100);
    expect(priceEvent(ev('maze', 'maze-token'))).toBe(6);
  });

  it('underpays rather than overpays an unrecognised tail', () => {
    // Only reachable from a forged request, since the real tags are pinned.
    expect(priceEvent(ev('relic', 'relic-museum'))).toBe(120);
    expect(priceEvent(ev('maze', 'maze-jackpot'))).toBe(6);
  });

  it('does not flat-price race or minigame', () => {
    // This test used to assert race = 10/5/2 and a minigame win = 10, which was
    // wrong twice over. A race pays its placing PLUS up to 128 in pickups
    // (Pickups.js), and a minigame pays 10 at most venues but 120 at the yard
    // butts (YardPlan.js BUTTS_REWARD) -- so a flat price would have quietly
    // capped both. Worse, the reported event carries no placing or win/lose
    // detail at all, so the old rule would have priced every race and every
    // minigame at ZERO. They are declared and bounded instead.
    expect(priceEvent(ev('race', '1'))).toBe(0);
    expect(priceEvent(ev('minigame', 'won'))).toBe(0);
    expect(DECLARED_KINDS.has('race')).toBe(true);
    expect(DECLARED_KINDS.has('minigame')).toBe(true);
  });

  it('refuses a kind it does not know', () => {
    expect(priceEvent(ev('jackpot'))).toBeNull();
    expect(priceEvent(ev(''))).toBeNull();
    expect(priceEvent(ev('KILL'))).toBeNull(); // exact match only
  });

  it('refuses the admin cheat outright, rather than pricing it at zero', () => {
    // AdminCheats.js can hand a local player any balance. Hiding the button is
    // not a control; the server refusing the kind is.
    expect(priceEvent(ev('cheat'))).toBeNull();
    expect(priceEvent(ev('admin'))).toBeNull();
  });

  it('never returns a negative amount for an earning kind', () => {
    for (const kind of CREDIT_EVENT_KINDS) {
      if (kind === 'purchase') continue; // priced from the catalogue, signed
      const price = priceEvent(ev(kind, '1'));
      if (price === null) continue;
      expect(price).toBeGreaterThanOrEqual(0);
    }
  });

  it('always returns a whole number', () => {
    for (const kind of CREDIT_EVENT_KINDS) {
      const price = priceEvent(ev(kind, '1'));
      if (price === null) continue;
      expect(Number.isInteger(price)).toBe(true);
    }
  });

  it('is not confused by a detail that is not a string', () => {
    // Retargeted onto a kind that still READS detail; race no longer does, so
    // asserting it here would have passed for the wrong reason.
    expect(priceEvent(ev('relic', { toString: () => 'relic-set' }))).toBe(120);
    expect(priceEvent(ev('relic', 1))).toBe(120);
    expect(priceEvent(ev('kill', null))).toBe(5);
  });
});

describe('capFor — a forged stream yields a trickle, not a fortune', () => {
  it('bounds every priced kind', () => {
    for (const kind of CREDIT_EVENT_KINDS) {
      if (priceEvent(ev(kind, '1')) === null) continue;
      const cap = capFor(kind);
      expect(cap, `${kind} has no cap`).toBeTruthy();
      expect(cap!.maxEvents).toBeGreaterThan(0);
      expect(cap!.windowSeconds).toBeGreaterThan(0);
    }
  });

  it('caps kills well above what honest play reaches', () => {
    // A cap that fires during honest play is worse than no cap. The station
    // hostile budget is 18 and they respawn; this leaves generous headroom.
    const cap = capFor('kill')!;
    expect(cap.maxEvents / (cap.windowSeconds / 3600)).toBeGreaterThanOrEqual(120);
  });

  it('returns null for a kind that is not priced', () => {
    expect(capFor('jackpot')).toBeNull();
    expect(capFor('cheat')).toBeNull();
  });
});
