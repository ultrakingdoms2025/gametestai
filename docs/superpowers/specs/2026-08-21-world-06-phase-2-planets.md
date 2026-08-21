# World 06, Phase 2 — Many Planets

**Status:** in build, branch `space-dock`.
**Supersedes nothing.** Extends `2026-08-19-lodestar-yard-design.md`, which built
Phase 1 (the yard, flight, combat, one landable planet).

---

## What the user asked for

> "i can fly all over space in my ship, many different planets, some maybe with
> rings, each different terrain… each planet allows me to reach fly through its
> atmosphere and land, explore the unique terrain and mine for minerals."

Four promises, and each one is a gate this phase is judged on:

1. **fly all over space** — the volume must be crossable. It currently is not; see
   "The travel defect" below.
2. **many different planets, some with rings** — ten landable worlds, and a ring
   system you fly *through* rather than look at.
3. **each different terrain** — different has to mean different at a glance from
   the ground, not a recoloured Cinder.
4. **land, explore, mine** — every planet lands, every planet has ore that is
   *its* ore, and the ore has to be somewhere that costs something to reach.

---

## The keystone decision, restated

**Planet surfaces are ONE parameterised world.** `src/worlds/PlanetWorld.js` is
driven by `src/worlds/planets/PlanetDescriptor.js`. Ten planets cost ten
descriptors: no second world class, no second height function, and no
`if (planet.id === ...)` anywhere in the renderer.

If a planet needs a SHAPE nobody has built, the shape is added to the shared
vocabulary — `terrain/PlanetHeight.js` for landforms, `planets/PlanetProps.js`
for props — where every other planet gets it too. That is the only sanctioned way
to grow the system, and it is why this phase begins with a vocabulary pass.

---

## The travel defect, and the Transit Drive

`space/Bodies.js` laid the system out against an **assumed** envelope of
"cruise 260 m/s, boost 1600 m/s", and said in as many words to re-derive it when
the flight model landed.

The flight model landed and it is nothing like that:

| quantity | source | value |
|---|---|---|
| cruise top speed | `thrust / drag` = 78 / 0.65 | **120 m/s** × powerMul |
| hard cap (boost only) | `FLIGHT.hardCap` | **260 m/s** × powerMul |
| boost duration | `boostEnergy / boostDrain` = 100 / 30 | **3.33 s** |

So sustained cruise is 120–285 m/s, and **Cinder at 62 km is a 517-second flight**
— eight and a half minutes of holding one key in a straight line. That is a defect
at *one* planet. Ten planets out to ~290 km would be forty minutes to the far one.

Shrinking the volume is not the fix: the distances and radii were chosen so the
sky reads with depth (see the screen-fraction table in `Bodies.js`), and collapsing
them turns a solar system into a diorama.

**The fix is a Transit Drive** — a separate high-speed mode whose top speed is
governed by altitude above the nearest body:

```
maxTransitSpeed = clamp(altitude * K, cruiseTop, TRANSIT_TOP)
```

