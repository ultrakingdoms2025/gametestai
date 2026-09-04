/**
 * Developer / admin console, driven by typed key sequences.
 *
 * ── Why a sequence and not a hotkey ───────────────────────────────────────
 * Every unmodified key in this game is already spoken for - WASD, Shift,
 * Space, R, 1-4, V, H, G, J, F, I, B, K, T, E, F1/F3/F5/F9 and the bracket
 * keys - and `Input._bind` deliberately drops anything with Ctrl, Meta or Alt
 * held so the browser's own shortcuts keep working. That rules out both a
 * spare letter and a modifier chord, and leaves the oldest trick there is: a
 * short code you type. It cannot be pressed by accident, it needs no UI, and
 * adding another one costs a line.
 *
 * Sequences are matched against a rolling buffer of the last few keys, so a
 * mistyped prefix does not need clearing - "ammoammo" still fires on the
 * second attempt - and an idle gap resets it so a code can never be completed
 * by two unrelated presses minutes apart.
 *
 * ── Why it listens to the window directly ─────────────────────────────────
 * `Input` swallows keys while the chat box has text capture, and it only
 * reports keys it knows about. A cheat code has to be readable whether or not
 * the pointer is locked, but *not* while the player is typing a chat message -
 * so this uses its own listener and asks `Input` whether text is being
 * captured before recording anything.
 */

/** Keys older than this are dropped, so a code has to be typed as a phrase. */
const IDLE_RESET = 1.6;
/** Longest code we will ever match; the buffer never needs to exceed it. */
const MAX_CODE = 12;

export class AdminCheats {
  /**
   * @param {{bus:any, input:any, loadout:any, player:any, economy:any,
   *          enabled?:boolean}} ctx
   */
  constructor({
    bus, input, loadout, player, economy, worldManager, portals, enabled = true,
  } = {}) {
    this.bus = bus ?? null;
    this.input = input ?? null;
    this.loadout = loadout ?? null;
    this.player = player ?? null;
    this.economy = economy ?? null;
    /** For `reset`, the only code that leaves the world it was typed in. */
    this.worldManager = worldManager ?? null;
    this.portals = portals ?? null;
    this.enabled = enabled !== false;

    /** Rolling buffer of recent letter keys. */
    this._buf = '';
    this._last = 0;

    /**
     * code -> handler. Lower case, letters only: `KeyA` -> 'a'.
     * @type {Map<string, {label:string, run:() => string|void}>}
     */
    this.codes = new Map();
    this.register('ammo', 'Resupply every weapon', () => this._resupply());
    this.register('heal', 'Restore health and stamina', () => this._heal());
    this.register('rich', 'Grant 5000 credits', () => this._credits(5000));
    this.register('reset', 'Return to Aether Station', () => this._toStation());

    this._onKey = (e) => this._handleKey(e);
    if (typeof window !== 'undefined') window.addEventListener('keydown', this._onKey);
  }

  /**
   * Add a code. Letters only - digits and symbols vary by keyboard layout.
   * @param {string} code
   * @param {string} label shown in the confirmation toast
   * @param {() => string|void} run returns a message to show instead of `label`
   */
  register(code, label, run) {
    this.codes.set(String(code).toLowerCase(), { label, run });
  }

  _handleKey(e) {
    if (!this.enabled) return;
    // Never while a menu or the chat box owns the keyboard, and never as part
    // of a browser shortcut.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (this.input?.textCaptured) return;
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (!/^Key[A-Z]$/.test(e.code)) return;

    const now = performance.now() / 1000;
    if (now - this._last > IDLE_RESET) this._buf = '';
    this._last = now;

    this._buf = (this._buf + e.code.slice(3).toLowerCase()).slice(-MAX_CODE);

    for (const [code, entry] of this.codes) {
      if (!this._buf.endsWith(code)) continue;
      this._buf = '';
      let msg;
      try {
        msg = entry.run();
      } catch (err) {
        console.error(`[AdminCheats] "${code}" failed:`, err);
        this._notify(`Cheat "${code}" failed — see console`, 'warn');
        return;
      }
      this._notify(msg || entry.label, 'good');
      this.bus?.emit('cheat:used', { code, label: entry.label });
      return;
    }
  }

