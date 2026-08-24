# Phase 9 · `art-medieval` — implementation plan

Spec: `docs/superpowers/specs/2026-08-23-art-medieval-design.md`.

---

## Task 1 — the evidence harness (`scripts/world-shot.mjs`)

Written first, because nothing after it can be judged without it, and because Phase 9 needs
it eight more times.

- CDP + in-process Vite, zero new dependencies, modelled on `scripts/hud-viewport-probe.mjs`.
- Per framing: PNG, `drawCalls`, `worldTriangles` (deterministic walk), `materials`,
  `renderables`, `instancedMeshes`, `instances`, `programs`, `geometries`, `textures`,
  `worldLights` / `worldLightsLit`, `npcs`, fps, and the runtime `errors` list.
- Validity fields recorded next to the numbers, not in a comment: `gameplayDriven` and the
  GL renderer string.
- `--compare <dir>` → `diff.json` + a printed before/after table.
- `--ablate <material names>` → the which-system-owns-this-pixel A/B.
- `--subject "name=<js>"` → three headings on a live, moving subject, with the player walked
  to it first so its LOD band is the one a player sees.
- `--views none` for subject-only runs.

**Done when** it produces `.probe/art-medieval/before/report.json` and seven PNGs with
`gameplayDriven: true` and a hardware GL string.

## Task 2 — baseline

Run it. Record the table into the spec. **Do not change anything first.**

## Task 3 — diagnose what the shots show, by ablation, not by reading

For each defect visible in a shot, name the system with `--ablate` before touching it.

Outcome (see spec §2): the white blow-out is **not** `medieval.glow`; it is
`src/systems/Loot.js`, which is out of this branch's boundary. Report with evidence, do not
fix. This step is the reason nothing was "fixed" that was not broken.

## Task 4 — the authored `.glb` (D4)

Follow the route proven three times, in the order it was proven, and change none of it.

1. **`scripts/make-beast-glb.mjs`** — a committed generator.
   - Exports `FRAME` (the beast-space landmarks read out of `BeastBody.PROFILES`, not
     guessed) and `TRI_BUDGET`, so a test can assert the generator and `BeastBody.js` have
     not drifted apart. The ship generator learned that one the hard way.
   - `WOLF_GLB_*`-style env overrides (`BEAST_GLB_SET`, `BEAST_GLB_OUT`) so the byte-diff test
     can re-run it into a temp file. A generator that can only write its committed path
     cannot be tested.
   - Placeholder glTF materials, so the file opens in a viewer, and a test that asserts the
     game never reads them.
2. **`public/assets/medieval/manifest.json`** — id, file, kind, licence, source, parts, tris,
   bytes, plus `slots` (part → beast material slot) and `species` (which parts each animal
   shows).
3. **`src/worlds/medieval/BeastAssets.js`** — the lazy loader. A near-copy of
   `src/npc/HeroAssets.js` **by intent**: manifest, lazy `GLTFLoader`, parallel fetches with
   an abort signal, per-asset `try`/`catch`, one warning per distinct failure, synchronous
   cache read returning null rather than throwing, `BASE_URL` not `/`, and an
   `installBeastAssets` seam so `node --test` can drive the real weld path with the real
   committed bytes.
4. **`BeastBody.js`** — weld the parts into the merged geometry the animal already draws, in
   the material slot the manifest names. No new mesh, no new material, no new program.
5. **`scripts/tests/beast-assets.test.mjs`** — the full contract: allow-listed licence, a line
   in `docs/assets/LICENCES.md`, manifest `bytes` against the file on disk, `tris` against the
   parsed `.glb`, both directions of the manifest cross-references, no part naming a material
   slot the beast does not own, and the **byte-diff** re-run.
6. **`docs/assets/LICENCES.md`** — a ledger line.

## Task 5 — the `belly` slot

`BeastBody.js:909` clones a material for a colour every profile declares and no mesh ever
uses. Use it, as a merged geometry **group** on the body the animal already draws, so
countershading costs no draw call and the wasted clone becomes a used one.

## Task 6 — `village-street`

`VIEWS.medieval` in `src/dev/Harness.js` puts that camera under the terrain. Raise it onto
the ground it was written for, and pin it with a test so a terrain change cannot bury it
again silently.

## Task 7 — after shots, and the gates

- `world-shot.mjs --compare .probe/art-medieval/before` → the before/after table.
- Subject shots of the wolf and the bear, before and after.
- `npm test`, `node scripts/contract-check.mjs`, `npm run build`.

**The budget gate:** `programs` and `materials` must be unchanged. `drawCalls` must be
unchanged. Triangles may rise only by the authored parts' own reservation.

## Explicitly not done

- No `BatchedMesh` port. The roadmap forbids it and the measurements say there is nothing to
  win: medieval is already merged by material.
- No new light. `worldLightsLit` is 0 — `LightRig` owns all 156 — and a light added for art
  is a boot-time cost.
- No foliage re-authoring. 60% of the world's triangles, already LOD'd on a 150 m grid; a
  phase of its own.
- No change to `src/systems/Loot.js`, `src/main.js`, `src/ui/**`, or any other world.
