/**
 * What a gameplay event is worth, and how often it may be honoured.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * `POST /api/game/state` accepted a `credits` number from the browser and wrote
 * it to `players.credit_balance` with only a non-negative check. The balance was
 * whatever the client last said. This module is half of the replacement: the
 * client reports *what happened*, and the amount is decided here.
 *
 * ── What server authority can and cannot buy ───────────────────────────────
 *
 * The server has no simulation. It cannot know whether a hostile really died, so
 * it cannot refuse a well-formed lie. What it CAN do, and what this module is
 * for, is:
 *
 *   1. price the claim, so the client never names a number;
 *   2. bound how often a claim is honoured, so a forged stream yields a trickle;
 *   3. refuse a kind it does not recognise, so new claims fail closed.
 *
 * Dedup is the database's job, not this module's — a UNIQUE constraint on
 * (player_id, event_key), so two concurrent replays cannot both win. A Set in a
 * process would not survive two lambdas.
 *
 * ── Keeping these numbers honest ───────────────────────────────────────────
 *
 * The prices mirror the client's current values, because moving the economy's
 * authority and changing its numbers in one step would make any balance
 * complaint impossible to attribute. Sources:
 *   kill      `src/systems/Economy.js:23`       CREDITS_PER_KILL = 5
 *   race      `src/systems/RaceManager.js:48`   RACE_PRIZES = [10, 5, 2]
 *   minigame  MinigameManager payout, 10 on a win
 */

/** Every kind the server will consider. Anything else is refused. */
export const CREDIT_EVENT_KINDS = [
  'kill',
  'loot',
  'race',
  'minigame',
  'relic',
  'viewpoint',
  'maze',
  'objective',
  'quest',
  'purchase',
  'migration',
] as const;

export type CreditEventKind = (typeof CREDIT_EVENT_KINDS)[number];

export interface CreditEvent {
  kind: CreditEventKind;
  /** Free-form discriminator: a race placing, a world id, an item id. */
  detail?: string;
}

export interface CreditCap {
  maxEvents: number;
  windowSeconds: number;
}

const HOUR = 3600;

/** Flat prices. A kind absent from here is priced by a rule below, or refused. */
const FLAT_PRICE: Partial<Record<CreditEventKind, number>> = {
  kill: 5,
  relic: 15,
  viewpoint: 10,
  maze: 25,
  objective: 20,
};

/** Race prize by finishing position, mirroring RACE_PRIZES. */
const RACE_PRIZE: Record<string, number> = { '1': 10, '2': 5, '3': 2 };

/**
 * Ceilings, per kind, per rolling window.
 *
 * Set deliberately loose. A cap that fires during honest play is worse than no
 * cap: it turns a security control into a support ticket, and the player who hit
 * it did nothing wrong. These bound the *yield* of a forged stream; they are not
 * meant to be reached, and they want measuring against real sessions before
 * anyone tightens them.
 */
const CAPS: Partial<Record<CreditEventKind, CreditCap>> = {
  // The station budgets 18 hostiles and respawns them. 400/hour is far above any
  // real rate and still bounds a forged stream to a few thousand credits.
  kill: { maxEvents: 400, windowSeconds: HOUR },
  loot: { maxEvents: 600, windowSeconds: HOUR },
  race: { maxEvents: 60, windowSeconds: HOUR },
  minigame: { maxEvents: 60, windowSeconds: HOUR },
  // Finite and identity-based in game, so these caps are backstops, not budgets.
  relic: { maxEvents: 60, windowSeconds: HOUR },
  viewpoint: { maxEvents: 60, windowSeconds: HOUR },
  maze: { maxEvents: 40, windowSeconds: HOUR },
  objective: { maxEvents: 60, windowSeconds: HOUR },
  quest: { maxEvents: 120, windowSeconds: HOUR },
  purchase: { maxEvents: 300, windowSeconds: HOUR },
  migration: { maxEvents: 1, windowSeconds: 365 * 24 * HOUR },
};

const KNOWN = new Set<string>(CREDIT_EVENT_KINDS);

/** A detail is only ever read as a string. Anything else is treated as absent. */
function detailOf(event: CreditEvent): string | null {
  const raw = (event as { detail?: unknown }).detail;
  return typeof raw === 'string' ? raw : null;
}

/**
 * The credits an event is worth, or `null` if the kind is refused.
 *
 * `null` and `0` mean different things. `null` is "I do not honour this kind at
 * all" — record the attempt, pay nothing, answer 400. `0` is "a known kind worth
 * nothing this time", such as finishing fourth.
 *
 * Anything the caller puts on the event besides `kind` and `detail` is ignored,
 * including a `delta` or `credits` field — which is exactly the request shape
 * this phase exists to stop trusting.
 */
export function priceEvent(event: CreditEvent): number | null {
  const kind = (event as { kind?: unknown }).kind;
  if (typeof kind !== 'string' || !KNOWN.has(kind)) return null;

  const detail = detailOf(event);

  switch (kind as CreditEventKind) {
    case 'race':
      return detail !== null ? (RACE_PRIZE[detail] ?? 0) : 0;

    case 'minigame':
      return detail === 'won' ? 10 : 0;

    // Priced by the caller, which holds the database handle: from the item
    // definition, the catalogue row, or `quests.reward_credits`. Zero here means
    // "this module does not set it", and the ledger refuses to write one of
    // these that arrived without a priced amount.
    case 'loot':
    case 'purchase':
    case 'quest':
    case 'migration':
      return 0;

    default:
      return FLAT_PRICE[kind as CreditEventKind] ?? 0;
  }
}

/** The ceiling for a kind, or `null` if the kind is not honoured at all. */
export function capFor(kind: string): CreditCap | null {
  if (!KNOWN.has(kind)) return null;
  return CAPS[kind as CreditEventKind] ?? null;
}
