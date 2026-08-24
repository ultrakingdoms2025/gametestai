# `pixel-attribution` — which object drew this pixel?

```
node scripts/pixel-attribution/sweep.mjs     --world medieval --view hills-vista
node scripts/pixel-attribution/attribute.mjs --world citadel  --view tower-top,souk-roofs
```

## Why this exists

`scripts/world-shot.mjs --ablate` is the repository's only tool for "which
system owns this pixel", and it answers the question **over the active world's
group only**:

```js
window.GAME.worldManager.active?.group?.traverse(...)
```

That is the right scope for a world art pass and the wrong scope for a defect
hunt. Several systems add their renderables **straight to the scene** because
they outlive any one world — `Relics` is two `InstancedMesh`es parented to
`scene`, `Loot` has its own group, `VFX`, `Projectiles` and the viewmodel are
all outside every world group. None of them can be ablated, counted or even
*named* by a world-group walk, and a sweep that hides "each of the 69 material
names in turn" is hiding 69 of the world's names while the culprit is not on
the list at all.

Five art branches looked for the source of a bright white artefact in two
worlds and none found it, because every instrument any of them had stopped at
the world group. This tool starts at `scene`.

## What it does

Both entry points boot the game the way `scripts/world-shot.mjs` does — same
CDP flow, same real-GPU ANGLE path, same `gameplayDriven: true` guarantee — and
then work entirely in pixels.

- **`sweep.mjs`** catalogues every visible renderable *leaf* in the whole
  scene, hides each one in turn, and reports which screen regions moved. One
  render per object; ~800 objects in about 13 s. It answers "what draws this"
  with no hypothesis at all.
- **`attribute.mjs`** takes a named suspect and proves or clears it: projection
  of its instances onto the frame, a full-frame ablation diff, a footprint
  count, and the two searches that produce *false negatives* on it (a raycast,
  and a nearest-object search ranked by metres instead of by angle).

## The three things that make the numbers trustworthy

1. **The ablation and the pixels that judge it happen in one JavaScript task.**
   `hide → postfx.render(0) → gl.readPixels → restore`, synchronously, so the
   rAF loop cannot slip a frame in between and no result is a comparison of two
   different moments. `Engine` sets `preserveDrawingBuffer` whenever `?dev=1`,
   which is how this page is booted, so the readback is the frame that was just
   composited rather than transparent black.

2. **`dt` is exactly 0.** `PostFX.render(dt)` advances `_time`, and the film
   grain keys its noise on `_time`. At `dt = 0` the frame reproduces
   bit-for-bit. Measured null pair over a whole 1600×900 frame in three
   framings: **peak ΔLum 0.0, 0 pixels over 1.0**. Every figure this tool
   prints carries that floor beside it.

3. **Leaves only, never a `Group`.** Hiding a group can hide a light under it,
   and `WebGLRenderer.projectObject` drops a hidden light from the light count,
   which re-keys every shader program in the scene (see `src/gfx/LightAnchor.js`).
   An ablation that recompiles the world is not an ablation, it is a different
   session.

## The trap it was built to avoid

A nearest-object-to-ray search ranked by **metres off the axis** is dominated
by the player's own viewmodel, which sits 10 cm from the lens and 1–9 cm off
every ray in the frame. The quantity a screen pixel measures is an **angle**.
The same search ranked by `perp / along` puts the real source first:

```
@(569,673)
   by ANGLE : relics#36 3.62mrad (0.29m @80.1m) | relics:glow#36 3.62mrad | SkinnedMesh 86.64mrad
   by METRES: Mesh 0.05m @0.1m | Mesh 0.09m @0.1m | Mesh 0.09m @0.1m
```

Both rankings are printed, always, so the failure mode is visible rather than
inferred.
