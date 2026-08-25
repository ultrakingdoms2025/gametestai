# The two subsystems in a crossing, removed

*crossing-subsystems, 24 Aug 2026. Every number here is from the PRODUCTION
bundle — `node scripts/frame-gaps.mjs --serve prod --events repeat --listeners`,
the hashed assets the site serves. It continues
[the crossing cost ledger](2026-08-24-crossing-cost-ledger.md), which measured
where a crossing goes and refused the change it was assigned.*

## What was handed over, and what it cost

The predecessor's ledger left one criterion failing — *"in production, no frame
gap over 250 ms on … repeated entry/exit"* — and two subsystems holding all of
it. Its own ablation said the criterion was reachable: stub both out and the
same crossing, with all 26,345 colliders still re-registered and all 12,256
physics probes still running, is 62 ms.

| | before | after |
| --- | ---: | ---: |
| `caches._onWorld` | **1,011.4 ms** | **49.5 ms** |
| ├ `Physics.raycast` ×12,256 | 54.6 | 37.8 |
| ├ `Caches._hasVisibleFloor` ×11 | **952.2** | **3.4** |
| └ the index those 11 probes now read | — | 5.3 |
| `npcManager.spawnForWorld` | **463.5 ms** | **30.0 ms** |
| └ inside the geometry `make()` closures | **416.3** | **0.0** |

and the crossing itself:

| crossing | before | after |
| --- | ---: | ---: |
| into `station` (26,345 colliders) | 1,228 – 1,371 ms | **79.6 – 97.9 ms** |
| into `medieval`, repeated | 317 – 362 ms | **93.7 – 104.7 ms** |
| worst frame gap on a repeat | 1,383 – 1,483 ms | **216.6 – 250.1 ms** |

The criterion is 250 ms and the answer is "on the line, not past it" — the
distribution and the reason are at the end.

Both numbers were taken the way the ledger insists on: exact counters beside the
clock (`Physics.gridWrites` is 234,341 into the station in every run, before and
after), the share reported as well as the number, and no `--profile` anywhere
near the production bundle.

## 1. The visible-floor probe: 952 ms, and three wrong diagnoses

`Caches._hasVisibleFloor` asks one question — *is there something the player can
SEE to stand on where physics says the floor is* — and it asked it by handing
the whole world group to `THREE.Raycaster.intersectObject`. Eleven calls, 86 ms
each.

### Why an eight-metre probe walks a district

`THREE.Mesh.raycast` rejects on the world-space bounding sphere, transforms the
ray into local space, and then rejects on the geometry's bounding box — with
`Ray.intersectsBox`, which tests the **infinite ray**. `far` is applied
afterwards, per intersection. So a probe eight metres tall is matched against
every mesh the downward line passes at any height whatsoever.

The fix is therefore not a cleverer raycast; it is to stop handing the raycaster
things whose box does not overlap the eight-metre segment. `_indexVisible`
buckets each raycastable leaf's world-space box by XZ cell once per crossing,
and the probe queries that.

**This cannot change an answer, by construction.** An intersection lies inside
the world box of the thing it intersected, and every hit the function can accept
lies on that segment. The world box of a rotated local box is *larger* than the
rotated box, so the filter errs toward keeping candidates. A 5,000-point
equivalence grid in `world-crossing.test.mjs` runs both branches and requires
they never disagree.

### The three diagnoses, in order, and only the third was right

| attempt | probe candidates | triangles per probe | `_hasVisibleFloor` |
| --- | ---: | ---: | ---: |
| whole tree | (everything) | 3,476,358 | 952.2 ms |
| cells, wide leaves in `always` | 115 | 2,287,006 | 835.3 ms |
| + per-instance filing | 18 | 2,006,152 | 736.7 ms |
| + collapsed instances skipped | **7** | **28,576** | **3.4 ms** |

The first attempt moved nothing and the diagnostic said why: a merged district
plate spans more cells than it is worth filing, and the version that dumped
those into an "ask always" list had put the entire ambient crowd there —
`StationActors:head` alone is 490,620 triangles, and ten instanced body parts
scattered over a 1,488 m station each wear one bounding box the size of the map.

The second attempt filed the *instances* rather than the object, and moved
almost nothing either. `visAlways` still held the crowd.

**`StationActors._hideActor` collapses a distance-culled figure with an all-zero
matrix** — deliberately, because a degenerate triangle is rejected at setup where
an off-screen one is still transformed and clipped. Its bottom-right element is
zero as well, so `Vector3.applyMatrix4` divides by *w* = 0 and any bound taken
through it comes back infinite. 20,757 of the station's 54,837 instances are
collapsed at the moment the index is built. One look at one of them was reading
"cannot be bounded" as "must be asked every time", and that was the whole 830 ms.

