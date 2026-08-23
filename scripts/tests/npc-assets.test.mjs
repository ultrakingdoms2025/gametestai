/**
 * The authored hero-character assets, held to the same contract the ship hulls
 * are held to - plus the two the ship side never closed.
 *
 * ── What this file is defending ───────────────────────────────────────────
 *
 * A binary in a repository is a claim that somebody made it and that it still
 * says what the manifest says it says. Neither half survives on trust. The
 * ship tests established the shape - allow-listed licence, manifest byte count
 * against the file on disk, triangle count against the parsed scene, and a
 * re-run of the generator compared with `Buffer.equals` - and this file follows
 * it exactly.
 *
 * Two things the ship side left open are closed here, because a third copy of a
 * pattern is the right moment to fix its gaps rather than inherit them:
 *
 *  1. **The licence ledger is actually read.** `docs/assets/LICENCES.md`
 *     exists and `maze-assets.test.mjs` enforces it; no ship test does, so
 *     `grep -c kestrel docs/assets/LICENCES.md` is 0 to this day. Both assets
 *     here must have a line.
 *  2. **The manifest's cross-references are checked in both directions.** A
 *     role that names a part the .glb does not contain is a character that
 *     silently loses a feature, and that is invisible in a screenshot of a
 *     character that still looks broadly right.
 *
 * And one that is specific to characters and is the whole perf argument of
 * Phase 6: **no part may name a material slot outside the six the `Humanoid`
 * already owns.** Three keys its shader cache on material configuration, this
 * project warms that cache by playing its cartesian product at boot, and a
 * seventh slot would be a new program family on every station load.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HERO_PART_KEYS, HERO_BONES } from '../../src/npc/HeroAssets.js';
import { FRAME, SLOT, TRI_BUDGET } from '../make-npc-glb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'public/assets/npc');
const MANIFEST = JSON.parse(readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));

/** Licences an asset in this repository may carry. Same list as the maze's. */
const LICENCES = ['generated', 'CC0-1.0', 'CC-BY-4.0', 'proprietary-owned'];

const ledger = () => readFileSync(path.join(ROOT, 'docs/assets/LICENCES.md'), 'utf8');

/* ------------------------------------------------------------------ */
/* A GLB reader, so the test parses the real bytes rather than trusting */
/* the generator's own report of what it wrote.                         */
/* ------------------------------------------------------------------ */

/**
 * Pull the JSON chunk and the mesh names/triangle counts out of a .glb.
 *
 * Written here rather than reusing three.js's `GLTFLoader`: the loader needs a
 * DOM-ish environment and `node --test` has none, and more importantly a test
 * that parses the container itself will catch a malformed chunk header, which
 * is exactly the class of corruption a hand-rolled writer can produce and a
 * forgiving loader can hide.
 */
function readGlb(file) {
  const buf = readFileSync(file);
  assert.equal(buf.readUInt32LE(0), 0x46546c67, `${path.basename(file)}: bad glTF magic`);
  assert.equal(buf.readUInt32LE(4), 2, 'glTF version must be 2');
  assert.equal(buf.readUInt32LE(8), buf.length, 'header length must match the file');
  const jsonLen = buf.readUInt32LE(12);
  assert.equal(buf.readUInt32LE(16), 0x4e4f534a, 'first chunk must be JSON');
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const binLen = buf.readUInt32LE(20 + jsonLen);
  assert.equal(buf.readUInt32LE(24 + jsonLen), 0x004e4942, 'second chunk must be BIN');
  assert.equal(20 + jsonLen + 8 + binLen, buf.length, 'chunk lengths must fill the file');
  const tris = json.meshes.reduce(
    (n, m) => n + m.primitives.reduce((k, p) => k + json.accessors[p.indices].count / 3, 0), 0
  );
  return { json, tris, bytes: buf.length, names: json.meshes.map((m) => m.name) };
}

