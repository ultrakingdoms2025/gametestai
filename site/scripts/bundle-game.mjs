/**
 * Build the game and copy it into `public/game`.
 *
 * The game is the Vite project in the repository root. Building it here rather
 * than committing a `dist` keeps one source of truth: the site always ships
 * whatever the game currently is, and nobody has to remember to regenerate a
 * checked-in bundle after changing a shader.
 *
 * Vite is told to emit with a `/game/` base, because the built HTML references
 * its assets by absolute path and those paths have to resolve once the bundle
 * is sitting under a subdirectory rather than at the root.
 */

import { execFileSync } from 'node:child_process';
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(here, '..');
const game = path.resolve(site, '..');
const dist = path.join(game, 'dist');
const dest = path.join(site, 'public', 'game');

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await exists(path.join(game, 'package.json')))) {
    console.error(`No game project found at ${game}.`);
    process.exit(1);
  }

  console.log(`Building the game in ${game} …`);
  execFileSync('npx', ['vite', 'build', '--base=/game/'], {
    cwd: game,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (!(await exists(path.join(dist, 'index.html')))) {
    console.error('The build finished but produced no dist/index.html.');
    process.exit(1);
  }

  // Cleared first, or an asset removed from the build lingers here forever and
  // the next person to look at the bundle finds files that no longer exist.
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  await cp(dist, dest, { recursive: true });

  console.log(`\nCopied the build into ${path.relative(site, dest)}.`);
  console.log('It is served at /game/index.html and gated by /play.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