Skipping a collapsed instance is exactly what three does with it:
`InstancedMesh.raycast` runs the same `Sphere.applyMatrix4` per instance and
rejects on `intersectsSphere`, which is false for any non-finite sphere. It could
never have contributed a hit.

**Both wrong attempts passed the equivalence grid.** The answers were right and
the work was not saved. The case that catches them is about the CANDIDATE LIST —
`always` must be empty, a probe over open sky must be handed nothing — and it is
the only property in that file a timing would have caught and no assertion about
placement could.

### Why there is no version of this that goes stale

The index is built at the top of one `_onWorld` call and dropped in that call's
`finally`. It never survives a crossing.

That is not caution for its own sake. The ledger's third route was to keep the
resolved SITES across a crossing, which removes the 952 ms *and* the 12,256
physics probes, and its warning was load-bearing: *a stale site is a silent
cache in the sky — its gate must assert REACHABILITY, not placement*. The
`[Caches]` log line only prints when something LANDED, so a site placed against
a floor that is no longer there says nothing at all.

`world-crossing.test.mjs` now asserts reachability and injects both directions:

- **taking away** — the deck is demolished between crossings, its collider left
  behind. A cache must not come back on it.
- **putting back** — a deck is built between crossings and nominated. A cache
  must be able to land on it.

Keeping the index across a crossing — the cheap version of this fix — fails
exactly those two cases and nothing else.

## 2. Character geometry: 416 ms rebuilding bodies the player just saw

`CharacterAssets.geoCache` is holder-counted and disposes on the last release, so
leaving a world frees the whole cast and re-entering lofts, welds, skins and
merges every body again: 48 geometries at ~8.7 ms each.

### The cast was re-rolled by walking through a door

Before any cache could help, a prior question: **would a retained cache ever
hit?** The harness now answers it directly — snapshot the live key set, rebuild
the cast, count the overlap. It was **27 of 52**.

`_createNPC` seeds each character from `hash(worldId) ^ counter`, and the counter
was never reset. The fourth civilian of a world got a different seed on every
visit, so the population was re-rolled by walking through a door — and the cache
is keyed on the appearance combination, so half the keys a re-entry asked for
were keys nobody had built.

