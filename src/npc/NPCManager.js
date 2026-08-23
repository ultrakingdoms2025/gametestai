import * as THREE from 'three';
import { CONFIG } from '../core/Config.js';
import { COLLISION_LAYER } from '../physics/Physics.js';
import { CharacterAssets, HumanoidFactory } from './Humanoid.js';
import { FriendlyNPC } from './FriendlyNPC.js';
import { HostileNPC } from './HostileNPC.js';
import { BeastNPC } from './BeastNPC.js';
import { BeastBody } from './BeastBody.js';
import { BeastPack } from './BeastPack.js';
import { beastDef, rollPackSize } from './BeastSpecies.js';
import { resolveSpot, resolveSurfaceY, seatSurfaceAt, isDeepWater, nearestDrySpot } from './Grounding.js';
import { ROLE, ROLE_ROTATION, castFor, roleDef } from './NPCRoles.js';
import { WEAPON_TABLES } from './NPCWeapons.js';
import { DEFAULT_LORE, buildLorePersona, loreEntryForScope } from '../content/Lore.js';
import { allows } from '../worlds/WorldRules.js';
import { pastBand } from '../worlds/lod/DistanceLod.js';

/* ------------------------------------------------------------------ */
/* Authored hero characters (Phase 6, decision D4)                     */
/* ------------------------------------------------------------------ */

/**
 * A station hostile's archetype, read off the weapon it was authored with.
 *
 * These four pairings are not invented here - they are `HOSTILE_KIND` in
 * `StationWorld._fillSpawns` and `KINDS` in `zones/Construction.js`, which are
 * copy-pasted from each other and both key on exactly this. Keying on the
 * weapon rather than on a new field means the mapping cannot fall out of step
 * with the encounter design, because the encounter design IS the weapon.
 *
 * The names on the right are the manifest's role keys and the reference files
 * they were authored against; see `public/assets/npc/manifest.json`.
 */
const HERO_BY_WEAPON = Object.freeze({
  rifle: 'rifle',    // Rogue Security Unit - g1
  baton: 'breaker',  // Breaker Frame       - g3
  sidearm: 'scout',  // Skirmish Drone      - g2
  staff: 'lance',    // Arc Lance Sentry    - g4
});

/** The seven fixed roles the references cover. @see NPCRoles.ROLE */
const HERO_ROLES = new Set([
  ROLE.VENDOR, ROLE.GUARD, ROLE.LOITERER, ROLE.SPECTATOR,
  ROLE.WANDERER, ROLE.LOREKEEPER, ROLE.QUEST_MANAGER,
]);

/** Which of the eleven are attackers, for the colour split in `_heroLook`. */
const HERO_RAIDERS = new Set(Object.values(HERO_BY_WEAPON));

/**
 * Fur tones.
 *
 * Both sets are near-black because the references are, and because the SKIN
 * slot draws the cranium, muzzle, ears and knuckles together - so this one
 * number is the whole colour of the animal. The three-way spread stops a
 * plaza of crew reading as one model repeated, which is the failure mode the
 * procedural crowd already spends a lot of effort avoiding.
 *
 * The raiders' violet does NOT come from here. It comes from the GLOW-slot eye
 * caps and the violet rim light in `_heroLook`, because a violet ALBEDO under
 * the station's amber key reads muddy brown, whereas a violet rim separates
 * the silhouette from the deck exactly the way `THEME_RIM` was written to.
 */
const RAIDER_TONES = Object.freeze([0x241d28, 0x1d1a22, 0x2b2130]);
const CREW_TONES = Object.freeze([0x2a2622, 0x1f1c19, 0x332d27]);

/**
 * The attackers' own palette, passed as an object rather than an index.
 *
 * `PALETTES.station` is built on a documented VALUE contract - a pale
 * ~30%-coverage secondary worn as collar and shoulder yoke - so that a
 * civilian separates from a mid-grey container wall. An attacker needs the
 * opposite. `g1`-`g4` are a single dark violet mass with one bright note in
 * it, and the first screenshot of these with a station palette showed exactly
 * why: pale bands across the shins and shoulders chopped the silhouette into
 * three pieces and the character stopped reading as one animal.
 *
 * Everything here is under 0.06 linear except the glow. The violet is carried
 * by the rim light and the eye caps, not by the albedo - a violet albedo under
 * the station's amber key goes muddy brown, which is a lesson `THEME_RIM`
 * already records for the crowd.
 */
const RAIDER_PALETTE = Object.freeze({
  primary: 0x211c26,
  secondary: 0x2a2431,
  leather: 0x342b3a,
  metal: 0x6b6472,
  glow: 0xa855f7,
});

/**
 * Owns every NPC in the active world: spawning, budget, level of detail,
 * hit queries, chat proximity and hostile respawn.
 *
 * Skinned meshes are the most expensive thing in the scene, so the manager is
 * also the throttle: a hard cap on live characters, animation update rates that
 * fall off with distance, foot IK disabled beyond 25 m and a cheap sphere
 * frustum test that stops off-screen characters posing at all.
 */

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
/** _snapToGround() and the water watchdog own this exclusively. */
const _dryScratch = new THREE.Vector3();
const _capA = new THREE.Vector3();
const _capB = new THREE.Vector3();
// raySegment owns these exclusively - callers must not pass them in.
const _seg = new THREE.Vector3();
const _rsA = new THREE.Vector3();
const _rsB = new THREE.Vector3();
const _sphere = new THREE.Sphere();
const _frustum = new THREE.Frustum();
const _projScreen = new THREE.Matrix4();

/**
 * Minimum XZ gap between two live characters' roots.
 *
 * Steering separation is a *force*, and a force loses: an agent whose seek term
 * is larger than its separation term walks straight into a neighbour and stays
 * there, and two idle characters have no seek term at all so they never
 * separate in the first place - `Navigation.update` returns before the
 * separation block when there is no target. Three characters placed on the same
 * spot measured a gap of exactly 0.000 m indefinitely, and identical skinned
 * geometry at an identical transform z-fights, which is the flicker the player
 * reported.
 *
 * So overlap is resolved as a *constraint* instead. A constraint converges in a
 * few steps and has no feedback path into the steering, so unlike a force it
 * cannot oscillate. 0.62 m keeps two 0.33 m bodies brushing shoulders without
 * ever sharing a triangle, which is well inside the 0.85 m minimum the group
 * spawner already enforces - so standing formations are untouched.
 */
const PERSONAL_SPACE = 0.62;
const PERSONAL_SPACE_SQ = PERSONAL_SPACE * PERSONAL_SPACE;
/**
 * A character may ask for more room than a person needs.
 *
 * 0.62 m is two 0.33 m bodies brushing shoulders. A bear is 0.62 m in radius on
 * its own, so at the shared gap two of them share most of a torso and a bear
 * standing next to a villager has its shoulder inside them. The pair's gap is
 * therefore the larger of the two claims, read off `npc.personalSpace` when a
 * character sets one - which is one property read per body in the sweep and
 * nothing at all for the humanoids, which never set it.
 */
const MAX_PERSONAL_SPACE = 1.4;
const MAX_PERSONAL_SPACE_SQ = MAX_PERSONAL_SPACE * MAX_PERSONAL_SPACE;
/**
 * Hard ceiling on live beasts, on the same terms as `HOSTILE_CEILING`.
 *
 * A beast costs more than a hostile per body - a dozen meshes rather than two,
 * a sense pass over the whole civilian roster - and packs arrive four and five
 * at a time, so a world that authors six wolf packs would otherwise quietly
 * spend its entire character budget on wildlife.
 */
const BEAST_CEILING = 14;
/** Fraction of the overlap resolved per step. Under 1 so simultaneous contacts settle. */
const SEPARATION_RELAX = 0.5;
/**
 * Hard cap on how far one step may move a character. Keeps the correction
 * sub-step-sized so `resolveCapsule` on the next tick can always absorb a push
 * that happened to be into a wall, and stops it ever reading as a teleport.
 */
const SEPARATION_MAX_STEP = 0.06;
/** Above this height difference the two are on different decks, not overlapping. */
const SEPARATION_MAX_RISE = 1.2;

/**
 * LOD switch hysteresis.
 *
 * Every one of these used to be a single boundary, so a character sitting on
 * the threshold toggled its eye meshes - or, at the far switch, its whole body -
 * on and off from frame to frame. Separate in/out distances turn each switch
 * into a band that has to be crossed properly before anything changes.
 */
const DETAIL_IN = 23;
const DETAIL_OUT = 27;
const IK_IN = 21;
const IK_OUT = 24;
const RENDER_IN = 125;
const RENDER_OUT = 135;
/**
 * Distance past which a character stops casting a sun shadow.
 *
 * Characters are the dominant frame cost in the crowded worlds - 66% of draw
 * calls at the citadel market, 46% at the medieval square - and roughly two
 * thirds of what a character costs is its shadow pass, spent largely on people
 * the camera cannot see: the sun's shadow camera spans +/-60 m around the
 * player (`CONFIG.render.shadowDistance`), so it catches far more of the crowd
 * than the view frustum does.
 *
 * The threshold is the one the pixels chose, not the one the counter wanted.
 * Measured across six vantages in the two crowd worlds, with the scene held
 * still and the shadow camera confirmed to be tracking the player, comparing
 * each cutoff against every character casting:
 *
 *     cutoff   citadel draws   medieval draws   pixels changed (worst vantage)
 *     none         1260             1137          -
 *     50 m         1120             1045          0.00%   (max delta 2/255)
 *     45 m         1022             1001          0.01%   (max delta 81)
 *     40 m         1008              969          0.02%   (max delta 90)
 *     35 m          938              969          0.13%   (max delta 103)
 *     30 m          910              907          0.20%   (max delta 116)
 *
 * 45 m is the knee: it banks 19% of the citadel frame and 12% of the medieval
 * one while the frame is, to the pixel, the frame you would have rendered
 * anyway. Below 40 m real shadows start to go - at 35 m and closer the loss is
 * a character's shadow falling on a market crate or a stall top, which is
 * exactly the cue that says a figure is standing *in* the scene rather than on
 * it. 30 m was tried first (it is worth another 112 draws at the citadel) and
 * rejected on those pixels.
 *
 * As shipped, with the band's outer edge in play, the same two vantages measure
 * 1248 -> 1108 draws at the citadel (25 casters of 39) and 1129 -> 1025 at the
 * medieval square (17 of 41); standing in the crowd at eye height, 40 m from
 * the citadel portal with 36 characters on screen, 1250 -> 1096. Every one of
 * those pairs is pixel-identical to the frame with every character casting,
 * inside the renderer's own dither noise.
 *
 * The band exists for the reason recorded above: a single boundary turns a
 * stride's worth of pelvis travel into a per-frame toggle, and a shadow
 * blinking on and off is far more visible than a pair of eye meshes doing it.
 * The contact decal in `_updateContactShadows` still grounds everyone out to
 * 70 m, so between this band and that range a character keeps a ground cue.
 *
 * 4 m of hysteresis, the same width as the detail band. Wider was tried and is
 * not free: characters are built casting, so a crowd that spawns at range has
 * never crossed the inner edge and holds its shadows all the way out to
 * SHADOW_OUT - a 52 m outer edge gave back half the saving at the citadel
 * (1152 draws against 1022 at a flat 45 m cutoff). A stride moves a pelvis well
 * under a metre, so 4 m is already several times what the jitter needs, and 50 m
 * measured pixel-identical to everyone casting in both worlds anyway.
 */
const SHADOW_IN = 45;
const SHADOW_OUT = 49;

/**
 * Distance bands on the SIMULATION rate - the fixed step, not the pose.
 *
 * ── Why this band and not another ──────────────────────────────────────────
 * Ablating `NPCManager.fixedUpdate` on the station measures -2.0 ms at the
 * plaza, -2.0 ms on the walkway loop and -3.6 ms in the construction court,
 * against a 16-21 ms frame, for ZERO draw calls: the crowd is cheap to draw and
 * expensive to think. Ablating the frame-side `update()` over the same run
 * measures -0.2 to -1.2 ms, because the pose is already banded by `lod.rate`.
 * So the cost that was left is `_think` / `_steer` / `_integrate` / the ground
 * probe, all of which run 60 times a second for every character in the world
 * however far away it is.
 *
 * ── A divisor, not a switch ────────────────────────────────────────────────
 * A frozen crowd at 100 m is worse than a slightly stuttery one, so nobody is
 * ever switched off. A demoted character is simulated on one step in N and
 * handed the N steps' worth of `dt` it banked (`NPC._simAccum`), so it covers
 * exactly the same ground per wall-clock second; what it loses is temporal
 * resolution inside the step, which at these ranges is the difference between a
 * 60 Hz and a 15 Hz turn on a body a few pixels tall.
 *
 * ── Why these distances ────────────────────────────────────────────────────
 * They are the pose bands (`lod.rate`, 16/34/65 m) and the draw band
 * (RENDER_IN/OUT) restated one step out, so the simulation is never coarser
 * than the animation that samples it:
 *
 *     < 36 m    every step        the pose is at 1/1 or 1/2 - full detail range
 *     < 68 m    every 2nd step    the pose is at 1/4 here
 *   < 135 m     every 4th step    the pose is at 1/10 here
 *   >= 135 m    every 8th step    RENDER_OUT: the body is not drawn at all
 *
 * Each edge is a band, never a line, for the reason recorded above DETAIL_IN:
 * a single boundary turns a stride's worth of pelvis travel into a per-frame
 * flip, and cadence popping at a band edge is exactly the failure mode. The
 * `out` edge is the threshold and the band is subtracted to make the `in` edge,
 * which is what `pastBand` in worlds/lod/DistanceLod.js already expresses - so
 * the hysteresis rule lives in one place for scenery and characters alike.
 */
