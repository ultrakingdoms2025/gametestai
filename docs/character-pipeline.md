# The character pipeline: what a hybrid authored path would actually cost

*Written 2026-09-02 against the tree at `audit-remediation-sep-2026`. Every number
below was measured in this repository, headlessly, with the command recorded
beside it. Where I could not measure something I say so rather than estimating.*

---

## 0. The question

Characters are 100% runtime-procedural (`src/npc/Humanoid.js:6-11`). The body is
good and is not the problem. The ceiling is threefold:

1. **No morph targets, no jaw bone.** The only face motion in the game is an eye
   pivot and a lid rotation (`src/npc/NPCAnimator.js:1697-1733`). Characters
   converse with a sealed, static face while `ChatClient` streams them dialogue.
2. **No unique face UV.** `Humanoid.js:3164` writes `((u/segU)*2, (v/segV)*2)`,
   so the head tiles the generic body skin texture 2x2. Lip colour, brow roots,
   stubble, asymmetry are not absent — they are unaddressable.
3. **Hair is a solid displaced shell.** No cards, no alpha, no anisotropy.

And the architectural blocker: `src/npc/HeroAssets.js` discards the glTF material
by design (its lines 18-30) and welds every authored part into the character's
own `SkinnedMesh` (lines 31-41). An authored asset cannot bring its own texture,
its own shader or its own morph targets. That is the decision this document
answers.

---

## 1. What a parallel authored-hero path costs, in shader programs

This is the number the whole decision turns on, so it is derived the way the
detail-normal work derived its: from `WebGLPrograms.getParameters` in the pinned
three 0.185.1 in `node_modules`, not from memory.

### 1.1 What is actually in the key

`scripts/frame-gaps.mjs:2421-2432` already transcribes the fixed 52-entry tail of
`getProgramCacheKey`. The fields that matter here, verified in
`node_modules/three/src/renderers/webgl/WebGLPrograms.js`:

| field | line | consequence |
|---|---|---|
| `morphTargets` / `morphNormals` / `morphColors` | 332-334 | in the boolean bitmask (`:559-563`) |
| `morphTargetsCount` | 335, 470 | **a number in the key** — 4 shapes and 8 shapes are two programs |
| `morphAttributeCount` | 471 | same |
| `customProgramCacheKey` | 432 | the last field; one difference here is one program |
| `numDirLights` … `numLightProbes` | 472-482 | constant per world here — see §5 |
| `mapUv`, `normalMapUv`, `roughnessMapUv`, … | 444-466 | *which map slots are bound*, not which textures |

Two things follow immediately, and they are the crux:

* **A material's colour and its texture identity are not in the key.** Two
  materials of the same type with the same *set of bound map slots* share one
  program. So the cost of an authored hero is driven by its number of distinct
  **material signatures**, never by the number of heroes.
* **`morphTargetsCount` is a number.** Introducing morph targets for *some*
  characters does not move programs, it *doubles* them for every material drawn
  both ways.

The repo has already paid to learn the first point. `Humanoid.js:455-488` records
the rim experiment: six rim tuples in a cast, each keyed separately, produced six
programs of byte-identical GLSL — *"six of the seven programs dock's first entry
linked, and six of medieval's seven, differed from an existing program in this
field and in NOTHING else."* One field difference, one program. That is the
exchange rate.

### 1.2 The shadow pass, which doubles some of the above

`node_modules/three/src/renderers/webgl/WebGLShadowMap.js:417-465`: unless a
material needs a unique depth variant — `alphaTest > 0` with a `map` or
`alphaMap`, a `displacementMap`, `clipShadows`, or `alphaToCoverage` — every
material shares one `_depthMaterial` instance. Its program still keys on the
*object's* skinning and morph params and on `result.map` / `alphaTest` / `side`
(`:481-483`). So:

* An opaque authored hero material adds **no** depth program: it collapses onto
  the one the body already links.
* **Hair cards do.** `alphaTest > 0` with a `map` is exactly the branch at
  `:434-435`, so alpha-cut hair takes a cloned depth material and **+1 depth
  program**. That is the real price of ceiling 3, and it is one program.

### 1.3 The counts

Measured baseline. The character body is one `SkinnedMesh` with six material
groups, plus nine sibling meshes (hair, headgear, and per eye a sclera, iris and
two lids):

