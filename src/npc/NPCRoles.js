/**
 * Friendly NPC roles.
 *
 * The stationary civilians used to be scenery with a name attached: they held a
 * pose, they never moved, and the only thing you could do with one was walk
 * past it. A role gives each of them a reason to be standing where they are - a
 * stall to mind, a door to guard, a match to watch - which is what the idle
 * behaviour in `FriendlyNPC` then dramatises, and what the persona hands to the
 * chat model so the character has something of its own to say.
 *
 * Roles are also the hook other systems key on. The Marketplace opens next to
 * anything reporting `role === 'vendor'` / `isVendor === true`, which is why
 * vendors are a first-class role rather than a name-matching heuristic.
 */

export const ROLE = {
  VENDOR: 'vendor',
  GUARD: 'guard',
  LOITERER: 'loiterer',
  SPECTATOR: 'spectator',
  WANDERER: 'wanderer',
  LOREKEEPER: 'lorekeeper',
  QUEST_MANAGER: 'quest_manager',
};

/**
 * @typedef {object} RoleDef
 * @property {string} id
 * @property {string} label            shown in the interaction prompt
 * @property {boolean} stationary      holds a post rather than roaming
 * @property {number} strollRadius     how far an idle stroll may take them, metres
 * @property {number} strollChance      0..1 likelihood of strolling instead of shifting
 * @property {number} lookAround       0..1 how often they turn to look at things
 * @property {string[]} postures       held poses that suit the role
 * @property {boolean} seatable        may be placed on a bench if one is found
 */

/** @type {Record<string, RoleDef>} */
export const ROLE_DEFS = {
  [ROLE.VENDOR]: {
    id: ROLE.VENDOR,
    label: 'Trader',
    stationary: true,
    // A trader steps around their own pitch and no further - walking away from
    // the stall is the one thing that would read as wrong.
    strollRadius: 1.6,
    strollChance: 0.35,
    lookAround: 0.8,
    postures: ['hips', 'crossed', 'none'],
    seatable: false,
  },
  [ROLE.GUARD]: {
    id: ROLE.GUARD,
    label: 'Guard',
    stationary: true,
    strollRadius: 3.2,
    strollChance: 0.55,
    lookAround: 1,
    postures: ['crossed', 'hips', 'none'],
    seatable: false,
  },
  [ROLE.LOITERER]: {
    id: ROLE.LOITERER,
    label: 'Local',
    stationary: true,
    strollRadius: 2.4,
    strollChance: 0.5,
    lookAround: 0.6,
    postures: ['crossed', 'pocket', 'lean', 'hips', 'none'],
    seatable: true,
  },
  [ROLE.SPECTATOR]: {
    id: ROLE.SPECTATOR,
    label: 'Spectator',
    stationary: true,
    strollRadius: 1.8,
    strollChance: 0.3,
    lookAround: 0.9,
    postures: ['pocket', 'crossed', 'none'],
    seatable: true,
  },
  [ROLE.WANDERER]: {
    id: ROLE.WANDERER,
    label: 'Traveller',
    stationary: false,
    strollRadius: 9,
    strollChance: 1,
    lookAround: 0.5,
    postures: ['none', 'pocket', 'crossed'],
    seatable: false,
  },
  [ROLE.LOREKEEPER]: {
    id: ROLE.LOREKEEPER,
    label: 'Lorekeeper',
    stationary: true,
    strollRadius: 1.2,
    strollChance: 0.1,
    lookAround: 1,
    postures: ['crossed', 'pocket', 'none'],
    seatable: false,
  },
  [ROLE.QUEST_MANAGER]: {
    id: ROLE.QUEST_MANAGER,
    label: 'Quest Manager',
    stationary: true,
    strollRadius: 1.2,
    strollChance: 0.1,
    lookAround: 1,
    postures: ['crossed', 'hips', 'none'],
    seatable: false,
  },
};

