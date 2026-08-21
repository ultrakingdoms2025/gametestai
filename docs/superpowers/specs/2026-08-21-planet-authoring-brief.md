# How to author a planet descriptor

Read this, then read `src/worlds/planets/Volcanic.js` **in full**, then read the
schema docblock at the top of `src/worlds/planets/PlanetDescriptor.js` **in full**.
Volcanic.js is the reference implementation and the quality bar. You are writing
its sibling, not a cut-down version of it.

---

## The one thing to understand first

**A planet is DATA.** `src/worlds/PlanetWorld.js` is the single world class that
renders every planet. You are not writing a world; you are writing the record that
makes one. That means:

- No `three` import. Ever. Your file crosses `postMessage` to a terrain worker.
- **No functions inside the descriptor.** A closure clones to `undefined` and the
  worker silently builds a flat plain with no error anywhere.
- No new world class, no new height function, no `if (planet.id === ...)`.
- Local `const`s and helper arrow functions *outside* the descriptor object are
  fine and encouraged — Volcanic.js uses `P(d, deg)` for polar placement and an
  `ORE(id)` lookup. Just don't let one end up *in* the returned record.

---

## The vocabulary you have

**Landforms** (`src/worlds/terrain/PlanetHeight.js` — read its docblock for the
exact params of each):

| layer | kinds |
|---|---|
| ADD | `volcano` `cone` `plateau` `ridge` `dunes` `scarp` |
| CUT | `basin` `trench` `channel` `crater` |
| LEVEL | `pad` `ramp` |

**Props** (`src/worlds/planets/PlanetProps.js`):
`columns` `shards` `boulders` `vents` `spires` `growth` `slabs`

**Sky kinds**: `daylight` `alpine` `space` — with a `params` block passed straight
to `createSky`. Read `src/gfx/Sky.js` for what each preset's params are; they cover
far more colour range than the names suggest (Cinder is `daylight` with
`rayleigh: 0.12, mie: 4.4` and it is an orange dust sky).

**Mineral terrains**: `plain` `highland` `shelf` `outcrop` `fissure` `crater`
`channel` `vent_field` `shore` `cave`

**Region shapes**: `disc` `annulus` `corridor` `rect` `field`, with the filters
`yMin` `yMax` `slopeMaxDeg` `slopeMinDeg` `clearOfLiquid` `clearOfPads`.

If your planet needs a shape nobody has built, **say so in your report** — do not
invent a kind, and do not fake it with a pile of `boulders`.

---

## Layer order matters, and it bit Cinder

Inside the LEVEL layer a later form overrides an earlier one where they overlap.
Volcanic.js records the measurement: **roads first, pads last.** The other way
round cost the rim pad its flatness — the spiral road left the pad centre
descending at 0.15, so inside a 20 m disc it had already taken 3.0 m off. A
"landing pad" with a three-metre fall across it. Measured: 3.00 m of span before,
0.00 m after.

Also: a `pad` with no explicit `y` takes the pre-level field height at its centre,
and a `ramp` with no explicit `y0` takes it at its first point. **So a ramp that
starts exactly at a pad centre meets the pad with no step.** Start it one metre
away and the two resolve to different numbers and the player walks off a riser
they cannot see. Volcanic.js's `SPIRAL` begins at `RIM_PAD` for exactly this reason.

---

## The nine things `definePlanet()` will throw at you

Design for these; do not discover them.

1. Every `landing` site needs a matching `pad` landform at the **same coordinates**
   (within 1e-6) and at least as large. *A landing site that is only an assertion
   is how "built but not reachable" gets shipped.*
2. Exactly one landing site is `primary: true`.
3. The rarity ladder runs **contiguously up from `common`** — you cannot have
   `common` then `rare`.
4. `unitValue` **ascends strictly between tiers**: the dearest common ore must be
   cheaper than the cheapest uncommon one.
5. `count` **never ascends between tiers**: a rarer thing is not more numerous.
6. The rarest tier may not use `terrain: 'plain'` and may not use a `field` region.
   *A rare element scattered over the whole map, underfoot at the pad, is a common
   element with an expensive name.*
7. `credits` is DERIVED (`unitValue * hold`) and authoring it is **refused**.
8. `palette.bands` must have ≥2 entries ascending by `upTo`.
9. Everything must be plain data — `assertCloneable` walks the whole record.

---

## The two things it *cannot* catch, which are therefore the review

### A. The ore must be walkable to

`scripts/tests/planet-minerals.test.mjs` floods the **real colliders** from each
landing pad over a 2 m lattice with no jump and no mantle. A seam at the bottom of
a vertical fissure, inside a lava flow, or on a 71° wall is content behind glass.

