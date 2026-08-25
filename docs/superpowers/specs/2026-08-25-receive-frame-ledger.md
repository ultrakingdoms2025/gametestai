# The frame that receives a world, measured

*perf-receive-frame, 25 Aug 2026. Every number here is from the PRODUCTION
bundle — `node scripts/frame-gaps.mjs --serve prod`, the hashed assets the site
serves. It continues
[the crossing cost ledger](2026-08-24-crossing-cost-ledger.md) and
[the crossing subsystems ledger](2026-08-24-crossing-subsystems-ledger.md),
which drove a station crossing from 1,228 ms of JavaScript to 80 and then said
the crossing was no longer the problem.*

## What was handed over

Two ledgers had taken the crossing apart and left one number standing. With
**both** offending subsystems stubbed out entirely — the dart budget and all
12,256 physics probes still running — the phase still cost **166.7 ms, of which
only 64 ms was the crossing**. `--gl` charged **1 ms** of a 233 ms gap to
`bindVertexArray` across 2,055 calls, so it was not submission and not the
driver. The brief that came with it named four suspects:

> ~135 ms of every crossing frame is the frame that RECEIVES a world:
> `updateMatrixWorld`, culling, the shadow pass, sixty characters' first update.

**All four are wrong.** Measured on the frame the station arrives on:

| | ms | calls |
| --- | ---: | ---: |
| `scene.updateMatrixWorld` | **1.9** | 2 |
| the shadow pass | **3.3** | 27 |
| every frame updater, sixty characters included | **4.4** | 5 |
| `renderBufferDirect` — all submission | **8.6** | 1,737 |
| **`SkinnedMesh.computeBoundingSphere`** | **123.6** | **27** |

## 1. The instrument, because nothing existing could see this

`--profile` on the production bundle reads `ya`, `wU`, `mt`, and it turned a
1,366 ms crossing into 11,450 ms the one time it was pointed at one. What
survives minification is PROPERTY names, so `--frames` instruments the loop
through them: the engine's two updater sets wrapped per member, each gameplay
subsystem by the key it hangs off `GAME`, `PostFX.render` and every composer
pass by name, and inside the render `scene.updateMatrixWorld`,
`WebGLShadowMap.render` and `renderBufferDirect`. Culling has no entry point to
wrap, so it is read as `r.render − r.matrixWorld − r.shadow − r.draw`.

The accumulator is drained by the recorder's own rAF callback, which is
installed before the first module of the bundle is parsed and therefore runs
before the engine loop every frame. What it drains at frame N is frame N−1's
loop — exactly the work inside the gap it is closing.

Two harness defects surfaced on the way and are fixed here:

- **`--floor` never reached the page.** It has been documented since the first
  version of this script and the recorder carried a hard-coded 24; every run
  that passed the flag silently got 24 anyway. It is the knob that decides
  which frames carry a breakdown, so it had to start working first.
- `blockedMs` is charged one gap late on a fully blocked gap: after a long
  block Chrome services the pending animation frame before the pending timer,
  so the heartbeat records `beats 0, blocked 0` for the gap that blocked and
  the whole stall against the next one. Both neighbours are in the report, so
  this is a reading rule rather than a fix.

## 2. What the receive frame actually is

The station's receive frame, and a steady station frame from the same run:

```
  216.6 ms  receive                    33.3 ms  steady
    131.8  x1     postfx                 13.4  x1     postfx
    125.7  x1     fx.scene                8.4  x1     fx.scene
    115.4  x3968  x.frustum               0.4  x4145  x.frustum
      9.8  x5     fixed                   1.3  x1     fixed
      8.6  x1737  r.draw                  5.2  x1522  r.draw
      6.0  x1     fx.gtao                 4.8  x1     fx.gtao
      4.4  x5     frame                   1.9  x5     frame
      3.3  x27    r.shadow                3.3  x26    r.shadow
      1.9  x2     r.matrixWorld           1.5  x2     r.matrixWorld
```

