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

/**
 * Above this median frame time, a sample is presumed to be a stall.
 *
 * Same number as `PostFX._trackBudget`'s build-stall guard, and it is the same
 * judgement: nothing in a healthy frame produces a 60 ms MEDIAN, so a sample
 * this large is a world build, a tab restore or a driver link, and reacting to
 * it costs the player quality for a transient cause.
 * @see Engine#_adaptResolution for the one way this differs from PostFX's use.
 */
const STALL_MEDIAN_MS = 60;

/**
 * How far one adaptation moves the internal resolution scale.
 *
 * 0.05 is ~10% of the pixels (area goes as the square) and rather less than
 * that off the frame, since only the fragment-bound part of it scales at all.
 * That is deliberately far smaller than the 10.8 ms dead band between the two
 * thresholds in `_adaptResolution`, which is the condition for a stepped
 * scaler not to pump: one step cannot carry the next sample across the band it
 * just left.
 */
const RES_STEP = 0.05;

/**
 * 0.05 does not survive repeated binary addition - four steps down and four
 * back up land on 0.9999999999999999, which is neither 1 nor a value the
 * `< 1` guard stops stepping at. Snapping each step back onto the 0.01 lattice
 * keeps the ladder exact and the pixel ratio a round number.
 * @param {number} s
 */
