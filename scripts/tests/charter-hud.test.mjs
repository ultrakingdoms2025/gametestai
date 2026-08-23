import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * THE PANEL READS WHAT THE SYSTEMS ACTUALLY PUBLISH.
 *
 * ── The failure this exists to catch ──────────────────────────────────────
 *
 * `relics:changed` was emitted on every world change and every pickup for
 * months with NO LISTENER ANYWHERE. Thirty finite collectibles and no counter.
 * Nothing errored, nothing was red, and the only symptom was a player who could
 * not tell how many were left.
 *
 * A charter board is that hazard at full size: it is the only thing on screen
 * that answers "what is this game about", it is fed by two systems, and every
 * way it can go wrong is silent - a renamed field reads `undefined/undefined`,
 * a missing subscription leaves the panel hidden, and a first-run player simply
 * never learns there was an objective.
 *
 * ── So the payloads are NOT written here ──────────────────────────────────
 *
 * Every payload below comes out of the REAL `Charters.progress()` and the REAL
 * `Onboarding.progress()`. A test that hand-built `{chartered: 3, total: 18}`
 * would pass for ever against a system that had stopped publishing either
 * field, which is this project's signature defect - a gate measuring something
 * the game does not do.
 *
 * ── Why the DOM is a shim and the HUD is not ──────────────────────────────
 *
 * A whole `HUD` cannot be constructed headlessly: it builds a hundred elements,
 * a `ChatBox` and a `WeaponWheel`. The two methods under test touch only the
 * nodes `_buildCharter` creates, so the panel is built by the REAL
 * `_buildCharter` over a nine-line element shim and then driven by the REAL
 * `_setCharter` / `_setOnboarding`. The same technique `discovery-hud` and
 * `mount-hud` use, for the same reason.
 */

/* ---------------------------------------------------------------------- */
/* A DOM, reduced to what `el()` and the panel touch                       */
/* ---------------------------------------------------------------------- */

