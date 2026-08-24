# World lights are born hidden — Phase 1, open item 4

Branch `world-light-visibility`. Closes the last of Phase 1's three open items
that is not "measure production".

> **OPEN, latent — 61 world lights created visible.** `Caves.js:859` and
> `MazeChunks.js:393` create theirs `visible = false` with tests enforcing it,
> and say why: the frame between creation and `LightRig`'s next walk is a frame
> in which they count, and one such frame is a full recompile. 61 sites across
> 12 world files do not. `claim()` on `world:changed` currently closes the
> window for build-time lights, so this is fragility rather than a live fault.
>
> — `docs/superpowers/specs/2026-08-21-implementation-brief-roadmap.md`, §4 Phase 1

**Headline: the roadmap's assessment was right, and this branch confirmed it by
measurement rather than repeating it. Nothing got measurably faster** — 272 warm
programs and 251 rig-keyed cache keys on both sides of the change, on the
production bundle. Sixty sites across eleven files are fixed, the fix is
structural rather than site-by-site, and the gate that holds it fails on one
reverted line. What was bought is that a hazard measured at up to **19x the
live point-light count on world arrival** no longer depends on `_activate`
staying synchronous, and that the next world file starts on the right side of
the rule.

---

## 1. The real count

**60 offending sites across 11 files**, not 61 across 12.

The roadmap's figure was taken before `art-space` shipped, which fixed
`SpaceWorld._buildRim` — one site in a twelfth file — and left a docblock
saying so. 61 − 1 = 60, 12 − 1 = 11. The roadmap was not stale; it was one
merge old.

Counted by stripping comments from every `.js` under `src/worlds/` and matching
`new THREE.<X>Light(`. The comment strip is not pedantry: `SpaceWorld.js:1132`
wrote `new THREE.DirectionalLight(...)` **in prose**, and a naive grep reports
65 constructions where there are 64.

| file | sites | previously hidden |
|---|---:|---:|
| `src/worlds/StationWorld.js` | 14 | 0 |
| `src/worlds/MedievalWorld.js` | 15 | 0 |
| `src/worlds/DockWorld.js` | 10 | 0 |
| `src/worlds/station/zones/Canteen.js` | 9 | 0 |
| `src/worlds/SportsWorld.js` | 4 | 0 |
| `src/worlds/station/OuterRing.js` | 2 | 0 |
| `src/worlds/station/zones/Construction.js` | 2 | 0 |
| `src/worlds/station/ControlTower.js` | 1 | 0 |
| `src/worlds/station/zones/Gym.js` | 1 | 0 |
| `src/worlds/station/zones/Habitation.js` | 1 | 0 |
| `src/worlds/PlanetWorld.js` | 1 | 0 |
| **subtotal — the item** | **60** | **0** |
| `src/worlds/maze/MazeChunks.js` | 2 | 2 |
| `src/worlds/citadel/Caves.js` | 1 | 1 |
| `src/worlds/SpaceWorld.js` | 1 | 1 |
| **total constructions under `src/worlds`** | **64** | **4** |

Those 64 constructions build far more than 64 lights — `Caves.js:858` is inside
a loop over every torch in every cave, `MazeChunks` inside a loop over every lit
candle in a streamed district. Built out, the nine worlds this branch measures
author **1,162** lights between them.

---

## 2. Why it is worth doing now, and what it is not

The mechanism is the one the sibling `perf-frame-gaps` branch root-caused this
week: Three pushes six light counts into `getProgramCacheKey` and its GLSL
preprocessor **unrolls** the lighting loops against them, so one frame drawn
with a different count shares no program with the frame before it and re-links
everything on screen. `getProgramInfoLog` — the driver link wait — was 96% of a
30-second stall.

**But the window really is shut for build-time lights, and this branch checked
rather than assumed.** `WorldManager._activate` is one synchronous block from
`await this.build(id)` onwards:

```
scene.add(world.group);
world.onActivate();          // group.visible = true  <- lights become live here
...
bus.emit('world:changed');   // main.js: lightRig.claim(world.group)
```

No `await` sits between those two lines, so no frame can render between them.
`warmWorld()` claims again before `compile()` for the same reason. And
`lightRig.update()` is the last thing in the frame updater, before the render.
Three guards, and the outermost is synchronous.

So this is **not** a frame-time fix. It is:

- the removal of a hazard whose only defence is a synchronous window nobody is
  obliged to preserve — `_activate` gaining one `await` in the wrong place
  turns 60 latent sites into a live 30-second stall, and nothing would have
  said so;
- the closing of a rule that a **new** world file starts on the wrong side of.
  Fourteen files author lights today. The fifteenth would have started visible.

---

## 3. The shape of the fix

`src/gfx/WorldLight.js` — three factories, `pointLight` / `spotLight` /
`dirLight`, with `THREE`'s own argument lists in `THREE`'s own order, each
returning the light with `visible = false` already set. `new THREE.PointLight(a,
b, c, d)` becomes `pointLight(a, b, c, d)`; nothing else about the light
changes, and omitted arguments still land on `THREE`'s defaults.

