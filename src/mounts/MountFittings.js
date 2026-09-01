import { DIGIT_ROW_CODES } from '../core/Input.js';

/**
 * MID-RIDE FITTING SWITCHES: hold one key, and the digit row becomes the
 * switches for the fittings the ridden mount actually owns.
 *
 * ── The problem this exists for ───────────────────────────────────────────
 *
 * The fitting badges in the HUD's mount panel are real `<button>`s and they
 * toggle correctly - but a player riding a mount cannot reach them. During
 * play the pointer is LOCKED, so the mouse steers the camera and there is no
 * cursor to click with; and the only key that frees the cursor is Escape,
 * which opens the pause hub and takes the whole screen. The control was
 * present, correct, and unreachable: the slow path (Esc -> Customise mount)
 * worked, and it costs the player the ride.
 *
 * So the gesture is a HOLD, not a mode: while the fittings key is down the
 * badges are numbered and the digits switch them; let go and the digits are
 * weapon slots again. Nothing is left running, pointer lock is never broken,
 * and the reinterpretation cannot outlive the finger holding it down. It is
 * the same shape as the mount wheel on M - hold, choose, release - which is
 * the one radial gesture this game has already taught.
 *
 * ── Why the key is G, and why it could not be a modifier ──────────────────
 *
 * `Shift` was the obvious first thought and is unusable: `ShiftLeft` is
 * Sprint (see BINDABLE in core/Input.js), so a sprinting player switching
 * weapons would fire this on every single weapon change - the two gestures
 * are physically identical.
 *
 * `Ctrl`, `Alt` and `Meta` are unusable for a harder reason: `Input`'s key
 * handler DROPS every event carrying one of them, deliberately and with a
 * comment saying why. An earlier build carved out an exception so Ctrl could
 * be a second crouch, which let the game see Ctrl+W while the browser also saw
 * it - and outside fullscreen the browser wins by closing the tab. Those three
 * are never coming back, so a binding on one would simply never fire.
 * `ControlLeft`/`ControlRight` are in RESERVED_CODES for exactly that.
 *
 * That leaves an ordinary letter, and `KeyG` is the one: it is free, it sits
 * directly right of `KeyF` (Dismount) so the whole mount-context group is
 * under one index finger without leaving WASD, and "G for gear" is the
 * mnemonic the fittings already read as. `KeyQ` is nominally free but is
 * spoken for - `Piloting.TRANSIT_KEY` records it as the reserved half of the
 * unbuilt lateral-thruster pair - and `J`, `K`, `N`, `X` are taken by the
 * quest board, unstuck, records and the airbrake despite not being BINDABLE
 * rows. Being rebindable, `KeyG` is a default rather than a decree.
 *
 * ── Where the numbering comes from ────────────────────────────────────────
 *
 * {@link ownedFittings} is the ONE source. The HUD calls it to draw the
 * badges and this class calls it to resolve a digit, so the number on a badge
 * and the number the key answers to are the same number by construction
 * rather than by two lists being kept in step. The filter is what makes that
 * matter: a mount owning only `power` and `shield` has them as 1 and 2, not
 * 1 and 3, because the third badge is not drawn and a gap the player cannot
 * see is a gap they cannot count.
 */

/**
 * The order fittings are drawn in, and therefore the order they are numbered
 * in. Matches the loop `HUD._setMountPowers` has always used; it is exported
 * so that loop can read this rather than repeat it.
 */
export const FITTING_ORDER = ['power', 'strength', 'shield', 'fire'];

/**
 * One owned fitting, ready to draw or to switch.
 * @typedef {{key: string, tier: number, on: boolean, digit: number, code: string}} Fitting
 */

/**
 * The mount's owned fittings, in badge order, numbered from 1.
 *
 * OWNERSHIP decides membership and the switch decides only appearance, which
 * is the same rule the badges have always drawn by: a fitting switched off is
 * dimmed and struck, never removed, because the player still owns the tier and
 * a badge that vanishes reads as a refund. It also keeps its number, so
 * switching one off never renumbers the ones beside it under the player's
 * finger.
 *
 * `isEnabled` is read the way `MountManager.isPowerEnabled` answers it -
 * anything but an explicit `false` is on - so a manager too old to have the
 * method, or a test double without it, reads as fully enabled rather than
 * fully off. Same rule as `MountMenuLogic.fittingSwitch`.
 *
 * Tiers are small integers; a missing, zero or unparseable tier is not owned
 * and draws nothing rather than a "0".
 *
 * @param {Record<string, number>|null|undefined} powers `MountManager.getPowers(id)`
 * @param {(key: string) => boolean} [isEnabled] the switch, per fitting
 * @returns {Fitting[]} at most `FITTING_ORDER.length` entries
 */