/**
 * Named characters for the stationary roles, per world theme.
 *
 * These replace the generic crowd names for the NPCs that hold a post, so the
 * plaza reads as a market with a quartermaster in it rather than as twelve
 * interchangeable "Deck Tech"s. Personas are written for the chat model: they
 * state the job, an opinion and a grievance, which is all a language model
 * needs to hold a short conversation in character.
 */
export const ROLE_CAST = {
  station: {
    [ROLE.VENDOR]: [
      {
        name: 'Quartermaster Bex',
        persona:
          'Runs the supply stall on the plaza concourse. Sells ammunition, ration packs and salvage kits, quotes prices before you ask, and grumbles that requisition paperwork moves slower than the freight lifts.',
      },
      {
        name: 'Broker Sunil Rai',
        persona:
          'A licensed trade broker working a folding stall of surplus. Cheerful, fast-talking, convinced everything is a bargain, and always trying to buy whatever you are carrying.',
      },
    ],
    [ROLE.GUARD]: [
      {
        name: 'Deck Warden Ilse',
        persona:
          'Station security posted on the plaza. Watchful and dry-humoured, keeps an eye on the gateway crowds, and will tell you exactly which corridors are off limits this shift.',
      },
      {
        name: 'Warden Cato Reyes',
        persona:
          'A long-serving deck warden who has seen every kind of trouble come through the gateway. Calm, blunt, quietly proud of a spotless incident record.',
      },
    ],
    [ROLE.SPECTATOR]: [
      {
        name: 'Observer Nell Yeong',
        persona:
          'An off-shift crew member who comes to the plaza to watch the gateway light up. Dreamy, curious about the other worlds, full of half-true stories about travellers.',
      },
    ],
    [ROLE.LOITERER]: [
      {
        name: 'Dockhand Priya Kaur',
        persona:
          'A dockhand killing time between freight calls. Friendly, tired, endlessly opinionated about hull maintenance backlogs and the recycled coffee.',
      },
      {
        name: 'Rigger Osei Mensah',
        persona:
          'A rigger leaning on a stanchion waiting for a lift crew. Talks shop about the gantries and about a repair nobody has noticed yet.',
      },
    ],
  },
  medieval: {
    [ROLE.VENDOR]: [
      {
        name: 'Merchant Adela',
        persona:
          'Keeps the market stall on the square, selling arrows, provisions and small charms. Shrewd, warm to a paying customer, and full of complaints about the bridge toll.',
      },
      {
        name: 'Pedlar Corwin',
        persona:
          'A travelling pedlar with a tray of oddments. Talks up every trinket as a relic, buys anything you will part with, and knows a rumour about every road out of the village.',
      },
    ],
    [ROLE.GUARD]: [
      {
        name: 'Watchman Hedric',
        persona:
          'A village watchman at his post by the square. Solid, unhurried, suspicious of strangers but honest with them, and certain the keep should send more men.',
      },
      {
        name: 'Serjeant Ulla',
        persona:
          'A serjeant of the garrison standing watch. Direct and professional, gives clear warnings about the woods after dark.',
      },
    ],
    [ROLE.SPECTATOR]: [
      {
        name: 'Pilgrim Marda',
        persona:
          'A pilgrim resting in the square, convinced the shimmering gate is a sign. Gentle, wide-eyed, asks more questions than she answers.',
      },
    ],
    [ROLE.LOITERER]: [
      {
        name: 'Goodman Aldous',
        persona:
          'A villager in for market day. Quietly proud of his craft, deeply sceptical of anything that glows, and happy to gossip about the keep.',
      },
      {
        name: 'Widow Sæwyn',
        persona:
          'An old villager who sits out at the square most days. Sharp memory, sharper tongue, and three different versions of every rumour.',
      },
    ],
  },
  sports: {
    [ROLE.VENDOR]: [
      {
        name: 'Kit Seller Dana Cruz',
        persona:
          'Runs the kit and refreshments stand at the park. Upbeat, relentlessly on-message about hydration, and will happily sell you gear you did not know you needed.',
      },
      {
        name: 'Pro Shop Marek',
        persona:
          'Minds the pro shop counter by the courts. Knows every piece of equipment on the site, buys used gear back, and has firm views about the right grip.',
      },
    ],
    [ROLE.GUARD]: [
      {
        name: 'Steward Alina Bosch',
        persona:
          'A site steward keeping the fixtures running. Organised, brisk, always three minutes from the next scheduled match.',
      },
      {
        name: 'Marshal Theo Vance',
        persona:
          'A course marshal watching the slope. Safety-first, cheerful about it, tells long stories about spectacular crashes.',
      },
    ],
    [ROLE.SPECTATOR]: [
      {
        name: 'Regular Junie Park',
        persona:
          'A park regular watching whatever match is on. Knows every local player, keeps a running commentary, and will explain why your stance is wrong.',
      },
    ],
    [ROLE.LOITERER]: [
      {
        name: 'Coach Rowan Blake',
        persona:
          'A club coach between sessions. Encouraging to a fault, full of drills you did not ask for, and keen to know what sport you play.',
      },
      {
        name: 'Skier Ash Delacroix',
        persona:
          'A weekend skier waiting for the lift queue to clear. Hyped about the fresh piste and completely unbothered by the cold.',
      },
    ],
  },
  /* Unreachable while MazeWorld sets crowd: false (see WorldRules.js and
   * NPCManager._populateHubs, which this table only feeds through castFor).
   * Written anyway so a lapsed crowd flag would surface lost travellers
   * rather than a station quartermaster standing in a hedge. */
  maze: {
    [ROLE.GUARD]: [
      {
        name: 'Hollis Rane',
        persona:
          'A self-appointed watcher of a junction he has decided is his to mind, on the theory that someone should keep count of who passes through. Wary of the hedges more than of any person.',
      },
    ],
    [ROLE.SPECTATOR]: [
      {
        name: 'Merle Ashcombe',
        persona:
          'Sits at the same dead end most days, watching the light move through the hedge wall and timing it against a count of her own steps. Not looking for a way out, exactly.',
      },
    ],
    [ROLE.LOITERER]: [
      {
        name: 'Denna Voss',
        persona:
          'Long past the fear stage and into a bored, practical routine - marks junctions, rations food, talks to whoever passes mostly to keep the habit of talking at all.',
      },
      {
        name: 'Old Kellen',
        persona:
          'Claims to have been in the maze longer than anyone else still walking, and enjoys being doubted about it. Trades directions for company, freely admits both may be wrong.',
      },
    ],
  },
};

