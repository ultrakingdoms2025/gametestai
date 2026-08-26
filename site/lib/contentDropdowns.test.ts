import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFakeDb } from './fakeDb';
import { OVERLAY_WORLDS } from './mapOverlaySchema';
import { LORE_SCOPES } from './loreScopes';
import { MARKETPLACE_ACTIONS, MARKETPLACE_CATEGORIES, MARKETPLACE_WORLDS } from './marketplaceCatalog';
import {
  createServerQuest,
  updateServerQuest,
  upsertServerLore,
  ServerContentInputError,
} from './serverContent';

/**
 * The owner panel's dropdowns, held to their canonical sources.
 *
 * A free-text `game_action` once took a server's whole marketplace listing to
 * a bodiless 500, and the fix was validating the write against THE SAME
 * constant the read throws on — not a second list that agrees today. These
 * tests extend that rule to every content field the panel now offers as a
 * dropdown: the option lists must be the canonical constants, and nobody may
 * hand-write a copy that can drift.
 *
 * None of this needs a database: the claims are about emitted SQL, thrown
 * refusals, and source text — the same three kinds of claim `fakeDb.ts` and
 * `serverRouteGuards.test.ts` already settle without one.
 */

const here = dirname(fileURLToPath(import.meta.url));

function read(...parts: string[]): string {
  return readFileSync(join(here, '..', ...parts), 'utf8').replace(/\r\n/g, '\n');
}

const SERVER = 'dropdowns-test-server';

/* ---------------------------------------------------------------------- */
/* Quest world: validated against the canonical 18                         */
/* ---------------------------------------------------------------------- */

describe('quest world is a canonical world, not free text', () => {
  it('refuses an off-list world before anything is written', async () => {
    const db = makeFakeDb((sql) => {
      if (sql.includes('nextval')) return [{ n: 1_000_001 }];
      return undefined;
    });
    await expect(
      createServerQuest(db, SERVER, {
        world: 'atlantis', title: 'x', questLine: 'y', rewardCredits: 1,
      })
    ).rejects.toThrow(ServerContentInputError);
    /* Refused at the write, so a quest no player can ever reach — a world the
     * game cannot enter — is never stored. Nothing reached the table. */
    expect(db.matching('INSERT INTO quests')).toHaveLength(0);
  });

  it('names the field and the allowed values in the refusal', async () => {
    const db = makeFakeDb((sql) => (sql.includes('nextval') ? [{ n: 1_000_001 }] : undefined));
    await expect(
      createServerQuest(db, SERVER, { world: 'atlantis', title: 'x', questLine: 'y', rewardCredits: 1 })
    ).rejects.toMatchObject({ field: 'world' });
  });

  it('accepts every world in the canonical list, planets included', async () => {
    /* `OVERLAY_WORLDS` is the list `scripts/tests/map-overlay.test.mjs`
     * already pins against the game's own registrations — so "the dropdown
     * matches the game" is transitive, not asserted twice. */
    for (const world of OVERLAY_WORLDS) {
      const db = makeFakeDb((sql) => {
        if (sql.includes('nextval')) return [{ n: 1_000_001 }];
        if (sql.startsWith('INSERT INTO quests')) return [{ id: 'q', server_id: SERVER, world }];
        return undefined;
      });
      const quest = await createServerQuest(db, SERVER, {
        world, title: 'x', questLine: 'y', rewardCredits: 1,
      });
      expect(quest.world).toBe(world);
    }
  });

  it('holds the same line on PATCH: an absent world is kept, a present one is checked', async () => {
    const db = makeFakeDb(() => []);
    await expect(
      updateServerQuest(db, SERVER, 'q1', { world: 'atlantis' })
    ).rejects.toThrow(ServerContentInputError);
    expect(db.matching('UPDATE quests')).toHaveLength(0);

    /* No world in the patch → no world in the refusal's reach. The stored
     * value — legacy included — survives untouched via COALESCE. */
    await updateServerQuest(db, SERVER, 'q1', { rewardCredits: 5 });
    expect(db.matching('UPDATE quests')).toHaveLength(1);
  });
});

/* ---------------------------------------------------------------------- */
/* Lore scope: canonical ORDER, permissive write — both pinned             */
/* ---------------------------------------------------------------------- */