export function ownedFittings(powers, isEnabled) {
  const out = [];
  if (!powers) return out;
  for (const key of FITTING_ORDER) {
    const tier = Math.floor(Number(powers[key]) || 0);
    if (tier <= 0) continue;
    const digit = out.length + 1;
    out.push({
      key,
      tier,
      on: isEnabled ? isEnabled(key) !== false : true,
      digit,
      code: DIGIT_ROW_CODES[digit - 1] ?? '',
    });
  }
  return out;
}

/**
 * The fitting a digit key means, or null.
 *
 * Null covers both "not a digit at all" and "a digit past the end of the
 * list". The second is deliberate and is NOT a fall-through to weapon
 * switching: while the badges are numbered on screen the whole digit row is
 * claimed, so tapping 3 on a mount with two fittings does nothing rather than
 * quietly drawing the bow.
 *
 * @param {Fitting[]} fittings from {@link ownedFittings}
 * @param {string} code a `KeyboardEvent.code`
 * @returns {Fitting|null}
 */
export function fittingForCode(fittings, code) {
  const i = DIGIT_ROW_CODES.indexOf(code);
  if (i < 0) return null;
  return fittings[i] ?? null;
}

/**
 * Should holding the key claim the digit row at all?
 *
 * ── The unmounted case, decided ───────────────────────────────────────────
 *
 * The claim applies ONLY when there is something to toggle - mounted, not
 * captured by a text field or an open panel, and owning at least one fitting.
 * Holding the key on foot does nothing at all, and a digit pressed under it
 * still switches weapons exactly as it always did.
 *
 * The alternative - claim the digits whenever the key is held - was rejected
 * because the badges ARE the affordance. There is nothing else on screen that
 * says the digits have been reinterpreted, so with no badges to number the
 * player would be holding a key that silently breaks weapon switching with no
 * way to tell why. A player resting a finger on G, or one who rebound
 * something and forgot, would find their guns dead and nothing to blame.
 * "No badges, no claim" makes the rule visible: the digits are claimed exactly
 * when the numbers are on screen.
 *
 * @param {{textCaptured?: boolean, mountId?: string|null, fittings?: Fitting[]}} state
 * @returns {boolean}
 */
export function shouldClaimDigits({ textCaptured, mountId, fittings } = {}) {
  if (textCaptured === true) return false;
  if (!mountId) return false;
  return Array.isArray(fittings) && fittings.length > 0;
}

/**
 * The hold-to-switch gesture, wired to the window.
 *
 * Owns its own capture-phase `keydown`/`keyup` listeners rather than polling
 * `input.pressed`, for the reason `Input.codeFor` is documented with: the
 * panels that hold their own listeners (the maze map, the mount wheel) do it
 * so they keep working when `Input` has stopped reporting, and they resolve
 * the BOUND code through `codeFor` so a rebind moves them too. This is a
 * third one of those, and it also has to see a digit press that `Input` has
 * been told to stop reporting - see the note on the claim below.
 *
 * Publishes `mount:fittings` `{ armed, mountId }` when the gesture starts and
 * ends. The payload deliberately does NOT carry the list: the HUD recomputes
 * it from {@link ownedFittings} over the same power bag, so there is no
 * snapshot to go stale and no second copy to disagree with the first.
 */
export class MountFittingKeys {
  /**
   * @param {{bus?: any, input?: any, mounts?: any, target?: any}} ctx
   *   `target` is the event source, defaulting to `window`; tests pass their
   *   own, and a Node import with no window simply binds nothing.
   */
  constructor({ bus, input, mounts, target } = {}) {
    this.bus = bus ?? null;
    this.input = input ?? null;
    this.mounts = mounts ?? null;

    /** True between the key going down on a mount with fittings and it coming up. */
    this._armed = false;
    /** The mount the current hold belongs to, so a toggle cannot land on another. */
    this._mountId = null;

    this._onKey = (e) => this._key(e);
    this._onBlur = () => this.disarm();

    const t = target ?? (typeof window !== 'undefined' ? window : null);
    this._target = t;
    if (t) {
      t.addEventListener('keydown', this._onKey, true);
      t.addEventListener('keyup', this._onKey, true);
      /* A key held when the window loses focus never delivers its keyup, so
       * without this the claim would outlive the gesture and the digits would
       * still be dead when the player came back. `Input` clears `_keys` on the
       * same event for the same reason. */
      t.addEventListener('blur', this._onBlur);
    }

    this._offs = [];
    /* Dismounting mid-hold leaves a claim with nothing behind it: no badges to
     * number and no fittings to switch, so the digits would be inert until the
     * key came up. Cheaper to answer the event than to make every digit press
     * re-derive whether the hold is still meaningful. */
    for (const ev of ['mount:dismounted', 'mount:dismissed']) {
      const off = bus?.on?.(ev, () => this.disarm());
      if (off) this._offs.push(off);
    }
  }

