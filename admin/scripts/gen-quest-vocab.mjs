/**
 * Derive the admin console's quest vocabulary from `scripts/quest-vocab.mjs`.
 *
 * ── Why this generator exists instead of a plain import ─────────────────────
 *
 * `scripts/quest-vocab.mjs` is the authoritative vocabulary: it imports the
 * game's own `ItemDefs`, `NPCRoles`, `RaceCircuits` and `PlayerAvatar`, and it
 * SCRAPES `src/**` off disk with `readFileSync` at module load. Both halves of
 * that make it unimportable from a Next.js server bundle:
 *
 *   - `src/player/PlayerAvatar.js` imports `three`, which the admin app does
 *     not depend on and has no business shipping;
 *   - the scrape reads repo-relative paths at RUNTIME. Next's file tracing
 *     cannot see a dynamic `readFileSync`, so `output: 'standalone'` would ship
 *     a lambda that throws ENOENT on the first quest save. A validator that
 *     500s is worse than the drift it was added to catch.
 *
 * So the vocabulary is baked at build time instead, and the ONLY hand-written
 * thing in the generated modules is this generator. Nothing below re-lists a
 * step type, a world or a target id: every value is read out of the real module
 * and every function is the real module's own source text, sliced out verbatim
 * (`Function.prototype.toString` where the function is exported, a brace match
 * where it is private). A copy is exactly how `STEP_TYPES` drifted; this is a
 * derivation, and it is re-derived on every `npm run build`.
 *
 * ── The self-check ─────────────────────────────────────────────────────────
 *
 * Emitting the source is not enough on its own — the sliced functions close
 * over module state that had to be re-hydrated from JSON, and a mistake there
 * would be silent. So after writing, this imports what it just wrote and runs
 * a corpus of several thousand (type, world, target) triples through BOTH
 * resolvers, comparing `{ok, reason, detail}` byte for byte. Any disagreement
 * fails generation. The corpus is built from the real candidate lists, the
 * authored seed quests, and deliberate negatives (dead types, foreign worlds,
 * NPC names borrowed from the wrong world), so it covers every branch the
 * resolver has, `diagnose()` included.
 *
 * ── `--optional` ───────────────────────────────────────────────────────────
 *
 * The Vercel project for this app has `admin/` as its root directory, so a
 * production build may not have `../scripts` or `../src` beside it — and even
 * where it does, `three` is only in the REPO ROOT's node_modules. `--optional`
 * therefore downgrades any failure to a warning WHEN the generated files are
 * already present and committed, so a deploy builds from the committed
 * derivation. It still fails hard when there is nothing to fall back on, and it
 * always fails hard without the flag, which is how a developer and CI run it.
 *
 * Usage:  node admin/scripts/gen-quest-vocab.mjs [--optional]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(ADMIN_ROOT, '..');
const VOCAB_SRC = path.join(REPO_ROOT, 'scripts', 'quest-vocab.mjs');

const LISTS_OUT = path.join(ADMIN_ROOT, 'lib', 'questVocab.lists.generated.mjs');
const RESOLVER_OUT = path.join(ADMIN_ROOT, 'lib', 'questVocab.resolver.generated.mjs');

const OPTIONAL = process.argv.includes('--optional');

/* ---------------------------------------------------------------------- */
/* Slicing a private function out of the source text                       */
/* ---------------------------------------------------------------------- */

/**
 * Index of the brace that closes the one at `open`, skipping strings and
 * comments. A naive counter would be defeated by a `}` inside a message, and
 * every string in `diagnose` is a template literal full of them.
 * @param {string} src
 * @param {number} open index of the opening `{`
 */