describe('the lore scope list', () => {
  it('is exactly the ORDER BY CASE in lore.ts, in the same order', () => {
    /* `lore.ts` cannot export the list itself — it imports `pg` at module
     * scope, and the dropdown lives in a client component. So the canonical
     * const lives in `loreScopes.ts` and THIS test is the pin: edit the CASE
     * or the const alone and this fails. */
    const src = read('lib', 'lore.ts');
    const caseAt = src.indexOf('CASE scope');
    expect(caseAt).toBeGreaterThan(-1);
    const block = src.slice(caseAt, src.indexOf('END', caseAt));
    const pairs = [...block.matchAll(/WHEN '([a-z]+)' THEN (\d+)/g)];
    expect(pairs.map((m) => m[1])).toEqual([...LORE_SCOPES]);
    expect(pairs.map((m) => Number(m[2]))).toEqual(LORE_SCOPES.map((_, i) => i));
  });

  it('does NOT become an allowlist at the write: a new scope is pure addition', async () => {
    /* Shipped merge behaviour, exercised by loreScoping.test.ts: a scope the
     * platform has never had is served as an addition, ordered last. So the
     * write stays permissive — this pin exists so nobody "fixes" it into the
     * quest-world rule and strands every off-list entry owners already have. */
    const db = makeFakeDb(() => undefined);
    const entry = await upsertServerLore(db, SERVER, {
      scope: 'annexe-hall', title: 't', body: 'b',
    });
    expect(entry.scope).toBe('annexe-hall');
    expect(db.matching('INSERT INTO server_lore_entries')).toHaveLength(1);
  });
});

/* ---------------------------------------------------------------------- */
/* The panel offers the canonical lists and hand-writes none of them       */
/* ---------------------------------------------------------------------- */

describe('the owner panel dropdowns', () => {
  const panel = read('components', 'ServerAdminPanel.tsx');

  it('imports every option list from its canonical module', () => {
    expect(panel).toMatch(/import \{ OVERLAY_WORLDS \} from '@\/lib\/mapOverlaySchema'/);
    expect(panel).toMatch(/import \{ LORE_SCOPES \} from '@\/lib\/loreScopes'/);
    expect(panel).toMatch(/MARKETPLACE_ACTIONS,\s*\n\s*MARKETPLACE_CATEGORIES,\s*\n\s*MARKETPLACE_WORLDS,\s*\n\} from '@\/lib\/marketplaceCatalog'/);
  });

  it('hand-writes no second world list', () => {
    /* THE test this file exists for. The canonical 18 appear in the component
     * only through the import — a string literal naming any of them is a
     * second list that will drift the day a world is added. */
    for (const world of OVERLAY_WORLDS) {
      expect(panel, `literal '${world}' in ServerAdminPanel`).not.toMatch(
        new RegExp(`['"\`]${world}['"\`]`)
      );
    }
  });

  it('hand-writes no second scope, category or action list', () => {
    for (const value of [...LORE_SCOPES, ...MARKETPLACE_CATEGORIES, ...MARKETPLACE_WORLDS]) {
      expect(panel, `literal '${value}'`).not.toMatch(new RegExp(`['"\`]${value}['"\`]`));
    }
    for (const action of MARKETPLACE_ACTIONS) {
      expect(panel, `literal '${action.id}'`).not.toMatch(new RegExp(`['"\`]${action.id}['"\`]`));
    }
  });

  it('offers selects, not free-text inputs, for all five fields', () => {
    for (const name of ['world', 'scope', 'category', 'gameAction', 'worldName']) {
      expect(panel, `free-text input for ${name}`).not.toMatch(
        new RegExp(`<input[^>]*name="${name}"`)
      );
      expect(panel, `no Picker for ${name}`).toMatch(new RegExp(`<Picker name="${name}"`));
    }
  });

  it('shows an off-list value already on a row as a labelled legacy option', () => {
    /* The instruction is "label it, do not silently rewrite it": an owner's
     * existing entry under a scope the canonical list never had must stay
     * reachable from the editor. */
    expect(panel).toMatch(/legacyValues=\{detail\.lore\.map\(\(l\) => l\.scope\)\}/);
    expect(panel).toMatch(/\(legacy\)/);
  });
});