Sixty hand-edits were refused for the reason the task named — sixty chances to
miss one, and a sixty-first the next time a world is added. The three files that
*had* remembered the line carried **three different comments** explaining it,
which is the drift this replaces.

Hiding at construction costs nothing, and that is a property of `LightRig` that
has to keep holding:

> The light's *own* `visible` flag is deliberately not part of the test: the rig
> is what set it to false.
> — `LightRig._walk`

So a light born hidden is still scanned, still scored and still copied into a
slot. `world-light-visibility.test.mjs` holds that separately, because if it
ever stopped being true every world in the game would go black and the
signature assertion would still pass.

### Exemptions

**None.** `EXEMPT` in the gate is an empty array with a docblock saying what an
entry would have to argue: that `LightRig` is wrong for one particular case,
when `RIG_BUDGET` is the whole supply of live lights and the rig owns it. No
light in the tree needed one.

---

## 4. The gate

`scripts/tests/world-light-visibility.test.mjs`, 8 cases in two halves.

**Static (4 cases).** No `.js` under `src/worlds/` may contain `new
THREE.<anything>Light(` outside a comment. This is categorical on purpose:
`citadel-caves.test.mjs` had already written down why the obvious gate is not
enough —

> The assertion is on the built lights, not on a regex over the source, because
> a light created visible and hidden two lines later would pass a regex.

— and a ban on the constructor has no "two lines later" to pass, because there
is no construction. The other three static cases check the scanner can see a
real construction and ignores one written in prose, that every file calling a
factory imports it, and that no file un-hides a light it just made.

**Measured (4 cases).** Nine real worlds — station, medieval, sports, citadel,
race, maze, dock, space and Cinder — built through a real `WorldManager` with
**no `LightRig` anywhere in their context**, so the flag being read is the one
the world's own constructor wrote. Each group is put into the state the arriving
frame sees (`group.visible = true`, which is what `onActivate` does and what
`build()` had just undone) and added to a scene holding nothing but a rig's slot
pool. The assertion is on `lightSignature` — the tuple
`WebGLRenderer.projectObject` builds and `getProgramCacheKey` is keyed on —
rather than on a flag.

That `group.visible = true` is load-bearing rather than incidental, and the case
asserts the group came out of `build()` hidden before flipping it. `projectObject`
skips a light under a hidden ancestor, so a signature taken over an un-activated
group is identical whatever the lights inside it are doing: without the flip
this would be a gate that measures nothing, which is the failure this repository
keeps paying for.

**Result:** `d5p12s2h0a0r0/ds2ps0ss0` — 5 directional, 12 point, 2 spot, 2 of
them shadow-casting, exactly `RIG_BUDGET` — held against all 1,162 authored
lights, in every one of the nine worlds.

### Ablation

Both halves ablate inside the file (a construction written in a comment must not
count; one light made visible must move the signature).

The gate itself was ablated against the whole suite. Reverting **one** of the 64
sites — `Gym.js`, `pointLight(hex, power, dist, 2)` back to `new
THREE.PointLight(hex, power, dist, 2)` — gives:

```
not ok 3263 - no world file constructs a THREE light directly
not ok 3265 - a world file that reaches for a light imports it from gfx/WorldLight.js
not ok 3267 - adding a built world to the scene does not move the shader light signature
not ok 3268 - ABLATION: one world light made visible moves the signature
# tests 3309   # pass 3305   # fail 4
```

Four failures, all four in this file, and **nothing else in the other 3,301
tests noticed** — which is also the measurement of how unguarded this was.

---

## 5. What was measured, and what it says

### 5.1 The size of the hazard that was closed

The nine worlds, built on the pre-fix tree (`0efbeac`) and on this branch, each
added to a scene holding only the rig's slots. This is the signature the first
frame after activation would have compiled against, had one been able to run
between `onActivate()` and `claim()`.

| world | authored lights | born visible, before | arriving signature, before | after |
|---|---:|---:|---|---|
| station | 226 | 226 | `d9 p233 s3 / ds3` | `d5 p12 s2 / ds2` |
| medieval | 156 | 156 | `d7 p166 s2 / ds2` | `d5 p12 s2 / ds2` |
| dock | 186 | 186 | `d5 p198 s2 / ds2` | `d5 p12 s2 / ds2` |
| sports | 4 | 4 | `d8 p13 s2 / ds3` | `d5 p12 s2 / ds2` |
| cinder | 1 | 1 | `d5 p13 s2 / ds2` | `d5 p12 s2 / ds2` |
| citadel | 63 | 0 | `d5 p12 s2 / ds2` | unchanged |
| maze | 525 | 0 | `d5 p12 s2 / ds2` | unchanged |
| space | 1 | 0 | `d5 p12 s2 / ds2` | unchanged |
| race | 0 | 0 | `d5 p12 s2 / ds2` | unchanged |

