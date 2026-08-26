/**
 * The half of the HUD's responsive contract that a browser cannot answer.
 *
 * `hud-viewport-probe.mjs` drives real Chrome at real viewport sizes and
 * measures real rectangles, which is the only honest way to check a layout.
 * Five things are not visible in a rectangle, and this file is those five:
 *
 *   1. `dvh` vs `vh`. A headless browser has no URL bar to slide away, so the
 *      two are identical in it and no measurement can tell them apart. On a
 *      phone `100vh` is the LARGE viewport - the one that includes the space
 *      the URL bar is sitting in - so the bottom of anything sized in `vh` is
 *      behind the browser chrome for as long as the bar is up. Checked in the
 *      four properties that are a height AND inside custom properties, because
 *      `--x: min(52vh, 460px)` plus `height: var(--x)` is the same defect with
 *      the unit moved one line away from the property it sizes.
 *   2. The shipped `<meta name="viewport">`. Without `viewport-fit=cover` every
 *      `env(safe-area-inset-*)` in the tree resolves to 0, so the whole
 *      safe-area layer is dead code that reads as done.
 *   3. Whether every stylesheet agrees about where the safe area is. They all
 *      have to read the SAME four tokens, or the probe drives one of them and
 *      grades the rest.
 *   4. Whether `Minimap.js` has gone back to writing `canvas.style.width`.
 *      An inline style beats every stylesheet, so while it did, no breakpoint
 *      could shrink the map and a 390 px phone got the same 220 px square a
 *      desktop does.
 *   5. Whether anybody has "forced landscape" with a `transform: rotate(90deg)`
 *      on the frame. That hack turns the pixels and leaves the input frame
 *      where it was, so it looks perfect in every rectangle the probe measures
 *      and every screenshot it takes, and is unplayable with a thumb. It is
 *      the one defect here a browser makes MORE invisible rather than less.
 *
 * Exported rather than inlined in the probe so `scripts/tests/hud-responsive
 * .test.mjs` can run the same five under `npm test`, which is the gate this
 * repository's CI actually runs on every push. `SHEETS` is the list they walk,
 * and it has to keep pace with what the probe positions - see the note on it,
 * and the test in `hud-responsive.test.mjs` that ties the two together.
 *
 * ── CRLF ──────────────────────────────────────────────────────────────────
 *
 * Every read here normalises line endings first. This repository checks out
 * with `core.autocrlf` on, so these files have CRLF in a checkout and LF in
 * the worktree they were written in, and a scrape that anchors on `\n` is
 * green in one and red in the other while being about the wrong thing in
 * both. That defect has now been paid for four separate times here - see the
 * long note in `charter-hud.test.mjs` and the roadmap's per-phase discipline.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Read a repo file with line endings normalised. Never skip the normalise. */
async function read(rel) {
  return (await readFile(path.join(root, rel), 'utf8')).replace(/\r\n/g, '\n');
}

/**
 * THE STYLESHEETS THAT LAY OUT THE INTERFACE.
 *
 * This list said `hud.css`, `pause-menu.css`, `touch.css` and nothing else,
 * which is three sheets out of the sixteen in `src/ui`. Both of the checks
 * that walk it are about a PHONE - `vh` against a moving URL bar, and one
 * answer to "where is the notch" - and the nine added here are the panels a
 * phone player opens: the quest board, the bag and the shop (one sheet), the
 * three customisers, the key list, the map, the mount wheel and the bug form.
 * Eight of the nine were measuring a height in `vh` when they were added.
 *
 * The panels are laid out by the viewport probe now (see the harness), and
 * this is the half of their contract a rectangle cannot carry.
 *
 * A sheet belongs here when it positions something. `audio.css`, `flight.css`,
 * `minigame.css` and `race.css` are not in the probe yet, so putting them here
 * would be a rule with no measurement behind it - add them together or not at
 * all.
 */
const SHEETS = [
  'src/ui/hud.css',
  'src/ui/pause-menu.css',
  'src/ui/touch.css',
  'src/ui/quest-board.css',
  'src/ui/inventory.css',
  'src/ui/character.css',
  'src/ui/mount-menu.css',
  'src/ui/ship-menu.css',
  'src/ui/keybind.css',
  'src/ui/maze-map.css',
  'src/ui/mountwheel.css',
  'src/ui/bug-report.css',
  'src/ui/records.css',
];

/**
 * @returns {Promise<string[]>} one line per failure; empty means clean.
 */
