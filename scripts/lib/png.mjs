/**
 * A PNG decoder and an image resampler, in pure JavaScript.
 *
 * Why hand-rolled: `scripts/make-world-tex.mjs` has to get 8-bit RGBA out of
 * whatever ambientCG and Poly Haven serve, and node has no image decoder.
 * Every off-the-shelf option (sharp, canvas, jimp) is either a native module
 * or a megabyte of dependency for one format, and a native module is exactly
 * what killed the ORIGINAL pipeline - the maze's textures were made by hand
 * on a machine with toktx installed and could not be re-run anywhere else.
 * PNG's decode path is zlib plus five scanline filters, and zlib is in node.
 *
 * That is also why the sources are fetched as PNG and not JPG even though
 * JPG is the smaller download: a baseline JPEG decoder is several hundred
 * lines of Huffman and IDCT, and it would be lossy on top of lossy before
 * the texture ever reached the block compressor.
 *
 * Not supported, deliberately, with a clear throw rather than a wrong image:
 * Adam7 interlacing (no source here ships it).
 */
import zlib from 'node:zlib';

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

/** @typedef {{width:number, height:number, data:Uint8Array}} Image RGBA8, row-major, top row first. */

/**
 * @param {Buffer|Uint8Array} bytes a PNG file
 * @returns {Image}
 */
export function decodePNG(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  for (let i = 0; i < 8; i++) if (b[i] !== SIG[i]) throw new Error('not a PNG (bad signature)');

  let width = 0, height = 0, depth = 0, colour = 0, interlace = 0;
  let palette = null, trns = null;
  const idat = [];

  for (let p = 8; p + 8 <= b.length;) {
    const len = b.readUInt32BE(p);
    const type = b.toString('latin1', p + 4, p + 8);
    const data = b.subarray(p + 8, p + 8 + len);
    p += 12 + len; // length + type + data + crc
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; colour = data[9]; interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }

  if (!width || !height) throw new Error('PNG has no IHDR');
  if (interlace !== 0) throw new Error('interlaced PNG - not supported by this decoder');

  const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = CHANNELS[colour];
  if (channels === undefined) throw new Error(`PNG colour type ${colour} is not one this decoder handles`);
  if (colour === 3 && !palette) throw new Error('indexed PNG with no PLTE');

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bitsPerPixel = channels * depth;
  const bytesPerPixel = Math.max(1, bitsPerPixel >> 3); // the filter's "bpp": 1 for sub-byte depths
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  if (raw.length < height * (stride + 1)) throw new Error('PNG data is short - truncated file?');

  /* Undo the per-scanline filter in place, top to bottom. Each row is
   * prefixed with its filter byte; filters 2-4 read the row above, which is
   * why this cannot be done row-independently. */
  const lines = Buffer.allocUnsafe(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = lines.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? lines.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bytesPerPixel ? cur[x - bytesPerPixel] : 0;
      const c = prev ? prev[x] : 0;
      const d = prev && x >= bytesPerPixel ? prev[x - bytesPerPixel] : 0;
      let v = src[x];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += c; break;
        case 3: v += (a + c) >> 1; break;
        case 4: {
          const pp = a + c - d;
          const pa = Math.abs(pp - a), pb = Math.abs(pp - c), pc = Math.abs(pp - d);
          v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? c : d);
          break;
        }
        default: throw new Error(`PNG filter type ${filter} on row ${y}`);
      }
      cur[x] = v & 0xff;
    }
  }

  const out = new Uint8Array(width * height * 4);
  const sample = (row, i) => {
    /* 16-bit samples are truncated to their high byte rather than rounded:
     * the block compressor is 8-bit and the low byte is below its noise
     * floor, and truncation is what every KTX2 toolchain does here. */
    if (depth === 16) return row[i * 2];
    if (depth === 8) return row[i];
    const per = 8 / depth, idx = (i / per) | 0, shift = 8 - depth * (i % per) - depth;
    const v = (row[idx] >> shift) & ((1 << depth) - 1);
    return colour === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
  };

  for (let y = 0; y < height; y++) {
    const row = lines.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colour === 3) {
        const idx = sample(row, x);
        out[o] = palette[idx * 3]; out[o + 1] = palette[idx * 3 + 1]; out[o + 2] = palette[idx * 3 + 2];
        out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else if (colour === 0 || colour === 4) {
        const g = sample(row, x * channels);
        out[o] = g; out[o + 1] = g; out[o + 2] = g;
        out[o + 3] = colour === 4 ? sample(row, x * channels + 1) : 255;
      } else {
        out[o] = sample(row, x * channels);
        out[o + 1] = sample(row, x * channels + 1);
        out[o + 2] = sample(row, x * channels + 2);
        out[o + 3] = colour === 6 ? sample(row, x * channels + 3) : 255;
      }
    }
  }
  return { width, height, data: out };
}

