# AETHER NEXUS — v4 backlog

> ## ⚠️ SUPERSEDED — 2026-08-22
>
> **Items 2, 4 and 5 are DONE.** The fix they propose — making the light count
> constant so Three stops invalidating its program cache — shipped as
> `src/gfx/LightRig.js`: a fixed pool of 19 slots added once at boot, with every
> other light demoted to a hidden source copied into a slot per frame. The
> deployed bundle contains it.
>
> Item 2 specifically: `car` **is** in `mounts.prebuild()` (`main.js:1012`), and
> `Car._buildLightRig()` runs from the constructor. Item 3 (assets outside map
> borders) has not been checked and may still stand.
>
> Planning from this file will re-solve a solved problem. Current state:
> `docs/superpowers/specs/2026-08-21-implementation-brief-roadmap.md`, Phase 1.

Reported by the user after the v3 batch. Addressed once the six v3 agents land.

---

## 1. Hoverboard rider is wrong way round, and rigid

The rider faces the wrong direction on the hoverboard and holds a stiff T-shaped pose.
Needs a real hoverboard stance: side-on stance (leading foot forward, feet across the
board, not along it), knees flexed, torso twisted toward the direction of travel, arms out
for balance, weight shifting into carves, crouching into boost, and absorbing bumps.

The seated-rider machinery from the dragon harness (`MountManager._poseSeated`,
`_solveIK`, `_aimTip`, and the world-space target pattern used for stirrups and grips) is
the right tool — pose the feet onto board-mounted foot targets the same way.

Owner: MOUNTS (`Hoverboard.js`, `MountManager.js`).

---

## 2. Car takes a very long time on first use

Same class of bug as the old 63-second bow freeze. `Car.js` only landed this round so it
is not in the boot warmup yet, and its headlights/brake lights change the scene light
count, which invalidates Three's whole program cache.

Fix: add `'car'` to `mounts.prebuild()` and to the configuration warmup in `main.js`.
See item 5 — the proper fix probably removes the need for per-mount warming entirely.

Owner: orchestrator (`main.js`) + MOUNTS.

---

## 3. Assets spawn outside the map borders

Trees (and possibly other scattered props) populate beyond the playable bounds. Scatter
passes are not clamping to `world.bounds`, or are clamping to the heightfield extent
rather than the playable area.

Owner: per-world (`MedievalWorld.js`, `SportsWorld.js`, `StationWorld.js`).

---

## 4. First-use freeze returns after portaling to another world

The boot warmup compiles the configurations that exist **in the world loaded at boot**.
Entering a new world introduces new materials and a different light set, so the first
weapon switch or camera change in that world recompiles again.

Owner: orchestrator + POSTFX. See item 5.

---

## 5. First load takes 5+ minutes on PC; Android is fine

**These three (2, 4, 5) are almost certainly one root cause.** Three.js keys its shader
program cache on light counts, so every time a light is added or removed — selecting a
weapon, summoning a mount, changing world — every material in view is invalidated and
recompiled. The current warmup papers over this by *playing through* each configuration at
boot, which is why boot got so slow: it is compiling the cartesian product of
configurations, ~390+ programs, through ANGLE/D3D11 on PC. Android uses a different
backend and a warmer driver cache, which fits the reported difference.

Proper fix, in order of value:

1. **Make the light count constant.** Attach every weapon light rig and mount light
   permanently at construction and toggle `intensity`/`visible` state that does *not*
   change the program key, instead of parenting and unparenting lights. One light
   configuration means one compile, and the whole per-configuration warmup can go away.
2. **Cut the program count.** ~390 programs is a lot; audit for near-duplicate materials
   that could share a single instance.
3. **Warm asynchronously after the menu appears** rather than before it, so the player sees
   the title card immediately and compilation finishes during the menu.
4. Keep `compileAsync` (it uses `KHR_parallel_shader_compile`), and confirm the extension
   is actually present on the PC target — if it is missing, compilation is fully
   synchronous and that alone would explain the platform gap.

Owner: orchestrator + POSTFX + WEAPONS + MOUNTS.

---

## 6. Character selector

A menu to configure the player character: sex (man — current — and woman), hair colour,
shirt colour, trouser colour, and ideally skin tone, height/build and hair style, since
`Humanoid.js` already parameterises all of those (`makeProportions`, `SLOT`,
`THEME_VARIANTS`, `SKIN_TONES`).

Must persist through `SaveGame` and apply to `PlayerAvatar` (and to the mount rider proxy,
which currently builds a hardcoded figure — seed 20260726, theme 'station', variant 'rig').

Owner: new CHARACTER agent (`src/ui/CharacterMenu.js`, `src/player/PlayerAvatar.js`,
`MountManager._ensureRider`, `SaveGame.js`).

---

## 7. NPCs flicker and glitch when they overlap or get stuck

Reported by the user: when NPCs walk together, overlap each other, or jam against an
object, they start glitching and flickering repeatedly.

Two distinct faults are likely stacked here, and both need checking:

- **Positional jitter.** Separation steering and wall avoidance are fighting: each frame
  the NPC is pushed out, walks back in, and is pushed out again. Needs hysteresis, a
  damped resolve, or a priority order between "avoid wall" and "avoid neighbour" so the
  two cannot oscillate. The same fault explains jamming against props.
- **Render flicker.** Two overlapping NPCs at the same depth z-fight, and/or the LOD
  detail toggle (`setDetailVisible`) thrashes on and off across its distance threshold
  when a neighbour perturbs the measured distance. LOD needs hysteresis (separate
  in/out thresholds), and coincident characters need depth separation.

Reproduce by driving several NPCs to the same waypoint and watching from 3-5 m.

Owner: NPC (`Navigation.js`, `NPCManager.js`, `NPC.js`).

---

## 8. Sword swing is glitchy and leaves large black triangles

The edge trail ribbon is rendering as opaque black geometry. Typical causes: a trail mesh
built with degenerate or unordered vertices, a material that is neither transparent nor
additive, `depthWrite` left on, missing `side: DoubleSide`, or a ribbon whose first frames
contain uninitialised positions at the origin (which produces exactly the "big triangle
from nowhere" artefact).

Owner: WEAPONS (`Sword.js`).
