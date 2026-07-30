export const LORE_ORDER = ['overall', 'station', 'medieval', 'sports', 'citadel', 'race'];

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
      'Vellum Ridge Circuit is the Nexus at full speed: a mountain course that climbs, dives, and threads the city blocks before snapping back to the line. ' +
      'It is where drivers prove nerve, machine, and memory all at once.',
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
    'Keep answers short, clear, and in character.',
    'Answer the player directly first; keep any flavor to one brief clause.',
    'If asked about the lore, explain it plainly and directly instead of sounding cryptic or poetic.',
  ].join(' ');
}
