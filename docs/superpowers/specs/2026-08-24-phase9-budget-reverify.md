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

| world | framings | materials | renderables | instanced | instances | world lights | world triangles | draw calls | programs (end of run) |
|---|---|---|---|---|---|---|---|---|---|
| station | 21 | **0** | **0** | **0** | **0** | **0** | 0 … +47,328 | −1,448 … +1,118 | 512 → 580 (+68) |
| medieval | 7 | **0** | **0** | **0** | **0** | **0** | **0** | −38 … +17 | 427 → 350 (−77) |
| citadel | 13 | **0** | **0** | **0** | **0** | **0** | 0 … +88,468 | −120 … +18 | 391 → 375 (−16) |
| sports | 8 | **0** | **0** | **0** | **0** | **0** | +4,860 … +23,772 | −52 … +20 | 540 → 541 (+1) |
| dock | 24 | **0** | **0** | **0** | **0** | **0** | −1,066 … −250 | −16 … +16 | 490 → 488 (−2) |
| space | 15 | **−2** | **+1** | **+1** | **0** | **0** | **+18,480** | −15 … +8 | 423 → 420 (−3) |
| cinder (planets) | 6 | **0** | **0** | **0** | **0** | **0** | **0** | −48 … 0 | 342 → 352 (+10) |
| race | 12 | **−1** | **0** | **0** | **0** | **0** | +648 … +2,088 | −6 … 0 | 441 → 441 (0) |
| maze | see §4 | — | — | — | — | — | — | — | — |

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
