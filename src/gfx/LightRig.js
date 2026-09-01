import * as THREE from 'three';

/**
 * The game's one and only light rig.
 *
 * ── The problem this solves ───────────────────────────────────────────────
 * Three pushes `numDirLights`, `numPointLights`, `numSpotLights` and the three
 * matching shadow counts into `getProgramCacheKey`, and its GLSL preprocessor
 * *unrolls* the lighting loops (`#pragma unroll_loop_start`) - so the per-light
 * shading body is physically duplicated N times in every fragment shader in the
 * scene. Two consequences, both measured on this project through ANGLE/D3D11:
 *
 *   1. **Compile time scales with the light count.** Same scene, same 207
 *      programs, only the visible point-light count changed:
 *
 *          42 point lights -> 59.8 s      12 -> 19.4 s      6 -> 13.0 s
 *
 *      The station world had 65 of them, which is the 118 s that used to be
 *      spent sitting at "Compiling shaders / 92%".
 *
 *   2. **Any change to a count throws the whole cache away.** Worlds carried
 *      their own lights (station 65 point / 5 dir / 2 spot, medieval 43 / 3 / 1),
 *      so stepping through a portal invalidated every program in the scene and
 *      recompiled them in a single blocking frame - measured at 83 s.
 *
 * ── What this class does ──────────────────────────────────────────────────
 * It owns a fixed set of *slot* lights that are added to the scene once and
 * never added, removed or hidden again, so the counts in the cache key are
 * constant for the entire session - across worlds, weapons, mounts and effects.
 *
 * Every other light in the game becomes a **source**: it stays exactly where it
 * is in its own hierarchy, keeps being positioned and animated by whatever owns
 * it, but is set `visible = false` so `projectObject` never pushes it (see the
 * note in gfx/LightAnchor.js - hiding a light is what drops it from the count).
 * Each frame the rig scores the sources by how much light they actually deliver
 * near the camera and copies the best ones into its slots.
 *
 * Nothing else in the codebase has to know. A world, a weapon or an effect
 * creates a `THREE.PointLight` the way it always did; the rig claims it on the
 * next scan.
 *
 * ── Why scoring is safe ───────────────────────────────────────────────────
 * A point light with `distance = 26` contributes mathematically nothing beyond
 * 26 m, so the lights that lose a slot are the ones already contributing ~0.
 * Swaps are additionally rate-limited (re-scored at {@link RESCORE_HZ}), require
 * the incoming light to beat the outgoing one by {@link SWAP_GAIN}, and cross-fade,
 * so a slot never pops.
 *
 * Directional lights are not distance-attenuated, so they are not scored: they
 * are assigned to fixed slots by intensity, shadow-casters first. Shadow slot 0
 * is reserved for the caller's sun (main.js drives it directly); a world that
 * brings its own shadow key - the station's window key, the sports far cascade -
 * lands in slot 1, and worlds with neither leave it dark.
 */

/**
 * Slot budget. These are the numbers baked into every shader in the game, so
 * raising one costs compile time in every program and lowering one risks a
 * visible light dropping out. Sized from measurement: at the station spawn only
 * 7 of the 65 authored point lights actually reach the player.
 */
export const RIG_BUDGET = {
  /**
   * Practicals, muzzle flashes, projectiles, portal spill, viewmodel fill.
   *
   * 12, not 16. Re-measured on ANGLE/D3D11 with the program count held fixed at
   * 30 and only this number varying: 16 lights cost 1567 ms, 12 cost 1224 ms,
   * 8 cost 889 ms - so each slot removed is worth about 5% of the entire cold
   * shader warm, which is the single most expensive thing in the boot. 12 still
   * leaves a comfortable margin over the 7 sources that actually reach the
   * player at the station spawn, which is the densest lighting in the game.
   */
  point: 12,
  /** Station monument accent, car headlights. */
  spot: 2,
  /** Slot 0 is the caller's sun; slot 1 is for a world that brings its own key. */
  dirShadow: 2,
  /** Rim / counter / bounce fills. Station uses all three. */
  dirFill: 3,
};

/** Re-rank sources this often. Between ranks, slots still track their source. */
const RESCORE_HZ = 6;
/** A challenger must deliver this much more light than the slot it displaces. */
const SWAP_GAIN = 1.4;
/** Seconds to fade a slot out before it changes source, and back in after. */
const FADE_OUT = 0.12;
const FADE_IN = 0.2;
/** Score sources against a point this far down the view axis as well as at the
 *  camera, so a practical lights the space you are walking into before you
 *  arrive rather than snapping on when you reach it. */
