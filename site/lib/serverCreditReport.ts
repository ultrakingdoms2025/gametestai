import type { Client, PoolClient } from 'pg';
import { priceEvent, resolveReportedEvent, type CreditEvent } from './creditPricing';
import {
  earnServerCredits,
  serverBalance,
  serverCreditKind,
  spendServerCredits,
} from './serverCredits';
import type {
  ReportedEvent,
  ReportHandlers,
  ReportResult,
  ReportOutcome,
} from './creditLedger';

/**
 * Reported gameplay events, applied to a SERVER ledger — the scoped mirror of
 * `creditLedger.applyReportedEvent`.
 *
 * ── Why this module exists, and why it is not `serverCredits.ts` ──────────
 *
 * The owner's instruction flips the economy invariant BY DESIGN: while a player
 * is inside a custom server, the credits the game reports are that server's —
 * the platform balance must never move — and while they are outside, the server
 * ledgers must never move. `POST /api/game/credits` therefore needs the whole
 * reported-event pipeline (reason→kind mapping, server pricing of flat kinds,
 * per-event ceilings, catalogue purchases by row) pointed at the server ledger.
 *
 * The VOCABULARY is deliberately shared, not copied: `resolveReportedEvent` and
 * `priceEvent` come from `creditPricing`, so what a kill is worth and which
 * reasons are refused can never disagree between the two economies. The MONEY
 * goes through `serverCredits`, whose kind table carries the server-side
 * ceilings and rate caps. This file cannot live inside `serverCredits.ts`
 * because that module's separation is pinned by a source scrape — it names no
 * global module and no global table — and the scrape's guarantee is worth more
 * than the tidiness of one file.
 *
 * ── What is honoured, and at whose price ──────────────────────────────────
 *
 *   - Flat/table-priced kinds (kill, viewpoint, relic, maze): priced HERE by
 *     `priceEvent`, exactly as the platform prices them. The client's number is
 *     discarded; a scoped kill pays 5 because a kill pays 5.
 *   - Declared kinds (ore, loot, race, …): the reported amount, already bounded
 *     by `resolveReportedEvent`'s PER_EVENT_MAX, then bounded AGAIN by the
 *     server kind's own ceiling and rate cap. Two gates in series, same spirit.
 *   - `quest` is refused upstream by `REASON_KIND` (already paid server-side),
 *     and a scoped quest completion pays through `completeQuestEngagement`'s
 *     `server_id` branch — display and accrual agree by construction.
 *   - A catalogue purchase goes through the injected handler, exactly as the
 *     platform path does, and the handler's `purchaseMarketplaceItem` call
 *     debits the server ledger when the scope names a server.
 *   - A plain debit (`spend`) is `spendServerCredits`: overdraw-refusing,
 *     idempotent per key.
 */

/** Any pg client — a plain Client in tests, a pooled one in a route. */
type Db = Client | PoolClient;

/** The server-ledger refusals, folded into the report vocabulary. */
function asOutcome(reason: string): ReportOutcome {
  switch (reason) {
    case 'ok':
    case 'duplicate':
    case 'unknown_kind':
    case 'capped':
    case 'insufficient':
    case 'invalid':
      return reason as ReportOutcome;
    case 'too_large':
      return 'too_large';
    default:
      return 'invalid';
  }
}

/**
 * Apply one reported `credits:changed` to one server's ledger.
 *
 * The same shape as `applyReportedEvent` on purpose — the route treats the two
 * paths identically and only the ledger differs. The returned `balance` is the
 * SERVER balance, which the client displays without knowing whose it is.
 */
export async function applyReportedServerEvent(
  db: Db,
  serverId: string,
  playerId: string,
  event: ReportedEvent,
  handlers: ReportHandlers = {}
): Promise<ReportResult> {
  const key = event?.key;
  const balanceNow = () => serverBalance(db, serverId, playerId);
  if (typeof key !== 'string' || key.length === 0 || key.length > 200) {
    return {
      key: typeof key === 'string' ? key : '',
      applied: false, delta: 0, balance: await balanceNow(), reason: 'invalid',
    };
  }

  const resolved = resolveReportedEvent(event.reason, event.delta, event.itemId);
  if (!resolved.ok) {
    return { key, applied: false, delta: 0, balance: await balanceNow(), reason: resolved.reason };
  }

  if (resolved.itemRef !== undefined) {
    /* A catalogue purchase. Injected, never imported, for the cycle reason
     * `ReportHandlers` documents — and it fails CLOSED the same way: no
     * handler, no purchase, never a browser-named price. */
    const buy = handlers.buyCatalogueItem;
    if (!buy) {
      return {
        key, applied: false, delta: 0, balance: await balanceNow(), reason: 'unpriced_purchase',
      };
    }
    const r = await buy({ itemRef: resolved.itemRef, eventKey: key });
    return { key, applied: r.applied, delta: r.delta, balance: r.balance, reason: r.reason };
  }

  if (resolved.kind === 'spend') {
    const r = await spendServerCredits(db, serverId, playerId, {
      cost: resolved.amount ?? 0,
      detail: resolved.detail,
      eventKey: key,
    });
    return { key, applied: r.applied, delta: r.delta, balance: r.balance, reason: asOutcome(r.reason) };
  }

  /* An earn. Server-priced kinds get their amount from `priceEvent` — the same
   * table the platform uses, with the reason as the detail discriminator so a
   * relic-set pays 500 and a maze token pays 6, scoped or not. Declared kinds
   * carry the amount `resolveReportedEvent` already bounded. */
  const amount =
    resolved.amount !== null
      ? resolved.amount
      : priceEvent({ kind: resolved.kind, detail: resolved.detail } as CreditEvent) ?? 0;

  if (amount <= 0) {
    /* A known kind worth nothing this time (finishing fourth). Nothing to
     * write: the server ledger records movements, and zero is not one. */
    return { key, applied: false, delta: 0, balance: await balanceNow(), reason: 'invalid' };
  }

  if (!serverCreditKind(resolved.kind)) {
    /* A platform kind the server table does not carry. Fails CLOSED — the same
     * answer an unmapped reason gets — and loudly enough to find, because a
     * kind that pays on the platform and silently vanishes while scoped is the
     * LOSS failure mode the pricing module warns about. */
    console.error(
      `[serverCreditReport] reported kind '${resolved.kind}' has no server-ledger kind; `
        + 'refusing the event. Add it to SERVER_CREDIT_KINDS with a reasoned cap.'
    );
    return { key, applied: false, delta: 0, balance: await balanceNow(), reason: 'unknown_kind' };
  }

  const r = await earnServerCredits(db, serverId, playerId, {
    kind: resolved.kind,
    amount,
    detail: resolved.detail,
    eventKey: key,
  });
  return { key, applied: r.applied, delta: r.delta, balance: r.balance, reason: asOutcome(r.reason) };
}
