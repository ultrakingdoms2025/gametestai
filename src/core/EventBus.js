/**
 * Global publish/subscribe bus.
 *
 * Every subsystem communicates through this rather than holding direct
 * references to each other. That keeps worlds, UI, combat and AI independently
 * replaceable. See CONTRACTS.md for the authoritative event catalogue.
 */
export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._handlers = new Map();
    this._queue = [];
  }

  /** Subscribe. Returns an unsubscribe function. */
  on(type, fn) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(fn);
    return () => this.off(type, fn);
  }

  /** Subscribe for a single delivery. */
  once(type, fn) {
    const off = this.on(type, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  off(type, fn) {
    this._handlers.get(type)?.delete(fn);
  }

  /** Fire synchronously. Handler exceptions are contained so one bad listener cannot stall a frame. */
  emit(type, payload) {
    const set = this._handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[EventBus] handler for "${type}" threw:`, err);
      }
    }
  }

  /** Defer an emit to the end of the current frame (avoids mutation-during-iteration hazards). */
  emitDeferred(type, payload) {
    this._queue.push([type, payload]);
  }

  /** Called once per frame by the engine to drain deferred emits. */
  flush() {
    if (this._queue.length === 0) return;
    const queue = this._queue;
    this._queue = [];
    for (const [type, payload] of queue) this.emit(type, payload);
  }

  clear() {
    this._handlers.clear();
    this._queue.length = 0;
  }
}

export const bus = new EventBus();