The same 4,000 frustum tests, 2,500 draw calls and 9M triangles. **The same
function, 290 times more expensive per call.** `Frustum.intersectsObject` is
arithmetic — a sphere copy, a matrix multiply and six plane distances — except
for one branch:

```js
if ( object.boundingSphere !== undefined ) {
  if ( object.boundingSphere === null ) object.computeBoundingSphere();
```

`SkinnedMesh` declares `boundingSphere` and initialises it to `null`, and
`SkinnedMesh.computeBoundingSphere()` **CPU-skins every vertex of the body** —
`getVertexPosition` per vertex, four bone lookups and four `Matrix4` multiplies
each. Wrapping it directly:

| frame | `x.frustum` | of which `x.skinBound` | characters |
| --- | ---: | ---: | ---: |
| station arrives | 123.9 ms / 4,574 calls | **123.6 ms** | 27 |
| medieval arrives | 85.2 ms / 3,578 calls | **84.3 ms** | 28 |
| the frame after | 44.3 ms / 2,750 calls | **43.5 ms** | 15 |
| every other frame | 0.4 ms / 4,145 calls | — | 0 |

4.6 ms per character, and 99% of the frustum time is that one call.

Nothing ever invalidates the result, so it is paid exactly once per
`SkinnedMesh` — and a crossing builds a whole new cast, so it is paid once per
character per crossing, on the frame that receives the world. It is invisible to
every instrument this repository already had: no programs, no geometries, no
textures, no GL, and a CPU profile that names it `T` on the bundle that counts.

## 3. The answer was already in the geometry

`mergeParts` in `src/npc/Humanoid.js` has always ended like this:

```js
geo.computeBoundingSphere();
// Animation moves vertices outside the bind pose; pad so frustum culling and
// shadow bounds do not pop limbs away at the edge of the screen.
geo.boundingSphere.radius *= 1.5;
```

A padded bind-pose sphere, computed once per body geometry, authored for exactly
this job — **and the culler has never read it**, because `SkinnedMesh` shadows
`geometry.boundingSphere` with its own.

`src/gfx/SkinBounds.js` hands it over, and `HumanoidFactory` calls it at the one
place in the game that constructs a `SkinnedMesh`.

This is not a new approximation. What ships today is the skinned sphere of ONE
arbitrary pose — whichever pose a character held on its first rendered frame —
frozen for that character's life. A padded bind-pose sphere is the same kind of
value and a strictly larger one, so it can only ever keep on screen something the
current sphere would have culled. The only other reader is `SkinnedMesh.raycast`,
where a larger sphere means more candidate triangles tested and never a missed
hit.

### The pad is 1.4 and both numbers in it were measured

- **synthetic** (`scripts/tests/skin-bounds.test.mjs`): a rig carrying vertices
  at every bone of the real humanoid spec, every joint driven to 86° on every
  axis in both directions and then all of them at once. The worst pose escapes
  a 1.5-padded sphere by **2.7%**.
- **real** (`frame-gaps.mjs --frames`, which walks every live character in the
  station and medieval after six seconds of play and compares the assigned
  sphere against the one three would compute for the pose it is actually in):
  118 characters, worst containment ratio **0.979** at a pad of 1.15.

The real measurement is the harsher of the two — one live character reached a
pose the synthetic sweep does not produce and came within 2% of leaving its
bound, and at a pad of 1.0 would have escaped it outright. 1.4 puts that
character at 0.80 and the synthetic worst at 0.73. The first draft of the
synthetic rig weighted every vertex to a single bone, which made bending the
lower spine swing the whole mesh about the pelvis; it demanded a margin to fix a
body no character has, and it is recorded in the test file so the next person
does not rebuild it.

## 4. The ablation, both ways round

Neither number below is an estimate. Both are the same session, the same bytes,
three crossing pairs each.

