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
