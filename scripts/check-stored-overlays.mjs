/**
 * THE PHASE 7 RELEASE STEP THAT CANNOT BE A UNIT TEST.
 *
 *   node scripts/check-stored-overlays.mjs            # every world
 *   node scripts/check-stored-overlays.mjs station    # one world
 *
 * ── What it checks ────────────────────────────────────────────────────────
 *
 * Phase 7's per-release gate asks for "zero `stale-name` and zero
 * `out-of-bounds` over the stored document". Both are properties of DATA IN A
 * DATABASE, not of the tree, so no `npm test` file can assert them: `npm test`
 * runs in CI with no credentials, and a fixture snapshot would only pin what
 * production looked like on the day it was taken. This is therefore a release
 * step you run, not a gate CI runs, and saying so plainly is better than
 * shipping a test that quietly asserts a stale copy.
 *
 * ── Why the two codes matter, and why they are not symmetrical ────────────
 *
 * `stale-name` is a WARNING in the site's conflict pass
 * (`site/lib/mapConflicts.ts`), so a whole document can be authored dead and
 * still save green. A rename in a Phase 7 release turns every entry that
 * targeted the old name into a row that reports applied and applies to
 * nothing. C1 in the spec is the rule: no name may be retired without an alias
 * table or a migration IN THE SAME RELEASE.
 *
 * `out-of-bounds` is the only ERROR-level conflict, and `hasErrors` refuses
 * the WHOLE document - so one bad row from a bounds change 400s an admin on a
 * row they never touched. C7 is the rule: bounds may not move in a release
 * that also re-authors placement.
 *
 * ── The 2026-08-28 census, and why this still needs running ───────────────
 *
 * That census found 27 stored entries across all worlds, every one of them a
 * `place`, which carries no target name - so today the stale-name half has
 * nothing to bite on and a rename is free. That is a fact about a moment, not
 * a property of the system: the first `move` or `remove` an admin authors
 * makes renames permanently expensive. Run this immediately before any release
 * that renames, and again after.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { judgeOverlays } from './lib/judge-overlays.mjs';

const require_ = createRequire(new URL('../site/package.json', import.meta.url));
const { Client } = require_('pg');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* Parse .env.local without dotenv, and without ever logging a value. */
function loadEnv(url) {
  const out = {};
  let text;
  try { text = readFileSync(url, 'utf8'); } catch { return out; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = loadEnv(new URL('../site/.env.local', import.meta.url));
const connStr = env.POSTGRES_URL || process.env.POSTGRES_URL;
if (!connStr) {
  console.error('No POSTGRES_URL in site/.env.local or the environment.');
  console.error('This is a release step run by a human with credentials, not a CI gate - see the header.');
  process.exit(2);
}

const only = process.argv[2] ?? null;

/* The catalogue pin is the tree's opinion of what names exist. Comparing the
 * stored document against it - rather than against a freshly built world - is
 * deliberate: it is the same artefact the release is diffing, so a name this
 * says is missing is a name the release retired. */
const catalogue = JSON.parse(
  readFileSync(path.join(root, 'scripts/tests/fixtures/station-catalogue.json'), 'utf8'),
);
const known = new Set(catalogue.map((o) => o.name));

const db = new Client({
  connectionString: connStr,
  ssl: /localhost|127\.0\.0\.1/.test(connStr) ? false : { rejectUnauthorized: false },
});
await db.connect();

/* SELECT only, and refused if it is ever anything else. This script points
 * at production; the guard costs one regex and removes a whole class of
 * accident. Copied in shape from .probe/map-census.mjs, which points at the
 * same database for the same reason. */
const q = (text, values) => {
  if (!/^\s*select/i.test(text)) throw new Error('READ-ONLY: refused non-SELECT');
  return db.query(text, values);
};

/* DISTINCT ON gives the HEAD document per world. Only the head applies, so
 * only the head can be stale - judging superseded versions would report
 * problems nobody can ever see and bury the one that matters. */
const { rows } = await q(
  `SELECT DISTINCT ON (world_id) world_id, version, entries
       FROM map_overlays${only ? ' WHERE world_id = $1' : ''}
      ORDER BY world_id, version DESC`,
  only ? [only] : [],
);

await db.end();

/* The judgement lives in its own module so `npm test` can watch both codes
 * fire without a database - see the note at the top of it. */
const { staleName, outOfBounds, unjudged, entries, targeted, problems } = judgeOverlays(rows, known);
void unjudged;

console.log(`${rows.length} stored document(s), ${entries} entries, ${targeted} of them name-targeted`);
for (const p of problems) console.log(`  ${p}`);
console.log(`\nstale-name    ${staleName}`);
console.log(`out-of-bounds ${outOfBounds}`);

if (targeted === 0) {
  console.log('\nNo entry targets an object by name, so a rename in this release is free.');
  console.log('That is a fact about today. Re-run this the moment an admin authors a move or a remove.');
}

process.exit(staleName || outOfBounds ? 1 : 0);