**Before the fix**, with `SkinnedMesh.computeBoundingSphere` replaced by a
bind-pose sphere from the harness:

| | worst gap |
| --- | ---: |
| `repeat:1`, `repeat:2` — as it ships | **233.2, 233.3 ms** |
| the same crossings, method ablated | **116.7, 116.7, 116.8 ms** |

**After the fix**, with the fix taken back out by nulling `boundingSphere` in
`SkinnedMesh.bind` — the last thing `HumanoidFactory` does to a body, so the
character is left in exactly the state it shipped in:

| | worst gap | `x.skinBound` |
| --- | ---: | ---: |
| `repeat:2` — with the fix | **133.2 ms** | — |
| `unbound:0/1/2` — fix removed | **233.3, 233.4, 216.6 ms** | 125.3, 122.6, 120.5 ms / x27 |

The receive frame's `postfx` falls from 131–145 ms to **8.6–21 ms**, and what is
left of the worst gap is the crossing's own JavaScript (83–86 ms) plus one
ordinary frame.

## 5. The budget

`stats().warm.programs` is **151** in every run in this branch, before and after.
No crossing measured here carries `dProg` above 0 except the two documented tails
in §6. Materials, renderables, instanced meshes, instances and world lights are
untouched by construction: this changes one property on an object that was
already in the scene.

## 6. The verdict

Three clean production runs — `--serve prod --events repeat --repeat 3`, no
instrumentation of any kind, which is the gate as the criterion is written
against it:

| run | `repeat:0` | `repeat:1` | `repeat:2` | `warm.programs` |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 866.6 (dProg 7) | **100.0** | **100.0** | 151 |
| 2 | 1,300.2 (dProg 8) | **100.0** | **100.0** | 151 |
| 3 | 1,383.3 (dProg 8) | **116.6** | **116.7** | 151 |

**Six true repeats: 100.0, 100.0, 100.0, 100.0, 116.6, 116.7 ms against a 250 ms
budget.** The whole distribution now sits at 40–47% of the budget, where it
previously sat at 87–100% with three of five failures a tenth of a millisecond
over. In those six phases the only gaps above the 24 ms floor at all are the
crossing's own 83–100 ms and the occasional 33 ms double-frame; the receive
frame no longer registers.

### `repeat:0` is a first entry wearing a repeat's label

It is not a repeat and this branch did not make it one. With `--events repeat`
alone the destination has never been entered in the session, so `repeat:0`'s
first crossing builds medieval's entire cast from scratch — `npcs 455–487 ms`,
`dGeometries +215` — and links 7–8 shader programs. That is 565–600 ms of
crossing inside an 866–1,383 ms gap, and it is the same cost the criterion's
`entry` line is for. The three earlier branches' ledgers report the same
distribution shape with two long tails in fifteen samples, which is what a
per-run first entry looks like.

The instrument now says so at the call site, and `--events entry,repeat` makes
all three phases true repeats.

### What is left, and it is not the receive frame

A crossing that LINKS A PROGRAM is still in a class of its own. In an
instrumented run one such crossing carried `dProg 1` and cost **5,433 ms**, of
which 5,314 ms was inside `renderBufferDirect` — one `linkProgram` and the
`LINK_STATUS` read that waits for it, in the driver, on the frame a player is
in. This phase has spent three branches on that axis and the remaining named
lever is sports' fog type. Nothing in this branch touches it.

## 7. Reading it yourself

```
node scripts/frame-gaps.mjs --serve prod --events repeat                    # the gate
node scripts/frame-gaps.mjs --serve prod --events repeat --frames           # + the loop, the containment check, the ablation
node --test scripts/tests/skin-bounds.test.mjs
```

`--frames` reports, per kept gap, every stage of the engine loop that ran inside
it; `skinBounds`, the containment ratio of every live character in both
criterion worlds; and `unbound:*`, the same crossings with this branch's change
taken back out.
