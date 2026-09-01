/**
 * The on-screen control set, and the one function that performs it.
 *
 * ── The rule the whole touch layer is built on ────────────────────────────
 *
 * **A touch control reaches the game through the same path a key or a mouse
 * button does.** No row here calls into a subsystem. A button that called
 * `mounts.summon()` directly would work on the day it was written and diverge
 * from what the keyboard does the first time either side changed - and the
 * player would then have two different games depending on what they touched it
 * with.
 *
 * ── Why a synthesised KeyboardEvent, and not `Input._keys.add()` ──────────
 *
 * The game reads keys through TWO channels. `Input` has its own `window`
 * listener, which feeds `pressed()`, `held()` and the movement axes. And nine
 * other modules - `HelpMenu`, `MountWheel`, `MazeMap`, `QuestBoard`,
 * `InventoryUI`, `MarketplaceUI`, `KeybindMenu`, `Unstuck`, `MinigameUI` -
 * bind their OWN capture-phase `keydown` on `window`, because `Input`
 * deliberately stops reporting while they are open and `pressed()` would never
 * see the key that closes them.
 *
 * A button that poked `Input`'s private state would satisfy the first channel
 * and be invisible to the second: M would open the mount wheel and then be
 * unable to close it, I would open the inventory and trap the player in it.
 * One `KeyboardEvent` dispatched on `window` feeds both, and feeds them through
 * the same code a physical key does - which is also the only version of this a
 * gate can honestly measure.
 *
 * ── Why rows name an ACTION rather than a key ─────────────────────────────
 *
 * `Input`'s rebinding works by redirecting a shipped code to the player's
 * choice, and `codeFor(action)` is the published way to ask what a verb landed
 * on. Rows that name an action therefore follow a rebind for free. Rows that
 * name a literal `code` are the verbs that were never rebindable in the first
 * place - inventory, marketplace, quest board, unstuck, airbrake, the weapon
 * digits - and each of those literals is checked against the rest of `src/` by
 * `touch-controls.test.mjs`, so a button cannot advertise a key nothing
 * answers.
 */

/** The four verbs the virtual stick covers, so no button duplicates them. */
export const STICK_ACTIONS = ['forward', 'back', 'left', 'right'];

/**
 * @typedef {object} TouchAction
 * @property {string} id
 * @property {string} label shown on the button
 * @property {string} [glyph] short symbol for the compact primary buttons
 * @property {'hold'|'tap'|'toggle'} kind
 * @property {'primary'|'left'|'tray'} where
 * @property {string} [action] a `BINDABLE` action; resolved through `codeFor`
 * @property {string} [code] a literal key code, for verbs that never were bindable
 * @property {'fire'|'aim'} [button] a mouse button flag rather than a key
 * @property {'pause'} [special] handled by the dispatcher itself
 * @property {string} [hint] tray-only caption
 */

/**
 * Every control, in the order the layer lays them out.
 *
 * ── Placement ────────────────────────────────────────────────────────────
 *
 * `primary` and `left` are always on screen; `tray` is one tap away. The split
 * is not cosmetic: a tray is fine for "open the marketplace" and fatal for
 * "jump", so every verb a player needs *in the second they need it* is out.
 *
 * ── Holds, taps and toggles ──────────────────────────────────────────────
 *
 * Sprint and aim are TOGGLES here and holds on the keyboard, because a thumb
 * that must stay down cannot also be on the stick. Crouch is deliberately NOT
 * a toggle even though the same argument would apply: five systems read it as a
 * momentary action - dive, roll, let go of a wall, swim down, fly down - so a
 * latched crouch is a dive that never ends and a wall that cannot be held.
 * `Input`'s own crouch docblock records that experiment and its result.
 */