Resetting the counter at the top of `spawnForWorld` is the same argument `Caches`
already makes about its own placement ("a player can learn where the moat cache
is and go back for it"). The town crier who is a different person each time you
come back is the version of that argument nobody had written down. After it:
**51 of 51**, and 0 geometries built from scratch.

### The bound is the design

The last release now parks the entry in a free list; an acquire revives it.
`geoCache` still means "entries with a live holder", so every case that pins *a
buffer a live mesh draws is never freed* reads exactly as it did.

The bound is in **bytes**, because a merged body and an eye sclera are both one
entry and differ by three orders of magnitude — 61 live entries measured 50.2 MB.
It is **one cast wide (64 MB)**, because the whole point is that leaving a world
and coming back finds that world's cast still there.

The honest cost is memory: the game now holds one departed cast it used to free.
That is the bargain `WorldManager` already strikes for world geometry — every
world visited stays built and resident, because rebuilding it is worse — applied
to the characters standing in them.

### The trim cannot run where it looks like it should

`releaseGeometry` is the obvious place to evict and it is the wrong one. A
crossing releases the world it is LEAVING before it acquires the world it is
arriving in, so at that instant the list holds both and nothing has yet said
which is wanted. Evicting oldest-first there throws away precisely the cast that
is about to be asked for — a cache with a perfect hit rate that measures zero.

`NPCManager.spawnForWorld` therefore trims at its END. A looser ceiling (two
casts) applies between them so in-play churn cannot run away.

Five cases in `character-geometry-cache.test.mjs` assert the bound rather than
trusting the constant, and each was confirmed by injection: an unbounded free
list and a trim that walks the live cache each fail four of them.

## 3. The lettered boards, which were a texture and a linked program

With both subsystems dealt with, the crossing was 85–98 ms of JavaScript inside
a 233–267 ms frame gap. Every one of those gaps carried **+1 linked program and
+15 to +32 textures**, the listener table — which now records the upload triple
per listener — charged none of them to any `world:changed` handler, and the
autopsy charged them to one place: `npcManager.spawnForWorld:uploads` read
`tex -24 prog -1`.

`NPC._attachSign` letters a 512×160 canvas per vendor and throws it away with
the character. A crossing therefore disposes every sign in the world it leaves
and letters every sign in the world it arrives in — and the program is the
sharper half, because a sign sprite is the only `SpriteMaterial` in the frame,
so disposing the last one releases its program and the next cast re-links it.

A sign is its TEXT and the text is authored, so `CharacterAssets.signMaterial`
keeps it and every merchant under those words wears it. This is a memo and not
the parked cache the geometry uses: the key set is closed and small, so there is
nothing here for a holder count to protect — which makes the CAP the only thing
standing in for one. Past it a board is private to its character exactly as
every sign was before, so the cap fails toward the old cost rather than toward a
leak.

**It removed the program link and it did not move the frame gap.** `dProg` on a
crossing went 1 → 0 and the gap stayed at 217–250 ms. It is kept for the axis
this phase has spent three branches on, not for the criterion, and it is
reported here as a change that did not do what it was aimed at.

## What is left is not the crossing at all

`--gl` charges every blocking WebGL call in a gap to its driver entry point. In
a 233 ms crossing gap the largest is `bindVertexArray` — **1 ms across 2,055
calls**. The residual is not uploads and not the driver.

So the ablation was re-run with a phase marked around it, which the predecessor's
version did not do: stub both subsystems out entirely and record the GAP, not
only `activationCost.total`.

```
the same crossing into "station" with the two stubbed out: total 64.4 ms
ablated              166.7     0      0      9   -18  pass
```

**166.7 ms in both runs.** A crossing with no visible-floor probe and no cast at
all still costs 167 ms of frame, of which 64 ms is the crossing. The other ~100
ms — ~135 ms with a real cast in it — is the frame that receives a world:
`updateMatrixWorld`, culling, the shadow pass and sixty characters' first update,
in the engine's own loop.

That is the floor this criterion is measured against, and it is in a different
file from anything this branch touched.

## The verdict, stated exactly

Fifteen true repeat phases across five production runs, after everything above:

```
216.6  216.7  216.7  233.2  233.2  233.3  233.3  233.4  233.5  250.0   pass
250.1  250.1  250.1  733.4  750.0                                      fail
```

Ten of fifteen pass. Three of the five failures are **250.1 ms against a 250 ms
budget** — a tenth of a millisecond, and the gaps are quantised to the 16.7 ms
vsync interval, so the whole distribution is one frame wide. The two long tails
both carried `dProg 1`: a crossing that links a program is half a second worse
than one that does not, which is the finding this phase already knew.

Against the 1,204–2,578 ms this started at, the crossing is gone. Against the
criterion, it is on the line and not past it — and the ablation says no further
work on THESE two subsystems can move it, because 167 ms of the remaining 217 is
there when neither of them runs at all.

## The budget, re-measured

`world-shot` on both criterion worlds, before and after, two framings each:

| axis | station | medieval |
| --- | --- | --- |
| materials | 225 → 225 | 41 → 41 |
| programs | 151 → 151, 188 → 188 | 146 → 146 |
| renderables / instancedMeshes / instances | unchanged | unchanged |
| worldLights / worldLightsLit | unchanged | unchanged |
| worldTriangles | 3,088,198 → 3,088,198 | unchanged |
| npcs / unculledMeshes | unchanged | unchanged |
| geometries | unchanged | 880 → 883 |
| textures | unchanged | 365 → 362 |

`stats().warm.programs` is **151 in all nine frame-gap runs**, before and after.

The `geometries` +3 is the parked cast, by design. The `textures` −3 is the
shared boards.

One axis needed a second look: `drawCalls` at `plaza-wide` read 2,409 before and
2,723 after, which is a 13% rise on a framing whose `worldTriangles` and
`byMaterial` breakdown are byte-identical. Re-running the BEFORE tree gave
**2,721**. The before number was a sample from a distribution — the cast was
re-rolled on every activation, so no station framing was reproducible — and the
after tree reads 2,723 and 2,721. Making the cast deterministic did not add draw
calls; it made the count repeatable.

## Reading it yourself

```
node scripts/frame-gaps.mjs --serve prod --events repeat                  # the gate
node scripts/frame-gaps.mjs --serve prod --events repeat --listeners      # + the fan-out, the autopsy, the ablation
```

With `--listeners` the autopsy now also reports `visProbeCandidates`,
`visProbeTriangles` and `visStats` (instances filed, instances collapsed), and
the geometry-cache hit rate a re-entry would get. Those are the numbers this
branch is written in; the wall clock on this machine moves 2.1× between runs of
the same bytes and is not one of them.
