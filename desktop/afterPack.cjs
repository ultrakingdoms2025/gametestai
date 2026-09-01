/**
 * electron-builder `afterPack` hook — flip the Electron fuses.
 *
 * ── WHAT A FUSE IS, AND WHY THIS FILE EXISTS ──────────────────────────────
 * Fuses are a bitfield compiled into the Electron binary itself. `@electron/
 * fuses` rewrites that bitfield in the packaged executable, so the setting
 * cannot be undone by an environment variable, a command-line flag, or an
 * edit to anything shipped alongside the exe — which is precisely what makes
 * them worth doing and what a config file cannot achieve.
 *
 * Until this hook existed the desktop build shipped with every fuse at its
 * default, and the September 2026 audit named the two consequences:
 *
 *   1. `ELECTRON_RUN_AS_NODE=1 "Aether Nexus.exe" -e "…"` made the SIGNED,
 *      INSTALLED game a general-purpose Node interpreter. Every allowlisting,
 *      EDR and parental-control product on the machine sees a trusted binary
 *      running; the script it runs is whatever the caller passed. Turning
 *      `RunAsNode` off is the single highest-value fuse here.
 *   2. With `OnlyLoadAppFromAsar` off, Electron's module search order prefers
 *      `resources/app/` over `resources/app.asar`. Any process that could
 *      write the install directory — and with `perMachine: false` that meant
 *      any non-admin process at all — could create `resources/app/main.cjs`
 *      and own the app permanently, with no need to touch the signed exe or
 *      the asar. `nsis.perMachine` is now `true` so the install root needs
 *      elevation to write, and this fuse means even a writable root is not
 *      enough: Electron will refuse to load anything but the asar.
 *
 * The rest close the adjacent doors: `NODE_OPTIONS` can inject a `--require`
 * into the main process, `--inspect` opens a debugger port that can evaluate
 * in the main process, and cookie encryption keeps the session cookie — which
 * is a logged-in Aether Nexus account — from being readable as plaintext by
 * anything that can open the profile directory.
 *
 * `EnableEmbeddedAsarIntegrityValidation` is the one that needs a partner:
 * the fuse only makes Electron CHECK a hash, and something has to have put the
 * hash there. electron-builder does, automatically — `computeData()` in
 * `app-builder-lib/out/platformPackager.js` runs whenever asar is enabled and
 * `disableAsarIntegrity` is not set, and `addWinAsarIntegrity()` writes it into
 * the Windows executable's resources. Both are true of this build (verified
 * against the installed app-builder-lib 26.15.3). If anyone ever sets
 * `asar: false` or `disableAsarIntegrity: true`, this fuse must come off in
 * the same commit or the app will refuse to start.
 *
 * ── ORDERING, WHICH IS LOAD-BEARING ───────────────────────────────────────
 * `afterPack` runs after the app directory is fully assembled (asar packed,
 * integrity hash injected) and BEFORE signing and before the NSIS/appx/zip
 * targets are produced. That order is the only one that works: flipping a fuse
 * rewrites bytes in the exe, so doing it after signing would invalidate the
 * signature, and doing it before the integrity hash was computed would hash
 * the wrong binary.
 */

const path = require('node:path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

/** Where the Electron executable lands for each platform electron-builder packs. */
const BINARY_SUFFIX = {
  win32: '.exe',
  darwin: '.app',
  linux: '',
};

exports.default = async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context;

  const suffix = BINARY_SUFFIX[electronPlatformName];
  if (suffix === undefined) {
    // Loud, not silent. A platform this hook does not know how to find the
    // binary for is a platform shipping with every fuse at its default, and
    // that must not pass as success.
    throw new Error(`[fuses] no known Electron binary layout for ${electronPlatformName}`);
  }

  const binary = path.join(appOutDir, `${packager.appInfo.productFilename}${suffix}`);

  await flipFuses(binary, {
    version: FuseVersion.V1,

    // macOS only: flipping fuses breaks an ad-hoc signature, so re-apply one.
    // Harmless elsewhere; the Windows build never reaches it.
    resetAdHocDarwinSignature: electronPlatformName === 'darwin',

    // The shipped exe stops being a Node interpreter.
    [FuseV1Options.RunAsNode]: false,

    // NODE_OPTIONS can `--require` a file into the main process. Off.
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,

    // `--inspect` / `--inspect-brk` open a port that evaluates in the main
    // process, where there is no sandbox and no context isolation. Off.
    [FuseV1Options.EnableNodeCliInspectArguments]: false,

    // The session cookie is a logged-in account. Encrypt it at rest.
    [FuseV1Options.EnableCookieEncryption]: true,

    // Refuse to run a tampered app.asar. (electron-builder supplies the hash.)
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,

    // Refuse `resources/app/` entirely — asar or nothing.
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });

  console.log(`[fuses] flipped on ${path.basename(binary)} (${electronPlatformName})`);
};