const LOOK_AHEAD = 15;

const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _cam = new THREE.Vector3();
const _ahead = new THREE.Vector3();

/** Mark an object as rig-owned so `_scan` never mistakes it for a source. */
function markSlot(obj) {
  if (obj) obj.userData.__rigSlot = true;
  return obj;
}

/** Resolution of the placeholder depth map an unused shadow slot renders once. */
const PARKED_SHADOW_SIZE = 64;

/**
 * Put an unclaimed shadow slot to sleep without breaking the shader.
 *
 * A slot that declares `castShadow` raises `numDirLightShadows`, so the fragment
 * shader gets a `sampler2DShadow` for it - and if no shadow pass ever ran, that
 * sampler is bound to the renderer's default *colour* texture. The draw then
 * fails with `GL_INVALID_OPERATION: Mismatch between texture format and sampler
 * type`, spammed once per draw call. The slot has to render exactly one pass so
 * a real depth attachment exists.
 *
 * That pass is made almost free rather than skipped: a 64px map over a 10 cm
 * frustum contains nothing, so it costs an allocation and an empty clear.
 * `WebGLShadowMap` clears `needsUpdate` itself once it has rendered, so this
 * arms a single pass and then stays quiet for the rest of the session.
 */
function parkShadow(light) {
  const s = light.shadow;
  s.mapSize.set(PARKED_SHADOW_SIZE, PARKED_SHADOW_SIZE);
  const c = s.camera;
  c.left = -0.05; c.right = 0.05;
  c.top = 0.05; c.bottom = -0.05;
  c.near = 0.1; c.far = 0.2;
  c.updateProjectionMatrix();
  s.autoUpdate = false;
  s.needsUpdate = true;
}

/** Rec. 709 luminance - a dim blue light should not outrank a bright warm one. */
function luminance(c) {
  return c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
}

/**
 * Three's punctual falloff, evaluated on the CPU: `getDistanceAttenuation` from
 * lights_pars_begin, so the ranking matches what the shader will actually do.
 */
function attenuation(d, cutoff, decay) {
  const dd = d < 0.05 ? 0.05 : d;
  let f = 1 / Math.max(Math.pow(dd, decay), 0.01);
  if (cutoff > 0) {
    if (dd >= cutoff) return 0;
    const x = dd / cutoff;
    const t = 1 - x * x * x * x;
    f *= t * t;
  }
  return f;
}

/**
 * Create a set of slot lights matching {@link RIG_BUDGET} in another scene, so
 * that scene resolves shared materials to the *same* shader programs as the
 * main one. Used by the portal destination preview, which renders a world group
 * into a private scene - without this it compiles a second complete program set
 * for every material it touches, which is exactly the multi-second hitch you
 * feel walking near a gateway.
 *
 * Every light is created dark. Shadow casters are created with their shadow
 * disabled so they cost a slot in the cache key and nothing else.
 *
 * @param {THREE.Scene} scene
 * @param {typeof RIG_BUDGET} [budget]
 * @returns {{ point: THREE.PointLight[], spot: THREE.SpotLight[],
 *             dirShadow: THREE.DirectionalLight[], dirFill: THREE.DirectionalLight[] }}
 */
export function buildMatchingSlots(scene, budget = RIG_BUDGET) {
  const out = { point: [], spot: [], dirShadow: [], dirFill: [] };

  for (let i = 0; i < budget.point; i++) {
    const l = markSlot(new THREE.PointLight(0xffffff, 0, 10, 2));
    l.name = `rig:point:${i}`;
    l.castShadow = false;
    scene.add(l);
    out.point.push(l);
  }
  for (let i = 0; i < budget.spot; i++) {
    const l = markSlot(new THREE.SpotLight(0xffffff, 0, 10, 0.5, 0.5, 2));
    l.name = `rig:spot:${i}`;
    l.castShadow = false;
    l.target = markSlot(new THREE.Object3D());
    scene.add(l, l.target);
    out.spot.push(l);
  }
  for (let i = 0; i < budget.dirShadow; i++) {
    const l = markSlot(new THREE.DirectionalLight(0xffffff, 0));
    l.name = `rig:dirShadow:${i}`;
    l.castShadow = true;
    parkShadow(l);
    l.target = markSlot(new THREE.Object3D());
    scene.add(l, l.target);
    out.dirShadow.push(l);
  }
  for (let i = 0; i < budget.dirFill; i++) {
    const l = markSlot(new THREE.DirectionalLight(0xffffff, 0));
    l.name = `rig:dirFill:${i}`;
    l.castShadow = false;
    l.target = markSlot(new THREE.Object3D());
    scene.add(l, l.target);
    out.dirFill.push(l);
  }
  return out;
}