/* sRGB <-> linear, 8-bit in. Built once: a 2048x2048 albedo is four million
 * texels and the transfer function is a pow() per channel. */
const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const linearToSrgb = (v) => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
};

/**
 * Area-average downsample to a square of `size`.
 *
 * `space` is load-bearing and is the reason this takes a third argument:
 *
 *  - `'srgb'` averages in LINEAR light and converts back. Averaging sRGB code
 *    values directly darkens every texture, worst in the midtones - the
 *    classic gamma-incorrect resize, and the reason a naively downsampled
 *    albedo reads muddier than its source.
 *  - `'linear'` averages the stored values, which is right for an ORM map
 *    where the numbers ARE the quantities.
 *  - `'normal'` averages the vectors and RENORMALISES each result to unit
 *    length. The average of two unit vectors is shorter than one, so a plain
 *    box filter flattens a normal map as it shrinks - the surface loses its
 *    bite exactly where the downsample was supposed to be free.
 *
 * @param {Image} img
 * @param {number} size target width and height in pixels
 * @param {'srgb'|'linear'|'normal'} space
 * @returns {Image}
 */
export function resample(img, size, space) {
  if (img.width === size && img.height === size) return img;
  if (img.width < size || img.height < size) {
    throw new Error(`refusing to upscale ${img.width}x${img.height} to ${size} - fetch a larger source`);
  }
  const out = new Uint8Array(size * size * 4);
  const sx = img.width / size, sy = img.height / size;
  const acc = new Float64Array(4);
  for (let y = 0; y < size; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.min(img.height, Math.ceil((y + 1) * sy));
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.min(img.width, Math.ceil((x + 1) * sx));
      acc.fill(0);
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * img.width + xx) * 4;
          if (space === 'srgb') {
            acc[0] += SRGB_TO_LINEAR[img.data[i]];
            acc[1] += SRGB_TO_LINEAR[img.data[i + 1]];
            acc[2] += SRGB_TO_LINEAR[img.data[i + 2]];
          } else if (space === 'normal') {
            acc[0] += img.data[i] / 127.5 - 1;
            acc[1] += img.data[i + 1] / 127.5 - 1;
            acc[2] += img.data[i + 2] / 127.5 - 1;
          } else {
            acc[0] += img.data[i]; acc[1] += img.data[i + 1]; acc[2] += img.data[i + 2];
          }
          acc[3] += img.data[i + 3];
          n++;
        }
      }
      const o = (y * size + x) * 4;
      if (space === 'srgb') {
        out[o] = linearToSrgb(acc[0] / n);
        out[o + 1] = linearToSrgb(acc[1] / n);
        out[o + 2] = linearToSrgb(acc[2] / n);
      } else if (space === 'normal') {
        const len = Math.hypot(acc[0], acc[1], acc[2]) || 1;
        out[o] = Math.round(((acc[0] / len) + 1) * 127.5);
        out[o + 1] = Math.round(((acc[1] / len) + 1) * 127.5);
        out[o + 2] = Math.round(((acc[2] / len) + 1) * 127.5);
      } else {
        out[o] = Math.round(acc[0] / n);
        out[o + 1] = Math.round(acc[1] / n);
        out[o + 2] = Math.round(acc[2] / n);
      }
      out[o + 3] = Math.round(acc[3] / n);
    }
  }
  return { width: size, height: size, data: out };
}

/** Peak signal-to-noise ratio in dB over RGB between two same-length RGBA buffers. Infinity when identical. */
export function psnrRGB(a, b) {
  if (a.length !== b.length) throw new Error('PSNR needs two images of the same size');
  let sum = 0, n = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) { const d = a[i + c] - b[i + c]; sum += d * d; n++; }
  }
  const mse = sum / n;
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}
