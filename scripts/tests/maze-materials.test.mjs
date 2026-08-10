import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildMazeMaterials, materialFingerprint, MAZE_PROGRAM_FAMILIES,
} from '../../src/worlds/maze/MazeMaterials.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('the maze compiles no more material families than it declares', () => {
  /* Phase 5 froze `renderer.info.programs.length`. That was the right gate when
   * nothing about the materials was allowed to change, and it is the wrong one
   * now: PBR maps change a program cache key by construction. What survives the
   * relaxation is the thing the frozen count was really protecting - that the
   * number of DISTINCT material feature-sets is small, known, and does not grow
   * when a district streams in. That is checkable here, headless, per commit;
   * the absolute program count is only checkable in a browser. */
  const mats = buildMazeMaterials();
  const seen = new Set(Object.values(mats).map(materialFingerprint));
  assert.ok(seen.size <= MAZE_PROGRAM_FAMILIES.length,
    `${seen.size} distinct material families, ${MAZE_PROGRAM_FAMILIES.length} declared: `
    + `${[...seen].filter((f) => !MAZE_PROGRAM_FAMILIES.includes(f)).join(', ')}`);
});

test('every family the set produces is on the declared list, by name', () => {
  /* The count test above would pass if a family were swapped for a different
   * one - fifteen declared, fifteen produced, none of them matching. Growing a
   * family is a deliberate act (Tasks 4 and 5 both do it) and the way it is
   * made deliberate is that the DECLARATION has to change in the same commit
   * as the material. */
  const mats = buildMazeMaterials();
  for (const [kind, mat] of Object.entries(mats)) {
    const f = materialFingerprint(mat);
    assert.ok(MAZE_PROGRAM_FAMILIES.includes(f),
      `'${kind}' compiles undeclared family '${f}' - add it to MAZE_PROGRAM_FAMILIES deliberately or unwind the change`);
  }
});

test('two calls hand back the same materials, not two equal sets', () => {
  /* The cached-once rule from Phase 5, now assertable rather than inspectable. */
  const a = buildMazeMaterials(), b = buildMazeMaterials();
  for (const k of Object.keys(a)) assert.equal(a[k], b[k], `material '${k}' was rebuilt`);
});

test('shaftWall IS the stair material, not a colour-matched copy', () => {
  /* Reused verbatim on purpose, since Phase 2c: a shaft must read as one
   * continuous piece of pale stonework, tower walls and treads alike. Identity
   * rather than equality also means the two can never drift apart when one of
   * them gains a map in Task 5 - there is only one material to change. A copy
   * with equal values would pass every visual check today and split into two
   * program families the first time somebody edits one of them. */
  const m = buildMazeMaterials();
  assert.equal(m.shaftWall, m.stair, 'shaftWall was rebuilt as its own material - the identity is the contract');
});

test('MazeWorld no longer builds materials itself', async () => {
  const src = await readFile(path.join(root, 'src/worlds/MazeWorld.js'), 'utf8');
  assert.ok(!/new THREE\.Mesh\w*Material\(/.test(src),
    'a material literal is back in MazeWorld - the family gate cannot see it there');
});
