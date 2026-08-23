# Phase 4 — `mission-core` ledger

**Design:** `docs/superpowers/specs/2026-08-23-mission-architecture.md`
**Roadmap:** `docs/superpowers/specs/2026-08-21-implementation-brief-roadmap.md` §Phase 4
**Branch:** worktree off `economy-authority` @ `93d809f`. Not pushed, not merged.

**Gates at the end:** `npm test` **2694/2694** (from 2628), `node scripts/contract-check.mjs`
**116/116** (from 114), `npm run build` clean, `node scripts/quest-vocab.mjs` silent.

**Verified in a browser**, not only in tests: booted signed out with the save cleared, watched the
tutorial face take the panel at `game:started`, walked with a real `KeyW` and watched
`player:footstep` advance the first step and the panel move to the second, then watched the panel
hand over to the mission board. The quest service answered 502 throughout — *"quest service
unreachable; the board will show what is bundled and nothing else"* — which is the login cliff the
onboarding exists to route around, demonstrated rather than argued.

---

## 1. What shipped

| | File | What it is |
|---|---|---|
| new | `src/systems/Charters.js` | The charter spine. Eighteen gateways, eighteen records; a record is the union of what a world publishes, and completing one restores that gateway's charter. Also the derived rank, per-world reputation, mastery and collection read surfaces. |
| new | `src/systems/Onboarding.js` | The signed-out opening sequence. Eight steps, each on an event the game already fires; a grant on the fifth; one locked aspirational reward. |
| new | `scripts/tests/charters.test.mjs` | 16 cases, four of them over the REAL built worlds through `_flightrig`. |
| new | `scripts/tests/onboarding.test.mjs` | 15 cases, including a code scrape that fails if the tutorial ever reaches for an account. |
| new | `scripts/tests/race-record.test.mjs` | 10 cases over the new circuit ledger. |
| new | `scripts/tests/quest-verbs.test.mjs` | 11 cases for `mine` and `pilot`, the mining half driven through the real seam on the real Cinder. |
| new | `scripts/tests/charter-hud.test.mjs` | 9 cases; every payload comes from the real producer, not a fixture. |
| edit | `src/systems/SaveGame.js` | The circuit personal-best ledger (`_recordRace`, `raceLedger`, `mergeRaces`, `bestRaceTime`, `_restoreRaces`), plus the `charters` and `onboarding` slices. |
| edit | `src/systems/QuestSystem.js` | Two new step verbs, `mine` and `pilot`, with their target candidates. |
| edit | `src/systems/Mining.js` | Emits `quest:activity{type:'mine'}` beside its existing `collect`. |
| edit | `scripts/quest-vocab.mjs` | Both verbs declared with their emitters; per-planet mineral and landing-pad vocabularies scraped from the descriptors. |
| edit | `src/systems/ProgressSync.js` | Charters, deeds, circuit bests and opening steps cross devices. Rosters deliberately do not. |
| edit | `site/lib/progressLedger.ts` | Four new kinds: `charter`, `deed`, `onboarding` (sets) and `race` (value, `min`). |
| edit | `src/ui/HUD.js`, `src/ui/hud.css` | One panel with two faces — the tutorial, then the mission board. |
| edit | `src/main.js` | Twelve lines: two imports, two constructions, two late wires, the sync payload, the dev handle. |

---

## 2. The decisions worth writing down

### Denominators are learned, and rosters can SHRINK

`SpaceObjectives` keeps its wing roster grow-only and decides its set prize against the live
world, because a deleted zone would otherwise leave a total nobody can reach. A charter cannot
take that deal — it has to draw a row for a world the player is not standing in, so it has no live
world to ask. It takes the other half instead: **each learner replaces exactly its own column of
exactly its own world**, so content that disappears takes its denominator with it on the next
visit. That also makes subscriber order irrelevant, because `relics:changed`,
`viewpoints:changed` and `minigame:armed` all carry their own world id.

### The charter persists NO numerator

Every "have" on the board is recomputed on read from the identity set of the system that owns it.
What is persisted is the learned rosters, the set of restored charters, and the deed set. A save
therefore cannot carry a summary that disagrees with its own detail, which is the defect
`Relics.serialize` had.

### `0 of 0` is not complete

An unvisited world's record is unknown, and `have >= need` is true for `0/0`. Without the
`need > 0` guard a player who had never left the station would hold seventeen charters and the top
rank would be free. Same guard `Viewpoints._onWorld` and `SpaceObjectives.deserialize` both carry.

### Deeds are the one authored column, and they get the emitter rule

