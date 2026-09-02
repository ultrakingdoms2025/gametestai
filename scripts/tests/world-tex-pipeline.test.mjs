import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { read as readKTX2 } from 'ktx-parse';

import { decodePNG, resample, psnrRGB } from '../lib/png.mjs';
import { loadKTX2Headless, disposeKTX2Headless } from '../lib/ktx2-roundtrip.mjs';
import { ENCODE_PROFILE, TEXTURE_SETS, packORM, encode } from '../make-world-tex.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAZE_TEX = path.join(root, 'public/assets/maze/tex');

/**
 * The gate on `scripts/make-world-tex.mjs`.
 *
 * The script exists because the maze's fifteen textures were made by hand on
 * a machine that had toktx installed, and could not be re-run anywhere else.
 * Its claim is that a wasm encoder plus a pure-JS decoder reproduce that pass
 * on any machine with node. Two things have to be true for that claim to
 * mean anything, and this file tests both:
 *
 *   1. The output is READABLE BY THE GAME. Not "a file appeared" - three's
 *      own KTX2Loader and the vendored Basis transcoder have to parse it,
 *      tag the right colour space, and transcode it back to the image that
 *      went in. Tested against a committed hand-made file FIRST, so a broken
 *      harness cannot pass a broken encoder.
 *   2. The settings are the ones the maze was actually built with. Those are
 *      not folklore: every committed .ktx2 carries `KTXwriterScParams`, and
 *      the last test here reads them back out and holds ENCODE_PROFILE to
 *      them. Change a quality level and this test says which file disagrees.
 *
 * Nothing here touches the network. The sources are megabytes and live in a
 * cache directory; the pipeline's arithmetic does not need them.
 */

after(() => disposeKTX2Headless());

/* ------------------------------------------------------------------ */
/* A PNG encoder, so the decoder has something to be tested against.   */

const CRC = zlib.crc32 ?? (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(body));
  return Buffer.concat([len, body, crc]);
}

const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
};

/**
 * Encode a PNG whose row N uses filter `filters[N % filters.length]`.
 * Cycling the filters is the point: filters 1-4 are where a hand-written
 * decoder goes wrong, and filter 4 (Paeth) is where it goes wrong quietly.
 *
 * @param {{width:number,height:number,depth:number,colour:number,samples:Uint8Array|Uint16Array,palette?:Buffer}} spec
 *   `samples` is raw channel data in PNG order, not RGBA.
 */