```
node -e "new HumanoidFactory({}).create({ seed: 7, theme: 'station' })"
  bones 26 · tris 20300 · verts 11106 · meshes on character 10 · morphAttributes 0
  materials  MeshPhysical ×3 (skin, cloth, cloth) + MeshStandard ×2 + MeshPhysical
```

(The brief said 22 bones; the tree says 26. The difference does not change any
number below — bone count is not in the program cache key at all.)

**(a) One authored hero that keeps its own PBR materials.**

| what it brings | forward | depth | total |
|---|---|---|---|
| 1 opaque `MeshStandard{map, normalMap, roughnessMap}` face | +1 | 0 | **+1** |
| + a second signature (`MeshPhysical` with sheen, for cloth) | +1 | 0 | **+1** |
| + alpha-cut hair cards | +1 | +1 | **+2** |
| + its own morph targets at one count | 0 — folded into the signatures above | 0 | **0** |

A complete authored hero — face, garment, alpha hair, expressions — is
**+4 shader programs, once, for the whole cast**, because every hero reusing
those three signatures reuses those four programs. Eleven heroes cost the same as
one. That does not fit in the two programs of margin left under the 146 ceiling,
so it wants its own budget line rather than the remaining slack; but the *shape*
of the cost is bounded, and bounded is the whole point.

**(b) Morph targets on the existing procedural humanoid.**

* Adopted **uniformly** — every humanoid in the game gets the same shape count —
  the six body-slot programs move from `morphTargets:false, count:0` to
  `true, count:N`, and the depth program moves with them. **Net delta: 0.**
* Adopted for **heroes only**, both variants coexist: **+6 forward and +1 depth
  = +7 programs**, and another +7 per additional distinct shape count (heroes at
  8, the player avatar at 4 → +14).

**+7 does not fit.** The station sits at 144 against a pin of 142 ±4
(`scripts/tests/frame-gaps-program-gate.test.mjs`), ceiling 146, margin 2. So the
cheap-looking option is affordable *only* in its most invasive form — all or
nothing across every character in six worlds — and the expensive-looking option is
affordable in its most surgical form. That inversion is the most useful thing in
this document.

---

## 2. How many named characters are there

A bounded count is what makes a bounded program cost acceptable. Counted from the
tree, not estimated:

| source | count |
|---|---|
| `src/npc/NPCRoles.js` `ROLE_CAST` (6 themes × stationary roles) | 39 |
| `src/npc/NPCManager.js` quest-manager `CAST` | 6 |
| World-authored personas (`CitadelWorld` 2, `DockWorld` 8, `MazeWorld` 21, `MedievalWorld` 15, `SportsWorld` 8, `StationWorld` 6, `citadel/Caravans` 28, `citadel/Oasis` 2, `maze/MazePopulation` 2, `medieval/Inhabitants` 1, `medieval/Population` 2, `station/zones/*` 24) | 119 |
| **distinct named characters carrying a persona** | **148** |
| distinct `talk`/`interact` targets across the 78 quests in `src/systems/QuestsOffline.mjs` | 45 |
| — of those, already in the persona set | 27 |
| **union** | **166** |

So the named cast is **166**, not eleven. Two consequences:

* **A per-character authored asset is out.** 166 heads is not a browser download
  (§4) and not a content budget that exists here.
* **A per-character authored asset was never the proposal.** §1 showed the cost is
  per *material signature*. 166 characters sharing one authored face material and
  one authored hair material is +4 programs and one texture set. The count that
  has to be bounded is the signature count, and that is bounded by construction
  rather than by the cast.

Two smaller findings fell out of the count and are recorded because nobody is
watching them:

* **Eighteen quest targets have no persona anywhere in the tree** — `Bex Corrado`,
  `Sparrow Nkemdi`, `Anselm Kade`, `Prue Okonkwo`, `Lt. Idris Fane`,
  `Dispatcher Ovie Kanu`, `Rooke Ilesanmi`, `Marta Vale`, `Hafsa the Dyer`,
  `Bashir the Ostler`, `Yusra the Falconer`, `Rafiq the Keeper`, `Ines Okonjo`,
  `Devrim Aslan`, `Halla Brandt`, `Petra Halvorsen`, `Tobias Renn`,
  `Marek Vaisey`. Quest steps address them by name. Whether they are spawned under
  those names is not something this document verified, but the asymmetry is worth
  someone's afternoon.
