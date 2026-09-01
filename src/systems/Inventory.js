import { isItem, itemDef, slotsFor, stackSize } from './ItemDefs.js';

/**
 * Player inventory: an unbounded-ish **store** plus an **active bag** that
 * starts at 30 slots and can be grown, permanently, to at most 60.
 *
 * Two rules shape the whole file.
 *
 * 1. Capacity is counted in *slots*, never in items. One slot holds one full
 *    stack, so 60 rifle rounds cost one slot and 61 cost two. Every accept path
 *    therefore asks "how many more units fit in the slots I have left", not
 *    "how many items are there".
 * 2. `consumeFromBag` is atomic. The weapons systems call it on the firing
 *    path, and a partial consume there would silently eat ammo for a shot that
 *    never happened - so it checks first and only then debits.
 *
 * Credits are *virtual*: they are addressable through this API by the id
 * `credits` for the loot and marketplace code's convenience, but they never
 * occupy a slot and always live in `Economy`.
 */

/**
 * Active bag capacity AT THE START OF A RUN, in slots. Contract-mandated.
 *
 * Still 30, and still the number `CONTRACTS-V3.md` names - what changed is that
 * it is now the floor rather than the whole story. `expandBag` raises
 * `_bagCapacity` above it and nothing lowers it back, so this constant is read
 * in exactly three places: the fresh-instance default, the clamp `deserialize`
 * applies to a save's `capacity`, and the tests that pin both.
 */
export const BAG_CAPACITY = 30;
/**
 * The most slots a bag can ever hold, however many expansion rigs are used.
 *
 * 60 for two reasons that happen to agree. It is double the start, so the
 * ladder has an obvious top; and it is exactly `STORE_CAPACITY`, which means
 * the fully-grown bag is the size of a container the panel has drawn since the
 * day it shipped - the 60-cell grid, the scroll behaviour and the column
 * widths are all already proven at this number, so growing the bag needs no
 * new layout and cannot invent a viewport the panel has never been measured at.
 *
 * Named, and exported, because THREE files need the same 60: this one clamps
 * to it, `ItemUse` refuses a rig at it, and the tests assert both. A literal
 * scattered across those would be three chances to disagree.
 */
export const BAG_CAPACITY_MAX = 60;
/** Store capacity, in slots. Generous, but finite so "both full" is reachable. */
const STORE_CAPACITY = 60;

/** Everything the player starts a fresh session with. */
const STARTER_BAG = [
  ['bullet', 180],
  ['arrow', 30],
  ['fireball_charge', 10],
  ['medkit', 2],
];
const STARTER_STORE = [
  ['bullet', 120],
  ['arrow', 30],
  ['alloy_scrap', 4],
];

export class Inventory {
  /**
   * @param {{ bus?:any, economy?:any, input?:any, root?:HTMLElement, ui?:boolean,
   *           starter?:boolean }} ctx
   */
  constructor({ bus, economy, input, root, ui = true, starter = true } = {}) {
    this.bus = bus ?? null;
    this.economy = economy ?? null;

    /** @type {Map<string, number>} store contents, id -> qty */
    this._store = new Map();
    /** @type {Map<string, number>} active bag contents, id -> qty */
    this._bag = new Map();

    this._bagCapacity = BAG_CAPACITY;
    this._storeCapacity = STORE_CAPACITY;

    // Snapshots handed to the UI. Rebuilt on change only - the panels read them
    // every time they redraw, and redrawing is a state-change event, not a frame.
    this._itemsCache = null;
    this._bagCache = null;

    /* -- optional self-hosted UI (see _tickUI) ------------------------- */
    this._input = input ?? null;
    this._uiRoot = root ?? null;
    this._wantUI = ui !== false;
    this.ui = null;
    this._uiPending = false;
    this._ticked = false;
    this._selfLoop = null;
    this._latch = false;
    this._desiredOpen = false;

    if (starter) this._grantStarterKit();

    if (this._wantUI && typeof document !== 'undefined') {
      this._mountUI();
      // The frame tick is orchestrator-owned. If nobody calls update() the
      // keybind would silently do nothing, so fall back to a plain keydown
      // listener - `input.pressed()` is useless off the frame loop because
      // main.js clears the edge set at the end of every frame.
      setTimeout(() => {
        if (!this._ticked) this._installKeyFallback();
      }, 2500);
    }
  }

