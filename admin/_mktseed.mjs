/**
 * TEMPORARY one-shot: insert the 25 missing shield/firepower marketplace rows.
 * ON CONFLICT DO NOTHING — cannot overwrite existing data.
 * Deleted immediately after running.
 */
import fs from 'node:fs';
import postgres from 'postgres';

const envPath = process.argv[2];
const APPLY = process.argv[3] === '--apply';
const raw = fs.readFileSync(envPath, 'utf8');
const vars = {};
for (const line of raw.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) vars[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const url = vars.POSTGRES_URL || vars.DATABASE_URL;
if (!url) { console.error('No POSTGRES_URL'); process.exit(1); }
const sql = postgres(url, { ssl: 'require', onnotice: () => {}, max: 1 });

const BASE = [
  { key: 'shield_5s', name: 'Aegis Shard', cat: 'spells', sort: 160,
    desc: 'Spell consumable that raises a damage shield for 5 seconds.',
    action: 'shield_5s', cfg: { effect: 'shield', seconds: 5 } },
  { key: 'firepower_boost_25', name: 'Firepower Sigil', cat: 'weapons', sort: 170,
    desc: 'Weapon consumable that boosts weapon damage by 25% for 30 seconds.',
    action: 'firepower_boost_25', cfg: { effect: 'modify_firepower', percent: 25, seconds: 30 } },
  { key: 'firepower_boost_50', name: 'Firepower Talisman', cat: 'weapons', sort: 171,
    desc: 'Weapon consumable that boosts weapon damage by 50% for 30 seconds.',
    action: 'firepower_boost_50', cfg: { effect: 'modify_firepower', percent: 50, seconds: 30 } },
  { key: 'firepower_boost_75', name: 'Firepower Seal', cat: 'weapons', sort: 172,
    desc: 'Weapon consumable that boosts weapon damage by 75% for 30 seconds.',
    action: 'firepower_boost_75', cfg: { effect: 'modify_firepower', percent: 75, seconds: 30 } },
  { key: 'firepower_boost_100', name: 'Firepower Crown', cat: 'weapons', sort: 173,
    desc: 'Weapon consumable that doubles weapon damage for 30 seconds.',
    action: 'firepower_boost_100', cfg: { effect: 'modify_firepower', percent: 100, seconds: 30 } },
];
const PRICES = {
  shield_5s:           { station: [210,101], medieval: [284,120], sports: [147,60],  citadel: [305,129], race: [210,92]  },
  firepower_boost_25:  { station: [150,73],  medieval: [203,86],  sports: [105,43],  citadel: [218,92],  race: [150,66]  },
  firepower_boost_50:  { station: [215,105], medieval: [290,124], sports: [151,62],  citadel: [312,133], race: [215,95]  },
  firepower_boost_75:  { station: [305,147], medieval: [412,174], sports: [214,87],  citadel: [442,188], race: [305,134] },
  firepower_boost_100: { station: [445,216], medieval: [601,255], sports: [312,127], citadel: [645,274], race: [445,196] },
};
const WORLDS = ['station', 'medieval', 'sports', 'citadel', 'race'];

try {
  const [{ n: before }] = await sql`SELECT COUNT(*)::int AS n FROM marketplace_items`;
  console.log(`rows before: ${before}`);

  const rows = [];
  for (const b of BASE) for (const w of WORLDS) {
    const [buy, sell] = PRICES[b.key][w];
    rows.push({ source_key: `${b.key}:${w}`, name: b.name, description: b.desc,
      category: b.cat, image: '', game_action: b.action, action_config: b.cfg,
      quantity: null, cost_buy: buy, cost_sell: sell, world_name: w,
      is_active: true, sort_order: b.sort });
  }
  console.log(`prepared ${rows.length} rows`);

  const keys = rows.map(r => r.source_key);
  const existing = await sql`SELECT source_key FROM marketplace_items WHERE source_key = ANY(${keys})`;
  console.log(`already present: ${existing.length}`);

  if (!APPLY) {
    console.log('\nDRY RUN — no writes. Sample row:');
    console.log(JSON.stringify(rows[0], null, 2));
    console.log(`\nWould insert ${rows.length - existing.length} new rows.`);
  } else {
    let inserted = 0;
    for (const r of rows) {
      const res = await sql`
        INSERT INTO marketplace_items
          (source_key, name, description, category, image, game_action, action_config,
           quantity, cost_buy, cost_sell, world_name, is_active, sort_order)
        VALUES
          (${r.source_key}, ${r.name}, ${r.description}, ${r.category}, ${r.image},
           ${r.game_action}, ${sql.json(r.action_config)}, ${r.quantity}, ${r.cost_buy},
           ${r.cost_sell}, ${r.world_name}, ${r.is_active}, ${r.sort_order})
        ON CONFLICT (source_key) DO NOTHING
        RETURNING source_key`;
      if (res.length) inserted++;
    }
    const [{ n: after }] = await sql`SELECT COUNT(*)::int AS n FROM marketplace_items`;
    console.log(`\ninserted: ${inserted}`);
    console.log(`rows after: ${after} (was ${before})`);
    const check = await sql`
      SELECT game_action, COUNT(*)::int AS n FROM marketplace_items
      WHERE game_action IN ('shield_5s','firepower_boost_25','firepower_boost_50','firepower_boost_75','firepower_boost_100')
      GROUP BY game_action ORDER BY game_action`;
    for (const c of check) console.log(`  ${c.game_action.padEnd(22)} ${c.n}`);
  }
} catch (e) {
  console.error('DB ERROR:', e.message);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
