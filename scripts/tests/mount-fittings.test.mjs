import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Input, BINDABLE, RESERVED_CODES, DIGIT_ROW_CODES } from '../../src/core/Input.js';
import {
  FITTING_ORDER, MountFittingKeys, fittingForCode, ownedFittings, shouldClaimDigits,
} from '../../src/mounts/MountFittings.js';
import { HUD } from '../../src/ui/HUD.js';
import { GROUPS as HELP_GROUPS } from '../../src/ui/HelpMenu.js';

/**
 * MID-RIDE FITTING SWITCHES: hold G, and 1-4 switch the ridden mount's
 * fittings instead of the weapon.
 *
 * The defect this closes is not a broken control - the badges in the mount
 * panel toggle perfectly. It is that a player cannot REACH them: during play
 * the pointer is locked, so there is no cursor to click with, and the only key
 * that frees one opens the pause hub over the whole screen. The badge was real
 * and unreachable.
 *
 * Two things are worth being sure about and neither is visible in a
 * screenshot:
 *
 *   1. THE NUMBERING. Badges are drawn from `['power','strength','shield',
 *      'fire']` FILTERED TO OWNED, so a mount owning only `power` and `shield`
 *      numbers them 1 and 2, not 1 and 3. If the key derived its mapping
 *      separately the two would agree on every mount that owns all four and
 *      disagree on every other one - which is the failure that ships, because
 *      the developer testing it owns everything.
 *   2. THE WEAPON MUST NOT SWITCH. `Loadout.update` runs
 *      `if (input.pressed(SLOT_KEYS[i])) this.select(i)` every frame, so
 *      without a claim the same press that toggles a fitting also draws a
 *      different gun. That is the regression this file exists for, and it is
 *      driven below through the REAL `Input.prototype.pressed` against a
 *      transcription of that exact loop.
 *
 * Nothing here needs a DOM except the two surface checks at the end, which run
 * `HUD.prototype._patchBootControls` against a stub element - a real assertion
 * about the rows rather than a grep of the source that would pass on a
 * commented-out list.
 */

/* ============================================================ numbering == */

test('ownedFittings numbers only what the mount owns, in badge order', () => {
  const all = ownedFittings({ power: 2, strength: 1, shield: 3, fire: 1 });
  assert.deepEqual(all.map((f) => f.key), FITTING_ORDER);
  assert.deepEqual(all.map((f) => f.digit), [1, 2, 3, 4]);
  assert.deepEqual(all.map((f) => f.code), DIGIT_ROW_CODES);
});

test('THE GAPPED CASE: power + shield are 1 and 2, never 1 and 3', () => {
  /* The whole reason the mapping is derived rather than indexed. `shield` is
   * third in `FITTING_ORDER`; the badge beside it on screen says 2, so the key
   * that switches it must be 2. */
  const list = ownedFittings({ power: 1, shield: 4 });
  assert.deepEqual(list.map((f) => f.key), ['power', 'shield']);
  assert.deepEqual(list.map((f) => f.digit), [1, 2]);
  assert.equal(fittingForCode(list, 'Digit2')?.key, 'shield');
  assert.equal(fittingForCode(list, 'Digit3'), null, 'a third digit has nothing to point at');
});

test('a zero, missing or unparseable tier is not owned and takes no number', () => {
  assert.deepEqual(ownedFittings({}).length, 0);
  assert.deepEqual(ownedFittings(null).length, 0);
  assert.deepEqual(ownedFittings({ power: 0, strength: null, shield: 'x' }).length, 0);
  // A fractional tier floors, like every other reader of the power bag.
  assert.deepEqual(ownedFittings({ fire: 2.7 }).map((f) => f.tier), [2]);
});

test('a switched-off fitting keeps its place and its number', () => {
  /* Membership is OWNERSHIP; the switch only changes how the badge looks. If
   * "off" removed the badge, switching one off would renumber the ones beside
   * it under the player's finger mid-hold. */
  const off = new Set(['strength']);
  const list = ownedFittings({ power: 1, strength: 1, shield: 1 }, (k) => !off.has(k));
  assert.deepEqual(list.map((f) => f.digit), [1, 2, 3]);
  assert.deepEqual(list.map((f) => f.on), [true, false, true]);
});

test('a manager with no isPowerEnabled reads every fitting as ON', () => {
  // Same rule `MountMenuLogic.fittingSwitch` and the badges already follow:
  // anything but an explicit false is on, so an old stub is not all-struck.
  assert.deepEqual(ownedFittings({ power: 1, fire: 1 }).map((f) => f.on), [true, true]);
  assert.deepEqual(
    ownedFittings({ power: 1 }, () => undefined).map((f) => f.on), [true],
  );
});

