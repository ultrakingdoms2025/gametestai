import { LANDABLE_PLANETS, SPACE_WORLDS, TOTAL_DESTINATIONS } from '@/lib/worlds';

/**
 * How big the game actually is, as opposed to how big the front page said.
 *
 * ── The contradiction this closes ─────────────────────────────────────────
 *
 * `lib/worlds.ts` holds SEVEN gateway worlds. The home page said "Six worlds",
 * the gateway's screen-reader line said "Six worlds" over seven rendered
 * panels, and the layout metadata said seven — three numbers for one array. All
 * of them are now derived from `WORLDS.length`.
 *
 * Underneath that, the game registers EIGHTEEN worlds: the seven behind the
 * gateways, plus `SpaceWorld`, plus the ten `PlanetWorld` subclasses stamped
 * from `src/worlds/planets/index.js`. Space, the ships and the landable planets
 * had no marketing surface at all, so a customer could not find out the game
 * had them without buying it first.
 *
 * ── Why these two constants are here and not in `lib/worlds.ts` ───────────
 *
 * They belong in `lib/worlds.ts` next to `MOUNTS` and `WEAPONS`, and that file
 * is owned elsewhere in this pass. Moving them there is a one-line change and
 * this module should then re-export or disappear. Until it does, they are
 * pinned to the game source by the comments above and by nothing else, which is
 * the weaker arrangement of the two.
 */

/* MOVED. These three now live in `lib/worlds.ts` beside MOUNTS and WEAPONS,
 * which is where this module's own header said they belonged. Re-exported here
 * so the five importers did not have to change in the same pass that moved
 * them; import them from `@/lib/worlds` in new code. */
export { LANDABLE_PLANETS, SPACE_WORLDS, TOTAL_DESTINATIONS };

const WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen', 'twenty',
];

/** Small numbers read as words in prose; anything above the table stays a numeral. */
export function numberWord(n: number): string {
  return WORDS[n] ?? String(n);
}

/** The same, capitalised, for the start of a sentence or a headline. */
export function NumberWord(n: number): string {
  const w = numberWord(n);
  return w.charAt(0).toUpperCase() + w.slice(1);
}