* **There are exactly six faces in the game.** `Humanoid.js:2800` —
  `FACE_COUNT = 6`. 166 named characters draw from six head sculpts. That is a
  larger identity problem than the missing jaw, and it is nearly free to fix
  (§3.3).

---

## 3. Which ceiling is cheapest to lift in the existing generator

### 3.1 The generated-blendshape claim, tested

> the head is a deterministic function of its face dials, so blendshapes can be
> GENERATED for free by re-running the builder with different parameters and
> diffing position buffers

**True, and here is the proof.** Two characters differing only in `faceId`,
everything else pinned:

```
node -e "F.create({seed:1,…,faceId:0})  vs  F.create({seed:1,…,faceId:3})"
  verts        11106 / 11106
  index count  60900 / 60900     index buffer byte-identical: true
  draw groups  identical (6 groups, identical starts and counts)
  moved verts  1260 of 11106 · max 9.84 mm · mean 0.62 mm
```

Identical topology, identical index buffer, identical groups; only positions
differ, and only inside the head. That *is* a morph target — no new machinery is
needed to author one. `buildHead` takes no RNG and neither does `faceArchetype`,
so the function is genuinely deterministic. And `mergeParts`
(`Humanoid.js:2568-2628`) concatenates parts without welding or de-duplicating
vertices, so the head occupies a stable contiguous vertex range in the merged
buffer and a full-length delta array is trivially constructible.

### 3.2 …and why "free" is the wrong word

Free in **CPU**, yes. Not free in **memory**, and the reason is a measurement that
contradicts a comment at the top of `Humanoid.js`:

> The expensive half (geometry) is cached per *archetype* … because 16 NPCs in a
> world only need a handful of distinct bodies.

Measured, station theme, with the exact parameters `NPCManager._createNPC` passes
for a civilian (`{seed, theme}` — everything else randomises off the seed):

```
cast  16 -> body archetypes  16
cast  32 -> body archetypes  31
cast  68 -> body archetypes  59
cast 200 -> body archetypes 133
cast 600 -> body archetypes 279
```

**Sixteen NPCs need sixteen bodies.** The archetype key is
`body|theme|variant|bottom|hero|P.key|faceId` (`Humanoid.js:5427`) and it carries
build × frame × shoulderScale-quantised-to-1/20 × faceId, so at crowd sizes the
cache almost never hits. That deserves attention on its own; here it is what
prices the blendshapes.

`WebGLMorphtargets`
(`node_modules/three/src/renderers/webgl/WebGLMorphtargets.js:38-52`) packs targets
into a `DataArrayTexture` backed by `Float32Array(width × height × 4 × count)`
where `width = position.count × vertexDataCount`. Position-only targets therefore
cost **verts × 16 bytes each, per geometry**, plus the source `BufferAttribute`
(verts × 12) and the retained staging buffer (another verts × 16).

For one 68-character station cast — 62 body archetypes, 705 288 vertices total:

| | per expression shape |
|---|---|
| morph texture (GPU) | **10.8 MB** |
| source attributes (CPU) | 8.1 MB |
| staging buffer (CPU) | 10.8 MB |

Eight expression shapes across that cast is ~86 MB of VRAM and ~150 MB of heap.
The entire `public/` directory is 20 MB. **That is not affordable, and it is why
"generated blendshapes are free" is a half-truth.**

Restricting morphs to hero archetypes cuts it to roughly 1.9 MB per shape at the
station — affordable — but that is exactly the case §1.3(b) prices at **+7
programs**, which does not fit under the pin. Both halves of the cheap option are
individually cheap and they are not simultaneously satisfiable.

### 3.3 The ranking