/* ================================================================ claim == */

test('the claim needs a mount, a fitting, and no text field', () => {
  const fittings = ownedFittings({ power: 1 });
  assert.equal(shouldClaimDigits({ mountId: 'car', fittings }), true);
  assert.equal(shouldClaimDigits({ mountId: null, fittings }), false, 'on foot');
  assert.equal(shouldClaimDigits({ mountId: 'car', fittings: [] }), false, 'nothing owned');
  assert.equal(
    shouldClaimDigits({ mountId: 'car', fittings, textCaptured: true }), false,
    'chat or an open panel owns the keyboard',
  );
});

/* ============================================================== gesture == */

/** A manager over plain records - the three methods the gesture actually calls. */
function stubMounts({ id = 'car', powers = { power: 2, shield: 1 }, off = new Set() } = {}) {
  const calls = [];
  return {
    calls,
    active: id ? { id } : null,
    getPowers: () => ({ ...powers }),
    isPowerEnabled: (m, k) => !(m === id && off.has(k)),
    setPowerEnabled: (m, k, on) => {
      calls.push({ mountId: m, power: k, on });
      if (on === false) off.add(k); else off.delete(k);
      return true;
    },
  };
}

/**
 * An `Input` that is real where it matters: `pressed` and `claimDigits` are
 * the prototype's own, over the same two fields the class keeps them in. A
 * hand-written double would be a double of the very method under test.
 */
function stubInput({ textCaptured = false } = {}) {
  const i = Object.create(Input.prototype);
  // `setBinding` -> `_rebuildBinds` -> `_resetAxes` writes the axis snapshot
  // and announces on the bus, so both have to exist for the rebind test.
  i.state = {};
  i.bus = null;
  i._pressedThisFrame = new Set();
  i._keys = new Set();
  i._binds = new Map();
  i._bindsInverse = new Map();
  i._digitsClaimed = false;
  i._textCaptured = textCaptured;
  return i;
}

/** A window that only remembers its listeners, so the gesture can be driven. */
function stubTarget() {
  const l = { keydown: [], keyup: [], blur: [] };
  return {
    listeners: l,
    addEventListener: (t, fn) => l[t]?.push(fn),
    removeEventListener: (t, fn) => {
      const a = l[t]; const i = a?.indexOf(fn) ?? -1; if (i >= 0) a.splice(i, 1);
    },
    fire(type, ev) { for (const fn of [...(l[type] ?? [])]) fn({ type, ...ev }); },
  };
}

function harness(opts = {}) {
  const emitted = [];
  const bus = { on: () => () => {}, emit: (n, p) => emitted.push([n, p]) };
  const mounts = stubMounts(opts.mounts);
  const input = stubInput(opts.input);
  const target = stubTarget();
  const keys = new MountFittingKeys({ bus, input, mounts, target });
  const down = (code, extra) => target.fire('keydown', { code, ...extra });
  const up = (code) => target.fire('keyup', { code });
  return { keys, input, mounts, bus, target, emitted, down, up };
}

/** `Loadout.update`'s selection loop, transcribed, over the real `pressed`. */
function loadoutSelection(input) {
  const SLOT_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4'];
  let selected = null;
  for (let i = 0; i < SLOT_KEYS.length; i++) {
    if (input.pressed(SLOT_KEYS[i])) selected = i;
  }
  return selected;
}

test('holding the key and tapping a digit toggles exactly that fitting', () => {
  const h = harness({ mounts: { powers: { power: 2, strength: 1, shield: 1 } } });
  h.down('KeyG');
  assert.equal(h.keys.armed, true);
  h.down('Digit2');
  assert.deepEqual(h.mounts.calls, [{ mountId: 'car', power: 'strength', on: false }]);
  // And back on with the same key: the switch is a toggle, not a one-way trip.
  h.down('Digit2');
  assert.deepEqual(h.mounts.calls[1], { mountId: 'car', power: 'strength', on: true });
});

test('the gapped mount toggles the fitting the badge says, not the third stat', () => {
  const h = harness({ mounts: { powers: { power: 1, shield: 3 } } });
  h.down('KeyG');
  h.down('Digit2');
  assert.deepEqual(h.mounts.calls, [{ mountId: 'car', power: 'shield', on: false }]);
  // Digit3 has no badge, so it does nothing at all - it does not fall through
  // to the third entry of FITTING_ORDER, and it does not draw a weapon either.
  h.down('Digit3');
  assert.equal(h.mounts.calls.length, 1);
});

