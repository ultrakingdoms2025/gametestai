# First entry: a freeze that was not a cost, and six identical shaders per world

*perf-first-entry, 25 Aug 2026. Every number here is from the PRODUCTION
bundle — `node scripts/frame-gaps.mjs --serve prod`, the hashed assets the site
serves. It continues
[the receive-frame ledger](2026-08-25-receive-frame-ledger.md), whose §7 table
of first-world-entry costs is the thing this branch was sent to explain, and
which stands except for one row.*

## What was handed over

Phase 1's repeat criterion is met — 100–117 ms against 250. What was left was
FIRST entry: eleven of seventeen worlds at 16.8–17.0 ms and six that were not,
led by

> | world | worst gap | dProg | what the ledger says it is |
> | --- | ---: | ---: | --- |
> | **race** | **31,284.1 ms** | **0** | a volatile world rebuilt (`dGeom −217`) |

Race is not volatile. `MazeWorld` is the only world in the game that is, and
`WorldManager.build` regenerates one only when it is not the active world.
Race's `_activate` is 442–487 ms, measured four times.

The 31,284 ms is real in the sense that no frame was drawn for 31 seconds. It
is not a cost: the main thread was idle for all of it.

## 1. `beats` was in the record the whole time

The recorder runs a 4 ms `setInterval` beside the frame loop and has since it
was written, with the reason on it:

> IS THE MAIN THREAD BLOCKED, OR IS THE FRAME JUST NOT COMING? … a 4 ms timer
> chain runs on the same main thread but is NOT gated on the compositor, so
> during a gap it either keeps ticking — the thread is free and the frame is
> stuck behind the GPU or the presenter — or it stops with the frames.

`printFrames` printed `blocked` and never printed `beats`, and `outside-loop`
— the number the §7 attributions were read off — is a subtraction, so a frame
that never arrived and a frame spent in a foreign task are identical in it.

Reproducing the §7 run on this tree, the same 30-second gap appeared, on a
different world:

```
at 147956  ms 32517.5  phase entry:citadel  blocked 445  beats 8004  dP 0
```

**8,004 heartbeats in 32,517.5 ms is one every 4.06 ms, end to end.** No
JavaScript ran in that gap except a single 445 ms block, and 445 ms is race's
whole crossing — the harness's `goto` landed inside someone else's frozen
window and was charged to it, because a gap belongs to the phase that was open
when it STARTED.

The page had already said so. In the same run's console log, from inside the
same gap:

```
128421 warn [harness] no animation frame for 10000ms - the window is very likely
              backgrounded or occluded. Nothing is updating, including the sun's
              shadow camera.
```

`src/dev/Harness.js` has counted those into `window.__HARNESS_RAF_STALLS__`
since it was written. `frame-gaps.mjs` never read it.

### What it is

Windows computes native window occlusion for headless windows too, and a
renderer it decides is occluded stops receiving `BeginFrame` while timers,
promises and CDP evals keep running at full rate. Four flags —
`--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`,
`--disable-background-timer-throttling` and
`--disable-features=CalculateNativeWinOcclusion` — take most of it away; it is
not gone, so the instrument now names it rather than trusting the flags:

- `beats` is printed beside `blocked` on every `--frames` row;
- the summary carries a `blocked` column and labels a row **STARVED** when the
  gap is over budget and the heartbeat inside it never was;
- `rafStalls` is read off the page's own watchdog and printed when it is not
  zero.

A starved gap still counts against the budget — the screen was frozen — but it
can no longer be read as the phase's own work.

### Race, measured four times