Two failure modes, both real, both from Cinder:

- Sulfur was authored in a `corridor` down the rift and the corridor included the
  **floor of a 13 m trench with near-vertical walls**. Fixed with `widthInner: 13`,
  which excludes the floor and addresses only the lips — which is also where
  sulfur actually crusts. *The fix and the geology were the same fix.*
- A colonnade at 5.0 m spacing left 2.0 m lanes between column faces and the reach
  probe lost a whole seam inside it. *A colonnade a body cannot walk into is
  scenery with ore behind glass.*

**Design the exotic ore as a SECOND LANDING, not a longer walk.** On Cinder the
exotic tier is 0-of-9 reachable from the primary pad at any distance, and becomes
reachable only from the rim pad down a purpose-built spiral road. That is the shape
to copy: the rarest thing costs a decision, not just time.

### B. The bands must move in HUE and SATURATION, not only in value

Cinder shipped six bands across **five degrees of hue and zero saturation change**,
and a tester who landed and walked it wrote:

> "Cinder from orbit is the best thing in the game. Cinder's surface is the worst.
> One flat salmon-brown hue, no rock, no ash, no vents, no heat, no shadows."

Value structure alone is a black-and-white photograph of a planet. Keep the value
structure — dark low, bright high — and spend the remaining freedom on hue and
saturation. Read Volcanic.js's `palette` docblock; it has the measured before/after.

---

## Fog: the numbers that make a horizon

Cinder's first fog was **darker and more saturated than the rock it hung over**, at
a `far` shorter than the map diagonal. The whole planet lived inside a 9-luma band.

Two rules, both asserted by `scripts/tests/planet-atmosphere.test.mjs` against your
own palette bands:

1. **Fog is LIGHTER and GREYER than the ground bands under it.** Cinder's ground
   averages L 0.110 / S 0.448 in linear space; its fog is L 0.186 / S 0.370.
2. **`far` must exceed the playfield diagonal** (`half * 2 * √2`), or the player
   sees the world stop — but not by much, or the rim shows through. Cinder: half
   400, diagonal 1131, `far` 1250. Use roughly **1.1 × diagonal**.

**Airless worlds are the exception and must be handled deliberately.** In vacuum
there is no haze, so fog cannot hide the map edge. Use a very long `far` (about
4 × the diagonal) tinted to the black sky, and lean on `terrain.rim` to drop the
edge away, so the world dissolves into the starfield rather than into soup. Say in
a comment that this is what you did and why.

---

## The two rules that each cost this project a day

**NaN, not lighting.** Four meshes shipped with `tile = 0` → NaN uvs →
`UnrealBloomPass` high-passes and blurs through five mips, and a weighted sum
containing NaN is NaN. **19 NaN pixels blacked out 921,600.** Flooding ambient 27×
moved the mean luminance by 0.07, because there was no image to brighten. *If a
world renders dark, check for NaN before you touch a light.* Never author a zero
tile, a zero radius, a zero width, or a degenerate polyline.

**The primitive is the problem.** This project shipped spacecraft built from 197
stacked `box()` calls and the user rejected them three times: *"they look like they
are made of square blocks."* Three art passes on box stacks produced three box
stacks. And one agent rejected the user's complaint by re-reading its own header
comment while the picture showed a barge. **Never assess art by reading code.**

---

## What "different terrain" has to mean

The user asked for "many different planets… each different terrain". The bar is:
**a screenshot of your planet's surface must be unmistakable for any other planet
in the system.** A recoloured Cinder fails, however good the numbers are.

Get that from *silhouette and landform first*, colour second:

- Volcanic = a shield with a caldera on the skyline from everywhere.
- Desert = long parallel dune crests, and one slot canyon that is invisible until
  you are in it.
- Ice = crevasse fields you have to route around, and pressure ridges.
- Airless moonlet = overlapping crater rims and shadows with nothing in them.
- Ocean = a horizon of water with island silhouettes standing off it.

Write the "THE MAP, in words" section at the top of your file **first**, naming
three to six places. If you cannot name them, the planet is noise with a palette.

---

## Your file's shape

Copy Volcanic.js's structure exactly:

1. Header docblock: **THE MAP, in words** — the named places and what each is for.
2. **WHY THE NUMBERS ARE THESE NUMBERS** — relief budget, and how much of the
   height is authored versus noise. Cinder: 11.6 m of noise against 158 m of
   authored relief; the noise is the last 7% and its whole job is to stop the
   authored shapes reading as CAD.