const snapScale = (s) => Math.round(s * 100) / 100;

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
    /**
     * SIMULATION TIME: seconds the game has actually been PLAYED.
     *
     * `elapsed` is wall time since boot and never stops - not while the
     * inventory is open, not behind the Esc hub, not while a market sheet is
     * up. This one stops whenever gameplay does, and it exists because a
     * *duration* the player was promised - thirty seconds of a speed boost,
     * five of a shield - is a duration of PLAY. A shield dated from the wall
     * clock and used from inside the bag is over before the bag closes.
     *
     * Every timed consumable dates its deadline from here, and so does the
     * HUD's countdown for it. That is the whole point of there being one: a
     * chip on screen and the effect it describes cannot disagree if they read
     * the same clock. See `setSimulating`, `systems/ActiveEffects.js`, and the
     * buff-clock note in `player/Player.js`.
     */
    this.simElapsed = 0;
    this.frame = 0;
    this.running = false;
    this._paused = false;
    /** @see setSimulating */
    this._simulating = true;

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
    /* How far the scaler may drop. A tier setting rather than a constant since
     * Phase 5: the 0.8 floor below was argued from the composer's MSAA, and a
     * low-end device runs with MSAA off, so the argument does not reach it.
     * @see gfx/QualityTier.js */
    this._resolutionFloor = 0.8;
    /* Consecutive 2 Hz samples over/under budget. @see `_adaptResolution` */
    this._resSlowStrikes = 0;
    this._resFastStrikes = 0;
    /* Whether the last announced state was full resolution, so the scaler can
     * speak on the EDGES of a degraded episode rather than on every rung of
     * the ladder. @see `_adaptResolution` */
    this._resAtFull = true;

    // `frameMs` is the mean (what the debug panel wants to show); `frameMsMedian`
    // is what quality decisions are made on. A world streaming in on a background
    // idle callback lands one 150 ms frame in the window, which shifts the mean by
    // 2.5 ms - enough to make the scaler and PostFX's budget guard drop quality
    // permanently in response to a hitch that has already ended. The median simply
    // does not see it.
    /* `resolutionScale` is here rather than left private because a quality drop
     * nobody can see is indistinguishable from the engine simply being bad at
     * its job - this is the mechanism a "the rendering is not smooth" report is
     * most likely to be describing, and it used to leave no trace anywhere but
     * the console. It rides `engine:stats`, which the diagnostics panel
     * (`ui/HUD.js#_updateDebug`) and the review harness (`dev/Harness.js`)
     * already consume. @see _adaptResolution */
    this.stats = {
      fps: 0, frameMs: 0, frameMsMedian: 0, drawCalls: 0, triangles: 0, programs: 0,
      resolutionScale: 1,
    };
    this._fpsAccum = 0;
    this._fpsFrames = 0;

    /* ── WebGL context loss ────────────────────────────────────────────────
     *
     * Observed once during a measurement run and it is the worst failure this
     * project has: a driver hang (an 11.7 s frame carrying only 8.2 ms of
     * engine CPU) took the context, `renderer.info` collapsed by 392 programs,
     * 1,375 geometries and 265 textures, and 1.1 s later the browser handed the
     * context back EMPTY. Nothing re-warmed it, so every program was re-linked
     * on demand inside gameplay frames and the game ran at ~1.3 fps for the
     * remaining eleven minutes.
     *
     * Three installs its own listeners in the `WebGLRenderer` constructor -
     * which has already run by this point, so ours are second in the queue and
     * `onContextRestore`'s `initGLContext()` is guaranteed to have re-created
     * the GL state before `_onContextRestored` runs. That ordering is the whole
     * reason the wiring lives here rather than anywhere earlier.
     *
     * What Three does NOT do is rebuild anything. `renderer.compile()` issues
     * `linkProgram` and drawing is what waits for the link (see
     * gfx/RehearsalDraw.js), so a restored context is a cold program cache and
     * the only cure is the boot warm, run again. `setContextRecovery` is where
     * main.js hands that in; everything here is the gate that stops the game
     * grinding through it a frame at a time in the meantime.
     */
    /** True between `webglcontextlost` and `webglcontextrestored`. */
    this.contextLost = false;
    /** Set while a recovery is drawing its own frames; see `_runRecovery`. */
    this._renderHeld = false;
    /** @type {null | (() => (Promise<void>|void))} */
    this._recover = null;
    this._recovering = false;
    /** `_paused` as the game had it before the loss, restored on recovery. */
    this._pausedBeforeLoss = false;
    // Bound copies as own properties, so `removeEventListener` could match and
    // so the prototype methods stay callable against a stub in a headless test.
    this._onContextLost = this._onContextLost.bind(this);
    this._onContextRestored = this._onContextRestored.bind(this);
    canvas.addEventListener('webglcontextlost', this._onContextLost, false);
    canvas.addEventListener('webglcontextrestored', this._onContextRestored, false);

    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      // Prevent an enormous dt spike when the tab returns.
      if (!document.hidden) this.clock.getDelta();
    });
  }

  /**
   * Whether the frame loop may draw this frame.
   *
   * False in exactly two states, and for two different reasons. With no context
   * a render is a no-op anyway - Three's `render` early-returns while
   * `_isContextLost` - so the only thing it buys is a misleading `renderer.info`
   * and a frame time that says everything is fine. While a recovery is running,
   * a loop render would be a second, frustum-culled draw of a scene whose
   * programs are still being linked, racing the un-culled warm frames that are
   * there to pay for exactly those links. @see _runRecovery
   */
  _canRender() {
    return !this.contextLost && !this._renderHeld;
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
    // While the context is gone (or a recovery is warming it back up) the
    // simulation is deliberately held, and whatever the game asks for in the
    // meantime is remembered rather than applied - `_runRecovery` restores it.
    if (this.contextLost || this._recovering) {
      this._pausedBeforeLoss = !!paused;
      return;
    }
    this._paused = paused;
  }

  /**
   * Say whether gameplay is actually simulating, which is what `simElapsed`
   * counts.
   *
   * NOT the same question as `setPaused`. The engine keeps rendering, keeps
   * flushing the bus and keeps ticking every overlay while a panel is open -
   * it is only the *gameplay* half of the frame that stands down, and the
   * engine has no idea which panels exist. So main.js, which owns
   * `gameplayBlocked`, tells it here; nothing else may call this.
   *
   * @param {boolean} on false while a UI panel holds gameplay
   */
  setSimulating(on) {
    this._simulating = !!on;
  }

  /**
   * Register what to run once a lost context comes back.
   *
   * Handed in rather than reached for: the warm that has to run is the boot's
   * own (`prewarm`/`rehearse` in main.js, and the sliced background warms they
   * hand off to), and the engine has no business knowing about mounts,
   * viewmodels or gateways. The engine's job is to hold the frame loop still
   * while it happens, and to put the loop back exactly as it found it.
   *
   * @param {null | (() => (Promise<void>|void))} fn
   */
  setContextRecovery(fn) {
    this._recover = typeof fn === 'function' ? fn : null;
  }

  /**
   * `webglcontextlost`.
   *
   * `preventDefault()` is not optional and it is not Three's to owe us: without
   * it the browser never fires `webglcontextrestored` at all and the canvas is
   * dead for the life of the page. Three does call it, and this calls it again,
   * because a renderer that has been disposed (or replaced) has removed its
   * listener and the difference between a recoverable hiccup and a black screen
   * cannot rest on that.
   */
  _onContextLost(event) {
    event?.preventDefault?.();
    if (this.contextLost) return;
    this.contextLost = true;
    // Freeze the simulation rather than letting it run blind: every frame that
    // passes is a frame the player has walked, been shot at and fallen through
    // without seeing any of it.
    this._pausedBeforeLoss = this._paused;
    this._paused = true;
    this.bus?.emit?.('engine:context-lost', {});
  }

  /** `webglcontextrestored`. Three has already re-created the GL state. */
  _onContextRestored() {
    if (!this.contextLost) return;
    this.contextLost = false;
    this.bus?.emit?.('engine:context-restored', {});
    this._runRecovery();
  }

  /**
   * Hold the loop's own render while the recovery draws its warm frames, then
   * hand the game back in the state it was in.
   *
   * The hold matters: a recovery frame is deliberately un-culled and draws
   * everything, and an ordinary loop render interleaved with it would be a
   * second full draw of a scene whose programs are still being linked - which
   * is the ~1.3 fps grind, arriving through the door the fix came in by.
   */
  async _runRecovery() {
    if (this._recovering) return;
    this._recovering = true;
    this._renderHeld = true;
    try {
      await this._recover?.();
    } catch (err) {
      // Never fatal. A failed re-warm costs the player the stalls it was there
      // to prevent; a thrown one would cost them the frame loop.
      console.warn('[engine] context recovery failed, first-use costs stay with the player:', err);
    } finally {
      this._renderHeld = false;
      this._recovering = false;
      this._paused = this._pausedBeforeLoss;
      // The clock has been running through all of it; drop the backlog rather
      // than hand the first live frame a multi-second dt to sub-step through.
      this.clock.getDelta();
      this._accumulator = 0;
      this.bus?.emit?.('engine:context-recovered', {});
    }
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
      /* Advanced HERE - inside the pause gate, beside the updaters it has to
       * agree with - rather than beside `elapsed` above. A frame in which
       * nothing simulated must not shorten a shield. `_simulating` is the
       * UI-panel gate (main.js's `gameplayBlocked`); `_paused` is the engine's
       * own, and both have to be clear for play time to pass. */
      if (this._simulating) this.simElapsed += dt;
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

    if (!this._canRender()) return;

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
      /* Read back here rather than written from `_adaptResolution` so the stat
       * is right on every path into it - the scaler being switched off, and
       * `setResolutionFloor` raising a scale that was below a tightened floor,
       * both move it without an adaptation. */
      this.stats.resolutionScale = this._resolutionScale;
      this.bus.emit('engine:stats', this.stats);
    }
  }

  /**
   * How far the adaptive scaler may drop this session.
   *
   * The default 0.8 exists because "below ~0.8 the upscale reintroduces exactly
   * the stair-stepping the composer's MSAA is there to remove" - a true
   * argument that stops applying the moment MSAA is 0, which is what the low
   * quality tier does. So the floor moves with the tier rather than being a
   * constant that only ever held for the desktop settings.
   *
   * A scale already below the new floor is raised to it, so tightening the
   * floor mid-session takes effect immediately rather than on the next hitch.
   *
   * @param {number} floor 0.25..1
   */
  setResolutionFloor(floor) {
    if (!Number.isFinite(floor)) return;
    this._resolutionFloor = Math.max(0.25, Math.min(1, floor));
    if (this._resolutionScale < this._resolutionFloor) {
      this._resolutionScale = this._resolutionFloor;
      this.resize();
    }
  }

  /**
   * Nudge internal resolution to hold ~60fps.
   *
   * ═══════════════════════════════════════════════════════════════════════
   *  THE ANTI-HITCH MECHANISM WAS MANUFACTURING HITCHES
   * ═══════════════════════════════════════════════════════════════════════
   *
   * This is called at 2 Hz from `_trackPerformance`. It used to react to a
   * SINGLE sample and step by 0.05, so a bad stretch walked the scale down in
   * four separate steps - and every one of those steps calls `postfx.setSize`,
   * which resizes the whole chain: RenderPass, GTAO plus its own depth/normal
   * prepass targets, the shafts, a five-level bloom mip chain, grade, output,
   * SMAA and film, eight to twelve render targets. three.js DISPOSES and
   * recreates the GL texture on any dimension change, so each step is eight to
   * twelve texture allocations.
   *
   * That is FOUR full post-chain reallocations inside two seconds, taken on
   * exactly the frames the player is already losing. The mechanism that exists
   * to remove hitches was adding four of its own to every rough patch, and
   * then four more on the way back up.
   *
   * ── The fix is the discipline `PostFX._trackBudget` already had ─────────
   *
   * That guard sits ten metres away in the same renderer and is properly
   * hysteretic: 150-frame sampling, four strikes down, six up, and an explicit
   * `ms > 60` guard that refuses to read a build stall as a budget problem.
   * This had none of the three. It now has all three - and, unlike that guard,
   * a ladder rather than a switch, because AO is on or off and resolution has
   * everything in between:
   *
   *   A LADDER, NOT A LEAP. Note what that is not: the version that fixed the
   *   four-reallocations bug above also stepped STRAIGHT TO THE FLOOR,
   *   arguing that the increments "cannot reach a useful resolution any
   *   sooner - it is the same destination". They are not the same
   *   destination. The floor is the destination only for a machine that
   *   cannot hold the budget at any scale. A 22.6 ms median - 44 fps, 35%
   *   over budget - was being answered with the entire 20% cut, 36% fewer
   *   pixels, which then took six consecutive fast samples to undo. So a
   *   machine hovering just under 45 fps rendered at 0.8x and upscaled
   *   indefinitely, stair-stepping every edge, for a deficit that one 0.05
   *   step usually covers.
   *
   *   The reallocation cost is paid for by the GATE, not by the step size.
   *   Every step still costs three consecutive slow samples, so steps are
   *   1.5 s apart at 2 Hz and the full 1.0 -> 0.8 descent takes six seconds
   *   and four reallocations - and only while the frame stays persistently
   *   slow. Four reallocations spread over six bad seconds is not the defect
   *   above; four inside two, off a single sample, was.
   *
   * ── Why a 0.05 ladder does not pump ─────────────────────────────────────
   *
   * What oscillates a stepped scaler is a step big enough to carry the next
   * sample back across the band it just left. It cannot here: the dead band
   * between the down threshold (22.5 ms) and the up threshold (11.7 ms) is
   * 10.8 ms wide, while one step moves ~10% of the pixels and rather less
   * than that off the frame, since only the fragment-bound part of it scales.
   * The 3-down/6-up asymmetry is kept on top of that, so a lull has to hold
   * for three seconds before any of it is given back.
   *
   * The consequence worth knowing: the scaler now settles on the FIRST rung
   * that brings the median back inside 22.5 ms, not on the floor. That is a
   * sharper image at a slightly lower frame rate than the leap produced, and
   * it is the intended trade - the leap's extra headroom was being spent on a
   * budget overrun that had already been paid off.
   *
   * The `ms > 60` guard matters more here than it does in PostFX: this is the
   * mechanism most likely to fire during a world build or a tab restore, and
   * dropping the player's resolution because a background world was generating
   * is a permanent-looking cost for a transient cause.
   */
  _adaptResolution() {
    const target = 16.7;
    // Median, not mean: see the note on `stats`. A build hitch must not cost the
    // player a permanently soft, aliased image.
    const avg = this.stats.frameMsMedian;
    const prev = this._resolutionScale;
    const floor = this._resolutionFloor;

    if (!(avg > 0)) return;

    /* ── THE BUILD-STALL GUARD, AND THE ONE WAY IT MUST NOT BE COPIED ──────
     *
     * A 60 ms median is a stall, a tab restore or a world build, not a
     * steady-state budget problem - the same threshold and the same reasoning
     * as `PostFX._trackBudget`.
     *
     * But that guard can afford to be unconditional and this one cannot. AO is
     * a luxury; resolution is the lever that might actually make a weak GPU
     * playable, and a machine genuinely running at 15 fps shows a 66 ms median
     * sample after sample. Refusing to help exactly the hardware this method
     * exists for would be the wrong way round. So a large median is ignored
     * while it looks like a STALL, and believed once it has persisted for
     * three seconds, which no build step in this game does behind a running
     * frame loop. */
    if (avg > STALL_MEDIAN_MS) {
      this._resStallSamples = (this._resStallSamples || 0) + 1;
      if (this._resStallSamples < 6) return;
    } else {
      this._resStallSamples = 0;
    }

    if (avg > target * 1.35) {
      this._resFastStrikes = 0;
      /* Three consecutive slow samples - a second and a half - before anything
       * is touched. One sample is a frame the player has already lost, and
       * reacting to it costs them a reallocation on top. */
      this._resSlowStrikes = (this._resSlowStrikes || 0) + 1;
      if (this._resSlowStrikes >= 3 && this._resolutionScale > floor) {
        this._resSlowStrikes = 0;
        this._resolutionScale = Math.max(floor, snapScale(this._resolutionScale - RES_STEP));
      }
    } else if (avg < target * 0.7) {
      this._resSlowStrikes = 0;
      /* Six up against three down, the same asymmetry PostFX uses: coming back
       * up on a brief lull and going straight back down is the pumping this
       * whole method is supposed to prevent. */
      this._resFastStrikes = (this._resFastStrikes || 0) + 1;
      if (this._resFastStrikes >= 6 && this._resolutionScale < 1) {
        this._resFastStrikes = 0;
        this._resolutionScale = Math.min(1, snapScale(this._resolutionScale + RES_STEP));
      }
    } else {
      this._resSlowStrikes = 0;
      this._resFastStrikes = 0;
    }

    if (Math.abs(prev - this._resolutionScale) > 0.001) {
      console.info(`[Engine] resolution scale ${prev.toFixed(2)} -> ${this._resolutionScale.toFixed(2)} `
        + `(${avg.toFixed(1)} ms median)`);

      /* SAY SO. The silent drop is the real defect here - the ladder above
       * only changes how it manifests. `stats.resolutionScale` carries the
       * live value to the diagnostics panel, but a player who never opens it
       * still deserves to know the image they are looking at is not the image
       * the game can draw.
       *
       * Only on the EDGES of an episode, though: a rung every 1.5 s down a
       * four-rung ladder and back would be eight toasts for one rough patch,
       * which is how a useful signal becomes noise the player learns to
       * ignore. `hud:notify` is an existing contract (`ui/HUD.js#_wire`), so
       * this needs no new wiring and no reference to the HUD. */
      const full = this._resolutionScale >= 1;
      if (full !== this._resAtFull) {
        this._resAtFull = full;
        this.bus?.emit('hud:notify', full
          ? { text: 'Render scale restored — 100%', tone: 'info' }
          : {
            text: `Render scale ${Math.round(this._resolutionScale * 100)}% — holding frame rate`,
            tone: 'warn',
          });
      }

      this.renderer.setPixelRatio(
        Math.min(window.devicePixelRatio, CONFIG.render.maxPixelRatio) * this._resolutionScale
      );
      this.postfx?.setSize(window.innerWidth, window.innerHeight);
    }
  }
}