export class LightRig {
  /**
   * @param {{ scene: THREE.Scene, camera: THREE.Camera,
   *           sun?: THREE.DirectionalLight, budget?: typeof RIG_BUDGET }} ctx
   *   `sun` is adopted as shadow slot 0 and never driven by the rig - the caller
   *   keeps owning its direction, colour and shadow frustum.
   */
  constructor({ scene, camera, sun = null, budget = RIG_BUDGET }) {
    this.scene = scene;
    this.camera = camera;
    this.budget = budget;
    this.sun = sun;

    const slots = buildMatchingSlots(scene, budget);

    /** @type {Array<{light:THREE.PointLight, src:THREE.PointLight|null, want:THREE.PointLight|null, fade:number}>} */
    this.point = slots.point.map((light) => ({ light, src: null, want: null, fade: 0 }));
    /** @type {Array<{light:THREE.SpotLight, src:THREE.SpotLight|null, want:THREE.SpotLight|null, fade:number}>} */
    this.spot = slots.spot.map((light) => ({ light, src: null, want: null, fade: 0 }));

    // Shadow slot 0 is the caller's sun if there is one: reuse the object so
    // main.js's existing per-frame aiming and shadow-frustum fitting keep
    // working untouched, and so anything that looks the sun up by traversal
    // still finds it first.
    this.dirShadow = slots.dirShadow.map((light) => ({ light, src: null, reserved: false }));
    if (sun) {
      const spare = this.dirShadow[0].light;
      scene.remove(spare, spare.target);
      markSlot(sun);
      markSlot(sun.target);
      this.dirShadow[0] = { light: sun, src: null, reserved: true };
    }
    this.dirFill = slots.dirFill.map((light) => ({ light, src: null }));

    /* Source registers, rebuilt by `_scan` every frame. */
    this._srcPoint = [];
    this._srcSpot = [];
    this._srcDir = [];
    this._cand = [];

    this._rescoreT = 0;
    /** Diagnostics for the F3 overlay / dev harness. */
    this.stats = { sources: 0, pointUsed: 0, spotUsed: 0, dirUsed: 0 };
  }

  /**
   * Take a subtree out of the light count before it is ever rendered.
   *
   * Worlds are generated in the background and only added to the scene on
   * activation, so `_scan` cannot see them - but the portal preview reparents an
   * *unactivated* world group into its own scene, and a world arriving with 43
   * live point lights would compile a second program set on the spot. Call this
   * as soon as a world finishes building.
   *
   * @param {THREE.Object3D} root
   */
  claim(root) {
    if (!root) return;
    root.traverse((o) => {
      if (o.isLight && !o.userData.__rigSlot && !o.isAmbientLight && !o.isHemisphereLight) {
        o.visible = false;
      }
    });
  }

  /**
   * Rank sources and drive the slots. Call once per rendered frame, before the
   * render and after everything that moves a light has run.
   * @param {number} dt seconds
   */
  update(dt) {
    this._scan();

    this._rescoreT -= dt;
    if (this._rescoreT <= 0) {
      this._rescoreT = 1 / RESCORE_HZ;
      this._rank();
    }

    this._drive(dt);
  }