3. `const ORE = (id) => …` — the `ITEMS` lookup that throws on a missing row, with
   YOUR planet's name in the message.
4. Frame-of-reference constants, then feature polylines/points as named `const`s.
5. `export const <NAME> = definePlanet({ … });` and `export default <NAME>;`

Every non-obvious number carries a comment saying **why it is that number**. That
is the house style and it is not optional here.

---

## How to check your work before you report

You do **not** need the planet registry — `PlanetWorld.of(DESCRIPTOR)` works
straight off your descriptor. Copy the headless build helper in
`scripts/tests/planet-minerals.test.mjs` (the `cinder()` function, ~line 399) and
write a throwaway probe that reports:

- **Every mineral placed vs requested.** `scatter` reports a shortfall rather than
  padding. A field that under-delivers by a quarter is a number nobody can reason
  about — Cinder's colonnade was cut from 210 to 150 for exactly this.
- **Pad flatness**: the height span across each landing disc. Target 0.00 m.
- **Reachability**: flood from each pad over a 2 m lattice against the real
  colliders and report, per mineral, how many nodes are reachable from which pad.
  The exotic tier should be 0-from-primary and reachable from its own pad.
- **Finiteness**: sample the height field over a dense grid and assert every value
  is finite. Do this one first; it is the cheapest and it is the failure that
  costs a day.

Report the actual measured tables in your summary. **Delete the probe when done** —
do not leave scratch files in the tree.

---

## Per-planet assignments

`gravity` is m/s². `half` is the playfield half-extent in metres, `seg` the terrain
grid; both the mesh and the collision heightfield use that grid, so keep the cell
near 3.1 m. Fog `far` ≈ 1.1 × `half·2·√2` (4× for airless).

| id | name | half | seg | gravity | sky kind | liquid |
|---|---|---|---|---|---|---|
| `tessera` | Tessera | 350 | 224 | 1.62 | `space` | none |
| `sirocco` | Sirocco | 440 | 280 | 9.10 | `daylight` | brine pans |
| `shoal` | Shoal | 440 | 280 | 9.60 | `daylight` | sea water |
| `vitrine` | Vitrine | 460 | 288 | 7.80 | `alpine` | meltwater / none |
| `verdigris` | Verdigris | 430 | 272 | 10.10 | `daylight` | river water |
| `lathe` | Lathe | 320 | 208 | 1.90 | `space` | none |
| `carnelian` | Carnelian | 440 | 280 | 7.40 | `alpine` | none |
| `sallow` | Sallow | 400 | 256 | 8.10 | `daylight` | acid lakes |
| `cathedra` | Cathedra | 400 | 256 | 6.60 | `alpine` | none |

### The mineral tables — use these exactly

`unitValue` must be `ORE('<item>')`, which reads `ITEMS[item].value`. The values
below are what is already in `src/systems/ItemDefs.js`; they are shown so you can
check the ladder, **not** so you can type them.

**tessera** — airless, sixth of a g, crater country
| id/item | rarity | terrain | cr/m³ | count | notes |
|---|---|---|---|---|---|
| `regolith` | common | `plain` | 7 | 40 | field |
| `anorthite` | uncommon | `outcrop` | 22 | 22 | crater rim |
| `sperrylite` | rare | `crater` | 140 | 12 | impact melt |
| `helion` | exotic | `crater` | 240 | 7 | a permanently-shadowed floor |

**sirocco** — dunes, salt pans, one slot canyon
| id/item | rarity | terrain | cr/m³ | count |
|---|---|---|---|---|
| `silica` | common | `plain` | 8 | 46 |
| `halite` | common | `shelf` | 14 | 34 |
| `selenite` | uncommon | `shore` | 30 | 22 |
| `cassiterite` | uncommon | `channel` | 46 | 18 |
| `chalcanth` | rare | `fissure` | 175 | 11 |
| `fulgurite` | exotic | `highland` | 285 | 7 |

**shoal** — islands over a shelf, one tidal chasm
| id/item | rarity | terrain | cr/m³ | count |
|---|---|---|---|---|
| `brinesalt` | common | `shore` | 10 | 40 |
| `nacre` | uncommon | `shore` | 36 | 20 |
| `polymetal` | rare | `shelf` | 200 | 12 |
| `abyssite` | exotic | `fissure` | 340 | 7 |

**vitrine** — crevasses, pressure ridges, a subglacial vault
| id/item | rarity | terrain | cr/m³ | count |
|---|---|---|---|---|
| `rime` | common | `plain` | 12 | 42 |
| `clathrate` | common | `shelf` | 20 | 30 |
| `cryolite` | uncommon | `outcrop` | 44 | 20 |
| `azurine` | rare | `fissure` | 215 | 12 |
| `hyaline` | exotic | `cave` | 380 | 8 |