| ceiling | cheapest lift in the existing generator | programs | memory | verdict |
|---|---|---|---|---|
| **2 — unique face UV** | give `buildHead` its own UV island instead of `(u/segU)*2`, and one small face texture in the existing skin slot: same material, same bound map slots, same program | **0** | one texture | **cheapest by a distance — do this first** |
| **1b — a jaw bone** | a 27th bone, a driver in `HEAD_BONES`, and `NPCAnimator` driving it off the dialogue stream | **0** (bone count is not in the program key) | 0 | underrated; not a smile, but it is the difference between talking and sealed |
| **1 — expressions** | generated blendshapes, proven in §3.1 | 0 if universal, +7 if hero-only | 10.8 MB *per shape* across a crowd | blocked on the archetype spread, not on the shapes |
| **3 — hair cards** | not reachable in the generator: needs `alphaTest` on a shell currently built with `OPAQUE_SHELL` | +1 forward, +1 depth | 0 | cheap in programs, expensive in art |

**The answer to "which is cheapest": ceiling 2, and it is not close.** A face UV
island plus a 512² face texture is zero programs, zero new materials, one texture,
and it unlocks lips, brows, stubble and asymmetry — what a viewer reads first at
conversational distance. A jaw bone is second-cheapest and also zero programs.
Blendshapes are third and are gated on a cache problem that has nothing to do with
faces.

**Does that beat authored assets on cost?** For ceilings 1 and 2, yes,
decisively. For ceiling 3, no. For *identity*, no — six faces stays six faces
however well each one is lit.

---

## 4. Download

Real numbers from this tree, because download size is a real cost:

| | |
|---|---|
| whole `public/` | 20 MB |
| `public/assets/maze` — 5 surfaces, 15 KTX2 files | 17 MB |
| — hedge set alone (albedo 0.86 + normal 5.01 + orm 0.75) | **6.6 MB** |
| `public/assets/npc` — both hero geometry `.glb`s | 268 KB |

The KTX2 **normal map is the whole cost**: 5.0 of the hedge's 6.6 MB. One authored
hero material set at that resolution would be a third of the game's current
download.

A head is ~0.2 m across and read from 1-3 m, so it has nothing like a hedge wall's
texel-density argument. **1K albedo + 1K normal + 512² ORM (~0.7 MB) is generous;
2K cannot be justified here.** One shared authored face/garment/hair set for the
whole named cast is therefore ~1-2 MB — **+5-10% of the download**, payable.

166 individually authored heads at that rate would be 120-330 MB. Not payable, and
not proposed.

---

## 5. What is and is not reachable

The target is Cyberpunk 2077. Stated plainly.

### Closed off by the constraints as they stand

* **Skin as a material.** CP2077 faces are subsurface scattering with a thickness
  map, a multi-lobe specular, and a separate eye shader. This project
  approximates SSS with `MeshPhysical` sheen plus a warm forward-fill term
  (`Humanoid.js:955-1000`) and says so out loud. Real SSS is a second pass and a
  second program family. Not reachable under a 146-program ceiling.
* **Per-character lighting.** `RIG_BUDGET` (`src/gfx/LightRig.js:62-79`) is
  12 point + 2 spot + 2 shadow-casting dir + 3 fill dir = 19 fixed slots,
  *"baked into every shader in the game"*, sized by a measurement that each point
  slot removed is worth ~5% of the entire cold shader warm. A character cannot
  have a key light of its own; conversation close-ups will always be lit by the
  room.
* **Per-character authored heads.** §4.
* **Anything needing a second full-screen pass** — a dedicated hair pass, a skin
  blur, deferred anything. Frame timing cannot be measured on the development
  display (`scripts/frame-gaps.mjs` correctly refuses at ~10 Hz rAF), which means
  it cannot be *defended*, which means it should not be spent.

### Genuinely open

* **A face that is not a tiled body texture.** Ceiling 2, zero programs. The
  single largest visual return available anywhere in this pipeline.
* **A mouth that moves when a character speaks.** A jaw bone is zero programs and
  the dialogue system is already there.
* **Expressions**, once the archetype spread in §3.2 is dealt with — and dealing
  with it is worth doing regardless, since 59 distinct 20 300-triangle geometries
  for a 68-person crowd is memory and build time being spent on nothing.
* **A bounded authored hero set**: one authored face material, one garment, one
  alpha-cut hair, shared by every named character. **+4 programs, ~1-2 MB.** Buys
  ceilings 2 *and* 3 plus per-character identity that six procedural faces cannot,
  and its cost does not scale with the cast.