  /* ------------------------------------------------------------------ */
  /* Sources                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Collect every light in the scene that is not one of ours and make sure it
   * is dark to the renderer.
   *
   * Run every frame rather than on a timer: a light that reaches `projectObject`
   * even once costs a full recompile of everything in view, so there is no
   * cadence at which missing one is acceptable.
   *
   * ── HOW BIG THE WALK ACTUALLY IS (re-measured 1 Sep 2026) ───────────────
   *
   * This said "a traverse of ~2000 nodes measures well under 0.1 ms", and that
   * number long predated the station's four outer zones. Re-counted against
   * the built worlds rather than remembered, `world.group` alone:
   *
   *   station  1,712 nodes  (226 lights, 1,353 meshes, depth 4)
   *   medieval   899 nodes  (156 lights,   645 meshes, depth 3)
   *   dock       404 nodes  (186 lights,   165 meshes, depth 4)
   *
   * Only the ACTIVE world is parented - `WorldManager._activate` removes the
   * previous group from the scene - so the station is the ceiling. The rest of
   * the live scene is the characters (about 22 bones plus a root and a merged
   * `SkinnedMesh` each, so roughly 1,500 nodes at the station's 59 spawns plus
   * the avatar), the six gateways, and the loot/relic/viewmodel roots: call it
   * 3,500-4,000 in total on the largest world.
   *
   * That is under twice what the old comment claimed and it was NOT optimised
   * on the strength of the comment being stale. A dirty-flag scan seeded off
   * `Object3D.add` was specified and refused: the walk is cheap, it carries
   * the hidden-ancestor rule that `traverse` cannot express, and the failure
   * mode of missing one light is a full recompile of everything in view. The
   * number is recorded here so the next person measures rather than inherits.
   *
   * Ambient and hemisphere lights are left alone - they are global, there is
   * exactly one of each, and their counts never vary.
   */
  _scan() {
    this._srcPoint.length = 0;
    this._srcSpot.length = 0;
    this._srcDir.length = 0;

    this._walk(this.scene, false);

    this.stats.sources = this._srcPoint.length + this._srcSpot.length + this._srcDir.length;
  }

  /**
   * Depth-first walk that carries an "is any ancestor hidden" flag.
   *
   * `Object3D.traverse` cannot express this, and the distinction matters: a
   * light under a hidden group is one `projectObject` would have skipped, so
   * feeding it into a slot would put light into the scene that was never there
   * before. Worlds are the case that bites - a world built in the background
   * and left parented but hidden would otherwise have its key light compete for
   * a slot against the world the player is actually standing in.
   *
   * The light's *own* `visible` flag is deliberately not part of the test: the
   * rig is what set it to false.
   *
   * @param {THREE.Object3D} obj
   * @param {boolean} hiddenAncestor
   */
  _walk(obj, hiddenAncestor) {
    if (obj.isLight && !obj.userData.__rigSlot && !obj.isAmbientLight && !obj.isHemisphereLight) {
      // Claim it. `visible = false` keeps it out of the light count while the
      // scene graph still gives it a world matrix, and whoever owns it can go
      // on animating its position, colour and intensity none the wiser.
      if (obj.visible) obj.visible = false;
      if (!hiddenAncestor) {
        if (obj.isPointLight) this._srcPoint.push(obj);
        else if (obj.isSpotLight) this._srcSpot.push(obj);
        else if (obj.isDirectionalLight) this._srcDir.push(obj);
      }
    }

    const children = obj.children;
    if (children.length === 0) return;
    const hidden = hiddenAncestor || obj.visible === false;
    for (let i = 0; i < children.length; i++) this._walk(children[i], hidden);
  }

  /* ------------------------------------------------------------------ */
  /* Ranking                                                             */
  /* ------------------------------------------------------------------ */

  _rank() {
    this.camera.getWorldPosition(_cam);
    this.camera.getWorldDirection(_ahead);
    _ahead.multiplyScalar(LOOK_AHEAD).add(_cam);

    this._assign(this.point, this._score(this._srcPoint));
    this._assign(this.spot, this._score(this._srcSpot));
    this._assignDirectional();
  }

  /**
   * Irradiance each source delivers at the camera, or at the look-ahead point,
   * whichever is greater. Dark sources are dropped outright, which is what makes
   * the pooled muzzle flashes, portal spill and unselected viewmodel rigs free:
   * they all idle at intensity 0.
   */
  _score(sources) {
    const out = this._cand;
    out.length = 0;
    for (let i = 0; i < sources.length; i++) {
      const l = sources[i];
      if (!(l.intensity > 0)) continue;
      _p.setFromMatrixPosition(l.matrixWorld);
      const lum = luminance(l.color) * l.intensity;
      if (!(lum > 0)) continue;
      const a = attenuation(_p.distanceTo(_cam), l.distance, l.decay);
      const b = attenuation(_p.distanceTo(_ahead), l.distance, l.decay);
      const score = lum * (a > b ? a : b);
      if (score <= 0) continue;
      // Spotlights are ranked on range alone: the cone is wherever its owner
      // aimed it, and there is no cheap way to know what it actually hits. With
      // only ever a couple of them in play, range is a sufficient tiebreak.
      out.push({ src: l, score });
    }
    out.sort((x, y) => y.score - x.score);
    return out;
  }

