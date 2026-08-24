import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('every light the maze creates starts hidden, so it never counts for a frame', async () => {
  /* LightRig claims lights on its next walk and the counts in every shader
   * cache key are fixed - but a light created VISIBLE inside a streamed chunk
   * is counted for the frame between its creation and that walk, which is
   * enough to compile a program. Creating it hidden costs nothing: the rig
   * takes it as a source either way.
   *
   * This used to read `/lantern\.visible\s*=\s*false/`, and the maze is the
   * reason the whole-tree gate now exists: the same assertion was owed by
   * sixty-four sites across fourteen world files and only three of them paid
   * it. `pointLight` is the hidden constructor, `scripts/tests/
   * world-light-visibility.test.mjs` is what forbids any other, and this stays
   * as the maze's own tripwire because the maze is the STREAMING case - its
   * lights are built while the world is already on screen, so the window this
   * closes is genuinely open here and not merely latent. */
  const src = await readFile(path.join(root, 'src/worlds/maze/MazeChunks.js'), 'utf8');
  const lights = [...src.matchAll(/\b(pointLight|spotLight|dirLight)\(/g)];
  assert.ok(lights.length >= 2,
    `MazeChunks creates ${lights.length} lights through gfx/WorldLight.js - the candle flame `
    + 'and the district lantern are both meant to come from there');
  assert.ok(!/new THREE\.\w*Light\(/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')),
    'MazeChunks constructs a THREE light directly - it would be live for the frame between '
    + 'the streamed district appearing and LightRig\'s next walk');
  assert.match(src, /from '\.\.\/\.\.\/gfx\/WorldLight\.js'/,
    'MazeChunks no longer imports the hidden light constructors');
});

test('the maze disposes its lights with the district that owns them', async () => {
  /* A walk across the maze evicts a district every 120 m. A lantern left
   * behind is a source the rig goes on scoring forever. */
  const src = await readFile(path.join(root, 'src/worlds/maze/MazeChunks.js'), 'utf8');
  const drops = [...src.matchAll(/entry\.lantern/g)];
  assert.ok(drops.length >= 2,
    `only ${drops.length} references to entry.lantern - drop() and disposeAll() must both release it`);
});

test('the maze allocates no material or texture per chunk', async () => {
  /* A tripwire, not a red-then-green: this passes today and exists so the art
   * pass cannot quietly undo the caching that keeps the shader count flat.
   * A texture built per chunk would be worse than a material per chunk. */
  const src = await readFile(path.join(root, 'src/worlds/maze/MazeChunks.js'), 'utf8');
  for (const forbidden of [/makeNoiseTexture/, /new THREE\.\w*Texture\(/, /new THREE\.Mesh\w+Material\(/]) {
    assert.ok(!forbidden.test(src),
      `MazeChunks builds ${forbidden} per chunk - materials and textures are cached in MazeMaterials.buildMazeMaterials`);
  }
});
