import { describe, it, expect } from 'vitest';
import { priceEvent, capFor, CREDIT_EVENT_KINDS, type CreditEvent } from './creditPricing';

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

  it('prices race placings by position, not by claim', () => {
    expect(priceEvent(ev('race', '1'))).toBe(10);
    expect(priceEvent(ev('race', '2'))).toBe(5);
    expect(priceEvent(ev('race', '3'))).toBe(2);
  });

  it('pays nothing for a placing outside the podium', () => {
    expect(priceEvent(ev('race', '4'))).toBe(0);
    expect(priceEvent(ev('race', '99'))).toBe(0);
  });

  it('prices a minigame win', () => {
    expect(priceEvent(ev('minigame', 'won'))).toBe(10);
    expect(priceEvent(ev('minigame', 'lost'))).toBe(0);
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
    expect(priceEvent(ev('race', { toString: () => '1' }))).toBe(0);
    expect(priceEvent(ev('race', 1))).toBe(0);
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