  /**
   * Hand the highest-scoring sources to slots, preferring to leave slots where
   * they are. Only a challenger that beats the weakest committed source by
   * {@link SWAP_GAIN} may displace it, so two lights of similar strength never
   * trade a slot back and forth.
   */
  _assign(slots, cand) {
    const score = new Map();
    for (let i = 0; i < cand.length; i++) score.set(cand[i].src, cand[i].score);

    // Drop commitments whose source went dark, or left the scene entirely.
    for (const s of slots) if (s.want && !score.has(s.want)) s.want = null;

    const committed = new Set();
    for (const s of slots) if (s.want) committed.add(s.want);

    for (let i = 0; i < cand.length; i++) {
      const c = cand[i];
      if (committed.has(c.src)) continue;

      let free = null;
      for (const s of slots) {
        if (!s.want) { free = s; break; }
      }
      if (free) {
        free.want = c.src;
        committed.add(c.src);
        continue;
      }

      let weakest = null;
      let weakestScore = Infinity;
      for (const s of slots) {
        const sc = score.get(s.want) ?? 0;
        if (sc < weakestScore) { weakestScore = sc; weakest = s; }
      }
      // Candidates are sorted, so once the best remaining one cannot win a
      // slot, none of the rest can either.
      if (!weakest || c.score <= weakestScore * SWAP_GAIN) break;
      committed.delete(weakest.want);
      weakest.want = c.src;
      committed.add(c.src);
    }
  }

  /**
   * Directional lights carry no falloff, so there is nothing to score: sort by
   * intensity and fill the slots. Shadow casters and fills are ranked
   * separately because the shadow slots are the scarce resource.
   */
  _assignDirectional() {
    const shadow = [];
    const fill = [];
    for (const l of this._srcDir) {
      if (!(l.intensity > 0)) continue;
      (l.castShadow ? shadow : fill).push(l);
    }
    const byIntensity = (a, b) => b.intensity * luminance(b.color) - a.intensity * luminance(a.color);
    shadow.sort(byIntensity);
    fill.sort(byIntensity);

    let si = 0;
    for (const slot of this.dirShadow) {
      if (slot.reserved) continue; // the caller's sun - not ours to reassign
      slot.src = shadow[si++] ?? null;
    }
    // A world that brought more shadow keys than there are slots would silently
    // lose one, and "my shadows vanished in this world" is a horrible bug to
    // track down from a screenshot.
    if (si < shadow.length) {
      const extra = shadow.length - si;
      if (this._warnedShadow !== extra) {
        this._warnedShadow = extra;
        console.warn(
          `[LightRig] ${shadow.length} shadow-casting directional lights but only ` +
          `${this.dirShadow.length - 1} assignable slots - ${extra} will not cast. ` +
          'Raise RIG_BUDGET.dirShadow or drop a key light.'
        );
      }
    }

    let fi = 0;
    for (const slot of this.dirFill) slot.src = fill[fi++] ?? null;
    if (fi < fill.length && this._warnedFill !== fill.length - fi) {
      this._warnedFill = fill.length - fi;
      console.warn(
        `[LightRig] ${fill.length} fill directionals but only ${this.dirFill.length} slots - ` +
        `${fill.length - fi} dropped (weakest first). Raise RIG_BUDGET.dirFill.`
      );
    }

    this.stats.dirUsed = Math.min(shadow.length, this.dirShadow.length) + Math.min(fill.length, this.dirFill.length);
  }

  /* ------------------------------------------------------------------ */
  /* Driving the slots                                                   */
  /* ------------------------------------------------------------------ */

  _drive(dt) {
    let pUsed = 0;
    for (const s of this.point) {
      this._crossfade(s, dt);
      if (this._applyPunctual(s)) pUsed++;
    }
    let sUsed = 0;
    for (const s of this.spot) {
      this._crossfade(s, dt);
      if (this._applyPunctual(s)) sUsed++;
    }
    for (const s of this.dirShadow) if (!s.reserved) this._applyDirectional(s, true);
    for (const s of this.dirFill) this._applyDirectional(s, false);

    this.stats.pointUsed = pUsed;
    this.stats.spotUsed = sUsed;
  }

