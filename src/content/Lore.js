/**
 * THE SCOPES THAT HAVE A KEEPER, AND WHY THE TEN PLANETS ARE NOT AMONG THEM.
 *
 * Every scope in `DEFAULT_LORE` must appear in FIVE mirrors or
 * `scripts/tests/dock-economy.test.mjs` goes red: this list, `LORE_ORDER` and
 * `LORE_LABELS` in `admin/app/dashboard/lore/page.tsx`, `DEFAULT_LORE_ROWS` in
 * `admin/lib/db.ts`, and the `CASE WHEN` ladder in `site/lib/lore.ts`. A scope
 * is therefore not free: it is five edits and a permanent row on a dashboard
 * somebody has to keep answering questions about.
 *
 * Phase 2 added TEN landable planets and gave none of them a scope. That was
 * decided rather than forgotten, and the reason is that a planet scope could
 * never be READ:
 *
 *   • `loreEntryForScope` has exactly two callers - `_spawnLorekeepers` and
 *     `_createNPC`'s lorekeeper branch, both in `NPCManager`. The first line of
 *     `_spawnLorekeepers` is `if (!allows(world, 'crowd')) return 0`.
 *   • `PlanetWorld`'s rule set sets `crowd: false`, along with merchants,
 *     quests, contracts and interiors, on the stated grounds that a planet
 *     surface is a WILDERNESS. No NPC of any kind spawns on one, so no keeper
 *     can stand on one, so nothing on a planet can ever ask this table a
 *     question.
 *   • The evidence is already in the repo: Cinder has been landable since
 *     Phase 1 with no scope here, and nothing fell back to the Chronicle
 *     because nothing ever looked.
 *
 * What the planets DO need from this file is to exist in the canonical-facts
 * sentence in `buildLorePersona` below - which every keeper in every world
 * recites, including the two standing in Lodestar Yard that a player asks
 * about the flight before taking it. That is where they went. If a planet ever
 * grows a settlement with a person in it, the rule flips and it earns a scope
 * on the day it earns an NPC.
 */
export const LORE_ORDER = ['overall', 'station', 'medieval', 'sports', 'citadel', 'race', 'maze', 'dock', 'space'];