  /* ====================================================================== */
  /* Contract surface                                                       */
  /* ====================================================================== */

  /** @returns {number} bag capacity in slots - 30 on a fresh run, up to 60 grown */
  get bagCapacity() {
    return this._bagCapacity;
  }

  /** @returns {number} the most slots this bag can ever hold (60) */
  get bagCapacityMax() {
    return BAG_CAPACITY_MAX;
  }

  /** @returns {number} slots currently occupied in the bag */
  get bagUsed() {
    return this._slotsOf(this._bag);
  }

  /** @returns {number} store capacity in slots */
  get storeCapacity() {
    return this._storeCapacity;
  }

  /** @returns {number} slots currently occupied in the store */
  get storeUsed() {
    return this._slotsOf(this._store);
  }

  /**
   * Store contents as a display snapshot. Stable object identity between
   * changes, so a UI can cheaply skip a redraw.
   * @returns {Array<{id:string, qty:number, slots:number, def:any}>}
   */
  get items() {
    if (!this._itemsCache) this._itemsCache = this._snapshot(this._store);
    return this._itemsCache;
  }

  /**
   * Active bag contents as a display snapshot.
   * @returns {Array<{id:string, qty:number, slots:number, def:any}>}
   */
  get bag() {
    if (!this._bagCache) this._bagCache = this._snapshot(this._bag);
    return this._bagCache;
  }

  /**
   * Add to the **store**. Credits are routed to Economy instead and always
   * succeed in full.
   * @param {string} itemId
   * @param {number} qty
   * @returns {number} how many were actually added
   */
  add(itemId, qty = 1) {
    const n = this._sanitise(qty);
    if (!n || !this._known(itemId)) return 0;
    if (this._isVirtual(itemId)) return this._addCredits(n);

    const accepted = this._accept(this._store, itemId, n, this._storeCapacity);
    if (accepted > 0) this._changed();
    if (accepted < n) this.bus?.emit('inventory:full', { itemId, overflow: n - accepted, where: 'store' });
    return accepted;
  }

  /**
   * Remove from the **store**.
   * @param {string} itemId
   * @param {number} qty
   * @returns {number} how many were actually removed
   */
  remove(itemId, qty = 1) {
    const n = this._sanitise(qty);
    if (!n) return 0;
    if (this._isVirtual(itemId)) return this.economy?.spend(n, 'inventory') ? n : 0;
    const removed = this._take(this._store, itemId, n);
    if (removed > 0) this._changed();
    return removed;
  }

  /**
   * Store count for an id. Deliberately **store only** - use `bagCount` for the
   * bag and `totalCount` for both.
   * @param {string} itemId
   * @returns {number}
   */
  count(itemId) {
    if (this._isVirtual(itemId)) return this.economy?.credits ?? 0;
    return this._store.get(itemId) ?? 0;
  }

  /**
   * Bag count for an id. This is what a weapon reports as its ammo.
   * @param {string} itemId
   * @returns {number}
   */
  bagCount(itemId) {
    if (this._isVirtual(itemId)) return this.economy?.credits ?? 0;
    return this._bag.get(itemId) ?? 0;
  }

  /** Store + bag. @param {string} itemId @returns {number} */
  totalCount(itemId) {
    return this.count(itemId) + this.bagCount(itemId);
  }

  /**
   * Move store -> bag, limited by free bag slots.
   * @param {string} itemId
   * @param {number} qty
   * @returns {number} how many moved
   */
  moveToBag(itemId, qty = 1) {
    const n = this._sanitise(qty);
    if (!n || this._isVirtual(itemId)) return 0;
    const available = Math.min(n, this._store.get(itemId) ?? 0);
    if (available <= 0) return 0;

    const room = this._roomFor(this._bag, itemId, this._bagCapacity);
    const moved = Math.min(available, room);
    if (moved <= 0) {
      this.bus?.emit('inventory:full', { itemId, overflow: available, where: 'bag' });
      return 0;
    }
    this._take(this._store, itemId, moved);
    this._put(this._bag, itemId, moved);
    this._changed();
    if (moved < available) this.bus?.emit('inventory:full', { itemId, overflow: available - moved, where: 'bag' });
    return moved;
  }

