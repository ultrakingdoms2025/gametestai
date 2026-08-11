import * as THREE from 'three';
import { CONFIG } from './Config.js';

/**
 * Owns the renderer, camera, frame loop and timing.
 *
 * The loop runs simulation on a fixed 60 Hz step (deterministic movement and
 * hit registration) while rendering as fast as the display allows, with the
 * remainder passed to renderers for interpolation-free but smooth camera work.
 */
/**
 * `?dev=1` only. The automated visual-review harness has to be able to read the
 * finished frame back off the canvas, and without a preserved drawing buffer
 * every `toDataURL`/`readPixels` returns transparent black because the buffer
 * has already been recycled by the time the capture runs. It costs the driver a
 * copy per frame, which is why it is strictly gated on the dev flag and never
 * paid for by a player.
 */
const DEV_CAPTURE =
  typeof location !== 'undefined' && new URLSearchParams(location.search).get('dev') === '1';

export class Engine {
  constructor(canvas, bus) {
    this.canvas = canvas;
    this.bus = bus;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      // Deliberately false, and it is *not* the anti-aliasing setting that
      // matters. The scene never touches the default framebuffer: PostFX renders
      // it into an HDR render target and only the final full-screen quad lands
      // here, so a multisampled drawing buffer would cost a resolve on every
      // frame and antialias nothing but that quad's (screen-aligned) edges.
      // Scene MSAA is configured on the composer's render target instead - see
      // MSAA_SAMPLES in gfx/PostFX.js.
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
      preserveDrawingBuffer: DEV_CAPTURE,
    });

    /**
     * Every tiled detail map in the game is viewed at grazing angles across
     * hundreds of metres of deck, road and grass. Without anisotropic filtering
     * those tiles alias into moire arcs long before MSAA or SMAA ever sees them,
     * because the aliasing happens *inside* the texture fetch. Setting the
     * library-wide default here - before `MaterialLibrary` is constructed in
     * main.js - means every procedurally generated texture is created with it,
     * without any subsystem having to remember.
     */
    this.maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();
    THREE.Texture.DEFAULT_ANISOTROPY = this.maxAnisotropy;

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, CONFIG.render.maxPixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = CONFIG.render.exposure;
    /* Shader error checking costs a synchronous stall per program.
     *
     * With it on, the first use of every program calls `getProgramInfoLog` and
     * `getProgramParameter(LINK_STATUS)`, both of which block until the driver
     * has finished linking. That is 200-odd blocking waits through ANGLE during
     * warmup, on top of the links themselves. It earns its keep in development,
     * where a broken shader should say so loudly; in a shipped build the
     * shaders either compiled weeks ago or they did not.
     */
    this.renderer.debug.checkShaderErrors = DEV_CAPTURE || import.meta.env?.DEV === true;

    this.renderer.shadowMap.enabled = true;
    /* `PCFSoftShadowMap` is deprecated and three silently substitutes
     * `PCFShadowMap`, which is what has actually been drawing. Asking for it by
     * name stops the console warning and makes the setting honest. */
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.info.autoReset = false;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(
      CONFIG.render.fov,
      window.innerWidth / window.innerHeight,
      CONFIG.render.near,
      CONFIG.render.far
    );
    this.camera.position.set(0, CONFIG.player.eyeHeight, 0);

    /** Post-processing chain, installed by main.js after construction. */
    this.postfx = null;

    this.clock = new THREE.Clock();
    this._accumulator = 0;
    this.fixedStep = 1 / 60;
    this.maxSubSteps = 5;
    this.elapsed = 0;
    this.frame = 0;
    this.running = false;
    this._paused = false;

    /** @type {Set<(dt:number, elapsed:number)=>void>} */
    this._fixedUpdaters = new Set();
    /** @type {Set<(dt:number, elapsed:number)=>void>} */
    this._frameUpdaters = new Set();

    // Rolling frame-time window drives the adaptive resolution scaler.
    this._frameTimes = new Float32Array(60);
    this._frameTimeSorted = new Float32Array(60);
    this._frameTimeIndex = 0;
    this._resolutionScale = 1;
    this.adaptiveResolution = true;

    // `frameMs` is the mean (what the debug panel wants to show); `frameMsMedian`
    // is what quality decisions are made on. A world streaming in on a background
    // idle callback lands one 150 ms frame in the window, which shifts the mean by
    // 2.5 ms - enough to make the scaler and PostFX's budget guard drop quality
    // permanently in response to a hitch that has already ended. The median simply
    // does not see it.
    this.stats = { fps: 0, frameMs: 0, frameMsMedian: 0, drawCalls: 0, triangles: 0, programs: 0 };
    this._fpsAccum = 0;
    this._fpsFrames = 0;

    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      // Prevent an enormous dt spike when the tab returns.
      if (!document.hidden) this.clock.getDelta();
    });
  }

  /** Simulation tick at a fixed rate. Physics, AI and combat register here. */
  onFixedUpdate(fn) {
    this._fixedUpdaters.add(fn);
    return () => this._fixedUpdaters.delete(fn);
  }

  /** Per-rendered-frame tick. Camera, VFX, UI register here. */
  onFrameUpdate(fn) {
    this._frameUpdaters.add(fn);
    return () => this._frameUpdaters.delete(fn);
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio, CONFIG.render.maxPixelRatio) * this._resolutionScale
    );
    this.renderer.setSize(w, h);
    this.postfx?.setSize(w, h);
    this.bus.emit('engine:resize', { width: w, height: h });
  }

  setPaused(paused) {
    this._paused = paused;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    this._loop();
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  _loop = () => {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._loop);

    const t0 = performance.now();
    // Clamp dt so a stall never tunnels characters through walls.
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.elapsed += dt;
    this.frame++;

    if (!this._paused) {
      this._accumulator += dt;
      let steps = 0;
      while (this._accumulator >= this.fixedStep && steps < this.maxSubSteps) {
        for (const fn of this._fixedUpdaters) fn(this.fixedStep, this.elapsed);
        this._accumulator -= this.fixedStep;
        steps++;
      }
      // If we blew the substep budget, drop the backlog rather than spiral.
      if (steps === this.maxSubSteps) this._accumulator = 0;

      for (const fn of this._frameUpdaters) fn(dt, this.elapsed);
    }

    this.bus.flush();

    this.renderer.info.reset();
    if (this.postfx) {
      this.postfx.render(dt);
    } else {
      this.renderer.render(this.scene, this.camera);
    }

    const frameMs = performance.now() - t0;
    this._trackPerformance(dt, frameMs);
  };

  _trackPerformance(dt, frameMs) {
    this._frameTimes[this._frameTimeIndex] = frameMs;
    this._frameTimeIndex = (this._frameTimeIndex + 1) % this._frameTimes.length;

    this._fpsAccum += dt;
    this._fpsFrames++;
    if (this._fpsAccum >= 0.5) {
      this.stats.fps = Math.round(this._fpsFrames / this._fpsAccum);
      this._fpsAccum = 0;
      this._fpsFrames = 0;

      let sum = 0;
      for (let i = 0; i < this._frameTimes.length; i++) {
        sum += this._frameTimes[i];
        this._frameTimeSorted[i] = this._frameTimes[i];
      }
      this.stats.frameMs = sum / this._frameTimes.length;
      this._frameTimeSorted.sort();
      this.stats.frameMsMedian = this._frameTimeSorted[this._frameTimeSorted.length >> 1];
      this.stats.drawCalls = this.renderer.info.render.calls;
      this.stats.triangles = this.renderer.info.render.triangles;
      this.stats.programs = this.renderer.info.programs?.length ?? 0;

      if (this.adaptiveResolution) this._adaptResolution();
      this.bus.emit('engine:stats', this.stats);
    }
  }

  /**
   * Nudge internal resolution to hold ~60fps. Steps are small and hysteretic so
   * the image never visibly pumps.
   */
  _adaptResolution() {
    const target = 16.7;
    // Median, not mean: see the note on `stats`. A build hitch must not cost the
    // player a permanently soft, aliased image.
    const avg = this.stats.frameMsMedian;
    const prev = this._resolutionScale;
    // Floor raised from 0.65: below ~0.8 the upscale reintroduces exactly the
    // stair-stepping the composer's MSAA is there to remove, so it is better to
    // shed post-processing passes (PostFX does that itself) than more pixels.
    if (avg > target * 1.35 && this._resolutionScale > 0.8) {
      this._resolutionScale = Math.max(0.8, this._resolutionScale - 0.05);
    } else if (avg < target * 0.7 && this._resolutionScale < 1) {
      this._resolutionScale = Math.min(1, this._resolutionScale + 0.05);
    }
    if (Math.abs(prev - this._resolutionScale) > 0.001) {
      this.renderer.setPixelRatio(
        Math.min(window.devicePixelRatio, CONFIG.render.maxPixelRatio) * this._resolutionScale
      );
      this.postfx?.setSize(window.innerWidth, window.innerHeight);
    }
  }
}
