/**
 * Quest content vocabulary — the only ids a quest step is allowed to name,
 * IN THE WORLD THE STEP NAMES THEM IN.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * 0 of 50 seeded quests were completable. The seed invented roughly 150 target
 * ids (`relay_node`, `nightshade`, `grain_sack`, `guild_master`) and the engine
 * exposes roughly 40 real ones; the intersection was EMPTY. Nothing in the
 * repo ever compared the two lists, so the content and the engine drifted apart
 * silently and stayed apart for fifty quests.
 *
 * This module is the comparison. It DERIVES the vocabulary from the same source
 * files the running game reads — `ITEMS`, `CIRCUITS`, `ROLE`, `ROLE_ROTATION`,
 * the `static id` on each World subclass, the quest-manager cast in
 * `NPCManager`, the authored casts in each world file AND in each world's own
 * source directory, the drop and cache tables, and the NPC budget arithmetic in
 * `NPCManager.spawnForWorld` — so a new item, a fourth circuit, a renamed NPC
 * or one extra civilian in a zone builder changes the ruler on the next test
 * run rather than six months later in production. Nothing here is a
 * hand-maintained duplicate list; where a value cannot be imported it is
 * scraped from the source text and the scrape is asserted non-empty by the
 * test, so a refactor that breaks the scrape fails loudly instead of quietly
 * accepting everything.
 *
 * ── THE BUG THIS FILE USED TO HAVE: declared != spawns ─────────────────────
 *
 * The first version of this validator asked one question about an NPC name:
 * "is it DECLARED somewhere in `src/`?" It never asked the only question that
 * matters to a player: "does a body carrying that name get a SPAWN SLOT in the
 * world the step names?"
 *
 * Those are different questions, and on the station they give opposite answers.
 * `ROLE_CAST.station` — Quartermaster Bex, Broker Sunil Rai, Deck Warden Ilse,
 * Warden Cato Reyes — is only ever handed out by `NPCManager._populateHubs`,
 * the crowd filler. The filler's budget is what is LEFT of `friendlyBudget`
 * after the world has authored its own people:
 *
 *     StationWorld  friendlyBudget = 50
 *                   42 authored civilians (18 hub + 6 in each of four zones)
 *                 +  6 gateway lorekeepers
 *                 = 48, leaving the filler TWO slots
 *
 * Two slots is not enough to reach those names dependably, and one more NPC
 * added to any zone builder removes them. Meanwhile the SAME names do spawn in
 * `race`, which has no cast of its own (`THEME_BY_WORLD` has no `race` entry,
 * so `castFor` falls back to `ROLE_CAST.station`) and has 23 filler slots
 * spare. "Quartermaster Bex" is therefore a valid target in `race` and an
 * impossible one on the `station`. A global vocabulary cannot express that, so
 * this one is per-world and spawn-aware.
 *
 * That is the same "verified BUILT, never verified REACHABLE" trap the medieval
 * expansion shipped four defects through — which had been living inside the
 * tool built to prevent it.
 *
 * ── The three questions a step has to survive ──────────────────────────────
 *
 *  1. Does the step's `type` have an EMITTER? Five types (`investigate`,
 *     `deliver`, `escort`, `stealth`, `craft`) are nouns nobody wired to an
 *     event. See {@link STEP_TYPE_EMITTERS} — every entry names the file and
 *     the subscription that proves it.
 *  2. Can the step's `target` ever be produced by the engine, IN THE WORLD THE
 *     STEP NAMES? `QuestSystem._advanceSteps` skips any step whose `world` is
 *     not the world the player is standing in, so "is this id real" is not a
 *     question that can be answered without a world.
 *  3. Does the thing named actually EXIST in that world at runtime? A name
 *     needs a guaranteed spawn slot; an item needs a drop table, a cache table
 *     or an authored interior stash that contains it; a role needs an NPC in
 *     that world that carries it.
 *
 * ── The matcher is COPIED, not approximated ───────────────────────────────
 *
 * {@link normalizeTarget} and {@link tokenRunMatch} are line-for-line mirrors of
 * `QuestSystem._normalizeTarget` / `_tokenRunMatch`. A validator that matched
 * more loosely than the engine would pass content the game then rejects; one
 * that matched more strictly would reject content that works. Either way the
 * ruler would be measuring a different wall. If the engine's matcher changes,
 * these two functions change with it — that is the one piece of deliberate
 * duplication in this file and it is why both carry the same comment.
 *
 * ── Where this file is deliberately CONSERVATIVE ───────────────────────────
 *
 * Reachability is not always decidable from source. Where it is not, this file
 * REJECTS rather than accepts, and says so in the failure text:
 *
 *   • The crowd filler's slots are a residual and its placement is best-effort
 *     (`_findStandingSpot` can fail, groups are skipped when the snapped centre
 *     is more than 4 m off the hub plane, the loop gives up after 60 passes).
 *     A cast name is therefore only trusted where the filler has at least a
 *     whole {@link ROLE_ROTATION} cycle of budget AND the name's own rotation
 *     slot is inside that budget. See {@link fillerNamesFor}.
 *   • Streamed populations (`MedievalResidency`) generate their names at run
 *     time from a seeded planner, so no streamed NAME is ever a valid target.
 *     Their ROLES are, because `roleOrder` is authored source.
 *   • Cache placement needs geometry (a dive site, or a 7 m drop). A world's
 *     cache TABLE is modelled; whether a given world's terrain yields a site is
 *     not, so cache items are accepted on the table alone.
 *   • `inventory:drop` (`main.js:1465`) lets a player drop and re-collect
 *     anything they are carrying, so in principle every item is "collectable"
 *     in every world. That path is ignored deliberately — treating it as
 *     reachability would make the `collect` rule vacuous.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import { ITEMS, PACKS } from '../src/systems/ItemDefs.js';
import { ROLE, ROLE_CAST, ROLE_ROTATION } from '../src/npc/NPCRoles.js';
import { CIRCUITS } from '../src/worlds/RaceCircuits.js';
import {
  OUTFITS, HAIR_STYLE_IDS, HEADGEAR_STYLES, SEX_PROFILES,
} from '../src/player/PlayerAvatar.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');

/** @param {string} rel repo-relative path */
function read(rel) {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

/** Every `.js` file under a repo-relative directory, recursively. */
function walkJs(rel) {
  const abs = path.join(REPO_ROOT, rel);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return [];
  const out = [];
  for (const entry of readdirSync(abs)) {
    const child = `${rel}/${entry}`;
    if (statSync(path.join(REPO_ROOT, child)).isDirectory()) out.push(...walkJs(child));
    else if (entry.endsWith('.js')) out.push(child);
  }
  return out;
}

/* ====================================================================== */
/* The matcher — mirrored from QuestSystem                                */
/* ====================================================================== */

/**
 * Mirror of `QuestSystem._normalizeTarget` (src/systems/QuestSystem.js).
 * Folds anything to `[a-z0-9_]`, which is why a bare integer was such a
 * dangerous candidate before the token-run rule landed.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeTarget(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Mirror of `QuestSystem._tokenRunMatch`. True when the shorter token list
 * appears as a CONTIGUOUS run in the longer one — never a bare substring.
 * @param {string[]} a
 * @param {string[]} b
 */
export function tokenRunMatch(a, b) {
  if (!a.length || !b.length) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  for (let i = 0; i + short.length <= long.length; i++) {
    let hit = true;
    for (let j = 0; j < short.length; j++) {
      if (long[i + j] !== short[j]) { hit = false; break; }
    }
    if (hit) return true;
  }
  return false;
}

/**
 * Would `QuestSystem._matchesStepTarget` accept `candidate` for `target`?
 * An empty target matches everything, exactly as the engine does.
 * @param {string} target
 * @param {string} candidate
 */
export function targetMatches(target, candidate) {
  const expected = normalizeTarget(target);
  if (!expected) return true;
  const normalized = normalizeTarget(candidate);
  if (!normalized) return false;
  if (normalized === expected) return true;
  return tokenRunMatch(expected.split('_').filter(Boolean), normalized.split('_').filter(Boolean));
}

/* ====================================================================== */
/* Step types: which ones the engine can actually advance                 */
/* ====================================================================== */

/**
 * Every step type that reaches `_advanceSteps`, and the proof.
 *
 * VERIFIED against `src/systems/QuestSystem.js` (the `this.bus.on(...)` block
 * in the constructor plus every `_advanceSteps(...)` call site) and against the
 * only four `emit('quest:activity', ...)` sites in `src/`:
 *
 *   src/ui/HUD.js:1773        type:'interact'  (quest-manager NPC ONLY)
 *   src/ui/HUD.js:1776        type:'talk'      (every NPC that is NOT one)
 *   src/systems/Loot.js:602   type:'collect'   (credits from a pickup)
 *   src/systems/Loot.js:610   type:'collect'   (any other item from a pickup)
 *   src/systems/Portals.js:2830 type:'interact' (the portal itself)
 *
 * `_onActivity` forwards `e.type` verbatim, so ONLY `talk`, `interact` and
 * `collect` can ever arrive that way. Everything else has a dedicated
 * subscription, listed below.
 *
 * @type {Record<string, {emitter:string, note?:string}>}
 */
export const STEP_TYPE_EMITTERS = {
  visit: {
    emitter: 'QuestSystem._creditVisit, from world:changed / accept() / _loadQuestsForWorld',
    note: 'Event carries ONE candidate: the id of the world just entered.',
  },
  collect: {
    emitter: "bus.on('loot:collected') → _onCollect, plus quest:activity type 'collect' (Loot.js:602,610)",
    note: 'Candidates are item ids, and only the ones THIS world can actually put in a pickup.',
  },
  talk: {
    emitter: "quest:activity type 'talk' (HUD.js:1776) → _onActivity",
    note: 'HUD.js:1772 sends `talk` only when `npc.isQuestManager` is FALSE. A quest manager can never emit one.',
  },
  interact: {
    emitter: "quest:activity type 'interact' (HUD.js:1773 quest manager, Portals.js:2830 portal), plus bus.on('portal:entering') → _onPortalEntering",
    note: 'ONLY quest managers and portals emit interact. Every other NPC emits talk.',
  },
  kill: { emitter: "bus.on('npc:killed') → _onKill (hostile NPCs only)" },
  defend: { emitter: "bus.on('npc:killed') → _onKill and bus.on('npc:damaged') → _onNpcDamaged (hostile NPCs only)" },
  race: {
    emitter: "bus.on('race:finished') → _onRaceFinished (count === 1) and bus.on('race:lap') → _onRaceLap (count > 1)",
    note: 'RaceManager only arms where a world publishes a trackPath — which is RaceWorld and nothing else.',
  },
  purchase: { emitter: "bus.on('market:trade') → _onMarketTrade (Marketplace.js:434,456,481,526)" },
  customize: { emitter: "bus.on('character:changed') → _onCharacterChanged (PlayerAvatar.js:550)" },
  survive: {
    emitter: 'QuestSystem.update() timer, one count per SURVIVE_TICK_S (30 s) without damage',
    note: 'Event carries the CURRENT world as its only candidate.',
  },
};

/** Step types a quest author may write. */
export const WORKING_STEP_TYPES = Object.freeze(Object.keys(STEP_TYPE_EMITTERS));

/**
 * Step types with NO emitter anywhere in `src/`.
 *
 * These are not "not implemented yet" — they are unfinishable by construction.
 * A player who accepts a quest containing one of them can never complete that
 * quest by any action available in the game. 53 of the 184 seeded steps (29%)
 * are one of these five.
 */
export const DEAD_STEP_TYPES = Object.freeze([
  'investigate', 'deliver', 'escort', 'stealth', 'craft',
]);

/* ====================================================================== */
/* Source scraping                                                        */
/* ====================================================================== */

/**
 * Index of the bracket that closes the one at `open`, skipping strings and
 * comments. Returns -1 when the source is unbalanced.
 * @param {string} src
 * @param {number} open
 */
function matchBracket(src, open) {
  let depth = 0;
  let quote = null, lineComment = false, blockComment = false;
  for (let i = open; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && n === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && n === '/') { lineComment = true; i++; continue; }
    if (c === '/' && n === '*') { blockComment = true; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The same source with every comment blanked out, character for character.
 *
 * Length is preserved (comment bodies become spaces, newlines survive) so every
 * index still lines up with the original file, and STRINGS are untouched so a
 * persona containing "//" is not mangled.
 *
 * Without this, `scanHostiles` read three DOCSTRINGS as spawn records —
 * `medieval/Inhabitants.js:60` and `medieval/Residency.js:91` both discuss
 * `type: 'hostile'` in prose — and concluded the vale spawned nameless
 * `Sentinel N` bandits it has never had. A validator that scrapes prose is
 * measuring the commentary, not the code.
 *
 * @param {string} src
 * @returns {string}
 */
function stripComments(src) {
  const out = src.split('');
  let quote = null, lineComment = false, blockComment = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (lineComment) {
      if (c === '\n') { lineComment = false; continue; }
      out[i] = ' ';
      continue;
    }
    if (blockComment) {
      if (c !== '\n') out[i] = ' ';
      if (c === '*' && n === '/') { out[i + 1] = ' '; blockComment = false; i++; }
      continue;
    }
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && n === '/') { out[i] = ' '; lineComment = true; continue; }
    if (c === '/' && n === '*') { out[i] = ' '; out[i + 1] = ' '; blockComment = true; i++; continue; }
    if (c === "'" || c === '"' || c === '`') quote = c;
  }
  return out.join('');
}

/**
 * The object literal a key sits inside.
 *
 * Used to read the DRESSING off an NPC record — `role`, `isQuestManager` — and
 * to decide whether a hostile spec names itself. A fixed-size window was the
 * first attempt and it was wrong in both directions: 400 characters is shorter
 * than some personas (so a role went unseen) and longer than some records (so
 * the NEXT character's role was read onto this one).
 *
 * The backward search is bounded because in every shape in the repo the opening
 * brace is within a line or two of the key; the forward scan is the full
 * string- and comment-aware matcher.
 *
 * @param {string} src
 * @param {number} at index of a key inside the object
 * @returns {string} the object source, or '' when it cannot be delimited
 */
function objectAround(src, at) {
  const from = Math.max(0, at - 400);
  const open = src.lastIndexOf('{', at);
  if (open < from) return '';
  const close = matchBracket(src, open);
  return close < 0 ? src.slice(open) : src.slice(open, close + 1);
}

/**
 * Split a JS argument list into top-level argument source strings.
 *
 * Needed because the world casts are authored as calls to a local factory
 * (`F('Marek Vaisey', 'persona…', co.length - 60, -(W + 20))`) whose arguments
 * contain commas inside strings, parens and arrays. A naive `split(',')` finds
 * the wrong argument and silently drops half the cast.
 *
 * @param {string} src whole file
 * @param {number} open index of the `(` that starts the list
 * @returns {{args:string[], end:number}|null}
 */
function splitCallArgs(src, open) {
  const args = [];
  let depth = 0, start = open + 1, i = open;
  let quote = null, lineComment = false, blockComment = false;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && n === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && n === '/') { lineComment = true; i++; continue; }
    if (c === '/' && n === '*') { blockComment = true; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0 && c === ')') { args.push(src.slice(start, i)); return { args, end: i }; }
      continue;
    }
    if (c === ',' && depth === 1) { args.push(src.slice(start, i)); start = i + 1; }
  }
  return null;
}