function encodePNG({ width, height, depth, colour, samples, palette, filters = [0, 1, 2, 3, 4] }) {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colour];
  const bpp = Math.max(1, (channels * depth) >> 3);
  const stride = Math.ceil((width * channels * depth) / 8);

  const rows = Buffer.alloc(height * stride);
  for (let i = 0; i < width * height * channels; i++) {
    if (depth === 16) rows.writeUInt16BE(samples[i], i * 2);
    else rows[i] = samples[i];
  }

  const out = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const f = filters[y % filters.length];
    out[y * (stride + 1)] = f;
    for (let x = 0; x < stride; x++) {
      const cur = rows[y * stride + x];
      const a = x >= bpp ? rows[y * stride + x - bpp] : 0;
      const b = y > 0 ? rows[(y - 1) * stride + x] : 0;
      const c = y > 0 && x >= bpp ? rows[(y - 1) * stride + x - bpp] : 0;
      let v;
      if (f === 0) v = cur;
      else if (f === 1) v = cur - a;
      else if (f === 2) v = cur - b;
      else if (f === 3) v = cur - ((a + b) >> 1);
      else v = cur - paeth(a, b, c);
      out[y * (stride + 1) + 1 + x] = v & 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth; ihdr[9] = colour; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    ...(palette ? [chunk('PLTE', palette)] : []),
    chunk('IDAT', zlib.deflateSync(out)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* The control: three reads a hand-made file                           */

test('the round-trip harness reads the committed hand-made maze textures', async () => {
  /* Run FIRST and deliberately. Every later assertion is "three read what
   * the encoder wrote"; if the harness cannot read toktx v4.4.2's output -
   * the files the game ships and renders correctly today - then nothing it
   * says about a newly encoded file is evidence of anything. */
  const albedo = await loadKTX2Headless(readFileSync(path.join(MAZE_TEX, 'stair-albedo.ktx2')));
  assert.equal(albedo.colorSpace, 'srgb', 'a hand-made albedo should come back sRGB-tagged');
  assert.equal(albedo.image.width, 1024);
  assert.equal(albedo.mipmaps.length, 11, '1024px is 11 mip levels down to 1x1');

  const orm = await loadKTX2Headless(readFileSync(path.join(MAZE_TEX, 'stair-orm.ktx2')));
  assert.equal(orm.colorSpace, 'srgb-linear', 'an ORM map is data, not colour');

  const normal = await loadKTX2Headless(readFileSync(path.join(MAZE_TEX, 'stair-normal.ktx2')));
  assert.equal(normal.colorSpace, 'srgb-linear');
});

/* ------------------------------------------------------------------ */
/* PNG decode                                                          */

test('the PNG decoder undoes all five scanline filters exactly', () => {
  const width = 23, height = 15; // not a multiple of anything, on purpose
  const samples = new Uint8Array(width * height * 3);
  for (let i = 0; i < samples.length; i++) samples[i] = (i * 37 + (i % 11) * 19) & 0xff;
  const img = decodePNG(encodePNG({ width, height, depth: 8, colour: 2, samples }));
  assert.equal(img.width, width);
  assert.equal(img.height, height);
  for (let p = 0; p < width * height; p++) {
    assert.equal(img.data[p * 4], samples[p * 3], `red at pixel ${p}`);
    assert.equal(img.data[p * 4 + 1], samples[p * 3 + 1], `green at pixel ${p}`);
    assert.equal(img.data[p * 4 + 2], samples[p * 3 + 2], `blue at pixel ${p}`);
    assert.equal(img.data[p * 4 + 3], 255, 'an RGB PNG is opaque');
  }
});

test('a 16-bit PNG decodes to its high bytes', () => {
  /* Poly Haven serves 16-bit PNGs - every map of every set - so this is not
   * a hypothetical branch. The block compressor is 8-bit, so the low byte is
   * below its noise floor and is dropped rather than rounded. */
  const samples = new Uint16Array([0x1234, 0x5678, 0x9abc, 0xffff, 0x0000, 0x00ff]);
  const img = decodePNG(encodePNG({ width: 2, height: 1, depth: 16, colour: 2, samples, filters: [0] }));
  assert.deepEqual([...img.data], [0x12, 0x56, 0x9a, 255, 0xff, 0x00, 0x00, 255]);
});

test('greyscale and indexed PNGs expand to RGBA', () => {
  /* ambientCG ships Roughness as 8-bit greyscale (colour type 0) and
   * AmbientOcclusion as indexed (colour type 3) in the same zip - both were
   * found in Travertine003, so both are load-bearing. */
  const grey = decodePNG(encodePNG({ width: 3, height: 1, depth: 8, colour: 0, samples: new Uint8Array([7, 128, 255]), filters: [0] }));
  assert.deepEqual([...grey.data.slice(0, 8)], [7, 7, 7, 255, 128, 128, 128, 255]);

  const palette = Buffer.from([10, 20, 30, 40, 50, 60]);
  const indexed = decodePNG(encodePNG({ width: 2, height: 1, depth: 8, colour: 3, samples: new Uint8Array([1, 0]), palette, filters: [0] }));
  assert.deepEqual([...indexed.data], [40, 50, 60, 255, 10, 20, 30, 255]);
});

test('the PNG decoder refuses what it cannot do rather than returning a wrong image', () => {
  const png = encodePNG({ width: 2, height: 2, depth: 8, colour: 2, samples: new Uint8Array(12), filters: [0] });
  png[8 + 8 + 12] = 1; // IHDR interlace byte
  assert.throws(() => decodePNG(png), /interlac/i);
  assert.throws(() => decodePNG(Buffer.alloc(64)), /not a PNG/);
});

/* ------------------------------------------------------------------ */
/* Resampling                                                          */

test('an sRGB downsample averages in linear light, not in code values', () => {
  /* The whole reason `resample` takes a colour space. Black and white average
   * to HALF THE LIGHT, which is code value 188 in sRGB, not 128. Averaging
   * the code values darkens every albedo in the game by about a stop and a
   * half in the midtones, and it looks like "the texture is muddy" rather
   * than like a bug. */
  const data = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
  const src = { width: 2, height: 2, data };
  const srgb = resample(src, 1, 'srgb');
  assert.ok(Math.abs(srgb.data[0] - 188) <= 1, `expected ~188, got ${srgb.data[0]}`);

  const linear = resample(src, 1, 'linear');
  assert.ok(Math.abs(linear.data[0] - 128) <= 1, `expected ~128, got ${linear.data[0]}`);
});

test('a normal-map downsample renormalises', () => {
  /* Two unit vectors 90 degrees apart average to a vector of length 0.707.
   * Left unnormalised it reads as a flatter surface, so a normal map loses
   * its bite every time it is halved - free-looking and cumulative. */
  const px = (x, y, z) => [Math.round((x + 1) * 127.5), Math.round((y + 1) * 127.5), Math.round((z + 1) * 127.5), 255];
  const data = new Uint8Array([...px(1, 0, 0), ...px(0, 0, 1), ...px(1, 0, 0), ...px(0, 0, 1)]);
  const out = resample({ width: 2, height: 2, data }, 1, 'normal');
  const v = [out.data[0] / 127.5 - 1, out.data[1] / 127.5 - 1, out.data[2] / 127.5 - 1];
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 0.02, `expected a unit vector, got length ${Math.hypot(...v)}`);
});

test('resample refuses to upscale', () => {
  /* Silently upscaling would produce a 2048px file with 1024px of detail and
   * a manifest asserting its size - a download cost with nothing behind it. */
  assert.throws(() => resample({ width: 16, height: 16, data: new Uint8Array(16 * 16 * 4) }, 32, 'linear'), /upscale/);
});

/* ------------------------------------------------------------------ */
/* ORM packing                                                         */

test('ORM packs to the glTF convention, metal 0 when the set has no metalness map', () => {
  const solid = (v) => ({ width: 1, height: 1, data: new Uint8Array([v, v, v, 255]) });
  const withMetal = packORM(solid(11), solid(22), solid(33));
  assert.deepEqual([...withMetal.data], [11, 22, 33, 255], 'R=AO, G=roughness, B=metalness');

  const dielectric = packORM(solid(11), solid(22), null);
  assert.deepEqual([...dielectric.data], [11, 22, 0, 255], 'no metalness map means metal=0');

  assert.throws(() => packORM(solid(1), { width: 2, height: 2, data: new Uint8Array(16) }, null), /roughness map is/);
});

/* ------------------------------------------------------------------ */
/* Encode -> three                                                     */

/** A test image with real structure: flat blocks, a ramp, and an edge. */
function testImage(size) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      data[i] = Math.round((x / (size - 1)) * 255);
      data[i + 1] = y < size / 2 ? 40 : 200;
      data[i + 2] = ((x >> 3) + (y >> 3)) % 2 ? 90 : 160;
      data[i + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

for (const [key, profile] of Object.entries(ENCODE_PROFILE)) {
  test(`an encoded ${key} comes back through three's KTX2Loader`, async () => {
    const image = testImage(128);
    const bytes = await encode(image, profile);
    assert.ok(bytes.byteLength > 0, 'the encoder produced no bytes');

    const container = readKTX2(bytes);
    assert.equal(container.vkFormat, 0, 'a Basis-supercompressed KTX2 has vkFormat 0');
    assert.equal(container.levels.length, 8, '128px is 8 mip levels down to 1x1');
    assert.equal(
      container.dataFormatDescriptor[0].transferFunction,
      profile.options.isSetKTX2SRGBTransferFunc ? 2 : 1,
      'the container records the transfer function; the loader does not guess it',
    );
    /* The recipe is written back into the file, which is how this script
     * recovered the hand pass in the first place. */
    assert.equal(container.keyValue.KTXwriterScParams, profile.scParams);

    const tex = await loadKTX2Headless(bytes);
    assert.equal(tex.colorSpace, profile.options.isSetKTX2SRGBTransferFunc ? 'srgb' : 'srgb-linear');
    assert.equal(tex.image.width, 128);
    assert.equal(tex.mipmaps.length, 8);

    const level0 = tex.mipmaps[0].data;
    assert.equal(level0.length, image.data.length, 'level 0 transcoded to a different size than it was encoded at');
    const psnr = psnrRGB(image.data, level0);
    /* A floor, not a target. ETC1S on a hard checkerboard is the codec's
     * worst case; 25 dB is far below what the real sources measure (28-36 dB
     * on the maze set) and exists to catch a channel swap or a garbage
     * transcode, not to grade the codec. */
    assert.ok(psnr > 25, `${key} round-tripped at only ${psnr.toFixed(2)} dB`);
  });
}

/* ------------------------------------------------------------------ */
/* The pin                                                             */

test('ENCODE_PROFILE still matches what the maze was actually built with', () => {
  /* Recovered, not remembered. Every committed .ktx2 carries the toktx
   * command line that made it, so the hand pass is readable off the artefact
   * even though the toolchain is long gone from this machine. If someone
   * retunes a quality level, this says which of the fifteen files disagrees
   * - and if the maze is ever re-encoded on purpose, this is the one place
   * that has to change with it. */
  const files = readdirSync(MAZE_TEX).filter((f) => f.endsWith('.ktx2'));
  assert.equal(files.length, 15, 'the maze has five surfaces of three maps');

  const bySuffix = { albedo: 'map', normal: 'normalMap', orm: 'ormMap' };
  const seen = new Set();
  for (const f of files) {
    const suffix = f.replace(/\.ktx2$/, '').split('-').pop();
    const profile = ENCODE_PROFILE[bySuffix[suffix]];
    assert.ok(profile, `unexpected map suffix '${suffix}' in ${f}`);
    const params = String(readKTX2(readFileSync(path.join(MAZE_TEX, f))).keyValue.KTXwriterScParams ?? '');
    seen.add(suffix);
    assert.equal(params, profile.handRecipe,
      `${f} was not built with the command line ENCODE_PROFILE.${bySuffix[suffix]} claims for it`);

    /* And the options actually handed to the wasm encoder have to agree with
     * that recovered line, or the profile documents one thing and does
     * another - which is the failure mode this whole file exists to prevent. */
    if (profile.options.isUASTC) {
      assert.match(params, new RegExp(`^--encode uastc --uastc_quality ${profile.options.uastcLDRQualityLevel}\\b`));
    } else {
      assert.match(params, new RegExp(`^--encode etc1s --qlevel ${profile.options.qualityLevel} `
        + `--clevel ${profile.options.compressionLevel}$`));
    }
  }
  assert.deepEqual([...seen].sort(), ['albedo', 'normal', 'orm']);
});

test('the declared maze set names the surfaces the manifest already ships', () => {
  /* The maze set in TEXTURE_SETS is the pipeline's own regression case: it is
   * transcribed from the committed manifest, so re-running it should land on
   * the same five surfaces at the same five sizes. A surface added to one and
   * not the other is the drift this catches. */
  const manifest = JSON.parse(readFileSync(path.join(root, 'public/assets/maze/manifest.json'), 'utf8'));
  const shipped = new Set(manifest.assets.filter((a) => a.kind === 'texture').map((a) => a.surface));
  const declared = new Set(TEXTURE_SETS.maze.surfaces.map((s) => s.name));
  assert.deepEqual([...declared].sort(), [...shipped].sort());

  for (const s of TEXTURE_SETS.maze.surfaces) {
    assert.ok(Number.isInteger(Math.log2(s.size)), `${s.name} is ${s.size}px - compressed textures need a power of two to repeat`);
  }
});