  /**
   * Move bag -> store, limited by free store slots.
   * @param {string} itemId
   * @param {number} qty
   * @returns {number} how many moved
   */
  moveToStore(itemId, qty = 1) {
    const n = this._sanitise(qty);
    if (!n || this._isVirtual(itemId)) return 0;
    const available = Math.min(n, this._bag.get(itemId) ?? 0);
    if (available <= 0) return 0;

    const room = this._roomFor(this._store, itemId, this._storeCapacity);
    const moved = Math.min(available, room);
    if (moved <= 0) {
      this.bus?.emit('inventory:full', { itemId, overflow: available, where: 'store' });
      return 0;
    }
    this._take(this._bag, itemId, moved);
    this._put(this._store, itemId, moved);
    this._changed();
    if (moved < available) this.bus?.emit('inventory:full', { itemId, overflow: available - moved, where: 'store' });
    return moved;
  }

  /**
   * Atomically spend from the bag. **Never partially consumes**: if the bag
   * holds fewer than `qty` this returns false and changes nothing, which is what
   * lets a weapon ask for a burst's worth of ammo in one call.
   * @param {string} itemId
   * @param {number} qty
   * @returns {boolean}
   */
  consumeFromBag(itemId, qty = 1) {
    const n = this._sanitise(qty);
    if (!n) return false;
    if (this._isVirtual(itemId)) return !!this.economy?.spend(n, 'inventory');
    const have = this._bag.get(itemId) ?? 0;
    if (have < n) return false;
    this._take(this._bag, itemId, n);
    this._changed();
    return true;
  }

  /** @returns {{version:number, store:Array, bag:Array, capacity:number}} */
  serialize() {
    return {
      version: 1,
      capacity: this._bagCapacity,
      store: [...this._store.entries()],
      bag: [...this._bag.entries()],
    };
  }

  /**
   * Restore from `serialize()`. Fails safe: a foreign or corrupt payload leaves
   * the current contents untouched rather than throwing into the frame loop.
   * @param {any} data
   * @returns {boolean} true when something was restored
   */
  deserialize(data) {
    if (!data || typeof data !== 'object') return false;
    const store = Array.isArray(data.store) ? data.store : null;
    const bag = Array.isArray(data.bag) ? data.bag : null;
    if (!store && !bag) return false;

    this._store.clear();
    this._bag.clear();
    /* CAPACITY FIRST, ROWS SECOND. THE ORDER IS THE BUG.
     *
     * `serialize()` has always emitted `capacity`, and this method used to
     * ignore it and re-accept the rows against whatever capacity the instance
     * happened to be carrying - which for a freshly constructed `Inventory` is
     * always 30. So a 60-slot save loaded into a 30-slot bag and `_accept`
     * silently dropped everything past slot 30. Not a warning, not an
     * `inventory:full` (that event is raised by `add`/`moveToBag`, not by the
     * restore path): thirty slots of a player's carried kit, gone on load.
     *
     * Restoring the capacity here, before a single row is accepted, is the fix.
     * `_clampCapacity` is what makes it safe to trust a file the player can
     * edit: a hand-written `capacity: 500` restores at 60, and a missing,
     * zero, negative or non-numeric one restores at 30 - which is exactly what
     * every save written before bag expansion existed will hand us. */
    this._bagCapacity = this._clampCapacity(data.capacity);
    // Re-add through the accept path so a save written under a bigger capacity
    // (or with an item that has since been removed) cannot overfill the bag.
    for (const entry of bag ?? []) {
      const [id, qty] = Array.isArray(entry) ? entry : [entry?.id, entry?.qty];
      if (this._known(id) && !this._isVirtual(id)) this._accept(this._bag, id, this._sanitise(qty), this._bagCapacity);
    }
    for (const entry of store ?? []) {
      const [id, qty] = Array.isArray(entry) ? entry : [entry?.id, entry?.qty];
      if (this._known(id) && !this._isVirtual(id)) this._accept(this._store, id, this._sanitise(qty), this._storeCapacity);
    }
    this._changed();
    return true;
  }

  /* ====================================================================== */
  /* Additions (documented in the agent report)                             */
  /* ====================================================================== */

