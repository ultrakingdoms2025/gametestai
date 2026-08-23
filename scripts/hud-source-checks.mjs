/**
 * The half of the HUD's responsive contract that a browser cannot answer.
 *
 * `hud-viewport-probe.mjs` drives real Chrome at real viewport sizes and
 * measures real rectangles, which is the only honest way to check a layout.
 * Four things are not visible in a rectangle, and this file is those four:
 *
 *   1. `dvh` vs `vh`. A headless browser has no URL bar to slide away, so the
 *      two are identical in it and no measurement can tell them apart. On a
 *      phone `100vh` is the LARGE viewport - the one that includes the space
 *      the URL bar is sitting in - so the bottom of anything sized in `vh` is
 *      behind the browser chrome for as long as the bar is up.
 *   2. The shipped `<meta name="viewport">`. Without `viewport-fit=cover` every
 *      `env(safe-area-inset-*)` in the tree resolves to 0, so the whole
 *      safe-area layer is dead code that reads as done.
 *   3. Whether the two stylesheets agree about where the safe area is. They
 *      have to read the SAME four tokens, or the probe drives one of them and
 *      grades both.
 *   4. Whether `Minimap.js` has gone back to writing `canvas.style.width`.
 *      An inline style beats every stylesheet, so while it did, no breakpoint
 *      could shrink the map and a 390 px phone got the same 220 px square a
 *      desktop does.
 *
 * Exported rather than inlined in the probe so `scripts/tests/hud-responsive
 * .test.mjs` can run the same four under `npm test`, which is the gate this
 * repository's CI actually runs on every push.
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

/** The stylesheets that lay out the interface. */
const SHEETS = ['src/ui/hud.css', 'src/ui/pause-menu.css', 'src/ui/touch.css'];

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
    const css = await read(file);
    const re = /(^|[\n;{])\s*((?:max-|min-)?height|inset|bottom|top)\s*:\s*([^;}]*\d(?:\.\d+)?vh[^;}]*)/g;
    for (const m of css.matchAll(re)) {
      fails.push(`${file}: \`${m[2]}: ${m[3].trim()}\` is measured in vh, which a `
        + 'mobile URL bar moves — use dvh');
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

  return fails;
}

export default hudSourceChecks;