export async function hudSourceChecks() {
  const fails = [];

  /* -- 1. the viewport meta ------------------------------------------- */
  const index = await read('index.html');
  const meta = index.match(/<meta\s+name="viewport"\s+content="([^"]+)"/);
  if (!meta) {
    fails.push('index.html has no viewport meta at all');
  } else {
    const content = meta[1];
    if (!/viewport-fit\s*=\s*cover/.test(content)) {
      fails.push('the viewport meta has no viewport-fit=cover, so every '
        + `env(safe-area-inset-*) in the tree resolves to 0: "${content}"`);
    }
    if (/user-scalable\s*=\s*no/.test(content) || /maximum-scale\s*=\s*1(\.0)?\b/.test(content)) {
      fails.push(`the viewport meta forbids zoom, which fails WCAG 1.4.4: "${content}"`);
    }
  }

  /* -- 2. dvh, not vh, in anything that is a height -------------------- */
  for (const file of SHEETS) {
    /* Comments stripped FIRST. Every one of these files now carries a note
     * saying why the `vh` it used to have became `dvh`, and a scan that reads
     * prose would fail on the explanation of its own fix. */
    const css = (await read(file)).replace(/\/\*[\s\S]*?\*\//g, '');
    const re = /(^|[\n;{])\s*((?:max-|min-)?height|inset|bottom|top)\s*:\s*([^;}]*\d(?:\.\d+)?vh[^;}]*)/g;
    for (const m of css.matchAll(re)) {
      fails.push(`${file}: \`${m[2]}: ${m[3].trim()}\` is measured in vh, which a `
        + 'mobile URL bar moves — use dvh');
    }
    /* AND THE SAME UNIT HIDING IN A CUSTOM PROPERTY.
     *
     * The rule above names four properties, so `--mw-size: min(52vh, 460px)`
     * followed by `height: var(--mw-size)` passed it while being the exact
     * defect it exists for. A custom property has no type to inspect, so the
     * unit is refused outright: a length that is used as a height must be
     * `dvh`, and one that is only ever used as a width should be `vw`. */
    for (const m of css.matchAll(/(^|[\n;{])\s*(--[\w-]+)\s*:\s*([^;}]*\d(?:\.\d+)?vh[^;}]*)/g)) {
      fails.push(`${file}: \`${m[2]}: ${m[3].trim()}\` puts vh inside a custom property, `
        + 'where the height check above cannot see it — use dvh');
    }
  }

  /* -- 3. one answer to "where is the notch" --------------------------- */
  const hud = await read('src/ui/hud.css');
  for (const edge of ['t', 'r', 'b', 'l']) {
    const name = { t: 'top', r: 'right', b: 'bottom', l: 'left' }[edge];
    const decl = new RegExp(`--sa-${edge}:\\s*env\\(safe-area-inset-${name},\\s*0px\\)`);
    if (!decl.test(hud)) {
      fails.push(`hud.css does not define --sa-${edge} as env(safe-area-inset-${name}, 0px) — `
        + 'the probe drives those four tokens, so a layer that does not read them is ungraded');
    }
  }
  for (const file of SHEETS) {
    const css = await read(file);
    /* One place may name `env()`: the four token declarations themselves. */
    const uses = [...css.matchAll(/env\(safe-area-inset-\w+/g)].length;
    const allowed = file === 'src/ui/hud.css' ? 4 : 0;
    if (uses > allowed) {
      fails.push(`${file} reads env(safe-area-inset-*) directly ${uses} time(s) — `
        + 'go through --sa-t/r/b/l so the whole interface has one answer');
    }
  }

  /* -- 4. the map's presented size is CSS ------------------------------ */
  const minimap = await read('src/ui/Minimap.js');
  if (/canvas\.style\.(width|height)\s*=/.test(minimap)) {
    fails.push('Minimap.js writes canvas.style.width/height again — an inline style beats '
      + 'every stylesheet, so no breakpoint can size the map and a phone gets the '
      + 'desktop square');
  }
  if (!/--map/.test(hud)) {
    fails.push('hud.css no longer declares --map, so nothing sizes the minimap at all');
  }

  /* -- 5. THE CSS ROTATE HACK, BANNED OUTRIGHT -------------------------
   *
   * The stock answer to "force landscape on mobile" is
   *
   *     @media (orientation: portrait) { #ui-root { transform: rotate(90deg) } }
   *
   * and it is a trap. It rotates the PIXELS and nothing else: pointer
   * coordinates, scroll, `innerWidth`/`innerHeight`, `env(safe-area-inset-*)`
   * and the virtual keyboard all stay in the frame the browser thinks it is
   * in. This game is played with a thumb dragging a look pad and a thumb on a
   * floating stick, so every touch would land somewhere other than where it
   * was aimed - and, being purely an input-frame defect, it looks PERFECT in
   * a screenshot and in every rectangle `hud-viewport-probe.mjs` measures.
   * That is exactly why it is checked here instead: a browser cannot see it.
   *
   * `src/ui/OrientationGate.js` is the honest version - a real
   * `screen.orientation.lock` where the API exists, and a rotate prompt
   * everywhere else. Narrow to the four elements the hack is ever applied to,
   * because a rotated icon or a spinning ring is not this defect: the crosshair
   * arms, the boot beacon and the mount wheel all legitimately rotate. */
  const FRAME_SUBJECT = /^(html|body|#ui-root|#viewport)(?![\w-])/;
  for (const file of SHEETS) {
    const css = (await read(file)).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/transform\s*:[^;]*\brotate[XYZ]?\s*\(/.test(rule[2])) continue;
      const subjects = rule[1].split(',')
        .map((s) => s.trim().split(/[\s>+~]+/).filter(Boolean).pop() ?? '');
      if (!subjects.some((s) => FRAME_SUBJECT.test(s))) continue;
      fails.push(`${file}: \`${rule[1].trim()}\` carries a rotate transform. Rotating the `
        + 'whole frame turns the pixels and leaves touch coordinates, scroll and the '
        + 'virtual keyboard where they were — see src/ui/OrientationGate.js');
    }
  }

  return fails;
}

export default hudSourceChecks;