Five of nine worlds would have arrived carrying a different program cache key —
the station at **19× the live point-light count** the shaders are built for, and
with three shadow-casting directionals against the rig's two. The four that held
are the three files that already knew (caves, maze, space) plus race, which
authors no lights at all.

That is a measurement of the hazard, not of a saving. No frame ever drew those
counts, because of §2.

### 5.2 Production: no measurable change, and that is the answer

`scripts/frame-gaps.mjs --serve prod --cache-keys --worlds medieval,sports
--events entry,weapon`, once on this branch and once on `0efbeac` with only
`src/worlds` swapped, so both runs used the same instrument, the same event set
and the same machine.

**`--cache-keys` is the decisive instrument, not the millisecond columns.** It
dumps every linked program's `getProgramCacheKey` after boot, so it answers the
one question this branch is actually about: *did any frame ever draw with a
light count other than the rig's?*

| | pre-fix `0efbeac` | branch |
|---|---:|---:|
| `stats().warm.programs` | **272** | **272** |
| programs linked after boot | 272 | 272 |
| …keyed to the rig triple `5 dir / 12 point / 2 spot` | **251** | **251** |
| …carrying no light counts (GTAO, SMAA, bloom, sky) | 21 | 21 |
| …keyed to **any other** light count | **0** | **0** |

Zero on both sides. No frame in a production boot ever drew with a world's own
lights live, before or after — which is exactly what §2 predicts and is now
measured instead of asserted. The `numPointLights 233` key the station would
have compiled against never appears, because `claim()` gets there first.

Programs linked per event are identical too, and unlike wall-clock they are
deterministic:

| event | dPrograms, pre-fix | dPrograms, branch |
|---|---:|---:|
| boot | 273 | 273 |
| backgroundChain | 213 | 213 |
| entry:medieval | 0 | 0 |
| entry:sports | 49 | 49 |
| weapon:sports | 2 | 2 |

**The millisecond columns are not quotable and are not quoted.** `idleBaseline`
was 16.9 ms on the pre-fix run and 33.4 ms on the branch run — the branch's
noise floor was twice as bad — and the branch still measured a *faster* boot
(21.5 s against 43.3 s) and a faster `entry:medieval` (1.3 s against 6.3 s)
while measuring a *slower* `weapon:sports` (383 ms against 33 ms). That is a
machine whose floor moves between runs, which this repository has already
recorded, and none of it is attributable to sixty `visible` flags that no frame
ever read.

### 5.3 The budget

`npm run build`: **3,339.34 kB** on this branch against **3,339.58 kB** on the
pre-fix tree — **240 bytes smaller**, because four `visible = false` lines and
three divergent comment blocks came out and three one-line factories went in.

Materials, renderables, instanced meshes and world lights are untouched by
construction: the same objects are created with the same arguments in the same
order, one property later. `worldLights` counts lights in the group and is
unchanged at 1,162 across the nine worlds; `worldLightsLit` was already 0 in
every art-phase budget table, because `LightRig` had demoted them by the time
any framing was taken. Shader programs: 272 both sides, above.

Materials, renderables, instanced meshes and world lights are untouched by
construction: the same objects are created with the same arguments in the same
order, one property later. `worldLights` in a `world-shot` sweep counts lights
in the group and is unchanged at 1,162 across the nine; `worldLightsLit` was
already 0 in every art-phase budget table, because `LightRig` had demoted them
by the time any framing was taken.

---

## 6. Two things found on the way

- **`SpaceWorld._buildRim`'s docblock named the wrong test.** It said
  "`space-yard-exterior.test.mjs` holds the flag"; the assertion is in
  `space-art.test.mjs`, and `space-yard-exterior.test.mjs` contains no light
  assertion at all. A comment claiming a gate that is not where it says is worse
  than no comment, because it stops the next reader looking. Corrected.

- **`maze-lighting.test.mjs` asserted `/lantern\.visible\s*=\s*false/`.** It was
  the right instinct in the wrong instrument, and its neighbour in
  `citadel-caves.test.mjs` had already said why. It now asserts the categorical
  thing, and keeps its own case because the maze is the **streaming** one: its
  district lanterns are built while the world is already on screen, so the
  window this closes is genuinely open there rather than merely latent.

---

## 7. Files

| file | change |
|---|---|
| `src/gfx/WorldLight.js` | **new.** Three factories; the one line, in one place. |
| `src/worlds/**` (14 files) | 64 constructions rerouted; 4 redundant `visible = false` lines and 3 divergent comments removed. |
| `scripts/tests/world-light-visibility.test.mjs` | **new.** The gate, 8 cases. |
| `scripts/tests/maze-lighting.test.mjs` | regex assertion replaced by the categorical one. |
| `docs/superpowers/specs/2026-08-21-implementation-brief-roadmap.md` | Phase 1 item 4 closed. |