* **Hair that reads as hair.** Only via the authored path. The generator cannot
  get there without alpha, and alpha in the generator costs the same +2 programs
  with none of the art upside.

### The honest summary

The gap to CP2077 is not the body — the body measures well. The gap is **the face,
and specifically the face's addressability**. Everything separating these
characters from that target at conversational distance — lips, brows, stubble,
asymmetry, expression, hair — is downstream of one line, `Humanoid.js:3164`, that
tiles a body texture across a head. Fix the UV and the rest becomes a series of
ordinary art decisions. Leave it and no amount of authored geometry helps, because
there is nowhere to put the pixels.

---

## 6. The decision, and the step taken

**Recommended sequence, in cost order:**

1. **Face UV island + face texture** (`Humanoid.js`, 0 programs).
2. **Jaw bone** (`Humanoid.js` + `NPCAnimator.js`, 0 programs).
3. **A bounded authored-hero material path** (+4 programs, ~1-2 MB) — the
   mechanism for which is what was implemented here.
4. **Archetype-cache spread**, then generated blendshapes.

Steps 1, 2 and 4 all live in `Humanoid.js`, which this change is not scoped to
touch.

### What was implemented: the opt-in own-material escape hatch in `HeroAssets.js`

A manifest asset entry may now declare `"own": ["<partKey>", …]`. A part named
there keeps its glTF material, which reaches the consumer as a new `material`
field on the `heroParts()` record.

It is **inert today**: no manifest declares `own`, every part still comes back
with `material: null`, `HumanoidFactory` welds exactly what it welded before, and
the station's 144 programs are untouched. Three guards make it a mechanism rather
than a speculation:

* **`HERO_OWN_PROGRAM_BUDGET = 4`.** The loader computes the distinct *material
  signatures* of the own-material set using the same superset-key discipline as
  `src/gfx/PreviewWarm.js:52-72`, and if the set exceeds the budget it drops every
  own material with one warning; the parts then weld through the existing path.
  **The budget is enforced by the loader, not by review.** `heroOwnSignatures()`
  exports what it counted, so the number is readable from a test or a console
  rather than argued about.
* **An own part must still declare a slot and a bone.** The degrade path is
  therefore always complete: over budget, or with a consumer that never reads
  `material`, the character is exactly the one that ships today.
* **Morph attributes are transformed, or refused.** `BufferGeometry.applyMatrix4`
  transforms `position` / `normal` / `tangent` and **not** `morphAttributes` in
  three 0.185.1. `namedParts` bakes the node transform into the geometry, so an
  authored hero carrying blendshapes under a non-identity node would have been
  silently corrupted — the deltas left in the authoring node's space while the
  base mesh moved. The loader now applies the matrix to absolute targets and its
  normal matrix to relative ones, and drops the morphs with one warning when it
  cannot decide.

### Why this and not the morph channel

*Substance.* The escape hatch unlocks all three ceilings for a bounded cast at
+4 programs, and its cost does not scale with the cast — an authored hero mesh can
carry its own morph targets inside a signature already being paid for (§1.3a, last
row: +0). The morph channel unlocks ceiling 1 only, costs +7 programs unless
adopted by every character in six worlds simultaneously, and §3.2 prices universal
adoption at 10.8 MB of VRAM *per shape*. Strictly more optionality, strictly less
budget.

*Scope.* The morph channel lives in `Humanoid.js`. Shipping half of it — a loader
that carries shapes nothing consumes — would be exactly the speculative code path
the brief rules out. What is shipped instead is the one seam an authored asset
cannot be commissioned without, with its own budget gate attached, and nothing
behind it yet.

### Follow-ups this change deliberately does not do

* Register `HERO_OWN_PROGRAM_BUDGET` and `heroOwnSignatures` in
  `scripts/contract-check.mjs:431`. That check is a subset check so it passes as
  written, but house convention is that a seam gets listed.
* Add a test for the budget-drop and morph-transform paths.
  `scripts/tests/npc-assets.test.mjs` is the right home and is outside this
  change's file list.
* Correct `Humanoid.js:14-15` ("16 NPCs in a world only need a handful of distinct
  bodies"). §3.2 measures 16 NPCs needing 16 bodies. The comment is wrong and the
  fix is not a comment.
