/**
 * Credit economy.
 *
 * Deliberately tiny and event-driven: the only thing that earns credits today is
 * killing a hostile yourself, so the system's whole job is to observe
 * `npc:killed`, decide whether it was the player's doing, and award once.
 *
 * The "award once" part is the interesting bit. `Combat._applyNPCDamage` guards
 * its own emit with `_sawNpcKilled`, but NPCs are pooled: `NPCManager` respawns
 * a dead hostile by calling `npc.respawn()` on the *same instance*, so ids and
 * object identity both come back around. A naive "never pay twice for this id"
 * set would silently stop paying after the first kill of each hostile - about
 * ten kills into a session the economy would look broken.
 *
 * So the guard is scoped to a single *death*: an id goes into `_awarded` when we
 * pay for it and comes back out when we observe that NPC alive again (either via
 * `npc:spawned`, which NPCManager emits on respawn, or lazily by noticing
 * `npc.isDead === false` on a later kill event). Duplicate emits for one death
 * are ignored; a genuine second kill of a respawned hostile pays out normally.
 */

/** Credits awarded per hostile the player personally kills. */
export const CREDITS_PER_KILL = 5;

export class Economy {
  /**
   * @param {{ bus: import('../core/EventBus.js').EventBus, credits?: number }} ctx
   */
  constructor({ bus, credits = 0 }) {
    this.bus = bus;
    this._credits = Number.isFinite(credits) ? Math.max(0, Math.floor(credits)) : 0;
    /** Lifetime counters, handy for the HUD and for save/load sanity checks. */
    this._earned = 0;
    this._spent = 0;
    this._kills = 0;

    /**
     * Keys of NPCs we have already paid for and have not yet seen alive again.
     * Keyed by `npc.id` when present, falling back to the object itself so an
     * id-less NPC still de-duplicates.
     * @type {Set<string|object>}
     */
    this._awarded = new Set();

    /** @type {Array<() => void>} */
    this._offs = [];
    if (bus) {
      this._offs.push(bus.on('npc:killed', (e) => this._onNPCKilled(e)));
      // Respawn reuses the instance, so clearing here re-arms the payout.
      this._offs.push(bus.on('npc:spawned', (e) => this._forget(e?.npc)));
      this._offs.push(bus.on('npc:despawned', (e) => this._forget(e?.npc)));
    }
  }

  /* ================================================================ */
  /* Contract surface                                                  */
  /* ================================================================ */

  /** @returns {number} current balance (integer, never negative) */
  get credits() {
    return this._credits;
  }

  /** Hostiles the player has been paid for this session. */
  get kills() {
    return this._kills;
  }

  /**
   * Grant credits and announce the change.
   * @param {number} amount whole credits; non-finite or <= 0 is a no-op
   * @param {string} [reason] free-form tag surfaced on `credits:changed`
   * @returns {number} the new balance
   */
  add(amount, reason = 'unknown') {
    const delta = Math.floor(Number(amount));
    if (!Number.isFinite(delta) || delta <= 0) return this._credits;
    this._credits += delta;
    this._earned += delta;
    this._emit(delta, reason, 'add');
    return this._credits;
  }

  /**
   * Deduct credits if the balance covers it.
   *
   * `itemId` is the one piece of context the server needs and the reason tag
   * cannot carry. A marketplace debit is a CATALOGUE PURCHASE: the server prices
   * it from `cost_buy` on the row, and refuses a marketplace debit that does not
   * say which row, because the alternative is the browser naming the price — a
   * 1,071-credit item was bought for 1 credit that way. The funnel is the only
   * thing between `Marketplace.buy` and the report, so the id travels here.
   *
   * Nothing else passes it and nothing else needs to: `Inventory`'s virtual-credit
   * spend is not a purchase and stays a plain declared debit.
   *
   * @param {number} amount
   * @param {string} [reason]
   * @param {{itemId?: string}} [meta] extra context surfaced on `credits:changed`
   * @returns {boolean} true when the balance was actually debited
   */
  spend(amount, reason = 'unknown', meta = null) {
    const cost = Math.floor(Number(amount));
    if (!Number.isFinite(cost) || cost <= 0) return false;
    if (cost > this._credits) return false;
    this._credits -= cost;
    this._spent += cost;
    this._emit(-cost, reason, 'spend', meta);
    return true;
  }

