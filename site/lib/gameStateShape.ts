/**
 * What `players.game_state` is allowed to contain.
 *
 * ── What it used to be ────────────────────────────────────────────────────
 *
 *     const stateJson = state == null ? null : JSON.stringify(state).slice(0, 200_000);
 *
 * One line, and two separate faults in it.
 *
 * **No shape at all.** Whatever the browser sent was stored. A signed-in caller
 * could POST a 190 KB object of arbitrary keys and it would be kept, read back
 * on every boot, and handed to the game — so the column was an
 * attacker-writable free-form store hanging off an account row.
 *
 * **`slice()` on JSON produces invalid JSON.** Truncating at 200,000 characters
 * cuts mid-token, so a save that went one byte over was stored as an
 * unparseable fragment, and `getGameState`'s `JSON.parse` then threw and
 * returned `null` — SILENTLY. The player's entire inventory, mounts, cosmetics,
 * ship and character were gone, and the only trace was a `catch` returning
 * null. A save too big to keep must be REFUSED, so the client learns and the
 * previous good save survives.
 *
 * ── What is checked ───────────────────────────────────────────────────────
 *
 * The top-level keys are the ones `buildRemotePayload()` in `src/main.js`
 * builds, and each is required to be the right sort of thing. Anything else is
 * DROPPED rather than refused, and that asymmetry is deliberate: an unknown key
 * is most likely a newer client talking to an older deployment, and this
 * repository's standing rule is that the failure mode to design against is
 * LOSS. Refusing the write would stop that player's inventory saving at all;
 * dropping the field costs them only the field.
 *
 * A key that IS known but the wrong type is refused, because that is not a
 * version skew, it is a client sending something no version of it ever sent.
 */

/** The largest quantity of one item this validator will accept in a save. */
export const MAX_ITEM_QTY = 100_000;

/**
 * The most a legitimate bag or store can hold of ONE item, for the record:
 * 60 slots (`STORE_CAPACITY`, and `BAG_CAPACITY_MAX`) times the largest stack
 * size in `src/systems/ItemDefs.js`, which is 240. `MAX_ITEM_QTY` is roughly
 * seven times that, which is the headroom convention `creditPricing.ts` sets
 * out: a ceiling that clips real play is worse than no ceiling, so it sits far
 * above anything the shipped game can produce and only a forgery reaches it.
 */
export const LARGEST_LEGITIMATE_ITEM_QTY = 60 * 240;

/** Serialised bytes. The column is TEXT; this is a sanity bound, not storage. */
export const MAX_STATE_BYTES = 200_000;

export type StateCheck =
  | { ok: true; state: Record<string, unknown>; dropped: string[] }
  | { ok: false; reason: string };

/**
 * The keys `src/main.js` sends, and what each must be.
 *
 * `object` here means "a non-null, non-array object, or null" — every one of
 * these is a `serialize()` result or null when the system is absent.
 */
const TOP_LEVEL: Record<string, 'number' | 'object'> = {
  v: 'number',
  at: 'number',
  inventory: 'object',
  mounts: 'object',
  cosmetics: 'object',
  piloting: 'object',
  character: 'object',
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Quantities in one `Inventory.serialize()` collection.
 *
 * The wire form is `[...map.entries()]`, i.e. `[[itemId, qty], ...]`. The
 * deserialiser also tolerates `{id, qty}` objects, so both are checked — a
 * bound that only covers one of two accepted spellings is not a bound.
 */
function collectionWithinBounds(rows: unknown): boolean {
  if (rows == null) return true;
  if (!Array.isArray(rows)) return false;
  /* 60 slots each side, and one row per item id. A little headroom for a save
   * written under a future capacity, and finite so a forged payload cannot ask
   * the database to store a novel one row at a time. */
  if (rows.length > 512) return false;
  for (const row of rows) {
    const qty = Array.isArray(row)
      ? row[1]
      : isPlainObject(row)
        ? row.qty
        : undefined;
    if (qty === undefined || qty === null) continue; // the client re-sanitises
    const n = Number(qty);
    if (!Number.isFinite(n)) return false;
    if (n < 0 || n > MAX_ITEM_QTY) return false;
  }
  return true;
}

/**
 * Validate a game-state blob, or say why not.
 *
 * Returns the state to store — the same object minus any unknown keys — rather
 * than a boolean, so the caller cannot forget to store the cleaned version and
 * write the original back instead.
 */
export function checkGameState(raw: unknown): StateCheck {
  if (!isPlainObject(raw)) {
    return { ok: false, reason: 'state must be an object' };
  }

  const state: Record<string, unknown> = {};
  const dropped: string[] = [];

  for (const [key, value] of Object.entries(raw)) {
    const expected = TOP_LEVEL[key];
    if (!expected) {
      dropped.push(key);
      continue;
    }
    if (value === null || value === undefined) {
      state[key] = null;
      continue;
    }
    if (expected === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) return { ok: false, reason: `${key} must be a finite number` };
      state[key] = n;
      continue;
    }
    if (!isPlainObject(value)) return { ok: false, reason: `${key} must be an object or null` };
    state[key] = value;
  }

  /* The inventory is the one section with a number in it worth forging: the
   * game restores quantities from this blob, so an unbounded `qty` is items
   * from nothing. `Inventory.deserialize` re-sanitises and re-accepts through
   * the capacity path, so this is not the only guard — but it is the one on
   * the side of the wire the player does not control. */
  const inventory = state.inventory;
  if (isPlainObject(inventory)) {
    if (!collectionWithinBounds(inventory.bag)) {
      return { ok: false, reason: 'inventory.bag is malformed or over the per-item limit' };
    }
    if (!collectionWithinBounds(inventory.store)) {
      return { ok: false, reason: 'inventory.store is malformed or over the per-item limit' };
    }
    if (inventory.capacity !== undefined && inventory.capacity !== null) {
      const cap = Number(inventory.capacity);
      /* `Inventory._clampCapacity` clamps to [30, 60] on read, so anything wildly
       * outside that is a hand-edited save rather than a version we shipped. */
      if (!Number.isFinite(cap) || cap < 0 || cap > 1000) {
        return { ok: false, reason: 'inventory.capacity is out of range' };
      }
    }
  }

  /* Measured on the CLEANED object, because that is what gets stored, and
   * refused rather than truncated — see the header for what `slice()` on JSON
   * actually did to people's saves. */
  const json = JSON.stringify(state);
  if (Buffer.byteLength(json, 'utf8') > MAX_STATE_BYTES) {
    return { ok: false, reason: 'state is too large to store' };
  }

  return { ok: true, state, dropped };
}