**verdigris** — canopy mesas, river gorges
| id/item | rarity | terrain | cr/m³ | count |
|---|---|---|---|---|
| `humic` | common | `plain` | 14 | 40 |
| `malachite` | uncommon | `channel` | 48 | 20 |
| `resin` | uncommon | `highland` | 62 | 18 |
| `sporecryst` | rare | `cave` | 240 | 11 |
| `verdite` | exotic | `outcrop` | 430 | 7 |

**lathe** — airless ring shepherd
| id/item | rarity | terrain | cr/m³ | count |
|---|---|---|---|---|
| `rimefall` | common | `plain` | 22 | 34 |
| `sider` | uncommon | `outcrop` | 88 | 18 |
| `tychite` | rare | `crater` | 360 | 10 |
| `aurichalc` | exotic | `crater` | 700 | 6 |

**carnelian** — scarps, dust, one very deep gorge
| id/item | rarity | terrain | cr/m³ | count |
|---|---|---|---|---|
| `ochre` | common | `plain` | 15 | 38 |
| `hematite` | uncommon | `highland` | 52 | 20 |
| `carnelite` | rare | `outcrop` | 260 | 12 |
| `monazite` | exotic | `channel` | 470 | 7 |

**sallow** — acid lakes, fumarole fields
| id/item | rarity | terrain | cr/m³ | count |
|---|---|---|---|---|
| `brimstone` | common | `vent_field` | 17 | 40 |
| `realgar` | uncommon | `shore` | 58 | 20 |
| `orpiment` | uncommon | `fissure` | 74 | 16 |
| `cinnabar` | rare | `crater` | 290 | 10 |
| `stibnite` | exotic | `vent_field` | 520 | 6 |

**cathedra** — shattered plates, spire fields, a hollow vault
| id/item | rarity | terrain | cr/m³ | count |
|---|---|---|---|---|
| `quartzite` | common | `plain` | 20 | 36 |
| `beryl` | uncommon | `fissure` | 78 | 18 |
| `spectrolite` | rare | `outcrop` | 320 | 11 |
| `lucent` | exotic | `cave` | 620 | 6 |

`size` (node radius, and therefore hold volume via
`max(1, round(size * 1.6))`) is yours to choose, with one rule: **the cheap ore is
the BULKY ore.** That is the whole cargo decision in a 10 m³ Kestrel versus a
40 m³ Dray, and a planet whose nodes are all one size has thrown it away. Cinder
runs 1.60 m for 6 cr/m³ tephra down to 0.62 m for 310 cr/m³ iridite.

### Landing sites

Two or three per planet. Exactly one `primary`. The primary is where the player
arrives on foot when the world is entered directly, so it must reach the common
and uncommon ore. At least one other pad exists to make the **exotic** tier
reachable — that is its job.

### The two planets with a special requirement

**`lathe`** — the payoff of the whole trip is that **Ceraunus and its rings fill
the sky**. Use the `space` sky's `planetDirection`, `planetAngularRadius`,
`planetLand`, `planetOcean` and `planetAtmosphere` params. **Compute the direction
and angular radius from `BODY_BY_ID.lathe` and `BODY_BY_ID.ceraunus` in
`src/worlds/space/Bodies.js`** — import them, do the arithmetic in a `const` above
the descriptor, and put plain numbers in the record. Do NOT type the numbers in by
hand: two copies of one fact, and the second goes stale the day the moon moves.
(`Bodies.js` imports no `three` and is plain data, so importing it is safe.)
For reference, Ceraunus is 108,300 m away with a 38,000 m radius — about 19° of
angular radius, a fifth of the visible hemisphere edge to edge.
Note the `space` sky does not draw ring geometry; get the ring read from the
planet params and say in a comment what is and is not represented.

**`shoal`** — this is the only planet whose `liquid` is a real sea rather than a
few bodies. `liquid.bodies` are AUTHORED surfaces at authored heights, not derived
from the terrain: Volcanic.js records that a lake whose level came out of a `min()`
over its basin **tilted twelve metres** across a single circle, and the fix was a
`pad` (a LEVEL) rather than a `basin` (a DELTA) under it. Your islands must stand
out of a flat sea. Check whether `PlanetWorld` supports swimming or whether water
is a wall — `PlanetWorld.js` sets `swim: false` — and design so the player is never
required to enter water they cannot swim in. Say what you found.
