import { describe, it, expect } from 'vitest';
import { checkGameState, MAX_ITEM_QTY, LARGEST_LEGITIMATE_ITEM_QTY } from './gameStateShape';

/**
 * What `players.game_state` will accept.
 *
 * The column used to be written as `JSON.stringify(state).slice(0, 200_000)`
 * with no validation at all, which was two faults in one line:
 *
 *   - whatever a signed-in browser sent was stored, so an account row carried
 *     an attacker-writable free-form blob;
 *   - `slice()` on JSON cuts mid-token, so a save one byte over the limit was
 *     stored as an unparseable fragment. `getGameState` then threw, caught, and
 *     returned null — SILENTLY. The player's whole inventory, mounts,
 *     cosmetics, ship and character were gone with no error anywhere.
 */

/** The shape `buildRemotePayload()` in `src/main.js` actually sends. */
function realisticState() {
  return {
    v: 1,
    at: Date.now(),
    inventory: {
      version: 1,
      capacity: 30,
      store: [['bullet', 240], ['ore_iron', 60]],
      bag: [['medkit', 4]],
    },
    mounts: { owned: ['strider'] },
    cosmetics: { skin: 'default' },
    piloting: { ship: 'skiff', at: [1, 2, 3] },
    character: { build: 'a' },
  };
}

describe('the shape it accepts', () => {
  it('accepts what the shipped client sends, unchanged', () => {
    const out = checkGameState(realisticState());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.dropped).toEqual([]);
    expect(out.state.inventory).toEqual(realisticState().inventory);
  });

  it('accepts null for any section — a system the player has not touched', () => {
    const out = checkGameState({ v: 1, at: 1, inventory: null, mounts: null });
    expect(out.ok).toBe(true);
  });

  it('refuses a top-level value that is not an object at all', () => {
    for (const bad of [null, 'a string', 42, [1, 2, 3]]) {
      expect(checkGameState(bad).ok).toBe(false);
    }
  });

  it('refuses a KNOWN key of the wrong type rather than storing it', () => {
    /* Not version skew — no client ever sent this — so it is a refusal, not a
     * drop. */
    expect(checkGameState({ ...realisticState(), inventory: 'not an object' }).ok).toBe(false);
    expect(checkGameState({ ...realisticState(), v: 'one' }).ok).toBe(false);
  });

  it('DROPS an unknown key instead of refusing the whole save', () => {
    /* The asymmetry is deliberate. An unknown key is most likely a newer client
     * talking to an older deployment, and this repository's standing rule is
     * that the failure mode to design against is LOSS: refusing would stop that
     * player's inventory saving at all, dropping costs them only the field. */
    const out = checkGameState({ ...realisticState(), somethingNew: { a: 1 }, evil: 'x' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.dropped.sort()).toEqual(['evil', 'somethingNew']);
    expect(out.state).not.toHaveProperty('somethingNew');
    expect(out.state).not.toHaveProperty('evil');
  });
});

describe('the bound on item quantities', () => {
  it('leaves the largest legitimate holding well clear of the ceiling', () => {
    /* 60 slots times the largest stack size in ItemDefs (240). The ceiling is
     * roughly seven times that, which is the headroom convention
     * `creditPricing.ts` sets out: only a forgery should ever reach it. */
    expect(LARGEST_LEGITIMATE_ITEM_QTY).toBe(14_400);
    expect(MAX_ITEM_QTY).toBeGreaterThan(LARGEST_LEGITIMATE_ITEM_QTY * 2);
  });

  it('accepts a full legitimate stack', () => {
    const state = realisticState();
    state.inventory.store = [['ore_iron', LARGEST_LEGITIMATE_ITEM_QTY]];
    expect(checkGameState(state).ok).toBe(true);
  });

  it('refuses a forged quantity in the bag or the store', () => {
    for (const section of ['bag', 'store'] as const) {
      const state = realisticState();
      state.inventory[section] = [['ore_iron', MAX_ITEM_QTY + 1]];
      const out = checkGameState(state);
      expect(out.ok, `${section} accepted an over-ceiling quantity`).toBe(false);
    }
  });

  it('refuses a negative quantity', () => {
    const state = realisticState();
    state.inventory.bag = [['medkit', -5]];
    expect(checkGameState(state).ok).toBe(false);
  });

  it('bounds the `{id, qty}` spelling too, not just the pair form', () => {
    /* `Inventory.deserialize` accepts both, so a bound that covered only one of
     * two accepted spellings would not be a bound. */
    const state = realisticState();
    (state.inventory as Record<string, unknown>).bag = [{ id: 'medkit', qty: MAX_ITEM_QTY + 1 }];
    expect(checkGameState(state).ok).toBe(false);
  });

  it('refuses a collection that is not an array', () => {
    const state = realisticState();
    (state.inventory as Record<string, unknown>).bag = { medkit: 1 };
    expect(checkGameState(state).ok).toBe(false);
  });
});

describe('size', () => {
  it('REFUSES an oversized save rather than truncating it into invalid JSON', () => {
    /* The old `slice(0, 200_000)` stored a fragment that would not parse, so
     * the next read silently returned null and the save was gone. Refusing is
     * the only outcome that leaves the previous good save standing. */
    const state = realisticState();
    (state as Record<string, unknown>).cosmetics = { blob: 'x'.repeat(300_000) };
    const out = checkGameState(state);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toMatch(/too large/i);
  });
});