const SIM_BAND = 4;
const SIM_HALF_OUT = 36;
const SIM_QUARTER_OUT = 68;
const SIM_EIGHTH_OUT = RENDER_OUT;

/**
 * Distance bands on the POSE rate - how often `NPC.update` runs the animator.
 *
 * These distances are not new; they were three bare comparisons inside
 * `_updateLOD` (`d < 16 ? 1 : d < 34 ? 0.5 : d < 65 ? 0.25 : 0.1`) and they were
 * the only switch in this file that was still a line rather than a band, which
 * the note above DETAIL_IN already says every switch here should be. Measured
 * against the real `_updateLOD`, a character loitering on an edge with +/-1.5 m
 * of jitter - well over a stride, and the same fixture the cadence band is
 * tested with:
 *
 *     pose rate, 16 / 34 / 65 m     190 flips per 600 frames, at every edge
 *     sim cadence, 36 m (banded)      0
 *     eye detail, 27 m (banded)       0
 *     shadow casting, 49 m (banded)   0
 *
 * ── What that chatter was NOT doing, which is why it survived this long ────
 * Nothing visible. A rate change conserves animation phase: `NPC.update` hands
 * the animator `useDt = this._animAccum`, i.e. exactly the time since the last
 * pose, so a character sampled at 30 Hz and one sampled at 15 Hz walk their
 * cycle at the same speed and only differ in temporal resolution. Nothing
 * appears, disappears or jumps at the edge - unlike the eye meshes, the foot IK
 * and above all the shadow, which is why those three were banded first.
 *
 * So this is consistency and a removed footgun rather than a measured win, and
 * the band width is the same 4 m as its neighbours for the same reason: a
 * stride moves a pelvis well under a metre.
 */
const POSE_BAND = 4;
const POSE_HALF_OUT = 16;
const POSE_QUARTER_OUT = 34;
const POSE_TENTH_OUT = 65;
/**
 * The pose rate for a character outside the frustum.
 *
 * Higher than the far-distance rate (0.1), and deliberately: `NPC.update`'s
 * off-screen branch holds a hidden character at a 0.2 s floor before it will
 * pose at all, so the effective cadence is about 5 Hz whatever this says. It is
 * the rate a character resumes at the instant it comes back on screen that
 * matters, and 0.12 is that.
 */
const POSE_RATE_HIDDEN = 0.12;
/**
 * Ceiling on one catch-up step, in seconds.
 *
 * A character promoted from the 1-in-8 band arrives owing up to seven steps,
 * and handing all of it to `_integrate` in one go would read as a lurch. Two
 * fifths of a second is over three times the largest debt the bands can build
 * (8/60 s), so it never binds in normal play; it is there for the case the
 * bands cannot cause - a stalled tab, a world build - where the alternative is
 * a character teleporting the length of the plaza.
 */
const SIM_MAX_STEP = 0.4;

/**
 * World id -> character theme. The theme is what every cast, costume, name and
 * weapon table below is keyed on, and every one of those lookups carries a
 * `?? station`, so a world missing from here is not an error - it is a world
 * quietly dressed as the space station. Exported, with the three name tables
 * below, so that can be pinned without building a world; see
 * scripts/tests/citadel-cast.test.mjs.
 */
export const THEME_BY_WORLD = {
  station: 'station', medieval: 'medieval', sports: 'sports', maze: 'maze',
  citadel: 'citadel',
  /* Lodestar Yard has a costume set of its own in `Humanoid.js` - variants,
   * palette, cloth kind and rim, all four - so this maps to `dock` rather than
   * borrowing `station`. Without the row the yard's whole cast would wear
   * Aether Nexus deck uniforms and nothing would say so; that is precisely
   * what happened to the citadel, whose twenty-five crowd slots stood in a
   * desert souk dressed as station dockhands. */
  dock: 'dock',
  /* `space` deliberately absent. `SpaceWorld` sets `crowd: false` and authors
   * nobody, so no character is ever created there and a theme for it would be
   * a costume set with no wearer. */
};
const MERCHANT_SIGN_WORLD = {
  station: 'AETHER NEXUS',
  medieval: 'ALDERMOOR VALE',
  sports: 'MERIDIAN ARENA',
  citadel: 'SUNSPIRE CITADEL',
  race: 'VELLUM CIRCUIT',
  dock: 'LODESTAR YARD',
};

/** Fallback names so a world that forgets to name its friendlies still reads. */
export const FALLBACK_NAMES = {
  station: ['Vex Orrin', 'Dr. Hala Mensu', 'Rig-Chief Danno', 'Sable Ito', 'Quartermaster Rhee', 'Pilot Ashe'],
  medieval: ['Alwin the Cooper', 'Mistress Bryda', 'Father Osric', 'Tam the Fletcher', 'Goodwife Elgiva', 'Sergeant Cuthred'],
  sports: ['Coach Marra', 'Deuce Kowalski', 'Nia Sandoval', 'Ollie Trent', 'Ref Bastian', 'Skye Larsen'],
  /* Sunspire Citadel. Written to the same register as the four characters
   * CitadelWorld authors by hand - Rafiq, Hafsa, Bashir, Yusra - so a friendly
   * the world forgot to name still sounds like it lives on the mesa rather
   * than on Ring 7. This row is not optional decoration: `spawnForWorld` reads
   * FALLBACK_NAMES[theme] with no `??`, so naming a theme without adding it
   * here is a TypeError the first time an unnamed friendly spawns. */
  citadel: ['Idris the Watercarrier', 'Sitt Marwa', 'Tahar the Ropemaker',
    'Layla of the Cisterns', 'Serjeant Kamal', 'Umm Zaynab'],
  /* Unreachable while MazeWorld sets crowd: false and names all nine of its
   * own spawns (see WANDERER_CAST in MazeWorld.js) - kept correct anyway, in
   * case that ever stops being true, rather than left as a station name a
   * hedge maze would never produce. */
  maze: ['A Lost Wanderer', 'Someone Turned Around', 'A Voice Past the Hedge', 'Someone Still Walking'],
  /* Lodestar Yard. NOT optional decoration: `spawnForWorld` reads
   * `FALLBACK_NAMES[theme]` with no `??`, so naming a theme in
   * `THEME_BY_WORLD` without adding it here is a TypeError the first time an
   * unnamed friendly spawns - which in this world is the first crowd slot the
   * filler reaches. Written to the same register as the yard's own authored
   * cast (Teodora, Ivo, Suri, Beck, Odalys, Casimir, Wren) so a friendly the
   * world forgot to name still sounds like it works here. */
  dock: ['Deck-Boss Ilarion', 'Plater Nkechi Abara', 'Slinger Tove Rask',
    'Burner Halim Qadri', 'Storesman Bo Lindqvist', 'Rigger Mireia Sol'],
};

/**
 * Extra civilians used to fill out the social hubs. Worlds only author a
 * handful of named characters, which leaves plazas and market squares reading
 * as evacuated, so the manager tops the population up itself.
 */
export const CROWD_NAMES = {
  station: [
    'Deck Tech Ruiz', 'Nav Cadet Bell', 'Hauler Kito', 'Medtech Vos', 'Fitter Okonjo',
    'Comms Officer Idi', 'Longshore Yusuf', 'Rations Clerk Pia', 'Welder Strand', 'Inspector Tamm',
    'Cargo Marshal Rho', 'Hydroponics Lem',
  ],
  medieval: [
    'Wat the Tanner', 'Goody Hulda', 'Edric Millson', 'Rilda the Baker', 'Hob the Drover',
    'Sister Aveline', 'Grim the Smith', 'Little Maude', 'Ceorl the Reeve', 'Tibb Wainwright',
    'Old Widow Særa', 'Piers the Carter',
  ],
  sports: [
    'Tess Halvorsen', 'Marco Diaz', 'Junie Park', 'Rowan Blake', 'Ash Delacroix',
    'Kenji Ito', 'Bex Ferrara', 'Dev Chaudhary', 'Lena Wojcik', 'Toby Nkemelu',
    'Nadia Reyes', 'Grant Okafor',
  ],
  citadel: [
    'Ghalib the Tanner', 'Sabiha the Potter', 'Munir Saltbearer', 'Halima the Weaver',
    'Jamil the Drover', 'Sister Rahma', 'Zuhayr the Smith', 'Little Anis',
    'Karim the Watchman', 'Nawal Basketmaker', 'Old Widow Thurayya', 'Faris the Carter',
  ],
  /* Unreachable while MazeWorld sets crowd: false - _populateHubs is never
   * called for it (see spawnForWorld). Kept correct anyway, per the same
   * reasoning as the maze entry in FALLBACK_NAMES above: a wrong fallback
   * that happens to be dead code today is still wrong, and worth fixing
   * once rather than rediscovering later. */
  maze: [
    'Thistle Vance', 'Old Mossop', 'Corda Vale', 'Half-Found Mabel',
    'Yew Barrow', 'Sil the Turned-Around',
  ],
  dock: [
    'Plater Anouk Verhoef', 'Burner Sabo Danjuma', 'Slinger Petra Kalnina',
    'Crane-Hand Yusuf Tekin', 'Storesman Reidun Aas', 'Rigger Emeka Nwosu',
    'Welder Sanna Koivisto', 'Fitter Dario Bellucci', 'Checker Marit Sund',
    'Painter Ola Adeyemi', 'Gate Clerk Ines Prado', 'Dogger Kwabena Osei',
  ],
};

/** One-line briefs so a filler civilian still has something to say. */
export const CROWD_PERSONAS = {
  station: [
    'A shift worker on Ring 7 who talks about hull maintenance backlogs and bad recycled coffee.',
    'A dock hand waiting on a delayed freighter, cheerful but tired of the paperwork.',
    'A junior technician who is very proud of a repair nobody has noticed yet.',
    'A trader between contracts, always angling for gossip about the portals.',
  ],
  medieval: [
    'A villager in for market day, full of complaints about the toll on the bridge.',
    'A craftsman taking a break, quietly proud of the work and suspicious of strangers.',
    'A farmhand up from the river fields who has heard three different rumours about the keep.',
    'A pilgrim resting in the square, convinced the shimmering gate is an omen.',
  ],
  sports: [
    'A regular at the park who will happily explain why your stance is wrong.',
    'A club coach between sessions, upbeat and relentlessly encouraging.',
    'A weekend skier waiting for the lift queue to clear, hyped about the fresh piste.',
    'A spectator killing time before the next match, keen to talk scores.',
  ],
  citadel: [
    'A water-carrier working the cistern round, who can tell you how many steps there are between the gate and the upper ward.',
    'A trader up off the caravan road, still dusty, certain the mule toll at the gate has doubled since spring.',
    'A roof-runner of the souk who takes the high line on every errand and thinks the stairs are for visitors.',
    'A mason patching the outer wall, quietly certain the old order built it better and unwilling to say who they were.',
  ],
  maze: [
    'Lost long enough to have stopped panicking about it, and unsure whether that is a good sign.',
    'Convinced the hedges rearrange themselves overnight and eager to argue the point.',
    'Rationing the last of their food and trying not to mention it to anyone they meet.',
    'Still following a thread of string that ran out three days ago, out of habit more than hope.',
  ],
  dock: [
    'A plater on the cradle gang, filthy, cheerful, and able to tell you which section joint on which hull was pinned crooked.',
    'A slinger waiting on the crane, killing time and convinced the yard will never launch anything while the paperwork looks like this.',
    'A burner on a break with a cutting torch still warm, quietly proud of a seam nobody has noticed yet.',
    'A storesman doing a stock count that has not balanced since commissioning, and blaming the trench for it.',
  ],
};

/** Postures that read well in a standing group, weighted toward folded arms. */
const GROUP_POSTURES = ['crossed', 'hips', 'pocket', 'crossed', 'lean', 'none'];

/** Ray vs. capsule segment. Returns the hit distance or -1. */
function raySegment(origin, dir, a, b, radius, maxDist) {
  _seg.subVectors(b, a);
  const baba = _seg.dot(_seg);
  if (baba < 1e-9) return -1;
  const bard = _seg.dot(dir);
  _rsA.subVectors(origin, a);
  const baoa = _seg.dot(_rsA);
  const rdoa = dir.dot(_rsA);
  const oaoa = _rsA.dot(_rsA);
  const A = baba - bard * bard;
  const B = baba * rdoa - baoa * bard;
  const C = baba * oaoa - baoa * baoa - radius * radius * baba;
  let y = baoa;
  if (Math.abs(A) > 1e-9) {
    const h = B * B - A * C;
    if (h >= 0) {
      const t = (-B - Math.sqrt(h)) / A;
      y = baoa + t * bard;
      if (t > 0 && t < maxDist && y > 0 && y < baba) return t;
    }
  }
  // Spherical caps at whichever end the ray passes.
  _rsB.copy(y <= 0 ? a : b);
  _rsA.subVectors(origin, _rsB);
  const bq = dir.dot(_rsA);
  const cq = _rsA.dot(_rsA) - radius * radius;
  const hq = bq * bq - cq;
  if (hq > 0) {
    const tc = -bq - Math.sqrt(hq);
    if (tc > 0 && tc < maxDist) return tc;
  }
  return -1;
}

function raySphere(origin, dir, center, radius, maxDist) {
  _rsA.subVectors(origin, center);
  const b = _rsA.dot(dir);
  const c = _rsA.dot(_rsA) - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t > 0 && t < maxDist ? t : -1;
}

