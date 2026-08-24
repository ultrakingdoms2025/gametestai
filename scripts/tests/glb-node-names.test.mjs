import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PropertyBinding } from 'three';

/**
 * ARE THE PARTS A MANIFEST DECLARES ACTUALLY REACHABLE IN ITS FILE?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY, AND WHAT THIS FILE DELIBERATELY DOES **NOT** ASSERT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `GLTFLoader` runs every node name through `PropertyBinding.sanitizeNodeName`,
 * which DELETES `[`, `]`, `.`, `:` and `/` and turns whitespace into `_`,
 * because those characters are reserved by the animation track-binding syntax.
 *
 * The D4 authored-asset contract is that a part's NAME IS A MATERIAL KEY — the
 * loader reads the key off the mesh, discards the glTF material unread, and
 * hands the geometry to a bucket the world already draws. So a world whose
 * material keys contain a dot ships parts that arrive renamed:
 *
 *     metal.panel  ->  metalpanel
 *
 * `art-race` shipped exactly that, and EIGHTEEN ASSERTIONS WERE GREEN OVER IT,
 * because every one read the `.glb` bytes directly while the browser reads the
 * same bytes through a parser that returns a different string.
 *
 * The obvious gate — "no node name may change under sanitisation" — WAS WRITTEN
 * FIRST AND THEN DELETED, because it is a gate measuring something the game does
 * not do. `race/RaceAssets.js` deliberately matches on the SANITISED form rather
 * than renaming its parts, and says why: the mesh name IS the material key, so a
 * file named `metal-panel` would need a second table mapping it back, which is
 * one more place for the contract to drift. Asserting the absolute would have
 * failed a correct design.
 *
 * What generalises is narrower and still worth holding:
 *
 *   1. A part a manifest DECLARES must be reachable in the file it names —
 *      compared the way the loader compares, through three's own function
 *      rather than a hand-written character class that could disagree with it.
 *   2. No two parts may collide after sanitising. There is no legitimate reason
 *      for that, and the failure is silent and asymmetric: the loader appends
 *      `_1` to a name it has already used, so the FIRST part still resolves and
 *      the second never does.
 *
 * Whether a given loader remembers to sanitise at all can only be proved by
 * running that loader — which is what `race-assets.test.mjs` now does.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const ASSETS = join(ROOT, 'public', 'assets');
const BS = String.fromCharCode(92);

const sane = (s) => PropertyBinding.sanitizeNodeName(s);

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('manifest.json')) out.push(p);
  }
  return out;
}

/** The JSON chunk of a binary glTF container, without a full parse. */
function glbJson(file) {
  const buf = readFileSync(file);
  assert.equal(buf.readUInt32LE(0), 0x46546c67, `${file} is not a glTF container`);
  const jsonLength = buf.readUInt32LE(12);
  return JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8'));
}

const manifests = walk(ASSETS);
const rel = (p) => relative(ROOT, p).split(BS).join('/');

test('finds the manifests at all, so an empty walk cannot pass silently', () => {
  assert.ok(manifests.length >= 8, `expected the committed manifests, found ${manifests.length}`);
});

for (const mf of manifests) {
  const manifest = JSON.parse(readFileSync(mf, 'utf8'));
  const entries = (manifest.assets ?? []).filter((a) => a?.file?.endsWith('.glb'));

  for (const entry of entries) {
    const glb = join(dirname(mf), entry.file);
    if (!existsSync(glb)) continue;
    const label = `${rel(glb)}`;

    test(`${label} — no two node names collide after sanitising`, () => {
      const seen = new Map();
      for (const n of glbJson(glb).nodes ?? []) {
        if (typeof n?.name !== 'string') continue;
        const s = sane(n.name);
        assert.ok(!seen.has(s),
          `"${n.name}" and "${seen.get(s)}" both sanitise to "${s}" — the loader appends _1 ` +
          `to the second, so it becomes unreachable by name while the first still works`);
        seen.set(s, n.name);
      }
    });

    const parts = Array.isArray(entry.parts) ? entry.parts : null;
    if (!parts?.length) continue;

    test(`${label} — every part the manifest declares is reachable`, () => {
      const names = new Set(
        (glbJson(glb).nodes ?? [])
          .filter((n) => typeof n?.name === 'string')
          .map((n) => sane(n.name))
      );
      const missing = parts.filter((p) => !names.has(sane(p)));
      assert.deepEqual(missing, [],
        `${label} declares ${JSON.stringify(missing)} but the file has ` +
        `${JSON.stringify([...names])} — compared the way GLTFLoader compares`);
    });
  }
}