/**
 * The order roles are handed out to the crowd filler.
 *
 * Vendors first so a marketplace is always reachable, then a guard, then the
 * rest of the budget spreads over spectators and loiterers. Repeating the tail
 * of the list is what keeps a large hub from being all vendors.
 */
export const ROLE_ROTATION = [
  ROLE.VENDOR,
  ROLE.LOITERER,
  ROLE.GUARD,
  ROLE.SPECTATOR,
  ROLE.LOITERER,
  ROLE.VENDOR,
  ROLE.SPECTATOR,
  ROLE.LOITERER,
  ROLE.GUARD,
  ROLE.LOITERER,
  ROLE.SPECTATOR,
  ROLE.LOITERER,
];

/**
 * Pick the named character for a role, falling back to a generic crowd entry.
 *
 * @param {string} theme
 * @param {string} role
 * @param {number} index which of that role this is (0-based)
 * @returns {{name:string, persona:string}|null}
 */
export function castFor(theme, role, index) {
  const byTheme = ROLE_CAST[theme] ?? ROLE_CAST.station;
  const list = byTheme[role];
  if (!list || list.length === 0) return null;
  if (index >= list.length) return null;
  return list[index];
}

/** @param {string} role */
export function roleDef(role) {
  return ROLE_DEFS[role] ?? ROLE_DEFS[ROLE.LOITERER];
}