function matchBrace(src, open) {
  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
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
    if (c === '{') { depth++; continue; }
    if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * The full text of a `function name(...) { ... }` declaration.
 * Throws rather than returning nothing: a scrape that degrades to "found
 * nothing" is the failure mode `quest-vocab.mjs` itself warns about at length.
 * @param {string} src
 * @param {string} name
 */
function sliceFunction(src, name) {
  const decl = new RegExp(`(^|\\n)function ${name}\\s*\\(`);
  const m = decl.exec(src);
  if (!m) throw new Error(`cannot find "function ${name}(" in scripts/quest-vocab.mjs`);
  const start = m.index + (m[1] ? 1 : 0);
  const open = src.indexOf('{', src.indexOf('(', start));
  const close = matchBrace(src, open);
  if (close < 0) throw new Error(`unbalanced braces slicing "${name}" from scripts/quest-vocab.mjs`);
  return src.slice(start, close + 1);
}

/* ---------------------------------------------------------------------- */
/* Generation                                                              */
/* ---------------------------------------------------------------------- */

function json(value) {
  return JSON.stringify(value, null, 2);
}

async function generate() {
  const vocab = await import(pathToFileURL(VOCAB_SRC).href);
  // ROLE_CAST is needed in its full role→cast shape; VOCAB flattens it to names.
  const NPC_ROLES_SRC = path.join(REPO_ROOT, 'src', 'npc', 'NPCRoles.js');
  const { ROLE_CAST } = await import(pathToFileURL(NPC_ROLES_SRC).href);

  /* `castFor` falls back to one theme for any theme it does not know, and
   * `diagnose` reproduces that fallback. Scraped exactly the way the real
   * module scrapes it, and asserted, because a regex that silently finds
   * nothing is the failure this whole file exists to prevent. */
  const castFallback = /ROLE_CAST\[theme\]\s*\?\?\s*ROLE_CAST\.([a-z]+)/
    .exec(readFileSync(NPC_ROLES_SRC, 'utf8'))?.[1];
  if (!castFallback) throw new Error('cannot scrape the ROLE_CAST fallback theme from src/npc/NPCRoles.js');

  const {
    VOCAB, WORKING_STEP_TYPES, DEAD_STEP_TYPES, GATED_STEP_TYPES, UNGATED_STEP_TYPES,
    QUEST_GATE, candidatesFor, resolveTarget, resolveQuestWorld,
    normalizeTarget, tokenRunMatch, targetMatches,
  } = vocab;

  const src = readFileSync(VOCAB_SRC, 'utf8');
  const stamp = new Date().toISOString().slice(0, 10);

  /* ---- the small, client-safe lists -------------------------------- */

  const stepWorlds = VOCAB.stepWorlds.map((id) => ({
    id,
    displayName: VOCAB.worlds[id].displayName,
    quests: VOCAB.worlds[id].rules.quests,
  }));
  const questWorlds = VOCAB.questWorlds.map((id) => ({
    id,
    displayName: VOCAB.worlds[id].displayName,
  }));

  /** type → world → distinct candidate values, for the target picker. */
  const targets = {};
  /** type → world → full Candidate[], for the resolver. */
  const candidates = {};
  for (const type of WORKING_STEP_TYPES) {
    targets[type] = {};
    candidates[type] = {};
    for (const { id } of stepWorlds) {
      const list = candidatesFor(type, id);
      if (!list.length) continue;
      candidates[type][id] = list;
      targets[type][id] = [...new Set(list.map((c) => c.value))];
    }
  }

  const header = (what) => `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * ${what}
 *
 * Derived from \`scripts/quest-vocab.mjs\` by \`admin/scripts/gen-quest-vocab.mjs\`
 * on ${stamp}. Regenerate with \`npm run vocab\` in \`admin/\`; \`npm run build\`
 * does it for you. Read the generator's header for why the vocabulary is baked
 * rather than imported, and for the corpus that proves this file agrees with
 * the module it came from.
 */
`;

  const listsOut = `${header('The quest vocabulary, small enough for a client bundle: which step\n * types have an emitter, which worlds a quest or a step may name, and the\n * target ids each (type, world) pair can actually produce.')}
/** Step types the engine can advance. Anything else is unfinishable. */
export const WORKING_STEP_TYPES = ${json(WORKING_STEP_TYPES)};

/** Step types with NO emitter anywhere in src/ — an author must never pick one. */
export const DEAD_STEP_TYPES = ${json(DEAD_STEP_TYPES)};

/** Worlds a QUEST may belong to: those whose \`makeRules\` sets quests:true. */
export const QUEST_WORLDS = ${json(questWorlds)};

/** Worlds a STEP may be scoped to — every registered world, because an
 *  already-accepted engagement keeps advancing in a quests:false world. */
export const STEP_WORLDS = ${json(stepWorlds)};

/** type → world id → the target ids that (type, world) can emit. */
export const TARGETS_BY_TYPE = ${json(targets)};
`;

  const resolverOut = `${header('The step resolver, re-hydrated. The data below is baked from the real\n * module; the functions below THAT are its own source text, sliced out\n * verbatim, so the admin console rejects exactly what the test suite rejects\n * and says the same words about it.')}
import {
  WORKING_STEP_TYPES, DEAD_STEP_TYPES, QUEST_WORLDS as QUEST_WORLD_ROWS, STEP_WORLDS as STEP_WORLD_ROWS,
} from './questVocab.lists.generated.mjs';

export { WORKING_STEP_TYPES, DEAD_STEP_TYPES };

/* ── Baked state the sliced functions close over ────────────────────── */

const QUEST_WORLDS = QUEST_WORLD_ROWS.map((w) => w.id);
const STEP_WORLDS = STEP_WORLD_ROWS.map((w) => w.id);
const GATED_STEP_TYPES = ${json(GATED_STEP_TYPES)};
const UNGATED_STEP_TYPES = ${json(UNGATED_STEP_TYPES)};
const QUEST_GATE = ${json(QUEST_GATE)};
const ROLE = ${json(Object.fromEntries(VOCAB.roles.map((r) => [r.toUpperCase(), r])))};
const ROLE_CAST = ${json(ROLE_CAST)};
const ROLE_ROTATION = ${json(VOCAB.roleRotation)};
const FILLER_CYCLE = ${json(VOCAB.fillerCycle)};
const CAST_FALLBACK_THEME = ${json(castFallback)};
/** Only \`Object.keys(ITEMS)\` is ever asked of this. */
const ITEMS = ${json(Object.fromEntries(VOCAB.items.map((id) => [id, 1])))};

const WORLD_ROWS = ${json(Object.fromEntries(VOCAB.stepWorlds.map((id) => [id, {
    id,
    displayName: VOCAB.worlds[id].displayName,
    theme: VOCAB.worlds[id].theme,
    rules: { quests: VOCAB.worlds[id].rules.quests },
    collectables: VOCAB.worlds[id].collectables,
  }])))};

const RESIDENT_ROWS = ${json(Object.fromEntries(
    VOCAB.stepWorlds.map((id) => [id, VOCAB.worlds[id].residents ?? []]),
  ))};

const SPAWN_PLAN_ROWS = ${json(Object.fromEntries(
    VOCAB.stepWorlds.map((id) => [id, VOCAB.worlds[id].spawns ?? null]),
  ))};

const WORLD_ROLE_ROWS = ${json(Object.fromEntries(
    VOCAB.stepWorlds.map((id) => [id, VOCAB.worlds[id].reachableRoles ?? []]),
  ))};

/** type → world → Candidate[], exactly what \`candidatesFor\` returned. */
const CANDIDATES = ${json(candidates)};

const WORLDS = new Map(Object.entries(WORLD_ROWS));
const RESIDENTS = new Map(Object.entries(RESIDENT_ROWS));
const SPAWN_PLANS = new Map(Object.entries(SPAWN_PLAN_ROWS));
const WORLD_ROLES = new Map(Object.entries(WORLD_ROLE_ROWS));
const VOCAB = { worlds: WORLD_ROWS };

/**
 * The baked stand-in for \`candidatesFor\`. The real one walks maps built by
 * scraping \`src/**\`; the table above is what it returned for every (type,
 * world) pair at generation time, so the lookup is the same answer.
 * @param {string} type
 * @param {string|null} worldId
 */
export function candidatesFor(type, worldId = null) {
  if (!worldId) return [];
  return CANDIDATES[type]?.[worldId] ?? [];
}

/* ── Verbatim from scripts/quest-vocab.mjs ──────────────────────────── */

${normalizeTarget.toString()}

${tokenRunMatch.toString()}

${targetMatches.toString()}

${sliceFunction(src, 'fillerSlotFor')}

${sliceFunction(src, 'diagnose')}

${resolveTarget.toString()}

${resolveQuestWorld.toString()}

export { normalizeTarget, tokenRunMatch, targetMatches, resolveTarget, resolveQuestWorld };
`;

  writeFileSync(LISTS_OUT, listsOut, 'utf8');
  writeFileSync(RESOLVER_OUT, resolverOut, 'utf8');

  await selfCheck(vocab);

  console.log(
    `[gen-quest-vocab] wrote lib/questVocab.lists.generated.mjs and `
    + `lib/questVocab.resolver.generated.mjs (${WORKING_STEP_TYPES.length} step types, `
    + `${questWorlds.length} quest worlds, ${stepWorlds.length} step worlds)`
  );
}

/* ---------------------------------------------------------------------- */
/* Self-check — the generated resolver must ANSWER like the real one       */
/* ---------------------------------------------------------------------- */

/** Every (type, world, target) triple worth asking about. */
function corpus(vocab) {
  const { VOCAB, WORKING_STEP_TYPES, DEAD_STEP_TYPES, candidatesFor } = vocab;
  const triples = [];
  const worlds = VOCAB.stepWorlds;
  const junk = ['', '   ', 'nightshade', 'relay_node', 'guild_master', 'grain_sack', '1', 'won'];

  for (const type of [...WORKING_STEP_TYPES, ...DEAD_STEP_TYPES, 'nonsense_type']) {
    for (const world of [...worlds, 'not_a_world', '', null]) {
      for (const target of junk) triples.push([type, world, target]);
      // Real candidates from this world, and from a DIFFERENT one, so the
      // "it IS reachable in ..." branch of diagnose() is exercised too.
      const mine = world ? candidatesFor(type, world).map((c) => c.value) : [];
      const theirs = world
        ? worlds.filter((w) => w !== world).flatMap((w) => candidatesFor(type, w).map((c) => c.value))
        : [];
      for (const t of sample(mine, 6)) triples.push([type, world, t]);
      for (const t of sample(theirs, 6)) triples.push([type, world, t]);
      // NPC names carry the sharpest diagnose() branches (quest desk vs talker,
      // crowd-filler slots, roles the world does not have).
      for (const r of sample((VOCAB.worlds[world]?.residents ?? []).map((x) => x.name), 4)) {
        triples.push([type, world, r]);
      }
      for (const role of VOCAB.roles) triples.push([type, world, role]);
    }
  }
  return triples;
}

/** A stable spread through a list, so the corpus is deterministic. */
function sample(list, n) {
  if (list.length <= n) return list;
  const step = Math.ceil(list.length / n);
  const out = [];
  for (let i = 0; i < list.length && out.length < n; i += step) out.push(list[i]);
  return out;
}

async function selfCheck(vocab) {
  const gen = await import(`${pathToFileURL(RESOLVER_OUT).href}?t=${Date.now()}`);

  let checked = 0;
  for (const [type, world, target] of corpus(vocab)) {
    const want = vocab.resolveTarget(type, target, { world });
    const got = gen.resolveTarget(type, target, { world });
    for (const key of ['ok', 'reason', 'detail']) {
      if (want[key] !== got[key]) {
        throw new Error(
          `generated resolveTarget disagrees on ${key} for `
          + `(${type}, ${world}, ${JSON.stringify(target)}):\n`
          + `  quest-vocab: ${JSON.stringify(want[key])}\n`
          + `  generated:   ${JSON.stringify(got[key])}`
        );
      }
    }
    if (want.candidates !== got.candidates) {
      throw new Error(`generated resolveTarget disagrees on candidate COUNT for (${type}, ${world})`);
    }
    checked++;
  }

  for (const world of [...vocab.VOCAB.stepWorlds, 'not_a_world', '', null, undefined]) {
    const want = vocab.resolveQuestWorld(world);
    const got = gen.resolveQuestWorld(world);
    for (const key of ['ok', 'reason', 'detail']) {
      if (want[key] !== got[key]) {
        throw new Error(
          `generated resolveQuestWorld disagrees on ${key} for ${JSON.stringify(world)}:\n`
          + `  quest-vocab: ${JSON.stringify(want[key])}\n`
          + `  generated:   ${JSON.stringify(got[key])}`
        );
      }
    }
    checked++;
  }

  // The authored seed is the corpus that matters most: every shipped step must
  // get the same verdict from the console it gets from `npm test`.
  const quests = (await import(
    pathToFileURL(path.join(ADMIN_ROOT, 'lib', 'quests', 'index.mjs')).href
  )).ALL_QUESTS;
  for (const quest of quests) {
    for (const step of quest.steps ?? []) {
      const world = step.world || quest.world;
      const want = vocab.resolveTarget(step.type, step.target, { world });
      const got = gen.resolveTarget(step.type, step.target, { world });
      if (want.ok !== got.ok || want.detail !== got.detail) {
        throw new Error(`generated resolver disagrees on seed quest #${quest.n} step ${step.order}`);
      }
      checked++;
    }
  }

  console.log(`[gen-quest-vocab] self-check: ${checked} verdicts agree with scripts/quest-vocab.mjs`);
}

/* ---------------------------------------------------------------------- */

try {
  if (!existsSync(VOCAB_SRC)) throw new Error(`${VOCAB_SRC} is not there`);
  await generate();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  const haveFallback = existsSync(LISTS_OUT) && existsSync(RESOLVER_OUT);
  if (OPTIONAL && haveFallback) {
    console.warn(
      `[gen-quest-vocab] could not re-derive the vocabulary (${message}).\n`
      + '[gen-quest-vocab] building from the committed derivation instead. This is expected on a '
      + 'deployment whose root directory is admin/, where ../scripts and three/ are not present.'
    );
  } else {
    console.error(`[gen-quest-vocab] FAILED: ${message}`);
    process.exit(1);
  }
}