/**
 * Which lore a gateway's keeper recites.
 *
 * A keeper stands beside a gateway to answer "what is through there". In every
 * world but one that question has a single answer, because every other world
 * has exactly one portal and it goes home to the station - so the keeper is
 * that world's OWN lorekeeper and `world.id` is the right scope. The station is
 * the hub: six gateways, six different destinations, and keying all six on
 * `world.id` gave the player six characters reciting the same paragraph about
 * the station they were already standing in.
 *
 * The rule is therefore derived from the ring rather than hard-coded to it -
 * when the portals in this world lead to more than one place, each keeper takes
 * its own gateway's destination.
 *
 * Keying on `spec.target` unconditionally would be WRONG, and wrong in four
 * worlds at once: medieval's single portal targets `station`, so its keeper
 * would stop knowing anything about Aldermoor Vale and start reciting station
 * lore to somebody standing in a village. Same for sports, citadel and race.
 *
 * Exported so the rule can be pinned by a test without building a world; see
 * scripts/tests/lorekeeper-scope.test.mjs.
 *
 * @param {{id:string, portalSpecs?:Array<{target?:string}>}} world
 * @param {{target?:string}} spec the gateway this keeper is standing beside
 * @returns {string} a key into the lore table
 */
export function lorekeeperScope(world, spec) {
  const specs = world?.portalSpecs ?? [];
  const targets = new Set();
  for (const s of specs) if (s?.target) targets.add(s.target);
  if (targets.size > 1 && spec?.target) return spec.target;
  return world?.id;
}

export class NPCManager {
  /** @param {{scene:THREE.Scene, engine:any, physics:any, bus:any, materials:any, player:any}} ctx */
  constructor({ scene, engine, physics, bus, materials, player }) {
    this.scene = scene;
    this.engine = engine;
    this.physics = physics;
    this.bus = bus;
    this.materials = materials;
    this.player = player;

    this.assets = new CharacterAssets(engine?.renderer);
    this.factory = new HumanoidFactory({ assets: this.assets });

    /** @type {import('./NPC.js').NPC[]} */
    this._npcs = [];
    this._hostiles = [];
    this._friendlies = [];
    this._respawnQueue = [];
    this.theme = 'station';
    this.worldId = null;
    this._loreData = DEFAULT_LORE;

    /* Hard ceiling regardless of what a world asks for.
     *
     * 26 was sized for a world you could cross in twenty seconds, where every
     * NPC was somewhere the player would plausibly be within the minute. The
     * station is now five decks half a kilometre apart, and 26 meant the twelve
     * characters authored around the hub plaza filled the budget and the eight
     * authored out in the zones - the galley's merchant among them - were
     * silently dropped by the `break` in `spawnForWorld`. A shop nobody can
     * reach is worse than no shop.
     *
     * What makes the raise affordable is the LOD that is already here: past
     * 135 m an NPC is not drawn at all, and past 65 m it is posed at a tenth of
     * the frame rate (see `_updateLOD`). Four decks' worth of characters are
     * always in that band, so the marginal cost of the extra eighteen is the
     * grounding watchdog - which round-robins one NPC per fixed step whatever
     * the population - plus a wider `_separateBodies` sweep, which is O(n^2)
     * over a number that is still under fifty.
     */
    /**
     * Raised again, 44 -> 72, for the maze's streamed population.
     *
     * The maze asks for one wanderer per resident district (see
     * `WANDERER_CHANCE`), and the widest residency is 43 districts, so it wants
     * up to ~39 characters on its own. Against a 44 ceiling that left five for
     * everything else and, worse, made the ceiling BIND: `MazePopulation.sync`
     * fills districts in sorted key order, which is level-major, so a budget
     * that runs out is a budget spent on the floor below the player while the
     * corridor they are standing in stays empty. The number had to clear the
     * distribution, not sit inside it.
     *
     * Affordable for the same reason the last raise was, only more so: the LOD
     * described above means anything past 135 m is not drawn and anything past
     * 65 m is posed at a tenth of the frame rate, and in a hedge maze almost
     * the whole population is beyond both at any moment. The costs that do
     * scale are the O(n^2) `_separateBodies` sweep - 2,556 pairs at 72 against
     * 946 at 44, both trivial - and the grounding watchdog, which round-robins
     * one NPC per fixed step whatever the population is.
     */
    this.maxNPCs = 72;
    this.maxHostiles = CONFIG.npc.hostileCount;
    // Worlds only author a handful of named civilians per district. A plaza
    // needs a crowd, so the manager tops the friendly population up itself
    // (see _populateHubs) and this is the ceiling for the result.
    this.maxFriendlies = Math.max(CONFIG.npc.friendlyCount, 30);

    /**
     * Swimmable water for the active world.
     *
     * Characters have no swimming animation and no buoyancy - only the player
     * does - so water is a hazard they have to be taught about, and until they
     * were, three of the medieval crowd spent their lives walking along the
     * riverbed. `WaterVolumes` derives the volumes from world geometry and
     * announces them; every character's steering, destination picking and
     * grounding consults them through here.
     * @type {import('../systems/WaterVolumes.js').WaterVolumes|null}
     */
    this.water = null;
    /**
     * The active world, held for ONE thing: its published surface gravity.
     *
     * A character resolves its own gravity from it - the same
     * `worldGravityRatio` the player uses - so this has to survive past
     * `spawnForWorld`, which is not the only place a body is built. Beast
     * top-ups (`Caravans`), respawns and `spawnOne` all create characters
     * long after the world changed, and a body that missed the world it was
     * born into falls in the previous one's physics.
     * @type {{gravity?:number, id?:string}|null}
     */
    this.gravityWorld = null;
    this._offs = [];
    if (this.bus) {
      this._offs.push(this.bus.on('water:volumes', ({ water }) => this.setWater(water)));
      // WaterVolumes may already have scanned this world before we subscribed;
      // asking makes the wiring order between the two irrelevant.
      this.bus.emit('water:request');
    }

    this._chatNPC = null;
    this._coverToken = 0;
    this._lodCursor = 0;
    this._seedCounter = 1;

    /** Friendlies flagged as traders. The Marketplace keys on these. */
    this._vendors = [];
    /**
     * Grounding watchdog cursor. One character re-audited per fixed step is
     * about 0.4 s to sweep a full world at 60 Hz, which is fast enough to catch
     * anything that slips through geometry and far too cheap to notice.
     */
    this._groundCursor = 0;
    this._groundFixes = 0;
    this._pauseUntil = 0;
    /**
     * Fixed-step counter, and the phase every banded simulation is measured
     * against. Never reset on a world change: the bands only care about the
     * counter modulo 8, and resetting it would put every character in the new
     * world back on the same step for the first cycle.
     */
    this._simStep = 0;

    // Shared contact-shadow layer. One InstancedMesh for the whole crowd - a
    // per-character decal would have cost 26 extra draw calls, and this world
    // has no headroom for that. See `_updateContactShadows`.
    this._contact = new THREE.InstancedMesh(
      this.assets.contactDiscGeometry(),
      this.assets.contactShadow(),
      this.maxNPCs
    );
    this._contact.name = 'npc.contactShadows';
    this._contact.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._contact.frustumCulled = false;
    this._contact.castShadow = false;
    this._contact.receiveShadow = false;
    this._contact.renderOrder = 2;
    this._contact.count = 0;
    this.scene.add(this._contact);
    this._contactMat = new THREE.Matrix4();
    this._contactPos = new THREE.Vector3();
    this._contactQuat = new THREE.Quaternion();
    this._contactScale = new THREE.Vector3();

    // If nothing else resolves NPC gunfire we do it ourselves, so hostiles are
    // always a real threat even before CombatSystem is wired up.
    this._selfResolveFire = true;
    this.bus?.on('weapon:fired', ({ origin }) => this._onGunfire(origin ?? this.player?.position, 1));
  }

  get npcs() {
    return this._npcs;
  }
  get hostiles() {
    return this._hostiles;
  }
  get friendlies() {
    return this._friendlies;
  }
  /** Friendlies that trade. Marketplace opens next to one of these. */
  get vendors() {
    return this._vendors;
  }

  /**
   * Nearest trader within `maxRange`, for the Marketplace proximity check.
   * @returns {import('./NPC.js').NPC|null}
   */
  nearestVendor(position, maxRange = 4.5) {
    let best = null;
    let bestSq = maxRange * maxRange;
    for (const npc of this._vendors) {
      if (npc.isDead) continue;
      const d = npc.position.distanceToSquared(position);
      if (d < bestSq) {
        bestSq = d;
        best = npc;
      }
    }
    return best;
  }

  /* ---------------------------------------------------------------- */
  /* Spawning                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Build every NPC described by `world.npcSpawns`. Positions are snapped to
   * the floor with `physics.groundHeight` so nothing ever spawns embedded in
   * geometry or hovering above it.
   */
  spawnForWorld(world) {
    this.clear();
    this.gravityWorld = world ?? null;
    if (!world) return;
    this.worldId = world.id;
    this.theme = THEME_BY_WORLD[world.id] ?? 'station';
    /* A world may forbid hostiles outright - the maze has NPCs purely to talk
     * to. Zeroing the budget is enough: every hostile path downstream is driven
     * by this count. */
    const hostilesAllowed = allows(world, 'hostiles');
    /**
     * A world may ask for more hostiles than the default budget.
     *
     * `CONFIG.npc.hostileCount` is 10, and 10 was sized for a world you can
     * cross in twenty seconds. On the station it BINDS, silently, and in the
     * worst possible place: `spawnForWorld` walks `npcSpawns` in order and
     * `continue`s past every hostile once the count is reached, and the hub's
     * ten are authored before the outer ring's are appended - so the
     * construction zone, whose own docstring says it "is deliberately the one
     * that carries the ring's combat", shipped with zero hostiles in it. The
     * fix has to be per-world: raising the global default would put eight more
     * enemies in the medieval valley, which has not asked for them.
     *
     * Clamped to 24 for the same reason `maxNPCs` exists at all. Hostiles are
     * the most expensive character in the world - they sense on a timer, raycast
     * for line of sight and hold a weapon model each - and they are also the
     * only ones that can converge on the player from anywhere. 24 is a little
     * over twice the default and still a third of the character budget.
     */
    const HOSTILE_CEILING = 24;
    const asked = Number.isFinite(world.hostileBudget) ? Math.floor(world.hostileBudget) : this.maxHostiles;
    const maxHostiles = hostilesAllowed ? Math.max(0, Math.min(HOSTILE_CEILING, asked)) : 0;
    /* A world may forbid crowd filling outright - the maze is meant to feel
     * empty, and a manager-added crowd on top of its eight authored wanderers
     * would defeat that. Zeroing the reserve and the hub budget below is
     * enough: `npcSpawns` becomes the whole cast. */
    const crowdAllowed = allows(world, 'crowd');
    const spawns = world.npcSpawns ?? [];

    let friendlyCount = 0;
    let hostileCount = 0;
    let nameIndex = 0;
    const names = FALLBACK_NAMES[this.theme];
    // Deal the hostile weapons out up front so every id in the theme's table is
    // represented and every model is built during world activation. A re-roll
    // later then only ever picks a weapon whose material is already compiled.
    const weaponDeal = this._dealWeapons(maxHostiles);
    const weaponPool = (WEAPON_TABLES[this.theme] ?? WEAPON_TABLES.station).map(([id]) => id);
    /* Reserve part of the civilian budget for standing groups. Worlds author
     * their named characters spread out along walking routes, which is right
     * for them but leaves nobody actually stood in the square talking.
     *
     * The reserve is now a fixed number of slots rather than a fraction. At
     * 60% of the budget a world that authors twenty characters loses eight of
     * them to filler that exists to make a square look busy - and it is always
     * the *last* eight, which is to say whichever district was written most
     * recently. Holding back six and giving the rest to the author gets the
     * same populated plaza while letting a world with five districts have five
     * districts' worth of people in it.
     */
    const CROWD_RESERVE = crowdAllowed ? 6 : 0;
    const authored = spawns.reduce((n, s) => n + (s.type === 'hostile' ? 0 : 1), 0);
    /**
     * A world may ask for a larger civilian budget, on the same terms as
     * `hostileBudget` above and for the same reason.
     *
     * `maxFriendlies` is 30, and the station's cast passed it: the hub is a
     * plaza, a commercial strip, a cargo yard and a traffic tower, and each of
     * the four outer zones now wants a merchant, a quest manager and people to
     * talk to. Over the cap the loss is silent and it is always the LAST
     * authored spawns that go, which on the station means the zones - the
     * districts the player has to walk half a kilometre to reach. A merchant
     * nobody can meet is worse than no merchant, which is the same argument
     * the `maxNPCs` note above makes about the galley.
     *
     * `maxNPCs` is still the hard ceiling: this only redistributes the
     * character budget toward civilians, it cannot raise it.
     */
    const askedF = Number.isFinite(world.friendlyBudget)
      ? Math.floor(world.friendlyBudget) : this.maxFriendlies;
    const friendlyBudget = Math.max(0, Math.min(this.maxNPCs - maxHostiles, askedF));
    const authoredCap = crowdAllowed
      ? Math.max(4, Math.min(authored, friendlyBudget - CROWD_RESERVE))
      // No reserve to hold back and nothing to top up with - every authored
      // friendly gets a slot.
      : authored;

    /**
     * Wildlife budget.
     *
     * Gated on the same `hostiles` rule the armed cast is: a world that has
     * declared it wants nothing that fights the player - the maze - means that
     * about bears too. A world may raise or lower the count with `beastBudget`
     * on the same terms as `hostileBudget`, and `maxNPCs` is still the ceiling
     * over everything.
     */
    const askedB = Number.isFinite(world.beastBudget) ? Math.floor(world.beastBudget) : BEAST_CEILING;
    const beastBudget = hostilesAllowed ? Math.max(0, Math.min(BEAST_CEILING, askedB)) : 0;
    let beastCount = 0;

    const anchors = [];
    for (const spec of spawns) {
      if (this._npcs.length >= this.maxNPCs) break;
      /* A beast spawn is a GROUP, not a body: `{ type:'beast', species:'wolf' }`
       * is a pack, and the pack is the unit a world author thinks in. */
      if (spec.type === 'beast') {
        if (beastCount >= beastBudget) continue;
        beastCount += this.spawnBeastGroup(spec, beastBudget - beastCount).length;
        continue;
      }
      const hostile = spec.type === 'hostile';
      if (hostile && hostileCount >= maxHostiles) continue;
      if (!hostile && friendlyCount >= authoredCap) continue;

      const pos = this._snapToGround(spec.position);
      if (!pos) continue;

      const name = spec.name ?? (hostile ? `Sentinel ${hostileCount + 1}` : names[nameIndex++ % names.length]);
      const npc = this._createNPC({
        hostile,
        name,
        persona: spec.persona,
        position: pos,
        patrol: (spec.patrol ?? []).map((p) => this._snapToGround(p)),
        yaw: spec.yaw ?? 0,
        posture: spec.posture,
        role: spec.role ?? (hostile ? undefined : ROLE.WANDERER),
        // Authored dressing for the character. `signLines` was accepted by
        // `_createNPC` but never read off the descriptor, so a world could not
        // actually letter its own stall; `vendorCategories` / `vendorTitle` are
        // the shop restriction the Marketplace reads when it opens.
        signLines: spec.signLines,
        vendorCategories: spec.vendorCategories,
        vendorTitle: spec.vendorTitle,
        /* An authored quest manager. `_spawnQuestManagers` still plants one per
         * world from its own cast, because every world needs at least one and
         * most worlds do not author any; this is what lets a world scatter more
         * of them itself rather than have exactly one, always, at the spawn. */
        isQuestManager: spec.isQuestManager === true,
        /* An authored weapon beats the deal.
         *
         * The deal exists so a player meets every weapon in the theme's table
         * before any repeats, and it stays in charge of every hostile that does
         * not care. What it cannot express is an ARCHETYPE - a breacher that is
         * only a breacher because it carries a baton, a marksman that is only a
         * marksman because it carries a rifle - because the deal is shuffled
         * precisely so the pairing is unlearnable. A named enemy whose weapon is
         * part of its identity says so here; `weaponPool` is still passed so a
         * respawn re-rolls within the theme rather than being frozen forever. */
        weaponId: hostile ? (spec.weaponId ?? weaponDeal[hostileCount]) : undefined,
        weaponPool: hostile ? (spec.weaponPool ?? weaponPool) : undefined,
        /* Only an AUTHORED weapon is fixed. The deal above is shuffled on
         * purpose, so a character that took its weapon from the deal keeps
         * re-rolling on first contact exactly as it always did - see
         * `weaponFixed` in HostileNPC. */
        weaponFixed: hostile && !!spec.weaponId,
      });
      npc.spawnSpec = spec;
      if (hostile) hostileCount++;
      else {
        friendlyCount++;
        anchors.push(pos);
      }
    }

    friendlyCount += this._spawnLorekeepers(world);
    this._spawnQuestManagers(world);
    this._populateHubs(anchors, crowdAllowed ? friendlyBudget - friendlyCount : 0);
    for (const npc of this._hostiles) npc.prebuildWeapons?.();
    this._seatCivilians();
    this.validateGrounding();
  }

