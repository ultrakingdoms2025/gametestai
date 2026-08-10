# Asset licence ledger

Every external or authored file under `public/assets/` gets a line here on the
day it lands, whether or not its licence carries an attribution obligation.
`scripts/tests/maze-assets.test.mjs` enforces both halves: every manifest
entry's licence must come from the allow-list below, and every entry's id must
appear in this file.

## Allow-list

| Licence | Obligation |
|---|---|
| `CC0-1.0` | None. Preferred for anything fetched from outside. |
| `CC-BY-4.0` | Attribution REQUIRED - the line here must name the author and source URL. |
| `proprietary-owned` | None - the project owns it outright. |
| `generated` | None - produced by a script in this repository (or a generator whose terms are recorded on its line). |

Anything else - Sketchfab's per-model terms especially - is not accepted. If a
model is worth an exception, the exception goes through the allow-list in the
test, deliberately, in its own commit.

## Ledger

| id | file | licence | source | fetched/made |
|---|---|---|---|---|
| `newel-finial` | `public/assets/maze/newel-finial.glb` | `generated` | `scripts/make-newel-glb.mjs` - procedural turned newel post (plinth, coved shaft, collar bead, acorn finial), authored by this repository's own script against three.js `LatheGeometry`. No external source, no generator service, nobody owed attribution. Re-running the script reproduces the file. | 2026-08-10 |
| `surf-hedge-albedo`, `surf-hedge-normal`, `surf-hedge-orm` | `public/assets/maze/tex/hedge-*.ktx2` | `CC0-1.0` | ambientCG **Moss002** (<https://ambientcg.com/view?id=Moss002>), fetched as <https://ambientcg.com/get?file=Moss002_2K-JPG.zip>. Colour, NormalGL, AmbientOcclusion and Roughness maps; ORM packed offline to the glTF convention (R=AO, G=roughness, B=metalness, metal=0) and the set compressed to KTX2 at 2048px (ETC1S for albedo/ORM, UASTC for the normal map). No attribution owed; recorded because every external file gets a line. | 2026-08-10 |
| `surf-floor-albedo`, `surf-floor-normal`, `surf-floor-orm` | `public/assets/maze/tex/floor-*.ktx2` | `CC0-1.0` | Poly Haven **Dirt Floor** (<https://polyhaven.com/a/dirt_floor>), fetched as `dirt_floor_{diff,nor_gl,arm}_2k.jpg` from <https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/dirt_floor/>. Poly Haven's `arm` map is already the glTF ORM layout; compressed to KTX2 at 2048px (ETC1S albedo/ORM, UASTC normal). Physical scale 2.07m per tile, per the asset's own metadata. | 2026-08-10 |
| `surf-stair-albedo`, `surf-stair-normal`, `surf-stair-orm` | `public/assets/maze/tex/stair-*.ktx2` | `CC0-1.0` | ambientCG **Travertine003** (<https://ambientcg.com/view?id=Travertine003>), fetched as <https://ambientcg.com/get?file=Travertine003_2K-JPG.zip>. Pale banded travertine for the stair/shaft-wall stonework; ORM packed offline (metal=0), downsampled to 1024px before KTX2 compression - the stair budget class was 512px procedural, and 1024 authored is already a step up. | 2026-08-10 |
| `surf-footing-albedo`, `surf-footing-normal`, `surf-footing-orm` | `public/assets/maze/tex/footing-*.ktx2` | `CC0-1.0` | Poly Haven **Castle Wall Slates** (<https://polyhaven.com/a/castle_wall_slates>), fetched as `castle_wall_slates_{diff,nor_gl,arm}_2k.jpg` from <https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/castle_wall_slates/>. Weathered stacked stone courses for the hedge footings; downsampled to 1024px before KTX2 compression. Physical scale 2.5m per tile, per the asset's own metadata. | 2026-08-10 |
| `surf-tunnel-albedo`, `surf-tunnel-normal`, `surf-tunnel-orm` | `public/assets/maze/tex/tunnel-*.ktx2` | `CC0-1.0` | Poly Haven **Park Dirt** (<https://polyhaven.com/a/park_dirt>), fetched as `park_dirt_{diff,nor_gl,arm}_2k.jpg` from <https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/park_dirt/>. Warm packed dirt with fine debris for the tunnel treads; downsampled to 1024px before KTX2 compression. Physical scale 3m per tile, per the asset's own metadata. | 2026-08-10 |
