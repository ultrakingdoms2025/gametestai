# Phase 9 re-verified: every art branch's budget, re-measured on the fixed harness

Branch `budget-reverify`. Nothing in `src/` was changed; this is a measurement
and a verdict.

## Why

Phase 9 ran nine art branches, and every one of them was merged on a budget
table — *materials, renderables, instanced meshes, world lights and shader
programs unchanged; triangles +N*. Those tables were the whole basis for
merging, and they were all taken through an instrument that was later found to
be broken in two ways at once:

- `Harness.ready()` returned as soon as `worldManager.active` existed, and
  `boot()` sets that **before** `prewarm()`. Measured on a headless sports
  boot: `ready()` at **t+95.9 s**, `[boot] playable` at **t+172.0 s**,
  background program warm still linking at **t+250 s**. Every framing was taken
  inside boot's own warm-up.
- `prewarm` ends in `rehearse()` → `forceDrawable`, which set `visible = true`
  and `frustumCulled = false` across the world group. A settled sports frame
  has **5** unculled objects; during that window it had **334**.

So "unchanged" was asserted through a noisy instrument, and a real regression
could have been sitting inside the noise. This branch's job was to find out
whether one was.

**Verdict: no. See §6.**

---

## 1. Method

### 1.1 The baseline commit

The last commit before Phase 9's art passes began is **`06b79f6` "The retention
loop stops being invisible"** — the first parent of `830f598 Merge Phase 9
art-medieval`, which is the *earliest* art merge on `main`'s first-parent chain:

```
5787121 Merge Phase 8
470fdc6 Merge Phase 11b
830f598 Merge Phase 9 art-medieval     <- first art merge
06b79f6 The retention loop stops being invisible   <- BASELINE
```

(The brief named the parent of the `art-dock` merge. That is `a60f1ae`, which
already contains art-medieval, Phase 11b and Phase 8 — `git log --merges` lists
newest first, and art-dock is the *fourth* art merge by date, not the first.
`06b79f6` is used instead, so the sweep spans the whole phase.)

`main` was measured at **`86425d3` "Widen --ablate from the world group to the
scene"**, its head at the time of the sweep.

### 1.2 Measuring an old tree with a new instrument

`06b79f6` was checked out into its own worktree and the *current* instrument
copied over it:

| copied in | why it cannot change what the old tree draws |
|---|---|
| `src/dev/Harness.js` | dev-only, loads under `?dev=1`, and only moves the camera, hides the HUD and reads counters. It builds no world geometry. |
| `src/dev/WorldTriangles.js` | a pure read-only walk of `worldManager.active.group` against a frustum. |
| `src/gfx/RehearsalDraw.js` | the one file with a real behavioural change — see below. |
| `scripts/world-shot.mjs` | did not exist at `06b79f6` (850 lines, all new). |

`RehearsalDraw.js` is the honest caveat. Its restore used to replay the
snapshot exactly; it now only puts a value back where the current value is
still the one it wrote. That does change what a settled frame draws, in one
case: if a world's own LOD hid something *during* the rehearsal window, the old
code un-hid it and the new code does not. It is applied **identically to both
trees**, which is the point — the two sides are measured by one instrument, not
by their own. `main.js` at `06b79f6` already imports `forceDrawable` and
already runs `prewarm()` before `engine.start()`, so `settleBoot`'s three
signals (`engine.running`, `rehearsalInForce()`, program quiescence) are all
live on the old tree. The baseline reports confirm it: `rehearsalInForce: 0`,
`bootWarmRunning: false`, `programsSettled: true`, `bootWarmWaitedMs` 45–90 s
on every world.

One further back-port was needed and is the smallest possible: `06b79f6`'s
`MazeWorld` has no `static seedOverride`, so `--seed` had nothing to write to.
The three lines `main` uses were copied in verbatim. `MazeTopology.js` is
byte-identical between the two commits, so one seed builds one maze on both
sides.

### 1.3 The sweep

For each tree, `scripts/world-shot.mjs` was run once per world with all of that
world's framings, on the same machine, same GPU (`ANGLE (NVIDIA, NVIDIA GeForce
RTX 5080, Direct3D11)`), 1600×900, `gameplayDriven: true`, both trees
concurrently so machine load is symmetric:

```
station medieval citadel sports maze dock space cinder
```

`cinder` is the only planet with framings (`PlanetWorld` generates a class per
planet; nine of the ten have no `VIEWS` entry).

`race` has **no `VIEWS.race` entry at all**, so `--world race` takes zero
landscape framings. `art-race` measured it with four `--subject` framings and
never wrote the command down; the four subject points survive in the
`subjectAt` field of the two reports it committed under
`docs/superpowers/specs/img/2026-08-23-art-race/`. They are re-flown here as
literals — `marshal-post {28.67, 1.33, 177.03}`, `grandstand {9.92, 2.09,
233.82}`, `tyre-stack {219.45, 4.65, 167.66}`, `chicane {-325.44, 1.48,
-243.74}` — because a literal is the same point in both trees where an
expression reading a live object could resolve somewhere else on each side.

`scripts/budget-diff.mjs` diffs the two sweeps world by world, framing by
framing. Two rules are built into it:

- **`programs` is compared only at the end of a run.** It climbs monotonically
  *within* one — 241 at the first framing to 441 at the twelfth on unchanged
  code — because a sweep walks the player into material configurations the boot
  warm never linked.
- **A framing whose row reports `rehearsalInForce`, `bootWarmRunning`,
  `gameplayDriven: false`, or a world that is not the one asked for is excluded
  and named**, rather than averaged in. Those four states are exactly what made
  the original tables wrong.

### 1.4 Every framing was measured on a settled frame

The whole point of re-measuring is that the original tables were not. Every
report in this sweep carries `settleBoot`'s own verdict, and all of them agree:

| tree | worlds | framings | `engineRunning` | `rehearsalCleared` | `programsSettled` | `timedOut` |
|---|---|---|---|---|---|---|
| `06b79f6` | 8 + race | 100 + 12 | true | true | true | false |
| `86425d3` | 8 + race | 100 + 12 | true | true | true | false |

No framing reported `rehearsalInForce`, `bootWarmRunning`, `gameplayDriven:
false`, or a world other than the one asked for. One framing failed outright
and is excluded and named: `maze/tower-top` on `main`'s first maze run
(`_computeView` found no tower on that seed — the same class of failure
`lift-car` has).

---

## 2. The sweep, world by world

Baseline `06b79f6` → `main` `86425d3`, first run of each. Every cell is the
range of the per-framing delta over that world's whole framing set. **Bold**
means the delta was the *same number in every framing*.

| world | framings | materials | renderables | instanced | instances | world lights | world triangles | draw calls | programs (settled boot) |
|---|---|---|---|---|---|---|---|---|---|
| station | 21 | **0** | **0** | **0** | **0** | **0** | 0 … +47,328 | −1,448 … +1,118 | **+1** |
| medieval | 7 | **0** | **0** | **0** | **0** | **0** | **0** | −38 … +17 | **−1 … −2** |
| citadel | 13 | **0** | **0** | **0** | **0** | **0** | 0 … +88,468 | −120 … +18 | **−2** |
| sports | 8 | **0** | **0** | **0** | **0** | **0** | +4,860 … +23,772 | −52 … +20 | **0 … +1** |
| dock | 24 | **0** | **0** | **0** | **0** | **0** | −1,066 … −250 | −16 … +16 | **−3** |
| space | 15 | **−2** | **+1** | **+1** | **0** | **0** | **+18,480** | −15 … +8 | **−2** |
| cinder (planets) | 6 | **0** | **0** | **0** | **0** | **0** | **0** | −48 … 0 | **0** |
| race | 12 | **−1** | **0** | **0** | **0** | **0** | +648 … +2,088 | −6 … 0 | **−2** |
| maze | see §4 | — | — | — | — | — | — | — | — |

The `programs` column is `stats().warm.programs` — the cache at the settled
boot, before any framing moves the camera. The end-of-run figure every Phase 9
table used is a warm-up ramp and is not comparable; §5.3 shows a third run
breaking it.

The absolute figures on the baseline tree, first framing of each world, all
reproduce the architecture baselines the branches declared before they authored
anything:

```
  cinder    mats   18  meshes    34  inst   15  instances    2202  lights     1
  citadel   mats   16  meshes   166  inst   20  instances     156  lights    63
  dock      mats   86  meshes   166  inst   17  instances     762  lights   186
  medieval  mats   41  meshes   654  inst  221  instances  178598  lights   156
  race      mats   29  meshes   453  inst  129  instances    5506  lights     0
  space     mats   43  meshes    44  inst    6  instances     537  lights     1
  sports    mats  112  meshes   334  inst   74  instances   15071  lights     4
  station   mats  225  meshes  1354  inst  217  instances   54837  lights   226