function makeNode(tag) {
  const node = {
    tagName: tag,
    className: '',
    hidden: false,
    children: [],
    _text: '',
    get textContent() { return this._text; },
    set textContent(v) {
      this._text = String(v);
      // Setting textContent to '' is how the panel clears its rows.
      if (this._text === '') this.children.length = 0;
    },
    appendChild(c) { this.children.push(c); return c; },
    append(...cs) { for (const c of cs) this.children.push(c); },
    classList: {
      _set: new Set(),
      toggle(c, on) { if (on) this._set.add(c); else this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
  };
  node.classList = { _set: new Set(), toggle(c, on) { if (on) this._set.add(c); else this._set.delete(c); }, contains(c) { return this._set.has(c); } };
  return node;
}

globalThis.document = globalThis.document ?? {};
globalThis.document.createElement = (tag) => makeNode(tag);
globalThis.document.createElementNS = (_ns, tag) => makeNode(tag);
globalThis.window = globalThis.window ?? globalThis;
globalThis.window.addEventListener = globalThis.window.addEventListener ?? (() => {});
globalThis.window.removeEventListener = globalThis.window.removeEventListener ?? (() => {});

const { HUD } = await import('../../src/ui/HUD.js');
const { Charters } = await import('../../src/systems/Charters.js');
const { Onboarding, ONBOARDING_STEPS } = await import('../../src/systems/Onboarding.js');
const { EventBus } = await import('../../src/core/EventBus.js');

/** A HUD reduced to the charter panel, built by the real `_buildCharter`. */
function panel() {
  const h = Object.create(HUD.prototype);
  const col = makeNode('div');
  h._buildCharter(col);
  return h;
}

/** Text of every `.col-count` under the record rows. */
const rowCounts = (h) => h.chRows.children.map((r) => r.children[1]?.textContent ?? '');

/* ====================================================================== */
/* 1. The tutorial face                                                    */
/* ====================================================================== */

test('a first-run player is shown the first instruction and nothing else', () => {
  const h = panel();
  const onboarding = new Onboarding({ bus: new EventBus() });

  assert.equal(h.charterPanel.hidden, true, 'the panel is not hidden before anything happens');
  h._setOnboarding(onboarding.progress());

  assert.equal(h.charterPanel.hidden, false, 'a first-run player is shown nothing');
  assert.equal(h.chTitle.textContent, ONBOARDING_STEPS[0].title);
  assert.equal(h.chHint.textContent, ONBOARDING_STEPS[0].text);
  assert.equal(h.chCount.textContent, `0/${ONBOARDING_STEPS.length}`);
  /* The record rows belong to the mission face and would be eighteen rows of
   * nothing to a player who has not moved yet. */
  assert.equal(h.chRows.hidden, true);
  assert.equal(h.chLocked.hidden, false, 'nothing aspirational is on display');
  assert.match(h.chLocked.textContent, /^Locked — /);
});

test('the tutorial keeps the panel while it is unfinished', () => {
  const h = panel();
  const bus = new EventBus();
  const onboarding = new Onboarding({ bus });
  const charters = new Charters({
    bus, worldManager: { ids: ['station', 'maze'], displayNameOf: (i) => i },
  });

  h._setOnboarding(onboarding.progress());
  /* The mission board arriving mid-tutorial must not take the panel: it fires
   * on every world change, and a player two steps into the opening sequence
   * would lose their instruction the first time anything rebuilt a world. */
  h._setCharter(charters.progress());
  assert.equal(h.chTitle.textContent, ONBOARDING_STEPS[0].title,
    'the charter board took the panel while the tutorial was still running');
});

test('finishing the tutorial hands the panel to the objective', () => {
  const h = panel();
  const bus = new EventBus();
  const onboarding = new Onboarding({ bus });
  const charters = new Charters({
    bus, worldManager: { ids: ['station', 'maze'], displayNameOf: (i) => i },
  });

  h._setOnboarding(onboarding.progress());
  h._setCharter(charters.progress());
  onboarding.deserialize({ done: ONBOARDING_STEPS.map((s) => s.id) });
  h._setOnboarding(onboarding.progress());

  assert.equal(h.chTitle.textContent, 'Chart the Nexus',
    'the tutorial finished and the panel still shows a tutorial step');
  assert.equal(h.chLocked.hidden, true, 'the locked reward is now permanent furniture');
});

/* ====================================================================== */
/* 2. The mission face, against real records                               */
/* ====================================================================== */

test('the board counts the gateways the registry actually has', () => {
  const h = panel();
  const bus = new EventBus();
  const ids = ['station', 'maze', 'citadel', 'race'];
  const charters = new Charters({ bus, worldManager: { ids, displayNameOf: (i) => i } });

  h._onboardDone = true;
  h._setCharter(charters.progress());
  assert.equal(h.chCount.textContent, `0/${ids.length}`);
  assert.equal(h.chTitle.textContent, 'Chart the Nexus');
  assert.ok(h.chHint.textContent.length > 0, 'the board says nothing about what to do');
});

test('the rows are the record of the world you are standing in', () => {
  const h = panel();
  const bus = new EventBus();
  const charters = new Charters({
    bus, worldManager: { ids: ['station', 'maze'], displayNameOf: (i) => i },
  });
  h._onboardDone = true;

  /* In the Coil: one deed, unfilled. The payload is the real `progress()`, so
   * a column renamed in `Charters` shows up here as a wrong row rather than a
   * green test. */
  bus.emit('world:changed', { id: 'maze', world: { id: 'maze' } });
  h._setCharter(charters.progress());
  assert.deepEqual(rowCounts(h), ['0/1']);

  bus.emit('maze:centre-found', { amount: 100 });
  h._setCharter(charters.progress());
  assert.deepEqual(rowCounts(h), ['1/1']);
  assert.equal(h.chRows.children[0].children[1].classList.contains('done'), true,
    'a finished column is not marked finished');
  assert.equal(h.chCount.textContent, '1/2', 'the charter was not counted on the board');
});

test('a world nobody has surveyed draws no rows rather than a row of zeroes', () => {
  const h = panel();
  const bus = new EventBus();
  const charters = new Charters({
    bus, worldManager: { ids: ['citadel'], displayNameOf: (i) => i },
  });
  h._onboardDone = true;

  bus.emit('world:changed', { id: 'citadel', world: { id: 'citadel' } });
  h._setCharter(charters.progress());
  /* "Unsurveyed" and "none found" are different sentences. A row reading 0/0
   * claims a record exists and is empty; no row at all, with the hint above it
   * saying so, is the truth. */
  assert.equal(h.chRows.hidden, true);
  assert.ok(h.chHint.textContent.length > 0);
});

test('the rank chip is written only once there is a rank to show', () => {
  const h = panel();
  const bus = new EventBus();
  const charters = new Charters({
    bus, worldManager: { ids: ['maze', 'citadel'], displayNameOf: (i) => i },
  });
  h._onboardDone = true;

  h._setCharter(charters.progress());
  const first = h.chRank.textContent;
  bus.emit('world:changed', { id: 'maze', world: { id: 'maze' } });
  bus.emit('maze:centre-found', { amount: 100 });
  h._setCharter(charters.progress());
  assert.notEqual(h.chRank.textContent, first, 'the rank never moves');
  assert.equal(h.chRank.textContent, h.chRank.textContent.toUpperCase());
});

/* ====================================================================== */
/* 3. The subscriptions exist                                              */
/* ====================================================================== */

test('no class this panel invents already means something else', async () => {
  /* THE DEFECT THIS CASE WAS WRITTEN FOR, found in a browser and not by a test.
   *
   * The panel shipped with `ch-` classes - `ch-head`, `ch-hint`, `ch-rank` -
   * and `ch-` is the CHARACTER menu's prefix. `character.css` has owned
   * `.ch-head` and `.ch-hint` for a long time, both stylesheets are loaded at
   * once, and the charter's brief line came out reading "Changes apply to your
   * body at once. Save from the Esc menu to keep them."
   *
   * Nothing errored. Nothing was red. The panel was on screen, in roughly the
   * right place, saying something from a different menu - which is the exact
   * failure shape this repo keeps paying for: a thing that LOOKS like it works.
   *
   * So: every class this panel creates is checked against every OTHER
   * stylesheet in `src/ui`. A collision fails here rather than in a screenshot
   * nobody compares. */
  const { readFile, readdir } = await import('node:fs/promises');
  const uiDir = new URL('../../src/ui/', import.meta.url);
  const hudSrc = await readFile(new URL('HUD.js', uiDir), 'utf8');

  const from = hudSrc.indexOf('_buildCharter(col) {');
  assert.ok(from > 0, '_buildCharter has been renamed - this gate is measuring nothing');
  const body = hudSrc.slice(from, hudSrc.indexOf('\n  }\n', from));
  const classesIn = (text) => {
    const out = new Set();
    for (const m of text.matchAll(/el\('[a-z]+',\s*'([^']+)'/g)) {
      for (const cls of m[1].split(/\s+/)) if (cls) out.add(cls);
    }
    return out;
  };
  const mine = classesIn(body);
  assert.ok(mine.size >= 5, `the class scrape found ${mine.size} classes - it has broken`);

  /* Shared vocabulary is DERIVED, not listed. `panel`, `panel-label`,
   * `col-row` and `col-count` are reused across several of the HUD's panels on
   * purpose - the discovery and objective panels are meant to look like this
   * one - so anything another `_build*` method also uses is somebody else's
   * word too and is left alone. What is checked is the vocabulary this panel
   * INVENTED, which is exactly the set `ch-head` was in. */
  const shared = new Set();
  for (const m of hudSrc.matchAll(/\n  (_build\w+)\(/g)) {
    if (m[1] === '_buildCharter') continue;
    const at = m.index ?? 0;
    for (const cls of classesIn(hudSrc.slice(at, hudSrc.indexOf('\n  }\n', at)))) shared.add(cls);
  }
  const own = [...mine].filter((c) => !shared.has(c));
  assert.ok(own.length >= 4, `only ${own.length} classes are this panel's own - the scrape has broken`);

  const files = (await readdir(uiDir)).filter((f) => f.endsWith('.css') && f !== 'hud.css');
  assert.ok(files.length >= 5, 'the stylesheet scrape found almost nothing');
  const clashes = [];
  for (const f of files) {
    const css = await readFile(new URL(f, uiDir), 'utf8');
    for (const cls of own) {
      if (new RegExp(`\\.${cls}\\b`).test(css)) clashes.push(`${cls} in ${f}`);
    }
  }
  assert.deepEqual(clashes, [], `these classes already mean something else: ${clashes.join(', ')}`);
});

test('the HUD listens to both channels', async () => {
  /* The `relics:changed` defect in one line: an event with no listener is
   * silent for ever. Scraped rather than driven, because `_wire` needs the
   * whole HUD and this is a fact about one file. */
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../../src/ui/HUD.js', import.meta.url), 'utf8');
  for (const channel of ['charter:changed', 'onboarding:changed']) {
    assert.match(src, new RegExp(`_on\\('${channel}'`),
      `nothing in the HUD listens to ${channel}`);
  }
});
