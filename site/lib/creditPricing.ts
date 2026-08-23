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

/**
 * ── The `daily` kind that is deliberately not here ─────────────────────────
 *
 * The mission architecture's section 6 proposed one, and the reasoning was
 * sound as far as it went: `CAPS` below takes `maxEvents` over `windowSeconds`,
 * so `{ maxEvents: 1, windowSeconds: 86400 }` is a once-a-day ceiling enforced
 * by the server's clock rather than the browser's, and brief 5.5's "not
 * farmable" requirement would need no new mechanism.
 *
 * It was evaluated for Phase 10 and refused, for two reasons that are facts
 * about this file rather than opinions about the design.
 *
 *   1. A KIND HERE IS A KIND THAT PAYS. The only route into the ledger is
 *      `POST /api/game/credits`, and every item goes through
 *      `resolveReportedEvent`, whose third statement refuses an event with a
 *      zero delta outright. There is no such thing as a zero-credit kind, so
 *      "add the machinery now and decide the payout later" is not available:
 *      the kind either pays on the day it lands or it does not exist.
 *
 *   2. THE MEASURED PROBLEM IS THE OTHER DIRECTION. The economy was measured at
 *      a whole-game faucet over 250,000 CR against exactly five `spend` call
 *      sites, with one clear of one world out of eighteen buying ~90% of every
 *      permanent item. A new source, however small and however tightly capped,
 *      moves the wrong number.
 *
 * So the retention loop pays no credits at all. Its "not farmable" guarantee is
 * structural instead of rate-limited, and stronger for it: a daily is completed
 * only when a charter record column advances, and every record column is an
 * identity set capped by content, so winding a clock forward buys day keys and
 * nothing else. See `src/systems/Retention.js` and the design at
 * `docs/superpowers/specs/2026-08-23-retention-loops-design.md` section 0.
 *
 * `REASON_KIND` therefore maps no retention reason, and
 * `scripts/tests/retention.test.mjs` fails if one appears - because a mapped
 * reason is a paid reason, and adding one should cost an argument.
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
  // Added when the client was migrated onto the ledger (phase 2 step 3). Each
  // one is a real source in the shipped game that the original list of 13
  // missed -- `ore` alone is the whole World 06 mining economy.
  'ore',
  'contract',
  'bounty',
  'sell',
  'spend',
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

/**
 * Flat prices, each one a constant read out of the game and pinned by
 * `creditReasons.test.ts`, which scrapes the source and fails if the two drift.
 *
 * The first version of this table was WRONG, by a lot, in the direction that
 * would have looked like theft: relic 15 against a real 120, viewpoint 10
 * against 150, maze 25 against 100, objective 20 against payouts up to 3,000.
 * Switching that on would have quietly cut earnings by up to 99% and every
 * report would have arrived as "my credits feel wrong".
 *
 * The lesson is the one this phase keeps re-learning: a price written from
 * memory of what the client does is not a mirror of it. These are measured, and
 * the scrape test is what keeps them measured.
 */
const FLAT_PRICE: Partial<Record<CreditEventKind, number>> = {
  kill: 5, // src/systems/Economy.js CREDITS_PER_KILL
  viewpoint: 150, // src/systems/Viewpoints.js SYNC_CREDITS
};