  /**
   * Grow the active bag, permanently, and say how much of the ask landed.
   *
   * ── THE RETURN VALUE IS THE WHOLE CONTRACT ──────────────────────────────
   * It is how many slots were ACTUALLY added, not how many were asked for, and
   * the caller is expected to tell the player that number rather than the one
   * on the item. A bag at 55 given a +10 rig grows by 5, and `ItemUse` says
   * "+5 slots" - because a use that quietly reported 10 while granting 5 is
   * the game lying about the only thing the player bought.
   *
   * At the cap it returns 0 and changes nothing, which is a legitimate answer
   * and NOT the way the refusal is meant to be reached: `ItemUse._canApply`
   * asks `bagCapacity < bagCapacityMax` BEFORE `consumeFromBag`, so a rig used
   * at 60 is kept rather than eaten. This zero is the backstop for any caller
   * that forgets to ask first.
   *
   * ── NO DEDICATED EVENT, AND THAT IS A DECISION ──────────────────────────
   * `_changed()` alone, so this raises the same `inventory:changed` every other
   * mutation raises - and that event has ALWAYS carried `bagCapacity` in its
   * payload. The panel's capacity bar is rebuilt inside `InventoryUI._render`,
   * which runs on `inventory:changed` and again on `open()`, so a bar built for
   * 30 ticks is corrected whether the panel was open when the rig was used or
   * not. A second `inventory:capacity` event would be a second subscription
   * driving the identical redraw, and the failure that shape produces is one
   * listener being wired and the other forgotten - the panel then under-reports
   * capacity forever, silently, which is precisely the bug this note exists to
   * avoid. One event, one redraw path.
   *
   * @param {number} slots how many slots to add
   * @returns {number} how many slots were actually added (0 at the cap)
   */
  expandBag(slots) {
    const want = this._sanitise(slots);
    if (!want) return 0;
    const next = Math.min(BAG_CAPACITY_MAX, this._bagCapacity + want);
    const added = next - this._bagCapacity;
    if (added <= 0) return 0;
    this._bagCapacity = next;
    this._changed();
    return added;
  }

  /**
   * Add straight to the bag, respecting slots.
   * @param {string} itemId @param {number} qty
   * @returns {number} how many were accepted
   */
  addToBag(itemId, qty = 1) {
    const n = this._sanitise(qty);
    if (!n || !this._known(itemId)) return 0;
    if (this._isVirtual(itemId)) return this._addCredits(n);
    const accepted = this._accept(this._bag, itemId, n, this._bagCapacity);
    if (accepted > 0) this._changed();
    return accepted;
  }

  /**
   * Pick something up: bag first, store as overflow. This is the loot path, and
   * the return value tells the caller whether the pickup can be cleared.
   *
   * @param {string} itemId
   * @param {number} qty
   * @returns {{toBag:number, toStore:number, dropped:number, taken:number}}
   */
  acquire(itemId, qty = 1) {
    const n = this._sanitise(qty);
    const out = { toBag: 0, toStore: 0, dropped: 0, taken: 0 };
    if (!n || !this._known(itemId)) return out;

    if (this._isVirtual(itemId)) {
      out.toBag = this._addCredits(n);
      out.taken = out.toBag;
      return out;
    }

    out.toBag = this._accept(this._bag, itemId, n, this._bagCapacity);
    const left = n - out.toBag;
    if (left > 0) out.toStore = this._accept(this._store, itemId, left, this._storeCapacity);
    out.taken = out.toBag + out.toStore;
    out.dropped = n - out.taken;

    if (out.taken > 0) this._changed();
    if (out.dropped > 0) this.bus?.emit('inventory:full', { itemId, overflow: out.dropped, where: 'both' });
    return out;
  }

  /** How many units of `itemId` the bag could still take. */
  bagRoomFor(itemId) {
    return this._isVirtual(itemId) ? Infinity : this._roomFor(this._bag, itemId, this._bagCapacity);
  }

  /** How many units of `itemId` the store could still take. */
  storeRoomFor(itemId) {
    return this._isVirtual(itemId) ? Infinity : this._roomFor(this._store, itemId, this._storeCapacity);
  }

  /** Bag + store room, i.e. what `acquire` would accept. */
  roomFor(itemId) {
    return this.bagRoomFor(itemId) + this.storeRoomFor(itemId);
  }

