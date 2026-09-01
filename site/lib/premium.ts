import type { Client, PoolClient } from 'pg';
import { FEE_BPS, FEE_FIXED_CENTS, formatCents, grossUp } from './pricing';
import { simulatedPurchasesAllowed, stripeConfigured } from './stripe';
import { COMP_PREFIX, compSubscriptionId } from './accessCodeFormat';

/**
 * The premium server-hosting SKU (7b), and the webhook that writes entitlement.
 *
 * ── This is the project's first recurring charge ──────────────────────────
 *
 * Everything sold before this is one-off: a $1 / 30-day access pass and credits
 * at $0.10 each, both `mode: 'payment'`. Hosting a custom server is not a
 * one-off — it is capacity that costs while it exists — so it is a subscription,
 * and a subscription brings three things the one-off flow has never had:
 *
 *   1. **A charge that recurs without a browser.** Nobody is redirected to
 *      `/api/confirm` on the second month, so the redirect path CANNOT be the
 *      thing that grants. Only the webhook can.
 *   2. **A state that changes without anyone buying anything.** `past_due`,
 *      `canceled`, a card expiring. Entitlement is therefore a row that Stripe
 *      keeps updating, not a fact recorded once at purchase.
 *   3. **Events that arrive out of order.** Stripe redelivers, and a redelivered
 *      `customer.subscription.deleted` landing after a fresh subscription would
 *      revoke something just paid for. Guarded below by subscription id, not by
 *      hoping.
 *
 * ── What Stripe TEST MODE does and does not demonstrate ───────────────────
 *
 * Demonstrated, genuinely and end to end, with test keys:
 *
 *   - Checkout session creation in `mode: 'subscription'` with a `recurring`
 *     price, which is a different API shape from every existing SKU and is the
 *     part most likely to be wrong.
 *   - Webhook signature verification against `STRIPE_WEBHOOK_SECRET` — the same
 *     code path, the same `constructEvent`, byte-identical behaviour to live.
 *   - The entitlement WRITE: a real row in `server_entitlements`, driven by a
 *     real signed event, which is what `createServer` reads.
 *   - Idempotency and ordering, exercisable on demand because the Stripe CLI can
 *     redeliver any event as often as you like — easier to test in test mode
 *     than in live.
 *   - Cancellation and `past_due`, via test cards that decline.
 *
 * NOT demonstrated, and it would be dishonest to imply otherwise:
 *
 *   - That money moves. No card is charged, no payout is made, no fee is taken.
 *     The fee arithmetic below is the same code the one-off SKUs already use, so
 *     it is not newly at risk, but it is not being verified against a real
 *     statement either.
 *   - Anything about the live account: tax registration, Stripe Radar rules,
 *     3-D Secure/SCA challenges on real European cards, or the account's actual
 *     processing rate — `FEE_BPS` is a configured default, not a measured one.
 *   - Renewal over real time. A month does not pass in a test. Stripe test
 *     clocks can simulate one and that is worth doing before live; it is not
 *     done here.
 *   - Disputes, refunds and involuntary churn, which are the events that
 *     actually decide whether an entitlement model is right.
 *
 * The switch is `STRIPE_SECRET_KEY`, exactly as it already is: a `sk_test_` key
 * exercises this whole path, and a `sk_live_` key changes nothing here.
 */

/** Any pg client — a plain Client in tests, a pooled one in a route. */
type Db = Client | PoolClient;

/* ---------------------------------------------------------------------- */
/* The SKU                                                                 */
/* ---------------------------------------------------------------------- */

/** What hosting one custom server is worth to the merchant, per month. */
export const SERVER_HOSTING_CENTS = 500;

/**
 * How many server SLOTS one hosting purchase adds.
 *
 * Slots ACCUMULATE: the owner's instruction is pay-per-server, so each hosting
 * purchase — simulated today, a real subscription later, through the identical
 * `writeEntitlement` path — adds this many slots to the player's allowance
 * rather than replacing it. `server_slot_grants` below is the record of which
 * subscription funded which slot, and `max_servers` is materialised from it.
 */
export const SERVERS_PER_SUBSCRIPTION = 1;

export const SERVER_HOSTING_SKU = 'server_hosting_monthly';

export interface SubscriptionQuote {
  netCents: number;
  feeCents: number;
  totalCents: number;
  interval: 'month';
  label: string;
  detail: string;
}

/**
 * The monthly charge, grossed up so the fee does not come out of the net.
 *
 * `grossUp` is `pricing.ts`'s, unchanged, so the number on this page is the
 * number Stripe is handed — which is the property that whole module exists for.
 * The gross-up is applied to the RECURRING amount, so it recurs with it.
 */
export function quoteServerHosting(): SubscriptionQuote {
  const netCents = SERVER_HOSTING_CENTS;
  const totalCents = grossUp(netCents);
  return {
    netCents,
    feeCents: totalCents - netCents,
    totalCents,
    interval: 'month',
    label: 'Custom server hosting',
    /* "per server": each purchase buys ONE server slot, and buying again adds
     * another. The copy says so because the button is now also how an owner at
     * quota pays for an additional server, and a price line that read like an
     * all-you-can-host subscription would be a lie on that screen. */
    detail: `${formatCents(totalCents)} per month, per server — includes processing (${(FEE_BPS / 100).toFixed(1)}% + ${formatCents(FEE_FIXED_CENTS)})`,
  };
}

