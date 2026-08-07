# Maze-world fixes: the crowd that shouldn't be there

## Bug 1 — `NPCManager` always tops the friendly population up to a crowd

`NPCManager.spawnForWorld` reserves six friendly slots (`CROWD_RESERVE`) off
every world's authored budget and hands the rest — `maxFriendlies -
friendlyCount`, `maxFriendlies` being `max(CONFIG.npc.friendlyCount, 30)` —
to `_populateHubs`, which clusters the world's own named spawns into hubs and
fills each with generic crowd civilians (`CROWD_NAMES`/`CROWD_PERSONAS`, or
themed named roles via `castFor`/`ROLE_CAST`). That is right for a station
plaza and wrong for a hedge maze whose entire point is being alone.

Fix: added a `crowd` capability to `src/worlds/WorldRules.js` (defaults to
`true`, documented alongside its neighbours), set `crowd: false` in
`MazeWorld`'s `makeRules({...})` call, and in `NPCManager.spawnForWorld`:

```js
const crowdAllowed = allows(world, 'crowd');
...
const CROWD_RESERVE = crowdAllowed ? 6 : 0;
const authoredCap = crowdAllowed
  ? Math.max(4, Math.min(authored, this.maxFriendlies - CROWD_RESERVE))
  : authored;               // every authored friendly gets a slot, no reserve held back
...
this._populateHubs(anchors, crowdAllowed ? this.maxFriendlies - friendlyCount : 0);
```

Zeroing the hub budget is the same "zeroed budget" convention already used
for `hostiles` two lines above it (`maxHostiles = hostilesAllowed ?
this.maxHostiles : 0`) — `_populateHubs` already returns immediately when
`budget <= 0`, so no change was needed inside that method itself.

## Bug 2 — the maze fell back to the station theme

`THEME_BY_WORLD[world.id] ?? 'station'` had no `'maze'` entry, so
`this.theme` silently became `'station'` for the maze, and every
theme-keyed table downstream (`FALLBACK_NAMES`, `CROWD_NAMES`,
`CROWD_PERSONAS`, `ROLE_CAST` via `castFor`) followed it there. That is
exactly where "Quartermaster Bex", "Dockhand Priya Kaur", "Deck Warden
Ilse", "Observer Nell Yeong", "Rigger Osei Mensah" and "Broker Sunil Rai"
came from — all six are named entries in `ROLE_CAST.station` in
`src/npc/NPCRoles.js`, handed out by `_populateHubs` → `castFor(this.theme,
role, roleIdx)` once `this.theme` had silently resolved to `'station'`.

Fix: added `maze: 'maze'` to `THEME_BY_WORLD`, and correct `'maze'` entries
to every companion table found by grepping for the theme keys
(`station:`/`medieval:`/`sports:`) across `src/npc/NPCManager.js` and
`src/npc/NPCRoles.js`:

- `FALLBACK_NAMES.maze` — anonymous, atmosphere-appropriate names (`'A Lost
  Wanderer'`, `'Someone Turned Around'`, ...) for the case an authored spawn
  forgets a `name`. Currently unreachable: all nine of `MazeWorld`'s spawns
  are named. Fixed anyway, per the same reasoning class as bug 1 — an
  unreachable wrong fallback is still wrong, and is exactly the kind of
  thing that resurfaces the next time someone touches this code without
  reading every call site first.
- `CROWD_NAMES.maze` / `CROWD_PERSONAS.maze` — names and one-line personas
  fitting people lost in a hedge maze, for `_populateHubs`'s fallback path
  when a role has no themed cast. Unreachable while `crowd: false`.
- `ROLE_CAST.maze` (`src/npc/NPCRoles.js`) — a `GUARD`, a `SPECTATOR` and
  two `LOITERER` entries, written with the same "job, opinion, grievance"
  shape as the other three themes, names chosen not to collide with
  `MazeWorld.WANDERER_CAST`. Unreachable while `crowd: false` (`castFor` is
  only called from `_populateHubs`).