test('THE REGRESSION: the same press does not change the selected weapon', () => {
  const h = harness({ mounts: { powers: { power: 2, shield: 1 } } });

  // Baseline: with no key held, Digit1 is a weapon slot and nothing else.
  h.input._pressedThisFrame.add('Digit1');
  assert.equal(loadoutSelection(h.input), 0, 'the digit row is broken before we touch it');
  assert.equal(h.mounts.calls.length, 0);
  h.input._pressedThisFrame.clear();

  // Now the gesture. `Input` still records the press - the real handler does -
  // so this is the exact frame `Loadout.update` would have selected on.
  h.down('KeyG');
  h.down('Digit1');
  h.input._pressedThisFrame.add('Digit1');

  assert.deepEqual(h.mounts.calls, [{ mountId: 'car', power: 'power', on: false }]);
  assert.equal(loadoutSelection(h.input), null, 'the weapon switched under the fitting toggle');
  assert.equal(h.input.digitsClaimed, true);
});

test('releasing the key gives the digit row straight back', () => {
  const h = harness();
  h.down('KeyG');
  h.up('KeyG');
  assert.equal(h.keys.armed, false);
  assert.equal(h.input.digitsClaimed, false);
  h.input._pressedThisFrame.add('Digit3');
  assert.equal(loadoutSelection(h.input), 2, 'the digits did not come back');
  // And a digit after the release toggles nothing.
  h.down('Digit1');
  assert.equal(h.mounts.calls.length, 0);
});

test('losing window focus mid-hold releases the claim', () => {
  /* A key held when the window blurs never delivers its keyup, so without this
   * the digits would still be dead when the player came back. `Input` clears
   * `_keys` on the same event for the same reason. */
  const h = harness();
  h.down('KeyG');
  h.target.fire('blur', {});
  assert.equal(h.keys.armed, false);
  assert.equal(h.input.digitsClaimed, false);
});

test('auto-repeat while the key is held is not a fresh press', () => {
  const h = harness();
  h.down('KeyG');
  const before = h.emitted.length;
  h.down('KeyG', { repeat: true });
  assert.equal(h.emitted.length, before, 'a held key re-emitted the gesture');
  h.down('Digit1', { repeat: true });
  assert.equal(h.mounts.calls.length, 0, 'a repeating digit toggled the fitting again');
});

test('a modifier combination is dropped, exactly as Input drops it', () => {
  // Ctrl+G is the browser's find-next. `Input.onKey` returns on any modifier,
  // so a gesture that fired under one would be invisible to the rest of the game.
  const h = harness();
  h.down('KeyG', { ctrlKey: true });
  assert.equal(h.keys.armed, false);
  h.down('KeyG', { altKey: true });
  assert.equal(h.keys.armed, false);
});

/* ============================================== nothing to switch, quietly */

test('on foot the key does nothing and the digits still switch weapons', () => {
  const h = harness({ mounts: { id: null } });
  h.down('KeyG');
  assert.equal(h.keys.armed, false, 'armed with no mount');
  assert.equal(h.input.digitsClaimed, false);
  h.down('Digit1');
  assert.equal(h.mounts.calls.length, 0);
  h.input._pressedThisFrame.add('Digit1');
  assert.equal(loadoutSelection(h.input), 0, 'weapon switching broke on foot');
});

test('a mount owning no fittings does not claim the digits either', () => {
  const h = harness({ mounts: { powers: {} } });
  h.down('KeyG');
  assert.equal(h.keys.armed, false);
  h.input._pressedThisFrame.add('Digit2');
  assert.equal(loadoutSelection(h.input), 1);
});

test('a captured text field blocks the gesture entirely', () => {
  const h = harness({ input: { textCaptured: true } });
  h.down('KeyG');
  assert.equal(h.keys.armed, false);
  assert.equal(h.input.digitsClaimed, false);
});

test('text capture starting mid-hold stops the toggle', () => {
  const h = harness();
  h.down('KeyG');
  assert.equal(h.keys.armed, true);
  h.input._textCaptured = true;
  h.down('Digit1');
  assert.equal(h.mounts.calls.length, 0, 'a fitting toggled while chat had the keyboard');
});

