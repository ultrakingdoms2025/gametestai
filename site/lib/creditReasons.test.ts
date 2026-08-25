import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REASON_KIND,
  DECLARED_KINDS,
  priceEvent,
  type CreditEventKind,
} from './creditPricing';

/**
 * The gate that stops a credit source going unpaid.
 *
 * Every credit change in the game funnels through `Economy.add(amount, reason)`
 * or `Economy.spend(amount, reason)`, and the server maps that `reason` onto a
 * kind. A reason the server does not know is REFUSED — which is the correct
 * behaviour for a forged claim and a disaster for a real one, because the player
 * simply stops being paid for something and nobody finds out.
 *
 * The design document listed 13 credit sources. The tree has 22. That gap is the
 * entire argument for this file: enumerating them by hand was already wrong once,
 * so this scrapes them instead, and fails when the game grows a source the server
 * has never heard of.
 *
 * It is a TEXTUAL scrape for the same reason `scripts/contract-check.mjs` is:
 * most of `src/` touches `document` or WebGL at module scope and cannot be
 * imported under Node.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

/** Read forward from an open paren, returning the balanced argument text. */
function argsAt(text: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return text.slice(openIndex + 1, i);
    }
  }
  return '';
}

/**
 * Split an argument list on its TOP-LEVEL commas.
 *
 * This replaced a regex that read the LAST argument, on the assumption that
 * `reason` is always last. It stopped being: `Economy.spend` now takes an
 * optional third argument, and a marketplace buy passes it — so
 * `spend(cost, 'market', buyMeta)` read as a call with a variable reason, and
 * the scrape reported a phantom dynamic site rather than 'market'.
 *
 * The reason has always been the SECOND argument. Reading it by position rather
 * than by "the one on the end" is what the contract actually says, and it does
 * not care how many arguments come after.
 */
function topLevelArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(args.slice(start, i));
      start = i + 1;
    }
  }
  out.push(args.slice(start));
  return out.map((s) => s.trim());
}

interface Site {
  file: string;
  line: number;
  call: 'add' | 'spend';
  reason: string | null; // null when the argument is not a literal
  raw: string;
}

const CALL = /economy\??\.(add|spend)\??\.?\(/g;

/**
 * Economy grants to ITSELF.
 *
 * `Economy._onNPCKilled` pays the kill bounty with `this.add(CREDITS_PER_KILL,
 * 'kill')` -- no `economy.` receiver, so the pattern above cannot see it, and
 * the single most common credit source in the game was invisible to this scrape
 * until the orphan check below noticed 'kill' was mapped but never emitted.
 * Anything Economy pays itself in future is caught the same way.
 */
const SELF_CALL = /this\.(add|spend)\(/g;
const SELF_FILE = 'systems/Economy.js';
/** A whole argument that is one string literal, e.g. `'market'`. */
const LITERAL = /^(?:'([^']*)'|"([^"]*)")$/;

/**
 * Strip comments before scanning.
 *
 * Without this the scrape matches PROSE: `QuestSystem.js:946` discusses
 * "the unconditional local `economy.add()`" in a docblock explaining why that
 * call was removed, and a scrape that counts it reports a phantom credit source
 * with no reason argument at all.
 *
 * Block comments go wholesale; line comments only when the line is entirely a
 * comment, so a `'http://...'` inside a string is never cut in half.
 */
function stripComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const stop = close === -1 ? text.length : close + 2;
      // Blank the comment but keep its newlines, so reported line numbers
      // still point at the real line in the real file.
      for (let k = i; k < stop; k++) out += text[k] === '\n' ? '\n' : ' ';
      i = stop;
      continue;
    }
    out += text[i++];
  }
  return out
    .split('\n')
    .map((line) => (line.trim().startsWith('//') ? '' : line))
    .join('\n');
}

function scan(): Site[] {
  const sites: Site[] = [];
  for (const file of walk(SRC)) {
    const text = stripComments(readFileSync(file, 'utf8'));
    const rel = file.slice(SRC.length + 1).split(String.fromCharCode(92)).join('/');
    const patterns = rel === SELF_FILE ? [CALL, SELF_CALL] : [CALL];
    for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const open = text.indexOf('(', m.index + m[0].length - 1);
      const args = argsAt(text, open);
      // The reason is argument two of `add(amount, reason)` / `spend(amount,
      // reason, meta?)`. By position, not by "the last one" — see topLevelArgs.
      const parts = topLevelArgs(args);
      const tail = parts.length >= 2 ? LITERAL.exec(parts[1]) : null;
      const literal = tail ? (tail[1] ?? tail[2] ?? null) : null;
      sites.push({
        file: file.slice(SRC.length + 1).split(String.fromCharCode(92)).join('/'),
        line: text.slice(0, m.index).split('\n').length,
        call: m[1] as 'add' | 'spend',
        reason: literal,
        raw: args.trim().slice(0, 120),
      });
    }
    }
  }
  return sites;
}

/**
 * Call sites whose reason is a VARIABLE, not a literal, and the literals that
 * variable can actually hold.
 *
 * A scrape cannot resolve these, so they are pinned by hand — and the test fails
 * if a NEW dynamic site appears, which is the point: someone adding one has to
 * come here and say what it can emit.
 */
