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
| into `station` (26,345 colliders) | 1,228 – 1,371 ms | **85.5 – 95.8 ms** |
| into `medieval`, repeated | 317 – 362 ms | **93.9 – 100.8 ms** |

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

## What is left, and it is not JavaScript

After both fixes the crossing into the station is 85–96 ms of JavaScript and the
frame gap around it is 233–317 ms. The difference is not the crossing: the gap
carries **+1 program and +25 textures**, and the listener table — which now
records the upload triple per listener — shows that **no `world:changed`
listener creates any of them**. They are the arriving world's first render.

That is a different problem in a different file, and it is the one standing
between this criterion and a comfortable margin rather than a marginal one.

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