  _notify(text, tone = 'info') {
    this.bus?.emit('hud:notify', { text, tone });
  }

  /* ------------------------------------------------------------------ */
  /* Actions                                                             */
  /* ------------------------------------------------------------------ */

  _resupply() {
    if (!this.loadout?.resupplyAll) return 'Resupply unavailable';
    const res = this.loadout.resupplyAll();
    const items = Object.entries(res.items ?? {});
    if (!items.length) return `All ${res.weapons} weapons already loaded`;
    const detail = items.map(([id, n]) => `${n} ${id.replace(/_/g, ' ')}`).join(', ');
    return `Resupplied — ${detail}`;
  }

  _heal() {
    const p = this.player;
    if (!p) return 'No player';
    if (typeof p.heal === 'function') p.heal(p.maxHealth ?? 100);
    else if (Number.isFinite(p.health)) p.health = p.maxHealth ?? 100;
    if (p.stamina && Number.isFinite(p.stamina.value)) p.stamina.value = p.stamina.max ?? 100;
    this.bus?.emit('player:healed', { full: true });
    return 'Health and stamina restored';
  }

  _credits(n) {
    if (!this.economy?.add) return 'No economy';
    this.economy.add(n, 'cheat');
    return `+${n} credits`;
  }

  /**
   * The way out of anywhere: put the player back on Aether Station.
   *
   * ── Why this is not `K`, and does not duplicate it ────────────────────────
   *
   * `UnstuckSystem` is the rescue for being wedged in geometry and it works
   * WITHIN a world - its last rung is that world's own spawn. It cannot help a
   * player who is not stuck at all but simply lost, several hundred metres into
   * a maze that regenerates its layout on every entry, with the only way out
   * being a gateway they cannot find. That is what this is for, and the maze is
   * the world that makes it necessary.
   *
   * ── Why it activates rather than entering a gateway ──────────────────────
   *
   * `portals.enterById` would give the warp and the wipe, but it can only use a
   * gateway the CURRENT world publishes and only from within its aperture -
   * neither of which a lost player has. Activation is world-agnostic and
   * position-independent, which is the entire requirement. It builds the
   * station first if the resident cap has evicted it, and drops the player at
   * that world's own spawn.
   *
   * ── Not awaited, deliberately ────────────────────────────────────────────
   *
   * `run()` is called synchronously by `_handleKey` so it can show a toast, and
   * a station build can take seconds. Returning the message immediately tells
   * the player their keystroke registered - the alternative is a code that
   * appears to do nothing for several seconds, which is a code people type
   * again. A failure is reported through the same toast channel rather than
   * being swallowed.
   *
   * Aborts any crossing still in flight first: `Portals.enter` owns the
   * player's input for the length of a transition, and a `reset` typed by
   * someone stuck mid-crossing must not leave that owner behind.
   */
  _toStation() {
    const wm = this.worldManager;
    if (!wm?.activate) return 'Cannot reach the station from here';

    this.portals?.abortTransition?.();

    if (wm.active?.id === 'station') {
      this.bus?.emit('player:rescue', { reason: 'cheat:reset' });
      return 'Already on Aether Station';
    }

    Promise.resolve(wm.activate('station')).then(
      () => this._notify('Returned to Aether Station', 'good'),
      (err) => {
        console.error('[AdminCheats] "reset" could not reach the station:', err);
        this._notify('Could not reach the station — see console', 'warn');
      }
    );
    return 'Returning to Aether Station…';
  }

  dispose() {
    if (typeof window !== 'undefined') window.removeEventListener('keydown', this._onKey);
    this.codes.clear();
  }
}

export default AdminCheats;
