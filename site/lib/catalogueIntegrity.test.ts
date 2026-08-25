import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFakeDb } from './fakeDb';
import {
  createServerMarketplaceItem,
  updateServerMarketplaceItem,
  ServerContentInputError,
} from './serverContent';
import { parseMarketplaceRows } from './marketplaceDb';
import {
  MARKETPLACE_ACTIONS,
  MARKETPLACE_CATEGORIES,
  MARKETPLACE_WORLDS,
} from './marketplaceCatalog';

/**
 * THE WRITE MUST NOT ACCEPT WHAT THE READ CANNOT SURVIVE.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DEFECT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `createServerMarketplaceItem` stored `game_action` as free text —
 * `text(input.gameAction, 60)` — and `marketplaceDb.rowToItem` THROWS on an
 * action it does not recognise. `listMarketplaceItems` mapped every row through
 * it. One row and the whole list died.
 *
 * Driven live through the real routes by the signed-in survey (§6 F8): an owner
 * authored one item with `gameAction: "totally_bogus"`, and
 * `GET /api/marketplace/items` went
 *
 *   owner  200 (612 items) -> 500 (empty body)
 *   member 200 (612 items) -> 500 (empty body)
 *   anon   200 (612 items) -> 200 (612 items)
 *
 * Anonymous callers were spared only because the scope clause
 * `server_id IS NULL OR server_id = $2` excludes the row from their query — so
 * it was a denial of service inside one server, taking the 612 PLATFORM items
 * down with the owner's own.
 *
 * `category` and `world_name` had the identical shape: written with
 * `text(...).toLowerCase()`, read with `normalizeCategory` / `normalizeWorld`,
 * which also throw.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS FILE HAS NO DATABASE IN IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Both halves of the fix are claims a database cannot settle any better than a
 * recording client can, and one that a database would make WORSE by hiding:
 *
 *   - the write half is "which value is bound to `game_action`", which is a
 *     claim about the SQL this app emits;
 *   - the read half is "given these rows, what comes back", which is a claim
 *     about a pure function over rows.
 *
 * And the decisive argument: without `POSTGRES_TEST_URL` every integration
 * suite in this repository SKIPS — `site/ npm test` reported 294 passed /
 * **128 skipped** — and a gate that vanishes on the machine where it runs is
 * how the last production incident shipped. `serverIdMigrations.test.ts` and
 * `economySeparation.test.ts` made the same call for the same reason.
 */

const here = dirname(fileURLToPath(import.meta.url));
const source = (...parts: string[]) =>
  readFileSync(join(here, '..', ...parts), 'utf8').replace(/\r\n/g, '\n');

/**
 * The source with its comments removed.
 *
 * Not fastidiousness — this file was written without it and two of its
 * assertions failed on the FIXED tree, because the comments explaining the fix
 * quote the code they replaced. A scrape that reads prose is a scrape that a
 * well-documented fix breaks and a silent regression could pass by adding a
 * comment. Strings are left alone: every needle below is code, not a literal.
 */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const ITEM = {
  name: 'Catalogue Bomb',
  description: 'The survey authored exactly this.',
  category: 'tools',
  image: '',
  gameAction: 'ammo_pack_rifle',
  actionConfig: {},
  quantity: null,
  costBuy: 10,
  costSell: 5,
  worldName: 'station',
  sortOrder: 0,
};

/* ---------------------------------------------------------------------- */
/* The write refuses a value the read cannot parse                         */
/* ---------------------------------------------------------------------- */

