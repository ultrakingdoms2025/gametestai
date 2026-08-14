/**
 * Time-slicing for the shader warms that run after `engine.start()` - the
 * gateway destination previews, and the background worlds' own precompile.
 *
 * ── What actually blocks ───────────────────────────────────────────────────
 * Not `compile()`. Three issues `linkProgram` there and never reads the result;
 * it reads `LINK_STATUS` on a program's *first use*, which is a draw. Measured
 * on this project, over a cold boot of the station:
 *
 *     _compilePreviewGroup   4 calls    43.9 ms total   (issues ~190 links)
 *     _renderPreview         4 calls   35.8  s total   (draws them)
 *
 * So slicing the compile would do nothing at all, and the previous shape of
 * `PortalSystem.warmPreviews` - one `render()` per gateway, from a background
 * idle callback - is four blocking chunks of 12.4 s, 15.3 s, 4.8 s and 3.3 s
 * landing in the first minute of play. About 163 ms of that is one program.
 *
 * The unit that has to be sliced is therefore the *draw*, at the granularity of
 * one distinct shader program. That is what `planPreviewWarm` enumerates and
 * `runSliced` paces.
 *
 * ── Why a representative object per program, not per material ──────────────
 * They are not the same count. `WebGLPrograms.getParameters` folds properties
 * of the *object* into the cache key as well as the material - skinning,
 * instancing, morph target count, whether the geometry carries vertex colours
 * or tangents - so one material shared by a static mesh and a skinned one is
 * two programs. In the other direction `WebGLRenderer.renderObject` draws a
 * `transparent && side === DoubleSide && !forceSinglePass` material twice, back
 * faces then front, which is two programs from one draw of one object. Drawing
 * one representative object per *signature* covers both: the double-sided case
 * comes free with the single draw, and the object-keyed cases are separate
 * units because their signatures differ.
 *
 * @see ../systems/Portals.js `warmPreviews`
 * @see ./RehearsalDraw.js - the same "compiling is not warming" lesson, applied
 *   to the boot rehearsal rather than to the previews.
 */

/**
 * The parameters `WebGLPrograms.getParameters` reads off the object rather than
 * the material, plus the material identity.
 *
 * Deliberately a *superset* of the real key. Over-splitting only costs an extra
 * slice that draws an already-linked program, which is a normal-length frame;
 * under-splitting drops a program out of the plan and it pays its full ~163 ms
 * inside a gameplay frame later, which is the whole defect. When in doubt, add
 * a component.
 *
 * @param {any} object
 * @param {any} material
 * @returns {string}
 */
export function previewProgramKey(object, material) {
  const g = object.geometry ?? null;
  const attrs = g?.attributes ?? null;
  const morph = g?.morphAttributes ?? null;
  return [
    material.uuid,
    object.isSkinnedMesh ? 'skin' : '',
    object.isInstancedMesh ? 'inst' : '',
    object.isBatchedMesh ? 'batch' : '',
    object.instanceColor ? 'icol' : '',
    object.isPoints ? 'pts' : object.isLine ? 'line' : object.isSprite ? 'spr' : 'mesh',
    object.morphTargetInfluences ? object.morphTargetInfluences.length : 0,
    attrs?.color ? 'vcol' : '',
    attrs?.tangent ? 'tan' : '',
    attrs?.uv1 ? 'uv1' : '',
    attrs?.normal ? 'nrm' : '',
    morph?.position ? 'mpos' : '',
    morph?.normal ? 'mnrm' : '',
    morph?.color ? 'mcol' : '',
  ].join('|');
}

/**
 * The dedupe both plans share: one representative renderable per distinct
 * program signature, in traversal order.
 *
 * @returns {{ units: any[], visit: (o: any) => void }}
 */
function programUnits() {
  /** @type {any[]} */
  const units = [];
  const seenKey = new Set();
  const seenObject = new Set();
  return {
    units,
    visit(o) {
      if (!(o.isMesh || o.isLine || o.isPoints || o.isSprite)) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      let novel = false;
      for (const m of mats) {
        if (!m) continue;
        const key = previewProgramKey(o, m);
        if (seenKey.has(key)) continue;
        seenKey.add(key);
        novel = true;
      }
      // One draw of the object covers every group of a multi-material mesh, so
      // a mesh that introduces four new keys is still one unit.
      if (novel && !seenObject.has(o)) {
        seenObject.add(o);
        units.push(o);
      }
    },
  };
}

/**
 * One representative renderable per distinct program the preview will need.
 *
 * `traverseVisible`, not `traverse`: a draw skips an object whose own or whose
 * ancestor's `visible` is false, so an invisible subtree contributes no program
 * to the preview and putting it in the plan would warm a key the preview never
 * asks for. This matches what the single un-sliced render used to cover, minus
 * frustum culling - the slice drawer clears `frustumCulled`, so the plan is a
 * superset of the old set rather than a subset of it.
 *
 * @param {any} group destination world's root
 * @returns {any[]} objects, in traversal order
 */
export function planPreviewWarm(group) {
  const { units, visit } = programUnits();
  if (!group?.traverseVisible) return units;
  /* The root itself is forced visible first, because an inactive world's group
   * is `visible = false` - that is how it stays off the live frame - and
   * `traverseVisible` stops dead at an invisible root. Parking a group for a
   * preview draw sets exactly this flag, so planning in any other state
   * describes a draw that never happens. Measured when this was missing: an
   * empty plan, no warning anywhere, and the entire cost silently left to the
   * one un-sliced render at the end. */
  const wasVisible = group.visible;
  group.visible = true;
  try {
    group.traverseVisible(visit);
  } finally {
    group.visible = wasVisible;
  }
  return units;
}