/* ---------------------------------------------------------------------- */
/* Entitlement                                                             */
/* ---------------------------------------------------------------------- */

/** What Stripe says about a subscription, mapped to what this app stores. */
export type EntitlementStatus = 'active' | 'past_due' | 'canceled' | 'inactive';

export interface Entitlement {
  playerId: string;
  status: EntitlementStatus;
  maxServers: number;
  subscriptionId: string | null;
  customerId: string | null;
  currentPeriodEnd: string | null;
  /**
   * Nobody paid for this one. See the "Simulated purchase" section below —
   * it is what tells an admin view, a revenue figure or a revocation sweep
   * that this row is a rehearsal rather than a customer.
   */
  simulated: boolean;
}

/**
 * Stripe's subscription statuses, mapped.
 *
 * `trialing` counts as active because a trial is an entitlement someone was
 * deliberately given. `incomplete` does not: the first payment has not
 * succeeded, and treating it as active is how a subscription that never pays
 * gets a month of hosting.
 */
export function mapStripeStatus(raw: string | null | undefined): EntitlementStatus {
  switch (String(raw ?? '')) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    default:
      return 'inactive';
  }
}

/** The columns `toEntitlement` expects, in one place so every read agrees. */
const ENTITLEMENT_COLS =
  `player_id, status, max_servers, stripe_subscription_id, stripe_customer_id,
   current_period_end, simulated`;

function toEntitlement(row: Record<string, unknown>): Entitlement {
  /* The column already holds one of THIS module's four statuses — Stripe's
   * vocabulary is mapped on the way in, once, by `mapStripeStatus`. Read back
   * through a guard anyway: a row written by hand, or by a future version with a
   * fifth status, must degrade to `inactive` rather than to something
   * `entitlementPermitsHosting` accidentally accepts. */
  const stored = String(row.status ?? '');
  const KNOWN: readonly EntitlementStatus[] = ['active', 'past_due', 'canceled', 'inactive'];
  const subscriptionId =
    row.stripe_subscription_id == null ? null : String(row.stripe_subscription_id);
  const customerId = row.stripe_customer_id == null ? null : String(row.stripe_customer_id);
  return {
    playerId: String(row.player_id),
    status: (KNOWN as readonly string[]).includes(stored)
      ? (stored as EntitlementStatus)
      : 'inactive',
    maxServers: Number(row.max_servers ?? 0),
    subscriptionId,
    customerId,
    currentPeriodEnd: row.current_period_end == null ? null : String(row.current_period_end),
    /* Either mark is enough. The column is the queryable one, the id prefix is
     * the one that survives a restore from a dump taken before the column
     * existed — and a row carrying a `sim_` subscription id is pretend whatever
     * a boolean somewhere says, because no such subscription exists at Stripe. */
    simulated: row.simulated === true || isSimulatedId(subscriptionId) || isSimulatedId(customerId),
  };
}

export async function readEntitlement(db: Db, playerId: string): Promise<Entitlement> {
  const r = await db.query(
    `SELECT ${ENTITLEMENT_COLS} FROM server_entitlements WHERE player_id = $1`,
    [playerId]
  );
  const row = r.rows[0];
  if (!row) {
    return {
      playerId, status: 'inactive', maxServers: 0,
      subscriptionId: null, customerId: null, currentPeriodEnd: null, simulated: false,
    };
  }
  return toEntitlement(row as Record<string, unknown>);
}

/**
 * Claim a Stripe event id, or discover it has already been handled.
 *
 * `ON CONFLICT DO NOTHING` returning no row IS the duplicate signal. The same
 * argument the credit ledger makes: not a Set in a process, which two lambdas
 * do not share, and not a check-then-act, which two concurrent deliveries both
 * pass. Stripe retries anything that is not a 2xx, so redelivery is normal
 * operation rather than an edge case.
 */