export const DEFAULT_LORE = {
  overall: {
    scope: 'overall',
    title: 'Aether Nexus Chronicle',
    sign_label: 'Lorekeeper',
    body:
      'The Aether Nexus is a chain of linked worlds held together by portals, trade, memory, and habit. ' +
      'Aether Station is the hub, the place where travellers are catalogued before they step through. ' +
      'Each world carries its own culture, but the portals make them part of one larger story.',
  },
  station: {
    scope: 'station',
    title: 'Station Lore',
    sign_label: 'Lorekeeper',
    body:
      'Aether Station is the orbital hub of the Nexus: a ring of concourses, plazas, gantries, and glass, ' +
      'built to receive travellers from every other world. It is the archive, the checkpoint, and the place where the next journey begins.',
  },
  medieval: {
    scope: 'medieval',
    title: 'Medieval Lore',
    sign_label: 'Lorekeeper',
    body:
      'Aldermoor Vale is an old-world valley of timber roofs, market squares, castle walls, and pilgrim roads. ' +
      'Its people still measure life by harvests, tolls, and the stories told beside the gatehouse fire.',
  },
  sports: {
    scope: 'sports',
    title: 'Sports Lore',
    sign_label: 'Lorekeeper',
    body:
      'The Meridian Athletic Grounds are a bright training complex of courts, tracks, bowls, snow runs, and grandstands. ' +
      'Competition is culture here; every surface is built for practice, spectacle, and the pride of a clean run.',
  },
  citadel: {
    scope: 'citadel',
    title: 'Citadel Lore',
    sign_label: 'Lorekeeper',
    body:
      'Sunspire Citadel crowns a cliff above the desert, a vertical town of terraces, rope bridges, towers, and guarded gates. ' +
      'Its people value height, discipline, and the hard-earned safety of the walls that keep the sky at bay.',
  },
  race: {
    scope: 'race',
    title: 'Race Lore',
    sign_label: 'Lorekeeper',
    body:
      'Vellum Ridge is the Nexus at full speed: three circuits cut into one stretch of coast and hill country. ' +
      'Vellum Ridge Circuit itself climbs, dives and threads the city blocks before snapping back to the line; ' +
      'Cinder Gorge is a quarry course of chicanes and a hairpin with no room to be wrong in; ' +
      'Aurora Rise runs up to a summit and back down to a vertical loop that every lap has to go over the top of. ' +
      'It is where drivers prove nerve, machine, and memory all at once.',
  },
  maze: {
    scope: 'maze',
    title: 'The Verdant Coil',
    sign_label: 'Keeper of the Verdant Coil',
    body:
      'A hedge maze that re-rolls its layout on every entry. Its districts and levels never repeat. ' +
      'The maze that cannot be learned is the entire point.',
  },
  /* Gateway 06's destination. Survey Site 06 was commissioned and is a working
   * yard now; the entry is REPLACED rather than kept beside a new one, because
   * `LORE_ORDER` is what the admin lore page and the site both enumerate and a
   * dead scope in it is a row somebody has to keep answering questions about.
   *
   * `sign_label` becomes the keeper NPC's on-screen name, uppercased
   * (`NPCManager._spawnLorekeepers`). It is not used by an AUTOMATIC keeper
   * here: the yard has two gateways, so `lorekeeperScope` gives each of its
   * keepers the DESTINATION's scope rather than the world's. The Yard Warden
   * `DockWorld` authors herself is the one who speaks this, and she takes her
   * persona from `buildLorePersona('dock')` so the two cannot drift. */
  dock: {
    scope: 'dock',
    title: 'Lodestar Yard',
    sign_label: 'Yard Warden',
    body:
      'Lodestar Yard was Survey Site 06 until the ring commissioned it. Nothing here was built here. ' +
      /* THIS PASSAGE USED TO RE-STATE A PREMISE THE PLAYER REJECTED.
       *
       * It said the hulls were "slab-sided and ribbed" so "a yard rat can climb
       * one like a wall". That premise was invented to justify a collision
       * constraint, and the player's answer was that climbing is the least
       * important thing about a spaceship - "still climbable where shape
       * allows". Shape is for looks; climbing is opportunistic. Lore that
       * argues for the rejected version is how a rejected design comes back.
       *
       * The other stale fact was the last line: there is no blast door any more
       * (the hangar is open to space, with piers running out of it) and the
       * launch counter has not read zero since Phase 1. */
      'Every hull came through the gateway in sections narrower than the arch and was pinned back ' +
      'together on a cradle. You can still find the seams if you know where to look, and a yard rat ' +
      'will climb a hull wherever its shape happens to allow it - which is not everywhere, and was ' +
      'never the point. The datum the surveyors left is still bolted to the floor at the centre of ' +
      'the assembly bay, and every berth in the yard is measured off it. Four hulls are fitted out. ' +
      'The board over the mouth stopped reading LAUNCHES: 000 a long time ago.',
  },
  /* The far side of the blast door.
   *
   * It has an entry because the DOCK needs it, not because anybody lives
   * there: with two gateways in the yard, one of its two keepers is given the
   * scope `space`, and without a row here `loreEntryForScope` falls back to
   * the Chronicle and that keeper answers a question about open space with a
   * summary of the Nexus. */
  space: {
    scope: 'space',
    title: 'Open Space',
    sign_label: 'Launch Control',
    /* REWRITTEN FOR PHASE 2, and the old text is worth recording because of
     * what it did. It read "nobody has ever needed it, because nothing has
     * ever launched from the yard" - true when open space was a lit holding
     * platform and a stub score. `buildLorePersona` concatenates this body
     * with the canonical-facts sentence below, so once that sentence began
     * listing ten landable planets the keeper at the launch gate was reciting
     * a paragraph that CONTRADICTED the next sentence out of her own mouth. A
     * keeper who denies a world exists is worse than no keeper; a keeper who
     * denies it and then describes it is worse again. */
    body:
      'Past the mouth at the north end of Lodestar Yard there is no floor and no roof. ' +
      'What is out there is a volume some six hundred kilometres across: Erenmark burning over ' +
      'the yard\'s shoulder, the ringed giant Ceraunus out and up, the Halberd Reach debris field ' +
      'off to port, and ten worlds a hull can be set down on, from Cinder at sixty-two kilometres ' +
      'to Cathedra at two hundred and eighty-eight. The yard fits the hulls out. Whether anything ' +
      'comes back is between the pilot and the volume.',
  },
};