  /** Sort a container by kind, then name. @param {'bag'|'store'} where */
  sort(where = 'bag') {
    const map = where === 'store' ? this._store : this._bag;
    const rows = [...map.entries()].sort((a, b) => {
      const da = itemDef(a[0]);
      const db = itemDef(b[0]);
      const ka = KIND_ORDER[da?.kind] ?? KIND_ORDER_UNKNOWN;
      const kb = KIND_ORDER[db?.kind] ?? KIND_ORDER_UNKNOWN;
      if (ka !== kb) return ka - kb;
      return (da?.name ?? a[0]).localeCompare(db?.name ?? b[0]);
    });
    map.clear();
    for (const [id, qty] of rows) map.set(id, qty);
    this._changed();
  }

  /** Drop everything (used by tests and by a fresh-game reset). */
  clear() {
    this._store.clear();
    this._bag.clear();
    this._changed();
  }

  /**
   * Per-frame tick. Only needed for the self-hosted panel's `I` keybind; the
   * data model itself is entirely event driven.
   * @param {number} dt
   */
  update(dt = 0) {
    this._ticked = true;
    this._tickUI();
    this.ui?.update?.(dt);
  }

  open() {
    if (this.ui?.isOpen) return;
    this._desiredOpen = true;
    if (!this.ui) {
      this._mountUI();
      return;
    }
    this._desiredOpen = false;
    this.ui.open?.();
  }

  close() {
    this._desiredOpen = false;
    this.ui?.close?.();
  }

  toggle() {
    if (this.ui?.isOpen) this.close();
    else this.open();
  }

  dispose() {
    this._stopSelfLoop();
    this.ui?.dispose?.();
    this.ui = null;
  }

  /* ====================================================================== */
  /* Internals                                                              */
  /* ====================================================================== */

  /* `isItem`, not a bare `ITEMS[id]`: the bare read also answers true for
   * every key on `Object.prototype`, so an id of `toString` used to pass this
   * gate and then poison the slot arithmetic with NaN. @see ItemDefs.isItem */
  _known(id) {
    return isItem(id);
  }

  _isVirtual(id) {
    return itemDef(id)?.virtual === true;
  }

