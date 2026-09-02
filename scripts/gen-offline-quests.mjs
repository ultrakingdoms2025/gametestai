/**
 * REGENERATE THE OFFLINE QUEST BOARD FROM THE SEED.
 *
 * `src/systems/QuestsOffline.mjs` is a mirror of `admin/lib/quests/*.mjs` — the
 * bundle the quest board falls back to when the player is signed out or the
 * service is unreachable. It was originally produced by hand, with
 * `scripts/tests/quests-offline.test.mjs` pinning it field-for-field so it
 * could not drift silently.
 *
 * A pin without a regenerator is only half the tool: it tells you the mirror is
 * wrong and leaves you to fix 78 quests by hand, which is how a red test turns
 * into a deleted test. This script is the other half. Edit the seed, run this,
 * and the drift test goes green because the mirror is genuinely correct — not
 * because anybody edited it into agreement.
 *
 *   node scripts/gen-offline-quests.mjs      (or: npm run quests:offline)
 *
 * It rewrites ONLY the rows between the `OFFLINE_QUESTS` array markers. The
 * file's long header — which explains why the fallback exists at all — is
 * preserved, because that reasoning is not derivable from the seed.
 *
 * `notes` is deliberately not copied: it is authoring commentary aimed at
 * whoever edits the seed, it is often longer than the quest itself, and no
 * player-facing surface reads it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { ALL_QUESTS } from '../admin/lib/quests/index.mjs';

const S = (v) => JSON.stringify(v);
const step = (s) => `      { order: ${s.order}, label: ${S(s.label)}, type: ${S(s.type)}, target: ${S(s.target)}, count: ${s.count}, world: ${S(s.world)} },`;

const rows = ALL_QUESTS.map((q) => {
  /* `pre` is an array of quest-LINE NAMES, not steps. Emitting it through
   * `step()` produced six `undefined` fields per entry and a green-looking
   * file that failed the pin — worth stating, because the two shapes sit two
   * lines apart in the seed and read alike at a glance. */
  const pre = q.pre == null ? 'null' : S(q.pre);
  return [
    '  {',
    `    quest_number: ${q.n},`,
    `    world: ${S(q.world)},`,
    `    quest_line: ${S(q.line)},`,
    `    title: ${S(q.title)},`,
    `    reward_credits: ${q.credits},`,
    `    duration_minutes: ${q.dur},`,
    `    pre: ${pre},`,
    '    steps: [',
    q.steps.map(step).join('\n'),
    '    ],',
    '  },',
  ].join('\n');
}).join('\n');

const path = 'src/systems/QuestsOffline.mjs';
const src = readFileSync(path, 'utf8');
const open = 'export const OFFLINE_QUESTS = Object.freeze([\n';
const close = '\n].map(Object.freeze));';
const a = src.indexOf(open);
const b = src.indexOf(close, a);
if (a < 0 || b < 0) {
  console.error(`[gen-offline-quests] markers not found in ${path} — refusing to write.`);
  process.exit(1);
}
writeFileSync(path, src.slice(0, a + open.length) + rows + src.slice(b), 'utf8');
const total = ALL_QUESTS.reduce((t, q) => t + q.credits, 0);
console.log(`[gen-offline-quests] ${ALL_QUESTS.length} quests, ${total} CR of rewards -> ${path}`);
