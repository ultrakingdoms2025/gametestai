#!/usr/bin/env node
/**
 * Builds a world's authored surface textures - fetch, pack, compress to KTX2,
 * and emit the manifest and licence lines that go with them.
 *
 *   node scripts/make-world-tex.mjs --list
 *   node scripts/make-world-tex.mjs --set maze --out .probe/tex --verify
 *   node scripts/make-world-tex.mjs --set maze --surface stair --dry-run
 *
 * Writing over an existing file needs --force: the default output directory
 * is a world's COMMITTED asset directory, and the manifest asserts the size
 * of every file in it.
 *
 * WHY THIS EXISTS
 *
 * `public/assets/maze/tex/` holds fifteen KTX2 files - five surfaces, three
 * maps each, seventeen megabytes - and they are the reason the maze is the
 * one world that reads as a place rather than as shaded boxes. They were made
 * BY HAND on 2026-08-10 and the toolchain that made them is not on this
 * machine and is not in this repository: no toktx, no basisu, no ktx binary,
 * and three ships only the DECODER. So the single most valuable art step the
 * project has taken could not be repeated, and rolling it out to the other
 * eight worlds was a manual job nobody was going to do.
 *
 * Nothing about the hand pass was lost, though, because a KTX2 file records
 * the parameters it was written with. Reading `KTXwriterScParams` out of all
 * fifteen committed files recovers the recipe exactly:
 *
 *     albedo  ->  --encode etc1s --qlevel 192 --clevel 2      (sRGB transfer)
 *     ORM     ->  --encode etc1s --qlevel 160 --clevel 2      (linear)
 *     normal  ->  --encode uastc --uastc_quality 2 --zcmp 19  (linear)
 *
 * and `KTXwriter` names the tool: toktx v4.4.2 / libktx v4.4.2. Those numbers
 * are not invented here; they are what the maze was actually built with, and
 * ENCODE_PROFILE below is that table transcribed. A normal map is UASTC and
 * not ETC1S because ETC1S quantises to a shared palette and shallow gradients
 * band under it - which on a normal map is a visible terrace across every
 * flat wall, not a subtle loss.
 *
 * The encoder is `ktx2-encoder` (a devDependency): the Basis Universal
 * encoder compiled to wasm, so it needs no native toolchain and runs wherever
 * node runs. That is the whole point - the hand pipeline's fatal flaw was
 * that it depended on a binary one person had installed.
 *
 * WHAT IT DOES
 *
 *  1. Fetches a CC0 source set from ambientCG or Poly Haven into a cache
 *     directory (default `node_modules/.cache/world-tex`, already ignored by
 *     .gitignore) so a re-run never re-downloads. Sources are fetched as PNG,
 *     not JPG: node has no JPEG decoder and writing one is several hundred
 *     lines of Huffman and IDCT, whereas PNG is zlib plus five filters. It
 *     also avoids decoding a lossy source only to re-compress it.
 *  2. Packs ORM to the glTF convention - R=AO, G=roughness, B=metalness -
 *     which is what `MazeMaterials.bakeSurface` emits and what the manifest's
 *     `ormMap` slot means. Poly Haven's `arm` map is ALREADY that layout and
 *     is passed through; ambientCG ships AO, Roughness and (sometimes)
 *     Metalness as separate greyscale files and they are combined here. When
 *     a set has no metalness map the blue channel is zero, which is correct
 *     for every dielectric surface in the maze and is what the existing
 *     licence lines say was done.
 *  3. Downsamples, when the target is smaller than the source, with an
 *     area filter that respects the colour space of what it is filtering -
 *     see `resample` in scripts/lib/png.mjs.
 *  4. Encodes to KTX2 with the recovered profile.
 *  5. Prints the manifest entries in EXACTLY the shape
 *     `public/assets/maze/manifest.json` uses - `surface`, `slot`, `licence`,
 *     `source` and the asserted `bytes` - and the `docs/assets/LICENCES.md`
 *     row, because every external file in this repository gets a line and
 *     `scripts/tests/maze-assets.test.mjs` enforces it.
 *
 * It PRINTS those rather than editing the manifest or the ledger in place. A
 * script that rewrites a committed JSON file it did not fully author is a
 * script that eventually drops an entry it did not understand; the two blocks
 * are small, and pasting them is a decision a person should make. `--emit
 * <path>` writes them to a file when that is more convenient.
 *
 * MEASURED AGAINST THE HAND PASS
 *
 * Re-encoding all five maze surfaces from their CC0 sources and comparing to
 * the fifteen committed files (`--set maze --out .probe/worldtex --verify`):
 *
 *   albedo (ETC1S)  -0.2% .. +0.8%   worst file 6,784 bytes over
 *   ORM    (ETC1S)  -4.9% .. +0.5%   three of five come out SMALLER
 *   normal (UASTC)  +1.8% .. +14.6%  the zstd level, see below
 *   whole set       17.55 MB -> 18.04 MB   (+2.7%)
 *
 * The albedo agreement is the striking one: hedge lands within 99 bytes of
 * the hand-made file and stair within 151, from a different source encoding
 * (PNG here, JPG then) on a different machine. Every file was read back
 * through three's own KTX2Loader and the vendored transcoder and came back
 * as the image that went in, at 23.8-46.2 dB PSNR - ETC1S territory.
 *
 * WHAT IT DOES NOT DO
 *
 * Four toktx knobs are not reachable through ktx2-encoder's public API and
 * are recorded here rather than pretended away. The wasm encoder exports
 * `setMipSRGB`, `setMipRenormalize`, `setMipWrapping` and `setMipFilter`, but
 * `applyInputOptions` does not wire them, so mip generation inside Basis runs
 * on its own defaults; and `setKTX2UASTCSupercompression` is a boolean, so
 * the zstd level is Basis's default rather than toktx's `--zcmp 19`. That
 * last one is the whole +2.7%: zstd is LOSSLESS, so the pixels are identical
 * either way and the only cost is download size. Closing it means wiring
 * those setters upstream, which is a pull request, not a lie in a comment.
 */
