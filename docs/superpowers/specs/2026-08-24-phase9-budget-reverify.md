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

