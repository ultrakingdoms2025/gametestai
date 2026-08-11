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
   * takes it as a source either way. */
  const src = await readFile(path.join(root, 'src/worlds/maze/MazeChunks.js'), 'utf8');
  const lights = [...src.matchAll(/new THREE\.\w*Light\(/g)];
  assert.ok(lights.length > 0, 'MazeChunks creates no lights at all');
  assert.ok(/lantern\.visible\s*=\s*false/.test(src),
    'a light is created without being hidden first - it will be counted for one frame');
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