export const TOUCH_ACTIONS = [
  /* ── Always on screen, right thumb ── */
  { id: 'fire', label: 'Fire', glyph: '◉', kind: 'hold', where: 'primary', button: 'fire' },
  { id: 'aim', label: 'Aim', glyph: '⊕', kind: 'toggle', where: 'primary', button: 'aim' },
  { id: 'jump', label: 'Jump', glyph: '▲', kind: 'hold', where: 'primary', action: 'jump' },
  { id: 'crouch', label: 'Crouch', glyph: '▼', kind: 'hold', where: 'primary', action: 'crouch' },
  { id: 'interact', label: 'Use', glyph: 'E', kind: 'tap', where: 'primary', action: 'interact' },
  { id: 'reload', label: 'Reload', glyph: '⟳', kind: 'tap', where: 'primary', action: 'reload' },

  /* ── Always on screen, left thumb and the corner ── */
  { id: 'sprint', label: 'Sprint', glyph: '»', kind: 'toggle', where: 'left', action: 'sprint' },
  /* The only way into the pause hub on a device with no Escape key - and it has
   * to stand the player DOWN rather than just show the card, because standing
   * down is what puts the `standby` block back. See the dispatcher. */
  { id: 'pause', label: 'Menu', glyph: '≡', kind: 'tap', where: 'left', special: 'pause' },

  /* ── One tap away ── */
  { id: 'weapon-1', label: 'Machine gun', kind: 'tap', where: 'tray', code: 'Digit1' },
  { id: 'weapon-2', label: 'Ember caster', kind: 'tap', where: 'tray', code: 'Digit2' },
  { id: 'weapon-3', label: 'Recurve bow', kind: 'tap', where: 'tray', code: 'Digit3' },
  { id: 'weapon-4', label: 'Sword', kind: 'tap', where: 'tray', code: 'Digit4' },
  { id: 'inventory', label: 'Inventory', kind: 'tap', where: 'tray', code: 'KeyI' },
  { id: 'market', label: 'Marketplace', kind: 'tap', where: 'tray', code: 'KeyB', hint: 'Near a vendor' },
  { id: 'quests', label: 'Quest board', kind: 'tap', where: 'tray', code: 'KeyJ' },
  { id: 'chat', label: 'Comms', kind: 'tap', where: 'tray', action: 'chat' },
  /* One row, two owners, exactly as the binding is: the maze's map where mounts
   * are forbidden, the mount wheel everywhere else. `mapActionOwner` decides,
   * and it decides for the key - so a touch button that sent anything other
   * than the key would have to duplicate that decision. */
  { id: 'map', label: 'Map / mounts', kind: 'tap', where: 'tray', action: 'map', hint: 'Then drag to aim' },
  { id: 'dismount', label: 'Dismount / board', kind: 'tap', where: 'tray', action: 'dismount' },
  { id: 'camera', label: 'First / third person', kind: 'tap', where: 'tray', action: 'camera' },
  { id: 'transit', label: 'Transit drive', kind: 'tap', where: 'tray', action: 'transit', hint: 'Ship only' },
  { id: 'airbrake', label: 'Airbrake', kind: 'hold', where: 'tray', code: 'KeyX', hint: 'Ship only' },
  /* `action` now, not `code: 'KeyK'`. The rescue is a real `BINDABLE` row -
   * `UnstuckSystem` used to hard-code the literal, which is why it never
   * appeared in the rebind panel - so this button follows a rebind like every
   * other verb here instead of sending a key the player may have moved. */
  { id: 'unstuck', label: 'Unstuck', kind: 'tap', where: 'tray', action: 'unstuck' },
  { id: 'map-out', label: 'Minimap out', kind: 'tap', where: 'tray', action: 'mapOut' },
  { id: 'map-in', label: 'Minimap in', kind: 'tap', where: 'tray', action: 'mapIn' },
  /* A HOLD, and the table's only reason to support one in the tray: the spec
   * requires a player four kilometres into the maze to be able to leave from
   * anywhere, and requires that the control cannot be fumbled mid-run. A tap
   * would be exactly the fumble it forbids. */
  { id: 'abandon', label: 'Leave the maze', kind: 'hold', where: 'tray', action: 'abandon', hint: 'Hold' },
  { id: 'help', label: 'All controls', kind: 'tap', where: 'tray', code: 'F1' },
];

/**
 * The key a row will actually send, after rebinding.
 *
 * @param {TouchAction} row
 * @param {{codeFor?: (a:string)=>string|null}} input
 * @returns {string|null} null for rows that are not keys at all
 */
export function touchCode(row, input) {
  if (!row) return null;
  if (row.action) return input?.codeFor?.(row.action) ?? null;
  return row.code ?? null;
}

/**
 * Perform a row.
 *
 * @param {TouchAction} row
 * @param {boolean} down true on press, false on release
 * @param {{input: any, view?: any}} ctx `view` is the window to dispatch into;
 *   injected so a gate can watch the events rather than infer them.
 */
export function sendTouchAction(row, down, { input, view = globalThis.window } = {}) {
  if (!row) return;

  if (row.button) {
    input?.setPointerButton?.(row.button, down);
    return;
  }

  if (row.special === 'pause') {
    /* Stand the player down, rather than showing the card.
     *
     * `exitLock()` is what emits `input:lockchange`, which is what puts
     * `standby` back into `gameplayUiBlocks` - i.e. what actually stops the
     * world simulating. A button that only raised the overlay would recreate,
     * from the other end, the precise defect this phase exists to close. */
    if (down) input?.exitLock?.();
    return;
  }

  const code = touchCode(row, input);
  if (!code || !view?.dispatchEvent) return;

  /* `bubbles: true` matters. Almost every listener in the game is registered in
   * the CAPTURE phase on `window`; a non-bubbling event dispatched at `window`
   * still reaches them, but the panels that listen on their own elements would
   * never see it, and the flag costs nothing. */
  const fire = (type) => {
    view.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true, cancelable: true }));
  };

  if (row.kind === 'tap') {
    // Both halves on the press. A tap that only sent keydown would leave the
    // key stuck down in `Input._keys` for the rest of the session - the player
    // would be permanently reloading, or permanently holding the quest board
    // open. The release is then a no-op, or the key goes down twice.
    if (!down) return;
    fire('keydown');
    fire('keyup');
    return;
  }

  fire(down ? 'keydown' : 'keyup');
}