Two worlds publish no list and still have a job: the Coil (reach the centre) and the station
(first trade, first mount, first gateway). Those four deeds are authored — and every one names a
bus event that `charters.test.mjs` scrapes out of `src/`. That is the rule the five deleted step
verbs were paid for.

### A race records on a FINISH, not a win

`_recordTrial` records only a win and says why. A race is different in the one way that matters: a
contest is you against a rival, a race is you against ten cars on expert. Requiring first place at
every grade would put a gateway's charter behind beating the hardest AI in the game three times —
"a gold nobody can reach is the same defect as a relic nobody can find". A DNF still records
nothing, because a DNF has no time.

### Two new verbs, both with an emitter first

`mine` gets a new `quest:activity` beside Mining's existing `collect` — `collect` fires for every
pickup in the game, so a step meaning "cut a seam" could be finished by walking over a dropped
item named after an ore. `pilot` gets a dedicated subscription to `pilot:landed`, the same shape
`race` has, because `Piloting` already publishes the world and the pad. `_forceSetDown` — the
anti-stranding recovery — emits `pilot:impact` and not `pilot:landed`, so a crash cannot complete
a landing step.

### Nothing is gated and nothing is paid

Charters record completion; they are never a key to it. Restoration pays no credits: the design's
§5 wants the price measured against real play, it is not measured, and a charter that paid *out*
would deepen a faucet the same document measures at 22 sources against 5 sinks.

---

## 3. The defect the browser found and the tests did not

The panel shipped for about an hour with `ch-` class names. `ch-` is the **character menu's**
prefix: `character.css` has owned `.ch-head` and `.ch-hint` for a long time, both stylesheets are
loaded at once, and the charter's brief line came out reading *"Changes apply to your body at once.
Save from the Esc menu to keep them."*

Nothing errored. Nothing was red. The panel was on screen, in the right place, saying something
from a different menu.

Renamed to `cht-`, and `charter-hud.test.mjs` now derives this panel's own vocabulary (the classes
no other `_build*` method uses) and fails if any of it is styled by another stylesheet in
`src/ui`. The first version of that guard only checked classes already correctly prefixed and
stayed green through the ablation — which is the "a gate that has never failed measures nothing"
rule catching itself.

---

## 4. Where the design is wrong or incomplete

1. **§2 and §1 disagree about the station.** §1 says a record is "its relics, its viewpoints, its
   trials, its seams, its wings" — learned. §2's table says the station's record is "the
   onboarding record: first trade, first mount, first gateway". The station also publishes **110
   relics**, so under the learn rule its record is 110 relics + 3 deeds and the first charter is a
   long haul rather than the quick win §2 implies. The learn rule won, because a hand-written
   per-world record list is exactly the constant that goes stale. Worth a revision either way.
2. **§2 gives the Coil a record no system persists.** "Centres reached (repeatable, volatile)" is
   not kept by anything in the game. It is a deed here — one bit, off `maze:centre-found` — which
   is new persistence the design does not describe.
3. **§2 gives the dock "hulls flown" and the planets "elements assayed".** Neither is per-world
   anywhere: `SpaceObjectives` counts elements as one career ledger, and nothing counts hulls
   flown. Not built; the dock's record is its viewpoints and its butts, and a planet's is its
   seams.
4. **§9's forgeable-quest hole is untouched.** `completeQuestEngagement` still never reads
   `step_states`. §11 records it as a Phase 4 item; it is a server change in a different phase's
   territory and it is not here.
5. **§5's charter costs are not sized.** Deliberate — see above.
6. **§6's retention loop is not built.** Out of the scope this phase was given.

---

## 5. Dead ends and things deliberately not built

- **A separate "granted" receipt on the opening reward.** Written, then deleted: it was
  unreachable. `Viewpoints._setPaid` and `Relics._paid` exist because their sets can complete
  through a cross-device merge with no transition to pay on; the opening grant has no such path,
  so the step's own done-ness IS the receipt, and a second one would be a second authority.
- **Syncing the learned rosters.** A device on an older build could hand another one a
  denominator its own worlds no longer have, and the charter would become uncompletable.
- **XP.** Explicitly rejected by the design and not built. Rank is a pure function of two sets.
- **Quests for the planets.** The design says resist it and the design is right.

## 6. Known flake, pre-existing

`dock-hulls.test.mjs` "the hulls fit inside the drop budget they were given" asserts a wall-clock
ceiling of 6,000 ms on a yard build. Under a loaded machine it has been seen at 9,869 ms. It fails
intermittently in a full run and passes on its own, both before and after this phase. Not touched.
