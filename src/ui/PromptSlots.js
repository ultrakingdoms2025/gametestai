/**
 * THE PROMPT CHANNEL, AND WHY IT HAS SLOTS.
 *
 * `pilot:prompt` has two publishers - `Piloting._pollBoard` and
 * `Mining._setPrompt` - and both are edge-latched on their own state. That is
 * correct for each of them on its own and wrong for the pair: whichever wrote
 * last in a frame owned the line, `mining.update` runs after `piloting.update`
 * in `main.js`, and mining publishes `null` the moment you step off a seam.
 *
 * Measured with the ship landed 16 m from a sulfur seam - the natural thing to
 * do after a descent:
 *
 *   7.3 m from the hull        "[F] Board the Kestrel"      boardableAt kestrel
 *   at the node (14.5 m out)   "[E] Work the Sulfur Crust"  boardableAt kestrel
 *   5 m from the hull          NOTHING                      boardableAt kestrel
 *   two seconds later          NOTHING                      boardableAt kestrel
 *
 * F still worked and nothing said so. The overlap is guaranteed rather than
 * unlucky: the boarding radius is 16.2 m for a Kestrel and `MINE_RANGE` is
 * 3.2 m, so you are always inside both.
 *
 * So each publisher owns a NAMED SLOT and the consumer merges them. Clearing
 * one can no longer clear the other, and neither publisher has to know the
 * other exists.
 *
 * This lives in its own module rather than inside `FlightHUD` for one reason:
 * `FlightHUD.js` imports its own stylesheet, so it cannot be loaded outside a
 * bundler - and a rule that decides what the player is told, which nothing can
 * drive in a test, is a rule that will be quietly broken again.
 */

/** The slots, in the order a tie is broken. Earlier wins. */
export const PROMPT_SOURCES = Object.freeze(['mining', 'board']);

/**
 * Which slot is on screen.
 *
 * Mining wins when both are set. Inside `MINE_RANGE` of a seam you are also
 * inside the boarding radius of the ship you flew in on, every time, and the
 * seam is the thing you walked over to.
 *
 * @param {{board?: string|null, mining?: string|null}} slots
 * @returns {string|null}
 */
export function pickPrompt(slots) {
  const k = pickPromptSlot(slots);
  return k ? slots[k] : null;
}

/**
 * Which slot NAME wins, rather than its text.
 *
 * The prompt is drawn as a keycap chip plus a sentence, and the chip's letter
 * lives in a parallel map keyed by slot - so the consumer needs to know which
 * publisher won, not just what it said. `pickPrompt` is kept as the thin
 * wrapper over this because it is the shape every existing caller and test
 * already speaks, and the tie-break rule must not exist twice.
 *
 * @param {{board?: string|null, mining?: string|null}} slots
 * @returns {'mining'|'board'|null}
 */
export function pickPromptSlot(slots) {
  if (!slots) return null;
  for (const k of PROMPT_SOURCES) {
    if (slots[k]) return k;
  }
  return null;
}

/**
 * Normalise an event's `source` to a slot name.
 * Anything unrecognised - including a publisher written before slots existed -
 * lands in `board`, which is what every pre-existing publisher meant.
 * @param {string|null|undefined} source
 */
export function promptSlot(source) {
  return source === 'mining' ? 'mining' : 'board';
}

/**
 * The connector between a verb and a venue name: `'the '`, or `''` when the
 * name already carries its own article.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────
 * Two places composed `${verb} the ${label}` - `MinigameManager._setPrompt`
 * and `HUD._composePrompt` - and `DockWorld` authors one venue as
 * `'The Test-Fire Butts'`, which is its real name. The player was offered
 * **"Start the The Test-Fire Butts"**, in the largest prompt on the screen,
 * at the one undiscovered minigame in the yard.
 *
 * The rule is here and not at either call site because there are two call
 * sites, and a rule about what the player reads that lives in two copies is a
 * rule that will disagree with itself. Case-insensitive on the article and
 * exact on the trailing space, so a venue genuinely called "Theatre" is
 * untouched.
 *
 * @param {string|null|undefined} label
 * @returns {'the '|''}
 */
export function venueArticle(label) {
  const s = String(label ?? '');
  return /^the\s/i.test(s) ? '' : 'the ';
}