| run | `entry:race` worst | `blocked` | dProg | `_activate` total |
| --- | ---: | ---: | ---: | ---: |
| all worlds, base | 50.0 | 20 | 0 | 442.0 (charged to `entry:citadel`'s starved gap) |
| all worlds, +cache-keys | 450.0 | 462 | 0 | 487.2 |
| all worlds, +rim fix | 12,833.6 | 12,855 | 0 | 487.2 |
| race alone, `--gl` | 483.4 | 497 | 0 | 473.3 |

**Race's first entry is its crossing and nothing else.** `--gl` on the 483.4 ms
run charges the whole gap to `bufferData`, 2 ms across 297 calls: not the
driver, not a link, not an upload. The engine loop inside it is 16 ms. What is
left is `npcs 264.7` — building race's cast for the first time — and
`changed 202.8`, the `world:changed` fan-out placing 8 darted caches and 43
darted relics.

One of the four carried 12,351 ms inside `r.shadowDraw` across 245 shadow
draws, with `dProg 0`, and the same 245 draws cost 1.4 ms on the very next
frame of the same run. It did not reproduce in the other three and it was not
taken with `--gl`, so this ledger names it and does not explain it: **a
one-in-four first-use cost in the shadow pass that creates no program.** It is
the one thing here left open.

## 2. The seven links are two causes, and the larger one is six identical shaders

`--cache-keys` has recorded the arrival's novel program keys since the
perf-frame-gaps branch and has never printed them. It does now — each novel key
aligned against the nearest key that already existed, with the differing fields
named by counting backwards from the fixed 52-entry tail of three's
`getProgramCacheKey`. On the shipping tree:

```
  entry:dock  +7 programs
      1 field differ: customProgramCacheKey rim3|16765608|0.31|4|0.62|16763052
                                         -> rim3|12376319|0.26|4|0.62|16763052
      ... and six more, every one of them that field and nothing else

  entry:medieval  +7 programs
      1 field differ: bools:instancing..vertexNormals 8389120 -> 8389123
      ... and six more, every one of them customProgramCacheKey rim3|... only
```

**Seven of dock's seven and six of medieval's seven differ from a program that
already existed in one field: the character rim's cache key.**

### The comment was right about the mechanism and wrong about the consequence

`addRim` in `src/npc/Humanoid.js` injects a fresnel rim and a two-colour fill
into a standard material, and ended:

```js
// Without a distinct cache key three would reuse the first compiled program
// for every rim colour.
mat.customProgramCacheKey = () => `rim3|${rimHex}|${strength}|${power}|${fwdK}|${fwd}`;
```

Three would reuse the program — and that is correct, because it is the same
program. Every one of those six values is a **uniform** (`uRimColor`,
`uRimStrength`, `uRimPower`, `uFillSky`, `uFillGround`, `uFillStrength`,
`uFillFwd`, `uFillFwdK`), and neither injected GLSL block interpolates
anything: the only `${}` in the whole function was in the key itself.

Sharing the program cannot leak a colour between characters, and the reason is
three's own code. `WebGLRenderer.getProgram`:

```js
parameters.uniforms = programCache.getUniforms( material );   // a clone, per material
material.onBeforeCompile( parameters, _this );                // runs on that clone
program = programCache.acquireProgram( parameters, programCacheKey );
materialProperties.uniforms = parameters.uniforms;            // stored per material
```

Only the compiled program is shared, and only when every other cache-key field
already matches.

What the per-tuple key bought was a fresh link of byte-identical GLSL for every
distinct rim tuple. There are six `addRim` call sites — skin, three cloths,
leather, metal — each with its own strength multiplier and falloff, so a cast
carries six tuples; `THEME_RIM` gives station, medieval, sports and dock a
different colour each; and a crossing rebuilds the cast. Six programs, on the
frame the player arrives on, in every world whose rim palette had not been seen.

The key is now the constant `'rim3'`, which is still required: three's default
`customProgramCacheKey()` returns `onBeforeCompile.toString()`.

### The gate is on the property, not on the key

A shared cache key is only safe while the source is identical —
`WebGLPrograms.acquireProgram` matches on the key alone and returns the first
program it finds, so two materials producing different GLSL under one key get a
wrong picture rather than a slow one.

`scripts/tests/character-rim-programs.test.mjs` therefore asserts the two facts
that make one key correct, and does not assert the key:

1. two rims differing in every value compile **byte-identical** vertex and
   fragment source, and the injected terms are actually present (an anchor that
   stopped matching would also be identical);
2. they carry **different uniform objects and values**, because three clones the
   uniforms per material before `onBeforeCompile` sees them.

Confirmed by injection in both directions: interpolating `power` into the
shader source fails case 1; putting the tuple back into the key fails cases 4
and 5. A fifth case reads `src/npc/Humanoid.js` and `src/npc/NPC.js` and fails
on any `customProgramCacheKey = () => \`…${…}…\`` — the same defect, looked for
once rather than found again in a year.

## 3. Before and after, and the ablation

**Read the counter, not the clock.** The exact counters below are
byte-deterministic across every run of each tree. The milliseconds are not: on
this driver a link costs anywhere between about 15 ms and 1,350 ms, so seven of
them are worth 0.1 s in one session and 9.5 s in another. Both numbers are
here, in that order, and the second one is a distribution rather than a value.

The ablation is the per-tuple key put back and the bundle rebuilt — nothing
else differs — measured with `--serve prod --events entry --worlds dock,medieval
--gl --cache-keys`.

| | `entry:dock` dProg | `entry:medieval` dProg | `boot` dProg | `warm.programs` |
| --- | ---: | ---: | ---: | ---: |
| shipped / ablated | **7** (7 of 7 are `rim3\|…`) | **7** (6 of 7) | 152 | **151** |
| this branch | **0** | **1** | 143 | **143** |

Every ablated run reproduces the same seven and the same six, key for key.

And what those counters were worth in wall clock, across five sessions:

| | `entry:dock` worst gap | `entry:medieval` worst gap |
| --- | ---: | ---: |
| shipped / ablated | 416.6 · 2,966.9 · **9,800.4** | 749.9 · 816.6 · 3,333.8 |
| this branch | **316.6 · 366.7** | 683.3 · 699.9 · 749.9 |

The 9,800.4 ms one is the shape of the worst case and it is worth reading
whole: **9,459.5 ms of it was inside `renderBufferDirect`** across 1,239 draws.
After the change the same 1,239 draws are 9.2 ms and the gap is the crossing —
`npcs 243.7`, `portals 45.9`. On a good session the same seven links cost about
100 ms, and dock's before and after overlap.

Medieval's seven were never its cost — its 683–750 ms is `npcs 428–461 ms`, a
first cast built from scratch, and it is 683–750 on both trees. Six of its
seven programs are gone all the same, and the margin they were spending is the
point: the receive-frame ledger measured one crossing at **5,433 ms for a single
`dProg 1`**, 5,314 ms of it the `LINK_STATUS` read inside `renderBufferDirect`
on a frame the player was in. Seven standing programs are seven chances at that.

`stats().warm.programs` falls from **151 to 143**. The budget moved DOWN by
nine, which is nine programs the game was building and could never need.

## 4. Maze is the other cause, and a warm cannot reach it today

Maze's six-to-twelve are not rim. Every one differs in
`bools:instancing..vertexNormals` or `metalnessMapUv`: bit 18 (`batching`) and
bit 10 (`vertexColors`), which are real, genuinely novel shaders.

`--gl` names the cost exactly:

```
entry:maze  1016.9 ms  blocked 1042  dProg 7
   gl: [["getProgramInfoLog",963,7],["getShaderInfoLog",3,14],["shaderSource",1,14], ...]
```

**963 ms across seven calls.** The whole gap is the link wait.

The cause is one line in `main.js`:

```js
const rest = worldManager.ids.filter((id) => id !== startWorld && !worldManager.isVolatile(id));
```

`MazeWorld` is `static volatile`, so it is filtered out of
`scheduleBackgroundBuilds` — it is never generated while the player stands in
the station, its gateway shows a stabilising disc, and there is nothing for
`warmWorld` to compile. That is deliberate and the file says so. The
consequence is that the maze is the one world whose programs are linked in
front of the player by design.

It is paid **once per session, not once per entry**, and that was measured
rather than assumed. `--events entry,repeat --worlds maze,medieval` puts the
maze in the repeat pair:

| | worst gap | dProg |
| --- | ---: | ---: |
| `entry:maze` | 1,933.5 ms | 12 |
| `repeat:0` (station↔maze) | 383.3 | 0 |
| `repeat:1` | **166.7** | **0** |
| `repeat:2` | **166.7** | **0** |

The programs survive the re-roll because the materials do —
`MazeMaterials`'s module cache is left alone by `MazeWorld.dispose()` on
purpose, and the file says so: *"materials survive re-rolls — see dispose()"*.

**That is also what makes the fix viable, and it is why it is worth costing.**
A single background build of the maze, warmed and then left to be re-rolled by
the first real entry, would link those seven programs behind the loading screen
and they would still be there afterwards. The price is one maze build in the
background chain — measured in this run's own log at **1,883 ms** — plus its
warm slices, against **963–4,151 ms** off the first maze entry. It is one
filter in `scheduleBackgroundBuilds` and `main.js` is outside this branch's file
boundary, so it is written down here and not taken.

## 5. Where the six now stand, and what each one is

`--serve prod --events entry --frames --cache-keys`, this tree:

| world | worst gap | blocked | dProg | what it is |
| --- | ---: | ---: | ---: | --- |
| dock | **316.6 – 366.7** | 322–354 | **0** (was 7) | the crossing: `npcs 243.7`, `portals 45.9` |
| medieval | **683.3 – 749.9** | 703–760 | **1** (was 7) | first cast, `npcs 428–460` |
| citadel | **466.7** | 495 | 0 | first cast, `npcs 305.9` |
| race | **450 – 483** | 462–497 | 0 | first cast + `changed 203–244` (darts) |
| maze | 1,933 – 4,150 | 1,969–4,151 | 7–12 | the only unwarmed world; §4 |
| sports | 6,183.6 | 6,192 | **45** (was 52) | its `FogExp2`; decided, kept |
| the other eleven | 16.8 – 17.1 | — | 0 | — |

**Four of the six are now a first cast being built, and no shader at all.**
`NPCManager.spawnForWorld` is 244–460 ms of a first entry in dock, medieval,
citadel and race, and the crossing-subsystems ledger already established what
that is: lofting, welding, skinning and merging every body in the cast, ~8.7 ms
per geometry, memoised only after it has been paid once. Its free list makes a
RE-entry free; a first entry has nothing to revive.

Nothing here is under 250 ms except the eleven that already were. What changed
is that five of the six are now one named cost apiece instead of a shader
stall, and the two that were seconds of driver time — dock, and six sevenths of
medieval — are milliseconds.

## 6. What was not taken

- **Sports' fog.** Untouched, per the brief. Its 52 became 45 for free: six of
  the seven the rim was minting are gone from its arrival too, which is worth
  saying because the fog is not all of sports and the rest of it is now smaller.
- **Maze's background warm.** §4, costed. `main.js`, outside the boundary.
- **`spawnForWorld`'s first cast.** 244–460 ms in four worlds, and the largest
  single remaining first-entry cost in the game. It is a build, not a cache
  miss: there is no earlier moment to move it to that is not the background
  chain, which would mean building four worlds' casts at boot. It belongs to
  `src/npc/`, and it is a design question rather than a defect.
- **Race's one-in-four 12.3 s shadow pass.** §1. Not reproduced under `--gl`,
  so it has no attribution and this branch will not guess one.
- **The occlusion itself.** The flags reduced it and did not remove it — one
  STARVED row still appeared in two of the six runs taken with them. Every
  number quoted in this ledger is from a gap whose `blocked` is within
  measurement noise of its `ms`.

## 7. The budget

`stats().warm.programs`: **151 before, 143 after**, in every run on each tree.
`boot`'s `dPrograms`: 152 → 143. Nothing rose.

## 8. Reading it yourself

```
node scripts/frame-gaps.mjs --serve prod --events entry --frames --cache-keys
node scripts/frame-gaps.mjs --serve prod --events entry --worlds maze --gl
node scripts/frame-gaps.mjs --serve prod --events entry,repeat --worlds maze,medieval
node --test scripts/tests/character-rim-programs.test.mjs
```

`--cache-keys` prints every program the arrival linked with the fields that
made it novel. `--gl` charges the gap to driver entry points. On any `--frames`
row, **read `beats` before `outside-loop`**: a gap whose `beats` is roughly
`ms / 4` had an idle main thread from end to end and is not the phase's work.