  /**
   * Force the balance to a value without an earn/spend audit trail. Used by
   * SaveGame; gameplay should use add/spend.
   * @param {number} value
   * @param {string} [reason]
   */
  set(value, reason = 'set') {
    const next = Math.max(0, Math.floor(Number(value)) || 0);
    const delta = next - this._credits;
    if (delta === 0) return this._credits;
    this._credits = next;
    this._emit(delta, reason, 'set');
    return this._credits;
  }

  /** @returns {{version:number, credits:number, earned:number, spent:number, kills:number}} */
  serialize() {
    return {
      version: 1,
      credits: this._credits,
      earned: this._earned,
      spent: this._spent,
      kills: this._kills,
    };
  }

  /**
   * Restore from `serialize()` output. Tolerates anything: a missing, foreign or
   * malformed payload leaves the balance untouched rather than throwing.
   * @param {any} data
   * @returns {boolean} true when something was actually restored
   */
  deserialize(data) {
    if (!data || typeof data !== 'object') return false;
    const credits = Number(data.credits);
    if (!Number.isFinite(credits)) return false;
    this._earned = Number.isFinite(Number(data.earned)) ? Math.max(0, Math.floor(data.earned)) : this._earned;
    this._spent = Number.isFinite(Number(data.spent)) ? Math.max(0, Math.floor(data.spent)) : this._spent;
    this._kills = Number.isFinite(Number(data.kills)) ? Math.max(0, Math.floor(data.kills)) : this._kills;
    this.set(credits, 'load');
    return true;
  }

  dispose() {
    for (const off of this._offs) {
      try {
        off();
      } catch {
        /* a bus that already cleared its handlers is not an error */
      }
    }
    this._offs.length = 0;
    this._awarded.clear();
  }

  /* ================================================================ */
  /* Internals                                                         */
  /* ================================================================ */

  /**
   * @param {number} delta
   * @param {string} reason
   * @param {'add'|'spend'|'set'} op which call produced this change
   * @param {{itemId?: string}|null} [meta] extra context, spread onto the event
   *
   * `op` exists because `reason` cannot be trusted to say what happened.
   * `CreditReporter` must report gameplay and must NOT report bookkeeping, and
   * the two are not distinguishable by tag: `QuestSystem` both `add`s a reward
   * and `set`s an absolute balance under the same 'quest' tag, and a reporter
   * filtering on tags alone would re-report the whole balance as if it were
   * fresh earnings. The operation is the honest discriminator.
   */
  _emit(delta, reason, op, meta = null) {
    const event = { credits: this._credits, delta, reason, op };
    // Only the fields that are actually present, so a listener can test for one
    // rather than for `undefined`.
    if (meta && typeof meta.itemId === 'string' && meta.itemId) event.itemId = meta.itemId;
    this.bus?.emit('credits:changed', event);
  }

  /** Stable de-duplication key for an NPC. */
  _key(npc) {
    if (!npc) return null;
    return typeof npc.id === 'string' || typeof npc.id === 'number' ? String(npc.id) : npc;
  }

  _forget(npc) {
    const key = this._key(npc);
    if (key !== null) this._awarded.delete(key);
  }

  /**
   * `npc:killed` -> `{ npc, byPlayer, weaponId }`. Only `byPlayer === true`
   * pays; NPC-on-NPC and scripted deaths are worth nothing.
   */
  _onNPCKilled(event) {
    if (!event || event.byPlayer !== true) return;
    const npc = event.npc;
    const key = this._key(npc);

    if (key !== null) {
      // A kill event for an NPC we already paid for and have not seen revived is
      // a duplicate emit, not a second kill.
      if (this._awarded.has(key)) {
        if (npc && npc.isDead === false) this._awarded.delete(key);
        else return;
      }
      this._awarded.add(key);
    }

    this._kills++;
    this.add(CREDITS_PER_KILL, 'kill');
  }
}