  /**
   * Spawn ONE character from a world spec, after `spawnForWorld` has run.
   *
   * `spawnForWorld` is a world-activation event: it clears everything and
   * rebuilds the whole cast from a fixed list. That is the right shape for a
   * world whose population is authored once, and the wrong shape for one whose
   * population STREAMS - the maze spawns a district's wanderer when that
   * district's hedges are built and releases them when they are released (see
   * `MazePopulation`), because 2.4 km of maze with a flat cast in it is a maze
   * where the nearest wanderer measured 543 m away.
   *
   * Friendlies only, deliberately. A streamed-in hostile would arrive with no
   * respawn bookkeeping and no weapon deal, and nothing in the game wants one:
   * the only world that streams population forbids hostiles outright.
   *
   * Returns null rather than throwing when the budget is full, so the caller's
   * residency bookkeeping can carry a spec with no character behind it and try
   * again later.
   *
   * The DRESSING a spec carries is honoured here exactly as `spawnForWorld`
   * honours it. It was not, and the omission was invisible until a world
   * streamed a shop: a merchant arriving through this path lost its
   * `vendorCategories` (so the Marketplace opened the whole catalogue at a
   * fishing village), lost its `signLines` (so the stall was unlettered) and
   * lost `isQuestManager` (so the reeve of a town two hundred metres from the
   * spawn had no quest board). A streamed character has to be the same
   * character as an authored one or streaming is not a placement decision, it
   * is a downgrade.
   *
   * @param {{position: THREE.Vector3, type?: string, name?: string, persona?: string,
   *          patrol?: THREE.Vector3[], yaw?: number, posture?: string, role?: string,
   *          signLines?: string[], vendorCategories?: string[], vendorTitle?: string,
   *          isQuestManager?: boolean}} spec
   * @returns {import('./NPC.js').NPC|null}
   */
  spawnOne(spec) {
    if (!spec?.position) return null;
    if (spec.type === 'hostile') return null;
    if (this._npcs.length >= this.maxNPCs) return null;

    const pos = this._snapToGround(spec.position);
    if (!pos) return null;

    const npc = this._createNPC({
      hostile: false,
      name: spec.name ?? 'A Lost Wanderer',
      persona: spec.persona,
      position: pos,
      patrol: (spec.patrol ?? []).map((p) => this._snapToGround(p)),
      yaw: spec.yaw ?? 0,
      posture: spec.posture,
      role: spec.role ?? ROLE.WANDERER,
      signLines: spec.signLines,
      vendorCategories: spec.vendorCategories,
      vendorTitle: spec.vendorTitle,
      isQuestManager: spec.isQuestManager === true,
    });
    npc.spawnSpec = spec;
    /* The same audit `spawnForWorld` runs over the whole cast at the end. A
     * character streamed in one at a time gets it one at a time. */
    npc.auditGrounding(true);
    return npc;
  }

  /* ---------------------------------------------------------------- */
  /* Beasts                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Spawn one authored pack.
   *
   * The unit a world authors is a GROUP, because that is the unit the design
   * is expressed in: "a wolf pack lives in the north woods" is one line, and
   * whether it is three wolves or five is the species' business, not the
   * author's. A bear's pack size is 1..1, so the same call spawns a loner.
   *
   * Members are scattered around the anchor rather than stacked on it, and each
   * is resolved onto real geometry the way every other spawn is - so a pack
   * authored on a slope arrives standing on the slope.
   *
   * @param {{position:THREE.Vector3, species?:string, count?:number,
   *          territory?:number, roamSpeed?:number, yaw?:number, name?:string,
   *          spread?:number}} spec
   * @param {number} [budget] hard cap on how many this call may create
   * @returns {import('./BeastNPC.js').BeastNPC[]}
   */
  spawnBeastGroup(spec, budget = BEAST_CEILING) {
    const out = [];
    if (!spec?.position || budget <= 0) return out;
    const def = beastDef(spec.species);
    const seed = (this._hashSeed(this.worldId ?? '') ^ (this._seedCounter * 0x9e3779b1)) >>> 0;
    let s = seed || 3;
    const rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };

    const home = this._snapToGround(spec.position);
    if (!home) return out;