/** The source text of one string literal, unescaped, or null if `s` is not one. */
function asStringLiteral(s) {
  const t = String(s ?? '').trim();
  const m = /^(['"])((?:\\.|(?!\1)[\s\S])*)\1$/.exec(t);
  if (!m) return null;
  return m[2].replace(/\\(['"\\])/g, '$1');
}

/**
 * Names authored as `name: 'X', persona: …` object literals.
 *
 * This is the shape Medieval, Sports, Survey, Maze and every station ZONE use
 * (`ZoneContext.npc(x, z, {name, persona, role, isQuestManager})`), and it is
 * also the shape of the hostile lookup tables — which is why the caller
 * subtracts the hostile set rather than trusting this pass alone.
 * @param {string} src
 * @returns {Array<{name:string, at:number}>}
 */
function scanNamePersonaLiterals(src) {
  const out = [];
  const re = /name:\s*(['"])((?:\\.|(?!\1)[^\n])*)\1\s*,\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*persona\s*:/g;
  for (const m of src.matchAll(re)) {
    out.push({ name: m[2].replace(/\\(['"\\])/g, '$1'), at: m.index ?? 0 });
  }
  return out;
}

/**
 * Names passed to a local NPC factory.
 *
 * Station, Citadel and Race all build their casts through an arrow function
 * that takes `name` and `persona` — but not at the same argument index (Race's
 * takes the circuit first). Rather than hard-coding three positions, the
 * factory's own parameter list is read and `name`'s index taken from it, so a
 * reordered signature moves the scraper with it.
 * @param {string} src
 * @returns {Array<{name:string, at:number, raw:string}>}
 */
function scanFactoryCalls(src) {
  const out = [];
  const sig = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/g;
  for (const m of src.matchAll(sig)) {
    const fn = m[1];
    const params = m[2].split(',').map((s) => s.trim().split(/[\s=:]/)[0]);
    const nameIdx = params.indexOf('name');
    // Both parameters required: it identifies an NPC factory and nothing else.
    if (nameIdx < 0 || params.indexOf('persona') < 0) continue;

    const call = new RegExp(`\\b${fn}\\s*\\(`, 'g');
    for (const c of src.matchAll(call)) {
      const open = (c.index ?? 0) + c[0].length - 1;
      if (open <= (m.index ?? 0)) continue;            // the definition itself
      const parsed = splitCallArgs(src, open);
      if (!parsed) continue;
      const lit = asStringLiteral(parsed.args[nameIdx]);
      if (lit) out.push({ name: lit, at: open, raw: src.slice(open, parsed.end + 1) });
    }
  }
  return out;
}

/**
 * Names authored as a destructured `[name, persona]` tuple.
 *
 * Exactly one cast in the repo does this (the two station promenade walkers,
 * StationWorld.js:10321). The 60-character floor on the second element is what
 * keeps this from matching ordinary pairs of short strings.
 * @param {string} src
 */
function scanTupleCasts(src) {
  const out = [];
  const re = /\[\s*(['"])((?:\\.|(?!\1)[^\n]){3,48})\1\s*,\s*\n?\s*(['"])(?:\\.|(?!\3)[\s\S]){60,}?\3\s*\]/g;
  for (const m of src.matchAll(re)) {
    out.push({ name: m[2].replace(/\\(['"\\])/g, '$1'), at: m.index ?? 0 });
  }
  return out;
}

/**
 * Hostile identities in one file, and whether any of them is UNNAMED.
 *
 * Four shapes, all present in the repo:
 *   1. `type: 'hostile'` followed by a literal `name:` (SportsWorld).
 *   2. A kind table whose entries carry a `weaponId` (StationWorld's
 *      HOSTILE_KIND, reached through the `H()` factory).
 *   3. `type: 'hostile'` with `name: names[i]`, indexing a nearby array of
 *      literals (MedievalWorld's ten bandits).
 *   4. `type: 'hostile'` with NO name at all (CitadelWorld's ring of eight).
 *      `NPCManager` calls those `Sentinel N`, which is the ONLY world where the
 *      token `sentinel` is a reachable kill target.
 * @param {string} src
 * @returns {{names:Set<string>, unnamed:boolean}}
 */
function scanHostiles(src) {
  const names = new Set();
  let unnamed = false;

  for (const m of src.matchAll(/type:\s*'hostile'/g)) {
    const at = m.index ?? 0;
    const record = objectAround(src, at) || src.slice(at, at + 400);
    /* `name` may be a key OR a shorthand property — the construction zone
     * writes `{ type: 'hostile', name, persona, weaponId }` after destructuring
     * its KINDS row, and reading only `name:` called seven named drones
     * nameless and made `sentinel` a station kill target it has never been. */
    if (!/\bname\s*(?::|,|\}|$)/m.test(record)) { unnamed = true; continue; }
    const lit = /name:\s*(['"])((?:\\.|(?!\1)[^\n])*)\1/.exec(record);
    if (lit) { names.add(lit[2]); continue; }
    // `name: names[i]` — resolve the array it indexes.
    const ref = /name:\s*([A-Za-z_$][\w$]*)\s*\[/.exec(record);
    if (!ref) continue;
    const arr = new RegExp(`(?:const|let)\\s+${ref[1]}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(src);
    if (!arr) continue;
    for (const s of arr[1].matchAll(/(['"])((?:\\.|(?!\1)[^\n])*)\1/g)) names.add(s[2]);
  }

  // Kind tables: a name whose entry also names a weapon is a combatant.
  for (const m of src.matchAll(/name:\s*(['"])((?:\\.|(?!\1)[^\n])*)\1[\s\S]{0,600}?weaponId\s*:/g)) {
    names.add(m[2]);
  }
  return { names, unnamed };
}

/**
 * A `const NAME = { … }` object literal whose leaves carry `id: '…'`.
 *
 * `DROP_TABLES` and `CACHE_TABLES` are both `{ worldId: [ {id, …}, … ] }`, so
 * one reader serves both and neither list is copied here.
 * @param {string} rel
 * @param {string} decl
 * @returns {Record<string, string[]>}
 */
function readIdTable(rel, decl) {
  const src = read(rel);
  const at = src.indexOf(`const ${decl} = {`);
  if (at < 0) return {};
  const open = src.indexOf('{', at);
  const close = matchBracket(src, open);
  if (close < 0) return {};
  const literal = src.slice(open, close + 1);
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const m of literal.matchAll(/([A-Za-z_][\w]*)\s*:\s*\[([\s\S]*?)\]/g)) {
    out[m[1]] = [...m[2].matchAll(/id:\s*'([a-z0-9_]+)'/g)].map((x) => x[1]);
  }
  return out;
}

/* ---------------------------------------------------------------------- */
/* What `quests: false` actually turns off                                 */
/* ---------------------------------------------------------------------- */

/**
 * ── THE SECOND FALSE POSITIVE: "listed here" != "advances here" ───────────
 *
 * This file used to reject EVERY step scoped to a `quests: false` world, on the
 * grounds that `QuestSystem` clears its quest list on entry. That conflated two
 * different questions, and measurement in the running game settled it:
 *
 *   world = maze, rules.quests === false, questSystem.worldQuests.length === 0
 *   — and yet engagements.size === 1 and a `survive` step went 0 → 1 in 36 s.
 *
 * `quests: false` gates ACCEPTING and LISTING. It does not stop an ALREADY
 * ACCEPTED engagement from progressing, because `this.engagements` is never
 * cleared and almost every emitter hangs off a bus subscription or the frame
 * loop, neither of which consults a world rule.
 *
 * The rule is therefore per STEP TYPE, and it is derived rather than listed:
 * a type is gated iff EVERY `_advanceSteps('<type>')` call site in
 * `QuestSystem` sits behind the one `allows(world, 'quests')` test in the
 * `world:changed` handler. On the current engine that is `visit` and nothing
 * else — `_creditVisit` is only ever reached from the three places the gate
 * controls (the handler itself, `accept()` via `worldQuests`, and
 * `_loadQuestsForWorld` via the `_pending` flag the gate's early return skips),
 * whereas `_creditSurvive` is called from `update()`, which no rule touches.
 *
 * If somebody moves the gate, adds a second one, or re-grounds a verb on the
 * gated path, {@link readQuestGate} moves with them. It throws rather than
 * guesses when the shapes it reads stop existing.
 */

/**
 * Method bodies of the class in one source file, keyed by method name.
 *
 * Anchored on the two-space indentation a class member has and closed with the
 * string- and comment-aware {@link matchBracket}, so a `if (…) {` four spaces
 * in is not mistaken for a method and a method containing braces inside strings
 * still ends where it really ends.
 *
 * @param {string} src comment-stripped source
 * @returns {Map<string,{open:number, close:number, body:string}>}
 */
function readMethods(src) {
  const out = new Map();
  for (const m of src.matchAll(/^ {2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = matchBracket(src, open);
    if (close < 0) continue;
    out.set(m[1], { open, close, body: src.slice(open, close + 1) });
  }
  return out;
}

/**
 * Every `if (…)` in a function body, with the region it guards.
 *
 * Two regions matter and they are different: the code INSIDE the branch, and —
 * when the branch returns — everything AFTER it, which the branch can skip.
 * `accept()` is the second shape (`if (!quest) { … return; }` above the credit)
 * and `update()` is the first (`if (this._pending && …) { … }` around it), so a
 * rule that only modelled one of them would misread one of the two.
 *
 * @param {string} body
 * @returns {Array<{cond:string, blockFrom:number, blockTo:number, end:number, returns:boolean}>}
 */
function readGuards(body) {
  const out = [];
  for (const m of body.matchAll(/\bif\s*\(/g)) {
    const paren = (m.index ?? 0) + m[0].length - 1;
    const condEnd = matchBracket(body, paren);
    if (condEnd < 0) continue;
    const cond = body.slice(paren + 1, condEnd);
    let i = condEnd + 1;
    while (i < body.length && /\s/.test(body[i])) i++;
    if (body[i] === '{') {
      const end = matchBracket(body, i);
      if (end < 0) continue;
      out.push({ cond, blockFrom: i, blockTo: end, end, returns: /\breturn\b/.test(body.slice(i, end + 1)) });
    } else {
      const semi = body.indexOf(';', i);
      const end = semi < 0 ? body.length : semi;
      out.push({ cond, blockFrom: i, blockTo: end, end, returns: /\breturn\b/.test(body.slice(i, end + 1)) });
    }
  }
  return out;
}

/** True when any of `names` appears as a whole word in `text`. */
function mentionsAny(text, names) {
  for (const n of names) if (new RegExp(`\\b${n}\\b`).test(text)) return true;
  return false;
}

/**
 * Locals a function reads straight out of gate-controlled state.
 *
 * `accept()` does `const quest = this.worldQuests.find(…)` and then guards on
 * `quest`, not on `worldQuests` — so without one level of taint the guard that
 * makes the whole method unreachable in a quest-less world reads as unrelated.
 * @param {string} body
 * @param {Set<string>} controlled
 */
function taintedLocals(body, controlled) {
  const names = new Set();
  const alt = [...controlled].join('|');
  if (!alt) return names;
  const re = new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*[^;\\n]*\\bthis\\.(?:${alt})\\b`, 'g');
  for (const m of body.matchAll(re)) names.add(m[1]);
  return names;
}

/**
 * Which step types the `quests` world rule can actually stop.
 *
 * Derived, in five passes over `src/systems/QuestSystem.js`:
 *
 *  1. find the ONE place the rule is consulted — the `world:changed` handler;
 *  2. read the gate's own block (what it blanks) and the statements its early
 *     `return` SKIPS (what never happens), and take the union of the `this.x`
 *     it writes as the gate-controlled state;
 *  3. mark every call site that is behind that gate: inside the skipped region,
 *     inside a branch whose condition names gate-controlled state, or after a
 *     branch that names it and returns;
 *  4. propagate to whole methods — a method every one of whose call sites is
 *     gated is itself only reachable through the gate — to a fixpoint;
 *  5. a step type is gated iff EVERY literal `_advanceSteps('<type>')` sits in
 *     a gated site or a gated method.
 *
 * A type with no literal call site at all (`talk`, which arrives through
 * `_onActivity`'s dynamic dispatch) is NOT gated: `quest:activity` is a bus
 * subscription and the bus does not read world rules.
 */
function readQuestGate() {
  const rel = 'src/systems/QuestSystem.js';
  const src = stripComments(read(rel));
  const fail = (why) => {
    throw new Error(`[quest-vocab] ${rel}: ${why} — the quests-rule derivation has stopped working`);
  };

  /* 1. The handler that consults the rule. */
  const sub = /bus\.on\(\s*'world:changed'\s*,\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/.exec(src);
  if (!sub) fail("no bus.on('world:changed', … => { … }) subscription");
  const hOpen = sub.index + sub[0].length - 1;
  const hClose = matchBracket(src, hOpen);
  if (hClose < 0) fail('the world:changed handler is unbalanced');
  const handler = src.slice(hOpen, hClose + 1);

  const gate = /if\s*\(\s*!\s*allows\(\s*[A-Za-z_$][\w$]*\s*,\s*'quests'\s*\)\s*\)\s*\{/.exec(handler);
  if (!gate) fail("the world:changed handler no longer tests allows(world, 'quests')");
  const gOpen = gate.index + gate[0].length - 1;
  const gClose = matchBracket(handler, gOpen);
  if (gClose < 0) fail('the quests gate block is unbalanced');
  const gateBlock = handler.slice(gOpen, gClose + 1);
  if (!/\breturn\b/.test(gateBlock)) fail('the quests gate no longer returns early');

  /* 2. Gate-controlled state: what the gate blanks, plus what its early return
   *    stops from ever being set. */
  const skippedFrom = hOpen + gClose + 1;
  const skippedTo = hClose;
  const skipped = src.slice(skippedFrom, skippedTo);
  const controlled = new Set();
  const cleared = [];
  for (const m of gateBlock.matchAll(/this\.([A-Za-z_$][\w$]*)\s*=[^=]/g)) {
    controlled.add(m[1]);
    cleared.push(m[1]);
  }
  for (const m of skipped.matchAll(/this\.([A-Za-z_$][\w$]*)\s*=[^=]/g)) controlled.add(m[1]);
  if (!controlled.size) fail('the quests gate changes no state at all');

  /* 3. Per-call-site gating. */
  const methods = readMethods(src);
  if (methods.size < 10) fail(`only ${methods.size} class methods parsed`);

  const methodAt = (i) => {
    for (const [name, m] of methods) if (i > m.open && i < m.close) return name;
    return null;
  };

  /** @type {Map<string,{list:ReturnType<typeof readGuards>, names:Set<string>}>} */
  const guards = new Map();
  for (const [name, m] of methods) {
    guards.set(name, {
      list: readGuards(m.body),
      names: new Set([...controlled, ...taintedLocals(m.body, controlled)]),
    });
  }

  const gatedSite = (i) => {
    if (i >= skippedFrom && i < skippedTo) return true;
    const name = methodAt(i);
    if (!name) return false;
    const m = methods.get(name);
    const g = guards.get(name);
    const off = i - m.open;
    for (const guard of g.list) {
      if (!mentionsAny(guard.cond, g.names)) continue;
      if (off > guard.blockFrom && off < guard.blockTo) return true;
      if (guard.returns && off > guard.end) return true;
    }
    return false;
  };

  /* 4. Methods every one of whose call sites is gated. A method with NO call
   *    site inside the class is an entry point — main.js drives `update`, the
   *    UI drives `accept`, the bus drives the handlers — so it is never gated
   *    by absence. */
  /** @type {Map<string, Array<{at:number, in:string|null, gated:boolean}>>} */
  const callSites = new Map();
  for (const m of src.matchAll(/this\.([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (!methods.has(m[1])) continue;
    const at = m.index ?? 0;
    const list = callSites.get(m[1]) ?? [];
    list.push({ at, in: methodAt(at), gated: gatedSite(at) });
    callSites.set(m[1], list);
  }

  const gatedMethods = new Set();
  for (let pass = 0; pass <= methods.size; pass++) {
    let changed = false;
    for (const name of methods.keys()) {
      if (gatedMethods.has(name)) continue;
      const sites = callSites.get(name);
      if (!sites?.length) continue;
      if (sites.every((s) => s.gated || (s.in && gatedMethods.has(s.in)))) {
        gatedMethods.add(name);
        changed = true;
      }
    }
    if (!changed) break;
  }

  /* 5. Step types. */
  /** @type {Map<string, Array<{owner:string|null, gated:boolean}>>} */
  const typeSites = new Map();
  for (const m of src.matchAll(/_advanceSteps\(\s*'([a-z_]+)'/g)) {
    const at = m.index ?? 0;
    const owner = methodAt(at);
    const list = typeSites.get(m[1]) ?? [];
    list.push({ owner, gated: gatedSite(at) || (!!owner && gatedMethods.has(owner)) });
    typeSites.set(m[1], list);
  }
  if (!typeSites.size) fail("no literal _advanceSteps('<type>') call sites found");

  const gatedTypes = [];
  /** @type {Record<string,string>} */
  const evidence = {};
  for (const [type, list] of typeSites) {
    if (!list.every((s) => s.gated)) continue;
    gatedTypes.push(type);
    evidence[type] = [...new Set(list.map((s) => s.owner ?? '(top level)'))].join(', ');
  }
  for (const t of gatedTypes) {
    if (!WORKING_STEP_TYPES.includes(t)) fail(`derived a gated type "${t}" that has no emitter entry`);
  }

  return Object.freeze({
    file: rel,
    /** Fields the gate blanks on entry — the quest LIST, and nothing else. */
    clears: Object.freeze([...new Set(cleared)]),
    /** Every `this.x` the gate controls, blanked or never set. */
    controlled: Object.freeze([...controlled].sort()),
    /** Methods reachable only through the gate. */
    gatedMethods: Object.freeze([...gatedMethods].sort()),
    /** Step types the `quests` rule can actually stop. */
    gatedTypes: Object.freeze(gatedTypes.sort()),
    /** Which method credits each gated type. */
    evidence: Object.freeze(evidence),
  });
}

export const QUEST_GATE = readQuestGate();

/**
 * Step types a `quests: false` world genuinely cannot advance.
 *
 * Derived by {@link readQuestGate}. Currently `['visit']`: the world entry that
 * would credit it is the very thing the gate returns out of.
 */
export const GATED_STEP_TYPES = QUEST_GATE.gatedTypes;

/**
 * Step types that keep advancing in a `quests: false` world.
 *
 * Everything else — `survive` from the un-gated `update()` timer, and every
 * type whose emitter is a bus subscription. Whether a given world can actually
 * PRODUCE one is a separate question, and the per-world candidate model answers
 * it: the maze permits no hostiles, loot, caches, merchants or races, so those
 * types still resolve to nothing there and are still rejected — by the rule
 * that governs them, not by the quest rule.
 */
export const UNGATED_STEP_TYPES = Object.freeze(
  WORKING_STEP_TYPES.filter((t) => !GATED_STEP_TYPES.includes(t)),
);

/* ---------------------------------------------------------------------- */
/* The engine's own numbers                                                */
/* ---------------------------------------------------------------------- */

/**
 * The spawn arithmetic, read out of `NPCManager` and `Config` rather than
 * copied.
 *
 * The FORMULA in {@link spawnPlan} is mirrored the same way the matcher is —
 * deliberately, with this comment on both — because it cannot be imported: it
 * lives inside `spawnForWorld`, which needs a Three.js scene and a physics
 * world to run. The NUMBERS it uses are all scraped, so re-tuning a budget
 * moves this file with it.
 */
function readSpawnLimits() {
  const npcSrc = read('src/npc/NPCManager.js');
  const cfgSrc = read('src/core/Config.js');
  const num = (src, re, label) => {
    const m = re.exec(src);
    if (!m) throw new Error(`[quest-vocab] could not scrape ${label} — NPCManager/Config changed shape`);
    return Number(m[1]);
  };
  return Object.freeze({
    maxNPCs: num(npcSrc, /this\.maxNPCs\s*=\s*(\d+)/, 'maxNPCs'),
    hostileCeiling: num(npcSrc, /const HOSTILE_CEILING\s*=\s*(\d+)/, 'HOSTILE_CEILING'),
    crowdReserve: num(npcSrc, /const CROWD_RESERVE\s*=\s*crowdAllowed\s*\?\s*(\d+)/, 'CROWD_RESERVE'),
    authoredFloor: num(npcSrc, /const authoredCap\s*=\s*crowdAllowed\s*\n?\s*\?\s*Math\.max\((\d+)/, 'authoredCap floor'),
    friendlyFloor: num(npcSrc, /this\.maxFriendlies\s*=\s*Math\.max\(CONFIG\.npc\.friendlyCount,\s*(\d+)\)/, 'maxFriendlies floor'),
    hostileCount: num(cfgSrc, /hostileCount:\s*(\d+)/, 'CONFIG.npc.hostileCount'),
    friendlyCount: num(cfgSrc, /friendlyCount:\s*(\d+)/, 'CONFIG.npc.friendlyCount'),
  });
}

export const SPAWN_LIMITS = readSpawnLimits();

/** `THEME_BY_WORLD`, which decides WHICH `ROLE_CAST` the crowd filler reads. */
function readThemes() {
  const src = read('src/npc/NPCManager.js');
  const at = src.indexOf('const THEME_BY_WORLD = {');
  const out = new Map();
  if (at < 0) return out;
  const open = src.indexOf('{', at);
  const close = matchBracket(src, open);
  for (const m of src.slice(open, close + 1).matchAll(/([a-z_]+)\s*:\s*'([a-z_]+)'/g)) out.set(m[1], m[2]);
  return out;
}

const THEMES = readThemes();
/** `castFor` falls back to the station cast for any theme it does not know. */
const CAST_FALLBACK_THEME = /ROLE_CAST\[theme\]\s*\?\?\s*ROLE_CAST\.([a-z]+)/
  .exec(read('src/npc/NPCRoles.js'))?.[1] ?? 'station';

/* ---------------------------------------------------------------------- */
/* Worlds                                                                  */
/* ---------------------------------------------------------------------- */

/**
 * Every World subclass, read from the `static id` the engine itself keys on,
 * together with everything its OWN sources author.
 *
 * "Its own sources" is the world file plus `src/worlds/<id>/**` — the station's
 * four zone builders live there and between them author 24 of the station's 42
 * civilians and FOUR of its six quest desks. Reading only `StationWorld.js` is
 * how the previous version came to believe the station had two quest managers
 * and 18 named NPCs.
 *
 * The base class is excluded by its id (`base`) rather than by filename, so a
 * world added in a differently-named file is still picked up.
 */
function buildWorlds() {
  const dir = path.join(REPO_ROOT, 'src', 'worlds');
  const worlds = new Map();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const rel = `src/worlds/${file}`;
    const src = read(rel);
    const id = /static\s+id\s*=\s*'([^']+)'/.exec(src)?.[1];
    if (!id || id === 'base') continue;
    const displayName = /static\s+displayName\s*=\s*'([^']+)'/.exec(src)?.[1] ?? id;

    // Capability flags. `makeRules` defaults everything to permitted, so a
    // world with no override block permits everything — same as the engine.
    const rulesBlock = /makeRules\(\{([\s\S]*?)\}\)/.exec(src)?.[1] ?? '';
    const rule = (key) => !new RegExp(`\\b${key}\\s*:\\s*false`).test(rulesBlock);

    const ownFiles = [rel, ...walkJs(`src/worlds/${id}`)];

    /** @type {Map<string, {name:string, role:string|null, questManager:boolean, file:string}>} */
    const friendly = new Map();
    const hostiles = new Set();
    let unnamedHostiles = false;
    /** Roles this world's own code can put on an NPC, streamed or authored. */
    const ownRoles = new Set();
    /** Interior stash tiers this world authors. */
    const tiers = new Set();
    let authorsStashes = false;
    let publishesTrack = false;

    for (const f of ownFiles) {
      /* Comments blanked, strings kept. Everything below scrapes CODE; a
       * docstring that merely mentions `type: 'hostile'` or `role: 'guard'` is
       * describing the engine, not populating a world. */
      const text = stripComments(f === rel ? src : read(f));
      const found = scanHostiles(text);
      for (const h of found.names) hostiles.add(h);
      unnamedHostiles = unnamedHostiles || found.unnamed;

      /** @param {string} name @param {string} record */
      const remember = (name, record) => {
        const role = /\brole\s*:\s*'([a-z_]+)'/.exec(record)?.[1] ?? null;
        const questManager = /isQuestManager\s*:\s*true/.test(record);
        const prev = friendly.get(name);
        friendly.set(name, {
          name,
          role: role ?? prev?.role ?? null,
          questManager: questManager || !!prev?.questManager,
          file: f,
        });
      };

      for (const hit of [...scanNamePersonaLiterals(text), ...scanTupleCasts(text)]) {
        remember(hit.name, objectAround(text, hit.at));
      }
      for (const hit of scanFactoryCalls(text)) remember(hit.name, hit.raw);

      /* Roles the world's own population code hands out.
       *
       * Not only `role: 'x'` on an authored spec: MedievalWorld's residency
       * STREAMS its people and picks their roles in `medieval/Population.js`
       * (`roleOrder` pushes the literals, `planSettlement` reads them back with
       * `role === 'vendor'`). Those NPCs are real and permanent-ish, so their
       * roles are reachable even though their generated NAMES never are. */
      for (const r of Object.values(ROLE)) {
        if (new RegExp(`\\brole\\w*\\s*(?::|===|==|=)\\s*'${r}'`).test(text)
          || new RegExp(`push\\('${r}'\\)`).test(text)) ownRoles.add(r);
      }

      if (/collectibleSpots/.test(text) || /\bctx\.relic\(/.test(text)) authorsStashes = true;
      for (const m of text.matchAll(/\btier\b/g)) {
        const window = text.slice(m.index ?? 0, (m.index ?? 0) + 90);
        for (const q of window.matchAll(/'([a-z]+)'/g)) tiers.add(q[1]);
      }
      for (const m of text.matchAll(/\bctx\.relic\(([^)]*)\)/g)) {
        for (const q of m[1].matchAll(/'([a-z]+)'/g)) tiers.add(q[1]);
      }
      if (/\btrackPath\s*[:=]/.test(text)) publishesTrack = true;
    }

    for (const h of hostiles) friendly.delete(h);

    // Budgets a world declares for itself, `this.x = 50` or `world.x = CONST`.
    const budget = (key) => {
      for (const f of ownFiles) {
        const text = stripComments(f === rel ? src : read(f));
        const m = new RegExp(`\\b(?:this|world)\\.${key}\\s*=\\s*([A-Za-z_$][\\w$]*|\\d+)`).exec(text);
        if (!m) continue;
        if (/^\d+$/.test(m[1])) return Number(m[1]);
        const c = new RegExp(`(?:export\\s+)?const\\s+${m[1]}\\s*=\\s*(\\d+)`).exec(text);
        if (c) return Number(c[1]);
      }
      return null;
    };

    worlds.set(id, {
      id,
      displayName,
      file: rel,
      files: ownFiles,
      theme: THEMES.get(id) ?? CAST_FALLBACK_THEME,
      themed: THEMES.has(id),
      rules: {
        quests: rule('quests'),
        crowd: rule('crowd'),
        merchants: rule('merchants'),
        hostiles: rule('hostiles'),
        races: rule('races'),
        loot: rule('loot'),
        caches: rule('caches'),
        interiors: rule('interiors'),
      },
      /** Portal destinations authored in this world, resolved below. */
      portalTargets: [...new Set([...src.matchAll(/target:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]))],
      /** Every authored friendly, in scrape order — world file first. */
      cast: [...friendly.values()],
      friendlyNames: [...friendly.keys()].sort(),
      hostileNames: [...hostiles].sort(),
      unnamedHostiles,
      ownRoles: [...ownRoles].sort(),
      stashTiers: authorsStashes ? [...tiers].filter((t) => ['common', 'rare', 'prize'].includes(t)) : [],
      publishesTrack,
      friendlyBudget: budget('friendlyBudget'),
      hostileBudget: budget('hostileBudget'),
    });
  }

  // A portal target is only real if it names a world that exists.
  for (const w of worlds.values()) w.portalTargets = w.portalTargets.filter((t) => worlds.has(t) && t !== w.id);
  return worlds;
}

const WORLDS = buildWorlds();

/* ---------------------------------------------------------------------- */
/* Quest managers                                                          */
/* ---------------------------------------------------------------------- */

/**
 * The one NPC per world that `NPCManager` plants itself.
 *
 * Read out of `NPCManager._spawnQuestManagers`'s own `CAST` table rather than
 * copied. This is NOT the whole list: `NPCManager.js:742` honours
 * `isQuestManager: spec.isQuestManager === true` off any authored spawn, and
 * the station authors four more in its zones plus Dispatcher Ovie Kanu on the
 * strip — SIX quest desks, not one. Those come out of the cast scrape above.
 * @returns {Map<string, string>} world id → NPC name
 */
function buildQuestManagers() {
  const src = read('src/npc/NPCManager.js');
  const fn = src.indexOf('_spawnQuestManagers(');
  const castAt = src.indexOf('const CAST = {', fn);
  const out = new Map();
  if (fn < 0 || castAt < 0) return out;
  const block = src.slice(castAt, src.indexOf('\n    };', castAt));
  for (const m of block.matchAll(/^\s{6}([a-z_]+):\s*\{[\s\S]{0,120}?name:\s*'([^']+)'/gm)) {
    out.set(m[1], m[2]);
  }
  return out;
}

const QUEST_MANAGERS = buildQuestManagers();

/* ---------------------------------------------------------------------- */
/* Race identity                                                           */
/* ---------------------------------------------------------------------- */

/** `RACE_TYPES` as RaceManager declares it, without importing the manager. */
function buildRaceTypes() {
  const src = read('src/race/RaceManager.js');
  const block = /export const RACE_TYPES = \{([^}]*)\}/.exec(src)?.[1] ?? '';
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

const RACE_TYPES = buildRaceTypes();

/**
 * Placings, exactly as `_eventTargetCandidates` namespaces them.
 *
 * The bare integer is deliberately absent. Pushing `1` is what made
 * `qualifier_round1` and `vellum500_stint1` complete on any P1 finish under the
 * old substring matcher; the engine now pushes `place_1`/`p1`/`1st`/`first` and
 * so does this list.
 */
const PLACE_TOKENS = (() => {
  const labels = ['1st', '2nd', '3rd', '4th', '5th', '6th'];
  const words = ['first', 'second', 'third'];
  const out = [];
  for (let p = 1; p <= 6; p++) {
    out.push(`place_${p}`, `p${p}`, labels[p - 1]);
    if (words[p - 1]) out.push(words[p - 1]);
  }
  return out;
})();

/* ====================================================================== */
/* The spawn model — who actually gets a body                             */
/* ====================================================================== */

/**
 * `NPCManager.spawnForWorld`'s budget arithmetic, for one world.
 *
 * MIRRORED, not imported, for the same reason the matcher is: `spawnForWorld`
 * needs a scene, a physics world and a Three.js runtime, none of which a
 * content test has. Every NUMBER in it is scraped ({@link SPAWN_LIMITS}) so a
 * re-tune moves this with it; only the shape of the formula is duplicated, and
 * this comment is the flag that says so.
 *
 * The output that matters is `fillerSlots` — what is LEFT for
 * `_populateHubs` after the world's own cast and the gateway lorekeepers have
 * been paid for. On the station that residual is 2 out of 50.
 *
 * @param {object} world
 */
function spawnPlan(world) {
  const L = SPAWN_LIMITS;
  const crowd = world.rules.crowd;
  const hostilesAllowed = world.rules.hostiles;

  const askedH = Number.isFinite(world.hostileBudget) ? world.hostileBudget : L.hostileCount;
  const maxHostiles = hostilesAllowed ? Math.max(0, Math.min(L.hostileCeiling, askedH)) : 0;

  const defaultFriendly = Math.max(L.friendlyCount, L.friendlyFloor);
  const askedF = Number.isFinite(world.friendlyBudget) ? world.friendlyBudget : defaultFriendly;
  const friendlyBudget = Math.max(0, Math.min(L.maxNPCs - maxHostiles, askedF));

  const authored = world.cast.length;
  const reserve = crowd ? L.crowdReserve : 0;
  const authoredCap = crowd
    ? Math.max(L.authoredFloor, Math.min(authored, friendlyBudget - reserve))
    : authored;
  const authoredSpawned = Math.min(authored, authoredCap);

  /* One lorekeeper per portal spec, added by the manager, and they are paid
   * for out of the same budget — `friendlyCount += this._spawnLorekeepers(world)`
   * runs BEFORE `_populateHubs` is handed its budget. */
  const lorekeepers = crowd ? world.portalTargets.length : 0;

  const fillerSlots = crowd ? Math.max(0, friendlyBudget - authoredSpawned - lorekeepers) : 0;
  const questDesk = QUEST_MANAGERS.has(world.id) ? 1 : 0;
  const bodies = authoredSpawned + lorekeepers + questDesk + maxHostiles + fillerSlots;

  return {
    friendlyBudget,
    maxHostiles,
    authored,
    authoredCap,
    authoredSpawned,
    /** Authored friendlies the cap DROPS. `spawnForWorld` walks in order. */
    authoredDropped: Math.max(0, authored - authoredCap),
    lorekeepers,
    fillerSlots,
    bodies,
    /** True when the world would hit `maxNPCs` before the filler runs. */
    overCeiling: bodies > L.maxNPCs,
  };
}

/** @type {Map<string, ReturnType<typeof spawnPlan>>} */
const SPAWN_PLANS = new Map([...WORLDS].map(([id, w]) => [id, spawnPlan(w)]));

/**
 * The filler slot index at which `castFor(theme, role, index)` is reached.
 *
 * `_populateHubs` deals `ROLE_ROTATION[nameIdx % length]` to filled slot
 * `nameIdx`, and keeps a per-role counter that indexes into `ROLE_CAST`. So the
 * n-th named character of a role appears at the n-th occurrence of that role in
 * the repeating rotation.
 * @param {string} role
 * @param {number} index
 * @returns {number} 0-based slot, or Infinity
 */
function fillerSlotFor(role, index) {
  let seen = 0;
  const limit = ROLE_ROTATION.length * (index + 2);
  for (let i = 0; i < limit; i++) {
    if (ROLE_ROTATION[i % ROLE_ROTATION.length] !== role) continue;
    if (seen === index) return i;
    seen++;
  }
  return Infinity;
}

/**
 * How much filler budget a world must have before ANY of its filler names is
 * treated as a dependable quest target.
 *
 * One whole rotation cycle. The argument is not a safety fudge, it is what the
 * rotation means: `ROLE_ROTATION` is the unit in which `_populateHubs` deals
 * jobs out, and a residual smaller than one cycle has not given every role in
 * it a single turn. Which names appear then depends entirely on where the
 * residual happened to land — and the residual is
 * `friendlyBudget − authoredFriendlies − lorekeepers`, so it moves every time
 * anybody adds one civilian to a zone builder.
 *
 * The station's residual is 2 of 50. A quest that targets a name held in those
 * two slots is a quest that breaks when a world author adds a bench-sitter, and
 * `_populateHubs` is best-effort even then: it needs anchors, a hub whose
 * snapped centre is within 4 m of the hub plane and a successful
 * `_findStandingSpot`, and it abandons the attempt after 60 passes.
 */
const FILLER_CYCLE = ROLE_ROTATION.length;

/**
 * Named characters the crowd filler can be relied on to produce in `world`.
 * @param {object} world
 * @returns {Array<{name:string, role:string, slot:number}>}
 */
function fillerNamesFor(world) {
  const plan = SPAWN_PLANS.get(world.id);
  if (!plan || plan.overCeiling) return [];
  if (plan.fillerSlots < FILLER_CYCLE) return [];
  const byRole = ROLE_CAST[world.theme] ?? ROLE_CAST[CAST_FALLBACK_THEME] ?? {};
  const out = [];
  for (const [role, list] of Object.entries(byRole)) {
    list.forEach((entry, i) => {
      const slot = fillerSlotFor(role, i);
      if (slot < plan.fillerSlots) out.push({ name: entry.name, role, slot });
    });
  }
  return out;
}

/** Roles the crowd filler can be relied on to hand out in `world`. */
function fillerRolesFor(world) {
  const plan = SPAWN_PLANS.get(world.id);
  if (!plan || plan.overCeiling) return [];
  if (plan.fillerSlots < FILLER_CYCLE) return [];
  const out = new Set();
  for (let i = 0; i < plan.fillerSlots; i++) out.add(ROLE_ROTATION[i % ROLE_ROTATION.length]);
  return [...out];
}

/**
 * Every NPC that is GUARANTEED a body in `world`, with the role it carries and
 * whether it opens a quest board.
 *
 * Three guaranteed sources, and only three:
 *   • the first `authoredCap` friendlies of `world.npcSpawns` — `spawnForWorld`
 *     walks the array in order and `continue`s past everything after the cap;
 *   • `NPCManager._spawnQuestManagers`, which plants its own cast entry;
 *   • the crowd filler, but only where its budget clears {@link FILLER_CYCLE}.
 *
 * Streamed populations are deliberately absent. `MedievalResidency` calls
 * `spawnOne` for people whose names come from a seeded planner at run time
 * (`medieval/Population.js nameFor`), so those names exist in no source file
 * and cannot be written into content.
 *
 * @param {object} world
 * @returns {Array<{name:string, role:string, questManager:boolean, source:string}>}
 */
function residentsOf(world) {
  const plan = SPAWN_PLANS.get(world.id);
  const out = [];
  const seen = new Set();
  const add = (name, role, questManager, source) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({ name, role, questManager, source });
  };

  const authored = world.cast.slice(0, plan.authoredCap);
  for (const c of authored) {
    // `NPCManager.spawnForWorld`: `role: spec.role ?? ROLE.WANDERER` for every
    // friendly that does not name one.
    add(c.name, c.role ?? ROLE.WANDERER, c.questManager, `${c.file} authored cast`);
  }

  const desk = QUEST_MANAGERS.get(world.id);
  if (desk) add(desk, ROLE.QUEST_MANAGER, true, 'src/npc/NPCManager._spawnQuestManagers');

  for (const f of fillerNamesFor(world)) {
    add(f.name, f.role, false,
      `src/npc/NPCRoles.js ROLE_CAST.${world.theme} via _populateHubs slot ${f.slot} of ${plan.fillerSlots}`);
  }
  return out;
}

/** @type {Map<string, ReturnType<typeof residentsOf>>} */
const RESIDENTS = new Map([...WORLDS].map(([id, w]) => [id, residentsOf(w)]));

/**
 * Roles an NPC in `world` actually carries.
 *
 * Not `Object.values(ROLE)`. Every authored `role:` on the station is `vendor`
 * or `quest_manager`; nothing there is a `guard`, and the two filler slots it
 * has left are not enough to make one dependable. A `talk` step targeting
 * `guard` on the station is a step no player can ever advance.
 * @param {object} world
 */
function rolesOf(world) {
  const out = new Set();
  for (const r of RESIDENTS.get(world.id) ?? []) out.add(r.role);
  /* Roles the world's own population code produces, including for people it
   * streams in rather than authors — see `ownRoles` in buildWorlds. */
  for (const r of world.ownRoles) out.add(r);
  // One lorekeeper per portal, added by `_spawnLorekeepers` when crowd is on.
  if (world.rules.crowd && world.portalTargets.length) out.add(ROLE.LOREKEEPER);
  for (const r of fillerRolesFor(world)) out.add(r);
  return [...out];
}

/** @type {Map<string, string[]>} */
const WORLD_ROLES = new Map([...WORLDS].map(([id, w]) => [id, rolesOf(w)]));

/* ====================================================================== */
/* Collectables — what a pickup in this world can actually contain        */
/* ====================================================================== */

const DROP_TABLES = readIdTable('src/systems/Loot.js', 'DROP_TABLES');
const CACHE_TABLES = readIdTable('src/systems/Caches.js', 'CACHE_TABLES');

/** `DROP_TABLES[world] ?? DROP_TABLES.station` — the fallback the engine uses. */
const DROP_FALLBACK = /DROP_TABLES\[this\._worldId\]\s*\?\?\s*DROP_TABLES\.([a-z]+)/
  .exec(read('src/systems/Loot.js'))?.[1] ?? 'station';
const CACHE_FALLBACK = /CACHE_TABLES\[this\._worldId\]\s*\?\?\s*CACHE_TABLES\.([a-z]+)/
  .exec(read('src/systems/Caches.js'))?.[1] ?? 'station';

/** Credits ride on every corpse drop — `Loot._dropFor` pushes them first. */
const DROP_GUARANTEED = [...read('src/systems/Loot.js')
  .slice(read('src/systems/Loot.js').indexOf('_dropFor(npc)'))
  .slice(0, 600)
  .matchAll(/itemId:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]);

/**
 * `Interiors._contentsFor`, per tier. Authored stashes are the ONLY source of
 * `relic_coin` on the station and in `sports`, `citadel` and `race`.
 */
function readStashTiers() {
  const src = read('src/systems/Interiors.js');
  const at = src.indexOf('_contentsFor(tier)');
  if (at < 0) return {};
  const body = src.slice(at, matchBracket(src, src.indexOf('{', at)) + 1);
  const items = (chunk) => [...chunk.matchAll(/itemId:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]);
  /** @type {Record<string, string[]>} */
  const out = {};
  const guards = [...body.matchAll(/tier === '([a-z]+)'/g)];
  for (let i = 0; i < guards.length; i++) {
    const start = guards[i].index ?? 0;
    const end = i + 1 < guards.length ? (guards[i + 1].index ?? body.length) : body.length;
    out[guards[i][1]] = items(body.slice(start, end));
  }
  // Whatever the function returns after the last guard is the common tier.
  const tail = guards.length ? body.slice(body.lastIndexOf('return [')) : body;
  out.common = items(tail);
  return out;
}

const STASH_TIERS = readStashTiers();

/**
 * Every item a `loot:collected` event in `world` can carry.
 *
 * Three sources, each gated on the rule that governs it AND on the world
 * actually having the thing:
 *   • corpse drops  `Loot._dropFor`, only where the world authors hostiles;
 *   • caches        `Caches._roll`, gated on `rules.caches`;
 *   • interior stashes `Interiors._contentsFor`, gated on `rules.interiors`
 *     and on the world authoring `collectibleSpots` / `ctx.relic`.
 *
 * @param {object} world
 * @returns {Array<{value:string, kind:string, source:string}>}
 */
function collectablesOf(world) {
  const out = [];
  const add = (value, kind, source) => out.push({ value, kind, source });

  const hasHostiles = world.rules.hostiles
    && (world.hostileNames.length > 0 || world.unnamedHostiles);
  if (world.rules.loot && hasHostiles) {
    for (const id of DROP_GUARANTEED) add(id, 'item', 'src/systems/Loot.js _dropFor guaranteed');
    const table = DROP_TABLES[world.id] ?? DROP_TABLES[DROP_FALLBACK] ?? [];
    const label = DROP_TABLES[world.id] ? world.id : `${DROP_FALLBACK} (fallback — no ${world.id} entry)`;
    for (const id of table) add(id, 'item', `src/systems/Loot.js DROP_TABLES.${label}`);
  }

  if (world.rules.caches) {
    const table = CACHE_TABLES[world.id] ?? CACHE_TABLES[CACHE_FALLBACK] ?? [];
    const label = CACHE_TABLES[world.id] ? world.id : `${CACHE_FALLBACK} (fallback — no ${world.id} entry)`;
    for (const id of table) add(id, 'item', `src/systems/Caches.js CACHE_TABLES.${label}`);
  }

  if (world.rules.interiors && world.stashTiers.length) {
    for (const tier of world.stashTiers) {
      for (const id of STASH_TIERS[tier] ?? []) {
        add(id, 'item', `src/systems/Interiors.js _contentsFor('${tier}')`);
      }
    }
  }
  return out;
}

/** @type {Map<string, ReturnType<typeof collectablesOf>>} */
const COLLECTABLES = new Map([...WORLDS].map(([id, w]) => [id, collectablesOf(w)]));

/* ====================================================================== */
/* The vocabulary                                                          */
/* ====================================================================== */

/**
 * Worlds a quest can be LISTED and ACCEPTED in.
 *
 * This is the `quests` rule and nothing else. `_loadQuestsForWorld` is only
 * reached through the flag the gate's early return skips, and `accept()` can
 * only find a quest in `worldQuests`, which the gate empties — so a quest whose
 * OWN `world` is quest-less is a quest that reaches no board.
 */
const QUEST_WORLDS = [...WORLDS.values()].filter((w) => w.rules.quests).map((w) => w.id);

/**
 * Worlds a STEP may be scoped to — every registered world, quest rule or not.
 *
 * `_advanceSteps` gates a step on `step.world !== this._worldId` and on nothing
 * else, and `this._worldId` is assigned BEFORE the quests gate returns. An
 * engagement accepted on a quest-enabled board therefore keeps advancing its
 * un-gated steps after the player walks into a quest-less world — measured in
 * the running game: `engagements.size === 1` and a maze-scoped `survive` step
 * went 0 → 1 while `worldQuests.length === 0`.
 *
 * Which types survive the trip is {@link GATED_STEP_TYPES}, derived from the
 * engine; which of them the world can actually produce is the ordinary
 * per-world candidate model.
 */
const STEP_WORLDS = [...WORLDS.keys()];

/**
 * Everything a step may name, grouped by where it came from.
 *
 * `worlds` is now the primary entry: nothing outside it is a complete answer,
 * because nothing outside it knows which world the player is standing in.
 */
export const VOCAB = Object.freeze({
  worlds: Object.fromEntries([...WORLDS].map(([id, w]) => [id, Object.freeze({
    ...w,
    spawns: SPAWN_PLANS.get(id),
    residents: RESIDENTS.get(id),
    reachableRoles: WORLD_ROLES.get(id),
    collectables: [...new Set(COLLECTABLES.get(id).map((c) => c.value))],
    questManagers: (RESIDENTS.get(id) ?? []).filter((r) => r.questManager).map((r) => r.name),
  })])),
  /** Worlds a QUEST may belong to — the `quests` rule. */
  questWorlds: QUEST_WORLDS,
  /** Worlds a STEP may be scoped to — every world, because steps are not gated. */
  stepWorlds: STEP_WORLDS,
  /** Step types the `quests` rule can stop, derived from QuestSystem. */
  gatedStepTypes: GATED_STEP_TYPES,
  /** Step types that keep advancing in a quests:false world. */
  ungatedStepTypes: UNGATED_STEP_TYPES,
  /** The derivation itself, so a test can prove the scrape still works. */
  questGate: QUEST_GATE,
  items: Object.keys(ITEMS),
  packs: PACKS.map((p) => p.id),
  circuits: CIRCUITS.map((c) => ({ id: c.id, name: c.name })),
  raceTypes: RACE_TYPES,
  placeTokens: PLACE_TOKENS,
  roles: Object.values(ROLE),
  /** `NPCManager._spawnQuestManagers` only. Worlds author more; see `worlds`. */
  questManagers: Object.fromEntries(QUEST_MANAGERS),
  roleCastByTheme: Object.fromEntries(
    Object.entries(ROLE_CAST).map(([theme, byRole]) => [
      theme,
      Object.values(byRole).flat().map((c) => c.name),
    ]),
  ),
  roleRotation: [...ROLE_ROTATION],
  fillerCycle: FILLER_CYCLE,
  spawnLimits: SPAWN_LIMITS,
  dropTables: DROP_TABLES,
  cacheTables: CACHE_TABLES,
  stashTiers: STASH_TIERS,
  character: {
    sex: Object.keys(SEX_PROFILES),
    outfit: Object.keys(OUTFITS),
    hairStyle: [...HAIR_STYLE_IDS],
    headgear: [...HEADGEAR_STYLES],
    build: ['slim', 'average', 'heavy', 'build_0', 'build_1', 'build_2'],
  },
  /** Trade `kind`, which `market:trade` puts on the event. */
  tradeKinds: ['buy', 'sell'],
});

/** Quest-manager names in one world — the only valid `interact` NPC targets. */
export function questManagersFor(worldId) {
  return (RESIDENTS.get(worldId) ?? []).filter((r) => r.questManager).map((r) => r.name);
}

/** Every NPC guaranteed a body in one world. */
export function residentsFor(worldId) {
  return [...(RESIDENTS.get(worldId) ?? [])];
}

/** Roles an NPC in one world actually carries. */
export function rolesFor(worldId) {
  return [...(WORLD_ROLES.get(worldId) ?? [])];
}

/** The spawn-budget arithmetic for one world. */
export function spawnPlanFor(worldId) {
  return SPAWN_PLANS.get(worldId) ?? null;
}

/**
 * One thing the engine can put in the candidate list for a step type.
 * @typedef {{value:string, kind:string, source:string}} Candidate
 */

/**
 * Every candidate `_eventTargetCandidates` can produce for `type`, in `world`.
 *
 * The world argument is NOT optional any more. `_advanceSteps` refuses to touch
 * a step whose `world` differs from the world the player is in, and half the
 * vocabulary — every NPC name, every role, every collectable item — differs
 * between worlds. A world-less answer is the bug this file was rebuilt to
 * remove, so it returns nothing rather than a union that would validate
 * "Quartermaster Bex" on the station because she stands in the race paddock.
 *
 * @param {string} type
 * @param {string|null} worldId
 * @returns {Candidate[]}
 */
export function candidatesFor(type, worldId = null) {
  const world = worldId ? WORLDS.get(worldId) ?? null : null;
  if (!world) return [];
  const residents = RESIDENTS.get(world.id) ?? [];
  const roles = WORLD_ROLES.get(world.id) ?? [];
  const out = [];
  const add = (value, kind, source) => {
    if (value == null || value === '') return;
    out.push({ value: String(value), kind, source });
  };

  switch (type) {
    case 'visit':
    case 'survive': {
      // The event carries the current world id and nothing else.
      add(world.id, 'world', `${world.file} static id`);
      break;
    }

    case 'collect': {
      for (const c of COLLECTABLES.get(world.id) ?? []) add(c.value, c.kind, c.source);
      break;
    }

    case 'talk': {
      /* HUD.js:1772 — `talk` is what an NPC emits when it is NOT a quest
       * manager. A quest desk emits `interact` and opens the board instead, so
       * naming one here would be a step no press of E can advance. */
      for (const r of residents) {
        if (r.questManager) continue;
        add(r.name, 'npc-name', r.source);
      }
      for (const role of roles) {
        if (role === ROLE.QUEST_MANAGER) continue;
        add(role, 'npc-role', `carried by an NPC in ${world.id}`);
      }
      break;
    }

    case 'interact': {
      // Portals: the quest:activity payload carries `${world}->${target}`,
      // and `portal:entering` synthesises the destination world id.
      for (const t of world.portalTargets) {
        add(`${world.id}->${t}`, 'portal-id', 'src/systems/Portals.js portal.id');
        add(t, 'world', 'src/systems/Portals.js portal:entering to');
        const dest = WORLDS.get(t);
        if (dest) add(dest.displayName, 'portal-label', `${dest.file} static displayName`);
      }
      // The only NPC that emits `interact` is a quest desk.
      for (const r of residents) {
        if (!r.questManager) continue;
        add(r.name, 'quest-manager-name', r.source);
      }
      if (residents.some((r) => r.questManager)) {
        add(ROLE.QUEST_MANAGER, 'npc-role', 'src/npc/NPCRoles.js ROLE');
      }
      break;
    }

    case 'kill':
    case 'defend': {
      if (!world.rules.hostiles) break;
      for (const n of world.hostileNames) add(n, 'hostile-name', `${world.id} authored hostiles`);
      /* `Sentinel N` is the fallback name at NPCManager.js:721, and it is only
       * ever used by a world that authors a hostile with no name of its own —
       * the citadel's ring of eight, and nowhere else. */
      if (world.unnamedHostiles) add('sentinel', 'hostile-name', 'src/npc/NPCManager.js:721 fallback name');
      break;
    }

    case 'race': {
      /* RaceManager only arms where a world publishes a `trackPath`. Sports
       * publishes none, which is why its twenty race steps cannot fire even
       * with the matching fixed — and `publishesTrack` is scraped, so a sports
       * track added later opens this up without editing the validator. */
      if (!world.rules.races || !world.publishesTrack) break;
      for (const c of VOCAB.circuits) {
        add(c.id, 'circuit-id', 'src/worlds/RaceCircuits.js CIRCUITS');
        add(c.name, 'circuit-name', 'src/worlds/RaceCircuits.js CIRCUITS');
      }
      for (const t of VOCAB.raceTypes) add(t, 'race-type', 'src/race/RaceManager.js RACE_TYPES');
      for (const p of VOCAB.placeTokens) add(p, 'place', 'QuestSystem._eventTargetCandidates');
      break;
    }

    case 'purchase': {
      /* A merchant rule is not a merchant. `Marketplace._findVendor` needs an
       * NPC reporting `role === 'vendor'`, so a world that permits trade and
       * has nobody carrying the role can never emit `market:trade`. */
      if (!world.rules.merchants || !roles.includes(ROLE.VENDOR)) break;
      for (const id of VOCAB.items) add(id, 'item', 'src/systems/ItemDefs.js ITEMS');
      for (const id of VOCAB.packs) add(id, 'pack', 'src/systems/ItemDefs.js PACKS');
      for (const k of VOCAB.tradeKinds) add(k, 'trade-kind', 'src/systems/Marketplace.js market:trade kind');
      break;
    }

    case 'customize': {
      for (const [field, values] of Object.entries(VOCAB.character)) {
        for (const v of values) add(v, `character-${field}`, 'src/player/PlayerAvatar.js');
      }
      break;
    }

    default:
      break;
  }
  return out;
}

/**
 * Why a target that does not resolve does not resolve.
 *
 * A bare "unknown target" is a poor answer when the real problem is that the
 * name is a quest desk and the step said `talk`, or that the NPC stands in a
 * different world, or that they are only ever produced by a crowd filler with
 * two slots left. Each of those needs a different edit, so each gets its own
 * sentence.
 *
 * @param {string} type
 * @param {string} raw
 * @param {object} world
 * @returns {string} extra detail, or ''
 */
function diagnose(type, raw, world) {
  const notes = [];
  const residents = RESIDENTS.get(world.id) ?? [];

  if (type === 'interact') {
    const hit = residents.find((r) => !r.questManager && targetMatches(raw, r.name));
    if (hit) {
      notes.push(`"${hit.name}" is not a quest manager — HUD.js:1772 emits "talk" for every NPC that is not one, so this step must use type "talk"`);
    }
  }
  if (type === 'talk') {
    const hit = residents.find((r) => r.questManager && targetMatches(raw, r.name));
    if (hit) {
      notes.push(`"${hit.name}" IS a quest manager — HUD.js:1773 emits "interact" and opens the board, so this step must use type "interact"`);
    }
  }

  if (type === 'talk' || type === 'interact') {
    const plan = SPAWN_PLANS.get(world.id);
    const byRole = ROLE_CAST[world.theme] ?? ROLE_CAST[CAST_FALLBACK_THEME] ?? {};
    for (const [role, list] of Object.entries(byRole)) {
      list.forEach((entry, i) => {
        if (!targetMatches(raw, entry.name)) return;
        const slot = fillerSlotFor(role, i);
        notes.push(
          `"${entry.name}" is a ROLE_CAST.${world.theme} name, handed out only by the crowd filler at slot ${slot + 1}`
          + ` — ${world.id} leaves the filler ${plan.fillerSlots} slot(s)`
          + ` (friendlyBudget ${plan.friendlyBudget} − ${plan.authoredSpawned} authored − ${plan.lorekeepers} lorekeeper(s)),`
          + ` and a filler name is only trusted when that residual covers a whole ${FILLER_CYCLE}-slot rotation`,
        );
      });
    }
    const roles = WORLD_ROLES.get(world.id) ?? [];
    for (const role of Object.values(ROLE)) {
      if (roles.includes(role) || !targetMatches(raw, role)) continue;
      notes.push(`no NPC in ${world.id} carries the role "${role}" — it has ${roles.join(', ')}`);
    }
  }

  if (type === 'collect' && Object.keys(ITEMS).some((id) => targetMatches(raw, id))) {
    const w = VOCAB.worlds[world.id];
    notes.push(`no pickup in ${world.id} can contain it — the world yields ${w.collectables.join(', ') || 'nothing'}`);
  }

  // Somewhere else, though? Every world, not just the quest-enabled ones — a
  // step scoped to a quest-less world still advances there.
  const elsewhere = [];
  for (const other of STEP_WORLDS) {
    if (other === world.id) continue;
    if (candidatesFor(type, other).some((c) => targetMatches(raw, c.value))) elsewhere.push(other);
  }
  if (elsewhere.length) {
    notes.push(`it IS reachable in ${elsewhere.join(', ')} — a step only advances in the world it names`);
  }
  return notes.length ? ` (${notes.join('; ')})` : '';
}

/**
 * Can a quest whose own `world` is this one ever be OFFERED to a player?
 *
 * The other half of the split. A step's world is only a filter on `_worldId`,
 * but a QUEST's world decides which board it appears on, and the board is the
 * one thing `quests: false` really does remove: the handler blanks
 * `worldQuests` and returns, `_loadQuestsForWorld` is never called because the
 * flag that triggers it is skipped, and `accept()` looks the quest up in the
 * list that was just emptied. So a quest authored INTO a quest-less world can
 * never be accepted by anybody, however reachable its steps are.
 *
 * @param {string|null|undefined} worldId the quest's own `world`
 * @returns {{ok:boolean, reason:string|null, detail:string}}
 */
export function resolveQuestWorld(worldId) {
  const id = String(worldId ?? '').trim();
  if (!id) {
    return { ok: false, reason: 'quest-world', detail: 'a quest must name the world whose board it stands on' };
  }
  const world = WORLDS.get(id);
  if (!world) {
    return {
      ok: false,
      reason: 'quest-world',
      detail: `"${id}" is not a registered World.static id (${[...WORLDS.keys()].join(', ')})`,
    };
  }
  if (!world.rules.quests) {
    return {
      ok: false,
      reason: 'quest-world',
      detail: `world "${id}" sets quests:false in makeRules — ${QUEST_GATE.file}'s world:changed handler blanks `
        + `${QUEST_GATE.clears.join(', ')} and returns on entry, so this quest never reaches a board and `
        + `accept() could never find it. Steps may be SCOPED to ${id} (${UNGATED_STEP_TYPES.join(', ')} still `
        + `advance there); the quest itself must live on a board in ${QUEST_WORLDS.join(', ')}.`,
    };
  }
  return { ok: true, reason: null, detail: `${id} permits quests, so its board is loaded on entry` };
}

/**
 * Can a player ever satisfy this step target?
 *
 * @param {string} type step type
 * @param {string|null|undefined} target step target
 * @param {{world?:string|null}} [opts] the step's own world — REQUIRED, because
 *   the engine gates on it and so does every NPC, role and item in this file
 * @returns {{ok:boolean, reason:string|null, detail:string, matched:Candidate|null, candidates:number}}
 */
export function resolveTarget(type, target, opts = {}) {
  const world = opts.world ?? null;
  const t = String(type ?? '').trim();

  if (DEAD_STEP_TYPES.includes(t)) {
    return {
      ok: false,
      reason: 'dead-type',
      detail: `step type "${t}" has no emitter anywhere in src/ — no player action can ever advance it`,
      matched: null,
      candidates: 0,
    };
  }
  if (!WORKING_STEP_TYPES.includes(t)) {
    return {
      ok: false,
      reason: 'unknown-type',
      detail: `step type "${t}" is not one of: ${WORKING_STEP_TYPES.join(', ')}`,
      matched: null,
      candidates: 0,
    };
  }
  if (!world) {
    return {
      ok: false,
      reason: 'no-world',
      detail: 'a step has to name the world it happens in — the vocabulary is per-world, because an NPC that spawns in one world does not spawn in another',
      matched: null,
      candidates: 0,
    };
  }
  if (!WORLDS.has(world)) {
    return {
      ok: false,
      reason: 'unknown-world',
      detail: `world "${world}" is not a registered World.static id (${[...WORLDS.keys()].join(', ')})`,
      matched: null,
      candidates: 0,
    };
  }
  /* `quests: false` gates ACCEPTING and LISTING, not ADVANCING.
   *
   * The gate is one early return in the `world:changed` handler. It empties
   * `worldQuests` — so no board, no accept — but `this.engagements` survives the
   * world change untouched and `_advanceSteps` never consults a world rule. Only
   * the types the gate can actually reach are refused here; the rest are judged
   * on their own emitter and on what the world can produce, exactly as they are
   * anywhere else. See {@link readQuestGate}. */
  if (!WORLDS.get(world).rules.quests && GATED_STEP_TYPES.includes(t)) {
    return {
      ok: false,
      reason: 'quests-disabled',
      detail: `world "${world}" sets quests:false in makeRules, and "${t}" is credited only from `
        + `${QUEST_GATE.evidence[t]}, which sits behind the allows(world, 'quests') early return in `
        + `${QUEST_GATE.file}'s world:changed handler — the handler blanks ${QUEST_GATE.clears.join(', ')} `
        + `and returns before crediting anything. An already-accepted engagement DOES survive the trip, so `
        + `${UNGATED_STEP_TYPES.join(', ')} still advance there; "${t}" cannot.`,
      matched: null,
      candidates: 0,
    };
  }

  const candidates = candidatesFor(t, world);
  const raw = String(target ?? '').trim();

  if (!candidates.length) {
    return {
      ok: false,
      reason: 'no-candidates',
      detail: `nothing in ${world} can emit a "${t}" event`,
      matched: null,
      candidates: 0,
    };
  }

  // The engine treats an empty target as "anything of this type counts".
  if (!raw || !normalizeTarget(raw)) {
    return {
      ok: true,
      reason: null,
      detail: 'untargeted — any event of this type advances it',
      matched: null,
      candidates: candidates.length,
    };
  }

  const hit = candidates.find((c) => targetMatches(raw, c.value));
  if (hit) {
    return {
      ok: true,
      reason: null,
      detail: `matches ${hit.kind} "${hit.value}" (${hit.source})`,
      matched: hit,
      candidates: candidates.length,
    };
  }

  return {
    ok: false,
    reason: 'unknown-target',
    detail: `"${raw}" is not one of the ${candidates.length} ${t} ids reachable in ${world}`
      + diagnose(t, raw, WORLDS.get(world)),
    matched: null,
    candidates: candidates.length,
  };
}

/** The distinct candidate values for a type/world, for a failure report. */
export function candidateValues(type, worldId = null) {
  return [...new Set(candidatesFor(type, worldId).map((c) => c.value))];
}

/* ====================================================================== */
/* Seed data                                                              */
/* ====================================================================== */

/** Repo-relative path of the one module that holds authored quest content. */
export const SEED_MODULE = 'admin/lib/quests/index.mjs';

/**
 * The authored seed content, imported from the modules the seeder itself reads.
 *
 * This used to slice a `DEFAULT_QUESTS` array literal out of `admin/lib/db.ts`
 * by text and evaluate it in a `data:` URL, because the content lived inside a
 * TypeScript module that imports `postgres` and so could be neither imported
 * nor `require`d. The content has since moved to five per-world `.mjs` modules
 * behind {@link SEED_MODULE}, and `db.ts` is now one line —
 * `const DEFAULT_QUESTS: readonly QuestSeed[] = ALL_QUESTS`. There is no
 * literal left to slice, so the scraper is replaced by the plain import it
 * always wanted to be, and the ruler now reads the SAME module the seeder
 * writes to the `quests` table rather than a text copy of it.
 *
 * Nothing is coerced or defaulted on the way through: the test has to see the
 * data exactly as the seeder does.
 *
 * @returns {Promise<Array<object>>}
 */
export async function loadSeedQuests() {
  const url = pathToFileURL(path.join(REPO_ROOT, SEED_MODULE)).href;
  const mod = await import(url);
  const quests = mod.ALL_QUESTS ?? mod.default;
  if (!Array.isArray(quests) || quests.length === 0) {
    throw new Error(`${SEED_MODULE} exported no quests — expected a non-empty ALL_QUESTS array`);
  }
  return quests;
}