/** Two constants under one kind, told apart by the reason tag. */
const RELIC_PRICE: Record<string, number> = {
  relic: 120, // src/systems/Relics.js VALUE
  'relic-set': 500, // src/systems/Relics.js SET_CREDITS
};
const MAZE_PRICE: Record<string, number> = {
  'maze-centre': 100, // src/worlds/MazeWorld.js MAZE_CENTRE_VALUE
  'maze-token': 6, // src/worlds/MazeWorld.js MAZE_TOKEN_VALUE
};

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
  // A dock sale is deliberate and slow -- fly out, mine a hold, fly back.
  ore: { maxEvents: 120, windowSeconds: HOUR },
  contract: { maxEvents: 60, windowSeconds: HOUR },
  bounty: { maxEvents: 400, windowSeconds: HOUR },
  sell: { maxEvents: 400, windowSeconds: HOUR },
  // Spending is not a thing anyone forges in their own favour, and a cap that
  // refuses a debit would leave the player holding goods they did not pay for.
  spend: { maxEvents: 2000, windowSeconds: HOUR },
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
    // Two prices each, chosen by the reason tag the client reported. An
    // unrecognised tail falls to the CHEAPER of the two: it can only be reached
    // by a forged request, and underpaying a forgery is the safe direction.
    case 'relic':
      return detail !== null ? (RELIC_PRICE[detail] ?? 120) : 120;

    case 'maze':
      return detail !== null ? (MAZE_PRICE[detail] ?? 6) : 6;

    // Priced by the caller, which holds the database handle: from the item
    // definition, the catalogue row, or `quests.reward_credits`. Zero here means
    // "this module does not set it", and the ledger refuses to write one of
    // these that arrived without a priced amount.
    case 'loot':
    case 'purchase':
    case 'quest':
    case 'migration':
    // Variable by nature and priced by whoever holds the numbers: an ore hold is
    // a mixed cargo, a contract carries its own reward, a bounty scales with the
    // hull killed. See DECLARED_KINDS in this file for what that costs us.
    case 'ore':
    case 'contract':
    case 'bounty':
    case 'sell':
    case 'spend':
    // Variable in the shipped game and NOT the flat numbers this table first
    // claimed: a race pays 10/5/2 plus up to 128 in pickups, a minigame pays 10
    // at most venues and 120 at the yard butts, an objective pays anywhere from
    // 225 to 3,000 by tier.
    case 'race':
    case 'minigame':
    case 'objective':
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

// ---------------------------------------------------------------------------
// Reported gameplay events: mapping the game's own vocabulary onto these kinds
// ---------------------------------------------------------------------------

/**
 * Every credit change in the game goes through `Economy.add(amount, reason)` or
 * `Economy.spend(amount, reason)` (src/systems/Economy.js). That single funnel is
 * what makes this migration safe to do at all: rather than editing 22 call sites
 * and hoping none was missed, the funnel reports, and a source that is added
 * later is covered the day it is written.
 *
 * `reason` is the game's tag. This table maps each one onto a server kind.
 *
 * An unmapped reason is REFUSED, not silently paid and not silently dropped.
 * That is deliberate and it is the whole point of `creditReasons.test.ts`, which
 * scrapes `src/` for reason strings and fails if one is missing from this table.
 * The design's stated failure mode is not theft, it is LOSS: a source that stops
 * paying is invisible to everyone except the player who quits over it.
 */
export const REASON_KIND: Record<string, CreditEventKind | 'refused'> = {
  // Combat
  kill: 'kill',
  bounty: 'bounty',

  // Pickups. `inventory` is the credits ITEM landing in the bag; `loot` is the
  // same value arriving straight off a corpse or cache.
  loot: 'loot',
  inventory: 'loot',

  // Selling a hold of ore at a dock. The largest single earn in the game.
  ore: 'ore',

  // Set pieces
  race: 'race',
  minigame: 'minigame',
  'maze-centre': 'maze',
  'maze-token': 'maze',
  relic: 'relic',
  'relic-set': 'relic',
  viewpoint: 'viewpoint',

  // Space objectives. Five separate channels in SpaceObjectives.js, one kind:
  // the distinction matters to the game's UI, not to what a credit is worth.
  'objective:wing': 'objective',
  'objective:survey': 'objective',
  'objective:landfall': 'objective',
  'objective:assay': 'objective',
  // The two literals `SpaceObjectives._payTier` is called with (:1525, :1723).
  'objective:kills': 'objective',
  'objective:ore': 'objective',

  // Board work
  contract: 'contract',

  // REFUSED, and not because it is untrusted -- because it is already paid.
  // `completeQuestEngagement` prices a quest from `quests.reward_credits` and
  // grants it server-side; the client then mirrors the returned balance with
  // `economy.set(next, 'quest')`. Honouring a reported 'quest' would pay a
  // second time for the same completion. The fallback `add` at
  // QuestSystem.js:987 only runs when that POST already succeeded but returned
  // something unreadable, so it too is a duplicate, not a missing payment.
  quest: 'refused',

  // Marketplace. `market` is BIDIRECTIONAL in the game — selling calls add() and
  // buying calls spend() with the same tag — so direction is taken from the sign
  // of the delta, never from the tag.
  market: 'sell',
  'market-refund': 'sell',

  // Refused by name. Hiding the admin button is not a control: the server has to
  // say no, because the button is only hidden.
  cheat: 'refused',
};

