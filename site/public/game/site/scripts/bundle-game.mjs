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
 *
 * ── `--if-available` ──────────────────────────────────────────────────────
 * The site's own build runs this with `--if-available`, which makes every way
 * it can fail non-fatal: no game project next door, no dependencies, a broken
 * build - each logs and exits 0, leaving whatever bundle is committed.
 *
 * That flag exists because of a real failure. `site` is a separate Vercel
 * project whose build was plain `next build`, so nothing ever regenerated this
 * bundle; four commits of gameplay fixes shipped to main without changing a
 * byte of what the site served, and the deployed game silently sat two weeks
 * behind the repository. Wiring the bundle into the build fixes that, but it
 * must never be able to take the storefront down with it - a stale game is a
 * bad day, a site that will not deploy is a worse one.
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

/** Best-effort mode: never fail the caller, just leave the committed bundle. */
const optional = process.argv.includes('--if-available');

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Give up, loudly but with the exit code the caller asked for. */
function bail(reason) {
  if (optional) {
    console.warn(`[bundle-game] ${reason}`);
    console.warn('[bundle-game] keeping the committed bundle in public/game.');
    process.exit(0);
  }
  console.error(`[bundle-game] ${reason}`);
  process.exit(1);
}

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

async function main() {
  if (!(await exists(path.join(game, 'package.json')))) {
    bail(`no game project found at ${game}.`);
    return;
  }

  /* The game's dependencies are its own. Vercel installs whatever the project's
   * root directory declares, which for the site is `site/package.json` - so on
   * a deploy the game sits there as source with an empty `node_modules` and
   * nothing it needs to build.
   *
   * ── Both halves of this are load-bearing; the first version had neither ───
   * It probed for `three` and installed with a bare `npm ci`, and in that shape
   * it never once succeeded on Vercel - not on the deploy that introduced it,
   * nor on any since. Every build logged "Cannot find package 'vite'", took the
   * `--if-available` exit, and shipped whatever bundle happened to be
   * committed. The mechanism meant to stop the deployed game going stale was
   * itself the thing going stale, silently, for its whole life.
   *
   *   1. `three` is a *dependency* and `vite` is a *devDependency*. Vercel
   *      builds run with NODE_ENV=production, under which npm omits dev
   *      dependencies - so `three` was restored from the build cache, the probe
   *      saw it, and the install was skipped while the build tool was still
   *      missing. Probe for what is about to be *run*, not for a runtime
   *      library that happens to sit beside it.
   *   2. `--include=dev`, or the install that does happen fetches `three` and
   *      omits `vite` all over again.
   *
   * Verified rather than reasoned about: under NODE_ENV=production a plain
   * install drops a devDependency and adding `--include=dev` restores it. */
  const NEEDED = ['vite', 'three'];
  const missing = [];
  for (const dep of NEEDED) {
    if (!(await exists(path.join(game, 'node_modules', dep)))) missing.push(dep);
  }
  if (missing.length) {
    console.log(`[bundle-game] game dependencies missing (${missing.join(', ')}); installing …`);
    try {
      const lock = await exists(path.join(game, 'package-lock.json'));
      run('npm', [lock ? 'ci' : 'install', '--include=dev', '--no-audit', '--no-fund'], game);
    } catch {
      bail('could not install the game dependencies.');
      return;
    }
  }

  /* Fail loudly here rather than let `npx` paper over it. With no local vite,
   * `npx` downloads one into a temp directory and runs it - but `vite.config.js`
   * imports `vite` by bare specifier, which resolves against the *project's*
   * node_modules and still is not there. The result is a confusing
   * UNRESOLVED_IMPORT against the config file rather than "the tool is not
   * installed", which is exactly how the original fault stayed unread in the
   * build log for as long as it did. */
  if (!(await exists(path.join(game, 'node_modules', 'vite')))) {
    bail('vite is still not installed in the game project after installing.');
    return;
  }

  console.log(`Building the game in ${game} …`);
  try {
    run('npx', ['vite', 'build', '--base=/game/'], game);
  } catch {
    bail('the game build failed.');
    return;
  }

  if (!(await exists(path.join(dist, 'index.html')))) {
    bail('the build finished but produced no dist/index.html.');
    return;
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
  if (optional) {
    console.warn('[bundle-game] unexpected failure, keeping the committed bundle:', e?.message ?? e);
    process.exit(0);
  }
  console.error(e);
  process.exit(1);
});