const DYNAMIC_SITES: Record<string, string[]> = {
  // SpaceObjectives._payTier(tier, credits, channel, line) — `channel` is passed
  // by its two callers at SpaceObjectives.js:1525 and :1723.
  'systems/SpaceObjectives.js': ['objective:kills', 'objective:ore'],
};

describe('credit reasons', () => {
  const sites = scan();

  it('finds the credit call sites at all', () => {
    // A scrape that silently matches nothing would make every assertion below
    // vacuously true — the exact shape of false green this repo keeps paying for.
    expect(sites.length).toBeGreaterThanOrEqual(20);
    expect(sites.some((s) => s.call === 'add')).toBe(true);
    expect(sites.some((s) => s.call === 'spend')).toBe(true);
  });

  it('maps every literal reason the game can emit', () => {
    const missing = sites
      .filter((s) => s.reason !== null && REASON_KIND[s.reason] === undefined)
      .map((s) => `${s.file}:${s.line} -> '${s.reason}'`);

    expect(
      missing,
      `These credit sources exist in the game but the server does not know them, ` +
        `so every one would be REFUSED and the player would silently stop being ` +
        `paid for it. Add them to REASON_KIND in lib/creditPricing.ts:\n` +
        missing.join('\n')
    ).toEqual([]);
  });

  it('has no unaccounted dynamic reason', () => {
    const unexplained = sites
      .filter((s) => s.reason === null)
      .filter((s) => !DYNAMIC_SITES[s.file])
      .map((s) => `${s.file}:${s.line} -> ${s.raw}`);

    expect(
      unexplained,
      `A credit call site passes a variable reason that nothing enumerates. ` +
        `Trace its callers and list the literals in DYNAMIC_SITES:\n` +
        unexplained.join('\n')
    ).toEqual([]);
  });

  it('maps every literal a dynamic site can emit', () => {
    const missing: string[] = [];
    for (const [file, reasons] of Object.entries(DYNAMIC_SITES)) {
      for (const reason of reasons) {
        if (REASON_KIND[reason] === undefined) missing.push(`${file} -> '${reason}'`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('does not map anything the game cannot emit', () => {
    // Not a correctness failure, but a mapped reason with no call site is either
    // a typo or a source that was removed — both worth knowing about.
    const emitted = new Set<string>();
    for (const s of sites) if (s.reason) emitted.add(s.reason);
    for (const reasons of Object.values(DYNAMIC_SITES)) for (const r of reasons) emitted.add(r);

    const orphans = Object.keys(REASON_KIND).filter((r) => !emitted.has(r));
    expect(orphans, `REASON_KIND maps reasons no call site emits: ${orphans.join(', ')}`).toEqual([]);
  });
});

/**
 * The server's flat prices are COPIES of constants that live in the game. A copy
 * that drifts is silent: the game pays 200, the server records 120, and the only
 * symptom is a player insisting their credits are wrong.
 *
 * The first version of this table was wrong on four of five entries, so this is
 * not hypothetical. Change a constant in the game and this test fails with the
 * two numbers side by side.
 */
describe('flat prices match the game constants', () => {
  const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

  function constant(rel: string, name: string): number {
    const text = read(rel);
    // Built without backslash escapes on purpose: the identifier is bounded by
    // "not an identifier character" rather than by a word boundary.
    const m = new RegExp('(?:^|[^A-Za-z0-9_$])' + name + '[ ]*=[ ]*([0-9]+)').exec(text);
    expect(m, name + ' not found in ' + rel + ' -- the scrape is broken, not the price').toBeTruthy();
    return Number(m![1]);
  }

  const cases: Array<[string, string, string, { kind: CreditEventKind; detail?: string }]> = [
    ['systems/Economy.js', 'CREDITS_PER_KILL', 'kill', { kind: 'kill' }],
    ['systems/Relics.js', 'VALUE', 'relic', { kind: 'relic', detail: 'relic' }],
    ['systems/Relics.js', 'SET_CREDITS', 'relic-set', { kind: 'relic', detail: 'relic-set' }],
    ['systems/Viewpoints.js', 'SYNC_CREDITS', 'viewpoint', { kind: 'viewpoint' }],
    ['worlds/MazeWorld.js', 'MAZE_CENTRE_VALUE', 'maze-centre', { kind: 'maze', detail: 'maze-centre' }],
    ['worlds/MazeWorld.js', 'MAZE_TOKEN_VALUE', 'maze-token', { kind: 'maze', detail: 'maze-token' }],
  ];

  for (const [file, name, label, event] of cases) {
    it(`pays ${label} what the game pays`, () => {
      const inGame = constant(file, name);
      expect(priceEvent(event), `${file} ${name} = ${inGame}, server priced differently`).toBe(inGame);
    });
  }

  it('prices nothing flat that the game varies', () => {
    // These are declared by the client and bounded, precisely because they are
    // NOT constants — pricing them flat is what would have cut an objective
    // payout from 3,000 to 20.
    for (const kind of ['race', 'minigame', 'objective', 'ore', 'contract', 'bounty', 'sell'] as CreditEventKind[]) {
      expect(DECLARED_KINDS.has(kind), `${kind} must be declared, not flat-priced`).toBe(true);
      expect(priceEvent({ kind })).toBe(0);
    }
  });
});