export async function claimStripeEvent(
  db: Db,
  eventId: string,
  type: string
): Promise<boolean> {
  if (!eventId) return false;
  const r = await db.query(
    `INSERT INTO stripe_webhook_events (event_id, type) VALUES ($1, $2)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [eventId, type]
  );
  return !!r.rows[0];
}

/* ---------------------------------------------------------------------- */
/* Slot grants: which purchase funded which server slot                    */
/* ---------------------------------------------------------------------- */

let slotSchemaPromise: Promise<void> | null = null;

/**
 * The ledger of hosting purchases, one row per subscription that ever funded a
 * slot. `max_servers` on `server_entitlements` is materialised from the SUM of
 * unrevoked rows here, which is what makes the allowance ACCUMULATE: a second
 * purchase is a second row, not an overwrite.
 *
 * Rows are kept and marked (`revoked_at`), repo style, so "which purchase paid
 * for this slot and when did it stop" stays answerable — except through the
 * `ON DELETE CASCADE`, which ties a grant's life to its entitlement row: the
 * simulated-entitlement sweep deletes the row, and pretend grants must not
 * survive it as orphaned history.
 *
 * Memoised like every other ensure here (a promise, not a boolean, so two cold
 * lambdas wait rather than racing; a rejection clears the memo). Called from
 * `runCustomServerSchema` — the path every route warms — AND from
 * `writeEntitlement` itself, because a writer whose table might not exist yet
 * must run its own ensure; that is the `server_id` production lesson verbatim.
 */
export function ensureServerSlotSchema(db: Db): Promise<void> {
  if (!slotSchemaPromise) {
    slotSchemaPromise = db
      .query(
        `CREATE TABLE IF NOT EXISTS server_slot_grants (
           player_id       TEXT NOT NULL
                             REFERENCES server_entitlements(player_id) ON DELETE CASCADE,
           subscription_id TEXT NOT NULL,
           slots           INTEGER NOT NULL DEFAULT 1,
           granted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           revoked_at      TIMESTAMPTZ,
           PRIMARY KEY (player_id, subscription_id)
         )`
      )
      /* `expires_at`: when a slot stops funding an allowance BY ITSELF, with
       * nobody sending an event to say so.
       *
       * Additive, nullable, and NULL for every row written before it existed —
       * which is every subscription and every simulated grant. Those are right
       * to be NULL: a Stripe subscription ends when Stripe says it ends, and
       * enforcing a stored `current_period_end` on one would tear down a
       * running server the moment a renewal webhook ran late.
       *
       * A comped slot is the opposite case. Nothing renews it and nothing will
       * ever send an event about it, so a comp with no expiry is a comp that
       * lasts forever. `liveSlots` therefore stops counting a lapsed slot, and
       * `expireLapsedSlots` marks it at the points where hosting is actually
       * decided. */
      .then(() =>
        db.query(
          `ALTER TABLE server_slot_grants ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`
        )
      )
      .then(() => undefined)
      .catch((err) => {
        slotSchemaPromise = null;
        throw err;
      });
  }
  return slotSchemaPromise;
}

/** Test-only: forget the memo so a fresh database can be built again. */
export function resetServerSlotSchemaMemo(): void {
  slotSchemaPromise = null;
}

/**
 * The slots currently funded: SUM of this player's unrevoked, unlapsed grants.
 *
 * `expires_at IS NULL` is the ordinary case and means "this slot ends when
 * something tells it to" — every subscription and every simulated grant. A
 * dated slot is a comp, and it stops counting on its own date without anybody
 * having to run anything.
 */
async function liveSlots(db: Db, playerId: string): Promise<number> {
  const r = await db.query(
    `SELECT COALESCE(SUM(slots), 0)::int AS n
       FROM server_slot_grants
      WHERE player_id = $1
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())`,
    [playerId]
  );
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * Mark lapsed comp slots revoked and re-materialise the allowances they funded.
 *
 * ── Why a sweep at all, when `liveSlots` already ignores them ─────────────
 *
 * `server_entitlements.max_servers` is MATERIALISED — computed by `liveSlots`
 * at write time and then stored — and `entitlementPermitsHosting` reads the
 * stored number. That is deliberate and worth keeping: the quota check in
 * `createServer` is one indexed read rather than an aggregate over a grants
 * table. But a materialised number cannot notice a date passing, so the row
 * would go on advertising a slot whose comp ran out a fortnight ago.
 *
 * ── Why here and not on a schedule ────────────────────────────────────────
 *
 * There is no scheduler in this project. A sweep that only runs when an
 * operator remembers is a sweep that has not run, so this is called at the two
 * points where the answer actually matters — `createServer`, which is the gate,
 * and the servers listing, which is where an owner is told whether they may
 * make another. Both already hold a connection, both are already writing or
 * about to, and a player who never comes back never needs the update.
 *
 * Scoped to one player when given one. The unscoped form exists for the admin
 * claw-back sweep, which has just revoked codes across many players at once.
 */
export async function expireLapsedSlots(db: Db, playerId?: string): Promise<number> {
  await ensureServerSlotSchema(db);
  const lapsed = await db.query(
    `UPDATE server_slot_grants SET revoked_at = NOW()
      WHERE revoked_at IS NULL
        AND expires_at IS NOT NULL
        AND expires_at <= NOW()
        AND ($1::text IS NULL OR player_id = $1)
      RETURNING player_id`,
    [playerId ?? null]
  );
  const touched = new Set(
    (lapsed.rows as { player_id: unknown }[]).map((row) => String(row.player_id))
  );
  for (const id of touched) {
    await db.query(
      `UPDATE server_entitlements SET max_servers = $2, updated_at = NOW()
        WHERE player_id = $1`,
      [id, await liveSlots(db, id)]
    );
  }
  return touched.size;
}

export interface SubscriptionFact {
  playerId: string;
  subscriptionId: string;
  customerId: string | null;
  status: EntitlementStatus;
  /** ISO timestamp, or null when Stripe did not give one. */
  currentPeriodEnd: string | null;
  /**
   * Nobody paid. Only `grantSimulatedHosting` ever sets this — the webhook
   * omits it, which is what makes a real subscription CLEAR the flag on a
   * player who had a pretend one.
   */
  simulated?: boolean;
  /**
   * When THIS subscription's slot stops funding an allowance on its own.
   *
   * Only a comp sets it — see `grantCompedHosting`. Stripe's own writes leave
   * it undefined, which stores NULL, which means "this slot ends when an event
   * says so" and is the behaviour every existing row already has.
   */
  slotExpiresAt?: string | null;
}

export type EntitlementWrite =
  | { applied: true; entitlement: Entitlement }
  | { applied: false; reason: 'stale_subscription' | 'invalid' };

/**
 * Write what Stripe says about one subscription.
 *
 * ── Slots accumulate; `server_slot_grants` is how ─────────────────────────
 *
 * Pay-per-server, at the owner's instruction: every DISTINCT subscription that
 * grants adds `SERVERS_PER_SUBSCRIPTION` slot(s) as a row in
 * `server_slot_grants`, and `max_servers` is materialised as the SUM of the
 * unrevoked rows. The same subscription re-asserting itself — a renewal event,
 * a replayed simulated confirm — is an idempotent upsert of its one row and
 * adds nothing. The simulated path and the real webhook path both land here,
 * so nothing diverges on the day Stripe goes live.
 *
 * ── The ordering guard, refined by accumulation ───────────────────────────
 *
 * Stripe redelivers. A `customer.subscription.deleted` for LAST month's
 * subscription can arrive after this month's `checkout.session.completed`, and
 * a naive all-or-nothing write would then cancel an entitlement that has just
 * been paid for. Under accumulation a cancellation releases exactly the slot
 * ITS subscription funded — never anyone else's — so the late-arriving delete
 * takes away last month's slot and leaves this month's standing, and the net
 * allowance is the same whichever order the two events land in. A revocation
 * for a subscription that never funded a slot here (and is not the stored one)
 * is still refused as `stale_subscription`: nothing of this player's was ever
 * attached to it, so there is nothing for it to take away.
 *
 * `max_servers` is set here and nowhere else. No route argument raises it, which
 * is what makes `createServer`'s quota check meaningful.
 */
export async function writeEntitlement(
  db: Db,
  fact: SubscriptionFact
): Promise<EntitlementWrite> {
  const playerId = String(fact?.playerId ?? '').trim();
  const subscriptionId = String(fact?.subscriptionId ?? '').trim();
  if (!playerId || !subscriptionId) return { applied: false, reason: 'invalid' };

  /* The writer runs its own ensure — the `server_id` production lesson: a
   * table this function is about to write might not exist on a database that
   * has only ever served reads, and "works warm, 500s cold" is the worst kind
   * of intermittent. Memoised, so the steady-state cost is one resolved await. */
  await ensureServerSlotSchema(db);

  const current = await readEntitlement(db, playerId);
  /* `past_due` still FUNDS its slot. Stripe retries a failed payment for days,
   * and tearing a running server down on the first decline punishes an expired
   * card rather than a non-payer — `entitlementPermitsHosting` says the same
   * thing and the two must not disagree. */
  const granting = fact.status === 'active' || fact.status === 'past_due';

  if (granting) {
    await db.query('BEGIN');
    try {
      await db.query(
        `INSERT INTO server_entitlements
           (player_id, stripe_customer_id, stripe_subscription_id, status, current_period_end,
            max_servers, simulated, updated_at)
         VALUES ($1, $2, $3, $4, $5, 0, $6, NOW())
         ON CONFLICT (player_id) DO UPDATE SET
           stripe_customer_id     = COALESCE(EXCLUDED.stripe_customer_id, server_entitlements.stripe_customer_id),
           stripe_subscription_id = EXCLUDED.stripe_subscription_id,
           status                 = EXCLUDED.status,
           current_period_end     = EXCLUDED.current_period_end,
           /* Assigned, never OR'd. A real signed Stripe event about this player
            * must be able to turn the flag OFF — otherwise the first customer who
            * tried the product before payments went live is mislabelled as
            * pretend forever, and the revocation sweep below would delete a
            * subscription somebody is paying for. */
           simulated              = EXCLUDED.simulated,
           updated_at             = NOW()`,
        [
          playerId,
          fact.customerId ?? null,
          subscriptionId,
          fact.status,
          fact.currentPeriodEnd ?? null,
          fact.simulated === true,
        ]
      );

      /* Back-fill a legacy allowance. A production row written before
       * `server_slot_grants` existed carries a funded `max_servers` with no
       * grant rows behind it; without this, that player's first ADDITIONAL
       * purchase would recompute their allowance from the grants alone and
       * quietly eat the slot they already had. `ON CONFLICT DO NOTHING` makes
       * it a no-op everywhere except that one migration case. */
      if (
        current.subscriptionId &&
        current.subscriptionId !== subscriptionId &&
        current.maxServers > 0
      ) {
        await db.query(
          `INSERT INTO server_slot_grants (player_id, subscription_id, slots)
           VALUES ($1, $2, $3)
           ON CONFLICT (player_id, subscription_id) DO NOTHING`,
          [playerId, current.subscriptionId, current.maxServers]
        );
      }

      /* Claim this purchase's slot — THE accumulation step. A subscription id
       * never seen before is a new row (+SERVERS_PER_SUBSCRIPTION); one seen
       * before only clears `revoked_at`, so a renewal event, a replayed
       * simulated confirm link and a subscription Stripe resumes are all the
       * same idempotent upsert and none of them mints a second slot. */
      await db.query(
        `INSERT INTO server_slot_grants (player_id, subscription_id, slots, expires_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (player_id, subscription_id) DO UPDATE SET
           revoked_at = NULL,
           /* Assigned, not COALESCEd. Re-comping the same code to the same
            * player is how an operator EXTENDS one, so the new date has to
            * win; and a real subscription can only reach this row if it shares
            * the comp's id, which it cannot, because the prefixes differ. */
           expires_at = EXCLUDED.expires_at`,
        [playerId, subscriptionId, SERVERS_PER_SUBSCRIPTION, fact.slotExpiresAt ?? null]
      );

      await db.query(
        `UPDATE server_entitlements SET max_servers = $2, updated_at = NOW()
          WHERE player_id = $1`,
        [playerId, await liveSlots(db, playerId)]
      );
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK').catch(() => {});
      throw err;
    }
    return { applied: true, entitlement: await readEntitlement(db, playerId) };
  }

  /* ---- revocation: release the slot this subscription was funding -------
   *
   * Under accumulation the old all-or-nothing ordering guard becomes finer
   * grained: a cancellation releases exactly the slot ITS subscription funded,
   * so a redelivered `subscription.deleted` for last month's subscription can
   * no longer zero an allowance this month's purchase is paying for — the
   * property the old `stale_subscription` refusal existed to protect — while a
   * player who cancels one of three purchases correctly keeps two. The net
   * allowance is the same whichever order Stripe delivers the events in.
   *
   * What is STILL refused as `stale_subscription`: a revocation for a
   * subscription that never funded a slot here and is not the stored one.
   * Nothing of this player's was ever attached to it, so there is nothing it
   * may take away. */
  const grantRow = await db.query(
    `SELECT slots FROM server_slot_grants
      WHERE player_id = $1 AND subscription_id = $2`,
    [playerId, subscriptionId]
  );
  const isStored = current.subscriptionId === subscriptionId;
  if (!grantRow.rows[0] && !isStored) {
    return { applied: false, reason: 'stale_subscription' };
  }

  await db.query('BEGIN');
  try {
    /* Legacy back-fill, mirror of the granting side: a stored pre-migration
     * subscription has no grant row, so give it one to release, or the release
     * below is a no-op and the allowance survives its own cancellation. */
    if (isStored && !grantRow.rows[0] && current.maxServers > 0) {
      await db.query(
        `INSERT INTO server_slot_grants (player_id, subscription_id, slots)
         VALUES ($1, $2, $3)
         ON CONFLICT (player_id, subscription_id) DO NOTHING`,
        [playerId, subscriptionId, current.maxServers]
      );
    }

    /* Marked, not deleted — and idempotent: a replayed cancellation finds
     * `revoked_at` already set and changes nothing. */
    await db.query(
      `UPDATE server_slot_grants SET revoked_at = NOW()
        WHERE player_id = $1 AND subscription_id = $2 AND revoked_at IS NULL`,
      [playerId, subscriptionId]
    );
    const remaining = await liveSlots(db, playerId);

    if (!isStored) {
      /* One of several purchases ended; the stored subscription is still the
       * paying one, so its status and ids stay exactly as they are. */
      await db.query(
        `UPDATE server_entitlements SET max_servers = $2, updated_at = NOW()
          WHERE player_id = $1`,
        [playerId, remaining]
      );
    } else if (remaining > 0) {
      /* The STORED subscription ended but other purchases are still live.
       * Point the row at the newest surviving grant rather than recording
       * `canceled` beside a funded allowance — `entitlementPermitsHosting`
       * reads status AND slots, and the two must not contradict. */
      const next = await db.query(
        `SELECT subscription_id FROM server_slot_grants
          WHERE player_id = $1 AND revoked_at IS NULL
          ORDER BY granted_at DESC, subscription_id DESC
          LIMIT 1`,
        [playerId]
      );
      await db.query(
        `UPDATE server_entitlements
            SET stripe_subscription_id = $2, max_servers = $3, updated_at = NOW()
          WHERE player_id = $1`,
        [playerId, String(next.rows[0].subscription_id), remaining]
      );
    } else {
      /* The last funded slot is gone: record what Stripe said, exactly as the
       * pre-accumulation write always has. */
      await db.query(
        `UPDATE server_entitlements
            SET status = $2, current_period_end = $3, max_servers = 0, updated_at = NOW()
          WHERE player_id = $1`,
        [playerId, fact.status, fact.currentPeriodEnd ?? null]
      );
    }
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  }

  return { applied: true, entitlement: await readEntitlement(db, playerId) };
}

/**
 * Does this player's entitlement currently permit hosting?
 *
 * `past_due` deliberately still permits. Stripe retries a failed payment for
 * days, and tearing down a running server on the first decline punishes an
 * expired card rather than a non-payer. `canceled` does not permit, and
 * `createServer` reads this same row.
 */
export function entitlementPermitsHosting(e: Entitlement): boolean {
  return (e.status === 'active' || e.status === 'past_due') && e.maxServers > 0;
}

/* ---------------------------------------------------------------------- */
/* Simulated purchase                                                      */
/* ---------------------------------------------------------------------- */

/**
 * A hosting subscription nobody paid for.
 *
 * ── Who decided this, and what it replaced ────────────────────────────────
 *
 * `startServerHostingCheckout` used to answer 503 without a Stripe key, with a
 * comment refusing to pretend: simulating a subscription would mean faking the
 * entitlement write, which is the one thing worth exercising, and a `sk_test_`
 * key makes the real path free.
 *
 * The site owner overruled that on 25 August 2026, in these words: *"I dont see
 * option on webpage to purchase the custom server membership, or how they would
 * after purchase access backend to set up. For now someone purchasing we can
 * just skip the actual payment as with other options until I finish stripe
 * integration."* The argument the 503 made was about test coverage; the cost it
 * ignored was that the product could not be bought, or even set up, by anybody —
 * which is a worse thing to ship than an untested webhook.
 *
 * ── What it costs, so nobody rediscovers this in production ───────────────
 *
 *   - Nothing here exercises Stripe. Subscription-mode session creation, the
 *     signed webhook, `client_reference_id` attribution, redelivery and the
 *     ordering guard are still only reachable with a key. This is a shortcut
 *     around that path, not a rehearsal of it.
 *   - The entitlement it writes is REAL in every way that matters downstream:
 *     `entitlementPermitsHosting` accepts it and `createServer` builds on it. A
 *     stranger who finds the checkout endpoint can host a server for free.
 *
 * Two things contain that. The bypass is dead the moment `stripeConfigured()`
 * is true — checked here, in the library that does the writing, as well as in
 * the route, so there is no flag anyone has to remember to turn off. And every
 * row it writes is marked, twice.
 *
 * ── Marked twice, deliberately ────────────────────────────────────────────
 *
 *   1. `server_entitlements.simulated`, a real column. Exact, indexable, and
 *      the thing `listSimulatedEntitlements` and `revokeSimulatedEntitlements`
 *      key on. A column beats a `LIKE` for a sweep that must not miss a row.
 *   2. A `sim_` prefix on BOTH the subscription id and the customer id. This is
 *      the mark that shows up unbidden: it appears in any admin view that
 *      renders an id, and any attempt to reconcile it against Stripe fails
 *      loudly with "no such subscription" rather than quietly counting it as
 *      revenue. It also survives a restore from a dump taken before the column
 *      existed, which a boolean does not.
 *
 * Neither alone was enough. The column is invisible to a query that does not
 * know to ask for it, and defaults FALSE — so an admin view written next year
 * would show a pretend subscriber as a customer. The prefix is visible
 * everywhere but is only a convention. `toEntitlement` therefore treats EITHER
 * mark as decisive.
 *
 * No `recordSitePurchase` row is written for a simulated hosting purchase, and
 * that is the same argument: a $5.20 line in the purchase ledger for money that
 * never moved is exactly the revenue figure this section exists to protect.
 *
 * ── Revoking them, the day real payments start ────────────────────────────
 *
 * `revokeSimulatedEntitlements(db)` deletes every marked row and returns the
 * player ids it removed. Deletion rather than `status = 'canceled'`, because a
 * cancelled row is still a row in a churn figure and these were never customers.
 * Servers already created survive the sweep — they simply stop being creatable
 * or extendable until their owner subscribes for real, which is the honest end
 * state, and the audit trail of who was granted what is in the audit chain.
 */

/** What marks an id as belonging to a purchase that never happened. */
export const SIMULATED_PREFIX = 'sim_';

/** How long a simulated subscription claims to run before it would renew. */
export const SIMULATED_PERIOD_DAYS = 30;

export function isSimulatedId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(SIMULATED_PREFIX);
}

/**
 * The subscription id for a simulated order.
 *
 * Derived from the order id minted at checkout rather than freshly random, for
 * the reason `/api/confirm` gives about the one-off SKUs: replaying a confirm
 * URL must settle nothing twice. The same order produces the same subscription
 * id, so a replay is an upsert of identical values.
 */
export function simulatedSubscriptionId(orderId: string): string {
  return `${SIMULATED_PREFIX}sub_${String(orderId).replace(/^sim_/, '')}`;
}

/** The customer id for a simulated order — stable per player, and obvious. */
export function simulatedCustomerId(playerId: string): string {
  return `${SIMULATED_PREFIX}cus_${playerId}`;
}

/**
 * Both marks, as one SQL predicate, so the sweep and the listing cannot drift.
 *
 * `\_` because `_` is a LIKE wildcard, and `sim_` unescaped would also match a
 * hypothetical `simX...`.
 */
const SIMULATED_PREDICATE = `
  simulated = TRUE
  OR stripe_subscription_id LIKE 'sim\\_%'
  OR stripe_customer_id LIKE 'sim\\_%'`;

export type SimulatedGrant =
  | { granted: true; entitlement: Entitlement }
  | { granted: false; reason: 'stripe_configured' | 'not_permitted' | 'invalid' };

/**
 * Grant hosting to someone who did not pay, while there is no way to pay.
 *
 * Refuses outright once `STRIPE_SECRET_KEY` exists. That check is here rather
 * than only in the route because this function is the thing that writes the
 * row: a second caller added later inherits the guard instead of having to
 * remember it.
 */
export async function grantSimulatedHosting(
  db: Db,
  input: { playerId: string; orderId: string; periodDays?: number }
): Promise<SimulatedGrant> {
  if (stripeConfigured()) return { granted: false, reason: 'stripe_configured' };
  /* And the opt-in, which `stripeConfigured()` alone never was. An empty
   * `STRIPE_SECRET_KEY` describes every deployment that has not been given keys
   * yet - production included - so "Stripe is off" was being read as permission
   * to hand a subscription to anyone who reached the endpoint. The permission is
   * now explicit, absent by default and unavailable in production; see
   * `simulatedPurchasesAllowed`. Checked HERE as well as in the route for the
   * reason the guard above is: this function writes the row, so a caller added
   * later inherits the fence instead of having to remember it. */
  if (!simulatedPurchasesAllowed()) return { granted: false, reason: 'not_permitted' };

  const playerId = String(input?.playerId ?? '').trim();
  const orderId = String(input?.orderId ?? '').trim();
  if (!playerId || !orderId) return { granted: false, reason: 'invalid' };

  const days = input.periodDays ?? SIMULATED_PERIOD_DAYS;
  const written = await writeEntitlement(db, {
    playerId,
    subscriptionId: simulatedSubscriptionId(orderId),
    customerId: simulatedCustomerId(playerId),
    status: 'active',
    currentPeriodEnd: new Date(Date.now() + days * 86_400_000).toISOString(),
    simulated: true,
  });
  if (!written.applied) return { granted: false, reason: 'invalid' };
  return { granted: true, entitlement: written.entitlement };
}

/** Every entitlement nobody paid for. The list to work from before going live. */
export async function listSimulatedEntitlements(db: Db): Promise<Entitlement[]> {
  const r = await db.query(
    `SELECT ${ENTITLEMENT_COLS} FROM server_entitlements
      WHERE ${SIMULATED_PREDICATE}
      ORDER BY updated_at DESC`
  );
  return (r.rows as Record<string, unknown>[]).map(toEntitlement);
}

/**
 * Delete every simulated entitlement. Returns the player ids it removed.
 *
 * Safe to run with real customers in the table: the predicate cannot match a
 * row Stripe wrote, because a live write assigns `simulated = FALSE` and Stripe
 * ids begin `sub_` / `cus_`, never `sim_`.
 */
export async function revokeSimulatedEntitlements(db: Db): Promise<string[]> {
  await ensureServerSlotSchema(db);
  /* Sim-funded SLOTS first, because not every sim grant lives under a row the
   * DELETE below will reach: a player who tried the product simulated and then
   * subscribed for real keeps their (real) entitlement row, and the sim slot
   * riding on it would otherwise survive the sweep. Same escaped-prefix match
   * as the predicate, for the same reason. */
  const released = await db.query(
    `UPDATE server_slot_grants SET revoked_at = NOW()
      WHERE subscription_id LIKE 'sim\\_%' AND revoked_at IS NULL
      RETURNING player_id`
  );
  const r = await db.query(
    `DELETE FROM server_entitlements WHERE ${SIMULATED_PREDICATE} RETURNING player_id`
  );
  const deleted = (r.rows as { player_id: unknown }[]).map((row) => String(row.player_id));
  const gone = new Set(deleted);
  /* Re-materialise the allowance for the survivors whose sim slot was just
   * released. Deleted rows need nothing — the CASCADE took their grants too. */
  for (const row of released.rows as { player_id: unknown }[]) {
    const playerId = String(row.player_id);
    if (gone.has(playerId)) continue;
    await db.query(
      `UPDATE server_entitlements SET max_servers = $2, updated_at = NOW()
        WHERE player_id = $1`,
      [playerId, await liveSlots(db, playerId)]
    );
  }
  return deleted;
}

/* ---------------------------------------------------------------------- */
/* Comped hosting: a slot an operator decided to give away                 */
/* ---------------------------------------------------------------------- */

/**
 * Hosting handed out on purpose, through an access code.
 *
 * ── Why this is NOT `grantSimulatedHosting` with a nicer name ─────────────
 *
 * They look alike — both write an entitlement nobody paid for — and they are
 * opposites in the two ways that matter.
 *
 *   1. **A simulated grant is a rehearsal; a comp is a decision.** The
 *      simulated path exists only because there is no way to pay yet, and it
 *      refuses outright the moment `STRIPE_SECRET_KEY` appears — the bypass
 *      dies in the same action that opens the real door. A comp is an operator
 *      choosing to give somebody a server, and it has to keep working after
 *      payments go live, because that is the day comping is most useful.
 *
 *   2. **The pretend rows get swept; comps must survive the sweep.**
 *      `revokeSimulatedEntitlements` deletes every row marked `sim_` or
 *      `simulated = TRUE` — it is the "clean up the rehearsal before going
 *      live" button. If a comp were marked simulated, that button would
 *      silently cancel servers an operator had deliberately given away, and
 *      the audit trail would say the sweep did it.
 *
 * So a comp is marked `comp_` on both ids and is NOT `simulated`. The sweep's
 * predicate cannot match it, `toEntitlement` does not flag it, and any attempt
 * to reconcile the id against Stripe still fails loudly with "no such
 * subscription" — which is the property the `sim_` prefix was chosen for and is
 * worth keeping for exactly the same reason.
 *
 * ── It does not distort revenue, for the same reason a sim grant does not ──
 *
 * No `recordSitePurchase` row is written. Revenue is `SUM(amount_cents)` over
 * `purchases`, so a comp contributes nothing to it, which is the truth.
 *
 * ── It expires, and the slot is what expires ──────────────────────────────
 *
 * The days a code grants land on `server_slot_grants.expires_at`, not on
 * `server_entitlements.current_period_end`. That choice matters for one case:
 * a PAYING customer who also redeems a comp code. Their comp slot lapses and
 * stops counting; their paid slot is untouched and their allowance simply
 * drops back to what they pay for. Had the expiry been enforced on the
 * entitlement row — whose `stripe_subscription_id` holds whichever write
 * landed last — the lapsing comp would have taken their paid hosting down with
 * it.
 */

/* `COMP_PREFIX` and `compSubscriptionId` are defined in `accessCodeFormat.ts`
 * and re-exported here, so this module stays the one place to look up the
 * entitlement vocabulary while the admin app — which cannot import this file —
 * still derives the identical slot id when it claws a code back. See that
 * file's note for why the definition sits there rather than here. */
export { COMP_PREFIX, compSubscriptionId };

export function isCompId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(COMP_PREFIX);
}

/** The customer id for a comped player — stable, and obvious in any listing. */
export function compCustomerId(playerId: string): string {
  return `${COMP_PREFIX}cus_${playerId}`;
}

export type CompGrant =
  | { granted: true; entitlement: Entitlement }
  | { granted: false; reason: 'invalid' };

/**
 * Give this player one hosting slot for `days`, funded by this code.
 *
 * Goes through `writeEntitlement` like everything else, so accumulation, the
 * ordering guard and the slot ledger all behave identically to a purchase —
 * there is no second way to raise `max_servers` and this does not become one.
 */
export async function grantCompedHosting(
  db: Db,
  input: { playerId: string; codeHash: string; days: number }
): Promise<CompGrant> {
  const playerId = String(input?.playerId ?? '').trim();
  const codeHash = String(input?.codeHash ?? '').trim();
  const days = Math.max(1, Math.floor(Number(input?.days ?? 0)));
  if (!playerId || !codeHash || !Number.isFinite(days)) return { granted: false, reason: 'invalid' };

  const endsAt = new Date(Date.now() + days * 86_400_000).toISOString();
  const written = await writeEntitlement(db, {
    playerId,
    subscriptionId: compSubscriptionId(codeHash),
    customerId: compCustomerId(playerId),
    status: 'active',
    /* Shown to the owner as "your free hosting runs until…". The slot's own
     * `expires_at` below is what actually enforces it; this is the copy of the
     * date that the entitlement row carries for display, exactly as a real
     * subscription carries Stripe's. */
    currentPeriodEnd: endsAt,
    simulated: false,
    slotExpiresAt: endsAt,
  });
  if (!written.applied) return { granted: false, reason: 'invalid' };
  return { granted: true, entitlement: written.entitlement };
}

/**
 * Take back the slot one code funded for one player, leaving everything else.
 *
 * The claw-back half of the admin's revoke button. It releases exactly the
 * comp's own grant row and re-materialises the allowance from what survives, so
 * a player who also pays keeps what they pay for and a player who also redeemed
 * a different code keeps that. Returns the allowance they are left with.
 *
 * Idempotent: a second call finds `revoked_at` already set and changes nothing.
 */
export async function revokeCompedHosting(
  db: Db,
  playerId: string,
  codeHash: string
): Promise<number> {
  await ensureServerSlotSchema(db);
  await db.query(
    `UPDATE server_slot_grants SET revoked_at = NOW()
      WHERE player_id = $1 AND subscription_id = $2 AND revoked_at IS NULL`,
    [playerId, compSubscriptionId(codeHash)]
  );
  const remaining = await liveSlots(db, playerId);
  await db.query(
    `UPDATE server_entitlements SET max_servers = $2, updated_at = NOW()
      WHERE player_id = $1`,
    [playerId, remaining]
  );
  return remaining;
}