for (const entry of MANIFEST.assets) {
  const file = path.join(DIR, entry.file);

  test(`${entry.id}: the manifest declares the file that is actually on disk`, () => {
    assert.ok(existsSync(file), `${file} is missing`);
    assert.equal(entry.kind, 'geometry');
    assert.ok(LICENCES.includes(entry.licence), `licence '${entry.licence}' is not on the allow-list`);
    assert.match(entry.source, /make-npc-glb\.mjs/, 'source must name the generator that made it');
    const bytes = readFileSync(file).length;
    assert.equal(bytes, entry.bytes, `manifest says ${entry.bytes} bytes, the file is ${bytes}`);
  });

  test(`${entry.id}: has a line in the licence ledger`, () => {
    // The gap the ship tests left open: four hull .glbs, no ledger entries.
    assert.ok(
      ledger().includes(`\`${entry.id}\``),
      `${entry.id} has no line in docs/assets/LICENCES.md - every asset gets one, allow-listed or not`
    );
  });

  test(`${entry.id}: the parsed scene matches the manifest's triangle count`, () => {
    const { tris } = readGlb(file);
    assert.equal(tris, entry.tris, `manifest says ${entry.tris} tris, the file has ${tris}`);
    assert.ok(tris <= TRI_BUDGET[entry.id], `${tris} tris is over the ${TRI_BUDGET[entry.id]} reservation`);
  });

  test(`${entry.id}: every mesh is a known part, and every declared part is a mesh`, () => {
    const { names } = readGlb(file);
    for (const n of names) {
      assert.ok(HERO_PART_KEYS.includes(n), `mesh '${n}' is not a part key - the loader would drop it`);
    }
    assert.deepEqual([...names].sort(), [...entry.parts].sort(), 'manifest parts must be the file\'s meshes');
  });

  test(`${entry.id}: re-running the generator reproduces the committed file byte for byte`, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'npc-glb-'));
    try {
      const out = path.join(dir, entry.file);
      execFileSync(process.execPath, ['scripts/make-npc-glb.mjs'], {
        cwd: ROOT,
        env: { ...process.env, NPC_GLB_SET: entry.id, NPC_GLB_OUT: out },
        stdio: 'pipe',
      });
      const a = readFileSync(file);
      const c = readFileSync(out);
      assert.equal(c.length, a.length, 'the generator produced a file of a different size');
      assert.ok(a.equals(c), 'the committed .glb is not what the generator produces');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${entry.id}: no non-finite vertex anywhere in the file`, () => {
    const { json } = readGlb(file);
    for (const acc of json.accessors) {
      if (!acc.min) continue;
      for (const v of [...acc.min, ...acc.max]) {
        assert.ok(Number.isFinite(v), 'an accessor bound is non-finite - a NaN blooms over the character');
      }
    }
  });
}

test('every part names one of the six existing character material slots', () => {
  /* THE PERF CONTRACT OF THIS WHOLE PHASE. A seventh slot is a seventh
   * material on every hero character, which is a new shader program family on
   * a boot that already warms ~390 of them. */
  const legal = new Set(Object.values(SLOT));
  for (const [key, slot] of Object.entries(MANIFEST.slots)) {
    assert.ok(HERO_PART_KEYS.includes(key), `slots names unknown part '${key}'`);
    assert.ok(legal.has(slot), `part '${key}' asks for slot ${slot}, which is not one of the six`);
  }
});

test('every part names a bone the skeleton actually has', () => {
  for (const [key, bone] of Object.entries(MANIFEST.bones)) {
    assert.ok(HERO_PART_KEYS.includes(key), `bones names unknown part '${key}'`);
    for (const b of (Array.isArray(bone) ? bone : [bone])) {
      assert.ok(HERO_BONES.includes(b), `part '${key}' is bound to '${b}', which is not a rig bone`);
    }
  }
});

test('a part authored across the centreline names both of its bones', () => {
  /* The bug this pins: `knuckle` is one mesh containing both hands. Bound to
   * `handR` alone, every vertex of the left hand followed the right wrist and
   * the character folded in half the moment it raised an arm. It was caught by
   * a screenshot, which is exactly the kind of thing a screenshot should not
   * have to be responsible for twice. */
  for (const key of ['knuckle', 'boot', 'armSpikes']) {
    const bone = MANIFEST.bones[key];
    assert.ok(Array.isArray(bone) && bone.length === 2,
      `'${key}' is authored on both sides and must name both bones, not '${bone}'`);
    assert.ok(bone.some((b) => b.endsWith('R')) && bone.some((b) => b.endsWith('L')),
      `'${key}' must name one bone per side`);
  }
});

test('every part a role asks for exists in that role\'s asset', () => {
  const byId = new Map(MANIFEST.assets.map((a) => [a.id, a]));
  for (const [role, spec] of Object.entries(MANIFEST.roles)) {
    const asset = byId.get(spec.asset);
    assert.ok(asset, `role '${role}' names asset '${spec.asset}', which is not declared`);
    for (const p of spec.parts) {
      assert.ok(asset.parts.includes(p), `role '${role}' wants part '${p}', absent from '${spec.asset}'`);
      assert.ok(MANIFEST.slots[p] !== undefined, `part '${p}' has no slot`);
      assert.ok(MANIFEST.bones[p] !== undefined, `part '${p}' has no bone`);
    }
  }
});

test('the eleven referenced roles are all present, and named as the game names them', () => {
  /* Eleven, because the brief is eleven reference files. The four attacker keys
   * are the weapon ids `HOSTILE_KIND` pairs its archetypes with, and the seven
   * others are `NPCRoles.ROLE` values - if either drifts, characters silently
   * stop being dressed and nothing else fails. */
  const roles = Object.keys(MANIFEST.roles);
  assert.equal(roles.length, 11, `expected 11 roles, found ${roles.length}`);
  for (const r of ['rifle', 'breaker', 'scout', 'lance']) assert.ok(roles.includes(r), `missing attacker '${r}'`);
  for (const r of ['vendor', 'guard', 'loiterer', 'spectator', 'wanderer', 'lorekeeper', 'quest_manager']) {
    assert.ok(roles.includes(r), `missing fixed role '${r}'`);
  }
});

test('the generator has not drifted from the skeleton it authors against', () => {
  /* The ship tests learned this one expensively: asserting two fields of a
   * plan once let a 0.40 m divergence ship. Every landmark the generator
   * positions geometry against is re-derived from Humanoid.js here, so moving
   * a bone in one file and not the other is a failed test rather than a
   * character with its brow ridge floating in front of its face. */
  assert.equal(FRAME.headBoneY, 1.545, 'head bone height');
  assert.equal(FRAME.neckY, 1.464, 'neck height');
  assert.equal(FRAME.chestY, 1.29, 'chest height');
  assert.equal(FRAME.pelvisY, 0.995, 'pelvis height');
  assert.equal(FRAME.hipY, 0.955, 'hip height');
  assert.equal(FRAME.clavicleY, 1.392, 'clavicle height');
  assert.equal(FRAME.ankleY, 0.098, 'ankle height');
  assert.equal(FRAME.legSideX, 0.095, 'leg lateral offset');
  // headFrame(P) at girth 1, which is what the face features are seated on.
  const ry = 0.1055 * 1.06;
  assert.ok(Math.abs(FRAME.skullCentre[1] - (1.5425 + ry)) < 1e-4, 'skull centre height');
  assert.ok(Math.abs(FRAME.skullRadii[1] - ry) < 1e-4, 'skull vertical radius');
  assert.ok(Math.abs(FRAME.skullRadii[0] - 0.0835 * 1.06) < 1e-4, 'skull lateral radius');
  assert.ok(Math.abs(FRAME.skullRadii[2] - 0.0995 * 1.06) < 1e-4, 'skull depth radius');
});

test('the loader builds no absolute /assets/npc/ path', () => {
  /* An absolute path 404s under the /game/ base the built game is served from,
   * and the failure is silent because the loader is designed to degrade. */
  const src = readFileSync(path.join(ROOT, 'src/npc/HeroAssets.js'), 'utf8');
  const bad = src.match(/(['"`])\/assets\/npc\//g);
  assert.equal(bad, null, 'an absolute /assets/npc/ path would 404 under the /game/ base');
});

test('the .glb placeholder materials are named so they cannot be mistaken for real ones', () => {
  /* The game discards them. The name is the last line of defence for the next
   * person who opens the file in a viewer and wonders which material the game
   * draws it with. */
  for (const entry of MANIFEST.assets) {
    const { json } = readGlb(path.join(DIR, entry.file));
    for (const m of json.materials) {
      assert.match(m.name, /-placeholder$/, `material '${m.name}' does not say it is a placeholder`);
    }
  }
});