describe('an owner cannot author a row the catalogue read will throw on', () => {
  it('refuses an unrecognised gameAction, and writes NOTHING', async () => {
    const db = makeFakeDb();
    await expect(
      createServerMarketplaceItem(db, 'srv-1', { ...ITEM, gameAction: 'totally_bogus' })
    ).rejects.toBeInstanceOf(ServerContentInputError);
    /* Nothing INSERTed is the point. A check that ran after the write would
     * still leave the bomb in the table. `ensureServerContentColumns` runs
     * first and is allowed; an INSERT is not. */
    expect(db.matching('INSERT INTO marketplace_items')).toEqual([]);
  });

  it('refuses an unrecognised category and world for the same reason', async () => {
    for (const bad of [{ category: 'siege_engines' }, { worldName: 'atlantis' }]) {
      const db = makeFakeDb();
      await expect(
        createServerMarketplaceItem(db, 'srv-1', { ...ITEM, ...bad })
      ).rejects.toBeInstanceOf(ServerContentInputError);
      expect(db.matching('INSERT INTO marketplace_items')).toEqual([]);
    }
  });

  it('refuses the same three on the EDIT path, which is a second way in', async () => {
    for (const bad of [
      { gameAction: 'totally_bogus' },
      { category: 'siege_engines' },
      { worldName: 'atlantis' },
    ]) {
      const db = makeFakeDb();
      await expect(
        updateServerMarketplaceItem(db, 'srv-1', 'item-1', bad)
      ).rejects.toBeInstanceOf(ServerContentInputError);
      expect(db.matching('UPDATE marketplace_items SET')).toEqual([]);
    }
  });

  it('names the field, so the owner is told what to change', async () => {
    const db = makeFakeDb();
    const err: unknown = await createServerMarketplaceItem(db, 'srv-1', {
      ...ITEM,
      gameAction: 'totally_bogus',
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(ServerContentInputError);
    expect((err as ServerContentInputError).field).toBe('gameAction');
    expect((err as ServerContentInputError).message).toContain('totally_bogus');
    expect((err as ServerContentInputError).message).toContain(MARKETPLACE_ACTIONS[0].id);
  });

  it('still authors a legitimate item, so the fix did not just delete the feature', async () => {
    const db = makeFakeDb(() => [{ id: 'x', server_id: 'srv-1' }]);
    await createServerMarketplaceItem(db, 'srv-1', ITEM);
    const insert = db.only('INSERT INTO marketplace_items');
    expect(insert.params).toContain('ammo_pack_rifle');
    expect(insert.params).toContain('station');
    expect(insert.params).toContain('tools');
  });

  it('accepts every id/category/world the read accepts — the two lists ARE one list', async () => {
    /* The failure being guarded is not only "the write is too loose". It is also
     * "the write is now strict against a DIFFERENT list", which would refuse
     * legitimate content. Both sides must be the same constant, and the cheapest
     * proof of that is to drive every value through the write. */
    for (const action of MARKETPLACE_ACTIONS) {
      const db = makeFakeDb(() => [{ id: 'x', server_id: 'srv-1' }]);
      await createServerMarketplaceItem(db, 'srv-1', { ...ITEM, gameAction: action.id });
      expect(db.only('INSERT INTO marketplace_items').params).toContain(action.id);
    }
    for (const category of MARKETPLACE_CATEGORIES) {
      const db = makeFakeDb(() => [{ id: 'x', server_id: 'srv-1' }]);
      await createServerMarketplaceItem(db, 'srv-1', { ...ITEM, category });
      expect(db.only('INSERT INTO marketplace_items').params).toContain(category);
    }
    for (const world of MARKETPLACE_WORLDS) {
      const db = makeFakeDb(() => [{ id: 'x', server_id: 'srv-1' }]);
      await createServerMarketplaceItem(db, 'srv-1', { ...ITEM, worldName: world });
      expect(db.only('INSERT INTO marketplace_items').params).toContain(world);
    }
  });

  it('reads its vocabulary from marketplaceCatalog and does not keep a copy', () => {
    /* A second literal list in `serverContent.ts` would pass every test above on
     * the day it was written and drift the first time an action is added. The
     * import is the property; the scrape is how it stays one. */
    const src = codeOnly(source('lib', 'serverContent.ts'));
    expect(src).toMatch(/from '\.\/marketplaceCatalog'/);
    expect(src).toContain('MARKETPLACE_ACTIONS');
    expect(src).toContain('MARKETPLACE_CATEGORIES');
    expect(src).toContain('MARKETPLACE_WORLDS');
    expect(
      src.includes("text(input.gameAction, 60)"),
      'gameAction is being stored as free text again — that is the defect verbatim'
    ).toBe(false);
  });
});

/* ---------------------------------------------------------------------- */
/* The read survives a row that is already stored                          */
/* ---------------------------------------------------------------------- */

describe('one unreadable row does not cost the whole catalogue', () => {
  const good = (id: string, name: string) => ({
    id,
    source_key: `${id}:station`,
    name,
    description: '',
    category: 'tools',
    image: '',
    game_action: 'ammo_pack_rifle',
    action_config: {},
    quantity: null,
    cost_buy: 10,
    cost_sell: 5,
    world_name: 'station',
    is_active: true,
    sort_order: 0,
    server_id: null,
    created_at: '',
    updated_at: '',
  });

  it('skips the bad row and serves the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const rows = [
        good('a', 'Platform item'),
        { ...good('bomb', 'Catalogue Bomb'), game_action: 'totally_bogus', server_id: 'srv-1' },
        good('c', 'Another platform item'),
      ];
      const items = parseMarketplaceRows(rows);
      expect(items.map((i) => i.id)).toEqual(['a', 'c']);
      /* The console line is the only trace a bad row leaves. It names the id and
       * the scope so an owner or an admin can find and delete it — recovering
       * from a bodiless 500 was the hard half of this defect. */
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('bomb');
      expect(String(warn.mock.calls[0][0])).toContain('srv-1');
    } finally {
      warn.mockRestore();
    }
  });

  it('skips an unreadable category or world too, not just the action', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const items = parseMarketplaceRows([
        { ...good('cat', 'x'), category: 'siege_engines' },
        { ...good('world', 'y'), world_name: 'atlantis' },
        good('ok', 'z'),
      ]);
      expect(items.map((i) => i.id)).toEqual(['ok']);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not COERCE the bad row into a plausible one', () => {
    /* A `?? "tools"` fallback would be worse than the 500 it replaces:
     * `game_action` is what the client turns into a grant, so a coerced action
     * sells the buyer something other than what the row says. The row must not
     * come back at all. */
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const items = parseMarketplaceRows([
        { ...good('bomb', 'Catalogue Bomb'), game_action: 'totally_bogus' },
      ]);
      expect(items).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('the catalogue read goes through it, rather than mapping rowToItem bare', () => {
    const src = codeOnly(source('lib', 'marketplaceDb.ts'));
    expect(src).toContain('return parseMarketplaceRows(rows);');
    expect(
      src.includes('rows.map(rowToItem)'),
      'listMarketplaceItems is mapping rowToItem directly again — one bad row 500s the list'
    ).toBe(false);
  });
});