  /** True while the badges are numbered and the digits belong to the fittings. */
  get armed() {
    return this._armed;
  }

  /** The bound key for this gesture, resolved through any rebind. */
  get code() {
    return this.input?.codeFor?.('fittings') ?? 'KeyG';
  }

  /**
   * The fittings the numbers currently refer to. Recomputed on every call, so
   * a fitting bought or switched mid-hold cannot leave it out of date.
   * @returns {{mountId: string|null, fittings: Fitting[]}}
   */
  snapshot() {
    const empty = { mountId: null, fittings: [] };
    if (this.input?.textCaptured === true) return empty;
    const id = this.mounts?.active?.id ?? null;
    if (!id) return empty;
    const bag = this.mounts?.getPowers?.(id) ?? null;
    if (!bag) return empty;
    return {
      mountId: id,
      fittings: ownedFittings(bag, (k) => this.mounts?.isPowerEnabled?.(id, k) !== false),
    };
  }

  /**
   * One handler for both edges, like `MountWheel._key`.
   * @param {KeyboardEvent|{type:string, code:string, repeat?:boolean, ctrlKey?:boolean, metaKey?:boolean, altKey?:boolean, preventDefault?:Function}} e
   */
  _key(e) {
    /* The same drop `Input.onKey` makes. Ctrl+G is the browser's (find next),
     * and a gesture that fired under it would be a gesture the player cannot
     * see the effect of because the browser is also acting. */
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.code === this.code) {
      if (e.type === 'keyup') { this.disarm(); return; }
      // Auto-repeat is not a fresh press. Re-arming on every repeat would
      // re-emit the event sixty times a second for a key that never moved.
      if (e.repeat) return;
      this.arm();
      return;
    }

    if (!this._armed || e.type !== 'keydown' || e.repeat) return;
    const i = DIGIT_ROW_CODES.indexOf(e.code);
    if (i < 0) return;
    /* Swallow the browser's own meaning of the key. `Input` still records the
     * press - it is `Input.pressed` that answers false for a claimed digit,
     * which is what keeps the weapon from switching - so nothing here needs to
     * fight the event's propagation. */
    e.preventDefault?.();
    const { mountId, fittings } = this.snapshot();
    // A hold that started on one mount must not toggle another's fittings.
    if (!mountId || mountId !== this._mountId) return;
    const f = fittingForCode(fittings, e.code);
    if (!f) return;
    this.mounts?.setPowerEnabled?.(mountId, f.key, !f.on);
  }

  /**
   * Start the gesture, if there is anything to start it for.
   *
   * Claiming the digit row is what stops `Loadout` switching weapons on the
   * same press: `Input.claimDigits(true)` makes `Input.pressed('Digit1')`
   * answer false for as long as the hold lasts, which covers every consumer of
   * the digit row at once rather than only the one we happened to think of.
   */
  arm() {
    if (this._armed) return false;
    const { mountId, fittings } = this.snapshot();
    if (!shouldClaimDigits({ textCaptured: this.input?.textCaptured, mountId, fittings })) {
      return false;
    }
    this._armed = true;
    this._mountId = mountId;
    this.input?.claimDigits?.(true);
    this.bus?.emit?.('mount:fittings', { armed: true, mountId });
    return true;
  }

  /** End the gesture and give the digit row back. Safe to call when not armed. */
  disarm() {
    if (!this._armed) return false;
    const mountId = this._mountId;
    this._armed = false;
    this._mountId = null;
    this.input?.claimDigits?.(false);
    this.bus?.emit?.('mount:fittings', { armed: false, mountId });
    return true;
  }

  dispose() {
    this.disarm();
    const t = this._target;
    if (t) {
      t.removeEventListener('keydown', this._onKey, true);
      t.removeEventListener('keyup', this._onKey, true);
      t.removeEventListener('blur', this._onBlur);
    }
    for (const off of this._offs) { try { off(); } catch { /* already gone */ } }
    this._offs.length = 0;
  }
}

export default MountFittingKeys;
