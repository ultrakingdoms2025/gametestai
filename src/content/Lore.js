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
      'Every hull came through the gateway in sections narrower than the arch and was pinned back ' +
      'together on a cradle, which is why they are slab-sided and ribbed and why a yard rat can climb ' +
      'one like a wall. The datum the surveyors left is still bolted to the floor at the centre of the ' +
      'assembly bay, and every berth in the yard is measured off it. Four hulls are fitted out. The ' +
      'board on the blast door reads LAUNCHES: 000.',
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
    body:
      'Beyond the blast door at the north end of Lodestar Yard there is no floor and no roof. ' +
      'The yard keeps one lit holding platform out there and nothing else: somewhere for a hull to ' +
      'be handed over to whoever is flying it. Nobody has ever needed it, because nothing has ever ' +
      'launched from the yard.',
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
     * did not exist. Pinned now by scripts/tests/dock-registration.test.mjs,
     * which asserts the yard is named here. */
    'Canonical game facts: the Nexus has seven worlds reachable through the gateway ring (Aether Station, Medieval Valley / Aldermoor Vale, Meridian Athletic Grounds, Sunspire Citadel, Vellum Ridge, which carries three circuits - Vellum Ridge Circuit, Cinder Gorge and Aurora Rise, The Verdant Coil, and Lodestar Yard); Aether Station is the hub and has six outbound portals, and each of the other six worlds has one return portal to the station. Lodestar Yard is the shipyard behind gateway six and is the only world with a second portal: a launch portal at its blast door leading out to open space, which is the eighth place and has no gateway of its own.',
    'Keep answers short, clear, and in character.',
    'Answer the player directly first; keep any flavor to one brief clause.',
    'If asked about the lore, explain it plainly and directly instead of sounding cryptic or poetic.',
    'If asked about the game itself, prefer concrete instructions and exact names over stories.',
  ].join(' ');
}