/**
 * One representative renderable per distinct program a `renderer.compile()` of
 * `root` would build.
 *
 * ── Why this is not `planPreviewWarm` ──────────────────────────────────────
 * `traverse`, not `traverseVisible`, and the difference is the whole reason
 * this exists separately. A preview *draw* skips a hidden subtree, so planning
 * one against `traverseVisible` describes exactly the set that will be drawn.
 * `compile()` does not skip it: it collects materials with `scene.traverse` and
 * prepares a parked interior's walls as readily as the street outside. Handing
 * the visible-only plan to a compile warm would therefore cover strictly LESS
 * than the single call it replaces, and every program it dropped would be
 * linked later - in a gameplay frame, under the player's mouse, which is the
 * defect the slicing is here to remove. The root's own `visible` is likewise
 * irrelevant and left untouched.
 *
 * The plan is a dedupe, not a substitute for the whole-group call: the key is a
 * near-superset of Three's, but the caller is still expected to finish with one
 * `compile()` over `root` to catch anything the key under-split. That call is
 * cheap by then, because every program the plan covered already exists.
 *
 * @param {any} root
 * @returns {any[]} objects, in traversal order
 */
export function planCompileWarm(root) {
  const { units, visit } = programUnits();
  if (!root?.traverse) return units;
  root.traverse(visit);
  return units;
}

/**
 * Split a plan into the batches one scheduler callback will draw.
 *
 * @param {any[]} units
 * @param {number} size
 * @returns {any[][]}
 */
export function chunkUnits(units, size) {
  const n = Math.max(1, Math.floor(size) || 1);
  const out = [];
  for (let i = 0; i < units.length; i += n) out.push(units.slice(i, i + n));
  return out;
}

/**
 * A "scheduler" that runs the next step at once.
 *
 * Deliberately does NOT yield - it is what a caller passes when it wants the
 * old one-block behaviour (a test, or a path with no idle time to give). On a
 * trampoline rather than a direct call because `runSliced` arms the next step
 * from inside the current one, and a plan of a thousand slices would otherwise
 * recurse a thousand frames deep.
 *
 * @returns {(fn: () => void) => void}
 */
export function immediateScheduler() {
  let queued = null;
  let running = false;
  return (fn) => {
    queued = fn;
    if (running) return;
    running = true;
    try {
      while (queued) {
        const next = queued;
        queued = null;
        next();
      }
    } finally {
      running = false;
    }
  };
}

/**
 * Run `steps` one per scheduler callback.
 *
 * `steps` is re-read on every callback, so a step may append further steps -
 * which is how a gateway's draw plan gets built by its own slice rather than up
 * front, keeping the traversal of a whole destination world off the callback
 * that would otherwise also be issuing every link.
 *
 * ── The yield is structural, not hoped for ─────────────────────────────────
 * Exactly one step runs per `schedule` invocation, and the next is only armed
 * after it returns. There is no loop here that could drain the list inside a
 * single task: an `await` of an already-resolved promise is a microtask, the
 * compositor never gets a turn, and the result measures exactly like the block
 * it was supposed to replace. Handing the re-arm to the caller's scheduler -
 * `requestIdleCallback` with a timeout, in this codebase - is what makes the
 * gap real.
 *
 * @param {{
 *   steps: Array<() => void>,
 *   schedule: (fn: () => void) => void,
 *   shouldStop?: () => boolean,
 *   shouldPause?: () => boolean,
 *   maxPauseMs?: number,
 *   now?: () => number,
 *   onError?: (err: any, index: number) => void,
 * }} opts
 * @returns {Promise<{ ran: number, total: number, reason: string }>}
 */
export function runSliced({
  steps,
  schedule,
  shouldStop = () => false,
  shouldPause = () => false,
  maxPauseMs = 30000,
  now = () => performance.now(),
  onError = null,
}) {
  return new Promise((resolve) => {
    if (typeof schedule !== 'function') {
      resolve({ ran: 0, total: steps?.length ?? 0, reason: 'no-scheduler' });
      return;
    }
    const list = steps ?? [];
    let i = 0;
    let ran = 0;
    let pausedSince = 0;
    const finish = (reason) => resolve({ ran, total: list.length, reason });
    const step = () => {
      if (shouldStop()) { finish('cancelled'); return; }
      if (i >= list.length) { finish('complete'); return; }
      // Two things pause: a world transition, which is a few seconds and worth
      // waiting out rather than abandoning the warm, and a deliberate wall-clock
      // hold while the driver works through the links that were just issued. The
      // cap is in wall-clock rather than callbacks precisely so the second of
      // those is expressible - it is only there so a permanently-paused system
      // cannot hold an idle callback chain open for the life of the page.
      if (shouldPause()) {
        if (!pausedSince) pausedSince = now();
        else if (now() - pausedSince > maxPauseMs) { finish('stalled'); return; }
        schedule(step);
        return;
      }
      pausedSince = 0;
      const fn = list[i++];
      try {
        fn();
        ran++;
      } catch (err) {
        onError?.(err, i - 1);
        finish('failed');
        return;
      }
      schedule(step);
    };
    schedule(step);
  });
}