  _sanitise(qty) {
    const n = Math.floor(Number(qty));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /**
   * A bag capacity that is safe to install, from anything at all.
   *
   * Clamped to `[BAG_CAPACITY, BAG_CAPACITY_MAX]` rather than merely floored,
   * because the input is a save file. Below the floor the panel would draw
   * fewer cells than the starter kit fills; above the ceiling a hand-edited
   * `capacity: 500` would hand out 470 free slots and the shop would have
   * nothing left to sell. Anything that is not a finite number at all -
   * absent, `null`, `"lots"`, `NaN` - reads as a pre-expansion save and
   * restores at 30, never at 0 and never at `undefined`.
   *
   * @param {unknown} value
   * @returns {number}
   */
  _clampCapacity(value) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n)) return BAG_CAPACITY;
    return Math.min(BAG_CAPACITY_MAX, Math.max(BAG_CAPACITY, n));
  }

  _addCredits(n) {
    this.economy?.add(n, 'inventory');
    return n;
  }

  /** Slots occupied by a whole container. */
  _slotsOf(map) {
    let slots = 0;
    for (const [id, qty] of map) slots += slotsFor(id, qty);
    return slots;
  }

  /**
   * How many more units of `id` a container can take.
   *
   * The slot maths is the interesting part: a partially filled stack absorbs
   * units for free, so the answer is "every unit that fits in the slots I
   * already hold for this item, plus every free slot's worth", not
   * "free slots x stack size".
   */
  _roomFor(map, id, capacity) {
    const stack = stackSize(id);
    if (!Number.isFinite(stack)) return Infinity;
    const held = map.get(id) ?? 0;
    const mine = slotsFor(id, held);
    const free = capacity - this._slotsOf(map);
    return Math.max(0, (mine + free) * stack - held);
  }

  /** Add as much of `qty` as fits. @returns {number} accepted */
  _accept(map, id, qty, capacity) {
    if (qty <= 0) return 0;
    const accepted = Math.min(qty, this._roomFor(map, id, capacity));
    if (accepted > 0) this._put(map, id, accepted);
    return accepted;
  }

  _put(map, id, qty) {
    map.set(id, (map.get(id) ?? 0) + qty);
  }

  /** Remove up to `qty`. @returns {number} removed */
  _take(map, id, qty) {
    const have = map.get(id) ?? 0;
    const removed = Math.min(have, qty);
    if (removed <= 0) return 0;
    if (removed === have) map.delete(id);
    else map.set(id, have - removed);
    return removed;
  }

  _snapshot(map) {
    const out = [];
    for (const [id, qty] of map) {
      out.push({ id, qty, slots: slotsFor(id, qty), def: itemDef(id) });
    }
    return out;
  }

  _changed() {
    this._itemsCache = null;
    this._bagCache = null;
    this.bus?.emit('inventory:changed', {
      items: this.items,
      bag: this.bag,
      bagUsed: this.bagUsed,
      bagCapacity: this._bagCapacity,
    });
  }

  _grantStarterKit() {
    for (const [id, qty] of STARTER_BAG) this._accept(this._bag, id, qty, this._bagCapacity);
    for (const [id, qty] of STARTER_STORE) this._accept(this._store, id, qty, this._storeCapacity);
  }

  /* ------------------------------------------------------------------ */
  /* Self-hosted panel                                                   */
  /* ------------------------------------------------------------------ */

  /** Lazily build the panel. Dynamic so the data model never pulls in the DOM. */
  _mountUI() {
    if (this.ui || this._uiPending) return;
    this._uiPending = true;
    import('../ui/InventoryUI.js')
      .then(({ InventoryUI }) => {
        this._uiPending = false;
        this.ui = new InventoryUI({
          bus: this.bus,
          inventory: this,
          economy: this.economy,
          input: this._resolveInput(),
          root: this._uiRoot ?? document.getElementById('ui-root') ?? document.body,
        });
        const shouldOpen = this._desiredOpen;
        this._desiredOpen = false;
        if (shouldOpen) this.ui.open();
      })
      .catch((err) => {
        this._uiPending = false;
        console.warn('[inventory] panel failed to mount:', err);
      });
  }

  _resolveInput() {
    if (this._input) return this._input;
    this._input = (typeof window !== 'undefined' ? window.GAME?.input : null) ?? null;
    return this._input;
  }

  /** `I` toggles the panel. Latched so a double tick cannot toggle twice. */
  _tickUI() {
    const ui = this.ui;
    const input = this._resolveInput();
    if (!ui || !input) return;
    if (ui.isOpen) return; // the open panel owns the keyboard itself
    const down = input.pressed?.('KeyI') ?? false;
    if (down && !this._latch) {
      this._latch = true;
      ui.open();
    } else if (!down) {
      this._latch = false;
    }
  }

  _installKeyFallback() {
    if (this._selfLoop) return;
    console.info('[inventory] no external tick - binding "I" directly');
    this._selfLoop = (e) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code !== 'KeyI') return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (this.ui?.isOpen) return; // the open panel owns the keyboard
      this.ui?.open();
    };
    window.addEventListener('keydown', this._selfLoop);
  }

  _stopSelfLoop() {
    if (this._selfLoop) window.removeEventListener('keydown', this._selfLoop);
    this._selfLoop = null;
  }
}

/**
 * Sort weighting so ammo leads a sorted panel and trinkets trail it.
 *
 * `mountpower` sits beside `skin` at the back rather than with the
 * consumables it behaves like, because both are one-slot things you apply to
 * a mount and then never see again: a player sorting their bag is looking for
 * the ammunition and the medkits, and a wall of 57 possible upgrade cells in
 * front of those would be the sort making the panel worse.
 *
 * `shipskin` takes rung 9, its own, BEHIND the mount skins rather than tied
 * with them. Tied ranks fall through to a name comparison, which would have
 * interleaved nine ship liveries alphabetically through twenty mount skins -
 * and "which of these can I actually put on the thing I am standing next to"
 * is exactly the question the sort is meant to answer. Two runs of cells, one
 * per vehicle, answers it; one shuffled run does not.
 *
 * Rung 9 was the UNKNOWN bucket - `KIND_ORDER[kind] ?? 9` - so taking it moved
 * the fallback to 99. Left at 9 an item of an unrecognised kind would have
 * sorted in among the ship liveries by name, which is the one place a reader of
 * a sorted bag would be least likely to notice it.
 */
const KIND_ORDER = { ammo: 0, consumable: 1, trinket: 2, currency: 3, mountpower: 7, skin: 8, shipskin: 9 };

/** Where a kind nothing recognises sorts. Past every real rung, on purpose. */
const KIND_ORDER_UNKNOWN = 99;