```

---

## 3. Attribution: every non-zero delta, matched to the branch that declared it

### 3.1 station — `art-station` (`8452d71`)

Declared: *"materials 225 → 225, renderables 1354 → 1354, instanced meshes 217
→ 217, world lights 226 → 226. ZERO in all 21"*, and **+47,328 world
triangles** — 204 crowd figures × 232 triangles each, declared in its §4.1 as
*"the correct place for the cost and it is reported rather than hidden"*.

Re-measured, framing for framing:

```
plaza-wide               3040870 -> 3088198 (+47328)
plaza-centre             3000812 -> 3048140 (+47328)
portal-medieval          2953922 -> 3001250 (+47328)
portal-sports            2744594 -> 2791922 (+47328)
street-level             2880964 -> 2928292 (+47328)
district-east            3147140 -> 3194468 (+47328)
hull-outward             2786914 -> 2830994 (+44080)
window-apron             2627314 -> 2671394 (+44080)
apron-wide               3306496 -> 3353824 (+47328)
dome-inside              3272342 -> 3319670 (+47328)
hab-stacks               2651312 -> 2691072 (+39760)
hab-lobby                2637302 -> 2677062 (+39760)
link-galley              2337798 -> 2337798 (0)
zone-habitation          2180736 -> 2180736 (0)
zone-habitation-court    3322754 -> 3370082 (+47328)
zone-gym                 2156800 -> 2156800 (0)
zone-gym-court           2203364 -> 2203364 (0)
zone-construction        2120816 -> 2120816 (0)
zone-construction-court  2419360 -> 2419360 (0)
zone-canteen             2309204 -> 2309204 (0)
zone-canteen-court       3319994 -> 3367322 (+47328)
```

That is `art-station`'s published table **to the triangle, in all 21 rows** —
the same twelve at +47,328, the same two at +44,080, the same two at +39,760
and the same five zeros, off the same absolute before-values. **Declared.
Matched.**

### 3.2 medieval — `art-medieval` (`830f598`)

Declared: *"shader programs 352 → 352, materials 41 → 41, world triangles
identical to the triangle. Zero by construction"* — the authored geometry
belongs to beasts, beasts are NPCs, and `worldTriangles()` does not walk them.

Re-measured: world triangles identical in all seven framings (2,286,650 /
2,162,308 / 2,469,140 / 2,319,604 / 2,291,376 / 1,840,998 / 2,639,514, both
trees), materials 41, renderables 654–655, instanced meshes 221–222, lights
156 — every one of them zero. **Declared. Matched.**

### 3.3 citadel — `art-citadel` (`dd97f35`)

Declared: +80,460 / +80,428 / +80,428 / +88,468 / +88,468 / +88,468 / +88,468
on the eight mesa framings, +2,504 on three ring framings, 0 on three, with
materials, renderables, instanced meshes and world lights identical in all
thirteen.

Re-measured:

```
gate-approach        351259 -> 431719 (+80460)
gate-spawn           342159 -> 422587 (+80428)
souk-alley           264753 -> 345181 (+80428)
souk-roofs           345172 -> 433640 (+88468)
ward-centre          307492 -> 395960 (+88468)
minaret-bridge       313248 -> 401716 (+88468)
tower-top            308631 -> 397099 (+88468)
desert-overview      237743 -> 240247  (+2504)
caravanserai-mast     23968 ->  23968      (0)
undercliff-terrace   108848 -> 108848      (0)
deepworks-rim        268591 -> 271095  (+2504)
ashfall-ward          57368 ->  57368      (0)
eyrie-summit         272843 -> 275347  (+2504)
```

Thirteen rows, thirteen matches, absolute values included. **Declared. Matched.**

### 3.4 sports — `art-sports` (`76e36d5`)

Declared: **+23,772** in six of seven framings and **+23,088** at `ski-slope`,
the 684 difference being *"exactly the 19-figure `carry` mesh outside the
frustum, 19 × 36"*.

Re-measured: +23,772 at `skatepark-wide`, `skatepark-bowl`, `bowl-interior`,
`courts` and `pool`; **+23,088** at `ski-slope` **and** at `track`; +4,860 at
`entrance-portal`. The two rows that differ from the branch's table are the two
framings that branch had itself recorded as broken — `entrance-portal`
photographed the *station* in its run, and `track` photographed the car park
from off the terrain edge. On this sweep both landed inside sports, on both
trees, and both moved by exactly the declared shape (23,772 less the carry
mesh, or a partial crowd in frustum). Materials 112, renderables 334, instanced
74, lights 4 — zero in all eight. **Declared. Matched.**

### 3.5 dock — `art-dock` (`e067a5b`)

Declared: **−250 triangles in 21 of 24 framings**, −1,066 in the three `-in`
framings, materials 86, renderables 166, instanced 17, lights 186 unmoved,
programs 490 → 490.

Re-measured: −250 in exactly 21 framings, **−1,066 in exactly `kestrel-in`,
`dray-in` and `pike-in`**, 86 / 166 / 17 / 186 flat in all 24, programs at end
of run 490 → 488. The one world where the phase made the budget **smaller**,
and it still does. **Declared. Matched.**

### 3.6 space — `art-space` (`b47ca48`)

The one branch that declared an overrun rather than a zero: *"+1 renderable, +1
instanced mesh, +2 draw calls, +18,480 triangles"*, with four costed
alternatives, and **materials 43 → 41** — three byte-identical belt materials
merged into one.

Re-measured: **+18,480 triangles in every one of the fifteen framings,
exactly**; materials −2; renderables +1; instanced meshes +1; instances and
lights unmoved; geometries 332 → 333; draw calls +2 in twelve and 0 in three.
Every number that branch declared, and no number it did not. **Declared.
Matched.**

### 3.7 cinder / the planets — `art-planets` (`a57c4fe`)

Declared: *"World triangles: 0 in all six framings. The substitution is exactly
free."*

Re-measured: **0 in all six**; materials 18, renderables 34, instanced meshes
15, lights 1, geometries 328 — all zero. Draw calls −48 … 0, which is the
excursion band `art-planets` §6.2 measured **on this exact world on identical
code** (*"−2..+48 across runs"*) and warned was not a noise floor even when
three runs agreed. **Declared. Matched.**

### 3.8 race — `art-race` (`0cc1e24`)

Declared: materials **29 → 28** (one *fewer*), triangles **+648 … +2,088**,
draw calls unchanged, renderables 453, instanced 129, instances 5,506, lights
0, programs 441 at the end of both runs.

Re-measured, and this is the strongest single result in the sweep: the twelve
subject framings reproduce the `before-report.json` and `after-report.json`
`art-race` committed **byte for byte** on draw calls, world triangles,
materials, renderables, instanced meshes, instances and world lights.

```
marshal-post-profile        810504 -> 811944 (+1440)
marshal-post-three-quarter  684036 -> 684828  (+792)
marshal-post-front          709112 -> 710552 (+1440)
grandstand-profile          724268 -> 725060  (+792)
grandstand-three-quarter    661430 -> 662222  (+792)
grandstand-front            647842 -> 649282 (+1440)
tyre-stack-profile          871992 -> 873432 (+1440)
tyre-stack-three-quarter    729886 -> 731326 (+1440)
tyre-stack-front            648546 -> 649986 (+1440)
chicane-profile             363818 -> 364466  (+648)
chicane-three-quarter       488644 -> 489292  (+648)
chicane-front               891288 -> 893376 (+2088)
```

The baseline column is also `art-race`'s own before-column, which means nothing
between `06b79f6` and that branch's merge base touched this world at all.
Programs at end of run: **441 → 441**. **Declared. Matched.**

---

## 4. maze — the one world that needed a second sweep to be comparable at all

`MazeWorld.build()` re-seeds from `Math.random()` on every activation, so two
runs of one commit photograph two different worlds. `art-maze` §0 measured what
that costs: **90%** swing on `shaft-up`'s triangle count and **63%** on
`tower-top`'s, across seven runs of unchanged code, plus materials 14–18,
renderables 46–92, instanced meshes 32–78 and world lights 675–950 — every axis
this re-verification is about, moving by more than any art pass could.

`--seed` exists to close that, and **it does not bind** (§7.1). The first sweep
therefore photographed seed `4124197018` on the baseline and `3030693222` on
`main` and is not evidence about anything:

```
                    (NOT COMPARABLE - different seeds)