test('a rebound fittings key is the one that arms', () => {
  const h = harness();
  h.input._binds.set('KeyG', 'KeyH');
  h.input._bindsInverse.set('KeyG', 'KeyH');
  assert.equal(h.keys.code, 'KeyH');
  h.down('KeyG');
  assert.equal(h.keys.armed, false, 'the shipped key still armed after a rebind');
  h.down('KeyH');
  assert.equal(h.keys.armed, true);
});

/* ============================================================== the bind == */

test('the fittings bind is present, rebindable, and in a rendered group', () => {
  const row = BINDABLE.find((d) => d.action === 'fittings');
  assert.ok(row, 'no `fittings` row in BINDABLE');
  assert.equal(row.code, 'KeyG');
  assert.ok(row.label, 'a row with no label draws a blank cap in the panel');
  /* `KeybindMenu._build` groups by `d.group` and creates a section for each
   * one it meets, so any group renders - but only these two are styled and
   * ordered, and a third would sort by whatever order BINDABLE happens to be
   * in. Actions is where every non-movement key already lives. */
  assert.equal(row.group, 'Actions');
  assert.ok(!RESERVED_CODES.includes(row.code), 'the bind points at a reserved key');
});

test('the fittings row reaches Esc -> Controls and can be moved', () => {
  const i = stubInput();
  const shown = i.bindings.find((d) => d.action === 'fittings');
  assert.ok(shown, 'the row never reaches the panel');
  assert.equal(shown.bound, 'KeyG');

  i._saveBinds = () => {};
  assert.equal(i.setBinding('KeyG', 'KeyH').ok, true);
  assert.equal(i.codeFor('fittings'), 'KeyH');
  assert.equal(i.bindings.find((d) => d.action === 'fittings').bound, 'KeyH');
  // And it cannot be parked on an escape hatch.
  assert.equal(i.setBinding('KeyG', 'Escape').ok, false);
});

test('KeyG collides with no other shipped bind', () => {
  const clash = BINDABLE.filter((d) => d.code === 'KeyG');
  assert.equal(clash.length, 1, `KeyG is claimed twice: ${clash.map((d) => d.action)}`);
});