/**
 * Kinds whose amount the CLIENT declares, because the server has no table that
 * could price them: a mixed ore hold, a contract's own reward, a bounty that
 * scales with the hull killed, a sale priced from a catalogue row.
 *
 * Be honest about what this costs. For these kinds the server is not pricing
 * the claim, it is BOUNDING it -- with a per-event ceiling here and a rate cap
 * above. That is strictly better than the hole it replaces (a browser naming its
 * own balance outright) and strictly weaker than the flat-priced kinds. Pricing
 * `ore` properly means porting the ore tables and having the client report the
 * cargo manifest rather than the total; that is worth doing and is not this
 * change.
 */
export const DECLARED_KINDS = new Set<CreditEventKind>([
  'loot',
  'ore',
  'contract',
  'bounty',
  'sell',
  'spend',
  'race',
  'minigame',
  'objective',
]);

/**
 * The largest single event of each declared kind the shipped game can produce.
 *
 * These are NOT tuning knobs and they are not meant to bite. Each is set far
 * above the largest amount the game can legitimately generate, so the only
 * thing that trips one is a number no honest session could produce. The reason
 * for the headroom is the failure mode: a ceiling that clips a real payout is
 * silent theft from the player, and they would have no way to report it beyond
 * "my credits feel wrong".
 *
 * An event over the ceiling is REFUSED and recorded at zero, not truncated.
 * Truncating would pay a wrong number and leave no trace that it was wrong.
 */
export const PER_EVENT_MAX: Partial<Record<CreditEventKind, number>> = {
  // Measured maxima from the shipped tables, then given room. The comment on
  // each is what the game can actually produce, so the headroom is visible.
  loot: 5_000, // Loot.js drops 4..14
  ore: 500_000, // a full best-case hold is ~15,000, and hold tiers can stack
  contract: 20_000, // Contracts.js REWARD tops out at 336
  bounty: 10_000, // AlienShip lance = 180
  sell: 500_000, // ~1,736 a stack; draining store+bag in one call is the ceiling
  race: 10_000, // 10 first place + up to 128 in pickups
  minigame: 10_000, // 120 at the yard butts, 10 elsewhere
  objective: 100_000, // richest tier is 3,000
  spend: 1_000_000, // catalogue-driven, no code constant to measure
};

export type ResolvedEvent =
  | { ok: true; kind: CreditEventKind; detail: string; amount: number | null }
  | { ok: false; reason: 'unknown_source' | 'refused' | 'too_large' | 'invalid' };

/**
 * Turn one reported `credits:changed` into something the ledger can apply.
 *
 * The sign of `delta` decides direction, never the reason tag — `market` is used
 * by the game for BOTH selling (a credit) and buying (a debit), so a tag-based
 * rule would get one of them backwards.
 */
export function resolveReportedEvent(reason: unknown, delta: unknown): ResolvedEvent {
  if (typeof reason !== 'string' || reason.length === 0 || reason.length > 64) {
    return { ok: false, reason: 'invalid' };
  }
  const d = Number(delta);
  if (!Number.isInteger(d) || d === 0) return { ok: false, reason: 'invalid' };

  const mapped = REASON_KIND[reason];
  if (mapped === undefined) {
    // Fails CLOSED. An unmapped reason means the game grew a credit source and
    // nobody told this table; refusing makes that loud instead of paying an
    // unpriced claim. `creditReasons.test.ts` is what stops it reaching here.
    return { ok: false, reason: 'unknown_source' };
  }
  if (mapped === 'refused') return { ok: false, reason: 'refused' };

  // A debit. Nobody forges a spend in their own favour, so the amount is taken
  // as reported and only sanity-bounded.
  if (d < 0) {
    const cost = -d;
    if (cost > (PER_EVENT_MAX.spend ?? Infinity)) return { ok: false, reason: 'too_large' };
    return { ok: true, kind: 'spend', detail: reason, amount: cost };
  }

  if (DECLARED_KINDS.has(mapped)) {
    const ceiling = PER_EVENT_MAX[mapped] ?? Infinity;
    if (d > ceiling) return { ok: false, reason: 'too_large' };
    return { ok: true, kind: mapped, detail: reason, amount: d };
  }

  // Flat- or table-priced: the reported amount is discarded entirely. This is
  // the half of the phase that actually holds — a client claiming 9,000 for a
  // kill is paid 5.
  return { ok: true, kind: mapped, detail: reason, amount: null };
}
