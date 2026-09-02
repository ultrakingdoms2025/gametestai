/**
 * Loads a .ktx2 file back through THREE'S OWN KTX2Loader, headless.
 *
 *   const tex = await loadKTX2Headless(bytes);
 *
 * Why this exists: `scripts/make-world-tex.mjs` encodes KTX2 with a wasm
 * encoder, and an encoder whose output the game cannot read is worse than no
 * encoder. The only gate worth having is the game's own reader, so this
 * module runs the REAL `three/examples/jsm/loaders/KTX2Loader.js` against the
 * REAL vendored transcoder in `public/vendor/basis/` - the same two files the
 * browser downloads. Nothing about the container, the colour space or the
 * transcode is re-implemented here.
 *
 * Three browser affordances the loader needs and Node lacks are shimmed, and
 * ONLY those:
 *
 *  1. `fetch` of a `file://` URL. KTX2Loader fetches the transcoder pair
 *     through THREE.FileLoader; Node's fetch refuses the file scheme.
 *     Shimmed rather than served over HTTP so this can run in a sandbox with
 *     no listening socket. (Deliberately not a local server: binding a port
 *     is the one thing likeliest to fail on somebody else's machine.)
 *  2. `Worker`. KTX2Loader concatenates the transcoder JS with its own
 *     `KTX2Loader.BasisWorker` body, publishes it as a blob: URL and spawns a
 *     worker on it. The shim resolves that blob and runs the SAME body in
 *     process, so the transcode executed here is three's worker code, not a
 *     paraphrase of it. Node has blob: URLs (`buffer.resolveObjectURL`), so
 *     even the URL round-trip is real.
 *  3. A renderer for `detectSupport`. The stub reports NO compressed-texture
 *     extension, which is not a fudge but the point: with every GPU format
 *     unavailable the worker falls back to RGBA32, and the caller gets actual
 *     8-bit pixels back to compare against the source. A transcode to BC7
 *     would prove the file parses; a transcode to RGBA proves it decodes to
 *     the image that went in.
 *
 * The harness is itself gated: `scripts/tests/world-tex-pipeline.test.mjs`
 * runs it over a committed hand-made maze texture first. If it cannot read
 * toktx v4.4.2's output, nothing it says about the encoder's output means
 * anything.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { resolveObjectURL } from 'node:buffer';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TRANSCODER_DIR = path.join(ROOT, 'public/vendor/basis');

/** Worker-side globals a browser gives the blob script and Node does not. */
class InProcessWorker {
  #handlers = [];
  #self;
  #ready;

  constructor(url) {
    const outward = (data) => {
      /* A real worker's message arrives on a later turn. Keeping that
       * asynchrony matters: WorkerPool resolves its promise from the
       * listener, and a synchronous reply would resolve before postMessage
       * has returned the promise it is meant to resolve. */
      queueMicrotask(() => {
        for (const h of this.#handlers) h({ data });
      });
    };
    this.#self = {
      addEventListener: (type, fn) => { if (type === 'message') this.#self._onmessage = fn; },
      postMessage: outward,
    };
    this.#ready = (async () => {
      const body = await resolveObjectURL(url).text();
      /* `require` and `__dirname` are handed in because the emscripten
       * transcoder takes its NODE branch here (process is real) and would
       * otherwise ReferenceError on `var fs = require("fs")` before it ever
       * looks at the wasmBinary it was given. */
      // eslint-disable-next-line no-new-func
      new Function('self', 'require', '__dirname', body)(this.#self, require_, TRANSCODER_DIR);
    })();
  }

  addEventListener(type, fn) { if (type === 'message') this.#handlers.push(fn); }

  postMessage(msg) {
    this.#ready.then(() => this.#self._onmessage({ data: msg }));
  }

  terminate() {}
}

let installed = false;

/** Install the three shims, once per process. Idempotent. */
function installShims() {
  if (installed) return;
  installed = true;

  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    if (!url.startsWith('file:')) return nativeFetch(input, init);
    const bytes = await readFile(fileURLToPath(url));
    return new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
  };

  if (typeof globalThis.Worker === 'undefined') globalThis.Worker = InProcessWorker;

  /* THREE.FileLoader reports download progress with a ProgressEvent even when
   * nobody passed an onProgress. Node has Event but not this subclass. */
  if (typeof globalThis.ProgressEvent === 'undefined') {
    globalThis.ProgressEvent = class ProgressEvent extends Event {
      constructor(type, init = {}) {
        super(type);
        this.lengthComputable = init.lengthComputable ?? false;
        this.loaded = init.loaded ?? 0;
        this.total = init.total ?? 0;
      }
    };
  }
}

/** A renderer that supports no compressed format, so the transcode lands on RGBA32. */
const RGBA_ONLY_RENDERER = Object.freeze({
  isWebGPURenderer: false,
  extensions: { has: () => false, get: () => null },
});

let loaderPromise = null;

/**
 * @param {Uint8Array|ArrayBuffer} bytes a .ktx2 file
 * @returns {Promise<import('three').CompressedTexture|import('three').DataTexture>}
 *   the texture three itself builds - `.colorSpace`, `.format`, `.mipmaps`
 *   and all - so every assertion is against three's reading, not ours.
 */
export async function loadKTX2Headless(bytes) {
  installShims();
  if (!loaderPromise) {
    loaderPromise = (async () => {
      const { KTX2Loader } = await import('three/examples/jsm/loaders/KTX2Loader.js');
      return new KTX2Loader()
        .setTranscoderPath(`${pathToFileURL(TRANSCODER_DIR).href}/`)
        .detectSupport(RGBA_ONLY_RENDERER)
        /* One worker: these files are megabytes and the pool would hold a
         * whole transcoder module per slot for no gain in a batch tool. */
        .setWorkerLimit(1);
    })();
  }
  const loader = await loaderPromise;
  const buffer = bytes instanceof ArrayBuffer
    ? bytes
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Promise((resolve, reject) => loader.parse(buffer, resolve, reject));
}

/** Release the loader's worker so a script that used it can exit promptly. */
export async function disposeKTX2Headless() {
  if (!loaderPromise) return;
  const loader = await loaderPromise;
  loader.dispose();
  loaderPromise = null;
}