forecourt        1179510 -> 1113316   materials 15 -> 15   meshes 56 -> 55
lift-car         1072654 -> 1633494   materials 15 -> 17   meshes 98 -> 81
```

The second sweep re-entered the maze through another world so the pin took, and
both trees then built **seed 20250823**:

| framing | draws | world triangles | materials | renderables | instanced | instances | lights | geometries |
|---|---|---|---|---|---|---|---|---|
| `forecourt` | −2 | 1,198,234 → 1,130,566 (**−67,668**) | **0** | **0** | **0** | **0** | **0** | −54 |
| `shaft-up` | 0 | 809,286 → 806,288 (**−2,998**) | **0** | **0** | **0** | **0** | **0** | −55 |
| `lift-car` | +1 | 1,312,746 → 1,301,142 (**−11,604**) | **0** | **0** | **0** | **0** | **0** | −64 |
| `tower-top` | 0 | 1,159,378 → 1,137,360 (**−22,018**) | **0** | **0** | **0** | **0** | **0** | −47 |

Absolutes, identical on both trees: materials 18 (19 at `tower-top`),
renderables 62 / 62 / 90 / 75, instanced meshes 47 / 47 / 76 / 60, world lights
525 / 525 / 850 / 675.

`art-maze` declared: materials, renderables, instanced meshes, world lights and
shader programs *"inside the noise floor"*; `geometries` **down**; and world
triangles **down**, with the true delta computed off the pure modules at
**−74,985** (−82,000 … −69,822 across eight seeds) — the hedge sprigs' −151,292
and the ivy's −8,952 against the candles' declared **+85,260**.

Re-measured at one bound seed with one instrument, the five census axes are
**identical to the object**, geometries are down, and triangles are down in all
four usable framings. **Declared. Matched** — and this is the first maze
before/after in the repository taken on the same maze.

Two of the six framings are excluded, on both trees, for the same two reasons:

- `corridor` photographed the **station**. The re-entry bounce leaves the
  maze's return gateway pointing at the world it came from, and `view()`'s
  player pin is a plane-side crossing, so `Portals._autoEnter` fires. The
  harness caught it and said so — *"photographed world "station", not "maze""*,
  *"the player is 1309.1 m from the camera"* — which is the repaired instrument
  doing exactly the job the old one could not.
- `above-entrance` then failed outright, because the run was standing in the
  station when it was asked for a maze framing.

Both happen identically on both trees, and both are artefacts of the workaround
in §7.1 rather than of either tree.

### 4.1 One trap deliberately not reported as a finding

`HARNESS.worldTriangles()` now counts a `BatchedMesh` **per visible instance**
rather than once at its reserved buffer size. The maze is the world built on
that class, so its absolute triangle numbers here are far larger than the ones
`art-maze` published (1.1–1.3 M against 0.7–0.8 M) and they are **not**
comparable to that document. That is a fixed instrument, not a regression, and
it applies identically to both columns above.

---

## 5. The noise floor, taken the only way it can be

A cross-tree delta means nothing until you know what the *same* tree does to
itself. Both trees were swept a second time, on the same machine, with the same
instrument. Below: the same-tree band on each side, next to the phase's delta.

### 5.1 The five census axes do not move at all

| world | materials | renderables | instanced | instances | world lights | world triangles |
|---|---|---|---|---|---|---|
| station | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| medieval | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| citadel | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| sports | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| dock | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| space | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| cinder | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |

(base run 1 → base run 2 / main run 1 → main run 2. Every framing of every
world. The maze is excluded: its seed, not its code, is what moves — see §4.)

**Zero. Not "inside a band" — identical, framing by framing, on both trees.**
That is what makes §2 and §3 evidence: on these six axes there is no noise for a
regression to hide in, so every delta reported there is signal, and every one of
them was declared.

It is also worth saying plainly what this does to the three branches that wrote
around a "noise floor" on these axes. `art-maze` recorded materials swinging
14–18 and renderables 46–92 on unchanged code; `art-citadel` recorded a
draw-call spread of ±50 and a program spread of 61. None of that was the
renderer. On the repaired instrument these axes are exact.

### 5.2 Draw calls: the band is bigger than the phase, everywhere

| world | base → base | main → main | **base → main (the phase)** |
|---|---|---|---|
| station | −1,146 … +348 | −1,423 … +353 | −1,448 … +1,118 |
| medieval | −48 … +8 | −12 … +4 | −38 … +17 |
| citadel | −160 … +52 | −86 … +50 | −120 … +18 |
| sports | −58 … +8 | −4 … +30 | −52 … +20 |
| dock | −16 … +18 | −12 … +36 | −16 … +16 |
| space | −15 … +4 | −2 … 0 | −15 … +8 |
| cinder | −48 … 0 | 0 … +4 | −48 … 0 |
| race | — | — | −6 … 0 |

Every world's cross-tree range sits inside, or level with, its own same-tree
range. `cinder`'s −48 is the excursion `art-planets` §6.2 chased and reproduced
on identical code, and it appears here on the *baseline* tree against itself.
Draw calls in this game are a measurement of where the streamed cast happened to
be standing.

### 5.3 Shader programs: the end of a run is the wrong number, and a third run proves it

`art-race` established the rule this sweep started with: *"`programs` climbs
monotonically through a run — 241 at the first framing to 441 at the twelfth, on
identical code, in both baselines … The end value agreed exactly (441 both
times), and that is the only program figure below."* Two runs of one world
agreeing made the end-of-run value look comparable.

It is not. Two runs of the station on each tree said this:

| | run 1 | run 2 |
|---|---|---|
| baseline | 512 | 536 |
| main | 580 | 580 |

which reads as a reproducible **+44 … +68** — the only axis anywhere in this
sweep that appeared to move the wrong way outside its own spread. A **third**
run on each tree was taken to name the extra programs by cache key. It did not
need to:

| | run 1 | run 2 | run 3 |
|---|---|---|---|
| baseline | 512 | 536 | **536** |
| main | 580 | 580 | **535** |

The ranges overlap. There is no +68. Two samples a side was luck, and the rule
that produced it — "the end of a run is stable" — is wrong: the end of a run
measures how far the walk got into material configurations the boot warm never
linked, and that depends on where the streamed cast happened to be standing.
The cache-key diff between the two 535/536 runs confirms it: **10 programs in
one and not the other, 11 the other way**, all of them `basic` and `sprite`
variants of the same additive systems, in both directions.

### 5.3.1 The figure that IS comparable: the cache at the settled boot

`settleBoot` already records it. `warm.programs` is the size of the program
cache at the moment the boot warm stopped growing and before any framing moves
the camera — the same instant on every run, by construction. It is nearly
deterministic:

| world | baseline | main | phase delta |
|---|---|---|---|
| cinder (planets) | 225, 225 | 225, 225 | **0** |
| sports | 449, 449 | 449, 450 | **0 … +1** |
| station | 357, 357, 357 | 358, 358, 358 | **+1** |
| maze | 232, 233 | 231, 231 | **−1 … −2** |
| medieval | 352, 351 | 350, 350 | **−1 … −2** |
| citadel | 239, 239 | 237, 237 | **−2** |
| race | 243 | 241 | **−2** |
| space | 245, 245 | 243, 243 | **−2** |
| dock | 275, 275 | 272, 272 | **−3** |

Nine worlds, reproducible to within one program, and the whole phase moved the
shader-program budget by **−3 to +1**. Six worlds went down; two are flat; the
station is one program up.

Every branch that claimed "shader programs unchanged" was right, and the
hundreds-wide swings three of them argued around — `art-citadel`'s spread of 61,
`art-space`'s +39, `art-sports`' ±22, `art-planets`' +37, `art-dock`'s 275 → 349
at `trench` — were all the ramp, and all of them are gone the moment the figure
is read at the settled boot instead of at the end of a walk.

**This is the one methodological change this branch would recommend**: budget
tables should quote `stats().warm.programs`, not `renderer.info.programs.length`
at the last framing. The value is already recorded in every report Phase 9's
harness has written since the `ready()` fix.

### 5.4 The relic halos: the one system no budget table has ever contained

`Relics` parents `relics:glow` to the **scene**, so `worldTriangles()` and the
material census — both world-group walks — have never counted it, in any of the
ten Phase 9 tables or in §2 above. `86425d3` widened `--ablate` to the scene, so
for the first time there is an instrument that can see it: `ablationCheck()`
reports what the hidden meshes *would be drawing in this frame*.

`--world medieval --ablate relic.glow`, three framings, both trees:

| framing | baseline | main |
|---|---|---|
| `hills-vista` | 1 mesh held hidden, **220 triangles removed** | 1 mesh, **220** |
| `castle-gate` | 1 mesh, **220** | 1 mesh, **220** |
| `village-square` | 1 mesh, **220** | 1 mesh, **220** |

Identical. The whole relic-halo system draws **220 triangles** — 0.008% of the
vale's 2.6 M — and the phase did not change it. `orb-hunt` and `fd91ac0` moved
its fog and its radiance, which is colour, not geometry, and this confirms they
cost nothing.

It is worth saying what this is not: 220 triangles is not what those halos
*cost*. They are 4.42 m additive quads with `depthWrite: false` and they are a
fill-rate system, which is why `orb-hunt` and the radiance cap argued about
luminance and not about counts. This measurement closes the *budget* question
for them and nothing else.

---

## 6. The verdict

**No. No regression hid in the noise.**

Nine worlds, 112 framings on each tree, every one taken on a settled frame with
the boot warm finished and no force-draw in effect. Across the six axes Phase 9
was merged on:

| axis | worlds where it moved | every move declared? |
|---|---|---|
| materials | space (−2), race (−1) | **yes** — both declared, both *reductions* |
| renderables | space (+1) | **yes** — declared, with four costed alternatives |
| instanced meshes | space (+1) | **yes** — same declaration |
| instances | none | — |
| world lights | none | — |
| world triangles | station, citadel, sports, space, race (up); dock, maze (down); medieval, cinder unmoved | **yes** — every one matches its branch's published table, framing for framing |
| shader programs (settled boot) | −3 … +1 across all nine | **yes** — every "unchanged" claim holds |

**There is no undeclared overrun anywhere in the sweep.** Not one axis, in one
world, in one framing.

And the claim is stronger than "inside the noise", because on five of those six
axes there *is* no noise: two runs of one tree produce byte-identical materials,
renderables, instanced meshes, instances, world lights and world triangles in
every world and every framing (§5.1). A regression on those axes could not have
hidden; it would have shown as a number.

The two axes that are genuinely noisy — draw calls and the end-of-run program
count — are noisy on *both* trees by more than the phase moved them (§5.2,
§5.3), and neither is a property of a world's budget. The settled-boot program
count, which is a property of it, moved by at most three programs in either
direction.

### 6.1 What did move, and none of it is a surprise

- **+47,328 triangles on the station** (the authored crowd) — declared and
  costed by `art-station` at 204 figures × 232 triangles.
- **+80,428 … +88,468 triangles on the citadel mesa** — declared by
  `art-citadel`, thirteen framings, thirteen matches.
- **+23,772 triangles on sports** — declared by `art-sports`, with the
  `ski-slope` −684 derived from the carry mesh leaving the frustum.
- **+18,480 triangles, +1 renderable, +1 instanced mesh, −2 materials on
  space** — the one branch that declared an overrun instead of a zero, with
  four costed alternatives.
- **+648 … +2,088 triangles and −1 material on race** — declared; the numbers
  reproduce its committed reports byte for byte.
- **−250 triangles on the dock**, **−67,668 … −2,998 on the maze** — two worlds
  where the phase made the budget *smaller*, both declared.
- **0 on medieval and on Cinder** — declared as zero, and zero it is.

### 6.2 Two things nobody claimed, both in the game's favour

- **Shader programs went DOWN in six of nine worlds** at the settled boot —
  dock −3, citadel/race/space −2, medieval and maze −1 to −2 — and are flat or
  +1 in the other three. `orb-hunt` said in prose that joining the relic halo's
  cache key to loot's meant *"the two systems cannot split the program cache"*
  and never put a number on it. These are the numbers.
- **The relic halo system costs 220 triangles**, measured for the first time
  (§5.4), and the phase did not move it.

---

## 7. Instrument defects found while doing this, handed back rather than fixed

`scripts/world-shot.mjs`, `src/dev/**` and `src/gfx/**` are outside this
branch's boundary. Two defects were hit; both were worked around inside
throwaway measurement worktrees, and neither is fixed here.

### 7.1 `world-shot --seed` is inert exactly where it is used

`--seed` exists so two runs photograph the same maze. It does not bind.

```
maze seed pinned to 20250823
maze seed in use: 4124197018        <- baseline tree
maze seed in use: 3030693222        <- main tree
```

The sequence is: `world-shot` puts `?world=maze` on the page URL, so `boot()`
**builds the maze** and `HARNESS.ready()` returns after that; only then does the
script write `MazeWorld.seedOverride`; and the `goto` that would rebuild is
skipped because `bootWorld === args.world`. The comment above the pin —
*"BEFORE the goto, because a volatile world re-seeds inside `build()` and `goto`
is what triggers it"* — is right about the mechanism and wrong about the order,
because for the world being measured there is no goto.

`WorldManager.build` will not rescue it either: it only disposes and
re-generates a volatile world `if (world._built && volatile && this._active !==
world)`, so a same-world `goto` cannot rebuild it. The workaround used here is
a bounce — `goto('station')` then `goto('maze')` — which does re-enter while the
maze is not active and does bind the seed.

**Cost of leaving it:** every maze measurement anyone takes with `--seed`
believes it is comparing two runs of one world and is comparing two different
worlds, over a noise floor `art-maze` measured at **90%** on `shaft-up`'s
triangle count. This is the same class of defect as the one this branch exists
to check: an instrument that reports the number it was asked for rather than the
number it measured.

**Suggested fix** (one branch, `scripts/world-shot.mjs`): when a seed is pinned
and the boot world is already the world asked for, re-enter it via another
world before framing. Better still, hand the seed to the page in the URL so the
boot itself uses it and no rebuild is needed.

### 7.2 `VIEWS.maze`'s `tower-top` aborts a run like `lift-car` does

`main`'s first maze run lost its last framing to
`harness: could not compute view "tower-top"` — `_computeView` found no tower on
that seed. `art-maze` §0 recorded the same shape for `lift-car` (**16 of 40
seeds** have no resident lift) and worked around it by naming the other five
framings on the command line. `tower-top` has it too, and nothing says so; a
`maze` sweep run with default views fails on some seeds and not others. The
report is still written — that repair landed — but the run exits non-zero and
the framing is lost.

### 7.3 `race` still has no `VIEWS` entry

`art-race` §7 composed and measured six `VIEWS.race` framings and did not commit
them, because `src/dev/Harness.js` was outside its boundary. The result is that
`world-shot --world race` takes **zero** framings today, and the only way to
re-fly that branch's evidence is to lift four coordinates out of the
`subjectAt` fields of the reports it committed — which is what this branch did.
The six proposed framings are still in that document and still uncommitted.

### 7.4 `--ablate` can now reach a scene-parented mesh and then calls it detached

`86425d3` widened `Harness.ablate`'s search from `worldManager.active.group` to
the scene, so `relic.glow` is findable for the first time. `ablationCheck()`'s
liveness test did not move with it:

```js
for (const o of a.meshes) {
  let n = o;
  while (n && n !== world?.group) n = n.parent;   // <- world group, not scene
  if (!n) detached++;
}
```

`relics:glow` is parented to the scene, so `world.group` is never on its
ancestor chain and it reads as detached on **every** framing. The measurement
itself is right — 220 triangles removed in 3 of 3 framings, on both trees — but
the run then fails with:

```
hills-vista: 1 ablated mesh(es) are no longer under the active world group
             - the world was rebuilt and this ablation is of the old one
```

which is false: nothing was rebuilt. That message is the same shape as the bug
its own comment block records ("*this walked to the top of the hierarchy … and
every mesh read as detached … a check that measures the wrong thing does not
produce a bad answer, it produces a confident wrong one*"). The fix is the same
size: the walk should terminate at the SCENE when the ablation was found there,
or the check should record which root each mesh was found under and walk to that
one.

**Cost of leaving it:** every scene-parented ablation — loot, relics, portals,
the avatar, the viewmodel, which is the whole set the widening was for — exits
non-zero and tells the operator the world was rebuilt. The next agent to ablate
one of those will chase a rebuild that did not happen.

---

## 8. What this sweep could not measure

### 8.1 Scene-parented systems are outside every triangle and material count

`HARNESS.worldTriangles()` and `world-shot`'s material census both walk
`worldManager.active.group`. `Relics` parents `relics:glow` to the **scene**;
so do loot, portals, the avatar and the viewmodel. `86425d3` widened
`--ablate` to the scene but left those two counters where they were, so
**nothing in §2 or §3 — on either tree — includes a relic halo, a loot pickup,
a portal disc or the player's own body.** That was equally true of all ten
original tables, so the comparison is fair; it is not complete.

§5.4 measures the relic halos' drawn triangles directly, through the one
instrument that can now see them, and finds no change across the phase. The
other scene-parented systems are not measured here.

### 8.2 Nine of the ten planets

`PlanetWorld` generates a class per planet from a descriptor and only `cinder`
has a `VIEWS` entry, so `cinder` is the only planet either `art-planets` or this
sweep photographed. `art-planets`' change — `_propMaterial` from `stone.castle`
to `rock.neutral` — applies to **15,700 props across all ten**, and it is a
material swap inside an existing `InstancedMesh`, which is exactly the shape
that costs nothing anywhere if it costs nothing on Cinder. That is an inference,
not a measurement, and it is the same inference `art-planets` made.

### 8.3 Frame time

Every figure here is a count. `fps` and `frameMsMedian` are in the reports and
are deliberately not compared: the two sweeps ran concurrently on one GPU so
that their *counts* would be taken under symmetric load, which is the opposite
of what a timing comparison needs.

### 8.4 The maze beyond four framings and one seed

See §4. Two of the maze's six framings are lost on both trees to the same two
causes, and the seed used is one seed.