None of these three are load-bearing for the bug fix itself (`crowd: false`
already makes `_populateHubs` a no-op for the maze), but the task explicitly
asked to make the fallback *correct*, not just unreachable, and the existing
pattern (`FALLBACK_NAMES`, `CROWD_NAMES`, `CROWD_PERSONAS` are grep hits for
`station:`/`medieval:`/`sports:`) made "check for others" turn up exactly
these tables and no more — `MERCHANT_SIGN_WORLD` and `WEAPON_TABLES` are
keyed by `world.id` and are irrelevant here since maze has no vendors
(`merchants: false`) and no hostiles (`hostiles: false`) regardless of theme.

## Bug 3 — `LOREKEEPER`

Traced with `grep -n LOREKEEPER src/npc/NPCManager.js`. It does not come
from `npcSpawns` at all: `NPCManager._spawnLorekeepers(world)` iterates
`world.portalSpecs` and spawns one auto-generated lorekeeper NPC per portal,
positioned 2.6 m off the portal, named from
`loreEntryForScope(world.id).sign_label` (uppercased — which is why the name
was literally `"LOREKEEPER"`, the generic default, since no lore entry is
registered for `'maze'`). `MazeWorld.build()` sets `this.portalSpecs = [{
target: 'station', ... }]` for the return arch, so `_spawnLorekeepers` fired
once — one lorekeeper the maze never authored, appearing before any
`npcSpawns` were even pushed to `this._npcs` in that call. It is redundant
with, and inconsistent in tone with, the hand-authored "Keeper of the Coil"
NPC (`role: 'lorekeeper'`) that `MazeWorld._populate` already places at the
forecourt.

Fix: gated `_spawnLorekeepers` itself, at the top:

```js
_spawnLorekeepers(world) {
  if (!allows(world, 'crowd')) return 0;
  ...
```

`_spawnQuestManagers` was checked too (`grep -n _spawnQuestManagers`) —
it looks up a fixed `CAST` table keyed by `world.id`, has no `'maze'` entry,
and already returns `0` for the maze with no change needed. Left ungated on
purpose: gating something that is already always a no-op for this world
would be a change with no observable effect and one more place for the
`crowd` semantics to be second-guessed later.

## Regression check — the four/five pre-existing worlds

`allows()` returns `true` when the flag is absent from a world's `rules`
(and `DEFAULT_RULES.crowd = true`), and grep across `src/worlds/*.js`
confirms only `MazeWorld` sets `crowd: false` — station, medieval, sports,
citadel and race are untouched. `crowdAllowed` is `true` in every one of
them, so `CROWD_RESERVE` stays `6`, `authoredCap`'s ternary takes the
original branch unchanged, and `_populateHubs`'s budget is still
`this.maxFriendlies - friendlyCount` — byte-for-byte the pre-existing
behaviour.

Verified live, not just by inspection (dev server on port 5173,
`http://localhost:5173/game/?dev=1&autostart=1&world=maze`, driven with
chrome-devtools MCP):

```
GAME.worldManager.active.npcSpawns.length  →  9
GAME.npcManager.npcs.length                →  9
GAME.npcManager.npcs.map(n => n.name)      →  [
  "The Keeper of the Coil", "Corvin Ashe", "Marta Wren", "Ossian Drell",
  "Pip", "Rue Calder", "Isolde Farr", "Bram Otts", "Ansel the Still"
]
```

No `LOREKEEPER`, no station crowd names. Console log confirms independently:
`[World] built "maze" in 320ms (161168 colliders, 9 npc spawns)`.

Then `await GAME.worldManager.activate('station')`:

```
GAME.npcManager.npcs.length       → 41
GAME.npcManager.friendlies.length → 31
GAME.npcManager.hostiles.length   → 10
```

