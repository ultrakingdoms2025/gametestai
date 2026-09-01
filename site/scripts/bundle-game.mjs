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
 * ── FAILURE IS FATAL. `--if-available` USED TO MEAN IT WAS NOT ────────────
 * The site's build ran this with `--if-available`, which made every way it
 * could fail non-fatal: no game project next door, no dependencies, a broken
 * build - each logged and exited 0, leaving whatever bundle happened to be
 * committed. The argument for it was that a stale game is a bad day and a site
 * that will not deploy is a worse one.
 *
 * The measurement below the `NEEDED` probe is what killed that argument. In
 * the shape it shipped in, this script NEVER ONCE SUCCEEDED on Vercel - not on
 * the deploy that introduced it, nor on any since. Every build logged "Cannot
 * find package 'vite'", took the soft exit, and shipped a stale bundle. The
 * mechanism meant to stop the deployed game going stale was itself the thing
 * going stale, silently, for its whole life, and the flag is the only reason
 * nobody found out. A gate that cannot fail does not report; it just agrees.
 *
 * So: every failure is now fatal by default, and the site's `build` script no
 * longer passes a flag. `git log` and the note above record what the soft exit
 * actually bought, which was nothing.
 *
 * ── THE ESCAPE HATCH, AND THE ONE CASE IT COVERS ──────────────────────────
 * `--if-available` (or `BUNDLE_GAME_OPTIONAL=1`) still exists for local work,
 * and it is REFUSED when `VERCEL` is set, so a deploy cannot opt out of its
 * own gate however the build command is written.
 *
 * Even then it softens exactly ONE failure: there is no game project at `..`
 * at all. That case is distinguishable - a missing sibling `package.json` is
 * "somebody checked out `site/` on its own", which cannot happen on Vercel,
 * where the whole repository is present. Every other failure is NOT
 * distinguishable from a real break and so is fatal in every mode:
 *
 *   * a dependency install that fails is indistinguishable from a registry
 *     outage, a corrupt lockfile, or a dependency that no longer resolves;
 *   * `vite` still missing after the install is the exact fault that hid for
 *     the flag's whole life;
 *   * a build that throws, or one that produces no `dist/index.html`, is a
 *     broken game and nothing else.
 *
 * Failing closed on all four is deliberate. If the storefront must ship while
 * the game is broken, `npm run build:site-only` is right there and says so.
 */

import { execFileSync } from 'node:child_process';
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(here, '..');
const game = path.resolve(site, '..');
const dist = path.join(game, 'dist');
const dest = path.join(site, 'public', 'game');

/* `VERCEL` is set on every Vercel build, of every project, in every
 * environment. It is the one signal that says "this output is going to be
 * served to somebody", and it is what makes the escape hatch below unavailable
 * to a deploy no matter how the build command is written. */
const onVercel = Boolean(process.env.VERCEL);
const askedOptional = process.argv.includes('--if-available') || process.env.BUNDLE_GAME_OPTIONAL === '1';
const optional = askedOptional && !onVercel;

if (askedOptional && onVercel) {
  console.warn('[bundle-game] --if-available/BUNDLE_GAME_OPTIONAL ignored: this is a Vercel build.');
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Give up.
 *
 * `soft` is opt-in per call site and exactly one call site passes it - see the
 * header. Defaulting it to false is the whole change: the previous version
 * defaulted every reason to soft, so adding a new failure mode silently added
 * a new way to ship a stale bundle.
 */
function bail(reason, { soft = false } = {}) {
  if (soft && optional) {
    console.warn(`[bundle-game] ${reason}`);
    console.warn('[bundle-game] keeping the committed bundle in public/game.');
    process.exit(0);
  }
  console.error(`[bundle-game] ${reason}`);
  if (soft) {
    console.error('[bundle-game] pass --if-available to tolerate this outside a Vercel build.');
  }
  process.exit(1);
}

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

async function main() {
  /* THE ONE SOFT FAILURE. A missing sibling `package.json` means `site/` was
   * checked out on its own, which is a shape only a person can produce - on
   * Vercel the whole repository is present, and `onVercel` refuses the flag
   * there anyway. */
  if (!(await exists(path.join(game, 'package.json')))) {
    bail(`no game project found at ${game}.`, { soft: true });
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

  await writeBuildStamp(dest);

  console.log(`\nCopied the build into ${path.relative(site, dest)}.`);
  console.log('It is served at /game/index.html and gated by /play.');
}

/* Which commit is actually deployed.
 *
 * The bundle is committed by hand and this script is allowed to fail softly, so
 * "is the deployed game current?" has always been a real question. It used to be
 * answered by grepping the sourcemaps for a source-level marker -- the only
 * place one survives once the chunk is minified. Those maps are no longer
 * shipped, because they published the whole source tree, so the answer moves
 * here.
 *
 * Written LAST, and only after the copy succeeded, so its presence means a build
 * genuinely ran. A stale stamp then means a stale bundle, which is precisely the
 * question worth being able to ask.
 */
async function writeBuildStamp(dir) {
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: game, encoding: 'utf8' }).trim();
  } catch {
    // A source tarball with no git history still builds; it just cannot say
    // which commit it came from, and "unknown" beats failing the build.
  }

  let count = 0;
  let bytes = 0;
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    count++;
    try {
      bytes += (await stat(path.join(entry.parentPath ?? entry.path, entry.name))).size;
    } catch {
      /* counted but unmeasurable; the count is the load-bearing half */
    }
  }

  const stamp = { commit, builtAt: new Date().toISOString(), files: count, bytes };
  await writeFile(path.join(dir, 'build.json'), `${JSON.stringify(stamp, null, 2)}\n`, 'utf8');
  console.log(
    `[bundle-game] stamped build.json: ${commit.slice(0, 7)}, ${count} files, ${(bytes / 1e6).toFixed(1)} MB`
  );
}

/* Fatal in every mode, `--if-available` included. An exception nobody
 * anticipated is the least distinguishable failure there is - it could be a
 * full disk, a permission, or a bug in this file - so it is the last thing
 * that should be allowed to pass as "the game was not available". */
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