export function loreEntryForScope(scope) {
  return DEFAULT_LORE[scope] ?? DEFAULT_LORE.overall;
}

export function buildLorePersona(scope, entries = DEFAULT_LORE) {
  const overall = entries.overall ?? DEFAULT_LORE.overall;
  const world = entries[scope] ?? loreEntryForScope(scope);
  return [
    `Speak as the Lorekeeper of the Aether Nexus.`,
    `You guard the histories of the worlds and answer questions about the portals, the people, and the place itself.`,
    `Overall lore: ${overall.body}`,
    `World lore: ${world.body}`,
    /* THIS SENTENCE IS THE LOREKEEPER'S ONLY MAP OF THE NEXUS.
     *
     * It is hardcoded, it is not derived from `LORE_ORDER`, and nothing checks
     * it against the world registry - so it goes stale silently and the model
     * then denies the existence of anything it does not list. It said "six
     * worlds ... five outbound portals" while the station had SIX gateways and
     * Survey Site 06 was on the other side of one of them, which meant a
     * keeper standing in the survey site would tell a player the survey site
     * did not exist. Then it said SEVEN, and "the eighth place", while ten
     * landable planets sat in that eighth place - so it denied Cinder, which
     * the whole Phase 1 loop exists to reach, and nine more besides.
     *
     * EIGHTEEN is what `main.js` registers: eight world classes by hand
     * (station, medieval, sports, citadel, race, maze, dock, space) plus one
     * per planet descriptor from `worldClasses()`, of which there are ten.
     *
     * Pinned by scripts/tests/dock-registration.test.mjs, which now checks the
     * parenthesised list against `landableBodies()` as well as against the
     * yard - so the next planet added is red here on the day it is added,
     * rather than denied for a release. */
    'Canonical game facts: the Nexus has eighteen worlds (Aether Station, Medieval Valley / Aldermoor Vale, Meridian Athletic Grounds, Sunspire Citadel, Vellum Ridge, which carries three circuits - Vellum Ridge Circuit, Cinder Gorge and Aurora Rise, The Verdant Coil, Lodestar Yard, the open space beyond the yard, and the ten planets out there a ship can land on: Cinder, Tessera, Sirocco, Shoal, Vitrine, Verdigris, Lathe, Carnelian, Sallow and Cathedra). Seven of those are reached through the gateway ring: Aether Station is the hub and has six outbound portals, and each of the other six ring worlds has one return portal to the station. Lodestar Yard is the shipyard behind gateway six and is the only world with a second portal: a launch portal at the north end of its hall, leading out to open space. Nothing past that portal has a gateway of its own - the ten planets are flown to and landed on, Cinder nearest at 62 km and Cathedra furthest at 288 km. Erenmark, Ceraunus and Halberd Reach are out there too but are NOT worlds: they are the star, a ringed gas giant with no surface, and an asteroid belt, and none of the three can be landed on.',
    'Keep answers short, clear, and in character.',
    'Answer the player directly first; keep any flavor to one brief clause.',
    'If asked about the lore, explain it plainly and directly instead of sounding cryptic or poetic.',
    'If asked about the game itself, prefer concrete instructions and exact names over stories.',
  ].join(' ');
}