41 total — comfortably in the station's normal populated range (higher than
the 30 the maze wrongly inherited from the top-up), not dropped. Console
also logged `[World] built "station" in 11148ms (25166 colliders, 33 npc
spawns)` for that pass, matching the station's usual authored count. No new
console errors attributable to this change (the pre-existing `502 Bad
Gateway` / `[lore] remote lore unavailable` warnings are the lore backend
being unreachable in this environment, unrelated to `NPCManager` or
`WorldRules`, and predate this change).

## Tests added (`scripts/tests/rules-applied.test.mjs`, `scripts/tests/world-rules.test.mjs`)

Following the file's existing "grep the stripped source for a live
`allows(...)` call" convention (`NPCManager.js` touches WebGL at module
scope and can't be imported under Node):

- Added `['src/npc/NPCManager.js', 'crowd']` to the `GATES` loop — proves a
  real `allows(..., 'crowd')` call and the `WorldRules.js` import both exist
  outside comments.
- Added `'crowd'` to the flag list in `'MazeWorld declares itself volatile
  and forbids the right things'`, so that test now also asserts
  `crowd: false` appears in `MazeWorld.js`.
- Added `'crowd'` to `world-rules.test.mjs`'s `GATED` list (defaults to
  `true`) and to the maze rule-set object in `'the maze rule set forbids
  exactly what the spec says'`.
- New test: `'NPCManager gives the maze its own theme rather than falling
  back to station'` — asserts `THEME_BY_WORLD` contains a `maze: 'maze'`
  entry, so a lapsed fallback can't quietly regress back to the station
  theme.

### Proof the tests go red

Replaced every `allows(world, 'crowd')` occurrence in `NPCManager.js`
(both call sites: the `crowdAllowed` computation in `spawnForWorld` and the
early return in `_spawnLorekeepers`) with `allows(world,
'TEMP_SABOTAGE_crowd')` via a single find/replace, then ran
`node --test scripts/tests/rules-applied.test.mjs`:

```
not ok 11 - src/npc/NPCManager.js honours crowd
  error: "src/npc/NPCManager.js has no allows(..., 'crowd') gate outside comments"
```

— the exact gate test failed, nothing else did. Restored with a second
find/replace back to `allows(world, 'crowd')` (not `git checkout --`, since
that would have discarded the real, not-yet-committed fix along with the
sabotage — the substitution was reverted verbatim instead). Re-ran the same
file: `26/26` pass, and `git diff --stat src/npc/NPCManager.js` showed the
same `44 ++++/4 --` shape as before the round trip, confirming a clean
restore with no stray leftovers.

## Command output

- `npm test` → `# tests 102`, `# pass 102`, `# fail 0`.
- `node scripts/contract-check.mjs` → `contract-check: 42/42 files present` /
  `All contracts satisfied.`
- `npm run build` → `✓ built in 1.39s`, only the pre-existing "chunks larger
  than 500 kB" advisory (present before this change, unrelated to it).

## Files touched

- `src/worlds/WorldRules.js` — new `crowd` rule flag.
- `src/worlds/MazeWorld.js` — `crowd: false` in `makeRules`.
- `src/npc/NPCManager.js` — `crowdAllowed` gate around `CROWD_RESERVE` /
  `authoredCap` / `_populateHubs`'s budget; early return in
  `_spawnLorekeepers`; `maze` entries in `THEME_BY_WORLD`, `FALLBACK_NAMES`,
  `CROWD_NAMES`, `CROWD_PERSONAS`.
- `src/npc/NPCRoles.js` — `ROLE_CAST.maze`.
- `scripts/tests/rules-applied.test.mjs` — `crowd` gate test, `crowd` added
  to the `MazeWorld` flag-coverage test, new `THEME_BY_WORLD` maze-entry
  test.
- `scripts/tests/world-rules.test.mjs` — `crowd` added to `GATED` and to the
  maze rule-set assertion.
