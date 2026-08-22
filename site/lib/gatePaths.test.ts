import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isGameAssetPath, isGatedGamePath, GAME_ASSET_PREFIX } from './gatePaths';

/**
 * What the launch gate covers, and what it deliberately stops covering.
 *
 * Every request under /game used to run the auth middleware: a JWT decode plus
 * an HMAC verify over the launch cookie, once per file, across 59 files. Vercel
 * runs middleware BEFORE the cache, so a cold first load paid a function
 * invocation for every asset — a cost that does not exist locally, where Vite
 * serves the same files directly. That is the shape of "production is slower
 * than local".
 *
 * Hashed asset files are now excluded. The entry point is still gated, so a
 * non-payer cannot launch the game, and the asset filenames only appear inside
 * that gated document.
 */

describe('isGameAssetPath', () => {
  it('matches hashed bundle assets', () => {
    expect(isGameAssetPath('/game/assets/index-B7A2ogu0.js')).toBe(true);
    expect(isGameAssetPath('/game/assets/three.core-Co-9pgkG.js')).toBe(true);
    expect(isGameAssetPath('/game/assets/maze/tex/hedge.ktx2')).toBe(true);
  });

  it('does not match the entry document', () => {
    expect(isGameAssetPath('/game')).toBe(false);
    expect(isGameAssetPath('/game/')).toBe(false);
    expect(isGameAssetPath('/game/index.html')).toBe(false);
  });

  it('does not match a lookalike prefix outside the asset directory', () => {
    expect(isGameAssetPath('/game/assets')).toBe(false);
    expect(isGameAssetPath('/gameassets/x.js')).toBe(false);
    expect(isGameAssetPath('/game/assetsx/x.js')).toBe(false);
    expect(isGameAssetPath('/notgame/assets/x.js')).toBe(false);
  });

  it('does not let a traversal segment escape the asset directory', () => {
    expect(isGameAssetPath('/game/assets/../index.html')).toBe(false);
    expect(isGameAssetPath('/game/assets/a/../../secret')).toBe(false);
  });

  it('matches the vendor directory the game loads at runtime', () => {
    // The Basis transcoder is fetched by KTX2Loader on demand and is as inert
    // as any other hashed asset.
    expect(isGameAssetPath('/game/vendor/basis/basis_transcoder.wasm')).toBe(true);
  });
});

describe('isGatedGamePath', () => {
  it('gates the entry document', () => {
    expect(isGatedGamePath('/game')).toBe(true);
    expect(isGatedGamePath('/game/')).toBe(true);
    expect(isGatedGamePath('/game/index.html')).toBe(true);
  });

  it('does not gate hashed assets', () => {
    expect(isGatedGamePath('/game/assets/index-B7A2ogu0.js')).toBe(false);
    expect(isGatedGamePath('/game/vendor/basis/basis_transcoder.wasm')).toBe(false);
  });

  it('ignores paths outside /game entirely', () => {
    expect(isGatedGamePath('/')).toBe(false);
    expect(isGatedGamePath('/store')).toBe(false);
    expect(isGatedGamePath('/gameplay')).toBe(false);
  });
});

describe('the middleware matcher itself', () => {
  // The runtime helpers above are defence in depth. The saving only exists if
  // the matcher stops invoking the function at all, and Next requires that
  // matcher to be a statically analysable literal — so it cannot import the
  // constant, and must be pinned textually instead.
  const here = dirname(fileURLToPath(import.meta.url));
  const proxySrc = readFileSync(join(here, '..', 'proxy.ts'), 'utf8');

  it('excludes the game asset directory so the function is never invoked', () => {
    expect(proxySrc).toMatch(/matcher:\s*\[[^\]]*game\/assets[^\]]*\]/);
  });

  it('still excludes the Next internals it always did', () => {
    for (const literal of ['api', '_next/static', '_next/image', 'favicon.ico']) {
      expect(proxySrc).toContain(literal);
    }
  });

  it('agrees with GAME_ASSET_PREFIX, so the two cannot drift apart', () => {
    // GAME_ASSET_PREFIX is '/game/assets/'; the matcher spells it without the
    // leading slash because it sits inside a negative lookahead on the path.
    expect(proxySrc).toContain(GAME_ASSET_PREFIX.replace(/^\/|\/$/g, ''));
  });
});