    const asked = Number.isFinite(spec.count) ? Math.floor(spec.count) : rollPackSize(def, rnd);
    const count = Math.max(1, Math.min(asked, budget, def.packMax));
    // A single animal has nothing to coordinate with, and a pack of one that
    // still holds a ring bearing would orbit its target forever without ever
    // being given an attack slot's worth of reason to close.
    const pack = count > 1 ? new BeastPack({ species: def.id, seed }) : null;
    const spread = spec.spread ?? (def.bodyRadius * 4 + count * 0.5);

    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + rnd() * 0.8;
      const r = i === 0 ? 0 : spread * (0.4 + rnd() * 0.6);
      _v1.set(home.x + Math.cos(a) * r, home.y + 1.5, home.z + Math.sin(a) * r);
      const pos = this._snapToGround(_v1);
      if (!pos) continue;
      const beast = this._createBeast({
        species: def.id,
        name: spec.name ?? def.name,
        position: pos,
        home,
        pack,
        yaw: spec.yaw ?? rnd() * Math.PI * 2,
        territory: spec.territory,
        roamSpeed: spec.roamSpeed,
      });
      if (beast) out.push(beast);
    }
    return out;
  }

  /**
   * Spawn one beast, after `spawnForWorld` has run.
   *
   * The programmatic path, and the mirror of `spawnOne` for civilians: a
   * scripted encounter, a quest, or a world that streams its wildlife the way
   * the maze streams its wanderers can reach for this without going near
   * `npcSpawns`. Returns null rather than throwing when the budget is full.
   *
   * @param {{position:THREE.Vector3, species?:string, home?:THREE.Vector3,
   *          pack?:BeastPack, yaw?:number, name?:string, territory?:number,
   *          roamSpeed?:number}} spec
   * @returns {import('./BeastNPC.js').BeastNPC|null}
   */
  spawnBeast(spec) {
    if (!spec?.position) return null;
    const pos = this._snapToGround(spec.position);
    if (!pos) return null;
    const beast = this._createBeast({ ...spec, position: pos });
    // The same audit `spawnForWorld` runs over the whole cast at the end.
    beast?.auditGrounding(true);
    return beast;
  }

  /**
   * Build one beast and file it.
   *
   * Beasts are filed as HOSTILES, which is what buys the respawn queue, the
   * alert propagation and the quest kill-tracking for free - see the note on
   * `type` in `BeastNPC`'s constructor. They are deliberately NOT given a
   * weapon deal: a wolf's weapon is its face.
   */
  _createBeast(o) {
    if (this._npcs.length >= this.maxNPCs) return null;
    const def = beastDef(o.species);
    const seed = (this._hashSeed(this.worldId ?? '') ^ (this._seedCounter++ * 2654435761)) >>> 0;
    const body = new BeastBody({ species: def.id, materials: this.materials, seed });

    const npc = new BeastNPC({
      species: def.id,
      name: o.name ?? def.name,
      position: o.position,
      home: o.home ?? o.position,
      pack: o.pack ?? null,
      theme: this.theme,
      scene: this.scene,
      physics: this.physics,
      bus: this.bus,
      manager: this,
      humanoid: body,
      seed,
      yaw: o.yaw ?? 0,
    });
    /* PER-SPAWN OVERRIDES, copied onto a fresh object rather than written into
     * the shared species row: `beastDef` returns the ONE table entry every
     * animal of that species reads, so mutating it would re-tune every wolf in
     * the game.
     *
     * `roamSpeed` is here for the same reason `territory` is, and it is the
     * caravan that needs it. `Caravans.driveHerds` walks a train's `home`
     * anchors along the road at `CARAVAN_SPEED`, and `BeastNPC._roam` steers at
     * `def.roamSpeed`; the camel row's grazing pace is 1.15 m/s, which is
     * exactly `CARAVAN_SPEED`, so an animal's top speed equalled its own
     * anchor's and the gap could only ever grow. Measured on the shipped
     * placement before this override, one train followed for 300 s: 0.61 m/s
     * made good against an anchor at 1.15, and camel-to-slot distance climbing
     * 19 m -> 96 m on a 5 m territory. @see Caravans.TRAIN_ROAM_SPEED. */
    if (Number.isFinite(o.territory) || Number.isFinite(o.roamSpeed)) {
      npc.def = {
        ...def,
        territory: Number.isFinite(o.territory) ? o.territory : def.territory,
        roamSpeed: Number.isFinite(o.roamSpeed) ? o.roamSpeed : def.roamSpeed,
      };
    }
    o.pack?.add(npc);

    npc.setWater(this.water);
    npc.setWorldGravity(this.gravityWorld);
    this._npcs.push(npc);
    this._hostiles.push(npc);
    this.bus?.emit('npc:spawned', { npc });
    return npc;
  }

  /**
   * A beast's blow connected.
   *
   * The same contract `npcFire` has, and for the same reason: the AI decides
   * that something was hit, and the combat system owns everything that happens
   * next - the damage, the knockback, the camera kick, the claw decal, the
   * bleed. If nothing is listening we resolve it here so a beast is never
   * toothless, which is exactly the fallback a hostile's gunfire already has.
   *
   * @param {import('./BeastNPC.js').BeastNPC} beast
   * @param {{target:any, isPlayer:boolean, damage:number,
   *          origin:THREE.Vector3, direction:THREE.Vector3, def:any}} hit
   */
  beastMaul(beast, hit) {
    if (!beast || !hit?.target) return;
    const handlers = this.bus?._handlers?.get('beast:maul');
    this.bus?.emit('beast:maul', { beast, ...hit });
    if (handlers && handlers.size > 0) return;

    // Nothing resolved it: apply the damage directly. Knockback and bleed are
    // the combat system's to give, so a fallback maul is a plain hit - it is a
    // safety net, not a second implementation.
    if (hit.isPlayer) {
      hit.target.applyDamage?.(hit.damage, hit.origin.clone(), beast.id);
    } else {
      hit.target.applyDamage?.(hit.damage, false, beast);
    }
  }

  /**
   * True while this manager still holds `npc`.
   *
   * Streaming callers keep their own reference to a character they asked for
   * (see `MazePopulation`), and `clear()` / `spawnForWorld()` dispose the whole
   * cast on every world activation without telling them - so a held reference
   * is only ever as good as this answer. Without it the caller cannot tell
   * "already populated" from "populated, then wiped", which is a distinction it
   * has to make on every frame and got wrong silently.
   *
   * @param {import('./NPC.js').NPC|null} npc
   * @returns {boolean}
   */
  owns(npc) {
    return !!npc && this._npcs.indexOf(npc) >= 0;
  }

  /**
   * Remove one character spawned by `spawnOne`, releasing everything `clear()`
   * would have released for it.
   *
   * Every list that can hold a reference is swept, not just `_npcs`: a corpse
   * left in `_hostiles` respawns, a vendor left in `_vendors` opens a shop for
   * a character that is not there, and - the one that actually bites - a
   * despawned `_chatNPC` leaves the chat prompt on screen pointing at nothing.
   * `socialPartner` is cleared for the same reason: it is a hard reference held
   * by a character that is staying.
   *
   * @param {import('./NPC.js').NPC} npc
   * @returns {boolean} true when this manager owned it
   */
  despawn(npc) {
    if (!npc) return false;
    const i = this._npcs.indexOf(npc);
    /* Not ours - already released by `clear()` on a world change, most likely.
     * Returning quietly rather than disposing again: `dispose()` on an NPC
     * whose meshes are already gone is not safe to repeat. */
    if (i < 0) return false;
    this._npcs.splice(i, 1);

    for (const list of [this._friendlies, this._hostiles, this._vendors, this._respawnQueue]) {
      const k = list.indexOf(npc);
      if (k >= 0) list.splice(k, 1);
    }
    for (const other of this._friendlies) {
      if (other.socialPartner === npc) other.socialPartner = null;
    }
    // A pack holds a hard reference to every member and hands out ring bearings
    // by rank, so a despawned wolf left in the roster would leave a permanent
    // gap in the circle its packmates orbit.
    npc.pack?.remove?.(npc);
    if (this._chatNPC === npc) {
      this._chatNPC = null;
      this.bus?.emit('chat:available', { npc: null });
    }

    this.bus?.emit('npc:despawned', { npc });
    npc.root.removeFromParent();
    npc.dispose();
    // The watchdog cursor indexes `_npcs`; the array just got shorter.
    if (this._groundCursor >= this._npcs.length) this._groundCursor = 0;
    return true;
  }

  setLoreData(entries) {
    this._loreData = entries ?? DEFAULT_LORE;
    const lorekeepers = this._friendlies.filter((npc) => npc.isLorekeeper);
    for (const npc of lorekeepers) {
      const scope = npc.loreScope ?? this.worldId ?? 'overall';
      const entry = this._loreData?.[scope] ?? loreEntryForScope(scope);
      npc.persona    = buildLorePersona(scope, this._loreData);
      npc.loreTitle  = String(entry.title ?? 'World Lore');
      npc.loreBody   = String(entry.body ?? '');
      npc.setSignLines?.([
        String(entry.sign_label ?? 'Lorekeeper').toUpperCase(),
        String(entry.title ?? scope).toUpperCase(),
      ]);
    }
  }

  /**
   * Deal one weapon id per hostile.
   *
   * Every id the theme uses appears at least once before any repeats, so a
   * player always meets the full mix, and the shuffle keeps it from being the
   * same character carrying the same thing every time.
   *
   * @param {number} count
   * @returns {string[]}
   */
  _dealWeapons(count) {
    const table = WEAPON_TABLES[this.theme] ?? WEAPON_TABLES.station;
    const ids = table.map(([id]) => id);
    const weights = table.map(([, w]) => w);
    const out = [];
    for (let i = 0; i < count; i++) {
      if (i < ids.length) {
        out.push(ids[i]);
        continue;
      }
      let total = 0;
      for (const w of weights) total += w;
      let roll = Math.random() * total;
      let picked = ids[0];
      for (let k = 0; k < ids.length; k++) {
        roll -= weights[k];
        if (roll <= 0) {
          picked = ids[k];
          break;
        }
      }
      out.push(picked);
    }
    // Fisher-Yates, so "the first hostile always has the sidearm" is not a rule
    // the player can learn.
    for (let i = out.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const t = out[i];
      out[i] = out[j];
      out[j] = t;
    }
    return out;
  }

  /**
   * Sit a couple of civilians down on whatever the world already has to sit on.
   *
   * There is no authored seat data in any of these worlds, so seats are found
   * rather than placed: `seatSurfaceAt` looks for a narrow surface a bench's
   * height above the floor near each standing civilian. Benches, planter rims,
   * bleacher treads and low walls all match; buildings and crates do not.
   *
   * Capped low on purpose - a plaza with two or three people sat down reads as
   * a plaza, one with a dozen reads as a waiting room.
   */
  _seatCivilians() {
    let seated = 0;
    const cap = 4;
    for (const npc of this._friendlies) {
      if (seated >= cap) break;
      if (!npc.roleDef?.seatable || npc.seated) continue;
      const floor = npc.position.y;
      let found = null;
      // Search a short ring around the character rather than only under their
      // feet: they were placed on open ground on purpose, and the bench is the
      // thing they were placed *next to*.
      for (const r of [0.9, 1.5, 2.2]) {
        for (let i = 0; i < 6 && !found; i++) {
          const a = (i / 6) * Math.PI * 2 + r;
          const x = npc.position.x + Math.cos(a) * r;
          const z = npc.position.z + Math.sin(a) * r;
          const y = seatSurfaceAt(this.physics, x, z, floor);
          if (y !== null) found = { x, y, z };
        }
        if (found) break;
      }
      if (!found) continue;
      npc.position.set(found.x, found.y, found.z);
      npc.spawnPoint.copy(npc.position);
      npc.setSeated(true, found.y - floor);
      seated++;
    }
    this._seatedCount = seated;
  }

  /**
   * Post-spawn grounding sweep.
   *
   * Every character is re-audited against the full surface stack at its column
   * the moment the world finishes spawning, and anything that resolved onto a
   * roof, into a basement or inside a mesh is corrected before the first frame
   * is drawn. `NPC.auditGrounding` is the same check the runtime watchdog runs.
   *
   * @returns {number} how many characters had to be corrected
   */
  validateGrounding() {
    let fixed = 0;
    for (const npc of this._npcs) {
      if (npc.auditGrounding(true)) fixed++;
    }
    this._groundFixes += fixed;
    return fixed;
  }

  /**
   * Adopt the active world's water volumes and push them down to every agent.
   *
   * Called from the `water:volumes` announcement, which fires on every world
   * change - so this is also what *clears* the medieval river when the player
   * portals to a world that has no water at all.
   *
   * @param {import('../systems/WaterVolumes.js').WaterVolumes|null} water
   */
  setWater(water) {
    this.water = water || null;
    for (const npc of this._npcs) npc.setWater(this.water);
  }

  /**
   * Pull one character out of deep water, on the same round-robin as the
   * grounding watchdog.
   *
   * Steering keeps characters from walking in, but it cannot help anyone who is
   * already there - dropped in by a respawn, shoved off a bank by the crowd
   * separation pass, or knocked in by an explosion. Without this they would
   * simply live in the river.
   *
   * @param {import('./NPC.js').NPC} npc
   * @returns {boolean} true if the character had to be moved
   */
  _auditWater(npc) {
    if (!this.water || !npc || npc.isDead) return false;
    const p = npc.position;
    /* Probed at the character's own feet, or every bridge deck in the vale is
     * a drowning: they all stand above the ray's old fixed origin, so anyone
     * who reached one measured metres of river and was teleported to the bank.
     * Something genuinely IN the water has its feet at or under the surface and
     * measures exactly what it always did. @see Grounding.waterDepthAt */
    if (!isDeepWater(this.physics, this.water, p.x, p.z, p.y)) return false;
    const dry = nearestDrySpot(this.physics, this.water, p, _dryScratch);
    if (!dry) return false;
    npc.position.copy(dry);
    npc.velocity.set(0, 0, 0);
    // Re-home them too: a character whose spawn point is in the river would
    // walk straight back in the moment it next decided to go home.
    if (isDeepWater(this.physics, this.water, npc.spawnPoint.x, npc.spawnPoint.z)) {
      npc.spawnPoint.copy(dry);
    }
    npc.nav?.clear?.();
    npc.auditGrounding(true);
    return true;
  }

  /**
   * Build one character and file it. Everything a world can author and
   * everything the crowd filler needs goes through here.
   *
   * @param {{hostile:boolean, name:string, persona?:string, position:THREE.Vector3,
   *          patrol?:THREE.Vector3[], yaw?:number, anchored?:boolean,
   *          groupFocus?:THREE.Vector3, posture?:string, signLines?:string[],
   *          vendorCategories?:string[], vendorTitle?:string}} o
   */
  /**
   * Which authored hero role, if any, this spawn is.
   *
   * ── Derived from what the spawn already says, on purpose ─────────────────
   * The obvious implementation is a `heroKind` field on every station spawn
   * descriptor. That would mean editing two duplicated hostile tables in two
   * files plus every named friendly in four zone files, and it would put an art
   * decision in the encounter design - so the next person who adds a Breaker
   * Frame to a new alley would get a human unless they remembered a field.
   *
   * Instead it is read off the two things the spawn ALREADY carries and cannot
   * omit: a hostile's fixed `weaponId`, which is what the four archetypes are
   * distinguished by in the first place (see `HOSTILE_KIND` in StationWorld),
   * and a friendly's `role`. A new hostile authored with a baton is a Breaker
   * Frame and looks like one without anyone doing anything.
   *
   * STATION ONLY. Phase 6 is the station's characters. The medieval valley's
   * townsfolk and the citadel's traders are Phase 9's problem, and giving them
   * ape features here would be a silent, world-wide art change nobody asked
   * for - which is exactly the shape of mistake this codebase keeps recording.
   *
   * @returns {string|null} a `manifest.roles` key, or null for procedural
   */
  _heroRole(o) {
    if (this.worldId !== 'station') return null;
    if (o.hostile) {
      /* The archetype is the weapon. A hostile whose weapon was DEALT rather
       * than authored has no stable identity to dress - `weaponFixed` is what
       * `StationWorld` sets on the four named archetypes - so an unfixed
       * hostile stays procedural rather than changing species on respawn. */
      if (!o.weaponFixed) return null;
      return HERO_BY_WEAPON[o.weaponId] ?? null;
    }
    const role = o.role ?? ROLE.WANDERER;
    return HERO_ROLES.has(role) ? role : null;
  }

  /**
   * The colour half of a hero character.
   *
   * Authored geometry, procedural colour: the shapes come out of the `.glb` and
   * everything that makes an attacker read as violet-black and a crew ape as
   * dark-furred is chosen here, through the same `create()` parameters any
   * character has always taken. No new material, no new texture.
   *
   * A gorilla is nearly black all over, so `skinTone` does the work for the
   * cranium, muzzle, ears and knuckles at once - they all draw in the SKIN
   * slot. `hairStyle: 'bald'` is not cosmetic: the procedural hair shell is a
   * cranium-shaped cap, and leaving it on puts a human haircut on top of an
   * ape's crested skull.
   */
  _heroLook(hero, seed) {
    const raider = HERO_RAIDERS.has(hero);
    const tones = raider ? RAIDER_TONES : CREW_TONES;
    return {
      hero,
      hairStyle: 'bald',
      headgear: 'none',
      skinTone: tones[seed % tones.length],
      // Crew keep the station's civilian palette - `n2` and `n4` are pale
      // suits, so the value contract is already right for them.
      palette: raider ? RAIDER_PALETTE : undefined,
      // Deep-set eyes under a heavy brow read as dark whatever colour they are;
      // the raiders' violet comes from the GLOW-slot eye caps, not from here.
      eyeColor: raider ? 0x2a1030 : 0x3a2416,
      /* Heavier and broader than a person, and then the body plan on top.
       *
       * The first pass stopped at `build`/`frame`/`shoulderScale`, which is a
       * wider heavier PERSON, and the screenshot of it against `g1` is the
       * whole argument for this line: an authored ape head on a human body
       * reads as a man in a gorilla mask, because a silhouette is what a
       * player perceives first and a silhouette is legs, arms and shoulders.
       * `ape` is the vertical remap in `makeProportions` - short legs, a long
       * deep torso, arms that hang toward the knee, a neck set forward.
       *
       * The crew sit at 0.85 rather than 1. `n1` and `n2` are the same animal
       * as `g1` inside a pressure suit that squares off the shoulders and pads
       * the legs, and they photograph a little closer to human than the
       * attackers do; the two values are also two geometry cache families,
       * which is what these eleven already cost. */
      build: 2,
      frame: 0,
      ape: raider ? 1 : 0.85,
      shoulderScale: raider ? 1.16 : 1.08,
      height: raider ? 1.86 : 1.72,
      /* The head ratio is the tell. @see Humanoid `headScale`. The raiders are
       * bigger-headed than the crew because `g1`-`g4` are: a roaring open jaw
       * needs the mass behind it or it reads as a shout rather than a threat. */
      /* Measured off the studio shots against `n2`: at 1.30 the crew's head
       * came out 16.6% of standing height where the reference is 19%, and the
       * raider's 1.42 already lands at 21%. The gap read as the crew being a
       * slightly different animal to the attackers, which they are not. */
      headScale: raider ? 1.42 : 1.38,
      rim: raider ? { hex: 0xa855f7, strength: 0.55 } : undefined,
    };
  }

  _createNPC(o) {
    const seed = (this._hashSeed(this.worldId ?? '') ^ (this._seedCounter++ * 2654435761)) >>> 0;
    const hero = this._heroRole(o);
    const humanoid = this.factory.create({
      seed,
      theme: this.theme,
      // Hostiles read as a unit: heavier builds and the armoured variant.
      variant: o.hostile ? this._hostileVariant() : undefined,
      build: o.hostile ? (seed % 3 === 0 ? 2 : 1) : undefined,
      ...(hero ? this._heroLook(hero, seed) : null),
    });

    const ctx = {
      name: o.name,
      persona: o.persona,
      position: o.position,
      patrol: o.patrol ?? [],
      theme: this.theme,
      scene: this.scene,
      physics: this.physics,
      bus: this.bus,
      manager: this,
      humanoid,
      seed,
      yaw: o.yaw ?? 0,
      anchored: o.anchored,
      groupFocus: o.groupFocus,
      posture: o.posture,
      role: o.role,
      weaponId: o.weaponId,
      weaponPool: o.weaponPool,
      weaponFixed: o.weaponFixed,
    };
    const npc = o.hostile ? new HostileNPC(ctx) : new FriendlyNPC(ctx);
    // A world-authored posture is a costume note, not a life sentence: the idle
    // loop still runs, it just starts from the pose the world asked for.
    if (o.posture) npc.fixedPosture = true;
    npc.isLorekeeper   = o.role === ROLE.LOREKEEPER;
    npc.isQuestManager = o.isQuestManager ?? false;
    npc.loreScope = o.loreScope ?? null;
    // A world may sell only part of the catalogue from a given stall - a galley
    // that stocks food and kit but no weapons. The Marketplace reads these off
    // the NPC when the shop opens; leaving them unset is the general trader
    // every existing vendor already is.
    if (Array.isArray(o.vendorCategories) && o.vendorCategories.length) {
      npc.vendorCategories = o.vendorCategories.map((c) => String(c));
    }
    if (o.vendorTitle) npc.vendorTitle = String(o.vendorTitle);
    if (o.signLines) npc.setSignLines?.(o.signLines);
    if (npc.isVendor && !o.signLines) {
      npc.setSignLines?.([
        'MERCHANT',
        MERCHANT_SIGN_WORLD[this.worldId] ?? String(this.worldId ?? 'NEXUS').toUpperCase(),
      ]);
    }
    // Before the first step it takes: a character created after the world's
    // water was announced would otherwise steer blind until the next swap. The
    // gravity goes with it, and for the same reason - see `gravityWorld`.
    npc.setWater(this.water);
    npc.setWorldGravity(this.gravityWorld);
    this._npcs.push(npc);
    if (o.hostile) {
      this._hostiles.push(npc);
    } else {
      this._friendlies.push(npc);
      if (npc.isVendor) this._vendors.push(npc);
    }
    this.bus?.emit('npc:spawned', { npc });
    return npc;
  }

  _spawnLorekeepers(world) {
    // One lorekeeper per portal is a manager-added convenience, not something
    // `npcSpawns` asked for - a world with crowd: false (the maze, which
    // already hand-authors its own keeper - see KEEPER_PERSONA in
    // MazeWorld.js) must not get a second, generic one standing next to it.
    if (!allows(world, 'crowd')) return 0;
    const specs = world?.portalSpecs ?? [];
    /* Does a keeper here speak about the gateway, or about the world it stands
     * in? See `lorekeeperScope` above - the rule is derived from the ring, and
     * `perGateway` is only ever true at the hub. */
    let made = 0;
    for (let i = 0; i < specs.length && this._npcs.length < this.maxNPCs; i++) {
      const spec = specs[i];
      const scope = lorekeeperScope(world, spec);
      const perGateway = scope !== world.id;
      const rotY = spec.rotationY ?? 0;
      const right = new THREE.Vector3(Math.cos(rotY), 0, -Math.sin(rotY));
      const normal = new THREE.Vector3(Math.sin(rotY), 0, Math.cos(rotY));
      const base = spec.position.clone()
        .addScaledVector(normal, 2.6)
        .addScaledVector(right, i % 2 === 0 ? 2.1 : -2.1);
      const spot = this._snapToGround(base);
      if (!spot) continue;
      const entry = this._loreData?.[scope] ?? loreEntryForScope(scope);
      const label = String(entry.sign_label ?? 'Lorekeeper').toUpperCase();
      const persona = buildLorePersona(scope, this._loreData);
      /* The board says where the gateway goes, not where the player is: at the
       * hub the keeper's own placard is the second half of the wayfinding, and
       * six boards all reading AETHER NEXUS told the player nothing. */
      const board = perGateway
        ? String(spec.label ?? entry.title ?? scope)
        : String(world.displayName ?? world.id);
      const npc = this._createNPC({
        hostile: false,
        /* "TO <somewhere>", not just "<somewhere>".
         *
         * A keeper beside the yard's gateway to the station is CORRECTLY given
         * the station's scope and correctly recites station lore - that is the
         * whole point of `lorekeeperScope`, and it is pinned by a test. But it
         * read as a bug from the floor: a tester in the shipyard met
         * "LOREKEEPER - AETHER NEXUS STATION" over a subtitle reading
         * "friendly · Lodestar Yard", listened to a paragraph about a station
         * they were nowhere near, and wrote it up as content in the wrong
         * world. One preposition turns the name from a claim about where you
         * are into a claim about where the arch goes, which is what it always
         * meant. */
        name: perGateway ? `${label} - to ${board}` : label,
        persona,
        position: spot,
        yaw: rotY + Math.PI,
        anchored: true,
        role: ROLE.LOREKEEPER,
        posture: 'crossed',
        signLines: perGateway ? [label, `TO ${board.toUpperCase()}`] : [label, board.toUpperCase()],
        loreScope: scope,
      });
      npc.isLorekeeper = true;
      npc.loreTitle = String(entry.title ?? 'World Lore');
      npc.loreBody  = String(entry.body ?? '');
      npc.portalTarget = spec.target;
      made++;
    }
    return made;
  }

  /**
   * Spawn one Quest Manager NPC per world, anchored in a fixed position near
   * the player spawn so they are always easy to find. Each world has a named
   * character with appropriate persona.
   *
   * @param {import('../worlds/World.js').World} world
   */
  _spawnQuestManagers(world) {
    if (!world) return;

    /**
     * World-specific Quest Manager cast.
     * position: [x, y, z] in world-space (snapped to ground)
     * yaw: facing direction (radians)
     */
    const CAST = {
      station: {
        name: 'Zara Vex',
        persona: 'The Quest Manager for Aether Nexus Station: a sharp, efficient coordinator who has dispatched hundreds of agents through every gateway on the ring. She speaks in mission briefings, rates everything by risk-versus-reward, and keeps a running tally of completed objectives on a holo-pad she never puts down. Gateway 06 finally has a briefing - the yard behind it got commissioned - and she is faintly annoyed at how long that took.',
        position: [-22, 0.2, 12],
        yaw: -Math.PI / 2,
        sign: ['QUEST MANAGER', 'AETHER NEXUS'],
      },
      medieval: {
        name: 'Edmund Marsh',
        persona: 'Quest Manager for Aldermoor Vale: a former knight who now coordinates missions from a market stall covered in parchment scrolls. He is methodical, formal, and expects every job to be done properly. He uses old-world titles and is quietly proud of his record.',
        position: [10, 0.2, -9],
        yaw: 2.5,
        sign: ['QUEST MANAGER', 'ALDERMOOR VALE'],
      },
      sports: {
        name: 'Petra Vance',
        persona: 'Quest Manager for the Meridian Athletic Grounds: a former champion athlete turned talent coordinator. She is direct, competitive, and constantly evaluating performance. She quotes personal bests, issues challenges, and believes any task worth doing is worth optimising.',
        position: [-8, 0.9, 128],
        yaw: Math.PI,
        sign: ['QUEST MANAGER', 'MERIDIAN ARENA'],
      },
      citadel: {
        name: 'Aldric Storne',
        persona: 'Quest Manager for Sunspire Citadel: a senior officer of the Citadel garrison who assigns official missions. He is grave, measured, and speaks with the authority of the walls behind him. Every mission he issues is considered; none are trivial.',
        position: [8, 14.3, 88],
        yaw: 0,
        sign: ['QUEST MANAGER', 'SUNSPIRE CITADEL'],
      },
      /* Lodestar Yard's dispatcher, and NOT its Yard Warden.
       *
       * The warden is authored by the world itself (`DockWorld._publish`)
       * because she is the yard's lore voice: the dock has two gateways, so
       * `lorekeeperScope` gives each of its automatic keepers the DESTINATION's
       * scope - `station` and `space` - and nobody in the yard would otherwise
       * recite the yard. Making her the quest manager as well would have put
       * two characters with the same name on the same apron, since this table
       * and `npcSpawns` do not know about each other. */
      dock: {
        name: 'Dispatcher Selim Bregovic',
        persona:
          'Quest Manager for Lodestar Yard: the man who turns what the Yard Warden wants into jobs with numbers on them. Brisk, faintly harassed, works off a board of chalked section numbers and hands out work by berth. He has been holding a launch checklist for four hulls since the site was commissioned and has never got to the bottom of it.',
        position: [10, 0.2, 40],
        yaw: -0.6,
        sign: ['QUEST MANAGER', 'LODESTAR YARD'],
      },
      race: {
        name: 'Kai Torres',
        persona: 'Quest Manager for Vellum Ridge: a former race strategist who now runs the mission board in the paddock. Kai is fast-talking, data-driven, and has an opinion on every racing line on all three circuits - the ridge, the gorge, and the loop at Aurora Rise. They make every briefing feel like a pre-race countdown.',
        position: [30, 0.2, 20],
        yaw: -Math.PI / 4,
        sign: ['QUEST MANAGER', 'VELLUM CIRCUIT'],
      },
    };

    const spec = CAST[world.id];
    if (!spec) return;
    if (this._npcs.length >= this.maxNPCs) return;

    const raw = new THREE.Vector3(spec.position[0], spec.position[1], spec.position[2]);
    const pos = this._snapToGround(raw);
    if (!pos) return;

    const npc = this._createNPC({
      hostile: false,
      name: spec.name,
      persona: spec.persona,
      position: pos,
      yaw: spec.yaw,
      anchored: true,
      role: ROLE.QUEST_MANAGER,
      posture: 'crossed',
      signLines: spec.sign,
      isQuestManager: true,
    });
    npc.isQuestManager = true;
  }

  /**
   *
   * Hubs are derived from where the world already put its named civilians, so
   * the extra population lands in the plaza or the market square rather than in
   * a random field. Each group is a small ring facing a common centre - the
   * single cheapest thing that makes a space read as inhabited.
   *
   * @param {THREE.Vector3[]} anchors authored friendly positions
   * @param {number} budget how many more civilians we are allowed to add
   */
  _populateHubs(anchors, budget) {
    if (budget <= 0 || anchors.length === 0) return;
    const hubs = this._clusterHubs(anchors, 22);
    const names = CROWD_NAMES[this.theme] ?? CROWD_NAMES.station;
    const personas = CROWD_PERSONAS[this.theme] ?? CROWD_PERSONAS.station;
    let rnd = this._hashSeed(`${this.worldId}:crowd`) >>> 0;
    const next = () => ((rnd = (rnd * 1664525 + 1013904223) >>> 0) / 4294967296);

    let made = 0;
    let nameIdx = 0;
    let guard = 0;
    /** How many of each role have been handed out, so names do not repeat. */
    const roleCounts = new Map();
    // Round-robin over the hubs so no single plaza gets the whole crowd.
    while (made < budget && this._npcs.length < this.maxNPCs && guard++ < 60) {
      const hub = hubs[guard % hubs.length];
      const size = Math.min(budget - made, 2 + ((next() * 2) | 0));
      const angle = next() * Math.PI * 2;
      const radius = 3.5 + next() * 7;
      _v1.set(hub.x + Math.cos(angle) * radius, hub.y, hub.z + Math.sin(angle) * radius);
      const centre = this._snapToGround(_v1, new THREE.Vector3());
      if (Math.abs(centre.y - hub.y) > 4) continue;

      const ring = 0.85 + next() * 0.4;
      let placed = 0;
      for (let i = 0; i < size; i++) {
        const a = angle + (i / size) * Math.PI * 2 + next() * 0.4;
        _v2.set(centre.x + Math.cos(a) * ring, centre.y + 1.2, centre.z + Math.sin(a) * ring);
        const spot = this._findStandingSpot(_v2, centre.y);
        if (!spot) continue;
        // Face the middle of the group. Characters face -Z at yaw 0.
        _v3.subVectors(centre, spot);
        const yaw = Math.atan2(-_v3.x, -_v3.z);
        // Every filled slot gets a job. The rotation guarantees a vendor early
        // (the Marketplace needs one to open next to) and then spreads guards,
        // spectators and loiterers across the hubs.
        const role = ROLE_ROTATION[nameIdx % ROLE_ROTATION.length];
        const def = roleDef(role);
        const roleIdx = roleCounts.get(role) ?? 0;
        roleCounts.set(role, roleIdx + 1);
        const cast = castFor(this.theme, role, roleIdx);
        this._createNPC({
          hostile: false,
          name: cast?.name ?? names[nameIdx % names.length],
          persona: cast?.persona ?? personas[nameIdx % personas.length],
          position: spot,
          yaw,
          anchored: true,
          groupFocus: centre,
          role,
          posture: def.postures[(next() * def.postures.length) | 0],
        });
        nameIdx++;
        placed++;
        made++;
        if (made >= budget || this._npcs.length >= this.maxNPCs) break;
      }
      // A group of one is just a lonely person; give the hub another try.
      if (placed === 0) continue;
    }
  }

  /** Greedy spatial clustering of authored spawns into hub centres. */
  _clusterHubs(points, radius) {
    const hubs = [];
    const r2 = radius * radius;
    for (const p of points) {
      let hub = null;
      for (const h of hubs) {
        if (h.distanceToSquared(p) < r2) {
          hub = h;
          break;
        }
      }
      if (hub) hub.lerp(p, 0.5);
      else hubs.push(p.clone());
    }
    return hubs;
  }

  /**
   * Validate a spot for a standing civilian: real ground at roughly the right
   * height, no wall in their face, and nobody already standing there.
   *
   * @returns {THREE.Vector3|null}
   */
  _findStandingSpot(probe, expectedY) {
    // Resolve against the whole surface stack rather than "first thing below
    // the probe": that is what stops a civilian being filed onto the roof of
    // the building they were meant to be standing beside.
    const g = resolveSurfaceY(this.physics, probe.x, probe.z, expectedY);
    if (g === null || Math.abs(g - expectedY) > 1.2) return null;
    const spot = new THREE.Vector3(probe.x, g, probe.z);
    for (const npc of this._npcs) {
      if (npc.position.distanceToSquared(spot) < 0.85 * 0.85) return null;
    }
    // Four cardinal probes at chest height: a spot boxed in by geometry is a
    // spot the character would immediately shove itself out of.
    _capA.set(spot.x, spot.y + 1.1, spot.z);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      _capB.set(Math.cos(a), 0, Math.sin(a));
      const hit = this.physics.raycast(_capA, _capB, 0.62, COLLISION_LAYER.WORLD);
      if (hit) return null;
    }
    // The cardinal raycasts miss entirely when the probe starts INSIDE a solid
    // (AABB raycasts from within a box report no hit), so a spot buried in a
    // keep wall passed every check and the capsule solver then ejected the
    // character upward - all the way to the roof. Reject any spot whose chest
    // point is contained by a solid box collider.
    if (this._insideSolid(_capA)) return null;
    return spot;
  }

  /**
   * True when `point` lies inside solid static geometry.
   *
   * Delegates to the physics world so terrain counts too. Terrain used to be a
   * grid of boxes, which this caught for free; as a heightfield it is a single
   * collider that only `Physics` knows how to test, and without that test a spot
   * buried in a hillside passes every check and the capsule solver ejects the
   * character out of the top of the hill.
   */
  _insideSolid(point) {
    return this.physics.containsPoint(point);
  }

  _hostileVariant() {
    if (this.theme === 'medieval') return 'mail';
    if (this.theme === 'sports') return 'track';
    return 'eva';
  }

  _hashSeed(str) {
    let h = 2166136261;
    for (let i = 0; i < (str?.length ?? 0); i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /**
   * Resolve an authored spawn onto the real surface.
   *
   * Two passes, and the order matters. A short probe starting just above the
   * authored height wins first so a character authored under a bridge, a
   * rampart or a gantry stays on the deck the author meant. Only when that
   * finds nothing does the guaranteed top-down search run - that one always
   * returns a number, so a spawn can never be left hanging in the air.
   *
   * @param {THREE.Vector3} p authored spawn point
   * @param {THREE.Vector3} [out]
   */
  _snapToGround(p, out) {
    if (!p) return null;
    const v = out ?? new THREE.Vector3();
    const spot = resolveSpot(this.physics, p, v);
    if (spot) {
      // A spawn resolved into the river is a character that starts its life
      // underwater and has no way out - steering can only stop them walking
      // *in*. Walk them to the nearest bank before anyone sees them.
      if (this.water && isDeepWater(this.physics, this.water, spot.x, spot.z)) {
        const dry = nearestDrySpot(this.physics, this.water, spot, _dryScratch);
        if (dry) return v.copy(dry);
      }
      return spot;
    }
    // Nothing standable anywhere near: keep the authored height rather than
    // returning null, so a world that authors a spawn over a gap still gets a
    // character (the runtime watchdog will pull them onto a surface).
    return v.set(p.x, p.y, p.z);
  }

  clear() {
    for (const npc of this._npcs) {
      this.bus?.emit('npc:despawned', { npc });
      npc.root.removeFromParent();
      npc.dispose();
    }
    if (this._contact) this._contact.count = 0;
    this._npcs.length = 0;
    this._hostiles.length = 0;
    this._friendlies.length = 0;
    this._vendors.length = 0;
    this._respawnQueue.length = 0;
    this._groundCursor = 0;
    if (this._chatNPC) {
      this._chatNPC = null;
      this.bus?.emit('chat:available', { npc: null });
    }
  }

  get chatNpc() {
    return this._chatNPC;
  }

  /* ---------------------------------------------------------------- */
  /* Frame loops                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * One simulation step for the crowd, at the cadence each character's distance
   * band has earned. See the SIM_* constants for why the bands are where they
   * are and why nobody is ever switched off entirely.
   *
   * Allocation-free: the only per-character state is two numbers that already
   * live on the character (`_simAccum`, `_simPhase`).
   */
  fixedUpdate(dt, elapsed) {
    if (elapsed < this._pauseUntil) return;
    this._coverToken = 0;
    const step = ++this._simStep;
    for (const npc of this._npcs) {
      const every = npc.lod.sim;
      if (every > 1) {
        npc._simAccum += dt;
        /* `_simPhase` spreads the demoted crowd across the cycle. Without it
         * every 1-in-8 character lands on the same step and the saving becomes
         * a sawtooth - seven cheap steps and one worse than no banding at all. */
        if (((step + npc._simPhase) % every) !== 0) continue;
      }
      // `_simAccum` already carries this step's `dt` on the demoted path, and
      // carries only a promotion's leftover debt (usually zero) on the full one.
      const owed = every > 1 ? npc._simAccum : npc._simAccum + dt;
      npc._simAccum = 0;
      npc.fixedUpdate(Math.min(owed, SIM_MAX_STEP), elapsed);
    }
    this._separateBodies();
    this._updateRespawns(dt);
    this._updateChatProximity();
    this._updateGroundingWatchdog();
  }

  /**
   * Pull interpenetrating characters apart.
   *
   * This is a positional constraint, not a steering force, and that distinction
   * is the whole point: it writes `position` and never touches `velocity`, so
   * nothing it does can feed back into `Navigation` and start a ping-pong. It
   * converges in a handful of steps and then stops applying at all.
   *
   * It is also the thing that stops overlapping characters z-fighting. Two
   * NPCs built from the same archetype share their geometry, so at the same
   * transform their triangles are exactly coincident and the depth test picks a
   * winner per-pixel per-frame - which is precisely the "NPCs flicker when they
   * walk together" the player reported.
   *
   * Twenty-six characters is 325 pairs of two multiplies and a compare; it does
   * not register against the fixed step.
   *
   * Skipped for the dead (a corpse is scenery and pushing it looks like it is
   * being dragged) and for the seated (they are pinned to furniture by
   * `_integrateSeated`, and shoving one sideways would slide it off its bench).
   */
  _separateBodies() {
    const list = this._npcs;
    const n = list.length;
    for (let i = 0; i < n; i++) {
      const a = list[i];
      if (a.isDead || a.seat) continue;
      const ap = a.position;
      const aSpace = a.personalSpace;
      for (let j = i + 1; j < n; j++) {
        const b = list[j];
        if (b.isDead || b.seat) continue;
        const bp = b.position;
        if (Math.abs(bp.y - ap.y) > SEPARATION_MAX_RISE) continue;
        let dx = bp.x - ap.x;
        let dz = bp.z - ap.z;
        const d2 = dx * dx + dz * dz;
        // Widest either body claims. The common case - two humanoids, neither
        // of which sets `personalSpace` - short-circuits on the shared constant
        // before any of this is evaluated.
        if (d2 >= (aSpace === undefined && b.personalSpace === undefined
          ? PERSONAL_SPACE_SQ : MAX_PERSONAL_SPACE_SQ)) continue;
        const space = Math.max(aSpace ?? PERSONAL_SPACE, b.personalSpace ?? PERSONAL_SPACE);
        if (d2 >= space * space) continue;
        let d = Math.sqrt(d2);
        if (d < 1e-4) {
          // Exactly coincident, so there is no direction to separate along.
          // Derive one from the pair's indices: it has to be deterministic
          // (random would make the pair jitter) and it has to differ per pair,
          // or a stack of three would push every pair the same way and stay a
          // stack.
          const a2 = (((i * 73856093) ^ (j * 19349663)) >>> 0) % 6283;
          dx = Math.cos(a2 * 0.001);
          dz = Math.sin(a2 * 0.001);
          d = 0;
        } else {
          dx /= d;
          dz /= d;
        }
        let push = (space - d) * 0.5 * SEPARATION_RELAX;
        if (push > SEPARATION_MAX_STEP) push = SEPARATION_MAX_STEP;
        ap.x -= dx * push;
        ap.z -= dz * push;
        bp.x += dx * push;
        bp.z += dz * push;
      }
    }
  }

  /**
   * Re-audit one character's footing per fixed step.
   *
   * The per-character ground probe is a short ray under the feet and cannot see
   * its way out of a mesh a character has somehow ended up inside. This is the
   * backstop: it walks the full surface stack at the character's column and
   * lifts anyone who has sunk. One NPC per step sweeps the whole world in under
   * half a second and costs a handful of rays.
   */
  _updateGroundingWatchdog() {
    const n = this._npcs.length;
    if (n === 0) return;
    this._groundCursor = (this._groundCursor + 1) % n;
    const npc = this._npcs[this._groundCursor];
    if (!npc) return;
    // Water first: pulling someone out of the river moves them, and the
    // grounding audit should then run against where they ended up rather than
    // against the riverbed they just left.
    if (this._auditWater(npc)) {
      this._groundFixes++;
      return;
    }
    if (npc.auditGrounding()) this._groundFixes++;
  }

  update(dt, elapsed) {
    if (elapsed < this._pauseUntil) return;
    this._updateLOD();
    for (const npc of this._npcs) npc.update(dt, elapsed);
    this._updateContactShadows();
  }

  pauseFor(seconds) {
    if (!(seconds > 0)) return false;
    const elapsed = this.engine?.elapsed ?? 0;
    this._pauseUntil = Math.max(this._pauseUntil, elapsed + seconds);
    return true;
  }

  /**
   * Place one AO decal per visible character on the surface it is standing on.
   *
   * The directional shadow cascade covers 120 m on a 2048 map, which is roughly
   * 6 cm per texel at character scale - it cannot resolve where a boot meets a
   * deck, so without this every NPC reads as pasted on top of the floor rather
   * than standing in it. The decal is snapped to the *sampled ground height*,
   * not the root, so it stays put on stairs and ramps instead of floating
   * whenever a character is mid-step.
   */
  _updateContactShadows() {
    const inst = this._contact;
    const pos = this._contactPos;
    let n = 0;
    for (const npc of this._npcs) {
      if (n >= this.maxNPCs) break;
      if (!npc.root.visible || npc.lod.distance > 70) continue;
      // Corpses have collapsed away from their root; anchor to the pelvis.
      const y = npc.groundY ?? npc.position.y;
      if (Math.abs(npc.position.y - y) > 0.9) continue; // airborne: no contact
      pos.set(npc.position.x, y + 0.012, npc.position.z);
      // Fades out as a character leaves the ground, so a jump lifts its shadow.
      const lift = 1 - Math.min(1, Math.max(0, npc.position.y - y) / 0.6);
      // 0.5 x height put a 0.66 m disc under a 1.75 m figure, and with the old
      // alpha ramp on a bright deck that was below the threshold where the eye
      // registers ground contact at all - every review read the characters as
      // floating. A standing adult occludes roughly a metre of floor.
      //
      // Height is the wrong ruler for something longer than it is tall: a bear
      // is 2.3 m of animal and would get a 0.87 m disc, which is the same
      // "floating" the note above is about. Bodies that are not upright publish
      // the footprint they actually cover.
      const s = (npc.contactRadius ?? npc.height * 0.62) * (0.78 + 0.22 * lift);
      this._contactScale.set(s, 1, s);
      this._contactMat.compose(pos, this._contactQuat, this._contactScale);
      inst.setMatrixAt(n++, this._contactMat);
    }
    inst.count = n;
    if (n > 0) inst.instanceMatrix.needsUpdate = true;
  }

  /**
   * Distance and frustum driven animation budget. Characters far away animate
   * at a fraction of the frame rate, lose foot IK, and lose eye detail; ones
   * off screen coast on their state machine alone.
   */
  _updateLOD() {
    const cam = this.engine?.camera;
    if (cam) {
      cam.updateMatrixWorld();
      _projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      _frustum.setFromProjectionMatrix(_projScreen);
    }
    const eye = cam ? _v3.setFromMatrixPosition(cam.matrixWorld) : this.player?.position ?? _v3.set(0, 0, 0);

    for (const npc of this._npcs) {
      const lod = npc.lod;
      const d = npc.position.distanceTo(eye);
      lod.distance = d;
      if (cam) {
        _sphere.center.copy(npc.position);
        _sphere.center.y += npc.height * 0.5;
        // Spatial hysteresis: a character that is already on screen is tested
        // against a fatter sphere than one that is not, so a body grazing the
        // frame edge has to properly leave before it is culled. Without the
        // margin `visible` chatters, and since `detail` is gated on it, the eye
        // meshes chattered with it.
        _sphere.radius = npc.height * (lod.visible ? 0.95 : 0.75);
        lod.visible = _frustum.intersectsSphere(_sphere);
      } else {
        lod.visible = true;
      }
      // A bigger crowd has to pay for itself, but 9 m was far too aggressive:
      // an NPC filling a third of the frame at 12 m had its eyes and lids culled
      // outright and presented a blank mannequin head. Eyes are six small meshes
      // on a bone - they stay on out to ~25 m, which is well past the range
      // where a face is still resolvable. Foot IK stops around 22 m, and
      // anything past ~130 m is not drawn at all rather than merely animated
      // slowly.
      //
      // Every one of those switches is now a band rather than a line. A single
      // boundary turns any distance jitter - a neighbour nudging the character,
      // a stride's worth of pelvis travel - into a per-frame on/off toggle,
      // which is visible as flicker precisely when characters are crowded
      // together and jostling.
      lod.detail = lod.visible && (lod.detail ? d < DETAIL_OUT : d < DETAIL_IN);
      lod.ik = lod.ik ? d < IK_OUT : d < IK_IN;
      // Distance only, never `lod.visible`: an off-screen character can still
      // throw a shadow into shot, so the frustum test is the wrong question to
      // ask about a caster.
      const shadow = lod.shadow ? d < SHADOW_OUT : d < SHADOW_IN;
      if (lod.shadow !== shadow) {
        // Written only on the change. Every character owns two shadow-casting
        // meshes, so re-asserting the flag each frame would be a hundred-odd
        // pointless writes per frame across a full crowd.
        lod.shadow = shadow;
        const h = npc.humanoid;
        // A humanoid IS two casting meshes; a quadruped is a dozen, and a wolf
        // whose barrel stops casting while its legs carry on is worse than one
        // that casts all the way out. A body that is more than two meshes says
        // so by offering this, and owns the whole switch itself.
        if (h.setShadowCasting) {
          h.setShadowCasting(shadow);
        } else {
          h.mesh.castShadow = shadow;
          if (h.hairMesh) h.hairMesh.castShadow = shadow;
        }
      }
      /* Pose cadence. Three hysteretic edges evaluated near to far, exactly as
       * the simulation cadence below does it - and the previous state is read
       * back off `lod.poseRate` rather than `lod.rate` precisely because the
       * frustum term overwrites `lod.rate` with a value (0.12) that does not
       * sit in this monotone sequence. Keeping the distance band on its own
       * field is what stops a character that has been off screen coming back
       * with a nonsense band state. @see POSE_BAND
       *
       * NOT keyed off `npc.root.visible`, and that is measured rather than
       * assumed. A character past RENDER_OUT but still inside the frustum is
       * posed at 6 Hz while nothing draws it, which looks like pure waste; the
       * cost of that waste, attributed with a wrapper around the real
       * `NPC.update` over 600-frame samples, is 18-26 us per pose and:
       *
       *     station, plaza-wide (35 of 68 in that state)   0.068 ms/frame
       *     station, dome-inside (45)                      0.085 ms/frame
       *     station, habitation court (67)                 0.085 ms/frame
       *     medieval, village square (15 of 47)            0.019 ms/frame
       *     medieval, hills vista (35 of 51)               0.036 ms/frame
       *
       * against median frames of 9-24 ms - between 0.15% and 0.55% of a frame,
       * inside the noise of the wall clock that measures it (an A/B that
       * skipped the pose entirely could not be distinguished from the control).
       * Adding the term would also make the pose band the one switch here whose
       * state depends on another switch's, and it would trade that 0.3% for a
       * character that has not been posed for the whole time it spent past
       * 135 m arriving mid-stride at RENDER_IN. Not worth it. */
      let poseRate = 1;
      if (pastBand(lod.poseRate <= 0.5, d, POSE_HALF_OUT, POSE_BAND)) poseRate = 0.5;
      if (pastBand(lod.poseRate <= 0.25, d, POSE_QUARTER_OUT, POSE_BAND)) poseRate = 0.25;
      if (pastBand(lod.poseRate <= 0.1, d, POSE_TENTH_OUT, POSE_BAND)) poseRate = 0.1;
      lod.poseRate = poseRate;
      lod.rate = lod.visible ? poseRate : POSE_RATE_HIDDEN;
      /* Simulation cadence. Distance only, never `lod.visible`: a character
       * behind the player still has to walk to where it is going, and freezing
       * everyone off screen is how a crowd ends up teleporting the moment you
       * turn round.
       *
       * The previous state of each edge is read back off `lod.sim` rather than
       * stored separately - the divisor is monotone in distance, so "was this
       * character already past the half edge" is exactly `lod.sim >= 2`. Three
       * independent hysteretic edges, evaluated near to far. */
      let sim = 1;
      if (pastBand(lod.sim >= 2, d, SIM_HALF_OUT, SIM_BAND)) sim = 2;
      if (pastBand(lod.sim >= 4, d, SIM_QUARTER_OUT, SIM_BAND)) sim = 4;
      if (pastBand(lod.sim >= 8, d, SIM_EIGHTH_OUT, SIM_BAND)) sim = 8;
      lod.sim = sim;
      const render = npc.root.visible ? d < RENDER_OUT : d < RENDER_IN;
      if (npc.root.visible !== render && !npc.animator.sunk) npc.root.visible = render;
    }
  }

  _updateRespawns(dt) {
    for (const npc of this._hostiles) {
      if (!npc.isDead) continue;
      if (npc._respawnAt == null) {
        npc._respawnAt = CONFIG.npc.respawnDelay;
        // Sink starts late so the corpse is readable for a while first.
        npc._sinkAt = Math.max(4, CONFIG.npc.respawnDelay - 4);
      }
      npc._respawnAt -= dt;
      npc._sinkAt -= dt;
      if (npc._sinkAt <= 0) npc.animator.beginSink();
      if (npc._respawnAt <= 0 && npc.animator.sunk) {
        const spot = this._pickRespawnPoint(npc);
        npc.respawn(spot);
        npc._respawnAt = null;
        this.bus?.emit('npc:spawned', { npc });
      }
    }
  }

  /** Prefer the NPC's own spawn, but never in the player's face. */
  _pickRespawnPoint(npc) {
    const player = this.player;
    const candidates = [npc.spawnPoint, ...npc.patrol];
    let best = npc.spawnPoint;
    let bestScore = -Infinity;
    for (const c of candidates) {
      const d = player ? c.distanceTo(player.position) : 100;
      const score = d > 30 ? d : d - 200;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    const snapped = this._snapToGround(best);
    return snapped ?? best;
  }

  _updateChatProximity() {
    const player = this.player;
    if (!player) return;
    const npc = this.nearestFriendly(player.position, CONFIG.npc.chatRange);
    if (npc === this._chatNPC) return;
    this._chatNPC = npc;
    this.bus?.emit('chat:available', { npc: npc ?? null });
  }

  /* ---------------------------------------------------------------- */
  /* Queries                                                           */
  /* ---------------------------------------------------------------- */

  /** @returns {import('./NPC.js').NPC|null} */
  nearestFriendly(position, maxRange = 6) {
    let best = null;
    let bestSq = maxRange * maxRange;
    for (const npc of this._friendlies) {
      // Every friendly is a chat target - stationary, seated, vendor or
      // wanderer alike. The flag exists so a hostile can never become one.
      if (npc.isDead || npc.conversational === false) continue;
      const d = npc.position.distanceToSquared(position);
      if (d < bestSq) {
        bestSq = d;
        best = npc;
      }
    }
    return best;
  }

  /**
   * Hit query for the combat system. Each NPC is a vertical capsule with a
   * separate head sphere; the nearest of the two decides whether the hit is a
   * headshot, and the nearest NPC overall wins.
   *
   * @returns {{npc:any, point:THREE.Vector3, distance:number, isHeadshot:boolean}|null}
   */
  raycastNPCs(origin, direction, maxDistance = 300) {
    let best = null;
    let bestDist = maxDistance;
    for (const npc of this._npcs) {
      if (npc.isDead) continue;
      /* Cheap reject: bounding sphere around the whole character.
       *
       * `height * 0.75` is the right radius for something taller than it is
       * long. A quadruped is the other way round - a wolf's nose sits a metre
       * in front of a sphere that only reaches 0.64 m - so a body whose extent
       * is not its height publishes `boundRadius` and the sphere is sized off
       * that instead. */
      const bound = npc.boundRadius ?? npc.height * 0.75;
      // Never tighter than it was for a humanoid: the along-axis slack stays
      // whichever of the two is larger, so this cannot start rejecting shots
      // that used to land.
      const slack = bound > npc.height ? bound : npc.height;
      _v3.copy(npc.position);
      _v3.y += npc.height * 0.5;
      const toC = _v3.sub(origin);
      const along = toC.dot(direction);
      if (along < -slack || along > bestDist + slack) continue;
      if (toC.lengthSq() - along * along > bound * bound) continue;

      /* The hit volume. A person is a vertical capsule from the feet to the
       * head; a wolf is a horizontal one along its spine, and asking it to be
       * the former leaves most of the animal unshootable. Bodies that are not
       * upright fill in their own. */
      const feet = npc.position;
      let r;
      if (npc.hitCapsule) {
        r = npc.hitCapsule(_capA, _capB);
      } else {
        r = npc.radius * 0.86;
        _capA.set(feet.x, feet.y + r, feet.z);
        _capB.set(feet.x, feet.y + npc.height * 0.86 - r, feet.z);
      }
      const body = raySegment(origin, direction, _capA, _capB, r, bestDist);

      const head = npc.headPosition;
      const headR = 0.135 * npc.humanoid.heightScale;
      const headHit = raySphere(origin, direction, head, headR, bestDist);

      let t = -1;
      let isHead = false;
      if (headHit >= 0 && (body < 0 || headHit <= body)) {
        t = headHit;
        isHead = true;
      } else if (body >= 0) {
        t = body;
      }
      if (t < 0 || t >= bestDist) continue;
      bestDist = t;
      best = best ?? { npc: null, point: new THREE.Vector3(), distance: 0, isHeadshot: false };
      best.npc = npc;
      best.distance = t;
      best.isHeadshot = isHead;
      best.point.copy(origin).addScaledVector(direction, t);
    }
    return best;
  }

  /** Nearest hostile with line of sight, for HUD threat markers and AI. */
  nearestHostile(position, maxRange = 60) {
    let best = null;
    let bestSq = maxRange * maxRange;
    for (const npc of this._hostiles) {
      if (npc.isDead) continue;
      const d = npc.position.distanceToSquared(position);
      if (d < bestSq) {
        bestSq = d;
        best = npc;
      }
    }
    return best;
  }

  /* ---------------------------------------------------------------- */
  /* Coordination                                                      */
  /* ---------------------------------------------------------------- */

  /** Tell nearby hostiles where the player is. */
  propagateAlert(source, radius = 24) {
    const at = source.hasLastKnown ? source.lastKnownTarget : this.player?.position;
    if (!at) return;
    const r2 = radius * radius;
    for (const npc of this._hostiles) {
      if (npc === source || npc.isDead) continue;
      if (npc.position.distanceToSquared(source.position) > r2) continue;
      npc.alert(at, false);
    }
  }

  /** Rate-limit the cover search to one NPC per fixed step. */
  requestCoverSlot() {
    if (this._coverToken > 0) return false;
    this._coverToken++;
    return true;
  }

  /** Pair up idle friendlies that are standing near each other. */
  findSocialPartner(npc, radius) {
    const r2 = radius * radius;
    let best = null;
    let bestSq = r2;
    for (const other of this._friendlies) {
      if (other === npc || other.isDead) continue;
      // Group members hold their formation; they do not walk off to chat.
      if (other.anchored) continue;
      if (other.socialPartner && other.socialPartner !== npc) continue;
      if (other.state === 'FLEE' || other.state === 'GREET') continue;
      const d = other.position.distanceToSquared(npc.position);
      if (d < bestSq && d > 1.2) {
        bestSq = d;
        best = other;
      }
    }
    if (best) best.socialPartner = npc;
    return best;
  }

  /**
   * A hostile pulled the trigger. Emits `npc:fire` for the combat system to
   * turn into tracers and damage. If nothing is listening we resolve the shot
   * here so the AI is never toothless.
   */
  npcFire(npc, origin, direction, damage, weaponId) {
    const player = this.player;
    const id = weaponId ?? npc?.weaponId ?? 'rifle';
    // Health before and after: `bus.emit` is synchronous, so whatever resolves
    // the shot - CombatSystem, or the fallback below - has finished by the time
    // we read it again. That is how `npc:attack` reports what actually landed
    // rather than what was merely fired, which is what the HUD needs to answer
    // "what just hit me".
    const before = Number.isFinite(player?.health) ? player.health : null;

    const payload = { npc, origin, direction, damage, weaponId: id, spread: 1 - npc.accuracy };
    const handlers = this.bus?._handlers?.get('npc:fire');
    this.bus?.emit('npc:fire', payload);
    this._onGunfire(origin, 0.8);

    const resolvedElsewhere = handlers && handlers.size > 0;
    if (!resolvedElsewhere && this._selfResolveFire && player && !player.isDead) {
      // Fallback resolution: nearest of world geometry and the player.
      const range = (npc?.weaponDef?.range ?? CONFIG.npc.attackRange) + 12;
      const wall = this.physics.raycast(origin, direction, range, COLLISION_LAYER.WORLD);
      const pp = player.position;
      _capA.set(pp.x, pp.y + CONFIG.player.radius, pp.z);
      _capB.set(pp.x, pp.y + CONFIG.player.height - CONFIG.player.radius, pp.z);
      const hit = raySegment(origin, direction, _capA, _capB, CONFIG.player.radius, range);
      if (hit >= 0 && !(wall && wall.distance < hit)) {
        player.applyDamage?.(damage, origin, npc.id);
      }
    }

    const after = Number.isFinite(player?.health) ? player.health : null;
    if (before !== null && after !== null && after < before - 1e-4) {
      this.bus?.emit('npc:attack', { npc, weaponId: id, damage: before - after });
    }
  }

  /** Friendlies scatter from gunfire wherever it comes from. */
  _onGunfire(origin, intensity) {
    for (const npc of this._friendlies) npc.onGunfire?.(origin, intensity);
    for (const npc of this._hostiles) {
      if (!npc.isDead && origin && npc.position.distanceToSquared(origin) < 40 * 40) {
        npc.alert(origin, false);
      }
    }
  }

  dispose() {
    this.clear();
    this._contact.removeFromParent();
    this._contact.dispose();
    this.factory.dispose();
    this.assets.dispose();
  }
}