test('DIGIT_ROW_CODES is the same four keys Loadout calls its weapon slots', () => {
  /* Two lists that must be identical, written out in two files. Read the other
   * one rather than trusting a comment: the claim only stops the weapon switch
   * if it covers exactly the codes the selection loop asks about. */
  const src = readFileSync(
    fileURLToPath(new URL('../../src/player/Loadout.js', import.meta.url)), 'utf8',
  );
  const m = src.match(/const SLOT_KEYS = (\[[^\]]*\]);/);
  assert.ok(m, 'SLOT_KEYS is no longer a literal array in Loadout.js');
  assert.deepEqual(JSON.parse(m[1].replace(/'/g, '"')), DIGIT_ROW_CODES);
});

/* ============================================== the badge, still a button */

/**
 * A `document` with just enough of an element for `HUD`'s `el()` helper.
 * Nothing here styles or lays anything out; the point is the button's handler.
 */
function withFakeDom(fn) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const make = (tag) => ({
    tag,
    className: '',
    textContent: '',
    type: '',
    attrs: {},
    children: [],
    handlers: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(t, h) { (this.handlers[t] ||= []).push(h); },
    appendChild(c) { this.children.push(c); return c; },
  });
  Object.defineProperty(globalThis, 'document', {
    value: { createElement: make }, configurable: true, writable: true,
  });
  try { return fn(make); } finally {
    if (saved) Object.defineProperty(globalThis, 'document', saved);
    else delete globalThis.document;
  }
}

/** Draw the badges the real way and hand back the elements. */
function badges({ powers, off = new Set(), armed = false }) {
  return withFakeDom((make) => {
    const pow = make('div');
    const h = Object.create(HUD.prototype);
    h.mountPow = pow;
    h._mountId = 'car';
    h._fittingsArmed = armed;
    h._mounts = {
      getPowers: () => ({ ...powers }),
      isPowerEnabled: (m, k) => !off.has(k),
      setPowerEnabled: (m, k, on) => { h._calls.push({ mountId: m, power: k, on }); },
    };
    h._calls = [];
    h._setMountPowers();
    return { pips: pow.children, calls: h._calls };
  });
}

test('THE CLICK SURVIVES: a badge is still a button that switches its fitting', () => {
  /* This gesture ADDS a route, it does not replace one. The click is the only
   * route on touch - no pointer lock, no keyboard - and the only one from
   * inside the pause hub, and it is what `touch-controls.test.mjs` excuses the
   * `fittings` verb from having a tray button for. */
  const { pips, calls } = badges({ powers: { power: 2, shield: 1 } });
  assert.equal(pips.length, 2);
  assert.equal(pips[0].tag, 'button');
  assert.equal(pips[0].type, 'button');
  assert.equal(pips[0].attrs['aria-pressed'], 'true');
  const prevented = [];
  pips[0].handlers.mousedown[0]({
    preventDefault: () => prevented.push('d'), stopPropagation: () => prevented.push('s'),
  });
  assert.deepEqual(calls, [{ mountId: 'car', power: 'power', on: false }]);
  // Both, as the weapon strip does: the pause card behind reads a bare press
  // as "resume".
  assert.deepEqual(prevented, ['d', 's']);
});

test('badges carry their digit only while the key is held', () => {
  const plain = badges({ powers: { power: 2, shield: 1 } }).pips.map((p) => p.textContent);
  assert.deepEqual(plain, ['PWR 2', 'SHD 1'], 'a digit leaked into the resting badge');

  const held = badges({ powers: { power: 2, shield: 1 }, armed: true }).pips;
  assert.deepEqual(held.map((p) => p.textContent), ['1·PWR 2', '2·SHD 1']);
  for (const p of held) assert.match(p.className, /\barmed\b/);
  // Same numbers the key resolves, on the same gapped mount.
  const list = ownedFittings({ power: 2, shield: 1 });
  assert.deepEqual(held.map((p) => p.textContent.slice(0, 1)), list.map((f) => String(f.digit)));
});

test('a switched-off badge is still dimmed and struck while armed', () => {
  const { pips } = badges({ powers: { power: 1, shield: 1 }, off: new Set(['shield']), armed: true });
  assert.match(pips[1].className, /\boff\b/, 'the off state was lost under the numbering');
  assert.match(pips[1].className, /\barmed\b/);
  assert.equal(pips[1].attrs['aria-pressed'], 'false');
  assert.match(pips[1].attrs.title ?? pips[1].title ?? '', /press 2/);
});

/* ====================================================== taught, or not == */

/**
 * There are three surfaces a player can read a control off, and only ONE of
 * them reads `BINDABLE`. The other two are hand-written lists, and the desktop
 * boot card carries a comment saying it had "fallen a long way behind - no
 * free-climbing, no parkour, none of the mounts or systems added since". These
 * three tests are the thing that tells the next person adding a keybind which
 * lists they have not touched yet.
 */

/** Run the real `_patchBootControls` against a stub element and read the rows. */
function bootChips(touchMode) {
  const list = { innerHTML: '' };
  const h = Object.create(HUD.prototype);
  h._bootPatched = false;
  h.root = { querySelector: (sel) => (sel === '.boot-controls' ? list : null) };
  h.input = { touchMode };
  h._patchBootControls();
  return [...list.innerHTML.matchAll(/<span><b>([^<]*)<\/b> ([^<]*)<\/span>/g)]
    .map((m) => [m[1], m[2]]);
}

test('the start-game card teaches the fittings key on desktop', () => {
  const chips = bootChips(false);
  assert.ok(chips.length > 10, 'the desktop chip list did not render');
  const row = chips.find(([k]) => k === 'G');
  assert.ok(row, `no G chip on the boot card: ${JSON.stringify(chips)}`);
  assert.match(row[1], /1-4/, 'the chip does not say where to look');
  // It belongs beside the other mount keys, not filed under the ship controls.
  const keys = chips.map(([k]) => k);
  assert.ok(keys.indexOf('G') > keys.indexOf('M'), 'G is not with the mount chips');
});

test('the touch start-game card deliberately does NOT carry it', () => {
  /* A phone has no key to hold, and no pointer lock to fight either - a thumb
   * taps the badge directly, which is the route this build keeps. A chip that
   * solves nothing there would cost most of a line on a 390 px screen. */
  const chips = bootChips(true);
  assert.ok(chips.length > 0, 'the touch chip list did not render');
  assert.ok(!chips.some(([k]) => k === 'G'), 'the keyboard gesture leaked onto the touch card');
});

test('the F1 help card teaches the fittings key under Mounts', () => {
  const mounts = HELP_GROUPS.find((g) => g.title === 'Mounts');
  assert.ok(mounts, 'the help card lost its Mounts section');
  const row = mounts.rows.find(([k]) => k === 'G');
  assert.ok(row, `no G row in the help card's Mounts section: ${JSON.stringify(mounts.rows)}`);
  assert.match(row[1], /1-4/);
  assert.match(row[1], /hold/i, 'the row does not say it is a hold');
});