import { mkdir, readFile, writeFile, stat, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { encodeToKTX2 } from 'ktx2-encoder';
import { read as readKTX2 } from 'ktx-parse';
import { decodePNG, resample, psnrRGB } from './lib/png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ */
/* Sources                                                             */

/**
 * ambientCG ships one zip per material at each resolution, with the maps as
 * separate greyscale/RGB PNGs named `<id>_<res>-PNG_<Map>.png`. Everything
 * there is CC0.
 */
function ambientCG(id, { res = '2K' } = {}) {
  const file = `${id}_${res}-PNG.zip`;
  const url = `https://ambientcg.com/get?file=${file}`;
  return {
    kind: 'ambientcg',
    id,
    licence: 'CC0-1.0',
    /* The manifest's `source` for the maze's ambientCG surfaces is the zip
     * URL, not the page - matched here so a regenerated entry diffs clean
     * against the committed one. */
    manifestSource: url,
    page: `https://ambientcg.com/view?id=${id}`,
    downloads: [{ url, as: file }],
    ledger: `ambientCG **${id}** (<https://ambientcg.com/view?id=${id}>), fetched as <${url}>`,
    async load(cache) {
      const zip = await readFile(path.join(cache, file));
      const stem = `${id}_${res}-PNG`;
      const pick = (suffix) => {
        const entry = `${stem}_${suffix}.png`;
        return zipHas(zip, entry) ? decodePNG(unzip(zip, entry)) : null;
      };
      const albedo = pick('Color');
      /* NormalGL, never NormalDX. three's MeshStandardMaterial reads +Y up;
       * a DX map is the same data with green inverted and lights every dent
       * as a bump. ambientCG ships both in the same zip, one letter apart. */
      const normal = pick('NormalGL');
      const ao = pick('AmbientOcclusion');
      const roughness = pick('Roughness');
      const metalness = pick('Metalness');
      if (!albedo) throw new Error(`${id}: no Color map in ${file}`);
      if (!normal) throw new Error(`${id}: no NormalGL map in ${file}`);
      if (!ao || !roughness) throw new Error(`${id}: needs AmbientOcclusion and Roughness to pack ORM`);
      return { albedo, normal, orm: packORM(ao, roughness, metalness), hadMetalness: !!metalness };
    },
  };
}

/**
 * Poly Haven serves loose files off its CDN and its `arm` map is already the
 * glTF ORM layout - AO in red, roughness in green, metalness in blue - so
 * there is nothing to pack. Everything there is CC0.
 */
function polyHaven(slug, { res = '2k' } = {}) {
  const base = `https://dl.polyhaven.org/file/ph-assets/Textures/png/${res}/${slug}`;
  const names = { albedo: 'diff', normal: 'nor_gl', orm: 'arm' };
  const downloads = Object.values(names).map((m) => ({
    url: `${base}/${slug}_${m}_${res}.png`,
    as: `${slug}_${m}_${res}.png`,
  }));
  return {
    kind: 'polyhaven',
    id: slug,
    licence: 'CC0-1.0',
    /* The maze's Poly Haven entries carry the asset PAGE as `source`. */
    manifestSource: `https://polyhaven.com/a/${slug}`,
    page: `https://polyhaven.com/a/${slug}`,
    downloads,
    ledger: `Poly Haven **${slug}** (<https://polyhaven.com/a/${slug}>), fetched as `
      + `\`${slug}_{diff,nor_gl,arm}_${res}.png\` from <${base}/>`,
    async load(cache) {
      const at = async (m) => decodePNG(await readFile(path.join(cache, `${slug}_${m}_${res}.png`)));
      return {
        albedo: await at(names.albedo),
        normal: await at(names.normal),
        /* Passed through, not repacked: Poly Haven's arm IS R=AO, G=rough,
         * B=metal. Repacking it from its own channels would be identity with
         * an extra rounding step. */
        orm: await at(names.orm),
        hadMetalness: null, // the arm map carries whatever the author put there
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* The declared sets                                                   */

/**
 * A set is one world's surfaces. `size` is the encoded edge in pixels and is
 * a download-budget decision before it is an art one: the maze's five
 * surfaces are 17 MB of the 20 MB in public/, so 1024 is the default and 2048
 * has to be earned by texel density - a surface whose tile covers two metres
 * and is walked past at arm's length earns it, a stair tread seen from four
 * metres does not.
 *
 * The maze set is transcribed from the committed manifest and licence ledger,
 * which makes it the pipeline's own regression case: run it and the output
 * should land on the same five surfaces at the same five sizes.
 */
export const TEXTURE_SETS = Object.freeze({
  maze: {
    out: 'public/assets/maze/tex',
    idPrefix: 'surf',
    surfaces: [
      {
        name: 'hedge', size: 2048, source: ambientCG('Moss002'),
        note: 'the hedge mass - the single most-drawn surface in the world, filling most of every corridor framing, which is what earns 2048',
      },
      {
        name: 'floor', size: 2048, source: polyHaven('dirt_floor'), tileMetres: 2.07,
        note: 'the corridor floor, seen at grazing angle down every run of the maze - the other surface that earns 2048',
      },
      {
        name: 'stair', size: 1024, source: ambientCG('Travertine003'),
        note: 'pale banded travertine for the stair and shaft-wall stonework; the budget class it replaced was 512 procedural, so 1024 authored is already a step up',
      },
      {
        name: 'footing', size: 1024, source: polyHaven('castle_wall_slates'), tileMetres: 2.5,
        note: 'weathered stacked stone courses for the hedge footings',
      },
      {
        name: 'tunnel', size: 1024, source: polyHaven('park_dirt'), tileMetres: 3,
        note: 'warm packed dirt with fine debris for the tunnel treads',
      },
    ],
  },
});

/* ------------------------------------------------------------------ */
/* Encode profiles - recovered from the committed files, see the header */

export const ENCODE_PROFILE = Object.freeze({
  map: {
    slot: 'map', suffix: 'albedo', space: 'srgb',
    /* `handRecipe` is the toktx command line read verbatim out of all five
     * committed albedo files. `scParams` is what THIS encoder did, written
     * into its own output. They are equal for the two ETC1S slots and differ
     * for the normal map by one setting nobody can reach - see below.
     * `scripts/tests/world-tex-pipeline.test.mjs` pins handRecipe against the
     * committed bytes, so the transcription cannot rot. */
    handRecipe: '--encode etc1s --qlevel 192 --clevel 2',
    scParams: '--encode etc1s --qlevel 192 --clevel 2',
    options: {
      isUASTC: false, qualityLevel: 192, compressionLevel: 2,
      isSetKTX2SRGBTransferFunc: true, isPerceptual: true,
    },
  },
  normalMap: {
    slot: 'normalMap', suffix: 'normal', space: 'normal',
    handRecipe: '--encode uastc --uastc_quality 2 --zcmp 19',
    /* The one deviation from the hand pass, stated rather than hidden:
     * ktx2-encoder exposes zstd supercompression as a BOOLEAN, so the level
     * is Basis's default and not toktx's 19. Measured cost on the maze set:
     * +3.3% on the 2048px normal maps and +14.6% on the 1024px ones. Nothing
     * else about the file differs, and the level is a pure size/time trade -
     * zstd is lossless, so no pixel moves. */
    scParams: '--encode uastc --uastc_quality 2 --zcmp default',
    options: {
      isUASTC: true, uastcLDRQualityLevel: 2, needSupercompression: true,
      isSetKTX2SRGBTransferFunc: false, isPerceptual: false,
      /* Deliberately NOT `isNormalMap: true`. That calls the encoder's
       * normal-map PRESET, which moves several knobs at once and is applied
       * after the transfer-function setter, so it can quietly undo the linear
       * tagging above. The hand pass did not use a preset either - its
       * recovered parameters are three explicit flags. */
    },
  },
  ormMap: {
    slot: 'ormMap', suffix: 'orm', space: 'linear',
    handRecipe: '--encode etc1s --qlevel 160 --clevel 2',
    scParams: '--encode etc1s --qlevel 160 --clevel 2',
    options: {
      isUASTC: false, qualityLevel: 160, compressionLevel: 2,
      isSetKTX2SRGBTransferFunc: false, isPerceptual: false,
    },
  },
});

/** Options every slot shares. */
export const COMMON_OPTIONS = Object.freeze({
  isKTX2File: true,
  generateMipmap: true,
  /* Measured, not assumed: with isYFlip unset the wasm encoder preserves row
   * order, and with it true the image comes back inverted. The committed
   * hand-made files carry KTXorientation "rd" (top row first), so preserving
   * row order is what matches them. Pinned explicitly so a future default
   * flip in the wasm cannot silently invert every normal map's green channel.
   */
  isYFlip: false,
});

/* ------------------------------------------------------------------ */
/* ORM packing                                                          */

/**
 * R=AO, G=roughness, B=metalness, A=255 - the glTF convention, which is what
 * every consumer in this repository expects.
 *
 * Reads the RED channel of each input rather than luminance: these are
 * greyscale masks stored as RGB, so red IS the value, and a luminance
 * weighting would darken a channel that is meant to be passed through.
 */
export function packORM(ao, roughness, metalness) {
  const { width, height } = ao;
  for (const [name, img] of [['roughness', roughness], ['metalness', metalness]]) {
    if (img && (img.width !== width || img.height !== height)) {
      throw new Error(`${name} map is ${img.width}x${img.height}, AO is ${width}x${height}`);
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = ao.data[i];
    data[i + 1] = roughness.data[i];
    data[i + 2] = metalness ? metalness.data[i] : 0;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

/* ------------------------------------------------------------------ */
/* Fetch cache                                                          */

async function ensureCached(cache, { url, as }, { log }) {
  const dest = path.join(cache, as);
  if (existsSync(dest)) {
    const { size } = await stat(dest);
    log(`  cached  ${as} (${mib(size)})`);
    return dest;
  }
  log(`  fetch   ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  await mkdir(cache, { recursive: true });
  /* Written under a temp name and renamed, so an interrupted download can
   * never leave a truncated file that the next run reports as "cached". */
  const tmp = `${dest}.part`;
  await writeFile(tmp, bytes);
  await rename(tmp, dest);
  log(`          ${mib(bytes.length)}`);
  return dest;
}

/* ------------------------------------------------------------------ */
/* Zip (read-only, enough for ambientCG)                                */

function eocd(buf) {
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 0x10000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('not a zip (no end-of-central-directory record)');
}

/** @returns {Map<string, {method:number, csize:number, offset:number}>} */
function zipIndex(buf) {
  const end = eocd(buf);
  let off = buf.readUInt32LE(end + 16);
  const count = buf.readUInt16LE(end + 10);
  const index = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const offset = buf.readUInt32LE(off + 42);
    index.set(buf.toString('utf8', off + 46, off + 46 + nameLen), { method, csize, offset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return index;
}

function zipHas(buf, name) { return zipIndex(buf).has(name); }

function unzip(buf, name) {
  const e = zipIndex(buf).get(name);
  if (!e) throw new Error(`zip has no entry '${name}'`);
  if (buf.readUInt32LE(e.offset) !== 0x04034b50) throw new Error(`corrupt local header for '${name}'`);
  /* The local header repeats the name and extra lengths and they can DIFFER
   * from the central directory's, so the data offset must be computed from
   * the local header - reading the central one here is the classic zip bug. */
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  const body = buf.subarray(start, start + e.csize);
  if (e.method === 0) return body;
  if (e.method === 8) return zlib.inflateRawSync(body);
  throw new Error(`zip entry '${name}' uses compression method ${e.method}`);
}

/* ------------------------------------------------------------------ */
/* Encode                                                               */

const mib = (n) => `${(n / 1048576).toFixed(2)} MB`;

/**
 * @param {{width:number,height:number,data:Uint8Array}} image RGBA8
 * @param {object} profile one of ENCODE_PROFILE
 * @param {boolean} quiet the wasm encoder writes a slice table to stdout
 */
export async function encode(image, profile, quiet = true) {
  const log = console.log;
  if (quiet) console.log = () => {};
  try {
    return await encodeToKTX2(image.data, {
      ...COMMON_OPTIONS,
      ...profile.options,
      /* Node has no image decoder, so ktx2-encoder demands one; the pixels
       * are already RGBA8 by this point, so this hands them straight over. */
      imageDecoder: async () => image,
      /* The provenance that made this script possible in the first place -
       * written back so the next person can recover the recipe from the file
       * exactly the way this one was recovered from the maze's. */
      kvData: { KTXwriterScParams: profile.scParams },
    });
  } finally {
    console.log = log;
  }
}

/* ------------------------------------------------------------------ */
/* Emit                                                                 */

function manifestEntry(set, surface, profile, file, bytes) {
  return {
    id: `${set.idPrefix}-${surface.name}-${profile.suffix}`,
    file: `tex/${path.basename(file)}`,
    kind: 'texture',
    surface: surface.name,
    slot: profile.slot,
    licence: surface.source.licence,
    source: surface.source.manifestSource,
    bytes,
  };
}

function ledgerRow(set, surface, entries, hadMetalness, today) {
  const ids = entries.map((e) => `\`${e.id}\``).join(', ');
  const files = `\`${set.out}/${surface.name}-*.ktx2\``;
  const size = entries[0].size;
  const packed = surface.source.kind === 'polyhaven'
    ? "Poly Haven's `arm` map is already the glTF ORM layout and is passed through unchanged"
    : 'ORM packed to the glTF convention (R=AO, G=roughness, B=metalness'
      + `${hadMetalness ? '' : ', metal=0 - the set ships no metalness map, which is correct for a dielectric'})`;
  const scale = surface.tileMetres ? ` Physical scale ${surface.tileMetres}m per tile, per the asset's own metadata.` : '';
  const note = surface.note.charAt(0).toUpperCase() + surface.note.slice(1);
  return `| ${ids} | ${files} | \`${surface.source.licence}\` | ${surface.source.ledger}. ${note}. ${packed}, `
    + `and the set compressed to KTX2 at ${size}px by \`scripts/make-world-tex.mjs\` (ETC1S for albedo/ORM, UASTC for `
    + `the normal map - a normal map compressed as ETC1S bands on shallow gradients).${scale} No attribution owed; `
    + `recorded because every external file gets a line. | ${today} |`;
}

/* ------------------------------------------------------------------ */
/* Verify                                                              */

/**
 * Reads the emitted file back through three's own KTX2Loader and the vendored
 * Basis transcoder, and reports what three makes of it.
 *
 * This is the gate the whole script stands on. An encoder whose output the
 * game cannot read is worse than no encoder, and "it wrote a file" is not
 * evidence - the file has to parse, carry the right colour space, transcode,
 * and come back as the image that went in.
 */
async function verify(bytes, image, profile) {
  const { loadKTX2Headless } = await import('./lib/ktx2-roundtrip.mjs');
  const container = readKTX2(bytes);
  const tex = await loadKTX2Headless(bytes);
  const level0 = tex.mipmaps?.[0]?.data;
  const expectSpace = profile.options.isSetKTX2SRGBTransferFunc ? 'srgb' : 'srgb-linear';
  const problems = [];
  if (tex.colorSpace !== expectSpace) {
    problems.push(`three read colour space '${tex.colorSpace}', expected '${expectSpace}'`);
  }
  if (tex.image?.width !== image.width || tex.image?.height !== image.height) {
    problems.push(`three read ${tex.image?.width}x${tex.image?.height}, encoded ${image.width}x${image.height}`);
  }
  const expectLevels = Math.log2(image.width) + 1;
  if (container.levels.length !== expectLevels) {
    problems.push(`${container.levels.length} mip levels, expected ${expectLevels}`);
  }
  let psnr = null;
  if (level0 && level0.length === image.data.length) {
    psnr = psnrRGB(image.data, level0);
  } else {
    problems.push(`level 0 came back as ${level0?.length ?? 0} bytes, expected ${image.data.length}`);
  }
  return { psnr, levels: container.levels.length, colorSpace: tex.colorSpace, problems };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */

function parseArgs(argv) {
  const args = {
    set: null, surfaces: [], out: null, size: null,
    cache: path.join(ROOT, 'node_modules/.cache/world-tex'),
    verify: false, dryRun: false, list: false, emit: null, verbose: false, force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') args.list = true;
    else if (a === '--verify') args.verify = true;
    else if (a === '--force') args.force = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--verbose') args.verbose = true;
    else if (a === '--set') args.set = argv[++i];
    else if (a === '--surface') args.surfaces.push(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--cache') args.cache = path.resolve(argv[++i]);
    else if (a === '--emit') args.emit = argv[++i];
    else if (a === '--size') args.size = Number(argv[++i]);
    else throw new Error(`unknown argument '${a}'`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = console.log.bind(console);

  if (args.list || !args.set) {
    log('Declared texture sets:\n');
    for (const [name, set] of Object.entries(TEXTURE_SETS)) {
      log(`  ${name}  ->  ${set.out}`);
      for (const s of set.surfaces) {
        log(`    ${s.name.padEnd(10)} ${String(s.size).padStart(4)}px  ${s.source.kind}:${s.source.id}`);
      }
    }
    log('\n  node scripts/make-world-tex.mjs --set <name> [--surface <name>]... [--verify]');
    if (!args.set) process.exitCode = args.list ? 0 : 1;
    return;
  }

  const set = TEXTURE_SETS[args.set];
  if (!set) throw new Error(`no declared set '${args.set}' - try --list`);
  const surfaces = args.surfaces.length
    ? set.surfaces.filter((s) => args.surfaces.includes(s.name))
    : set.surfaces;
  if (!surfaces.length) throw new Error(`no surface matched ${args.surfaces.join(', ')}`);

  const outDir = path.resolve(ROOT, args.out ?? set.out);
  if (!args.dryRun) await mkdir(outDir, { recursive: true });
  await mkdir(args.cache, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const entries = [];
  const rows = [];
  let total = 0;

  for (const surface of surfaces) {
    const size = args.size ?? surface.size;
    log(`\n${surface.name} (${size}px, ${surface.source.kind}:${surface.source.id})`);
    for (const d of surface.source.downloads) await ensureCached(args.cache, d, { log });

    const maps = await surface.source.load(args.cache);
    const surfaceEntries = [];

    for (const key of ['map', 'normalMap', 'ormMap']) {
      const profile = ENCODE_PROFILE[key];
      const src = { map: maps.albedo, normalMap: maps.normal, ormMap: maps.orm }[key];
      const image = resample(src, size, profile.space);
      const t0 = Date.now();
      const bytes = await encode(image, profile, !args.verbose);
      const file = path.join(outDir, `${surface.name}-${profile.suffix}.ktx2`);
      /* The default output directory is a world's COMMITTED asset directory,
       * so an unguarded write clobbers shipped bytes that a manifest already
       * asserts the size of. That is not hypothetical: the first run of this
       * script overwrote three of the maze's hand-made files, and only
       * `git checkout` got them back. A re-encode has to be asked for. */
      if (!args.dryRun && existsSync(file) && !args.force) {
        throw new Error(`${path.relative(ROOT, file)} already exists. Re-encoding a committed texture `
          + 'changes bytes the manifest asserts - pass --force if that is what you mean, '
          + 'or --out <dir> to write somewhere else.');
      }
      if (!args.dryRun) await writeFile(file, bytes);
      total += bytes.byteLength;
      log(`  ${profile.suffix.padEnd(7)} ${String(bytes.byteLength).padStart(9)} bytes  `
        + `${(bytes.byteLength / 1024).toFixed(0).padStart(5)} KB  ${((Date.now() - t0) / 1000).toFixed(1)}s`
        + `${args.dryRun ? '  (dry run, not written)' : ''}`);

      if (args.verify) {
        const v = await verify(bytes, image, profile);
        log(`          three: ${v.colorSpace}, ${v.levels} levels, `
          + `PSNR ${v.psnr === Infinity ? 'lossless' : `${v.psnr.toFixed(2)} dB`}`);
        for (const p of v.problems) log(`          FAIL: ${p}`);
        if (v.problems.length) process.exitCode = 1;
      }

      const entry = manifestEntry(set, surface, profile, file, bytes.byteLength);
      entry.size = size;
      surfaceEntries.push(entry);
    }
    entries.push(...surfaceEntries);
    rows.push(ledgerRow(set, surface, surfaceEntries, maps.hadMetalness, today));
  }

  if (args.verify) {
    const { disposeKTX2Headless } = await import('./lib/ktx2-roundtrip.mjs');
    await disposeKTX2Headless();
  }

  /* `size` is scaffolding for the ledger row, not a manifest field - the
   * committed manifest has no such key and an extra one would fail the
   * shape the loader and its test agree on. */
  const forManifest = entries.map((e) => {
    const copy = { ...e };
    delete copy.size;
    return copy;
  });
  const manifest = JSON.stringify(forManifest, null, 2).replace(/^/gm, '    ').trim();
  const blocks = [
    `\n${'-'.repeat(70)}`,
    `total: ${total} bytes (${mib(total)}) across ${entries.length} files`,
    `\nManifest entries for ${set.out.replace(/tex$/, 'manifest.json')} ("assets"):\n`,
    manifest,
    `\nLedger rows for docs/assets/LICENCES.md:\n`,
    ...rows,
    '',
  ].join('\n');
  log(blocks);
  if (args.emit) {
    await writeFile(path.resolve(ROOT, args.emit), blocks);
    log(`written to ${args.emit}`);
  }
}

/* Run only when invoked as a script. Compared as resolved PATHS, not as URL
 * strings: on Windows `file://${process.argv[1]}` is `file://E:\...` and
 * import.meta.url is `file:///E:/...`, so the string form never matches and
 * the module would import silently doing nothing - or, with a loose
 * basename fallback, would run itself when the test suite imports it. */
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`make-world-tex: ${e.message}`);
    process.exitCode = 1;
  });
}
