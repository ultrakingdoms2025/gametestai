# AETHER NEXUS

**Five worlds. One gateway. Nothing downloaded.**

A first-person action-adventure that runs in a browser tab — and generates every
world, every character and every texture in code as you play. No asset packs, no
model downloads, no install. Open a link and you are standing in it.

---

## The hook

- **Step through a portal and the world changes completely** — orbital station,
  medieval valley, floodlit sports complex, cliff-top desert citadel, and a
  racing circuit through rough country and city streets.
- **Everything is procedural.** Terrain, buildings, crowds, faces, fabric, fur,
  feathers and stone are all generated from code at load time. The whole game is
  a few hundred kilobytes of logic, not gigabytes of art.
- **Five mounts, each with its own physics** — and none of them is a reskin.
- **Climb anything.** If it has a face, you can go up it.

---

## The worlds

| World | What it is |
|---|---|
| **Aether Station** | An orbital habitat with a working plaza, market, hydroponics and hangar bays, hanging in front of a planet. |
| **Medieval Valley** | A walled town, castle, forests and lakes across open country — swimmable water and hundreds of instanced trees. |
| **Meridian Athletic Grounds** | A floodlit sports complex: pool, courts, skatepark, running track, ski piste and a seated crowd. |
| **Sunspire Citadel** | A desert mesa town built to be *climbed* — souk rooftops, rope bridges, minarets and a 46 m great tower. |
| **The Circuit** | A racing world: a long track winding over rough terrain and through city streets. |

Every world is a **portal ring** away. Destinations keep building in the
background while the transition holds, so travel is seamless.

---

## Movement

- **Free-climbing** — grip any near-vertical surface and go up it. Stamina is a
  budget for *movement*, not a countdown: hang still and you recover, so any
  height is reachable if you pace it.
- **Parkour** — running leaps, mid-air dives, and a landing roll that absorbs a
  fall that would otherwise hurt.
- **Mantling** onto ledges, **swimming** with depth and drowning, **crouching**,
  **sprinting** and a **coyote-time** jump with input buffering, so jumps land
  when you meant them to.
- **Fall damage with an answer** — haystacks under every high traversal line
  turn a leap of faith into a route rather than a death.
- **Unstuck** on a key, for the one time in a thousand that geometry wins.

---

## Mounts

Summoned from a **radial wheel** on one key — aim and release.

- **Hoverboard** — nimble, boosts, carves.
- **Dragon** — a powered flyer. Climbs when asked, holds altitude, breathes fire.
- **Ground Car** — fast over open terrain, and the vehicle you race in.
- **Horse** — a real gait model: halt, walk, trot, canter and gallop, each with
  its own **footfall pattern**. Stride advances with distance travelled, so the
  legs never skate. Leans into turns and cannot pivot at a gallop.
- **Eagle** — a *glider*, not a small dragon. Height and speed are one budget:
  dive to buy speed, pull up to spend it for altitude. Thermals rise off hot
  ground, so the best lift sits along the cliff rim you launched from.

Each mount has its own procedurally-generated voice: hoofbeats fire from the
same phase table that places the leg, so a trot *sounds* like a trot.

---

## Racing

- **A full circuit** over rough terrain and through city streets.
- **Up to 10 cars**, with AI competitors at **varying performance levels** so the
  field spreads and the race is a contest rather than a procession.
- **Selectable difficulty** and start-when-ready.
- **Live minimap** showing the whole circuit and every racer's position.
- **Lap validation** through ordered checkpoints — no shortcutting.
- **Leaderboard** at the flag. **10 credits** for a win, **5** for second,
  **2** for third.

---

## Combat

- **Four weapons**, each mechanically distinct: a machine gun, a charge-and-
  release **ember caster**, a **recurve bow** with draw weight and arrow drop,
  and a **sword** for melee.
- **Ammunition comes out of your bag**, not a private per-weapon counter — a
  stack of 60 rounds is one inventory slot, not sixty.
- **Fire from the mount** — a dragon breathes from its mouth, not from your hands.
- Charge mechanics, aim-down-sight, spread, recoil and reload.

---

## Characters

A full character creator on one key:

- **Male or female** body frames, three builds and a height slider.
- **Six face archetypes**, ten skin tones, seven hair styles, hair and eye colour.
- **Seven headgear styles** — headband, peaked cap, hood, helm, wrap, circlet.
- **Shirt style and trouser style chosen independently**, so a tunic over
  tracksuit trousers is a combination you can actually wear.
- **Separate colours** for top, legs and accent trim.
- Everything applies to your body live, in the world you are standing in.

---

## The people in it

- **Friendly NPCs** you can talk to, with personas and conversation.
- **Hostiles** with real navigation — they path around obstacles, take cover and
  refuse to walk into deep water.
- **Merchants** with a marketplace: buy ammunition, sell trinkets, all against a
  30-slot bag.
- **Crowds** of instanced spectators that make a stadium feel occupied.
- **Grounding watchdogs** keep every character on the surface it belongs on.

---

## Progression

- **Credits** from kills, loot, hidden relics, contracts and race podiums.
- **Hidden relics** scattered across the citadel, worth finding.
- **Supply caches** and **contracts** for directed objectives.
- **30-slot inventory** with stacking.

---

## Under the hood

- **Physically-based rendering** throughout: every surface carries an albedo,
  normal and packed roughness/metalness/AO map, all generated procedurally.
- **Post-processing chain** — bloom, ground-truth ambient occlusion, SMAA
  anti-aliasing and ACES tone mapping.
- **A pooled light rig.** Shader programs are keyed on light counts, so an
  uncontrolled scene recompiles hundreds of shaders and stalls. Fixed slots with
  scored assignment and crossfade cut cold start from minutes to seconds.
- **Baked vertex occlusion** on architecture, so buildings sit *in* the ground
  rather than resting on it — free at runtime.
- **Procedural audio**: every sound is synthesised, from gunfire and wingbeats to
  per-world music, with a scheduler, buses and reverb.
- **Diagnostics overlay** with live frame timing, draw calls and collider display.

---

## Quality of life

- **Full key rebinding** — every gameplay control, remapped and remembered.
- **Save and back up in one action.** Your progress is written to the browser
  *and* to a file you own, so clearing site data cannot take it. Load reads
  whichever exists.
- **Sealed saves.** An edited save file is refused.
- **Autosave** every 30 seconds and on world change.
- **Audio mixer** with independent music and effects control.
- **In-game control reference** and a start-screen summary.
- **Minimap** with zoom, objectives and points of interest.

---

## The short version

> A browser-native action-adventure that builds five worlds, a cast of
> characters and every texture in them from code — then lets you climb the
> architecture, fly a glider off it, and race a car through a city.