That one law does four jobs at once: it makes the volume crossable, it decelerates
the ship automatically as it closes so there is no overshoot, it hands the ship to
`approachState()` already at a sane speed, and it needs no separate drop-out rule.
Mass lock (no transit inside a body's `approach` phase or inside dock handoff) is
the only extra rule.

Target: **62 km in 15–25 s, 290 km in 60–90 s.** Near worlds are a hop; the far
ones are a journey of about a minute. Exact constants are measured, not guessed,
and pinned by `scripts/tests/ship-transit.test.mjs`.

---

## The roster

Ten landable worlds, plus the gas giant, the star and the belt as scenery. Every
one of the five directions the user named is spoken for, and the four new
distances fill the gaps between the existing ones so the sky has depth in every
bearing.

| # | Body | kind | dist km | radius m | direction | the one thing it is |
|---|---|---|---|---|---|---|
| 1 | **Cinder** | rock | 62 | 9 000 | out & down | volcanic — caldera, lava lakes, fissures *(exists)* |
| 2 | **Tessera** | moon | 88 | 4 200 | right | airless cratered moonlet — vacuum, low g, black shadows |
| 3 | **Sirocco** | rock | 118 | 11 000 | down & right | desert — dune seas, salt pans, a slot canyon |
| 4 | **Shoal** | rock | 142 | 12 500 | down & left | ocean archipelago — islands, shallow shelf, a tidal chasm |
| 5 | **Vitrine** | ice | 155 | 15 000 | straight ahead | ice — crevasse fields, pressure ridges, a subglacial cave |
| 6 | **Verdigris** | rock | 176 | 10 200 | up & right | biotic — canopy mesas, river gorges, standing growth |
| 7 | **Carnelian** | rock | 205 | 8 400 | far right & up | red iron highlands — scarps, dust, a deep gorge |
| 8 | **Sallow** | rock | 232 | 7 600 | far down | toxic — acid lakes, fumarole fields, yellow air |
| 9 | **Ceraunus** | gas | 245 | 38 000 | out & up | ringed gas giant — **not landable, it has no surface** *(exists)* |
| 10 | **Lathe** | moon | ~250 | 2 600 | out & up, in the rings | ring shepherd — land with the rings arched overhead |
| 11 | **Cathedra** | rock | 288 | 6 800 | far ahead & up | crystal — shattered plates, spires, a hollow vault |
| — | Erenmark | star | 640 | 15 500 | behind & up | the primary, and the light *(exists)* |
| — | Halberd Reach | belt | 26 | — | left | debris field *(exists)* |

**Ceraunus stays unlandable and that is a feature.** "Gas giant. No surface." is a
true fact about a gas giant, and the answer to a player who flies out to it is
**Lathe** — a shepherd moon parked just outside the outer ring edge, so the trip
that looked like a dead end is the trip with the best view and the richest ore in
the system. Flying to Lathe means flying through the ring plane.

**Erenmark is BEHIND on purpose** and must stay there. Everything the player flies
toward is front-lit rather than a silhouette, and when they are lost, the way home
and the brightest thing in the sky are the same bearing. That is navigation for
free, and it is the reason the whole layout works.

---

## The economy: value climbs with distance

An ore is a reason to fly somewhere. If the ore 288 km out is worth the same as the
ore 62 km out, the far planets are scenery with a mining prompt on them.

So the value bands climb with the leg, and *within* each planet the four-rung ladder
`PlanetDescriptor` enforces (contiguous from `common`, value ascending strictly
between tiers, count never ascending, rarest never on the flat) does the local work.

| planet | km | common | uncommon | rare | exotic |
|---|---|---|---|---|---|
| Cinder | 62 | 6, 16 | 34, 52 | 190 | 310 |
| Tessera | 88 | 7 | 22 | 140 | 240 |
| Sirocco | 118 | 8, 14 | 30, 46 | 175 | 285 |
| Shoal | 142 | 10 | 36 | 200 | 340 |
| Vitrine | 155 | 12, 20 | 44 | 215 | 380 |
| Verdigris | 176 | 14 | 48, 62 | 240 | 430 |
| Carnelian | 205 | 15 | 52 | 260 | 470 |
| Sallow | 232 | 17 | 58, 74 | 290 | 520 |
| Cathedra | 288 | 20 | 78 | 320 | 620 |
| Lathe | ~250 | 22 | 88 | 360 | 700 |

Lathe is out of order on distance and dearest on value **on purpose**: it is the
hardest place in the system to reach, because reaching it means crossing a ring
plane, and the reward has to say so.

`unitValue` is **credits per cubic metre of hold**, not per node. The node's size
is its hold volume (`holdUnitsFor` = `max(1, round(size * 1.6))`, the same 1.6
`Piloting.stow` charges), so the cheap ore must be the BULKY ore. That is the
entire cargo decision in a 10 m³ Kestrel versus a 40 m³ Dray, and a planet whose
ores are all the same size has thrown it away.

---

## Vocabulary added this phase

Added to the shared vocabulary, so every planet gets them:

**Landforms** (`terrain/PlanetHeight.js`)
- `crater` — bowl with a RAISED ANNULAR RIM. `basin` alone gives a dent; the rim
  is what makes a crater read as a crater. Tessera, Lathe, Carnelian.
- `dunes` — transverse ridges with an asymmetric slip face. Sirocco.
- `scarp` — a cliff along a POLYLINE. A canyon rim and a fault block are lines,
  not circles. Carnelian, Cathedra, Sirocco.

**Props** (`planets/PlanetProps.js`)
- `spires` — faceted tapering pinnacles. Vitrine, Cathedra.
- `growth` — trunk plus canopy. Verdigris.
- `slabs` — tilted plates. Cathedra, Vitrine, Carnelian.

**The rule that governs all six:** the primitive is the problem. This project shipped
spacecraft made of 197 stacked boxes and was rejected three times for it. Nothing
organic or crystalline gets built out of stacked boxes, and no art is ever assessed
by re-reading the code that made it — it is screenshotted and looked at.

---

## What every descriptor must satisfy

`definePlanet()` throws on all of this; the list is here so it is designed for
rather than discovered:

1. Every `landing` site has a matching `pad` landform at the same coordinates, at
   least as large. *A landing site that is only an assertion is how "built but not
   reachable" gets shipped.*
2. Exactly one landing site is `primary`.
3. The rarity ladder is contiguous from `common`; `unitValue` ascends strictly
   between tiers; `count` never ascends between tiers.
4. The rarest tier is never `terrain: 'plain'` and never a `field` region. *A rare
   element underfoot at the pad is a common element with a better name.*
5. `credits` is DERIVED and authoring it is refused.
6. The descriptor is plain data end to end — no functions, no class instances, no
   `three` import. It crosses `postMessage` to the terrain worker, and a closure
   clones to `undefined`, which returns a silently flat world.
7. `palette.bands` ascend by `upTo` and there are at least two.

And two things the validator cannot catch, which are therefore the review:

8. **The ore must be walkable to.** `planet-minerals.test.mjs` floods the real
   colliders from each pad. A seam at the bottom of a vertical fissure is content
   behind glass.
9. **The bands must move in HUE and SATURATION, not only in value.** Cinder shipped
   six bands across five degrees of hue and zero saturation change, and a tester
   wrote: "one flat salmon-brown hue, no rock, no ash, no shadows." Value structure
   alone is a black-and-white photograph of a planet.

---

## The two rules from Phase 1 that killed a day each

**NaN, not lighting.** When a world renders dark, check for NaN before touching a
light. Four meshes shipped with `tile = 0` → NaN uvs → `UnrealBloomPass`
high-passes and blurs through five mips, and a weighted sum containing NaN is NaN.
**19 NaN pixels blacked out 921,600.** Flooding ambient 27× moved the mean by 0.07
because there was no image to brighten.

**Fog is what makes a horizon.** Cinder's first fog was darker AND more saturated
than the rock it hung over, at a `far` shorter than the map diagonal, and the whole
planet lived inside a 9-luma band. Fog must be **lighter and greyer** than the
ground bands under it, and `far` must exceed the playfield diagonal
(`half * 2 * √2`) or the player sees the world stop.

---

## Order of work

1. Vocabulary — landforms, props, Transit Drive. *(blocks everything)*
2. Ore rows in `ItemDefs.js` and the body layout in `space/Bodies.js`. *(one hand,
   because they are global ladders and nine hands would make nine ladders)*
3. Nine descriptors, one file each, in parallel.
4. Registration: the planet registry, and every silent per-world table.
5. Objectives and the economy retuned for ten planets rather than one.
6. Verification: a headless per-planet probe, screenshots, and a playthrough agent
   whose only job is to play cold and be harsh.
7. Merge to `main`, **rebuild the committed bundle**, push.

Step 7's middle clause is not a formality. The site serves a COMMITTED bundle from
`site/public/game`; a merge without `cd site && npm run bundle-game` ships nothing.