  /** Dip to black before changing source, then come back up. */
  _crossfade(slot, dt) {
    if (slot.want !== slot.src) {
      slot.fade -= dt / FADE_OUT;
      if (slot.fade <= 0) {
        slot.fade = 0;
        slot.src = slot.want;
      }
    } else if (slot.src) {
      slot.fade = Math.min(1, slot.fade + dt / FADE_IN);
    } else {
      slot.fade = 0;
    }
  }

  /** Copy a point/spot source onto its slot. @returns {boolean} slot is lit */
  _applyPunctual(slot) {
    const l = slot.light;
    const src = slot.src;
    if (!src || slot.fade <= 0) {
      l.intensity = 0;
      return false;
    }
    _p.setFromMatrixPosition(src.matrixWorld);
    l.position.copy(_p);
    l.color.copy(src.color);
    l.distance = src.distance;
    l.decay = src.decay;
    l.intensity = src.intensity * slot.fade;
    if (l.isSpotLight) {
      l.angle = src.angle;
      l.penumbra = src.penumbra;
      if (src.target) {
        _q.setFromMatrixPosition(src.target.matrixWorld);
        // A spot whose target was never parented reports the origin, which is
        // also what three would have used, so this is correct either way.
        l.target.position.copy(_q);
        l.target.updateMatrixWorld();
      }
    }
    return true;
  }

  /**
   * Copy a directional source onto its slot, shadow configuration included.
   * The source keeps being the object its world pokes (`shadow.needsUpdate`,
   * intensity, target position); the slot is what the renderer sees.
   */
  _applyDirectional(slot, withShadow) {
    const l = slot.light;
    const src = slot.src;
    if (!src) {
      l.intensity = 0;
      if (withShadow) {
        l.shadow.autoUpdate = false;
        // Only silence it once it actually owns a depth attachment - see
        // parkShadow(). Clearing `needsUpdate` before the first pass would leave
        // the shader sampling a colour texture through a shadow sampler.
        if (l.shadow.map) l.shadow.needsUpdate = false;
      }
      return;
    }

    l.color.copy(src.color);
    l.intensity = src.intensity;
    _p.setFromMatrixPosition(src.matrixWorld);
    l.position.copy(_p);
    _q.setFromMatrixPosition(src.target.matrixWorld);
    l.target.position.copy(_q);
    l.target.updateMatrixWorld();

    if (!withShadow) return;

    const a = l.shadow;
    const b = src.shadow;
    if (a.mapSize.x !== b.mapSize.x || a.mapSize.y !== b.mapSize.y) {
      a.mapSize.copy(b.mapSize);
      // A live map at the old resolution would be reused at the wrong size.
      a.map?.dispose();
      a.map = null;
    }
    a.bias = b.bias;
    a.normalBias = b.normalBias;
    a.blurSamples = b.blurSamples;

    const ca = a.camera;
    const cb = b.camera;
    if (ca.left !== cb.left || ca.right !== cb.right || ca.top !== cb.top ||
        ca.bottom !== cb.bottom || ca.near !== cb.near || ca.far !== cb.far) {
      ca.left = cb.left; ca.right = cb.right;
      ca.top = cb.top; ca.bottom = cb.bottom;
      ca.near = cb.near; ca.far = cb.far;
      ca.updateProjectionMatrix();
    }

    a.autoUpdate = b.autoUpdate;
    // Forward the world's one-shot refresh request and consume it, so a world
    // driving a 7 Hz shadow refresh keeps driving it through the slot.
    if (b.needsUpdate) {
      a.needsUpdate = true;
      b.needsUpdate = false;
    }
  }

  /** @returns {string} one-line summary for the debug overlay. */
  describe() {
    const s = this.stats;
    return `lights ${s.pointUsed}/${this.point.length}p ${s.spotUsed}/${this.spot.length}s ` +
      `${s.dirUsed}d from ${s.sources} sources`;
  }

  dispose() {
    const all = [...this.point, ...this.spot];
    for (const s of all) {
      s.light.removeFromParent();
      s.light.dispose?.();
    }
    for (const s of [...this.dirShadow, ...this.dirFill]) {
      if (s.reserved) continue;
      s.light.shadow?.map?.dispose();
      s.light.target?.removeFromParent();
      s.light.removeFromParent();
      s.light.dispose?.();
    }
    this.point.length = 0;
    this.spot.length = 0;
    this.dirShadow.length = 0;
    this.dirFill.length = 0;
  }
}

export default LightRig;
